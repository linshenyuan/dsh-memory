/**
 * MEMORY.md 的解析与行级编辑。
 *
 * 两条设计原则：
 *
 * 1. **解析必须宽容。** 模型和人都能手改这个文件。遇到看不懂的行一律跳过，
 *    **绝不抛错** —— 一个解析器 bug 不该让整个记忆功能不可用。
 *
 * 2. **编辑按行做，不重写整个文件。** 用户可能在文件里写了额外的说明文字、
 *    自定义的段标题、注释。整文件重写会把这些全抹掉。按行插入/替换/删除则
 *    只动该动的那一行。
 *
 * 条目格式：
 *
 *   - 正文 <!-- id:m001 topic:indent-style at:2026-10-01 -->
 *   - [待裁决] 正文 <!-- id:m005 topic:package-manager at:2026-10-12 conflict-with:m001 -->
 *
 * 元数据放 HTML 注释：Markdown 渲染器会隐藏它，文件依然干净；机器一条正则
 * 就能精确解析。
 *
 * 注意：**哈希不入文件**，每次解析时从 `topic + content` 重算。文件更干净，
 * 而且避免了「文件里的哈希和实际内容不一致」这种隐性损坏。
 */
import { contentHashOf } from "./hash.js";

/** `## 段名`（只认二级标题）。 */
const HEADING_RE = /^#{2}\s+(.*?)\s*$/;
/** 条目行：`- [待裁决] 正文 <!-- meta -->`。 */
const ENTRY_RE = /^(\s*)-\s+(?:\[(待裁决)\]\s+)?(.+?)\s*$/;
/**
 * 行尾的元数据注释。
 *
 * 注释体用 `(?:(?!-->)[\s\S])*?` 而不是 `.*?`：**禁止注释体里出现 `-->`**。
 *
 * 这不是洁癖。如果允许，那么一行里有两个注释时，惰性匹配会从**第一个** `<!--`
 * 开始、一路吃到最后一个 `-->`，把中间的正文整段吞成元数据 ——
 * `- 正文 <!-- 注 --> 还有正文 <!-- id:m1 ... -->` 会变成正文只剩「正文」，
 * 后面那截凭空消失。加上这个约束，正则引擎只能从最后一个 `<!--` 起匹配。
 */
const TRAILING_META_RE = /\s*<!--\s*((?:(?!-->)[\s\S])*?)\s*-->\s*$/;
/** 行内注释（连同两侧空白）。 */
const INLINE_COMMENT_RE = /[ \t]*<!--[\s\S]*?-->[ \t]*/g;

/**
 * 剥掉正文里原有的 HTML 注释。
 *
 * 为什么必须剥：元数据就放在 HTML 注释里。如果正文里混进一段
 * `<!-- id:fake -->`，写回去之后解析器会把 fake 当成真元数据 —— 条目会凭空
 * 换 id / 换 topic，而且下一次写入的「去重」判定会基于假指纹，产生重复条目。
 * 这类污染是自我放大的，必须在**读和写两侧**都切断，否则读到的内容与写回的
 * 内容不一致，哈希校验会误报。
 *
 * 只在「注释两侧都有实际内容、且原文本来就有空白」时才补一个空格，
 * 避免 `正文<!--x-->继续` 被黏成 `正文继续`。
 *
 * @param {unknown} text - 原始正文。
 * @returns {string} 干净的正文。
 */
function stripInlineComments(text) {
  return String(text ?? "")
    .replace(INLINE_COMMENT_RE, (match, offset, whole) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      // 只看被正则吃掉的**首尾**空白，不能看整个 match ——
      // 注释体里本来就可能有空格（`<!-- 说明 -->`），那不算「原文这里有空白」。
      const ateSpace = /^[ \t]/.test(match) || /[ \t]$/.test(match);
      const needsGlue = ateSpace && /\S$/.test(before) && /^\S/.test(after);
      return needsGlue ? " " : "";
    })
    .trim();
}

/**
 * 解析 `id:m001 topic:foo at:2026-10-01` 形式的元数据串。
 * 无法识别（没有冒号）的片段直接忽略。
 *
 * @param {unknown} raw - 元数据串。
 * @returns {Record<string, string>} 键值对。
 */
function parseMeta(raw) {
  const meta = {};
  for (const part of String(raw ?? "").split(/\s+/)) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    meta[part.slice(0, i)] = part.slice(i + 1);
  }
  return meta;
}

/**
 * 解析 MEMORY.md。
 *
 * @param {unknown} text - 文件内容。
 * @returns {{lines: string[], sections: Array<{name: string, headingLine: number,
 *            startLine: number, endLine: number}>, entries: Array<object>}}
 */
export function parseMemory(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  const entries = [];
  const seenIds = new Set();
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      if (current !== null) current.endLine = i;
      current = { name: heading[1], headingLine: i, startLine: i + 1, endLine: lines.length };
      sections.push(current);
      continue;
    }

    const match = ENTRY_RE.exec(line);
    if (match === null) continue;

    // 先切掉行尾的元数据注释，剩下的才是正文。
    const tail = TRAILING_META_RE.exec(match[3]);
    const meta = parseMeta(tail === null ? "" : tail[1]);
    const body = tail === null ? match[3] : match[3].slice(0, tail.index);
    // 正文里残留的行内注释在这里一并剥掉，保证「读到的」和「写回的」是同一份文本。
    const content = stripInlineComments(body);
    // 正文被剥空的条目没有任何信息量，注入时只会变成一行空的 `- `，直接丢掉。
    if (content === "") continue;

    const id = typeof meta.id === "string" && meta.id !== "" ? meta.id : null;

    // 重复 id：跳过后来者。保留先出现的那条，因为它更可能是原始条目。
    if (id !== null) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    entries.push({
      lineIndex: i,
      indent: match[1] ?? "",
      pending: match[2] !== undefined,
      content,
      id,
      topic: typeof meta.topic === "string" && meta.topic !== "" ? meta.topic : null,
      at: typeof meta.at === "string" && meta.at !== "" ? meta.at : null,
      conflictWith: typeof meta["conflict-with"] === "string" ? meta["conflict-with"] : null,
      section: current === null ? null : current.name,
      area: typeof meta.area === "string" && meta.area !== "" ? meta.area : null,
      hash: contentHashOf(meta.topic ?? "", content),
    });
  }

  return { lines, sections, entries };
}

/**
 * 生成一行条目文本。
 *
 * @param {{id: string, topic: string, at: string, content: string,
 *          pending?: boolean, conflictWith?: string|string[]|null}} entry
 * @returns {string} 一行 Markdown。
 */
export function formatEntry(entry) {
  const meta = [`id:${entry.id}`, `topic:${entry.topic}`, `at:${entry.at}`];
  if (typeof entry.area === "string" && entry.area.trim() !== "") meta.push(`area:${entry.area.trim()}`);
  const withIds = Array.isArray(entry.conflictWith)
    ? entry.conflictWith.join(",")
    : entry.conflictWith;
  if (typeof withIds === "string" && withIds !== "") meta.push(`conflict-with:${withIds}`);
  const flag = entry.pending === true ? "[待裁决] " : "";
  // 正文里已有的 HTML 注释会被解析器当成元数据，先剥掉避免自我污染。
  const body = stripInlineComments(entry.content);
  return `- ${flag}${body} <!-- ${meta.join(" ")} -->`;
}

/**
 * 在指定段末尾插入一行；段不存在就创建。
 *
 * 「段末尾」= 该段范围内最后一个非空行之后。这样段与段之间会自动留出空行，
 * 而且不会插到下一段的标题下面。
 *
 * @param {{lines: string[], sections: Array<object>}} parsed - parseMemory 的结果。
 * @param {string} sectionName - 目标段名。
 * @param {string} line - 要插入的行。
 * @returns {string[]} 新的行数组（不修改入参）。
 */
export function insertEntry(parsed, sectionName, line) {
  const lines = [...parsed.lines];
  const section = parsed.sections.find((s) => s.name === sectionName);

  if (section === undefined) {
    // 段不存在 → 在文件末尾新建一个段。
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(`## ${sectionName}`, "", line);
    return lines;
  }

  let insertAt = section.startLine;
  for (let i = section.startLine; i < section.endLine; i += 1) {
    if (lines[i].trim() !== "") insertAt = i + 1;
  }
  lines.splice(insertAt, 0, line);
  return lines;
}

/**
 * 替换一行。行号越界时原样返回。
 * @param {string[]} lines - 行数组。
 * @param {number} lineIndex - 行号。
 * @param {string} line - 新内容。
 * @returns {string[]} 新的行数组。
 */
export function replaceLine(lines, lineIndex, line) {
  if (lineIndex < 0 || lineIndex >= lines.length) return [...lines];
  const next = [...lines];
  next[lineIndex] = line;
  return next;
}

/**
 * 删除一行，并顺手清掉它留下的多余空行（连续两个空行压成一个）。
 * @param {string[]} lines - 行数组。
 * @param {number} lineIndex - 行号。
 * @returns {string[]} 新的行数组。
 */
export function removeLine(lines, lineIndex) {
  if (lineIndex < 0 || lineIndex >= lines.length) return [...lines];
  const next = [...lines];
  next.splice(lineIndex, 1);
  return collapseBlankLines(next);
}

/**
 * 连续空行压成一个，并去掉首尾空行。
 * @param {string[]} lines - 行数组。
 * @returns {string[]} 新的行数组。
 */
export function collapseBlankLines(lines) {
  const out = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0 && out[out.length - 1].trim() === "") continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out;
}

/**
 * 行数组拼回文件文本（末尾留一个换行）。
 * @param {string[]} lines - 行数组。
 * @returns {string} 文件内容。
 */
export function joinLines(lines) {
  return `${lines.join("\n")}\n`;
}
