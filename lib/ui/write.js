/**
 * 面板上的自由编辑（增 / 改 / 删）。
 *
 * 面板上之前只有一个写入口 —— 冲突裁决（`resolve.js`，限 4 个固定动作）。要改
 * 一条普通记忆，要么手编 MEMORY.md，要么让模型调 `memory_save`。这文件补上
 * 「用户在面板里直接编辑」这条路：
 *
 *   add     新增一条（topic + 正文，可选分类，可选工作空间）
 *   update  改一条已存在的（按 id 或 topic 定位，改 topic/正文/分类/工作空间）
 *   delete  删一条（按 id 或 topic 定位）
 *
 * 三个约束，和 `resolve.js` 对齐：
 *
 * 1. **只改该改的行。** 复用 parse.js 的行级编辑，不重写整个文件 —— 用户可能在
 *    文件里写了额外的说明文字、自定义段标题、注释，整文件重写会把这些全抹掉。
 *
 * 2. **定位靠 id，回退靠 topic。** 面板拿到的每条记忆都带 id（见 lib/ui/data.js
 *    的 entryView），所以优先按 id 精确命中；没给 id 时再按 topic 找第一条。
 *
 * 3. **改完立即落盘 + 记审计 + 重建派生视图。** `by:"user"` 写进审计，和模型写入
 *    （`memory_save` 不带 by、或 by 未设）区分开 —— 以后查「谁改的」一目了然。
 *
 * 本文件**不依赖 DSH 运行时**，读写函数由调用方注入，可以独立单测。
 */
import { appendRun } from "../audit.js";
import { nextId } from "../detect.js";
import {
  formatEntry,
  insertEntry,
  joinLines,
  parseMemory,
  removeLine,
  replaceLine,
} from "../parse.js";
import { resolveMemoryPaths } from "../paths.js";
import { DEFAULT_SECTION, emptyTemplate, rebuildConflicts } from "../save.js";
import { byteLength } from "../truncate.js";

/** 面板给的三个编辑动作。 */
export const EDIT_ACTIONS = Object.freeze(["add", "update", "delete"]);

/**
 * 把正文压成一行：条目格式是「一行一条」，正文里的换行会破坏文件结构。
 * 与 lib/save.js 的 saveMemory 一致。
 * @param {unknown} content - 原始正文。
 * @returns {string} 压平后的正文。
 */
function normContent(content) {
  return String(content ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 在解析结果里找目标条目：优先 id，其次 topic（首个匹配）。
 *
 * @param {object[]} entries - parseMemory 的条目。
 * @param {{id?: string|null, topic?: string|null}} locator - 定位信息。
 * @returns {object|null} 命中的条目；找不到返回 null。
 */
function findEntry(entries, locator) {
  if (typeof locator.id === "string" && locator.id !== "") {
    const byId = entries.find((e) => e.id === locator.id);
    if (byId !== undefined) return byId;
  }
  if (typeof locator.topic === "string" && locator.topic.trim() !== "") {
    const byTopic = entries.find((e) => e.topic === locator.topic.trim());
    if (byTopic !== undefined) return byTopic;
  }
  return null;
}

/**
 * 预算拒绝（与 saveMemory 同口径）。
 * @param {object} paths - resolveMemoryPaths 的结果。
 * @param {string} topic - 主题。
 * @param {number} bytes - 写入后字节数。
 * @param {string} [scope] - 审计用作用域。
 * @returns {{ok: false, action: string, id: string, message: string}} 拒绝结果。
 */
function overBudget(paths, topic, bytes, scope) {
  return {
    ok: false,
    action: "rejected",
    id: "",
    message:
      `写入被拒：${paths.label}记忆将达到 ${bytes}/${paths.maxBytes} 字节，超出上限。` +
      '请先删掉过时条目，或缩短内容，再重试。',
    usage: "",
    scope,
  };
}

/**
 * 执行一次面板编辑。
 *
 * @param {object} options
 * @param {object} options.cfg - 归一化配置。
 * @param {string} options.cwd - 工作目录。
 * @param {"project"|"user"} options.scope - 作用域。
 * @param {"add"|"update"|"delete"} options.action - 编辑动作。
 * @param {string} [options.id] - 目标条目 id（定位用，优先于 topic）。
 * @param {string} [options.topic] - 目标/新 主题（定位或新增用）。
 * @param {string} [options.content] - 新正文（add/update 用）。
 * @param {string} [options.section] - 新分类（add/update 用，空则兜底「未分类」）。
 * @param {string} [options.area] - 新工作空间（add/update 用，仅项目作用域有意义）。
 * @param {(path: string) => Promise<string|null>} options.readText - 读文件。
 * @param {(path: string, text: string) => Promise<void>} options.writeText - 原子写。
 * @param {string} [options.now] - 当前时间 ISO 串（注入以便测试）。
 * @param {object|null} [options.logger] - 可选 logger。
 * @returns {Promise<{ok: boolean, action: string, id?: string, message: string}>}
 */
export async function editMemory({
  cfg,
  cwd,
  scope,
  action,
  id = null,
  topic = null,
  content = null,
  section = null,
  area = null,
  readText,
  writeText,
  now = new Date().toISOString(),
  logger = null,
}) {
  if (!EDIT_ACTIONS.includes(action)) {
    return { ok: false, action, message: `未知的编辑动作: ${String(action)}` };
  }

  const paths = resolveMemoryPaths(cwd, scope === "user" ? "user" : "project", cfg);
  const date = now.slice(0, 10);

  let text;
  try {
    text = await readText(paths.file);
  } catch (error) {
    return { ok: false, action, message: `读取 ${paths.displayPath} 失败: ${String(error)}` };
  }

  // add 允许文件不存在（直接新建）；update/delete 必须有内容可改。
  if (action !== "add" && (text === null || text === undefined || text === "")) {
    return { ok: false, action, message: `${paths.displayPath} 不存在或为空，没有可编辑的内容。` };
  }

  const parsed = parseMemory(text ?? emptyTemplate(scope));
  const entries = parsed.entries;

  // ---- 新增 ----
  if (action === "add") {
    const newTopic = String(topic ?? "").trim();
    const newContent = normContent(content);
    if (newTopic === "" || newContent === "") {
      return { ok: false, action, message: "新增条目需要 topic 和正文，两者都不能为空。" };
    }
    const sec = typeof section === "string" && section.trim() !== "" ? section.trim() : DEFAULT_SECTION;
    const newArea = typeof area === "string" && area.trim() !== "" ? area.trim() : null;
    const newId = nextId(entries);

    let lines = insertEntry(
      parseMemory(joinLines(parsed.lines)),
      sec,
      formatEntry({ id: newId, topic: newTopic, at: date, content: newContent, area: newArea }),
    );
    const next = joinLines(lines);

    const bytes = byteLength(next);
    if (bytes > paths.maxBytes) {
      return { ...overBudget(paths, newTopic, bytes, paths.scope), id: "" };
    }

    await writeText(paths.file, next);
    await appendRun(
      paths.runs,
      { at: now, op: "save", id: newId, topic: newTopic, section: sec, area: newArea, scope: paths.scope, by: "user", bytes },
      logger,
    );
    await rebuildConflicts(paths, next, now, logger);
    return { ok: true, action, id: newId, message: `已新增 ${newId}（topic: ${newTopic}）。` };
  }

  // ---- 改 / 删：都要先定位 ----
  const target = findEntry(entries, { id, topic });
  if (target === null) {
    return {
      ok: false,
      action,
      message: "找不到要操作的条目（id 或 topic 都没匹配上）。",
    };
  }

  if (action === "delete") {
    const next = joinLines(removeLine(parsed.lines, target.lineIndex));
    await writeText(paths.file, next);
    await appendRun(
      paths.runs,
      { at: now, op: "delete", id: target.id, topic: target.topic, scope: paths.scope, by: "user" },
      logger,
    );
    await rebuildConflicts(paths, next, now, logger);
    return { ok: true, action, id: target.id, message: `已删除 ${target.id}。` };
  }

  // ---- update ----
  const newTopic = typeof topic === "string" && topic.trim() !== "" ? topic.trim() : target.topic;
  const newContent =
    typeof content === "string" && content.trim() !== "" ? normContent(content) : target.content;
  const newSection =
    typeof section === "string" && section.trim() !== "" ? section.trim() : target.section ?? DEFAULT_SECTION;
  const newArea =
    typeof area === "string" && area.trim() !== "" ? area.trim() : target.area ?? null;

  const line = formatEntry({
    id: target.id,
    topic: newTopic,
    at: target.at ?? date,
    content: newContent,
    area: newArea,
    pending: target.pending === true,
    conflictWith: target.conflictWith,
  });

  let lines;
  if (newSection !== (target.section ?? DEFAULT_SECTION)) {
    // 换了分类 → 先删原行，再插到新段末尾（保持段结构）。
    lines = insertEntry(
      parseMemory(joinLines(removeLine(parsed.lines, target.lineIndex))),
      newSection,
      line,
    );
  } else {
    lines = replaceLine(parsed.lines, target.lineIndex, line);
  }
  const next = joinLines(lines);

  const bytes = byteLength(next);
  if (bytes > paths.maxBytes) {
    return { ...overBudget(paths, newTopic, bytes, paths.scope), id: target.id };
  }

  await writeText(paths.file, next);
  await appendRun(
    paths.runs,
    {
      at: now,
      op: "update",
      id: target.id,
      topic: newTopic,
      section: newSection,
      area: newArea,
      scope: paths.scope,
      by: "user",
      bytes,
    },
    logger,
  );
  await rebuildConflicts(paths, next, now, logger);
  return { ok: true, action, id: target.id, message: `已更新 ${target.id}（topic: ${newTopic}）。` };
}
