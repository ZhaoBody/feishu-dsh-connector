import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { syncOnce } from '../lib/registrar.js';

/** 假工作区：记录挂载调用。 */
function fakeWorkspace(existing) {
  const attached = [];
  return {
    attached,
    create: async () => ({
      sessionIds: [...existing, ...attached],
      attachSession: async (id) => {
        attached.push(id);
      },
    }),
  };
}

const config = {
  workspacePath: '/home/u/ws',
  workspaceTitle: '测试工作区',
};

describe('syncOnce', () => {
  it('只挂新出现的会话', async () => {
    const workspace = fakeWorkspace(['feishu-a']);
    const attached = await syncOnce({
      registry: { create: workspace.create },
      config,
      sessionsRoot: '/root',
      listSessionIds: async () => ['feishu-a', 'feishu-b', 'feishu-c'],
    });

    assert.deepEqual(attached, ['feishu-b', 'feishu-c']);
    assert.deepEqual(workspace.attached, ['feishu-b', 'feishu-c']);
  });

  it('没有新会话时返回空数组', async () => {
    const workspace = fakeWorkspace(['feishu-a']);
    const attached = await syncOnce({
      registry: { create: workspace.create },
      config,
      sessionsRoot: '/root',
      listSessionIds: async () => ['feishu-a'],
    });
    assert.deepEqual(attached, []);
  });

  it('单个会话失败不影响其它', async () => {
    const calls = [];
    const registry = {
      create: async () => ({
        sessionIds: [],
        attachSession: async (id) => {
          calls.push(id);
          if (id === 'bad') throw new Error('boom');
        },
      }),
    };
    const warnings = [];
    const attached = await syncOnce({
      registry,
      config,
      sessionsRoot: '/root',
      listSessionIds: async () => ['bad', 'good'],
      logger: { warn: (message) => warnings.push(message) },
    });

    assert.deepEqual(attached, ['good']);
    assert.deepEqual(calls, ['bad', 'good']);
    assert.match(warnings[0] ?? '', /挂载 bad 失败/);
  });
});
