/**
 * 出站消息登记表：记录机器人自己发出的每一条消息，供撤回使用。
 *
 * 为什么必须持久化：撤回的合法性依赖「这条是我发的」这一事实，
 * 而它不能存在内存里——进程重启后内存清零，历史消息就再也撤不回（旧插件的实际故障）。
 *
 * 为什么按「消息」而不是「卡片」登记：飞书删除接口对文本/文件/图片/卡片一视同仁，
 * 撤回能力不应受消息类型限制。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 出站消息的类别（仅用于诊断与日志，不参与撤回决策）。 */
export type OutboundKind = 'text' | 'file' | 'image' | 'card';

/** 一条出站记录。 */
export interface OutboundRecord {
  readonly messageId: string;
  readonly chatId: string;
  readonly kind: OutboundKind;
  /** 发送时间（毫秒），用于过期判断。 */
  readonly createdAt: number;
}

/** 落盘结构。 */
interface RegistryState {
  readonly version: 1;
  readonly records: readonly OutboundRecord[];
}

/** 登记表配置。 */
export interface OutboundRegistryOptions {
  /** 保留时长，默认 7 天（验收要求 ≥24h）。 */
  readonly maxAgeMs?: number;
  /** 最多保留记录数，默认 2000。 */
  readonly maxRecords?: number;
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void; debug(message: string): void };
}

/** 默认值。 */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_RECORDS = 2000;

/**
 * 出站消息登记表（持久化）。
 *
 * 内存态即时更新、写盘串行排队；`flush()` 可等待落盘。
 */
export class OutboundRegistry {
  private records: OutboundRecord[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly maxAgeMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly logger: { warn(message: string): void; debug(message: string): void };

  constructor(file: string, options: OutboundRegistryOptions = {}) {
    this.file = file;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
  }

  /** 读取磁盘记录；缺失视为首次运行，损坏则告警后从空开始（不猜）。 */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RegistryState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        this.logger.warn(`出站消息登记表版本不符，已忽略：${this.file}`);
        return;
      }
      this.records = parsed.records.filter(isRecord);
      this.prune();
      this.logger.debug(`出站消息登记表已加载 ${this.records.length} 条`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`出站消息登记表读取失败，已从空状态开始：${String(error)}`);
      }
    }
  }

  /** 登记一条刚发出的消息。 */
  add(record: OutboundRecord): void {
    this.records.push(record);
    this.prune();
    this.schedulePersist();
  }

  /** 按 message id 查一条。 */
  get(messageId: string): OutboundRecord | undefined {
    return this.records.find((record) => record.messageId === messageId);
  }

  /** 某会话最近的记录（新的在前）。 */
  recent(chatId: string, limit = 10): OutboundRecord[] {
    return this.records
      .filter((record) => record.chatId === chatId)
      .slice(-limit)
      .reverse();
  }

  /** 删除一条（撤回成功后调用，避免二次撤回）。 */
  forget(messageId: string): void {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.messageId !== messageId);
    if (this.records.length !== before) this.schedulePersist();
  }

  /** 当前条数。 */
  get size(): number {
    return this.records.length;
  }

  /** 等待落盘完成。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** 裁掉过期与超量的记录。 */
  private prune(): void {
    const now = this.now();
    this.records = this.records.filter((record) => now - record.createdAt <= this.maxAgeMs);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(this.records.length - this.maxRecords);
    }
  }

  /** 排队写盘；写链保证不交错。 */
  private schedulePersist(): void {
    this.writeChain = this.writeChain
      .then(() => this.persist())
      .catch((error: unknown) => {
        this.logger.warn(`出站消息登记表写盘失败：${String(error)}`);
      });
  }

  /** 原子落盘。 */
  private persist(): void {
    const data: RegistryState = { version: 1, records: this.records };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}

/** 磁盘记录的形状校验：宁可少记一条，也不让脏数据进白名单。 */
function isRecord(value: unknown): value is OutboundRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.messageId === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.createdAt === 'number' &&
    (record.kind === 'text' || record.kind === 'file' || record.kind === 'image' || record.kind === 'card')
  );
}
