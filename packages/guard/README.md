# 飞书会话防护

对**飞书来源的会话**（session id 以 `feishu-` 开头）做只读化与范围限制，防止群里其他人通过机器人读到你的个人文件。

## 为什么需要它

bridge 的执行体跑在 dsh web 进程里，权限与你自己的 Web 会话相同。虽然 `FEISHU_ALLOWED_USERS` 已经挡住了非白名单用户，但被允许的人（或话术诱导）仍可能让 agent 去翻 `~/.ssh`、`.dsh` 这些地方。

本插件在 `tools/pre-execute` 阶段拦截，**只对飞书会话生效**——你自己在 Web 里的操作完全不受影响。

## 三条规则

| 类别 | 工具 | 处理 |
|---|---|---|
| 写 | `write` / `edit` / `apply_patch` | **拒绝**（严格只读） |
| 命令 | `bash` / `pwsh` / `terminal_*` | **拒绝**（无法静态保证只读） |
| 读 | `read` / `read_image` / `glob` / `grep` | 路径必须在**项目工作区**内；含 `..` 直接拒绝 |
| 其他 | 提问、定时、待办等 | 放行 |

「项目工作区」直接从 `workspaceRegistry` 实时读取——**工作区 = 公司数据范围**，家目录、`.ssh`、`.dsh`、个人代码都不在其中。

## 配置

```yaml
- insert:
    - id: feishu-guard
      name: '@local/feishu-guard'
      config:
        sessionPrefix: feishu-   # 只拦截这些会话；缺省即此值
```

## 测试

```bash
node --test test/*.test.js
```

覆盖：路径提取、`..` 逃逸、前缀相似的目录不误判、写/命令类拒绝、读越界拒绝、非飞书会话放行。

## 已知限制

- 前缀匹配是「信任 session id 命名」——如果有人能伪造 `feishu-` 前缀的会话，就能绕过。实践中 session id 由 bridge 独占生成。
- 只拦工具调用层；如果某个工具内部自己去读文件（例如某些 MCP 工具），不在此列。
