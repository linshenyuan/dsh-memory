/**
 * 按 UTF-8 字节的安全截断。
 *
 * 这个文件存在的唯一理由是一个**会话级不可逆损坏**：
 *
 *   按 UTF-16 字数 `String.prototype.slice` 截断，如果切点正好落在一个代理对
 *   （surrogate pair，比如 emoji）中间，会产生一个孤立代理项。它序列化成 UTF-8
 *   时是非法字节序列，API 直接返回 400。而这个坏字符会被**永久写进会话历史** ——
 *   之后每一轮请求都带着它，换话题、重启、清缓存都不恢复。
 *
 * 实现照抄 DSH 官方的 `dsh-agent-instructions/lib/index.js`：从字节上限往前退，
 * 退到不是 UTF-8 续字节（`0b10xxxxxx`）为止。
 */
import { Buffer } from "node:buffer";

/**
 * 按字节上限截断，保证结果是合法 UTF-8。
 *
 * @param {unknown} value - 待截断的文本。
 * @param {number} maxBytes - 字节上限。
 * @returns {string} 截断后的文本；未超限时原样返回。
 */
export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;

  let end = Math.max(0, Math.trunc(maxBytes));
  // 0b10xxxxxx 是 UTF-8 续字节 —— 停在那里会切掉一个多字节字符的开头。
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * 文本的 UTF-8 字节长度。
 *
 * 注意：不是 `String.length`。一个 emoji 的 `String.length` 是 2，字节长度是 4；
 * 一个中文字符的 `String.length` 是 1，字节长度是 3。混用这两个口径是上限判断
 * 出错的常见来源，所以统一走这个函数。
 *
 * @param {unknown} value - 待测量文本。
 * @returns {number} 字节长度。
 */
export function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}
