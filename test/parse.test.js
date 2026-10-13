import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  collapseBlankLines,
  formatEntry,
  insertEntry,
  joinLines,
  parseMemory,
  removeLine,
  replaceLine,
} from "../lib/parse.js";

const SAMPLE = [
  "# 项目记忆",
  "",
  "> 一段给人看的说明。",
  "",
  "## 约定",
  "",
  "- 缩进用 4 空格；不用分号结尾。<!-- id:m001 topic:indent-style at:2026-10-01 -->",
  "- 测试跑 `pnpm test:unit`。<!-- id:m002 topic:test-cmd at:2026-10-03 -->",
  "",
  "## 踩过的坑",
  "",
  "- `export function apply` 会被当构造函数。<!-- id:m003 topic:dsh-apply-pitfall at:2026-10-11 -->",
  "",
  "## 待裁决",
  "",
  "- [待裁决] 包管理器用 npm。<!-- id:m004 topic:package-manager at:2026-10-12 conflict-with:m001 -->",
  "",
].join("\n");

test("解析出条目与元数据", () => {
  const { entries } = parseMemory(SAMPLE);
  assert.equal(entries.length, 4);

  const first = entries[0];
  assert.equal(first.id, "m001");
  assert.equal(first.topic, "indent-style");
  assert.equal(first.at, "2026-10-01");
  assert.equal(first.section, "约定");
  assert.equal(first.pending, false);
  assert.equal(first.content, "缩进用 4 空格；不用分号结尾。");
  assert.equal(typeof first.hash, "string");
});

test("解析出待裁决标记与冲突对象", () => {
  const { entries } = parseMemory(SAMPLE);
  const pending = entries.find((e) => e.id === "m004");
  assert.equal(pending.pending, true);
  assert.equal(pending.conflictWith, "m001");
  assert.equal(pending.section, "待裁决");
  assert.equal(pending.content, "包管理器用 npm。");
});

test("解析出段结构", () => {
  const { sections } = parseMemory(SAMPLE);
  assert.deepEqual(
    sections.map((s) => s.name),
    ["约定", "踩过的坑", "待裁决"],
  );
});

test("解析必须宽容：乱七八糟的行不抛错、不误判", () => {
  const messy = [
    "# 标题",
    "这是一段自由文字，不是条目。",
    "- 没有元数据的裸条目",
    "* 用星号的项目符号（不认）",
    "  - 缩进的条目 <!-- id:m009 topic:indented at:2026-10-12 -->",
    "<!-- 单独一行的注释 -->",
    "- 正文里有 <!-- 内联注释 --> 这种东西 <!-- id:m010 topic:inline at:2026-10-12 -->",
    "",
  ].join("\n");

  const { entries } = parseMemory(messy);
  // 只认 `- ` 开头的行；裸条目和无 id 条目仍会被收进来（可注入，但不参与去重/冲突）。
  assert.equal(entries.some((e) => e.id === "m009"), true);
  assert.equal(entries.some((e) => e.id === "m010"), true);
  assert.equal(entries.some((e) => e.content === "没有元数据的裸条目"), true);
  assert.equal(entries.some((e) => e.content.startsWith("* ")), false);
});

test("重复 id 只保留先出现的那个", () => {
  const dup = [
    "## 段",
    "- 第一条 <!-- id:m001 topic:a at:2026-10-01 -->",
    "- 第二条 <!-- id:m001 topic:b at:2026-10-02 -->",
  ].join("\n");
  const { entries } = parseMemory(dup);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].topic, "a");
});

test("formatEntry 生成的行能被解析回来（往返一致）", () => {
  const line = formatEntry({
    id: "m007",
    topic: "kv-cache",
    at: "2026-10-12",
    content: "记忆块一变，前缀缓存从改动处全部失效。",
    pending: true,
    conflictWith: ["m001", "m002"],
  });

  const { entries } = parseMemory(`## 段\n${line}\n`);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.id, "m007");
  assert.equal(e.topic, "kv-cache");
  assert.equal(e.at, "2026-10-12");
  assert.equal(e.pending, true);
  assert.equal(e.conflictWith, "m001,m002");
  assert.equal(e.content, "记忆块一变，前缀缓存从改动处全部失效。");
});

test("formatEntry 剥掉正文里原有的 HTML 注释，避免自我污染", () => {
  const line = formatEntry({
    id: "m008",
    topic: "x",
    at: "2026-10-12",
    content: "正文 <!-- id:fake --> 继续",
  });
  const { entries } = parseMemory(`## 段\n${line}\n`);
  assert.equal(entries[0].id, "m008");
  assert.equal(entries[0].content, "正文 继续");
});

test("读取时也剥掉正文里的内联注释 —— 读到的和写回的必须是同一份文本", () => {
  // 如果只在写入时剥、读取时不剥，哈希会算在带注释的文本上；写回之后文本变了，
  // 下次读取的哈希就与流水对不上，启动自检会误报。
  const text = [
    "## 段",
    "- 正文里有 <!-- 内联注释 --> 这种东西 <!-- id:m010 topic:inline at:2026-10-12 -->",
  ].join("\n");
  const { entries } = parseMemory(text);
  assert.equal(entries[0].content, "正文里有 这种东西");

  // 与写入路径保持一致：再写回去，内容不变。
  const rewritten = formatEntry(entries[0]);
  const again = parseMemory(`## 段\n${rewritten}\n`).entries[0];
  assert.equal(again.content, entries[0].content);
  assert.equal(again.hash, entries[0].hash);
});

test("剥注释时不把相邻的字黏在一起", () => {
  const { entries } = parseMemory("## 段\n- 前<!-- x -->后 <!-- id:m1 topic:t at:2026-10-12 -->\n");
  assert.equal(entries[0].content, "前后");
});

test("整行只有注释时被丢弃，不产生幽灵条目", () => {
  // 正文为空 → 注入时只会变成一行空的 `- `，纯噪音，直接丢掉。
  const { entries } = parseMemory("## 段\n- <!-- id:m1 topic:t at:2026-10-12 -->\n");
  assert.equal(entries.length, 0);
});

test("一行里有两个注释时，只有行尾那个算元数据", () => {
  // 惰性匹配如果从第一个 `<!--` 开始吃，中间的正文会被整段吞掉。
  const text = [
    "## 段",
    "- 前面 <!-- 注 --> 后面 <!-- id:m020 topic:two at:2026-10-12 -->",
  ].join("\n");
  const { entries } = parseMemory(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "m020");
  assert.equal(entries[0].content, "前面 后面");
});

test("元数据注释体里不允许出现 -->（否则会吞掉正文）", () => {
  const text = [
    "## 段",
    "- 正文 <!-- id:m021 topic:three at:2026-10-12 --> 尾部 <!-- id:m022 topic:four at:2026-10-13 -->",
  ].join("\n");
  const { entries } = parseMemory(text);
  // 行尾那个是元数据；中间那个是正文的一部分，随正文一起被剥掉。
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "m022");
  assert.equal(entries[0].content, "正文 尾部");
});

test("insertEntry 插到指定段末尾", () => {
  const parsed = parseMemory(SAMPLE);
  const lines = insertEntry(parsed, "约定", "- 新条目 <!-- id:m100 topic:new at:2026-10-12 -->");
  const { entries } = parseMemory(joinLines(lines));
  const added = entries.find((e) => e.id === "m100");
  assert.equal(added.section, "约定");
  // 应该排在 m002 之后，而不是跑进别的段。
  const order = entries.map((e) => e.id);
  assert.equal(order.indexOf("m100"), order.indexOf("m002") + 1);
});

test("insertEntry 在段不存在时创建新段", () => {
  const parsed = parseMemory(SAMPLE);
  const lines = insertEntry(parsed, "新分类", "- 条目 <!-- id:m101 topic:x at:2026-10-12 -->");
  const { entries, sections } = parseMemory(joinLines(lines));
  assert.equal(sections.some((s) => s.name === "新分类"), true);
  assert.equal(entries.find((e) => e.id === "m101").section, "新分类");
});

test("insertEntry 不改动入参", () => {
  const parsed = parseMemory(SAMPLE);
  const before = [...parsed.lines];
  insertEntry(parsed, "约定", "- x <!-- id:m102 topic:y at:2026-10-12 -->");
  assert.deepEqual(parsed.lines, before);
});

test("replaceLine 与 removeLine 按行号工作", () => {
  const parsed = parseMemory(SAMPLE);
  const target = parsed.entries[0];

  const replaced = replaceLine(parsed.lines, target.lineIndex, "- 改过了 <!-- id:m001 topic:indent-style at:2026-10-05 -->");
  assert.equal(parseMemory(joinLines(replaced)).entries[0].content, "改过了");

  const removed = removeLine(parsed.lines, target.lineIndex);
  assert.equal(parseMemory(joinLines(removed)).entries.some((e) => e.id === "m001"), false);
  assert.equal(parseMemory(joinLines(removed)).entries.length, 3);
});

test("replaceLine / removeLine 越界时安全返回", () => {
  const lines = ["a", "b"];
  assert.deepEqual(replaceLine(lines, 99, "x"), ["a", "b"]);
  assert.deepEqual(removeLine(lines, -1), ["a", "b"]);
});

test("collapseBlankLines 压缩连续空行并去首尾", () => {
  assert.deepEqual(collapseBlankLines(["", "a", "", "", "b", ""]), ["a", "", "b"]);
});

test("空输入与纯空白输入不抛错", () => {
  assert.deepEqual(parseMemory("").entries, []);
  assert.deepEqual(parseMemory(null).entries, []);
  assert.deepEqual(parseMemory("   \n  \n").entries, []);
});

test("CRLF 换行也能解析", () => {
  const crlf = "## 段\r\n- 条目 <!-- id:m001 topic:a at:2026-10-12 -->\r\n";
  const { entries } = parseMemory(crlf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "条目");
});

test("解析出 area（工作空间）维度", () => {
  const { entries } = parseMemory("## 段\n- 条目 <!-- id:m001 topic:a at:2026-10-12 area:backend -->\n");
  assert.equal(entries[0].area, "backend");
  // 没有 area 元数据时返回 null，而不是空串。
  const { entries: none } = parseMemory("## 段\n- 条目 <!-- id:m002 topic:b at:2026-10-12 -->\n");
  assert.equal(none[0].area, null);
});

test("formatEntry 含 area 且往返一致", () => {
  const line = formatEntry({ id: "m001", topic: "a", at: "2026-10-12", content: "正文", area: "frontend" });
  assert.equal(line.includes("area:frontend"), true);
  const { entries } = parseMemory(`## 段\n${line}\n`);
  assert.equal(entries[0].area, "frontend");

  // area 为空时不写入元数据。
  const noArea = formatEntry({ id: "m002", topic: "b", at: "2026-10-12", content: "正文" });
  assert.equal(/area:/.test(noArea), false);
});
