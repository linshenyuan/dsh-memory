/**
 * 敏感信息扫描与打码。
 *
 * 这是整个插件唯一不能省的安全底线。
 *
 * 为什么必须在**注入时**做：记忆正文会被塞进模型上下文。如果模型之前误把
 * API Key 写进了记忆文件，那条 Key 会**每轮都被带进上下文** —— 等于持续外泄。
 *
 * 为什么只打码、不阻断写入：磁盘上的原文不该被插件悄悄改掉。用户可能有意记
 * 「我们的 token 前缀是 sk-abc」。打码只发生在「给模型看」的那一份上，既不丢
 * 信息，也不把凭据送进上下文。
 */

/** 命中后的替换文本。 */
const RULES = [
  {
    name: "私钥",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    mask: "[PRIVATE KEY 已打码]",
  },
  {
    name: "OpenAI 风格 token",
    re: /\bsk-[A-Za-z0-9_-]{20,}/g,
    mask: "sk-***",
  },
  {
    name: "GitHub token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
    mask: "ghp_***",
  },
  {
    name: "AWS access key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    mask: "AKIA***",
  },
  {
    // 后行断言确保只在 `key = value` 这类赋值形状里命中，避免误伤普通句子。
    name: "通用凭据字段",
    re: /(?<=(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)\S{12,}/gi,
    mask: "***",
  },
  {
    name: "提示注入",
    // 注意：JS 不支持 `(?i)` 内联标志，忽略大小写只能走 `i` flag。
    re: /ignore\s+(all\s+)?(previous|above)\s+instructions?/gi,
    mask: "[疑似注入语句已移除]",
  },
  {
    // 零宽字符、方向控制符、BOM：肉眼看不见，但模型看得见，可以藏指令。
    name: "不可见字符",
    re: /[\u200b-\u200f\u202a-\u202e\ufeff]/g,
    mask: "",
  },
];

/**
 * 扫描并打码。
 *
 * 任何一条规则抛错都不影响其余规则 —— 打码是旁路，不能因为它坏掉就让记忆注入
 * 整个不可用。
 *
 * @param {unknown} text - 待处理的文本。
 * @returns {{text: string, hits: number}} 处理后的文本与命中总数。
 */
export function sanitize(text) {
  let out = String(text ?? "");
  let hits = 0;

  for (const rule of RULES) {
    try {
      // 用函数形式的替换，避免 mask 里的 `$&` / `$1` 被当成反向引用展开。
      out = out.replace(rule.re, () => {
        hits += 1;
        return rule.mask;
      });
    } catch {
      // 单条规则失败只跳过它自己。
    }
  }

  return { text: out, hits };
}
