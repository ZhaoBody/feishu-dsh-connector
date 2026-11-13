/**
 * 飞书助手接线入口。
 *
 * 本文件只做一件事：把接入层与执行体层接起来。
 * 业务逻辑分别在 `@feishu-assistant/feishu-adapter` 与 `@feishu-assistant/dsh-executor`。
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createFileLogger, FeishuAdapter, LarkConnection, OutboundRegistry } from '@feishu-assistant/feishu-adapter';
import { createHttpExecutor } from '@feishu-assistant/dsh-executor';

const ROOT = resolve(process.cwd(), '..');
const DEFAULT_WORKSPACE = resolve(ROOT, 'feishu-assistant-workspace');

/** 读取必需的环境变量，缺失时立即失败（不猜默认值）。 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
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

  // allowedUsers 为空表示「所有人都能用」；owner 名单单独配置，决定谁的会话有完整权限。
  const allowedUsers = csv('FEISHU_ALLOWED_USERS');
  const ownerUsers = csv('FEISHU_OWNER_USERS') ?? [];

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

  // 执行体走 dsh web 的 HTTP API：不再自己 spawn 子进程，web 永远是唯一写者。
  // 这样 Web 里打开过的飞书会话也能继续聊，锁冲突从根上消失。
  const executor = createHttpExecutor({
    cwd: workspace,
    persistenceFile: join(workspace, '.feishu-executor', 'actors.json'),
    ...(ownerUsers.length > 0 ? { ownerOpenIds: ownerUsers } : {}),
    rpc: {
      baseUrl: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080',
      ...(process.env.DSH_AUTH_FILE !== undefined ? { tokenFile: process.env.DSH_AUTH_FILE } : {}),
    },
    logger,
  });

  // 出站消息登记表：撤回能力的唯一依据，必须落盘（重启后仍可撤）。
  const outbound = new OutboundRegistry(join(workspace, '.feishu-executor', 'outbound.json'));
  outbound.load();

  const adapter = new FeishuAdapter({
    connection,
    executor,
    outbound,
    ...(allowedUsers !== undefined ? { allowedUsers } : {}),
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

  // 自愈：SDK 在重试耗尽后进入 failed 就不再恢复；但更常见的是卡在 reconnecting
  // 反复超时（实测见过连续 40 次、每次 15s 超时），这种状态它也不会自己好。
  // 所以两个条件满足其一就主动退出，交给 systemd Restart=always 重拉：
  //   1) state === 'failed'
  //   2) 持续 5 分钟没有 connected
  let lastHealthyAt = Date.now();
  const healthTimer = setInterval(() => {
    const state = connection.connectionState();
    if (state === 'connected') {
      lastHealthyAt = Date.now();
      return;
    }
    const downForMs = Date.now() - lastHealthyAt;
    if (state === 'failed' || downForMs > 5 * 60_000) {
      console.error(
        `[bridge] 长连接异常（state=${state}，已 ${Math.round(downForMs / 1000)}s 未连通），主动退出等待重启`,
      );
      void adapter.stop().finally(() => process.exit(1));
    }
  }, 20_000);
  healthTimer.unref();

  // 连接层报错时立即复核一次，不等下一轮轮询。
  connection.onError(() => {
    const state = connection.connectionState();
    if (state === 'failed') {
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
