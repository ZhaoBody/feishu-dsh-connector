/**
 * 执行体层的持久化：key → sessionId 与最近活跃时间。
 *
 * 独立文件、独立版本号（`version: 1`），不触碰线上旧插件的 session-map
 * （那份文件的 v3 版本号已被 activeChildren 占用）。
 *
 * 写盘策略：内存态即时更新，变更排进一条串行写链，`flush()` 可等待落盘。
 * 因此并发 set 不会交错写坏文件（宪法第八条：失败必须显式，不静默丢数据）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 单个执行体的持久化记录。 */
export interface ActorRecord {
  /** 该执行体绑定的 dsh session id。 */
  readonly sessionId: string;
  /** 最近一次活跃的毫秒时间戳，用于空闲归档。 */
  readonly lastActiveAt: number;
}

/** 落盘文件结构。 */
export interface ExecutorState {
  readonly version: 1;
  readonly actors: Record<string, ActorRecord>;
}

/** 持久化可选依赖。 */
export interface ExecutorPersistenceOptions {
  /** 日志器；缺省静默。 */
  readonly logger?: { warn(message: string): void; debug(message: string): void };
  /** 注入时钟，便于测试。 */
  readonly now?: () => number;
}

/**
 * 执行体映射的持久化。
 *
 * 文件损坏或版本不符时整体放弃并保留内存为空——宁可冷恢复重绑，也不猜。
 */
export class ExecutorPersistence {
  private actors = new Map<string, ActorRecord>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly file: string;
  private readonly now: () => number;
  private readonly logger: { warn(message: string): void; debug(message: string): void };

  constructor(
    file: string,
    options: ExecutorPersistenceOptions = {},
  ) {
    this.file = file;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
  }

  /** 加载磁盘映射；缺失文件视为首次运行，损坏文件告警后放弃。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ExecutorState>;
      if (parsed.version !== 1 || typeof parsed.actors !== 'object' || parsed.actors === null) {
        this.logger.warn(`执行体映射版本不符，已忽略：${this.file}`);
        return;
      }
      for (const [key, record] of Object.entries(parsed.actors)) {
        if (typeof record?.sessionId === 'string' && typeof record?.lastActiveAt === 'number') {
          this.actors.set(key, { sessionId: record.sessionId, lastActiveAt: record.lastActiveAt });
        }
      }
      this.logger.debug(`执行体映射已加载 ${this.actors.size} 条：${this.file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`执行体映射读取失败，已从空状态开始：${String(error)}`);
      }
    }
  }

  /** 读取一条映射。 */
  get(key: string): ActorRecord | undefined {
    return this.actors.get(key);
  }

  /** 绑定（或重绑）一个 key 到 session id，并刷新活跃时间。 */
  set(key: string, sessionId: string): void {
    this.actors.set(key, { sessionId, lastActiveAt: this.now() });
    this.schedulePersist();
  }

  /** 刷新活跃时间（不改变绑定）。 */
  touch(key: string): void {
    const record = this.actors.get(key);
    if (record === undefined) return;
    this.actors.set(key, { sessionId: record.sessionId, lastActiveAt: this.now() });
    this.schedulePersist();
  }

  /** 删除一条映射。 */
  delete(key: string): void {
    if (!this.actors.delete(key)) return;
    this.schedulePersist();
  }

  /** 全部 key。 */
  keys(): string[] {
    return [...this.actors.keys()];
  }

  /** 当前条数。 */
  get size(): number {
    return this.actors.size;
  }

  /** 等待已排队的写盘全部完成。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** 排一次落盘；写链保证不交错。 */
  private schedulePersist(): void {
    this.writeChain = this.writeChain
      .then(() => this.persist())
      .catch((error: unknown) => {
        this.logger.warn(`执行体映射写盘失败：${String(error)}`);
      });
  }

  /** 原子落盘：写临时文件后 rename 覆盖。 */
  private persist(): void {
    const data: ExecutorState = {
      version: 1,
      actors: Object.fromEntries(this.actors),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}
