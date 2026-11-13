import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { OutboundRegistry } from '../src/outbound-registry.ts';
import { RecallService, describeRecall, type RecallTransport } from '../src/recall-service.ts';

const DAY = 24 * 60 * 60_000;
const T0 = 1_700_000_000_000;

/** 假传输：记录撤回调用，可设成抛错。 */
class FakeTransport implements RecallTransport {
  readonly recalled: string[] = [];
  failing = false;

  async recallMessage(messageId: string): Promise<void> {
    if (this.failing) throw new Error('im.v1.message.delete 返回 40006：消息不存在');
    this.recalled.push(messageId);
  }
}

/** 建一个临时登记表并写入若干记录。 */
function makeRegistry(
  dir: string,
  records: Array<{ messageId: string; chatId: string; createdAt: number }>,
): OutboundRegistry {
  const registry = new OutboundRegistry(join(dir, 'outbound.json'), { now: () => T0 });
  registry.load();
  for (const record of records) {
    registry.add({ ...record, kind: 'text' });
  }
  return registry;
}

describe('RecallService', () => {
  it('不传 id 时撤回该会话最近一条', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const registry = makeRegistry(dir, [
      { messageId: 'om_1', chatId: 'oc_a', createdAt: T0 - 1000 },
      { messageId: 'om_2', chatId: 'oc_a', createdAt: T0 - 500 },
    ]);
    const transport = new FakeTransport();
    const service = new RecallService(transport, registry, { now: () => T0 });

    const result = await service.recall('oc_a');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_2');
    assert.deepEqual(transport.recalled, ['om_2']);
    assert.equal(registry.size, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('空表时返回 not-found 且带空候选', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const registry = makeRegistry(dir, []);
    const service = new RecallService(new FakeTransport(), registry, { now: () => T0 });

    const result = await service.recall('oc_a');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
    assert.deepEqual(result.candidates, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it('别的会话的消息返回 forbidden，并给出候选', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const registry = makeRegistry(dir, [{ messageId: 'om_a', chatId: 'oc_a', createdAt: T0 }]);
    const service = new RecallService(new FakeTransport(), registry, { now: () => T0 });

    const result = await service.recall('oc_b', 'om_a');

    assert.equal(result.reason, 'forbidden');
    assert.equal(result.messageId, 'om_a');
    rmSync(dir, { recursive: true, force: true });
  });

  it('超出 24 小时窗口返回 expired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const registry = makeRegistry(dir, [{ messageId: 'om_old', chatId: 'oc_a', createdAt: T0 - 2 * DAY }]);
    const service = new RecallService(new FakeTransport(), registry, { now: () => T0 });

    const result = await service.recall('oc_a');

    assert.equal(result.reason, 'expired');
    rmSync(dir, { recursive: true, force: true });
  });

  it('接口失败时返回 api-error 并保留原始原因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const registry = makeRegistry(dir, [{ messageId: 'om_1', chatId: 'oc_a', createdAt: T0 }]);
    const transport = new FakeTransport();
    transport.failing = true;
    const service = new RecallService(transport, registry, { now: () => T0 });

    const result = await service.recall('oc_a');

    assert.equal(result.reason, 'api-error');
    assert.match(result.detail ?? '', /40006/);
    assert.equal(registry.size, 1, '失败时不应删除登记，允许重试');
    rmSync(dir, { recursive: true, force: true });
  });

  it('重启后仍能撤回重启前登记的消息（验收 1）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    const first = makeRegistry(dir, [{ messageId: 'om_before_restart', chatId: 'oc_a', createdAt: T0 - 1000 }]);
    await first.flush();

    // 模拟进程重启：新实例重新 load
    const second = new OutboundRegistry(join(dir, 'outbound.json'), { now: () => T0 });
    second.load();
    const service = new RecallService(new FakeTransport(), second, { now: () => T0 });

    const result = await service.recall('oc_a');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_before_restart');
    rmSync(dir, { recursive: true, force: true });
  });

  it('失败文案必须带 messageId 与原因，不允许只有一句「没有」', () => {
    const forbidden = describeRecall({
      ok: false,
      messageId: 'om_x',
      reason: 'forbidden',
      candidates: ['om_y'],
    });
    assert.match(forbidden, /om_x/);
    assert.match(forbidden, /不是本机器人/);
    assert.match(forbidden, /om_y/);
  });
});
