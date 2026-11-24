/**
 * 卡字段登记表（单一来源）—— `#A104` 步1。
 *
 * 定位：**内部模块**，不进 `lib/index.js` 的导出面（T0-a 不动）；`banner-kit` 的 `emit` 与
 * 静态检查 `scripts/field-contract-lint.mjs` 共用本表。
 *
 * 每键 7 属性：`key`（键名）· `layer`（L1 形状 / L2 写入约定 / L3 身份 / L4a 文本 /
 * L4b 结构 / L4c 族私有 / L5 kit 自填）· `type` · `required`（写入约定硬性）· `status`
 * （active / alias / retired）· `writers`（写入方）· `note`（语义与复用指引）。
 *
 * 规矩（用户 2026-11-20 裁定）：已有字段能表同义 ⇒ 禁新增；新增必须在本表写 why，
 * 否则 `field-contract-lint` 报红。不得改 `REQUIRED_KEYS` / `OPTIONAL_KEYS`，不得删
 * `pages` 声明；退役键只拒新写、老卡读侧照旧。
 */

export const FIELD_LAYERS = Object.freeze({
	L1: "条目形状",
	L2: "写入约定",
	L3: "身份与位置",
	"L4a": "展示文本",
	"L4b": "展示结构",
	"L4c": "族私有",
	L5: "kit 自填"
});

export const FIELD_STATUS = Object.freeze({ ACTIVE: "active", ALIAS: "alias", RETIRED: "retired" });

/** 逐键登记；顺序即文档表序（L1 → L5，同层按字母）。 */
export const FIELDS = Object.freeze([
	// ---- L1 条目形状（冻结，永不加）----
	{ key: "at", layer: "L1", type: "number(ms)", required: true, status: "active", writers: "kit（由 time 或 now 补）", note: "条目时间戳，store 排序与 ttl 判定用；新代码只读 at，不新增时间字段" },
	{ key: "kind", layer: "L1", type: "string", required: true, status: "active", writers: "8 写入方", note: "卡族名，决定配色/图标/落位族；族名不是来源，来源看 source；kind=balance 被两家共用" },
	{ key: "role", layer: "L1", type: "enum banner|notice|status", required: true, status: "active", writers: "kit", note: "K9 三合一遗留轴；notice 值已退役，新代码不得依赖；现役只 banner/status" },
	{ key: "schemaVersion", layer: "L1", type: "number", required: true, status: "active", writers: "kit", note: "条目形状版本，恒 1；升版会整片重建，禁改" },
	{ key: "sessionId", layer: "L1", type: "string|null", required: true, status: "active", writers: "8 写入方", note: "所属会话；null 仅限全局卡，现读生产无 null" },
	{ key: "source", layer: "L1", type: "string", required: true, status: "active", writers: "8 写入方（opts）", note: "写入方标识；store 派生 owner 即取本键，禁再造 owner 字段" },
	{ key: "state", layer: "L1", type: "enum running|ok|warn|error|info", required: true, status: "active", writers: "kit 兜底；status 卡与 queue 告警显式传", note: "渲染配色唯一依据；能力态（OK/DEGRADED/BLOCKED）不是本键，见 items[].state" },
	{ key: "text", layer: "L1", type: "string", required: true, status: "active", writers: "kit 兜底链", note: "契约级单行文本；有 title 时勿重复写 text，禁新增同义别名" },
	// ---- L2 写入约定（emit 闸门）----
	{ key: "family", layer: "L2", type: "string(enum)", required: true, status: "active", writers: "8 写入方", note: "why：图标/徽章/色板/历史色按家族取，kind 只留渲染特型；新 kind 复用已有 family，新增家族须登记；缺则 emit 拒收，老卡回落 kind" },
	{ key: "foldable", layer: "L2", type: "boolean", required: true, status: "active", writers: "8 写入方", note: "why：折叠族资格由数据自声明，替代 NS_CMD_KINDS；form=bubble 与带 commandId 必须 false（emit 强制）；老卡回落旧规则" },
	{ key: "priority", layer: "L2", type: "number(0..3)", required: true, status: "active", writers: "8 写入方", note: "why：合成卡代表卡按优先级选，替代 NS_ALERT_KINDS／nsPriOf 的 kind 分支；0 告警/1 状态/2 通知适配/3 其余；老卡回落旧规则" },
	{ key: "anchorLevel", layer: "L2", type: "enum row|session|global", required: true, status: "active", writers: "8 写入方", note: "落位级别；row 必须带位置键（anchorSeq/turn/commandId），用 ANCHOR_LEVEL 常量" },
	{ key: "form", layer: "L2", type: "enum bubble|card", required: true, status: "active", writers: "8 写入方", note: "呈现形态；用 CARD_FORM 常量，缺/非法即拒" },
	// ---- L3 身份与位置 ----
	{ key: "anchorSeq", layer: "L3", type: "number", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/taskqueue/graceful-restart", note: "宿主事件 seq 锚点；有它才可原位落行，取不到写 null 不猜" },
	{ key: "cardId", layer: "L3", type: "string(32hex)", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/notify/taskqueue/graceful-restart/sessions-cost/host-compat", note: "卡身份；有它走幂等分支，禁再用 (kind,rev,mode) 造第二身份" },
	{ key: "commandId", layer: "L3", type: "string", required: false, status: "active", writers: "cost-guard/balance/taskqueue/graceful-restart/sessions-cost", note: "命令↔行配对键，取宿主发放值；取不到 null" },
	{ key: "ctxKey", layer: "L3", type: "string", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/notify/taskqueue/graceful-restart/sessions-cost", note: "旧 context id 形态；只有 <prefix>-<seq> 形态可解锚，禁新造第三套位置键" },
	{ key: "rev", layer: "L3", type: "number", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/notify/taskqueue/sessions-cost", note: "排序/替换计数，只作排序；新卡以 cardId 为身份，禁把时间戳当身份" },
	{ key: "turn", layer: "L3", type: "number|null", required: false, status: "active", writers: "cost-guard/cost-ledger/notify/taskqueue/graceful-restart/sessions-cost", note: "回合锚；正整数或 null，0 视为非法（gate-shape-turn 整卡拒收）" },
	// ---- L4a 展示文本 ----
	{ key: "advice", layer: "L4a", type: "string", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/sessions-cost", note: "可执行建议句；与 subtitle（范围）不可互替" },
	{ key: "lines", layer: "L4a", type: "string[]", required: false, status: "active", writers: "cost-guard/balance/notify/taskqueue/sessions-cost", note: "整行自由文本；嵌套数组内已另名（sessions[].peak.lines 改 rows 属三档，未做）" },
	{ key: "metaText", layer: "L4a", type: "string", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/sessions-cost", note: "口径/来源一行；与 subtitle 分工固定，禁合并" },
	{ key: "subtitle", layer: "L4a", type: "string", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/sessions-cost", note: "身份/范围副题；与 advice 不同义" },
	{ key: "time", layer: "L4a", type: "number(ms)", required: false, status: "retired", writers: "无（本批 7 写入方改名 at）", note: "at 的旧写名；本批已停写，读侧只认 at；老卡与 client:3094 的 banner.time 仅作兜底" },
	{ key: "title", layer: "L4a", type: "string", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/notify/taskqueue/host-compat/sessions-cost", note: "卡面主标题；restart 卡未传导致 text 退化为 kind，属待补" },
	// ---- L4b 展示结构 ----
	{ key: "body", layer: "L4b", type: "string", required: false, status: "active", writers: "host-compat", note: "compat 卡正文（旧客户端单行）；新卡优先 items" },
	{ key: "buttons", layer: "L4b", type: "array<{label,action}>", required: false, status: "active", writers: "host-compat", note: "compat 卡按钮行" },
	{ key: "elapsedMs", layer: "L4b", type: "number", required: false, status: "active", writers: "notify", note: "回合用时，metaOf 渲染" },
	{ key: "history", layer: "L4b", type: "array<{t,at,total,delta}>", required: false, status: "active", writers: "cost-ledger", note: "账本历史快照；嵌套 at 为格式化字符串，与外层 at 不同型" },
	{ key: "items", layer: "L4b", type: "array<{id,state,missing,why,advice}>", required: false, status: "active", writers: "host-compat", note: "compat 降级条目；items[].state 是能力态，不是卡 state" },
	{ key: "kv", layer: "L4b", type: "array<{k,v}>", required: false, status: "active", writers: "cost-guard/cost-ledger/balance", note: "键值分项；与 stats 网格分工固定" },
	{ key: "openPanel", layer: "L4b", type: "boolean", required: false, status: "active", writers: "taskqueue", note: "queue 卡出现即展开面板" },
	{ key: "reason", layer: "L4b", type: "string", required: false, status: "active", writers: "notify/graceful-restart", note: "原因短句；notify=完成原因，restart=重启原因，同键两域已在文档注明" },
	{ key: "sessions", layer: "L4b", type: "array<object>", required: false, status: "active", writers: "sessions-cost", note: "多会话费用明细；内含 peak/off 与 {k,v} 行" },
	{ key: "severity", layer: "L4b", type: "enum blocked|degraded", required: false, status: "alias", writers: "host-compat", note: "state 的兼容别名（blocked=error/degraded=warn）；新卡写 state，读侧映射" },
	{ key: "sessionShort", layer: "L4b", type: "string", required: false, status: "active", writers: "cost-guard/notify", note: "会话短 id，渲染用" },
	{ key: "stats", layer: "L4b", type: "array<{label,value,strong,key,note,color,bg,border,size}>", required: false, status: "active", writers: "cost-guard/cost-ledger/balance/sessions-cost", note: "网格 KPI；strong=强值，key=结论标记（cost-guard 双模式状态专用），两者非别名，三档改 primary 前保留" },
	{ key: "status", layer: "L4b", type: "string", required: false, status: "active", writers: "cost-guard", note: "两域：cost 卡 A/B/C 结论；queue 任务态（pending 等）不是本键" },
	{ key: "taskId", layer: "L4b", type: "number", required: false, status: "active", writers: "taskqueue", note: "队列任务号，身份退回时用" },
	{ key: "capState", layer: "L4b", type: "enum OK|DEGRADED|BLOCKED", required: false, status: "active", writers: "host-compat", note: "why：能力态与卡渲染态同名不同义，嵌套 items[].capState 区隔；读侧回落 items[].state" },
	{ key: "clock", layer: "L4b", type: "string", required: false, status: "active", writers: "cost-ledger", note: "why：嵌套 history[].clock 是格式化时间，外层 at 是数字，改名避免同键不同型；读侧回落 history[].at" },
	{ key: "rows", layer: "L4b", type: "array<{k,v}>", required: false, status: "active", writers: "sessions-cost", note: "why：嵌套 sessions[].peak.rows 与条目级 lines 形状不同，改名区隔；读侧回落 peak.lines" },
	{ key: "statusNote", layer: "L4c", type: "string", required: false, status: "active", writers: "graceful-restart", note: "why：restart 卡顶层短句与 stats[].note 同名不同层，改名区隔；读侧回落 note" },
	{ key: "variant", layer: "L4b", type: "string(enum)", required: false, status: "active", writers: "balance/cost-guard", note: "why：mode 归 kit 独占（展示值会被覆盖），展示徽章改由 variant 承载；读侧回落 mode" },
	{ key: "ttlMs", layer: "L4b", type: "number", required: false, status: "retired", writers: "无（2026-09-24 停写）", note: "可见期；用户裁定不设有效期，新写拒绝、老卡照旧" },
	// ---- L4c 族私有 ----
	{ key: "costYuan", layer: "L4c", type: "number", required: false, status: "active", writers: "cost-guard", note: "cost 族金额，折叠摘要兜底" },
	{ key: "helper", layer: "L4c", type: "string", required: false, status: "active", writers: "cost-guard", note: "cost 族辅助说明（仅状态 C）" },
	{ key: "modes", layer: "L4c", type: "array<object>", required: false, status: "active", writers: "cost-guard", note: "cost v2 双模式布局；与 stats 并列的第四形态，禁扩散" },
	{ key: "phase", layer: "L4c", type: "string", required: false, status: "active", writers: "graceful-restart", note: "重启相位（scheduled/observing/exiting/invalid）" },
	{ key: "raw", layer: "L4c", type: "object", required: false, status: "active", writers: "cost-guard", note: "cost 族原始读数（turn/cum/ctx/turns）" },
	{ key: "remainSec", layer: "L4c", type: "number", required: false, status: "active", writers: "graceful-restart", note: "重启剩余秒数，卡片倒计时用" },
	{ key: "scheduleId", layer: "L4c", type: "string", required: false, status: "active", writers: "graceful-restart", note: "重启排程号，卡身份与去重键" },
	{ key: "tier", layer: "L4c", type: "enum peak|offpeak", required: false, status: "active", writers: "cost-guard", note: "高峰/低谷标记" },
	{ key: "trigger", layer: "L4c", type: "string", required: false, status: "active", writers: "cost-guard", note: "cost 触发原因文案" },
	{ key: "turns", layer: "L4c", type: "number", required: false, status: "active", writers: "cost-guard", note: "cost 预测回合数" },
	{ key: "note", layer: "L4c", type: "string", required: false, status: "retired", writers: "无（本批改 statusNote）", note: "restart 卡旧顶层短句；本批停写，读侧回落 note；stats[].note 是格子脚注，同名不同层" },
	// ---- L5 kit 自填 ----
	{ key: "mode", layer: "L5", type: "enum start|replace", required: false, status: "active", writers: "kit", note: "kit 的身份轴；写入方传值会被覆盖，禁止用它对展示分支" },
	// ---- 退役（仅老卡读侧）----
	{ key: "confirmed", layer: "L4c", type: "boolean", required: false, status: "retired", writers: "无（本批停写）", note: "重启确认标记；零读取，退役" },
	{ key: "count", layer: "L4b", type: "number", required: false, status: "retired", writers: "无（本批停写）", note: "与 items.length 重复，退役" },
	{ key: "deadline", layer: "L4c", type: "number", required: false, status: "retired", writers: "无（本批停写）", note: "重启截止时刻；零读取，退役" },
	{ key: "hasSummary", layer: "L4b", type: "boolean", required: false, status: "retired", writers: "无（本批停写）", note: "notify 旧标记；零读取，退役" },
	{ key: "anchorSource", layer: "L4c", type: "string", required: false, status: "retired", writers: "无（本批停写）", note: "中间件补 turn 的诊断标记；零读取，退役" },
	{ key: "pages", layer: "L4a", type: "string[]", required: false, status: "retired", writers: "无", note: "声明冻结（禁删声明），从未写入；新写拒绝" },
	{ key: "requestedAt", layer: "L4c", type: "number", required: false, status: "retired", writers: "无（本批停写）", note: "重启请求时刻；零读取，退役" }
]);

export const FIELD_MAP = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f.key, f])));

export function fieldOf(key) {
	return FIELD_MAP[key] ?? null;
}
export function isRegisteredKey(key) {
	return Object.prototype.hasOwnProperty.call(FIELD_MAP, key);
}
export function statusOfKey(key) {
	return FIELD_MAP[key]?.status ?? null;
}
/** 本模块自带的自检：56 键、键名唯一、7 属性齐。 */
export function selfCheck() {
	const bad = [];
	const seen = new Set();
	for (const f of FIELDS) {
		if (seen.has(f.key)) bad.push(`dup:${f.key}`);
		seen.add(f.key);
		for (const k of ["key", "layer", "type", "required", "status", "writers", "note"]) {
			if (f[k] === undefined || f[k] === null || f[k] === "") bad.push(`missing:${f.key}:${k}`);
		}
		if (!FIELD_LAYERS[f.layer]) bad.push(`bad-layer:${f.key}`);
		if (!Object.values(FIELD_STATUS).includes(f.status)) bad.push(`bad-status:${f.key}`);
	}
	return { ok: bad.length === 0, bad, count: FIELDS.length };
}
