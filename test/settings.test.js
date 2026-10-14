/**
 * 面板设置（lib/settings.js）的单元测试。
 *
 * 这一层是「面板改的值存哪」的唯一实现，所以除了往返，还要钉住三件事：
 *
 * 1. **路径落在 `$DSH_HOME` 下** —— 跨工作区共用，不能跟着仓库走。
 * 2. **只认白名单键** —— 面板不该能改落点（比如把 `projectMemoryDir` 指到别处）。
 * 3. **坏文件 fail-open** —— 读不到 / 解析不了就当「没覆盖」，绝不让插件起不来。
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DEFAULTS, resolveConfig } from "../lib/config.js";
import { resolveDshHome } from "../lib/paths.js";
import {
  MAX_MAX_BYTES,
  MIN_MAX_BYTES,
  PANEL_KEYS,
  SETTINGS_FILE,
  readSettings,
  readSettingsSync,
  settingsPath,
  validateLimits,
  writeSettings,
} from "../lib/settings.js";

let root = "";
let file = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-memory-settings-"));
  file = join(root, SETTINGS_FILE);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("settingsPath 落在 $DSH_HOME 下（跨工作区共用）", () => {
  assert.equal(settingsPath(), join(resolveDshHome(), SETTINGS_FILE));
});

test("PANEL_KEYS 只含两个上限", () => {
  assert.deepEqual([...PANEL_KEYS], ["projectMaxBytes", "userMaxBytes"]);
});

test("validateLimits：两个整数且在范围内才通过", () => {
  const ok = validateLimits({ projectMaxBytes: 4096, userMaxBytes: 8192 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { projectMaxBytes: 4096, userMaxBytes: 8192 });

  for (const bad of [
    {},
    { projectMaxBytes: 4096 },
    { projectMaxBytes: "4096", userMaxBytes: 4096 }, // 字符串不做隐式转换
    { projectMaxBytes: 4096.5, userMaxBytes: 4096 }, // 非整数
    { projectMaxBytes: MIN_MAX_BYTES - 1, userMaxBytes: 4096 }, // 低于下限
    { projectMaxBytes: 4096, userMaxBytes: MAX_MAX_BYTES + 1 }, // 高于上限
  ]) {
    assert.equal(validateLimits(bad).ok, false, JSON.stringify(bad));
  }
});

test("读写往返：写进去的能原样读回来", async () => {
  await rm(file, { force: true });
  const written = await writeSettings({ projectMaxBytes: 2048, userMaxBytes: 3072 }, file);
  assert.deepEqual(written, { projectMaxBytes: 2048, userMaxBytes: 3072 });
  assert.deepEqual(await readSettings(file), { projectMaxBytes: 2048, userMaxBytes: 3072 });
  assert.deepEqual(readSettingsSync(file), { projectMaxBytes: 2048, userMaxBytes: 3072 });
});

test("写入是合并，不是覆盖（只给一个键时另一个保留）", async () => {
  await rm(file, { force: true });
  await writeSettings({ projectMaxBytes: 2048, userMaxBytes: 3072 }, file);
  await writeSettings({ projectMaxBytes: 5120 }, file);
  assert.deepEqual(await readSettings(file), { projectMaxBytes: 5120, userMaxBytes: 3072 });
});

test("坏文件 fail-open：不存在 / 非法 JSON / 非对象 都当没覆盖", async () => {
  await rm(file, { force: true });
  assert.deepEqual(await readSettings(file), {});
  assert.deepEqual(readSettingsSync(file), {});

  for (const junk of ["not json", "[]", "null", "42"]) {
    await writeFile(file, junk, "utf8");
    assert.deepEqual(await readSettings(file), {}, `异步读: ${junk}`);
    assert.deepEqual(readSettingsSync(file), {}, `同步读: ${junk}`);
  }
});

test("只认 PANEL_KEYS（越权的键一律丢）", async () => {
  await rm(file, { force: true });
  await writeFile(
    file,
    JSON.stringify({
      projectMaxBytes: 4096,
      userMaxBytes: 4096,
      projectMemoryDir: "/tmp/evil",
      nope: 1,
    }),
    "utf8",
  );
  const read = await readSettings(file);
  assert.deepEqual(read, { projectMaxBytes: 4096, userMaxBytes: 4096 });
  assert.equal(Object.hasOwn(read, "projectMemoryDir"), false);
});

test("resolveConfig：面板覆盖优先于 DSH 配置", () => {
  const dsh = { projectMaxBytes: 1000, userMaxBytes: 2000, projectMemoryDir: ".memory" };
  const cfg = resolveConfig(dsh, { projectMaxBytes: 9999 });
  assert.equal(cfg.projectMaxBytes, 9999, "面板的值该赢");
  assert.equal(cfg.userMaxBytes, 2000, "面板没给的那个仍走 DSH 配置");
  assert.equal(cfg.projectMemoryDir, ".memory");
  // 两个来源都没有 → 默认值
  assert.equal(resolveConfig(null).projectMaxBytes, DEFAULTS.projectMaxBytes);
});
