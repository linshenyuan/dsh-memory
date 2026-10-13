/**
 * 测试替身：`@deepseek-ai/schemastery`。
 *
 * 只需要「链式 `.default()` 返回自身」这一点行为 —— 测试关心的是默认值本身，
 * 不是 schema 的校验能力（那是 DSH 的职责）。
 */

/** 造一个最小可用的 schema 节点。 */
function node() {
  const self = {
    default(value) {
      self.defaultValue = value;
      return self;
    },
    description(text) {
      self.descriptionText = text;
      return self;
    },
  };
  return self;
}

const z = {
  string: node,
  boolean: node,
  natural: node,
  number: node,
  object(shape) {
    return { type: "object", shape };
  },
};

export default z;
