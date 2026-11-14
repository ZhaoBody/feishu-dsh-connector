/**
 * 飞书接入层的门面：把「连接、分拣、执行体、回复」串起来。
 *
 * 依赖方向：本模块只认 `Executor` 接口（类型导入）与自己的连接层，
 * 不知道执行体是进程还是 session，也不 import 任何执行层实现。
 */

import type { ActorKey, Executor, ExecutorEvent } from '@feishu-assistant/dsh-executor/contract';

import { route, type InboundMessage, type RouteDecision } from './message-router.ts';
import type { MessageHandler } from './lark-connection.ts';
import type { OutboundKind, OutboundRegistry } from './outbound-registry.ts';
import { RecallService, type RecallResult } from './recall-service.ts';
import { mainActorBrief, parseSpawn } from './dispatch.ts';
import { ReplyCollector } from './reply-renderer.ts';
import type { CardTransport } from './streaming-card.ts';
import { StreamingCard } from './streaming-card.ts';

/**
 * 连接端口：门面只需要这四项能力。
 *
 * 用接口而不是具体类，测试可注入零依赖的替身（宪法第五条：脱离环境可验）。
 */
export interface ConnectionPort extends CardTransport {
  onMessage(handler: MessageHandler): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 回复一条消息，返回新消息的 message id（用于登记出站记录）。 */
  replyText(chatId: string, messageId: string, text: string): Promise<string>;
  /** 撤回一条消息；失败抛错。 */
  recallMessage(messageId: string): Promise<void>;
}

/** 门面日志接口。 */
export interface AdapterLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** 门面配置。 */
export interface FeishuAdapterOptions {
  readonly connection: ConnectionPort;
  readonly executor: Executor;
  /** 出站消息登记表；撤回能力依赖它，必须持久化。 */
  readonly outbound: OutboundRegistry;
  readonly logger?: AdapterLogger;
  /** 注入时钟，便于测试。 */
  readonly now?: () => number;
  /** 卡片 patch 最小间隔，默认 400ms。 */
  readonly cardThrottleMs?: number;
  /**
   * 允许使用机器人的用户 open_id 列表；缺省表示不限。
   *
   * 执行体有完整 shell 权限，暴露给任意群成员等于把服务器交出去，
   * 生产环境必须配置。
   */
  readonly allowedUsers?: readonly string[];
}

/**
 * 接入层门面。
 *
 * 一条消息的走向：分拣 → 中断/执行 → 回复。分拣是纯函数，失败一律回执给用户。
 */
export class FeishuAdapter {
  private readonly connection: ConnectionPort;
  private readonly executor: Executor;
  private readonly outbound: OutboundRegistry;
  private readonly recallService: RecallService;
  private readonly logger: AdapterLogger;
  private readonly now: () => number;
  private readonly cardThrottleMs: number;
  private readonly allowedUsers: readonly string[] | undefined;
  private readonly liveCards = new Set<StreamingCard>();
  /** 已经注入过角色说明的主对话（每个 chat 一次）。 */
  private readonly briefed = new Set<string>();
  private taskSeq = 0;
  private unbind: (() => void) | undefined;
  private started = false;

  constructor(options: FeishuAdapterOptions) {
    this.connection = options.connection;
    this.executor = options.executor;
    this.outbound = options.outbound;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.cardThrottleMs = options.cardThrottleMs ?? 400;
    this.allowedUsers = options.allowedUsers;
    this.recallService = new RecallService(this.connection, this.outbound, { now: this.now });
  }

  /** 注册消息处理并建立长连接。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unbind = this.connection.onMessage(async (message) => {
      await this.handle(message);
    });
    await this.connection.connect();
  }

  /** 断开连接并释放执行体；幂等。 */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unbind?.();
    this.unbind = undefined;
    for (const card of this.liveCards) card.dispose();
    this.liveCards.clear();
    await this.connection.disconnect();
    await this.executor.dispose();
    await this.outbound.flush();
  }

  /** 撤回本机器人发过的消息；不传 id 时撤该会话最近一条。 */
  async recall(chatId: string, messageId?: string): Promise<RecallResult> {
    const result = await this.recallService.recall(chatId, messageId);
    this.logger.info(
      `撤回 chat=${chatId} message=${result.messageId ?? '(无)'} → ${result.ok ? '成功' : result.reason ?? '失败'}`,
    );
    return result;
  }

  /** 单条消息的完整处理。 */
  async handle(message: InboundMessage): Promise<void> {
    if (this.allowedUsers !== undefined && !this.allowedUsers.includes(message.senderOpenId)) {
      this.logger.warn(`拒绝未授权用户 ${message.senderOpenId}（chat ${message.chatId}）`);
      await this.send(message.chatId, message.messageId, '你没有使用这个机器人的权限。', 'text');
      return;
    }

    const decision = route(message);
    this.logger.info(`路由 ${message.messageId} → ${decision.intent}（${decision.reason}）`);

    const hasImages = message.images !== undefined && message.images.length > 0;
    const hasFiles = message.files !== undefined && message.files.length > 0;
    if (message.attachmentErrors !== undefined && message.attachmentErrors.length > 0) {
      this.logger.warn(`附件失败 chat=${message.chatId}：${message.attachmentErrors.join('；')}`);
    }
    if (!hasImages && !hasFiles && message.attachmentErrors !== undefined && message.attachmentErrors.length > 0) {
      await this.send(
        message.chatId,
        message.messageId,
        `附件无法处理：${message.attachmentErrors.join('；')}。请改用文字或支持的图片格式。`,
        'text',
      );
      return;
    }

    if (message.text.trim().length === 0 && !hasImages && !hasFiles) {
      await this.send(message.chatId, message.messageId, '这条消息没有可处理的内容。', 'text');
      return;
    }

    if (decision.intent === 'interrupt') {
      await this.handleInterrupt(message, decision);
      return;
    }

    // 同一个人已经在跑：先给一句排队反馈，避免用户以为消息丢了。
    const waiting = this.executor.pending(decision.key);
    if (waiting > 0) {
      this.logger.info(`排队 key=${decision.key} 前面 ${waiting} 条`);
      await this.send(
        message.chatId,
        message.messageId,
        `已收到，前面还有 ${waiting} 条在处理，会按顺序回复。`,
        'text',
      );
    }

    await this.runStreaming(message, decision);
  }

  /**
   * 流式执行：一张卡片承载一条回复，内容原地生长。
   *
   * 卡片按执行体隔离——不同 key 各开各的卡，同一时刻互不覆盖（需求 T6）。
   * 卡片打不开就降级为一条纯文本回复，绝不静默吞掉结果。
   */
  private async runStreaming(message: InboundMessage, decision: RouteDecision): Promise<void> {
    const collector = new ReplyCollector();
    let card: StreamingCard | undefined;

    try {
      card = new StreamingCard(this.connection, message.chatId, message.messageId, {
        throttleMs: this.cardThrottleMs,
        now: this.now,
        logger: this.logger,
        onNewCard: (messageId) => {
          this.outbound.add({ messageId, chatId: message.chatId, kind: 'card', createdAt: this.now() });
        },
      });
      const messageId = await card.open();
      this.liveCards.add(card);
      this.outbound.add({ messageId, chatId: message.chatId, kind: 'card', createdAt: this.now() });
    } catch (error) {
      this.logger.warn(`卡片打开失败，降级纯文本：${String(error)}`);
      card?.dispose();
      card = undefined;
    }

    const sink = {
      emit: (event: ExecutorEvent): void => {
        collector.onEvent(event);
        if (card !== undefined) card.push(collector.snapshot.text);
      },
    };

    const startedAt = this.now();
    let text = this.composeText(message);
    // 每个主对话首次交互时注入角色说明，之后它记住了。
    if (!this.briefed.has(message.chatId)) {
      this.briefed.add(message.chatId);
      text = `${mainActorBrief()}\n\n---\n\n${text}`;
    }
    const result = await this.executor.run(
      decision.key,
      {
        text,
        ...(message.images !== undefined ? { images: message.images } : {}),
      },
      sink,
    );
    this.logger.info(
      `执行 key=${decision.key} ok=${result.ok} 耗时=${this.now() - startedAt}ms 长度=${result.text.length}`,
    );

    // 失败：把错误原样交给用户（卡片红色终态或纯文本）。
    if (!result.ok) {
      const failure = collector.snapshot.text;
      if (card !== undefined) {
        await card.close(failure, 'error');
        this.liveCards.delete(card);
        return;
      }
      await this.send(message.chatId, message.messageId, failure, 'text');
      return;
    }

    // 成功：解析派活标记。正文之外的任务另开无状态会话并行执行。
    const parsed = parseSpawn(result.text);
    for (const task of parsed.tasks) {
      this.logger.info(`主对话派活：${task.slice(0, 60)}`);
      this.spawnTask(message.chatId, decision.key, message.messageId, task);
    }
    const visible = parsed.text.length > 0 ? parsed.text : parsed.tasks.length > 0 ? '收到，已经派人去办了。' : '';

    if (card !== undefined) {
      await card.close(visible, 'done');
      this.liveCards.delete(card);
      return;
    }
    if (visible.length > 0) {
      await this.send(message.chatId, message.messageId, visible, 'text');
    }
  }

  /**
   * 派活：另开无状态会话执行，完成后把结果注回主对话再回复用户。
   *
   * 不阻塞接入层——主对话派完就能接下一句话。
   */
  private spawnTask(chatId: string, mainKey: ActorKey, replyTo: string, task: string): void {
    const taskKey = `${chatId}::__task-${++this.taskSeq}` as ActorKey;
    void (async () => {
      try {
        this.logger.info(`派活开始 task=${taskKey}`);
        const collector = new ReplyCollector();
        const result = await this.executor.run(taskKey, { text: task }, {
          emit: (event: ExecutorEvent) => collector.onEvent(event),
        });
        const outcome = result.ok ? result.text : `执行失败：${result.text}`;
        this.logger.info(`派活完成 task=${taskKey} ok=${result.ok} 长度=${outcome.length}`);
        // 结果注回主对话：它持记忆，由它决定怎么转述给用户。
        const followup = new ReplyCollector();
        const injected = await this.executor.run(
          mainKey,
          { text: `【执行体回报】任务：${task}\n结果：${outcome}` },
          { emit: (event: ExecutorEvent) => followup.onEvent(event) },
        );
        const text = injected.ok ? parseSpawn(followup.snapshot.text).text : `⚠️ ${outcome}`;
        await this.send(chatId, replyTo, text.length > 0 ? text : outcome, 'text');
        this.logger.info(`派活结果已回发 task=${taskKey}`);
      } catch (error) {
        // 派活是后台任务，异常必须落日志，否则会出现「派出去了但永远没回音」。
        this.logger.warn(`派活失败 task=${taskKey}：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  /**
   * 把入站文件的存在告诉 agent。
   *
   * 协议没有「文件块」，所以走文本：给出绝对路径，agent 用读文件工具自己处理。
   */
  private composeText(message: InboundMessage): string {
    const files = message.files ?? [];
    if (files.length === 0) return message.text;
    const note = files
      .map((file) => `[用户发送的文件：${file.name}（${file.bytes} 字节），已保存到 ${file.path}]`)
      .join('\n');
    return message.text.trim().length > 0 ? `${note}\n\n${message.text}` : note;
  }

  /** 回复并登记出站记录：没有登记就没有撤回权。 */
  private async send(chatId: string, replyTo: string, text: string, kind: OutboundKind): Promise<void> {
    const messageId = await this.connection.replyText(chatId, replyTo, text);
    this.outbound.add({ messageId, chatId, kind, createdAt: this.now() });
  }

  /** 中断只作用于说话人自己的执行体，并在回执里说清楚。 */
  private async handleInterrupt(message: InboundMessage, decision: RouteDecision): Promise<void> {
    await this.executor.interrupt(decision.key);
    const reply =
      '已停止你的任务。\n\n（当前实现下，正在执行的长回合可能无法立刻打断，会在本回合结束后生效。）';
    await this.send(message.chatId, message.messageId, reply, 'text');
  }
}
