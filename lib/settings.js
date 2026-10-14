/**
 * 面板可改的设置（目前只有两个记忆上限）。
 *
 * **为什么不直接改 DSH 配置。** DSH 的 profile 配置由 DSH 自己管（写在
 * `cordis.patch.yml` 里），插件去写它有被覆盖、注释丢失的风险。所以面板改的值
 * 单独存一份覆盖文件，**优先级高于 DSH 配置**，DSH 配置退化成初始默认。
 *
 * 合并顺序（后者覆盖前者）：`DEFAULTS` ← `cordis.patch.yml` 的 config ← 本文件。
 *
 * 文件放在 `$DSH_HOME/dsh-memory.settings.json` —— 跟工作区无关，跨项目共用。
 * 读不到 / 解析不了一律当「没覆盖」（fail-open），绝不因为一个坏文件让插件起不来。
 *
 * 本文件**不依赖 DSH 运行时**，可以独立单测。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDshHome } from "./paths.js";
import { readText, writeAtomic } from "./store.js";

/** 覆盖文件名。 */
export const SETTINGS_FILE = "dsh-memory.settings.json";

/**
 * 面板**允许写**的键。这个文件是「面板专属」的：读和写都只认这几个键，
 * 其余键即便出现在文件里也一律忽略 —— 免得顺手就把落点
 * （`projectMemoryDir` 之类）改到别处去。
 */
export const PANEL_KEYS = Object.freeze(["projectMaxBytes", "userMaxBytes"]);

/** 上限取值范围（字节）。下限防止把记忆卡死，上限防止误填天文数字。 */
export const MIN_MAX_BYTES = 512;
export const MAX_MAX_BYTES = 1048576;

/**
 * 覆盖文件的绝对路径。
 * @returns {string} 绝对路径。
 */
export function settingsPath() {
  return join(resolveDshHome(), SETTINGS_FILE);
}

/**
 * 只保留 `PANEL_KEYS` 里的键 —— 拼错的、越权的键直接丢。
 * @param {unknown} raw - 任意值。
 * @returns {object} 过滤后的键值对。
 */
function pickPanel(raw) {
  const out = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const key of PANEL_KEYS) {
    const value = raw[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * 校验面板提交的上限：两个都必须给，且是范围内的整数。
 *
 * 只认数字类型 —— 面板的 `<input type="number">` 经 JSON 传过来就是 number，
 * 若收到字符串说明调用方写错了，直接拒，不做隐式转换。
 *
 * @param {object} input - `{projectMaxBytes, userMaxBytes}`。
 * @returns {{ok: true, value: object}|{ok: false, message: string}} 校验结果。
 */
export function validateLimits(input) {
  const out = {};
  for (const key of PANEL_KEYS) {
    const raw = input?.[key];
    const num = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isInteger(num)) {
      return { ok: false, message: `${key} 必须是整数（收到 ${JSON.stringify(raw)}）。` };
    }
    if (num < MIN_MAX_BYTES || num > MAX_MAX_BYTES) {
      return {
        ok: false,
        message: `${key} 需在 ${MIN_MAX_BYTES} ~ ${MAX_MAX_BYTES} 字节之间（收到 ${num}）。`,
      };
    }
    out[key] = num;
  }
  return { ok: true, value: out };
}

/**
 * 同步读覆盖文件。**只在插件加载时用一次** —— `apply()` 是同步的，而那时必须
 * 拿到已保存的值，异步读会有一个「首轮用了旧值」的窗口。文件很小，同步读无所谓。
 *
 * @param {string} [path] - 覆盖文件路径。
 * @returns {object} 键值对；读不到 / 解析不了返回 `{}`。
 */
export function readSettingsSync(path = settingsPath()) {
  try {
    return pickPanel(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/**
 * 异步读覆盖文件。
 * @param {string} [path] - 覆盖文件路径。
 * @returns {Promise<object>} 键值对；读不到 / 解析不了返回 `{}`。
 */
export async function readSettings(path = settingsPath()) {
  let text = null;
  try {
    text = await readText(path);
  } catch {
    return {};
  }
  if (text === null) return {};
  try {
    return pickPanel(JSON.parse(text));
  } catch {
    return {};
  }
}

/**
 * 合并写入覆盖文件（只写 `PANEL_KEYS` 里的键）。
 * @param {object} limits - `{projectMaxBytes, userMaxBytes}`。
 * @param {string} [path] - 覆盖文件路径。
 * @returns {Promise<object>} 写入后的完整覆盖内容。
 */
export async function writeSettings(limits, path = settingsPath()) {
  const current = await readSettings(path);
  const next = { ...current, ...pickPanel(limits) };
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
