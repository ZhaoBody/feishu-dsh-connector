# feishu-adapter

飞书助手的**接入层**：长连接、消息分拣、回复渲染。只认 `Executor` 契约（类型导入），不知道执行体是进程还是 session。

## 职责

- 飞书长连接与事件去重（交给 SDK 的 `safety.dedup`）
- 把归一化消息转成内部 `InboundMessage`
- 分拣：`route()` 纯函数，规则优先于模型判断
- 回复：`ReplyCollector` 把执行体事件收敛成一段文本
- 失败必须回执给用户（不静默）

## 不负责

- 不拉起进程、不管理 session、不碰 JSON-RPC
- 不 import 任何执行体实现（只有 `import type`）

## 分拣规则

**原则：误判成本不对称**——误转执行体只多一条上下文，误留主会话会拖住整群，所以默认偏向转执行体。

| 优先级 | 命中 | 去向 |
|---|---|---|
| 1 | 停 / 取消 / stop | 说话人自己的执行体（`interrupt`） |
| 2 | 动作词（改/跑/提交/**看/弄/搞/查**…） | 说话人自己的执行体（`task`） |
| 3 | 含指代（这个/那个/刚才/上面） | 说话人自己的执行体（需要上下文） |
| 4 | 整句命中闲聊白名单（你好/谢谢/收到/哈哈…） | 主会话 `__main__` |
| 5 | ≤12 字且无动作词 | 主会话 `__main__` |
| 6 | 其余（兜底） | 说话人自己的执行体 |

第 6 条是设计稿漏掉的场景：「这个怎么弄」这类模糊句原先会落进主会话，一旦触发长任务就把公共通道占死。

## 流式卡片

- 每条回复一张卡片，`push` 文本、节流 patch（默认 400ms），内容原地生长
- 卡片状态**按执行体隔离**：两个人同时跑任务，两张卡各更各的，内容不交叉
- 卡片打不开时降级为纯文本回复，不静默吞结果
- 卡片 message id 同样登记进出站表，可被撤回

## 撤回

- 每条出站消息都登记进 `OutboundRegistry`（持久化 JSON），重启后仍可撤
- 撤回不区分消息类型：文本/文件/图片/卡片一视同仁
- 失败一律结构化返回：`messageId` + 原因分类（`not-found` / `forbidden` / `expired` / `api-error`）+ 候选列表
- 默认可撤窗口 24 小时；成功撤回后会从登记表移除，避免二次撤回

```ts
const result = await adapter.recall(chatId);          // 撤最近一条
const target = await adapter.recall(chatId, messageId); // 撤指定一条
console.log(describeRecall(result));                  // 给用户看的文案
```

## 入站图片

- 飞书 SDK 会把图片消息归一到 `resources`（含 `fileKey`），适配器下载后按魔数识别
  `png / jpeg / webp / gif`，转成协议要求的 `SdkEncodedImageBlock`
- 带图片的消息一律转执行体（不走主会话）
- 单张失败不拖垮整条消息：成功的照常投递，失败的记入 `attachmentErrors` 并回执原因
- **能否“看懂”取决于模型**：图片会正确落到 dsh 的附件存储（会话日志可见 `attachmentId`）。
  实测 `deepseek-flash` 能正确识别（1×1 红图答“红色”）；`deepseek-chat` 是纯文本模型，
  会回答“看不到图片”——所以默认模型选 `deepseek-flash`

## 安全

- `allowedUsers` 配置后，非白名单用户只会收到「没有权限」提示，不会触发执行体
- 群白名单与私聊白名单走飞书 SDK 原生 `policy`，在消息进入本层之前就拦掉
- **执行体没有审批 UI**：需要审批的操作会被 fail closed（直接拒绝），不会挂起；
  安全边界由执行体的 `permissionMode` 沙箱控制（默认 `workspace-write`），不是靠人工点确认
- 即便如此，仍建议配 `allowedUsers`：白名单是「谁能用」，沙箱是「最多能干什么」，两者互补

## 测试

```bash
node --test --test-force-exit test/*.spec.ts   # 假连接 + 假执行体，零外部依赖
```
