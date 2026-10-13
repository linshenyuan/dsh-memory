/**
 * 面板数据聚合层的测试。
 *
 * 这一层是「面板上看到的东西」和「磁盘上的文件」之间唯一的翻译。所以测试的重点
 * 不是「字段有没有」，而是**四件事必须一致**：
 *
 * 1. 一次聚合里各视图说的是同一时刻的状态（不是分四次读出来的）。
 * 2. A / B 的定义与 lib/ui/resolve.js 的排序一致 —— 否则面板显示「保留 A」，
 *    实际删掉的却是 A 那条。
 * 3. 读不到 / 解析不了时是「标记错误」而不是「整个面板空白」。
 * 4. 只读：聚合过程一个字节都不写。
 *
 * 用真临时目录 + 真 fs，不 mock —— 路径解析、runs.jsonl 的读取都是这条链路的
 * 组成部分，mock 掉就等于不测。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { readText } from "../lib/store.js";
import { collectPanelData, collectScope, replayEntries } from "../lib/ui/data.js";

let root = "";
let cfg = null;

/** 记忆目录（绝对路径，避开 $DSH_HOME）。 */
function memoryDir() {
  return join(root, "memory");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-ui-data-"));
  cfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 造一份 MEMORY.md：两条正常条目 + 一组待裁决冲突。 */
function fixture() {
  return [
    "# 记忆",
    "",
    "## 偏好",
    "",
    "- 缩进用 2 个空格 <!-- id:m001 topic:indent at:2026-10-01 -->",
    "- [待裁决] 缩进用 4 个空格 <!-- id:m002 topic:indent at:2026-10-05 conflict-with:m001 -->",
    "",
    "## 环境",
    "",
    "- Node 用 v22 <!-- id:m003 topic:node at:2026-10-02 -->",
    "",
  ].join("\n");
}

/** 清空记忆目录。 */
async function clean() {
  await rm(memoryDir(), { recursive: true, force: true });
}

test("没有文件时：exists=false、不是错误、四组字段都是空壳", async () => {
  await clean();
  const scope = await collectScope(root, "project", cfg, readText);
  assert.equal(scope.exists, false);
  assert.equal(scope.error, null);
  assert.equal(scope.entryCount, 0);
  assert.equal(scope.bytes, 0);
  assert.deepEqual(scope.entries, []);
  assert.deepEqual(scope.conflicts, []);
  assert.deepEqual(scope.runs, []);
  assert.ok(scope.maxBytes > 0, "上限要带上，否则用量视图画不出比例");
  assert.ok(scope.displayPath.length > 0);
});

test("正常文件：条数、字节、分类分布、冲突分组都对", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");

  const scope = await collectScope(root, "project", cfg, readText);
  assert.equal(scope.exists, true);
  assert.equal(scope.error, null);
  assert.equal(scope.entryCount, 3);
  assert.equal(scope.bytes, Buffer.byteLength(fixture(), "utf8"));
  assert.deepEqual(scope.sections, { 偏好: 2, 环境: 1 });
  assert.equal(scope.conflicts.length, 1);
});

test("冲突的 A / B 按日期定：A 是最早那条、B 是最新那条", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");

  const scope = await collectScope(root, "project", cfg, readText);
  const group = scope.conflicts[0];
  assert.equal(group.topic, "indent");
  assert.equal(group.count, 2);
  assert.equal(group.a.id, "m001", "A 必须是 2026-10-01 那条（较早的）");
  assert.equal(group.b.id, "m002", "B 必须是 2026-10-05 那条（较新的）");
  assert.equal(group.b.pending, true);
  assert.deepEqual(group.others, []);
});

test("缺日期的条目排最后（当「新」处理，避免误删已有的那条）", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    [
      "- 旧规矩 <!-- id:m001 topic:x at:2026-09-01 -->",
      "- [待裁决] 新规矩 <!-- id:m002 topic:x conflict-with:m001 -->",
      "",
    ].join("\n"),
    "utf8",
  );
  const scope = await collectScope(root, "project", cfg, readText);
  const group = scope.conflicts[0];
  assert.equal(group.a.id, "m001");
  assert.equal(group.b.id, "m002");
});

test("读取抛错：错误被记在 scope 上，不往上抛（面板不能整个空白）", async () => {
  const boom = async () => {
    throw new Error("EACCES: 权限不够");
  };
  const scope = await collectScope(root, "project", cfg, boom);
  assert.equal(scope.error !== null, true);
  assert.match(scope.error, /读取失败/);
  assert.equal(scope.entries.length, 0);
});

test("两个作用域各自独立：项目炸了不影响用户级", async () => {
  await clean();
  const seen = [];
  const flaky = async (path) => {
    seen.push(path);
    if (path.includes("memory") && !path.includes("user-memory")) {
      throw new Error("boom");
    }
    return null;
  };
  const data = await collectPanelData({ cwd: root, cfg, readText: flaky });
  assert.equal(data.scopes.length, 2);
  assert.equal(data.scopes[0].scope, "project");
  assert.equal(data.scopes[0].error !== null, true);
  assert.equal(data.scopes[1].scope, "user");
  assert.equal(data.scopes[1].error, null, "用户级不该被项目级的故障带崩");
  assert.ok(seen.length >= 2, "两个作用域都要被读过");
});

test("聚合结果带 cwd 与 generatedAt，四个视图共用一份", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");

  const data = await collectPanelData({ cwd: root, cfg, readText });
  assert.equal(data.cwd, root);
  assert.equal(typeof data.generatedAt, "string");
  assert.equal(Number.isNaN(Date.parse(data.generatedAt)), false);
  assert.equal(data.totals.entries, 3);
  assert.equal(data.totals.conflicts, 1);
  assert.equal(data.totals.pending, 1);
  assert.equal(data.totals.bytes, Buffer.byteLength(fixture(), "utf8"));
});

test("审计流水：读出来、映射成面板字段、并能重放", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");
  await writeFile(
    join(memoryDir(), "runs.jsonl"),
    [
      JSON.stringify({ at: "2026-10-01T00:00:00.000Z", op: "save", id: "m001", topic: "indent", by: "model", scope: "project" }),
      JSON.stringify({ at: "2026-10-02T00:00:00.000Z", op: "save", id: "m003", topic: "node", by: "model", scope: "project" }),
      "{ 这行是坏的，应当被跳过",
      JSON.stringify({ at: "2026-10-05T00:00:00.000Z", op: "conflict", id: "m002", topic: "indent", by: "model", scope: "project" }),
    ].join("\n"),
    "utf8",
  );

  const scope = await collectScope(root, "project", cfg, readText);
  assert.equal(scope.runCount, 3, "坏行要跳过，好行要留下");
  assert.equal(scope.runs[0].op, "save");
  assert.equal(scope.runs[2].op, "conflict");
  // 流水正好覆盖了文件里的三条（m002 是 conflict → pending），所以自检应当通过。
  assert.equal(scope.replay.ok, true);
  assert.deepEqual(scope.replay.missing, []);
  assert.deepEqual(scope.replay.orphan, []);

  const replayed = replayEntries([
    { at: "2026-10-01T00:00:00.000Z", op: "save", id: "m001", topic: "indent" },
  ]);
  assert.deepEqual(replayed, [{ id: "m001", topic: "indent", status: "active" }]);

  // 手工往文件里加一条（流水里没有）→ 自检要如实报 missing，而不是假装通过。
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    `${fixture()}- 手写的一条 <!-- id:m099 topic:hand at:2026-10-06 -->\n`,
    "utf8",
  );
  const after = await collectScope(root, "project", cfg, readText);
  assert.equal(after.replay.ok, false);
  assert.deepEqual(after.replay.missing, ["m099"]);
});

test("只读：聚合跑完磁盘上的文件一个字节都没变", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");
  const before1 = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  await collectPanelData({ cwd: root, cfg, readText });
  const after1 = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(after1, before1);
});

test("正文超长时被裁到展示上限，并留下省略号", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  const long = "很".repeat(3000);
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    `- ${long} <!-- id:m001 topic:long at:2026-10-01 -->\n`,
    "utf8",
  );
  const scope = await collectScope(root, "project", cfg, readText);
  assert.equal(scope.entries[0].content.length, 2001);
  assert.equal(scope.entries[0].content.endsWith("…"), true);
});

test("不把编辑期字段外传（lineIndex / indent / hash 不出现在面板数据里）", async () => {
  await clean();
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), "MEMORY.md"), fixture(), "utf8");
  const scope = await collectScope(root, "project", cfg, readText);
  for (const entry of scope.entries) {
    assert.equal(Object.hasOwn(entry, "lineIndex"), false);
    assert.equal(Object.hasOwn(entry, "indent"), false);
    assert.equal(Object.hasOwn(entry, "hash"), false);
    assert.equal(typeof entry.id, "string");
  }
});
