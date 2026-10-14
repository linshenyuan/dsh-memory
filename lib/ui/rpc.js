/**
 * 设置面板的宿主侧 RPC 端点。
 *
 * 面板在浏览器里跑，记忆文件在磁盘上，中间必须有一条通道。通道就是 DSH 现成的
 * 那一套：宿主挂一条 `/<channel>` 前缀路由，浏览器 `connection.rpc.call(channel,
 * endpoint, payload)` 发一条 POST 过去，线上格式是
 * `client-request → server-response`（见 lib/ui/route.js）。
 *
 * **挂路由这件事不在这里做，也不用 `ctx.connection.rpc.handle`。** 后者在当前
 * DSH 版本里必然抛错（连接服务自己的 context 没 inject `webServer`），原因与
 * 复刻出来的传输语义都写在 lib/ui/route.js 的文件头。本文件只管**端点逻辑**。
 *
 * 为什么仍走 `connection.rpc.call` 那条线上格式、而不是自己发明一套：
 *
 * 1. **信封是现成的。** `rpcId` 配对、`{ok,value}` / `{ok,error}` 信封、
 *    `application/json` 校验、Host/Origin 围栏与浏览器鉴权都在通道语义里。
 *
 * 2. **前缀安全。** 客户端那侧把 URL 拼成相对的（`dsh-memory/snapshot`，
 *    前导斜杠被刻意去掉），反代到子目录下也不会打偏。
 *
 * 3. **channel 不占 `/api`。** `/api` 是保留的共享通道，只能 `intercept` 不能
 *    `handle`，且它的拦截器槽位是独占的；我们用独立 channel，与别家插件互不干扰。
 *
 * 本文件**不依赖 DSH 运行时** —— 只返回一个普通函数，注册动作留给 lib/index.js。
 * 这样端点逻辑（尤其是「谁能写、写到哪」这类判断）可以脱离 DSH 独立单测。
 */
import { PANEL_KEYS, settingsPath, validateLimits, writeSettings } from "../settings.js";
import { ACTIONS, resolveConflict } from "./resolve.js";
import { collectPanelData } from "./data.js";
import { EDIT_ACTIONS, editMemory } from "./write.js";
import { clearRun } from "../audit.js";
import { resolveMemoryPaths } from "../paths.js";
import { withFileLock } from "../lock.js";

/** 面板用的 RPC channel。必须以 `/` 开头，且不能是保留值 `/api`。 */
export const CHANNEL = "/dsh-memory";

/** 面板会调的端点：snapshot 只读聚合、resolve 裁决冲突、edit 自由编辑、settings 改上限、audit.clear 清审计。 */
export const ENDPOINTS = Object.freeze(["snapshot", "resolve", "edit", "settings", "audit.clear"]);

/**
 * 造一个成功信封。
 * @param {unknown} value - 任意可 JSON 序列化的值。
 * @returns {{ok: true, value: unknown}} 信封。
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * 造一个失败信封。
 *
 * 形状必须严格是 `{ok:false, error:{code, message, details}}` —— 客户端那侧
 * 的 `parseConnectionResponse` 会逐个字段校验，缺一个 `details` 就整条响应
 * 被判成非法，浏览器侧只会看到一个 TypeError。
 *
 * @param {string} code - 机器可读的错误码。
 * @param {string} message - 给人看的一句话。
 * @param {object} [details] - 附加信息，必须是对象（不能是 undefined）。
 * @returns {{ok: false, error: {code: string, message: string, details: object}}} 信封。
 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/**
 * 校验一个作用域名。
 * @param {unknown} scope - 待校验值。
 * @returns {"project"|"user"|null} 合法时归一化后的作用域，否则 null。
 */
function normalizeScope(scope) {
  if (scope === "user") return "user";
  if (scope === "project") return "project";
  return null;
}

/**
 * 创建面板的 RPC 处理器。
 *
 * 返回的函数交给 lib/ui/route.js 的 `mountRpcRoute({ handler })`。签名与
 * connection 的约定一致：`(endpoint, payload, signal) => 信封`。
 *
 * **工作目录只认宿主记的那个。** payload 里的 `cwd` 一律忽略 —— 面板能写盘
 * （`resolve` 会改 MEMORY.md），如果让浏览器指定路径，等于开了一个「往任意
 * 位置写文件」的口子。宿主侧记的是最近一次会话真实打开的工作区，这就是唯一
 * 可信的来源。
 *
 * @param {object} deps
 * @param {() => string} deps.getCwd - 取宿主记录的工作目录。
 * @param {object} deps.cfg - 归一化配置。
 * @param {(path: string) => Promise<string|null>} deps.readText - 读文件。
 * @param {(path: string, text: string) => Promise<void>} deps.writeText - 原子写。
 * @param {object|null} [deps.logger] - 可选 logger。
 * @param {string|null} [deps.settingsFile] - 面板设置的覆盖文件路径；`null` = 走
 *   `$DSH_HOME` 下的默认路径。测试用临时路径注入，免得碰到真实 home。
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>}
 *          处理器。
 */
export function createRpcHandler({ getCwd, cfg, readText, writeText, logger = null, settingsFile = null }) {
  return async function handler(endpoint, payload) {
    const body = payload !== null && typeof payload === "object" ? payload : {};
    const cwd = getCwd();

    if (typeof cwd !== "string" || cwd === "") {
      return fail("no-workspace", "还没有记录到工作目录，先随便开一轮会话再回来。", {});
    }

    if (endpoint === "snapshot") {
      try {
        const data = await collectPanelData({ cwd, cfg, readText });
        return ok(data);
      } catch (error) {
        // collectPanelData 内部已经逐作用域兜底，走到这里说明是聚合层本身炸了。
        return fail("snapshot-failed", `聚合面板数据失败: ${String(error)}`, {});
      }
    }

    if (endpoint === "resolve") {
      const scope = normalizeScope(body.scope);
      if (scope === null) {
        return fail("bad-scope", "作用域只能是 project 或 user。", { got: String(body.scope) });
      }
      if (typeof body.topic !== "string" || body.topic.trim() === "") {
        return fail("bad-topic", "缺少 topic，无法定位要裁决的冲突。", {});
      }
      if (!ACTIONS.includes(body.action)) {
        return fail("bad-action", `未知的裁决动作: ${String(body.action)}`, { allowed: ACTIONS });
      }

      let result;
      try {
        result = await resolveConflict({
          cfg,
          cwd,
          scope,
          topic: body.topic,
          action: body.action,
          readText,
          writeText,
          logger,
        });
      } catch (error) {
        return fail("resolve-failed", `裁决失败: ${String(error)}`, {});
      }

      // resolveConflict 把「冲突已经不存在了」这类竞态也归为 ok:false。
      // 那不是通道故障，是业务结果 —— 但它同样不是成功，所以如实传下去，
      // 让面板显示那句话而不是假装成功。
      if (result.ok !== true) {
        return fail("resolve-rejected", result.message, { action: result.action });
      }
      return ok(result);
    }

    if (endpoint === "edit") {
      const scope = normalizeScope(body.scope);
      if (scope === null) {
        return fail("bad-scope", "作用域只能是 project 或 user。", { got: String(body.scope) });
      }
      if (!EDIT_ACTIONS.includes(body.action)) {
        return fail("bad-action", `未知的编辑动作: ${String(body.action)}`, { allowed: EDIT_ACTIONS });
      }
      // add 是新建，topic 和正文都得给。
      if (body.action === "add") {
        if (typeof body.topic !== "string" || body.topic.trim() === "") {
          return fail("bad-topic", "新增条目需要 topic。", {});
        }
        if (typeof body.content !== "string" || body.content.trim() === "") {
          return fail("bad-content", "新增条目需要正文。", {});
        }
      }
      // update 至少要改点什么：正文或 topic 非空即可（分类可选）。
      if (body.action === "update") {
        const hasTopic = typeof body.topic === "string" && body.topic.trim() !== "";
        const hasContent = typeof body.content === "string" && body.content.trim() !== "";
        if (!hasTopic && !hasContent) {
          return fail("bad-content", "修改需要至少给出 topic 或正文。", {});
        }
      }
      // update / delete 都要先能定位到条目。
      if (body.action === "update" || body.action === "delete") {
        const hasId = typeof body.id === "string" && body.id.trim() !== "";
        const hasTopic = typeof body.topic === "string" && body.topic.trim() !== "";
        if (!hasId && !hasTopic) {
          return fail("bad-target", "修改或删除需要 id 或 topic 来定位条目。", {});
        }
      }

      let result;
      try {
        result = await editMemory({
          cfg,
          cwd,
          scope,
          action: body.action,
          id: typeof body.id === "string" ? body.id.trim() : null,
          topic: typeof body.topic === "string" ? body.topic.trim() : null,
          content: typeof body.content === "string" ? body.content : null,
          section: typeof body.section === "string" ? body.section : null,
          area: typeof body.area === "string" ? body.area : null,
          readText,
          writeText,
          logger,
        });
      } catch (error) {
        return fail("edit-failed", `编辑失败: ${String(error)}`, {});
      }

      // editMemory 把「找不到条目」这类业务结果也归为 ok:false。如实传下去，
      // 让面板显示那句话而不是假装成功。
      if (result.ok !== true) {
        return fail("edit-rejected", result.message, { action: result.action });
      }
      return ok(result);
    }

    if (endpoint === "settings") {
      // 面板改记忆上限。校验 → 落盘（下次启动还在）→ **就地改这份共享 cfg 对象**。
      // 工具 / 面板 / 钩子持有的是同一个引用，所以改完立即生效，不用重启。
      const checked = validateLimits(body);
      if (checked.ok !== true) {
        return fail("bad-limits", checked.message, { allowed: PANEL_KEYS });
      }
      try {
        // settingsFile 只在测试里注入；生产走 $DSH_HOME 下的默认路径。
        await writeSettings(checked.value, settingsFile ?? settingsPath());
      } catch (error) {
        return fail("settings-write-failed", `写入设置失败: ${String(error)}`, {});
      }
      Object.assign(cfg, checked.value);
      return ok({ ...checked.value, message: "已保存，立即生效。" });
    }

    if (endpoint === "audit.clear") {
      // 面板「确认清除」一条审计记录：删掉 runs.jsonl 里那一行（按 at 定位）+ 追一条
      // clear 标记，让启动自检不误报 missing / orphan。只动流水，不删记忆。
      const scope = normalizeScope(body.scope);
      if (scope === null) {
        return fail("bad-scope", "作用域只能是 project 或 user。", { got: String(body.scope) });
      }
      if (typeof body.at !== "string" || body.at.trim() === "") {
        return fail("bad-target", "缺少 at，无法定位要清除的审计记录。", {});
      }
      const paths = resolveMemoryPaths(cwd, scope, cfg);
      try {
        // 串行化同一份 runs.jsonl 的「读 → 改 → 写」，避免和别处的 clear 抢。
        await withFileLock(paths.runs, () =>
          clearRun(
            paths.runs,
            {
              at: body.at,
              op: typeof body.op === "string" ? body.op : null,
              id: typeof body.id === "string" ? body.id : null,
              by: "user",
            },
            logger,
          ),
        );
      } catch (error) {
        return fail("audit-clear-failed", `清除审计记录失败: ${String(error)}`, {});
      }
      return ok({ at: body.at, id: body.id ?? null, cleared: true });
    }

    return fail("unknown-endpoint", `未知的端点: ${String(endpoint)}`, { allowed: ENDPOINTS });
  };
}
