/**
 * 测试用的模块解析钩子：把三个 DSH 运行时的包名映射到 test/stubs/ 下的替身。
 *
 * 为什么需要它：`lib/index.js` 与 `lib/tool.js` 会 `import` DSH 运行时的包，而
 * 这些包只在装了 DSH 的机器上才有。没有这层映射，「装配逻辑」就完全测不到 ——
 * 一个写错的 `apply()` 只能等装进 DSH 之后才炸。
 *
 * 只在测试进程里生效（由 test/index.test.js 调用 `register()` 注册）。
 */
export function resolve(specifier, context, nextResolve) {
  const map = {
    "@deepseek-ai/dsh-llm": "./stubs/dsh-llm.js",
    "@deepseek-ai/dsh-tools": "./stubs/dsh-tools.js",
    "@deepseek-ai/schemastery": "./stubs/schemastery.js",
  };
  const target = map[specifier];
  if (target !== undefined) {
    return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
