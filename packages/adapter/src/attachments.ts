/**
 * 入站图片的类型识别。
 *
 * 飞书下载回来的图片没有可靠的文件名，靠魔数判断比猜扩展名稳。
 * 协议只接受 png/jpeg/webp/gif 四种，识别不出来就明确报错，不硬塞。
 */

/** 协议认可的四类图片。 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * 按文件头识别图片类型。
 *
 * @param buffer - 图片字节。
 * @returns 识别到的 MIME；不是这四类之一时返回 `undefined`（调用方负责报错）。
 */
export function sniffImageMime(buffer: Buffer): ImageMime | undefined {
  if (buffer.length >= 8) {
    // PNG：89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return 'image/png';
    }
    // GIF：GIF87a / GIF89a
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif';
    }
    // WebP：RIFF....WEBP
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp';
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}
