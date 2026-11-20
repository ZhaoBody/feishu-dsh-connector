import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SubagentCollector } from '../src/subagent-collector.ts';

/** 构造一个假 RPC，记录被调用的端点。 */
function makeRpc(options: { sessions: unknown[]; records: unknown[] }) {
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    call: async (endpoint: string, args: Record<string, unknown> = {}) => {
      calls.push({ endpoint, args });
      if (endpoint === 'session/list') return { items: options.sessions };
      if (endpoint === 'session/page') return { records: options.records };
      if (endpoint === 'session/prompt') return { accepted: true };
      return {};
    },
  };
}

/** 建一个临时 dir 写 actors/state。 */
function makeFiles(mains: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-'));
  const actors = { version: 1, actors: Object.fromEntries(Object.entries(mains).map(([k, v]) => [k, { sessionId: v }])) };
  const actorsFile = join(dir, 'actors.json');
  writeFileSync(actorsFile, JSON.stringify(actors));
  return { dir, actorsFile, stateFile: join(dir, 'collector.json') };
}

/** 造一条 assistant 文本记录。 */
function recordWithText(text: string) {
  return { event: { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text }] } } } };
}

/** 造一条 turn/end 记录。 */
function recordTurnEnd() {
  return { event: { type: 'turn/end', seq: 10 } };
}

describe('SubagentCollector', () => {
  it('把完成的子任务结果投回主对话', async () => {
    const files = makeFiles({ 'oc_a::__main__': 'feishu-owner-1' });
    const rpc = makeRpc({
      sessions: [{ sessionId: 'sub-1', running: false, origin: 'subagent', parentSessionId: 'feishu-owner-1', projections: { asOfSeq: 10 } }],
      records: [recordWithText('子任务结果：lab-ok'), recordTurnEnd()],
    });
    const collector = new SubagentCollector({ rpc, actorsFile: files.actorsFile, stateFile: files.stateFile });
    await collector.tick();

    const prompt = rpc.calls.find((c) => c.endpoint === 'session/prompt');
    assert.ok(prompt, '应当向主对话注入 prompt');
    const text = String((prompt.args.request as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '');
    assert.match(text, /子任务完成/);
    assert.match(text, /lab-ok/);
    rmSync(files.dir, { recursive: true, force: true });
  });

  it('同一子任务不重复回流', async () => {
    const files = makeFiles({ 'oc_a::__main__': 'feishu-owner-1' });
    const rpc = makeRpc({
      sessions: [{ sessionId: 'sub-1', running: false, origin: 'subagent', parentSessionId: 'feishu-owner-1', projections: { asOfSeq: 10 } }],
      records: [recordWithText('ok'), recordTurnEnd()],
    });
    const collector = new SubagentCollector({ rpc, actorsFile: files.actorsFile, stateFile: files.stateFile });
    await collector.tick();
    await collector.tick();
    const prompts = rpc.calls.filter((c) => c.endpoint === 'session/prompt');
    assert.equal(prompts.length, 1, '第二次 tick 不应重复注入');
    rmSync(files.dir, { recursive: true, force: true });
  });

  it('还在跑的子任务不回流', async () => {
    const files = makeFiles({ 'oc_a::__main__': 'feishu-owner-1' });
    const rpc = makeRpc({
      sessions: [{ sessionId: 'sub-1', running: true, origin: 'subagent', parentSessionId: 'feishu-owner-1', projections: { asOfSeq: 5 } }],
      records: [],
    });
    const collector = new SubagentCollector({ rpc, actorsFile: files.actorsFile, stateFile: files.stateFile });
    await collector.tick();
    assert.equal(rpc.calls.filter((c) => c.endpoint === 'session/prompt').length, 0);
    rmSync(files.dir, { recursive: true, force: true });
  });

  it('父会话不是主对话时不回流', async () => {
    const files = makeFiles({ 'oc_a::__main__': 'feishu-owner-1' });
    const rpc = makeRpc({
      sessions: [{ sessionId: 'sub-1', running: false, origin: 'subagent', parentSessionId: 'some-other', projections: { asOfSeq: 10 } }],
      records: [{ event: { type: 'turn/end', seq: 10 } }],
    });
    const collector = new SubagentCollector({ rpc, actorsFile: files.actorsFile, stateFile: files.stateFile });
    await collector.tick();
    assert.equal(rpc.calls.filter((c) => c.endpoint === 'session/prompt').length, 0);
    rmSync(files.dir, { recursive: true, force: true });
  });
});
