/**
 * 文件日志：把接入层与执行体的事件落到磁盘，供事后复盘。
 *
 * 为什么需要它：聊天窗口里的消息会被撤回、会被翻过去，出事时唯一可复盘的
 * 就是磁盘上的记录。写入走串行队列，避免并发交错；超过上限自动滚动一份。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志器形状：接入层与执行体都只用到其中一部分。 */
export interface FileLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** 等待已排队的写入完成。 */
  flush(): Promise<void>;
}

/** 配置。 */
export interface FileLoggerOptions {
  /** 单文件上限，超过后滚动为 `<file>.1`，默认 5MB。 */
  readonly maxBytes?: number;
  /** 注入时钟，便于测试。 */
  readonly now?: () => number;
  /** 同时输出到 stderr（默认 false）。 */
  readonly echo?: boolean;
}

/** 默认单文件上限。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 创建文件日志器。
 *
 * @param file - 日志文件绝对路径；父目录会自动创建。
 */
export function createFileLogger(file: string, options: FileLoggerOptions = {}): FileLogger {
  mkdirSync(dirname(file), { recursive: true });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => Date.now());
  const echo = options.echo ?? false;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const write = (level: LogLevel, message: string): void => {
    if (closed) return;
    const line = `${new Date(now()).toISOString()} [${level}] ${message}\n`;
    if (echo) process.stderr.write(line);
    chain = chain
      .then(() => {
        rotateIfNeeded();
        appendFileSync(file, line, 'utf8');
      })
      .catch((error: unknown) => {
        // 日志本身写失败不能再抛（会打断业务），只能打到 stderr。
        process.stderr.write(`[logger] 写日志失败：${String(error)}\n`);
      });
  };

  /** 超过上限时把当前文件滚动成 `.1`（只保留一份历史）。 */
  const rotateIfNeeded = (): void => {
    if (!existsSync(file)) return;
    if (statSync(file).size < maxBytes) return;
    const backup = `${file}.1`;
    if (existsSync(backup)) renameSync(backup, `${backup}.tmp`);
    renameSync(file, backup);
  };

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    flush: async () => {
      await chain;
    },
  };
}
