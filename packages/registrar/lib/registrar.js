/**
 * 一次同步：把该工作区目录下的会话挂到工作区上。
 *
 * 逻辑与 IO 分离——`listSessionIds` 与 `registry` 都可注入，测试不需要真磁盘、
 * 不需要真工作区服务（宪法第五条：核心逻辑脱离环境可验证）。
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeCwd } from './encode-cwd.js';

/**
 * 列出会话目录名（即 session id）。
 *
 * @param {string} dir - 会话根目录。
 * @returns {Promise<string[]>} 目录名；目录不存在时返回空数组（首次运行属正常）。
 */
export async function listSessionIds(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * 执行一次登记。
 *
 * @param {object} params - 依赖与配置。
 * @param {{ create(path: string, title?: string): Promise<{ sessionIds: readonly string[], attachSession(id: string): Promise<void> }> }} params.registry
 *   工作区注册表。
 * @param {{ workspacePath: string, workspaceTitle: string }} params.config - 配置。
 * @param {string} params.sessionsRoot - DSH 会话根目录。
 * @param {(dir: string) => Promise<string[]>} [params.listSessionIds] - 可注入的目录列举器。
 * @param {{ warn(message: string): void }} [params.logger] - 日志器。
 * @returns {Promise<string[]>} 本次新挂上的 session id。
 */
export async function syncOnce({ registry, config, sessionsRoot, listSessionIds: list = listSessionIds, logger }) {
  const workspace = await registry.create(config.workspacePath, config.workspaceTitle);
  const dir = join(sessionsRoot, encodeCwd(config.workspacePath));
  const ids = await list(dir);
  const known = new Set(workspace.sessionIds.map(String));
  const attached = [];

  for (const id of ids) {
    if (known.has(id)) continue;
    try {
      await workspace.attachSession(id);
      known.add(id);
      attached.push(id);
    } catch (error) {
      // 单个会话挂载失败不该让整轮同步失败：记下来继续。
      logger?.warn?.(
        `feishu-session-registrar: 挂载 ${id} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return attached;
}
