/**
 * 通过 dsh web 的 HTTP API 驱动 agent 的执行体实现。
 *
 * 与 {@link SessionExecutor}（自己 spawn `dsh --profile sdk`）的区别：
 * 这里**不持有任何 session 写句柄**，prompt 交给 web 进程执行，结果靠只读拉取。
 * 因此 Web 里打开过的会话也能继续聊——锁冲突从根上消失。
 *
 * 代价：没有流式推送，靠轮询（默认 1 秒）刷新，卡片按轮询增量 patch。
 */

import { randomUUID } from 'node:crypto';

import type { ActorKey, EventSink, Executor, RunInput, RunResult } from './contract.ts';
import { ExecutorPersistence } from './persistence.ts';
import { WebRpcClient, WebRpcError, type WebRpcOptions } from './web-rpc.ts';

/** 执行体配置。 */
export interface HttpExecutorConfig {
  /** dsh web 的 RPC 连接参数。 */
  readonly rpc?: WebRpcOptions;
  /** 新会话所属的工作目录。 */
  readonly cwd: string;
  /** 可选 agent preset。 */
  readonly agentPreset?: string;
  /** key→session 持久化文件。 */
  readonly persistenceFile: string;
  /** 轮询间隔，默认 1000ms。 */
  readonly pollIntervalMs?: number;
  /** 单轮超时，默认 10 分钟。 */
  readonly runTimeoutMs?: number;
  /** 注入 session id 生成器，便于测试。 */
  readonly sessionIdMinter?: (key: ActorKey) => string;
  readonly logger?: { warn(message: string): void; debug(message: string): void };
}

/** 会话摘要里我们用到的字段。 */
interface SessionSummary {
  readonly sessionId: string;
  readonly running: boolean;
  readonly projections?: { readonly asOfSeq?: number };
}

/** session/list 的返回值。 */
interface SessionListValue {
  readonly items: readonly SessionSummary[];
}

/** session/page 的返回记录。 */
interface SessionPageRecord {
  readonly type: string;
  readonly event?: { readonly type?: string; readonly seq?: number; readonly data?: Record<string, unknown> };
}

/** 一次轮询的结果。 */
interface PollOutcome {
  readonly text: string;
  readonly done: boolean;
}

/**
 * 基于 dsh web API 的执行体。
 *
 * 单写者语义由 web 进程保证；本类只保证「同一 key 的 run 串行」（接入层视角）。
 */
export class HttpExecutor implements Executor {
  private readonly config: HttpExecutorConfig;
  private readonly rpc: WebRpcClient;
  private readonly persistence: ExecutorPersistence;
  private readonly logger: { warn(message: string): void; debug(message: string): void };
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingCounts = new Map<string, number>();
  private disposed = false;

  constructor(config: HttpExecutorConfig) {
    this.config = config;
    this.rpc = new WebRpcClient({
      ...(config.rpc ?? {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
    this.logger = config.logger ?? { warn: () => {}, debug: () => {} };
    this.persistence = new ExecutorPersistence(config.persistenceFile, { logger: this.logger });
    this.persistence.load();
  }

  /** 该 key 前面还有多少条在排队。 */
  pending(key: ActorKey): number {
    return this.pendingCounts.get(key) ?? 0;
  }

  async run(key: ActorKey, input: RunInput, sink: EventSink): Promise<RunResult> {
    if (this.disposed) {
      sink.emit({ type: 'error', message: '执行体已关闭，无法接收新任务' });
      return { ok: false, text: '执行体已关闭' };
    }
    this.pendingCounts.set(key, (this.pendingCounts.get(key) ?? 0) + 1);
    try {
      let finalText = '';
      await this.enqueue(key, async () => {
        const sessionId = await this.ensureSession(key);
        const baseline = await this.currentCursor(sessionId);
        sink.emit({ type: 'status', state: 'running' });
        await this.prompt(sessionId, input);

        const outcome = await this.pollUntilDone(sessionId, baseline, (text) => {
          sink.emit({ type: 'delta', text });
        });
        finalText = outcome.text;
        this.persistence.touch(key);
        sink.emit({ type: 'done', text: finalText });
        sink.emit({ type: 'status', state: 'idle' });
      });
      return { ok: true, text: finalText };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`执行体 ${key} 失败：${message}`);
      sink.emit({ type: 'error', message });
      return { ok: false, text: message };
    } finally {
      const left = (this.pendingCounts.get(key) ?? 1) - 1;
      if (left <= 0) this.pendingCounts.delete(key);
      else this.pendingCounts.set(key, left);
    }
  }

  async interrupt(key: ActorKey): Promise<void> {
    const record = this.persistence.get(key);
    if (record === undefined) return;
    try {
      await this.rpc.call('session/cancel', { request: { sessionId: record.sessionId } });
    } catch (error) {
      // 取消不是关键路径：会话可能已结束或不存在，记下来即可。
      this.logger.warn(`中断 ${key} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async release(key: ActorKey): Promise<void> {
    this.chains.delete(key);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.chains.clear();
    await this.persistence.flush();
  }

  /** 拿到该 key 的 session；没有就创建一个（复用 DSH 的会话）。 */
  private async ensureSession(key: ActorKey): Promise<string> {
    const existing = this.persistence.get(key);
    if (existing !== undefined) return existing.sessionId;
    const requested = this.config.sessionIdMinter?.(key) ?? `feishu-${randomUUID().slice(0, 8)}`;
    const created = await this.rpc.call<{ sessionId: string }>('session/create', {
      request: {
        ...(this.config.cwd !== '' ? { cwd: this.config.cwd } : {}),
        sessionId: requested,
        ...(this.config.agentPreset !== undefined ? { agentPreset: this.config.agentPreset } : {}),
      },
    });
    this.persistence.set(key, created.sessionId);
    this.logger.debug(`为 ${key} 创建 session ${created.sessionId}`);
    return created.sessionId;
  }

  /** 当前会话的事件游标（page 的 throughSeq 上界）。 */
  private async currentCursor(sessionId: string): Promise<number> {
    const list = await this.rpc.call<SessionListValue>('session/list', { _request: {} });
    const item = list.items.find((entry) => entry.sessionId === sessionId);
    return item?.projections?.asOfSeq ?? 0;
  }

  /** 投递一轮输入。 */
  private async prompt(sessionId: string, input: RunInput): Promise<void> {
    const content: Array<Record<string, unknown>> = [];
    if (input.text.trim().length > 0) content.push({ type: 'text', text: input.text });
    for (const image of input.images ?? []) {
      content.push({ type: 'image', mediaType: image.mimeType, data: image.data });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    await this.rpc.call('session/prompt', {
      request: { requestId: randomUUID(), sessionId, mode: 'queue', content },
    });
  }

  /** 轮询直到该会话出现新的 turn/end，返回累积的助手文本。 */
  private async pollUntilDone(
    sessionId: string,
    baseline: number,
    onDelta: (text: string) => void,
  ): Promise<PollOutcome> {
    const timeoutMs = this.config.runTimeoutMs ?? 10 * 60_000;
    const intervalMs = this.config.pollIntervalMs ?? 1_000;
    const startedAt = Date.now();
    let text = '';
    let cursor = baseline;

    for (;;) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`执行超时（${Math.round(timeoutMs / 60_000)} 分钟）：${sessionId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const list = await this.rpc.call<SessionListValue>('session/list', { _request: {} });
      const item = list.items.find((entry) => entry.sessionId === sessionId);
      const asOf = item?.projections?.asOfSeq ?? cursor;
      if (asOf <= cursor) {
        if (text.length > 0 && item?.running === false) return { text, done: true };
        continue;
      }
      const page = await this.rpc.call<{ records: SessionPageRecord[] }>('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq: asOf, maxMessages: 50 },
      });
      cursor = asOf;
      for (const record of page.records ?? []) {
        const event = record.event;
        if (event?.type !== 'assistant/message') continue;
        const next = extractAssistantText(event.data);
        // 轮询会重复读到同一事件：文本没变就不再推 delta。
        if (next.length > 0 && next !== text) {
          text = next;
          onDelta(text);
        }
      }
      const finished = (page.records ?? []).some((record) => record.event?.type === 'turn/end');
      if (finished) return { text, done: true };
      if (text.length > 0 && item?.running === false) return { text, done: true };
    }
  }

  /** 同一个 key 的任务串成一条链；前一个失败不阻塞后续。 */
  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(task, task);
    const settled = run.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return run;
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

/** 便捷工厂。 */
export function createHttpExecutor(config: HttpExecutorConfig): HttpExecutor {
  return new HttpExecutor(config);
}
