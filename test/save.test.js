import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { readRuns } from "../lib/audit.js";
import { resolveConfig } from "../lib/config.js";
import { parseMemory } from "../lib/parse.js";
import { resolveMemoryPaths } from "../lib/paths.js";
import { saveMemory } from "../lib/save.js";
import { readText } from "../lib/store.js";

/**
 * 每个用例一个全新的临时工作区 —— 记忆是**有状态**的，共用目录会让用例之间
 * 互相污染，而那种失败极难排查。
 */
let cwd = "";

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(cwd, ".memory"), { recursive: true, force: true });
  await rm(join(cwd, ".user-memory"), { recursive: true, force: true });
});

/** 默认配置：落点改到临时目录下。 */
function cfg(overrides = {}) {
  return resolveConfig({ projectMemoryDir: ".memory", ...overrides });
}

/** 读回 MEMORY.md 的条目。 */
async function entriesOf(c) {
  const paths = resolveMemoryPaths(cwd, "project", c);
  const text = await readText(paths.file);
  return text === null ? null : parseMemory(text).entries;
}

test("首次写入：自动建目录、建文件、写入条目", async () => {
  const c = cfg();
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "indent-style", content: "缩进用 4 空格。", scope: "project", section: "约定" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(result.id, "m001");

  const entries = await entriesOf(c);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "m001");
  assert.equal(entries[0].topic, "indent-style");
  assert.equal(entries[0].section, "约定");
  assert.equal(entries[0].content, "缩进用 4 空格。");
  assert.equal(entries[0].pending, false);

  // 模板自带的段标题要保留下来 —— 它是给人看的脚手架。
  const text = await readText(resolveMemoryPaths(cwd, "project", c).file);
  assert.match(text, /^# 项目记忆/m);
  assert.match(text, /^## 踩过的坑/m);
});

test("未指定 section 时落进「未分类」，段不存在会自动创建", async () => {
  const c = cfg();
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "a", content: "内容 A。", scope: "project" },
  });
  assert.equal(result.action, "created");

  const entries = await entriesOf(c);
  assert.equal(entries[0].section, "未分类");

  const text = await readText(resolveMemoryPaths(cwd, "project", c).file);
  assert.match(text, /^## 未分类$/m);
});

test("完全相同的记忆第二次写入被去重，文件逐字节不变", async () => {
  const c = cfg();
  const input = { topic: "test-cmd", content: "测试跑 pnpm test:unit。", scope: "project" };

  await saveMemory({ cfg: c, cwd, input });
  const paths = resolveMemoryPaths(cwd, "project", c);
  const before = await readFile(paths.file, "utf8");

  const second = await saveMemory({ cfg: c, cwd, input });
  assert.equal(second.ok, true);
  assert.equal(second.action, "deduped");
  assert.equal(second.id, "m001");

  const after = await readFile(paths.file, "utf8");
  assert.equal(after, before);
});

test("归一化差异（大小写 / 标点 / 空白）也算重复", async () => {
  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "indent-style", content: "缩进用 4 空格。", scope: "project" },
  });
  const second = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "Indent-Style", content: "缩进用 4 空格", scope: "project" },
  });
  assert.equal(second.action, "deduped");

  const entries = await entriesOf(c);
  assert.equal(entries.length, 1);
});

test("mode=update：替换旧条目，不新增行", async () => {
  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "package-manager", content: "包管理器用 npm。", scope: "project", section: "约定" },
  });

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: {
      topic: "package-manager",
      content: "包管理器改用 pnpm。",
      scope: "project",
      mode: "update",
      section: "约定",
    },
  });

  assert.equal(result.action, "updated");
  assert.equal(result.id, "m001");

  const entries = await entriesOf(c);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "包管理器改用 pnpm。");
  assert.equal(entries[0].id, "m001");
});

test("mode=update 保留旧条目的 area（工作空间标签不被抹掉）", async () => {
  const c = cfg();
  // 直接落一份带 area:backend 的文件 —— memory_save 没有 area 参数，area 只能来自
  // 面板手填或先前的文件；这里用文件模拟「已经整理好的记忆」。
  const paths = resolveMemoryPaths(cwd, "project", c);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.file,
    [
      "# 项目记忆",
      "",
      "## 约定",
      "- 使用 PostgreSQL。 <!-- id:m001 topic:database at:2026-10-01 area:backend -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: {
      topic: "database",
      content: "改用 PostgreSQL 17。",
      scope: "project",
      mode: "update",
    },
  });
  assert.equal(result.action, "updated");
  assert.equal(result.id, "m001");

  const entries = await entriesOf(c);
  assert.equal(entries.length, 1, "同 topic 只有一条，没有被重复插入");
  assert.equal(entries[0].content, "改用 PostgreSQL 17。", "正文换成新的");
  assert.equal(entries[0].area, "backend", "area 必须原样保留，不因 update 抹掉");
  assert.equal(entries[0].section, "约定", "段落在原处保留");

  // 钉死格式：注释里 area: 只出现一次，且没有出现空 area / 重复追加。
  const text = await readText(paths.file);
  assert.equal(text.match(/area:/g)?.length ?? 0, 1);
  assert.equal(text.includes("area: "), false, "不该产生空 area");
});

test("mode=update 时旧条目没有 area，也不该凭空造一个", async () => {  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "indent-style", content: "缩进用 4 空格。", scope: "project", section: "约定" },
  });
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "indent-style", content: "缩进用 2 空格。", scope: "project", mode: "update" },
  });
  assert.equal(result.action, "updated");

  const entries = await entriesOf(c);
  assert.equal(entries[0].area, null);
  const text = await readText(resolveMemoryPaths(cwd, "project", c).file);
  assert.equal(text.includes("area:"), false, "没有 area 的条目不该被补出空 area");
});

test("mode=new 且同 topic 内容不同 → 冻结为待裁决，两条都留着", async () => {
  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "package-manager", content: "包管理器用 npm。", scope: "project", section: "约定" },
  });

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: {
      topic: "package-manager",
      content: "包管理器改用 pnpm。",
      scope: "project",
      section: "约定",
    },
  });

  assert.equal(result.action, "conflicted");
  assert.equal(result.id, "m002");
  // 返回文本必须说清「暂不注入上下文」，否则模型会以为已经生效。
  assert.match(result.message, /待裁决/);

  const entries = await entriesOf(c);
  assert.equal(entries.length, 2);

  const old = entries.find((e) => e.id === "m001");
  const fresh = entries.find((e) => e.id === "m002");
  assert.equal(old.pending, false);
  assert.equal(fresh.pending, true);
  assert.equal(fresh.conflictWith, "m001");
});

test("冲突时生成 CONFLICTS.md，裁决后自动删除", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);

  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "package-manager", content: "包管理器用 npm。", scope: "project" },
  });
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "package-manager", content: "包管理器改用 pnpm。", scope: "project" },
  });

  const rendered = await readText(paths.conflicts);
  assert.notEqual(rendered, null);
  assert.match(rendered, /# 待裁决冲突/);
  assert.match(rendered, /包管理器用 npm/);
  assert.match(rendered, /包管理器改用 pnpm/);

  // 手工裁决：删掉带 [待裁决] 的那条。
  const text = await readFile(paths.file, "utf8");
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !line.includes("[待裁决]"))
    .join("\n");
  await writeFile(paths.file, kept, "utf8");

  // 下次写入时重建派生视图 → 没有冲突了，文件该被删掉。
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "other", content: "另一件事。", scope: "project" },
  });

  assert.equal(await readText(paths.conflicts), null);
});

test("待裁决的条目不再作为冲突源（不滚雪球）", async () => {
  const c = cfg();
  const base = { scope: "project", topic: "package-manager" };
  await saveMemory({ cfg: c, cwd, input: { ...base, content: "用 npm。" } });
  await saveMemory({ cfg: c, cwd, input: { ...base, content: "用 pnpm。" } });
  const third = await saveMemory({ cfg: c, cwd, input: { ...base, content: "用 yarn。" } });

  assert.equal(third.action, "conflicted");
  // 冲突对象只指向活跃的那条，不含已经待裁决的 m002。
  assert.equal(third.id, "m003");
  const entries = await entriesOf(c);
  const fresh = entries.find((e) => e.id === "m003");
  assert.equal(fresh.conflictWith, "m001");
});

test("mode=append：同 topic 补充信息，不算冲突", async () => {
  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "test-cmd", content: "测试跑 pnpm test:unit。", scope: "project" },
  });
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: {
      topic: "test-cmd",
      content: "端到端测试跑 pnpm test:e2e，需要先起服务。",
      scope: "project",
      mode: "append",
    },
  });

  assert.equal(result.action, "created");
  const entries = await entriesOf(c);
  assert.equal(entries.length, 2);
  assert.equal(entries.every((e) => e.pending === false), true);
});

test("空白输入被硬拒，连文件都不创建", async () => {
  const c = cfg();
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "  ", content: "   ", scope: "project" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "rejected");
  assert.equal(result.id, "");

  const paths = resolveMemoryPaths(cwd, "project", c);
  assert.equal(await readText(paths.file), null);
  // 但审计里要留下痕迹。
  const runs = await readRuns(paths.runs, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].op, "reject");
  assert.equal(runs[0].reason, "blank");
});

test("超出字节上限时明确拒绝，且不修改文件", async () => {
  const c = cfg({ projectMaxBytes: 900 });
  const paths = resolveMemoryPaths(cwd, "project", c);

  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "small", content: "一条小记忆。", scope: "project" },
  });
  const before = await readFile(paths.file, "utf8");

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "big", content: "很长的一段话。".repeat(200), scope: "project" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "rejected");
  assert.match(result.message, /超出上限/);
  assert.equal(await readFile(paths.file, "utf8"), before);

  const runs = await readRuns(paths.runs, 0);
  const last = runs[runs.length - 1];
  assert.equal(last.op, "reject");
  assert.equal(last.reason, "oversize");
  assert.equal(last.bytes > 900, true);
});

test("正文里的换行被压成一行（条目格式是一行一条）", async () => {
  const c = cfg();
  await saveMemory({
    cfg: c,
    cwd,
    input: {
      topic: "multi",
      content: "第一行\n第二行\n\n第三行",
      scope: "project",
    },
  });

  const entries = await entriesOf(c);
  assert.equal(entries[0].content, "第一行 第二行 第三行");
  const text = await readText(resolveMemoryPaths(cwd, "project", c).file);
  assert.equal(text.split(/\r?\n/).filter((l) => l.includes("第一行")).length, 1);
});

test("审计流水完整记录了整条链路", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);
  const base = { scope: "project", topic: "kv-cache" };

  await saveMemory({ cfg: c, cwd, input: { ...base, content: "记忆块一变，前缀缓存失效。", reason: "成本相关" } });
  await saveMemory({ cfg: c, cwd, input: { ...base, content: "记忆块一变，前缀缓存失效。", reason: "成本相关" } });
  await saveMemory({ cfg: c, cwd, input: { ...base, content: "缓存从改动处全部失效。", mode: "update" } });
  await saveMemory({ cfg: c, cwd, input: { ...base, content: "换个说法：改了就得重算。", mode: "new" } });

  const runs = await readRuns(paths.runs, 0);
  assert.deepEqual(
    runs.map((r) => r.op),
    ["save", "dedupe", "update", "conflict"],
  );
  assert.equal(runs[0].reason, "成本相关");
  assert.equal(runs[0].scope, "project");
  assert.equal(typeof runs[0].hash, "string");
  assert.equal(runs[1].id, "m001");
  assert.equal(runs[3].with, "m001");
  assert.equal(typeof runs[3].bytes, "number");
});

test("审计是旁路：流水目录不可写也不影响写入成功", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);
  // 用一个必然失败的 logger，确认 logger 自己抛错也不会往上冒。
  const hostileLogger = {
    warn() {
      throw new Error("logger 坏了");
    },
  };

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "x", content: "内容。", scope: "project" },
    logger: hostileLogger,
  });
  assert.equal(result.ok, true);
  assert.equal((await readRuns(paths.runs, 0)).length, 1);
});

test("user 作用域落到独立目录，与 project 互不干扰", async () => {
  // userMemoryDir 用绝对路径：相对路径的基准是 $DSH_HOME，不是工作区。
  const c = cfg({ userMemoryDir: join(cwd, ".user-memory") });
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "reply-style", content: "回复用中文，别客套。", scope: "user" },
  });
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "indent-style", content: "缩进用 4 空格。", scope: "project" },
  });

  const userPaths = resolveMemoryPaths(cwd, "user", c);
  const projectPaths = resolveMemoryPaths(cwd, "project", c);
  assert.notEqual(userPaths.file, projectPaths.file);

  const userEntries = parseMemory(await readFile(userPaths.file, "utf8")).entries;
  assert.equal(userEntries.length, 1);
  assert.equal(userEntries[0].topic, "reply-style");
  assert.equal(userEntries[0].id, "m001"); // 独立编号空间

  const projectEntries = await entriesOf(c);
  assert.equal(projectEntries.length, 1);
  assert.equal(projectEntries[0].topic, "indent-style");
});

test("id 递增不受删除影响（删过之后不会撞号）", async () => {
  const c = cfg();
  await saveMemory({ cfg: c, cwd, input: { topic: "a", content: "A。", scope: "project" } });
  await saveMemory({ cfg: c, cwd, input: { topic: "b", content: "B。", scope: "project" } });
  await saveMemory({ cfg: c, cwd, input: { topic: "c", content: "C。", scope: "project" } });

  // 手工删掉中间那条。
  const paths = resolveMemoryPaths(cwd, "project", c);
  const text = await readFile(paths.file, "utf8");
  await writeFile(
    paths.file,
    text.split(/\r?\n/).filter((l) => !l.includes("id:m002")).join("\n"),
    "utf8",
  );

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "d", content: "D。", scope: "project" },
  });
  assert.equal(result.id, "m004");
});

test("MEMORY.md 缺失但 runs.jsonl 还在时不崩（fail-open）", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);
  await saveMemory({ cfg: c, cwd, input: { topic: "a", content: "A。", scope: "project" } });

  await rm(paths.file, { force: true });
  assert.equal(await readText(paths.file), null);

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "b", content: "B。", scope: "project" },
  });
  assert.equal(result.ok, true);
  const entries = await entriesOf(c);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].topic, "b");
});

test("写入的条目格式能被解析器原样读回（含 id / topic / 日期）", async () => {
  const c = cfg();
  const now = "2026-10-12T08:30:00.000Z";
  await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "dsh-apply-pitfall", content: "`export function apply` 会被当构造函数。", scope: "project", section: "踩过的坑" },
    now,
  });

  const entries = await entriesOf(c);
  assert.equal(entries[0].at, "2026-10-12");
  assert.equal(entries[0].section, "踩过的坑");
  assert.equal(entries[0].hash.length, 64);
});

test("文件确实被原子替换：写完不留下 .tmp 残渣", async () => {
  const c = cfg();
  await saveMemory({ cfg: c, cwd, input: { topic: "a", content: "A。", scope: "project" } });
  await saveMemory({ cfg: c, cwd, input: { topic: "a", content: "A 改了。", scope: "project", mode: "update" } });

  const dir = resolveMemoryPaths(cwd, "project", c).dir;
  const entries = await readFile(join(dir, "MEMORY.md"), "utf8");
  assert.match(entries, /A 改了。/);

  // 目录里只该有 MEMORY.md 和 runs.jsonl。
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["MEMORY.md", "runs.jsonl"]);
  await stat(join(dir, "MEMORY.md"));
});

// ---- 失败分级：读失败不覆盖、审计失败要出声 ----

test("读盘失败时中止写入，绝不把已有记忆覆盖成只剩这一条", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);
  // 先放一份正常记忆，再把它变成一个**目录** —— 这样 readText 会抛 EISDIR
  // （不是 ENOENT，所以不会被当成「文件不存在」），精确模拟「读不出来」。
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.file, "- 老记忆。<!-- id:m001 topic:a at:2026-10-01 -->\n", "utf8");
  await rm(paths.file, { force: true });
  await mkdir(paths.file, { recursive: true });

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "x", content: "新内容。", scope: "project" },
  });

  assert.equal(result.ok, false, "读失败必须明确失败");
  assert.equal(result.action, "rejected");
  assert.match(result.message, /读不到/);
  assert.match(result.message, /中止/);

  // 关键断言：目标仍然是那个目录，没被写成一个「只剩新条目」的文件。
  const st = await stat(paths.file);
  assert.equal(st.isDirectory(), true, "读失败不该改写目标 —— 否则就是静默清空记忆库");
});

test("审计写入失败时：记忆照样写入成功，但 message 里明确提示", async () => {
  const c = cfg();
  const paths = resolveMemoryPaths(cwd, "project", c);
  // 把 runs.jsonl 变成一个目录 → appendFile 抛 EISDIR → appendRun 返回 false。
  await mkdir(join(paths.dir, "runs.jsonl"), { recursive: true });

  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "a", content: "A。", scope: "project" },
  });

  assert.equal(result.ok, true, "审计是旁路：写失败不阻断记忆操作");
  assert.equal(result.action, "created");
  assert.match(result.message, /审计未记录成功/);

  // 记忆本身确实写进去了。
  const entries = await entriesOf(c);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "A。");
});

test("审计写入正常时 message 里不该出现审计缺口的提示", async () => {
  const c = cfg();
  const result = await saveMemory({
    cfg: c,
    cwd,
    input: { topic: "a", content: "A。", scope: "project" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.includes("审计未记录成功"), false);
});
