/**
 * 设置面板的数据聚合。
 *
 * 面板要四个视图 —— 浏览 / 用量 / 冲突 / 审计 —— 但它们读的是同一份磁盘状态。
 * 所以只做**一次**聚合，四个视图各取所需。理由不只是省 IO：
 *
 * 1. **一致性。** 分四次读文件，用户点开「用量」和点开「冲突」看到的可能是两个
 *    不同时刻的状态。一次快照 + 一个 generatedAt，四个视图说的是同一件事。
 *
 * 2. **面板是只读的。** 聚合过程不写任何文件 —— 没有副作用，可以随便刷新。
 *
 * 3. **fail-open 照旧。** 某个作用域读不到、解析不了，就在结果里标出来，绝不让
 *    整个面板空白。用户最需要看到面板的时候，恰恰是文件被写坏的时候。
 *
 * 本文件**不依赖 DSH 运行时**，readText 由调用方注入，可以独立单测。
 */
import { replay, readRuns, verifyReplay } from "../audit.js";
import { DEFAULTS } from "../config.js";
import { collectConflicts, countBySection } from "../detect.js";
import { parseMemory } from "../parse.js";
import { resolveMemoryPaths } from "../paths.js";
import { byteLength } from "../truncate.js";

/** 审计视图一次最多带多少条记录。多了前端也没人看，还会把响应撑大。 */
const MAX_RUNS = 100;

/** 浏览视图里单条正文的展示上限（字符）。文件里仍是全文，这只是传输裁剪。 */
const MAX_CONTENT_CHARS = 2000;

/**
 * 把一条正文裁到展示上限。
 *
 * 这里按**字符**裁而不是字节：面板数据走 JSON，不参与模型上下文，切坏一个
 * emoji 不会污染会话 —— 那是注入路径才有的问题（见 lib/truncate.js）。
 *
 * @param {unknown} content - 原始正文。
 * @returns {string} 裁剪后的正文。
 */
function clip(content) {
  const text = String(content ?? "");
  return text.length <= MAX_CONTENT_CHARS ? text : `${text.slice(0, MAX_CONTENT_CHARS)}…`;
}

/**
 * 把内部条目投影成面板要的形状。
 *
 * 只带前端用得上的字段。`lineIndex` / `indent` / `hash` 这些编辑期的东西不外传 ——
 * 面板按 id 定位条目，行号是实现细节。
 *
 * @param {object} entry - parseMemory 的条目。
 * @returns {object} 面板条目。
 */
function entryView(entry) {
  return {
    id: entry.id,
    topic: entry.topic,
    at: entry.at,
    section: entry.section,
    area: entry.area ?? null,
    pending: entry.pending === true,
    conflictWith: entry.conflictWith,
    content: clip(entry.content),
  };
}

/**
 * 把一组冲突整理成「A / B」两方。
 *
 * A / B 的定义必须确定，否则「保留 A」这句话没有意义。这里按 `at` 升序排：
 * **A = 最早的那条**（通常是已经在用的），**B = 最新的那条**（通常是本次想写进来
 * 的）。没有日期的一律排在最后 —— 缺日期说明是手写的，按「新」处理更安全。
 *
 * 只有一条时 A 和 B 指向同一条，面板会识别出来并只给两个选项。
 *
 * @param {object} group - collectConflicts 的一组。
 * @returns {object} 面板冲突组。
 */
function conflictView(group) {
  const all = [group.pending, ...group.others].filter((e) => e !== undefined && e !== null);
  const ordered = [...all].sort((x, y) => {
    const ax = typeof x.at === "string" && x.at !== "" ? x.at : "9999-99-99";
    const ay = typeof y.at === "string" && y.at !== "" ? y.at : "9999-99-99";
    return ax < ay ? -1 : ax > ay ? 1 : 0;
  });
  return {
    topic: group.topic,
    a: entryView(ordered[0]),
    b: entryView(ordered[ordered.length - 1]),
    others: ordered.slice(1, -1).map(entryView),
    count: ordered.length,
  };
}

/**
 * 收集一个作用域的全部面板数据。
 *
 * @param {string} cwd - 工作目录。
 * @param {"project"|"user"} scope - 作用域。
 * @param {object} cfg - 归一化配置。
 * @param {(path: string) => Promise<string|null>} readText - 读文件（注入以便测试）。
 * @returns {Promise<object>} 该作用域的面板数据。
 */
export async function collectScope(cwd, scope, cfg, readText) {
  const paths = resolveMemoryPaths(cwd, scope, cfg);
  const base = {
    scope: paths.scope,
    label: paths.label,
    displayPath: paths.displayPath,
    dirDisplay: paths.dirDisplay,
    file: paths.file,
    exists: false,
    bytes: 0,
    maxBytes: paths.maxBytes,
    entryCount: 0,
    sections: {},
    entries: [],
    conflicts: [],
    runs: [],
    runCount: 0,
    replay: null,
    error: null,
  };

  let text;
  try {
    text = await readText(paths.file);
  } catch (error) {
    return { ...base, error: `读取失败: ${String(error)}` };
  }
  if (text === null || text === undefined || text === "") {
    // 文件不存在不是错误 —— 新项目第一次打开面板就是这样。
    return base;
  }

  let parsed;
  try {
    parsed = parseMemory(text);
  } catch (error) {
    return { ...base, exists: true, error: `解析失败: ${String(error)}` };
  }

  const runs = await readRuns(paths.runs, MAX_RUNS);
  const groups = collectConflicts(parsed.entries);

  // 回放自检：流水重放出的 id 集合 vs 文件里实际存在的 id 集合。
  // 不一致是常态（手改文件是设计允许的），所以这里只如实报告，不做判断。
  let replayResult = null;
  try {
    if (runs.length > 0) {
      replayResult = verifyReplay(runs, parsed.entries);
    }
  } catch {
    replayResult = null;
  }

  return {
    ...base,
    exists: true,
    bytes: byteLength(text),
    entryCount: parsed.entries.length,
    sections: countBySection(parsed.entries),
    entries: parsed.entries.map(entryView),
    conflicts: groups.map(conflictView),
    runs: runs.map((run) => ({
      at: typeof run.at === "string" ? run.at : null,
      op: typeof run.op === "string" ? run.op : null,
      id: typeof run.id === "string" ? run.id : null,
      topic: typeof run.topic === "string" ? run.topic : null,
      by: typeof run.by === "string" ? run.by : null,
      scope: typeof run.scope === "string" ? run.scope : null,
    })),
    runCount: runs.length,
    replay: replayResult,
    error: null,
  };
}

/**
 * 聚合整个面板的数据。
 *
 * @param {{cwd: string, cfg: object,
 *          readText: (path: string) => Promise<string|null>}} options - 依赖。
 * @returns {Promise<object>} `{cwd, generatedAt, scopes, totals}`。
 */
export async function collectPanelData({ cwd, cfg, readText }) {
  const scopes = [];
  for (const scope of ["project", "user"]) {
    // 一个作用域炸了不该让另一个也看不到 —— collectScope 内部已经吞掉异常，
    // 这里再兜一层是为了防「它自己没兜住」。
    try {
      scopes.push(await collectScope(cwd, scope, cfg, readText));
    } catch (error) {
      scopes.push({
        scope,
        label: scope === "user" ? "用户" : "项目",
        displayPath: "",
        dirDisplay: "",
        exists: false,
        bytes: 0,
        maxBytes: 0,
        entryCount: 0,
        sections: {},
        entries: [],
        conflicts: [],
        runs: [],
        runCount: 0,
        replay: null,
        error: `聚合失败: ${String(error)}`,
      });
    }
  }

  return {
    cwd,
    generatedAt: new Date().toISOString(),
    scopes,
    // 面板的「设置」区要显示当前上限、以及「恢复默认」要跳回的值。
    // 由服务端给，避免客户端再写一遍默认值（两个真源）。
    limits: {
      current: { projectMaxBytes: cfg.projectMaxBytes, userMaxBytes: cfg.userMaxBytes },
      defaults: { projectMaxBytes: DEFAULTS.projectMaxBytes, userMaxBytes: DEFAULTS.userMaxBytes },
    },
    totals: {
      entries: scopes.reduce((sum, s) => sum + s.entryCount, 0),
      bytes: scopes.reduce((sum, s) => sum + s.bytes, 0),
      maxBytes: scopes.reduce((sum, s) => sum + s.maxBytes, 0),
      conflicts: scopes.reduce((sum, s) => sum + s.conflicts.length, 0),
      pending: scopes.reduce(
        (sum, s) => sum + s.entries.filter((e) => e.pending === true).length,
        0,
      ),
      runs: scopes.reduce((sum, s) => sum + s.runCount, 0),
    },
  };
}

/**
 * 重放审计流水，供「审计」视图做时间线（可选能力，面板暂未使用）。
 *
 * 导出它是为了让面板将来能加「按时刻回看」而不必再碰 audit.js —— 也顺便让
 * 单测能直接验证聚合层没有曲解 replay 的语义。
 *
 * @param {object[]} runs - 审计记录。
 * @returns {Array<{id: string, topic: string, status: string}>} 条目状态列表。
 */
export function replayEntries(runs) {
  const state = replay(runs ?? []);
  return [...state.entries()].map(([id, value]) => ({
    id,
    topic: value.topic,
    status: value.status,
  }));
}
