window.__ModuleLoader__.load({
	id: "@ericality/dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		//  「通知（Bark / 群晖）」设置卡 —— 通知设置整改 v0.7.0（客户端 B 侧）
		//  位置: 设置 > 本地插件 > 通知（Bark / 群晖）(settings.localplugin.item key=notify)
		//  契约(唯一来源): docs/任务记录/2026-09-12-通知设置整改-契约v0.7.0.md §4(RPC 形状)/§5(卡片规则)
		//                 + docs/任务记录/2026-09-12-本地插件折叠卡-契约.md（外壳/标题行由容器提供）
		//  视觉/文案权威: public/preview-notify-settings.html（用户已确认"按此实施"）
		//  数据面: 已认证 RPC /notify-hub (同 /model-console、/costguard-cfg 先例)
		//          get / saveDevice / deleteDevice / setRoutes / setOptions / test —— 逐字按 §4, 不自创字段
		//  安全: 明文 URL 只上行(saveDevice); 列表/响应/日志只回 urlTail(「…尾4位」),
		//        响应与日志永不出现完整 URL / key; 本组件不做任何明文缓存或回显。
		//  样式: 零新增色相 —— 全部 dsw 语义变量(business/success/warn/danger)+ color-mix,
		//        chrome 取值与预览 public/preview-notify-settings.html 的 nt-* 家族同款;
		//        卡内**分组级**折叠保留(预留类型 / 高级), 整卡折叠由容器 dsh-quick-insert 提供。
		//  旧 host 兼容(契约 §5 补充 · 协调人裁决): 本文件先于 host 重启上线, 因此在旧 RPC 下必须优雅降级 ——
		//        ① hasProducer 缺失 ⇒ 当 true(不丢进"预留"折叠区) ② effective 缺失 ⇒ 本地回退解析
		//        ③ setOptions 不存在 ⇒ 不判整次保存失败, 改为提示 OPTIONS_RPC_HINT
		//        ④ 旧 host 会把 routes[type]=[] 删键 ⇒ 三态读回变"默认", 由同一提示覆盖
		// ═══════════════════════════════════════════════════════════════════
		const ROW_ID = "notify";
		/** v0.9.0：左栏面板 id（sidebar.panellist 的 id 与 main 的 key 必须相同）。 */
		const PANEL_ID = "notify";
		const NS = "ui-notify";
		const CHANNEL = "/notify-hub";

		/** kind 枚举 (沿用; 设备区本次不改)。 */
		const KINDS = [
			{ id: "bark", label: "bark · Bark" },
			{ id: "synology", label: "synology · 群晖" }
		];
		const KIND_LABEL = { bark: "Bark", synology: "群晖" };
		const URL_RE = /^https?:\/\//i;

		/**
		 * 契约 §2 冻结 type 表的**兜底**副本（服务端 get 未回 types 时用于渲染项目行; 含 hasProducer）。
		 * 权威源始终是服务端返回的 types[{ type, label, group, level, hasProducer }]。
		 */
		const TYPES_FALLBACK = [
			{ type: "auth.login_failed", label: "登录失败（密码/验证码错误）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.locked", label: "触发锁定（含全站闸）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.unlocked", label: "锁定期满 / 手动解除", group: "DSH-安全", level: "active", hasProducer: true },
			{ type: "auth.new_device", label: "新设备通过 TOTP 验证", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.mfa_changed", label: "MFA 启用 / 停用 / 重生成", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.otp", label: "登录一次性码（发到手机）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "task.done", label: "对话完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "task.asking", label: "需要你回应（agent 提问）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "task.interrupted", label: "回合被中断（重启后补推）", group: "DSH-任务", level: "active", hasProducer: true },
			// 2026-10-02（`#A424`）第 15 项：子 agent 会话的回合结束走本 type（与 task.done 同组同档，仅"选渠道"独立）
			{ type: "subagent.done", label: "子 agent 完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "team.member.done", label: "智能体团队成员完成", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "cost.alert", label: "费用提醒", group: "DSH-费用", level: "active", hasProducer: true },
			{ type: "queue.dispatched", label: "队列派发", group: "DSH-队列", level: "passive", hasProducer: true },
			{ type: "queue.cancelled", label: "队列取消", group: "DSH-队列", level: "passive", hasProducer: true },
			{ type: "queue.failed", label: "队列失败", group: "DSH-队列", level: "timeSensitive", hasProducer: true },
			{ type: "test", label: "测试推送（设置卡逐台）", group: "DSH-测试", level: "active", hasProducer: true }
		];

		/**
		 * 契约 §5 emoji 映射（客户端常量, 冻结; 未列出的 type ⇒ 空串）。
		 * 2026-09-12 协调人裁决①落实: 补 queue.dispatched/queue.cancelled="⛰"、cost.alert="💰"
		 * —— 与用户已确认预览 public/preview-notify-settings.html 的"预留类型"行 1:1（契约 §5 已同步此项）。
		 */
		const TYPE_EMOJI = {
			"task.done": "✅",
			"task.asking": "⁉️",
			"task.interrupted": "❌",
			"subagent.done": "🤖",
			"team.member.done": "👥",
			"auth.login_failed": "🔒",
			"auth.locked": "🔒",
			"auth.unlocked": "🔓",
			"auth.new_device": "✅",
			"auth.mfa_changed": "🔐",
			"test": "🔔",
			"queue.dispatched": "⛰",
			"queue.cancelled": "⛰",
			"cost.alert": "💰"
		};

		/** 行内补充说明 —— 逐字取自已确认预览 public/preview-notify-settings.html（仅这 3 行有 note）。 */
		const ROW_NOTES = {
			"team.member.done": "Agent Teams 团队成员会话回合结束；默认不推送，需在此单独选渠道开启",
			"task.done": "回合耗时 ≥ 阈值时推送完整问答（原来和下面两项共用一个 type）",
			"task.asking": "agent 调用提问工具时立即推，不受阈值限制",
			"task.interrupted": "容器重启致回合中断时补一条，含去重标记"
		};

		/** 契约 §5 客户端分组（组内保持服务端顺序; hasProducer===false 一律进预留折叠区, 不在这里匹配）。 */
		const GROUPS = [
			{ title: "对话（回合级）", match: function (t) { return t === "task.done" || t === "task.asking" || t === "task.interrupted" || t === "subagent.done" || t === "team.member.done"; } },
			{ title: "登录安全（由 auth-proxy 发送）", match: function (t) { return t.indexOf("auth.") === 0; } },
			{ title: "其它", match: function (t) { return t === "test"; } }
		];
		/** 「其它」组下标 —— 服务端将来新增的 type(有生产者)兜底归到这里, 避免静默消失。 */
		const OTHER_GROUP = 2;

		/** 契约 §3 options 默认值（服务端未回 options 时用; 与 host 侧 `config.minTurnMs ?? 60000` 一致）。
		 *  ★ 2026-10-02（`#A428` 件①）`bannerSummary: true → false`（用户令「默认关的就行」）——
		 *  **必须与服务端 `lib/index.js` `optionsDefaults.bannerSummary` 同值**（同批改，防"界面显示开、实际关"假象）。 */
		const DEFAULT_OPTIONS = { minTurnMs: 60000, bannerSummary: false, reconcile: true,
			// ★件G（2026-10-06）：全局公共参数 —— **必须与服务端 `optionsDefaults` 同值**（否则"界面显示 X、实际 Y"）；★件J-乙 起为 6 键
			// ★件J-乙（2026-10-08）：＋ `synologyConcurrency`（第 6 键）；bark 三默认值按 `T51` ⇒ 20000／1／2。
			//   ★这里只是"服务端没回该键时的兜底显示值"；**真正的显式值来自服务端回读**（现网 hub 显式
			//   `barkRetries=5`／`barkConcurrency=5` ⇒ 界面显示 5／5，**不显示兜底 1／2**）。
			barkTimeoutMs: 20000, barkRetries: 1, barkConcurrency: 2, synologyTimeoutMs: 10000, synologyRetries: 0,
			synologyConcurrency: 1 };
		/** ★件G：全局参数夹取边界（与服务端常量同口径）；★件J-乙 起 6 键 */
		const TIMEOUT_MIN_MS = 1000, TIMEOUT_MAX_MS = 120000, RETRIES_MAX = 5, CONC_MIN = 1, CONC_MAX = 8;
		const MIN_TURN_MS_MAX = 3600000;
		const MIN_SEC_MAX = 3600;

		/** 旧 host（host 侧插件未更新）提示 —— 契约 §5 补充 ③/④。 */
		const OPTIONS_RPC_HINT = "host 插件未更新：本次改动里的『触发条件』与『关闭』要等 dsh web 重启后生效";
		const SAVED_STALE_TEXT = "✓ 已保存（触发条件/关闭需重启 dsh web 后生效）";

		// ---- ★件B（`#A449`）：载荷分隔符 7 项（**按出现位置**，逐台设备可配）----------------
		/** 客户端兜底表（旧 host 未回 `sepMeta` 时用）；**必须与服务端 `lib/index.js` `SEP_SPECS` 逐字一致**。 */
		const SEP_META_FALLBACK = [
			{ key: "sepHead", label: "消息开头", pos: "每条消息的第 1 行", def: "=*34" },
			{ key: "sepTail", label: "消息结尾", pos: "每条消息的最后 1 行", def: "=*34" },
			{ key: "sepTitleQ", label: "标题与问题之间", pos: "标题行下面（切开标题与正文/问题）", def: "─*30" },
			{ key: "sepQa", label: "问题与回答之间", pos: "「👀 问题」之后、「💡 回复」之前", def: "\\n*2" },
			{ key: "sepReplyFooter", label: "回答与页脚之间", pos: "回答之后、页脚行之前（单页消息）", def: "\\n*2" },
			{ key: "sepBodyFooter", label: "正文与页脚之间（多页最后一条）", pos: "多页时最后一条：正文之后、页脚行之前", def: "\\n*2" },
			{ key: "sepPageJoin", label: "分页消息之间的连接", pos: "仅 Bark：多页拼成一条时、页与页之间", def: "\\n*2" }
		];
		// ---- ★件C（`#A462`）：「内容段」三开关（逐台设备各一份；默认全开 ＝ 现状）＋「简洁」预设 ----
		/** 客户端兜底表（旧 host 未回 `segMeta` 时用）；**必须与服务端 `lib/index.js` `SEG_SPECS` 逐字一致**。 */
		const SEG_META_FALLBACK = [
			{ key: "segTitle", label: "会话标题", def: true, pos: "标题行（含状态前缀，如「✅ 任务完成 · 」）；相邻分隔符 P3" },
			{ key: "segQuestion", label: "问题", def: true, pos: "「👀 问题」块；相邻分隔符 P3／P4" },
			{ key: "segAnswer", label: "回答", def: true, pos: "「💡 回复」块 ＋ **随附页脚**；相邻分隔符 P4／P5／P6" }
		];
		/** ★「简洁」预设 ＝ 把三开关填成「标题开／问题关／回答关」⇒ 输出只含「标题＋状态」。**只填值**，不做双向联动锁定。 */
		const SEG_PRESET_SIMPLE = { segTitle: true, segQuestion: false, segAnswer: false };
		/** 空段就地标注（不得静默：哪个类型本就没有哪一段）。 */
		const SEG_EMPTY_NOTE = "空段标注：「问题」＝仅「需要你回应」类（task.asking）有该段；task.done／task.interrupted／subagent.done 本就无该段 ⇒ 该开关对其无效，关掉 ⇒ 输出逐字不变（不多出空行、不多出／少掉分隔符）｜「回答」＝同理，且关「回答」⇒ 随附页脚一并省略（＝「只发标题和状态」口径）。";
		const SEP_COUNT_MIN = 1;
		const SEP_COUNT_MAX = 60;
		const SEP_BODY_MAX = 32;

		// ---- v0.9.0：模板（{{占位符}}）与渠道参数 ----
		/** 旧 host 未回 `tplMeta` 时的兜底（**只列键/标签**；样本与服务端权威表同源，不在此重复长文案）。 */
		const TPL_PLACEHOLDERS_FALLBACK = [
			{ key: "title", label: "标题（纯）" }, { key: "titleFull", label: "完整标题" }, { key: "status", label: "状态文字" }, { key: "emoji", label: "状态 emoji" },
			{ key: "session", label: "会话标题" }, { key: "sid", label: "会话短 id" }, { key: "turn", label: "回合号" },
			{ key: "elapsed", label: "用时（可读）" }, { key: "elapsedMs", label: "用时（毫秒）" }, { key: "reason", label: "结束原因" },
			{ key: "question", label: "问题" }, { key: "answer", label: "回答" }, { key: "summary", label: "总结段落" },
			{ key: "footer", label: "页脚" }, { key: "body", label: "旧版正文" }, { key: "time", label: "当前时间" },
			{ key: "date", label: "当前日期" }, { key: "iso", label: "ISO 时间" }, { key: "type", label: "通知类型" },
			{ key: "typeLabel", label: "类型中文名" }, { key: "group", label: "Bark group" }, { key: "level", label: "Bark level" },
			{ key: "device", label: "设备 id" }, { key: "deviceName", label: "设备名称" }, { key: "kind", label: "渠道类型" },
			{ key: "sepHead", label: "分隔符：消息开头" }, { key: "sepTail", label: "分隔符：消息结尾" },
			{ key: "sepTitleQ", label: "分隔符：标题与问题之间" }, { key: "sepQa", label: "分隔符：问题与回答之间" },
			{ key: "sepReplyFooter", label: "分隔符：回答与页脚之间" }, { key: "sepBodyFooter", label: "分隔符：正文与页脚之间" },
			{ key: "sepPageJoin", label: "分隔符：分页连接" }
		];
		const TPL_EXAMPLES_FALLBACK = {
			bark: { title: "{{emoji}} {{status}} · {{session}}", body: "{{status}}｜回合 #{{turn}}（{{elapsed}}）\n{{answer}}" },
			synology: { title: "", body: "{{sepHead}}\n{{title}}\n{{sepTitleQ}}\n👀 问题\n{{question}}\n💡 回复\n{{answer}}\n{{sepReplyFooter}}{{footer}}\n{{sepTail}}" }
		};
		const TPL_LIMITS_FALLBACK = { title: 300, body: 4000, name: 64, emoji: 16 };
		const TPL_DEFAULTS_FALLBACK = [
			{ id: "bark-default", name: "Bark 默认", emoji: "", title: "{{titleFull}}", body: "{{body}}", builtin: true },
			{ id: "synology-default", name: "群晖 默认", emoji: "", title: "", body: "{{body}}", builtin: true }
		];
		/** 类型 → [emoji, status] 兜底（服务端 tplMeta.typeStatus 未回时用）。 */
		const TYPE_STATUS_FALLBACK = {
			"task.done": ["✅", "任务完成"], "task.asking": ["⁉️", "需要你回应"], "task.interrupted": ["❌", "回合被中断"],
			"subagent.done": ["🤖", "子 agent 完成"], "test": ["🔔", "测试推送"], "cost.alert": ["💰", "费用提醒"],
			"queue.dispatched": ["⛰", "队列派发"], "queue.cancelled": ["⛰", "队列取消"], "queue.failed": ["⛰", "队列失败"],
			"auth.login_failed": ["🔒", "登录失败"], "auth.locked": ["🔒", "触发锁定"], "auth.unlocked": ["🔓", "锁定期满"],
			"auth.new_device": ["✅", "新设备验证"], "auth.mfa_changed": ["🔐", "MFA 变更"], "auth.otp": ["🔢", "登录一次性码"]
		};
		const BARK_LEVELS_FALLBACK = [
			{ id: "active", label: "active（默认）" },
			{ id: "timeSensitive", label: "timeSensitive（时效性，穿透免打扰）" },
			{ id: "passive", label: "passive（静默）" },
			{ id: "critical", label: "critical（关键）" }
		];
		const BARK_LEVEL_LABEL = { active: "active", timeSensitive: "timeSensitive", passive: "passive", critical: "critical" };
		/** v0.9.0: Bark 通知图标默认值（与服务端 `DEFAULT_BARK_ICON` 同源）：DSH 大肥鱼。 */
		const DEFAULT_BARK_ICON_FALLBACK = "";
		function tplMetaOf(data) {
			var m = data && data.tplMeta && typeof data.tplMeta === "object" ? data.tplMeta : null;
			return {
				placeholders: (m && Array.isArray(m.placeholders) && m.placeholders.length) ? m.placeholders : TPL_PLACEHOLDERS_FALLBACK,
				examples: (m && m.examples && typeof m.examples === "object") ? m.examples : TPL_EXAMPLES_FALLBACK,
				limits: (m && m.limits && typeof m.limits === "object") ? m.limits : TPL_LIMITS_FALLBACK,
				barkLevels: (m && Array.isArray(m.barkLevels) && m.barkLevels.length) ? m.barkLevels : ["active", "timeSensitive", "passive", "critical"],
				defaultBarkIcon: (m && typeof m.defaultBarkIcon === "string" && m.defaultBarkIcon) ? m.defaultBarkIcon : DEFAULT_BARK_ICON_FALLBACK,
				defaultTemplates: (m && Array.isArray(m.defaultTemplates) && m.defaultTemplates.length) ? m.defaultTemplates : TPL_DEFAULTS_FALLBACK,
				typeStatus: (m && m.typeStatus && typeof m.typeStatus === "object") ? m.typeStatus : TYPE_STATUS_FALLBACK,
				unavailablePreview: (m && Array.isArray(m.unavailablePreview)) ? m.unavailablePreview : ["title","titleFull","body","session","sid","turn","elapsed","elapsedMs","reason","question","answer","summary","footer"]
			};
		}
		/** v0.9.1：模板库数组（服务端 `get.templates` 权威；旧 host/未加载 ⇒ 两条内置兜底）。 */
		function templatesOf(data) {
			var list = data && Array.isArray(data.templates) ? data.templates : [];
			if (!list.length) return TPL_DEFAULTS_FALLBACK.map(function (t) { return Object.assign({}, t, { usedBy: [] }); });
			return list.map(function (t) {
				return {
					id: String(t && t.id || ""), name: String(t && t.name || (t && t.id) || ""),
					emoji: String(t && t.emoji || ""),
					title: String(t && t.title || ""), body: String(t && t.body || ""),
					builtin: !!(t && t.builtin), usedBy: Array.isArray(t && t.usedBy) ? t.usedBy : []
				};
			}).filter(function (t) { return t.id; });
		}
		function sepUnescape(s) { return String(s).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\"); }
		function sepExpand(spec) {
			var t = String(spec == null ? "" : spec);
			var i = t.lastIndexOf("*");
			if (i <= 0) return { text: t };
			var body = sepUnescape(t.slice(0, i));
			var n = parseInt(t.slice(i + 1), 10);
			return { text: body.repeat(isFinite(n) ? Math.max(0, n) : 1) };
		}
		/** **与服务端 `parseSepNotation` 同口径**（仅用于即时预览；落盘值以服务端回包为权威）。 */
		function sepParse(raw, defSpec) {
			var def = sepExpand(defSpec);
			var raw0 = raw === undefined || raw === null ? null : String(raw);
			if (raw0 === null) return { spec: defSpec, text: def.text, note: null, configured: false };
			var t = raw0.trim();
			var bad = function (why) { return { spec: defSpec, text: def.text, note: why + " ⇒ 回退默认 " + defSpec + "，已按 " + defSpec + " 处理", configured: true }; };
			if (!t) return bad("配置为空");
			var i = t.lastIndexOf("*");
			if (i <= 0) return bad("记法不合语法（须写「字符或短串*次数」）");
			var body = sepUnescape(t.slice(0, i));
			var cntRaw = t.slice(i + 1).trim();
			if (!/^-?\d+$/.test(cntRaw)) return bad("次数非法（" + JSON.stringify(cntRaw) + "）");
			if (!body) return bad("字符部分为空");
			var cnt = parseInt(cntRaw, 10);
			var use = cnt, clipped = false, cut = false;
			if (cnt < SEP_COUNT_MIN) { use = SEP_COUNT_MIN; clipped = true; }
			else if (cnt > SEP_COUNT_MAX) { use = SEP_COUNT_MAX; clipped = true; }
			if (body.length > SEP_BODY_MAX) { body = body.slice(0, SEP_BODY_MAX); cut = true; }
			var spec = body + "*" + use;
			var note = null;
			if (clipped) note = "次数越界（" + cnt + " 不在 [" + SEP_COUNT_MIN + "," + SEP_COUNT_MAX + "]）⇒ 夹取到边界，已按 " + spec + " 处理";
			else if (cut) note = "字符部分超长（>" + SEP_BODY_MAX + "）⇒ 截断并报，已按 " + spec + " 处理";
			return { spec: spec, text: body.repeat(use), note: note, configured: true };
		}

		/** 空表单。 */
		function emptyForm() {
			return { name: "", kind: "bark", url: "" };
		}
		function kindLabel(kind) {
			return KIND_LABEL[kind] || String(kind || "");
		}
		/** hasProducer 缺失(旧 host) ⇒ 视为 true（不得因此丢进"预留"折叠区）。 */
		function hasProducerOf(ty) {
			return !(ty && ty.hasProducer === false);
		}
		function emojiOf(type) {
			return TYPE_EMOJI[type] || "";
		}

		// ---------- 三态 / 路由语义 (契约 §1 三步 + §5 三态推导, 纯函数便于校验) ----------
		/** 契约 §5: 键存在且非空 ⇒ custom; 键存在且为空数组 ⇒ off; 无键(或非数组) ⇒ default。 */
		function modeFromRoutes(routes, type) {
			if (!routes || !Object.prototype.hasOwnProperty.call(routes, type)) return "default";
			var v = routes[type];
			if (!Array.isArray(v)) return "default";
			return v.length ? "custom" : "off";
		}
		function enabledIdsOf(devices) {
			return (devices || []).filter(function (d) { return d && d.enabled !== false; }).map(function (d) { return d.id; });
		}
		function filterEnabled(ids, devices) {
			var en = enabledIdsOf(devices);
			return (ids || []).filter(function (id) { return en.indexOf(id) >= 0; });
		}
		/** 默认路由解析结果（为空 ⇒ 发全部启用设备）—— "关闭 → 自选"的起点用它(不得变空)。 */
		function defaultResolvedIds(routeDefault, devices) {
			var list = (routeDefault && routeDefault.length) ? routeDefault : enabledIdsOf(devices);
			return filterEnabled(list, devices);
		}
		/** 契约 §1 三步语义的本地副本 —— 仅用于 ① 服务端未回 effective ② 默认路由草稿已改动。 */
		function resolveIdsLocal(routes, routeDefault, devices, type) {
			if (routes && Object.prototype.hasOwnProperty.call(routes, type) && Array.isArray(routes[type])) {
				return filterEnabled(routes[type], devices);
			}
			return defaultResolvedIds(routeDefault, devices);
		}
		function deviceNameOf(devices, id) {
			var hit = (devices || []).filter(function (d) { return d && d.id === id; })[0];
			return hit ? (hit.name || hit.id) : id;
		}
		function deviceNamesOf(devices, ids) {
			if (!ids || !ids.length) return "无";
			return ids.map(function (id) { return deviceNameOf(devices, id); }).join(" + ");
		}
		/** 契约 §3 规整: 越界/非法 ⇒ 夹到 [0,3600000] 整数; 非布尔 ⇒ 默认 true。 */
		function normalizeOptions(raw) {
			var src = (raw && typeof raw === "object") ? raw : {};
			var ms = src.minTurnMs;
			if (typeof ms !== "number" || !isFinite(ms)) ms = DEFAULT_OPTIONS.minTurnMs;
			ms = Math.round(ms);
			if (ms < 0) ms = 0;
			if (ms > MIN_TURN_MS_MAX) ms = MIN_TURN_MS_MAX;
			return {
				minTurnMs: ms,
				bannerSummary: typeof src.bannerSummary === "boolean" ? src.bannerSummary : DEFAULT_OPTIONS.bannerSummary,
				reconcile: typeof src.reconcile === "boolean" ? src.reconcile : DEFAULT_OPTIONS.reconcile,
				// ★件G：5 键（越界夹取 / 非法回落默认；与服务端同口径）；★件J-乙：＋ `synologyConcurrency`（共 6 键）
				barkTimeoutMs: clampNum(src.barkTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULT_OPTIONS.barkTimeoutMs),
				barkRetries: clampNum(src.barkRetries, 0, RETRIES_MAX, DEFAULT_OPTIONS.barkRetries),
				barkConcurrency: clampNum(src.barkConcurrency, CONC_MIN, CONC_MAX, DEFAULT_OPTIONS.barkConcurrency),
				synologyTimeoutMs: clampNum(src.synologyTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULT_OPTIONS.synologyTimeoutMs),
				synologyRetries: clampNum(src.synologyRetries, 0, RETRIES_MAX, DEFAULT_OPTIONS.synologyRetries),
				synologyConcurrency: clampNum(src.synologyConcurrency, CONC_MIN, CONC_MAX, DEFAULT_OPTIONS.synologyConcurrency)
			};
		}
		/** ★件G：数值夹取（非 number/NaN ⇒ fallback；否则四舍五入并夹到 [lo,hi]） */
		function clampNum(v, lo, hi, fallback) {
			if (typeof v !== "number" || !isFinite(v)) return fallback;
			return Math.min(hi, Math.max(lo, Math.round(v)));
		}
		/** 阈值输入(秒) 解析: 0…3600 整数, 否则 null(调用方给错误文案)。 */
		function parseSeconds(text) {
			var s = String(text === undefined || text === null ? "" : text).trim();
			if (!/^[0-9]+$/.test(s)) return null;
			var n = parseInt(s, 10);
			if (!(n >= 0 && n <= MIN_SEC_MAX)) return null;
			return n;
		}
		/**
		 * 契约 §5 保存语义: routes 用**完整映射** —— custom 行给 ids、off 行给 []、default 行不给键。
		 * 未知 type 不下发（host 侧 setRoutes 对未知 type 返回 bad-request, 会把整次保存打挂）。
		 */
		function buildRoutesPayload(routesMap, known) {
			var out = {};
			Object.keys(routesMap || {}).forEach(function (t) {
				if (known && !known[t]) return;
				var v = routesMap[t];
				if (!Array.isArray(v)) return;
				out[t] = v.slice();
			});
			return out;
		}

		// ---------- 样式 (nt-* 家族 = 预览 public/preview-notify-settings.html 已确认; 零新增色相) ----------
var UI_V2_CSS = `/* ===== v0.9.3 布局整改（方案 A：四 Tab ＋ 抽屉；2026-11-23 用户确认） ===== */
.nt-root{position:relative;display:flex;flex-direction:column;gap:10px;container-type:inline-size;container-name:ntcard;overflow:hidden}
.nt-head{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2)}
.nt-head-r{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:6px;min-width:0;max-width:62%}
.nt-head-r .nt-hint{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nt-head-r .nt-st{white-space:nowrap}
.nt-tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
.nt-tabs::-webkit-scrollbar{display:none}
.nt-tab{appearance:none;border:0;background:transparent;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-tertiary);height:38px;padding:0 13px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;flex:none;display:inline-flex;align-items:center;gap:7px}
.nt-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary,#4176e6)}
.nt-tab .n{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent);border-radius:999px;padding:1px 6px;line-height:1.4}
.nt-tab[aria-selected="true"] .n{color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent)}
.nt-pane{display:flex;flex-direction:column;gap:12px;min-width:0}
.nt-pane[hidden]{display:none !important}
.nt-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nt-bar-r{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nt-h{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary)}
.nt-pill{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 12px;border-radius:999px;border:1px solid;font-size:12px;font-weight:600;line-height:1;white-space:nowrap}
.nt-pill .nt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.nt-pill-neutral{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.nt-pill-accent{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary))}
.nt-pill-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 15%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 52%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 58%,var(--dsw-alias-label-primary))}
.nt-badge{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-size:12px;font-weight:600;line-height:1;letter-spacing:0}
.nt-badge.nt-syn{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);color:var(--dsw-alias-label-secondary)}
.nt-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 9%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1;flex:none;letter-spacing:0}
.nt-effpill{display:inline-flex;align-items:center;height:auto;padding:0;border:0;background:transparent;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.nt-groups{display:flex;flex-direction:column;gap:14px}
.nt-group{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d}
.nt-group-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 5%,transparent)}
.nt-group-n{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.nt-tr{display:grid;grid-template-columns:minmax(180px,1.5fr) 84px minmax(100px,.9fr) 84px 58px minmax(178px,auto);align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-primary);min-width:0}
.nt-tr:last-child{border-bottom:0}
.nt-tr.nt-th{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.3px;padding:7px 14px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 4%,transparent)}
.nt-tr:not(.nt-th):hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 7%,transparent)}
.nt-tr[data-off="true"] .nt-name,.nt-tr[data-off="true"] .c-tpl{color:var(--dsw-alias-label-tertiary)}
.nt-tr-note{padding:0 14px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 4%,transparent)}
.c-name{display:flex;align-items:center;gap:7px;min-width:0}
.nt-sort{display:inline-flex;align-items:center;gap:1px;flex:none;cursor:grab;color:var(--dsw-alias-label-tertiary);opacity:.45}
.nt-tr:hover .nt-sort{opacity:1}
.nt-sort .nt-grip{font-size:11px;line-height:1}
.nt-ordbtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);width:18px;height:18px;line-height:1;border-radius:4px;font-size:10px;cursor:pointer;padding:0}
.nt-ordbtn:disabled{opacity:.35;cursor:default}
.nt-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nt-id{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);border:0;border-radius:5px;padding:1px 5px;flex:none}
.nt-pen{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:.4;padding:2px 3px;border-radius:5px;flex:none;line-height:1;font-size:12px}
.nt-tr:hover .nt-pen{opacity:1}
.nt-pen:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.rename-in{height:26px;min-width:0;flex:1;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 7px;outline:none}
.c-kind{justify-self:start}
.c-tpl{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-url{min-width:0}
.nt-tail{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 8%,transparent);border:0;border-radius:5px;padding:1px 5px}
.c-sw{justify-self:start}
.c-act{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.nt-btn-sm{height:28px;padding:0 10px;font-size:12px;border-radius:7px}
.nt-btn-icon{width:28px;padding:0;justify-content:center}
.nt-btn-primary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 60%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 72%,var(--dsw-alias-label-primary));font-weight:600}
.nt-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 20%,transparent)}
.nt-drawer-wrap{position:fixed;inset:0;z-index:60;pointer-events:none}
.nt-drawer-wrap[data-open="false"]{display:none}
.nt-drawer-wrap[data-open="true"]{pointer-events:auto}
.nt-drawer-mask{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);backdrop-filter:blur(6px) saturate(1.05);opacity:0;pointer-events:none;transition:opacity .18s ease}
.nt-drawer-wrap[data-open="true"] .nt-drawer-mask{opacity:1;pointer-events:auto}
.nt-drawer{position:absolute;top:0;right:0;bottom:0;width:min(400px,100%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-18px 0 48px #0000001f;transform:translateX(102%);transition:transform .2s ease;overflow:hidden}
.nt-drawer[data-open="true"]{transform:translateX(0)}
.nt-drawer-h{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.nt-drawer-h .nt-btn{margin-left:auto}
.nt-drawer-b{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:14px}
.nt-drawer-b .nt-edit{grid-template-columns:1fr;border-top:0;padding-top:0;margin-top:0}
.nt-drawer-b .nt-edit .nt-acts{display:none}
.nt-drawer-f{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.nt-drawer-f .nt-hint{margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nt-drawer-b .nt-pay-wrap{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:12px}
.nt-split{display:grid;grid-template-columns:236px minmax(0,1fr) 320px;gap:14px;align-items:start}
.nt-list{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d;display:flex;flex-direction:column}
.nt-list-h{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12.5px;font-weight:600}
.nt-list-h .nt-btn{margin-left:auto}
.nt-li{appearance:none;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;font:inherit;padding:9px 11px;cursor:pointer;display:grid;gap:5px;color:var(--dsw-alias-label-primary)}
.nt-li:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 7%,transparent)}
.nt-li[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 10%,transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary,#4176e6)}
.nt-li:disabled{opacity:.6;cursor:default}
.nt-li-t{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;min-width:0}
.nt-li-t .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nt-li-m{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.nt-list-foot{padding:8px 11px;border-top:1px solid var(--dsw-alias-border-l2)}
.nt-ed{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d;padding:13px;min-width:0}
.nt-ed-empty{display:grid;gap:6px;padding:26px 8px;text-align:center}
.nt-ed-empty-t{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.nt-split .nt-tpl{border:0;padding:0;background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none;border-left:0;border-radius:0}
.nt-pv{position:sticky;top:0;display:grid;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d;padding:12px;min-width:0}
.nt-pv-h{display:flex;align-items:center;gap:8px}
.nt-pv-h .nt-hint{margin-left:auto}
.nt-chk{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.nt-switchlist{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:4px 12px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 4%,transparent)}
.nt-switchrow{display:flex;align-items:center;gap:12px;padding:8px 0;cursor:pointer}
.nt-switchrow+.nt-switchrow{border-top:1px solid var(--dsw-alias-border-l1)}
.nt-switchrow-t{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.nt-switchrow-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nt-switchrow .nt-hint{font-size:11px}
.nt-chk input{width:14px;height:14px;accent-color:var(--dsw-alias-state-business-primary,#4176e6);flex:none;margin:0}
.nt-live{background:transparent;border:0;padding:0;backdrop-filter:none;-webkit-backdrop-filter:none}
.nt-live-bar{flex-wrap:wrap;gap:6px}
.nt-acc,.nt-details{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d;overflow:hidden;margin:0}
.nt-details>summary{cursor:pointer;list-style:none;padding:11px 13px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.nt-details>summary::-webkit-details-marker{display:none}
.nt-details[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l2)}
.nt-details .nt-fold-bd{padding:12px 13px}
.nt-acc>summary{cursor:pointer;list-style:none;padding:11px 13px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.nt-acc>summary::-webkit-details-marker{display:none}
.nt-acc>summary::before{content:"";width:0;height:0;border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;opacity:.5;flex:none;transition:transform .15s ease;transform-origin:35% 50%}
.nt-acc[open]>summary::before{transform:rotate(90deg)}
.nt-acc-b{padding:0 13px 13px;display:grid;gap:10px}
.nt-grp{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base);box-shadow:0 4px 14px #0000000d;margin-bottom:12px}
.nt-grp-h{padding:9px 14px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 5%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2)}
.nt-item{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0}
.nt-item:last-child{border-bottom:0}
.nt-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 6%,transparent)}
.nt-item .nt-t{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.nt-item .nt-rt-type{font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 8%,transparent);border:0;border-radius:5px;padding:1px 5px}
.nt-item .nt-chips{order:5;flex:1 0 100%}
.nt-item .nt-seg{order:3;margin-left:auto;border-radius:8px}
.nt-item .nt-seg button{height:28px;padding:0 10px;font-size:12px}
.nt-item .nt-eff{order:4;flex:1 0 100%;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.nt-item .nt-eff b{color:var(--dsw-alias-label-secondary);font-weight:600}
.nt-chip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.nt-chip[data-on="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-weight:600}
.nt-note{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 8%,transparent);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:8px 11px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.nt-dragmsg{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:6px 10px;font-size:11.5px}
@container ntcard (max-width:740px){
.nt-head{flex-direction:column;align-items:stretch;gap:0}
.nt-tabs{flex-wrap:wrap;overflow:visible}
.nt-head-r{max-width:none;justify-content:flex-end;padding:6px 0 8px}
.nt-head-r .nt-hint{display:none}
.nt-tr{grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;padding:11px 12px}
.nt-tr.nt-th{display:none}
.nt-tr .c-name{grid-column:1;grid-row:1}
.nt-tr .c-sw{grid-column:2;grid-row:1}
.nt-tr .c-kind{grid-row:2;grid-column:1}
.nt-tr .c-tpl{grid-row:2;grid-column:2;text-align:right;font-size:12px}
.nt-tr .c-url{grid-row:3;grid-column:1}
.nt-tr .c-act{grid-row:3;grid-column:2}
.nt-tr .nt-pen{opacity:1}
.nt-tr .nt-grip{display:none}
.nt-tr .c-name .nt-id{display:none}
.nt-split{grid-template-columns:1fr}
.nt-pv{position:static}
.nt-head{align-items:center}
.nt-head-r{padding-bottom:0}
}
@media (max-width:720px){
.nt-split{grid-template-columns:1fr}
.nt-pv{position:static}
.nt-tr{grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;padding:11px 12px}
.nt-tr.nt-th{display:none}
.nt-tr .c-name{grid-column:1;grid-row:1}
.nt-tr .c-sw{grid-column:2;grid-row:1}
.nt-tr .c-kind{grid-row:2;grid-column:1}
.nt-tr .c-tpl{grid-row:2;grid-column:2;text-align:right}
.nt-tr .c-url{grid-row:3;grid-column:1}
.nt-tr .c-act{grid-row:3;grid-column:2}
.nt-drawer{width:100%}
}`;

		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-nt-card-css")) return;
			// 2026-11-24（task-16）「当前配置与状态」只读区样式（窄屏横向滚动；不新增主题色）
			try {
				var stS = document.createElement("style");
				stS.id = "dsh-nt-status-css";
				stS.textContent = [
					".nt-status{display:flex;flex-direction:column;gap:10px;min-width:0}",
					".nt-status-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}",
					".nt-status-table{border-collapse:collapse;width:100%;font-size:11.5px;min-width:680px}",
					".nt-status-table th,.nt-status-table td{border-bottom:1px solid var(--dsw-alias-border-l2);padding:5px 8px;text-align:left;white-space:nowrap}",
					".nt-status-table th{color:var(--dsw-alias-label-tertiary);font-weight:600}",
					".nt-status-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:4px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
					".nt-status-meta code{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:10.5px;word-break:break-all;white-space:normal}",
					".nt-status-err{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
					"@media (max-width:720px){.nt-status-table{min-width:560px}}"
				].join("");
				(document.head || document.documentElement).appendChild(stS);
			} catch (e) { /* 样式失败不影响功能 */ }
			var st = document.createElement("style");
			st.id = "dsh-nt-card-css";
			st.textContent = [
				// 卡自带主题色 (契约 §3.1/§3.2): **本卡显式声明**, 不走容器按 key 哈希分配 —— notify = business 蓝。
				// 胶囊外壳(border/圆角/背景/外层 padding)与整卡折叠已由容器 dsh-quick-insert 提供(契约 §5.1/§5.3)。
				".dsh-lp-card[data-lp-key=\"notify\"]{--lp-accent:#4176e6}",
				// ★件F／F2 修复：卡壳强调色**深色变体**（原为硬编码、无 dark 变体 ⇒ 深色下卡壳左条/边框/卡面混色仍深蓝，
				//   与 business 语义深色值 `#679efe` 不一致）。取值出处：宿主主题 `--dsw-static-deepseek-400` = `#679efe`。
				"body[data-ds-dark-theme] .dsh-lp-card[data-lp-key=\"notify\"]{--lp-accent:#679efe}",
				// 卡内**分组级**折叠保留(预留类型 / 高级): 取值 1:1 同款折叠家族, 前缀化为 .nt-details/.nt-arr
				".nt-details{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px}",
				".nt-details[open]{padding-bottom:2px}",
				".nt-details summary{cursor:pointer;display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;user-select:none;padding:2px 0;list-style:none}",
				".nt-details summary::-webkit-details-marker{display:none}",
				".nt-details summary:hover{color:var(--dsw-alias-label-primary)}",
				".nt-arr{font-size:9px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;flex:none}",
				".nt-details[open] summary .nt-arr{transform:rotate(90deg)}",
				".nt-badge{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-size:11px;font-weight:700;padding:0 10px;border-radius:999px;letter-spacing:.2px;line-height:19px;flex:none}",
				".nt-badge.nt-syn{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 55%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 62%,var(--dsw-alias-label-primary))}",
				".nt-note{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 10%,transparent);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:11.5px;line-height:1.75;color:var(--dsw-alias-label-secondary)}",
				".nt-note b{color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-note code,.nt-flabel code,.nt-rt-type,.nt-id,.nt-tail{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:10.5px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}",
				".nt-hint,.nt-hint *{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px}",
				".nt-hint.nt-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-sh{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600}",
				".nt-tag{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 50%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:700;padding:0 8px;border-radius:999px;line-height:17px;flex:none}",
				// 设备列表 (设备区本次不改)
				".nt-list{display:grid;grid-template-columns:1fr;gap:6px}",
				// ★件F（2026-10-05）：**渠道按大类型分组（bark→群晖）＋ 组内拖动排序**（用户裁定「拖动／仅同类型组内、不跨组」）
				".nt-group{display:grid;grid-template-columns:1fr;gap:6px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:7px 8px}",
				".nt-group[data-over=\"true\"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 7%,transparent)}",
				".nt-group[data-reject=\"true\"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent)}",
				".nt-grp-h2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;font-weight:700;color:var(--dsw-alias-label-tertiary)}",
				".nt-effpill{display:inline-flex;align-items:center;height:19px;padding:0 8px;border-radius:999px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
				".nt-grip{color:var(--dsw-alias-label-tertiary);cursor:grab;font-size:13px;line-height:1;user-select:none;flex:none}",
				// ★件G（2026-10-06 用户令「按照甲做」＋窄屏定案 B）：手机端排序按钮 ＋ 触屏三条治理
				//   ① ↑↓ 按钮（桌面 32×32；窄屏 ≥40×40；组首/组尾 disabled **不隐藏**）
				//   ② 行内**禁长按选字**（`code` 例外 ⇒ id/尾号/type 码仍可长按复制）
				//   ③ **不抢滚动**：不绑 touch 事件；按钮 `touch-action:manipulation`、仅 click 触发
				".nt-ord{display:inline-flex;gap:4px;flex:none}",
				".nt-ordbtn{min-width:32px;height:32px;padding:0 6px;line-height:1;font-size:14px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}",
				".nt-row{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}",
				".nt-row code{user-select:text;-webkit-user-select:text}",
				// 窄屏（≤460px）＝ **方案 B**：允许换行、操作全在、把手隐藏（桌面拖拽不受影响）
				// ★件H（用户裁「乙」）：**只命中排序按钮与文字按钮** —— 删掉原全量 `.nt-acts button`（它会反噬开关/段控）；
				//   开关**显式兜住原胶囊 44×24**（用 `.nt-acts .nt-switch` 两级形式：危险规则 `.nt-acts button` 是 (0,1,1)，
				//   而基础 `.nt-switch`/`.nt-btn` 在**本媒体块之后**声明 ⇒ 同特异性的窄屏规则会被压掉，实测 `.nt-btn{height:32px}` 曾失效为 26）；
				//   ↑↓ **等比缩小到 24×24**（＝桌面 32 的 75%，与胶囊等高）；
				//   热区用 `::after` **居中定尺 40×40**（**不得用 `inset`**：UA 按钮边框 2px ⇒ 包含块是内边距盒，只得到 36×36）；
				//   `.nt-ord` gap 4→18 给热区让位（两热区间留 2px 死区）；操作按钮按裁定＝**32**。全部在媒体查询内 ⇒ 桌面逐字不变。
				"@media (max-width:460px){.nt-grip{display:none}.nt-list{min-width:0}.nt-row{flex-wrap:wrap;min-width:0;max-width:100%}.nt-name{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nt-ord{order:-1;gap:18px}.nt-ordbtn{width:24px;height:24px;min-width:24px;padding:0;font-size:12px;line-height:1;box-sizing:border-box;position:relative;touch-action:manipulation}.nt-ordbtn::after{content:\"\";position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px}.nt-acts .nt-btn{height:32px;line-height:30px}.nt-acts .nt-switch{width:44px;height:24px;border-radius:999px}}",
				// 触屏设备（无 hover / 粗指针）＝ 把手隐藏（HTML5 拖拽在触屏不着火；排序走 ↑↓）
				"@media (hover:none) and (pointer:coarse){.nt-grip{display:none}}",
				".nt-row[dragging=\"true\"]{opacity:.45;border-style:dashed}",
				".nt-dragmsg{font-size:11px;color:var(--dsw-alias-state-error-primary,#ec1313);border:1px dashed color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);border-radius:8px;padding:5px 9px}",
				// ★件F：其余段落**默认收起**（渠道区默认展开）
				".nt-fold{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
				".nt-fold>summary{cursor:pointer;list-style:none;padding:7px 10px;font-size:12.5px;font-weight:600}",
				".nt-fold>summary::-webkit-details-marker{display:none}",
				".nt-fold>summary::before{content:\"▸\";display:inline-block;width:14px;color:var(--dsw-alias-label-tertiary)}",
				".nt-fold[open]>summary::before{content:\"▾\"}",
				".nt-fold-bd{padding:0 10px 10px}",
				".nt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".nt-row[data-off=\"true\"]{opacity:.62}",
				".nt-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}",
				".nt-id{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".nt-tail{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".nt-acts{margin-left:auto;display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
				".nt-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;height:26px;font:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap;flex:none}",
				".nt-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-btn:disabled{opacity:.45;cursor:default}",
				".nt-btn-solid{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-btn-solid:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent)}",
				".nt-btn-danger{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 42%,transparent)}",
				".nt-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 42%,transparent)}",
				".nt-result{flex-basis:100%;font-size:11px;line-height:16px}",
				".nt-result.ok{color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-result.err{color:var(--dsw-alias-state-error-primary,#ec1313)}",
				".nt-result.pending{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				// 启用开关 (44×24, 同设置卡先例)
				".nt-switch{box-sizing:border-box;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 28%,transparent);cursor:pointer;padding:2px;transition:background .15s,border-color .15s}",
				".nt-switch::after{content:\"\";display:block;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
				".nt-switch[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
				".nt-switch[data-on=\"true\"]::after{transform:translateX(20px)}",
				// 行内编辑 / 添加表单 (设备区本次不改)
				".nt-edit,.nt-add{flex-basis:100%;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;align-items:end;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px;margin-top:3px}",
				".nt-add{border-top:none;padding-top:0}",
				".nt-field{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".nt-flabel{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
				".nt-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;min-width:0;height:30px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 9px;font-size:12.5px;line-height:22px}",
				".nt-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);outline:none}",
				".nt-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
				".nt-edit .nt-acts,.nt-add .nt-acts{margin-left:0;grid-column:1/-1}",
				// 通知项目分组 + 行 (契约 §5; 取值 1:1 预览 .nt-grp/.nt-grp-h/.nt-item/.nt-t/.nt-eff)
				".nt-grp{display:flex;flex-direction:column;gap:6px}",
				".nt-grp-h{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:700;letter-spacing:.4px}",
				".nt-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".nt-item[data-mode=\"off\"]{border-style:dashed;opacity:.86}",
				".nt-item[data-mode=\"default\"]{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 6%,transparent)}",
				".nt-t{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;flex:none}",
				".nt-eff{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".nt-eff b{color:var(--dsw-alias-label-secondary);font-weight:600}",
				".nt-rt-type{color:var(--dsw-alias-label-primary);flex:none}",
				// 三态分段控件「默认｜自选｜关闭」
				".nt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;overflow:hidden;flex:none;margin-left:auto}",
				".nt-seg button{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;height:28px;padding:0 12px;cursor:pointer}",
				".nt-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}",
				".nt-seg button:hover:not([data-on=\"true\"]){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-seg button[data-on=\"true\"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-weight:700}",
				".nt-seg button[data-on=\"true\"][data-v=\"off\"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-seg button:disabled{opacity:.55;cursor:default}",
				// ★ 件B（`#A449`）：设备行**下面**的「载荷（分隔符）」行（自有 nt-pay- 前缀）
				".nt-devwrap{display:flex;flex-direction:column;gap:6px;min-width:0}",
				".nt-pay{flex-basis:100%;display:flex;flex-direction:column;gap:6px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent)}",
				".nt-pay-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".nt-pay-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:9px 14px;margin-top:4px}",
				".nt-pay-item{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".nt-segline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;margin:6px 0 4px}",
				".nt-segline .nt-acts{margin-left:auto}",
				".nt-seglock{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 0 2px 9px;opacity:.55}",
				".nt-seglock .nt-switch{cursor:not-allowed}",
				".nt-pay-pos{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px}",
				".nt-pay-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-pay-note.ok{color:var(--dsw-alias-label-tertiary)}",
				".nt-pay-eff{flex:1 1 auto;min-width:0}",
				// 设备胶囊
				".nt-chips{display:flex;gap:5px;flex-wrap:wrap;align-items:center}",
				".nt-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 35%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;font-family:inherit;cursor:pointer;user-select:none;flex:none}",
				".nt-chip:hover:not(:disabled):not([data-inherit=\"true\"]){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-chip .nt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:none}",
				".nt-chip[data-on=\"true\"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 68%,var(--dsw-alias-label-primary));font-weight:700}",
				".nt-chip[data-on=\"true\"] .nt-dot{opacity:1}",
				// default 态: 虚线只读(继承默认路由); off 态: 整行虚线弱化 + 胶囊一起弱化; 停用设备: 不可点
				".nt-chip[data-inherit=\"true\"]{border-style:dashed;cursor:default}",
				".nt-chip[data-inherit=\"true\"][data-on=\"true\"]{border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary);font-weight:600}",
				".nt-chip[data-inherit=\"true\"][data-on=\"true\"] .nt-dot{opacity:1}",
				".nt-item[data-mode=\"off\"] .nt-chip{opacity:.5}",
				".nt-chip[data-dead=\"true\"]{border-style:dashed;opacity:.5}",
				// 触发条件区 (options)
				".nt-opts{display:grid;grid-template-columns:1fr;gap:7px}",
				".nt-opt{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}",
				".nt-opt .nt-input{width:76px}",
				// ★件I：全局参数（每组 **3** 个数字输入框 —— ★件J-乙 起群晖组亦为 3；沿用本家族 token，禁纯白/禁跨插件色板）
				".nt-optgroup{display:flex;flex-direction:column;gap:6px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
				".nt-optgroup>.nt-opts{grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:7px 14px}",
				".nt-optgroup-h{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
				".nt-optgroup .nt-opt .nt-input{width:88px}",
				".nt-cb{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary,#4176e6);flex:none}",
				// 徽标 / 保存状态
				".nt-mark{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:10.5px;line-height:1;flex:none;white-space:nowrap}",
				".nt-mark.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-mark.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-status{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".nt-st{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:11.5px;line-height:1;border:1px solid transparent;flex:none}",
				".nt-st.saving{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-st.saved{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-st.failed{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 45%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}",
				// ★ 2026-10-02（`#A432` 件B）：保存态「点串」—— **自有 `nt-save-` 前缀，零官方类名/内部 DOM/内部字段**；
				//   节奏 ＝ **每 500ms 前进一个点**（三 span ＋ `1.5s steps(1,end)` 循环；仅"视觉模仿"官方"连接中"的节奏）；
				//   `prefers-reduced-motion` ⇒ 关动画（点全亮，不闪烁）。
				".nt-save-cap{font-variant-numeric:tabular-nums}",
				".nt-save-dots{display:inline-grid;grid-template-columns:repeat(3,max-content);gap:4px;align-items:center;margin-left:1px}",
				".nt-save-dot{width:4px;height:4px;border-radius:999px;background:currentColor;opacity:.22}",
				".nt-save-dot-a{opacity:1}",
				".nt-save-dot-b{animation:nt-save-dot-b 1.5s steps(1,end) infinite}",
				".nt-save-dot-c{animation:nt-save-dot-c 1.5s steps(1,end) infinite}",
				"@keyframes nt-save-dot-b{0%,33.32%{opacity:.22}33.33%,100%{opacity:1}}",
				"@keyframes nt-save-dot-c{0%,66.65%{opacity:.22}66.66%,100%{opacity:1}}",
				"@media (prefers-reduced-motion:reduce){.nt-save-dot-b,.nt-save-dot-c{animation:none;opacity:1}}",
				".nt-err{color:var(--dsw-alias-state-error-primary,#ec1313);font-size:10.5px;line-height:14px}",
				// v0.9.0: 左栏「通知」页 + 模板/渠道参数（同一 nt-* 家族；颜色仅用既有语义 token）
				".nt-page{height:100%;overflow:auto;box-sizing:border-box;padding:18px 22px;background:transparent}",
				".nt-page-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:12px;max-width:1100px;margin-left:auto;margin-right:auto}",
				".nt-page-ico{font-size:20px;line-height:1}",
				".nt-page-title{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary)}",
				".nt-page-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
				".nt-page-stat{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
				".nt-page-body{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:9px}",
				".nt-live-bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:9px 11px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}",
				".nt-live{display:flex;flex-direction:column;gap:8px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);backdrop-filter:blur(10px) saturate(1.15);-webkit-backdrop-filter:blur(10px) saturate(1.15)}",
				".nt-live-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".nt-live-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
				".nt-live-box{display:flex;flex-direction:column;gap:5px;min-width:0}",
				".nt-live-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);line-height:18px}",
				".nt-live-pre{max-height:200px;line-height:1.65;font-size:12px;margin:0}",
				".nt-live-note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);border-top:1px dashed var(--dsw-alias-border-l2);padding-top:7px}",
				"@media (max-width:720px){.nt-live-grid{grid-template-columns:1fr}}",
				".nt-ph{display:flex;flex-direction:column;gap:8px}",
				".nt-ph-toggle{align-self:flex-start}",
				".nt-ph-panel{display:flex;flex-direction:column;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:11px 12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 52%,transparent);backdrop-filter:blur(12px) saturate(1.15);-webkit-backdrop-filter:blur(12px) saturate(1.15)}",
				".nt-ph-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".nt-ph-search{flex:1 1 220px;min-width:0;height:30px}",
				".nt-ph-cats{display:flex;gap:6px;overflow-x:auto;padding-bottom:3px}",
				".nt-ph-cat{flex:none;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}",
				".nt-ph-cat[data-on=\"true\"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 18%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 72%,var(--dsw-alias-label-primary));font-weight:700}",
				".nt-ph-list{display:grid;grid-template-columns:1fr;gap:6px;max-height:300px;overflow:auto}",
				".nt-ph-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;text-align:left;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 38%,transparent);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;min-height:48px}",
				".nt-ph-row:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 65%,transparent)}",
				".nt-ph-key{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 72%,var(--dsw-alias-label-primary));white-space:nowrap}",
				".nt-ph-label{font-size:12.5px;color:var(--dsw-alias-label-primary);align-self:center;font-weight:600}",
				".nt-ph-desc{grid-column:1/-1;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}",
				".nt-ph-msg{color:var(--dsw-alias-state-success-primary,#22c55e)}",
				"@media (max-width:520px){.nt-ph-panel{padding:6px}.nt-ph-list{max-height:46vh}.nt-ph-search{flex:1 1 100%}}",
				".nt-tpl{flex-basis:100%;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 50%,transparent);padding:11px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 30%,transparent);backdrop-filter:blur(10px) saturate(1.15);-webkit-backdrop-filter:blur(10px) saturate(1.15)}",
				".nt-tpl-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".nt-tpl-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}",
				".nt-tpl-grid .nt-field{display:flex}",
				".nt-tpl-ta{box-sizing:border-box;width:100%;min-height:80px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-base) 58%,transparent);color:var(--dsw-alias-label-primary);border-radius:8px;padding:9px 10px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12px;line-height:1.65}",
				".nt-tpl-ta:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);outline:none}",
				".nt-tpl-chips{display:flex;gap:4px;flex-wrap:wrap;align-items:center}",
				".nt-tpl-chip{height:22px;padding:0 8px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap}",
				".nt-tpl-chip:hover:not(:disabled){border-style:solid;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6)}",
				".nt-tpl-prev{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:11px;line-height:1.55;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;margin:0;max-height:240px;overflow:auto;color:var(--dsw-alias-label-primary)}",
				".nt-kindtpl{display:flex;flex-direction:column;gap:9px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 42%,transparent);backdrop-filter:blur(10px) saturate(1.15);-webkit-backdrop-filter:blur(10px) saturate(1.15)}",
				".nt-kindtpl-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
				".nt-defs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:7px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
				".nt-defs code{font-size:10.5px}",
				"@media (max-width:720px){.nt-tpl-grid{grid-template-columns:1fr}.nt-page{padding:12px}}",
				"@media (max-width:640px){.nt-edit,.nt-add{grid-template-columns:1fr}}"
			].join("\n") + UI_V2_CSS;
			(document.head || document.documentElement).appendChild(st);
		}

		// ---------- 控制器: /notify-hub RPC + snapshot store (仿「模型与密钥」卡) ----------
		/* ★`#A57`：通道面双路 —— 先打官方 Fetch 面 `/api/<channel>/<ep>`（0.2.2），
		   失败回落旧通道 `<channel>/<ep>`（0.1.2）；模式缓存 + 诊断锚（禁静默）。 */
		var _faceMode = null;
		function faceRpc(rpc, chName, endpoint, payload) {
			var callApi = function () { return rpc.call("/api", chName + "/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call("/" + chName, endpoint, payload || {}); };
			var p = _faceMode === "api" ? callApi()
				: _faceMode === "legacy" ? callLegacy()
				: callApi().then(function (r) { _faceMode = "api"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { [chName]: "api" }); } catch (e) {} return r; },
					function () { _faceMode = "legacy"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { [chName]: "legacy" }); } catch (e) {} return callLegacy(); });
			return Promise.resolve(p);
		}

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, data: null, error: "" });
			var lastValue = null;
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, CHANNEL.replace(/^\//, ""), endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(value) {
				lastValue = value;
				store.set({ status: "ready", loaded: true, data: value, error: "" });
				return value;
			}
			function fail(message) {
				store.set({ status: "error", loaded: lastValue !== null, data: lastValue, error: message || "读取失败" });
			}
			/** get: 卡加载即拉取 (服务端为权威源; 只回 urlTail, 无明文; 回 types/effective/options)。 */
			function refresh() {
				return call("get", {}).then(function (res) {
					var value = res && res.ok ? res.value : null;
					if (value && typeof value === "object") { publish(value); return value; }
					fail(res && res.error && res.error.message);
					return null;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				/** payload: { id?, name, kind, url?, enabled? } —— url 缺省/空串 = 保留原 url (§4)。 */
				saveDevice: function (payload) {
					return call("saveDevice", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				deleteDevice: function (id) {
					return call("deleteDevice", { id: id }).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/**
				 * ★件F（2026-10-05，用户令「可以 order也加 签卡吧」）：**渠道排序**（**仅同类型组内**，不跨组）。
				 * payload: `{ kind, ids }` —— `ids` 必须是**该 kind 组现有设备的全集**的一个不重复排列；
				 * 服务端非法输入一律 `bad-request` 且盘上逐字不变（**不静默**）。
				 */
				reorderDevices: function (payload) {
					return call("reorderDevices", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** payload: { routeDefault?, routes? } —— routes 为完整映射: custom ⇒ ids, off ⇒ [] (显式零请求)。 */
				setRoutes: function (payload) {
					return call("setRoutes", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/**
				 * payload: { minTurnMs?, bannerSummary?, reconcile? } —— 契约 §4 新增端点。
				 * 旧 host 无此端点 ⇒ 返回 { ok:false }, 调用方按"只提示不判整次失败"降级(契约 §5 补充 ③)。
				 */
				setOptions: function (payload) {
					return call("setOptions", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** 只打被点的那一台; value = { id, status:"ok"|"fail", error? }。 */
				test: function (id) {
					return call("test", { id: id });
				},
				/** v0.9.1: 模板库新增/编辑 `{id?, name, title?, body?}`。 */
				saveTemplate: function (payload) {
					return call("saveTemplate", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** v0.9.1: 删除模板 `{id}`（内置不可删；仍被设备使用 ⇒ 服务端拒绝）。 */
				deleteTemplate: function (payload) {
					return call("deleteTemplate", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** v0.9.0 兼容别名：按 kind 编辑内置默认模板。 */
				setTemplates: function (payload) {
					return call("setTemplates", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** v0.9.0: 模板预览（零网络/零写盘）。payload `{deviceId?,kind?,type?,...}`。 */
				preview: function (payload) {
					return call("preview", payload || {});
				}
			};
		}

		// ---------- v0.9.3：占位符选择器（分组 + 搜索 + 始终可见说明，触屏友好） ----------
		const PH_GROUPS = [
			{ id: "common", label: "常用" },
			{ id: "basic", label: "标题与状态" },
			{ id: "content", label: "内容" },
			{ id: "context", label: "时间 / 设备" },
			{ id: "sep", label: "分隔符" },
			{ id: "all", label: "全部" }
		];
		function phGroupOf(key) {
			if (key.indexOf("sep") === 0) return "sep";
			if (["question", "answer", "summary", "footer", "body"].indexOf(key) >= 0) return "content";
			if (["time", "date", "iso", "type", "typeLabel", "group", "level", "device", "deviceName", "kind"].indexOf(key) >= 0) return "context";
			return "basic";
		}
		const PH_COMMON_KEYS = ["title", "titleFull", "emoji", "status", "answer", "body", "time", "deviceName"];
		function normalizePhList(list) {
			return (Array.isArray(list) ? list : []).map(function (p) {
				return {
					key: String(p.key || ""), label: String(p.label || p.key || ""), desc: String(p.desc || ""),
					group: p.group || phGroupOf(String(p.key || "")),
					common: p.common !== undefined ? !!p.common : PH_COMMON_KEYS.indexOf(String(p.key || "")) >= 0
				};
			}).filter(function (p) { return p.key; });
		}
		function PlaceholderPicker(props) {
			var h = react.createElement;
			var placeholders = normalizePhList(props.placeholders);
			var [open, setOpen] = react.useState(false);
			var [search, setSearch] = react.useState("");
			var [group, setGroup] = react.useState("common");
			var [target, setTarget] = react.useState("body");
			var [msg, setMsg] = react.useState("");
			var q = search.trim().toLowerCase();
			var rows = placeholders.filter(function (p) {
				if (group === "common" && !p.common) return false;
				if (group !== "all" && group !== "common" && p.group !== group) return false;
				if (!q) return true;
				return (p.key + " " + p.label + " " + p.desc).toLowerCase().indexOf(q) >= 0;
			});
			function insert(p) {
				if (typeof props.onInsert === "function") props.onInsert(p.key, target);
				setMsg("已插入 {{" + p.key + "}} 到「" + (target === "title" ? "标题" : "正文") + "」");
			}
			return h("div", { className: "nt-ph", "data-ph-picker": "1" }, [
				h("button", {
					type: "button", className: "nt-btn nt-ph-toggle", "data-ph-toggle": "1", "aria-expanded": open ? "true" : "false",
					disabled: props.busy, onClick: function () { setOpen(!open); setMsg(""); }
				}, (open ? "▾ " : "＋ ") + "插入占位符（" + placeholders.length + " 个）"),
				open ? h("div", { className: "nt-ph-panel", "data-ph-open": "1" }, [
					h("div", { className: "nt-ph-top", key: "top" }, [
						h("input", {
							className: "nt-input nt-ph-search", "data-ph-search": "1", value: search, placeholder: "搜索占位符 / 中文说明",
							onChange: function (e) { setSearch(e.target.value); }
						}),
						h("span", { className: "nt-hint" }, "插入到"),
						h("span", { className: "nt-seg", "data-ph-target": target }, [
							h("button", { type: "button", key: "body", "data-v": "body", "data-on": target === "body" ? "true" : "false", onClick: function () { setTarget("body"); } }, "正文"),
							h("button", { type: "button", key: "title", "data-v": "title", "data-on": target === "title" ? "true" : "false", onClick: function () { setTarget("title"); } }, "标题")
						]),
						h("button", { type: "button", className: "nt-btn", "data-ph-close": "1", onClick: function () { setOpen(false); } }, "完成")
					]),
					h("div", { className: "nt-ph-cats", key: "cats" }, PH_GROUPS.map(function (g) {
						return h("button", {
							type: "button", key: g.id, className: "nt-ph-cat", "data-ph-group": g.id,
							"data-on": group === g.id ? "true" : "false", onClick: function () { setGroup(g.id); }
						}, g.label);
					})),
					h("div", { className: "nt-ph-list", key: "list", "data-ph-list": "1" }, rows.length ? rows.map(function (p) {
						return h("button", {
							type: "button", key: p.key, className: "nt-ph-row", "data-ph-key": p.key,
							title: "", onClick: function () { insert(p); }
						}, [
							h("code", { className: "nt-ph-key", key: "k" }, "{{" + p.key + "}}"),
							h("span", { className: "nt-ph-label", key: "l" }, p.label),
							h("span", { className: "nt-ph-desc", key: "d" }, p.desc || "（无说明）")
						]);
					}) : h("div", { className: "nt-hint" }, "没有匹配的占位符")),
					msg ? h("div", { className: "nt-hint nt-ph-msg", key: "msg", "data-ph-msg": "1" }, msg) : null
				]) : null
			]);
		}

		// ---------- 「通知（Bark / 群晖）」设置卡 ----------
		function NotifyCard(props) {
			var state = props.useNotifyHub(function (s) { return s; });
			var h = react.createElement;
			var data = state && state.data;
			var loaded = !!(state && state.loaded);
			var devices = data && Array.isArray(data.devices) ? data.devices : [];
			var types = data && Array.isArray(data.types) && data.types.length ? data.types : TYPES_FALLBACK;
			var enabledCount = devices.filter(function (d) { return d && d.enabled !== false; }).length;
			var serverRoutes = (data && data.routes && typeof data.routes === "object") ? data.routes : {};
			var serverDefault = (data && Array.isArray(data.routeDefault)) ? data.routeDefault : [];
			var serverEffective = (data && data.effective && typeof data.effective === "object") ? data.effective : {};
			var serverOptions = normalizeOptions(data && data.options);
			// 旧 host 探测(契约 §5 补充): 新 host 的 get 必回 options ⇒ 缺失 = host 侧插件未更新
			var staleHost = !(data && data.options && typeof data.options === "object");
			// ★件B: 分隔符元数据（**服务端为准**；旧 host 未回 ⇒ 用与真源逐字一致的兜底表）
			var sepMeta = (data && Array.isArray(data.sepMeta) && data.sepMeta.length) ? data.sepMeta : SEP_META_FALLBACK;
			// ★件C: 内容段元数据（同样服务端为准；旧 host 未回 ⇒ 用与真源逐字一致的兜底表）
			var segMeta = (data && Array.isArray(data.segMeta) && data.segMeta.length) ? data.segMeta : SEG_META_FALLBACK;
			// v0.9.0: 模板/渠道参数元数据（服务端 `tplMeta` 为准；旧 host 未回 ⇒ 兜底）
			var tplMeta = tplMetaOf(data);
			var serverTemplates = templatesOf(data);
			var defaultsView = (data && data.defaults && typeof data.defaults === "object") ? data.defaults : null;

			var [editing, setEditing] = react.useState(null);          // { id, form } —— 行内编辑
			var [addForm, setAddForm] = react.useState(emptyForm());   // 添加设备表单
			// v0.9.3（2026-11-23，用户确认方案 A）：顶部四 Tab ＋ 右侧抽屉；改名走行内
			var [tab, setTab] = react.useState("channels");            // channels | templates | routes | advanced
			var [addOpen, setAddOpen] = react.useState(false);         // 抽屉：新增态
			var [renameId, setRenameId] = react.useState(null);        // 行内改名中的设备 id
			var renameRef = react.useRef(null);                        // 改名输入节点
			var renameCancelRef = react.useRef(false);                 // Esc 取消 ⇒ blur 守卫（防"取消却提交"）
			// v0.9.3（2026-11-23，用户确认方案 A）：顶部四 Tab ＋ 右侧抽屉；改名走行内
			var [tab, setTab] = react.useState("channels");            // channels | templates | routes | advanced
			var [addOpen, setAddOpen] = react.useState(false);         // 抽屉：新增态
			var [renameId, setRenameId] = react.useState(null);        // 行内改名中的设备 id
			var renameRef = react.useRef(null);                        // 改名输入节点
			var renameCancelRef = react.useRef(false);                 // Esc 取消 ⇒ blur 守卫（防"取消却提交"）
			var [draftRoutes, setDraftRoutes] = react.useState({});    // 通知项目路由草稿 (routes 完整映射)
			var [draftDefault, setDraftDefault] = react.useState([]);  // 默认路由草稿
			var [draftSec, setDraftSec] = react.useState(String(Math.round(serverOptions.minTurnMs / 1000))); // 阈值(秒)草稿
			// ★T52（2026-10-08，`#A544` ③「甲′」）：阈值框也改为**离开输入框（blur）才提交**。
			//   与 5 键框**同构**（非受控 ＋ 键入期零 setState／零定时器／零 DOM 回写 ＋ 回读聚焦守卫），
			//   但 **`draftSec` 仍是 state** —— 因为它是 `curSnap`/`isDirty`/撤销按钮的**真值来源**，
			//   撤销语义（`#A413`）**一行不改**：`ref` 只在"键入期"承载文本，**提交点**才 `setDraftSec`。
			var secDraftRef = react.useRef(String(Math.round(serverOptions.minTurnMs / 1000))); // 键入中的文本（**永不据此渲染**）
			var secNodeRef = react.useRef(null);                      // 阈值 input 节点（回读时按需写回）
			var secFocusedRef = react.useRef(false);                  // 该框此刻是否聚焦（**回读不得覆盖正在输入的框**）
			var [draftBanner, setDraftBanner] = react.useState(serverOptions.bannerSummary);
			var [draftReconcile, setDraftReconcile] = react.useState(serverOptions.reconcile);
			var [staleOpts, setStaleOpts] = react.useState(false);     // setOptions 失败(旧 host) ⇒ 只提示不判失败
			// ★件J-甲（2026-10-07）：全局参数的**输入界面**（★件J-乙 起 6 键）—— **离开输入框（blur）才保存**。
			//   用户硬口径：「只要没离开这个输入框 就不要打断」⇒ 键入期 **零 setState／零定时器／零 DOM 回写**。
			var [optMsg5, setOptMsg5] = react.useState(null);         // { kind:"ok"|"clamp"|"err", text }
			var optDraft5 = react.useRef({});                         // key -> 输入中的文本（**只进 ref，永不据此渲染**）
			var optNodes5 = react.useRef({});                         // key -> input 节点（服务端回读时按需写回）
			var optFocus5 = react.useRef(null);                       // 当前聚焦的键（**服务端回读不得覆盖正在输入的框**）
			var [busy, setBusy] = react.useState(false);
			var [error, setError] = react.useState("");                // 卡的全局错误/负向反馈
			var [editErrs, setEditErrs] = react.useState({});        // 编辑表单字段错误
			var [addErrs, setAddErrs] = react.useState({});           // 添加表单字段错误
			var [tests, setTests] = react.useState({});                // id -> { pending } | { status, error }
			var [payDraft, setPayDraft] = react.useState({});          // ★件B: devId -> { mode:"default"|"custom", specs }
			var [payNotes, setPayNotes] = react.useState({});          // ★件B: devId -> [降级/结果说明]（就地可见，不静默）
			// v0.9.0: 设备级模板（{{占位符}}）草稿/预览/说明 + 渠道级默认模板草稿
			var [tplDraft, setTplDraft] = react.useState({});          // devId -> { title, body }
			var [tplNotes, setTplNotes] = react.useState({});          // devId -> [说明/降级]
			var [tplPrev, setTplPrev] = react.useState({});            // devId -> { pending } | { mode,title,body,pages,notes,error }
			var [tplExampleSel, setTplExampleSel] = react.useState({}); // devId -> "full"|"simple"
			var tplFocus = react.useRef({});                            // devId -> "title"|"body"（插入占位符的目标）
			var tplNodes = react.useRef({});                            // devId -> { title:node, body:node }
			// v0.9.1: 模板库编辑器（新增/编辑同一条表单）
			var [tplEdit, setTplEdit] = react.useState(null);          // null | { id?, name, title, body }
			var [tplEditNotes, setTplEditNotes] = react.useState([]);   // [说明/错误]
			var [tplEditPrev, setTplEditPrev] = react.useState(null);   // 编辑中的模板预览
			var [tplLibPrev, setTplLibPrev] = react.useState(null);     // 兼容旧服务端预览（新 UI 用实时预览）
			var [prevDeviceId, setPrevDeviceId] = react.useState("");   // 实时预览设备
			var [prevType, setPrevType] = react.useState("task.done");  // 实时预览通知类型
			var [prevSample, setPrevSample] = react.useState(true);     // 实时预览：用示例内容（标题/正文真实运行时为空）
			var tplEditFocus = react.useRef("body");                    // 插入占位符目标
			var tplEditNodes = react.useRef({});                        // { title:node, body:node }
			/** ★件F：拖拽提示行（跨组拖放被拒时如实提示；不改数据）。 */
			var [dragMsg, setDragMsg] = react.useState("");
			var [savedAt, setSavedAt] = react.useState(null);
			var [savedStale, setSavedStale] = react.useState(false);   // 本次"已保存"是否为降级提示文案
			var flashTimer = react.useRef(null);
			// ★ 即改即存 ＋ 一键撤销（`#A413` 件1；用户 2026-10-02 批「按你的推荐来」）
			var [baseline, setBaseline] = react.useState(null);   // **打开面板那一刻**的服务端快照（**内存**，不落 localStorage）；关闭即清
			var [armed, setArmed] = react.useState(false);        // 是否处于"本次打开"中（撤销可用性前置）
			var lastWritten = react.useRef(null);                 // 最近一次**写盘成功**的快照（＝推送判据；防"与 baseline 比对"造成写循环）
			/** ★T52（`#A544` ③(v)）：`armed` 的**同步镜像** —— 收起/卸载要**立即**失效（state 是异步的，
			 *  用它挡不住"收起后已排队的写"）；`writeSnap` 的 `armed` 校验读这个 ref。 */
			var armedRef = react.useRef(false);
			/** ★`#A547` (a) 二次（VM 实测 `after=1` ⇒ 一次去重不够）：**在飞快照签名** ——
			 *  `lastWritten` 只在"写成功"后才更新，而一次 `writeSnap` 是**两条 RPC 串行**，
			 *  窗口内第二条同快照调用会**双双通过**（`writing.current` 已提前清、`lastWritten` 还是旧值）。 */
			var inFlightSig = react.useRef(null);
			var cardRoot = react.useRef(null);                    // 卡内首个节点：用于 `closest("details")` 判定面板开/关
			var pushTimer = react.useRef(null);
			var writing = react.useRef(false);
			react.useEffect(function () {
				return function () { if (flashTimer.current) clearTimeout(flashTimer.current); };
			}, []);
			/** 服务端快照变化 → 重置草稿 (服务端为权威源; 「重新加载」也走这里)。 */
			react.useEffect(function () {
				if (!data) return;
				setDraftRoutes(serverRoutes);
				setDraftDefault(serverDefault);
				setDraftSec(String(Math.round(serverOptions.minTurnMs / 1000)));
				// ★T52：服务端快照为权威源 ⇒ **同步重置 `secDraftRef`**（但**不覆盖正在输入的框**：聚焦守卫见下）
				secDraftRef.current = String(Math.round(serverOptions.minTurnMs / 1000));
				setDraftBanner(serverOptions.bannerSummary);
				setDraftReconcile(serverOptions.reconcile);
				lastWritten.current = SNAP(serverRoutes, serverDefault, serverOptions.minTurnMs, serverOptions.bannerSummary, serverOptions.reconcile);
				setPayDraft({}); // ★件B: 载荷草稿随服务端快照复位（服务端为权威源；就地说明 payNotes 保留）
				// v0.9.1: 设备高级覆盖草稿随服务端快照复位（服务端为权威源）；模板库编辑器保留用户正在编辑的内容
				setTplDraft({});
				if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }
			}, [data]);

			function flashSaved(stale) {
				setSavedStale(!!stale);
				setSavedAt(Date.now());
				if (flashTimer.current) clearTimeout(flashTimer.current);
				// ★ 2026-10-02（`#A432` 件B，默认候选）：**已保存驻留 2s 后静默**（原 1800ms）
				flashTimer.current = setTimeout(function () { setSavedAt(null); }, 2000);
			}
			function errText(res, fallback) {
				return (res && res.error && res.error.message) || fallback;
			}
			/** 客户端即时校验 (服务端仍强制; 这里只为省一次往返)。 */
			function validate(form, requireUrl) {
				var errs = {};
				var name = String(form.name || "").trim();
				if (!name) errs.name = "名称不能为空";
				else if (name.length > 32) errs.name = "不能超过 32 个字符";
				var url = String(form.url || "").trim();
				if (url && !URL_RE.test(url)) errs.url = "必须以 http(s):// 开头";
				else if (!url && requireUrl) errs.url = "URL 不能为空";
				return errs;
			}

			/** v0.9.3：抽屉开关（编辑态 ＝ editing 非空；新增态 ＝ addOpen） */
			function openAdd(kind) {
				setError("");
				setEditing(null);
				setAddErrs({});
				setAddForm(Object.assign({}, emptyForm(), kind ? { kind: kind } : {}));
				setAddOpen(true);
			}
			function closeDrawer() {
				setEditing(null);
				setAddOpen(false);
				setEditErrs({});
				setAddErrs({});
			}
			/**
			 * v0.9.3：**行内改名**（v0.9.2 只能进编辑表单改；用户「设备名称要能自定义吧?」）。
			 * 服务端 `saveDevice` 对未传键是 additive 保留（url / enabled / 模板 / bark 参数 / 分隔符都不动）
			 * ⇒ 只发 id + kind + name 是安全的（已核 index.js:1252 起的合并逻辑）。
			 */
			function commitRename(dev, rawName) {
				var name = String(rawName == null ? "" : rawName).trim();
				setRenameId(null);
				if (!name || name === (dev.name || dev.id)) return;
				if (name.length > 32) { setError("设备名称不能超过 32 个字符（未改名）"); return; }
				setError("");
				setBusy(true);
				props.saveDevice({ id: dev.id, kind: dev.kind, name: name }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setError(""); flashSaved(false); }
					else setError(errText(res, "改名失败"));
				}, function () { setBusy(false); setError("改名失败（请求被拒/断链）"); });
			}
			/** v0.9.3：抽屉开关（编辑态 ＝ editing 非空；新增态 ＝ addOpen） */
			function openAdd(kind) {
				setError("");
				setEditing(null);
				setAddErrs({});
				setAddForm(Object.assign({}, emptyForm(), kind ? { kind: kind } : {}));
				setAddOpen(true);
			}
			function closeDrawer() {
				setEditing(null);
				setAddOpen(false);
				setEditErrs({});
				setAddErrs({});
			}
			/**
			 * v0.9.3：**行内改名**（v0.9.2 只能进编辑表单改；用户「设备名称要能自定义吧?」）。
			 * 服务端 `saveDevice` 对未传键是 additive 保留（url / enabled / 模板 / bark 参数 / 分隔符都不动）
			 * ⇒ 只发 id + kind + name 是安全的（已核 index.js:1252 起的合并逻辑）。
			 */
			function commitRename(dev, rawName) {
				var name = String(rawName == null ? "" : rawName).trim();
				setRenameId(null);
				if (!name || name === (dev.name || dev.id)) return;
				if (name.length > 32) { setError("设备名称不能超过 32 个字符（未改名）"); return; }
				setError("");
				setBusy(true);
				props.saveDevice({ id: dev.id, kind: dev.kind, name: name }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setError(""); flashSaved(false); }
					else setError(errText(res, "改名失败"));
				}, function () { setBusy(false); setError("改名失败（请求被拒/断链）"); });
			}
			function startEdit(dev) {
				setError("");
				setEditErrs({});
				var b = dev.bark || {};
				setEditing({ id: dev.id, form: {
					name: dev.name || dev.id, kind: dev.kind || "bark", url: "",
					// v0.9.1: 设备选择的模板（空 ⇒ 按渠道内置默认）
					templateId: (dev.tpl && dev.tpl.templateId) || "",
					// v0.9.0: Bark 渠道参数（默认空 ⇒ 按 type 冻结表；图标空 ⇒ 服务端默认 DSH 大肥鱼）
					barkGroup: b.group || "", barkLevel: b.level || "", barkSound: b.sound || "", barkIcon: b.icon || "",
					barkIsArchive: b.isArchive === 0 ? 0 : 1
				} });
			}
			function patchEdit(next) { setEditing(Object.assign({}, editing, { form: Object.assign({}, editing.form, next) })); }
			function submitEdit() {
				if (!editing) return;
				var errs = validate(editing.form, false);
				if (Object.keys(errs).length) { setEditErrs(errs); return; }
				setEditErrs({});
				setError("");
				setBusy(true);
				var payload = { id: editing.id, name: editing.form.name.trim(), kind: editing.form.kind };
				payload.templateId = String(editing.form.templateId || "");   // 空串 ⇒ 服务端删键（按渠道内置默认）
				var url = String(editing.form.url || "").trim();
				if (url) payload.url = url;            // 留空 = 不修改 (不下发 url 字段)
				if (editing.form.kind === "bark") {
					payload.barkGroup = String(editing.form.barkGroup || "").trim();
					payload.barkLevel = String(editing.form.barkLevel || "").trim();
					payload.barkSound = String(editing.form.barkSound || "").trim();
					payload.barkIcon = String(editing.form.barkIcon || "").trim();
					payload.barkIsArchive = editing.form.barkIsArchive === 0 ? 0 : 1;
				}
				props.saveDevice(payload).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setEditing(null); setError(""); flashSaved(false); }
					else setError(errText(res, "保存设备失败"));
				}, function () { setBusy(false); setError("保存设备失败"); });
			}
			function submitAdd() {
				var errs = validate(addForm, true);
				if (Object.keys(errs).length) { setAddErrs(errs); return; }
				setAddErrs({});
				setError("");
				setBusy(true);
				props.saveDevice({ name: addForm.name.trim(), kind: addForm.kind, url: String(addForm.url).trim() }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setAddForm(emptyForm()); setAddOpen(false); setError(""); flashSaved(false); }
					else setError(errText(res, "添加设备失败"));
				}, function () { setBusy(false); setError("添加设备失败"); });
			}
			function toggleDevice(dev) {
				setError("");
				setBusy(true);
				props.saveDevice({ id: dev.id, name: dev.name, kind: dev.kind, enabled: dev.enabled === false }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setError(""); flashSaved(false); }
					else setError(errText(res, "切换启用状态失败"));
				}, function () { setBusy(false); setError("切换启用状态失败"); });
			}
			function removeDevice(dev) {
				setError("");
				setBusy(true);
				props.deleteDevice(dev.id).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						if (editing && editing.id === dev.id) setEditing(null);
						// deleteDevice 同时从 routeDefault 与所有 routes 剔除该 id (服务端行为)
						setError("");
						flashSaved(false);
					} else setError(errText(res, "删除设备失败"));
				}, function () { setBusy(false); setError("删除设备失败"); });
			}
			function runTest(dev) {
				setError("");
				setTests(function (prev) { return Object.assign({}, prev, { [dev.id]: { pending: true } }); });
				props.test(dev.id).then(function (res) {
					// §4: value = { id, status: "ok"|"fail", error? }
					var v = res && res.ok && res.value ? res.value : null;
					var next = v
						? (v.status === "ok" ? { status: "ok" } : { status: "fail", error: v.error || "发送失败" })
						: { status: "fail", error: errText(res, "发送失败") };
					setTests(function (prev) { return Object.assign({}, prev, { [dev.id]: next }); });
				}, function (err) {
					setTests(function (prev) {
						return Object.assign({}, prev, { [dev.id]: { status: "fail", error: String((err && err.message) || err) } });
					});
				});
			}

			// ---- 通知项目 (契约 §5): 三态推导 = routes 键判定; 胶囊显示"实际发往谁" ----
			/** 行内胶囊显示的设备集: off ⇒ 空; custom ⇒ 草稿; default ⇒ 服务端 effective(权威)或本地回退解析。 */
			function rowEffIds(type, mode) {
				if (mode === "off") return [];
				if (mode === "custom") return filterEnabled(draftRoutes[type], devices);
				var defaultDirty = JSON.stringify(draftDefault) !== JSON.stringify(serverDefault);
				if (!defaultDirty && Array.isArray(serverEffective[type])) return filterEnabled(serverEffective[type], devices);
				return defaultResolvedIds(draftDefault, devices);
			}
			/** 分段控件: 切 custom ⇒ 以当前 effective 为起点(原为 off ⇒ 默认路由解析结果, 不得变空); off ⇒ []; default ⇒ 删键。 */
			function setRowMode(type, v) {
				setDraftRoutes(function (prev) {
					var mode = modeFromRoutes(prev, type);
					if (v === mode) return prev;
					var next = Object.assign({}, prev);
					if (v === "custom") {
						next[type] = (mode === "off" ? defaultResolvedIds(draftDefault, devices) : rowEffIds(type, "default")).slice();
					} else if (v === "off") {
						next[type] = [];
					} else {
						delete next[type];
					}
					return next;
				});
			}
			/** 默认态只读(胶囊 no-op); off 态不可点; 只有 custom 态可勾/去勾。 */
			function toggleRowChip(type, id) {
				setDraftRoutes(function (prev) {
					if (modeFromRoutes(prev, type) !== "custom") return prev;
					var arr = (prev[type] || []).slice();
					var i = arr.indexOf(id);
					if (i >= 0) arr.splice(i, 1); else arr.push(id);
					var next = Object.assign({}, prev);
					next[type] = arr;
					return next;
				});
			}
			function toggleDefault(id) {
				setDraftDefault(function (prev) {
					var arr = prev.slice();
					var i = arr.indexOf(id);
					if (i >= 0) arr.splice(i, 1); else arr.push(id);
					return arr;
				});
			}
			/* ================= ★ 即改即存 ＋ 一键撤销（`#A413` 件1） =================
			 * ① **改动即写**：**开关类立即**；**阈值框 ⇒ ★T52 起「离开输入框（blur）才提交」**（含"收起面板兜底提交"）
			 *   —— **不再是"键入停顿 600ms 防抖"**（旧写法会在打字中途写盘并 `busy` 夺焦）② 卡底「↩ 撤销本次改动」
			 *   ＝把**打开面板那一刻**的值写回（**本次打开以来全部改动一起还原**，不是"只撤最后一次"）
			 * ③ **关闭面板（卡体 `<details>` 收起）⇒ 丢弃 baseline** ⇒ 撤销失效 ④ `baseline` ＝ **内存**（**不新增 `localStorage` 键**）
			 * ⑤ **失败 ⇒ 显示值回滚到"写盘成功的值" ＋ 卡内红字点名原因**（`props.refresh()` 重拉真值 ⇒ 草稿随服务端快照重置，**不静默**）
			 * ⑥ **RPC 形状一字不改**（仍 `setRoutes` / `setOptions`）；**平铺态**（`.dsh-lp-flat`，容器无折叠）**无"关闭"语义**
			 *   ⇒ baseline 寿命 ＝ **组件挂载期**（如实，不假装有）。 */
			function SNAP(routes, def, minTurnMs, bannerSummary, reconcile) {
				return { routes: JSON.parse(JSON.stringify(routes || {})), def: (def || []).slice(), minTurnMs: minTurnMs, bannerSummary: !!bannerSummary, reconcile: !!reconcile };
			}
			function serverSnap() {
				return SNAP(serverRoutes, serverDefault, serverOptions.minTurnMs, serverOptions.bannerSummary, serverOptions.reconcile);
			}
			function curSnap() {
				var sec = parseSeconds(draftSec);
				return SNAP(draftRoutes, draftDefault, sec === null ? serverOptions.minTurnMs : sec * 1000, draftBanner, draftReconcile);
			}
			function sameSnap(x, y) { return !!x && !!y && JSON.stringify(x) === JSON.stringify(y); }
			function knownTypes() {
				var known = {};
				types.forEach(function (t) { if (t && t.type) known[t.type] = true; });
				return known;
			}
			function writeFail(msg) {
				writing.current = false;
				setSavedStale(false);
				setError(msg + " —— 已回滚为服务端现值");
				if (props.refresh) props.refresh();      // 重拉真值 ⇒ 草稿随服务端快照重置 ＝ 显示值回滚
			}
			/** 写一次（routes ＋ options；**两条 RPC 形状逐字未改**）。
			 *  ★T52（`#A544` ③(v)）：增 `armed` 校验 —— 「已收起/已卸载」时**不得再写盘**（丢弃已排队的自动写）。
			 *  `bypassArmed` **只给"收起兜底提交"用**：那一路是**先把 `armed` 置 false 再把最后一批草稿提交掉**
			 *  （顺序不可换：否则收起后 ≥1s 仍可能有迟到写 —— 正是本件要修的时序缺陷）。 */
			function writeSnap(sv, okMsg, bypassArmed) {
				if (!sv) return;
				if (!bypassArmed && !armedRef.current) return;   // 收起/卸载后 ⇒ 拒绝写（不静默、不报错、不写盘）
				if (writing.current) return;
				// ★`#A547` (a)：**同一快照不重复写**去重 —— `writing.current` 只防"同时在写"，
				//   防不住"前一次已回来、后一次又发同一份"（VM 真浏览器臂实测：收起兜底**直调**本函数
				//   ＋ 自动写 effect **排队** ⇒ 同一份 `26000` 被写两次，**迟到的第二条把用户"恢复 10000"的
				//   已接受写入盖掉** ＝ 数据正确性问题）。⇒ 与 `lastWritten` 逐字比对（同一序列化串即同快照）。
				var _sig = JSON.stringify(sv);
				if ((lastWritten.current && _sig === JSON.stringify(lastWritten.current))
					|| (inFlightSig.current && _sig === inFlightSig.current)) {
					if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }
					return;
				}
				inFlightSig.current = _sig;                                      // ★登记"在飞"（写毕清）
				writing.current = true;
				setBusy(true);
				var known = knownTypes();
				props.setRoutes({ routeDefault: sv.def.slice(), routes: buildRoutesPayload(sv.routes, known) }).then(function (res) {
					if (!(res && res.ok)) { writing.current = false; inFlightSig.current = null; setBusy(false); writeFail(errText(res, "保存路由失败")); return null; }
					return props.setOptions({ minTurnMs: sv.minTurnMs, bannerSummary: sv.bannerSummary, reconcile: sv.reconcile });
				}).then(function (res2) {
					if (res2 === null) return;           // 路由臂已失败并处理
					writing.current = false;
					inFlightSig.current = null;                                   // ★写毕 ⇒ 允许后续真改动再写
					setBusy(false);
					lastWritten.current = sv;
					setError("");
					if (res2 && res2.ok) { setStaleOpts(false); flashSaved(false); }
					else { setStaleOpts(true); flashSaved(true); }   // 旧 host：路由已存、选项待重启（既有降级语义，逐字保留）
				}, function () { writing.current = false; inFlightSig.current = null; setBusy(false); writeFail("保存失败（网络/服务端异常）"); });
			}
			/** 改动即写：**只剩"开关类"走这里**（阈值已改为 blur 提交 ⇒ 本 effect 不再依赖 `draftSec`）。
			 *  ★T52（`#A544` ③(v)）三处时序修正：① **`armed` 早退前先清 `pushTimer`**（否则收起后定时器仍会触发）
			 *  ② **effect 带 cleanup**（卸载/依赖变化即取消已排队的写）③ 真正写盘前经 `writeSnap` 的 `armed` 校验。 */
			react.useEffect(function () {
				if (!loaded || !armed) {
					if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }   // ★修正①
					return;
				}
				var cur = curSnap();
				if (sameSnap(cur, lastWritten.current)) return;
				if (pushTimer.current) clearTimeout(pushTimer.current);
				pushTimer.current = setTimeout(function () {
					pushTimer.current = null;
					writeSnap(cur);
				}, 0);
				return function () { if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; } };   // ★修正②
			}, [draftRoutes, draftDefault, draftSec, draftBanner, draftReconcile, armed, loaded]);
			/** ★T52：「**武装**」面板（＝开始"本次打开"）—— **与既有面板开合逻辑逐字同款**：
			 *  `baseline` ＝ **此刻的服务端快照**（撤销的还原目标）＋ `lastWritten` 同步 ＋ `armed=1`。
			 *  为什么提交路径也要武装：`toggle` 事件是**容器（`<details class="dsh-lp-card">`）冒泡**上来的，
			 *  实测**不保证在"展开后立刻键入并失焦"这一串里先于 blur 到达**（VM 场单跑实测：`armed` 仍为 0
			 *  ⇒ 新加的第 ③ 道 `armed` 校验会把这次提交挡掉 ⇒ 用户"打了字、离开框、却没保存"）。
			 *  ⇒ 提交路径**自保**：未武装则当场武装（**此刻服务端值就是"打开那一刻"的值**，语义与既有 `toggle` 分支一致）。 */
			function armNow() {
				if (armedRef.current) return;
				var sv = serverSnap();
				setBaseline(sv);
				lastWritten.current = sv;
				armedRef.current = true;
				setArmed(true);
			}
			/** ★T52：**阈值框的提交点 ＝ 离开输入框（blur）／收起面板（兜底）**。
			 *  **撤销逻辑一行不改**：提交 = 把 `ref` 里的文本 `setDraftSec(...)` ⇒ 之后走的仍是既有
			 *  `curSnap`/`writeSnap`/`lastWritten`/`baseline` 那条路（`#A413` 语义逐字保留）。 */
			function commitSecNow(force) {
				var text = secDraftRef.current;
				var sec = parseSeconds(text);
				if (sec === null) {
					// 非法/空：**不写坏值**（不静默）——把 DOM 拉回服务端现值
					var node0 = secNodeRef.current;
					if (node0) node0.value = String(Math.round(serverOptions.minTurnMs / 1000));
					return;
				}
				if (sec * 1000 === serverOptions.minTurnMs) return;      // 与当前服务端值一致 ⇒ 不动就不写
				armNow();                                                // ★未武装则当场武装（baseline＝此刻服务端值）
				setDraftSec(String(sec));
				var cur = SNAP(draftRoutes, draftDefault, sec * 1000, draftBanner, draftReconcile);
				writeSnap(cur, undefined, !!force);
			}
			/** 撤销：把**打开面板那一刻**的 baseline **原样写回**（同一批 RPC），随后重拉真值 */
			function undoAll() {
				if (!isDirty) return;
				setError("");
				writeSnap(baseline);
			}
			var isDirty = armed && !!baseline && !sameSnap(curSnap(), baseline);
			/** 面板开/关：卡体由容器包在 `<details class="dsh-lp-card">` 里（折叠记忆 `dsh-lp-open`）。
			 *  收起 ⇒ **先兜底提交阈值草稿**（★T52；顺序：**提交 → 再清 baseline/armed**，否则 `writeSnap` 会被 `armed` 挡掉）
			 *  ⇒ **清 baseline**（撤销失效）；再展开 ⇒ **用当前服务端真值重新起 baseline**（＝新一次"打开"）。 */
			react.useEffect(function () {
				var el = cardRoot.current;
				var d = el && typeof el.closest === "function" ? el.closest("details") : null;
				if (!d) return;                          // 平铺态：无"关闭"语义（baseline 寿命＝挂载期）
				var onToggle = function () {
					if (d.open) { armNow(); }
					else {
						if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }   // ★取消已排队的自动写
						commitSecNow(true);                                                                    // ★兜底提交（bypassArmed）
						armedRef.current = false;
						setBaseline(null); setArmed(false);
					}
				};
				d.addEventListener("toggle", onToggle);
				return function () { d.removeEventListener("toggle", onToggle); };
			}, [serverRoutes, serverDefault, serverOptions, loaded]);
			/** ★T52（`#A544` ③(v)）：**卸载（关掉卡 / 切走）时**取消已排队的写并失效 `armed`
			 *  —— 卸载分支**不提交**（无法安全更新 state，且服务端可能已不可达）；只保证"不再迟到写盘"。 */
			react.useEffect(function () {
				return function () {
					if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }
					armedRef.current = false;
				};
			}, []);
			/** ★T52：**服务端回读的聚焦守卫**（同 5 键框 `optFocus5` 口径）—— 只在该框**未聚焦**时写回 DOM；
			 *  正在输入时**一律不碰**（否则服务端值会把用户正在打的字顶掉）。 */
			react.useEffect(function () {
				var node = secNodeRef.current;
				if (!node || secFocusedRef.current) return;
				var want = String(Math.round(serverOptions.minTurnMs / 1000));
				secDraftRef.current = want;
				if (node.value !== want) node.value = want;
			}, [serverOptions.minTurnMs]);

			// ---- 折叠标题行已移交 summary 槽 (契约 §5.2/§5.4): 本卡只提供 body, 不再自绘标题行/徽标行/箭头 ----
			var note = h("div", { className: "nt-note", ref: cardRoot }, [
				h("b", null, "逐项可配："),
				"每行选「默认 / 自选 / 关闭」，行尾写明",
				h("b", null, "实际发往谁"),
				"；",
				h("b", null, "关闭"),
				" = 写显式空路由（旧版空值会回落默认路由 ⇒ 关不掉）。",
				h("br"),
				h("b", null, "明文只上行："),
				"完整 URL（Bark key / 群晖 webhook）只在保存时上行，列表、响应与日志只回尾号。"
			]);

			if (!loaded) {
				// body 顶层直出 (契约 §5.1/§5.3): 无 .nt-card 外壳、无整卡 <details>
				return h(react.Fragment, null, [
					note,
					h("div", { className: "nt-hint" }, state && state.status === "error"
						? "读取失败：" + (state.error || "") + "（RPC /notify-hub 未注册？）"
						: "加载中…")
				]);
			}

			// ---- ① 设备列表 (本次不改) ----
			function kindBadge(kind) {
				return h("span", { className: "nt-badge" + (kind === "bark" ? "" : " nt-syn") }, kindLabel(kind));
			}
			function resultEl(dev) {
				var r = tests[dev.id];
				if (!r) return null;
				if (r.pending) return h("span", { className: "nt-result pending" }, "发送中…（只打这一台）");
				if (r.status === "ok") return h("span", { className: "nt-result ok" }, "✓ 已发送");
				return h("span", { className: "nt-result err" }, "✗ 失败：" + (r.error || "发送失败"));
			}
			function editFormEl(dev) {
				if (!editing || editing.id !== dev.id) return null;
				var f = editing.form;
				return h("div", { className: "nt-edit" }, [
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "名称"),
						h("input", { className: "nt-input", value: f.name, disabled: busy, onChange: function (e) { patchEdit({ name: e.target.value }); } }),
						editErrs.name ? h("span", { className: "nt-err" }, editErrs.name) : null
					]),
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "类型 kind"),
						h("select", { className: "nt-input", value: f.kind, disabled: busy, onChange: function (e) { patchEdit({ kind: e.target.value }); } },
							KINDS.map(function (k) { return h("option", { key: k.id, value: k.id }, k.label); }))
					]),
					h("label", { className: "nt-field", style: { gridColumn: "1/-1" } }, [
						h("span", { className: "nt-flabel" }, "通知模板", h("span", { className: "nt-hint" }, "每台设备选一个；一个模板可被多台共用，设备类型不限")),
						h("select", {
							className: "nt-input", "data-dev-template": dev.id, value: f.templateId || "", disabled: busy,
							onChange: function (e) { patchEdit({ templateId: e.target.value }); }
						}, [
							h("option", { key: "__default", value: "" }, "按渠道内置默认（" + (f.kind === "bark" ? "Bark 默认" : "群晖 默认") + "）")
						].concat(serverTemplates.map(function (t) {
							return h("option", { key: t.id, value: t.id }, t.name + "（" + t.id + "）");
						}))),
						h("span", { className: "nt-hint" }, "当前生效：" + ((dev.tpl && dev.tpl.effectiveName) || "—") + (dev.tpl && dev.tpl.missing ? "（所选模板不存在，已回落内置默认）" : "") + "；高级可再覆盖标题/正文")
					]),
					h("label", { className: "nt-field", style: { gridColumn: "1/-1" } }, [
						h("span", { className: "nt-flabel" }, "完整 URL（含 key / webhook）", h("code", null, "只上行")),
						h("input", {
							className: "nt-input", type: "password", value: f.url, disabled: busy,
							placeholder: "留空 = 不修改（当前 " + (dev.urlTail || "—") + "）",
							onChange: function (e) { patchEdit({ url: e.target.value }); }
						}),
						editErrs.url ? h("span", { className: "nt-err" }, editErrs.url) : null
					]),
				]
					.concat(f.kind === "bark" ? [
						h("label", { className: "nt-field", key: "bg" }, [
							h("span", { className: "nt-flabel" }, "Bark group", h("span", { className: "nt-hint" }, "留空 ⇒ 按通知类型默认")),
							h("input", { className: "nt-input", value: f.barkGroup, disabled: busy, placeholder: "DSH-任务", onChange: function (e) { patchEdit({ barkGroup: e.target.value }); } })
						]),
						h("label", { className: "nt-field", key: "bl" }, [
							h("span", { className: "nt-flabel" }, "Bark level", h("span", { className: "nt-hint" }, "留空 ⇒ 按通知类型默认")),
							h("select", { className: "nt-input", value: f.barkLevel, disabled: busy, onChange: function (e) { patchEdit({ barkLevel: e.target.value }); } },
								[h("option", { key: "auto", value: "" }, "默认（按类型）")].concat(tplMeta.barkLevels.map(function (lv) {
									return h("option", { key: lv, value: lv }, BARK_LEVEL_LABEL[lv] || lv);
								})))
						]),
						h("label", { className: "nt-field", key: "bs" }, [
							h("span", { className: "nt-flabel" }, "Bark 提示音", h("span", { className: "nt-hint" }, "留空 ⇒ 系统默认")),
							h("input", { className: "nt-input", value: f.barkSound, disabled: busy, placeholder: "如 alarm / bell", onChange: function (e) { patchEdit({ barkSound: e.target.value }); } })
						]),
						h("label", { className: "nt-field", key: "bi" }, [
							h("span", { className: "nt-flabel" }, "通知图标 URL", h("code", null, "默认 DSH 大肥鱼")),
							h("input", { className: "nt-input", value: f.barkIcon, disabled: busy, placeholder: tplMeta.defaultBarkIcon, onChange: function (e) { patchEdit({ barkIcon: e.target.value }); } }),
							h("span", { className: "nt-hint" }, "留空 ⇒ 默认 DSH 图标；填 none 或 - ⇒ 不带图标；也可填自己的 http(s) 图片 URL")
						]),
						// v0.9.6：两个开关收进一个「开关组」，标签左、开关右，不再像两段裸文字
						h("div", { className: "nt-switchlist", key: "sw" }, [
							h("label", { className: "nt-switchrow", key: "ba" }, [
								h("span", { className: "nt-switchrow-t" }, [
									h("span", { className: "nt-switchrow-name" }, "归档到 Bark 历史"),
									h("span", { className: "nt-hint" }, "isArchive：推送同时写入 Bark 的历史列表")
								]),
								h("button", {
									type: "button", role: "switch", className: "nt-switch", disabled: busy,
									"aria-checked": f.barkIsArchive === 1 ? "true" : "false",
									"data-on": f.barkIsArchive === 1 ? "true" : "false",
									"aria-label": "归档到 Bark 历史",
									onClick: function () { patchEdit({ barkIsArchive: f.barkIsArchive === 1 ? 0 : 1 }); }
								})
							])
						])
					] : [])
					.concat([
						h("div", { className: "nt-acts", key: "acts" }, [
							h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, onClick: submitEdit }, "保存设备"),
							h("button", { type: "button", className: "nt-btn", disabled: busy, onClick: function () { setEditing(null); setEditErrs({}); } }, "取消"),
							h("span", { className: "nt-hint" }, "服务端只回 urlTail，不回明文")
						])
					])
				);
			}
			// ---- ★件B（`#A449`）：载荷（分隔符）行 —— 两态「默认｜自定义」＋ 7 项 by 位置 ＋ 重置 ----
			/** 当前生效草稿：有草稿用草稿；否则由服务端快照反推（任一键已配置 ⇒ 自定义态）。 */
			function payOf(dev) {
				if (payDraft[dev.id]) return payDraft[dev.id];
				var specs = {};
				var anyCustom = false;
				sepMeta.forEach(function (m) {
					var s = dev.seps && dev.seps[m.key] ? dev.seps[m.key] : null;
					specs[m.key] = s ? s.spec : m.def;
					if (s && s.configured) anyCustom = true;
				});
				// ★件C: 三开关（服务端透出的 value／configured 为准；旧 host 无 `segs` ⇒ 全开＝现状）
				var segs = {};
				var anySegCustom = false;
				segMeta.forEach(function (m) {
					var v = dev.segs && dev.segs[m.key] ? dev.segs[m.key] : null;
					segs[m.key] = v && v.value === false ? false : true;
					if (v && v.configured) anySegCustom = true;
				});
				// ★件C-补（用户裁定「简介和默认 自定义是并列的」）：三态并列 —— 默认｜简洁｜自定义
				//   「简洁」＝三开关值**恰为** 标题开／问题关／回答关（值等价判定 ⇒ 手改到该组合也如实显示「简洁」）
				return { mode: (anyCustom || anySegCustom) ? (segIsSimple(segs) ? "simple" : "custom") : "default", specs: specs, segs: segs };
			}
			/** 「简洁」＝三开关值恰为 标题开／问题关／回答关（**值等价判定**，与预设常量同源）。 */
			function segIsSimple(segs) {
				return !!(segs && segs.segTitle !== false && segs.segQuestion === false && segs.segAnswer === false);
			}
			function segStateTxt(cur) {
				return "内容段：" + segMeta.map(function (m) { return m.label + "＝" + (cur.segs[m.key] === false ? "关" : "开"); }).join("／")
					+ (cur.mode === "default" ? "（默认＝现状 · 三开关锁定为「开」；切「自定义」后可逐台单独设置）" : "（本设备自定义）");
			}
			/** 扳动一个开关（**只改草稿，不写盘**；默认态锁定 ⇒ 直接返回，零副作用）。 */
			function toggleSeg(dev, key, on) {
				var cur = payOf(dev);
				if (cur.mode !== "custom") return;
				var next = Object.assign({}, cur.segs);
				next[key] = on === undefined ? !(cur.segs[key] !== false) : on === true;
				setPay(dev, { segs: next });
				setPayNote(dev.id, []);
			}
			function setPay(dev, patch) {
				var next = Object.assign({}, payOf(dev), patch);
				setPayDraft(Object.assign({}, payDraft, { [dev.id]: next }));
			}
			function setPayNote(id, msgs) { setPayNotes(Object.assign({}, payNotes, { [id]: msgs })); }
			/** 三态并列开关之一（默认｜简洁｜自定义）。**「简洁」选中即自动写盘**（不需点「保存载荷」）。 */
			function paySegEl(dev, v, text, cur) {
				var tip = v === "simple" ? "简洁（＝只发标题＋状态）：选中即**自动写盘**（扁平三键 标题开／问题关／回答关）；已是简洁态时再点仍会写一次（幂等，不静默跳过）"
					: (v === "default" ? "默认（＝现状）：删本设备 7 项分隔符 ＋ 内容段三开关（范围严格限本设备）"
						: "自定义：展开 3 个内容段开关 ＋ 7 项分隔符，改完点「保存载荷」生效");
				return h("button", {
					type: "button", key: v, id: dev.id + "-paystate-" + v, "data-v": v, "data-pay": dev.id,
					"data-on": cur.mode === v ? "true" : "false", disabled: busy, title: tip,
					onClick: function () {
						if (v === "simple") {
							// ★件C-补：选中即自动写盘（载荷＝扁平 segTitle/segQuestion/segAnswer，不引入 segs 嵌套）
							var next = Object.assign({}, payOf(dev).segs);
							Object.keys(SEG_PRESET_SIMPLE).forEach(function (k) { next[k] = SEG_PRESET_SIMPLE[k]; });
							setPay(dev, { mode: "simple", segs: next });
							setPayNote(dev.id, []);
							savePayload(dev, { mode: "simple" });
							return;
						}
						setPay(dev, { mode: v });
						setPayNote(dev.id, []);
						if (v === "default") savePayload(dev, { mode: "default" });
					}
				}, text);
			}
			/** 三开关之一（自定义态：可扳动；默认态：**灰显锁定** ＋ 不产生任何写盘）。 */
			function segSwitchEl(dev, m, cur, locked) {
				var on = cur.segs[m.key] !== false;
				return h("label", { className: "nt-pay-item", key: m.key }, [
					h("span", { className: "nt-flabel" }, "内容段「" + m.label + "」", h("code", null, m.key),
						h("span", { className: "nt-hint" }, "默认 " + (m.def === false ? "关" : "开"))),
					h("span", { className: "nt-pay-pos" }, "位置：" + m.pos),
					h("button", {
						type: "button", className: "nt-switch", id: dev.id + "-sw-" + m.key, "data-seg": m.key, "data-dev": dev.id,
						"data-on": on ? "true" : "false", "data-locked": locked ? "true" : "false", disabled: busy || locked,
						title: locked ? "默认＝现状：三开关锁定为「开」（切「自定义」后可逐台单独设置）" : "点一下扳动本设备的「" + m.label + "」段",
						onClick: function () { toggleSeg(dev, m.key); }
					}),
					h("span", { className: "nt-hint" + (on ? "" : " nt-warn"), "data-seg-state": m.key },
						on ? "开（该段会出现在输出里）" : "关（该段与其相邻分隔符一并省略；本类型若本就无该段 ⇒ 输出逐字不变）")
				]);
			}
			/** 非自定义态（默认／简洁）的三开关：**灰显锁定**（只读回显，不挂 onClick ⇒ 无写盘可能）。 */
			function segLockedEl(dev, cur) {
				var isSimple = cur.mode === "simple";
				return h("span", { className: "nt-seglock", "data-seg-locked-row": dev.id, "data-lock-mode": cur.mode }, [
					h("span", { className: "nt-hint" }, isSimple ? "内容段（简洁态）" : "内容段（默认＝现状）"),
					segMeta.map(function (m) {
						var on = cur.segs[m.key] !== false;
						return h("button", {
							type: "button", className: "nt-switch", key: m.key, "data-seg": m.key, "data-dev": dev.id,
							"data-on": on ? "true" : "false", "data-locked": "true", disabled: true, tabIndex: -1,
							title: (isSimple ? "简洁态锁定：" : "默认态锁定：") + "本设备「" + m.label + "」＝" + (on ? "开" : "关") + "；切「自定义」后可单独设置"
						});
					}),
					h("span", { className: "nt-hint" }, isSimple ? "锁定为：标题开／问题关／回答关（只发标题＋状态）" : "锁定为全开（＝现状）")
				]);
			}
			function payloadRowEl(dev) {
				var cur = payOf(dev);
				var notes = payNotes[dev.id] || [];
				var n = dev.lastSend && dev.lastSend.pages ? dev.lastSend.pages : null;
				var effTxt = cur.mode === "default"
					? "默认 ＝ 逐字现状（7 项均走内置默认）"
					: "自定义：" + sepMeta.map(function (m) { return sepParse(cur.specs[m.key], m.def).spec; }).join(" · ");
				return h("div", { className: "nt-row nt-pay", key: dev.id + "-pay" }, [
					h("div", { className: "nt-pay-h" }, [
						h("span", { className: "nt-flabel" }, "载荷（分隔符）"),
						h("code", { className: "nt-id" }, "7 项 · 按出现位置"),
						h("span", { className: "nt-hint nt-pay-eff", "data-pay-eff": dev.id }, [
							"生效面：对话（回合级）四项；其余类型不受影响",
							"｜" + segStateTxt(cur),
							n ? "｜上次推送 " + n + " 条" : "",
							(dev.lastSend && Array.isArray(dev.lastSend.adjusted) && dev.lastSend.adjusted.length)
								? "｜⚠ 上次推送时已按 X 处理：" + dev.lastSend.adjusted.join("；") : "",
							"｜" + effTxt,
							staleHost ? "｜⚠ host 插件未更新：需重启 dsh web 后生效" : ""
						]),
						h("span", { className: "nt-acts" }, [
							h("button", { type: "button", className: "nt-btn", id: dev.id + "-pay-reset", "data-pay-reset": dev.id, disabled: busy, title: "把本设备 7 项分隔符 ＋ 内容段三开关恢复为默认（范围严格限本设备）", onClick: function () { setPayNote(dev.id, []); savePayload(dev, { mode: "reset" }); } }, "恢复默认（本设备）"),
							h("span", { className: "nt-seg", "data-seg-states": dev.id }, [paySegEl(dev, "default", "默认", cur), paySegEl(dev, "simple", "简洁", cur), paySegEl(dev, "custom", "自定义", cur)])
						])
					]),
					cur.mode !== "custom" ? segLockedEl(dev, cur) : null,
					cur.mode === "custom" ? h("details", { className: "nt-pay-det", id: dev.id + "-pay-det", "data-pay-det": dev.id }, [
						h("summary", null, "分隔符细节（7 项 · 逐项标注出现在哪）"),
						// ★件C-补: 「内容段」三开关（与 7 项分隔符**同处本展开区**）——「简洁」已提升为**并列第三态**（本区不再有预设按钮）
						h("div", { className: "nt-segline" }, [
							h("span", { className: "nt-flabel" }, "内容段（3 开关 · 逐台独立）"),
							h("code", { className: "nt-id" }, "segTitle／segQuestion／segAnswer"),
							h("span", { className: "nt-hint" }, "缺省或 true ＝ 开；显式 false ＝ 关（段关掉 ⇒ 与该段相邻的分隔符一并省略）｜「简洁」＝**并列第三态**（选中即自动写盘）；手改到 标题开／问题关／回答关 时，该态即如实显示")
						]),
						h("div", { className: "nt-pay-grid" }, segMeta.map(function (m) { return segSwitchEl(dev, m, cur, false); })),
						h("div", { className: "nt-hint nt-pay-note" }, SEG_EMPTY_NOTE),
						h("div", { className: "nt-pay-grid" }, sepMeta.map(function (m) {
							var r = sepParse(cur.specs[m.key], m.def);
							return h("label", { className: "nt-pay-item", key: m.key }, [
								h("span", { className: "nt-flabel" }, m.label, h("code", null, m.key), h("span", { className: "nt-hint" }, "默认 " + m.def)),
								h("span", { className: "nt-pay-pos" }, "位置：" + m.pos + "｜记法：字符或短串*次数（1–60）"),
								h("input", {
									className: "nt-input", id: dev.id + "-" + m.key, "data-sep": m.key, "data-dev": dev.id,
									value: cur.specs[m.key], disabled: busy, placeholder: m.def,
									onChange: function (e) { var sp = Object.assign({}, cur.specs); sp[m.key] = e.target.value; setPay(dev, { specs: sp }); }
								}),
								r.note
									? h("span", { className: "nt-pay-note" }, "已按 " + r.spec + " 处理：" + r.note)
									: h("span", { className: "nt-pay-note ok" }, "解析 ⇒ " + r.spec + "｜" + r.text.length + " 字符")
							]);
						})),
						h("div", { className: "nt-acts" }, [
							h("button", { type: "button", className: "nt-btn nt-btn-solid", id: dev.id + "-pay-save", "data-pay-save": dev.id, disabled: busy, onClick: function () { savePayload(dev); } }, "保存载荷"),
							h("span", { className: "nt-hint" }, "服务端为准：越界夹取 / 语法非法回退默认，保存后就地报出（不静默）")
						])
					]) : null,
					notes.length ? h("div", { className: "nt-pay-grid" }, notes.map(function (t, i) {
						return h("span", { className: "nt-pay-note", key: "pn" + i }, t);
					})) : null
				]);
			}
			/** mode: "default"(=删键回默认) | "reset"(=恢复默认) | "simple"(=简洁：扁平三键自动写盘) | undefined(=提交 3 开关 ＋ 7 项)。 */
			function savePayload(dev, opt) {
				var cur = payOf(dev);
				var mode = opt && opt.mode ? opt.mode : cur.mode;
				var payload = { id: dev.id, name: dev.name || dev.id, kind: dev.kind || "bark" };
				if (mode === "default" || mode === "reset") payload.sepReset = true;
				else if (mode === "simple") {
					// ★件C-补：简洁态载荷 ＝ **扁平三键**（segTitle:true／segQuestion:false／segAnswer:false）
					//   **不带** 7 项 sep 键、**不带** sepReset（不新增键、不改 saveDevice 契约；不引入 segs 嵌套）
					segMeta.forEach(function (m) { payload[m.key] = SEG_PRESET_SIMPLE[m.key] === false ? false : true; });
				} else {
					sepMeta.forEach(function (m) { payload[m.key] = String(cur.specs[m.key] == null ? "" : cur.specs[m.key]).trim() || m.def; });
					// ★件C: 三开关随同一次保存下发（开 ⇒ 服务端不建键；关 ⇒ 落盘 false）
					segMeta.forEach(function (m) { payload[m.key] = cur.segs[m.key] === false ? false : true; });
				}
				setError("");
				setBusy(true);
				props.saveDevice(payload).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						var info = (res.value && Array.isArray(res.value.sepInfo)) ? res.value.sepInfo : [];
						var sinfo = (res.value && Array.isArray(res.value.segInfo)) ? res.value.segInfo : [];
						// ★件C-补：成功／降级都上屏（降级＝服务端回包里的 note，逐条列出；不静默）
						var msgs = [];
						if (mode === "simple") msgs.push("✓ 已写盘「简洁」＝只发标题＋状态（会话标题 开／问题 关／回答 关；页脚随「回答」一并省略）");
						else if (mode === "default" || mode === "reset") msgs.push("✓ 已恢复本设备的 7 项分隔符 ＋ 内容段三开关（全开）默认（范围严格限本设备）");
						msgs = msgs.concat(info.concat(sinfo).filter(function (x) { return x && x.note; }).map(function (x) { return (x.label || x.key) + "：" + x.note; }));
						if (!msgs.length) msgs = ["✓ 已保存（服务端未报降级）"];
						setPayNote(dev.id, msgs);
						flashSaved(false);
					} else { setPayNote(dev.id, ["✗ 写盘失败（未生效）：" + errText(res, "保存载荷失败")]); setError(errText(res, "保存载荷失败")); }
				}, function () { setBusy(false); setPayNote(dev.id, ["✗ 写盘失败（请求被拒/断链，未生效）"]); setError("保存载荷失败"); });
			}

			// ---- v0.9.0：自定义模板（{{占位符}}）—— 每台设备 override / 渠道级默认 ----
			function kindLabelOf(kind) { return kind === "bark" ? "Bark" : (kind === "synology" ? "群晖" : String(kind)); }
			function tplOf(dev) {
				if (tplDraft[dev.id]) return tplDraft[dev.id];
				var t = dev.tpl || {};
				return { title: t.title || "", body: t.body || "" };
			}
			function setTplField(dev, field, value) {
				setTplDraft(Object.assign({}, tplDraft, { [dev.id]: Object.assign({}, tplOf(dev), { [field]: value }) }));
			}
			function tplNode(dev, field) {
				var m = tplNodes.current[dev.id] || (tplNodes.current[dev.id] = {});
				return m[field];
			}
			function tplInsert(dev, key, fieldIn) {
				var field = fieldIn || tplFocus.current[dev.id] || "body";
				var cur = tplOf(dev);
				var token = "{{" + key + "}}";
				var node = tplNode(dev, field);
				var text = cur[field] || "";
				if (node && typeof node.selectionStart === "number") {
					var s = node.selectionStart, e = node.selectionEnd;
					setTplField(dev, field, text.slice(0, s) + token + text.slice(e));
					var pos = s + token.length;
					setTimeout(function () { try { node.focus(); node.setSelectionRange(pos, pos); } catch (err) {} }, 0);
				} else {
					setTplField(dev, field, text + token);
				}
				setTplNotes(Object.assign({}, tplNotes, { [dev.id]: [] }));
			}
			function tplApplyExample(dev) {
				var which = tplExampleSel[dev.id] || "full";
				var ex = (tplMeta.examples && (tplMeta.examples[dev.kind] || tplMeta.examples[which])) || { title: "", body: "" };
				setTplDraft(Object.assign({}, tplDraft, { [dev.id]: { title: ex.title || "", body: ex.body || "" } }));
				setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✓ 已填入示例模板（**只是草稿**；点「保存格式」才写盘）"] }));
			}
			function tplSave(dev) {
				var cur = tplOf(dev);
				setBusy(true);
				props.saveDevice({ id: dev.id, name: dev.name || dev.id, kind: dev.kind || "bark", tplTitle: cur.title, tplBody: cur.body }).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						var info = (res.value && Array.isArray(res.value.tplInfo)) ? res.value.tplInfo : [];
						var msgs = info.filter(function (x) { return x && x.note; }).map(function (x) { return x.note; });
						if (!msgs.length) msgs = ["✓ 已保存设备模板（空 = 继承渠道默认）"];
						setTplNotes(Object.assign({}, tplNotes, { [dev.id]: msgs }));
						flashSaved(false);
					} else {
						setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✗ 写盘失败（未生效）：" + errText(res, "保存模板失败")] }));
						setError(errText(res, "保存模板失败"));
					}
				}, function () { setBusy(false); setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✗ 写盘失败（请求被拒/断链，未生效）"] })); });
			}
			function tplReset(dev) {
				setBusy(true);
				props.saveDevice({ id: dev.id, name: dev.name || dev.id, kind: dev.kind || "bark", tplReset: true }).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						setTplDraft(Object.assign({}, tplDraft, { [dev.id]: { title: "", body: "" } }));
						setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✓ 已删除本设备模板 ⇒ 继承渠道默认 / 旧版格式"] }));
						flashSaved(false);
					} else setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✗ 恢复失败：" + errText(res, "恢复默认模板失败")] }));
				}, function () { setBusy(false); setTplNotes(Object.assign({}, tplNotes, { [dev.id]: ["✗ 恢复失败（请求被拒/断链）"] })); });
			}
			function tplPreview(dev) {
				setTplPrev(Object.assign({}, tplPrev, { [dev.id]: { pending: true } }));
				props.preview({ deviceId: dev.id, type: "task.done" }).then(function (res) {
					if (res && res.ok && res.value) setTplPrev(Object.assign({}, tplPrev, { [dev.id]: res.value }));
					else setTplPrev(Object.assign({}, tplPrev, { [dev.id]: { error: errText(res, "预览失败") } }));
				}, function () { setTplPrev(Object.assign({}, tplPrev, { [dev.id]: { error: "预览失败（请求被拒/断链）" } })); });
			}
			// ---- v0.9.1: 模板库编辑器（新增/编辑共用一张表单） ----
			/** 预览设备跟着编辑对象走：优先「正在用这条模板」的设备，其次同 kind 的第一台 */
			function pickPreviewDeviceFor(tpl) {
				if (!tpl) return;
				var used = (tpl.usedBy || []).filter(function (id) { return devices.some(function (d) { return d.id === id; }); });
				if (used.length) { setPrevDeviceId(used[0]); return; }
				var kind = tpl.id === "synology-default" ? "synology" : (tpl.id === "bark-default" ? "bark" : null);
				if (kind) {
					var same = devices.filter(function (d) { return d.kind === kind; })[0];
					if (same) setPrevDeviceId(same.id);
				}
			}
			function startNewTemplate() {
				setPrevDeviceId("");
				setTplEdit({ name: "新模板", emoji: "", title: "{{titleFull}}", body: "{{body}}" });
				setTplEditNotes([]);
				setTplEditPrev(null);
				setTplLibPrev(null);
			}
			function startEditTemplate(t) {
				pickPreviewDeviceFor(t);
				setTplEdit({ id: t.id, name: t.name, emoji: t.emoji || "", title: t.title || "", body: t.body || "" });
				setTplEditNotes(t.builtin ? ["内置模板可编辑内容，但不可删除"] : []);
				setTplEditPrev(null);
				setTplLibPrev(null);
			}
			function cancelTplEdit() {
				setTplEdit(null);
				setTplEditNotes([]);
				setTplEditPrev(null);
			}
			function setTplEditField(field, value) {
				setTplEdit(Object.assign({}, tplEdit || {}, { [field]: value }));
				setTplEditNotes([]);
			}
			function tplEditInsert(key, fieldIn) {
				var field = fieldIn || tplEditFocus.current || "body";
				var cur = tplEdit || { title: "", body: "" };
				var token = "{{" + key + "}}";
				var node = (tplEditNodes.current || {})[field];
				var text = cur[field] || "";
				if (node && typeof node.selectionStart === "number") {
					var s = node.selectionStart, e = node.selectionEnd;
					setTplEditField(field, text.slice(0, s) + token + text.slice(e));
					var pos = s + token.length;
					setTimeout(function () { try { node.focus(); node.setSelectionRange(pos, pos); } catch (err) {} }, 0);
				} else setTplEditField(field, text + token);
			}
			function saveTplEdit() {
				if (!tplEdit) return;
				var name = String(tplEdit.name || "").trim();
				if (!name) { setTplEditNotes(["模板名称不能为空"]); return; }
				setBusy(true);
				props.saveTemplate({ ...(tplEdit.id ? { id: tplEdit.id } : {}), name: name, emoji: tplEdit.emoji || "", title: tplEdit.title || "", body: tplEdit.body || "" }).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						var info = (res.value && Array.isArray(res.value.info)) ? res.value.info : [];
						var msgs = info.filter(function (x) { return x && x.note; }).map(function (x) { return x.note; });
						if (!msgs.length) msgs = ["✓ 已保存模板" + (tplEdit && tplEdit.id ? "：" + tplEdit.id : "")];
						setTplEditNotes(msgs);
						setTplEdit(null);
						flashSaved(false);
					} else {
						setTplEditNotes(["✗ 写盘失败：" + errText(res, "保存模板失败")]);
						setError(errText(res, "保存模板失败"));
					}
				}, function () { setBusy(false); setTplEditNotes(["✗ 写盘失败（请求被拒/断链）"]); });
			}
			function deleteTpl(t) {
				setBusy(true);
				props.deleteTemplate({ id: t.id }).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						setTplEditNotes([]); setTplLibPrev(null);
						if (tplEdit && tplEdit.id === t.id) setTplEdit(null);
						flashSaved(false);
					} else {
						setTplEditNotes(["✗ 删除失败：" + errText(res, "删除模板失败")]);
						setError(errText(res, "删除模板失败"));
					}
				}, function () { setBusy(false); setTplEditNotes(["✗ 删除失败（请求被拒/断链）"]); });
			}
			function previewTplEdit() {
				if (!tplEdit || !tplEdit.id) { setTplEditNotes(["新增模板先保存，再预览（预览读服务端已保存的模板）"]); return; }
				setTplEditPrev({ pending: true });
				props.preview({ templateId: tplEdit.id, type: "task.done" }).then(function (res) {
					if (res && res.ok && res.value) setTplEditPrev(res.value);
					else setTplEditPrev({ error: errText(res, "预览失败") });
				}, function () { setTplEditPrev({ error: "预览失败（请求被拒/断链）" }); });
			}
			function previewTplById(t) {
				setTplLibPrev({ pending: true });
				props.preview({ templateId: t.id, type: "task.done" }).then(function (res) {
					if (res && res.ok && res.value) setTplLibPrev(res.value);
					else setTplLibPrev({ error: errText(res, "预览失败") });
				}, function () { setTplLibPrev({ error: "预览失败（请求被拒/断链）" }); });
			}
			function tplPreviewBox(pr) {
				if (!pr) return null;
				if (pr.pending) return h("div", { className: "nt-hint" }, "预览中…（零网络、零写盘）");
				if (pr.error) return h("div", { className: "nt-pay-note" }, "✗ " + pr.error);
				// 2026-11-24（task-17）：预览与发送同源 ⇒ 直接展示「按渠道最终发送」字段（含分页/seps/segs/模板覆盖）
				var dv = pr.delivery || null;
				var titleSupported = pr.titleSupported !== false;
				var head = [
					"实际发送（与服务端发送同源）",
					"｜渠道 " + String(pr.kind || "?"),
					"｜共 " + (Array.isArray(pr.pages) ? pr.pages.length : 1) + " 条",
					pr.source ? "｜标题来源 " + String(pr.source.title || "legacy") + " · 正文来源 " + String(pr.source.body || "legacy") : ""
				].join("");
				var titleLine = titleSupported
					? ("标题：" + String((dv && dv.title) || pr.title || "") + "\n")
					: "标题：（群晖 Chat 无独立标题字段 ⇒ 不参与发送；如需标题请写入正文模板的 {{title}}）\n";
				var bodyText = dv
					? (dv.kind === "bark" ? String(dv.body || "") : (Array.isArray(dv.pages) ? dv.pages.join("\n\n---- 分页 ----\n\n") : String(pr.body || "")))
					: String(pr.body || "");
				var warns = (Array.isArray(pr.warnings) && pr.warnings.length)
					? h("div", { className: "nt-pay-note", "data-tpl-warnings": "1", style: { color: "var(--dsw-alias-state-warn-primary,#f59e0b)" } }, "模板警告：" + pr.warnings.map(function (w) { return String(w.message || w.code || ""); }).join("；"))
					: null;
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 5 } }, [
					h("div", { className: "nt-hint" }, head),
					h("pre", { className: "nt-tpl-prev", "data-tpl-preview": "1" }, titleLine + bodyText),
					warns,
					(Array.isArray(pr.notes) && pr.notes.length) ? h("div", { className: "nt-pay-note" }, pr.notes.join("；")) : null
				]);
			}
			function tplTextarea(dev, field, label, placeholder) {
				return h("label", { className: "nt-field", key: field }, [
					h("span", { className: "nt-flabel" }, label, h("span", { className: "nt-hint" }, "最大 " + (field === "title" ? tplMeta.limits.title : tplMeta.limits.body) + " 字符")),
					h("textarea", {
						className: "nt-tpl-ta", "data-tpl": field, "data-tpl-dev": dev.id, value: tplOf(dev)[field], disabled: busy,
						placeholder: placeholder || "", ref: function (n) { if (n) { var m = tplNodes.current[dev.id] || (tplNodes.current[dev.id] = {}); m[field] = n; } },
						onFocus: function () { tplFocus.current[dev.id] = field; },
						onChange: function (e) { setTplField(dev, field, e.target.value); setTplNotes(Object.assign({}, tplNotes, { [dev.id]: [] })); }
					})
				]);
			}
			function templateRowEl(dev) {
				var cur = tplOf(dev);
				var notes = tplNotes[dev.id] || [];
				var t = dev.tpl || {};
				var sel = serverTemplates.find(function (x) { return x.id === (t.effectiveId || ""); }) || serverTemplates[0] || { emoji: "", title: "", body: "" };
				var merged = { emoji: sel.emoji || "", title: cur.title || sel.title || "", body: cur.body || sel.body || "" };
				var effTitle = t.effectiveTitle || "";
				var effBody = t.effectiveBody || "";
				return h("div", { className: "nt-tpl", "data-tpl-row": dev.id }, [
					h("div", { className: "nt-tpl-h" }, [
						h("span", { className: "nt-flabel" }, "高级覆盖（可选）"),
						h("span", { className: "nt-tag" }, "优先于所选模板"),
						h("span", { className: "nt-hint" }, "空 = 用所选模板。标题仅 Bark 生效；正文渲染后仍按渠道上限分页。"),
						h("span", { className: "nt-hint" }, "生效来源：标题 " + (t.titleSource || "legacy") + " · 正文 " + (t.bodySource || "legacy"))
					]),
					h("div", { className: "nt-tpl-grid" }, [
						dev.kind === "bark" ? tplTextarea(dev, "title", "标题模板", "{{emoji}} {{status}} · {{session}}") :
							h("div", { className: "nt-field" }, [h("span", { className: "nt-flabel" }, "标题模板"), h("span", { className: "nt-hint" }, "群晖 Chat 没有独立标题字段：请在正文里用 {{title}} 自行嵌入（此框对群晖不生效）")]),
						tplTextarea(dev, "body", "正文模板", dev.kind === "bark" ? "{{status}}｜{{answer}}" : "{{body}}")
					]),
					react.createElement(PlaceholderPicker, { placeholders: tplMeta.placeholders, busy: busy, onInsert: function (key, field) { tplInsert(dev, key, field); } }),
					h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
						h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, "data-tpl-save": dev.id, onClick: function () { tplSave(dev); } }, "保存格式"),
						h("button", { type: "button", className: "nt-btn", disabled: busy, "data-tpl-reset": dev.id, onClick: function () { tplReset(dev); }  }, "清除本设备覆盖"),
						h("select", { className: "nt-input", style: { width: 150 }, value: tplExampleSel[dev.id] || "full", disabled: busy, onChange: function (e) { setTplExampleSel(Object.assign({}, tplExampleSel, { [dev.id]: e.target.value })); } }, [
							h("option", { key: "full", value: "full" }, "完整示例"), h("option", { key: "simple", value: "simple" }, "简洁示例")
						]),
						h("button", { type: "button", className: "nt-btn", disabled: busy, onClick: function () { tplApplyExample(dev); } }, "填入示例")
					]),
					liveToolbarEl(),
					h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
						h("button", { type: "button", className: "nt-btn", disabled: busy, "data-tpl-preview": dev.id, onClick: function () { tplPreview(dev); } }, "预览实际发送（与发送同源）")
					]),
					tplPreviewBox(tplPrev[dev.id]),
					livePreviewEl(merged, dev, "编辑示意（非最终；最终以上方服务端预览为准）", prevSample),
					notes.length ? h("div", { className: "nt-pay-grid" }, notes.map(function (x, i) { return h("span", { className: "nt-pay-note", key: "tn" + i }, x); })) : null
				]);
			}
			/** 实时预览：只填**真实可获取**的字段；标题/正文/问答等留空（发送时才有）。 */
			function previewDeviceOf() {
				return devices.find(function (d) { return d.id === prevDeviceId; }) || devices[0] || { id: "preview", name: "（无设备）", kind: "bark", seps: {}, segs: {}, bark: null };
			}
			function sepTextOf(dev, m) {
				var s = dev && dev.seps && dev.seps[m.key];
				if (s && typeof s.text === "string") return s.text;
				return sepParse(m.def, m.def).text;
			}
			function buildLiveVars(dev, type, tplEmoji) {
				var trec = types.find(function (t) { return t.type === type; }) || { type: type, label: type, group: "", level: "" };
				var st = (tplMeta.typeStatus && tplMeta.typeStatus[type]) || (TYPE_STATUS_FALLBACK[type] ? { emoji: TYPE_STATUS_FALLBACK[type][0], status: TYPE_STATUS_FALLBACK[type][1] } : { emoji: "", status: trec.label });
				var now = new Date();
				var seps = {};
				sepMeta.forEach(function (m) { seps[m.key] = sepTextOf(dev, m); });
				var pad = function (n) { return String(n).padStart(2, "0"); };
				return Object.assign({
					// v0.9.5：{{prefix}} = 标题前缀（Bark 且该设备 titlePrefix 开 ⇒ "[DSH] "）
					prefix: (dev.kind === "bark" && (!dev.bark || dev.bark.titlePrefix !== false)) ? "[DSH] " : "",
					title: "", titleFull: "", body: "", status: st.status || "", emoji: tplEmoji || st.emoji || "",
					session: "", sid: "", turn: "", elapsed: "", elapsedMs: "", reason: "", question: "", answer: "", summary: "", footer: "",
					time: pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()),
					date: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
					iso: now.toISOString(),
					type: type, typeLabel: trec.label || type,
					group: (dev && dev.bark && dev.bark.group) || trec.group || "",
					level: (dev && dev.bark && dev.bark.level) || trec.level || "",
					device: dev.id || "", deviceName: dev.name || "", kind: dev.kind || ""
				}, seps);
			}
			function renderTplLocal(text, vars) {
				var used = [], unknown = [];
				var out = String(text == null ? "" : text).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, function (m, name) {
					if (Object.prototype.hasOwnProperty.call(vars, name)) { used.push(name); return vars[name] == null ? "" : String(vars[name]); }
					unknown.push(name); return m;
				});
				return { text: out, used: used, unknown: unknown };
			}
			function liveToolbarEl() {
				var dev = previewDeviceOf();
				var typeRec = types.find(function (t) { return t.type === prevType; }) || types[0] || { type: "task.done", label: "对话完成" };
				return h("div", { className: "nt-live-bar", "data-live-bar": "1" }, [
					h("span", { className: "nt-flabel" }, "实时预览"),
					h("span", { className: "nt-hint" }, "设备"),
					h("select", {
						className: "nt-input", style: { width: 180 }, "data-prev-device": "1", value: dev.id === "preview" ? "" : dev.id,
						onChange: function (e) { setPrevDeviceId(e.target.value); }
					}, [h("option", { key: "__none", value: "" }, "（无设备 / 按 Bark）")].concat(devices.map(function (d) {
						return h("option", { key: d.id, value: d.id }, (d.name || d.id) + " · " + d.kind);
					}))),
					h("span", { className: "nt-hint" }, "类型"),
					h("select", {
						className: "nt-input", style: { width: 240 }, "data-prev-type": "1", value: prevType,
						onChange: function (e) { setPrevType(e.target.value); }
					}, types.map(function (t) { return h("option", { key: t.type, value: t.type }, t.label || t.type); })),
					h("span", { className: "nt-hint" }, "设备名/时间/类型/emoji/分隔符为真实值；标题/正文/问答为空（发送时才有）")
				]);
			}
			/** 示例内容（真实运行时标题/正文/问答都是空的 ⇒ 预览框会全空，看不出排版；用户可关掉） */
			var SAMPLE_VARS = { title: "通知 UI 整改 布局确认", titleFull: "通知 UI 整改 布局确认", body: "（回合结束）用时 4 分 12 秒 · 3 条改动已落盘", question: "要我把预览落成 client.js 吗？", answer: "好，按这个来", summary: "3 条改动、1 个测试待跑", reason: "重启", session: "通知UI整改接手确认现状", turn: "12", elapsed: "4m12s" };
			/** 实时预览：标题/正文两个独立预览框（群晖标题不发送，仅作模板参考）。sample=true ⇒ 填示例内容 */
			function livePreviewEl(tpl, dev, label, sample) {
				var kind = dev.kind || "bark";
				var vars = buildLiveVars(dev, prevType, tpl.emoji || "");
				if (sample) Object.assign(vars, SAMPLE_VARS);
				var tr = renderTplLocal(tpl.title, vars);
				var br = renderTplLocal(tpl.body, vars);
				var typeRec = types.find(function (t) { return t.type === prevType; });
				// v0.9.6：标题前缀已下线 —— 标题就是模板渲染出来的原文（{{prefix}} 恒空）
				var autoPrefix = "";
				var titleText = kind === "bark" ? (autoPrefix + tr.text) : tr.text;
				var used = Array.from(new Set(tr.used.concat(br.used)));
				var unavailable = (tplMeta.unavailablePreview || []).filter(function (k) { return used.indexOf(k) >= 0; });
				var unknown = Array.from(new Set(tr.unknown.concat(br.unknown)));
				var notes = [];
				if (unavailable.length) notes.push("预览无真实值、按空串渲染：" + unavailable.map(function (k) { return "{{" + k + "}}"; }).join("、") + "（真实发送时才有）");
				if (unknown.length) notes.push("未知占位符：" + unknown.map(function (k) { return "{{" + k + "}}"; }).join("、") + "（原样保留）");
				if (kind !== "bark") notes.push("群晖 Chat 没有独立标题字段：标题框仅作模板参考，实际不发送");
				return h("div", { className: "nt-live", "data-live-preview": label }, [
					h("div", { className: "nt-live-h", key: "h" }, [
						h("span", { className: "nt-flabel" }, "实时预览"),
						h("span", { className: "nt-tag" }, label),
						h("span", { className: "nt-hint" }, "设备 " + (dev.name || "—") + " · 类型 " + ((typeRec && typeRec.label) || prevType))
					]),
					h("div", { className: "nt-live-grid", key: "g" }, [
						h("div", { className: "nt-live-box", key: "title" }, [
							h("div", { className: "nt-live-label", key: "l" }, "标题" + (kind === "bark" ? "（Bark 实际发送）" : "（群晖不单独发送，仅参考）")),
							h("pre", { className: "nt-tpl-prev nt-live-pre", key: "p", "data-live-title": "1" }, titleText || "（空 — 真实发送时才有）")
						]),
						h("div", { className: "nt-live-box", key: "body" }, [
							h("div", { className: "nt-live-label", key: "l" }, "正文"),
							h("pre", { className: "nt-tpl-prev nt-live-pre", key: "p", "data-live-body": "1" }, br.text || "（空 — 真实发送时才有）")
						])
					]),
					notes.length ? h("div", { className: "nt-live-note", key: "n" }, notes.join("；")) : null
				]);
			}

			function templateEditorEl() {
				if (!tplEdit) return null;
				var isNew = !tplEdit.id;
				return h("div", { className: "nt-tpl", "data-tpl-edit": tplEdit.id || "new", key: "tpl-edit" }, [
					h("div", { className: "nt-tpl-h" }, [
						h("span", { className: "nt-flabel" }, isNew ? "新增模板" : "编辑模板"),
						tplEdit.id ? h("code", { className: "nt-id" }, tplEdit.id) : h("span", { className: "nt-tag" }, "未保存"),
						h("span", { className: "nt-hint" }, "一个模板可被多台设备共用；设备类型不限（Bark/群晖都可选）")
					]),
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "模板名称", h("span", { className: "nt-hint" }, "最多 " + tplMeta.limits.name + " 字符")),
						h("input", {
							className: "nt-input", "data-tpl-edit-name": "1", value: tplEdit.name || "", disabled: busy,
							placeholder: "例如：简洁 / 安全告警",
							onChange: function (e) { setTplEditField("name", e.target.value); }
						})
					]),
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "emoji（独立维度）", h("span", { className: "nt-hint" }, "留空 ⇒ 按通知类型自动（✅/⁉️/…）；填了就强制用这个")),
						h("input", {
							className: "nt-input", "data-tpl-edit-emoji": "1", value: tplEdit.emoji || "", disabled: busy,
							placeholder: "留空 = 按类型", maxLength: tplMeta.limits.emoji,
							onChange: function (e) { setTplEditField("emoji", e.target.value); }
						})
					]),
					h("div", { className: "nt-tpl-grid" }, [
						h("label", { className: "nt-field" }, [
							h("span", { className: "nt-flabel" }, "标题模板", h("span", { className: "nt-hint" }, "仅 Bark 使用；群晖无独立标题字段")),
							h("textarea", {
								className: "nt-tpl-ta", "data-tpl-edit-title": "1", value: tplEdit.title || "", disabled: busy,
								placeholder: "{{emoji}} {{status}} · {{session}}",
								ref: function (n) { if (n) tplEditNodes.current.title = n; },
								onFocus: function () { tplEditFocus.current = "title"; },
								onChange: function (e) { setTplEditField("title", e.target.value); }
							})
						]),
						h("label", { className: "nt-field" }, [
							h("span", { className: "nt-flabel" }, "正文模板", h("span", { className: "nt-hint" }, "最大 " + tplMeta.limits.body + " 字符；可用 {{body}} 嵌旧版完整正文")),
							h("textarea", {
								className: "nt-tpl-ta", "data-tpl-edit-body": "1", value: tplEdit.body || "", disabled: busy,
								placeholder: "{{body}}",
								ref: function (n) { if (n) tplEditNodes.current.body = n; },
								onFocus: function () { tplEditFocus.current = "body"; },
								onChange: function (e) { setTplEditField("body", e.target.value); }
							})
						])
					]),
					react.createElement(PlaceholderPicker, { placeholders: tplMeta.placeholders, busy: busy, onInsert: function (key, field) { tplEditInsert(key, field); } }),
					h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
						h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, "data-tpl-edit-save": "1", onClick: saveTplEdit }, "保存模板"),
						h("button", { type: "button", className: "nt-btn", disabled: busy, "data-tpl-edit-cancel": "1", onClick: cancelTplEdit }, "取消"),
						h("span", { className: "nt-hint" }, isNew ? "新模板保存后出现在列表，可分配给设备" : "内置模板可编辑内容；不可删除")
					]),
					tplEditNotes.length ? h("div", { className: "nt-pay-grid" }, tplEditNotes.map(function (x, i) { return h("span", { className: "nt-pay-note", key: "te" + i }, x); })) : null
				]);
			}
			function templateLibEl() {
				var pick = tplEdit || serverTemplates[0] || null;
				return h("div", { className: "nt-split", key: "tplsplit" }, [
					h("div", { className: "nt-list", key: "list" }, [
						h("div", { className: "nt-list-h" }, [
							h("span", null, "模板库"),
							h("span", { className: "nt-hint" }, serverTemplates.length + " 条"),
							h("button", {
								type: "button", className: "nt-btn nt-btn-sm", disabled: busy || !!tplEdit,
								"data-template-add": "1", onClick: startNewTemplate
							}, "＋ 新增")
						]),
						serverTemplates.map(function (t) {
							var on = !!(tplEdit && tplEdit.id === t.id);
							return h("button", {
								type: "button", className: "nt-li", key: t.id, "data-template-edit": t.id, "data-template": t.id,
								"data-on": on ? "true" : "false", disabled: busy,
								title: on ? "再点一下收起编辑" : "编辑这条模板",
								onClick: function () { if (on) cancelTplEdit(); else startEditTemplate(t); }
							}, [
								h("span", { className: "nt-li-t" }, [
									h("span", { className: "t" }, (t.emoji ? t.emoji + " " : "") + t.name),
									h("span", { className: "nt-pill nt-pill-neutral" }, t.builtin ? "内置" : "自定义")
								]),
								h("span", { className: "nt-li-m" }, [
									h("span", null, (t.usedBy || []).length + " 台在用"),
									h("code", { className: "nt-id" }, t.id)
								])
							]);
						}),
						h("div", { className: "nt-list-foot" }, h("span", { className: "nt-hint" }, "内置两条始终存在，不可删；一个模板可被多台共用"))
					]),
					h("div", { className: "nt-ed", key: "ed" }, tplEdit ? templateEditorEl() : h("div", { className: "nt-ed-empty" }, [
						h("span", { className: "nt-ed-empty-t", key: "t" }, "选一条模板开始编辑"),
						h("span", { className: "nt-hint", key: "h" }, "点左侧模板名即可编辑，右侧是它的实时预览；也可以点「＋ 新增」建一条自己的")
					])),
					h("div", { className: "nt-pv", key: "pv" }, [
						h("div", { className: "nt-pv-h" }, [
							h("span", { className: "nt-h" }, "实时预览"),
							h("span", { className: "nt-hint" }, tplEdit ? "编辑中" : "所选模板")
						]),
						h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
							h("button", {
								type: "button", className: "nt-btn nt-btn-solid", disabled: busy, "data-tpl-lib-preview": "1",
								onClick: function () {
									var dev = previewDeviceOf();
									setTplLibPrev({ pending: true });
									props.preview({ deviceId: dev ? dev.id : undefined, templateId: pick ? pick.id : undefined, type: "task.done" }).then(function (res) {
										if (res && res.ok && res.value) setTplLibPrev(res.value); else setTplLibPrev({ error: errText(res, "预览失败") });
									}, function () { setTplLibPrev({ error: "预览失败（请求被拒/断链）" }); });
								}
							}, "预览实际发送（与发送同源）")
						]),
						tplPreviewBox(tplLibPrev),
						pick ? livePreviewEl(pick, previewDeviceOf(), "编辑示意（非最终；最终以上方服务端预览为准）", prevSample) : h("div", { className: "nt-hint" }, "还没有模板"),
						h("label", { className: "nt-chk", key: "sample" }, [
							h("input", {
								type: "checkbox", checked: prevSample,
								onChange: function (e) { setPrevSample(!!e.target.checked); }
							}),
							h("span", { className: "nt-hint" }, "用示例内容预览（真实运行时标题/正文为空）")
						])
					])
				]);
			}
			//   口径：**仅同类型组内**（不跨组，跨组拖放**拒绝并提示**）；排序真值 ＝ 服务端 `order`（组内 1..N）
			//   ⇒ 显示按（组序, order）；拖动结束 ⇒ 调 RPC `reorderDevices({kind, ids})`（服务端校验"该组全集的不重复排列"）。
			var KIND_ORDER = ["bark", "synology"];
			var KIND_LABEL = { bark: "BARK", synology: "群晖" };
			var groupKinds = KIND_ORDER.slice();
			devices.forEach(function (d) { if (groupKinds.indexOf(d.kind) < 0) groupKinds.push(d.kind); }); // 未知 kind 兜底成组（不静默丢）
			var rankOf = function (k) { var i = KIND_ORDER.indexOf(k); return i < 0 ? 9 : i; };
			var orderedDevices = devices.slice().sort(function (a, b) {
				var ra = rankOf(a.kind), rb = rankOf(b.kind);
				if (ra !== rb) return ra - rb;
				var oa = typeof a.order === "number" && a.order >= 1 ? a.order : 9999;
				var ob = typeof b.order === "number" && b.order >= 1 ? b.order : 9999;
				return oa - ob;
			});
			var draggedId = null, draggedKind = null;   // 本轮拖拽手势内（不跨渲染；不额外加 hook）
			var doReorder = function (kind, ids) {
				setDragMsg("");
				props.reorderDevices({ kind: kind, ids: ids }).then(function (res) {
					if (!(res && res.ok)) setError(errText(res, "排序保存失败"));
				}, function () { setError("排序保存失败（请求被拒/断链，未生效）"); });
			};
			var dropOn = function (targetKind, targetId, e) {
				if (e && e.preventDefault) e.preventDefault();
				if (!draggedId) return;
				if (targetId && targetId === draggedId) return;   // ★落到自己身上 ⇒ **no-op**（不得空发 RPC / 不得把自己挪到尾）
				if (draggedKind !== targetKind) {   // ★跨组 ⇒ 拒绝（用户口径），如实提示、不改数据
					setDragMsg("✗ 排序只允许在同一类型组内（" + (KIND_LABEL[draggedKind] || draggedKind) + " → " + (KIND_LABEL[targetKind] || targetKind) + " 已拒绝）");
					setTimeout(function () { setDragMsg(""); }, 2500);
					return;
				}
				var ids = orderedDevices.filter(function (x) { return x.kind === targetKind; }).map(function (x) { return x.id; });
				var from = ids.indexOf(draggedId);
				if (from < 0) return;
				ids.splice(from, 1);
				var to = targetId ? ids.indexOf(targetId) : ids.length;
				if (to < 0) to = ids.length;
				ids.splice(to, 0, draggedId);
				doReorder(targetKind, ids);
			};
			/**
			 * ★件G（2026-10-06 用户令「按照甲做」）：**手机端 ↑↓ 按钮路径** ——
			 *   与拖动路径**共用同一个 `doReorder(...)`**（同一 RPC `reorderDevices`、同一 `order` 真值，**禁两套实现**）；
			 *   只做**组内相邻交换**；到组首/组尾 ⇒ 按钮 `disabled`（不触发，不静默 no-op）。
			 */
			var idsOf = function (kind) { return orderedDevices.filter(function (x) { return x.kind === kind; }).map(function (x) { return x.id; }); };
			var moveBy = function (kind, id, delta) {
				var ids = idsOf(kind);
				var i = ids.indexOf(id), j = i + delta;
				if (i < 0 || j < 0 || j >= ids.length) return;
				var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
				doReorder(kind, ids);
			};
			/** 该行在**本组内**的下标 / 组长度（供 ↑↓ 边界置灰） */
			var groupIdx = function (kind, id) { return idsOf(kind).indexOf(id); };
			var groupLen = function (kind) { return idsOf(kind).length; };
			/**
			 * ★件G：组头「当前生效配置」摘要（**真值来自服务端 `options`**，不是占位）——
			 *   bark ⇒ `超时 {h}s · 重试 {n} · 并发 {c}`。
			 * ★件J-乙（2026-10-08）：群晖 ⇒ `超时 {h}s · 重试 {n} · 并发 {c} · 逐页 1.5s`
			 *   —— 与 bark **同构**（前 3 段），**并保留既有已上线的「逐页 1.5s」信息**（并发只作用于多台之间，
			 *   每台内部仍逐页 1500ms ⇒ 该信息仍然为真，**不得静默删**）。
			 */
			var effText = function (kind) {
				var o = (typeof serverOptions === "object" && serverOptions) ? serverOptions : DEFAULT_OPTIONS;
				var h = Math.round((kind === "bark" ? o.barkTimeoutMs : o.synologyTimeoutMs) / 1000);
				var r = kind === "bark" ? o.barkRetries : o.synologyRetries;
				if (kind === "bark") return "超时 " + h + "s · 重试 " + r + " · 并发 " + o.barkConcurrency;
				return "超时 " + h + "s · 重试 " + r + " · 并发 " + o.synologyConcurrency + " · 逐页 1.5s";
			};
			/** v0.9.3：渠道表一行（表格网格；编辑/参数/模板覆盖全在右侧抽屉里） */
			var deviceRowEl = function (dev) {
				var on = dev.enabled !== false;
				var gi = groupIdx(dev.kind, dev.id), gl = groupLen(dev.kind);
				var tplName = (dev.tpl && dev.tpl.effectiveName) || "默认";
				var renaming = renameId === dev.id;
				return h(react.Fragment, { key: dev.id }, [
					h("div", {
						className: "nt-tr", "data-off": on ? "false" : "true", "data-dev-row": dev.id, "data-dev": dev.id,
						onDragOver: function (e) { if (e && e.preventDefault) e.preventDefault(); },
						onDrop: function (e) { if (e && e.stopPropagation) e.stopPropagation(); dropOn(dev.kind, dev.id, e); }
					}, [
						h("span", { className: "c-name" }, [
							h("span", {
								className: "nt-sort", "data-sort": dev.id, "data-ord-row": dev.id, draggable: "true", title: "拖动排序（仅本类型组内；跨组会被拒绝）",
								onDragStart: function () { draggedId = dev.id; draggedKind = dev.kind; },
								onDragEnd: function () { draggedId = null; draggedKind = null; }
							}, [
								h("span", { className: "nt-grip", "data-grip": dev.id, "aria-hidden": "true" }, h("svg", { key: "g", viewBox: "0 0 10 16", width: 9, height: 14, fill: "currentColor" }, [
									h("circle", { key: "1", cx: 3, cy: 3, r: 1.2 }), h("circle", { key: "2", cx: 7, cy: 3, r: 1.2 }),
									h("circle", { key: "3", cx: 3, cy: 8, r: 1.2 }), h("circle", { key: "4", cx: 7, cy: 8, r: 1.2 }),
									h("circle", { key: "5", cx: 3, cy: 13, r: 1.2 }), h("circle", { key: "6", cx: 7, cy: 13, r: 1.2 })
								])),
								h("button", {
									type: "button", className: "nt-ordbtn", "data-ord": "up", disabled: busy || gi <= 0,
									title: "上移（仅本类型组内）", "aria-label": "上移 " + (dev.name || dev.id),
									onClick: function () { moveBy(dev.kind, dev.id, -1); }
								}, "↑"),
								h("button", {
									type: "button", className: "nt-ordbtn", "data-ord": "down", disabled: busy || gi < 0 || gi >= gl - 1,
									title: "下移（仅本类型组内）", "aria-label": "下移 " + (dev.name || dev.id),
									onClick: function () { moveBy(dev.kind, dev.id, 1); }
								}, "↓")
							]),
							renaming
								? h("input", {
									className: "rename-in", defaultValue: dev.name || dev.id, disabled: busy,
									"data-rename-input": dev.id, "aria-label": "设备名称",
									ref: function (n) {
										if (!n) return;
										renameRef.current = n;
										setTimeout(function () { try { n.focus(); n.select(); } catch (e) {} }, 0);
									},
									onKeyDown: function (e) {
										if (e.key === "Enter") { e.preventDefault(); if (e.target.blur) e.target.blur(); }
										else if (e.key === "Escape") { e.preventDefault(); renameCancelRef.current = true; setRenameId(null); }
									},
									onBlur: function (e) {
										if (renameCancelRef.current) { renameCancelRef.current = false; return; }
										commitRename(dev, e.target.value);
									}
								})
								: h("span", {
									className: "nt-name", title: "双击改名",
									onDoubleClick: function () { if (!busy) setRenameId(dev.id); }
								}, dev.name || dev.id),
							h("code", { className: "nt-id" }, dev.id),
							renaming ? null : h("button", {
								type: "button", className: "nt-pen", "data-rename": dev.id, disabled: busy,
								title: "改名（也可双击名称）", "aria-label": "改名 " + (dev.name || dev.id),
								onClick: function () { setRenameId(dev.id); }
							}, h("svg", { key: "i", viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, [
								h("path", { key: "p", d: "M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" })
							]))
						]),
						h("span", { className: "c-kind" }, kindBadge(dev.kind)),
						h("span", { className: "c-tpl", "data-dev-template-name": dev.id, title: "本设备实际生效的模板" }, tplName + (dev.tpl && dev.tpl.missing ? "（回落）" : "")),
						h("span", { className: "c-url" }, h("code", { className: "nt-tail", title: "只回显尾号，明文永不下发" }, dev.urlTail || "—")),
						h("span", { className: "c-sw" }, h("button", {
							type: "button", className: "nt-switch", disabled: busy,
							"data-on": on ? "true" : "false", "aria-pressed": on ? "true" : "false",
							title: on ? "点击停用该设备" : "点击启用该设备",
							onClick: function () { toggleDevice(dev); }
						})),
						h("span", { className: "c-act" }, [
							h("button", { type: "button", className: "nt-btn nt-btn-sm", disabled: busy, "data-test": dev.id, onClick: function () { runTest(dev); } }, "测试"),
							h("button", {
								type: "button", className: "nt-btn nt-btn-sm", disabled: busy, "data-edit-dev": dev.id,
								onClick: function () { setAddOpen(false); startEdit(dev); }
							}, "编辑"),
							h("button", { type: "button", className: "nt-btn nt-btn-sm nt-btn-danger", disabled: busy, "data-del-dev": dev.id, onClick: function () { removeDevice(dev); } }, "删除")
						])
					]),
					tests[dev.id] ? h("div", { className: "nt-tr-note", key: "r" }, resultEl(dev)) : null
				]);
			};
			/** v0.9.3 组块：组头（类型胶囊 ＋ 规模 ＋ 生效摘要 ＋ 添加）→ 表头 → 行 */
			var TABLE_HEAD = ["名称", "类型", "当前模板", "URL", "启用", "操作"];
			var groupBlock = function (kind) {
				var g = orderedDevices.filter(function (d) { return d.kind === kind; });
				var onN = g.filter(function (d) { return d.enabled !== false; }).length;
				return h("div", {
					className: "nt-group", key: "grp-" + kind, "data-group": kind,
					onDragOver: function (e) { if (e && e.preventDefault) e.preventDefault(); },
					onDrop: function (e) { dropOn(kind, null, e); }
				}, [
					h("div", { className: "nt-group-h" }, [
						kindBadge(kind),
						h("span", { className: "nt-group-n", key: "n" }, h("span", { className: "nt-hint" }, g.length + " 台 · 启用 " + onN)),
						h("span", { className: "nt-effpill", "data-eff": kind, title: "全局参数在「高级 › 全局参数」里改" }, effText(kind)),
						h("button", {
							type: "button", className: "nt-btn nt-btn-sm", style: { marginLeft: "auto" }, disabled: busy,
							"data-add-kind": kind, title: "在「" + kindLabel(kind) + "」组新增渠道",
							onClick: function () { openAdd(kind); }
						}, "＋ 添加设备")
					]),
					h("div", { className: "nt-tr nt-th" }, TABLE_HEAD.map(function (t, idx) {
						return h("span", { key: t, style: idx === TABLE_HEAD.length - 1 ? { textAlign: "right" } : null }, t);
					})),
					g.length ? g.map(deviceRowEl) : h("div", { className: "nt-hint", style: { padding: "10px 14px" } }, "（本类型暂无渠道）")
				]);
			};
			var deviceRows = devices.length ? groupKinds.map(groupBlock) : [];


			// ---- ② 添加设备 (本次不改) ----
			var addEl = h("div", { className: "nt-add" }, [
				h("label", { className: "nt-field" }, [
					h("span", { className: "nt-flabel" }, "名称"),
					h("input", {
						className: "nt-input", value: addForm.name, disabled: busy, placeholder: "例如：我的手机",
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { name: e.target.value })); }
					}),
					addErrs.name ? h("span", { className: "nt-err" }, addErrs.name) : null
				]),
				h("label", { className: "nt-field" }, [
					h("span", { className: "nt-flabel" }, "类型 kind"),
					h("select", {
						className: "nt-input", value: addForm.kind, disabled: busy,
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { kind: e.target.value })); }
					}, KINDS.map(function (k) { return h("option", { key: k.id, value: k.id }, k.label); }))
				]),
				h("label", { className: "nt-field", style: { gridColumn: "1/-1" } }, [
					h("span", { className: "nt-flabel" }, "完整 URL（含 key / webhook，仅上行）"),
					h("input", {
						className: "nt-input", type: "password", value: addForm.url, disabled: busy,
						placeholder: "https://api.day.app/…（Bark）或群晖 webhook URL",
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { url: e.target.value })); }
					}),
					addErrs.url ? h("span", { className: "nt-err" }, addErrs.url) : null
				]),
				h("div", { className: "nt-acts" }, [
					h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, onClick: submitAdd }, "+ 添加设备"),
					h("span", { className: "nt-hint" }, "id 由服务端自动生成（bark1… / chat…）、enabled 默认 true；保存后列表只显示尾号")
				])
			]);

			// ---- ③ 通知项目 (契约 §5: 分组 / 三态 / 实际发往 / 预留类型折叠) ----
			function segEl(type, v, text, mode) {
				return h("button", {
					type: "button", key: v, "data-v": v, "data-seg": type,
					"data-on": mode === v ? "true" : "false", disabled: busy,
					onClick: function () { setRowMode(type, v); }
				}, text);
			}
			function rowEl(ty) {
				var type = ty.type;
				var mode = modeFromRoutes(draftRoutes, type);
				var eff = rowEffIds(type, mode);
				var emoji = emojiOf(type);
				var label = ty.label || type;
				var effText = mode === "off"
					? "不推送（该类型已关闭）"
					: deviceNamesOf(devices, eff) + "（" + eff.length + " 台" + (mode === "default" ? " · 继承默认路由" : "") + "）";
				var rowNote = ROW_NOTES[type];
				return h("div", { className: "nt-item", key: type, "data-mode": mode }, [
					h("span", { className: "nt-t" }, emoji ? emoji + " " + label : label),
					h("code", { className: "nt-rt-type" }, type),
					mode === "custom" ? h("span", { className: "nt-chips" }, devices.map(function (dev) {
						var on = eff.indexOf(dev.id) >= 0;
						var inherit = mode === "default";
						var dead = dev.enabled === false;
						return h("button", {
							type: "button", key: dev.id, className: "nt-chip",
							disabled: busy || mode === "off" || dead,
							"data-on": on ? "true" : "false",
							"data-inherit": inherit ? "true" : undefined,
							"data-dead": dead ? "true" : undefined,
							"data-t": type, "data-d": dev.id,
							title: inherit ? "继承默认路由（只读）：改默认路由见最下方高级" : (dead ? "该设备已停用" : ""),
							onClick: function () { toggleRowChip(type, dev.id); }
						}, [h("span", { className: "nt-dot", key: "d" }), dev.name || dev.id]);
					})) : null,
					h("span", { className: "nt-seg" }, [
						segEl(type, "default", "默认", mode),
						segEl(type, "custom", "自选", mode),
						segEl(type, "off", "关闭", mode)
					]),
					h("span", { className: "nt-eff" }, [
						"实际发往：",
						h("b", null, effText),
						rowNote ? " · " + rowNote : null
					])
				]);
			}
			/** 预留类型行 (hasProducer===false): 只标注, 不可交互。 */
			function reservedRowEl(ty) {
				var emoji = emojiOf(ty.type);
				var label = ty.label || ty.type;
				return h("div", { className: "nt-item", key: ty.type, "data-mode": "off" }, [
					h("span", { className: "nt-t" }, emoji ? emoji + " " + label : label),
					h("code", { className: "nt-rt-type" }, ty.type),
					h("span", { className: "nt-mark warn" }, "暂无来源"),
					h("span", { className: "nt-eff" }, "代码里查不到调用方（Stage 1 预留），本次只做标注，不删 key 以免将来接线时丢配置")
				]);
			}
			var activeTypes = types.filter(function (t) { return t && t.type && hasProducerOf(t); });
			var reservedTypes = types.filter(function (t) { return t && t.type && t.hasProducer === false; });
			var usedType = {};
			var grouped = GROUPS.map(function (g) {
				var rows = activeTypes.filter(function (t) {
					if (usedType[t.type] || !g.match(t.type)) return false;
					usedType[t.type] = true;
					return true;
				});
				return { title: g.title, rows: rows };
			});
			// 未知但有生产者的 type ⇒ 兜底归「其它」, 避免服务端新增 type 时静默消失
			var leftovers = activeTypes.filter(function (t) { return !usedType[t.type]; });
			if (leftovers.length) grouped[OTHER_GROUP].rows = grouped[OTHER_GROUP].rows.concat(leftovers);

			// ★件F：段头改由外层「默认收起的折叠容器」承载（`summary`），此处不再重复渲染段头
			var typeSection = h(react.Fragment, null, [
				grouped.map(function (g) {
					if (!g.rows.length) return null;
					return h("div", { className: "nt-grp", key: g.title },
						[h("div", { className: "nt-grp-h", key: "t" }, g.title)].concat(g.rows.map(rowEl)));
				}),
				reservedTypes.length ? h("details", { className: "nt-details", key: "reserved" }, [
					h("summary", null, [
						h("span", { className: "nt-arr", key: "a" }, ""),
						"预留类型（当前",
						h("b", { key: "b" }, "无任何生产者"),
						"，永不触发 · 点开看一眼）"
					]),
					h("div", { className: "nt-grp", style: { marginTop: 7 } }, reservedTypes.map(reservedRowEl))
				]) : null
			]);

			// ---- ④ 触发条件 (options) ----
			var stale = staleOpts || staleHost;
			// ★件F：段头改由外层「默认收起的折叠容器」承载（`summary`），此处不再重复渲染段头
			// ---- ★件I/J-甲（2026-10-07）「全局参数」折叠区：输入界面（★件J-乙 起 6 键）（**离开输入框才保存** · 键入期零定时器 · 夹取如实报）----
			// 范围（用户口径）：bark＝超时/重试/并发；群晖＝超时/重试/并发（**★件J-乙 2026-10-08 起开并发**；
			//   用户原口径「同一类型共享参数」⇒ 与 bark 同构）；同类型共享一份、两组各自全局。
			var GLOBAL_OPTS_META = [
				{ group: "bark", label: "Bark", keys: [
					{ key: "barkTimeoutMs", label: "超时", unit: "ms", min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS, step: 1000 },
					{ key: "barkRetries", label: "重试次数", unit: "次", min: 0, max: RETRIES_MAX, step: 1 },
					{ key: "barkConcurrency", label: "并发数", unit: "路", min: CONC_MIN, max: CONC_MAX, step: 1 }
				] },
				{ group: "synology", label: "群晖", keys: [
					{ key: "synologyTimeoutMs", label: "超时", unit: "ms", min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS, step: 1000 },
					{ key: "synologyRetries", label: "重试次数", unit: "次", min: 0, max: RETRIES_MAX, step: 1 },
					// ★件J-乙（2026-10-08）：群晖**开并发**（默认 1 ＝ 逐台串行）；**并发只作用于多台之间，每台内部仍逐页 1.5s**
					{ key: "synologyConcurrency", label: "并发数", unit: "路", min: CONC_MIN, max: CONC_MAX, step: 1 }
				] }
			];
			function optMetaOf(key) {
				for (var gi = 0; gi < GLOBAL_OPTS_META.length; gi++) {
					var m = GLOBAL_OPTS_META[gi].keys.filter(function (x) { return x.key === key; })[0];
					if (m) return m;
				}
				return null;
			}
			/** 提交**单个键**（服务端 `setOptions` 逐键透传、其余保持原值 ⇒ **不动就不写**）。**只由 blur 触发**。
			 *  ★`#A547` (b)：补**"不动就不写"守卫** —— 原来只有"注释说不动就不写、代码里没有守卫"：
			 *  **只要焦点经过该框（Tab 路过 / 点别的框导致它 blur）就会把它"当前原值"再写一遍盘**
			 *  （VM 真浏览器臂实测：一趟里同型写了 2 次，载荷逐字 `{"barkRetries":1}` ＝ 未改动键）。
			 *  与 `commitSecNow` 的 `sec*1000 === serverOptions.minTurnMs` 守卫**同口径**；
			 *  **夹取后与原值相同 ⇒ 不写也不报"已保存"**（本来就是原值，报"已保存"是噪声）。 */
			function commitOpt5(key, text) {
				var meta = optMetaOf(key);
				var label = meta ? meta.label : key;
				var num = Number(String(text).trim());
				if (String(text).trim() === "" || !isFinite(num)) {
					setOptMsg5({ kind: "err", text: "「" + label + "」请输入数字（未提交，服务端未改动）" });
					return;
				}
				// ★`#A547` (b)：**不动就不写** —— 与"当前服务端生效值"比对（夹取后比对，越界但夹回原值也算不动）
				var _cur = (typeof serverOptions === "object" && serverOptions) ? serverOptions[key] : undefined;
				var _eff = meta ? Math.min(meta.max, Math.max(meta.min, Math.round(num))) : num;
				if (typeof _cur === "number" && _eff === _cur) {
					optDraft5.current[key] = String(_cur);
					var _n0 = optNodes5.current[key];
					if (_n0 && String(_n0.value) !== String(_cur)) _n0.value = String(_cur);
					return;
				}
				setBusy(true);
				var payload = {};
				payload[key] = num;
				props.setOptions(payload).then(function (res) {
					setBusy(false);
					if (!(res && res.ok)) {
						setStaleOpts(true);
						setOptMsg5({ kind: "err", text: "保存失败：host 插件未更新或端点不可用（服务端未改动）" });
						return;
					}
					var got = (res.value && res.value.options) ? normalizeOptions(res.value.options) : null;
					var clamped = got ? got[key] : null;
					delete optDraft5.current[key];
					// ★件J-甲：服务端回读**只**在"该框此刻未聚焦"时写回 DOM；**正在输入的框一律不碰**。
					if (clamped !== null) {
						optDraft5.current[key] = String(clamped);
						if (optFocus5.current !== key) {
							var node = optNodes5.current[key];
							if (node && String(node.value) !== String(clamped)) node.value = String(clamped);
						}
					}
					if (clamped !== null && clamped !== num) {
						setOptMsg5({ kind: "clamp", text: "已夹取：「" + label + "」" + num + " → " + clamped + (meta ? "（允许 " + meta.min + "–" + meta.max + "）" : "") });
					} else {
						setOptMsg5({ kind: "ok", text: "✓ 已保存：" + label + " = " + num + "（即时生效）" });
					}
				}, function () {
					setBusy(false);
					setOptMsg5({ kind: "err", text: "保存失败（网络/服务端异常，服务端未改动）" });
				});
			}
			/** 键入期：**只把文本记进 ref**（零 setState／零定时器／零 DOM 回写 ⇒ 不打断输入）。 */
			function onOptInput5(key) {
				return function (e) { optDraft5.current[key] = e.target.value; };
			}
			/** **离开输入框（blur）⇒ 此刻才提交该键**（用户硬口径：没离开输入框就不打断）。 */
			function onOptBlur5(key) {
				return function (e) {
					if (optFocus5.current === key) optFocus5.current = null;
					var text = (e && e.target) ? e.target.value : undefined;
					if (text === undefined) text = optDraft5.current[key];
					commitOpt5(key, text);
				};
			}
			var globalsSection = h(react.Fragment, null, [
				h("div", { className: "nt-opts", "data-opts-globals": "1", key: "g" }, GLOBAL_OPTS_META.map(function (g) {
					return h("div", { className: "nt-optgroup", key: g.group, "data-optgroup": g.group }, [
						h("span", { className: "nt-optgroup-h", key: "h" }, g.label + "（同类型共享一份 · 离开输入框即保存）"),
						h("div", { className: "nt-opts", key: "b" }, g.keys.map(function (m) {
							return h("label", { className: "nt-opt", key: m.key }, [
								m.label + " ",
								h("input", {
									className: "nt-input", type: "number", min: m.min, max: m.max, step: m.step,
									"data-opt": m.key, "aria-label": g.label + " " + m.label,
									// ★件J-甲：**非受控**（`defaultValue`）—— 受控 `value` 会被 React 在每次重渲染时强制回写 DOM
									//   （键入中会被服务端回读值/任何重渲染顶掉）⇒ 输入期值只在 DOM 里，提交与回读写回均由本组件显式控制。
									defaultValue: String(serverOptions[m.key] === undefined || serverOptions[m.key] === null ? "" : serverOptions[m.key]),
									// ★件J-甲：**不再随 `busy` 禁用** —— `disabled` 一旦落到正在输入的框上，浏览器会立即失焦（手机＝键盘收起）
									//   ⇒ 这正是"被打断"的第二条路径（件I 每次防抖保存都会 busy ⇒ 正在打的框被夺焦）。
									//   ★T52 起：6 键框与阈值框**都**只由 blur 提交 ⇒ 一律无需禁用。
									ref: function (n) { if (n) optNodes5.current[m.key] = n; },
									onChange: onOptInput5(m.key),
									onFocus: function () { optFocus5.current = m.key; },
									onBlur: onOptBlur5(m.key)
								}),
								" " + m.unit,
								h("span", { className: "nt-hint" }, "允许 " + m.min + "–" + m.max)
							]);
						}))
					]);
				})),
				optMsg5 ? h("div", { className: "nt-hint" + (optMsg5.kind === "err" ? " nt-warn" : ""), "data-optmsg": optMsg5.kind, key: "m" }, optMsg5.text) : null
			]);

			var optionsSection = h(react.Fragment, null, [
				h("div", { className: "nt-opts", key: "o" }, [
					h("label", { className: "nt-opt" }, [
						"回合耗时阈值 ",
						// ★T52（2026-10-08，`#A544` ③「甲′」）：与 5 键框**同构** ——
						//   ① **非受控** `defaultValue`（受控 `value` 会被 React 在每次重渲染时把服务端回读值写回 DOM）
						//   ② 键入期 **零 setState／零定时器／零 DOM 回写**（只写 `secDraftRef`）
						//   ③ **提交点 ＝ blur ／ 收起面板兜底**（`onBlur` ＋ `commitSecNow`）
						//   ④ **不随 `busy` 禁用**（`disabled` 落到正在输入的框 ⇒ 立即失焦＝手机键盘收起）
						h("input", {
							className: "nt-input", type: "number", min: 0, max: MIN_SEC_MAX, step: 1,
							defaultValue: String(Math.round(serverOptions.minTurnMs / 1000)),
							ref: function (n) { if (n) secNodeRef.current = n; },
							onChange: function (e) { secDraftRef.current = e.target.value; },   // ★只记文本，不渲染
							onFocus: function () { secFocusedRef.current = true; },
							onBlur: function () {
								secFocusedRef.current = false;
								commitSecNow();                                                 // ★离开输入框 ⇒ 此刻才提交
							}
						}),
						" 秒",
						h("span", { className: "nt-hint" }, "短于该时长的回合不推\"对话完成\"（提问推送不受限制）· 离开输入框即保存")
					]),
					h("label", { className: "nt-opt" }, [
						h("input", {
							type: "checkbox", className: "nt-cb", checked: draftBanner, disabled: busy,
							onChange: function (e) { setDraftBanner(e.target.checked); }
						}),
						" 回复含\"总结\"段落时，在会话内注入横幅（本地提醒，不推送）"
					]),
					h("label", { className: "nt-opt" }, [
						h("input", {
							type: "checkbox", className: "nt-cb", checked: draftReconcile, disabled: busy,
							onChange: function (e) { setDraftReconcile(e.target.checked); }
						}),
						" 容器重启后补推被中断的回合（去重，不重复打扰）"
					])
				]),
				stale ? h("div", { className: "nt-hint nt-warn", key: "w" }, OPTIONS_RPC_HINT) : null
			]);

			// ---- ⑤ 高级折叠区 (routeDefault 胶囊可点, 参与保存) ----
			var advancedSection = h("details", { className: "nt-details" }, [
				h("summary", null, [
					h("span", { className: "nt-arr", key: "a" }, ""),
					"高级：默认路由 / 原始配置（排障用）"
				]),
				h("div", { style: { marginTop: 7, display: "flex", flexDirection: "column", gap: 7 } }, [
					h("div", { className: "nt-item" }, [
						h("code", { className: "nt-rt-type" }, "routeDefault"),
						h("span", { className: "nt-hint" }, "\"默认\"态的行走这里"),
						h("span", { className: "nt-chips" }, devices.map(function (dev) {
							var on = draftDefault.indexOf(dev.id) >= 0;
							return h("button", {
								type: "button", key: dev.id, className: "nt-chip", disabled: busy,
								"data-on": on ? "true" : "false",
								onClick: function () { toggleDefault(dev.id); }
							}, [h("span", { className: "nt-dot", key: "d" }), dev.name || dev.id]);
						})),
						h("span", { className: "nt-mark ok" }, "已勾 " + draftDefault.length + " 台"),
						h("span", { className: "nt-eff" }, [
							"当前默认路由：",
							h("b", null, deviceNamesOf(devices, draftDefault)),
							"（为空则 = 发全部启用设备）"
						])
					]),
					h("div", { className: "nt-hint" }, [
						"写盘位置 ",
						h("code", null, "插件数据目录下的 notify-hub.json"),
						"（0600，dsh-notify 写 / auth-proxy 读）；本卡改动",
						h("b", null, "无需重启"),
						"即时生效。"
					])
				])
			]);

			// ---- v0.9.1: 模板库折叠区 + 「内部默认配置」只读折叠区 ----
			var tplLibSection = templateLibEl();
			var internalDefaultsSection = defaultsView ? h(react.Fragment, null, [
				h("div", { className: "nt-note", key: "n" }, [
					h("b", null, "只读："),
					"以下是当前运行态的内部默认值（用户要求「把内部 Bark/群晖 配置当默认配置暴露出来」）。",
					"密钥不会出现在这里 —— 设备只显示尾号。"
				]),
				h("div", { className: "nt-defs", key: "d", "data-defaults-view": "1" }, [
					h("div", null, ["Bark 默认图标：", h("code", null, String((defaultsView.bark && defaultsView.bark.icon) || tplMeta.defaultBarkIcon))]),
					h("div", null, ["Bark 默认：前缀 ", h("code", null, String((defaultsView.bark && defaultsView.bark.titlePrefix) || "[DSH] ")), " · isArchive ", h("code", null, String((defaultsView.bark && defaultsView.bark.isArchive) ?? 1))]),
					h("div", null, ["超时/重试/并发：Bark ", h("code", null, String((defaultsView.delivery && defaultsView.delivery.barkTimeoutMs) || "?") + "ms / " + String((defaultsView.delivery && defaultsView.delivery.barkRetries) ?? "?") + " / " + String((defaultsView.delivery && defaultsView.delivery.barkConcurrency) ?? "?")), " · 群晖 ", h("code", null, String((defaultsView.delivery && defaultsView.delivery.synologyTimeoutMs) || "?") + "ms / " + String((defaultsView.delivery && defaultsView.delivery.synologyRetries) ?? "?") + " / " + String((defaultsView.delivery && defaultsView.delivery.synologyConcurrency) ?? "?"))]),
					h("div", null, ["群晖分页：", h("code", null, String((defaultsView.delivery && defaultsView.delivery.synologyPageLimit) || 2000)), " 字符/条 · 页间隔 ", h("code", null, String((defaultsView.delivery && defaultsView.delivery.synologyPageIntervalMs) || 1500)), "ms"]),
					h("div", null, ["设备预设结构：", h("code", null, (Array.isArray(defaultsView.devices) ? defaultsView.devices : []).map(function (x) { return (x.name || x.id) + "(" + x.kind + ")"; }).join("、") || "（无）")]),
					h("div", null, ["默认路由：", h("code", null, (Array.isArray(defaultsView.routeDefault) && defaultsView.routeDefault.length ? defaultsView.routeDefault.join(", ") : "（空 = 全部启用设备）"))]),
					h("div", null, ["写盘位置：", h("code", null, String(defaultsView.source || "插件数据目录下的 notify-hub.json"))])
				])
			]) : h("div", { className: "nt-hint" }, "旧 host 未返回 defaults（重启 dsh web 后可见）");

			// 优先级: 失败 > 保存中 > 已保存 > 静止提示 (避免「已保存」闪烁遮住随后的失败信息)
			var live = error
				? h("span", { className: "nt-st failed nt-save-cap" }, "✗ " + error)
				: busy
					? h("span", { className: "nt-st saving nt-save-cap" }, [
						// ★ `#A432` 件B：保存中 ＝ **点串每 500ms 进一点**（自有 `nt-save-*`，零官方类名）
						h("span", { key: "l" }, "保存中"),
						h("span", { className: "nt-save-dots", key: "d", "aria-hidden": "true" }, [
							// 三个点＝三个 span（第 1 点亮、第 2/3 点按 1.5s steps 循环依次亮起 ⇒ 每 500ms 前进一点）
							h("span", { className: "nt-save-dot nt-save-dot-a", key: "1" }),
							h("span", { className: "nt-save-dot nt-save-dot-b", key: "2" }),
							h("span", { className: "nt-save-dot nt-save-dot-c", key: "3" })
						])
					])
					: savedAt !== null
						? h("span", { className: "nt-st saved nt-save-cap" }, savedStale ? SAVED_STALE_TEXT : "✓ 已保存")
						: h("span", { className: "nt-hint" }, "改动即存（开关立即生效；阈值＝离开输入框即保存）；关掉本卡后不能再撤销");
			var actions = h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
				h("button", {
					type: "button", className: "nt-btn", disabled: busy || !isDirty,
					title: isDirty ? "把本次打开以来的全部改动还原为打开时的值" : "本次打开后尚未改动",
					onClick: undoAll
				}, "撤销本次改动"),
				h("button", {
					type: "button", className: "nt-btn", disabled: busy,
					onClick: function () { setError(""); setSavedStale(false); setStaleOpts(false); props.refresh(); }
				}, "重新加载"),
				live
			]);

						// ---- v0.9.3（2026-11-23，用户确认方案 A）：顶部四 Tab ＋ 右侧抽屉 ----
			var tabCounts = { channels: devices.length, templates: serverTemplates.length, routes: activeTypes.length };
			var tabsEl = h("div", { className: "nt-tabs", role: "tablist" }, [
				["channels", "渠道"], ["templates", "模板库"], ["routes", "路由"], ["advanced", "高级"], ["status", "状态"]
			].map(function (pair) {
				var k = pair[0];
				return h("button", {
					key: k, type: "button", role: "tab", className: "nt-tab", "data-tab": k,
					"aria-selected": tab === k ? "true" : "false",
					onClick: function () {
						setTab(k);
						if (k !== "channels") { setEditing(null); setAddOpen(false); }
						setRenameId(null);
					}
				}, [h("span", { key: "t" }, pair[1])].concat(tabCounts[k] ? [h("span", { className: "n", key: "n" }, String(tabCounts[k]))] : []));
			}));
			var headStatus = h("div", { className: "nt-head-r" }, [actions]);

			// 抽屉：编辑态 ＝ editing（设备存在才开）；新增态 ＝ addOpen
			var editingDev = editing ? devices.filter(function (d) { return d.id === editing.id; })[0] : null;
			var drawerOpen = !!addOpen || !!(editing && editingDev);
			var panelDev = editingDev || devices[0] || null;
			var drawerEl = h("div", { className: "nt-drawer-wrap", key: "drawer", "data-open": drawerOpen ? "true" : "false" }, [
				h("div", { className: "nt-drawer-mask", key: "mask", "data-drawer-mask": "1", onClick: closeDrawer }),
				h("aside", {
					className: "nt-drawer", key: "aside", "data-open": drawerOpen ? "true" : "false",
					"data-drawer": addOpen ? "add" : "edit", "aria-hidden": drawerOpen ? "false" : "true"
				}, [
					h("div", { className: "nt-drawer-h", key: "h" }, [
						h("span", { className: "nt-h", key: "t" }, addOpen ? "添加设备" : "编辑设备"),
						(!addOpen && editingDev) ? kindBadge(editingDev.kind) : null,
						(!addOpen && editingDev) ? h("code", { className: "nt-id", key: "id" }, editingDev.id) : null,
						h("button", {
							type: "button", key: "x", className: "nt-btn nt-btn-icon", "data-drawer-close": "1",
							"aria-label": "关闭", onClick: closeDrawer
						}, h("svg", { key: "i", viewBox: "0 0 24 24", width: 13, height: 13, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true" }, [
							h("path", { key: "p", d: "M6 6l12 12M18 6 6 18" })
						]))
					]),
					h("div", { className: "nt-drawer-b", key: "b" }, [
						// 未打开抽屉时仍渲染「正在编辑或第一台」的面板（hidden）——
						// 保持 DOM 结构与门禁可见性一致，也避免"第一次点编辑才挂载"造成的布局跳动。
						addOpen ? addEl : (panelDev ? h(react.Fragment, null, [
							drawerOpen ? editFormEl(panelDev) : null,
							h("div", { className: "nt-pay-wrap", key: "pay", "data-pay-wrap": panelDev.id, hidden: !drawerOpen }, payloadRowEl(panelDev)),
							h("div", { className: "nt-pay-wrap", key: "tpl", "data-tpl-wrap": panelDev.id, hidden: !drawerOpen }, templateRowEl(panelDev))
						]) : null)
					]),
					// v0.9.5：保存/取消固定在抽屉底部（不再随表单滚走）
					h("div", { className: "nt-drawer-f", key: "f" }, [
						h("span", { className: "nt-hint", key: "h" }, addOpen ? "新增设备：id 由服务端生成，保存后列表只显示尾号" : "服务端只回 urlTail，不回明文"),
						h("button", { type: "button", className: "nt-btn", key: "c", disabled: busy, onClick: closeDrawer }, "取消"),
						h("button", {
							type: "button", className: "nt-btn nt-btn-primary", key: "s", disabled: busy,
							"data-drawer-save": "1",
							onClick: function () { if (addOpen) submitAdd(); else submitEdit(); }
						}, addOpen ? "添加设备" : "保存设备")
					])
				])
			]);

			// ---- 2026-11-24（task-16）：当前配置与状态（只读；用户已批「配置可以暴露」） ----
			// 数据面 = 服务端 get 的 `health`（设备健康记录）+ `config`（配置元信息）+ 既有 devices/routes/effective/templates。
			// 脱敏：只显示服务端回的 urlTail / 已 sanitize 的错误详情；本组件不做任何写操作、不影响发送行为。
			var HEALTH_CLASS_CN = {
				timeout: "超时", connect: "连接失败", tls: "TLS/证书",
				http_413: "页面 413", http_4xx: "HTTP 4xx", http_5xx: "HTTP 5xx",
				protocol: "协议拒绝", unknown: "未知"
			};
			function fmtWhen(iso) {
				try { return new Date(iso).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return String(iso || "—"); }
			}
			function statusSectionEl() {
				var d0 = data || {};
				var health = d0.health && typeof d0.health === "object" ? d0.health : null;
				var cfg = d0.config && typeof d0.config === "object" ? d0.config : null;
				var hmap = {};
				if (health && Array.isArray(health.devices)) health.devices.forEach(function (x) { if (x && x.deviceId) hmap[x.deviceId] = x; });
				var errLabel = function (cls) { return cls ? (HEALTH_CLASS_CN[cls] || String(cls)) : "—"; };
				var bars = [];
				bars.push(h("div", { className: "nt-bar", key: "bar" }, [
					h("span", { className: "nt-h", key: "t" }, "当前配置与状态"),
					h("span", { className: "nt-hint", key: "h" }, "只读；密钥只显示尾号；错误分类来自最近一次真实发送记录"),
					h("span", { className: "nt-bar-r", key: "r" }, [
						h("button", {
							type: "button", className: "nt-btn", key: "refresh", "data-status-refresh": "1",
							disabled: busy, onClick: function () { try { props.refresh(); } catch (e) { /* 刷新失败保持只读 */ } }
						}, "刷新")
					])
				]));
				if (!health && !cfg) {
					bars.push(h("div", { className: "nt-hint", key: "old" }, "当前 host 未返回 health/config 字段（重启 dsh web 加载新版插件后可见）。"));
					return h("div", { className: "nt-status", "data-notify-status": "1" }, bars);
				}
				// ① 配置元信息
				if (cfg) {
					var meta = [
						["配置文件", cfg.file || "—"],
						["最后修改", cfg.mtime ? fmtWhen(cfg.mtime) : "—"],
						["hub 版本 / 插件版本", String(cfg.hubVersion ?? "?") + " / " + String(cfg.pluginVersion ?? "?")],
						["迁移标记", cfg.migratedAt ? fmtWhen(cfg.migratedAt) : "（无）"],
						["设备", String(cfg.deviceCount ?? 0) + " 台（启用 " + String(cfg.enabledCount ?? 0) + "）"],
						["模板", String(cfg.templateCount ?? 0) + " 个（自定义 " + String(cfg.customTemplateCount ?? 0) + "）"],
						["默认路由", (Array.isArray(cfg.routeDefault) && cfg.routeDefault.length) ? cfg.routeDefault.join(", ") : "（空 = 全部启用设备）"],
						["与默认差异", (function () {
							var dd = cfg.defaultsDiff || {}; var parts = [];
							if (Array.isArray(dd.options) && dd.options.length) parts.push("全局参数 " + dd.options.length + " 项已改");
							if (dd.routeDefaultIsDefault === false) parts.push("默认路由已改");
							if (Array.isArray(dd.templatesEdited) && dd.templatesEdited.length) parts.push("内置模板已改");
							if (dd.devicesWithCustomSeps) parts.push("自定义分隔符 " + dd.devicesWithCustomSeps + " 台");
							if (dd.devicesWithCustomSegs) parts.push("自定义内容段 " + dd.devicesWithCustomSegs + " 台");
							if (dd.devicesWithOverrides) parts.push("模板覆盖 " + dd.devicesWithOverrides + " 台");
							return parts.length ? parts.join(" · ") : "（全部为默认值）";
						})()],
						["健康记录", String(health && health.file || cfg.healthFile || "—") +
							(health && health.updatedAt ? " · 更新 " + fmtWhen(health.updatedAt) : "") +
							(health && health.writeError ? " · 写盘失败: " + health.writeError : "")]
					];
					bars.push(h("div", { className: "nt-status-meta", key: "meta", "data-status-meta": "1" },
						meta.map(function (pair, i) {
							return h("div", { key: "m" + i }, [h("b", null, pair[0] + "："), h("code", null, String(pair[1]))]);
						})));
				}
				// ② 设备表
				bars.push(h("div", { className: "nt-h", key: "dev-h" }, "设备"));
				bars.push(h("div", { className: "nt-status-wrap", key: "dev-wrap" }, h("table", { className: "nt-status-table", "data-status-devices": "1" }, [
					h("thead", { key: "thead" }, h("tr", null, [
						h("th", { key: "n" }, "名称"), h("th", { key: "k" }, "类型"), h("th", { key: "e" }, "启用"),
						h("th", { key: "u" }, "地址尾号"), h("th", { key: "ok" }, "最近成功"), h("th", { key: "f" }, "最近失败"),
						h("th", { key: "c" }, "错误分类"), h("th", { key: "x" }, "连续失败")
					])),
					h("tbody", { key: "tbody" }, devices.map(function (dev) {
						var st = hmap[dev.id] || null;
						var cls = st && st.lastErrorClass ? st.lastErrorClass : null;
						return h("tr", { key: "d:" + dev.id, "data-status-device": dev.id }, [
							h("td", { key: "n" }, String(dev.name || dev.id)),
							h("td", { key: "k" }, kindLabel(dev.kind)),
							h("td", { key: "e" }, dev.enabled === false ? "停用" : "启用"),
							h("td", { key: "u" }, h("code", null, String(dev.urlTail || "—"))),
							h("td", { key: "ok" }, st && st.lastOkAt ? fmtWhen(st.lastOkAt) : "—"),
							h("td", { key: "f" }, st && st.lastFailAt ? fmtWhen(st.lastFailAt) : "—"),
							h("td", { key: "c", className: cls ? "nt-status-err" : null }, cls
								? (errLabel(cls) + (st.lastErrorDetail ? "（" + st.lastErrorDetail + "）" : ""))
								: "—"),
							h("td", { key: "x" }, st && st.consecutiveFails ? String(st.consecutiveFails) : "0")
						]);
					}))
				])));
				// ③ 路由摘要（按 type：配置值 / 生效值）
				if (cfg && Array.isArray(cfg.routes)) {
					var devName = {};
					devices.forEach(function (dv) { devName[dv.id] = dv.name || dv.id; });
					var cfgLabel = { inherit: "默认（继承）", custom: "自选", off: "关闭（显式空）" };
					bars.push(h("div", { className: "nt-h", key: "route-h" }, "路由摘要"));
					bars.push(h("div", { className: "nt-status-wrap", key: "route-wrap" }, h("table", { className: "nt-status-table", "data-status-routes": "1" }, [
						h("thead", { key: "thead" }, h("tr", null, [h("th", { key: "t" }, "通知类型"), h("th", { key: "c" }, "配置"), h("th", { key: "e" }, "生效设备")])),
						h("tbody", { key: "tbody" }, cfg.routes.map(function (r) {
							return h("tr", { key: "r:" + r.type }, [
								h("td", { key: "t" }, h("code", null, String(r.type))),
								h("td", { key: "c" }, cfgLabel[r.configured] || String(r.configured || "—")),
								h("td", { key: "e" }, (Array.isArray(r.effective) ? r.effective : []).map(function (id) { return devName[id] || id; }).join(", ") || "（无）")
							]);
						}))
					])));
				}
				// ④ 模板摘要（每设备当前模板与来源）
				if (cfg && cfg.templates && Array.isArray(cfg.templates.byDevice)) {
					var srcLabel = { device: "设备覆盖", template: "所选模板", kind: "渠道默认", legacy: "旧版组稿" };
					bars.push(h("div", { className: "nt-h", key: "tpl-h" }, "模板摘要"));
					bars.push(h("div", { className: "nt-status-wrap", key: "tpl-wrap" }, h("table", { className: "nt-status-table", "data-status-templates": "1" }, [
						h("thead", { key: "thead" }, h("tr", null, [h("th", { key: "d" }, "设备"), h("th", { key: "t" }, "模板"), h("th", { key: "s" }, "正文来源"), h("th", { key: "ti" }, "标题来源")])),
						h("tbody", { key: "tbody" }, cfg.templates.byDevice.map(function (t) {
							return h("tr", { key: "t:" + t.deviceId }, [
								h("td", { key: "d" }, String(t.deviceName || t.deviceId)),
								h("td", { key: "t" }, String(t.templateName || t.templateId || "—")),
								h("td", { key: "s" }, srcLabel[t.bodySource] || String(t.bodySource || "—")),
								h("td", { key: "ti" }, srcLabel[t.titleSource] || String(t.titleSource || "—"))
							]);
						}))
					])));
				}
				return h("div", { className: "nt-status", "data-notify-status": "1" }, bars);
			}

			var channelsPane = h("div", { className: "nt-pane", key: "pane-channels", "data-pane": "channels", hidden: tab !== "channels" }, [
				h("div", { className: "nt-bar", key: "bar" }, [
					h("span", { className: "nt-h", key: "t" }, "渠道"),
					h("span", { className: "nt-hint", key: "h" }, "一行一台；参数与模板覆盖都在「编辑」抽屉里"),
					h("span", { className: "nt-bar-r", key: "r" }, [
						h("button", {
							type: "button", className: "nt-btn nt-btn-primary", disabled: busy, "data-add": "1",
							onClick: function () { openAdd(groupKinds[0] || "bark"); }
						}, "＋ 添加设备")
					])
				]),
				dragMsg ? h("div", { className: "nt-dragmsg", key: "dm", "data-dragmsg": "1" }, dragMsg) : null,
				deviceRows.length ? h("div", { className: "nt-groups", key: "g" }, deviceRows) : h("div", { className: "nt-hint", key: "g0" }, "尚未配置任何设备"),
				note
			]);

			var templatesPane = h("div", { className: "nt-pane", key: "pane-templates", "data-pane": "templates", hidden: tab !== "templates" }, templateLibEl());

			var routesPane = h("div", { className: "nt-pane", key: "pane-routes", "data-pane": "routes", hidden: tab !== "routes" }, [
				h("div", { className: "nt-bar", key: "bar" }, [
					h("span", { className: "nt-h", key: "t" }, "路由"),
					h("span", { className: "nt-hint", key: "h" }, "逐项独立：关闭 = 写显式空路由（不再回落默认）；选「自选」后可点设备胶囊"),
					h("span", { className: "nt-bar-r", key: "r" }, h("span", { className: "nt-pill nt-pill-success" }, [h("span", { className: "nt-dot", key: "d" }), "改动即存"]))
				]),
				typeSection
			]);

			var statusPane = h("div", { className: "nt-pane", key: "pane-status", "data-pane": "status", hidden: tab !== "status" }, [
				statusSectionEl()
			]);

			var advancedPane = h("div", { className: "nt-pane", key: "pane-advanced", "data-pane": "advanced", hidden: tab !== "advanced" }, [
				h("div", { className: "nt-bar", key: "bar" }, [
					h("span", { className: "nt-h", key: "t" }, "高级"),
					h("span", { className: "nt-hint", key: "h" }, "平时不用看；全局参数、默认路由、内部默认值都在这里")
				]),
				h("details", { className: "nt-acc", key: "fold-globals", "data-fold": "globals" }, [
					h("summary", null, [
						"全局参数",
						h("span", { className: "nt-tag" }, GLOBAL_OPTS_META.reduce(function (n, g) { return n + g.keys.length; }, 0) + " 键"),
						h("span", { className: "nt-hint" }, "bark／群晖 各自一份；离开输入框即保存")
					]),
					h("div", { className: "nt-acc-b" }, globalsSection)
				]),
				h("details", { className: "nt-acc", key: "fold-options", "data-fold": "options" }, [
					h("summary", null, [
						"触发条件",
						h("span", { className: "nt-tag" }, "options"),
						h("span", { className: "nt-hint" }, "原来只写在 cordis.patch.yml 的项；改完即时生效")
					]),
					h("div", { className: "nt-acc-b" }, optionsSection)
				]),
				advancedSection,
				h("details", { className: "nt-acc", key: "fold-internal-defaults", "data-fold": "internal-defaults" }, [
					h("summary", null, [
						"默认配置（内部值）",
						h("span", { className: "nt-tag" }, "只读"),
						h("span", { className: "nt-hint" }, "Bark / 群晖 的内部默认参数与当前设备结构；密钥只显尾号")
					]),
					h("div", { className: "nt-acc-b" }, internalDefaultsSection)
				])
			]);

			return h("div", { className: "nt-root", "data-notify-root": "1" }, [
				h("div", { className: "nt-head", key: "head" }, [tabsEl, headStatus]),
				channelsPane,
				templatesPane,
				routesPane,
				advancedPane,
				statusPane,
				drawerEl
			]);

		}

		// ---------- 通知卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5.1/§5.4) ----------
		// 与 item 卡共用同一个 inject 返回值 (同一 controller.store) ⇒ 摘要随 store 实时刷新
		function NotifySummary(props) {
			var state = props.useNotifyHub(function (s) { return s; });
			var loaded = !!(state && state.loaded);
			var d = state && state.data;
			var list = d && Array.isArray(d.devices) ? d.devices : [];
			var n = list.length;
			var m = list.filter(function (x) { return x && x.enabled !== false; }).length;
			// 契约 §5: K = types.filter(hasProducer).length（权威 types 来自 get; 未回则用冻结兜底表）
			var srcTypes = d && Array.isArray(d.types) && d.types.length ? d.types : TYPES_FALLBACK;
			var k = srcTypes.filter(hasProducerOf).length;
			return react.createElement(react.Fragment, null, [
				react.createElement("span", { className: "lp-ico", key: "ico" }, react.createElement(NotifyPanelIcon, { size: 14 })),
				react.createElement("span", { className: "lp-title", key: "title" }, "通知（Bark / 群晖）"),
				react.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				react.createElement("span", { className: "lp-hint", key: "hint" },
					loaded ? n + " 台设备（" + m + " 台启用）· " + k + " 个通知项目" : "读取中…")
			]);
		}

		// ---------- v0.9.0：左栏「通知」页（sidebar.panellist + main 成对注册） ----------
		// 用户 2026-11-22：「这个插件要能接入到左侧面板配置」＋「通知最好像 MFA 一样带一个 DSH 的图标」。
		// 图标默认用站内 `/dsh-icon-512.png`（DSH 大肥鱼；dsh-pwa 提供）；取不到 ⇒ 回落 🔔（不空白）。
		function NotifyPanelIcon(props) {
			var size = props && props.size ? props.size : 18;
			// 不用 hooks（icon 可能被宿主以函数形式直接调用）⇒ 取不到 DSH 图标时就地切 🔔，不空白
			return react.createElement("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center" } }, [
				react.createElement("img", {
					key: "i", src: "/dsh-icon-512.png", alt: "通知", width: size, height: size,
					style: { width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block" },
					onError: function (e) {
						try {
							e.currentTarget.style.display = "none";
							var fb = e.currentTarget.nextSibling;
							if (fb && fb.style) fb.style.display = "inline";
						} catch (err) { /* 图标失败不影响面板 */ }
					}
				}),
				react.createElement("span", { key: "b", style: { display: "none", fontSize: size, lineHeight: 1 }, "aria-hidden": "true" }, "🔔")
			]);
		}
		function NotifyPage(props) {
			var state = props.useNotifyHub(function (s) { return s; });
			var d = state && state.data;
			var devices = d && Array.isArray(d.devices) ? d.devices : [];
			var enabled = devices.filter(function (x) { return x && x.enabled !== false; }).length;
			// v0.9.3：显式挂 `data-bgimg-surface` —— 页面底＝壁纸插件那套（不透明度可全局调、与其它页一致）；
			//   不自己写死颜色（用户 2026-11-23：「磨砂就用壁纸那个，可以自己调节，也能维持全局统一」）
			return react.createElement("div", { className: "nt-page", "data-notify-page": "1" }, [
				react.createElement("div", { className: "nt-page-h", key: "h" }, [
					react.createElement("span", { className: "nt-page-ico", key: "i" }, react.createElement(NotifyPanelIcon, { size: 22 })),
					react.createElement("div", { className: "nt-page-t", key: "t" }, [
						react.createElement("div", { className: "nt-page-title", key: "title" }, "通知中心"),
						react.createElement("div", { className: "nt-page-sub", key: "sub" }, "渠道 / 模板库 / 路由 / 高级 · Bark + 群晖 Chat · 与「设置 › 本地插件」同一份数据")
					]),
					react.createElement("span", { className: "nt-badge", key: "b" }, "本地插件"),
					react.createElement("span", { className: "nt-page-stat", key: "s" }, devices.length + " 台设备 · " + enabled + " 台启用")
				]),
				react.createElement("div", { className: "nt-page-body", key: "body" }, react.createElement(NotifyCard, props))
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];
		// 中文卡 (zh 即 en, 免英文回退缺失)
		var dict = {};
		/** 控制器实例 (apply 内赋值; 两个槽的 inject 共用)。 */
		var controller = null;
		// item / summary 两个槽共用同一 inject 返回值 (契约 §1: summary props 契约 = item 卡)
		function cardInjected() {
			return {
				hooks: { notifyHub: controller.store },
				refresh: controller.refresh,
				saveDevice: controller.saveDevice,
				deleteDevice: controller.deleteDevice,
				setRoutes: controller.setRoutes,
				setOptions: controller.setOptions,
				// ★件F：**props 白名单必须同改**（`cardInjected()` 是显式映射；漏一行 ⇒ 点击时 `props.reorderDevices is not a function`
				//   ＝手册记的 2026-09-13「props 断链」事故形态；fold-smoke 的件F 真拖放臂即为此设）
				reorderDevices: controller.reorderDevices,
				saveTemplate: controller.saveTemplate,
				deleteTemplate: controller.deleteTemplate,
				setTemplates: controller.setTemplates,
				preview: controller.preview,
				test: controller.test
			};
		}

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: dict, en: dict }); }, "ui-notify: settings card dictionaries");
			controller = createController(ctx.get("connection"));

			// 配置卡迁到插件详情页（plugins.bundle.config，key = 包名）；旧「设置 > 本地插件」列已退役
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: "@ericality/dsh-notify",
					locale: NS,
					inject: cardInjected
				}, NotifyCard);
			});

			// v0.9.0: 左栏「通知」页（成对注册：main 的 key ≡ panellist 的 id）。
			// 槽不存在（旧宿主 / 无 layout）⇒ 静默降级：设置卡仍可用，不影响任何通知发送。
			try {
				ctx.slots.inject("main", function () {
					return ctx.slots.register({ name: "main", key: PANEL_ID, inject: cardInjected }, NotifyPage);
				});
			} catch (e) { /* 左栏页不可用: 静默降级 */ }
			try {
				ctx.slots.inject("sidebar.panellist", function () {
					return ctx.slots.register({
						name: "sidebar.panellist", id: PANEL_ID, order: 30,
						label: function () { return "通知"; }
					}, NotifyPanelIcon);
				});
			} catch (e) { /* panellist 不可用: 静默降级 */ }
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
