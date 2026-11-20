/**
 * 子任务完成回流器。
 *
 * 原生 subagent 只负责「派活」和「向父 agent 发完成通知」；但父 agent 的完成通知
 * 只是进 inbox，**不会自己开一轮新 turn**。也就是说：用户派完活不说话，子任务跑完了，
 * 结果就静静躺在父会话的 inbox 里，永远发不到群里（实测：主对话只有 turn 1，没有 turn 2）。
 *
 * 本组件补的就是这一段：扫出「已完成但还没转述」的子代理会话，把结果作为一条消息
 * 投回主对话，让主对话开一轮新 turn 去转述——转述内容再由哨兵投递到群。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 只需要 RPC 的 call 能力。 */
export interface CollectorRpc {
  call<T = unknown>(endpoint: string, args?: Record<string, unknown>): Promise<T>;
}

/** 会话摘要里用到的字段。 */
interface SessionSummary {
  readonly sessionId: string;
  readonly running: boolean;
  readonly origin?: 'subagent';
  readonly parentSessionId?: string;
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

/** 回流器配置。 */
export interface SubagentCollectorConfig {
  readonly rpc: CollectorRpc;
  /** actors.json：用来找出哪些会话是主对话。 */
  readonly actorsFile: string;
  /** 已转述进度，避免重复回流。 */
  readonly stateFile: string;
  /** 轮询间隔，默认 3000ms。 */
  readonly intervalMs?: number;
  readonly logger?: { warn(message: string): void; info?(message: string): void; debug?(message: string): void };
}

/**
 * 扫一轮，把完成的子任务结果投回主对话。
 *
 * 公开是为了让测试能单步驱动。
 */
export class SubagentCollector {
  private readonly config: SubagentCollectorConfig;
  private readonly logger: NonNullable<SubagentCollectorConfig['logger']>;
  /** childSessionId → 已转述到的事件序号。 */
  private delivered: Record<string, number> = {};
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(config: SubagentCollectorConfig) {
    this.config = config;
    this.logger = config.logger ?? { warn: () => {} };
    this.loadState();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs ?? 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.saveState();
  }

  /** 扫一轮。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const mains = this.readMainSessions();
      if (mains.size === 0) return;
      const list = await this.config.rpc.call<{ items: readonly SessionSummary[] }>('session/list', {
        _request: {},
      });
      for (const child of list.items) {
        if (child.origin !== 'subagent') continue;
        if (child.running) continue;
        const parent = child.parentSessionId;
        if (parent === undefined || !mains.has(parent)) continue;
        const asOf = child.projections?.asOfSeq ?? 0;
        if (asOf <= (this.delivered[child.sessionId] ?? 0)) continue;
        const result = await this.readResult(child.sessionId, parent, asOf);
        if (result === undefined) continue;
        await this.injectIntoParent(parent, result);
        this.delivered[child.sessionId] = asOf;
      }
      this.saveState();
    } catch (error) {
      // 回流失败不能影响接入主流程，下一轮再试。
      this.logger.warn(`子任务回流失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** 取子会话里最后一个回合的助手文本；没有完成回合时返回 undefined。 */
  private async readResult(sessionId: string, parentSessionId: string, asOf: number): Promise<string | undefined> {
    // 子代理会话必须用 subagent 形式的持久地址，普通 {kind:'session'} 会被拒
    // （实测：session/agent-busy — subagent Sessions require their durable parent address）。
    const page = await this.config.rpc.call<{ records: readonly PageRecord[] }>('session/page', {
      request: {
        address: { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' },
        throughSeq: asOf,
        maxMessages: 40,
      },
    });
    const records = page.records ?? [];
    const hasTurnEnd = records.some((record) => record.event?.type === 'turn/end');
    if (!hasTurnEnd) return undefined;
    let text = '';
    for (const record of records) {
      if (record.event?.type !== 'assistant/message') continue;
      const next = extractAssistantText(record.event.data);
      if (next.length > 0) text = next;
    }
    return text.length > 0 ? text : undefined;
  }

  /** 把结果作为一条消息投回主对话，触发它开新的一轮。 */
  private async injectIntoParent(parentSessionId: string, result: string): Promise<void> {
    const text = [
      '【子任务完成】你之前派出去的子任务已经跑完，下面是它的最终输出。',
      '请把结果转述给群里提问的人（能精简就精简，保留关键结论与证据）。',
      '',
      result,
    ].join('\n');
    await this.config.rpc.call('session/prompt', {
      request: {
        requestId: `collector-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: parentSessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    });
    this.logger.info?.(`子任务结果已投回主对话 ${parentSessionId}`);
  }

  /** 读 actors.json，找出所有主对话会话 id。 */
  private readMainSessions(): Set<string> {
    const ids = new Set<string>();
    let raw: string;
    try {
      raw = readFileSync(this.config.actorsFile, 'utf8');
    } catch {
      return ids;
    }
    try {
      const parsed = JSON.parse(raw) as { actors?: Record<string, { sessionId?: string }> };
      for (const [key, value] of Object.entries(parsed.actors ?? {})) {
        if (!key.endsWith('::__main__')) continue;
        if (typeof value.sessionId === 'string' && value.sessionId.length > 0) ids.add(value.sessionId);
      }
    } catch {
      return ids;
    }
    return ids;
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.config.stateFile, 'utf8')) as {
        delivered?: Record<string, number>;
      };
      this.delivered = parsed.delivered ?? {};
    } catch {
      this.delivered = {};
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.config.stateFile, `${JSON.stringify({ delivered: this.delivered }, null, 2)}\n`);
    } catch (error) {
      this.logger.warn(`回流进度保存失败：${error instanceof Error ? error.message : String(error)}`);
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
