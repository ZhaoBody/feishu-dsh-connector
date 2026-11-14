/**
 * 飞书发送接口（本地 HTTP）。
 *
 * 为什么单独做成接口：发送能力不该锁在 bridge 内部当回调。告警脚本、cron、
 * 别的 agent、甚至你在终端里 `curl` 一下，都应该能往群里发一条消息。
 *
 * 暴露方式：只绑 127.0.0.1（同机可达，外网不可达）。可选 token 鉴权，
 * 由 `DSH_FEISHU_SEND_TOKEN` 决定；不配就是不鉴权（回环地址，风险可控）。
 *
 *   POST /send   {"chatId":"oc_xxx","text":"...","kind":"text"|"card"}
 *   GET  /health → {"ok":true}
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 发送回调：由接入层提供真正的发送实现。 */
export type SendFunction = (chatId: string, text: string) => Promise<{ ok: boolean; messageId?: string; error?: string }>;

/** 接口配置。 */
export interface SendApiConfig {
  /** 监听端口，默认 3090。 */
  readonly port?: number;
  /** 监听地址，默认 127.0.0.1（不要改成 0.0.0.0）。 */
  readonly host?: string;
  /** 可选鉴权 token；设置后请求需带 `Authorization: Bearer <token>`。 */
  readonly token?: string;
  /** 真正的发送实现。 */
  readonly send: SendFunction;
  /** 单请求体上限，默认 256KB（飞书文本上限远小于此）。 */
  readonly maxBodyBytes?: number;
  readonly logger?: { warn(message: string): void; info(message: string): void };
}

/** 发送接口服务。 */
export class SendApi {
  private readonly config: SendApiConfig;
  private readonly logger: { warn(message: string): void; info(message: string): void };
  private server: Server | undefined;

  constructor(config: SendApiConfig) {
    this.config = config;
    this.logger = config.logger ?? { warn: () => {}, info: () => {} };
  }

  /** 启动监听；端口占用时抛错（fail loud，不静默降级）。 */
  async start(): Promise<{ port: number }> {
    if (this.server !== undefined) throw new Error('SendApi 已启动');
    const host = this.config.host ?? '127.0.0.1';
    const port = this.config.port ?? 3090;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    const actual = typeof address === 'object' && address !== null ? address.port : port;
    this.logger.info(`[send-api] 监听 http://${host}:${actual}`);
    return { port: actual };
  }

  /** 停止监听。 */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** 处理一个请求。 */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        this.writeJson(response, 200, { ok: true });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/send') {
        this.writeJson(response, 404, { ok: false, error: 'not found' });
        return;
      }
      // 鉴权（配置了 token 才校验）。
      if (this.config.token !== undefined) {
        const header = request.headers.authorization ?? '';
        if (header !== `Bearer ${this.config.token}`) {
          this.writeJson(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      }
      const body = await this.readBody(request);
      const parsed = JSON.parse(body) as { chatId?: unknown; text?: unknown };
      if (typeof parsed.chatId !== 'string' || parsed.chatId.length === 0) {
        this.writeJson(response, 400, { ok: false, error: 'chatId 必填' });
        return;
      }
      if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0) {
        this.writeJson(response, 400, { ok: false, error: 'text 必填' });
        return;
      }
      const result = await this.config.send(parsed.chatId, parsed.text);
      this.writeJson(response, result.ok ? 200 : 502, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[send-api] 请求失败：${message}`);
      this.writeJson(response, 500, { ok: false, error: message });
    }
  }

  /** 读请求体，超限直接拒绝。 */
  private async readBody(request: IncomingMessage): Promise<string> {
    const limit = this.config.maxBodyBytes ?? 256 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > limit) throw new Error(`请求体超过 ${limit} 字节`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(text);
  }
}
