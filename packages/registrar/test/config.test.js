import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG, validateConfig } from '../lib/config.js';

describe('配置校验', () => {
  it('缺少 workspacePath 时抛错（不猜默认目录）', () => {
    assert.throws(() => validateConfig(), /必须配置 workspacePath/);
  });

  it('补齐 workspacePath 后返回完整配置', () => {
    const config = validateConfig({ workspacePath: '/srv/feishu-workspace' });
    assert.equal(config.workspacePath, '/srv/feishu-workspace');
    assert.equal(config.intervalMs, DEFAULT_CONFIG.intervalMs);
  });

  it('相对路径被拒绝', () => {
    assert.throws(() => validateConfig({ workspacePath: 'relative/path' }), /绝对路径/);
  });

  it('空标题被拒绝', () => {
    assert.throws(() => validateConfig({ workspacePath: '/srv/ws', workspaceTitle: '   ' }), /不能为空/);
  });

  it('过小的间隔被拒绝', () => {
    assert.throws(() => validateConfig({ workspacePath: '/srv/ws', intervalMs: 100 }), /intervalMs/);
  });

  it('合法覆盖被接受', () => {
    const config = validateConfig({ workspacePath: '/srv/ws', intervalMs: 60_000 });
    assert.equal(config.intervalMs, 60_000);
    assert.equal(config.workspacePath, '/srv/ws');
  });
});
