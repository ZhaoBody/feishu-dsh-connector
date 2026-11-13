import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InboundMessage } from '../src/message-router.ts';
import { route } from '../src/message-router.ts';
import { actorKeyOf, mainKeyOf, parseActorKey } from '../src/keys.ts';

/** 构造一条测试消息，默认群聊。 */
function message(text: string, senderOpenId = 'ou_alice'): InboundMessage {
  return {
    chatId: 'oc_group',
    senderOpenId,
    text,
    chatType: 'group',
    messageId: 'om_1',
  };
}

describe('message-router 分拣', () => {
  it('强指令动词转给说话人自己的执行体', () => {
    const decision = route(message('帮我改一下这个文件'));
    assert.equal(decision.intent, 'task');
    assert.equal(decision.key, mainKeyOf('oc_group'));
  });

  it('闲聊进 chat 级主对话', () => {
    const decision = route(message('今天天气怎么样？'));
    assert.equal(decision.intent, 'chat');
    assert.equal(decision.key, mainKeyOf('oc_group'));
  });

  it('中断指令只命中说话人', () => {
    const decision = route(message('停', 'ou_bob'));
    assert.equal(decision.intent, 'interrupt');
    assert.equal(decision.key, actorKeyOf('oc_group', 'ou_bob'));
  });

  it('中断优先于任务：先说停就不再派新活', () => {
    const decision = route(message('停，然后帮我改文件'));
    assert.equal(decision.intent, 'interrupt');
  });

  it('英文强指令同样生效', () => {
    const decision = route(message('run the tests please'));
    assert.equal(decision.intent, 'task');
  });

  it('指代 + 泛动作转执行体（原设计稿的漏网点）', () => {
    assert.equal(route(message('这个怎么弄')).intent, 'task');
    assert.equal(route(message('帮我看看日志')).intent, 'task');
  });

  it('含指代即转执行体，因为主会话没有那段上下文', () => {
    assert.equal(route(message('这个数字是多少')).intent, 'task');
  });

  it('短句无动作词仍可留在主会话', () => {
    assert.equal(route(message('今天天气怎么样？')).intent, 'chat');
  });

  it('整句问候/致谢进主对话', () => {
    for (const text of ['你好', '谢谢！', '嗯']) {
      const decision = route(message(text));
      assert.equal(decision.intent, 'chat');
      assert.equal(decision.key, mainKeyOf('oc_group'));
    }
  });

  it('白名单不抢动作句：谢谢 + 改文件仍转执行体', () => {
    assert.equal(route(message('谢谢，帮我改一下')).intent, 'task');
  });

  it('未识别的长句进主对话', () => {
    const decision = route(message('我们明天再一起商量商量吧好不好呀'));
    assert.equal(decision.intent, 'task');
    assert.equal(decision.key, mainKeyOf('oc_group'));
  });
});

describe('执行体键', () => {
  it('构造后可无损还原', () => {
    const key = actorKeyOf('oc_group', 'ou_alice');
    assert.deepEqual(parseActorKey(key), { chatId: 'oc_group', identity: 'ou_alice' });
  });

  it('主会话键使用保留身份', () => {
    assert.equal(mainKeyOf('oc_group'), 'oc_group::__main__');
  });

  it('非法键返回 undefined，不猜', () => {
    assert.equal(parseActorKey('oc_group'), undefined);
    assert.equal(parseActorKey('::x'), undefined);
  });
});
