# dsh-executor

飞书助手的**执行体层**：按 `ActorKey` 管理独立执行体，与飞书完全解耦。

提供两种实现，接口一致（`Executor`）：

| 实现 | 怎么执行 | 什么时候用 |
|---|---|---|
| **`HttpExecutor`** | 通过 dsh web 的 HTTP API 驱动 agent | **当前默认**——web 是唯一写者，无锁冲突 |
| `SessionExecutor` | 自己 spawn `dsh --profile sdk` 子进程 | 需要独立进程沙箱、或 web 不可用时 |

## 职责

- 维护 `ActorKey → sessionId` 映射（独立持久化文件 `actors.json`）
- 同一个 key 的 `run` 严格串行（单写者），不同 key 并行
- 会话 id 前缀本身就是权限边界的一部分（见下）
- `dispose()` 回收全部资源

## 不负责

- 不知道飞书、chatId 语义、卡片
- 不做消息分拣与派活（那是接入层的事）

## HttpExecutor（默认）

```ts
import { createHttpExecutor } from '@feishu-assistant/dsh-executor';

const executor = createHttpExecutor({
  cwd: workspace,
  persistenceFile: join(workspace, '.feishu-executor/actors.json'),
  ownerOpenIds: ['ou_xxx'],       // 这些人拿到 feishu-owner- 前缀（完整权限）
  rpc: { baseUrl: 'http://127.0.0.1:3080' },
});

await executor.run('oc_x::__main__', { text: '帮我看下日志' }, { emit: () => {} });
```

协议（均已实测）：

- 认证：`GET /connect?token=<启动令牌>&interactions=none` → 签名 cookie（30 天），失效自动重换
- 调用：`POST /api/<namespace>/<method>`，body `{type:'client-request', rpcId, method, payload:{args}}`
- `args` 的 key 是**方法参数名**（`prompt` 要 `{request:{…}}`，`list` 要 `{_request:{}}`）
- 执行：`session/prompt` 投递 + 轮询 `session/page` 取结果（默认 1s，卡片按增量 patch）
- 取消：`session/cancel`

### 会话前缀与权限

| key 后缀 | 生成的 session 前缀 | 用途 |
|---|---|---|
| `__task-N` | `feishu-task-` | 派活出来的任务执行体：能写、能跑命令 |
| 白名单 open_id | `feishu-owner-` | 用户自己的会话：完整权限 |
| 其他 | `feishu-` | 主对话 / 同事会话：受限 |

`packages/guard` 靠这些前缀判断权限，所以前缀**由 bridge 独占生成**，模型无法指定。

## SessionExecutor（备选）

```ts
import { SessionExecutor } from '@feishu-assistant/dsh-executor';

const executor = new SessionExecutor({
  command: 'dsh',
  cwd: workspace,
  provider: 'deepseek-official',
  model: 'deepseek-flash',   // 要处理图片必须用支持视觉的模型
  permissionMode: 'workspace-write',
  persistenceFile: join(workspace, '.feishu-executor/actors.json'),
});
```

`permissionMode` 写入子进程的 `DSH_PERMISSION_MODE`，用**沙箱边界**代替审批：

| 值 | 效果 |
|---|---|
| `read-only` | 只能读，写操作被拒（实测：`bash: 权限不够`） |
| `workspace-write` | 可读写工作区，越界被拒 |
| `danger-full-access` | 无限制（等于把机器交出去，慎用） |

SDK 运行时**没有审批 UI**，需要审批的操作走 `approval/request` 的默认回退 `unavailable` → **fail closed**，不会挂起。

> 注意：用 `SessionExecutor` 时 bridge 与 dsh web 是两个写者，**Web 里打开过的会话会报 `session/writer-held`**。这是默认用 HttpExecutor 的原因。

## 输入与错误

- `run(key, { text, images }, sink)`：图片转成 `PromptContentPart`（`{type:'image', mediaType, data}`）
- 回合以错误收尾时**抛出原始错误**，不退化成一个笼统的「没有产出文本」——失败必须可溯源
- 多轮对话按 `seq > baseline` 过滤事件：`session/page` 返回「最近 N 条」含上一轮，
  不过滤会把旧回合误判成本轮完成（这个 bug 踩过一次）

## 测试

```bash
node --test --test-force-exit test/*.spec.ts   # 假 SDK 进程，无需真实 dsh
```
