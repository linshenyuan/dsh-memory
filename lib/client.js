/**
 * dsh-memory 的设置面板（浏览器半侧）。
 *
 * 这是手写的 DSH client bundle，格式与官方 tsdown 产物一致：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * 三条硬约束，违反任何一条浏览器侧都起不来：
 *
 * 1. **id 必须等于包名。** client-modules 用 package.json 的 name 认这条 bundle
 *    （`<包名>/client.js`），对不上会报 "client bundle not found"。
 *
 * 2. **不能用 ESM。** 这里是 CJS 工厂，依赖一律 `require(...)`。写 `import`
 *    会直接语法错误 —— 这段代码不是被 Node 加载的，是被浏览器的模块加载器
 *    按字符串执行 `new Function(...)` 出来的。
 *
 * 3. **不能有动态 import / 顶层副作用。** 工厂只做「注册」，真正的渲染由
 *    slots 框架驱动（这也是官方 bundle 的惰性 CJS 模型）。
 *
 * 面板落在 `settings.section` 这个 slot 上 —— 设置页里一个独立的导航项。
 * 数据走 `ctx.connection.rpc.call("/dsh-memory", ...)`，与宿主侧的
 * lib/ui/rpc.js 一对。
 */
window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;
		const Button = primitives.Button;
		const SegmentedTabs = primitives.SegmentedTabs;
		const Tag = primitives.Tag;

		/** 与宿主侧 lib/ui/rpc.js 的 CHANNEL 必须一致。 */
		const CHANNEL = "/dsh-memory";

		/** locale 命名空间。 */
		const NS = "settings.memory";

		/** 四个视图。 */
		const TABS = ["browse", "usage", "conflicts", "audit"];

		/** 四个裁决动作，顺序与面板上的按钮一致。 */
		const ACTIONS = [
			{ action: "keep-a", key: "actionKeepA", tone: "danger" },
			{ action: "keep-b", key: "actionKeepB", tone: "danger" },
			{ action: "keep-both", key: "actionKeepBoth", tone: "default" },
			{ action: "later", key: "actionLater", tone: "default" },
		];

		const en = {
			nav: "Memory",
			title: "Long-term Memory",
			intro: "Plain Markdown on disk, read on demand. You can edit, add, or delete entries right here — changes write straight to disk.",
			tabBrowse: "Browse",
			tabUsage: "Usage",
			tabConflicts: "Conflicts",
			tabAudit: "Audit",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			loading: "Loading…",
			empty: "Nothing here yet.",
			noWorkspace: "No workspace recorded yet. Start a session first.",
			scopeProject: "Project",
			scopeUser: "User",
			bytes: "Size",
			entries: "Entries",
			sections: "By section",
			pending: "Pending",
			pendingTag: "awaiting decision",
			conflictWith: "conflicts with",
			conflictHint: "Pick one, or keep both. Nothing is written until you decide.",
			actionKeepA: "Keep A",
			actionKeepB: "Keep B",
			actionKeepBoth: "Keep both",
			actionLater: "Later",
			confirmDrop: "This deletes the other entry. Continue?",
			confirmYes: "Delete it",
			confirmNo: "Cancel",
			edit: "Edit",
			delete: "Delete",
			add: "Add",
			addTab: "New +",
			addEntry: "Add entry",
			editEntry: "Edit entry",
			topic: "Topic",
			content: "Content",
			section: "Section",
			topicPh: "e.g. indent-style",
			contentPh: "One line of plain text",
			sectionPh: "leave empty for 未分类",
			save: "Save",
			cancel: "Cancel",
			confirmDelete: "Delete this entry? This cannot be undone.",
			confirmDeleteYes: "Confirm delete",
			confirmDeleteNo: "Cancel",
			auditTime: "Time",
			auditOp: "Op",
			auditTopic: "Topic",
			auditBy: "By",
			replayOk: "Audit log matches the file.",
			replayDiff: "Audit log and file differ — hand edits are fine, this is just a note.",
			readError: "Could not read this scope.",
			workspace: "Workspace",
			allWorkspaces: "All workspaces",
			area: "Workspace",
			areaPh: "e.g. frontend / backend / docs (optional)",
		};
		const zh = {
			nav: "记忆",
			title: "长期记忆",
			intro: "磁盘上的纯 Markdown，按需读取。可以直接在这里编辑、新增或删除条目，改动会直接写入磁盘。",
			tabBrowse: "浏览",
			tabUsage: "用量",
			tabConflicts: "冲突",
			tabAudit: "审计",
			refresh: "刷新",
			refreshing: "刷新中…",
			loading: "加载中…",
			empty: "这里还是空的。",
			noWorkspace: "还没有记录到工作目录，先随便开一轮会话再回来。",
			scopeProject: "项目",
			scopeUser: "用户",
			bytes: "体积",
			entries: "条目",
			sections: "分类分布",
			pending: "待裁决",
			pendingTag: "待裁决",
			conflictWith: "与以下条目冲突",
			conflictHint: "留一条，或两条都留。没点之前不会写盘。",
			actionKeepA: "保留 A",
			actionKeepB: "保留 B",
			actionKeepBoth: "两条都留",
			actionLater: "稍后",
			confirmDrop: "这会删掉另一条，确定？",
			confirmYes: "确认删除",
			confirmNo: "取消",
			edit: "编辑",
			delete: "删除",
			add: "新增",
			addTab: "新建+",
			addEntry: "新增条目",
			editEntry: "编辑条目",
			topic: "主题",
			content: "正文",
			section: "分类",
			topicPh: "例如：缩进风格",
			contentPh: "一行纯文本",
			sectionPh: "留空归入「未分类」",
			save: "保存",
			cancel: "取消",
			confirmDelete: "删除这条记忆？此操作不可撤销。",
			confirmDeleteYes: "确认删除",
			confirmDeleteNo: "取消",
			auditTime: "时间",
			auditOp: "操作",
			auditTopic: "主题",
			auditBy: "来源",
			replayOk: "审计流水与文件一致。",
			replayDiff: "审计流水与文件不一致 —— 手工编辑是允许的，这条只是提示。",
			readError: "这个作用域读不出来。",
			workspace: "工作空间",
			allWorkspaces: "全部工作空间",
			area: "工作空间",
			areaPh: "如 前端 / 后端 / 文档（可选）",
		};

		// ---- 样式 ---------------------------------------------------------------
		// 用官方的主题变量，不写死颜色 —— 深浅色切换由 DSH 自己带。
		// 样式只在工厂执行时注入一次，tag 上带插件名便于排查。
		const CSS = [
			".dmx-root{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary)}",
			".dmx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
			".dmx-title{margin:0;font-size:18px;font-weight:600}",
			".dmx-intro{margin:4px 0 0;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-cwd{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
			".dmx-panel{display:flex;flex-direction:column;gap:12px}",
			".dmx-subtabs{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}",
			".dmx-addbox{display:inline-flex;border-radius:8px;background:var(--dsw-alias-state-business-primary)}",
			".dmx-addbox[data-active='true']{filter:brightness(0.85)}",
			".dmx-dangerbox{display:inline-flex;border-radius:8px;background:var(--dsw-alias-state-error-primary)}",
			".dmx-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
			".dmx-cardhead{display:flex;align-items:center;justify-content:space-between;gap:10px}",
			".dmx-cardname{font-size:14px;font-weight:600}",
			".dmx-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dmx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
			".dmx-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}",
			".dmx-barfill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary)}",
			".dmx-barfill[data-warn='true']{background:var(--dsw-alias-state-warn-primary)}",
			".dmx-entry{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dmx-entry:first-child{border-top:0}",
			".dmx-toprow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dmx-topic{font-size:13px;font-weight:600}",
			".dmx-content{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}",
			".dmx-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);margin:0}",
			".dmx-group{display:flex;flex-direction:column;gap:8px}",
			".dmx-area{display:flex;flex-direction:column;gap:8px;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dmx-area:first-of-type{border-top:0}",
			".dmx-area-head{display:flex;align-items:center;gap:8px}",
			".dmx-area-name{font-size:13px;font-weight:600}",
			".dmx-area-tag{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px}",
			".dmx-vs{font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}",
			".dmx-side{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}",
			".dmx-side[data-picked='true']{border-color:var(--dsw-alias-state-business-primary)}",
			".dmx-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".dmx-notice{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dmx-notice[data-bad='true']{color:var(--dsw-alias-state-error-primary)}",
			".dmx-table{width:100%;border-collapse:collapse;font-size:12px}",
			".dmx-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 8px 6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}",
			".dmx-table td{padding:4px 8px 4px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
			".dmx-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}",
			".dmx-form{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-top:8px;display:flex;flex-direction:column;gap:8px}",
			".dmx-form-title{font-size:13px;font-weight:600}",
			".dmx-field{display:flex;flex-direction:column;gap:4px}",
			".dmx-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dmx-input{border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:6px 8px;font-family:inherit}",
			".dmx-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dmx-textarea{resize:vertical;min-height:54px;line-height:20px}",
		].join("");

		const CSS_TAG_ID = "dsh-memory/Panel.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-memory";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---- 小工具 -------------------------------------------------------------

		/**
		 * 把字节数写成给人看的形式。
		 * @param {number} n - 字节数。
		 * @returns {string} 例如 `1.2 KB`。
		 */
		function fmtBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / 1024 / 1024).toFixed(1)} MB`;
		}

		/**
		 * 取条目的显示日期（只保留到天）。
		 * @param {unknown} at - 条目时间戳。
		 * @returns {string} `YYYY-MM-DD`，缺失时为空串。
		 */
		function fmtDay(at) {
			if (typeof at !== "string" || at === "") return "";
			return at.slice(0, 10);
		}

		/** 作用域的本地化名。 */
		function scopeLabel(scope, t) {
			return scope === "user" ? t("scopeUser") : t("scopeProject");
		}

		// ---- 子组件 -------------------------------------------------------------

		/**
		 * 一条记忆的卡片，带「编辑 / 删除」按钮与内联编辑表单。
		 * @param {{entry: object, scope: string, edit: Function, onChanged: Function,
		 *          t: Function}} props - 条目、作用域、编辑函数、刷新回调与翻译函数。
		 * @returns {object} React 元素。
		 */
		function EntryRow({ entry, scope, edit, onChanged, t }) {
			const [editing, setEditing] = React.useState(false);
			const [confirming, setConfirming] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [draft, setDraft] = React.useState({
				topic: entry.topic || "",
				content: entry.content || "",
				section: entry.section || "",
				area: entry.area || "",
			});

			const run = async (payload) => {
				setBusy(true);
				setNotice(null);
				try {
					const result = await edit(scope, payload);
					setNotice({ bad: false, text: result.message });
					setEditing(false);
					setConfirming(false);
					onChanged();
				} catch (error) {
					setNotice({ bad: true, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			if (editing) {
				return h(
					"div",
					{ className: "dmx-entry" },
					h("div", { className: "dmx-form-title" }, t("editEntry")),
					h(
						"div",
						{ className: "dmx-field" },
						h("label", null, t("topic")),
						h("input", {
							className: "dmx-input",
							value: draft.topic,
							onChange: (e) => setDraft({ ...draft, topic: e.target.value }),
						}),
					),
					h(
						"div",
						{ className: "dmx-field" },
						h("label", null, t("content")),
						h("textarea", {
							className: "dmx-input dmx-textarea",
							value: draft.content,
							onChange: (e) => setDraft({ ...draft, content: e.target.value }),
						}),
					),
					h(
						"div",
						{ className: "dmx-field" },
						h("label", null, t("section")),
						h("input", {
							className: "dmx-input",
							placeholder: t("sectionPh"),
							value: draft.section,
							onChange: (e) => setDraft({ ...draft, section: e.target.value }),
						}),
					),
					scope === "project"
						? h(
								"div",
								{ className: "dmx-field" },
								h("label", null, t("area")),
								h("input", {
									className: "dmx-input",
									placeholder: t("areaPh"),
									value: draft.area,
									onChange: (e) => setDraft({ ...draft, area: e.target.value }),
								}),
						  )
						: null,
					h(
						"div",
						{ className: "dmx-actions" },
						h(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => void run({ action: "update", id: entry.id, topic: draft.topic, content: draft.content, section: draft.section, area: draft.area }) }, t("save")),
						h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => setEditing(false) }, t("cancel")),
					),
					notice === null ? null : h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
				);
			}

			return h(
				"div",
				{ className: "dmx-entry" },
				h(
					"div",
					{ className: "dmx-toprow" },
					h("span", { className: "dmx-topic" }, entry.topic || "—"),
					fmtDay(entry.at) === "" ? null : h(Tag, { tone: "quiet" }, fmtDay(entry.at)),
					entry.pending === true ? h(Tag, { tone: "warning" }, t("pendingTag")) : null,
				),
				h("p", { className: "dmx-content" }, entry.content || ""),
				confirming === true
					? h(
							"div",
							{ className: "dmx-actions" },
							h("span", { className: "dmx-notice" }, t("confirmDelete")),
							h(
								"div",
								{ className: "dmx-dangerbox" },
								h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => void run({ action: "delete", id: entry.id }) }, t("confirmDeleteYes")),
							),
							h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => setConfirming(false) }, t("confirmDeleteNo")),
					  )
					: h(
							"div",
							{ className: "dmx-actions" },
							h(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => setEditing(true) }, t("edit")),
							h(
								"div",
								{ className: "dmx-dangerbox" },
								h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => setConfirming(true) }, t("delete")),
							),
					  ),
				notice === null ? null : h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
			);
		}

		/**
		 * 一个作用域的「新增条目」表单。
		 * @param {{scope: string, edit: Function, onChanged: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function AddForm({ scope, edit, onChanged, t }) {
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [draft, setDraft] = React.useState({ topic: "", content: "", section: "", area: "" });

			const run = async () => {
				setBusy(true);
				setNotice(null);
				try {
					const result = await edit(scope, {
						action: "add",
					topic: draft.topic,
					content: draft.content,
					section: draft.section,
					area: draft.area,
				});
					setNotice({ bad: false, text: result.message });
					setDraft({ topic: "", content: "", section: "", area: "" });
					onChanged();
				} catch (error) {
					setNotice({ bad: true, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			return h(
				"div",
				{ className: "dmx-form" },
				h("div", { className: "dmx-form-title" }, t("addEntry")),
				h(
					"div",
					{ className: "dmx-field" },
					h("label", null, t("topic")),
					h("input", {
						className: "dmx-input",
						placeholder: t("topicPh"),
						value: draft.topic,
						onChange: (e) => setDraft({ ...draft, topic: e.target.value }),
					}),
				),
				h(
					"div",
					{ className: "dmx-field" },
					h("label", null, t("content")),
					h("textarea", {
						className: "dmx-input dmx-textarea",
						placeholder: t("contentPh"),
					value: draft.content,
					onChange: (e) => setDraft({ ...draft, content: e.target.value }),
				}),
			),
			h(
				"div",
				{ className: "dmx-field" },
				h("label", null, t("section")),
						h("input", {
							className: "dmx-input",
							placeholder: t("sectionPh"),
							value: draft.section,
							onChange: (e) => setDraft({ ...draft, section: e.target.value }),
						}),
					),
					scope === "project"
						? h(
								"div",
								{ className: "dmx-field" },
								h("label", null, t("area")),
								h("input", {
									className: "dmx-input",
									placeholder: t("areaPh"),
									value: draft.area,
									onChange: (e) => setDraft({ ...draft, area: e.target.value }),
								}),
						  )
						: null,
					h(
						"div",
						{ className: "dmx-actions" },
						h(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => void run() }, t("add")),
					),
				notice === null ? null : h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
			);
		}

		/**
		 * 一个作用域的分组卡片（浏览视图）。
		 * @param {{scope: object, edit: Function, onChanged: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		/**
		 * 把一个作用域的条目按段（section）分组。
		 * @param {object[]} entries - 条目列表。
		 * @returns {Array<[string, object[]]>} `[段名, 该段条目]` 列表。
		 */
		function groupBySection(entries) {
			const groups = new Map();
			for (const entry of entries) {
				const key = entry.section || "—";
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key).push(entry);
			}
			return [...groups.entries()];
		}

		/**
		 * 一个作用域的卡片（浏览视图）。
		 *
		 * 项目作用域额外按「工作空间（area）」做一级分组，再在每格里按段分组；
		 * 用户作用域不分区，直接按段分组（与改动前一致）。
		 *
		 * @param {{scope: object, edit: Function, onChanged: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function ScopeCard({ scope, edit, onChanged, t }) {
			const useAreas = scope.scope === "project";
			const areaGroups = new Map();
			for (const entry of scope.entries ?? []) {
				const areaKey = useAreas ? entry.area || "" : "";
				if (!areaGroups.has(areaKey)) areaGroups.set(areaKey, []);
				areaGroups.get(areaKey).push(entry);
			}

			const renderArea = (areaKey, items) => {
				const sections = groupBySection(items);
				const bands = sections.map(([name, seEntries]) =>
					h(
						"div",
						{ key: `sec:${name}`, className: "dmx-group" },
						h("div", { className: "dmx-meta" }, h("span", null, name)),
						seEntries.map((entry) => h(EntryRow, { key: entry.id ?? entry.topic, entry, scope: scope.scope, edit, onChanged, t })),
					),
				);
				if (!useAreas) return bands;
				const label = areaKey === "" ? t("allWorkspaces") : areaKey;
				return h(
					"div",
					{ key: `area:${areaKey}`, className: "dmx-area" },
					h(
						"div",
						{ className: "dmx-area-head" },
						h("span", { className: "dmx-area-name" }, label),
						h("span", { className: "dmx-area-tag" }, t("workspace")),
					),
					bands,
				);
			};

			return h(
				"section",
				{ className: "dmx-card" },
				h(
					"div",
					{ className: "dmx-cardhead" },
					h("span", { className: "dmx-cardname" }, scopeLabel(scope.scope, t)),
					h(
						"span",
						{ className: "dmx-meta" },
						h("span", null, `${t("entries")}: ${scope.entryCount ?? 0}`),
						h("span", null, `${t("bytes")}: ${fmtBytes(scope.bytes)}`),
					),
				),
				h("div", { className: "dmx-meta dmx-mono" }, scope.displayPath || ""),
				scope.error ? h("p", { className: "dmx-err" }, `${t("readError")} ${scope.error}`) : null,
				(scope.entries ?? []).length === 0
					? h("p", { className: "dmx-empty" }, t("empty"))
					: [...areaGroups.entries()].map(([areaKey, items]) => renderArea(areaKey, items)),
			);
		}

		/**
		 * 用量视图的一个作用域。
		 * @param {{scope: object, t: Function}} props - 作用域数据与翻译函数。
		 * @returns {object} React 元素。
		 */
		function UsageCard({ scope, t }) {
			const used = Number(scope.bytes) || 0;
			const max = Number(scope.maxBytes) || 0;
			const ratio = max > 0 ? Math.min(1, used / max) : 0;
			const sections = Object.entries(scope.sections ?? {});
			return h(
				"section",
				{ className: "dmx-card" },
				h(
					"div",
					{ className: "dmx-cardhead" },
					h("span", { className: "dmx-cardname" }, scopeLabel(scope.scope, t)),
					h("span", { className: "dmx-meta" }, `${fmtBytes(used)} / ${fmtBytes(max)}`),
				),
				h("div", { className: "dmx-bar" }, h("div", {
					className: "dmx-barfill",
					"data-warn": ratio >= 0.9 ? "true" : "false",
					style: { width: `${Math.round(ratio * 100)}%` },
				})),
				h(
					"div",
					{ className: "dmx-meta" },
					h("span", null, `${t("entries")}: ${scope.entryCount ?? 0}`),
					h("span", null, `${t("pending")}: ${(scope.entries ?? []).filter((e) => e.pending === true).length}`),
					h("span", null, `runs: ${scope.runCount ?? 0}`),
				),
				h(
					"div",
					{ className: "dmx-group" },
					h("div", { className: "dmx-meta" }, t("sections")),
					sections.length === 0
						? h("p", { className: "dmx-empty" }, t("empty"))
						: sections.map(([name, count]) =>
								h(
									"div",
									{ key: name, className: "dmx-meta" },
									h("span", null, name),
									h("span", null, String(count)),
								),
							),
				),
			);
		}

		/**
		 * 一个冲突组，带四个裁决按钮。
		 * @param {{group: object, scope: string, resolve: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function ConflictCard({ group, scope, resolve, t }) {
			const [busy, setBusy] = React.useState(false);
			const [confirming, setConfirming] = React.useState(null);
			const [notice, setNotice] = React.useState(null);

			const run = async (action) => {
				setBusy(true);
				setNotice(null);
				try {
					const result = await resolve(scope, group.topic, action);
					setNotice({ bad: false, text: result.message });
					setConfirming(null);
				} catch (error) {
					setNotice({ bad: true, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const onAction = (action) => {
				// 「两条都留」和「稍后」不删东西，直接执行；另外两个先问一句。
				if (action === "keep-both" || action === "later") void run(action);
				else setConfirming(action);
			};

			const side = (label, entry) =>
				h(
					"div",
					{ className: "dmx-side" },
					h(
						"div",
						{ className: "dmx-toprow" },
						h("span", { className: "dmx-topic" }, label),
						fmtDay(entry.at) === "" ? null : h(Tag, { tone: "quiet" }, fmtDay(entry.at)),
					),
					h("p", { className: "dmx-content" }, entry.content || ""),
				);

			return h(
				"section",
				{ className: "dmx-card" },
				h(
					"div",
					{ className: "dmx-cardhead" },
					h("span", { className: "dmx-cardname" }, group.topic || "—"),
					h(Tag, { tone: "warning" }, scopeLabel(scope, t)),
				),
				h("p", { className: "dmx-empty" }, t("conflictHint")),
				side("A", group.a),
				group.count > 2 ? h("div", { className: "dmx-vs" }, `… ${group.count - 2} …`) : null,
				side("B", group.b),
				(group.others ?? []).length > 0
					? h(
							"div",
							{ className: "dmx-group" },
							h("div", { className: "dmx-meta" }, t("conflictWith")),
							group.others.map((entry, index) =>
								h("p", { key: index, className: "dmx-content" }, entry.content || ""),
							),
						)
					: null,
				confirming === null
					? h(
							"div",
							{ className: "dmx-actions" },
							ACTIONS.map((item) =>
								h(
									Button,
									{
										key: item.action,
										size: "sm",
										variant: item.tone === "danger" ? "ghost" : "primary",
										disabled: busy,
										onClick: () => onAction(item.action),
									},
									t(item.key),
								),
							),
						)
					: h(
							"div",
							{ className: "dmx-actions" },
							h("span", { className: "dmx-notice" }, t("confirmDrop")),
							h(
								"div",
								{ className: "dmx-dangerbox" },
								h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => void run(confirming) }, t("confirmYes")),
							),
							h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => setConfirming(null) }, t("confirmNo")),
						),
				notice === null
					? null
					: h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
			);
		}

		/**
		 * 审计视图。
		 * @param {{data: object, t: Function}} props - 面板数据与翻译函数。
		 * @returns {object} React 元素。
		 */
		function AuditView({ data, t }) {
			const rows = [];
			for (const scope of data.scopes ?? []) {
				for (const run of scope.runs ?? []) rows.push({ scope, run });
			}
			rows.sort((a, b) => (a.run.at ?? "") < (b.run.at ?? "") ? 1 : -1);
			const replay = (data.scopes ?? []).find((s) => s.replay !== null && s.replay !== undefined);
			return h(
				"section",
				{ className: "dmx-card" },
				replay === undefined
					? null
					: h(
							"p",
							{ className: "dmx-empty" },
							replay.replay.ok === true ? t("replayOk") : t("replayDiff"),
						),
				rows.length === 0
					? h("p", { className: "dmx-empty" }, t("empty"))
					: h(
							"table",
							{ className: "dmx-table" },
							h(
								"thead",
								null,
								h(
									"tr",
									null,
									h("th", null, t("auditTime")),
									h("th", null, t("auditOp")),
									h("th", null, t("auditTopic")),
									h("th", null, t("auditBy")),
								),
							),
							h(
								"tbody",
								null,
								rows.map(({ scope, run }, index) =>
									h(
										"tr",
										{ key: index },
										h("td", null, (run.at ?? "").replace("T", " ").slice(0, 19)),
										h("td", null, run.op ?? ""),
										h("td", null, run.topic ?? ""),
										h("td", null, `${scopeLabel(scope.scope, t)} / ${run.by ?? ""}`),
									),
								),
							),
						),
			);
		}

		/**
		 * 面板主体。
		 *
		 * 数据靠 `load()` 拉一次，本地存住；编辑或裁决后手动刷新。**不做轮询** ——
		 * 记忆文件不是高频变化的东西，定时拉只会白烧 IO。
		 *
		 * @param {{load: Function, resolve: Function, edit: Function, t: Function}} props - 注入面。
		 * @returns {object} React 元素。
		 */
		function MemorySection({ load, resolve, edit, t }) {
			const [tab, setTab] = React.useState("browse");
			// 「浏览」页下的次级 tab：按作用域（用户 / 项目）切换。项目页里再按工作空间分区。
			const [browseScope, setBrowseScope] = React.useState("project");
			// 「新建+」是次级 tab 排旁边的独立方框：点它把下面换成新增表单，写入选中的作用域。
			const [adding, setAdding] = React.useState(false);
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const reload = React.useCallback(async () => {
				setBusy(true);
				try {
					const value = await load();
					setData(value);
					setError(null);
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			}, [load]);

			React.useEffect(() => {
				void reload();
			}, [reload]);

			const conflictTotal = data === null ? 0 : (data.totals?.conflicts ?? 0);

			const tabs = TABS.map((value) => ({
				value,
				id: `dmx-tab-${value}`,
				panelId: `dmx-panel-${value}`,
				label: value === "conflicts" && conflictTotal > 0 ? `${t(`tab${value[0].toUpperCase()}${value.slice(1)}`)} · ${conflictTotal}` : t(`tab${value[0].toUpperCase()}${value.slice(1)}`),
			}));

			let panel = null;
			if (error !== null) {
				panel = h("p", { className: "dmx-err" }, error);
			} else if (data === null) {
				panel = h("p", { className: "dmx-empty" }, t("loading"));
			} else if (tab === "browse") {
				const scopes = data.scopes ?? [];
				const current = scopes.find((s) => s.scope === browseScope) ?? scopes[0] ?? null;
				panel = h(
					"div",
					{ className: "dmx-panel" },
					h(
						"div",
						{ className: "dmx-subtabs" },
						h(SegmentedTabs, {
							items: [
								{ value: "user", id: "dmx-scope-user", panelId: "dmx-scope-panel-user", label: scopeLabel("user", t) },
								{ value: "project", id: "dmx-scope-project", panelId: "dmx-scope-panel-project", label: scopeLabel("project", t) },
							],
							value: browseScope,
							onChange: (value) => {
								setBrowseScope(value);
								// 切作用域就退出新增态 —— 否则看不出这次新增会写进哪个作用域。
								setAdding(false);
							},
							label: t("title"),
						}),
						// 「新建+」：紧挨 tab 排右侧的独立小方框（靠 space-between 推开）。
						// ghost Button 自身无边框、无底色，光靠它做不出「方框」，所以外面套一层
						// 带边框的容器（边框色走主题变量）—— 方框是这层 div 给的，点击仍是官方 Button。
						h(
							"div",
							{ className: "dmx-addbox", "data-active": adding ? "true" : "false" },
							h(
								Button,
								{ size: "sm", variant: "ghost", onClick: () => setAdding((v) => !v) },
								t("addTab"),
							),
						),
					),
					adding
						? h(AddForm, { scope: browseScope, edit, onChanged: () => void reload(), t })
						: current === null
							? null
							: h(ScopeCard, { key: current.scope, scope: current, edit, onChanged: () => void reload(), t }),
				);
			} else if (tab === "usage") {
				panel = h(
					"div",
					{ className: "dmx-panel" },
					(data.scopes ?? []).map((scope) => h(UsageCard, { key: scope.scope, scope, t })),
				);
			} else if (tab === "conflicts") {
				const cards = [];
				for (const scope of data.scopes ?? []) {
					for (const group of scope.conflicts ?? []) {
						cards.push(
							h(ConflictCard, {
								key: `${scope.scope}:${group.topic}`,
								group,
								scope: scope.scope,
								resolve,
								t,
							}),
						);
					}
				}
				panel = cards.length === 0
					? h("p", { className: "dmx-empty" }, t("empty"))
					: h("div", { className: "dmx-panel" }, cards);
			} else {
				panel = h(AuditView, { data, t });
			}

			return h(
				"div",
				{ className: "dmx-root" },
				h(
					"div",
					{ className: "dmx-head" },
					h(
						"div",
						null,
						h("h2", { className: "dmx-title" }, t("title")),
						h("p", { className: "dmx-intro" }, t("intro")),
						data === null ? null : h("p", { className: "dmx-cwd" }, data.cwd ?? ""),
					),
					h(
						Button,
						{ size: "sm", variant: "ghost", disabled: busy, onClick: () => void reload() },
						busy ? t("refreshing") : t("refresh"),
					),
				),
				h(SegmentedTabs, {
					items: tabs,
					value: tab,
					onChange: setTab,
					label: t("title"),
				}),
				panel,
			);
		}

		// ---- 注册 ---------------------------------------------------------------

		/** 需要的客户端服务。**不声明 connection** —— 缺了它面板该显示错误而不是整个不加载。 */
		const inject = ["slots", "locale"];

		/**
		 * 挂载设置页里的「记忆」面板。
		 * @param {object} ctx - 浏览器侧 cordis context。
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory: section dictionaries");

			/**
			 * 调宿主的一个端点。
			 * @param {string} endpoint - 端点名。
			 * @param {object} payload - 载荷。
			 * @returns {Promise<unknown>} 解开信封后的值。
			 */
			const call = async (endpoint, payload) => {
				const connection = ctx.get("connection");
				if (connection === undefined || connection === null) {
					throw new Error(t("noWorkspace"));
				}
				const result = await connection.rpc.call(CHANNEL, endpoint, payload);
				if (result.ok === true) return result.value;
				throw new Error(result.error?.message ?? "RPC failed");
			};

			// 注入面：非 hooks 的键会原样变成组件的 props（见 ui-renderer 的
			// bindInjectSources）。所以 `load` / `resolve` / `edit` 直接就是组件拿到的函数。
			const face = () => ({
				load: () => call("snapshot", {}),
				resolve: (scope, topic, action) => call("resolve", { scope, topic, action }),
				edit: (scope, payload) => call("edit", { scope, ...payload }),
			});

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "memory",
						order: 20,
						label: () => t("nav"),
						locale: NS,
						inject: face,
					},
					MemorySection,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
