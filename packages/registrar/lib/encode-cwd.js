/**
 * 把工作区路径编码成 DSH 的会话目录名。
 *
 * 规则：去掉首尾斜杠、剩余斜杠全部替换为 `-`、两端补 `--`。
 * 例：`/home/u/a-b` → `--home-u-a-b--`。
 *
 * 注意这是 DSH 的磁盘布局约定，不是我们的发明；布局变了这里要跟着改。
 */

/**
 * @param {string} path - 绝对路径。
 * @returns {string} 会话目录名。
 */
export function encodeCwd(path) {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return `--${trimmed.replace(/[/\\]+/g, '-')}--`;
}
