/**
 * 审计流水与回放。
 *
 * 为什么需要审计：写入准入层是「插件在改模型写的记忆」—— 去重会拒绝写入、冲突
 * 会打标记、裁决会删条目。没有记录的话，某天你发现「我明明记过的东西怎么没了」，
 * 就永远查不出是谁改的、什么时候改的、为什么改。
 *
 * 为什么不用数据库：`runs.jsonl` 一行一个 JSON，只追加不修改。丢了这个文件只丢
 * 审计（记忆本身还在 MEMORY.md 里），而 MEMORY.md 放在工作区里能直接进 Git ——
 * `git log` 就是比一张表更朴素也更可靠的审计链。
 *
 * op 取值：
 *   save      新建条目
 *   dedupe    命中内容指纹，拒绝写入
 *   conflict  同 topic 冲突，冻结待裁决
 *   update    覆盖同 topic 的已有条目
 *   resolve   裁决完成
 *   delete    用户在面板里直接删掉一条（与 resolve 的「drop」等价，只是来源不同）
 *   archive   归档
 *   reject    写入被拒（空内容 / 超预算）
 */
import { appendLine, readText } from "./store.js";

/** 审计里出现的全部操作类型。 */
export const OPS = Object.freeze([
  "save",
  "dedupe",
  "conflict",
  "update",
  "resolve",
  "delete",
  "archive",
  "reject",
]);

/**
 * 追加一条审计记录。
 *
 * 审计是**旁路**：写失败只 warn，绝不影响记忆功能本身。这条是硬规则 ——
 * 记录失败不该让写入变成不可用。
 *
 * @param {string} runsPath - runs.jsonl 路径。
 * @param {object} entry - 记录内容（至少含 op）。
 * @param {object|null} [logger] - 可选 logger。
 * @returns {Promise<boolean>} 是否写入成功。
 */
export async function appendRun(runsPath, entry, logger = null) {
  let line;
  try {
    line = JSON.stringify(entry);
  } catch (error) {
    try {
      logger?.warn?.(`dsh-memory: 审计记录无法序列化: ${String(error)}`);
    } catch {
      // ignore
    }
    return false;
  }
  return appendLine(runsPath, line, logger);
}

/**
 * 读取最近的审计记录。
 *
 * 坏行直接跳过 —— 审计流水不该因为一行损坏就整个读不出来。
 *
 * @param {string} runsPath - runs.jsonl 路径。
 * @param {number} [limit] - 最多读多少条（从最新的往前取）；<=0 表示全部。
 * @returns {Promise<object[]>} 按时间正序的记录数组。
 */
export async function readRuns(runsPath, limit = 200) {
  let text;
  try {
    text = await readText(runsPath);
  } catch {
    return [];
  }
  if (text === null || text === "") return [];

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const slice = limit > 0 ? lines.slice(-limit) : lines;

  const runs = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") runs.push(parsed);
    } catch {
      // 坏行跳过。
    }
  }
  return runs;
}

/**
 * 从 ops 序列重建记忆库状态。
 *
 * 纯函数，不碰磁盘 —— 这是「可回放」的全部实现。
 *
 * 实际用途是**启动自检**：用 runs.jsonl 重放出的 id 集合，与 MEMORY.md 里实际
 * 存在的 id 集合对比。不一致说明有人手改了文件（正常），或者流水与文件脱节了
 * （要警告）。零成本的完整性检查。
 *
 * @param {object[]} runs - readRuns 的结果（按时间正序）。
 * @param {{upto?: string|null}} [options] - `upto` 为 ISO 时间串，只回放该时刻之前的记录。
 * @returns {Map<string, {topic: string, hash: string|null, status: string}>}
 *          条目 id → 状态。status 取值：active / pending / archived。
 */
export function replay(runs, { upto = null } = {}) {
  const state = new Map();
  if (!Array.isArray(runs)) return state;

  for (const run of runs) {
    if (run === null || typeof run !== "object") continue;
    const at = typeof run.at === "string" ? run.at : null;
    if (upto !== null && at !== null && at > upto) break;

    switch (run.op) {
      case "save":
      case "update":
        if (typeof run.id === "string") {
          state.set(run.id, {
            topic: run.topic ?? null,
            hash: run.hash ?? null,
            status: "active",
          });
        }
        break;

      case "conflict":
        if (typeof run.id === "string") {
          state.set(run.id, {
            topic: run.topic ?? null,
            hash: run.hash ?? null,
            status: "pending",
          });
        }
        break;

      case "resolve": {
        const drop = String(run.drop ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const id of drop) state.delete(id);
        const keep = String(run.keep ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const id of keep) {
          const prev = state.get(id);
          if (prev !== undefined) state.set(id, { ...prev, status: "active" });
        }
        break;
      }

      case "delete":
        if (typeof run.id === "string") state.delete(run.id);
        break;

      case "archive":
        if (typeof run.id === "string" && state.has(run.id)) {
          state.set(run.id, { ...state.get(run.id), status: "archived" });
        }
        break;

      case "dedupe":
      case "reject":
        // 没有落库，状态不变。
        break;

      default:
        // 未知 op 跳过 —— 将来加了新 op，旧版本读新流水也不该炸。
        break;
    }
  }

  return state;
}

/**
 * 用重放结果校验 MEMORY.md 的实际内容。
 *
 * @param {object[]} runs - 审计流水。
 * @param {Array<{id: string|null, pending: boolean}>} entries - 当前解析出的条目。
 * @returns {{ok: boolean, missing: string[], orphan: string[]}}
 *          `missing` = 文件里有但流水里没有（大概率是手工加的）；
 *          `orphan`  = 流水里有但文件里没有（被手工删了，或流水与文件脱节）。
 */
export function verifyReplay(runs, entries) {
  const state = replay(runs);
  const fileIds = new Set();
  for (const entry of entries) {
    if (entry.id !== null) fileIds.add(entry.id);
  }

  const missing = [];
  for (const id of fileIds) {
    if (!state.has(id)) missing.push(id);
  }

  const orphan = [];
  for (const [id, info] of state) {
    if (info.status === "active" && !fileIds.has(id)) orphan.push(id);
  }

  return {
    ok: missing.length === 0 && orphan.length === 0,
    missing: missing.sort(),
    orphan: orphan.sort(),
  };
}
