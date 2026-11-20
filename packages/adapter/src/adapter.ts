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
import { claimsSpawn, mainActorBrief, parseSpawn } from './dispatch.ts';
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
  /** 往群里发一条新消息（不挂回复关系），返回 message id。 */
  sendText(chatId: string, text: string): Promise<string>;
  /** 给消息加表情回应；不支持可缺省。 */
  addReaction?(messageId: string, emojiType?: string): Promise<void>;
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
  /** 超过这个毫秒数仍未出结果就先发一句「正在处理」，默认 15000；设 0 关闭。 */
  readonly slowNoticeMs?: number;
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
  private readonly slowNoticeMs: number;
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
    this.slowNoticeMs = options.slowNoticeMs ?? 15_000;
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

    if (decision.intent === 'recall') {
      await this.handleRecall(message, decision.count ?? 1);
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

    await this.react(message.messageId);
    await this.handleMainActor(message, decision);
  }

  /**
   * 给收到的消息打个表情，表示「已收到」。
   *
   * 模型可能要想十几秒甚至超时，没有这个反馈用户会以为消息没送进来。
   * 失败只记日志：缺 `im:message.reaction` 权限时不该阻断正常流程。
   */
  private async react(messageId: string): Promise<void> {
    if (this.connection.addReaction === undefined) return;
    try {
      await this.connection.addReaction(messageId);
    } catch (error) {
      this.logger.warn(`表情回应失败（可能缺 im:message.reaction 权限）：${String(error)}`);
    }
  }

  /**
   * 主对话处理：静默执行，回复由哨兵统一投递到群。
   *
   * 为什么不在入口直接发：主对话有两个入口（飞书、Web GUI），后者产生的回复也要进群。
   * 把「发送」收敛成一条路径（哨兵），两个入口才不会一半有、一半没有。
   */
  private async handleMainActor(message: InboundMessage, decision: RouteDecision): Promise<void> {
    const collector = new ReplyCollector();
    const startedAt = this.now();
    // 模型可能想几十秒甚至超时重试；超过阈值先吱一声，免得用户以为消息没进来。
    let noticed = false;
    const noticeTimer =
      this.slowNoticeMs > 0
        ? setTimeout(() => {
            noticed = true;
            void this.send(message.chatId, message.messageId, '收到，正在处理，稍等一下喵…', 'text').catch(
              (error: unknown) => this.logger.warn(`处理中提示发送失败：${String(error)}`),
            );
          }, this.slowNoticeMs)
        : undefined;
    noticeTimer?.unref?.();
    let text = this.composeText(message);
    // 每个主对话首次交互时注入角色说明，之后它记住了。
    if (!this.briefed.has(message.chatId)) {
      this.briefed.add(message.chatId);
      text = `${mainActorBrief()}\n\n---\n\n${text}`;
    }
    let result;
    try {
      result = await this.executor.run(
        decision.key,
        {
          text,
          ...(message.images !== undefined ? { images: message.images } : {}),
        },
        { emit: (event: ExecutorEvent) => collector.onEvent(event) },
      );
    } finally {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    }
    this.logger.info(
      noticed ? `执行 key=${decision.key}（已发处理中提示）ok=${result.ok}` : `执行 key=${decision.key} ok=${result.ok}`,
    );
    this.logger.info(
      `执行 key=${decision.key} ok=${result.ok} 耗时=${this.now() - startedAt}ms 长度=${result.text.length}`,
    );

    if (!result.ok) {
      // 失败要即时告知，不经过哨兵——否则群里像是没收到。
      await this.send(message.chatId, message.messageId, collector.snapshot.text, 'text');
      return;
    }

    const parsed = parseSpawn(result.text);
    for (const task of parsed.tasks) {
      this.logger.info(`主对话派活：${task.slice(0, 60)}`);
      this.spawnTask(message.chatId, decision.key, task);
    }

    // 兜底：回复里声称派了活，却没有标记 → 实际什么都没发生。
    // 不给用户留一个「等一个不存在的结果」的状态，当场说清楚。
    if (parsed.tasks.length === 0 && claimsSpawn(result.text)) {
      this.logger.warn(`主对话声称派活但没有标记（session=${decision.key}）`);
      // 正文仍由哨兵投递；这里只追加一条独立的补充说明，避免重复发送同一条。
      await this.send(
        message.chatId,
        message.messageId,
        '补充说明：刚才那条提到「已派出」，但实际没有生成可执行的任务，所以不会有后续结果。需要真执行的话请再说一次，我会真正派出去。',
        'text',
      );
    }
  }

  /**
   * 派活：另开无状态会话执行，完成后把结果注回主对话再回复用户。
   *
   * 不阻塞接入层——主对话派完就能接下一句话。
   */
  private spawnTask(chatId: string, mainKey: ActorKey, task: string): void {
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
        // 结果已经注回主对话，投递由哨兵统一负责。
        this.logger.info(`派活结果已回注主对话 task=${taskKey} ok=${injected.ok}`);
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
    const note =
      files.length === 0
        ? ''
        : files
            .map((file) => `[用户发送的文件：${file.name}（${file.bytes} 字节），已保存到 ${file.path}]`)
            .join('\n');
    const body = message.text.trim().length > 0 ? message.text : '';
    // 群里多人共用一个主对话：必须标出发送者，否则它会把这个人的话当成主人的。
    const who = message.senderName ?? message.senderOpenId;
    const head = message.chatType === 'group' ? `[群成员 ${who} 说]` : `[私聊 ${who} 说]`;
    return [head, note, body].filter((part) => part.length > 0).join('\n');
  }

  /** 回复并登记出站记录：没有登记就没有撤回权。 */
  private async send(chatId: string, replyTo: string, text: string, kind: OutboundKind): Promise<void> {
    const messageId = await this.connection.replyText(chatId, replyTo, text);
    this.outbound.add({ messageId, chatId, kind, createdAt: this.now() });
  }

  /**
   * 主动往群里发一条文本。
   *
   * 供哨兵、本地发送接口、任何外部调用方使用——发送能力不再只属于消息回复流程。
   */
  async sendToChat(chatId: string, text: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    try {
      const messageId = await this.connection.sendText(chatId, text);
      this.outbound.add({ messageId, chatId, kind: 'text', createdAt: this.now() });
      return { ok: true, messageId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 撤回：按条数撤该会话最近几条出站消息。
   *
   * 为什么不让模型做：撤回是确定的动作，规则命中就直接执行，不再耗一次推理，
   * 也避免模型「口头说撤了但实际没撤」。
   */
  private async handleRecall(message: InboundMessage, count: number): Promise<void> {
    const recalled: string[] = [];

    // 引用了具体消息：优先撤被引用的那条（用户指向很明确）。
    if (message.replyToMessageId !== undefined) {
      const target = await this.recall(message.chatId, message.replyToMessageId);
      if (target.ok) recalled.push(target.messageId ?? '');
      else {
        const why =
          target.reason === 'forbidden'
            ? '那条不是我发的，撤不了'
            : target.reason === 'expired'
              ? '那条已经超过可撤回时限'
              : '没找到那条消息';
        await this.send(message.chatId, message.messageId, `撤回失败：${why}。`, 'text');
        return;
      }
    } else {
      // 没引用：撤该会话里机器人最近发出的 count 条。
      for (let index = 0; index < count; index += 1) {
        const result = await this.recall(message.chatId);
        if (!result.ok) break;
        recalled.push(result.messageId ?? '');
      }
    }

    const text =
      recalled.length > 0
        ? `已撤回 ${recalled.length} 条消息。`
        : '没有可撤回的消息（可能已超时或不是我发的）。';
    await this.send(message.chatId, message.messageId, text, 'text');
  }

  /** 中断只作用于说话人自己的执行体，并在回执里说清楚。 */
  private async handleInterrupt(message: InboundMessage, decision: RouteDecision): Promise<void> {
    await this.executor.interrupt(decision.key);
    const reply =
      '已停止你的任务。\n\n（当前实现下，正在执行的长回合可能无法立刻打断，会在本回合结束后生效。）';
    await this.send(message.chatId, message.messageId, reply, 'text');
  }
}
