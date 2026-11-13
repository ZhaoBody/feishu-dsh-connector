/**
 * 执行体实现（首版）：一个 SDK 进程承载多个 session，按 ActorKey 串行投递。
 *
 * 为什么不是一个 key 一个进程：进程启动约 1–2s、常驻几十 MB，群里人多时会线性膨胀；
 * 首版用「共享进程 + 独立 sessionId」拿到上下文隔离与并行能力，接口保持进程语义，
 * 后续换 `ProcessPerActorExecutor` 时接入层不用改。
 */

import { createHash } from 'node:crypto';

import type { ActorKey, EventSink, Executor, RunInput, RunResult } from './contract.ts';
import { ExecutorPersistence } from './persistence.ts';
import { SdkProcess, type SdkProcessOptions, type SpawnLike } from './process-pool.ts';

/** 最小日志接口。 */
export interface ExecutorLogger {
  warn(message: string): void;
  debug(message: string): void;
}

/** 执行体配置。 */
export interface ExecutorConfig {
  /** dsh 可执行文件。 */
  readonly command: string;
  /** 进程参数，默认 `['--profile', 'sdk']`。 */
  readonly args?: readonly string[];
  /** 工作目录。 */
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  /** key→sessionId 的持久化文件。 */
  readonly persistenceFile: string;
  /** 空闲归档阈值，默认 30 分钟。 */
  readonly idleMs?: number;
  /** 同时存在的执行体上限，默认 64；超限显式拒绝新执行体，不静默。 */
  readonly maxActors?: number;
  /**
   * 单轮执行超时（毫秒），默认 10 分钟。
   *
   * 超时不是「取消」——协议没有取消能力，执行体进程会继续跑；
   * 但调用方必须立刻拿到失败，否则卡片会永远停在「处理中」。
   */
  readonly runTimeoutMs?: number;
  readonly logger?: ExecutorLogger;
  readonly now?: () => number;
  /** 注入 spawn，便于用假进程做测试。 */
  readonly spawnImpl?: SpawnLike;
  /** 注入 session id 生成器，便于测试确定性。 */
  readonly sessionIdMinter?: (key: ActorKey) => string;
  /**
   * 子进程的权限模式（写入 `DSH_PERMISSION_MODE`）。
   *
   * SDK 运行时没有审批 UI，需要审批的操作会 fail closed（直接拒绝）而不会挂起；
   * 因此这里用沙箱边界代替审批。默认 `workspace-write`：可读写工作区，越界被拒。
   */
  readonly permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * 中断模式：
   * - `degrade`（默认）：协议不支持 agent 级取消，只记录并返回，由接入层告知用户；
   * - `kill-process`：杀掉共享进程（会波及其它 key 的在途回合，慎用）。
   */
  readonly interruptMode?: 'degrade' | 'kill-process';
}

/** 默认参数。 */
const DEFAULT_ARGS = ['--profile', 'sdk'] as const;

/**
 * 按 ActorKey 管理 session 的执行体。
 *
 * 单写者保证：同一个 key 的 `run` 通过一条 promise 链严格串行；
 * 不同 key 各自成链、可并行。
 */
export class SessionExecutor implements Executor {
  private readonly config: ExecutorConfig;
  private readonly logger: ExecutorLogger;
  private readonly persistence: ExecutorPersistence;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingCounts = new Map<string, number>();
  private readonly now: () => number;
  private process: SdkProcess | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.logger = config.logger ?? { warn: () => {}, debug: () => {} };
    this.now = config.now ?? (() => Date.now());
    this.persistence = new ExecutorPersistence(config.persistenceFile, {
      now: this.now,
      logger: this.logger,
    });
    this.persistence.load();
    this.sweepTimer = setInterval(() => this.sweepIdle(), Math.max(30_000, (config.idleMs ?? 30 * 60_000) / 2));
    this.sweepTimer.unref?.();
  }

  /** 当前映射条数（观测用）。 */
  get size(): number {
    return this.persistence.size;
  }

  /**
   * 给一轮执行套超时。
   *
   * 超时后原 promise 仍在跑，这里挂一个 catch 避免 unhandled rejection；
   * 调用方拿到明确的超时错误，用户至少能看到「失败」而不是永远「处理中」。
   */
  private async withTimeout<T>(promise: Promise<T>, key: ActorKey): Promise<T> {
    const timeoutMs = this.config.runTimeoutMs ?? 10 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`执行超时（${Math.round(timeoutMs / 60_000)} 分钟）：${key}`));
      }, timeoutMs);
      timer.unref?.();
    });
    promise.catch(() => undefined);
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    let finalText = '';
    this.pendingCounts.set(key, (this.pendingCounts.get(key) ?? 0) + 1);
    try {
      await this.enqueue(key, async () => {
        const process = await this.ensureProcess();
        const sessionId = this.sessionFor(key);
        sink.emit({ type: 'status', state: 'running' });
        finalText = await this.withTimeout(
          process.prompt(sessionId, input, (delta) => {
            sink.emit({ type: 'delta', text: delta });
          }),
          key,
        );
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
    if (this.config.interruptMode === 'kill-process' && this.process?.alive === true) {
      this.logger.warn(`中断 ${key}：终止共享进程（同进程内其它任务一并受影响）`);
      await this.process.shutdown();
      this.process = undefined;
      return;
    }
    this.logger.warn(`中断 ${key}：当前协议不支持 agent 级取消，已标记但本回合不可打断`);
  }

  async release(key: ActorKey): Promise<void> {
    this.chains.delete(key);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await this.process?.shutdown();
    this.process = undefined;
    this.chains.clear();
    await this.persistence.flush();
  }

  /** 释放空闲超阈值的 key，返回被释放的列表。 */
  sweepIdle(): ActorKey[] {
    const idleMs = this.config.idleMs ?? 30 * 60_000;
    const now = this.now();
    const released: ActorKey[] = [];
    for (const key of this.persistence.keys()) {
      const record = this.persistence.get(key);
      if (record === undefined) continue;
      if (now - record.lastActiveAt < idleMs) continue;
      this.chains.delete(key);
      released.push(key as ActorKey);
    }
    return released;
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

  /** 保证共享进程可用；崩溃后下次调用自动重建。 */
  private async ensureProcess(): Promise<SdkProcess> {
    if (this.process?.alive === true) return this.process;
    const options: SdkProcessOptions = {
      command: this.config.command,
      args: this.config.args ?? DEFAULT_ARGS,
      cwd: this.config.cwd,
      provider: this.config.provider,
      model: this.config.model,
      logger: this.logger,
      env: { DSH_PERMISSION_MODE: this.config.permissionMode ?? 'workspace-write' },
      ...(this.config.spawnImpl !== undefined ? { spawnImpl: this.config.spawnImpl } : {}),
    };
    const process = new SdkProcess(options);
    await process.start();
    process.onExit((error) => {
      if (this.process === process) this.process = undefined;
      this.logger.warn(`share SDK 进程退出：${error.message}`);
    });
    this.process = process;
    return process;
  }

  /** 取该 key 的 session id，没有则铸造并持久化。 */
  private sessionFor(key: ActorKey): string {
    const existing = this.persistence.get(key);
    if (existing !== undefined) return existing.sessionId;
    const limit = this.config.maxActors ?? 64;
    if (this.persistence.size >= limit) {
      throw new Error(
        `执行体数量已达上限 ${limit}（当前 ${this.persistence.size}）；` +
          `请释放空闲执行体或调大 maxActors`,
      );
    }
    const sessionId = this.mint(key);
    this.persistence.set(key, sessionId);
    this.logger.debug(`为 ${key} 铸造 session ${sessionId}`);
    return sessionId;
  }

  /** 默认 session id：稳定前缀 + 时间戳，可读且不撞。 */
  private mint(key: ActorKey): string {
    if (this.config.sessionIdMinter !== undefined) return this.config.sessionIdMinter(key);
    const digest = createHash('sha1').update(key).digest('hex').slice(0, 10);
    return `feishu-${digest}-${this.now()}`;
  }
}

/** 便捷工厂。 */
export function createExecutor(config: ExecutorConfig): SessionExecutor {
  return new SessionExecutor(config);
}
