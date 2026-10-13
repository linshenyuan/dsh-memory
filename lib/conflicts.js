/**
 * CONFLICTS.md 生成。
 *
 * 这是一个**派生视图**，不是真相源 —— 删了会在下次写入时自动重建，手改也会被
 * 覆盖。真相只有一份：MEMORY.md。这样避免「两个文件说的不一样」这类经典问题。
 *
 * 为什么还要单独一份：注入上下文里只放一句计数，模型看不到冲突全文；而人要看
 * 细节时，翻一个专门的清单比在 MEMORY.md 里搜 `[待裁决]` 方便。
 */
import { displayPath } from "./paths.js";

/**
 * 渲染 CONFLICTS.md。
 *
 * @param {Array<{topic: string, pending: object, others: object[]}>} groups - collectConflicts 的结果。
 * @param {object} paths - resolveMemoryPaths 的结果。
 * @param {string} generatedAt - ISO 时间串。
 * @returns {string|null} 文件内容；没有冲突时返回 null（表示该删除这个文件）。
 */
export function renderConflicts(groups, paths, generatedAt) {
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const lines = [
    "# 待裁决冲突",
    "",
    `> 自动生成于 ${generatedAt} —— **不要直接编辑这个文件**，改动会被覆盖。`,
    ">",
    "> 裁决方式：编辑 `MEMORY.md`",
    ">   - 删掉不要的那条 → 下次启动识别为已裁决",
    ">   - 或去掉保留那条的 `[待裁决]` 标记并移到对应分类段下",
    ">   - 两条都留也可以：把两条的 `[待裁决]` 标记都去掉，表示「两条都对，只是语境不同」",
    "",
    `当前 ${groups.length} 组待裁决。这些条目**暂不注入上下文**。`,
    "",
    "---",
    "",
  ];

  for (const group of groups) {
    lines.push(`## ${group.topic ?? "(无 topic)"}`, "");

    // 先把「已有条目」列出来，再把待裁决的放后面 —— 和人的阅读顺序一致：
    // 先看到已知的，再看新增的争议项。
    for (const other of group.others) {
      lines.push(`**已有** · ${other.at ?? "无日期"} · \`${other.id ?? "无 id"}\``);
      lines.push("");
      lines.push(`> ${other.content}`);
      lines.push("");
    }

    lines.push(
      `**待裁决** · ${group.pending.at ?? "无日期"} · \`${group.pending.id ?? "无 id"}\``,
    );
    lines.push("");
    lines.push(`> ${group.pending.content}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(
    "文件位置：" + paths.displayPath + "（工作区外或跨项目时以实际配置为准）",
    "",
  );

  return lines.join("\n");
}

/**
 * 渲染冲突摘要，用于注入上下文里的那一行计数。
 *
 * @param {Array<object>} groups - collectConflicts 的结果。
 * @param {string} conflictsPath - CONFLICTS.md 的绝对路径。
 * @param {string} cwd - 工作目录（用于显示路径缩写）。
 * @returns {string} 摘要文本；没有冲突时返回空串。
 */
export function renderConflictSummary(groups, conflictsPath, cwd) {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  const topics = groups
    .map((g) => g.topic)
    .filter((t) => typeof t === "string" && t !== "")
    .slice(0, 5);
  const more = groups.length > topics.length ? ` 等 ${groups.length} 组` : "";
  return [
    `<conflicts pending="${groups.length}">`,
    `有 ${groups.length} 组待裁决的冲突${topics.length > 0 ? `（${topics.join("、")}${more}）` : ""}。`,
    "这些条目**暂未带入上下文**，因为互相矛盾的信息只会干扰判断。",
    `完整清单见 ${displayPath(conflictsPath, cwd)}。`,
    "如果用户问起相关话题，可以主动提一句「记忆库里有两处待确认的冲突」。",
    "</conflicts>",
  ].join("\n");
}
