/**
 * 冲突检测与 id 分配。全是纯函数，零 LLM。
 *
 * 核心设计：**判定权交给模型，插件只做字符串比较。**
 *
 * 插件不猜语义 —— 它只问一句「同一个 topic 下是不是已经有一条了」。「这是不是
 * 同一件事的新结论」由模型在写入时通过 `mode` 声明：它刚读完那段对话，这个判断
 * 对它是零边际成本的；比事后另起一次 LLM 调用去猜，既便宜又准。
 *
 * 这样做的三个好处：
 *   - 零 LLM：没有语义判断，只有 topic 的等值比较
 *   - 判定准确：模型写的时候就知道上下文
 *   - 不会误杀：冲突**不删任何东西**，两条都留着等人裁决
 *
 * topic 的比较走 `topicKey()`（归一化后比较），与内容指纹用同一套口径 —— 模型
 * 写成 `Indent-Style` 还是 `indent-style` 不该产生两个话题。
 */
import { topicKey } from "./hash.js";

/** 冲突判定的四种结果。 */
export const CONFLICT_NONE = "none";
export const CONFLICT_DUPLICATE = "duplicate";
export const CONFLICT_UPDATE = "update";
export const CONFLICT_CONFLICT = "conflict";

/**
 * 判定一条待写入的记忆与已有条目的关系。
 *
 * @param {Array<object>} entries - parseMemory 解析出的条目。
 * @param {{topic: string, hash: string|null, mode: string}} incoming - 待写入项。
 * @returns {{kind: string, with: string[]}} 判定结果与涉及的已有 id。
 */
export function detectConflict(entries, { topic, hash, mode }) {
  const key = topicKey(topic);
  // 没有 topic 就不做同话题判定 —— 否则所有「没写 topic」的条目会互相冲突。
  if (key === "") return { kind: CONFLICT_NONE, with: [] };

  // 只跟「活跃且 id 完好」的条目比。待裁决的条目已经是一个未决问题，
  // 不该再拿它当冲突源（否则会滚成一串）。
  const sameTopic = entries.filter(
    (e) => topicKey(e.topic) === key && !e.pending && e.id !== null,
  );
  if (sameTopic.length === 0) return { kind: CONFLICT_NONE, with: [] };

  const exact = sameTopic.find((e) => e.hash !== null && e.hash === hash);
  if (exact !== undefined) return { kind: CONFLICT_DUPLICATE, with: [exact.id] };

  if (mode === "update") return { kind: CONFLICT_UPDATE, with: sameTopic.map((e) => e.id) };
  // append = 给同一话题补充信息，旧条目仍然成立，不算冲突。
  if (mode === "append") return { kind: CONFLICT_NONE, with: [] };

  // mode === "new" 但同 topic 已有条目 → 冻结待裁决。
  return { kind: CONFLICT_CONFLICT, with: sameTopic.map((e) => e.id) };
}

/**
 * 分配下一个条目 id（`m001` 形式）。
 *
 * 取已有最大编号 +1，而不是用条数 —— 删过条目之后用条数会导致 id 重复。
 *
 * @param {Array<object>} entries - 已有条目。
 * @returns {string} 新 id。
 */
export function nextId(entries) {
  let max = 0;
  for (const entry of entries) {
    if (typeof entry.id !== "string") continue;
    const match = /^m(\d+)$/.exec(entry.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `m${String(max + 1).padStart(3, "0")}`;
}

/**
 * 收集全部待裁决冲突，供 CONFLICTS.md 和注入计数使用。
 *
 * @param {Array<object>} entries - parseMemory 解析出的条目。
 * @returns {Array<{topic: string, pending: object, others: object[]}>}
 */
export function collectConflicts(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry.id !== null) byId.set(entry.id, entry);
  }

  const groups = [];
  for (const entry of entries) {
    if (!entry.pending) continue;
    const ids = String(entry.conflictWith ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    groups.push({
      topic: entry.topic,
      pending: entry,
      others: ids.map((id) => byId.get(id)).filter((e) => e !== undefined),
    });
  }
  return groups;
}

/**
 * 统计文件里有多少条目按类型分布 —— 给用量展示用。
 *
 * @param {Array<object>} entries - 条目。
 * @returns {Record<string, number>} 段名 → 条数。
 */
export function countBySection(entries) {
  const counts = {};
  for (const entry of entries) {
    const key = entry.section ?? "(无段)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
