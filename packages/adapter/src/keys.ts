/**
 * 执行体键的构造与解析。
 *
 * 键格式 `chatId::identity`：飞书 chat_id（oc_…）与 open_id（ou_…）都不含 `::`，
 * 因此分隔符无歧义。主会话用保留身份 `__main__`。
 */

import type { ActorKey } from '@feishu-assistant/dsh-executor/contract';

/** 主会话身份占位符：同群共享的闲聊上下文。 */
export const MAIN_ACTOR = '__main__';

/** 同一人在同一群内的执行体键。 */
export function actorKeyOf(chatId: string, openId: string): ActorKey {
  return `${chatId}::${openId}`;
}

/** 某个群的主会话键。 */
export function mainKeyOf(chatId: string): ActorKey {
  return `${chatId}::${MAIN_ACTOR}`;
}

/**
 * 从执行体键还原 chatId 与身份。
 *
 * @param key - 合法的执行体键。
 * @returns chatId 与身份段；格式不合法时返回 `undefined`（调用方负责报错，不猜）。
 */
export function parseActorKey(key: string): { chatId: string; identity: string } | undefined {
  const index = key.indexOf('::');
  if (index <= 0 || index === key.length - 2) return undefined;
  return { chatId: key.slice(0, index), identity: key.slice(index + 2) };
}
