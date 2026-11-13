/**
 * 撤回服务：在「出站登记表」之上做所有权、过期与失败分类。
 *
 * 旧插件的教训：撤回失败只回一句 "no bot message to recall"，用户既不知道
 * 是哪条、也不知道为什么。这里每次失败都带 messageId、原因分类与候选列表。
 */

import { OutboundRegistry, type OutboundRecord } from './outbound-registry.ts';

/** 撤回所需的最小发送能力（不绑定具体连接实现）。 */
export interface RecallTransport {
  /** 删除一条本机器人发出的消息；失败抛错。 */
  recallMessage(messageId: string): Promise<void>;
}

/** 失败原因分类。 */
export type RecallFailureReason = 'not-found' | 'forbidden' | 'expired' | 'api-error';

/** 撤回结果。成功与失败都是结构化数据，调用方可直接展示。 */
export interface RecallResult {
  readonly ok: boolean;
  /** 本次操作针对的消息 id（无 id 且无候选时缺省）。 */
  readonly messageId?: string;
  readonly reason?: RecallFailureReason;
  /** 同会话最近可撤的候选消息 id（新的在前），便于用户改用指定 id。 */
  readonly candidates?: readonly string[];
  /** 底层错误原文（仅 api-error 时有）。 */
  readonly detail?: string;
}

/** 撤回服务配置。 */
export interface RecallServiceOptions {
  /** 可撤回的最大消息年龄，默认 24 小时（与验收一致）。 */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

/** 默认可撤回窗口：24 小时。 */
const DEFAULT_RECALL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * 按会话撤回机器人自己发出的消息。
 *
 * 调用方给 id 就撤指定消息；不给就撤该会话最近一条可撤消息。
 */
export class RecallService {
  private readonly transport: RecallTransport;
  private readonly registry: OutboundRegistry;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(transport: RecallTransport, registry: OutboundRegistry, options: RecallServiceOptions = {}) {
    this.transport = transport;
    this.registry = registry;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_RECALL_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 撤回一条消息。
   *
   * @param chatId - 会话 id（所有权与过期都按会话判断）。
   * @param messageId - 指定消息；省略则取该会话最近一条。
   */
  async recall(chatId: string, messageId?: string): Promise<RecallResult> {
    const candidates = this.registry.recent(chatId, 5).map((record) => record.messageId);
    let target = messageId;

    if (target === undefined) {
      const latest = this.registry.recent(chatId, 1)[0];
      if (latest === undefined) {
        return { ok: false, reason: 'not-found', candidates: [] };
      }
      target = latest.messageId;
    }

    const record = this.registry.get(target);
    if (record === undefined || record.chatId !== chatId) {
      return { ok: false, messageId: target, reason: 'forbidden', candidates };
    }
    if (this.now() - record.createdAt > this.maxAgeMs) {
      return { ok: false, messageId: target, reason: 'expired', candidates };
    }

    try {
      await this.transport.recallMessage(target);
    } catch (error) {
      return {
        ok: false,
        messageId: target,
        reason: 'api-error',
        detail: error instanceof Error ? error.message : String(error),
        candidates,
      };
    }

    this.registry.forget(target);
    return { ok: true, messageId: target };
  }

  /** 该会话最近可撤的记录（诊断用）。 */
  recent(chatId: string, limit = 5): OutboundRecord[] {
    return this.registry.recent(chatId, limit);
  }
}

/**
 * 把结构化结果翻译成给用户看的一句话。
 *
 * 失败时**必须**包含 messageId 与原因，禁止只说「没有可撤回的消息」。
 */
export function describeRecall(result: RecallResult): string {
  if (result.ok) return `已撤回消息 ${result.messageId ?? ''}。`;
  const candidates = result.candidates ?? [];
  const tail = candidates.length > 0 ? `\n可撤候选：${candidates.join('、')}` : '\n该会话没有可撤回的出站消息记录。';
  switch (result.reason) {
    case 'not-found':
      return `没有找到可撤回的消息。${tail}`;
    case 'forbidden':
      return `消息 ${result.messageId ?? '(未知)'} 不是本机器人在该会话发出的，拒绝撤回。${tail}`;
    case 'expired':
      return `消息 ${result.messageId ?? '(未知)'} 超出可撤回窗口（默认 24 小时）。${tail}`;
    case 'api-error':
      return `撤回 ${result.messageId ?? '(未知)'} 失败：${result.detail ?? '接口未返回原因'}。${tail}`;
    default:
      return `撤回失败（未知原因）。${tail}`;
  }
}
