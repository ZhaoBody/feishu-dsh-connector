import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFileLogger } from '../src/file-logger.ts';

describe('文件日志', () => {
  it('按级别写入并可 flush 等待落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const file = join(dir, 'bridge.log');
    const logger = createFileLogger(file, { now: () => 1_700_000_000_000 });

    logger.info('路由 oc_a::ou_a → task');
    logger.warn('执行体失败：超时');
    await logger.flush();

    const content = readFileSync(file, 'utf8');
    assert.match(content, /\[info\] 路由 oc_a::ou_a → task/);
    assert.match(content, /\[warn\] 执行体失败：超时/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('超过上限时滚动一份历史', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const file = join(dir, 'bridge.log');
    writeFileSync(file, 'x'.repeat(200), 'utf8');
    const logger = createFileLogger(file, { maxBytes: 100, now: () => 1_700_000_000_000 });

    logger.info('触发滚动');
    await logger.flush();

    const rolled = readFileSync(`${file}.1`, 'utf8');
    assert.equal(rolled.length, 200);
    assert.match(readFileSync(file, 'utf8'), /触发滚动/);
    rmSync(dir, { recursive: true, force: true });
  });
});
