import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeCwd } from '../lib/encode-cwd.js';

describe('encodeCwd', () => {
  it('把单层路径编码成 DSH 的会话目录名', () => {
    assert.equal(encodeCwd('/home/u/a'), '--home-u-a--');
  });

  it('与真实布局一致（对照 ~/.dsh/sessions）', () => {
    assert.equal(
      encodeCwd('/srv/app/feishu-assistant-workspace'),
      '--srv-app-feishu-assistant-workspace--',
    );
  });

  it('忽略多余的尾斜杠', () => {
    assert.equal(encodeCwd('/home/u/a/'), '--home-u-a--');
  });
});
