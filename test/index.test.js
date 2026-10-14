/**
 * 装配测试：把 DSH 运行时换成替身，验证 `apply()` 到底注册了什么。
 *
 * 这一层测不到工具的真实执行（那由 lib/save.js 的集成测试覆盖），但它能抓住
 * 最容易出错、又最难在本地发现的一类问题：**插件装进 DSH 之后才发现没生效** ——
 * section 名字写错、order 撞车、忘了 `interpolate: false`、钩子签名不对。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

register("./loader.mjs", import.meta.url);

const mod = await import("../lib/index.js");
const { apply, Config, inject, name } = mod;
const { MEMORY_RULES } = await import("../lib/guide.js");

let root = "";

/**
 * 进来时的 `DSH_HOME`，跑完要还原。
 *
 * 为什么必须把 `$DSH_HOME` 也关进临时目录：用户级落点 `$DSH_HOME/memory` 是
 * **真实路径**，这台机器上就有记忆文件。不隔离的话，「没有记忆文件时不注入」
 * 「L3 提醒只在干了实事时触发」这类用例会被真实用户记忆污染 —— 它们之前能过，
 * 只是因为那时机器上恰好还没有用户记忆。这类耦合必须切断，否则记忆库一有内容，
 * 测试就会莫名其妙地红。
 */
const savedDshHome = process.env.DSH_HOME;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-apply-"));
  process.env.DSH_HOME = join(root, "dsh-home");
});

after(async () => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  await rm(root, { recursive: true, force: true });
});

/**
 * 造一个最小 ctx，把注册动作都记下来。
 *
 * `inject` 会被真调用一次（而不是只记下来）：宿主侧的面板路由就挂在那儿，
 * 只记录不执行的话，「路由到底有没有挂上」这件事测不到。
 *
 * @param {object} [options] - `{ connection, webServer }`，置 false 表示这个
 *   profile 没有那个服务（命令行 / 无界面场景），用来验证面板是「跳过」而不是「崩掉」。
 * @returns {{ctx: object, sections: object[], tools: object[], handlers: Map,
 *            routes: Map, injects: object[], effects: object[]}} 替身与记录。
 */
function fakeCtx({ connection = true, webServer = true } = {}) {
  const sections = [];
  const tools = [];
  const handlers = new Map();
  const routes = new Map();
  const injects = [];
  const effects = [];
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    tools: {
      register(tool) {
        tools.push(tool);
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    inject(deps, callback) {
      injects.push({ deps, callback });
      if (!connection || !webServer) return;
      if (!deps.includes("connection") || !deps.includes("webServer")) return;
      callback({
        connection: { requestRejection: () => undefined },
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
        effect(factory, label) {
          effects.push({ label, dispose: factory() });
        },
      });
    },
  };
  return { ctx, sections, tools, handlers, routes, injects, effects };
}

/**
 * 造一对最小的 node:http req/res，用来**真的走一遍路由**。
 *
 * 面板的通道是 HTTP，只断言「注册了路由」测不出传输层的错（状态码、信封、
 * 路径解析）。这里让请求真的穿过去，再从响应里读回 `result` 信封。
 *
 * @param {string} endpoint - 端点名。
 * @param {unknown} payload - 载荷。
 * @returns {{req: object, res: object}} 请求与响应替身。
 */
function fakeHttpExchange(endpoint, payload) {
  const body = Buffer.from(
    JSON.stringify({ type: "client-request", rpcId: "r1", method: endpoint, payload }),
    "utf8",
  );
  const req = {
    method: "POST",
    url: `/dsh-memory/${endpoint}`,
    headers: {
      host: "127.0.0.1:3080",
      "content-type": "application/json",
      "content-length": String(body.byteLength),
    },
    destroy() {},
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (sent) return { value: undefined, done: true };
          sent = true;
          return { value: body, done: false };
        },
      };
    },
  };
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    on() {},
    once() {},
    off() {},
    /** 读回 server-response 里的 result 信封。 */
    result() {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8")).result;
    },
  };
  return { req, res };
}

/** 造一个假 session。 */
function fakeSession(cwd, id = "s1") {
  return { header: { cwd, id }, id };
}

/** 走一遍 agent/pre-step 钩子，返回注入的消息。 */
async function runPreStep(handlers, session, step = 1) {
  const results = [];
  for (const handler of handlers.get("agent/pre-step") ?? []) {
    const decision = { kind: "accept", messages: [] };
    const out = await handler(
      { agent: { session }, step, signal: { throwIfAborted() {} } },
      async () => decision,
    );
    results.push(out);
  }
  return results;
}

/** 走一遍 tools/result 钩子。 */
function runToolResult(handlers, exec, result = {}) {
  for (const handler of handlers.get("tools/result") ?? []) handler(exec, result);
}

test("导出形式符合 DSH 的 Host plugin 规范", () => {
  assert.equal(name, "dsh-memory");
  assert.deepEqual(inject, ["systemPrompt", "tools"]);
  assert.equal(typeof apply, "function");
  // 必须是**函数声明**而不是箭头函数：cordis 4 会把带 prototype 的 apply 当类
  // 构造函数 new 一遍，返回值被丢弃 —— 函数声明同样不依赖返回值，但这一点
  // 值得钉住，避免以后有人改成 `export const apply = ...` 又想靠返回值。
  assert.equal(typeof apply.prototype, "object");
  // Config 必须能导出（DSH 用它校验配置、渲染配置面板）。
  assert.equal(typeof Config, "object");
  assert.equal(typeof Config.shape, "object");
});

test("Config 覆盖了 DEFAULTS 里的每一项", async () => {
  const { DEFAULTS } = await import("../lib/config.js");
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(
      Object.hasOwn(Config.shape, key),
      true,
      `schema 里缺了配置项 ${key} —— 它会在配置面板里不可见`,
    );
  }
});

test("注册了 L1 规矩段：order 150、interpolate 关闭、正文是常量", () => {
  const { ctx, sections } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });

  assert.equal(sections.length, 1);
  const section = sections[0];
  assert.equal(section.name, "memory-rules");
  // DSH 的 SECTION_ORDERS 里没有 MEMORY 这一格，所以走的是兜底号。
  assert.equal(section.order, 150);
  // 必须显式关闭插值：记忆是自由文本，模型完全可能写进 `{{`，插值器会直接抛错。
  assert.equal(section.interpolate, false);
  assert.equal(section.text, MEMORY_RULES);
  // 必须是字符串常量，不能是函数 —— 内容一变，KV 前缀缓存就从该位置起全部失效。
  assert.equal(typeof section.text, "string");
});

test("规矩段的位置落在 persona 之后、策略之前（0 < order < 500）", async () => {
  const { ctx, sections } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });
  const { SECTION_ORDERS } = await import("./fixtures/section-orders.js");
  assert.equal(sections[0].order > SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX, true);
  assert.equal(sections[0].order < SECTION_ORDERS.PLAN_POLICY, true);
  // 也不能挤进任何工具段里 —— 那是工具说明的地盘，起始于 1000。
  assert.equal(sections[0].order < SECTION_ORDERS.TOOL_BASH, true);
});

test("注册表里有 MEMORY 这一格时跟随它，没有就用兜底号", () => {
  const { ctx, sections } = fakeCtx();
  ctx.systemPrompt.getSectionOrder = (name) => (name === "MEMORY" ? 1234 : undefined);
  apply(ctx, { projectMemoryDir: ".memory" });
  assert.equal(sections[0].order, 1234);
});

test("注册表返回非数字（拼错名字的典型后果）时也要退回兜底号，不能把 undefined 交给 section()", () => {
  const { ctx, sections } = fakeCtx();
  // 真实的 getSectionOrder 就是 `return SECTION_ORDERS[name]` —— 名字不存在时返回 undefined，
  // 而 section() 遇到非有限数会抛 TypeError。所以这里必须兜住。
  ctx.systemPrompt.getSectionOrder = () => undefined;
  assert.doesNotThrow(() => apply(ctx, { projectMemoryDir: ".memory" }));
  assert.equal(sections[0].order, 150);

  const { ctx: bare, sections: bareSections } = fakeCtx();
  delete bare.systemPrompt.getSectionOrder;
  assert.doesNotThrow(() => apply(bare, { projectMemoryDir: ".memory" }));
  assert.equal(bareSections[0].order, 150);
});

test("规矩段正文里不含 `{{`（否则即使关了插值也容易被误改回来）", () => {
  assert.equal(MEMORY_RULES.includes("{{"), false);
  // 但必须把「怎么用 memory_save」讲清楚，否则模型不知道有这个工具。
  assert.match(MEMORY_RULES, /memory_save/);
  assert.match(MEMORY_RULES, /topic/);
});

test("注册了 memory_save（写）与 memory_read（读）两个工具", () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });

  assert.equal(tools.length, 2);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_read", "memory_save"]);
  for (const tool of tools) assert.equal(typeof tool.execute, "function");

  // memory_save：参数必须是「topic + 正文 + 作用域」这一组，缺一不可。
  const save = tools.find((t) => t.name === "memory_save");
  assert.deepEqual(
    Object.keys(save.parameters).sort(),
    ["content", "mode", "reason", "scope", "section", "topic"],
  );
  assert.equal(save.parameters.topic.required, true);
  assert.equal(save.parameters.content.required, true);
  assert.equal(save.parameters.scope.required, true);
  // 可选参数**省略** `required`。DSH 的 value-schema DSL 只认 `required: true`，
  // 写 `required: false` 会让 defineTool 抛错、插件启动失败（见 test/tool.test.js）。
  for (const name of ["mode", "section", "reason"]) {
    assert.equal(
      Object.hasOwn(save.parameters[name], "required"),
      false,
      `parameters.${name} 不该带 required（可选 = 省略）`,
    );
  }

  // memory_read：仅 scope 必填，topic / keywords 都可选。
  const read = tools.find((t) => t.name === "memory_read");
  assert.deepEqual(Object.keys(read.parameters).sort(), ["keywords", "scope", "topic"]);
  assert.equal(read.parameters.scope.required, true);
  // 可选参数**省略** `required`（DSH 的 value-schema DSL 只认 `required: true`）。
  for (const name of ["topic", "keywords"]) {
    assert.equal(
      Object.hasOwn(read.parameters[name], "required"),
      false,
      `memory_read 的 ${name} 是可选参数，不该带 required`,
    );
  }
  // keywords 必须是**字符串**：数组写法的 DSL 支持度在本仓库验证不了，写错只会在
  // 装进真 DSH 时表现为「插件启动失败」。
  assert.equal(read.parameters.keywords.type, "string");
});

test("工具描述里必须写清「什么时候不要写」和「不确定就别写」", () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });
  const description = tools.find((t) => t.name === "memory_save").description;
  assert.match(description, /不确定就别调用/);
  assert.match(description, /不写/);
  assert.match(description, /元话语/);
});

test("memory_read 的描述必须讲清「按需读取」与「怎么读」", () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });
  const description = tools.find((t) => t.name === "memory_read").description;
  assert.match(description, /memory_read/);
  assert.match(description, /按需/);
  assert.match(description, /scope/);
});

test("注册了 tools/result 与 agent/pre-step 两个钩子", () => {
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory" });
  assert.equal(handlers.has("tools/result"), true);
  assert.equal(handlers.has("agent/pre-step"), true);
});

test("按需加载：有记忆文件时 pre-step 也不注入记忆快照；只有 L3 提醒走 notice form", async () => {
  // 改成按需加载后，记忆不再在会话开始时整批注入——模型需要时调 memory_read。
  // 所以 pre-step 不该再产生 snapshot 形态的注入；这里逐个核对 shape，确保
  // 「没有快照注入」与「L3 提醒的 notice 形状自洽」都成立。
  const cwd = await mkdtemp(join(root, "source-shape-"));
  await mkdir(join(cwd, ".memory"), { recursive: true });
  await writeFile(
    join(cwd, ".memory", "MEMORY.md"),
    [
      "- 缩进用 4 空格。<!-- id:m001 topic:indent at:2026-10-01 -->",
      "- [待裁决] 缩进用 2 空格。<!-- id:m002 topic:indent at:2026-10-12 conflict-with:m001 -->",
    ].join("\n"),
    "utf8",
  );

  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  // 第一轮：有记忆文件，但按需加载下不注入任何记忆快照。
  const first = await runPreStep(handlers, session, 1);
  assert.deepEqual(first[0].messages, []);

  // 改了若干文件后，L3 提醒走 form: "notice"，要求 summary 是非空字符串。
  for (const file of ["a.js", "b.js", "c.js"]) {
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });
  }
  const reminded = await runPreStep(handlers, session, 2);
  const notice = reminded[0].messages[0];
  assert.equal(notice.source.kind, "dsh-memory");
  assert.equal(notice.source.form, "notice");
  assert.equal(typeof notice.source.summary, "string");
  assert.notEqual(notice.source.summary, "");
  assert.match(notice.content[0].text, /memory_save/);
});

test("pre-step 注入的 form 都在 DSH 会话视图认识的集合里", async () => {
  // 未知 form 一律降级成不透明。按需加载后 pre-step 只可能产出 notice，这里
  // 确认它确实落在 DSH 客户端认识的集合内。
  const KNOWN_FORMS = ["instructions", "catalog", "snapshot", "notice", "relay", "recall"];
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(root);

  for (const file of ["a.js", "b.js", "c.js"]) {
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });
  }
  const out = await runPreStep(handlers, session, 1);
  for (const message of out[0].messages) {
    assert.equal(KNOWN_FORMS.includes(message.source.form), true);
  }
});

test("按需加载：pre-step 不注入记忆快照（记忆靠 memory_read 现读）", async () => {
  const cwd = await mkdtemp(join(root, "snapshot-"));
  await mkdir(join(cwd, ".memory"), { recursive: true });
  await writeFile(
    join(cwd, ".memory", "MEMORY.md"),
    "- 缩进用 4 空格。<!-- id:m001 topic:indent at:2026-10-01 -->\n",
    "utf8",
  );

  const { ctx, handlers, tools } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  // 第一轮：不注入任何记忆快照。
  const first = await runPreStep(handlers, session, 1);
  assert.deepEqual(first[0].messages, []);

  // 同一轮窗口内再跑 pre-step 仍然不注入。
  const second = await runPreStep(handlers, session, 2);
  assert.deepEqual(second[0].messages, []);

  // 改用 memory_read 现读，能拿到内容（且不带冻结窗口）。
  const read = tools.find((t) => t.name === "memory_read");
  const result = await read.execute({ scope: "both" }, { agent: { session } });
  assert.equal(result.ok, true);
  assert.match(result.text, /缩进用 4 空格。/);
});

test("memory_read 跨会话都读到同一份（不绑定某个会话）", async () => {
  const cwd = await mkdtemp(join(root, "two-sessions-"));
  await mkdir(join(cwd, ".memory"), { recursive: true });
  await writeFile(
    join(cwd, ".memory", "MEMORY.md"),
    "- 一条记忆。<!-- id:m001 topic:a at:2026-10-01 -->\n",
    "utf8",
  );

  const { ctx, tools } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const read = tools.find((t) => t.name === "memory_read");

  const a = await read.execute({ scope: "both" }, { agent: { session: fakeSession(cwd, "a") } });
  const b = await read.execute({ scope: "both" }, { agent: { session: fakeSession(cwd, "b") } });
  assert.match(a.text, /一条记忆。/);
  assert.match(b.text, /一条记忆。/);
});

test("按需加载：即使有记忆文件，pre-step 也不注入记忆快照", async () => {
  const cwd = await mkdtemp(join(root, "no-inject-"));
  await mkdir(join(cwd, ".memory"), { recursive: true });
  await writeFile(
    join(cwd, ".memory", "MEMORY.md"),
    "- 一条记忆。<!-- id:m001 topic:a at:2026-10-01 -->\n",
    "utf8",
  );

  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const out = await runPreStep(handlers, fakeSession(cwd), 1);
  assert.deepEqual(out[0].messages, []);
});

test("没有记忆文件时不注入（不塞一个空的 <memory> 标签）", async () => {
  const cwd = await mkdtemp(join(root, "empty-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const out = await runPreStep(handlers, fakeSession(cwd), 1);
  assert.deepEqual(out[0].messages, []);
});

test("pre-step 的 decision 必须原样 spread，不能替换掉", async () => {
  const cwd = await mkdtemp(join(root, "spread-"));
  await mkdir(join(cwd, ".memory"), { recursive: true });
  await writeFile(
    join(cwd, ".memory", "MEMORY.md"),
    "- 一条记忆。<!-- id:m001 topic:a at:2026-10-01 -->\n",
    "utf8",
  );

  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });

  // 假装上游的监听器往 decision 上挂了字段 —— 丢掉它们会出问题。
  const upstream = { kind: "accept", messages: [{ role: "user" }], startsRequestSeries: true };
  const out = await handlers.get("agent/pre-step")[0](
    { agent: { session: fakeSession(cwd) }, step: 1, signal: { throwIfAborted() {} } },
    async () => upstream,
  );

  assert.equal(out.kind, "accept");
  assert.equal(out.startsRequestSeries, true);
  // 按需加载下没有记忆快照注入，只有上游自带的消息（无提醒）。
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0], upstream.messages[0]);
});

test("上游 reject 时直接放行，不做任何事", async () => {
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });

  const rejected = { kind: "reject", reason: "nope" };
  const out = await handlers.get("agent/pre-step")[0](
    { agent: { session: fakeSession(root) }, step: 1, signal: { throwIfAborted() {} } },
    async () => rejected,
  );
  assert.equal(out, rejected);
});

test("L3 提醒：改了若干文件但没写记忆 → 提醒一次，且只一次", async () => {
  const cwd = await mkdtemp(join(root, "remind-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  const write = (file) =>
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });

  write("src/a.js");
  write("src/b.js");
  let out = await runPreStep(handlers, session, 1);
  assert.deepEqual(out[0].messages, []); // 还差一个

  write("src/c.js");
  out = await runPreStep(handlers, session, 2);
  assert.equal(out[0].messages.length, 1);
  assert.equal(out[0].messages[0].source.form, "notice");
  assert.match(out[0].messages[0].content[0].text, /memory_save/);

  // 同一轮不会再提醒。
  out = await runPreStep(handlers, session, 2);
  assert.deepEqual(out[0].messages, []);
});

test("写记忆文件本身不算「干了实事」（否则写完又被提醒，死循环）", async () => {
  const cwd = await mkdtemp(join(root, "self-write-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  for (const file of ["src/a.js", "src/b.js", ".memory/MEMORY.md", ".memory/runs.jsonl"]) {
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });
  }

  const out = await runPreStep(handlers, session, 1);
  assert.deepEqual(out[0].messages, []);
});

test("失败的写入不计入提醒阈值", async () => {
  const cwd = await mkdtemp(join(root, "failed-write-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  for (const file of ["src/a.js", "src/b.js", "src/c.js"]) {
    runToolResult(
      handlers,
      { name: "write", arguments: { file_path: file }, agent: { session } },
      { isError: true },
    );
  }
  const out = await runPreStep(handlers, session, 1);
  assert.deepEqual(out[0].messages, []);
});

test("调用过 memory_save 之后提醒计数清零", async () => {
  const cwd = await mkdtemp(join(root, "after-save-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });
  const session = fakeSession(cwd);

  for (const file of ["src/a.js", "src/b.js", "src/c.js"]) {
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });
  }
  runToolResult(
    handlers,
    { name: "memory_save", arguments: {}, agent: { session } },
    { isError: false },
  );

  const out = await runPreStep(handlers, session, 1);
  assert.deepEqual(out[0].messages, []);
});

test("writeReminder 关掉时不提醒", async () => {
  const cwd = await mkdtemp(join(root, "no-remind-"));
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", writeReminder: false, verifyOnStart: false });
  const session = fakeSession(cwd);

  for (const file of ["a.js", "b.js", "c.js"]) {
    runToolResult(handlers, {
      name: "write",
      arguments: { file_path: file },
      agent: { session },
    });
  }
  const out = await runPreStep(handlers, session, 1);
  assert.deepEqual(out[0].messages, []);
});

test("读不到记忆文件时 fail-open：不抛错、不阻塞", async () => {
  // 用一个不可能存在、也不可能创建的路径（Windows 上 `?` 非法）。
  const { ctx, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: "?", verifyOnStart: false });
  const out = await runPreStep(handlers, fakeSession(root), 1);
  assert.equal(Array.isArray(out[0].messages), true);
});

test("传入 null 配置也能用（走默认值）", () => {
  const { ctx, sections, tools } = fakeCtx();
  apply(ctx, null);
  assert.equal(sections.length, 1);
  assert.equal(tools.length, 2);
});

test("没有任何 ctx 子服务时不应崩（inject 会拦住这种情况，但保险起见）", () => {
  // 真实 DSH 里 inject 没满足就不会调用 apply；这里只确认 apply 本身不依赖
  // 别的隐藏服务。
  const { ctx } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, { projectMemoryDir: ".memory" }));
});

test("端到端冒烟：写入 → 去重 → 下一会话注入 → 冲突冻结", async () => {
  const cwd = await mkdtemp(join(root, "e2e-"));
  const { ctx, tools, handlers } = fakeCtx();
  apply(ctx, { projectMemoryDir: ".memory", verifyOnStart: false });

  const tool = tools[0];
  const exec = { agent: { session: fakeSession(cwd) } };
  const base = { topic: "indent-style", scope: "project", section: "约定" };

  // 1. 第一次写 → created
  const saved = await tool.execute({ ...base, content: "缩进用 4 空格。" }, exec);
  assert.equal(saved.ok, true);
  assert.equal(saved.action, "created");
  assert.equal(saved.id, "m001");

  // 2. 同一会话再写一遍 → deduped
  const again = await tool.execute({ ...base, content: "缩进用 4 空格。" }, exec);
  assert.equal(again.action, "deduped");
  assert.equal(again.id, "m001");

  // 3. 换个大小写写同一条 → 仍然 deduped（topic 与内容都归一化后比较）
  const recased = await tool.execute(
    { ...base, topic: "Indent-Style", content: "缩进用 4 空格" },
    exec,
  );
  assert.equal(recased.action, "deduped");

  // 4. 新会话里用 memory_read 现读 → 拿到刚写的内容（按需加载，不靠注入）
  const read = tools.find((t) => t.name === "memory_read");
  const readResult = await read.execute(
    { scope: "both" },
    { agent: { session: fakeSession(cwd, "s2") } },
  );
  assert.equal(readResult.ok, true);
  const snapshot = readResult.text;
  assert.match(snapshot, /^<memory>/);
  assert.match(snapshot, /<project_memory path="[^"]*\.memory\/MEMORY\.md"/);
  assert.match(snapshot, /- 缩进用 4 空格。/);

  // 5. 写一条结论矛盾的 → conflicted
  const conflict = await tool.execute({ ...base, content: "缩进用 2 空格。" }, exec);
  assert.equal(conflict.action, "conflicted");
  assert.equal(conflict.id, "m002");

  // 6. 再读一次 → 冲突冻结：只有计数，没有待裁决的正文；已确认的那条仍在
  const readAgain = await read.execute(
    { scope: "both" },
    { agent: { session: fakeSession(cwd, "s3") } },
  );
  const text = readAgain.text;
  assert.match(text, /<conflicts pending="1">/);
  assert.match(text, /有 1 组待裁决的冲突（indent-style）/);
  assert.equal(text.includes("缩进用 2 空格。"), false);
  // 已确认的那条仍然要带上。
  assert.match(text, /- 缩进用 4 空格。/);

  // 7. 工具返回给模型看的文本
  const rendered = tool.output.render({}, saved);
  assert.match(rendered[0].text, /已写入 m001/);
  assert.match(rendered[0].text, /\[项目记忆 \d+% \(\d+\/\d+ bytes\)\]/);

  const conflictRendered = tool.output.render({}, conflict);
  assert.match(conflictRendered[0].text, /待裁决/);
});

test("工具执行时没有 agent 也不崩（cwd 回退到 process.cwd()）", async () => {
  const dir = await mkdtemp(join(root, "no-agent-"));
  const { ctx, tools } = fakeCtx();
  // projectMemoryDir 用绝对路径，这样即使回退到 process.cwd() 也只落在临时目录里。
  apply(ctx, { projectMemoryDir: join(dir, "mem"), verifyOnStart: false });

  const result = await tools[0].execute({ topic: "", content: "", scope: "project" }, {});
  assert.equal(result.ok, false);
  assert.equal(result.action, "rejected");

  // 空输入连盘都不该碰，但审计要留痕。
  const { readRuns } = await import("../lib/audit.js");
  const runs = await readRuns(join(dir, "mem", "runs.jsonl"), 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].reason, "blank");
  assert.equal(runs[0].session, null);
});

test("面板 RPC：connection + webServer 在时挂上 /dsh-memory 前缀路由，且不写进 inject", async () => {
  // `connection` / `webServer` 绝不能进 `inject` —— inject 里声明了但 profile
  // 里没有的服务会让**整个插件不激活**。命令行 / 无界面的 profile 两个都没有，
  // 记忆功能却仍然要能用，所以面板是「有就挂、没有就跳过」。
  assert.equal(inject.includes("connection"), false);
  assert.equal(inject.includes("webServer"), false);

  const dir = await mkdtemp(join(root, "rpc-"));
  const { ctx, routes, injects, effects } = fakeCtx();
  apply(ctx, { projectMemoryDir: join(dir, "mem"), verifyOnStart: false });

  assert.equal(injects.length, 1);
  assert.deepEqual(injects[0].deps, ["connection", "webServer"]);

  assert.deepEqual([...routes.keys()], ["/dsh-memory"]);
  const route = routes.get("/dsh-memory");
  assert.equal(route.kind, "prefix");
  assert.equal(typeof route.handler, "function");

  // 必须挂在 effect 里 —— 插件卸载时要能把路由摘掉。
  assert.equal(effects.length, 1);
  assert.match(effects[0].label, /dsh-memory/);
});

test("面板 RPC：缺 connection 或 webServer 时安静跳过，插件照常工作", async () => {
  for (const missing of [{ connection: false }, { webServer: false }]) {
    const dir = await mkdtemp(join(root, "rpc-none-"));
    const { ctx, sections, tools, routes } = fakeCtx(missing);
    assert.doesNotThrow(() =>
      apply(ctx, { projectMemoryDir: join(dir, "mem"), verifyOnStart: false }),
    );

    // 规矩段与工具仍然注册了 —— 面板只是可有可无的一层。
    assert.equal(sections.length, 1);
    assert.equal(tools.length, 2);
    assert.equal(routes.size, 0);
  }
});

test("面板 RPC：工作目录来自最近一次会话，面板自己不能指定", async () => {
  const dir = await mkdtemp(join(root, "rpc-cwd-"));
  const { ctx, handlers, routes } = fakeCtx();
  apply(ctx, { projectMemoryDir: join(dir, "mem"), verifyOnStart: false });

  const route = routes.get("/dsh-memory");
  /** 真的把一次请求穿过去，读回端点信封。 */
  async function call(endpoint, payload) {
    const { req, res } = fakeHttpExchange(endpoint, payload);
    await route.handler(req, res);
    assert.equal(res.status, 200);
    return res.result();
  }

  // 还没跑过任何会话 → 宿主不知道工作目录，端点要如实拒绝。
  const early = await call("snapshot", {});
  assert.equal(early.ok, false);
  assert.equal(early.error.code, "no-workspace");

  // 跑一轮 pre-step 之后，宿主就记住了这个工作区。
  const cwd = join(dir, "workspace");
  await mkdir(cwd, { recursive: true });
  await runPreStep(handlers, fakeSession(cwd, "s1"), 1);

  const later = await call("snapshot", { cwd: "D:/某个不存在的路径" });
  assert.equal(later.ok, true);
  assert.equal(later.value.cwd, cwd, "必须用宿主记的 cwd，不能听载荷里的");
});
