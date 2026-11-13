/**
 * 消息分拣：决定一条飞书消息该由谁执行。
 *
 * 这是「门口分拣」的实现——纯函数、无 IO、可单测。规则优先于任何模型判断，
 * 因为把重任务留在主会话会拖垮所有人都要用的那条通道（设计目标 G4）。
 *
 * 判定顺序固定为 中断 → 强指令 → 闲聊：先说「停」的人不应该顺带触发一次新任务。
 */

import type { ActorKey, RunImage } from '@feishu-assistant/dsh-executor/contract';
import { actorKeyOf } from './keys.ts';

/** 已落盘的入站文件。 */
export interface InboundFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

/** 一条已归一化的入站消息（字段名与飞书事件无关，便于测试）。 */
export interface InboundMessage {
  readonly chatId: string;
  readonly senderOpenId: string;
  readonly text: string;
  readonly chatType: 'group' | 'p2p';
  readonly messageId: string;
  /** 消息是否带附件（图片/文件/音视频）。纯附件消息的 text 为空。 */
  readonly hasAttachments?: boolean;
  /** 已下载的入站图片。 */
  readonly images?: readonly RunImage[];
  /** 已落盘的入站文件。 */
  readonly files?: readonly InboundFile[];
  /** 附件处理失败的原因（格式不支持、下载失败等），用于给用户明确回执。 */
  readonly attachmentErrors?: readonly string[];
}

/** 一条消息的处置意图。 */
export type RouteIntent = 'chat' | 'task' | 'interrupt';

/** 分拣结果。`reason` 只用于日志与排障，不参与业务判断。 */
export interface RouteDecision {
  readonly intent: RouteIntent;
  readonly key: ActorKey;
  readonly reason: string;
}

/** 中断指令：只中断说话人自己的执行体，不波及同群其他人。 */
const INTERRUPT_PATTERNS: readonly RegExp[] = [
  /(?:^|[，,。.!！\s])(?:停一下|停下|停止|停|别弄了|别做了|别跑了|取消|中断|算了)/,
  /\b(?:stop|cancel|abort|halt)\b/i,
];

/**
 * 动作词：命中即视为可能需要动手，转专属执行体。
 *
 * 词表刻意放宽（含「看/弄/搞/查」这类泛动作）：误转的成本是多开一条上下文，
 * 误留主会话的成本是整群被一条长任务拖住——两者不对称，所以宁可多转。
 */
const ACTION_PATTERNS: readonly RegExp[] = [
  /(?:改|修改|执行|运行|跑|生成|提交|排查|定位|部署|安装|写|测试|修复|打包|上传|下载|删除|重命名|迁移|重构|优化|分析|检查|对比|导出|导入|实现|接入|改造)/,
  /(?:看|查|弄|搞|处理|整理|准备|安排|收拾|算|修|调|换|加|找|搜|读|打开|启动|停止|重启|清理|备份|恢复)/,
  /\b(?:run|build|fix|deploy|commit|test|create|write|refactor|install|upgrade|implement|check|review|restart|backup|restore)\b/i,
];

/**
 * 指代词：出现即说明依赖上下文，主会话没有那段上下文，转执行体更合适。
 */
const REFERENCE_PATTERN = /(?:这个|那个|刚才|上面|前面|之前那|上一条|上一|刚才那)/;

/**
 * 纯闲聊白名单：整句命中才留在主会话。
 *
 * 用「整句匹配」而不是包含匹配——「谢谢，帮我改一下」不该被当成闲聊。
 */
const CHITCHAT_PATTERNS: readonly RegExp[] = [
  /^(?:你好|您好|嗨|哈喽|hi|hello|在吗|在不在|早|早上好|早安|晚安|晚上好)\s*[!！。~～,.，]*$/i,
  /^(?:谢谢|感谢|多谢|好的|好|行|可以|收到|嗯+|哦+|ok|okay|明白|了解|辛苦了|不错|厉害|棒)\s*[!！。~～,.，]*$/i,
  /^(?:哈+|嘿+|呵+|笑死|哈哈+)\s*[!！。~～,.，]*$/i,
];

/** 闲聊长度上限：超过这个长度且没有动作词，仍按执行体处理（偏安全）。 */
const CHITCHAT_MAX_LENGTH = 12;

/**
 * 对一条消息做分拣。
 *
 * @param message - 入站消息。
 * @returns 意图、目标执行体键与判定理由。
 */
export function route(message: InboundMessage): RouteDecision {
  const text = message.text.trim();
  const speakerKey = actorKeyOf(message.chatId, message.senderOpenId);

  for (const pattern of INTERRUPT_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: 'interrupt', key: speakerKey, reason: '命中中断指令，只作用于说话人' };
    }
  }

  if (message.images !== undefined && message.images.length > 0) {
    return { intent: 'task', key: speakerKey, reason: '带图片输入，转执行体处理' };
  }

  if (message.files !== undefined && message.files.length > 0) {
    return { intent: 'task', key: speakerKey, reason: '带文件输入，转执行体处理' };
  }

  for (const pattern of ACTION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: 'task', key: speakerKey, reason: '命中动作词，转出主会话' };
    }
  }

  if (REFERENCE_PATTERN.test(text)) {
    return { intent: 'task', key: speakerKey, reason: '含上下文指代，主会话没有那段上下文' };
  }

  // 闲聊与短句也进说话人自己的会话：共享主会话会让「追问」掉进另一段上下文，
  // 出现「你先说 1 我再回答」这种答非所问。一人一会话，上下文才连续。
  for (const pattern of CHITCHAT_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: 'chat', key: speakerKey, reason: '整句命中闲聊白名单（仍走本人会话）' };
    }
  }

  if (text.length <= CHITCHAT_MAX_LENGTH) {
    return { intent: 'chat', key: speakerKey, reason: '短句且无动作词（仍走本人会话）' };
  }

  // 兜底：未识别的长句一律转执行体。主会话的职责是「随手回一句」，不是「处理未知请求」。
  return {
    intent: 'task',
    key: speakerKey,
    reason: '未命中闲聊特征，按偏安全默认转专属执行体',
  };
}
