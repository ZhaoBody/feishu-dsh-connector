/**
 * 飞书卡片构造：把一段 Markdown 变成可 patch 的卡片 JSON。
 *
 * 卡片是「流式」的载体——同一张卡片反复 patch，用户看到的是内容在生长，
 * 而不是一条条新消息。`update_multi: true` 是 patch 共享卡片的前提。
 */

/** 卡片所处的阶段，决定标题与配色。 */
export type CardPhase = 'running' | 'done' | 'error';

/**
 * 构造卡片 JSON。
 *
 * 用**卡片 2.0 schema**（`schema` / `body`），不用 1.0 的 `elements`：
 * 1.0 的 `lark_md` 只支持加粗/斜体/链接，列表、行内代码、代码块、表格全都不渲染
 * （实测「- 项」「`code`」「| 表 |」都是原样文本）。2.0 的 markdown 组件全都支持。
 */
export function buildCard(text: string, phase: CardPhase, title: string): object {
  const template = phase === 'error' ? 'red' : phase === 'done' ? 'green' : 'blue';
  const body = text.trim().length > 0 ? text : phase === 'running' ? '_处理中…_' : '_(无内容)_';
  return {
    schema: '2.0',
    // update_multi 是原地 patch（流式更新）的前提，2.0 同样需要。
    config: { update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [{ tag: 'markdown', content: body }],
    },
  };
}

/** 卡片标题：按阶段给出可读状态，避免用户盯着「处理中」不知道发生了什么。 */
export function titleFor(phase: CardPhase): string {
  switch (phase) {
    case 'running':
      return '正在处理';
    case 'done':
      return '已完成';
    case 'error':
      return '执行失败';
    default:
      return '回复';
  }
}
