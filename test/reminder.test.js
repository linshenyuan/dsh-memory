import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_REMIND_THRESHOLD,
  REMINDER_TEXT,
  noteMemoryWrite,
  noteWrite,
  shouldRemind,
  stateOf,
} from "../lib/reminder.js";

/** 每个用例用一个全新的假 session —— 状态是挂在对象上的。 */
function fakeSession() {
  return {};
}

test("阈值之前不提醒", () => {
  const s = fakeSession();
  assert.equal(shouldRemind(s, 1, 3), false);
  noteWrite(s);
  assert.equal(shouldRemind(s, 2, 3), false);
  noteWrite(s);
  assert.equal(shouldRemind(s, 3, 3), false);
});

test("攒够阈值就提醒，并消费掉计数", () => {
  const s = fakeSession();
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);

  assert.equal(shouldRemind(s, 4, 3), true);
  assert.equal(stateOf(s).writes, 0);
  // 计数已清，同一个 step 不会再提醒。
  assert.equal(shouldRemind(s, 4, 3), false);
  assert.equal(shouldRemind(s, 5, 3), false);
});

test("同一个 step 最多提醒一次（防死循环）", () => {
  const s = fakeSession();
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);
  assert.equal(shouldRemind(s, 7, 3), true);

  // 模型回应提醒后又写了三个文件 —— 但仍在同一个 step 里，不该再提醒。
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);
  assert.equal(shouldRemind(s, 7, 3), false);
  // 进入下一个 step 才允许。
  assert.equal(shouldRemind(s, 8, 3), true);
});

test("写入记忆后计数清零（不再为已经写过的记忆重复提醒）", () => {
  const s = fakeSession();
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);
  // 攒够了，但模型自己先写了记忆。
  noteMemoryWrite(s);
  assert.equal(shouldRemind(s, 9, 3), false);
});

test("清零不影响防死循环的 step 标记", () => {
  const s = fakeSession();
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);
  assert.equal(shouldRemind(s, 2, 3), true);
  noteMemoryWrite(s);
  // step 2 已经提醒过，即使清零过也不该在同一个 step 再提醒。
  noteWrite(s);
  noteWrite(s);
  noteWrite(s);
  assert.equal(shouldRemind(s, 2, 3), false);
});

test("不同会话的状态互不影响", () => {
  const a = fakeSession();
  const b = fakeSession();
  noteWrite(a);
  noteWrite(a);
  noteWrite(a);
  assert.equal(shouldRemind(a, 1, 3), true);
  assert.equal(shouldRemind(b, 1, 3), false);
});

test("阈值可调：0 表示第一次检查就提醒，1 表示写过一个文件后提醒", () => {
  const s = fakeSession();
  assert.equal(shouldRemind(s, 1, 0), true);

  const t = fakeSession();
  assert.equal(shouldRemind(t, 1, 1), false);
  noteWrite(t);
  assert.equal(shouldRemind(t, 1, 1), true);
});

test("提醒文本必须说清「可以不写」和「别编造」", () => {
  // 这两句是设计的一部分：没有它们，模型会把提醒当成必须执行的指令，
  // 于是编造一条没用的记忆 —— 而它的代价是未来每个会话都要为它买单。
  assert.match(REMINDER_TEXT, /直接忽略这条提醒/);
  assert.match(REMINDER_TEXT, /不要为了回应这条提醒而编造记忆/);
  assert.match(REMINDER_TEXT, /memory_save/);
  assert.equal(DEFAULT_REMIND_THRESHOLD, 3);
});
