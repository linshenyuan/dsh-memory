import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { resolveMemoryPaths } from "../lib/paths.js";
import {
  rankByKeywords,
  readMemory,
  renderEntries,
  renderSnapshot,
  renderScope,
  splitKeywords,
  usageLabel,
} from "../lib/render.js";

const CWD = "/tmp/ws";
const cfg = (overrides = {}) => resolveConfig({ projectMemoryDir: ".memory", ...overrides });
const pathsOf = (c) => resolveMemoryPaths(CWD, "project", c);

/** 造一个条目。 */
function entry(over = {}) {
  return {
    id: "m001",
    topic: "t",
    at: "2026-10-12",
    content: "一条记忆。",
    pending: false,
    conflictWith: null,
    section: "约定",
    hash: "h",
    lineIndex: 0,
    indent: "",
    ...over,
  };
}

test("usageLabel 给出百分比和绝对值", () => {
  assert.equal(usageLabel(0, 1000), "0% (0/1000 bytes)");
  assert.equal(usageLabel(500, 1000), "50% (500/1000 bytes)");
  assert.equal(usageLabel(1000, 1000), "100% (1000/1000 bytes)");
});

test("usageLabel 对 0 上限不炸（除零）", () => {
  assert.equal(usageLabel(100, 0), "0% (100/0 bytes)");
});

test("renderEntries 保留段标题，按段归组", () => {
  const text = renderEntries([
    entry({ content: "A。", section: "约定" }),
    entry({ content: "B。", section: "踩过的坑" }),
    entry({ content: "C。", section: "约定" }),
  ]);
  assert.equal(text, ["## 约定", "- A。", "- C。", "", "## 踩过的坑", "- B。", ""].join("\n").trim());
});

test("renderScope 把正文包进带 path 与 usage 的标签", () => {
  const c = cfg();
  const block = renderScope("project_memory", pathsOf(c), [entry({ content: "缩进用 4 空格。" })], c);
  assert.notEqual(block, null);
  assert.match(block, /^<project_memory path="\.memory\/MEMORY\.md" usage="\d+% \(\d+\/\d+ bytes\)">/);
  assert.match(block, /- 缩进用 4 空格。/);
  assert.match(block, /<\/project_memory>$/);
});

test("renderScope 在 conflictFreeze 打开时滤掉待裁决条目", () => {
  const c = cfg();
  const entries = [
    entry({ id: "m001", content: "用 npm。" }),
    entry({ id: "m002", content: "用 pnpm。", pending: true }),
  ];
  const block = renderScope("project_memory", pathsOf(c), entries, c);
  assert.match(block, /用 npm。/);
  assert.equal(block.includes("用 pnpm。"), false);
});

test("conflictFreeze 关闭时待裁决条目也会带进去", () => {
  const c = cfg({ conflictFreeze: false });
  const entries = [
    entry({ id: "m001", content: "用 npm。" }),
    entry({ id: "m002", content: "用 pnpm。", pending: true }),
  ];
  const block = renderScope("project_memory", pathsOf(c), entries, c);
  assert.match(block, /用 pnpm。/);
});

test("全部条目都待裁决时返回 null（没有可注入内容）", () => {
  const c = cfg();
  const block = renderScope("project_memory", pathsOf(c), [entry({ pending: true })], c);
  assert.equal(block, null);
});

test("空条目列表返回 null", () => {
  const c = cfg();
  assert.equal(renderScope("project_memory", pathsOf(c), [], c), null);
});

test("敏感信息在注入前被打码，并给出打码计数", () => {
  const c = cfg();
  const block = renderScope(
    "project_memory",
    pathsOf(c),
    [entry({ content: "部署用的 key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789。" })],
    c,
  );
  assert.equal(block.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.match(block, /sk-\*\*\*/);
  assert.match(block, /已打码 1 处/);
});

test("sensitiveScan 关闭时不打码", () => {
  const c = cfg({ sensitiveScan: false });
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const block = renderScope("project_memory", pathsOf(c), [entry({ content: `key ${secret}` })], c);
  assert.equal(block.includes(secret), true);
});

test("超限时截断并明确告知，不静默截断", () => {
  const c = cfg({ projectMaxBytes: 120 });
  const block = renderScope(
    "project_memory",
    pathsOf(c),
    [entry({ content: "很长的一条记忆。".repeat(40) })],
    c,
  );
  assert.match(block, /usage="OVERSIZE \(\d+\/120 bytes\)"/);
  assert.match(block, /\[记忆超限\]/);
  assert.match(block, /mode: "update"/);
  // 正文确实被切短了。
  assert.equal(block.length < 120 + 400, true);
});

test("先打码再截断：被截断切开的凭据不会漏出去", () => {
  // 顺序反过来的话，截断会把 `sk-xxxx` 切成 `sk-xx`，正则匹配不上，凭据就进上下文了。
  const c = cfg({ projectMaxBytes: 30 });
  const block = renderScope(
    "project_memory",
    pathsOf(c),
    [entry({ content: `前缀 ${"字".repeat(20)} sk-abcdefghijklmnopqrstuvwxyz0123456789` })],
    c,
  );
  assert.equal(block.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
});

test("截断后的结果必须是合法 UTF-8（不产生孤立代理项）", () => {
  const c = cfg({ projectMaxBytes: 61 });
  const block = renderScope(
    "project_memory",
    pathsOf(c),
    [entry({ content: "😀".repeat(40) })],
    c,
  );
  assert.equal(Buffer.from(block, "utf8").toString("utf8"), block);
});

test("renderSnapshot 没有任何记忆时返回 undefined", async () => {
  const c = cfg();
  const out = await renderSnapshot({ cwd: CWD, cfg: c, readText: async () => null });
  assert.equal(out, undefined);
});

test("renderSnapshot 只渲染存在的作用域", async () => {
  const c = cfg();
  const readText = async (p) =>
    p.endsWith("MEMORY.md") && p.includes(".memory") ? "- 项目记忆一条。\n" : null;

  const { text, sections } = await renderSnapshot({ cwd: CWD, cfg: c, readText });
  assert.match(text, /^<memory>/);
  assert.match(text, /<project_memory /);
  assert.equal(text.includes("<user_memory "), false);
  assert.match(text, /<\/memory>$/);
  // 引导语必须包含「你当前的指令优先」—— 否则过时的记忆会压过现实。
  assert.match(text, /你当前的指令和项目的实际状态优先于这里的内容/);

  // 分片必须和正文同源：会话视图按 sections 渲染，不给就等于让用户看不到注入内容。
  assert.deepEqual(
    sections.map((s) => s.name),
    ["project_memory"],
  );
  assert.equal(sections[0].text.includes("项目记忆一条。"), true);
  assert.equal(text.includes(sections[0].text), true);
});

test("分片的名字与顺序稳定：作用域块在前，冲突摘要在后", async () => {
  const c = cfg({ userMemoryDir: join(CWD, ".user") });
  const text = [
    "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
    "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
  ].join("\n");
  const readText = async () => text;

  const { sections } = await renderSnapshot({ cwd: CWD, cfg: c, readText });
  assert.deepEqual(
    sections.map((s) => s.name),
    ["project_memory", "conflicts", "user_memory", "conflicts"],
  );
  // 每个分片都必须有非空名字和字符串正文，否则会话视图会降级成不透明。
  for (const section of sections) {
    assert.equal(typeof section.name, "string");
    assert.notEqual(section.name, "");
    assert.equal(typeof section.text, "string");
  }
});

test("框架文字不属于任何分片（它声明的是快照这个形态本身的语义）", async () => {
  const c = cfg();
  const readText = async (p) => (p.includes(".memory") ? "- 一条。\n" : null);
  const { text, sections } = await renderSnapshot({ cwd: CWD, cfg: c, readText });

  for (const line of ["<memory>", "</memory>", "本次会话内不会再更新"]) {
    assert.equal(
      sections.some((s) => s.text.includes(line)),
      false,
      `框架文字不该出现在分片里: ${line}`,
    );
  }
  assert.equal(text.includes("<memory>"), true);
});

test("renderSnapshot 在冲突时附上计数摘要", async () => {
  const c = cfg();
  const text = [
    "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
    "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
  ].join("\n");
  const readText = async (p) => (p.includes(".memory") ? text : null);

  const { text: out, sections } = await renderSnapshot({ cwd: CWD, cfg: c, readText });
  assert.match(out, /<conflicts pending="1">/);
  assert.match(out, /有 1 组待裁决的冲突/);
  assert.match(out, /暂未带入上下文/);
  // 待裁决的正文本身不该出现在注入里。
  assert.equal(out.includes("用 pnpm。"), false);
  assert.equal(sections.some((s) => s.name === "conflicts"), true);
});

test("readText 抛错时 fail-open：当作没有记忆，不抛出去", async () => {
  const c = cfg();
  const readText = async () => {
    throw new Error("EACCES");
  };
  const out = await renderSnapshot({ cwd: CWD, cfg: c, readText });
  assert.equal(out, undefined);
});

test("signal 已中止时不再读盘", async () => {
  const c = cfg();
  let called = false;
  const signal = {
    throwIfAborted() {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  const out = await renderSnapshot({
    cwd: CWD,
    cfg: c,
    readText: async () => {
      called = true;
      return null;
    },
    signal,
  });
  assert.equal(out, undefined);
  assert.equal(called, false);
});

// ---- readMemory：按需读取入口（memory_read 工具底层）----

test("readMemory 没有任何记忆时返回 null", async () => {
  const c = cfg();
  const text = await readMemory({ cwd: CWD, scope: "both", cfg: c, readText: async () => null });
  assert.equal(text, null);
});

test("readMemory 按作用域读取项目记忆", async () => {
  const c = cfg();
  const readText = async (p) =>
    p.includes(".memory") ? "- 项目记忆一条。<!-- id:m001 topic:t at:2026-10-01 -->\n" : null;
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText });
  assert.match(text, /<project_memory /);
  assert.match(text, /项目记忆一条。/);
});

test("readMemory 用 topic 过滤只取同一主题（不区分大小写）", async () => {
  const c = cfg();
  const readText = async () =>
    [
      "- npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
      "- pnpm。<!-- id:m002 topic:other at:2026-10-02 -->",
    ].join("\n");
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, topic: "PM" });
  assert.match(text, /npm。/);
  assert.equal(text.includes("pnpm。"), false);
});

test("readMemory 带 topic 时不附冲突摘要", async () => {
  const c = cfg();
  const readText = async () => "- npm。<!-- id:m001 topic:pm at:2026-10-01 -->\n";
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, topic: "pm" });
  assert.equal(text.includes("<conflicts"), false);
});

test("readMemory scope=both（无 topic）复用整批快照排版，含冲突摘要", async () => {
  const c = cfg();
  const readText = async (p) =>
    p.includes(".memory")
      ? [
          "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
          "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
        ].join("\n")
      : null;
  const text = await readMemory({ cwd: CWD, scope: "both", cfg: c, readText });
  assert.match(text, /^<memory>/);
  assert.match(text, /<conflicts pending="1">/);
  assert.match(text, /有 1 组待裁决的冲突/);
  // 待裁决的正文本身不该出现。
  assert.equal(text.includes("用 pnpm。"), false);
  // 已确认的那条仍然要带上。
  assert.match(text, /用 npm。/);
});

test("readMemory 读盘抛错时 fail-open 返回 null", async () => {
  const c = cfg();
  const readText = async () => {
    throw new Error("EACCES");
  };
  const text = await readMemory({ cwd: CWD, scope: "both", cfg: c, readText });
  assert.equal(text, null);
});

// ---- 关键词检索（memory_read 的 keywords 参数）----

test("splitKeywords 按空白 / 逗号 / 顿号 / 分号切分并归一化、去重", () => {
  assert.deepEqual(splitKeywords("pnpm  缓存, lockfile、monorepo；"), ["pnpm", "缓存", "lockfile", "monorepo"]);
  // 标点和大小写被归一化掉 —— 口径和去重指纹同一套。
  assert.deepEqual(splitKeywords("PostgreSQL-17!"), ["postgresql17"]);
  // 去重：两次同一 key 只留一个。
  assert.deepEqual(splitKeywords("pnpm pnpm,pnpm"), ["pnpm"]);
  // 空 / 非字符串 / 纯分隔符都不产出词。
  assert.deepEqual(splitKeywords(""), []);
  assert.deepEqual(splitKeywords("  ,， "), []);
  assert.deepEqual(splitKeywords(null), []);
  assert.deepEqual(splitKeywords(42), []);
});

test("rankByKeywords：命中 topic 的排在命中正文的前面", () => {
  const ranked = rankByKeywords(
    [
      entry({ id: "m001", topic: "other", content: "我们决定用 pnpm。" }),
      entry({ id: "m002", topic: "pnpm", content: "包管理器。" }),
    ],
    splitKeywords("pnpm"),
  );
  assert.deepEqual(
    ranked.map((e) => e.id),
    ["m002", "m001"],
    "m002 命中 topic（3 分）应先于 m001 只命中正文（1 分）",
  );
});

test("rankByKeywords：命中多个词的排在命中单个词的前面", () => {
  const ranked = rankByKeywords(
    [
      entry({ id: "m001", topic: "a", content: "pnpm。" }),
      entry({ id: "m002", topic: "b", content: "pnpm 缓存。" }),
    ],
    splitKeywords("pnpm 缓存"),
  );
  assert.deepEqual(
    ranked.map((e) => e.id),
    ["m002", "m001"],
  );
});

test("rankByKeywords：一个词都没命中的条目被丢掉", () => {
  const ranked = rankByKeywords(
    [entry({ id: "m001", topic: "a", content: "npm。" })],
    splitKeywords("pnpm"),
  );
  assert.deepEqual(ranked, []);
});

test("rankByKeywords：keywords 为空时原样返回（等于不过滤）", () => {
  const entries = [entry({ id: "m001" }), entry({ id: "m002" })];
  assert.equal(rankByKeywords(entries, []), entries);
});

test("rankByKeywords：并列时确定性排序（at 新的在前）", () => {
  const ranked = rankByKeywords(
    [
      entry({ id: "m001", topic: "x", at: "2026-10-01", content: "pnpm。" }),
      entry({ id: "m002", topic: "x", at: "2026-10-09", content: "pnpm。" }),
    ],
    splitKeywords("pnpm"),
  );
  assert.deepEqual(ranked.map((e) => e.id), ["m002", "m001"]);
});

test("readMemory：keywords 按内容命中，想不起 topic 也能捞到", async () => {
  const c = cfg();
  const readText = async () =>
    [
      "- 用 npm。<!-- id:m001 topic:pkg at:2026-10-01 -->",
      "- 包管理器换成 pnpm 了，理由是 monorepo 支持。<!-- id:m002 topic:pkg-manager at:2026-10-02 -->",
    ].join("\n");
  // 只记得内容里有 pnpm，不知道 topic 叫什么。
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, keywords: "pnpm" });
  assert.match(text, /包管理器换成 pnpm 了/);
  assert.equal(text.includes("用 npm。"), false);
});

test("readMemory：keywords 与 topic 可叠加（先精确再排序）", async () => {
  const c = cfg();
  const readText = async () =>
    [
      "- A。<!-- id:m001 topic:pm at:2026-10-01 -->",
      "- B。<!-- id:m002 topic:pm at:2026-10-02 -->",
      "- C。<!-- id:m003 topic:other at:2026-10-03 -->",
    ].join("\n");
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, topic: "pm", keywords: "B" });
  assert.match(text, /- B。/);
  assert.equal(text.includes("- A。"), false, "topic 先筛掉了不相关主题");
  assert.equal(text.includes("- C。"), false);
});

test("readMemory：keywords 命中后仍走打码 → 截断那条链（不新开绕过打码的路）", async () => {
  const c = cfg();
  const readText = async () =>
    "- 部署 key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789，配 pnpm 用。<!-- id:m001 topic:deploy at:2026-10-01 -->";
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, keywords: "pnpm" });
  assert.match(text, /sk-\*\*\*/, "关键词命中的内容照样被打码");
  assert.equal(text.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  // 复用了 renderScope，所以 usage 表头也在。
  assert.match(text, /usage="\d+% \(\d+\/\d+ bytes\)"/);
});

test("readMemory：keywords 一条都没命中时返回 null", async () => {
  const c = cfg();
  const readText = async () => "- 用 npm。<!-- id:m001 topic:pkg at:2026-10-01 -->";
  const text = await readMemory({ cwd: CWD, scope: "project", cfg: c, readText, keywords: "zebra" });
  assert.equal(text, null);
});

test("readMemory：只给关键词、不给 topic 时附不上冲突摘要（查一部分不添乱）", async () => {
  const c = cfg();
  const readText = async () =>
    [
      "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->",
      "- [待裁决] 用 pnpm。<!-- id:m002 topic:pm at:2026-10-12 conflict-with:m001 -->",
    ].join("\n");
  const text = await readMemory({ cwd: CWD, scope: "both", cfg: c, readText, keywords: "npm" });
  assert.equal(text.includes("<conflicts"), false);
  assert.match(text, /用 npm。/);
  // 待裁决那条没命中关键词，不该出现（且 freeze 本来也会过滤它）。
  assert.equal(text.includes("用 pnpm。"), false);
});

test("readMemory：scope=both + 无过滤仍走整批快照（没被关键词参数改动破坏）", async () => {
  const c = cfg();
  const readText = async (p) =>
    p.includes(".memory") ? "- 用 npm。<!-- id:m001 topic:pm at:2026-10-01 -->" : null;
  const text = await readMemory({ cwd: CWD, scope: "both", cfg: c, readText, keywords: null });
  assert.match(text, /^<memory>/, "一个过滤条件都没有时仍复用整批快照排版");
});
