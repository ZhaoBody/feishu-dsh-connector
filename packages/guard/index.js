/**
 * 飞书会话防护（Host 插件）。
 *
 * 背景：bridge 的执行体跑在 dsh web 进程里，权限与 Web 会话相同。为了让「群里其他人
 * 通过机器人」只能看项目数据、碰不到个人文件，这里对**飞书来源的会话**做三条约束：
 *
 * 1. **只读**：写文件与执行命令一律拒绝（无法静态保证 bash 只读，所以整类禁掉）
 * 2. **范围**：读操作的绝对路径必须落在某个项目工作区内；出现 `..` 直接拒绝
 * 3. **隔离**：只对 session id 以 `feishu-` 开头的会话生效；白名单用户自己的飞书会话
 *    用 `feishu-owner-` 前缀，完全放行，Web 会话也不受影响
 *
 * 数据范围取自 `workspaceRegistry`——**项目工作区 = 公司数据**，其余（家目录、.ssh、.dsh、
 * 个人代码）一律不许碰。
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** 插件名（与 patch 行 id 一致）。 */
export const name = 'feishu-guard';

/** 需要工作区列表（判断数据范围）与工具钩子（拦截）。 */
export const inject = ['tools', 'workspaceRegistry'];

/** 写操作：严格只读模式下整类拒绝。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'notebook_edit', 'apply_patch']);

/** 命令执行：无法静态判定是否只读，整类拒绝。 */
const EXEC_TOOLS = new Set(['bash', 'pwsh', 'terminal_run', 'terminal_send', 'powershell']);

/** 读操作：放行前要检查路径范围。 */
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'ls', 'list_files']);

/** 默认配置。 */
const DEFAULTS = {
  /** 受限范围：这些 session 只能只读访问项目工作区。 */
  sessionPrefix: 'feishu-',
  /** 可信范围：这些 session 完全放行（白名单用户自己的飞书会话）。 */
  trustedPrefix: 'feishu-owner-',
  /**
   * 历史任务前缀：早期自造派活用 root session 时产生，允许写与执行命令。
   *
   * 现在派活走原生 subagent（权限沿 parent 继承），新会话不再有这个前缀；
   * 保留是为了唤醒旧任务会话时行为一致。
   */
  taskPrefix: 'feishu-task-',
};

/**
 * 提取参数中的绝对路径。
 *
 * 只看序列化后的字符串，够用且不会漏（命令、路径、pattern 都在里面）。
 *
 * @param {unknown} args - 工具参数。
 * @returns {string[]} 形似绝对路径的片段。
 */
export function absolutePathsIn(args) {
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  } catch {
    return [];
  }
  return text.match(/(?<![\w.-])\/[^\s"',\]}]+/g) ?? [];
}

/**
 * 判断读取路径是否越界。
 *
 * @param {unknown} args - 工具参数。
 * @param {readonly string[]} allowedRoots - 允许的工作区根目录。
 * @returns {string | undefined} 越界原因；没有越界时 `undefined`。
 */
export function findEscape(args, allowedRoots) {
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  } catch {
    return '工具参数无法解析，保守拒绝';
  }
  // `..` 一律拒绝：相对路径逃逸最难静态判断，直接不放行。
  if (/(?:^|["'\s/])\.\.(?:\/|["'\s]|$)/.test(text)) {
    return '路径包含 `..`（试图跳出工作区）';
  }
  for (const candidate of absolutePathsIn(args)) {
    if (!isAbsolute(candidate)) continue;
    const resolved = resolve(candidate);
    const inside = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root.endsWith('/') ? root : `${root}/`),
    );
    if (!inside) return `路径不在任何项目工作区内：${resolved}`;
  }
  return undefined;
}

/**
 * 注册插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 * @param {Partial<typeof DEFAULTS>} [config] - patch 行配置。
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config };
  if (typeof options.sessionPrefix !== 'string' || options.sessionPrefix.length === 0) {
    throw new Error('feishu-guard: sessionPrefix 不能为空');
  }

  /**
   * 找到这条调用真正归属的飞书会话。
   *
   * 主对话的 session id 带 feishu- 前缀；它派出的子代理是 UUID，
   * 但 `header.parentSession` 指回父会话。沿这一层继承，权限才不会被子代理绕过。
   *
   * @returns 归属的飞书 session id；与飞书无关的会话返回 undefined。
   */
  function owningSession(session, opts) {
    if (session === undefined || session === null) return undefined;
    const own = String(session.id ?? '');
    if (own.startsWith('feishu-')) return own;
    const parent = session.header?.parentSession;
    if (typeof parent === 'string' && parent.startsWith('feishu-')) return parent;
    return undefined;
  }

  /** 允许访问的根目录：项目工作区 + 技能目录（读文档要用）。 */
  function allowedRoots() {
    const workspaces = ctx.workspaceRegistry.list().map((workspace) => workspace.path);
    const skills = join(homedir(), '.dsh', 'skills');
    return [...workspaces, skills];
  }

  /** 统一拒绝返回。 */
  function deny(reason) {
    ctx.logger?.warn?.(`feishu-guard: 已拒绝一次工具调用 — ${reason}`);
    return { kind: 'deny', reason };
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session;
    // 子代理的 session 是 UUID，权限要沿 parent 链继承发起它的那个飞书会话。
    // 否则同事派出的子代理会绕过所有限制。
    const owning = owningSession(session, options);
    if (owning === undefined) return next();
    if (owning.startsWith(options.trustedPrefix)) return next();
    const sessionId = owning;
    if (!sessionId.startsWith(options.sessionPrefix)) return next();

    const toolName = String(exec.name);
    const isTaskActor = sessionId.startsWith(options.taskPrefix);

    if (WRITE_TOOLS.has(toolName)) {
      // 任务执行体允许写，但同样不能写到允许范围之外。
      if (isTaskActor) {
        const roots = allowedRoots();
        const escape = findEscape(exec.arguments, roots);
        if (escape !== undefined) return deny(`写入超出允许范围：${escape}`);
        return next();
      }
      return deny(`飞书会话是只读的：不允许 ${toolName}。需要改动请自己在 Web 里操作。`);
    }
    if (EXEC_TOOLS.has(toolName)) {
      // 任务执行体必须能跑命令才能干活；命令里出现受限路径或敏感文件时拦下。
      if (isTaskActor) {
        const escape = findEscape(exec.arguments, allowedRoots());
        if (escape !== undefined) return deny(`命令触碰了不允许的路径：${escape}`);
        return next();
      }
      return deny(`飞书会话禁止执行命令（${toolName}），以免越界读写或个人文件被翻。`);
    }
    if (READ_TOOLS.has(toolName)) {
      const escape = findEscape(exec.arguments, allowedRoots());
      if (escape !== undefined) return deny(`飞书会话只能读项目工作区：${escape}`);
      return next();
    }
    // 其余工具（提问、定时、待办等）与文件系统无关，放行。
    return next();
  });
}
