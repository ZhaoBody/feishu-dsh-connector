import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sniffImageMime } from '../src/attachments.ts';

/** 构造带指定文件头的 buffer。 */
function head(...bytes: number[]): Buffer {
  return Buffer.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe('图片类型识别', () => {
  it('识别 PNG', () => {
    assert.equal(sniffImageMime(head(0x89, 0x50, 0x4e, 0x47)), 'image/png');
  });

  it('识别 JPEG', () => {
    assert.equal(sniffImageMime(head(0xff, 0xd8, 0xff)), 'image/jpeg');
  });

  it('识别 GIF', () => {
    assert.equal(sniffImageMime(head(0x47, 0x49, 0x46, 0x38)), 'image/gif');
  });

  it('识别 WebP', () => {
    assert.equal(
      sniffImageMime(head(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
      'image/webp',
    );
  });

  it('未知格式返回 undefined，不猜', () => {
    assert.equal(sniffImageMime(Buffer.from('hello world')), undefined);
  });
});
