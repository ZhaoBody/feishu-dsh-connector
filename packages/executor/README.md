# dsh-executor

飞书助手的**执行体层**：按 `ActorKey` 管理独立执行体（session / 进程），与飞书完全解耦。

## 职责

- 维护 `ActorKey → sessionId` 映射（独立持久化文件，不碰旧插件的 session-map）
- 同一个 key 的 `run` 严格串行（单写者），不同 key 并行
- 拉起并复用 `dsh --profile sdk` 子进程，走 NDJSON-RPC
- 空闲归档、崩溃后自动重建、`dispose()` 回收全部资源

## 不负责

- 不知道飞书、chatId 语义、卡片
- 不做消息分拣（那是接入层的事）

## 用法

```ts
import { SessionExecutor } from '@feishu-assistant/dsh-executor';

const executor = new SessionExecutor({
  command: 'dsh',
  cwd: workspace,
  provider: 'deepseek-official',
  model: 'deepseek-flash',   // 要处理图片必须用支持视觉的模型
  persistenceFile: join(workspace, '.feishu-executor/actors.json'),
});

const result = await executor.run('oc_x::ou_y', '帮我改配置', {
  emit: (event) => console.log(event),
});
```

## 权限模式

`permissionMode` 写入子进程的 `DSH_PERMISSION_MODE`，用**沙箱边界**代替审批：

| 值 | 效果 |
|---|---|
| `read-only` | 只能读，写操作被拒（实测：`bash: 权限不够`） |
| `workspace-write`（默认） | 可读写工作区，越界被拒 |
| `danger-full-access` | 无限制（等于把机器交出去，慎用） |

关键事实：SDK 运行时**没有审批 UI**，需要审批的操作走 `approval/request` 的默认回退
`unavailable` → **fail closed（直接拒绝）**，不会挂起。所以这里不配审批，只配沙箱。

## 输入与错误

- `run(key, { text, images }, sink)`：图片按协议转成 `SdkEncodedImageBlock`，由 dsh 准入到附件存储
- 回合以错误收尾时（`turn/end` 的 `reason.kind = 'error'`），**抛出原始错误**，
  不会退化成一个笼统的「没有产出文本」——失败必须可溯源

## 已知限制

- 当前 SDK 协议（0.2.x）没有 agent 级 cancel，`interrupt` 默认降级为「记录并告知」；
  配置 `interruptMode: 'kill-process'` 会终止共享进程（会波及其它 key 的在途回合）。
- 测试脚本带 `--test-force-exit`：Node 22 下子进程 pipe 句柄在 destroy 后仍残留，
  生产由信号处理里的 `process.exit` 收尾。

## 测试

```bash
node --test --test-force-exit test/*.spec.ts   # 用假 SDK 进程，无需真实 dsh
```
