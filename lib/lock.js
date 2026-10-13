/**
 * 进程内的「按文件串行化」锁。
 *
 * **为什么需要。** 记忆文件的写入都是「读 → 改 → 写」。`store.js` 的 `writeAtomic`
 * 只保证「不会写半截」，它管不了丢更新：两个写入口各自读到同一版本、各自改，
 * 后写的会把先写的整个覆盖掉 —— 而两次调用都会返回成功。这个 bug 不报错、
 * 不打日志，只是悄悄少一条记忆。
 *
 * 本插件确实有多个写入口，而且它们会撞：
 *   - 模型的 `memory_save`（lib/save.js）
 *   - 设置面板的 `edit`（lib/ui/write.js）与 `resolve`（lib/ui/resolve.js）
 * 两个入口都读写同一份 `<scope>/MEMORY.md`。
 *
 * **为什么进程内锁就够。** 上面两个入口都跑在**同一个 DSH 宿主进程**里 ——
 * 面板的 RPC handler 也是宿主侧挂上去的，不是另一个进程。所以一个进程内的
 * promise 队列就能把「读 → 改 → 写」串起来，不需要跨进程文件锁。
 *
 * **边界（写清楚，免得被当成万能）。** 这只覆盖同一进程。如果将来出现多个进程
 * 同时打开同一个工作区（比如同时跑两个 DSH 实例指向同一个目录），这里挡不住 ——
 * 那时才需要 OS 级文件锁，或者「写前比对 hash + 失败重试」的乐观并发。
 *
 * **key 怎么选。** 用目标文件的**绝对路径**（`resolveMemoryPaths(...).file`），
 * 不要用相对路径或 `cwd` —— 同一份文件在不同写法下必须是同一把锁。project 与
 * user 两个作用域路径天然不同，所以自动各排各的队，互不阻塞。
 *
 * 本文件不依赖 DSH 运行时，也不做任何 IO，可以独立单测。
 */

/** 每个 key 上「已排队任务的尾巴」。值恒为一个不会 reject 的 Promise。 */
const chains = new Map();

/**
 * 串行执行 `fn`：同一个 `key` 上的调用按调用顺序排队，前一个（无论成败）完成后
 * 才轮到下一个。不同 `key` 之间互不阻塞。
 *
 * @template T
 * @param {string} key - 串行化键（用目标文件的绝对路径）。
 * @param {() => Promise<T>|T} fn - 临界区。「读 → 改 → 写」整个区间都要包进来，
 *   不能只包写 —— 否则两个任务仍会读到同一个旧版本。
 * @returns {Promise<T>} `fn` 的返回值；`fn` 抛错时照常向上抛，且不阻塞队列。
 */
export function withFileLock(key, fn) {
  const k = String(key);
  const prev = chains.get(k) ?? Promise.resolve();

  // prev 永远不 reject（见下面的 settled），所以只需一个成功分支。
  const run = prev.then(() => fn());

  // 队列尾巴：吞掉成败，只用来表示「轮到下一个了」。吞掉是必须的 ——
  // 否则一个失败的任务会把后面整条链都带崩。
  const settled = run.then(
    () => {},
    () => {},
  );
  chains.set(k, settled);
  // 只有自己仍是尾巴时才清理，避免把后来者的链头删掉（那会导致两个任务并行）。
  void settled.then(() => {
    if (chains.get(k) === settled) chains.delete(k);
  });

  return run;
}

/**
 * 当前仍被记住的锁数量。仅用于诊断与测试（验证空闲后不残留）。
 * @returns {number} 锁表大小。
 */
export function lockCount() {
  return chains.size;
}
