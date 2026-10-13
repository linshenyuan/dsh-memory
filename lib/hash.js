/**
 * 内容指纹：去重判定的唯一依据。
 *
 * 为什么用哈希而不是相似度：相似度阈值会在「同一件事换个说法」和「不同的事共享
 * 关键词」之间来回挪，**只会换一种错法**。哈希是确定性的 —— 命中就是逐字节相同，
 * 没有解释空间。
 *
 * 代价是近似重复检测不出来。这是**故意的**：近似去重必然误杀，而误杀（丢掉真
 * 信息）比漏杀（多一条重复）严重得多。近似重复交给提示词里的「一条一个事实」
 * 和上限压力去缓解。
 */
import { createHash } from "node:crypto";

/**
 * 归一化：折掉格式差异，只留内容。
 *
 * 口径（与 mneme 的 content-hash.js 一致，便于交叉验证）：
 * NFKC → 转小写 → 去标点 → 空白折叠。
 *
 * 为什么不额外做同义词/词干处理：那会引入一个新的、会漂移的口径。哈希的全部
 * 价值就在于它是死的。
 *
 * @param {unknown} value - 任意值，非字符串会被 String() 后处理。
 * @returns {string} 归一化结果。
 */
export function normalizeForHash(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{P}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * topic 的比较键。
 *
 * 在内容归一化的基础上**再折掉分隔符**：`indent-style`、`indent_style`、
 * `indent.style`、`Indent Style` 都是同一个话题。模型写 topic 时换个分隔符不该
 * 产生一个新话题，否则同一条内容会被反复写入、越堆越多。
 *
 * 内容那一侧**不做**这一步 —— 正文里 `a b` 和 `ab` 可能是两回事，折掉会误杀。
 * 只有 topic 这种「短标识」才适合这么激进。
 *
 * `contentHashOf` 也必须走这个函数来算 topic 部分：两边口径不一致的话，会出现
 * 「指纹说这是同一条记忆，topic 比较却说不是同一个话题」这种自相矛盾的判定。
 *
 * @param {unknown} topic - 原始 topic。
 * @returns {string} 比较键；空串表示「没有 topic」，此时不参与同话题判定。
 */
export function topicKey(topic) {
  return normalizeForHash(topic).replace(/\s+/g, "");
}

/**
 * 一条记忆的内容指纹。
 *
 * topic 和 content 一起算：topic 是冲突检测的依据，内容变了 topic 没变时哈希
 * 必须不同，否则「同 topic 改结论」会被误判成重复。
 *
 * @param {string} topic - 主题键。
 * @param {string} content - 记忆正文。
 * @returns {string|null} sha256 十六进制串；topic 和 content 归一化后都为空时返回 null。
 */
export function contentHashOf(topic, content) {
  const t = topicKey(topic);
  const c = normalizeForHash(content);
  if (t === "" && c === "") return null;
  return createHash("sha256").update(`${t}\u0000${c}`).digest("hex");
}

/**
 * 截短哈希，用于展示和审计里的人类可读引用。
 * @param {unknown} hash - 完整哈希。
 * @returns {string} 前 12 位，或空串。
 */
export function shortHash(hash) {
  return typeof hash === "string" ? hash.slice(0, 12) : "";
}
