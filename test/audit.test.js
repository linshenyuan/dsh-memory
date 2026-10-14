import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendRun, clearRun, OPS, readRuns, replay, verifyReplay } from "../lib/audit.js";

test("appendRun / readRuns 往返", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  try {
    const path = join(dir, "runs.jsonl");
    await appendRun(path, { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" });
    await appendRun(path, { at: "2026-10-12T00:01:00Z", op: "dedupe", id: "m001", topic: "a" });

    const runs = await readRuns(path);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].op, "save");
    assert.equal(runs[1].op, "dedupe");

    // limit 取最新的若干条。
    const tail = await readRuns(path, 1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].op, "dedupe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRuns 对不存在的文件返回空数组", async () => {
  assert.deepEqual(await readRuns(join(tmpdir(), "definitely-missing-xyz", "runs.jsonl")), []);
});

test("readRuns 跳过损坏的行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  try {
    const path = join(dir, "runs.jsonl");
    await writeFile(
      path,
      ['{"op":"save","id":"m001"}', "这不是 JSON", "", '{"op":"archive","id":"m001"}'].join("\n"),
      "utf8",
    );
    const runs = await readRuns(path);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].op, "save");
    assert.equal(runs[1].op, "archive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay 重建 save / conflict / resolve / archive", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a", hash: "h1" },
    { at: "2026-10-12T00:01:00Z", op: "save", id: "m002", topic: "b", hash: "h2" },
    { at: "2026-10-12T00:02:00Z", op: "conflict", id: "m003", topic: "a", hash: "h3", with: "m001" },
    { at: "2026-10-12T00:03:00Z", op: "archive", id: "m002" },
    { at: "2026-10-12T00:04:00Z", op: "resolve", keep: "m003", drop: "m001" },
  ];

  const state = replay(runs);
  assert.equal(state.get("m001"), undefined); // 被 drop 掉了
  assert.equal(state.get("m002").status, "archived");
  assert.equal(state.get("m003").status, "active"); // 从 pending 变 active
});

test("replay 的 upto 只回放该时刻之前", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-12T01:00:00Z", op: "save", id: "m002", topic: "b" },
  ];
  assert.deepEqual([...replay(runs, { upto: "2026-10-12T00:30:00Z" }).keys()], ["m001"]);
  assert.equal(replay(runs).size, 2);
});

test("replay 忽略 dedupe / reject（没落库）", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "dedupe", id: "m001", topic: "a" },
    { at: "2026-10-12T00:01:00Z", op: "reject", reason: "blank" },
  ];
  assert.equal(replay(runs).size, 0);
});

test("replay 遇到未知 op 不抛错（向前兼容）", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-12T00:01:00Z", op: "future-op-we-dont-know", id: "m002" },
  ];
  const state = replay(runs);
  assert.equal(state.size, 1);
  assert.equal(state.has("m001"), true);
});

test("replay 对非数组容错", () => {
  assert.equal(replay(null).size, 0);
  assert.equal(replay(undefined).size, 0);
});

test("clearRun 删掉目标行 + 追加 clear 标记，文件净增 0 行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  try {
    const path = join(dir, "runs.jsonl");
    await appendRun(path, { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" });
    await appendRun(path, { at: "2026-10-12T00:01:00Z", op: "dedupe", id: "m001", topic: "a" });

    const removed = await clearRun(path, { at: "2026-10-12T00:00:00Z", op: "save", id: "m001" });
    assert.equal(removed, true);

    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 2, "原 2 行 → 删 1 + 加 1 clear 标记 = 仍 2 行（不膨胀）");
    assert.equal(JSON.parse(lines[0]).op, "dedupe", "原 save 行被删");
    const marker = JSON.parse(lines[1]);
    assert.equal(marker.op, "clear");
    assert.equal(marker.id, "m001");
    assert.equal(marker.origOp, "save");
    assert.equal(marker.by, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearRun 目标不存在时仍写 clear 标记", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  try {
    const path = join(dir, "runs.jsonl");
    await appendRun(path, { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" });
    const removed = await clearRun(path, { at: "2099-01-01T00:00:00Z", id: "m001" });
    assert.equal(removed, false, "没找到目标行返回 false");
    const runs = await readRuns(path);
    assert.equal(runs.at(-1).op, "clear", "但仍追加了 clear 标记");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearRun 坏行原样保留，不会被误删", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  try {
    const path = join(dir, "runs.jsonl");
    await writeFile(path, ['{"at":"2026-10-12T00:00:00Z","op":"save","id":"m001"}', "坏行", ""].join("\n"), "utf8");
    await clearRun(path, { at: "2026-10-12T00:00:00Z", id: "m001" });
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 2, "坏行保留 + clear 标记");
    assert.equal(lines[0], "坏行");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyReplay 一致时 ok", () => {
  const runs = [{ at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" }];
  const entries = [{ id: "m001", pending: false }];
  assert.deepEqual(verifyReplay(runs, entries), { ok: true, missing: [], orphan: [] });
});

test("verifyReplay 报出文件里有但流水里没有的（手工加的）", () => {
  const runs = [{ at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" }];
  const entries = [{ id: "m001", pending: false }, { id: "m999", pending: false }];
  const result = verifyReplay(runs, entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["m999"]);
  assert.deepEqual(result.orphan, []);
});

test("verifyReplay 报出流水里有但文件里没有的", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-12T00:01:00Z", op: "save", id: "m002", topic: "b" },
  ];
  const entries = [{ id: "m001", pending: false }];
  const result = verifyReplay(runs, entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphan, ["m002"]);
});

test("verifyReplay：clear 标记（origOp=save）压掉被清记录的 missing，自检仍一致", () => {
  // 用户从面板清掉了 m001 的 save 行 —— 重放后 m001 不在 state 里，但记忆还在文件里，
  // 本该报 missing；有了 clear 标记就不报，自检仍一致。
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-13T00:00:00Z", op: "clear", id: "m001", origOp: "save", by: "user" },
  ];
  const entries = [{ id: "m001", pending: false }];
  const result = verifyReplay(runs, entries);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.orphan, []);
});

test("verifyReplay：clear 标记（origOp=delete）压掉 orphan", () => {
  // 流水 save m001 → delete m001；清掉 delete 行后重放又变 m001 active，但文件里没
  // m001 —— 本该报 orphan；有 clear(origOp=delete) 标记就不报。
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-12T00:01:00Z", op: "delete", id: "m001" },
    { at: "2026-10-13T00:00:00Z", op: "clear", id: "m001", origOp: "delete", by: "user" },
  ];
  const entries = [];
  const result = verifyReplay(runs, entries);
  assert.equal(result.ok, true);
  assert.deepEqual(result.orphan, []);
});

test("verifyReplay：clear 标记只压自己的 id，不误伤别的 missing", () => {
  const runs = [
    { at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "a" },
    { at: "2026-10-12T00:01:00Z", op: "save", id: "m002", topic: "b" },
    { at: "2026-10-13T00:00:00Z", op: "clear", id: "m001", origOp: "save", by: "user" },
  ];
  // 文件里 m001 / m002 / m999 都在；m999 是手工加的（无 clear 标记）应照常报 missing。
  const entries = [
    { id: "m001", pending: false },
    { id: "m002", pending: false },
    { id: "m999", pending: false },
  ];
  const result = verifyReplay(runs, entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["m999"]);
  assert.deepEqual(result.orphan, []);
});

test("OPS 覆盖代码里用到的全部操作", () => {
  assert.deepEqual([...OPS].sort(), [
    "archive",
    "clear",
    "conflict",
    "dedupe",
    "delete",
    "reject",
    "resolve",
    "save",
    "update",
  ]);
});
