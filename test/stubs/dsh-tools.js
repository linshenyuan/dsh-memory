/**
 * 测试替身：`@deepseek-ai/dsh-tools`。
 *
 * `defineTool` 在真实 DSH 里会把定义包成带校验、权限、展示的完整工具描述符。
 * 测试只关心「定义长什么样」，所以原样返回 —— 但**保留一条真实的作者规则**：
 *
 *   parameters 里某个参数一旦写了 `required`，值必须是 `true`；省略才表示可选。
 *
 * 真货就是这么判的（`@deepseek-ai/dsh-tools/lib/types/schema.js`：
 * `required must be true when present`）。替身不模仿这一条的话，写成
 * `required: false` 的错只会在装进 DSH 之后才暴露成「插件启动失败」——
 * 而这类错正是这套替身存在的意义（见 test/loader.mjs 的说明）。
 *
 * 只模仿这一条。类型、`output.schema`、展示卡片都不校验：它们写错不会让插件
 * 起不来，测出来只会是噪音。
 */

/**
 * 校验参数规格里的 `required` 写法，然后原样返回定义。
 *
 * @param {object} definition - 工具定义。
 * @returns {object} 同一个对象。
 * @throws {Error} 某个参数的 `required` 存在但不是 `true`。
 */
export function defineTool(definition) {
  const specs = definition.parameters ?? {};
  for (const [name, spec] of Object.entries(specs)) {
    if (spec === null || typeof spec !== "object") continue;
    if (spec.required !== undefined && spec.required !== true) {
      // 消息与真货逐字一致，失败时读起来就是 DSH 里的那句话。
      throw new Error(`parameters.${name}.required must be true when present`);
    }
  }
  return definition;
}
