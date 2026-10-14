/**
 * `memory_save` —— 暴露给模型的工具定义。
 *
 * 为什么必须是一个工具，而不是让模型直接用 write/edit 改记忆文件：
 *
 * DSH 的工具系统只提供 `tools/result`（执行**后**）钩子，**没有执行前的拦截点**。
 * 如果模型用自带的 write/edit 直接改文件，插件没有任何机会介入 —— 拦不住重复
 * 写入、拦不住矛盾写入、也没法在写入那一刻记审计。
 *
 * 所以「提示词驱动」保留在**决定何时写**这一层（见 lib/guide.js 与 lib/reminder.js），
 * 而**怎么写**这一层由本工具承载。
 *
 * 本文件只做三件事：声明参数、把参数交给 lib/save.js、把结果渲染成给人看的一段
 * 文字。全部业务逻辑在 lib/save.js 里，那边不依赖 DSH 运行时，能独立测试。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

import { readMemory } from "./render.js";
import { DEFAULT_SECTION, saveMemory } from "./save.js";
import { readText } from "./store.js";

/**
 * 构造 `memory_save` 工具。
 *
 * @param {{cfg: object, logger?: object|null}} deps - 依赖。
 * @returns {object} defineTool 的产物。
 */
export function createMemorySaveTool({ cfg, logger = null }) {
  return defineTool({
    name: "memory_save",
    description: [
      "把一条有跨会话价值的记忆写进长期记忆库。写入前自动做内容去重与冲突检测。",
      "",
      "什么时候用：干完一件有实质内容的事之后，里面有值得跨会话记住的东西 ——",
      "一个偏好、一个带理由的决策、一个技术约束、一个带根因的坑。",
      "",
      "什么时候不用：问候、简单查询、短问答；只在本次对话有意义的信息；",
      "你从当前上下文就能看到的东西；以及「用户要求我记住 X」这类元话语 —— 要记的是 X 本身。",
      "",
      "不确定就别调用。「不写」是完全合法的结果。",
      "",
      "topic 必须准确：kebab-case 短标识，描述主题而不是内容。同一件事必须用同一个 topic ——",
      "它是冲突检测的唯一依据。写之前先看一眼记忆库里有没有同 topic 的条目。",
    ].join("\n"),
    // 参数规格用的是 DSH 的 value-schema DSL，不是 JSON Schema：`required` 一旦
    // 出现，值必须是 `true`；**可选参数一律省略 `required`**，写 `required: false`
    // 会当场抛错（`@deepseek-ai/dsh-tools` 的 `schema.js`：`required must be true
    // when present`）。写错的话 `defineTool` 会在 `apply` 里炸，插件直接「启动失败」，
    // 而本地测试默认看不出来 —— test/tool.test.js 与 test/stubs/dsh-tools.js 各守一道。
    parameters: {
      topic: {
        type: "string",
        required: true,
        description:
          "主题键。kebab-case 的短标识，如 indent-style / package-manager / dsh-apply-pitfall。" +
          "描述主题而不是内容（用 indent-style，不要用 用4空格缩进）。" +
          "同一件事必须用同一个 topic —— 它是冲突检测的唯一依据。",
      },
      content: {
        type: "string",
        required: true,
        description:
          "记忆正文。一条一个事实。保留原始细节（路径、命令、报错原文照抄），不要概括抽象。" +
          "不要写「用户要求我记住 X」这类元话语 —— 要记的是 X 本身。",
      },
      scope: {
        type: "string",
        required: true,
        description:
          "project = 项目相关（技术约定、已定方案、踩过的坑）；" +
          "user = 跨项目的个人偏好或习惯。",
      },
      mode: {
        type: "string",
        description:
          "new（默认）= 新建条目，同 topic 已有条目时会自动转为待裁决冲突；" +
          "update = 这条是同一 topic 的新结论，替换掉旧条目；" +
          "append = 给同 topic 追加补充信息，旧条目仍然成立。" +
          "不确定就用 new，系统会自动处理冲突。",
      },
      section: {
        type: "string",
        description:
          "写进哪个二级标题段，如 约定 / 已定方案 / 踩过的坑。段不存在会自动创建。" +
          `不填则放进「${DEFAULT_SECTION}」段。`,
      },
      reason: {
        type: "string",
        description: "为什么值得记，一句话。便于日后翻审计时理解当时的判断。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          action: { type: "string", required: true },
          id: { type: "string", required: true },
          message: { type: "string", required: true },
          usage: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.usage === "" ? value.message : `${value.message}\n\n[${value.usage}]`,
        },
      ],
    },

    async execute(args, exec) {
      const session = exec.agent?.session ?? null;
      const cwd = session?.header?.cwd ?? process.cwd();
      const sessionKey = session?.header?.id ?? session?.id ?? null;

      return saveMemory({
        cfg,
        cwd,
        input: args,
        sessionKey,
        logger,
      });
    },

    presentCall(args) {
      return {
        card: "generic",
        title: `Save memory: ${args.topic}`,
        kind: "write",
        rawInput: args.topic,
      };
    },
  });
}

/**
 * `memory_read` —— 暴露给模型的「按需读取」工具。
 *
 * 记忆改成按需加载之后，不再在会话开始时整批注入。模型在**需要背景事实时**调用
 * 本工具，现读现渲染磁盘上的当前内容。好处有两点：
 *
 *   1. 记忆文件一旦被改（模型自己 `memory_save` 也好、人手工改也好）下一轮就能读到，
 *      没有「冻结」窗口——这是当初整批注入最大的痛点。
 *   2. 不占用每一轮的上下文预算——只读模型真正需要的那一份。
 *
 * 注意它和 `memory_save` 不是一对对称的 CRUD：`memory_save` 是唯一写入入口（为了
 * 去重/冲突/审计），`memory_read` 只是读取。渲染逻辑全部在 lib/render.js 的
 * `readMemory` 里，本文件只声明参数、调它、把结果渲染成给人看的一段文字。
 */
export function createMemoryReadTool({ cfg, logger = null }) {
  return defineTool({
    name: "memory_read",
    description: [
      "按需读取跨会话长期记忆的**当前**内容（从磁盘实时读取，反映最新状态，不会过期）。",
      "",
      "什么时候用：你手头缺背景事实——一个约定、一个已定方案、一个踩过的坑——",
      "而当前上下文里又看不到。调 `memory_read` 工具先读一下确认有没有相关记忆，再决定下一步。",
      "",
      "什么时候不用：你刚刚就用 `memory_save` 写过，已经知道自己写了什么；",
      "或者这个会话明显还没产生过相关记忆。",
      "",
      "scope：`project` = 项目记忆（技术约定、已定方案、踩过的坑）；",
      "`user` = 跨项目的个人偏好；`both`（默认）= 两个都读。",
      "`topic` 可缩小范围到某个主题（kebab-case，如 `indent-style`）。",
      "`keywords` 可按内容做全文检索（不依赖你记住确切的 topic）。",
      "",
      "**你当前的指令 > 项目实际状态 > 任何记忆。** 读到的内容仅供参考，",
      "记忆和现实冲突时先去查证，别拿旧记忆当事实。",
    ].join("\n"),
    // 参数规格同样是 DSH 的 value-schema DSL（见 createMemorySaveTool 的注释）：
    // `required` 一旦出现必须是 `true`，可选参数一律省略。
    parameters: {
      scope: {
        type: "string",
        required: true,
        description:
          "project = 项目记忆；user = 用户记忆；both = 两个都读（默认）。",
      },
      topic: {
        type: "string",
        description:
          "可选，只返回该 topic 的条目（kebab-case，不区分大小写）。不填返回全部。",
      },
      // 故意用单个字符串而不是数组：本仓库验证过 `type: "string"` 可用，
      // `type: "array"` / `items` 是否被 DSL 支持无法在这里验证 —— 写错只会在装进
      // 真 DSH 时表现为「插件启动失败」。分隔交给工具内部做，模型照常用空格/逗号分隔。
      keywords: {
        type: "string",
        description:
          "可选，全文关键词检索。用空格或逗号分隔多个词（如 `pnpm 缓存` 或 `pnpm,缓存`），" +
          "在记忆的 topic 和正文里做子串匹配，命中越多、越靠前的排在前面。" +
          "想不起确切的 topic 时用它 —— 按内容里的字眼也能捞到（大小写、标点差异都能对上）。" +
          "中文没有词间空格，所以别写成一长句没有分隔符的话。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          scope: { type: "string", required: true },
          text: { type: "string", required: true },
          usage: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.text === "" ? "(该作用域没有可读取的记忆)" : value.text,
        },
      ],
    },

    async execute(args, exec) {
      const session = exec.agent?.session ?? null;
      const cwd = session?.header?.cwd ?? process.cwd();

      const text = await readMemory({
        cwd,
        scope: args.scope,
        cfg,
        readText,
        topic: args.topic ?? null,
        keywords: args.keywords ?? null,
        logger,
      });

      return {
        ok: true,
        scope: args.scope,
        text: text ?? "",
        usage: text === null ? "(无记忆)" : `${text.length} 字`,
      };
    },

    presentCall(args) {
      return {
        card: "generic",
        title: `Read memory: ${args.scope}${args.keywords ? ` · ${args.keywords}` : ""}`,
        kind: "read",
        rawInput: args.scope,
      };
    },
  });
}
