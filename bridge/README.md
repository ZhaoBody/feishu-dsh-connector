# 飞书助手接线入口

本程序只做**接线**：把飞书接入层（`@feishu-assistant/feishu-adapter`）与执行体层（`@feishu-assistant/dsh-executor`）接起来。
两层各自的职责见它们自己的 README；本文件不含业务逻辑。

## 结构

```
feishu-dsh-bridge/src/main.ts   接线入口（约 70 行）
feishu-adapter/                 飞书接入：长连接 / 分拣 / 回复
dsh-executor/                   执行体：ActorKey → session、进程管理、持久化
```

旧实现（`src/dsh-bridge.ts`，单进程 + 内联 session 管理）已由上述两层取代，备份为 `src/dsh-bridge.ts.bak-*`。

## 会话模型

- 群里每个成员一个执行体：`ActorKey = chatId::openId`
- 同群共享闲聊走主会话：`chatId::__main__`
- 同一 key 严格串行，不同 key 并行
- 映射持久化在 `<DSH_WORKSPACE>/.feishu-executor/actors.json`

## 配置

```bash
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'
export DSH_MODEL='deepseek-flash'   # 视觉：deepseek-flash 可看图；deepseek-chat 不能
export DSH_PROVIDER='deepseek-official'
export DSH_COMMAND='dsh'
export DSH_WORKSPACE='/absolute/path/to/feishu-assistant-workspace'
```

`DSH_WORKSPACE` 可省略，默认 `../feishu-assistant-workspace/`。

## 访问控制（生产必配）

执行体默认拥有完整 shell 权限，**不配白名单等于把服务器交给群里的每个人**。

```bash
export FEISHU_ALLOWED_USERS='ou_xxx,ou_yyy'   # 允许使用的用户 open_id
export FEISHU_GROUP_ALLOWLIST='oc_xxx'         # 只响应这些群
export FEISHU_DM_ALLOWLIST='ou_xxx'            # 私聊白名单（自动切 allowlist 模式）
```

## 安装与启动

三个包是一个 pnpm workspace（根：`default-workspace/pnpm-workspace.yaml`），装一次即可：

```bash
cd feishu-dsh-connector
pnpm install          # 由根目录统一安装，生成根 pnpm-lock.yaml

cd feishu-dsh-bridge
pnpm start
```

依赖关系用 `workspace:*` 声明，不再需要手工 symlink。

飞书开放平台中将机器人配置为长连接事件订阅，并订阅 `im.message.receive_v1`。应用需要具备发送消息的权限。

当前只处理文本消息；回复为整段文本（不流式 patch 卡片）。
