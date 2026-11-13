/**
 * 执行体层的对外契约。
 *
 * 这个模块只有类型、没有运行时代码：飞书接入层通过 `import type` 引用它，
 * 于是「接入层依赖执行层」只发生在编译期，运行时不产生任何耦合。
 *
 * 设计约束（宪法第一条/第三条）：执行体不认识飞书，接入层不认识进程。
 */

/**
 * 执行体键：同一人在同一群内的唯一执行体，形如 `oc_xxx::ou_yyy`。
 *
 * 键的构造是接入层的职责（只有它知道 chatId 与 openId 的关系）；
 * 执行体层只把它当作不透明字符串使用。
 */
export type ActorKey = `${string}::${string}`;

/**
 * 执行体向上抛出的事件流。
 *
 * 接入层只消费这四种事件，因此换实现（进程 / session / 远端）时渲染层不用改。
 */
export type ExecutorEvent =
  | { readonly type: 'status'; readonly state: 'running' | 'idle' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly text: string }
  | { readonly type: 'error'; readonly message: string };

/** 事件接收器：执行体往里推事件，不关心它最终被渲染成卡片还是纯文本。 */
export interface EventSink {
  emit(event: ExecutorEvent): void;
}

/** 一张入站图片：base64 数据 + 协议认可的 MIME 类型。 */
export interface RunImage {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 标准 base64（不带 data: 前缀）。 */
  readonly data: string;
}

/** 一轮输入：文本 + 可选图片。 */
export interface RunInput {
  readonly text: string;
  readonly images?: readonly RunImage[];
}

/** 一次 run 的结果。`ok=false` 时 `text` 是可直接回给用户的失败说明。 */
export interface RunResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * 执行体接口：按进程语义设计（每个 key 可独立起停），首版以 session 实现。
 *
 * 实现方必须保证：同一个 key 的 `run` 严格串行（单写者），不同 key 可并行。
 */
export interface Executor {
  /** 向该 key 投递一轮输入；返回前必须已经通过 sink 推完 done/error。 */
  run(key: ActorKey, input: RunInput, sink: EventSink): Promise<RunResult>;
  /**
   * 中断该 key 上正在执行的回合。
   *
   * 注：当前 SDK 协议（0.2.x）没有 agent 级 cancel，首版实现为「终止该执行体」，
   * 因此实现方必须通过 sink 或日志显式告知降级，不得静默。
   */
  interrupt(key: ActorKey): Promise<void>;
  /**
   * 该 key 前面还有多少条在排队（0 = 空闲）。
   *
   * 接入层据此给用户「已排队」的反馈——静默排队会让用户以为消息丢了。
   */
  pending(key: ActorKey): number;
  /** 释放该 key 的执行体（进程/session），之后再次 run 应可冷恢复。 */
  release(key: ActorKey): Promise<void>;
  /** 释放全部执行体与定时器；重复调用必须安全。 */
  dispose(): Promise<void>;
}
