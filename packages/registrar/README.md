# feishu-session-registrar

把飞书 bridge 产生的会话挂到 dsh 的工作区上，让 Web 侧边栏能看到它们。

## 为什么需要它

飞书 bridge 以独立的 `dsh --profile sdk` 进程运行，它产生的会话落在
`~/.dsh/sessions/--<cwd 编码>--/` 下，但**从不登记**到 `workspaceRegistry`。
dsh Web 的会话列表读的是工作区登记表，所以这些会话明明在磁盘上，界面里看不到。

本插件补上这一步登记：定时扫描该目录，把新会话挂到工作区。

## 做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 调 `workspaceRegistry.create()` 确保工作区存在 | 不创建会话、不写会话内容 |
| 调 `workspace.attachSession()` 挂新会话 | 不碰飞书、不改 bridge |
| 失败只告警，不影响宿主 | 不做删除/归档 |

## 配置

写在 `cordis.patch.yml` 的行里，启动时校验（非法值直接抛错）：

| 字段 | 默认值 | 约束 |
|---|---|---|
| `workspacePath` | `…/default-workspace/feishu-assistant-workspace` | 必须是已存在的绝对路径 |
| `workspaceTitle` | `飞书助手（新架构）` | 非空 |
| `intervalMs` | `30000` | 整数且 ≥ 5000 |

## 结构

```
index.js              插件入口：校验配置、起定时器
lib/config.js         默认值 + 校验（纯函数）
lib/encode-cwd.js     工作区路径 → 会话目录名（纯函数）
lib/registrar.js      syncOnce：一次同步，依赖全部可注入
test/*.test.js        11 个用例，不碰真磁盘与真服务
```

## 测试

```bash
node --test test/*.test.js
```

## 安装 / 卸载

```bash
# 安装（也可由 plugin_manager install_bundle 完成）
plugin_manager install_bundle --target /absolute/path/to/packages/registrar

# 卸载
plugin_manager remove_bundle @local/feishu-session-registrar
```

本地目录安装是 **link 语义**：改完源码需要重载宿主（`dsh-restart.sh`）才生效。
