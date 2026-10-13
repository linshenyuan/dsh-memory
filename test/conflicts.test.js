import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { renderConflictSummary, renderConflicts } from "../lib/conflicts.js";
import { collectConflicts } from "../lib/detect.js";
import { parseMemory } from "../lib/parse.js";
import { resolveMemoryPaths } from "../lib/paths.js";

const CWD = resolve("/tmp/ws");
const cfg = resolveConfig({ projectMemoryDir: ".memory" });
const paths = resolveMemoryPaths(CWD, "project", cfg);

const CONFLICTED = [
  "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
  "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
].join("\n");

test("没有冲突时返回 null（表示该删掉这个文件）", () => {
  assert.equal(renderConflicts([], paths, "2026-10-12T00:00:00.000Z"), null);
  assert.equal(renderConflicts(null, paths, "2026-10-12T00:00:00.000Z"), null);
});

test("渲染出已有条目与待裁决条目，并说清怎么裁决", () => {
  const groups = collectConflicts(parseMemory(CONFLICTED).entries);
  const text = renderConflicts(groups, paths, "2026-10-12T00:00:00.000Z");

  assert.match(text, /^# 待裁决冲突/);
  assert.match(text, /不要直接编辑这个文件/);
  assert.match(text, /当前 1 组待裁决/);
  assert.match(text, /## pm/);
  assert.match(text, /\*\*已有\*\* · 2026-10-01 · `m001`/);
  assert.match(text, /> 用 npm。/);
  assert.match(text, /\*\*待裁决\*\* · 2026-10-12 · `m002`/);
  assert.match(text, /> 用 pnpm。/);
  // 裁决方式必须给出可操作的动作，否则人不知道该改哪儿。
  assert.match(text, /编辑 `MEMORY\.md`/);
  assert.match(text, /删掉不要的那条/);
});

test("多组冲突各自成节", () => {
  const text = [
    "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
    "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
    "- 缩进 2 空格。<!-- id:m003 topic:indent at:2026-10-01 -->",
    "- [待裁决] 缩进 4 空格。<!-- id:m004 topic:indent at:2026-10-12 conflict-with:m003 -->",
  ].join("\n");
  const groups = collectConflicts(parseMemory(text).entries);
  const rendered = renderConflicts(groups, paths, "2026-10-12T00:00:00.000Z");
  assert.match(rendered, /当前 2 组待裁决/);
  assert.match(rendered, /## pm/);
  assert.match(rendered, /## indent/);
});

test("注入里的冲突摘要只给计数和路径，不给正文", () => {
  const groups = collectConflicts(parseMemory(CONFLICTED).entries);
  const summary = renderConflictSummary(groups, paths.conflicts, CWD);

  assert.match(summary, /^<conflicts pending="1">/);
  assert.match(summary, /有 1 组待裁决的冲突（pm）/);
  assert.match(summary, /暂未带入上下文/);
  assert.match(summary, /完整清单见 \.memory\/CONFLICTS\.md/);
  assert.match(summary, /<\/conflicts>$/);
  // 互相矛盾的两条正文都不该进上下文。
  assert.equal(summary.includes("用 npm。"), false);
  assert.equal(summary.includes("用 pnpm。"), false);
});

test("冲突组数超过 5 时只列前 5 个话题名，但计数是准确的", () => {
  const lines = [];
  for (let i = 1; i <= 8; i += 1) {
    lines.push(`- 旧 ${i}。<!-- id:m1${i} topic:topic-${i} at:2026-10-01 -->`);
    lines.push(
      `- [待裁决] 新 ${i}。<!-- id:m2${i} topic:topic-${i} at:2026-10-12 conflict-with:m1${i} -->`,
    );
  }
  const groups = collectConflicts(parseMemory(lines.join("\n")).entries);
  assert.equal(groups.length, 8);

  const summary = renderConflictSummary(groups, paths.conflicts, CWD);
  assert.match(summary, /pending="8"/);
  assert.match(summary, /有 8 组待裁决的冲突/);
  assert.match(summary, /等 8 组/);
  // 只列 5 个话题名。
  assert.equal(summary.includes("topic-6"), false);
});

test("没有冲突时摘要为空串（不往上下文里塞空标签）", () => {
  assert.equal(renderConflictSummary([], paths.conflicts, CWD), "");
});

test("没有 topic 的冲突组也能渲染", () => {
  const text = [
    "- 甲。<!-- id:m001 at:2026-10-01 -->",
    "- [待裁决] 乙。<!-- id:m002 at:2026-10-12 conflict-with:m001 -->",
  ].join("\n");
  const groups = collectConflicts(parseMemory(text).entries);
  const rendered = renderConflicts(groups, paths, "2026-10-12T00:00:00.000Z");
  assert.match(rendered, /## \(无 topic\)/);
  // 摘要里没有话题名，但计数仍然要给。
  assert.match(renderConflictSummary(groups, paths.conflicts, CWD), /pending="1"/);
});

test("CONFLICTS.md 里给出了 MEMORY.md 的位置", () => {
  const groups = collectConflicts(parseMemory(CONFLICTED).entries);
  const text = renderConflicts(groups, paths, "2026-10-12T00:00:00.000Z");
  assert.match(text, /文件位置：\.memory\/MEMORY\.md/);
  assert.equal(text.includes(join(CWD, ".memory")), false);
});
