/**
 * 写入核心。**不依赖任何 DSH 运行时**，可以直接单元测试。
 *
 * 这一层被刻意从 `lib/tool.js` 里拆出来：`tool.js` 只是把 DSH 的工具定义
 * （`defineTool`、参数 schema、渲染）套在这个纯逻辑外面。拆开之后，写入的
 * 全部行为 —— 去重、冲突冻结、预算拒绝、审计 —— 都能在没有 DSH 的环境里
 * 用真实文件跑测试，而不是靠 mock 一整个 agent 运行时。
 *
 * 整个流程零 LLM 调用，全是字符串比较和文件 IO。
 *
 * 八个步骤（顺序有讲究，不要调换）：
 *   1. 空白硬拒         —— 空 topic + 空正文，直接拒，连盘都不碰
 *   2. 读盘 + 宽容解析  —— 读不到就当空文件（fail-open）
 *   3. 去重 / 冲突判定  —— 纯字符串比较，判定权在模型给的 mode 上
 *   4. 生成新内容       —— 按判定结果替换 / 插入 / 冻结
 *   5. 预算检查         —— 超限**明确拒绝**，不静默截断
 *   6. 原子落盘         —— 写临时文件再 rename
 *   7. 记审计           —— 只追加的 runs.jsonl
 *   8. 重建派生视图     —— CONFLICTS.md
 *
 * 整段「读 → 改 → 写」（第 2~6 步）在 lib/lock.js 的按文件锁内执行：本插件有两个
 * 会写同一份 MEMORY.md 的入口（模型的 memory_save、面板的 edit / resolve），不串行化
 * 会互相覆盖 —— 丢更新，而且两边都报成功。
 */
import { unlink } from "node:fs/promises";

import { appendRun } from "./audit.js";
import { renderConflicts } from "./conflicts.js";
import {
  CONFLICT_CONFLICT,
  CONFLICT_DUPLICATE,
  CONFLICT_UPDATE,
  collectConflicts,
  detectConflict,
  nextId,
} from "./detect.js";
import { contentHashOf } from "./hash.js";
import { withFileLock } from "./lock.js";
import {
  formatEntry,
  insertEntry,
  joinLines,
  parseMemory,
  removeLine,
  replaceLine,
} from "./parse.js";
import { resolveMemoryPaths } from "./paths.js";
import { usageLabel } from "./render.js";
import { readText, writeAtomic } from "./store.js";
import { byteLength } from "./truncate.js";

/** 合法的写入模式。 */
export const MODES = ["new", "update", "append"];

/** 没指定 section 时的兜底段名 —— 让它显眼一点，提醒人和模型去归类。 */
export const DEFAULT_SECTION = "未分类";

/**
 * 新建文件时的模板。
 *
 * 预置三个段名是有意的：给模型一个「该往哪儿放」的提示，比让它自己发明段名
 * 更不容易长出一堆一次性段落。
 *
 * @param {"project"|"user"} scope - 作用域。
 * @returns {string} 模板文本。
 */
export function emptyTemplate(scope) {
  const title = scope === "user" ? "# 用户记忆" : "# 项目记忆";
  return [
    title,
    "",
    "> 由 dsh-memory 维护。可以直接手改 —— 改动会被保留。",
    "> 带 `[待裁决]` 标记的条目存在冲突，暂不注入上下文。",
    "",
    "## 约定",
    "",
    "## 已定方案",
    "",
    "## 踩过的坑",
    "",
  ].join("\n");
}

/**
 * 生成返回里的用量行。
 * @param {string} text - 文件内容。
 * @param {object} paths - resolveMemoryPaths 的结果。
 * @returns {string} 用量描述。
 */
function usageOf(text, paths) {
  return `${paths.label}记忆 ${usageLabel(byteLength(text), paths.maxBytes)}`;
}

/**
 * 重建 CONFLICTS.md（派生视图，不是真相源）。
 *
 * 没有冲突时把文件删掉 —— 留一个空清单会让人以为还有待办。
 *
 * @param {object} paths - resolveMemoryPaths 的结果。
 * @param {string} text - 新的 MEMORY.md 内容。
 * @param {string} at - ISO 时间串。
 * @param {object|null} logger - 可选 logger。
 * @returns {Promise<void>}
 */
export async function rebuildConflicts(paths, text, at, logger = null) {
  try {
    const groups = collectConflicts(parseMemory(text).entries);
    const rendered = renderConflicts(groups, paths, at);
    if (rendered === null) {
      try {
        await unlink(paths.conflicts);
      } catch {
        // 本来就不存在。
      }
      return;
    }
    await writeAtomic(paths.conflicts, rendered);
  } catch (error) {
    // 派生视图失败不影响主流程。
    try {
      logger?.warn?.(`dsh-memory: CONFLICTS.md 重建失败: ${String(error)}`);
    } catch {
      // ignore
    }
  }
}

/**
 * 写入一条记忆。
 *
 * @param {object} options
 * @param {object} options.cfg - 归一化配置。
 * @param {string} options.cwd - 工作目录。
 * @param {object} options.input - `{topic, content, scope, mode, section, reason}`。
 * @param {string|null} [options.sessionKey] - 会话标识（进审计，便于回溯）。
 * @param {string} [options.now] - 当前时间 ISO 串（注入以便测试）。
 * @param {object|null} [options.logger] - 可选 logger。
 * @returns {Promise<{ok: boolean, action: string, id: string, message: string, usage: string}>}
 */
export async function saveMemory({
  cfg,
  cwd,
  input,
  sessionKey = null,
  now = new Date().toISOString(),
  logger = null,
}) {
  const scope = input?.scope === "user" ? "user" : "project";
  const paths = resolveMemoryPaths(cwd, scope, cfg);
  // 「读 → 改 → 写」整段串行化：否则并发的两个写入口各自读到同一版本、各自改，
  // 后写的覆盖先写的 —— 丢更新，而且两边都报成功。writeAtomic 只管「不写半截」。
  // 锁 key 用绝对路径，project / user 两个作用域天然各排各的队。
  return withFileLock(paths.file, () =>
    writeMemory({ input, sessionKey, now, logger, scope, paths }),
  );
}

/**
 * `saveMemory` 的临界区。**必须在 withFileLock 内调用** —— 它做的是读 → 改 → 写。
 *
 * @param {object} args
 * @param {object} args.input - 同 saveMemory。
 * @param {string|null} args.sessionKey - 会话标识（进审计）。
 * @param {string} args.now - 当前时间 ISO 串。
 * @param {object|null} args.logger - 可选 logger。
 * @param {"project"|"user"} args.scope - 已归一化的作用域。
 * @param {object} args.paths - resolveMemoryPaths 的结果。
 * @returns {Promise<{ok: boolean, action: string, id: string, message: string, usage: string}>}
 */
async function writeMemory({ input, sessionKey, now, logger, scope, paths }) {
  const topic = String(input?.topic ?? "").trim();
  // 正文压成一行：条目格式是「一行一条」，正文里的换行会破坏文件结构。
  const content = String(input?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const mode = MODES.includes(input?.mode) ? input.mode : "new";
  const section =
    typeof input?.section === "string" && input.section.trim() !== ""
      ? input.section.trim()
      : DEFAULT_SECTION;
  const reason =
    typeof input?.reason === "string" && input.reason.trim() !== ""
      ? input.reason.trim()
      : null;

  const at = now;
  const date = at.slice(0, 10);

  // ---- 1. 空白 / 纯噪声硬拒 ----
  const hash = contentHashOf(topic, content);
  if (hash === null) {
    await appendRun(
      paths.runs,
      { at, op: "reject", reason: "blank", scope, session: sessionKey },
      logger,
    );
    return {
      ok: false,
      action: "rejected",
      id: "",
      message: "写入被拒：topic 和正文都是空的（或只剩标点空白）。",
      usage: "",
    };
  }

  // ---- 2. 读盘 + 解析（fail-open：读不到就按空文件处理）----
  let text = null;
  try {
    text = await readText(paths.file);
  } catch (error) {
    try {
      logger?.warn?.(`dsh-memory: 读取 ${paths.displayPath} 失败: ${String(error)}`);
    } catch {
      // ignore
    }
  }
  const parsed = parseMemory(text ?? emptyTemplate(scope));
  const entries = parsed.entries;

  // ---- 3. 去重 / 冲突判定 ----
  const verdict = detectConflict(entries, { topic, hash, mode });

  if (verdict.kind === CONFLICT_DUPLICATE) {
    const existingId = verdict.with[0];
    await appendRun(
      paths.runs,
      { at, op: "dedupe", id: existingId, topic, hash, scope, session: sessionKey },
      logger,
    );
    return {
      ok: true,
      action: "deduped",
      id: existingId,
      message: `已存在完全相同的记忆（${existingId}），未重复写入。`,
      usage: usageOf(text ?? "", paths),
    };
  }

  // ---- 4. 生成新内容 ----
  let lines = parsed.lines;
  let op = "save";
  let action = "created";
  let message = "";
  let resultId = nextId(entries);
  let conflictWith = null;

  if (verdict.kind === CONFLICT_UPDATE) {
    const [firstId, ...restIds] = verdict.with;
    const target = entries.find((entry) => entry.id === firstId);
    if (target !== undefined) {
      // **area 必须从旧条目带过来。** formatEntry 是按传入字段现造注释行的，没传
      // 就没有 —— 直接四字段重建会把旧条目上的 `area:xxx`（工作空间标签）悄悄抹掉。
      // 那条记忆还在、id/topic 都没变，却从面板的工作空间分组里消失，且无从查证。
      // section 不走这里：它由行上方最近的 `## 标题` 决定，replaceLine 只换这一行、
      // 不挪位置，段落在原处保留。
      lines = replaceLine(
        lines,
        target.lineIndex,
        formatEntry({ id: firstId, topic, at: date, content, area: target.area }),
      );
      // 同 topic 的其余条目一并删掉。按行号从大到小删，避免前面的删除让后面的行号失效。
      const rest = restIds
        .map((id) => entries.find((entry) => entry.id === id))
        .filter((entry) => entry !== undefined)
        .sort((a, b) => b.lineIndex - a.lineIndex);
      for (const entry of rest) lines = removeLine(lines, entry.lineIndex);
      resultId = firstId;
      op = "update";
      action = "updated";
      message = `已更新 ${firstId}（topic: ${topic}），替换了原来的内容。`;
    }
  } else if (verdict.kind === CONFLICT_CONFLICT) {
    // 冲突：不删任何东西，两条都留，新条目打待裁决标记。
    lines = insertEntry(
      parseMemory(joinLines(lines)),
      section,
      formatEntry({
        id: resultId,
        topic,
        at: date,
        content,
        pending: true,
        conflictWith: verdict.with,
      }),
    );
    conflictWith = verdict.with;
    op = "conflict";
    action = "conflicted";
    message =
      `已写入 ${resultId}，但与同 topic（${topic}）的 ${verdict.with.join("、")} 结论不同，` +
      "已标记为待裁决，暂不注入上下文，等人裁决。";
  } else {
    lines = insertEntry(
      parseMemory(joinLines(lines)),
      section,
      formatEntry({ id: resultId, topic, at: date, content }),
    );
    message = `已写入 ${resultId}（topic: ${topic}）。`;
  }

  const next = joinLines(lines);

  // ---- 5. 预算检查（超限不静默截断，明确拒绝）----
  const bytes = byteLength(next);
  if (bytes > paths.maxBytes) {
    await appendRun(
      paths.runs,
      { at, op: "reject", reason: "oversize", topic, hash, scope, bytes, session: sessionKey },
      logger,
    );
    return {
      ok: false,
      action: "rejected",
      id: "",
      message:
        `写入被拒：${paths.label}记忆将达到 ${bytes}/${paths.maxBytes} 字节，超出上限。` +
        '请先用 mode: "update" 合并同类项，或删掉过时条目，再重试。',
      usage: usageOf(text ?? "", paths),
    };
  }

  // ---- 6. 原子落盘 ----
  await writeAtomic(paths.file, next);

  // ---- 7. 审计 ----
  await appendRun(
    paths.runs,
    {
      at,
      op,
      id: resultId,
      topic,
      hash,
      scope,
      mode,
      section,
      bytes,
      ...(conflictWith !== null ? { with: conflictWith.join(",") } : {}),
      ...(reason !== null ? { reason } : {}),
      session: sessionKey,
    },
    logger,
  );

  // ---- 8. 重建派生视图 ----
  await rebuildConflicts(paths, next, at, logger);

  return {
    ok: true,
    action,
    id: resultId,
    message,
    usage: usageOf(next, paths),
  };
}
