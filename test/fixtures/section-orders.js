/**
 * DSH 的 `SECTION_ORDERS` 快照（只读数据，不是替身）。
 *
 * 来源：`@deepseek-ai/dsh-system-prompt/lib/index.js` 顶部的 `SECTION_ORDERS`
 * 常量，DSH 的 `ctx.systemPrompt.getSectionOrder(name)` 就是查这张表。
 *
 * 抄一份在这里的目的：
 *   1. 断言规矩段的位置**相对谁**靠前/靠后，而不是只钉一个魔数 150；
 *   2. 留一份可对照的凭据 —— DSH 改表时能直接 diff。
 *
 * 注意这是**快照**，不会自动更新。测试只用它表达相对关系，不用它校验 DSH 的当前值。
 */
export const SECTION_ORDERS = Object.freeze({
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
});

/** DSH 的 `CONTEXT_ORDERS` 快照，同一个来源。 */
export const CONTEXT_ORDERS = Object.freeze({
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
});
