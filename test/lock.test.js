/**
 * 进程内「按文件串行化」锁（lib/lock.js）的单元测试。
 *
 * 这把锁要挡的是「丢更新」：两个任务各自读到同一版本、各自改，后写的覆盖先写的。
 * 所以测试重点不是「fn 被调用了」，而是**顺序** —— 同一个 key 上，后一个必须等
 * 前一个**完全结束（含它的 await）**才开始；不同 key 之间则不能互相阻塞。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { lockCount, withFileLock } from "../lib/lock.js";

test("同一 key 上严格串行：后者等前者完全结束", async () => {
  const log = [];
  const first = withFileLock("k-serial", async () => {
    log.push("a:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.push("a:end");
    return "a";
  });
  const second = withFileLock("k-serial", async () => {
    log.push("b:start");
    return "b";
  });

  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(ra, "a");
  assert.equal(rb, "b");
  assert.deepEqual(log, ["a:start", "a:end", "b:start"], "b 不该在 a 结束前启动");
});

test("返回值原样透传", async () => {
  assert.equal(await withFileLock("k-ret", () => 42), 42);
  assert.deepEqual(await withFileLock("k-ret", async () => ({ x: 1 })), { x: 1 });
});

test("fn 抛错照常向上抛，且不卡住后面的任务", async () => {
  const log = [];
  const bad = withFileLock("k-err", async () => {
    throw new Error("boom");
  });
  const next = withFileLock("k-err", async () => {
    log.push("after");
    return "ok";
  });

  await assert.rejects(bad, /boom/);
  assert.equal(await next, "ok");
  assert.deepEqual(log, ["after"]);
});

test("不同 key 互不阻塞", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let bDone = false;

  const a = withFileLock("k-block", async () => {
    await gate;
    return "a";
  });
  const b = withFileLock("k-free", async () => {
    bDone = true;
    return "b";
  });

  // a 还卡在 gate 上，b 就应该已经能跑完 —— 说明两个 key 用的是两把锁。
  assert.equal(await b, "b");
  assert.equal(bDone, true);
  release();
  assert.equal(await a, "a");
});

test("多个任务排队时顺序不乱", async () => {
  const order = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      withFileLock("k-many", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(i);
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test("空闲后锁表不残留（不泄漏）", async () => {
  await withFileLock("k-gone", async () => 1);
  // 清理是在 settled 之后的微任务里做的，让出几拍再断言。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lockCount(), 0);
});
