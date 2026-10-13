import { strict as assert } from "node:assert";
import { test } from "node:test";

import { byteLength, truncateUtf8 } from "../lib/truncate.js";

test("未超限时原样返回", () => {
  const text = "hello 世界";
  assert.equal(truncateUtf8(text, 1000), text);
});

test("byteLength 按 UTF-8 字节算，不是 String.length", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("中"), 3);
  assert.equal("😀".length, 2);
  assert.equal(byteLength("😀"), 4);
});

test("不会切开多字节的中文字符", () => {
  const text = "中文中文中文"; // 每字 3 字节，共 18 字节
  const cut = truncateUtf8(text, 8);
  // 字节 0-5 是完整的「中文」，字节 6-8 是第三个字 → 8 落在第三个字中间。
  // 只能退到 6 字节，保留两个字。
  assert.equal(cut, "中文");
  assert.equal(byteLength(cut) <= 8, true);
  // 关键：结果必须是合法 UTF-8，能原样往返。
  assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);

  // 恰好落在字符边界上时不回退：6 字节就是「中文」的边界。
  assert.equal(truncateUtf8(text, 6), "中文");
  assert.equal(truncateUtf8(text, 3), "中");
  assert.equal(truncateUtf8(text, 2), "");
});

test("不会切开 emoji（代理对）—— 这是会话级不可逆损坏的来源", () => {
  const text = "😀😀😀😀"; // 每个 4 字节
  for (let limit = 0; limit <= 16; limit += 1) {
    const cut = truncateUtf8(text, limit);
    // 往返一致 = 没有产生孤立代理项。
    assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
    assert.equal(byteLength(cut) <= limit, true);
  }
});

test("按 UTF-16 截断会踩坑，按字节截断不会", () => {
  const text = "a😀b";
  // 反面教材：slice(0, 2) 把 emoji 切成两半。
  const naive = text.slice(0, 2);
  assert.equal(naive.length, 2);
  assert.notEqual(Buffer.from(naive, "utf8").toString("utf8"), naive);

  // 正确做法：截到 1 字节 → 只保留 "a"。
  assert.equal(truncateUtf8(text, 1), "a");
  // 截到 5 字节 → "a😀"。
  assert.equal(truncateUtf8(text, 5), "a😀");
});

test("limit 为 0 或负数时返回空串", () => {
  assert.equal(truncateUtf8("abc", 0), "");
  assert.equal(truncateUtf8("abc", -5), "");
});

test("对非字符串容错", () => {
  assert.equal(truncateUtf8(null, 10), "");
  assert.equal(truncateUtf8(undefined, 10), "");
});
