/**
 * 通过 dsh web 的 HTTP API 驱动 agent 的 RPC 客户端。
 *
 * 为什么走这条路：bridge 原本自己 spawn `dsh --profile sdk` 子进程，于是
 * 同一个 session 有两个写者，flock 互斥——Web 里打开过的会话 bridge 就写不进去。
 * 改成通过 web 的 API 调用，**web 永远是唯一写者**，锁冲突从根上消失，
 * 同时 bridge 仍是独立进程、保留自己的沙箱边界。
 *
 * 协议（全部实测确认）：
 * - 认证：`GET /connect?token=<启动令牌>&interactions=none` → 签名 cookie（30 天）
 * - 调用：`POST /api/<namespace>/<method>`，body `{type:'client-request', rpcId, method, payload:{args}}`
 * - args 的 key 是**方法参数名**（如 prompt 要 `{request:{...}}`，list 要 `{_request:{}}`）
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** RPC 客户端配置。 */
export interface WebRpcOptions {
  /** dsh web 地址，默认 `http://127.0.0.1:3080`。 */
  readonly baseUrl?: string;
  /** 启动令牌文件；缺省 `~/.dsh/logs/dsh-web-auth-url.txt`（每次重启 web 会更新）。 */
  readonly tokenFile?: string;
  /** 单次调用超时，默认 60 秒。 */
  readonly timeoutMs?: number;
  readonly logger?: { warn(message: string): void; debug(message: string): void };
}

/** RPC 业务错误（gateway 返回的 structured error）。 */
export class WebRpcError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(endpoint: string, code: string, message: string, details?: unknown) {
    super(`${endpoint} 失败：${code} — ${message}`);
    this.name = 'WebRpcError';
    this.code = code;
    this.details = details;
  }
}

/**
 * dsh web 的 RPC 客户端。
 *
 * cookie 过期（web 重启后 token 变）会自动重新换一次，调用方无需关心。
 */
export class WebRpcClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly logger: { warn(message: string): void; debug(message: string): void };
  private cookie = '';
  private rpcId = 0;

  constructor(options: WebRpcOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3080';
    this.tokenFile = options.tokenFile ?? join(homedir(), '.dsh', 'logs', 'dsh-web-auth-url.txt');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
  }

  /** 调用一个一元 Remote 端点。 */
  async call<T = unknown>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.callWithRetry<T>(endpoint, args, true);
  }

  private async callWithRetry<T>(endpoint: string, args: Record<string, unknown>, retryOnAuth: boolean): Promise<T> {
    if (this.cookie === '') await this.authenticate();
    const body = {
      type: 'client-request',
      rpcId: `bridge-${++this.rpcId}`,
      method: endpoint,
      payload: { args },
    };
    const response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401 && retryOnAuth) {
      // web 重启后 token 变了：重新换 cookie 再试一次。
      this.logger.debug('[rpc] cookie 失效，重新认证');
      await this.authenticate();
      return this.callWithRetry<T>(endpoint, args, false);
    }
    const text = await response.text();
    if (!text.startsWith('{')) {
      throw new WebRpcError(endpoint, `http-${response.status}`, text.slice(0, 200));
    }
    const envelope = JSON.parse(text) as {
      result?: { ok?: boolean; value?: T; error?: { code?: string; message?: string; details?: unknown } };
    };
    const result = envelope.result;
    if (result?.ok !== true) {
      throw new WebRpcError(
        endpoint,
        result?.error?.code ?? 'unknown',
        result?.error?.message ?? '未返回错误详情',
        result?.error?.details,
      );
    }
    return result.value as T;
  }

  /** 用启动令牌换 API cookie。 */
  private async authenticate(): Promise<void> {
    const token = this.readToken();
    const response = await fetch(
      `${this.baseUrl}/connect?token=${encodeURIComponent(token)}&interactions=none`,
      { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) },
    );
    const setCookie = response.headers.get('set-cookie');
    if (setCookie === null || setCookie === '') {
      throw new WebRpcError('/connect', 'auth-failed', `HTTP ${response.status}，未返回 cookie`);
    }
    this.cookie = setCookie.split(';')[0] ?? '';
    this.logger.debug(`[rpc] 认证成功（${this.cookie.slice(0, 16)}…）`);
  }

  /** 读启动令牌；文件每次重启都会变，所以每次都读。 */
  private readToken(): string {
    const raw = readFileSync(this.tokenFile, 'utf8').trim();
    const match = /token=([^&\s]+)/.exec(raw);
    if (match?.[1] === undefined) {
      throw new WebRpcError('/connect', 'token-missing', `无法从 ${this.tokenFile} 读到 token`);
    }
    return match[1];
  }
}
