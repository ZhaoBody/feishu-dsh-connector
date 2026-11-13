/**
 * dsh-executor：按 ActorKey 管理执行体的独立包。
 *
 * 对外只暴露契约（`./contract`，纯类型）与实现（本入口）。飞书相关的一切都不在这里。
 */

export type { ActorKey, EventSink, Executor, ExecutorEvent, RunResult } from './contract.ts';
export { SessionExecutor, createExecutor } from './executor.ts';
export type { ExecutorConfig, ExecutorLogger } from './executor.ts';
export { ExecutorPersistence } from './persistence.ts';
export type { ActorRecord, ExecutorState, ExecutorPersistenceOptions } from './persistence.ts';
export { SdkProcess, SdkProcessError } from './process-pool.ts';
export type { SdkProcessOptions, SdkSessionEvent, SpawnLike } from './process-pool.ts';
export { LineRpcClient, RpcRequestError } from './rpc.ts';
export type { RpcClientOptions, RpcLogger } from './rpc.ts';
