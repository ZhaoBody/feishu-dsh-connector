import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ActorKey, EventSink, Executor, RunInput, RunResult } from '@feishu-assistant/dsh-executor/contract';

import { FeishuAdapter, type ConnectionPort } from '../src/adapter.ts';
import type { InboundMessage } from '../src/message-router.ts';
import type { MessageHandler } from '../src/lark-connection.ts';
import { OutboundRegistry } from '../src/outbound-registry.ts';

/** 记录调用的假执行体。 */
class FakeExecutor implements Executor {
  readonly runs: Array<{ key: ActorKey; text: string }> = [];
  readonly interrupts: ActorKey[] = [];
  disposed = false;
  next: (sink: EventSink, text: string) => RunResult = (sink) => {
    sink.emit({ type: 'done', text: '好的' });
    return { ok: true, text: '好的' };
  };

  readonly inputs: Array<{ key: ActorKey; text: string; images: number }> = [];

  async run(key: ActorKey, input: RunInput, sink: EventSink): Promise<RunResult> {
    this.runs.push({ key, text: input.text });
    this.inputs.push({ key, text: input.text, images: input.images?.length ?? 0 });
    return this.next(sink, input.text);
  }

  /** 由测试控制：模拟「该 key 前面还有几条」 */
  waiting = 0;

  pending(): number {
    return this.waiting;
  }

  async interrupt(key: ActorKey): Promise<void> {
    this.interrupts.push(key);
  }

  async release(): Promise<void> {
    // 门面当前不调用 release；保留以满足契约。
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** 记录回复的假连接；每次发送返回递增的 messageId。 */
class FakeConnection implements ConnectionPort {
  readonly replies: Array<{ chatId: string; messageId: string; text: string }> = [];
  readonly recalled: string[] = [];
  readonly cards: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  connected = false;
  private handler: MessageHandler | undefined;
  private counter = 0;

  onMessage(handler: MessageHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async replyText(chatId: string, messageId: string, text: string): Promise<string> {
    this.replies.push({ chatId, messageId, text });
    this.counter += 1;
    return `om_out_${this.counter}`;
  }

  async recallMessage(messageId: string): Promise<void> {
    this.recalled.push(messageId);
  }

  async sendCard(_chatId: string, card: object): Promise<string> {
    this.counter += 1;
    const messageId = `om_card_${this.counter}`;
    this.cards.push({ messageId, card: card as Record<string, unknown> });
    return messageId;
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.cards.push({ messageId, card: card as Record<string, unknown> });
  }

  async deliver(message: InboundMessage): Promise<void> {
    if (this.handler === undefined) throw new Error('未注册 handler');
    await this.handler(message);
  }
}

/** 构造一条测试消息。 */
function inbound(text: string, senderOpenId = 'ou_alice'): InboundMessage {
  return { chatId: 'oc_group', senderOpenId, text, chatType: 'group', messageId: 'om_1' };
}

/** 建一套门面，返回所有部件。 */
function setup(logger?: { info(message: string): void; warn(message: string): void }): {
  adapter: FeishuAdapter;
  connection: FakeConnection;
  executor: FakeExecutor;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-test-'));
  const now = (): number => 1_700_000_000_000;
  const connection = new FakeConnection();
  const executor = new FakeExecutor();
  const registry = new OutboundRegistry(join(dir, 'outbound.json'), { now });
  registry.load();
  const adapter = new FeishuAdapter({ connection, executor, outbound: registry, now, ...(logger !== undefined ? { logger } : {}) });
  return { adapter, connection, executor, dir };
}

describe('FeishuAdapter 接线', () => {
  it('闲聊走主会话，任务走个人执行体', async () => {
    const { adapter, connection, executor, dir } = setup();
    await adapter.start();

    await connection.deliver(inbound('今天天气怎么样？'));
    await connection.deliver(inbound('帮我改一下配置'));

    assert.equal(executor.runs[0]?.key, 'oc_group::__main__');
    assert.equal(executor.runs[1]?.key, 'oc_group::ou_alice');
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('执行失败会以告警文本回执，不静默', async () => {
    const { adapter, connection, executor, dir } = setup();
    executor.next = (sink) => {
      sink.emit({ type: 'error', message: '进程崩了' });
      return { ok: false, text: '进程崩了' };
    };
    await adapter.start();

    await connection.deliver(inbound('帮我跑测试'));

    const lastCard = connection.cards.at(-1);
    const content = JSON.stringify(lastCard?.card ?? {});
    assert.match(content, /执行失败：进程崩了/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('中断只调该说话人的执行体并回执', async () => {
    const { adapter, connection, executor, dir } = setup();
    await adapter.start();

    await connection.deliver(inbound('停', 'ou_bob'));

    assert.deepEqual(executor.interrupts, ['oc_group::ou_bob']);
    assert.match(connection.replies[0]?.text ?? '', /已停止/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('每条回复都登记出站记录，可据此撤回', async () => {
    const { adapter, connection, dir } = setup();
    await adapter.start();

    await connection.deliver(inbound('帮我改一下配置'));
    const recalled = await adapter.recall('oc_group');

    assert.equal(recalled.ok, true);
    assert.match(recalled.messageId ?? '', /^om_card_/);
    assert.deepEqual(connection.recalled, [recalled.messageId]);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('并发回复时卡片按执行体隔离，内容不交叉（T6）', async () => {
    const { adapter, connection, executor, dir } = setup();
    executor.next = (sink, text) => {
      const reply = `回复:${text}`;
      sink.emit({ type: 'delta', text: reply });
      sink.emit({ type: 'done', text: reply });
      return { ok: true, text: reply };
    };
    await adapter.start();

    await Promise.all([
      connection.deliver(inbound('帮我改 A', 'ou_a')),
      connection.deliver(inbound('帮我改 B', 'ou_b')),
    ]);

    // 每张卡最后一次 patch 的内容即终态。
    const finals = new Map<string, string>();
    for (const { messageId, card } of connection.cards) {
      const elements = (card as { body?: { elements?: Array<{ content?: string }> } }).body?.elements;
      finals.set(messageId, elements?.[0]?.content ?? '');
    }
    const texts = [...finals.values()];
    assert.equal(texts.length, 2, '两个人应各自一张卡');
    assert.ok(texts.some((text) => text === '回复:帮我改 A'), `缺失 A 的卡：${JSON.stringify(texts)}`);
    assert.ok(texts.some((text) => text === '回复:帮我改 B'), `缺失 B 的卡：${JSON.stringify(texts)}`);

    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未授权用户被拒绝并收到明确提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-test-'));
    const now = (): number => 1_700_000_000_000;
    const connection = new FakeConnection();
    const executor = new FakeExecutor();
    const registry = new OutboundRegistry(join(dir, 'outbound.json'), { now });
    registry.load();
    const adapter = new FeishuAdapter({
      connection,
      executor,
      outbound: registry,
      now,
      allowedUsers: ['ou_alice'],
    });
    await adapter.start();

    await connection.deliver(inbound('帮我改配置', 'ou_stranger'));

    assert.equal(executor.runs.length, 0, '未授权用户不应触发执行体');
    assert.match(connection.replies[0]?.text ?? '', /没有使用这个机器人的权限/);

    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('该用户已有任务在跑时先回排队提示', async () => {
    const { adapter, connection, executor, dir } = setup();
    executor.waiting = 2;
    await adapter.start();

    await connection.deliver(inbound('帮我改配置'));

    assert.match(connection.replies[0]?.text ?? '', /前面还有 2 条/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('带图片的消息转执行体并透传图片数量', async () => {
    const { adapter, connection, executor, dir } = setup();
    await adapter.start();

    await connection.deliver({
      chatId: 'oc_group',
      senderOpenId: 'ou_alice',
      text: '这张图里是什么',
      chatType: 'group',
      messageId: 'om_img',
      hasAttachments: true,
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    });

    assert.equal(executor.inputs[0]?.key, 'oc_group::ou_alice');
    assert.equal(executor.inputs[0]?.images, 1);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件消息转执行体，并把落盘路径写进输入', async () => {
    const { adapter, connection, executor, dir } = setup();
    await adapter.start();

    await connection.deliver({
      chatId: 'oc_group',
      senderOpenId: 'ou_alice',
      text: '帮我看看这个日志',
      chatType: 'group',
      messageId: 'om_file',
      hasAttachments: true,
      files: [{ name: 'app.log', path: '/tmp/e2e-ws/app.log', bytes: 128 }],
    });

    const text = executor.inputs[0]?.text ?? '';
    assert.match(text, /app\.log/);
    assert.match(text, /\/tmp\/e2e-ws\/app\.log/);
    assert.match(text, /帮我看看这个日志/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('执行与撤回都会留下日志记录', async () => {
    const logs: string[] = [];
    const { adapter, connection, dir } = setup({
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    });
    await adapter.start();

    await connection.deliver(inbound('帮我改配置'));
    await adapter.recall('oc_group');

    assert.ok(logs.some((line) => line.includes('路由')), '缺路由日志');
    assert.ok(logs.some((line) => line.includes('执行 key=')), '缺执行结果日志');
    assert.ok(logs.some((line) => line.includes('撤回 chat=')), '缺撤回日志');
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('附件全部失败时回执具体原因', async () => {
    const { adapter, connection, dir } = setup();
    await adapter.start();

    await connection.deliver({
      chatId: 'oc_group',
      senderOpenId: 'ou_alice',
      text: '',
      chatType: 'group',
      messageId: 'om_bad',
      hasAttachments: true,
      attachmentErrors: ['图片格式不支持（仅支持 png / jpeg / webp / gif）'],
    });

    assert.match(connection.replies[0]?.text ?? '', /图片格式不支持/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('纯附件消息给出明确提示，不静默丢弃', async () => {
    const { adapter, connection, dir } = setup();
    await adapter.start();

    await connection.deliver({
      chatId: 'oc_group',
      senderOpenId: 'ou_alice',
      text: '',
      chatType: 'group',
      messageId: 'om_img',
      hasAttachments: true,
    });

    assert.match(connection.replies[0]?.text ?? '', /没有可处理的内容/);
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stop 会断开连接并释放执行体', async () => {
    const { adapter, connection, executor, dir } = setup();
    await adapter.start();
    await adapter.stop();

    assert.equal(connection.connected, false);
    assert.equal(executor.disposed, true);
    rmSync(dir, { recursive: true, force: true });
  });
});
