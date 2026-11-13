/**
 * 飞书会话登记器（Host 侧）。
 *
 * 背景：飞书 bridge 以独立的 `dsh --profile sdk` 进程运行，它产生的会话落在
 * `~/.dsh/sessions/--<cwd 编码>--/` 下，但**从不登记**到 workspaceRegistry，
 * 于是 dsh Web 的侧边栏看不到它们。
 *
 * 本插件只做一件事：定时把该目录下的会话挂到对应工作区上。
 * 不创建会话、不改会话内容、不碰飞书；失败只告警，不影响宿主。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { validateConfig } from './lib/config.js';
import { syncOnce } from './lib/registrar.js';

/** 插件名（与 patch 行 id 一致，便于日志定位）。 */
export const name = 'feishu-session-registrar';

/** 依赖工作区注册表：没有它这个插件没有意义。 */
export const inject = ['workspaceRegistry'];

/**
 * 注册插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 * @param {Partial<import('./lib/config.js').DEFAULT_CONFIG>} [rawConfig] - patch 行配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  const sessionsRoot = join(homedir(), '.dsh', 'sessions');
  let stopped = false;
  let running = false;

  const sync = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const attached = await syncOnce({
        registry: ctx.workspaceRegistry,
        config,
        sessionsRoot,
        logger: ctx.logger,
      });
      if (attached.length > 0) {
        ctx.logger?.info?.(`feishu-session-registrar: 新登记 ${attached.length} 个会话`);
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `feishu-session-registrar: 同步失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  };

  ctx.effect(() => {
    void sync();
    const timer = setInterval(() => void sync(), config.intervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
}
