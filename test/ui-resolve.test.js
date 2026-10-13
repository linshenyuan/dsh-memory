/**
 * 冲突裁决写回的测试。
 *
 * 这是整个插件里**唯一一个用户直接触发的写盘动作**，所以测试要盯的不是「函数
 * 返回了 ok」，而是四条硬约束：
 *
 * 1. **只改该改的行。** 用户在 MEMORY.md 里写的前言、自定义段标题、注释必须
 *    原样保留 —— 整文件重写会把这些全抹掉。
 * 2. **A / B 的定义与 lib/ui/data.js 一致。** 面板显示「保留 A」，落盘就必须
 *    是保留 A 那条；两边排序判据一旦不同，用户会看到「我点了保留 A，结果 B 被
 *    留下了」。
 * 3. **`later` 不落任何痕迹。** 不写盘、不写审计、不动 CONFLICTS.md。
 * 4. **审计记录能被 replay 读懂。** 字段名写错不会报错，只会让启动自检从此
 *    把「已删掉的条目」当成还在 —— 静默的噪音。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { replay } from "../lib/audit.js";
import { resolveConfig } from "../lib/config.js";
import { readText, writeAtomic } from "../lib/store.js";
import { ACTIONS, resolveConflict } from "../lib/ui/resolve.js";

let root = "";
let cfg = null;

/** 记忆目录（绝对路径，避开 $DSH_HOME）。 */
function memoryDir() {
  return join(root, "memory");
}

/** MEMORY.md 的路径。 */
function memoryFile() {
  return join(memoryDir(), "MEMORY.md");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-ui-resolve-"));
  cfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * 写一份带冲突的 MEMORY.md。
 *
 * 特意带上「前言 + 自定义段标题 + 段间说明」，用来验证裁决不会整文件重写。
 *
 * @returns {Promise<string>} 写进去的原文。
 */
async function seed() {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  const text = [
    "# 项目记忆",
    "",
    "<!-- 这段前言是手写的，裁决不该动它 -->",
    "",
    "## 代码风格",
    "",
    "- 缩进用 2 个空格 <!-- id:m001 topic:indent at:2026-10-01 -->",
    "- [待裁决] 缩进用 4 个空格 <!-- id:m002 topic:indent at:2026-10-05 conflict-with:m001 -->",
    "",
    "## 环境",
    "",
    "- Node 用 v22 <!-- id:m003 topic:node at:2026-10-02 -->",
    "",
  ].join("\n");
  await writeFile(memoryFile(), text, "utf8");
  return text;
}

/** 跑一次裁决。 */
function decide(action, topic = "indent") {
  return resolveConflict({
    cfg,
    cwd: root,
    scope: "project",
    topic,
    action,
    readText,
    writeText: writeAtomic,
    now: "2026-10-13T00:00:00.000Z",
  });
}

/** 读回文件内容。 */
function readBack() {
  return readFile(memoryFile(), "utf8");
}

/** 读审计流水（按行解析）。 */
async function readRuns() {
  const text = await readFile(join(memoryDir(), "runs.jsonl"), "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("四个动作是固定的那四个，顺序也固定（面板按钮按它渲染）", () => {
  assert.deepEqual([...ACTIONS], ["keep-a", "keep-b", "keep-both", "later"]);
});

test("keep-a：留下 A（较早那条），删掉 B，并去掉两个待裁决标记", async () => {
  await seed();
  const result = await decide("keep-a");
  assert.equal(result.ok, true);
  assert.deepEqual(result.kept, ["m001"]);
  assert.deepEqual(result.dropped, ["m002"]);

  const text = await readBack();
  assert.equal(text.includes("缩进用 2 个空格"), true);
  assert.equal(text.includes("缩进用 4 个空格"), false);
  assert.equal(text.includes("[待裁决]"), false);
  assert.equal(text.includes("conflict-with"), false);
  // 保留的那条仍然是合法条目（id/topic/at 都在）。
  assert.match(text, /id:m001 topic:indent at:2026-10-01/);
});

test("keep-b：留下 B（较新那条），删掉 A", async () => {
  await seed();
  const result = await decide("keep-b");
  assert.equal(result.ok, true);
  assert.deepEqual(result.kept, ["m002"]);
  assert.deepEqual(result.dropped, ["m001"]);

  const text = await readBack();
  assert.equal(text.includes("缩进用 4 个空格"), true);
  assert.equal(text.includes("缩进用 2 个空格"), false);
  assert.equal(text.includes("[待裁决]"), false);
  // 被留下的那条升级成普通条目：id 保留，标记清掉。
  assert.match(text, /id:m002 topic:indent at:2026-10-05/);
});

test("keep-both：两条都留，只把标记去掉", async () => {
  await seed();
  const result = await decide("keep-both");
  assert.equal(result.ok, true);
  assert.deepEqual(result.kept, ["m001", "m002"]);
  assert.deepEqual(result.dropped, []);

  const text = await readBack();
  assert.equal(text.includes("缩进用 2 个空格"), true);
  assert.equal(text.includes("缩进用 4 个空格"), true);
  assert.equal(text.includes("[待裁决]"), false);
  assert.equal(text.includes("conflict-with"), false);
  assert.equal(result.message.includes("已确认保留 2 条"), true);
});

test("later：一个字节都不写 —— 文件、审计、CONFLICTS.md 全部不动", async () => {
  await seed();
  const before = await readBack();
  const result = await decide("later");
  assert.equal(result.ok, true);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.dropped, []);

  assert.equal(await readBack(), before);
  await assert.rejects(() => stat(join(memoryDir(), "runs.jsonl")), "稍后不该留下审计记录");
});

test("裁决不整文件重写：手写前言、段标题、其它条目原样保留", async () => {
  await seed();
  await decide("keep-a");
  const text = await readBack();
  assert.equal(text.includes("# 项目记忆"), true);
  assert.equal(text.includes("<!-- 这段前言是手写的，裁决不该动它 -->"), true);
  assert.equal(text.includes("## 代码风格"), true);
  assert.equal(text.includes("## 环境"), true);
  assert.equal(text.includes("- Node 用 v22 <!-- id:m003 topic:node at:2026-10-02 -->"), true);
});

test("裁完最后一个冲突后，CONFLICTS.md 被清掉（不再留一个空文件）", async () => {
  await seed();
  // 先造一份 CONFLICTS.md 模拟「之前有冲突」的状态。
  await writeFile(join(memoryDir(), "CONFLICTS.md"), "# 待裁决\n", "utf8");
  await decide("keep-a");
  await assert.rejects(() => stat(join(memoryDir(), "CONFLICTS.md")));
});

test("审计记录能被 replay 读懂：保留的转 active、放弃的被删掉", async () => {
  await seed();
  // 先补一条 conflict 记录，模拟「写进来时就被冻结」的完整历史。
  await writeFile(
    join(memoryDir(), "runs.jsonl"),
    [
      JSON.stringify({ at: "2026-10-01T00:00:00.000Z", op: "save", id: "m001", topic: "indent" }),
      JSON.stringify({ at: "2026-10-02T00:00:00.000Z", op: "save", id: "m003", topic: "node" }),
      JSON.stringify({ at: "2026-10-05T00:00:00.000Z", op: "conflict", id: "m002", topic: "indent" }),
    ].join("\n") + "\n",
    "utf8",
  );

  await decide("keep-a");
  const runs = await readRuns();
  const record = runs[runs.length - 1];
  assert.equal(record.op, "resolve");
  assert.equal(record.action, "keep-a");
  assert.equal(record.by, "user");
  // 字段名必须是 replay 读的那两个（逗号分隔字符串），不是数组。
  assert.equal(record.keep, "m001");
  assert.equal(record.drop, "m002");

  const state = replay(runs);
  assert.equal(state.has("m001"), true);
  assert.equal(state.get("m001").status, "active");
  assert.equal(state.has("m002"), false, "被放弃的条目必须在重放里消失");
  assert.equal(state.get("m003").status, "active");
});

test("只有一条时 A 和 B 是同一条：三个「保留」动作等价，都只是去标记", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    memoryFile(),
    "- [待裁决] 孤立的一条 <!-- id:m001 topic:solo at:2026-10-01 -->\n",
    "utf8",
  );
  for (const action of ["keep-a", "keep-b", "keep-both"]) {
    await writeFile(
      memoryFile(),
      "- [待裁决] 孤立的一条 <!-- id:m001 topic:solo at:2026-10-01 -->\n",
      "utf8",
    );
    const result = await decide(action, "solo");
    assert.equal(result.ok, true, `${action} 应当成功`);
    assert.deepEqual(result.kept, ["m001"], `${action} 不该删掉唯一那条`);
    assert.deepEqual(result.dropped, []);
    const text = await readBack();
    assert.equal(text.includes("[待裁决]"), false);
    assert.match(text, /id:m001 topic:solo/);
  }
});

test("没有 id 的条目一律保留 —— 定位不到的东西不许删", async () => {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    memoryFile(),
    [
      "- 没有元数据的旧条目 <!-- id:m001 topic:x at:2026-10-01 -->",
      "- [待裁决] 模型忘了写 id <!-- topic:x conflict-with:m001 -->",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = await decide("keep-a", "x");
  assert.equal(result.ok, true);
  const text = await readBack();
  assert.equal(text.includes("模型忘了写 id"), true, "没有 id 的条目不能被删");
});

test("未知动作、缺 topic、找不到 topic、文件不存在：都是 ok:false 而不是抛错", async () => {
  await seed();
  const bad = await decide("keep-z");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /未知的裁决动作/);

  const noTopic = await resolveConflict({
    cfg,
    cwd: root,
    scope: "project",
    topic: "   ",
    action: "keep-a",
    readText,
    writeText: writeAtomic,
  });
  assert.equal(noTopic.ok, false);
  assert.match(noTopic.message, /缺少 topic/);

  const gone = await decide("keep-a", "根本没有这个 topic");
  assert.equal(gone.ok, false);
  assert.match(gone.message, /已经没有待裁决的条目/);

  await rm(memoryDir(), { recursive: true, force: true });
  const missing = await decide("keep-a");
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不存在或为空/);
});

test("写盘失败时如实报错，不谎报成功", async () => {
  await seed();
  const result = await resolveConflict({
    cfg,
    cwd: root,
    scope: "project",
    topic: "indent",
    action: "keep-a",
    readText,
    writeText: async () => {
      throw new Error("EPERM: 文件被占用");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /写入/);
});

test("user 作用域走的是用户级落点，不会误改项目级文件", async () => {
  await seed();
  await mkdir(join(root, "user-memory"), { recursive: true });
  await writeFile(
    join(root, "user-memory", "MEMORY.md"),
    [
      "- 缩进用 2 空格（用户级） <!-- id:m001 topic:indent at:2026-10-01 -->",
      "- [待裁决] 缩进用 4 空格（用户级） <!-- id:m002 topic:indent at:2026-10-05 conflict-with:m001 -->",
      "",
    ].join("\n"),
    "utf8",
  );
  const projectBefore = await readBack();
  const result = await resolveConflict({
    cfg,
    cwd: root,
    scope: "user",
    topic: "indent",
    action: "keep-b",
    readText,
    writeText: writeAtomic,
    now: "2026-10-13T00:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(await readBack(), projectBefore, "项目级文件不该被动过");

  const userText = await readFile(join(root, "user-memory", "MEMORY.md"), "utf8");
  assert.equal(userText.includes("缩进用 4 空格（用户级）"), true);
  assert.equal(userText.includes("缩进用 2 空格（用户级）"), false);
  assert.equal(userText.includes("[待裁决]"), false);
});
