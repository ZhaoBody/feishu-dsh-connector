/**
 * 飞书助手接线入口。
 *
 * 本文件只做一件事：把接入层与执行体层接起来。
 * 业务逻辑分别在 `@feishu-assistant/feishu-adapter` 与 `@feishu-assistant/dsh-executor`。
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createFileLogger, FeishuAdapter, LarkConnection, OutboundRegistry } from '@feishu-assistant/feishu-adapter';
import { SessionExecutor } from '@feishu-assistant/dsh-executor';

const ROOT = resolve(process.cwd(), '..');
const DEFAULT_WORKSPACE = resolve(ROOT, 'feishu-assistant-workspace');

/** 读取必需的环境变量，缺失时立即失败（不猜默认值）。 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

/** 权限模式：只接受 dsh 认识的三个值，其余一律回落到 workspace-write。 */
function permissionMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const raw = process.env.DSH_PERMISSION_MODE;
  if (raw === 'read-only' || raw === 'danger-full-access') return raw;
  return 'workspace-write';
}

/** 逗号分隔的环境变量 → 字符串数组；空值返回 undefined。 */
function csv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

async function main(): Promise<void> {
  const workspace = resolve(process.env.DSH_WORKSPACE ?? DEFAULT_WORKSPACE);
  await mkdir(workspace, { recursive: true });

  // 落盘日志：路由、撤回、执行结果都留痕，出事可复盘。
  const logger = createFileLogger(join(workspace, '.feishu-executor', 'bridge.log'), { echo: true });

  const connection = new LarkConnection({
    appId: required('FEISHU_APP_ID'),
    appSecret: required('FEISHU_APP_SECRET'),
    requireMention: true,
    // 入站文件落到工作区，agent 通过路径自己读取。
    attachmentsDir: join(workspace, 'attachments'),
    ...(process.env.FEISHU_SDK_LOG === 'debug' ? { sdkLogLevel: 'debug' as const } : {}),
    ...(csv('FEISHU_GROUP_ALLOWLIST') !== undefined ? { groupAllowlist: csv('FEISHU_GROUP_ALLOWLIST') } : {}),
    ...(csv('FEISHU_DM_ALLOWLIST') !== undefined ? { dmMode: 'allowlist' as const, dmAllowlist: csv('FEISHU_DM_ALLOWLIST') } : {}),
    logger,
  });

  const executor = new SessionExecutor({
    command: process.env.DSH_COMMAND ?? 'dsh',
    cwd: workspace,
    provider: process.env.DSH_PROVIDER ?? 'deepseek-official',
    model: process.env.DSH_MODEL ?? 'deepseek-flash',
    persistenceFile: join(workspace, '.feishu-executor', 'actors.json'),
    permissionMode: permissionMode(),
    logger,
  });

  // 出站消息登记表：撤回能力的唯一依据，必须落盘（重启后仍可撤）。
  const outbound = new OutboundRegistry(join(workspace, '.feishu-executor', 'outbound.json'));
  outbound.load();

  const adapter = new FeishuAdapter({
    connection,
    executor,
    outbound,
    ...(csv('FEISHU_ALLOWED_USERS') !== undefined ? { allowedUsers: csv('FEISHU_ALLOWED_USERS') } : {}),
    logger,
  });

  await adapter.start();

  const stop = async (signal: string): Promise<void> => {
    console.error(`[bridge] 收到 ${signal}，正在关闭`);
    try {
      await adapter.stop();
      await logger.flush();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  // 自愈：SDK 重连 48 次后进入 failed 且不再自愈（实测 DNS 抖动会导致此状态）。
  // 主动退出，交给 systemd 的 Restart=always 拉起一个干净进程。
  // 20 秒一轮：比 60 秒少一个数量级的失联窗口，开销仍可忽略。
  const healthTimer = setInterval(() => {
    const state = connection.connectionState();
    if (state === 'failed') {
      console.error(`[bridge] 长连接状态 ${state}，主动退出等待 systemd 重启`);
      void adapter.stop().finally(() => process.exit(1));
    }
  }, 20_000);
  healthTimer.unref();

  // 连接层报错时立即复核一次，不等下一轮轮询。
  connection.onError(() => {
    if (connection.connectionState() === 'failed') {
      console.error('[bridge] 连接层报错且状态为 failed，主动退出等待重启');
      void adapter.stop().finally(() => process.exit(1));
    }
  });

  console.error('[bridge] 飞书接入与执行体已就绪');
  await new Promise<void>(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
