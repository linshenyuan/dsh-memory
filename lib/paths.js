/**
 * 记忆落点解析。
 *
 * 两个作用域：
 *   - project：跟随工作区，可提交进 Git（审计靠 git log）
 *   - user：跨项目，放 $DSH_HOME/memory
 *
 * 为什么不把用户级也放进工作区：它是跨项目的偏好，不该跟着某个仓库走。
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/**
 * 解析 DSH home。
 *
 * 优先环境变量，回退 `~/.dsh`。不走 `@deepseek-ai/dsh-home-paths` 是为了保持
 * **零 peer 依赖** —— 如果 DSH 的 home 不在默认位置，用 `userMemoryDir` 配置覆盖即可。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "") return resolve(env.trim());
  return join(homedir(), ".dsh");
}

/**
 * 把绝对路径压成给人看的形式。
 *
 * 优先级：**工作区内 → 相对路径**，其次 home 下 → `~`，最后原样输出。
 *
 * 为什么工作区优先：这个字符串会进注入上下文，而模型最需要知道的是「它在你的
 * 工作目录里」。`~/projects/foo/.dsh-memory/MEMORY.md` 和
 * `.dsh-memory/MEMORY.md` 指向同一个地方，但后者直接说明了它和当前
 * 项目的从属关系。
 *
 * @param {string} abs - 绝对路径。
 * @param {string} [cwd] - 工作目录。
 * @returns {string} 显示用路径（正斜杠）。
 */
export function displayPath(abs, cwd) {
  if (typeof cwd === "string" && cwd !== "") {
    const rel = relative(cwd, abs);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return rel.split(sep).join("/");
    }
  }
  const home = homedir();
  if (abs === home || abs.startsWith(home + sep)) {
    return `~${abs.slice(home.length).split(sep).join("/")}`;
  }
  return abs.split(sep).join("/");
}

/**
 * 解析一个作用域下的全部落点。
 *
 * 相对路径的基准不一样，这是有意的：
 *   - `projectMemoryDir` 相对**工作区** —— 它就该跟着仓库走
 *   - `userMemoryDir` 相对 **`$DSH_HOME`** —— 它是跨项目的东西，相对工作区没有意义
 *
 * 如果让 `userMemoryDir` 也相对工作区，那么换个项目打开，用户级记忆就换了一份，
 * 而且「相对路径」会隐式地跟着 `process.cwd()` 跑 —— 那种行为极难排查。
 *
 * @param {string} cwd - 工作目录。
 * @param {"project"|"user"} scope - 作用域。
 * @param {object} cfg - 归一化配置。
 * @returns {{scope: string, dir: string, file: string, conflicts: string,
 *            runs: string, displayPath: string, dirDisplay: string,
 *            maxBytes: number, label: string}}
 */
export function resolveMemoryPaths(cwd, scope, cfg) {
  const isUser = scope === "user";
  const dir = isUser
    ? resolve(resolveDshHome(), cfg.userMemoryDir ?? "memory")
    : resolve(cwd, cfg.projectMemoryDir);
  const file = join(dir, isUser ? cfg.userFileName : cfg.projectFileName);
  return {
    scope: isUser ? "user" : "project",
    dir,
    file,
    conflicts: join(dir, "CONFLICTS.md"),
    runs: join(dir, "runs.jsonl"),
    displayPath: displayPath(file, cwd),
    dirDisplay: displayPath(dir, cwd),
    maxBytes: isUser ? cfg.userMaxBytes : cfg.projectMaxBytes,
    label: isUser ? "用户" : "项目",
  };
}

/**
 * 判断某个路径是否落在记忆目录内。
 *
 * 用途：L3 提醒的触发条件要区分「干了实事」（改项目文件）和「在写记忆」。
 * 写记忆本身不该触发提醒，否则写完又被提醒，无限循环。
 *
 * @param {string} candidate - 待判断的路径（可能是相对路径）。
 * @param {string} cwd - 工作目录。
 * @param {object} cfg - 归一化配置。
 * @returns {boolean} 是否在记忆目录内。
 */
export function isMemoryPath(candidate, cwd, cfg) {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
  for (const scope of ["project", "user"]) {
    const p = resolveMemoryPaths(cwd, scope, cfg);
    if (abs === p.file || abs === p.conflicts || abs === p.runs) return true;
    // 目录内的一切（含每日日志 YYYY-MM-DD.md）都算记忆文件。
    if (abs.startsWith(p.dir + sep)) return true;
  }
  return false;
}
