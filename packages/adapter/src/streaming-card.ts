/**
 * 流式卡片：一条回复一张卡片，反复 patch 而不是发多条消息。
 *
 * 节流策略与旧插件一致：至少 `throttleMs` 间隔一次 patch，同一时刻只有一次
 * patch 在途，最新的内容总是赢——这样模型吐字再快也不会触发飞书限流。
 *
 * 与旧插件的关键差别：卡片状态**按 ActorKey 隔离**（每个执行体一张卡），
 * 两个人同时跑任务时，两张卡各更各的，内容不交叉（需求 T6）。
 */

import { buildCard, titleFor, type CardPhase } from './card-renderer.ts';

/** 卡片所需的最小发送能力。 */
export interface CardTransport {
  /** 发送一张卡片（可指定回复目标），返回 message id。 */
  sendCard(chatId: string, card: object, replyTo?: string): Promise<string>;
  /** 原地更新一张卡片。 */
  updateCard(messageId: string, card: object): Promise<void>;
}

/** 节流配置。 */
export interface StreamingCardOptions {
  /** 最小 patch 间隔，默认 400ms。 */
  readonly throttleMs?: number;
  /**
   * 单张卡片的字符上限；超过就关掉这张、另开一张继续。
   * 飞书单个卡片元素有内容上限（约 3 万字），不滚动会导致 patch 被拒。
   */
  readonly maxChars?: number;
  /** 滚动出新卡片时回调（接入层据此登记出站记录，保证新卡也能撤回）。 */
  readonly onNewCard?: (messageId: string) => void;
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void };
}

/**
 * 一张流式卡片。
 *
 * 生命周期：`open()` → 多次 `push()` → `close()`。
 * `dispose()` 可随时中断（清定时器，不再 patch）。
 */
export class StreamingCard {
  private readonly transport: CardTransport;
  private readonly chatId: string;
  private readonly replyTo: string | undefined;
  private readonly throttleMs: number;
  private readonly maxChars: number;
  private readonly onNewCard: ((messageId: string) => void) | undefined;
  private readonly now: () => number;
  private readonly logger: { warn(message: string): void };
  private messageId: string | undefined;
  private latest = '';
  private sent = '';
  private lastAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private rolling: Promise<void> | undefined;
  private closed = false;

  constructor(transport: CardTransport, chatId: string, replyTo?: string, options: StreamingCardOptions = {}) {
    this.transport = transport;
    this.chatId = chatId;
    this.replyTo = replyTo;
    this.throttleMs = options.throttleMs ?? 400;
    this.maxChars = options.maxChars ?? 28_000;
    this.onNewCard = options.onNewCard;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? { warn: () => {} };
  }

  /** 发出的卡片 message id（未 open 时为 undefined）。 */
  get id(): string | undefined {
    return this.messageId;
  }

  /** 发首帧，返回 message id。 */
  async open(): Promise<string> {
    const card = buildCard('', 'running', titleFor('running'));
    const messageId = this.replyTo === undefined
      ? await this.transport.sendCard(this.chatId, card)
      : await this.transport.sendCard(this.chatId, card, this.replyTo);
    this.messageId = messageId;
    this.lastAt = this.now();
    return messageId;
  }

  /** 推入最新文本；按节流窗口决定立即或延后 patch，超长则滚动新卡。 */
  push(text: string): void {
    this.latest = text;
    if (this.messageId !== undefined && text.length > this.maxChars && this.rolling === undefined) {
      this.rolling = this.rollover().finally(() => {
        this.rolling = undefined;
      });
      return;
    }
    this.schedule();
  }

  /** 终态：清定时器、等在途 patch、发最后一帧。 */
  async close(text: string, phase: CardPhase): Promise<void> {
    this.latest = text;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushing;
    this.closed = true;
    if (this.messageId === undefined) return;
    try {
      await this.transport.updateCard(this.messageId, buildCard(text, phase, titleFor(phase)));
      this.sent = text;
    } catch (error) {
      this.logger.warn(`卡片终态更新失败：${String(error)}`);
    }
  }

  /** 放弃该卡片：不再 patch（消息本身保留）。 */
  dispose(): void {
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 排一次 patch（立即或延迟），保证同一时刻只有一个在途。 */
  /** 关掉当前卡片，另开一张继续 —— 内容超限时唯一的正确做法。 */
  private async rollover(): Promise<void> {
    await this.flushing;
    const head = this.latest.slice(0, this.maxChars);
    if (this.messageId !== undefined) {
      try {
        await this.transport.updateCard(this.messageId, buildCard(head, 'done', titleFor('done')));
      } catch (error) {
        this.logger.warn(`卡片滚动时收尾失败：${String(error)}`);
      }
    }
    const tail = this.latest.slice(this.maxChars);
    try {
      const card = buildCard(tail, 'running', titleFor('running'));
      const messageId = this.replyTo === undefined
        ? await this.transport.sendCard(this.chatId, card)
        : await this.transport.sendCard(this.chatId, card, this.replyTo);
      this.messageId = messageId;
      this.sent = tail;
      this.lastAt = this.now();
      this.onNewCard?.(messageId);
    } catch (error) {
      this.logger.warn(`卡片滚动失败，内容可能被截断：${String(error)}`);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.flushing !== undefined) return;
    const wait = Math.max(0, this.lastAt + this.throttleMs - this.now());
    if (wait === 0) {
      this.flushing = this.flush().finally(() => {
        this.flushing = undefined;
      });
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.schedule();
    }, wait);
    this.timer.unref?.();
  }

  /** 执行一次 patch；失败只告警（内容最终会由终态兜底）。 */
  private async flush(): Promise<void> {
    if (this.closed || this.messageId === undefined) return;
    const text = this.latest;
    if (text === this.sent) return;
    this.lastAt = this.now();
    try {
      await this.transport.updateCard(this.messageId, buildCard(text, 'running', titleFor('running')));
      this.sent = text;
    } catch (error) {
      this.logger.warn(`卡片 patch 失败：${String(error)}`);
    }
  }
}
