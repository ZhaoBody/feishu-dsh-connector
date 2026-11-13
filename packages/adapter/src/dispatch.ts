/**
 * 派活协议：主对话在回复里用标记把任务甩出去，接入层解析后另开无状态会话执行。
 *
 * 为什么用文本标记而不是工具：profile 里解析不到 `@deepseek-ai/dsh-tools`，
 * 插件无法注册工具；标记方案零依赖，且对模型来说和工具一样是「约定的语法」。
 *
 * 格式（宽松解析，容忍全角/多余空白）：
 *   [[SPAWN]] 任务描述 [[/SPAWN]]
 */

/** 派活标记的正则（大小写不敏感，容忍空格）。 */
const SPAWN_PATTERN = /\[\[\s*SPAWN\s*\]\]([\s\S]*?)\[\[\s*\/\s*SPAWN\s*\]\]/gi;

/** 一条解析结果。 */
export interface ParsedReply {
  /** 去掉派活标记后的正文（发给用户的部分）。 */
  readonly text: string;
  /** 要派出去的任务（可能多条）。 */
  readonly tasks: readonly string[];
}

/**
 * 从主对话的回复里抽出派活任务。
 *
 * 标记会被剔除；同一段里多个标记按出现顺序返回。任务为空（只有标记没有内容）时忽略。
 *
 * @param reply - 主对话的完整回复。
 * @returns 清洗后的正文与任务列表。
 */
export function parseSpawn(reply: string): ParsedReply {
  const tasks: string[] = [];
  const text = reply.replace(SPAWN_PATTERN, (_match, body: string) => {
    const task = body.trim();
    if (task.length > 0) tasks.push(task);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), tasks };
}

/**
 * 主对话的角色说明。
 *
 * 首次与某个主对话会话交互时注入一次，之后它就记住了。
 */
export function mainActorBrief(): string {
  return [
    '【角色】你是这个飞书群的对接主体，所有对话的记忆都在你这里。',
    '',
    '处理方式：',
    '1. 能直接回答的（闲聊、问概念、澄清需求）——自己答，简洁。',
    '2. 需要动手查/跑的（看日志、查配置、排查故障、读代码）——**派出去**，别自己做：',
    '   在回复里写 `[[SPAWN]]完整、自包含的任务描述[[/SPAWN]]`，可以写多条。',
    '   派出去的执行体没有你的对话记忆，所以任务描述必须把背景、目标、要查什么写全。',
    '3. 派完之后用一句话告诉用户「已派出」，不要等结果；结果回来后会接着给你。',
    '',
    '注意：不要声称自己查过东西——你只负责判断和派活，查证由执行体完成。',
  ].join('\n');
}
