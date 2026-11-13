import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { absolutePathsIn, apply, findEscape } from '../index.js';

/** 构造一个最小 ctx，捕获 pre-execute handler。 */
function makeCtx(workspaces = ['/srv/project', '/srv/docs']) {
  const handlers = {};
  const ctx = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    workspaceRegistry: { list: () => workspaces.map((path) => ({ path })) },
    logger: { warn: () => {} },
  };
  return { ctx, handlers };
}

/** 调一次钩子。 */
async function call(handlers, toolName, args, sessionId) {
  const handler = handlers['tools/pre-execute'];
  return handler(
    { name: toolName, arguments: args, agent: { session: { id: sessionId } } },
    async () => ({ kind: 'allow' }),
  );
}

describe('路径提取与越界判定', () => {
  it('从参数里提取绝对路径', () => {
    const paths = absolutePathsIn({ path: '/srv/project/a.md', other: ['/tmp/x'] });
    assert.deepEqual(paths.sort(), ['/srv/project/a.md', '/tmp/x']);
  });

  it('包含 .. 一律拒绝', () => {
    assert.match(findEscape({ path: '../../etc/passwd' }, ['/srv/project']) ?? '', /\.\./);
  });

  it('白名单外的绝对路径被拒绝', () => {
    const reason = findEscape({ path: '/home/u/.ssh/id_rsa' }, ['/srv/project']);
    assert.match(reason ?? '', /不在任何项目工作区/);
  });

  it('白名单内放行', () => {
    assert.equal(findEscape({ path: '/srv/project/docs/a.md' }, ['/srv/project']), undefined);
  });

  it('前缀相似但不同目录不算之内', () => {
    assert.notEqual(findEscape({ path: '/srv/project-x/a.md' }, ['/srv/project']), undefined);
  });
});

describe('工具拦截（只对飞书会话）', () => {
  it('写操作被拒绝', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const decision = await call(handlers, 'write', { path: '/srv/project/a.md' }, 'feishu-123');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /只读/);
  });

  it('命令执行被拒绝', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const decision = await call(handlers, 'bash', { command: 'cat /etc/passwd' }, 'feishu-123');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /禁止执行命令/);
  });

  it('读项目内文件放行', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const decision = await call(handlers, 'read', { path: '/srv/project/README.md' }, 'feishu-123');
    assert.equal(decision.kind, 'allow');
  });

  it('读个人目录被拒绝', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const decision = await call(handlers, 'read', { path: '/home/u/.ssh/id_rsa' }, 'feishu-123');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /只能读项目工作区/);
  });

  it('owner 的飞书会话（feishu-owner- 前缀）完全放行', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    assert.equal((await call(handlers, 'bash', { command: 'ls /' }, 'feishu-owner-abc')).kind, 'allow');
    assert.equal((await call(handlers, 'write', { path: '/srv/project/a.md' }, 'feishu-owner-abc')).kind, 'allow');
    assert.equal((await call(handlers, 'read', { path: '/home/u/.ssh/id_rsa' }, 'feishu-owner-abc')).kind, 'allow');
  });

  it('非飞书会话完全不受影响', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    assert.equal((await call(handlers, 'bash', { command: 'ls /' }, 'session-abc')).kind, 'allow');
    assert.equal((await call(handlers, 'read', { path: '/home/u/.ssh/id_rsa' }, 'session-abc')).kind, 'allow');
  });

  it('无关工具（提问/定时）放行', async () => {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    assert.equal((await call(handlers, 'ask_user_question', {}, 'feishu-123')).kind, 'allow');
  });
});
