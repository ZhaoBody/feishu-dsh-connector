/**
 * 极简 NDJSON-RPC 客户端：一行一个 JSON 消息，走子进程的 stdin/stdout。
 *
 * 不直接依赖 `@deepseek-ai/dsh-sdk-protocol`：包版本与运行中的 dsh 不一致时，
 * 依赖会带来类型与行为漂移；行协议本身只有三种消息，自己实现更可控。
 */

import type { Readable, Writable } from 'node:stream';

/** 日志器（与其它模块保持同一最小形状）。 */
export interface RpcLogger {
  warn(message: string): void;
  debug(message: string): void;
}

/** 一行的 JSON 消息。 */
type Wire = Record<string, unknown>;

/** 客户端可选配置。 */
export interface RpcClientOptions {
  /** 单次请求超时（默认 30 分钟：agent 任务可能很长）。 */
  readonly requestTimeoutMs?: number;
  readonly logger?: RpcLogger;
}

/** 请求被拒绝（对端返回 error 或超时）。 */
export class RpcRequestError extends Error {
  readonly method: string;
  readonly data: unknown;

  constructor(method: string, message: string, data?: unknown) {
    super(`JSON-RPC ${method} 失败：${message}`);
    this.name = 'RpcRequestError';
    this.method = method;
    this.data = data;
  }
}

/**
 * 行协议客户端。
 *
 * 生命周期由调用方持有：`close()` 只解绑监听，不销毁流（流的归属是子进程）。
 */
export class LineRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notificationHandlers = new Set<(method: string, params: Wire) => void>();
  private buffer = '';
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly logger: RpcLogger;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onData = (chunk: Buffer | string): void => this.consume(chunk.toString());

  constructor(
    input: Readable,
    output: Writable,
    options: RpcClientOptions = {},
  ) {
    this.input = input;
    this.output = output;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30 * 60_000;
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
    this.input.on('data', this.onData);
  }

  /** 订阅服务端通知。返回解绑函数。 */
  onNotification(handler: (method: string, params: Wire) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /** 发一个请求并等待对应响应。 */
  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcRequestError(method, '连接已关闭'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcRequestError(method, `超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      this.output.write(line, (error) => {
        if (error === null || error === undefined) return;
        this.settle(id, undefined, new RpcRequestError(method, `写入失败：${error.message}`));
      });
    });
  }

  /** 解绑监听并拒绝所有未完成请求。 */
  close(reason = '连接已关闭'): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.onData);
    for (const id of [...this.pending.keys()]) {
      this.settle(id, undefined, new RpcRequestError('(pending)', reason));
    }
    this.notificationHandlers.clear();
  }

  /** 解析一行并分发。非 JSON 行只记 debug，不中断流。 */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: Wire;
    try {
      message = JSON.parse(line) as Wire;
    } catch {
      this.logger.warn(`忽略非 JSON 行：${line.slice(0, 200)}`);
      return;
    }
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id !== undefined) {
      const error = message.error as { message?: string; data?: unknown } | undefined;
      if (error !== undefined) {
        this.settle(id, undefined, new RpcRequestError(String(message.method ?? ''), String(error.message ?? '未知错误'), error.data));
      } else {
        this.settle(id, message.result, undefined);
      }
      return;
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method === undefined) return;
    const params = (message.params ?? {}) as Wire;
    for (const handler of this.notificationHandlers) handler(method, params);
  }

  private settle(id: number, result: unknown, error: Error | undefined): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error !== undefined) entry.reject(error);
    else entry.resolve(result);
  }
}
