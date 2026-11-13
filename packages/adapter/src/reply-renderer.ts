/**
 * 回复渲染：把执行体事件流收敛成「当前该显示的一段文本」。
 *
 * 这一层刻意不依赖飞书 SDK：它只产出文本与状态，发不发卡、发到哪由连接层决定。
 * 首版是纯文本（不流式 patch 卡片），后续接卡片时只换渲染器，不动执行体。
 */

import type { ExecutorEvent } from '@feishu-assistant/dsh-executor/contract';

/** 一帧回复快照。 */
export interface ReplySnapshot {
  /** 当前累积的正文（Markdown）。 */
  readonly text: string;
  /** 生命周期状态。 */
  readonly state: 'running' | 'done' | 'error';
}

/**
 * 回复收集器：按事件更新内部快照。
 *
 * 用法：把执行体的 `EventSink.emit` 直接接到 `onEvent`，需要发包时读 `snapshot`。
 */
export class ReplyCollector {
  private text = '';
  private state: ReplySnapshot['state'] = 'running';
  private failure: string | undefined;

  /** 消费一个执行体事件。 */
  onEvent(event: ExecutorEvent): void {
    switch (event.type) {
      case 'status':
        if (event.state === 'running') this.state = 'running';
        return;
      case 'delta':
        this.text = event.text;
        return;
      case 'done':
        this.text = event.text;
        this.state = 'done';
        return;
      case 'error':
        this.failure = event.message;
        this.state = 'error';
        return;
      default:
        return;
    }
  }

  /** 当前快照。 */
  get snapshot(): ReplySnapshot {
    if (this.state === 'error') {
      return { text: formatFailure(this.failure ?? '未知错误'), state: 'error' };
    }
    return { text: this.text, state: this.state };
  }

  /** 是否已有可发送的正文（渲染层据此决定发不发空消息）。 */
  get hasText(): boolean {
    return this.snapshot.text.trim().length > 0;
  }
}

/** 把错误文本包装成用户可读的一段话（失败必须可见，宪法第八条）。 */
export function formatFailure(message: string): string {
  return `⚠️ 执行失败：${message}`;
}
