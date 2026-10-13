import { strict as assert } from "node:assert";
import { test } from "node:test";

import { contentHashOf, normalizeForHash, shortHash, topicKey } from "../lib/hash.js";

test("normalizeForHash 折掉大小写、标点、空白差异", () => {
  assert.equal(normalizeForHash("Hello, World!"), "hello world");
  assert.equal(normalizeForHash("  hello   world  "), "hello world");
  assert.equal(normalizeForHash("Hello，World。"), "helloworld");
});

test("normalizeForHash 做 NFKC 归一", () => {
  // 全角 → 半角。
  assert.equal(normalizeForHash("ＡＢＣ１２３"), "abc123");
});

test("normalizeForHash 对非字符串容错", () => {
  assert.equal(normalizeForHash(null), "");
  assert.equal(normalizeForHash(undefined), "");
  assert.equal(normalizeForHash(123), "123");
});

test("contentHashOf 对相同内容给出相同指纹", () => {
  const a = contentHashOf("indent-style", "缩进用 4 空格。");
  const b = contentHashOf("Indent-Style", "缩进用 4 空格");
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("contentHashOf 对 topic 或内容不同给出不同指纹", () => {
  const base = contentHashOf("topic-a", "同样的内容");
  assert.notEqual(base, contentHashOf("topic-b", "同样的内容"));
  assert.notEqual(base, contentHashOf("topic-a", "不同的内容"));
});

test("contentHashOf 在两者都为空时返回 null", () => {
  assert.equal(contentHashOf("", ""), null);
  assert.equal(contentHashOf("   ", "..."), null);
});

test("contentHashOf 用 NUL 分隔，避免边界拼接歧义", () => {
  // "ab" + "c" 与 "a" + "bc" 必须不同。
  assert.notEqual(contentHashOf("ab", "c"), contentHashOf("a", "bc"));
});

test("shortHash 截前 12 位", () => {
  assert.equal(shortHash("0123456789abcdef"), "0123456789ab");
  assert.equal(shortHash(null), "");
});

test("topicKey 与哈希用同一套口径", () => {
  // 口径不一致会产生自相矛盾的判定：指纹说「同一条」，topic 比较说「不同话题」，
  // 于是同一条内容被反复写入。
  assert.equal(topicKey("Indent-Style"), topicKey("indent-style"));
  assert.equal(topicKey("indent style"), topicKey("indent-style"));
  assert.equal(topicKey("ＫＶ－ＣＡＣＨＥ"), topicKey("kv-cache"));
  assert.notEqual(topicKey("topic-a"), topicKey("topic-b"));
});

test("topicKey 对空 topic 返回空串（表示不参与同话题判定）", () => {
  assert.equal(topicKey(""), "");
  assert.equal(topicKey("   "), "");
  assert.equal(topicKey(null), "");
  assert.equal(topicKey(undefined), "");
  assert.equal(topicKey("..."), "");
});
