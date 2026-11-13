/**
 * SDK 进程封装：一个 `dsh --profile sdk` 子进程 + 行协议客户端。
 *
 * 只负责「进程活着、帧能收发、事件能解析」；它不知道 ActorKey，也不知道飞书。
 * 谁在哪个进程里跑哪个 session，由 executor 决定。
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process';

import type { RunInput } from './contract.ts';
import { LineRpcClient, type RpcLogger } from './rpc.ts';

/** 握手返回的服务标识；用于确认对面真的是 SDK 运行时。 */
const EXPECTED_SERVER_NAME = 'deepseek-harness-sdk-runtime';

/** 进程配置。 */
export interface SdkProcessOptions {
  /** 可执行文件，通常为 `dsh`。 */
  readonly command: string;
  /** 进程参数，通常为 `['--profile', 'sdk']`。 */
  readonly args: readonly string[];
  /** 工作目录。 */
  readonly cwd: string;
  /** 模型路由。 */
  readonly provider: string;
  readonly model: string;
  /** 额外环境变量（覆盖继承值）。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: RpcLogger;
  readonly requestTimeoutMs?: number;
  /** 注入口，测试时替换为假进程。 */
  readonly spawnImpl?: SpawnLike;
}

/** 可注入的 spawn 形状：只要求返回带标准流的子进程。 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions },
) => ChildProcess;

/** 从 `session.event` 通知里抽出的最小事件形状。 */
export interface SdkSessionEvent {
  readonly sessionId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** 事件订阅器。 */
export type SdkEventListener = (event: SdkSessionEvent) => void;

/** 进程已死亡的错误。 */
export class SdkProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdkProcessError';
  }
}

/**
 * 一个 SDK 运行时进程。
 *
 * 使用顺序：`start()` → 若干 `prompt()` → `shutdown()`。
 * 进程退出会通过 `onExit` 广播，未完成请求统统被拒绝。
 */
export class SdkProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: LineRpcClient | undefined;
  private readonly listeners = new Set<SdkEventListener>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly options: SdkProcessOptions;
  private readonly logger: RpcLogger;
  private exited = false;

  constructor(options: SdkProcessOptions) {
    this.options = options;
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
  }

  /** 子进程是否仍在运行。 */
  get alive(): boolean {
    return this.child !== undefined && !this.exited && this.child.exitCode === null;
  }

  /** 拉起进程并完成握手。 */
  async start(): Promise<void> {
    if (this.child !== undefined) throw new SdkProcessError('进程已启动，不能重复 start');
    const spawnImpl: SpawnLike = this.options.spawnImpl ?? ((command, args, options) => spawn(command, [...args], options));
    const child = spawnImpl(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => this.logger.debug(`[sdk] ${chunk.toString().trimEnd()}`));
    child.on('error', (error: Error) => this.fail(new SdkProcessError(`SDK 进程错误：${error.message}`)));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.fail(new SdkProcessError(`SDK 进程退出 code=${String(code)} signal=${String(signal)}`));
    });
    const client = new LineRpcClient(child.stdout, child.stdin, {
      ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      logger: this.logger,
    });
    this.client = client;
    client.onNotification((method, params) => this.handleNotification(method, params));
    const result = (await client.request('initialize', {
      cwd: this.options.cwd,
      provider: this.options.provider,
      model: this.options.model,
    })) as { serverInfo?: { name?: string } } | undefined;
    if (result?.serverInfo?.name !== EXPECTED_SERVER_NAME) {
      throw new SdkProcessError(`握手失败：对面不是 SDK 运行时（serverInfo=${String(result?.serverInfo?.name)}）`);
    }
    this.logger.debug(`[sdk] 已就绪 pid=${String(child.pid)}`);
  }

  /** 订阅会话事件。返回解绑函数。 */
  onEvent(listener: SdkEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 订阅进程死亡。返回解绑函数。 */
  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * 投递一轮输入并等待完成，返回最终的助手文本。
   *
   * 用 `session/wait` 收敛，而不是盯 `session.status` 的 running→idle 边沿：
   * 极短回合可能一次 status 通知都不发，盯边沿会让调用方永久挂起。
   */
  async prompt(sessionId: string, input: RunInput, onDelta?: (text: string) => void): Promise<string> {
    const client = this.requireClient();
    let finalText = '';
    let turnError: string | undefined;
    const unbind = this.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      // 回合以错误收尾时把真实原因记下来：否则调用方只能看到「没有产出文本」，
      // 无法区分模型超时、网关不通还是真的空回复（失败可溯源）。
      if (event.type === 'turn/end') {
        const reason = event.data.reason as { kind?: string; error?: { message?: string } } | undefined;
        if (reason?.kind === 'error') {
          turnError = reason.error?.message ?? '模型回合以错误结束';
        }
        return;
      }
      if (event.type !== 'assistant/message') return;
      const message = event.data.message;
      const content = pickContent(message);
      const textOfMessage = textFromContent(content);
      if (textOfMessage.length === 0) return;
      finalText = textOfMessage;
      onDelta?.(textOfMessage);
    });
    try {
      await client.request('session/prompt', {
        sessionId,
        contentBlocks: buildContentBlocks(input),
      });
      await client.request('session/wait', { sessionId });
      if (turnError !== undefined) {
        throw new SdkProcessError(turnError);
      }
      if (finalText.length === 0) {
        throw new SdkProcessError('本轮结束但没有产出文本');
      }
      return finalText;
    } finally {
      unbind();
    }
  }

  /** 恢复一个已持久化的会话（不存在则抛错，不自动创建）。 */
  async resume(sessionId: string): Promise<void> {
    await this.requireClient().request('session/resume', { sessionId });
  }

  /** 优雅关闭：先请求 shutdown，再兜底 kill。 */
  async shutdown(): Promise<void> {
    const child = this.child;
    const client = this.client;
    if (child === undefined) return;
    try {
      await client?.request('shutdown', undefined, 5_000);
    } catch (error) {
      this.logger.debug(`[sdk] shutdown 请求失败，直接终止：${String(error)}`);
    }
    client?.close('进程关闭');
    if (child.exitCode === null) child.kill('SIGTERM');
    this.exited = true;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.destroyStreams();
    this.child = undefined;
    this.client = undefined;
  }

  /** 关掉子进程的三条流；否则父进程会因为残留句柄而无法退出（附则一）。 */
  private destroyStreams(): void {
    const child = this.child;
    if (child === undefined) return;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  private requireClient(): LineRpcClient {
    if (this.client === undefined || this.exited) throw new SdkProcessError('SDK 进程未启动或已退出');
    return this.client;
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session.event') return;
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const event = params.event;
    if (sessionId.length === 0 || event === null || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const data = (record.data !== null && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>;
    for (const listener of this.listeners) listener({ sessionId, type, data });
  }

  /** 进程死亡：拒绝所有等待中的请求，并通知订阅者。 */
  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.client?.close(error.message);
    this.destroyStreams();
    for (const listener of this.exitListeners) listener(error);
    this.exitListeners.clear();
  }
}

/** 把一轮输入拼成协议要求的 content blocks：文本在前，图片随后。 */
function buildContentBlocks(input: RunInput): unknown[] {
  const blocks: unknown[] = [];
  if (input.text.trim().length > 0) blocks.push({ type: 'text', text: input.text });
  for (const image of input.images ?? []) {
    blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  // 协议要求至少一块：纯空输入时给一个空文本块，让 agent 至少能回一句。
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/** 从助手消息里取 content 数组。 */
function pickContent(message: unknown): unknown[] {
  if (message === null || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

/** 把 content blocks 里的文本拼起来。 */
function textFromContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('');
}
