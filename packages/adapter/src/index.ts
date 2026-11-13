/**
 * feishu-adapter：飞书接入层的独立包。
 *
 * 只依赖 Executor 契约（类型）与飞书 SDK，不依赖任何执行体实现。
 */

export { FeishuAdapter } from './adapter.ts';
export type { FeishuAdapterOptions, AdapterLogger } from './adapter.ts';
export { LarkConnection } from './lark-connection.ts';
export type { LarkConnectionOptions, MessageHandler, ConnectionLogger } from './lark-connection.ts';
export { route } from './message-router.ts';
export type { InboundMessage, RouteDecision, RouteIntent } from './message-router.ts';
export { actorKeyOf, mainKeyOf, parseActorKey, MAIN_ACTOR } from './keys.ts';
export { OutboundRegistry } from './outbound-registry.ts';
export type { OutboundKind, OutboundRecord, OutboundRegistryOptions } from './outbound-registry.ts';
export { RecallService, describeRecall } from './recall-service.ts';
export type { RecallFailureReason, RecallResult, RecallServiceOptions, RecallTransport } from './recall-service.ts';
export { createFileLogger } from './file-logger.ts';
export type { FileLogger, FileLoggerOptions, LogLevel } from './file-logger.ts';
export { ReplyCollector, formatFailure } from './reply-renderer.ts';
export type { ReplySnapshot } from './reply-renderer.ts';
