# 用 systemd 部署

把 bridge 托管成 **systemd 用户服务**，好处是：进程独立于 dsh web（重启 dsh 不会连带杀掉它）、崩溃自动拉起、开机自启、日志由 journald 管。

## 为什么不用 nohup

我们踩过的坑，写在这里省你重走一遍：

| 做法 | 后果 |
|---|---|
| `nohup pnpm start &` 从会话里起 | 属于 dsh 的进程树，`dsh-restart.sh` 一停服务就把它一起带走 |
| 日志路径写 `/tmp/...` | `/tmp` 被系统清理后，systemd **连标准输出都打不开**，进程直接 300/STDOUT 退出，无限重启失败（现场见过 520 次） |
| 直接 `ExecStart=pnpm start` 不加 PATH | systemd 的环境变量里没有你的 node 路径，报 `/usr/bin/env: "node": 没有那个文件或目录` |

## 1. 写服务文件

创建 `~/.config/systemd/user/feishu-bridge.service`：

```ini
[Unit]
Description=Feishu DSH Bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/feishu/bridge

# 凭证与工作区；EnvironmentFile 里一行一个 KEY=VALUE，不要 export 前缀
EnvironmentFile=%h/.dsh/feishu-assistant.env

# 白名单（生产必配）：非白名单用户在进 agent 之前就被拒
Environment=FEISHU_ALLOWED_USERS=ou_xxxxxxxxxxxxxxxx
Environment=DSH_WORKSPACE=/absolute/path/to/feishu-assistant-workspace

# systemd 默认 PATH 不含 nvm/自定义 node 安装位置，必须补上
Environment=PATH=%h/.local/node22/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

ExecStart=%h/.local/node22/bin/pnpm start

# 崩溃自动拉起（配合应用内的连接自愈）
Restart=always
RestartSec=5

# 输出交给 journald，不再自己维护日志文件
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

把 `/absolute/path/to/...`、`%h/.local/node22/bin` 换成你自己的。

> `%h` 是 systemd 的用户家目录占位符，展开成 `/home/你的用户名`。

## 2. 凭证文件

`~/.dsh/feishu-assistant.env`：

```dotenv
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
DSH_PROVIDER=deepseek-official
DSH_MODEL=deepseek-flash
```

```bash
chmod 600 ~/.dsh/feishu-assistant.env
```

## 3. 启用

```bash
systemctl --user daemon-reload
systemctl --user enable --now feishu-bridge
systemctl --user status feishu-bridge
```

确认长连接起来了：

```bash
journalctl --user -u feishu-bridge -n 5
# 期望看到：[feishu] 长连接已就绪
```

## 4. 开机自启（不登录也要跑）

默认情况下 `systemctl --user` 服务在你**登录后**才会启动，注销就停。要让它在没人登录时也常驻：

```bash
loginctl enable-linger "$USER"
```

## 5. 常用命令

```bash
systemctl --user status feishu-bridge    # 状态
systemctl --user restart feishu-bridge   # 重启（会中断进行中的任务）
systemctl --user stop feishu-bridge      # 停
journalctl --user -u feishu-bridge -f    # 实时日志
journalctl --user -u feishu-bridge -n 100 --since "1 hour ago"
```

业务日志（路由、执行结果、撤回）不在 journal 里，在：

```
<DSH_WORKSPACE>/.feishu-executor/bridge.log
```

该文件有 5MB 滚动（保留一份 `.1`），不会无限增长。

## 6. 权限边界

执行体现在跑在 dsh web 进程里（HTTP API 驱动），**不再有独立沙箱**。飞书会话的约束由 `feishu-guard` 插件在工具层落实：

- 写文件、执行命令：拒绝（严格只读）
- 读文件：绝对路径必须在项目工作区内，含 `..` 直接拒绝
- 只对 `feishu-` 前缀的会话生效，你自己的 Web 会话不受影响

所以这份服务文件里**不需要** `DSH_PERMISSION_MODE`——那是旧架构（独立子进程）的配置。

## 7. 自愈机制

服务里有两层兜底，不需要外部看门狗：

| 层 | 机制 | 触发条件 |
|---|---|---|
| 应用内 | 每 20 秒检查长连接状态 | 状态为 `failed`（SDK 重连次数耗尽）→ 主动 `exit(1)` |
| systemd | `Restart=always` + `RestartSec=5` | 进程退出后 5 秒重拉 |

为什么要这层：飞书 SDK 在 DNS 抖动、网络切换后会重试有限次，**耗尽后不会自己恢复**——进程活着但再也收不到消息。应用内检测到 `failed` 主动退出，是最省事的解法。

## 8. 常见问题

| 现象 | 排查 |
|---|---|
| `status=209/STDOUT` | 日志路径不可写（常见于把 `StandardOutput` 指到 `/tmp`） |
| `/usr/bin/env: "node": 没有那个文件` | `PATH` 里没有你的 node 目录 |
| `activating (auto-restart)` 反复 | 看 `journalctl --user -u feishu-bridge -n 30` 找真实报错 |
| 服务 active 但机器人不回消息 | 先确认飞书侧事件订阅是「长连接」且订阅了 `im.message.receive_v1` |
| 重启 dsh web 后 bridge 挂了 | 说明没走 systemd（还在某个会话的进程树里） |
