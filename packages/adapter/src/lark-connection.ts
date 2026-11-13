/**
 * 飞书连接层：只管「长连接进来、消息交出去、回复发回去」。
 *
 * 它不知道执行体是进程还是 session——`onMessage` 由上层接线时注入，
 * 回复用 `sendText`/`replyText` 主动发。这样接入层可以独立测试、独立替换。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import * as lark from '@larksuiteoapi/node-sdk';

import type { RunImage } from '@feishu-assistant/dsh-executor/contract';

import { sniffImageMime } from './attachments.ts';
import type { InboundFile, InboundMessage } from './message-router.ts';

/** SDK 日志级别映射。 */
const SDK_LEVELS = {
  debug: lark.LoggerLevel.debug,
  info: lark.LoggerLevel.info,
  warn: lark.LoggerLevel.warn,
  error: lark.LoggerLevel.error,
} as const;

/**
 * 把 SDK 的下载返回值统一成 Buffer。
 *
 * `messageResource.get` 返回 `{ writeFile, getReadableStream, headers }`——
 * 没有 `data` 字段，只能 `getReadableStream()`；它返回的流**不支持 for-await**
 * （实测会拿到非 Buffer 对象），必须用 data/end 事件收集。
 */
async function toBuffer(value: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value;
  const holder = value as { getReadableStream?: () => unknown; data?: unknown } | null;
  const stream =
    typeof holder?.getReadableStream === 'function' ? holder.getReadableStream() : holder?.data ?? value;
  if (Buffer.isBuffer(stream)) return stream;
  if (stream !== null && typeof stream === 'object' && typeof (stream as { on?: unknown }).on === 'function') {
    const readable = stream as {
      on(event: 'data', handler: (chunk: Buffer | string) => void): void;
      on(event: 'end', handler: () => void): void;
      on(event: 'error', handler: (error: Error) => void): void;
    };
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      readable.on('end', () => resolve());
      readable.on('error', (error) => reject(error));
    });
    return Buffer.concat(chunks);
  }
  throw new Error('资源下载返回了无法识别的结构');
}

/** 连接层日志接口。 */
export interface ConnectionLogger {
  info(message: string): void;
  error(message: string): void;
}

/** 连接配置。 */
export interface LarkConnectionOptions {
  readonly appId: string;
  readonly appSecret: string;
  /** 飞书或 Lark 域。 */
  readonly domain?: 'feishu' | 'lark';
  /** 群里是否必须 @机器人 才处理，默认 true。 */
  readonly requireMention?: boolean;
  /** 私聊策略，默认 open。 */
  readonly dmMode?: 'open' | 'allowlist' | 'disabled';
  /** 群白名单：只响应这些 chat id 的群（防止被拉进陌生群后乱跑命令）。 */
  readonly groupAllowlist?: string[];
  /** 私聊白名单（dmMode 为 allowlist 时生效）。 */
  readonly dmAllowlist?: string[];
  /** 消息去重窗口（毫秒），默认 10 分钟。 */
  readonly dedupTtlMs?: number;
  /** 入站文件的落盘目录；缺省不落盘（文件会被忽略并提示）。 */
  readonly attachmentsDir?: string;
  /** 飞书 SDK 自身的日志级别，排查「事件到底到没到」时设 debug。 */
  readonly sdkLogLevel?: 'debug' | 'info' | 'warn' | 'error';
  readonly logger?: ConnectionLogger;
}

/** 收到一条消息后的处理函数；异常由连接层统一兜底记录。 */
export type MessageHandler = (message: InboundMessage) => Promise<void>;

/**
 * 飞书长连接。
 *
 * 生命周期：`connect()` → `on('message')` → 若干发送 → `disconnect()`。
 */
export class LarkConnection {
  private readonly options: LarkConnectionOptions;
  private readonly logger: ConnectionLogger;
  private readonly handlers = new Set<MessageHandler>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private channel: lark.LarkChannel | undefined;
  private connected = false;
  private readonly attachmentsDir: string | undefined;

  constructor(options: LarkConnectionOptions) {
    this.options = options;
    this.logger = options.logger ?? { info: () => {}, error: () => {} };
    this.attachmentsDir = options.attachmentsDir;
  }

  /** 注册消息处理函数，返回解绑函数。 */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 注册连接错误回调（重连、鉴权失败等），返回解绑函数。 */
  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /** 建立长连接；重复调用是幂等的。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    const channel = lark.createLarkChannel({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      transport: 'websocket',
      domain: this.options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      source: 'feishu-adapter',
      loggerLevel: SDK_LEVELS[this.options.sdkLogLevel ?? 'info'],
      policy: {
        dmMode: this.options.dmMode ?? 'open',
        // 始终 false：飞书里「发文件」无法同时 @ 机器人，交给 SDK 过滤会让附件永远收不到。
        // 「群里纯文本必须 @」改由本层的 dispatch 判断。
        requireMention: false,
        ...(this.options.groupAllowlist !== undefined ? { groupAllowlist: this.options.groupAllowlist } : {}),
        ...(this.options.dmAllowlist !== undefined ? { dmAllowlist: this.options.dmAllowlist } : {}),
      },
      safety: {
        dedup: { ttl: this.options.dedupTtlMs ?? 10 * 60_000 },
        chatQueue: { enabled: false },
      },
    });
    this.channel = channel;
    channel.on('message', (message) => {
      // 入口日志：收不到消息时，这一行是判断「事件到底有没有到」的关键。
      this.logger.info(
        `[feishu] 收到事件 ${message.messageId} chat=${message.chatId} type=${message.rawContentType}`,
      );
      void this.dispatch(message);
    });
    channel.on('error', (error) => {
      this.logger.error(`[feishu] ${error.message}`);
      for (const handler of this.errorHandlers) handler(error);
    });
    await channel.connect();
    this.connected = true;
    this.logger.info('[feishu] 长连接已就绪');
  }

  /** 发送纯文本，返回该消息的 message id（调用方据此登记出站记录）。 */
  async sendText(chatId: string, text: string): Promise<string> {
    const channel = this.requireChannel();
    const result = await channel.send(chatId, { text });
    return result.messageId;
  }

  /** 回复指定消息（保持话题归属），返回新消息的 message id。 */
  async replyText(chatId: string, messageId: string, text: string): Promise<string> {
    const channel = this.requireChannel();
    const result = await channel.send(chatId, { text }, { replyTo: messageId });
    return result.messageId;
  }

  /** 发送一张卡片（可指定回复目标），返回新消息的 message id。 */
  async sendCard(chatId: string, card: object, replyTo?: string): Promise<string> {
    const channel = this.requireChannel();
    const result = replyTo === undefined
      ? await channel.send(chatId, { card })
      : await channel.send(chatId, { card }, { replyTo });
    return result.messageId;
  }

  /** 原地更新一张卡片。 */
  async updateCard(messageId: string, card: object): Promise<void> {
    const channel = this.requireChannel();
    await channel.updateCard(messageId, card);
  }

  /** 发送文件，返回新消息的 message id。 */
  async sendFile(chatId: string, fileName: string, content: Buffer): Promise<string> {
    const channel = this.requireChannel();
    const result = await channel.send(chatId, { file: { source: content, fileName } });
    return result.messageId;
  }

  /**
   * 撤回一条本机器人发出的消息。
   *
   * 是否「本机器人发出」由调用方的出站登记表判断；这里只负责调接口，
   * 失败直接抛出（错误必须可溯源，不吞）。
   */
  async recallMessage(messageId: string): Promise<void> {
    const channel = this.requireChannel();
    await channel.recallMessage(messageId);
  }

  /**
   * 当前长连接状态。
   *
   * SDK 在重试耗尽后进入 `failed` 且不再自愈，调用方应据此触发进程级重启。
   */
  connectionState(): string {
    return this.channel?.getConnectionStatus()?.state ?? 'unknown';
  }

  /** 断开长连接；重复调用是安全的。 */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.channel?.disconnect();
    this.channel = undefined;
    this.logger.info('[feishu] 长连接已断开');
  }

  /** 把 SDK 的归一化消息转成内部消息并交给所有处理器。 */
  private async dispatch(message: lark.NormalizedMessage): Promise<void> {
    const text = message.content.trim();
    const hasAttachments = message.resources.length > 0;
    // 空文本且无附件的消息（撤回通知、表情回应等）直接忽略；
    // 带附件但无文本的消息必须交给上层——静默丢弃会让用户以为机器人坏了。
    if (text.length === 0 && !hasAttachments) {
      this.logger.info(`[feishu] 忽略空消息 ${message.messageId}`);
      return;
    }

    // 群里的纯文本必须 @ 机器人才处理；带附件的消息放行（发文件时无法 @）。
    const requireMention = this.options.requireMention ?? true;
    if (requireMention && message.chatType === 'group' && !message.mentionedBot && !hasAttachments) {
      this.logger.info(`[feishu] 忽略未 @ 的群消息 ${message.messageId}`);
      return;
    }

    const { images, files, errors } = await this.collectAttachments(message);
    const inbound: InboundMessage = {
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType === 'group' ? 'group' : 'p2p',
      senderOpenId: message.senderId,
      text,
      hasAttachments,
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(errors.length > 0 ? { attachmentErrors: errors } : {}),
    };
    for (const handler of this.handlers) {
      try {
        await handler(inbound);
      } catch (error) {
        this.logger.error(`[adapter] 处理 ${message.messageId} 失败：${error instanceof Error ? error.message : String(error)}`);
        await this.reportFailure(message.chatId, message.messageId, error);
      }
    }
  }

  /**
   * 收集入站附件：图片转成协议块，文件落盘后把路径交给 agent。
   *
   * 单张失败不拖垮整条消息：成功的照常投递，失败的记进 errors 由上层回执。
   */
  private async collectAttachments(
    message: lark.NormalizedMessage,
  ): Promise<{ images: RunImage[]; files: InboundFile[]; errors: string[] }> {
    const resources = message.resources;
    const images: RunImage[] = [];
    const files: InboundFile[] = [];
    const errors: string[] = [];

    for (const resource of resources) {
      if (resource.type === 'image') {
        try {
          const bytes = await this.downloadMessageResource(message.messageId, resource.fileKey, 'image');
          const mimeType = sniffImageMime(bytes);
          if (mimeType === undefined) {
            errors.push('图片格式不支持（仅支持 png / jpeg / webp / gif）');
            continue;
          }
          images.push({ mimeType, data: bytes.toString('base64') });
        } catch (error) {
          errors.push(`图片下载失败：${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (resource.type === 'file') {
        if (this.attachmentsDir === undefined) {
          errors.push('文件消息未启用落盘（未配置 attachmentsDir）');
          continue;
        }
        try {
          const bytes = await this.downloadMessageResource(message.messageId, resource.fileKey, 'file');
          const path = this.saveFile(resource, bytes);
          files.push({ name: basename(path), path, bytes: bytes.length });
        } catch (error) {
          errors.push(`文件下载失败：${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      errors.push(`${resource.type} 类型暂不支持`);
    }
    return { images, files, errors };
  }

  /**
   * 下载消息里的资源。
   *
   * 必须走 `im/v1/messages/:message_id/resources/:file_key`——`im/v1/images/:image_key`
   * 只认机器人自己上传的图片，对消息里的图片会返回 400。
   */
  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Buffer> {
    const channel = this.requireChannel();
    const raw = await channel.rawClient.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    return toBuffer(raw);
  }

  /** 把文件落到工作区，文件名做穿越清洗。 */
  private saveFile(resource: lark.ResourceDescriptor, bytes: Buffer): string {
    const dir = this.attachmentsDir as string;
    mkdirSync(dir, { recursive: true });
    const raw = resource.fileName ?? `file-${Date.now()}`;
    const safe = basename(raw).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120) || 'file';
    const path = join(dir, `${Date.now()}-${safe}`);
    writeFileSync(path, bytes);
    return path;
  }

  /** 处理失败必须让用户看见（宪法第八条：禁止静默退化）。 */
  private async reportFailure(chatId: string, messageId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await this.replyText(chatId, messageId, `⚠️ 处理失败：${reason}`);
    } catch (sendError) {
      this.logger.error(`[adapter] 失败回执也发不出去：${String(sendError)}`);
    }
  }

  private requireChannel(): lark.LarkChannel {
    if (this.channel === undefined || !this.connected) {
      throw new Error('飞书长连接尚未建立');
    }
    return this.channel;
  }
}
