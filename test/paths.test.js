import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { displayPath, isMemoryPath, resolveDshHome, resolveMemoryPaths } from "../lib/paths.js";

const CWD = resolve("/tmp/ws");
const cfg = (overrides = {}) => resolveConfig({ projectMemoryDir: ".memory", ...overrides });

test("project 作用域落在工作区内", () => {
  const p = resolveMemoryPaths(CWD, "project", cfg());
  assert.equal(p.dir, join(CWD, ".memory"));
  assert.equal(p.file, join(CWD, ".memory", "MEMORY.md"));
  assert.equal(p.conflicts, join(CWD, ".memory", "CONFLICTS.md"));
  assert.equal(p.runs, join(CWD, ".memory", "runs.jsonl"));
  assert.equal(p.scope, "project");
  assert.equal(p.label, "项目");
  assert.equal(p.maxBytes, 10800);
});

test("user 作用域默认落在 $DSH_HOME/memory，不跟着工作区走", () => {
  const p = resolveMemoryPaths(CWD, "user", cfg());
  assert.equal(p.dir, join(resolveDshHome(), "memory"));
  assert.equal(p.scope, "user");
  assert.equal(p.label, "用户");
  // 关键：不在工作区里。
  assert.equal(p.dir.startsWith(CWD), false);
});

test("userMemoryDir 是绝对路径时直接用", () => {
  const p = resolveMemoryPaths(CWD, "user", cfg({ userMemoryDir: "D:/mem" }));
  assert.equal(p.dir, resolve("D:/mem"));
});

test("userMemoryDir 是相对路径时相对 $DSH_HOME，不是相对工作区", () => {
  const p = resolveMemoryPaths(CWD, "user", cfg({ userMemoryDir: ".user-memory" }));
  assert.equal(p.dir, join(resolveDshHome(), ".user-memory"));
  // 关键：绝不能跟着工作区跑 —— 否则换个项目打开就换了一份用户记忆。
  assert.equal(p.dir.startsWith(CWD), false);
});

test("DSH_HOME 环境变量优先于 ~/.dsh", () => {
  const original = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = resolve("/tmp/custom-dsh");
    assert.equal(resolveDshHome(), resolve("/tmp/custom-dsh"));
    // 空串视为没配。
    process.env.DSH_HOME = "   ";
    assert.equal(resolveDshHome(), join(homedir(), ".dsh"));
  } finally {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
  }
});

test("上限按作用域分开取", () => {
  const c = cfg({ projectMaxBytes: 100, userMaxBytes: 200 });
  assert.equal(resolveMemoryPaths(CWD, "project", c).maxBytes, 100);
  assert.equal(resolveMemoryPaths(CWD, "user", c).maxBytes, 200);
});

test("displayPath 工作区优先，其次 home，最后原样", () => {
  // 工作区内 → 相对路径（哪怕它同时也在 home 下）。
  assert.equal(displayPath(join(CWD, ".memory", "MEMORY.md"), CWD), ".memory/MEMORY.md");
  // home 下但不在工作区内 → `~`。
  assert.equal(displayPath(join(homedir(), ".dsh", "memory", "MEMORY.md")), "~/.dsh/memory/MEMORY.md");
  // 两者都不是 → 原样返回（正斜杠）。
  const outside = resolve("/opt/other/memory/MEMORY.md");
  assert.equal(displayPath(outside, CWD), outside.split(sep).join("/"));
});

test("工作区内的路径即使同时在 home 下也用相对路径（模型更容易理解从属关系）", () => {
  const nested = join(homedir(), "projects", "foo");
  assert.equal(
    displayPath(join(nested, ".dsh-memory", "MEMORY.md"), nested),
    ".dsh-memory/MEMORY.md",
  );
});

test("注入里的 path 是给人看的相对路径，不是绝对路径", () => {
  const p = resolveMemoryPaths(CWD, "project", cfg());
  assert.equal(p.displayPath, ".memory/MEMORY.md");
  assert.equal(p.displayPath.includes(sep), false);
});

test("isMemoryPath 认得记忆目录里的每一个文件", () => {
  const c = cfg();
  assert.equal(isMemoryPath(".memory/MEMORY.md", CWD, c), true);
  assert.equal(isMemoryPath(".memory/CONFLICTS.md", CWD, c), true);
  assert.equal(isMemoryPath(".memory/runs.jsonl", CWD, c), true);
  // 目录里的其它文件（比如手工放的日记）也算 —— 写它们不该触发「你该写记忆了」的提醒。
  assert.equal(isMemoryPath(".memory/2026-10-12.md", CWD, c), true);
  assert.equal(isMemoryPath(join(CWD, ".memory", "MEMORY.md"), CWD, c), true);
});

test("isMemoryPath 对工作区里的普通文件返回 false", () => {
  const c = cfg();
  assert.equal(isMemoryPath("src/index.js", CWD, c), false);
  assert.equal(isMemoryPath("MEMORY.md", CWD, c), false);
  assert.equal(isMemoryPath(".memory-other/MEMORY.md", CWD, c), false);
  assert.equal(isMemoryPath("", CWD, c), false);
  assert.equal(isMemoryPath(null, CWD, c), false);
  assert.equal(isMemoryPath(undefined, CWD, c), false);
});

test("isMemoryPath 也认得用户级记忆目录", () => {
  const c = cfg();
  assert.equal(isMemoryPath(join(resolveDshHome(), "memory", "MEMORY.md"), CWD, c), true);
});
