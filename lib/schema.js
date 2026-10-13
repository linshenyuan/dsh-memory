/**
 * 配置 schema（只给 DSH 用）。
 *
 * 单独一个文件的原因：它 `import` 了 DSH 运行时的 `@deepseek-ai/schemastery`，
 * 而 `lib/config.js` 里的 `DEFAULTS` / `resolveConfig` 是纯逻辑、要在没有 DSH 的
 * 环境里跑测试。把带运行时依赖的那一小块隔离出去，其余部分就能独立测试。
 *
 * 真正生效的值由 `resolveConfig` 给出（它会兜住 schema 默认值没被填上的情况），
 * schema 的作用是让 DSH 在加载时校验配置类型、并在配置面板里展示每一项。
 */
import z from "@deepseek-ai/schemastery";

import { DEFAULTS } from "./config.js";

export const Config = z.object({
  // ---- 落点 ----
  /** 项目级记忆目录，相对工作区。跟着仓库走，可以直接进 Git。 */
  projectMemoryDir: z.string().default(DEFAULTS.projectMemoryDir),
  /** 用户级记忆目录（跨项目）。留空 = `$DSH_HOME/memory`。 */
  userMemoryDir: z.string().default(DEFAULTS.userMemoryDir),
  projectFileName: z.string().default(DEFAULTS.projectFileName),
  userFileName: z.string().default(DEFAULTS.userFileName),

  // ---- 预算（字节，不是字符）----
  /** 项目记忆上限。超了拒绝写入，不静默截断。 */
  projectMaxBytes: z.natural().default(DEFAULTS.projectMaxBytes),
  /** 用户记忆上限。 */
  userMaxBytes: z.natural().default(DEFAULTS.userMaxBytes),

  // ---- 开关 ----
  /** 干了实事但没写记忆时，注入一条提醒。 */
  writeReminder: z.boolean().default(DEFAULTS.writeReminder),
  /** 待裁决的冲突条目不进注入上下文。 */
  conflictFreeze: z.boolean().default(DEFAULTS.conflictFreeze),
  /** 注入前扫敏感信息并打码（只打码，不改磁盘原文）。 */
  sensitiveScan: z.boolean().default(DEFAULTS.sensitiveScan),
  /** 写 runs.jsonl 审计流水。 */
  auditEnabled: z.boolean().default(DEFAULTS.auditEnabled),
  /** 启动时用 runs.jsonl 重放并与 MEMORY.md 对比，不一致只 warn。 */
  verifyOnStart: z.boolean().default(DEFAULTS.verifyOnStart),

  // ---- 提醒调参 ----
  /** 累计写几个「非记忆文件」后触发提醒。写一个就提醒太吵。 */
  remindAfterToolWrites: z.natural().default(DEFAULTS.remindAfterToolWrites),
});
