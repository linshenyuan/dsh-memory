/**
 * 记忆渲染。
 *
 * 两个消费者：
 *
 *   - `renderSnapshot` —— 「整批快照」形态，原来是会话开始时一次性注入用的
 *     （见历史设计）。现在记忆改成**按需读取**（`memory_read` 工具），快照形态
 *     仍保留给 `memory_read` 在 `scope: "both"` 时复用，保证两种入口给出的
 *     排版完全一致。
 *   - `readMemory` —— 按需读取的入口，按 `scope` / `topic` 现读现渲染，永远反映
 *     磁盘上的最新状态（没有「冻结」窗口）。
 *
 * 渲染顺序（安全相关，不能调换）：**先打码，再截断**。反过来会让被截断切开的
 * 凭据逃过正则。
 */
import { collectConflicts } from "./detect.js";
import { renderConflictSummary } from "./conflicts.js";
import { parseMemory } from "./parse.js";
import { resolveMemoryPaths } from "./paths.js";
import { sanitize } from "./sanitize.js";
import { byteLength, truncateUtf8 } from "./truncate.js";

/** 注入块的引导语。 */
const INTRO = [
  "<memory>",
  "以下是跨会话长期记忆的**当前**内容（每次调用都从磁盘实时读取，反映最新状态）。",
  "**你当前的指令和项目的实际状态优先于这里的内容。** 记忆与现实冲突时先去查证。",
];

/**
 * 用量表头。
 *
 * 带上百分比和绝对值，模型才知道还剩多少空间 —— 它会主动合并，而不是硬塞。
 * 这个做法抄自 Hermes 的 `[67% — 1,474/2,200 chars]`。
 *
 * @param {number} used - 已用字节。
 * @param {number} max - 上限字节。
 * @returns {string} 表头文本。
 */
export function usageLabel(used, max) {
  const pct = max > 0 ? Math.min(999, Math.round((used / max) * 100)) : 0;
  return `${pct}% (${used}/${max} bytes)`;
}

/**
 * 按段把条目渲染成文本。保留段标题，丢掉文件里的说明文字（那些是给人看的）。
 *
 * @param {Array<object>} entries - 条目。
 * @returns {string} 渲染结果。
 */
export function renderEntries(entries) {
  const bySection = new Map();
  for (const entry of entries) {
    const key = typeof entry.section === "string" ? entry.section : "";
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(entry);
  }

  const out = [];
  for (const [section, list] of bySection) {
    if (section !== "") out.push(`## ${section}`);
    for (const entry of list) out.push(`- ${entry.content}`);
    out.push("");
  }
  return out.join("\n").trim();
}

/**
 * 渲染一个作用域的记忆块。
 *
 * @param {string} tag - 标签名（`project_memory` / `user_memory`）。
 * @param {object} paths - resolveMemoryPaths 的结果。
 * @param {Array<object>} entries - 该作用域的全部条目。
 * @param {object} cfg - 归一化配置。
 * @returns {string|null} 渲染结果；没有可注入内容时返回 null。
 */
export function renderScope(tag, paths, entries, cfg) {
  // 冻结：待裁决条目互相矛盾，喂给模型只会让它混乱，不如等人裁决。
  const visible = cfg.conflictFreeze === true
    ? entries.filter((entry) => !entry.pending)
    : entries;
  if (visible.length === 0) return null;

  const body = renderEntries(visible);
  if (body === "") return null;

  // 顺序不能换：先打码再截断。反过来会让被切开的凭据逃过正则。
  const scanned = cfg.sensitiveScan === true ? sanitize(body) : { text: body, hits: 0 };
  const rawBytes = byteLength(scanned.text);
  const oversize = rawBytes > paths.maxBytes;
  const shown = oversize ? truncateUtf8(scanned.text, paths.maxBytes) : scanned.text;

  const usage = oversize
    ? `OVERSIZE (${rawBytes}/${paths.maxBytes} bytes)`
    : usageLabel(rawBytes, paths.maxBytes);

  const parts = [`<${tag} path="${paths.displayPath}" usage="${usage}">`, shown];

  if (scanned.hits > 0) {
    parts.push("", `[已打码 ${scanned.hits} 处疑似凭据或注入语句 —— 磁盘上的原文未改动]`);
  }

  if (oversize) {
    // 明确告知，不静默截断。静默截断会让模型以为自己写的都还在。
    parts.push(
      "",
      `[记忆超限] 该文件已达 ${rawBytes} 字节，超过 ${paths.maxBytes} 上限，本次只带入了前 ${paths.maxBytes} 字节。`,
      "请先用 `memory_save` 的 `mode: \"update\"` 合并同类项，或删掉过时条目，把总量降回上限以内。",
    );
  }

  parts.push(`</${tag}>`);
  return parts.join("\n");
}

/**
 * 读取并渲染一个作用域的原始素材。
 *
 * fail-open：读不到就当作「没有记忆」，绝不阻塞主流程。
 *
 * @param {string} cwd - 工作目录。
 * @param {"project"|"user"} scope - 作用域。
 * @param {object} cfg - 归一化配置。
 * @param {Function} readText - 读文件函数（注入以便测试）。
 * @param {object|null} [signal] - 中止信号。
 * @param {object|null} [logger] - 可选 logger。
 * @returns {Promise<{paths: object, parsed: object|null}>}
 */
export async function loadScope(cwd, scope, cfg, readText, signal = null, logger = null) {
  const paths = resolveMemoryPaths(cwd, scope, cfg);
  let text = null;
  try {
    signal?.throwIfAborted?.();
    text = await readText(paths.file);
  } catch (error) {
    try {
      logger?.warn?.(`dsh-memory: 读取 ${paths.displayPath} 失败，按无记忆继续: ${String(error)}`);
    } catch {
      // logger 自己坏了也不能往上抛。
    }
  }
  return { paths, parsed: text === null ? null : parseMemory(text) };
}

/**
 * 渲染完整的 `<memory>` 注入块。
 *
 * 返回值同时给出**拼好的文本**和**具名分片**。分片不是装饰：DSH 的会话视图
 * 按 `source.form === "snapshot"` 把注入块渲染成「谁贡献了哪一段」的列表，
 * 而那个 form 要求 `sections` 是一个非空的 `{name, text}` 数组 ——
 * 声明了 form 却不给 sections，那一行会**静默降级**成不透明视图。
 * 所以这里一并产出，两边永远同源。
 *
 * 注意 `INTRO` / `</memory>` 这几行框架文字**不属于任何分片** —— 它们声明的是
 * 这个 form 自身的语义（「这是一份快照，会取代更早的快照」），不是某一段内容。
 *
 * @param {object} options
 * @param {string} options.cwd - 工作目录。
 * @param {object} options.cfg - 归一化配置。
 * @param {Function} options.readText - 读文件函数。
 * @param {object|null} [options.signal] - 中止信号。
 * @param {object|null} [options.logger] - 可选 logger。
 * @returns {Promise<{text: string, sections: Array<{name: string, text: string}>}|undefined>}
 *          注入内容与它的具名分片；没有可注入内容时 undefined。
 */
export async function renderSnapshot({ cwd, cfg, readText, signal = null, logger = null }) {
  const sections = [];

  for (const scope of ["project", "user"]) {
    const { paths, parsed } = await loadScope(cwd, scope, cfg, readText, signal, logger);
    if (parsed === null) continue;

    const tag = scope === "user" ? "user_memory" : "project_memory";
    const block = renderScope(tag, paths, parsed.entries, cfg);
    if (block !== null) sections.push({ name: tag, text: block });

    const groups = collectConflicts(parsed.entries);
    if (groups.length > 0) {
      sections.push({
        name: "conflicts",
        text: renderConflictSummary(groups, paths.conflicts, cwd),
      });
    }
  }

  if (sections.length === 0) return undefined;

  // 作用域块在前、冲突摘要在后 —— 和人的阅读顺序一致：先看已知的，再看待确认的。
  const scopeParts = sections.filter((s) => s.name !== "conflicts").map((s) => s.text);
  const conflictParts = sections.filter((s) => s.name === "conflicts").map((s) => s.text);

  const lines = [...INTRO, ""];
  if (scopeParts.length > 0) lines.push(...scopeParts, "");
  if (conflictParts.length > 0) lines.push(...conflictParts, "");
  lines.push("</memory>");

  return { text: lines.join("\n"), sections };
}

/**
 * 按需读取记忆并渲染成可读文本。
 *
 * 与 `renderSnapshot` 的区别：它不套 `<memory>` 信封、不分 `source.form` 分片——
 * 它就是 `memory_read` 工具直接回给模型的一段明文。永远从磁盘现读现渲染，所以
 * 反映最新状态，没有「会话开始时冻结」那一层。
 *
 * `scope: "both"` 且**不**带 `topic` 时直接复用 `renderSnapshot`：那段排版（含
 * 冲突摘要、usage 表头、打码/截断）已经是定稿，两种入口给同样的排版最不容易让
 * 模型产生「两份记忆格式不一样」的困惑。其余情况（单作用域、或带 topic 过滤）
 * 走下面这条逐作用域的轻量路径。
 *
 * @param {object} options
 * @param {string} options.cwd - 工作目录。
 * @param {"project"|"user"|"both"} options.scope - 读取哪个作用域。
 * @param {object} options.cfg - 归一化配置。
 * @param {Function} options.readText - 读文件函数。
 * @param {string|null} [options.topic] - 可选 topic 过滤（kebab-case，不区分大小写）。
 * @param {object|null} [options.signal] - 中止信号。
 * @param {object|null} [options.logger] - 可选 logger。
 * @returns {Promise<string|null>} 拼接好的可读文本；两个作用域都没有可读取内容时 null。
 */
export async function readMemory({ cwd, scope, cfg, readText, topic = null, signal = null, logger = null }) {
  // both + 无 topic：复用整批快照排版（含冲突摘要）。
  if ((topic === null || topic === "") && scope === "both") {
    const snap = await renderSnapshot({ cwd, cfg, readText, signal, logger });
    return snap?.text ?? null;
  }

  const normalizedTopic =
    topic !== null && topic !== "" ? topic.trim().toLowerCase() : null;
  const scopes = scope === "both" ? ["project", "user"] : [scope];
  const blocks = [];

  for (const s of scopes) {
    const { paths, parsed } = await loadScope(cwd, s, cfg, readText, signal, logger);
    if (parsed === null) continue;

    const tag = s === "user" ? "user_memory" : "project_memory";
    let entries = parsed.entries;
    if (normalizedTopic !== null) {
      entries = entries.filter((entry) => (entry.topic ?? "").toLowerCase() === normalizedTopic);
    }
    const block = renderScope(tag, paths, entries, cfg);
    if (block !== null) blocks.push(block);

    // topic 过滤是「查某一主题」，附上无关的冲突摘要只会添乱，所以仅全量时附。
    if (normalizedTopic === null) {
      const groups = collectConflicts(parsed.entries);
      if (groups.length > 0) {
        blocks.push(renderConflictSummary(groups, paths.conflicts, cwd));
      }
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
