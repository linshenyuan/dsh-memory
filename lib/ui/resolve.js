/**
 * 冲突裁决的写回。
 *
 * 面板上给四个选项，这里把它们翻译成对 MEMORY.md 的行级编辑：
 *
 *   keep-a     只留 A（按日期排最早的那条，通常就是原来在用的）
 *   keep-b     只留 B（最新的那条，通常是本次想写进来的）
 *   keep-both  两条都留（「都对，只是语境不同」）
 *   later      不动文件 —— 纯粹是「我看到了，先放着」
 *
 * 三个约束：
 *
 * 1. **只改该改的行。** 复用 parse.js 的行级编辑，不重写整个文件 —— 用户可能在
 *    文件里写了额外的说明文字、自定义段标题、注释，整文件重写会把这些全抹掉。
 *
 * 2. **裁决结果必须可被下次解析认出来。** 保留的条目去掉 `[待裁决]` 和
 *    `conflict-with` 两个标记，这样下次启动扫描时它们就是普通条目 ——
 *    「已裁决」这个状态不需要额外存储，文件本身就是状态。
 *
 * 3. **`later` 不写盘。** 不给「稍后」留任何痕迹，否则每次点它都产生一条审计，
 *    把真正有价值的记录淹掉。
 *
 * 本文件**不依赖 DSH 运行时**，读写函数由调用方注入，可以独立单测。
 */
import { appendRun } from "../audit.js";
import { collectConflicts } from "../detect.js";
import { formatEntry, joinLines, parseMemory, removeLine, replaceLine } from "../parse.js";
import { resolveMemoryPaths } from "../paths.js";
import { rebuildConflicts } from "../save.js";

/** 面板给的四个裁决动作。 */
export const ACTIONS = Object.freeze(["keep-a", "keep-b", "keep-both", "later"]);

/**
 * 把一组冲突里的条目按日期升序排，和面板的 A / B 定义保持一致。
 *
 * 这个函数和 lib/ui/data.js 里的排序必须同步 —— 否则面板上显示的 A 和真正被保留
 * 的那条会是两条不同的记忆，而且看不出来。所以两边用同一套判据：有日期的按日期，
 * 没日期的排最后。
 *
 * @param {object[]} items - 组内条目。
 * @returns {object[]} 升序排列的新数组。
 */
function orderGroup(items) {
  return [...items].sort((x, y) => {
    const ax = typeof x.at === "string" && x.at !== "" ? x.at : "9999-99-99";
    const ay = typeof y.at === "string" && y.at !== "" ? y.at : "9999-99-99";
    return ax < ay ? -1 : ax > ay ? 1 : 0;
  });
}

/**
 * 在解析结果里找出某个 topic 的待裁决组。
 *
 * @param {object[]} entries - parseMemory 的条目。
 * @param {string} topic - 目标 topic。
 * @returns {{pending: object, others: object[]}|null} 冲突组；找不到返回 null。
 */
function findGroup(entries, topic) {
  const groups = collectConflicts(entries);
  return groups.find((g) => g.topic === topic) ?? null;
}

/**
 * 执行一次裁决。
 *
 * @param {object} options
 * @param {object} options.cfg - 归一化配置。
 * @param {string} options.cwd - 工作目录。
 * @param {"project"|"user"} options.scope - 作用域。
 * @param {string} options.topic - 冲突的 topic。
 * @param {string} options.action - `keep-a` / `keep-b` / `keep-both` / `later`。
 * @param {(path: string) => Promise<string|null>} options.readText - 读文件。
 * @param {(path: string, text: string) => Promise<void>} options.writeText - 原子写。
 * @param {string} [options.now] - 当前时间 ISO 串（注入以便测试）。
 * @param {object|null} [options.logger] - 可选 logger。
 * @returns {Promise<{ok: boolean, action: string, message: string,
 *                    kept?: string[], dropped?: string[]}>}
 */
export async function resolveConflict({
  cfg,
  cwd,
  scope,
  topic,
  action,
  readText,
  writeText,
  now = new Date().toISOString(),
  logger = null,
}) {
  if (!ACTIONS.includes(action)) {
    return { ok: false, action, message: `未知的裁决动作: ${String(action)}` };
  }
  if (typeof topic !== "string" || topic.trim() === "") {
    return { ok: false, action, message: "缺少 topic，无法定位要裁决的冲突。" };
  }

  // 「稍后」到此为止：不读文件、不写文件、不留审计。
  if (action === "later") {
    return { ok: true, action, message: "已标记为稍后处理，文件未改动。", kept: [], dropped: [] };
  }

  const paths = resolveMemoryPaths(cwd, scope === "user" ? "user" : "project", cfg);

  let text;
  try {
    text = await readText(paths.file);
  } catch (error) {
    return { ok: false, action, message: `读取 ${paths.displayPath} 失败: ${String(error)}` };
  }
  if (text === null || text === undefined || text === "") {
    return { ok: false, action, message: `${paths.displayPath} 不存在或为空，没有可裁决的内容。` };
  }

  const parsed = parseMemory(text);
  const group = findGroup(parsed.entries, topic);
  if (group === null) {
    // 竞态很常见：另一次写入或人工编辑已经把这组冲突解掉了。这不是错误。
    return {
      ok: false,
      action,
      message: `topic「${topic}」下已经没有待裁决的条目了（可能已被其他改动解决）。`,
    };
  }

  const ordered = orderGroup([group.pending, ...group.others]);
  const a = ordered[0];
  const b = ordered[ordered.length - 1];
  // 只有一条时 A 和 B 是同一条 —— 三个「保留」动作等价，都只是去掉标记。
  const same = a.id !== null && a.id === b.id;

  /** 按动作算出要保留的 id 集合。 */
  const keepIds = new Set();
  if (action === "keep-both" || same) {
    for (const item of ordered) if (item.id !== null) keepIds.add(item.id);
  } else if (action === "keep-a") {
    if (a.id !== null) keepIds.add(a.id);
  } else {
    if (b.id !== null) keepIds.add(b.id);
  }

  // 没有 id 的条目没法被 id 定位（模型漏写元数据时会这样）。这类条目一律保留：
  // 删掉一条无法定位的内容，风险远大于留着。
  const keep = ordered.filter((item) => item.id === null || keepIds.has(item.id));
  const drop = ordered.filter((item) => item.id !== null && !keepIds.has(item.id));

  let lines = parsed.lines;

  // 第一步：保留的条目重写成「普通条目」—— 去掉 [待裁决] 与 conflict-with。
  // 必须在删除之前做：重写不改变行数，行号仍然有效；反过来就会错位。
  for (const item of keep) {
    lines = replaceLine(
      lines,
      item.lineIndex,
      formatEntry({
        id: item.id,
        topic: item.topic,
        at: item.at,
        content: item.content,
        pending: false,
        conflictWith: null,
      }),
    );
  }

  // 第二步：删除被放弃的条目。**降序删**，否则删掉一行之后后面的行号全部前移。
  for (const item of [...drop].sort((x, y) => y.lineIndex - x.lineIndex)) {
    lines = removeLine(lines, item.lineIndex);
  }

  const next = joinLines(lines);

  try {
    await writeText(paths.file, next);
  } catch (error) {
    return { ok: false, action, message: `写入 ${paths.displayPath} 失败: ${String(error)}` };
  }

  // 派生视图跟着更新；失败只 warn，不影响已经落盘的裁决。
  await rebuildConflicts(paths, next, now, logger);

  const keptIds = keep.map((e) => e.id).filter((id) => id !== null);
  const droppedIds = drop.map((e) => e.id).filter((id) => id !== null);

  if (cfg?.auditEnabled !== false) {
    await appendRun(
      paths.runs,
      {
        at: now,
        op: "resolve",
        id: keptIds[0] ?? null,
        topic,
        by: "user",
        action,
        scope: paths.scope,
        // 字段名必须和 lib/audit.js 的 `replay` 对齐：它读的是逗号分隔的
        // `keep` / `drop` 两个**字符串**。写成 `kept` / `dropped` 数组的话
        // 流水照样能写进去、面板照样能显示，但启动自检重放时会把「被删掉的
        // 条目」当成还在，报一堆假的 orphan —— 这种错不报错，只是悄悄把
        // 自检变成噪音。
        keep: keptIds.join(","),
        drop: droppedIds.join(","),
      },
      logger,
    );
  }

  const summary =
    droppedIds.length === 0
      ? `已确认保留 ${keptIds.length} 条。`
      : `保留 ${keptIds.join("、") || "0 条"}，移除 ${droppedIds.join("、")}。`;

  return { ok: true, action, message: summary, kept: keptIds, dropped: droppedIds };
}
