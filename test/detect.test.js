import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CONFLICT_CONFLICT,
  CONFLICT_DUPLICATE,
  CONFLICT_NONE,
  CONFLICT_UPDATE,
  collectConflicts,
  countBySection,
  detectConflict,
  nextId,
} from "../lib/detect.js";
import { contentHashOf } from "../lib/hash.js";

/** 构造一条条目。 */
function entry({ id, topic, content, pending = false, conflictWith = null, section = "约定" }) {
  return {
    id,
    topic,
    content,
    pending,
    conflictWith,
    section,
    hash: contentHashOf(topic, content),
    lineIndex: 0,
  };
}

test("同 topic 不存在时是 none", () => {
  const entries = [entry({ id: "m001", topic: "a", content: "甲" })];
  const verdict = detectConflict(entries, { topic: "b", hash: "x", mode: "new" });
  assert.equal(verdict.kind, CONFLICT_NONE);
  assert.deepEqual(verdict.with, []);
});

test("内容完全相同是 duplicate（去重）", () => {
  const entries = [entry({ id: "m001", topic: "a", content: "甲" })];
  const hash = contentHashOf("a", "甲");
  const verdict = detectConflict(entries, { topic: "a", hash, mode: "new" });
  assert.equal(verdict.kind, CONFLICT_DUPLICATE);
  assert.deepEqual(verdict.with, ["m001"]);
});

test("mode=update 时替换旧条目", () => {
  const entries = [entry({ id: "m001", topic: "a", content: "甲" })];
  const hash = contentHashOf("a", "乙");
  const verdict = detectConflict(entries, { topic: "a", hash, mode: "update" });
  assert.equal(verdict.kind, CONFLICT_UPDATE);
  assert.deepEqual(verdict.with, ["m001"]);
});

test("mode=append 时不视为冲突（旧条目仍然成立）", () => {
  const entries = [entry({ id: "m001", topic: "a", content: "甲" })];
  const hash = contentHashOf("a", "补充");
  const verdict = detectConflict(entries, { topic: "a", hash, mode: "append" });
  assert.equal(verdict.kind, CONFLICT_NONE);
});

test("mode=new 且同 topic 内容不同 → 冻结为冲突", () => {
  const entries = [entry({ id: "m001", topic: "package-manager", content: "用 npm" })];
  const hash = contentHashOf("package-manager", "用 pnpm");
  const verdict = detectConflict(entries, { topic: "package-manager", hash, mode: "new" });
  assert.equal(verdict.kind, CONFLICT_CONFLICT);
  assert.deepEqual(verdict.with, ["m001"]);
});

test("冲突时列出全部同 topic 的活跃条目", () => {
  const entries = [
    entry({ id: "m001", topic: "a", content: "甲" }),
    entry({ id: "m002", topic: "a", content: "乙" }),
    entry({ id: "m003", topic: "b", content: "丙" }),
  ];
  const verdict = detectConflict(entries, { topic: "a", hash: "zzz", mode: "new" });
  assert.equal(verdict.kind, CONFLICT_CONFLICT);
  assert.deepEqual(verdict.with.sort(), ["m001", "m002"]);
});

test("已待裁决的条目不作为冲突源（避免滚雪球）", () => {
  const entries = [entry({ id: "m001", topic: "a", content: "甲", pending: true })];
  const verdict = detectConflict(entries, { topic: "a", hash: "zzz", mode: "new" });
  assert.equal(verdict.kind, CONFLICT_NONE);
});

test("没有 id 的裸条目不参与判定", () => {
  const entries = [entry({ id: null, topic: "a", content: "甲" })];
  const verdict = detectConflict(entries, { topic: "a", hash: "zzz", mode: "new" });
  assert.equal(verdict.kind, CONFLICT_NONE);
});

test("nextId 取最大编号 +1，不受删除影响", () => {
  assert.equal(nextId([]), "m001");
  assert.equal(nextId([entry({ id: "m001", topic: "a", content: "x" })]), "m002");
  assert.equal(
    nextId([
      entry({ id: "m001", topic: "a", content: "x" }),
      entry({ id: "m042", topic: "a", content: "y" }),
    ]),
    "m043",
  );
  // 乱格式的 id 被忽略。
  assert.equal(nextId([entry({ id: "weird", topic: "a", content: "x" })]), "m001");
});

test("collectConflicts 按待裁决条目分组，并带出冲突对象", () => {
  const entries = [
    entry({ id: "m001", topic: "pkg", content: "用 npm" }),
    entry({
      id: "m002",
      topic: "pkg",
      content: "用 pnpm",
      pending: true,
      conflictWith: "m001",
    }),
  ];
  const groups = collectConflicts(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].topic, "pkg");
  assert.equal(groups[0].pending.id, "m002");
  assert.equal(groups[0].others.length, 1);
  assert.equal(groups[0].others[0].id, "m001");
});

test("collectConflicts 对悬空引用容错", () => {
  const entries = [
    entry({ id: "m002", topic: "pkg", content: "用 pnpm", pending: true, conflictWith: "m999" }),
  ];
  const groups = collectConflicts(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].others, []);
});

test("countBySection 统计各段条数", () => {
  const entries = [
    entry({ id: "m001", topic: "a", content: "x", section: "约定" }),
    entry({ id: "m002", topic: "b", content: "y", section: "约定" }),
    entry({ id: "m003", topic: "c", content: "z", section: "坑" }),
  ];
  assert.deepEqual(countBySection(entries), { 约定: 2, 坑: 1 });
});
