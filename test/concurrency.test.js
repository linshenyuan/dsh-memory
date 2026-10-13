/**
 * 并发写入的回归测试 —— lib/lock.js 那把锁要解决的正是这个。
 *
 * 记忆写入是「读 → 改 → 写」。没有串行化时，两个写入口各自读到同一版本、各自改，
 * 后写的把先写的整个覆盖掉：丢一条记忆，而**两次调用都返回成功**。这类 bug 不报错、
 * 不打日志，只能靠这种「同时写、断言两条都在」的测试钉住。
 *
 * 这里刻意用真实文件 IO（真实 readText / writeAtomic），因为丢更新只在 await 处
 * 交错时才发生 —— mock 掉 IO 反而测不出来。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { parseMemory } from "../lib/parse.js";
import { saveMemory } from "../lib/save.js";
import { readText, writeAtomic } from "../lib/store.js";
import { editMemory } from "../lib/ui/write.js";

let root = "";
let cfg = null;

/** 项目记忆目录（绝对路径，避开 $DSH_HOME）。 */
function memoryDir() {
  return join(root, "memory");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-concurrency-"));
  cfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一份只有一条记忆的 MEMORY.md。 */
async function seed() {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    ["- 已有记忆 <!-- id:m001 topic:seed at:2026-10-01 -->", ""].join("\n"),
    "utf8",
  );
}

/** 读回当前解析出的条目。 */
async function entries() {
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  return parseMemory(text).entries;
}

/** 面板新增一条的调用糖。 */
function panelAdd(topic, content) {
  return editMemory({
    cfg,
    cwd: root,
    scope: "project",
    action: "add",
    topic,
    content,
    readText,
    writeText: writeAtomic,
  });
}

test("面板并发新增两条不同记忆：两条都在，id 不撞", async () => {
  await seed();
  const [a, b] = await Promise.all([panelAdd("topic-a", "内容 A"), panelAdd("topic-b", "内容 B")]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.id, b.id, "两条新记忆不该拿到同一个 id");

  const topics = (await entries()).map((e) => e.topic);
  assert.equal(topics.includes("topic-a"), true, "并发的 A 被覆盖了");
  assert.equal(topics.includes("topic-b"), true, "并发的 B 被覆盖了");
  assert.equal(topics.length, 3);
});

test("模型 memory_save 与面板 edit 并发：两边都不丢", async () => {
  await seed();
  const [saved, edited] = await Promise.all([
    saveMemory({
      cfg,
      cwd: root,
      input: { topic: "from-model", content: "模型写的", scope: "project", mode: "new" },
    }),
    panelAdd("from-panel", "面板写的"),
  ]);

  assert.equal(saved.ok, true);
  assert.equal(edited.ok, true);

  const topics = (await entries()).map((e) => e.topic);
  assert.equal(topics.includes("from-model"), true, "模型写的被覆盖了");
  assert.equal(topics.includes("from-panel"), true, "面板写的被覆盖了");
  assert.equal(topics.length, 3);
});

test("并发新增多个不同条目：全部保留且 id 唯一", async () => {
  await seed();
  const topics = ["t1", "t2", "t3", "t4", "t5"];
  const results = await Promise.all(topics.map((t) => panelAdd(t, `内容 ${t}`)));
  for (const r of results) assert.equal(r.ok, true);

  const list = await entries();
  assert.equal(list.length, 6, "5 条并发新增应全部保留（含 1 条种子）");
  const got = list.map((e) => e.topic);
  for (const t of topics) assert.equal(got.includes(t), true, `${t} 丢了`);

  const ids = list.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "并发写入产生了重复 id");
});
