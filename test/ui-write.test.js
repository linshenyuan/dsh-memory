/**
 * 面板自由编辑（lib/ui/write.js）的单元测试。
 *
 * 这一层和 lib/ui/resolve.js 一样，是「浏览器」和「磁盘」之间唯一的写入口，
 * 所以除了功能，还要钉住：
 *
 * 1. **定位语义**：优先 id，回退 topic（首个匹配）。
 * 2. **写盘是行级编辑**：不重写整文件，用户手写的说明/段标题/注释原样保留。
 * 3. **审计来源是 user**：面板改的记忆和模型写的（memory_save）在流水里能区分开。
 * 4. **预算拒绝不写盘**：超限在写盘之前就返回，文件保持原状。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { readText, writeAtomic } from "../lib/store.js";
import { EDIT_ACTIONS, editMemory } from "../lib/ui/write.js";

let root = "";
let cfg = null;

/** 记忆目录（绝对路径，避开 $DSH_HOME）。 */
function memoryDir() {
  return join(root, "memory");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-ui-write-"));
  cfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一份带两条普通条目的 MEMORY.md（无待裁决、无段标题）。 */
async function seedPlain() {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    [
      "- 缩进用 2 个空格 <!-- id:m001 topic:indent at:2026-10-01 -->",
      "- 用 pnpm <!-- id:m002 topic:package-manager at:2026-10-02 -->",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 造一次调用（readText / writeText 固定用真实文件 IO）。 */
function call(payload) {
  return editMemory({ cfg, cwd: root, readText, writeText: writeAtomic, ...payload });
}

test("编辑动作集合冻结为 add / update / delete", () => {
  assert.deepEqual([...EDIT_ACTIONS], ["add", "update", "delete"]);
});

test("add：文件不存在也能新建并写盘", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  const result = await call({ scope: "project", action: "add", topic: "foo", content: "bar 内容" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "add");
  assert.equal(typeof result.id, "string");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("bar 内容"), true);
  assert.equal(text.includes("id:"), true);
});

test("add：带上工作空间后写进 area 元数据，审计也记录 area", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  const result = await call({ scope: "project", action: "add", topic: "foo", content: "bar", area: "backend" });
  assert.equal(result.ok, true);
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(/area:backend/.test(text), true);
  const runs = await readText(join(memoryDir(), "runs.jsonl"));
  assert.equal(runs.includes('"area":"backend"'), true);
});

test("add：工作空间为空时不在元数据里写 area", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  await call({ scope: "project", action: "add", topic: "foo", content: "bar", area: "   " });
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(/area:/.test(text), false);
});

test("add：topic 或正文为空时拒绝，不碰盘", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  for (const payload of [
    { scope: "project", action: "add", topic: "", content: "x" },
    { scope: "project", action: "add", topic: "x", content: "   " },
  ]) {
    const result = await call(payload);
    assert.equal(result.ok, false);
    assert.equal(await readText(join(memoryDir(), "MEMORY.md")), null, "不该创建文件");
  }
});

test("update：按 id 改正文，原正文被替换", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "update", id: "m001", content: "改过的正文" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "m001");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("改过的正文"), true);
  assert.equal(text.includes("缩进用 2 个空格"), false);
});

test("update：没给 id 时按 topic 定位第一条", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "update", topic: "package-manager", content: "用 yarn" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "m002");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("用 yarn"), true);
});

test("update：改分类会把条目移到新段，而不是留在原位", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "update", id: "m001", content: "x", section: "约定" });
  assert.equal(result.ok, true);
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("## 约定"), true);
  assert.equal(text.includes("id:m001"), true);
});

test("update：改工作空间只改 area 元数据，不动条目所在行", async () => {
  await seedPlain();
  const before = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  const result = await call({ scope: "project", action: "update", id: "m001", content: "缩进用 2 个空格", area: "frontend" });
  assert.equal(result.ok, true);
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(/area:frontend/.test(text), true);
  // 行没被移动（id 仍在原位，section 没变）。
  assert.equal(text.indexOf("id:m001"), before.indexOf("id:m001"), "改工作空间不该移动条目行");
});

test("delete：按 id 删一条，其余保留", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "delete", id: "m001" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "m001");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("id:m001"), false);
  assert.equal(text.includes("id:m002"), true);
});

test("delete：没给 id 时按 topic 定位第一条", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "delete", topic: "package-manager" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "m002");
});

test("update / delete：文件不存在或定位不到时如实返回失败", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  assert.equal((await call({ scope: "project", action: "update", id: "m001", content: "x" })).ok, false);
  assert.equal((await call({ scope: "project", action: "delete", id: "m001" })).ok, false);

  await seedPlain();
  assert.equal((await call({ scope: "project", action: "delete", id: "nope" })).ok, false);
  assert.equal((await call({ scope: "project", action: "update", topic: "不存在", content: "x" })).ok, false);
});

test("未知动作：返回失败而不是炸", async () => {
  await seedPlain();
  const result = await call({ scope: "project", action: "frobnicate" });
  assert.equal(result.ok, false);
});

test("所有写操作都记审计，且 by 为 user", async () => {
  await seedPlain();
  await call({ scope: "project", action: "add", topic: "a", content: "b" });
  await call({ scope: "project", action: "update", id: "m001", content: "c" });
  await call({ scope: "project", action: "delete", id: "m002" });

  const runs = await readText(join(memoryDir(), "runs.jsonl"));
  assert.notEqual(runs, null);
  assert.equal(runs.includes('"by":"user"'), true);
  assert.equal(runs.includes('"op":"save"'), true);
  assert.equal(runs.includes('"op":"update"'), true);
  assert.equal(runs.includes('"op":"delete"'), true);
});

test("add：超过预算明确拒绝且文件不被创建", async () => {
  const smallCfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
    projectMaxBytes: 50,
  });
  await rm(memoryDir(), { recursive: true, force: true });
  const result = await editMemory({
    cfg: smallCfg,
    cwd: root,
    scope: "project",
    action: "add",
    topic: "x",
    content: "y",
    readText,
    writeText: writeAtomic,
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, "rejected");
  assert.equal(await readText(join(memoryDir(), "MEMORY.md")), null, "预算拒绝不该写盘");
});
