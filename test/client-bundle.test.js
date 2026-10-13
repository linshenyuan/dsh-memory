/**
 * 客户端 bundle 的格式与装配测试。
 *
 * 手写的 client bundle 是这套东西里**最容易「本地看起来没问题、装进 DSH 才发现
 * 挂了」**的一块：它既不是 ESM 也不是普通 CJS，而是浏览器模块加载器按字符串执行
 * 的工厂函数。格式错一个字符，表现是设置页里干脆没有这一项，日志里只有一句
 * 「client bundle not found」或者一个静默的空白。
 *
 * 所以这里不 import 它（import 不了），而是把它当一个**脚本文本**在隔离沙箱里
 * 执行一遍，用替身顶掉 react 与官方组件库，然后检查：
 *
 * 1. 注册形状对：`window.__ModuleLoader__.load({ id, factory })`，且 id 必须等于
 *    包名 —— client-modules 用包名认这条 bundle。
 * 2. 工厂是 CJS：只能用 `require`，出现任何 ESM 语句都是致命错。
 * 3. require 的模块都在运行时的静态种子里（react / ui-slots / ui-primitives /
 *    cordis / client-store / dockkit），或是一个真的 client 插件包。要一个
 *    种子表里没有的名字，浏览器侧会抛「missed the module table」。
 * 4. `apply` 注册到 `settings.section`，id 唯一、locale 齐全。
 * 5. 两本字典键集完全一致 —— 漏一个键，中文界面会显示成英文或键名。
 */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

/**
 * 运行时的静态模块种子表。
 *
 * 抄自 dsh-web-frontend 的 `staticModules` —— 浏览器里 `require` 能直接命中的
 * 全部名字。不在表里、又不是 client 插件包的，就是错的。
 */
const SEED_MODULES = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);

/** 读一次源码，多个用例共用。 */
const source = await readFile(bundlePath, "utf8");

/**
 * 在隔离沙箱里执行 bundle，并**物化一次**（调用工厂），拿回它的注册与导出。
 *
 * 注意必须物化：执行脚本只是把工厂登记进队列，CSS 注入这类副作用都写在工厂
 * 闭包里，要等 `factory(require)` 被调用时才发生 —— 这正是官方「惰性 CJS」模型
 * 的意思。只跑脚本不调工厂，会误判成「CSS 没注入」。
 *
 * @param {object} [options] - `{ head }`，false 表示不提供 document（模拟
 *   工厂在非 DOM 环境里被执行，比如 SSR 或提前物化）。
 * @returns {{registration: object, exports: object, styles: object[],
 *            document: object|null, seen: string[]}} 结果。
 */
function loadBundle({ head = true } = {}) {
  const registrations = [];
  const styles = [];
  const document = head
    ? {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: "" }),
        head: {
          appendChild: (node) => {
            styles.push(node);
          },
        },
      }
    : undefined;

  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console,
  };
  if (document !== undefined) sandbox.document = document;
  // 故意不给 `require`：工厂自己接一个参数，外面传进去 —— 与真实加载器一致。
  vm.runInNewContext(source, sandbox, { filename: "client.js" });

  assert.equal(registrations.length, 1, "bundle 必须且只能 load 一次");
  const { require: stub, seen } = fakeRequire();
  const exports = registrations[0].factory(stub);
  return { registration: registrations[0], exports, styles, document: document ?? null, seen };
}

/** 造一个替身 require，把官方依赖换掉。 */
function fakeRequire() {
  const seen = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const primitives = {
    Button: function Button() {},
    SegmentedTabs: function SegmentedTabs() {},
    Tag: function Tag() {},
  };
  const stub = (specifier) => {
    seen.push(specifier);
    if (specifier === "react") return react;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`测试没有为 ${specifier} 准备替身`);
  };
  return { require: stub, seen };
}

/** 造一个浏览器侧 ctx 替身。 */
function fakeClientCtx() {
  const dictionaries = [];
  const slotInjects = [];
  const registrations = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts });
      },
    },
    slots: {
      inject: (slot, callback) => {
        slotInjects.push(slot);
        callback();
      },
      register: (options, Component) => {
        registrations.push({ options, Component });
      },
    },
    effect: (fn, name) => {
      effects.push(name);
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    get: () => undefined,
  };
  return { ctx, dictionaries, slotInjects, registrations, effects };
}

test("bundle 用 __ModuleLoader__.load 注册，且 id 等于包名", () => {
  const { registration } = loadBundle();
  assert.equal(typeof registration.factory, "function");
  assert.equal(
    registration.id,
    pkg.name,
    "client-modules 用 package.json 的 name 认这条 bundle，对不上会报 client bundle not found",
  );
});

test("工厂是纯 CJS：没有 import / export / 顶层 await / 动态 import", () => {
  assert.equal(/^[ \t]*import[\s({]/m.test(source), false, "不能出现 ESM import");
  assert.equal(/^[ \t]*export[\s{]/m.test(source), false, "不能出现 ESM export");
  assert.equal(/\bimport\s*\(/.test(source), false, "不能出现动态 import");
  assert.equal(/^[ \t]*await\b/m.test(source), false, "顶层不能有 await");
  // 注释里提到 import 是可以的（上面几条只在行首匹配），但这里确认没有真的用它。
  assert.equal(source.includes("window.__ModuleLoader__.load("), true);
});

test("require 的每个模块要么在静态种子里，要么是声明的 client 插件", () => {
  const { seen } = loadBundle();
  for (const specifier of seen) {
    assert.equal(
      SEED_MODULES.has(specifier),
      true,
      `require("${specifier}") 不在静态种子里 —— 浏览器侧会抛 missed the module table`,
    );
  }
  assert.deepEqual(seen, ["react", "@deepseek-ai/dsh-client-ui-primitives"]);
});

test("工厂导出 apply 与 inject；inject 是服务名数组，不声明 connection", () => {
  const { exports } = loadBundle();
  assert.equal(typeof exports.apply, "function");
  assert.equal(Array.isArray(exports.inject), true);
  assert.deepEqual([...exports.inject], ["slots", "locale"]);
  // connection 故意不在 inject 里：缺了它面板该显示错误，而不是整个插件不加载。
  assert.equal(exports.inject.includes("connection"), false);
});

test("apply 把面板注册到 settings.section，id 与 order 固定", () => {
  const { exports } = loadBundle();
  const { ctx, slotInjects, registrations, effects } = fakeClientCtx();
  exports.apply(ctx);

  assert.deepEqual(slotInjects, ["settings.section"]);
  assert.equal(registrations.length, 1);
  const { options, Component } = registrations[0];
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "memory");
  assert.equal(typeof options.order, "number");
  assert.equal(typeof options.locale, "string");
  assert.equal(typeof options.label, "function");
  assert.equal(typeof options.label(), "string");
  assert.equal(typeof Component, "function");
  assert.equal(effects.length >= 1, true, "locale 字典注册要走 ctx.effect，卸载时才能清掉");
});

test("注入面给出 load / resolve / edit，且都是函数（非 hooks 键会原样变成组件 props）", () => {
  const { exports } = loadBundle();
  const { ctx, registrations } = fakeClientCtx();
  exports.apply(ctx);
  const face = registrations[0].options.inject();
  assert.equal(typeof face.load, "function");
  assert.equal(typeof face.resolve, "function");
  assert.equal(typeof face.edit, "function");
  assert.equal(Object.hasOwn(face, "hooks"), false, "这里不需要 hooks 机制，别误用");
});

test("locale 字典齐备：中英键集完全一致，且四个裁决动作都有文案", () => {
  const { exports } = loadBundle();
  const { ctx, dictionaries } = fakeClientCtx();
  exports.apply(ctx);

  assert.equal(dictionaries.length, 1);
  const { namespace, dicts } = dictionaries[0];
  assert.equal(namespace, "settings.memory");
  assert.equal(typeof dicts.zh, "object");
  assert.equal(typeof dicts.en, "object");

  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, "两本字典的键必须一一对应，否则某一种语言会露键名");
  assert.equal(zhKeys.length > 0, true);

  for (const key of ["nav", "title", "tabBrowse", "tabUsage", "tabConflicts", "tabAudit"]) {
    assert.equal(zhKeys.includes(key), true, `缺了 ${key}`);
  }
  for (const key of ["actionKeepA", "actionKeepB", "actionKeepBoth", "actionLater"]) {
    assert.equal(zhKeys.includes(key), true, `缺了裁决动作文案 ${key}`);
    assert.equal(typeof dicts.zh[key], "string");
    assert.equal(dicts.zh[key].length > 0, true);
  }
});

test("CSS 只注入一次，且带 data-plugin-css 去重标记", () => {
  const { styles } = loadBundle();
  assert.equal(styles.length, 1);
  assert.equal(styles[0].dataset.plugin, "dsh-memory");
  assert.equal(styles[0].dataset.pluginCss, "dsh-memory/Panel.css");
  assert.equal(styles[0].textContent.includes(".dmx-root"), true);
});

test("没有 document 时工厂也不炸（非 DOM 环境提前物化）", () => {
  assert.doesNotThrow(() => loadBundle({ head: false }));
});

test("样式只用官方主题变量，不写死颜色", () => {
  // 抓出 CSS 里的 #hex / rgb() / 具名颜色，只允许 var(--dsw-...)。
  const cssBlock = source.slice(source.indexOf("const CSS = ["), source.indexOf("].join(\"\")"));
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(cssBlock), false, "不要写死 hex 颜色");
  assert.equal(/\brgba?\(/.test(cssBlock), false, "不要写死 rgb 颜色");
  assert.equal(cssBlock.includes("var(--dsw-alias-"), true, "颜色一律走主题变量");
});
