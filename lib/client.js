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
			usageTotal: "Total usage",
			auditRuns: "Audit runs",
			pctUsed: "used",
			settingsTab: "Settings",
			limitProject: "Project limit",
			limitProjectSub: "Follows the current workspace",
			limitUser: "User limit",
			limitUserSub: "Shared across projects",
			bytesUnit: "bytes",
			approxChars: "Chinese chars",
			restoreDefault: "Restore default",
			limitHint: "Writes over the limit are rejected (never silently truncated). Takes effect immediately.",
			sectionFixedHint: "Section is fixed here (change it from Browse)",
			savedCount: "change(s) saved",
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
			auditRunTitle: "Audit record",
			gotoBrowse: "Open in Browse",
			auditId: "Entry id",
			auditSection: "Section",
			auditMode: "Mode",
			auditBytes: "Bytes",
			auditReason: "Reason",
			auditWith: "Conflicts with",
			auditAction: "Resolve action",
			auditKeep: "Kept",
			auditDrop: "Dropped",
			auditScope: "Scope",
			auditHash: "Content hash",
			auditSession: "Session",
			flashMiss: "This memory is no longer in the file (it may have been changed or deleted).",
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
			usageTotal: "总记忆用量",
			auditRuns: "审计 runs",
			pctUsed: "已用",
			settingsTab: "设置",
			limitProject: "项目记忆上限",
			limitProjectSub: "跟着当前工作区走",
			limitUser: "用户记忆上限",
			limitUserSub: "跨项目共用，所有工作区共享",
			bytesUnit: "字节",
			approxChars: "中文字符",
			restoreDefault: "恢复默认",
			limitHint: "超过上限时写入会被拒绝（不会静默截断）。改完立即生效。",
			sectionFixedHint: "分类在这里不可改（要改去「浏览」页）",
			savedCount: "处改动已保存",
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
			auditRunTitle: "审计记录",
			gotoBrowse: "去浏览页看",
			auditId: "条目 id",
			auditSection: "分类",
			auditMode: "模式",
			auditBytes: "字节",
			auditReason: "理由",
			auditWith: "冲突对象",
			auditAction: "裁决动作",
			auditKeep: "保留",
			auditDrop: "移除",
			auditScope: "作用域",
			auditHash: "内容指纹",
			auditSession: "会话",
			flashMiss: "这条记忆已经不在文件里了（可能被改过或删掉了）。",
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
			".dmx-entry{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:0.5px solid var(--dsw-alias-border-l1);scroll-margin-top:24px}",
			// 只有被点中的那一条会闪（.dmx-flash 只由单个 flashId 触发，不会批量标）
			".dmx-entry.dmx-flash{animation:dmx-flash 1.6s ease-out}",
			"@keyframes dmx-flash{0%,55%{background:var(--dsw-alias-state-business-primary);outline:0.5px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}100%{background:transparent;outline:0.5px solid transparent;color:inherit}}",
			// 减少动态效果时不动画，但保留 1.6s 的静态高亮（定时器到点照样撤）
			"@media (prefers-reduced-motion:reduce){.dmx-entry.dmx-flash{animation:none;background:var(--dsw-alias-state-business-primary)}}",
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
			// 可点的表格行（审计页）
			".dmx-table tbody tr.dmx-rowlink{cursor:pointer}",
			".dmx-table tbody tr.dmx-rowlink:hover td{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
			".dmx-th-go{width:16px}",
			".dmx-td-go{width:16px;color:var(--dsw-alias-label-tertiary);text-align:right}",
			// 审计弹窗：字段表
			".dmx-runbody{display:flex;flex-direction:column;gap:10px}",
			".dmx-kv{display:flex;flex-direction:column}",
			".dmx-kvrow{display:flex;align-items:baseline;gap:12px;padding:6px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dmx-kvrow:first-child{border-top:0}",
			".dmx-kvk{flex:0 0 96px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-kvv{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all;min-width:0}",
			".dmx-kvv.dmx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}",
			".dmx-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}",
			".dmx-form{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-top:8px;display:flex;flex-direction:column;gap:8px}",
			".dmx-form-title{font-size:13px;font-weight:600}",
			".dmx-field{display:flex;flex-direction:column;gap:4px}",
			".dmx-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dmx-input{border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:6px 8px;font-family:inherit}",
			".dmx-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dmx-textarea{resize:vertical;min-height:54px;line-height:20px}",
			".dmx-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}",
			".dmx-stat{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}",
			".dmx-statnum{font-size:18px;font-weight:700}",
			".dmx-statlabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}",
			".dmx-scopes>.dmx-card{min-width:0}",
			".dmx-big{font-size:26px;font-weight:700}",
			".dmx-kb{font-size:20px;font-weight:700}",
			".dmx-big em,.dmx-kb em{font-style:normal;font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:2px}",
			".dmx-secs{display:flex;flex-direction:column;gap:2px;max-height:132px;overflow:auto}",
			".dmx-secs-title{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			// 分类行是按钮：点开弹窗看该分类下的记忆（弹窗里直接可编辑）。
			".dmx-secrow{appearance:none;border:0;background:transparent;font-family:inherit;cursor:pointer;display:flex;align-items:baseline;justify-content:space-between;gap:8px;width:100%;font-size:12px;color:var(--dsw-alias-label-secondary);padding:5px 6px;border-radius:6px;text-align:left}",
			".dmx-secrow:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
			".dmx-secnum{font-style:normal;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:6px}",
			".dmx-chev{font-size:9px;color:var(--dsw-alias-label-tertiary)}",
			// 分类弹窗：条目列表 + 直接可编辑的行
			".dmx-entrylist{display:flex;flex-direction:column;max-height:56vh;overflow:auto;padding-right:2px}",
			".dmx-dentry{border-top:0.5px solid var(--dsw-alias-border-l1);padding:10px 6px 12px;display:flex;flex-direction:column;gap:6px;border-radius:6px}",
			".dmx-dentry:first-child{border-top:0}",
			".dmx-dentry:hover{background:var(--dsw-alias-bg-layer-3)}",
			".dmx-dentryhead{display:flex;align-items:center;gap:8px}",
			".dmx-dentryid{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			// 删除入口：小 ×，平时透明，鼠标移到该条才显形。
			".dmx-dentrydel{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;font-family:inherit;margin-left:auto;opacity:0;transition:opacity .12s}",
			".dmx-dentry:hover .dmx-dentrydel{opacity:1}",
			".dmx-dentrydel:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}",
			".dmx-frow{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
			".dmx-f{display:flex;flex-direction:column;gap:3px;min-width:0}",
			".dmx-f span{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-confirm{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px}",
			".dmx-confmsg{flex:1}",
			".dmx-modal .dmx-actions{border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:10px}",
			// 弹窗里的正文框统一不可拖拽 —— resize:vertical 会让每个框被单独拖动，
			// 一列条目高度就会参差不齐。超长内容在框内滚动。
			".dmx-modal .dmx-textarea{resize:none}",
			".dmx-usageline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dmx-minitab{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 10px;border-radius:999px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;white-space:nowrap}",
			".dmx-minitab:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
			".dmx-minitab[data-open='true']{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);font-weight:600}",
			".dmx-caret{font-size:9px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-settings{display:flex;flex-direction:column}",
			// 遮罩：用 backdrop-filter 压暗**背后内容**，不引入任何颜色值。原因有二 ——
			// 主题变量里没有够黑的遮罩色（bg-layer 系列都是中深灰，叠上去暗得不明显），
			// 而 client-bundle 的测试又禁止在 CSS 里写死颜色。降级：老 Electron 不支持时
			// 遮罩是全透明，弹窗照常可用。
			".dmx-overlay{position:fixed;inset:0;z-index:1000;display:flex;padding:24px 16px;overflow:auto;backdrop-filter:brightness(.45);animation:dmx-fade .14s ease-out}",
			// margin:auto 而不是 align-items:center —— 弹窗比视口高时还能滚动、顶部不被切掉。
			".dmx-modal{margin:auto;position:relative;width:100%;max-width:520px;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;animation:dmx-pop .16s ease-out}",
			// 弹窗动画：入场「遮罩淡入 + 卡片上浮放大」，退场反向。退场由 Modal 挂上
			// data-closing 触发，130ms 后组件才卸载（时长和上面两处的声明对得上）。
			"@keyframes dmx-fade{from{opacity:0}to{opacity:1}}",
			"@keyframes dmx-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}",
			"@keyframes dmx-fade-out{from{opacity:1}to{opacity:0}}",
			"@keyframes dmx-pop-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(6px) scale(.98)}}",
			".dmx-overlay[data-closing='true']{animation:dmx-fade-out .12s ease-in forwards}",
			".dmx-overlay[data-closing='true'] .dmx-modal{animation:dmx-pop-out .12s ease-in forwards}",
			"@media (prefers-reduced-motion:reduce){.dmx-overlay,.dmx-modal{animation:none}}",
			".dmx-modalhead{display:flex;align-items:center;gap:10px}",
			".dmx-modaltitle{font-size:14px;font-weight:600}",
			// margin-left:auto 把 ✕ 顶到最右。不能用 justify-content:space-between ——
			// 「新增」那个弹窗不给 title（用表单自己的标题），只剩 ✕ 一个子元素时
			// space-between 会把它留在最左。
			".dmx-modalclose{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;font-family:inherit;margin-left:auto}",
			".dmx-modalclose:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
			".dmx-modal .dmx-form{border:0;padding:0;margin-top:0}",
			".dmx-setrow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}",
			".dmx-setrow:first-child{border-top:0}",
			".dmx-setlabel{display:flex;flex-direction:column;gap:2px}",
			".dmx-setlabel b{font-size:13px;font-weight:600}",
			".dmx-setlabel span{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-numwrap{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
			".dmx-num{width:104px;text-align:right;font-variant-numeric:tabular-nums}",
			".dmx-unit{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dmx-approx{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:96px;text-align:right}",
			".dmx-hint{margin:0;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}",
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
		function EntryRow({ entry, scope, edit, onChanged, flashId = null, t }) {
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
					// data-entry-id 两个分支都要给：定位时按它找 DOM 元素。
					{ className: "dmx-entry", "data-entry-id": entry.id ?? "" },
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
				{
					className: flashId !== null && entry.id === flashId ? "dmx-entry dmx-flash" : "dmx-entry",
					"data-entry-id": entry.id ?? "",
				},
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
		 * 一个简单的模态弹窗：半透明遮罩 + 居中卡片。
		 *
		 * **为什么自己搭而不找官方组件**：浏览器半侧能 `require` 的只有静态种子里那几个
		 * （react / ui-primitives …），而 ui-primitives 里到底有没有 Dialog、API 长什么样，
		 * 在这里无法验证 —— 猜错了面板会整块挂掉。所以只用**普通元素 + 主题变量**搭，
		 * 行为完全可控。点遮罩、或点右上角 ✕，都会关闭。
		 *
		 * @param {{title?: string, onClose: Function, children: object}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function Modal({ title, onClose, children }) {
			const [closing, setClosing] = React.useState(false);

			/**
			 * 关闭：先挂上 `data-closing` 播退场动画，等动画时长过了再真正卸载 ——
			 * 否则组件立刻被卸载，退场动画根本来不及播。130ms 和 CSS 里的 `.12s`
			 * 对齐（留一点余量）。重复点击由 `closing` 挡住，不会排多个定时器。
			 */
			const requestClose = () => {
				if (closing) return;
				setClosing(true);
				setTimeout(onClose, 130);
			};

			return h(
				"div",
				{ className: "dmx-overlay", "data-closing": closing ? "true" : "false", onClick: requestClose },
				h(
					"div",
					{ className: "dmx-modal", onClick: (e) => e.stopPropagation() },
					h(
						"div",
						{ className: "dmx-modalhead" },
						title === undefined ? null : h("span", { className: "dmx-modaltitle" }, title),
						h("button", { type: "button", className: "dmx-modalclose", onClick: requestClose }, "✕"),
					),
					// children 既可以是元素，也可以是 `(requestClose) => 元素` —— 后者给
					// 「保存成功后要关窗」那种场景用，好让程序化关闭也走同一个退场动画。
					typeof children === "function" ? children(requestClose) : children,
				),
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
		function ScopeCard({ scope, edit, onChanged, flashId = null, t }) {
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
						seEntries.map((entry) => h(EntryRow, { key: entry.id ?? entry.topic, entry, scope: scope.scope, edit, onChanged, flashId, t })),
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
		 * 用量总览：所有作用域加起来的占用 + 三个关键计数，外加一个「设置」小 tab。
		 *
		 * 「设置」**不做成独立 tab 页** —— 它是挂在「已用」数字后面的一个小胶囊，
		 * 点开就地展开两个记忆上限。当前值与默认值都来自 snapshot 的 `limits`，
		 * 客户端不重复写默认值（避免两个真源）。
		 *
		 * @param {{totals: object, limits: object, saveSettings: Function,
		 *          onSaved: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function TotalsCard({ totals, limits, saveSettings, onSaved, t }) {
			const [open, setOpen] = React.useState(false);
			const [draft, setDraft] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const used = Number(totals?.bytes) || 0;
			const max = Number(totals?.maxBytes) || 0;
			const ratio = max > 0 ? Math.min(1, used / max) : 0;
			const pct = max > 0 ? Math.round((used / max) * 100) : 0;

			const current = {
				projectMaxBytes: Number(limits?.current?.projectMaxBytes) || 0,
				userMaxBytes: Number(limits?.current?.userMaxBytes) || 0,
			};
			const defaults = {
				projectMaxBytes: Number(limits?.defaults?.projectMaxBytes) || 0,
				userMaxBytes: Number(limits?.defaults?.userMaxBytes) || 0,
			};
			const form = draft ?? current;

			const save = async () => {
				setBusy(true);
				setNotice(null);
				try {
					const result = await saveSettings({
						projectMaxBytes: Number(form.projectMaxBytes),
						userMaxBytes: Number(form.userMaxBytes),
					});
					setNotice({ bad: false, text: result.message });
					setDraft(null);
					onSaved();
				} catch (error) {
					setNotice({ bad: true, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			/** 一行上限输入：标签 + 数字框 + 单位 + 换算提示。 */
			const row = (key, labelKey, subKey) =>
				h(
					"div",
					{ className: "dmx-setrow" },
					h("span", { className: "dmx-setlabel" }, h("b", null, t(labelKey)), h("span", null, t(subKey))),
					h(
						"span",
						{ className: "dmx-numwrap" },
						h("input", {
							className: "dmx-input dmx-num",
							type: "number",
							min: "512",
							step: "512",
							value: String(form[key]),
							onChange: (e) => setDraft({ ...form, [key]: e.target.value }),
						}),
						h("span", { className: "dmx-unit" }, t("bytesUnit")),
						h("span", { className: "dmx-approx" }, `≈ ${Math.round((Number(form[key]) || 0) / 3)} ${t("approxChars")}`),
					),
				);

			return h(
				"section",
				{ className: "dmx-card" },
				h("div", { className: "dmx-cardhead" }, h("span", { className: "dmx-cardname" }, t("usageTotal"))),
				h(
					"div",
					{ className: "dmx-usageline" },
					h("span", { className: "dmx-big" }, fmtBytes(used), h("em", null, ` /${pct}% ${t("pctUsed")}`)),
					h(
						"button",
						{ type: "button", className: "dmx-minitab", onClick: () => setOpen(true) },
						t("settingsTab"),
					),
				),
				h("div", { className: "dmx-bar" }, h("div", {
					className: "dmx-barfill",
					"data-warn": ratio >= 0.9 ? "true" : "false",
					style: { width: `${Math.round(ratio * 100)}%` },
				})),
				h(
					"div",
					{ className: "dmx-stats" },
					h("div", { className: "dmx-stat" }, h("b", { className: "dmx-statnum" }, String(totals?.entries ?? 0)), h("span", { className: "dmx-statlabel" }, t("entries"))),
					h("div", { className: "dmx-stat" }, h("b", { className: "dmx-statnum" }, String(totals?.pending ?? 0)), h("span", { className: "dmx-statlabel" }, t("pending"))),
					h("div", { className: "dmx-stat" }, h("b", { className: "dmx-statnum" }, String(totals?.runs ?? 0)), h("span", { className: "dmx-statlabel" }, t("auditRuns"))),
				),
				open
					? h(
							Modal,
							{ title: t("settingsTab"), onClose: () => setOpen(false) },
							h(
								"div",
								{ className: "dmx-settings" },
								row("projectMaxBytes", "limitProject", "limitProjectSub"),
								row("userMaxBytes", "limitUser", "limitUserSub"),
								h(
									"div",
									{ className: "dmx-actions" },
									h(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => void save() }, t("save")),
									h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => setDraft(defaults) }, t("restoreDefault")),
									notice === null ? null : h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
								),
								h("p", { className: "dmx-hint" }, t("limitHint")),
							),
						)
					: null,
			);
		}

		/**
		 * 「分类」弹窗的内容：列出某个段下的条目，**直接可编辑** —— 每条就是输入框，
		 * 点进去就能改，没有「编辑」按钮。删除走每行右上角的小 ×（鼠标移到该条才显形）
		 * + 行内二次确认。底部一个「保存」把改动攒着一起提交。
		 *
		 * **为什么「分类」在这里不可改**：这个弹窗本身就是按分类聚合出来的，改了分类
		 * 这行就会从这个分类里消失，容易让人以为被删了。要改分类去「浏览」页。
		 *
		 * @param {{scope: string, entries: object[], edit: Function, onSaved: Function,
		 *          onDone: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function SectionModal({ scope, entries, edit, onSaved, onDone, t }) {
			const [drafts, setDrafts] = React.useState(() =>
				entries.map((e) => ({
					id: e.id,
					topic: e.topic ?? "",
					area: e.area ?? "",
					content: e.content ?? "",
				})),
			);
			const [removed, setRemoved] = React.useState([]);
			const [confirming, setConfirming] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);

			const patch = (id, key, value) =>
				setDrafts((list) => list.map((d) => (d.id === id ? { ...d, [key]: value } : d)));

			/**
			 * 保存：**只提交真正动过的条目**（没改的不发 RPC），删除排在最后。
			 * 逐条调用 `edit` 端点 —— 一次只处理一条，但并发锁会把它们串起来。
			 *
			 * 写法上刻意避开「行首 await」：client-bundle 用例用行首匹配来近似
			 * 「顶层不能有 await」，行首出现 await 会被它误判成违规。
			 */
			const save = async () => {
				setBusy(true);
				setNotice(null);
				try {
					const updates = drafts.filter((d) => {
						if (removed.includes(d.id)) return false;
						const before = entries.find((e) => e.id === d.id);
						if (before === undefined) return false;
						return (
							d.topic !== (before.topic ?? "") ||
							d.area !== (before.area ?? "") ||
							d.content !== (before.content ?? "")
						);
					});

					let count = 0;
					// 不传 section —— 后端保留原分类。
					for (const d of updates) {
						const done = await edit(scope, {
							action: "update",
							id: d.id,
							topic: d.topic,
							content: d.content,
							area: d.area,
						});
						if (done?.ok !== true) throw new Error(done?.message ?? "更新失败");
						count += 1;
					}
					for (const id of removed) {
						const gone = await edit(scope, { action: "delete", id });
						if (gone?.ok !== true) throw new Error(gone?.message ?? "删除失败");
						count += 1;
					}

					// 删掉的从草稿里摘掉，免得再点一次「保存」重复删除。
					setDrafts((list) => list.filter((d) => !removed.includes(d.id)));
					setRemoved([]);
					setNotice({ bad: false, text: `✓ ${count} ${t("savedCount")}` });
					onSaved();
				} catch (error) {
					setNotice({ bad: true, text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};

			const visible = drafts.filter((d) => !removed.includes(d.id));

			return h(
				"div",
				{ className: "dmx-entrylist" },
				visible.length === 0
					? h("p", { className: "dmx-empty" }, t("empty"))
					: visible.map((d) =>
							h(
								"div",
								{ key: d.id, className: "dmx-dentry" },
								h(
									"div",
									{ className: "dmx-dentryhead" },
									h("span", { className: "dmx-dentryid" }, d.id),
									h(
										"button",
										{
											type: "button",
											className: "dmx-dentrydel",
											title: t("delete"),
											onClick: () => setConfirming(d.id),
										},
										"✕",
									),
								),
								h(
									"div",
									{ className: "dmx-frow" },
									h(
										"label",
										{ className: "dmx-f" },
										h("span", null, t("topic")),
										h("input", {
											className: "dmx-input",
											value: d.topic,
											onChange: (e) => patch(d.id, "topic", e.target.value),
										}),
									),
									h(
										"label",
										{ className: "dmx-f" },
										h("span", null, t("area")),
										h("input", {
											className: "dmx-input",
											value: d.area,
											onChange: (e) => patch(d.id, "area", e.target.value),
										}),
									),
								),
								h(
									"label",
									{ className: "dmx-f" },
									h("span", null, t("content")),
									h("textarea", {
										className: "dmx-input dmx-textarea",
										value: d.content,
										onChange: (e) => patch(d.id, "content", e.target.value),
									}),
								),
								confirming === d.id
									? h(
											"div",
											{ className: "dmx-confirm" },
											h("span", { className: "dmx-confmsg" }, t("confirmDelete")),
											h(
												Button,
												{
													size: "sm",
													variant: "primary",
													disabled: busy,
													onClick: () => {
														setRemoved((list) => [...list, d.id]);
														setConfirming(null);
													},
												},
												t("confirmDeleteYes"),
											),
											h(
												Button,
												{ size: "sm", variant: "ghost", disabled: busy, onClick: () => setConfirming(null) },
												t("confirmDeleteNo"),
											),
										)
									: null,
							),
						),
				h(
					"div",
					{ className: "dmx-actions" },
					h(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => void save() }, t("save")),
					h(Button, { size: "sm", variant: "ghost", disabled: busy, onClick: onDone }, t("cancel")),
					notice === null
						? null
						: h("span", { className: "dmx-notice", "data-bad": notice.bad ? "true" : "false" }, notice.text),
					h("span", { className: "dmx-hint", style: { marginLeft: "auto" } }, t("sectionFixedHint")),
				),
			);
		}

		/**
		 * 用量视图的一个作用域卡片：占用条 + 分类分布。
		 * 分布列表限高滚动 —— 段多的时候不会把卡片撑高、两列也就不会左右不齐。
		 * 每一行可点：点开弹窗看该分类下的记忆（弹窗里直接可编辑）。
		 * @param {{scope: object, edit: Function, onSaved: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function UsageCard({ scope, edit, onSaved, t }) {
			const [openSec, setOpenSec] = React.useState(null);
			const used = Number(scope.bytes) || 0;
			const max = Number(scope.maxBytes) || 0;
			const ratio = max > 0 ? Math.min(1, used / max) : 0;
			const pct = max > 0 ? Math.round((used / max) * 100) : 0;
			const sections = Object.entries(scope.sections ?? {});
			const entries = scope.entries ?? [];
			// 口径必须和 detect.js 的 countBySection 一致（section ?? "(无段)"），
			// 否则「17 条」点开会和列表对不上。
			const inSection =
				openSec === null ? [] : entries.filter((e) => (e.section ?? "(无段)") === openSec);
			return h(
				"section",
				{ className: "dmx-card" },
				h(
					"div",
					{ className: "dmx-cardhead" },
					h("span", { className: "dmx-cardname" }, scopeLabel(scope.scope, t)),
					h("span", { className: "dmx-meta" }, `${t("entries")}: ${scope.entryCount ?? 0}`),
				),
				h("div", null, h("span", { className: "dmx-kb" }, fmtBytes(used), h("em", null, ` /${pct}% ${t("pctUsed")}`))),
				h("div", { className: "dmx-bar" }, h("div", {
					className: "dmx-barfill",
					"data-warn": ratio >= 0.9 ? "true" : "false",
					style: { width: `${Math.round(ratio * 100)}%` },
				})),
				h("p", { className: "dmx-secs-title" }, t("sections")),
				sections.length === 0
					? h("p", { className: "dmx-empty" }, t("empty"))
					: h(
							"div",
							{ className: "dmx-secs" },
							sections.map(([name, count]) =>
								h(
									"button",
									{ key: name, type: "button", className: "dmx-secrow", onClick: () => setOpenSec(name) },
									h("span", null, name),
									h("span", { className: "dmx-secnum" }, String(count), h("i", { className: "dmx-chev" }, "›")),
								),
							),
						),
				openSec === null
					? null
					: h(
							Modal,
							{ title: openSec, onClose: () => setOpenSec(null) },
							// 函数式子元素：拿到 Modal 的 requestClose，保存成功后走同一个退场动画。
							(requestClose) =>
								h(SectionModal, {
									scope: scope.scope,
									entries: inSection,
									edit,
									onSaved,
									onDone: requestClose,
									t,
								}),
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
		 * 审计记录里可展示的字段 → 文案键。记录里为空 / null 的字段不显示。
		 * 顺序就是弹窗里的展示顺序。
		 */
		const RUN_FIELDS = {
			at: "auditTime",
			op: "auditOp",
			id: "auditId",
			topic: "auditTopic",
			section: "auditSection",
			mode: "auditMode",
			bytes: "auditBytes",
			reason: "auditReason",
			with: "auditWith",
			action: "auditAction",
			keep: "auditKeep",
			drop: "auditDrop",
			scope: "auditScope",
			by: "auditBy",
			hash: "auditHash",
			session: "auditSession",
		};

		/**
		 * 一条审计记录的完整字段 + 「去浏览页看」。
		 *
		 * 「去浏览页看」**只切 tab、选中同作用域，不尝试定位具体某一条** —— 卡片不渲染
		 * `id`，没有可定位的 DOM；而且那条可能已经被改甚至删了，硬定位只会误导。
		 *
		 * @param {{scope: string, run: object, onGoto: Function, onDone: Function,
		 *          t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function RunModal({ scope, run, onGoto, onDone, t }) {
			const rows = Object.entries(RUN_FIELDS).filter(([key]) => {
				const value = run?.[key];
				return value !== null && value !== undefined && value !== "";
			});
			return h(
				"div",
				{ className: "dmx-runbody" },
				h(
					"div",
					{ className: "dmx-kv" },
					rows.map(([key]) => {
						const raw = String(run[key]);
						const text =
							key === "at"
								? raw.replace("T", " ").slice(0, 19)
								: key === "scope"
									? scopeLabel(raw, t)
									: raw;
						const mono = key === "id" || key === "hash" || key === "session";
						return h(
							"div",
							{ key, className: "dmx-kvrow" },
							h("span", { className: "dmx-kvk" }, t(RUN_FIELDS[key])),
							h("span", { className: mono ? "dmx-kvv dmx-mono" : "dmx-kvv" }, text),
						);
					}),
				),
				h(
					"div",
					{ className: "dmx-actions" },
					h(Button, {
						size: "sm",
						variant: "primary",
						onClick: () => {
							onGoto(scope, run?.id ?? null);
							onDone();
						},
					}, t("gotoBrowse")),
					h(Button, { size: "sm", variant: "ghost", onClick: onDone }, t("cancel")),
				),
			);
		}

		/**
		 * 审计视图。表格行可点：点开弹窗看这条记录的完整字段。
		 * @param {{data: object, onGoto: Function, t: Function}} props - 参数。
		 * @returns {object} React 元素。
		 */
		function AuditView({ data, onGoto, t }) {
			const [openRun, setOpenRun] = React.useState(null);
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
									h("th", { className: "dmx-th-go" }, ""),
								),
							),
							h(
								"tbody",
								null,
								rows.map(({ scope, run }, index) =>
									h(
										"tr",
										{ key: index, className: "dmx-rowlink", onClick: () => setOpenRun({ scope: scope.scope, run }) },
										h("td", null, (run.at ?? "").replace("T", " ").slice(0, 19)),
										h("td", null, run.op ?? ""),
										h("td", null, run.topic ?? ""),
										h("td", null, `${scopeLabel(scope.scope, t)} / ${run.by ?? ""}`),
										h("td", { className: "dmx-td-go" }, "›"),
									),
								),
							),
						),
				openRun === null
					? null
					: h(
							Modal,
							{ title: t("auditRunTitle"), onClose: () => setOpenRun(null) },
							(requestClose) =>
								h(RunModal, { scope: openRun.scope, run: openRun.run, onGoto, onDone: requestClose, t }),
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
		function MemorySection({ load, resolve, edit, saveSettings, t }) {
			const [tab, setTab] = React.useState("browse");
			// 「浏览」页下的次级 tab：按作用域（用户 / 项目）切换。项目页里再按工作空间分区。
			const [browseScope, setBrowseScope] = React.useState("project");
			// 「新建+」是次级 tab 排旁边的独立方框：点它把下面换成新增表单，写入选中的作用域。
			const [adding, setAdding] = React.useState(false);
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			// 从审计跳转过来时，要闪一下的那一条的 id。**只能是单个 id** —— 只高亮被点中的
			// 那一条，绝不会把「这次改过的所有条目」都标出来。
			const [flashId, setFlashId] = React.useState(null);
			// 目标条目在文件里找不到（被改过 / 删了）时给个提示。
			const [flashMiss, setFlashMiss] = React.useState(false);

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

			// 定位到目标条目。放在 effect 里是因为 setTab 之后 DOM 还没渲染，当场查是
			// 空的 —— 必须等这一轮渲染完才能查到、才能滚。
			React.useEffect(() => {
				if (flashId === null || tab !== "browse") return undefined;
				const found = document.querySelector(`[data-entry-id="${flashId}"]`);
				if (found === null) {
					setFlashMiss(true);
					return undefined;
				}
				setFlashMiss(false);
				found.scrollIntoView({ block: "center", behavior: "smooth" });
				// 闪完就撤，不留痕。
				const timer = setTimeout(() => setFlashId(null), 1600);
				return () => clearTimeout(timer);
			}, [flashId, tab]);

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
								{ size: "sm", variant: "ghost", onClick: () => setAdding(true) },
								t("addTab"),
							),
						),
					),
					flashMiss === true ? h("p", { className: "dmx-empty" }, t("flashMiss")) : null,
					current === null
						? null
						: h(ScopeCard, {
								key: current.scope,
								scope: current,
								edit,
								onChanged: () => void reload(),
								flashId,
								t,
							}),
					// 「新建+」不再是「把面板内容换掉」，而是弹一个窗口 —— 列表始终在下面。
					adding
						? h(
								Modal,
								{ onClose: () => setAdding(false) },
								h(AddForm, { scope: browseScope, edit, onChanged: () => void reload(), t }),
							)
						: null,
				);
			} else if (tab === "usage") {
				panel = h(
					"div",
					{ className: "dmx-panel" },
					h(TotalsCard, {
						totals: data.totals ?? {},
						limits: data.limits ?? {},
						saveSettings,
						onSaved: () => void reload(),
						t,
					}),
					h(
						"div",
						{ className: "dmx-scopes" },
						(data.scopes ?? []).map((scope) =>
							h(UsageCard, { key: scope.scope, scope, edit, onSaved: () => void reload(), t }),
						),
					),
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
				panel = h(AuditView, {
					data,
					// 「去浏览页看」：切 tab + 选中同作用域 + 闪一下那一条。
					// entryId 可能为 null（老条目没有 id）—— 那时只切 tab、不高亮。
					onGoto: (scopeName, entryId) => {
						setBrowseScope(scopeName);
						setAdding(false);
						setFlashMiss(false);
						setTab("browse");
						setFlashId(entryId ?? null);
					},
					t,
				});
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
				saveSettings: (limits) => call("settings", limits),
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
