/**
 * L3 每轮提醒的文本与触发判据。
 *
 * 关键设计：**不每轮都注入。**
 *
 * WorkBuddy 的做法是每轮往上下文里塞一段 `<memory_and_skills_reminder>`。简单，
 * 但那意味着 N 轮之后历史里堆了 N 段提醒 —— 这跟「省钱」的初衷正好相反。
 *
 * 本插件的做法：只在「干了实事但还没写记忆」时注入，且每轮最多一次。判据是
 * 「本轮改动了 N 个非记忆文件」——写记忆本身不算，否则写完又被提醒，无限循环。
 */

/** 触发提醒前需要累计的「实质写盘」次数。 */
export const DEFAULT_REMIND_THRESHOLD = 3;

/** 提醒正文。 */
export const REMINDER_TEXT = [
  "<memory_reminder>",
  "本次会话已经改动过若干个文件，但还没有写入任何长期记忆。",
  "",
  "如果刚才的工作里有**跨会话价值**的东西，现在用 `memory_save` 记下来：",
  "- 项目相关的约定、决策、踩过的坑 → `scope: \"project\"`",
  "- 跨项目的个人偏好或习惯 → `scope: \"user\"`",
  "",
  "如果没什么值得记的，**直接忽略这条提醒，继续你原来的工作**。",
  "不要为了回应这条提醒而编造记忆 —— 一条没用的记忆，未来每个会话都要为它买单。",
  "</memory_reminder>",
].join("\n");

/**
 * 提醒在会话视图里的**一行摘要**。
 *
 * 配 `source.form: "notice"` 用：那个 form 要求 `summary` 是一个非空字符串，
 * 会显示在折叠行上，让人不展开就知道这条注入是什么。少了它，声明了 `notice`
 * 也会降级成不透明视图。
 */
export const REMINDER_SUMMARY = "已改动若干文件，但尚未写入长期记忆";

/**
 * 每个会话的提醒状态。
 *
 * 用 WeakMap 挂在 session 对象上：会话销毁时状态自动回收，不需要任何清理逻辑。
 */
const states = new WeakMap();

/**
 * 取（或初始化）某个会话的提醒状态。
 * @param {object} session - agent.session。
 * @returns {{writes: number, remindedAtStep: number}} 状态对象。
 */
export function stateOf(session) {
  let state = states.get(session);
  if (state === undefined) {
    state = { writes: 0, remindedAtStep: -1 };
    states.set(session, state);
  }
  return state;
}

/**
 * 记一次「实质写盘」。
 * @param {object} session - agent.session。
 */
export function noteWrite(session) {
  stateOf(session).writes += 1;
}

/**
 * 写入记忆之后把计数清零。
 *
 * 提醒的语义是「干了实事**但还没写记忆**」。写过记忆之后如果不清零，下一次攒够
 * 阈值会再提醒一遍 —— 而那时记忆已经写过了，提醒就变成了噪音。
 *
 * 只清计数、不动 `remindedAtStep`：那个是防死循环用的，与「写没写过」无关。
 *
 * @param {object} session - agent.session。
 */
export function noteMemoryWrite(session) {
  stateOf(session).writes = 0;
}

/**
 * 判断是否该提醒，并在该提醒时消费掉计数。
 *
 * `remindedAtStep` 是防死循环的关键：模型回应提醒后会继续跑，如果那时又满足
 * 条件就会再次提醒，无限循环。用 step 号去重，保证每轮最多提醒一次。
 *
 * @param {object} session - agent.session。
 * @param {number} step - 当前 step 号。
 * @param {number} threshold - 触发阈值。
 * @returns {boolean} 是否该注入提醒。
 */
export function shouldRemind(session, step, threshold) {
  const state = stateOf(session);
  if (state.writes < threshold) return false;
  if (state.remindedAtStep === step) return false;
  state.writes = 0;
  state.remindedAtStep = step;
  return true;
}
