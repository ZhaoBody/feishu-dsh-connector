import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamingCard, type CardTransport } from '../src/streaming-card.ts';

/** 记录发送与更新。 */
class FakeCards implements CardTransport {
  readonly sent: Array<{ messageId: string; card: object }> = [];
  readonly updates: Array<{ messageId: string; card: object }> = [];
  private counter = 0;

  async sendCard(_chatId: string, card: object): Promise<string> {
    this.counter += 1;
    const messageId = `om_card_${this.counter}`;
    this.sent.push({ messageId, card });
    return messageId;
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.updates.push({ messageId, card });
  }
}

/** 从卡片 JSON 里取正文。 */
function contentOf(card: object): string {
  // 卡片 2.0：正文在 body.elements
  const elements = (card as { body?: { elements?: Array<{ content?: string }> } }).body?.elements;
  return elements?.[0]?.content ?? '';
}

describe('流式卡片', () => {
  it('内容超上限时自动滚动新卡', async () => {
    const transport = new FakeCards();
    const card = new StreamingCard(transport, 'oc_a', undefined, {
      maxChars: 10,
      throttleMs: 0,
      now: () => 0,
      logger: { warn: () => {} },
    });

    await card.open();
    card.push('0123456789ABCDEFGHIJ');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(transport.sent.length, 2, '应发出两张卡');
    assert.match(contentOf(transport.sent[0]!.card), /处理中/, '首卡是占位帧');
    assert.equal(card.id, 'om_card_2', '活动卡片应切到新卡');
  });

  it('滚动时回调新卡 id，便于登记撤回', async () => {
    const transport = new FakeCards();
    const ids: string[] = [];
    const card = new StreamingCard(transport, 'oc_a', undefined, {
      maxChars: 5,
      throttleMs: 0,
      now: () => 0,
      onNewCard: (id) => ids.push(id),
      logger: { warn: () => {} },
    });

    await card.open();
    card.push('1234567890');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(ids, ['om_card_2']);
  });
});
