/**
 * 主对话哨兵：盯着每个群的主对话会话，把**新产生的** assistant 回复发到飞书。
 *
 * 为什么需要它：主对话有两个入口——飞书消息，以及你在 Web GUI 里直接点开会话聊。
 * 后者不经过 bridge，回复只落在会话里，群里永远看不到。哨兵是唯一出口：
 * 不管是哪个入口触发的回复，只要落进会话，就被发到对应群。
 *
 * 去重靠事件 seq：记住每个群「已发到哪一条」，重启也不重发。
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { parseSpawn } from './dispatch.ts';

/** 只需要 RPC 的 call 能力，不依赖 executor 包的具体类型。 */
export interface WatcherRpc {
  call<T = unknown>(endpoint: string, args?: Record<string, unknown>): Promise<T>;
}

/** 哨兵配置。 */
export interface MainWatcherConfig {
  /** 用来读会话的 RPC 客户端。 */
  readonly rpc: WatcherRpc;
  /** actors.json（chatId::__main__ → sessionId 映射）。 */
  readonly actorsFile: string;
  /** 已发送进度文件。 */
  readonly stateFile: string;
  /** 把文本发到群里；由接入层提供。 */
  readonly onMessage: (chatId: string, text: string) => Promise<void>;
  /** 轮询间隔，默认 2000ms。 */
  readonly intervalMs?: number;
  readonly logger?: { warn(message: string): void; debug(message: string): void; info?(message: string): void };
}

/** 会话摘要里用到的字段。 */
interface SessionSummary {
  readonly sessionId: string;
  readonly projections?: { readonly asOfSeq?: number };
}

/** session/page 的记录。 */
interface PageRecord {
  readonly event?: {
    readonly type?: string;
    readonly seq?: number;
    readonly data?: Record<string, unknown>;
  };
}

/**
 * 主对话哨兵。
 *
 * 单实例即可；`start()` 起定时器，`stop()` 停止并落盘进度。
 */
export class MainWatcher {
  private readonly config: MainWatcherConfig;
  private readonly logger: { warn(message: string): void; debug(message: string): void; info?(message: string): void };
  /** chatId → 已发送到的 seq。 */
  private cursor: Record<string, number> = {};
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(config: MainWatcherConfig) {
    this.config = config;
    this.logger = config.logger ?? { warn: () => {}, debug: () => {} };
    this.loadState();
  }

  /** 启动轮询。重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  /** 停止轮询并落盘。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.saveState();
  }

  /**
   * 扫一轮：找到每个主对话会话里新出现的回复并发送。
   *
   * 公开是为了让测试能单步驱动，不必等定时器。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const mainEntries = this.readMainEntries();
      if (mainEntries.length === 0) return;
      const list = await this.config.rpc.call<{ items: readonly SessionSummary[] }>('session/list', {
        _request: {},
      });
      for (const [chatId, sessionId] of mainEntries) {
        const summary = list.items.find((item) => item.sessionId === sessionId);
        const asOf = summary?.projections?.asOfSeq ?? 0;
        const last = this.cursor[chatId] ?? 0;
        if (asOf <= last) continue;
        await this.deliver(chatId, sessionId, last, asOf);
        this.cursor[chatId] = asOf;
      }
      this.saveState();
    } catch (error) {
      // 哨兵失败不能影响接入层主流程，记日志下一轮再试。
      this.logger.warn(`哨兵轮询失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** 读某个会话的新回复并发出去。 */
  private async deliver(chatId: string, sessionId: string, fromSeq: number, toSeq: number): Promise<void> {
    const page = await this.config.rpc.call<{ records: readonly PageRecord[] }>('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq: toSeq, maxMessages: 50 },
    });
    // 一轮可能有多条 assistant 消息（多个 step），取最后一条完整文本。
    let text = '';
    let hasTurnEnd = false;
    for (const record of page.records ?? []) {
      const event = record.event;
      const seq = event?.seq ?? 0;
      if (seq <= fromSeq) continue;
      if (event?.type === 'assistant/message') {
        const next = extractAssistantText(event.data);
        if (next.length > 0) text = next;
      }
      if (event?.type === 'turn/end') hasTurnEnd = true;
    }
    if (!hasTurnEnd || text.length === 0) return;
    // 主对话的回复里可能带派活标记：发给群之前剔掉。
    const visible = parseSpawn(text).text;
    if (visible.length === 0) return;
    this.logger.info?.(`哨兵发送 chat=${chatId} seq=${toSeq} 长度=${visible.length}`);
    await this.config.onMessage(chatId, visible);
  }

  /** 读 actors.json 里的主对话映射。 */
  private readMainEntries(): Array<[string, string]> {
    let raw: string;
    try {
      raw = readFileSync(this.config.actorsFile, 'utf8');
    } catch {
      return [];
    }
    let parsed: { actors?: Record<string, { sessionId?: string }> };
    try {
      parsed = JSON.parse(raw) as { actors?: Record<string, { sessionId?: string }> };
    } catch {
      return [];
    }
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(parsed.actors ?? {})) {
      const [chatId, suffix] = key.split('::');
      if (chatId === undefined || suffix !== '__main__') continue;
      if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) continue;
      entries.push([chatId, value.sessionId]);
    }
    return entries;
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.config.stateFile, 'utf8')) as {
        cursor?: Record<string, number>;
      };
      this.cursor = parsed.cursor ?? {};
    } catch {
      this.cursor = {};
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.config.stateFile, `${JSON.stringify({ cursor: this.cursor }, null, 2)}\n`);
    } catch (error) {
      this.logger.warn(`哨兵进度保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 从 assistant/message 事件里取文本。 */
function extractAssistantText(data: Record<string, unknown> | undefined): string {
  const message = data?.message;
  if (message === null || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as { type?: string; text?: string };
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('');
}
