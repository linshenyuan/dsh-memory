import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendRun, OPS, readRuns, replay, verifyReplay } from "../lib/audit.js";

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

test("OPS 覆盖代码里用到的全部操作", () => {
  assert.deepEqual([...OPS].sort(), [
    "archive",
    "conflict",
    "dedupe",
    "delete",
    "reject",
    "resolve",
    "save",
    "update",
  ]);
});
