#!/usr/bin/env node
/**
 * 假 SDK 进程：按 NDJSON-RPC 协议应答 initialize / session/prompt / session/wait / shutdown。
 *
 * 行为约定（供测试断言）：
 * - 每个 session 记住最后一次 prompt 的文本；
 * - 收到 session/wait 时先推一条 assistant/message 事件（内容 `echo:<text>`），再回响应；
 * - 文本里带 `SLOW:<ms>` 时，事件与响应都延迟该毫秒数，用于验证串行。
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
/** @type {Map<string, string>} */
const lastText = new Map();
let closed = false;

function write(message) {
  if (closed) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const message = JSON.parse(trimmed);
  const method = message.method;
  const params = message.params ?? {};

  if (method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fake-0' } });
    return;
  }

  if (method === 'session/resume') {
    // 已存在的 session 返回成功；不存在的返回错误（模拟真实行为）。
    if (params.sessionId.includes('missing')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'session not found' } });
    } else {
      respond(message.id, {});
    }
    return;
  }

  if (method === 'session/prompt') {
    const text = textOf(params.contentBlocks);
    // 测试用：请求里带 EXIT 就模拟运行时崩溃（不回响应直接退出）。
    if (text.includes('EXIT')) {
      process.exit(1);
    }
    lastText.set(params.sessionId, text);
    respond(message.id, { messageId: `msg-${Date.now()}` });
    return;
  }

  if (method === 'session/wait') {
    const sessionId = params.sessionId;
    const text = lastText.get(sessionId) ?? '';
    // 测试用：请求里带 TURN_ERROR 就模拟「回合以错误收尾且无文本」。
    if (text.includes('TURN_ERROR')) {
      notify('session.event', {
        sessionId,
        event: {
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'error', error: { message: 'Request timed out.: 连接超时' } } },
        },
      });
      respond(message.id, {});
      return;
    }
    const slow = /SLOW:(\d+)/.exec(text);
    const delay = slow === null ? 0 : Number(slow[1]);
    setTimeout(() => {
      notify('session.event', {
        sessionId,
        event: {
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] } },
        },
      });
      respond(message.id, {});
    }, delay);
    return;
  }

  if (method === 'shutdown') {
    respond(message.id, {});
    closed = true;
    setTimeout(() => process.exit(0), 5);
    return;
  }

  respond(message.id, {});
});

/** 从 contentBlocks 里拼出文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}
