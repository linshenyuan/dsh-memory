/**
 * 文件读写。全部是纯 IO，不含任何业务判断。
 *
 * 两条硬规则：
 *
 * 1. **写必须原子。** 直接 `writeFile` 写到一半崩掉，MEMORY.md 就被截断了 ——
 *    整个记忆库当场消失。做法是写临时文件再 `rename`：同目录保证同分区，
 *    rename 在同分区上是原子的，要么旧内容要么新内容，没有中间态。
 *
 * 2. **读失败必须区分「不存在」和「读不了」。** 不存在是正常的（第一次用还没
 *    文件），返回 null；读不了（权限、磁盘错）要抛出去让调用方决定怎么降级。
 *    把两者混成一个 null 会让真实故障被静默吞掉。
 */
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 读文本文件。
 *
 * @param {string} path - 文件路径。
 * @returns {Promise<string|null>} 文件内容；不存在时 null。
 * @throws {Error} 存在但读不了时抛出（调用方自行降级）。
 */
export async function readText(path) {
  try {
    const text = await readFile(path, "utf8");
    // 去掉 BOM —— 有些 Windows 编辑器会加，留着会让第一行匹配不上。
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * 原子写文本文件。
 *
 * @param {string} path - 目标路径。
 * @param {string} text - 内容。
 * @returns {Promise<void>}
 */
export async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (error) {
    // Windows 上目标被占用时 rename 可能抛 EPERM；先删目标再试一次。
    if (error?.code === "EPERM" || error?.code === "EEXIST" || error?.code === "EACCES") {
      try {
        await unlink(path);
        await rename(tmp, path);
        return;
      } catch {
        // 落到下面的清理逻辑。
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // 清理失败不掩盖真正的错误。
    }
    throw error;
  }
}

/**
 * 追加一行（用于 runs.jsonl）。
 *
 * 不用 writeAtomic：审计是「只追加、永不修改」的流水，追加语义本身就该是原子的
 * 小写入。而且它写失败不该影响任何别的东西，所以这里吞掉异常只报告。
 *
 * @param {string} path - 文件路径。
 * @param {string} line - 一行内容（不含换行）。
 * @param {object|null} [logger] - 可选 logger。
 * @returns {Promise<boolean>} 是否写入成功。
 */
export async function appendLine(path, line, logger = null) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
    return true;
  } catch (error) {
    try {
      logger?.warn?.(`dsh-memory: 追加失败 ${path}: ${String(error)}`);
    } catch {
      // logger 自己坏了也不能往上抛 —— 审计是旁路。
    }
    return false;
  }
}

/**
 * 文件是否已存在（用于「首次创建」的判断）。
 * @param {string} path - 路径。
 * @returns {Promise<boolean>} 是否存在。
 */
export async function exists(path) {
  return (await readText(path)) !== null;
}
