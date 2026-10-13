/**
 * dsh-memory —— 跨会话长期记忆。
 *
 * 设计要点（按重要性排）：
 *
 * 1. **零额外 LLM 调用。** 不蒸馏、不巩固、不判定重要性、不裁决冲突。判断「该不该记」
 *    这件事交还给前台模型 —— 它本来就在读这段对话，这是零边际成本的。
 *
 * 2. **写入必须走 memory_save 工具。** DSH 只有 `tools/result`（执行后）钩子，没有执行
 *    前的拦截点。模型若用自带 write/edit 直接改记忆文件，插件拦不住重复、拦不住矛盾、
 *    也没法记审计。
 *
 * 3. **记忆按需读取，不在会话开始时整批注入。** 改成用 `memory_read` 工具让模型在
 *    需要时现读现渲染磁盘上的内容。好处：记忆文件一改下一轮就能读到（没有冻结窗口），
 *    也不占用每一轮的上下文预算——只读模型真正需要的那一份。
 *
 * 4. **一切失败都 fail-open。** 读不到、解析不了、渲染出错 —— 一律当作「没有记忆」
 *    继续跑，绝不阻塞主流程。
 *
 * 导出形式遵循 DSH 的 Host plugin 规范：`export function apply` + 可选的 `inject` 与
 * `Config`。所有资源用 `ctx.on` / `ctx.systemPrompt.section` / `ctx.tools.register`
 * 注册，它们由所属 context 拥有，卸载时自动清理 —— 不依赖 apply 的返回值。
 * （cordis 4 会把带 prototype 的 apply 当类构造函数 `new`，返回值被丢弃。）
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { readRuns, verifyReplay } from "./audit.js";
import { resolveConfig } from "./config.js";
import { MEMORY_RULES } from "./guide.js";
import { isMemoryPath, resolveMemoryPaths } from "./paths.js";
import { parseMemory } from "./parse.js";
import {
  REMINDER_SUMMARY,
  REMINDER_TEXT,
  noteMemoryWrite,
  noteWrite,
  shouldRemind,
} from "./reminder.js";
import { readText, writeAtomic } from "./store.js";
import { createMemoryReadTool, createMemorySaveTool } from "./tool.js";
import { CHANNEL, createRpcHandler } from "./ui/rpc.js";
import { mountRpcRoute } from "./ui/route.js";

export const name = "dsh-memory";

/** 需要的服务。只声明最小集合 —— 声明了但没有的 profile 会让插件不激活。 */
export const inject = ["systemPrompt", "tools"];

// schema 单独放 lib/schema.js：那边 import 了 DSH 运行时的 schemastery，
// 隔离出去之后 lib/config.js 与其余模块都能在没有 DSH 的环境里跑测试。
export { Config } from "./schema.js";

/**
 * 注入消息的来源标识。
 *
 * DSH 会话格式 v4 的要求是「producer-owned source kind」：非空字符串，且不能是
 * 保留值 `"plugin"`。一方的注入就是这么写的 —— `agent-instructions` /
 * `session-reference` / `user-question-reply`，`dsh-time-context` 更是直接写
 * `kind: name`（插件自己的名字）。所以这里写自己的名字。
 *
 * 顺带澄清一个容易搞混的点：会话里那个 `plugin:<名字>` 前缀**不是**给新注入用的
 * 命名约定。它只出现在 v3→v4 的格式迁移里 —— 老日志把来源存成
 * `{ kind: "plugin", plugin: "X" }`，迁移时映射不到一方生产者就退化成
 * `plugin:X`。原生写入的 kind 不会被加前缀，会话视图里显示的就是这个字符串本身。
 */
const SOURCE_KIND = "dsh-memory";

/**
 * L1 规矩段的位置。
 *
 * DSH 的 `SECTION_ORDERS` 是**DSH 自己仓库里那些 section 的中央编排表** ——
 * 里面没有给记忆留格子（只有 HARNESS_IDENTITY / DEPLOYMENT_PERSONA_* /
 * PLAN_POLICY / TEAM_POLICY / TOOL_* / MCP_SERVERS / …）。所以
 * `getSectionOrder("MEMORY")` 现在返回 `undefined`，直接交给
 * `section({ order })` 会抛
 * `TypeError: prompt section "…" order must be a finite number`。
 *
 * 所以用「有就跟随、没有就用自己的号」的写法：将来 DSH 真给记忆留了一格，
 * 插件自动跟着动；现在没有，就用 {@link FALLBACK_SECTION_ORDER}。
 *
 * 撞号不用担心：`comparePromptSections` 是 `a.order - b.order || 名字字典序`，
 * 数字相同既不报错也不是随机 —— 按 section 名排序，结果确定。
 */
const FALLBACK_SECTION_ORDER = 150;

/**
 * 取规矩段的排序号。
 *
 * `FALLBACK_SECTION_ORDER = 150` 是**挑的**，不是随手写的：它落在
 * `DEPLOYMENT_PERSONA_PREFIX`（0）和 `PLAN_POLICY`（500）之间 —— 也就是
 * 「讲完你是谁之后、讲任何策略/计划/工具之前」。记忆是背景事实，排在策略后面
 * 会让「该不该记」的规矩看起来像是可以商量的建议；挤进 persona 里又会让它被
 * 当成身份描述。
 *
 * @param {object} ctx - cordis context。
 * @returns {number} 有限数。
 */
function sectionOrder(ctx) {
  const registered = ctx.systemPrompt.getSectionOrder?.("MEMORY");
  return Number.isFinite(registered) ? registered : FALLBACK_SECTION_ORDER;
}

/**
 * logger 调用包一层：logger 自己抛错也不能影响主流程。
 * @param {object|null} logger - ctx.logger。
 * @param {string} message - 日志内容。
 */
function safeWarn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // ignore
  }
}

/**
 * 构造一条注入消息。
 *
 * @param {string} text - 正文。
 * @param {object} source - `{ form, ... }` 形式的来源声明。
 * @returns {object} createUserMessage 的产物。
 */
function userMessage(text, source) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: SOURCE_KIND, ...source },
  });
}

/**
 * 启动自检：用 runs.jsonl 重放，与 MEMORY.md 的实际条目对比。
 *
 * 不一致不一定是错误 —— 手改文件是设计允许的。所以只 warn，不阻断、不修改任何东西。
 * 它的价值在于：如果哪天出现「记忆莫名其妙少了一条」，日志里能立刻看到线索。
 *
 * @param {string} cwd - 工作目录。
 * @param {object} cfg - 归一化配置。
 * @param {object|null} logger - ctx.logger。
 * @returns {Promise<void>}
 */
async function runVerify(cwd, cfg, logger) {
  for (const scope of ["project", "user"]) {
    try {
      const paths = resolveMemoryPaths(cwd, scope, cfg);
      const text = await readText(paths.file);
      if (text === null) continue;
      const runs = await readRuns(paths.runs, 0);
      if (runs.length === 0) continue;

      const result = verifyReplay(runs, parseMemory(text).entries);
      if (result.ok) continue;

      safeWarn(
        logger,
        `dsh-memory: ${paths.displayPath} 与审计流水不一致 —— ` +
          `文件里有但流水里没有: [${result.missing.join(", ") || "无"}]；` +
          `流水里有但文件里没有: [${result.orphan.join(", ") || "无"}]。` +
          "（手工编辑文件是正常的，这条只是提示。）",
      );
    } catch (error) {
      safeWarn(logger, `dsh-memory: 自检失败: ${String(error)}`);
    }
  }
}

/**
 * 装配插件。
 *
 * @param {object} ctx - cordis context。
 * @param {object} [config] - cordis.patch.yml 里这一行的 config。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const logger = ctx.logger ?? null;

  // ---- L1：规矩段 ----------------------------------------------------------
  // 常驻系统提示，内容必须是常量 —— 它一变，KV 前缀缓存从该位置起全部失效。
  // `interpolate: false` 是硬要求：DSH 的插值器遇到未注册的 `{{name}}` 会直接抛错，
  // 而记忆是自由文本，模型完全可能写进 `{{`。
  ctx.systemPrompt.section({
    name: "memory-rules",
    order: sectionOrder(ctx),
    interpolate: false,
    text: MEMORY_RULES,
  });

  // ---- 两个工具：写 + 读 --------------------------------------------------
  // `memory_save` 是唯一写入入口（去重/冲突/审计都在这一层）；`memory_read`
  // 是按需读取入口（现读现渲染磁盘内容）。记忆不再在会话开始时整批注入。
  ctx.tools.register(createMemorySaveTool({ cfg, logger }));
  ctx.tools.register(createMemoryReadTool({ cfg, logger }));

  // ---- 设置面板的 RPC 通道 --------------------------------------------------
  // 面板在浏览器里，要读（浏览/用量/冲突/审计）也要写（裁决）。
  //
  // 用 `ctx.inject` 而不是把它加进本插件的 `inject`：`inject` 里声明了但
  // profile 里没有的服务会让**整个插件不激活**。命令行 / 无界面的 profile
  // 没有 connection / webServer，记忆功能却仍然要能用，所以这里做成
  // 「有就挂、没有就跳过」。
  //
  // 需要两个服务：`connection` 给请求栅栏（Host/Origin + 浏览器 cookie），
  // `webServer` 用来挂路由。**不用 `connection.rpc.handle`** —— 它在这个
  // DSH 版本里必然抛错（连接服务自己的 context 没 inject `webServer`），
  // 路由挂不上，浏览器侧看到的就是 `HTTP 405`。原因与复刻出来的传输语义
  // 见 lib/ui/route.js 的文件头。
  //
  // 工作目录取自最近一次会话（见 agent/pre-step）。**不接受面板传路径** ——
  // 裁决会写盘，让浏览器指定路径等于开了个任意写文件的口子。
  let lastCwd = null;

  ctx.inject(["connection", "webServer"], (panelCtx) => {
    const handler = createRpcHandler({
      getCwd: () => lastCwd,
      cfg,
      readText,
      writeText: writeAtomic,
      logger,
    });
    panelCtx.effect(
      () =>
        mountRpcRoute({
          webServer: panelCtx.webServer,
          connection: panelCtx.connection,
          channel: CHANNEL,
          handler,
          logger,
        }),
      "dsh-memory: 面板 RPC 路由",
    );
  });

  /** 每个会话只跑一次的旁路任务（启动自检）标记。WeakSet：会话销毁自动回收。 */
  const seen = new WeakSet();

  // ---- 记录「实质写盘」，供 L3 提醒判断 -------------------------------------
  // 写记忆文件本身不算 —— 否则「写完记忆 → 又被提醒写记忆」会无限循环。
  ctx.on("tools/result", (exec, result) => {
    if (cfg.writeReminder !== true) return;

    const session = exec.agent?.session ?? null;
    if (session === null || session === undefined) return;

    // 成功写入记忆 → 计数清零（提醒的语义是「干了实事但还没写记忆」）。
    if (exec.name === "memory_save") {
      if (result?.isError !== true) noteMemoryWrite(session);
      return;
    }

    if (result?.isError === true) return;
    if (exec.name !== "write" && exec.name !== "edit") return;

    const path = exec.arguments?.file_path;
    if (typeof path !== "string" || path === "") return;

    const cwd = session.header?.cwd ?? process.cwd();
    if (isMemoryPath(path, cwd, cfg)) return;

    noteWrite(session);
  });

  // ---- L3 条件提醒（按需加载后，记忆不再自动注入）--------------------------
  ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
    // 不 own 这个决策，必须先让后面的监听器跑完，再在它的结果上追加。
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();

    const session = agent?.session;
    if (session === null || session === undefined) return decision;

    const cwd = session.header?.cwd ?? process.cwd();
    const messages = [];

    // 记下最近一次会话的工作区，供设置面板定位（面板不能自己指定路径）。
    lastCwd = cwd;

    // 每个会话只跑一次启动自检（旁路，不阻塞主流程）。
    if (cfg.verifyOnStart === true && !seen.has(session)) {
      seen.add(session);
      // 不 await：自检是旁路，慢一点无所谓，绝不能拖慢首轮。
      void runVerify(cwd, cfg, logger);
    }

    // L3：干了实事但还没写记忆 → 提醒一次。shouldRemind 内部按 step 去重，
    // 保证每轮最多提醒一次，避免「提醒 → 回应 → 又提醒」的死循环。
    if (cfg.writeReminder === true && shouldRemind(session, step, cfg.remindAfterToolWrites)) {
      // `form: "notice"` 要求 `summary` 非空 —— 它显示在折叠行上，不展开就能看懂。
      messages.push(
        userMessage(REMINDER_TEXT, { form: "notice", summary: REMINDER_SUMMARY }),
      );
    }

    if (messages.length === 0) return decision;

    // 必须 spread：decision 上还有 startsRequestSeries 之类的字段，丢掉会出问题。
    return { ...decision, messages: [...messages, ...decision.messages] };
  });
}
