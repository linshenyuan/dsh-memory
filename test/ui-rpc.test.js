/**
 * 面板 RPC 端点的测试。
 *
 * 这一层是「浏览器」和「磁盘」之间唯一的接口，所以除了功能，还有两件事必须钉住：
 *
 * 1. **信封形状是严格的。** 客户端那侧的 `parseConnectionResponse` 逐字段校验
 *    `{ok, error:{code, message, details}}`，`details` 必须是对象 —— 少给一个
 *    `details`，整条响应被判非法，浏览器只看到一个 TypeError，面板显示的是
 *    「未知错误」而不是真正的原因。
 *
 * 2. **工作目录只认宿主记的那个。** 裁决会写盘。如果让 payload 里的 `cwd` 生效，
 *    这个端点就变成了「往任意路径写文件」的口子 —— 面板是浏览器里的东西，
 *    它给的路径不可信。
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { resolveConfig } from "../lib/config.js";
import { readText, writeAtomic } from "../lib/store.js";
import { CHANNEL, ENDPOINTS, createRpcHandler } from "../lib/ui/rpc.js";

/** 宿主侧 channel 的准入规则（来自 dsh-client-connection 的 assertChannel）。 */
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
/** 端点段的准入规则。 */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

let root = "";
let cfg = null;

/** 记忆目录（绝对路径，避开 $DSH_HOME）。 */
function memoryDir() {
  return join(root, "memory");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-ui-rpc-"));
  cfg = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一份带冲突的 MEMORY.md。 */
async function seed() {
  await rm(memoryDir(), { recursive: true, force: true });
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(
    join(memoryDir(), "MEMORY.md"),
    [
      "- 缩进用 2 个空格 <!-- id:m001 topic:indent at:2026-10-01 -->",
      "- [待裁决] 缩进用 4 个空格 <!-- id:m002 topic:indent at:2026-10-05 conflict-with:m001 -->",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 面板设置的覆盖文件（临时路径，别碰真实 $DSH_HOME）。 */
function settingsFile() {
  return join(root, "dsh-memory.settings.json");
}

/** 造一个处理器。 */
function handler({ cwd = root } = {}) {
  return createRpcHandler({
    getCwd: () => cwd,
    cfg,
    readText,
    writeText: writeAtomic,
    settingsFile: settingsFile(),
  });
}

/** 断言信封是客户端那侧能接受的成功形状。 */
function assertOkEnvelope(result) {
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, "value"), true);
}

/** 断言信封是客户端那侧能接受的失败形状。 */
function assertFailEnvelope(result, code) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "object");
  assert.equal(typeof result.error.code, "string");
  assert.equal(typeof result.error.message, "string");
  assert.equal(result.error.message.length > 0, true);
  assert.equal(typeof result.error.details, "object");
  assert.notEqual(result.error.details, null);
  assert.equal(Array.isArray(result.error.details), false);
  if (code !== undefined) assert.equal(result.error.code, code);
}

test("channel 与端点名都符合宿主的准入规则", () => {
  assert.match(CHANNEL, CHANNEL_PATTERN);
  assert.notEqual(CHANNEL, "/api", "`/api` 是保留的共享通道，只能 intercept 不能 handle");
  assert.deepEqual([...ENDPOINTS], ["snapshot", "resolve", "edit", "settings", "audit.clear"]);
  for (const endpoint of ENDPOINTS) assert.match(endpoint, ENDPOINT_PATTERN);
});

test("snapshot：返回聚合好的面板数据", async () => {
  await seed();
  const result = await handler()("snapshot", {});
  assertOkEnvelope(result);
  assert.equal(result.value.cwd, root);
  assert.equal(result.value.totals.entries, 2);
  assert.equal(result.value.totals.conflicts, 1);
  assert.equal(result.value.scopes.length, 2);
});

test("snapshot 对空载荷、怪载荷都容错（面板刷新时不带参数）", async () => {
  await seed();
  for (const payload of [undefined, null, "字符串", 42, []]) {
    const result = await handler()("snapshot", payload);
    assertOkEnvelope(result);
  }
});

test("resolve：走完裁决链路并返回业务结果", async () => {
  await seed();
  const result = await handler()("resolve", { scope: "project", topic: "indent", action: "keep-a" });
  assertOkEnvelope(result);
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.value.kept, ["m001"]);
  assert.deepEqual(result.value.dropped, ["m002"]);
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("缩进用 2 个空格"), true);
  assert.equal(text.includes("缩进用 4 个空格"), false);
});

test("resolve：参数不合法时给出机器可读的错误码，不是笼统失败", async () => {
  await seed();
  assertFailEnvelope(
    await handler()("resolve", { scope: "global", topic: "indent", action: "keep-a" }),
    "bad-scope",
  );
  assertFailEnvelope(
    await handler()("resolve", { scope: "project", topic: "  ", action: "keep-a" }),
    "bad-topic",
  );
  assertFailEnvelope(
    await handler()("resolve", { scope: "project", topic: "indent", action: "keep-z" }),
    "bad-action",
  );
});

test("resolve：冲突已经不存在时如实传下去，不假装成功", async () => {
  await seed();
  const result = await handler()("resolve", { scope: "project", topic: "不存在", action: "keep-a" });
  assertFailEnvelope(result, "resolve-rejected");
  assert.match(result.error.message, /已经没有待裁决的条目/);
});

test("未知端点：报错而不是静默返回空", async () => {
  const result = await handler()("delete-everything", {});
  assertFailEnvelope(result, "unknown-endpoint");
});

test("edit：新增一条会写盘，新内容出现在文件里", async () => {
  await seed();
  const result = await handler()("edit", {
    scope: "project",
    action: "add",
    topic: "foo",
    content: "bar 内容",
    section: "约定",
  });
  assertOkEnvelope(result);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.action, "add");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("bar 内容"), true);
  assert.equal(text.includes("id:"), true);
});

test("edit：改一条已有条目（按 id 定位）", async () => {
  await seed();
  const result = await handler()("edit", {
    scope: "project",
    action: "update",
    id: "m001",
    content: "改过的正文",
  });
  assertOkEnvelope(result);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.id, "m001");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("改过的正文"), true);
  assert.equal(text.includes("缩进用 2 个空格"), false);
});

test("edit：删一条（按 id 定位）", async () => {
  await seed();
  const result = await handler()("edit", {
    scope: "project",
    action: "delete",
    id: "m001",
  });
  assertOkEnvelope(result);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.id, "m001");
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("id:m001"), false);
});

test("edit：参数不合法时给出机器可读错误码，不是笼统失败", async () => {
  await seed();
  assertFailEnvelope(
    await handler()("edit", { scope: "project", action: "frobnicate" }),
    "bad-action",
  );
  assertFailEnvelope(
    await handler()("edit", { scope: "project", action: "add", topic: "", content: "x" }),
    "bad-topic",
  );
  assertFailEnvelope(
    await handler()("edit", { scope: "project", action: "add", topic: "x", content: "" }),
    "bad-content",
  );
  assertFailEnvelope(
    await handler()("edit", { scope: "project", action: "delete" }),
    "bad-target",
  );
});

test("edit：定位不到条目时如实传下去，不假装成功", async () => {
  await seed();
  const result = await handler()("edit", {
    scope: "project",
    action: "update",
    id: "nope",
    content: "x",
  });
  assertFailEnvelope(result, "edit-rejected");
  assert.match(result.error.message, /找不到要操作的条目/);
});

test("edit：载荷里的 cwd 一律忽略，只写宿主记的目录", async () => {
  await seed();
  const elsewhere = join(root, "elsewhere");
  const result = await handler()("edit", {
    cwd: elsewhere,
    scope: "project",
    action: "add",
    topic: "x",
    content: "y",
  });
  assertOkEnvelope(result);
  // 真正被改的必须是宿主记的那个目录。
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("x"), true);
  // 载荷指的地方一个文件都不该出现。
  await assert.rejects(() => stat(join(elsewhere, "MEMORY.md")));
});

test("还没记录工作目录时：给出能看懂的提示", async () => {
  const result = await handler({ cwd: null })("snapshot", {});
  assertFailEnvelope(result, "no-workspace");
  assert.match(result.error.message, /工作目录/);
});

test("载荷里的 cwd 一律忽略 —— 不能让浏览器指定写盘位置", async () => {
  await seed();
  const elsewhere = join(root, "elsewhere");
  const result = await handler()("resolve", {
    cwd: elsewhere,
    scope: "project",
    topic: "indent",
    action: "keep-b",
  });
  assertOkEnvelope(result);
  // 真正被改的必须是宿主记的那个目录。
  const text = await readFile(join(memoryDir(), "MEMORY.md"), "utf8");
  assert.equal(text.includes("缩进用 4 个空格"), true);
  // 载荷指的地方一个文件都不该出现。
  await assert.rejects(() => stat(join(elsewhere, "MEMORY.md")));
});

test("聚合层本身炸了也是 ok:false（而不是把异常抛穿 RPC 层）", async () => {
  const boom = createRpcHandler({
    getCwd: () => root,
    cfg,
    readText: async () => {
      throw new Error("boom");
    },
    writeText: writeAtomic,
  });
  const result = await boom("snapshot", {});
  // collectPanelData 逐作用域兜底，所以这里其实是「成功但每个作用域都带 error」。
  assertOkEnvelope(result);
  assert.equal(result.value.scopes.every((s) => s.error !== null), true);
});

test("settings：保存上限 → 落盘 + 就地改 cfg（立即生效）", async () => {
  const c = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
  const h = createRpcHandler({
    getCwd: () => root,
    cfg: c,
    readText,
    writeText: writeAtomic,
    settingsFile: settingsFile(),
  });

  await rm(settingsFile(), { force: true });
  const result = await h("settings", { projectMaxBytes: 4096, userMaxBytes: 8192 });
  assertOkEnvelope(result);
  assert.equal(result.value.projectMaxBytes, 4096);
  assert.equal(result.value.userMaxBytes, 8192);

  // 立即生效：共享的 cfg 对象被就地改了 —— 工具 / 面板 / 钩子持有的是同一个引用。
  assert.equal(c.projectMaxBytes, 4096);
  assert.equal(c.userMaxBytes, 8192);

  // 也落了盘，下次启动还在。
  const saved = JSON.parse(await readFile(settingsFile(), "utf8"));
  assert.deepEqual(saved, { projectMaxBytes: 4096, userMaxBytes: 8192 });
});

test("settings：参数非法 → 拒绝，且不写盘、不改 cfg", async () => {
  const c = resolveConfig({
    projectMemoryDir: memoryDir(),
    userMemoryDir: join(root, "user-memory"),
  });
  const h = createRpcHandler({
    getCwd: () => root,
    cfg: c,
    readText,
    writeText: writeAtomic,
    settingsFile: settingsFile(),
  });
  await rm(settingsFile(), { force: true });
  const before = { ...c };

  for (const payload of [
    {}, // 两个都没给
    { projectMaxBytes: 4096 }, // 少一个
    { projectMaxBytes: "4096", userMaxBytes: 4096 }, // 字符串（不做隐式转换）
    { projectMaxBytes: 1, userMaxBytes: 4096 }, // 低于下限
    { projectMaxBytes: 4096, userMaxBytes: 1e9 }, // 高于上限
  ]) {
    const result = await h("settings", payload);
    assertFailEnvelope(result, "bad-limits");
    assert.equal(c.projectMaxBytes, before.projectMaxBytes, "非法参数不该改 cfg");
    assert.equal(c.userMaxBytes, before.userMaxBytes, "非法参数不该改 cfg");
  }
  await assert.rejects(() => readFile(settingsFile(), "utf8"), "非法参数不该写盘");
});

test("snapshot 带上当前上限与默认值（面板设置区要用）", async () => {
  await seed();
  const result = await handler()("snapshot", {});
  assertOkEnvelope(result);
  assert.equal(typeof result.value.limits.current.projectMaxBytes, "number");
  assert.equal(typeof result.value.limits.defaults.projectMaxBytes, "number");
  assert.equal(typeof result.value.limits.defaults.userMaxBytes, "number");
});

test("audit.clear：删掉目标行 + 写 clear 标记，且 snapshot 自检仍一致", async () => {
  await seed();
  const runsPath = join(memoryDir(), "runs.jsonl");
  await writeFile(
    runsPath,
    [
      JSON.stringify({ at: "2026-10-12T00:00:00Z", op: "save", id: "m001", topic: "indent" }),
      JSON.stringify({ at: "2026-10-12T00:01:00Z", op: "save", id: "m002", topic: "indent" }),
    ].join("\n") + "\n",
    "utf8",
  );

  const result = await handler()("audit.clear", {
    scope: "project",
    at: "2026-10-12T00:00:00Z",
    op: "save",
    id: "m001",
  });
  assertOkEnvelope(result);
  assert.equal(result.value.cleared, true);

  const text = await readFile(runsPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 2, "删 1 行 + 加 1 clear 标记 = 2 行");
  assert.equal(JSON.parse(lines[0]).op, "save");
  assert.equal(JSON.parse(lines[0]).id, "m002", "原 m002 行还在");
  assert.equal(JSON.parse(lines[1]).op, "clear");

  // 记忆没动；清掉 m001 的 save 行后，clear 标记（origOp=save）压掉 missing —— 自检仍一致。
  const snap = await handler()("snapshot", {});
  const project = snap.value.scopes.find((s) => s.scope === "project");
  assert.equal(project.replay.ok, true, "清掉 save 行后自检仍一致");
});

test("audit.clear：参数不合法时给机器可读错误码，不写盘", async () => {
  await seed();
  const runsPath = join(memoryDir(), "runs.jsonl");
  await writeFile(runsPath, JSON.stringify({ at: "2026-10-12T00:00:00Z", op: "save", id: "m001" }) + "\n", "utf8");

  assertFailEnvelope(await handler()("audit.clear", { scope: "galaxy", at: "x" }), "bad-scope");
  assertFailEnvelope(await handler()("audit.clear", { scope: "project" }), "bad-target");

  // 失败不该改写文件。
  const text = await readFile(runsPath, "utf8");
  assert.equal(text.includes('"op":"clear"'), false);
});
