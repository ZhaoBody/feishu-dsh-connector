/**
 * 配置：默认值 + 显式校验。
 *
 * 配置错误一律抛错（不静默回落），这样 patch 写错时能在启动日志里立刻看到，
 * 而不是让插件带着半套参数跑起来。
 */

import { isAbsolute } from 'node:path';

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  /**
   * 飞书 bridge 的工作区目录（必须是已存在的绝对路径）。
   *
   * **没有默认值**：它是部署方自己的目录布局，猜错只会把会话挂到错误的工作区。
   */
  workspacePath: undefined,
  /** 侧边栏里显示的工作区名。 */
  workspaceTitle: '飞书助手',
  /** 扫描间隔（毫秒）。 */
  intervalMs: 30_000,
};

/** 最小扫描间隔：再小就是无意义的空转。 */
const MIN_INTERVAL_MS = 5_000;

/**
 * 校验并合并配置。
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} [raw] - patch 行提供的配置。
 * @returns {typeof DEFAULT_CONFIG} 完整配置。
 * @throws {Error} 任一项不合法时抛出，消息里带插件名与具体字段。
 */
export function validateConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...raw };

  if (config.workspacePath === undefined) {
    throw new Error('feishu-session-registrar: 必须配置 workspacePath（飞书 bridge 的工作区绝对路径）');
  }
  if (typeof config.workspacePath !== 'string' || !isAbsolute(config.workspacePath)) {
    throw new Error('feishu-session-registrar: workspacePath 必须是绝对路径');
  }
  if (typeof config.workspaceTitle !== 'string' || config.workspaceTitle.trim().length === 0) {
    throw new Error('feishu-session-registrar: workspaceTitle 不能为空');
  }
  if (!Number.isInteger(config.intervalMs) || config.intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`feishu-session-registrar: intervalMs 必须是不小于 ${MIN_INTERVAL_MS} 的整数`);
  }
  return config;
}
