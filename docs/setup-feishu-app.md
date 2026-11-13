# 创建飞书机器人

本文件是 `README.md` 的前置步骤：从零创建一个能对接本项目的飞书应用。

> 飞书开放平台的界面会调整措辞，菜单名以你看到的为准；下面的路径是 2026 年中的形态。

## 1. 创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，用**企业管理员**账号登录
2. 「创建企业自建应用」→ 填名称（如 `DSH 助手`）和描述 → 创建
3. 进入应用后，记下 **凭证与基础信息 → App ID / App Secret**（后面填进 `.env`）

> 自建应用的 `App ID` 以 `cli_` 开头。

## 2. 开启机器人能力

「添加应用能力」→ **机器人** → 启用。

没有这一步，应用无法收发消息。

## 3. 添加权限

「权限管理」→ 搜索并勾选下面这组（名称以平台为准）：

| 权限 | 用途 |
|---|---|
| `im:message` | 接收消息、发送消息 |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:chat` | 读取群信息（判断群聊/私聊） |
| `im:resource` | 下载消息里的图片/文件 |
| `im:message.reaction` | （可选）表情回应 |
| `contact:user.base:readonly` | （可选）读取发送者信息 |

**撤回**依赖删除消息的能力；如果撤回报权限错误，在「权限管理」里补一组消息管理权限（与 `im:message` 相关的删除类）。

## 4. 配置事件订阅（长连接）

「事件与回调」→ **订阅方式** → 选 **使用长连接接收事件**（不要选 webhook，本项目不含公网 HTTP 服务）。

然后添加事件：

```
im.message.receive_v1        接收消息
```

如果漏了这一步，机器人会一直连上但收不到任何消息——排查时优先看这里。

## 5. 发布版本

「版本管理与发布」→ 创建版本 → 填版本号 → **申请发布**。

企业自建应用通常需要管理员审核通过，机器人才正式生效。开发调试阶段可以先让管理员把自己加进可用范围。

## 6. 把机器人加进群

在目标群里：群设置 → 群机器人 → 添加机器人 → 搜索你的应用名。

**注意**：本项目默认要求群消息 `@机器人` 才处理（附件消息除外，因为飞书里发文件无法同时 @）。私聊不需要 @。

## 7. 填进配置

```bash
cd bridge
cp .env.example .env
```

```dotenv
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_ALLOWED_USERS=ou_你的openid      # 生产必配
DSH_WORKSPACE=/absolute/path/to/feishu-assistant-workspace
```

`FEISHU_ALLOWED_USERS` 里的 open_id 怎么拿：给机器人发一条消息，bridge 日志会打出发送者 open_id；或者用[开放平台的 API 调试台](https://open.feishu.cn/api-explorer)查。

## 常见卡点

| 现象 | 原因 |
|---|---|
| 长连接建立但收不到消息 | 事件订阅方式不是「长连接」，或没订阅 `im.message.receive_v1` |
| 群里发消息机器人不理 | 没加进群；或没 @ 它（且不是附件消息） |
| 报 `99991663` 等权限错误 | 权限没勾全，或版本审核未通过 |
| 能收不能发 | 少了 `im:message:send_as_bot` |
| 撤回失败 | 补消息管理类权限 |
