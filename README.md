# dsh-memory

给 DSH（DeepSeek Harness）用的跨会话长期记忆。记忆就是几个 Markdown 文件，**不额外调用任何 LLM**。

## 它解决什么

DSH 本身没有记忆插件：新会话开始，模型对上一个会话里定下来的约定、踩过的坑、你的偏好一无所知。这个插件补上这一层。

设计上有一条硬约束：**不为了「记住」再多花一次钱**。所以：

- 不做摘要蒸馏、不做重要性打分、不做冲突裁决 —— 这些在别的记忆系统里都要额外跑一次 LLM
- 「该不该记」这个判断交还给前台模型，它本来就在读这段对话，对它来说是零边际成本
- 插件只做**字符串比较和文件读写**：去重靠哈希，冲突检测靠 topic 等值，全部是纯函数

## 工作方式

三层，按「什么时候进上下文」区分：

**L1 · 规矩段（常驻系统提示）**
一段固定文字，告诉模型记忆库在哪、什么时候该写、什么时候不该写、`topic` 怎么起。内容是不变的常量 —— 系统提示一变，KV 前缀缓存就从改动处全部失效。

**L2 · 按需读取（不再整批注入）**
记忆不再在会话开始时注入。模型在**需要背景事实时**调 `memory_read` 工具，现读现渲染磁盘上的当前内容。好处：记忆文件一改下一轮就能读到（没有冻结窗口），也不占用每一轮的上下文预算——只读模型真正需要的那一份。`memory_save` 的返回值仍然会直接告诉模型它写了什么。

**L3 · 条件提醒（干了实事但没写记忆时）**
累计改动了若干个非记忆文件、却一条记忆都没写，才注入一条提醒。写记忆本身不算「干了实事」，否则写完又被提醒，死循环。提醒里明确写了「没什么值得记的就直接忽略，不要为了回应这条提醒而编造记忆」。

### 规矩段为什么排在 150

`lib/index.js` 里规矩段的 `order` 不是随手写的数。

DSH 的 `SECTION_ORDERS`（`@deepseek-ai/dsh-system-prompt`）是**DSH 自己仓库里那些 section 的中央编排表**，里面没有给记忆留格子 —— 只有 `HARNESS_IDENTITY`(-1000) / `DEPLOYMENT_PERSONA_PREFIX`(0) / `PLAN_POLICY`(500) / `TEAM_POLICY`(600) / `FILE_REFERENCE`(900) / 一堆 `TOOL_*`(1000–3000) / `MCP_SERVERS`(3100) / … 所以 `getSectionOrder("MEMORY")` 现在返回 `undefined`，而 `section({ order })` 遇到非有限数会**直接抛 `TypeError`**。

插件因此写成「有就跟随、没有就用自己的号」：

```js
const registered = ctx.systemPrompt.getSectionOrder?.("MEMORY");
const order = Number.isFinite(registered) ? registered : 150;
```

150 落在 `DEPLOYMENT_PERSONA_PREFIX`(0) 和 `PLAN_POLICY`(500) 之间 —— 也就是「讲完你是谁之后、讲任何策略/计划/工具之前」。记忆是背景事实，排在策略后面会让「该不该记」的规矩看起来像可以商量的建议；挤进 persona 里又会让它被当成身份描述。

**撞号不用管。** DSH 的排序是 `a.order - b.order || 名字字典序`：数字相同既不报错也不是随机的，只是这两个 section 之间按名字排，结果是确定的。

### 注入消息的来源标识

L2 / L3 的注入是 `user` 角色的消息，带一个 `source`：

```js
{ kind: "dsh-memory", form: "snapshot", sections: [{ name: "project_memory", text: "…" }, …] }
{ kind: "dsh-memory", form: "notice",   summary: "已改动若干文件，但尚未写入长期记忆" }
```

`kind` 是「producer-owned」的：DSH 会话格式 v4 只要求它是非空字符串、且不是保留值 `"plugin"`。一方的注入就是这么写的（`agent-instructions` / `session-reference` / `user-question-reply`，`dsh-time-context` 直接写自己的插件名），所以这里写自己的名字。

顺带澄清一个容易搞混的点：会话里那个 `plugin:<名字>` 前缀**不是**给新注入用的命名约定。它只出现在 v3→v4 的格式迁移里 —— 老日志把来源存成 `{ kind: "plugin", plugin: "X" }`，迁移时映射不到一方生产者就退化成 `plugin:X`。原生写入的 kind 不会被加前缀。

`form` 不能乱写：会话视图按它选渲染分支，而**声明的 form 字段读不出来时会静默降级**成不透明视图（不报错，但用户看不到本该看到的结构）。

- `form: "snapshot"` 要求 `sections` 是非空的 `{name, text}` 数组。所以 `renderSnapshot` 同时产出拼好的文本**和**具名分片，两者永远同源。
- `form: "notice"` 要求 `summary` 是非空字符串（显示在折叠行上，不展开就能看懂）。

## 写入

写入只有一个入口：`memory_save` 工具。

**为什么不让模型直接用 `write` / `edit` 改文件** —— DSH 的工具系统只有 `tools/result`（执行**后**）钩子，**没有执行前的拦截点**。模型直接改文件的话，插件没有任何机会介入：拦不住重复写入、拦不住矛盾写入、也没法在写入那一刻记审计。所以「什么时候写」交给提示词，「怎么写」由工具承载。

工具内部八步，零 LLM：

| 步骤 | 做什么 |
| --- | --- |
| 1 | 空白 / 纯标点输入 → 直接拒，连盘都不碰 |
| 2 | 读盘 + 宽容解析（读不到就当空文件） |
| 3 | 去重与冲突判定（纯字符串比较） |
| 4 | 生成新内容（替换 / 插入 / 冻结） |
| 5 | 预算检查 —— 超限**明确拒绝**，不静默截断 |
| 6 | 原子落盘（写临时文件再 `rename`） |
| 7 | 记审计 |
| 8 | 重建 `CONFLICTS.md` |

**整段 2→6（读 → 改 → 写）被 `lib/lock.js` 的「按文件串行化锁」包住。** 本插件有两个会读写同一份 `MEMORY.md` 的入口：模型的 `memory_save`，以及设置面板的 `edit` / `resolve`。没有这把锁时，两个入口各自读到同一版本、各自改，后写的会把先写的整个覆盖掉 —— 丢一条记忆，而两边都返回成功。`writeAtomic` 只保证「不写半截」，管不了这个，两者正交。

锁是**进程内**的（promise 队列，key = 目标文件的绝对路径）：两个入口都跑在同一个 DSH 宿主进程里，所以不需要跨进程文件锁。边界写在 `lib/lock.js` 的文件头 —— 若将来有多个进程同开一个工作区，这里挡不住，那时才需要 OS 级文件锁或「写前比对 + 重试」。

### 去重

每条记忆的指纹是 `sha256(normalize(topic) + NUL + normalize(content))`。归一化口径：NFKC → 转小写 → 去标点 → 空白折叠。topic 那一侧再折掉分隔符，所以 `indent-style`、`indent_style`、`Indent Style` 是同一个话题。

用哈希而不是相似度：相似度阈值只会在「同一件事换个说法」和「不同的事共享关键词」之间来回挪，**只会换一种错法**。代价是近似重复检测不出来 —— 这是故意的，误杀（丢掉真信息）比漏杀（多一条重复）严重得多。

### 冲突：默认冻结，等人裁决

同一个 `topic` 下出现结论不同的新条目时：

- **不删任何东西**，两条都留着
- 新条目打上 `[待裁决]` 标记，**不注入上下文**（互相矛盾的信息只会干扰判断）
- 生成一份 `CONFLICTS.md` 清单，把「已有的」和「有争议的」并排列出来
- 上下文里只出现一行计数（`<conflicts pending="1">`），不塞正文

裁决有两条路：

1. **手工改 `MEMORY.md`** —— 删掉不要的那条，或者去掉保留那条的 `[待裁决]` 标记。下次写入时清单自动重建；没有冲突了，`CONFLICTS.md` 自动删除。
2. **设置页的「记忆 → 冲突」** —— 每个冲突是一张卡片，A / B 两条并排，四个按钮：

| 按钮 | 落盘动作 |
| --- | --- |
| 保留 A | 留下较早那条，删掉 B |
| 保留 B | 留下较新那条，删掉 A |
| 两条都留 | 两条都留，只去掉 `[待裁决]` 与 `conflict-with` 标记 |
| 稍后 | **一个字节都不写** —— 不落盘、不写审计、不动 `CONFLICTS.md` |

A / B 的定义是确定的：按 `at` 升序排，**A = 最早那条**（通常是在用的），**B = 最新那条**（通常是本次想写进来的）；没有日期的一律排在最后，按「新」处理更安全。只有一条时 A 和 B 是同一条，面板只给三个「保留」选项。

「保留 A / 保留 B」会删东西，所以点下去先问一句再执行；「两条都留 / 稍后」不删东西，直接生效。

模型也可以主动避免冲突：写入时用 `mode` 声明这是新结论（`update`，替换旧的）还是补充信息（`append`，旧的仍成立）。这个判断对刚读完对话的模型来说是零成本的，比事后另起一次 LLM 调用去猜又便宜又准。

### 审计

`runs.jsonl`，一行一个 JSON，只追加不修改。记 `save` / `dedupe` / `conflict` / `update` / `reject`。

它的价值是：写入准入层在**替模型改记忆** —— 去重会拒绝写入、冲突会打标记、裁决会删条目。没有记录的话，某天你发现「我明明记过的东西怎么没了」，永远查不出是谁改的、什么时候改的、为什么改。

启动时会用流水重放一遍，与 `MEMORY.md` 的实际条目对比。不一致只 warn 不阻断 —— 手工改文件是设计允许的，这条只是给你留线索。

### 超限不静默截断

超过字节上限时，`memory_save` 明确返回拒绝，并提示用 `mode: "update"` 合并同类项。注入时如果文件已经超限，会明确写一句「本次只带入了前 N 字节」，而不是让模型以为自己写的都还在。

## 设置页的记忆面板

设置页里多一个「记忆」导航项，四个视图：

| 视图 | 看什么 |
| --- | --- |
| 浏览 | 两个作用域各自的条目；**项目**作用域先按「工作空间」分区、每区内再按段分组，**用户**作用域直接按段分组。每条含 `topic` / 日期 / 正文，**可编辑 / 删除，底部可新增** |
| 用量 | 每个作用域的字节占用与上限比例条、条目数、待裁决数、分类分布 |
| 冲突 | 每个冲突一张卡片 + 四个裁决按钮（见上） |
| 审计 | `runs.jsonl` 的时间线，以及启动自检「流水与文件是否一致」的结论 |

**只读聚合 + 两个写动作。** 聚合过程不碰任何文件（没有副作用，可以随便点刷新）；会写盘的是「浏览」页的编辑 / 新增 / 删除按钮，以及「冲突」页的裁决按钮。面板里改的记忆全部记入审计，来源标 `by:"user"`，和模型写入（`memory_save`）分得清。

**「工作空间」是可选的一级维度（仅项目作用域）。** 一条项目记忆可以带一个 `area`（工作空间）标签，写在行尾元数据里（`<!-- id:m001 topic:foo at:2026-10-01 area:backend -->`）。浏览视图里项目作用域因此变成两级：先按 `area` 分区（没填的归「全部工作空间」），每区内再按 `## 段` 分组；用户作用域不分区，维持单级。编辑 / 新增表单里项目作用域会多一个「工作空间」输入框，留空即不写 `area`。`area` 只改元数据、不影响条目所在行，所以改工作空间不会移动条目。

### 数据怎么从磁盘走到浏览器

浏览器里的面板和磁盘上的文件之间只有一条通道：宿主侧在 `webServer` 上挂一条 `/dsh-memory` 前缀路由，浏览器侧 `ctx.connection.rpc.call("/dsh-memory", "snapshot" | "resolve" | "edit", payload)` 发一条 POST 过去。三个端点：

- `snapshot` —— 返回一次聚合结果，四个视图共用（`lib/ui/data.js`）
- `resolve` —— 执行一次裁决（`lib/ui/resolve.js`）
- `edit` —— 自由编辑：新增 / 修改 / 删除一条（`lib/ui/write.js`），行级编辑、不重写整个文件，并记 `by:"user"` 的审计

**为什么自己挂路由，而不是 `ctx.connection.rpc.handle(...)`：** 后者在当前 DSH 版本里**必然抛错**。`HostConnectionService.rpc.handle` 内部走的是 `this.ctx`（连接服务自己的 context），而那个服务的 `inject` 只有 `["credentials"]` —— 在 cordis 里读一个没 inject 的服务会抛 `cannot get property without inject`。于是路由永远挂不上，浏览器 POST 落到 SPA 静态兜底，面板上只显示一行 `transport failure for /dsh-memory/snapshot: HTTP 405`。对照 `/api` 那条路由是好的：它在 `ctx.inject(["webServer"], …)` 里用**自己的** `webCtx.webServer` 注册。

所以本插件自己 inject `webServer`，自己注册前缀路由，并逐分支复刻 `rpcFetchHandler` 与 `bridge` 的语义（`lib/ui/route.js`）：404 / 415 / 400 / `gateway/bad-request` / 500 / 200，线上格式与 `/api` 通道逐字节一致。同一个坑 `dsh-pocket` 也踩过，它的 `lib/web-rpc.js` 里有同样的注释。

**保留的那三点好处还在：**

- **信封、鉴权、围栏都沿用 DSH 的语义。** `rpcId` 配对、`{ok,value}` / `{ok,error}` 信封、`content-type` 检查、Host/Origin 围栏与浏览器鉴权（`connection.requestRejection`）都照原样接，不是自己发明一套。
- **前缀安全。** 客户端那侧把 URL 拼成相对的（前导斜杠被刻意去掉），反代到子目录下也不会打偏。
- **不占 `/api`。** `/api` 是保留的共享通道（只能 `intercept`，不能 `handle`），而且它的拦截器槽位是**独占**的、已被 `dsh-api-gateway` 占用；独立 channel 与别家插件互不干扰。

### 两个刻意的设计

**工作目录只认宿主记的那个。** 裁决会写盘，所以端点一律忽略 payload 里的 `cwd`，只用插件从最近一次会话记下来的工作区。让浏览器指定路径等于开了一个「往任意位置写文件」的口子。还没跑过任何会话时，`snapshot` 返回 `no-workspace` 而不是猜一个路径。

**没有面板服务就安静跳过。** `connection` 与 `webServer` 都不在插件的 `inject` 里，而是走 `ctx.inject(["connection", "webServer"], ...)`：`inject` 里声明了但 profile 里没有的服务会让**整个插件不激活**，命令行 / 无界面 profile 两个都没有，记忆功能却仍然要能用。面板是「有就挂、没有就跳过」。

### 客户端半侧是什么形状

`lib/client.js` 是**手写的 DSH client bundle**，格式与官方 tsdown 产物一致：

```js
window.__ModuleLoader__.load({
  id: "dsh-memory",                // 必须等于 package.json 的 name
  factory: (require) => { ... return module.exports },
});
```

四条硬约束，违反任何一条设置页里会干脆没有这一项：

1. **`id` 必须等于包名。** `dsh-client-modules` 用包名认这条 bundle。
2. **不能用 ESM。** 这是 CJS 工厂，依赖一律 `require(...)` —— 它不是被 Node 加载的，是被浏览器的模块加载器按字符串执行出来的，写 `import` 是直接语法错误。
3. **`require` 的名字必须能命中。** `react` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` 这类是打进 shell 的**静态种子**；`@deepseek-ai/dsh-client-ui-settings` 这类是 client 插件包。要一个两者都不是的名字，浏览器侧会抛「missed the module table」。
4. **工厂只注册，不渲染。** 执行脚本只是把工厂登记进队列；副作用（含 CSS 注入）写在工厂闭包里，等 `factory(require)` 被调用时才发生。

`test/client-bundle.test.js` 在隔离沙箱里把这段代码真跑一遍，上面四条逐条校验。

## 安全

注入前会扫描并打码：私钥、`sk-` / `ghp_` / `AKIA` 凭据、`key = value` 形式的通用凭据字段、提示注入语句、不可见字符（零宽字符 / 方向控制符 / BOM）。

**只打码，不改磁盘原文。** 你可能有意记「我们的 token 前缀是 sk-abc」，磁盘上保留原样，只有给模型看的那一份被打码。

顺序是**先打码再截断** —— 反过来，截断会把 `sk-xxxx` 切成 `sk-xx`，正则匹配不上，凭据就进上下文了。

截断按 **UTF-8 字节**做，并且不会切开多字节字符。按 UTF-16 切会把 emoji 切成孤立代理项，产生非法 UTF-8，API 返回 400 —— 那是会话级不可逆的损坏。

## 落点

| 作用域 | 默认位置 | 用途 |
| --- | --- | --- |
| `project` | `<工作区>/.dsh-memory/MEMORY.md` | 技术约定、已定方案、踩过的坑。可提交进 Git，`git log` 就是审计链 |
| `user` | `$DSH_HOME/memory/MEMORY.md` | 跨项目的个人偏好、习惯。不跟着某个仓库走 |

两个作用域的**相对路径基准不一样**，这是有意的：`projectMemoryDir` 相对工作区（它就该跟着仓库走），`userMemoryDir` 相对 `$DSH_HOME`（它是跨项目的东西，相对工作区没有意义 —— 否则换个项目打开就换了一份用户记忆，而且会隐式地跟着 `process.cwd()` 跑，极难排查）。

目录里会有三个文件：

- `MEMORY.md` —— 唯一的真相源，可以直接手改
- `CONFLICTS.md` —— 派生视图，删了会自动重建，手改会被覆盖
- `runs.jsonl` —— 审计流水

条目格式：

```markdown
## 约定

- 缩进用 4 空格。<!-- id:m001 topic:indent-style at:2026-10-01 -->
- [待裁决] 包管理器用 pnpm。<!-- id:m005 topic:package-manager at:2026-10-12 conflict-with:m001 -->
```

元数据放在 HTML 注释里：Markdown 渲染时看不见，文件保持干净，机器一条正则就能精确解析。**哈希不写进文件**，每次解析时重算 —— 文件更干净，也避免了「文件里的哈希和实际内容不一致」这种隐性损坏。

## 配置

写在 DSH 的 `cordis.patch.yml` 里（装插件时由 `plugin_manager` 生成，不用手写）：

```yaml
- insert:
    - id: dsh-memory
      name: 'dsh-memory'
      config:
        projectMemoryDir: .dsh-memory
        writeReminder: true
        conflictFreeze: true
        sensitiveScan: true
        auditEnabled: true
        verifyOnStart: true
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `projectMemoryDir` | `.dsh-memory` | 项目级目录，**相对工作区** |
| `userMemoryDir` | 空 | 用户级目录。留空 = `$DSH_HOME/memory`；**相对路径的基准是 `$DSH_HOME`，不是工作区** |
| `projectFileName` / `userFileName` | `MEMORY.md` | 文件名 |
| `projectMaxBytes` / `userMaxBytes` | `10800` | 上限，**按字节**。≈ 3600 中文字符 / 约 1.2K tokens |
| `writeReminder` | `true` | 干了实事没写记忆时提醒 |
| `conflictFreeze` | `true` | 待裁决条目不进上下文 |
| `sensitiveScan` | `true` | 注入前打码 |
| `auditEnabled` | `true` | 写审计流水 |
| `verifyOnStart` | `true` | 启动时重放校验，不一致只 warn |
| `remindAfterToolWrites` | `3` | 累计改几个非记忆文件后触发提醒 |

上限按字节而不是字符：DSH 官方的安全截断本来就是按字节做的，配置也用字节可以少一层换算 —— 而换算正是「切坏一个 emoji 就毁掉整个会话」那类 bug 的温床。

## 安装

用 DSH 的 `plugin_manager` 的 `install_bundle`，`target` 指向这个目录的**绝对路径**：

```
D:\Code\project\dsh-memory
```

**不要**手写 profile 的 `package.json` 或 `cordis.patch.yml`，也不要跑 `pnpm`。这是一个零依赖 bundle：没有依赖、没有安装脚本、没有构建步骤，`package.json` 里的 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，DSH 加载时自己把那一行插进去。

它是**双面插件**：同一行 loader 条目同时挂上宿主半侧（`exports["."]` → `lib/index.js`）和浏览器半侧（`exports["./client"]` → `lib/client.js`）。浏览器半侧靠 `package.json` 的 `dsh.client` 声明被 `dsh-client-modules` 扫到。

### 包里的展示元数据都是真的在用

装完之后设置页里那一行会显示图标、标题、描述 —— 它们来自三个地方，缺一个就静默少一块：

| 文件 | 谁读它 | 缺了会怎样 |
| --- | --- | --- |
| `package.json` 的 `icon` | `dsh-app-boot` 的 `readPluginMeta` → `iconOf` | 设置页没有图标 |
| `locale/en.json` | 同上 → `dictionariesOf`（以 `en.json` 为锚点扫同目录所有 `*.json`） | **整个 locale 目录都不读**，标题退化成包名 |
| `locale/zh.json` | 同上，按文件名当语言 id | 中文界面显示英文 |

两个硬约束：

- `${包名}/locale/en.json` 和 `${包名}/package.json` 是**通过 Node 的 ESM 解析器**去解析的，所以 `exports` 必须把它们导出来 —— 这就是 `"./locale/*.json"` 和 `"./package.json"` 那两条存在的原因。没导出就是 `ERR_PACKAGE_PATH_NOT_EXPORTED`，表现是「图标和标题静默没有」。
- `meta.title` / `meta.description` 存在就必须是**非空字符串**；`icon` 必须是**相对路径**、扩展名在 `.svg/.png/.jpg/.jpeg/.webp` 里、是普通文件、≤256 KiB、realpath 之后仍在包目录内。

`test/manifest.test.js` 把这套契约全部钉住了。

### 装完先看两处

- **设置页的插件列表**：那一行有没有图标、标题、描述 —— 这就是 `locale` 与 `icon` 有没有真的被读到的直接证据。
- **设置页里的「记忆」导航项**：有没有出现，四个视图能不能拉到数据。

## 开发

```bash
npm test
```

244 个用例，零依赖（只用 `node:test` 和 `node:assert`）。

- `hash` / `truncate` / `sanitize` / `parse` / `detect` / `audit` —— 纯函数，逐个测边界
- `render` —— 打码与截断的顺序、超限提示、冲突摘要、**分片与正文同源**
- `reminder` —— 阈值、防死循环、写记忆后清零
- `paths` —— 落点解析与「是不是记忆文件」
- `conflicts` —— 派生视图渲染
- `save` —— **集成测试**，用真实临时目录跑完整写入链路（去重 / 冲突 / 预算拒绝 / 审计 / 原子性）
- `index` —— **装配测试**，用 `test/loader.mjs` 把三个 DSH 运行时的包替换成 `test/stubs/` 下的替身，验证 `apply()` 到底注册了什么，注入消息的 `source` 形状是否自洽，以及面板 RPC 有没有挂上
- `tool` —— **工具参数规格**：可选参数一律省略 `required`（DSH 的 value-schema DSL 只认 `required: true`，写 `false` 会让 `defineTool` 抛错、插件启动失败）
- `manifest` —— **包清单契约**，`exports`（含 `./client`）/ `icon` / `locale` / `files` / `dsh.client` / 无依赖，对着 DSH 加载器的真实规则逐条校验
- `ui-data` / `ui-resolve` / `ui-write` / `ui-rpc` / `ui-route` —— **面板各层**：聚合只读且四视图同源、A/B 定义与写回一致、`later` 不落痕迹、自由编辑的行级写回与 `by:"user"` 审计、审计记录能被 `replay` 读懂、端点信封形状严格、载荷里的 `cwd` 被忽略、HTTP 传输的状态码与信封形状（404 / 415 / 400 / `gateway/bad-request` / 500 / 200）与栅栏分支
- `client-bundle` —— **客户端 bundle 格式**，在 `node:vm` 沙箱里把 `lib/client.js` 真跑一遍：注册形状、`id` 等于包名、无 ESM 语句、`require` 全部命中静态种子、槽注册参数、中英字典键集一致、CSS 只用主题变量
- `lock` / `concurrency` —— **并发写入**：锁的串行化语义（后者等前者完全结束、不同 key 不互阻、出错不卡队列、空闲不泄漏），以及真实文件 IO 下的并发回归（两个入口同时新增不同条目 → 两条都必须留下、id 不撞）。这两组是「去掉锁就变红」的，刻意如此

最有价值的是 `save` / `index` / `manifest` / `client-bundle` / `tool` 这几个：`save` 覆盖所有真实行为；`index` 抓「装进 DSH 之后才发现没生效」（section 名字写错、`order` 撞车、忘了 `interpolate: false`、钩子签名不对、声明了 form 却给不齐字段）；`manifest` 抓「图标和标题静默消失」；`client-bundle` 抓「设置页里干脆没有这一项」；`tool` 抓「工具参数写法违反 DSL，插件启动失败」——这一类失败全都**不报错**，只会静默地少一块。

### 替身该模仿到什么程度

`test/stubs/` 下的替身不是「返回个形状就行」的空壳：**真货里会让插件起不来的规则，替身必须照着实现**。`dsh-tools` 的替身就实现了 `parameters` 里 `required` 出现即必须为 `true` 这一条 —— 少了它，写 `required: false` 的错在本地是绿的，装进 DSH 才炸成「启动失败」，而设置页只给一个红色徽标、不给原因。

反过来，写错**不会**让插件起不来的规则（类型、`output.schema`、展示卡片）替身一律不校验：那只会制造噪音，不增加保护。

## 设计取舍

**为什么改成按需读取（不再整批注入）。** 当初整批注入后「冻结」是为了保住前缀缓存——但代价是模型在本会话里看不到自己刚写的记忆，而且记忆文件一旦被手改，当前会话毫无感知。改成 `memory_read` 按需读取后，每次都现读现渲染磁盘上的最新内容，没有这层过期窗口；同时也只占模型真正去读那一下的上下文，不会每轮都背着整份记忆。多一次工具调用换来「永远最新 + 不占常驻预算」，对记忆这种低频、背景型的资料更划算。

**为什么一切失败都 fail-open。** 读不到、解析不了、渲染出错 —— 一律当作「没有记忆」继续跑。一个解析器 bug 不该让整个记忆功能不可用，更不该阻塞主流程。

**为什么解析要宽容。** 模型和人都能手改 `MEMORY.md`。看不懂的行一律跳过，**绝不抛错**。编辑也按行做，不重写整个文件 —— 你写在文件里的额外说明、自定义段标题都会保留。

**为什么没有「后台整理」。** 那需要额外跑 LLM 做巩固/蒸馏，是这套设计里唯一要持续花钱的部分，被砍掉了。压力改为通过「上限 + 明确的超限提示 + `mode: "update"`」交给前台模型主动合并 —— 它在干活的时候顺手就做了。

**为什么 `MEMORY_RULES` 是硬编码的常量。** 它的位置在系统提示里，内容一变缓存就失效，所以不能按配置动态生成。因此它不写死具体路径（用「默认在…」的说法），实际路径由 `memory_read` 返回内容里写的为准。

**为什么面板挂在设置页，而不是右侧边栏。** 右侧边栏是「跟当前会话/文件打交道」的地方，而记忆是跨会话、跨项目的静态状态 —— 它和「设置」是同一类东西（低频、全局、看配置）。挂在设置页还有个实际好处：`settings.section` 是官方明确给功能插件用的加性席位，不需要抢占别人已经占了的区域。

**为什么面板不轮询。** 记忆文件不是高频变化的东西。定时拉只会白烧 IO，还会让「看到的数字」和「实际文件」之间多一层不知道什么时候刷新的模糊地带。所以是打开拉一次 + 手动刷新；裁决完由用户自己决定要不要再看一眼。

**为什么「稍后」什么都不写。** 它的语义是「我看到了，先放着」。如果每次点它都留一条审计，那真正有价值的记录（谁改了什么）会被一堆「稍后」淹掉；如果它写一个「已读」标记，就又多了一份和文件不同步的状态要维护。不写就是不写。

**为什么聚合只做一次。** 分四次读文件，用户点开「用量」和点开「冲突」看到的可能是两个不同时刻的状态，而面板上没有任何东西提示这一点。一次快照 + 一个 `generatedAt`，四个视图说的是同一件事。

## 目录结构

```
lib/
  index.js       插件入口：apply / inject / Config，注册 L1 section、工具、两个钩子、面板 RPC
  schema.js      配置 schema（唯一 import DSH 运行时的模块）
  config.js      DEFAULTS 与 resolveConfig（纯逻辑，不依赖 DSH）
  paths.js       落点解析、显示路径、isMemoryPath
  guide.js       L1 规矩段正文
  reminder.js    L3 提醒的文本、阈值与状态
  render.js      记忆渲染（先打码再截断；renderSnapshot 给整批快照，readMemory 给按需读取）
  tool.js        memory_save 的工具定义（薄封装）
  save.js        写入核心：八步流程，不依赖 DSH，可独立测试
  parse.js       MEMORY.md 的宽容解析与行级编辑
  detect.js      去重 / 冲突判定、id 分配
  hash.js        归一化与内容指纹
  sanitize.js    敏感信息打码
  truncate.js    按 UTF-8 字节的安全截断
  store.js       原子读写
  lock.js        进程内「按文件串行化」锁（防并发读改写丢更新）
  audit.js       审计流水与回放
  conflicts.js   CONFLICTS.md 与冲突摘要渲染
  client.js      【浏览器半侧】设置页的记忆面板（手写 client bundle）
  ui/
    data.js      面板数据聚合（四个视图共用一次快照，只读）
    resolve.js   四个裁决动作的写回（行级编辑，不重写整个文件）
    write.js     自由编辑的写回（新增/修改/删除，行级编辑，记 by:user 审计）
    rpc.js       面板的三个 RPC 端点（信封、参数校验、cwd 来源）
    route.js     HTTP 传输层（挂前缀路由、复刻 rpcFetchHandler 的语义、请求栅栏）
test/            244 个用例 + stubs/ + fixtures/ + loader.mjs
```
