import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SessionExecutor, type ExecutorConfig } from '../src/executor.ts';
import type { EventSink, ExecutorEvent, ActorKey } from '../src/contract.ts';
import type { SpawnLike } from '../src/process-pool.ts';

const FAKE_SDK = fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url));

/** 假 spawn：忽略配置里的命令，一律用 node 跑假 SDK。 */
const fakeSpawn: SpawnLike = (_command, _args, options) =>
  spawn(process.execPath, [FAKE_SDK], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/** 收集事件，便于断言顺序。 */
function collect(): { events: ExecutorEvent[]; sink: EventSink } {
  const events: ExecutorEvent[] = [];
  return { events, sink: { emit: (event) => events.push(event) } };
}

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** 建一个指向临时目录的执行体。 */
function makeExecutor(overrides: Partial<ExecutorConfig> = {}): SessionExecutor {
  const dir = mkdtempSync(join(tmpdir(), 'executor-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const executor = new SessionExecutor({
    command: 'dsh',
    cwd: dir,
    provider: 'fake',
    model: 'fake',
    persistenceFile: join(dir, 'actors.json'),
    spawnImpl: fakeSpawn,
    ...overrides,
  });
  cleanup.push(() => executor.dispose());
  return executor;
}

describe('HttpExecutor 的会话前缀', () => {
  it('owner 与非 owner 生成不同前缀', async () => {
    const { HttpExecutor } = await import('../src/http-executor.ts');
    const executor = new HttpExecutor({
      cwd: '/srv/ws',
      persistenceFile: '/tmp/mint-test.json',
      ownerOpenIds: ['ou_owner'],
    });
    // 直接测前缀生成：这是安全边界的一部分，必须确定。
    const mint = (executor as unknown as { mintSessionId(key: string): string }).mintSessionId.bind(executor);
    assert.match(mint('oc_a::ou_owner'), /^feishu-owner-[0-9a-f]{8}$/);
    assert.match(mint('oc_a::ou_other'), /^feishu-[0-9a-f]{8}$/);
    await executor.dispose();
  });

  it('未配置 ownerOpenIds 时一律用受限前缀', async () => {
    const { HttpExecutor } = await import('../src/http-executor.ts');
    const executor = new HttpExecutor({ cwd: '/srv/ws', persistenceFile: '/tmp/mint-test2.json' });
    const mint = (executor as unknown as { mintSessionId(key: string): string }).mintSessionId.bind(executor);
    assert.match(mint('oc_a::ou_owner'), /^feishu-[0-9a-f]{8}$/);
    await executor.dispose();
  });
});

describe('SessionExecutor', () => {
  it('投递一轮并把助手文本交回', async () => {
    const executor = makeExecutor();
    const { events, sink } = collect();
    const result = await executor.run('oc_a::ou_a' as ActorKey, { text: '你好' }, sink);

    assert.equal(result.ok, true);
    assert.equal(result.text, 'echo:你好');
    assert.equal(events.at(-1)?.type, 'status');
    assert.ok(events.some((event) => event.type === 'done'));
  });

  it('同一 key 严格串行，不同 key 可并行', async () => {
    const executor = makeExecutor();
    const order: string[] = [];
    const run = async (key: ActorKey, text: string): Promise<void> => {
      const { sink } = collect();
      await executor.run(key, { text }, sink);
      order.push(text);
    };

    await Promise.all([
      run('oc_a::ou_a' as ActorKey, 'SLOW:120 first'),
      run('oc_a::ou_a' as ActorKey, 'second'),
      run('oc_a::ou_b' as ActorKey, 'third'),
    ]);

    // 同 key 的 first 必须在 second 之前；ou_b 不受影响。
    assert.ok(order.indexOf('SLOW:120 first') < order.indexOf('second'));
    assert.ok(order.includes('third'));
  });

  it('映射持久化后复用同一个 session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'executor-persist-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'actors.json');
    const key = 'oc_a::ou_a' as ActorKey;

    const first = new SessionExecutor({
      command: 'dsh',
      cwd: dir,
      provider: 'fake',
      model: 'fake',
      persistenceFile: file,
      spawnImpl: fakeSpawn,
      sessionIdMinter: () => 'session-fixed',
    });
    await first.run(key, { text: 'hi' }, collect().sink);
    await first.dispose();

    const second = new SessionExecutor({
      command: 'dsh',
      cwd: dir,
      provider: 'fake',
      model: 'fake',
      persistenceFile: file,
      spawnImpl: fakeSpawn,
      sessionIdMinter: () => 'should-not-be-used',
    });
    const { sink, events } = collect();
    await second.run(key, { text: 'again' }, sink);
    await second.dispose();

    assert.ok(events.some((event) => event.type === 'done'));
    assert.equal(second.size, 1);
  });

  it('超过 maxActors 时显式拒绝，不静默（T8）', async () => {
    const executor = makeExecutor({ maxActors: 1 });
    await executor.run('oc_a::ou_a' as ActorKey, { text: 'first' }, collect().sink);

    const { sink, events } = collect();
    const result = await executor.run('oc_a::ou_b' as ActorKey, { text: 'second' }, sink);

    assert.equal(result.ok, false);
    assert.match(result.text, /上限 1/);
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(executor.size, 1);
  });

  it('把权限模式注入子进程环境', async () => {
    let captured: NodeJS.ProcessEnv | undefined;
    const spy: SpawnLike = (command, args, options) => {
      captured = options.env;
      return fakeSpawn(command, args, options);
    };
    const executor = makeExecutor({ spawnImpl: spy, permissionMode: 'read-only' });
    await executor.run('oc_a::ou_a' as ActorKey, { text: 'hi' }, collect().sink);

    assert.equal(captured?.DSH_PERMISSION_MODE, 'read-only');
  });

  it('pending 反映排队条数，执行完归零', async () => {
    const executor = makeExecutor();
    const key = 'oc_a::ou_a' as ActorKey;

    const first = executor.run(key, { text: 'SLOW:200 first' }, collect().sink);
    const second = executor.run(key, { text: 'second' }, collect().sink);
    assert.equal(executor.pending(key), 2, '两条都在队列里');

    await Promise.all([first, second]);
    assert.equal(executor.pending(key), 0, '跑完应归零');
  });

  it('回合以错误收尾时抛出真实原因，不吞成「没有文本」', async () => {
    const executor = makeExecutor();
    const { sink, events } = collect();

    const result = await executor.run('oc_a::ou_a' as ActorKey, { text: 'TURN_ERROR 请触发' }, sink);

    assert.equal(result.ok, false);
    assert.match(result.text, /连接超时/);
    assert.equal(events.at(-1)?.type, 'error');
  });

  it('进程崩溃后下一次调用自动重建', async () => {
    const executor = makeExecutor();
    const key = 'oc_a::ou_a' as ActorKey;

    const crashed = await executor.run(key, { text: 'EXIT now' }, collect().sink);
    assert.equal(crashed.ok, false, '崩溃的回合必须失败，不能假成功');

    const recovered = await executor.run(key, { text: 'hi' }, collect().sink);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.text, 'echo:hi');
  });

  it('dispose 之后再投递会被明确拒绝', async () => {
    const executor = makeExecutor();
    await executor.dispose();
    const { sink, events } = collect();
    const result = await executor.run('oc_a::ou_a' as ActorKey, { text: 'hi' }, sink);

    assert.equal(result.ok, false);
    assert.equal(events.at(-1)?.type, 'error');
  });
});
