/**
 * 工具定义测试。
 *
 * 盯的是一条「只有装进真 DSH 才会炸」的作者规则：参数规格用的是 DSH 的
 * value-schema DSL，`required` 一旦出现必须是 `true`，**省略才表示可选**。
 * 写成 `required: false` 会让 `defineTool()` 当场抛错，而它是在 `apply()` 里
 * 被调用的 —— 插件会以「启动失败」收场，本地测试却全绿（替身原来不看这条）。
 *
 * 这里与 test/stubs/dsh-tools.js 是两道互补的保险：
 * 替身拦「将来新写的参数」，本文件直接盯住「当前这份定义」。
 *
 * 注意断言对象是**作者规格**（替身原样返回的那个对象），不是真货编译出来的
 * JSON Schema —— 真货会把 `required: true` 上提成父级的 `required: [...]` 数组。
 */
import { strict as assert } from "node:assert";
import { register } from "node:module";
import { test } from "node:test";

register("./loader.mjs", import.meta.url);

const { createMemoryReadTool, createMemorySaveTool } = await import("../lib/tool.js");

test("参数里不出现 required: false —— 可选参数一律省略 required", () => {
  const tool = createMemorySaveTool({ cfg: {} });
  const specs = Object.entries(tool.parameters);

  assert.ok(specs.length > 0, "工具至少要声明一个参数");

  for (const [name, spec] of specs) {
    assert.ok(
      spec.required === undefined || spec.required === true,
      `parameters.${name}.required 只能是 true，或者干脆不写（当前: ${String(spec.required)}）`,
    );
  }
});

test("必填的恰好是 topic / content / scope", () => {
  const tool = createMemorySaveTool({ cfg: {} });
  const required = Object.entries(tool.parameters)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .sort();

  assert.deepEqual(required, ["content", "scope", "topic"]);
});

test("memory_read 参数里也不出现 required: false", () => {
  const tool = createMemoryReadTool({ cfg: {} });
  const specs = Object.entries(tool.parameters);

  assert.ok(specs.length > 0, "工具至少要声明一个参数");

  for (const [name, spec] of specs) {
    assert.ok(
      spec.required === undefined || spec.required === true,
      `parameters.${name}.required 只能是 true，或者干脆不写（当前: ${String(spec.required)}）`,
    );
  }
});

test("memory_read 必填的恰好是 scope（topic 可选）", () => {
  const tool = createMemoryReadTool({ cfg: {} });
  const required = Object.entries(tool.parameters)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .sort();

  assert.deepEqual(required, ["scope"]);
});
