/**
 * 包清单契约测试。
 *
 * 这些约束散落在 DSH 的加载器里（`dsh-app-boot` 的 `readPluginMeta` /
 * `dsh-plugin-manager` 的安装路径），任何一条踩错都不会让插件报错 —— 只会让
 * **图标或标题静默消失**，或者在解析 locale 时抛一个和记忆功能毫不相干的错。
 * 所以在这里一次性钉住。
 */
import { strict as assert } from "node:assert";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** 读 JSON。 */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** 文件是否存在且是普通文件。 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const manifest = await readJson(join(ROOT, "package.json"));

/** DSH `dsh-app-boot` 里的常量，抄一份用于校验。 */
const MAX_ICON_BYTES = 256 * 1024;
const ICON_MEDIA_TYPES = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

test("bundle patch 指向一个真实存在的文件", async () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, "string");
  assert.equal(isAbsolute(patch), false, "patch 必须是相对路径");
  assert.equal(await isFile(join(ROOT, patch)), true);
});

test("cordis.patch.yml 里的插件名与 package.json 一致", async () => {
  const text = await readFile(join(ROOT, "cordis.patch.yml"), "utf8");
  assert.match(text, /^-\s*insert:/m);
  // 名字必须与 package.json 的 name 一模一样，否则 DSH 解析不到这个包。
  assert.equal(text.includes(`'${manifest.name}'`), true, `patch 里没写 '${manifest.name}'`);
});

test("exports 必须暴露 package.json 与 locale/*.json", () => {
  // DSH 是用 Node 的 ESM 解析器去解析 `${specifier}/locale/en.json` 和
  // `${specifier}/package.json` 的（`resolvePluginResource`）。没导出就直接
  // ERR_PACKAGE_PATH_NOT_EXPORTED —— 表现是图标和标题「静默没有」。
  const exports = manifest.exports;
  assert.equal(typeof exports, "object");
  assert.equal(typeof exports["."], "string", "缺 `exports['.']` —— 插件根本加载不了");
  assert.equal(
    typeof exports["./package.json"],
    "string",
    "缺 `exports['./package.json']` —— 图标和标题读不到",
  );
  assert.equal(
    typeof exports["./locale/*.json"],
    "string",
    "缺 `exports['./locale/*.json']` —— locale 解析不到，插件元数据会报错或降级",
  );
});

test("入口文件真的存在", async () => {
  assert.equal(await isFile(join(ROOT, manifest.exports["."])), true);
});

test("客户端半侧：exports['./client'] 必须存在且指向真实文件", async () => {
  // `dsh-client-modules` 的 `clientExportOf` 只认 `exports["./client"]`，
  // 且必须是字符串（或 `{default: 字符串}`）。它不读 `main`，也不猜路径。
  const client = manifest.exports["./client"];
  assert.equal(typeof client, "string", "缺 `exports['./client']` —— 浏览器侧加载不到面板");
  assert.equal(await isFile(join(ROOT, client)), true, `${client} 不存在`);
  // 声明了 client 就必须同时声明 dsh.client，否则加载器不知道该怎么装它。
  assert.equal(typeof manifest.dsh?.client, "object", "有 ./client 却没有 dsh.client 声明");
});

test("dsh.client 声明：platform 必填，inject 是字符串数组，immediately 是布尔", async () => {
  const decl = manifest.dsh.client;
  // 这三个字段的校验写在 `parseDshClient` 里，形状不对会在启动时抛错，
  // 而且错误信息跟记忆功能毫无关系 —— 所以在这里就钉住。
  assert.equal(typeof decl.platform, "string");
  assert.notEqual(decl.platform.trim(), "");
  assert.equal(decl.platform, "web", "面板是浏览器 UI，platform 只能是 web");

  if (decl.inject !== undefined) {
    assert.equal(Array.isArray(decl.inject), true);
    for (const name of decl.inject) assert.equal(typeof name, "string");
  }
  if (decl.immediately !== undefined) assert.equal(typeof decl.immediately, "boolean");
});

test("dsh.client.inject 只列真实的 client 插件包，且不含本包自己", () => {
  const decl = manifest.dsh.client;
  const inject = decl.inject ?? [];
  // 列进来的名字会在启动时拿去和 loader 里的包名比对（orderByModuleGraph），
  // 拼错了不会报错，只会让顺序退化成扫描顺序。
  assert.equal(inject.includes(manifest.name), false, "不该把自己列进 inject");
  // 面板要用 `slots` 与 `locale` 两个服务，它们的提供方必须在 inject 里。
  assert.equal(inject.includes("@deepseek-ai/dsh-client-ui-settings"), true, "settings.section 槽由它声明");
  assert.equal(inject.includes("@deepseek-ai/dsh-client-locale"), true, "locale 服务由它提供");
  // ui-slots / ui-primitives 是**静态种子**（打进 shell 的），不是 client 插件包，
  // 列进来没有意义 —— 它们没有 dsh.client 声明，构不成图上的边。
  assert.equal(inject.includes("@deepseek-ai/dsh-client-ui-slots"), false);
  assert.equal(inject.includes("@deepseek-ai/dsh-client-ui-primitives"), false);
});

test("dsh.manifestVersion 是 1", () => {
  assert.equal(manifest.dsh.manifestVersion, 1);
});

test("icon：相对路径、受支持的格式、是普通文件、不超过 256 KiB", async () => {
  const icon = manifest.icon;
  assert.equal(typeof icon, "string");
  // DSH 明确拒绝绝对路径和带协议的路径。
  assert.equal(isAbsolute(icon), false, "icon 必须是相对路径");
  assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), false, "icon 不能带协议前缀");

  assert.equal(ICON_MEDIA_TYPES.has(extname(icon).toLowerCase()), true, "只接受 svg/png/jpg/jpeg/webp");

  const file = resolve(ROOT, icon);
  assert.equal(await isFile(file), true, "icon 必须是普通文件");

  // 必须落在 manifest 目录内（DSH 会做 realpath 检查）。
  const local = relative(ROOT, file);
  assert.equal(local !== ".." && !local.startsWith(`..${sep}`), true, "icon 必须留在包目录内");

  const size = (await stat(file)).size;
  assert.equal(size <= MAX_ICON_BYTES, true, `icon 超过 256 KiB（当前 ${size} 字节）`);
});

test("locale 文件：命名合法、同目录、meta 字段非空", async () => {
  const dir = join(ROOT, "locale");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  assert.equal(names.length > 0, true, "至少要有一个 locale 文件");

  // en.json 是 DSH 定位整个 locale 目录的锚点 —— 少了它其余文件全都不读。
  assert.equal(names.includes("en.json"), true, "缺 en.json，DSH 找不到 locale 目录");

  const seen = new Set();
  for (const name of names) {
    const language = name.slice(0, -".json".length);
    assert.equal(LANGUAGE_ID.test(language), true, `${name}: 文件名必须是语言 id`);
    assert.equal(seen.has(language.toLowerCase()), false, `${name}: 语言 id 重复`);
    seen.add(language.toLowerCase());

    const parsed = await readJson(join(dir, name));
    assert.equal(typeof parsed.meta, "object", `${name}: 缺 meta`);
    // DSH 用 textOf 校验：存在就必须是非空字符串，否则整个插件元数据报错。
    assert.equal(typeof parsed.meta.title, "string", `${name}: meta.title 必须是字符串`);
    assert.notEqual(parsed.meta.title.trim(), "", `${name}: meta.title 不能为空`);
    assert.equal(typeof parsed.meta.description, "string", `${name}: meta.description 必须是字符串`);
    assert.notEqual(parsed.meta.description.trim(), "", `${name}: meta.description 不能为空`);
  }
});

test("中英文 locale 的字段必须对齐（少一个键就会在切换语言时露馅）", async () => {
  const en = await readJson(join(ROOT, "locale", "en.json"));
  const zh = await readJson(join(ROOT, "locale", "zh.json"));
  assert.deepEqual(Object.keys(en.meta).sort(), Object.keys(zh.meta).sort());
});

test("files 里声明的每一项都真实存在", async () => {
  for (const entry of manifest.files) {
    const target = join(ROOT, entry);
    const info = await stat(target);
    assert.equal(info.isFile() || info.isDirectory(), true, `files 里声明了不存在的 ${entry}`);
  }
  // 双面插件：两半都必须真的会被装进去。
  const covered = (rel) =>
    manifest.files.some((entry) => entry === rel || (entry.endsWith("/") ? false : rel === entry) || rel.startsWith(`${entry}/`));
  assert.equal(covered("lib/index.js"), true, "files 没覆盖宿主半侧");
  assert.equal(covered("lib/client.js"), true, "files 没覆盖客户端半侧");
  assert.equal(covered("locale/zh.json"), true, "files 没覆盖 locale");
});

test("零依赖：不声明 dependencies / peerDependencies / 安装脚本", () => {
  // 官方 Host plugin 模板的原话：不需要依赖、安装脚本或构建工具。
  // 有依赖就意味着 DSH 加载时要跑包管理器 —— 那是另一条完全不同的安装路径。
  // 客户端半侧同样零依赖：react 与官方组件库都是浏览器里的静态种子，
  // 走 `require` 直接命中，不需要（也不能）在这里声明成包依赖。
  assert.equal(manifest.dependencies, undefined, "不该声明 dependencies");
  assert.equal(manifest.peerDependencies, undefined, "不该声明 peerDependencies");
  assert.equal(manifest.scripts?.postinstall, undefined, "不该有 postinstall");
  assert.equal(manifest.scripts?.prepare, undefined, "不该有 prepare");
  assert.equal(manifest.scripts?.build, undefined, "客户端 bundle 是手写的，不该有构建步骤");
});

test("ESM 与发布标记", () => {
  assert.equal(manifest.type, "module");
  // 现在是对外开源包（MIT）—— 不再带「本地私有、不该被误发布」的 private 标记。
  assert.equal(manifest.private, undefined, "已转为公开包，不应再有 private 标记");
  assert.equal(manifest.license, "MIT", "公开包应声明许可证");
});

test("README 里写清楚了落点、装法与位置选择的理由", async () => {
  const text = await readFile(join(ROOT, "README.md"), "utf8");
  // 装法：必须是 plugin_manager 的 install_bundle，且不要手写 profile / 跑 pnpm。
  assert.match(text, /install_bundle/);
  assert.match(text, /不要.{0,12}pnpm|不要.{0,20}pnpm/);
  // 位置选择要有理由，不能只给一个魔数。
  assert.match(text, /DEPLOYMENT_PERSONA_PREFIX|PERSONA_PREFIX/);
  assert.match(text, /PLAN_POLICY/);
});
