/**
 * dsh-memory 配置的默认值与归一化。
 *
 * 设计原则：所有上限按**字节**配置，不按字符。
 *
 * 理由：DSH 官方的安全截断（truncateUtf8）是按字节做的，配置也用字节可以少一层
 * 字符/字节换算 —— 而换算正是「切坏一个 emoji 就毁掉整个会话」那类 bug 的温床。
 *
 * 本文件**不依赖 DSH 运行时**，可以独立测试。给 DSH 看的 schema 在 lib/schema.js。
 */

/** ≈ 3600 中文字符 / 约 1.2K tokens。参考 Hermes 的 2200+1375=3575。 */
const DEFAULT_MAX_BYTES = 10800;

/** 显式默认值。cordis 不保证把 schema 默认值填进 config，所以自己兜一层。 */
export const DEFAULTS = Object.freeze({
  // 落点
  projectMemoryDir: ".dsh-memory",
  userMemoryDir: "", // 空 = $DSH_HOME/memory
  projectFileName: "MEMORY.md",
  userFileName: "MEMORY.md",

  // 预算（字节）
  projectMaxBytes: DEFAULT_MAX_BYTES,
  userMaxBytes: DEFAULT_MAX_BYTES,

  // 开关
  writeReminder: true,
  conflictFreeze: true,
  sensitiveScan: true,
  auditEnabled: true,
  verifyOnStart: true,

  // 提醒调参
  remindAfterToolWrites: 3,
});

/**
 * 归一化配置。
 *
 * 只接受 DEFAULTS 里声明过的键 —— 未知键直接忽略，避免配置里塞了拼错的键却
 * 静默走了默认值（那种 bug 查起来很费劲）。
 *
 * **两个来源，后者覆盖前者**：`raw` 是 cordis 传进来的配置；`override` 是面板改过、
 * 存在覆盖文件里的值（见 lib/settings.js）。**面板优先** —— 用户刚在界面上点的值，
 * 不该被配置文件里的旧值盖掉。
 *
 * @param {object|null|undefined} raw - cordis 传进来的原始配置。
 * @param {object|null} [override] - 面板覆盖（同样只取 DEFAULTS 里声明过的键）。
 * @returns {object} 归一化后的配置；`userMemoryDir` 为 `null` 表示走 $DSH_HOME。
 */
export function resolveConfig(raw, override = null) {
  const cfg = { ...DEFAULTS };
  for (const source of [raw, override]) {
    if (source === null || typeof source !== "object") continue;
    for (const key of Object.keys(DEFAULTS)) {
      const value = source[key];
      if (value !== undefined && value !== null) cfg[key] = value;
    }
  }
  // 空字符串 = 没配，交给 paths.js 走 $DSH_HOME/memory。
  if (typeof cfg.userMemoryDir !== "string" || cfg.userMemoryDir.trim() === "") {
    cfg.userMemoryDir = null;
  }
  return cfg;
}
