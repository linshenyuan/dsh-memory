/**
 * 测试替身：`@deepseek-ai/dsh-llm`。
 *
 * 只在测试里用 —— 目的是让 `lib/index.js` 能在**没有 DSH 运行时**的环境下被加载，
 * 从而验证 `apply()` 的装配逻辑（注册了哪些 section、哪个工具、哪些钩子）。
 * 真实实现由 DSH 在安装后提供。
 */

export function createUserMessage({ content, source }) {
  return { role: "user", content, source };
}

export function createAssistantMessage({ content, source }) {
  return { role: "assistant", content, source };
}
