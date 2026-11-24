/* ==========================================================================================
 * @ericality/dsh-cost-tier — **时段规则唯一权威库**（本地辅助库，非官方包）
 *
 * 为什么存在：官方定价页措辞已变 ⇒ 5 个包各自复刻的解析锚点【已死】、恒走内置兜底，且
 *   “节假日被当成高峰”；同一套时段口径被复制 5 份（4 份自称“逐字复刻”）⇒ 本库收敛为**单点定义**。
 * 批1.5：吸收 seed（`dsh-nas/seed/.../dsh-taskqueue`）的**边界/纪元**算法（含其测试向量）：
 *   `isPeakAtMs`／`nextOffpeakAt`／`effectiveNextOffpeak`／`currentEpisode`／`currentPeakWindowText`／`beijingHm`，
 *   并新增 `currentWindow(ms)`；**北京时区 +8h 算术统一收敛到 `bjDate()` 一处**。
 *
 * 纪律（`docs/插件开发准入清单.md` B1/B2）：
 *   · **纯函数**：无 `ctx`、**无网络**、零第三方依赖（只用 `node:fs` 读自有数据文件）；模块顶层**永不 throw**。
 *   · **不接触任何宿主面** ⇒ `dshCompat.requires = []`（空集，不自造键名）；健康度由 `probe()` 如实上报。
 *   · 官方页解析＝**纯文本函数** `parsePeakWindows(text)`；**取页由消费方做**（本库不联网）。
 *   · 表外年份 ⇒ **计入降级**（`reasons` 逐条可执行），且**沿用现行兜底**（周末全低谷 ＋ 工作日窗口高峰）。
 *   · ★**签名适配层**（批1.5 硬要求）：seed 的 `isBeijingPeak(windows, now)`（对象在前）与本库
 *     `isBeijingPeak(ms, opts)`（数值在前）**同名不同签名**。本库保留自身语义，并把 seed 形态作**兼容形参**；
 *     不做适配 ⇒ `NaN` ⇒ **恒判平峰、闸门永不暂停且不报错不降级**（静默失效）⇒ 由 `adaptArgs()` ＋
 *     `healthState().reasons[invalid-time-input]` 双重兜住。
 * ========================================================================================== */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url"; // node 内置；**非第三方依赖**（顶层无副作用，读文件在 try/catch 内）

/** @typedef {"peak"|"offpeak"} Tier */

export const TIER_PEAK = "peak";
export const TIER_OFFPEAK = "offpeak";

/** 北京时区固定偏移（中国自 1991 起无夏令时 ⇒ 固定 +08:00，纯算术、无 Intl 依赖） */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 兜底窗口（**含头不含尾**）：工作日 [9,12) ∪ [14,18) 为高峰 —— 与官方页新措辞逐字一致 */
export const FALLBACK_WINDOWS = Object.freeze([[9, 12], [14, 18]]);

/** debug=peak 时合成的“模拟低谷边界”提前量（搬自 seed `dsh-taskqueue`，值逐字相同） */
export const DEBUG_OFFPEAK_LEAD_MS = 10 * 60 * 1000;

/**
 * 官方页锚点（按序尝试；**禁用作锚点者见 `FORBIDDEN_ANCHORS`**）。
 * ★`"为高峰时段"` **也不可用**：它会命中价格表那句「空闲时段价格为**为高峰时段**价格的一半」之前的上下文
 *   （实测该串在价格表段落内、位于真窗口**之前**）⇒ 取到错位置（与 `"高峰时段"` 同类错误）。
 *   本库只采用“北京时间周一至周五”（新措辞）＋旧锚点（向后兼容）。
 */
export const PEAK_ANCHORS = Object.freeze({
	primary: "北京时间周一至周五",
	legacy: "高峰时段为北京时间",
});
/** ★禁用作锚点：`"高峰时段"` 实测首次命中的是**价格表表头**（错位置） */
export const FORBIDDEN_ANCHORS = Object.freeze(["高峰时段"]);

/** 降级原因码（**逐条可执行**：每条都指出“该做什么”） */
export const REASONS = Object.freeze({
	TABLE_YEAR_MISSING: "holiday-table-year-missing",
	TABLE_UNREADABLE: "holiday-table-unreadable",
	PEAK_PARSE_FAILED: "peak-window-parse-failed",
	PEAK_WINDOW_EMPTY: "peak-window-empty",
	INVALID_INPUT: "invalid-time-input",
});

/** 内置兜底表（数据文件缺失/损坏时用它；口径＝放假日读法 (ii)） */
export const BUILTIN_HOLIDAYS = Object.freeze({
	2026: Object.freeze([
		"2026-01-01", "2026-01-02", "2026-01-03",
		"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
		"2026-04-04", "2026-04-05", "2026-04-06",
		"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
		"2026-06-19", "2026-06-20", "2026-06-21",
		"2026-09-25", "2026-09-26", "2026-09-27",
		"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
	]),
});
export const BUILTIN_SOURCE = "国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）·放假日口径 (ii)";

/** 表外数据文件（**年度更新免部署**：把新年度 JSON 放进该路径即可；env 覆盖仅测试用） */
const TABLE_FILE = process.env.DSH_COST_TIER_HOLIDAYS || fileURLToPath(new URL("../data/cn-holidays.json", import.meta.url));

/** 载入结果（模块级一次；失败**不 throw**，只记 degraded 原因） */
const loadState = { table: null, source: BUILTIN_SOURCE, loadReasons: [] };

function loadHolidayTable() {
	const out = { years: {}, source: BUILTIN_SOURCE, reasons: [] };
	for (const [y, list] of Object.entries(BUILTIN_HOLIDAYS)) out.years[y] = new Set(list);
	try {
		// 只读自有数据文件（R2）；读不到/坏 JSON ⇒ 保持内置兜底并记原因（**绝不 throw**）
		if (existsSync(TABLE_FILE)) {
			const j = JSON.parse(readFileSync(TABLE_FILE, "utf8"));
			const ys = j && typeof j === "object" && j.years && typeof j.years === "object" ? j.years : null;
			if (!ys) { out.reasons.push("file-shape"); return out; }
			for (const [y, list] of Object.entries(ys)) {
				if (!/^\d{4}$/.test(y) || !Array.isArray(list)) continue;
				out.years[y] = new Set(list.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)));
			}
			if (typeof j.source === "string" && j.source) out.source = j.source;
			if (typeof j.readingMode === "string" && j.readingMode) out.readingMode = j.readingMode;
		}
	} catch (err) {
		out.reasons.push("file-unreadable");
	}
	return out;
}

/** 模块级只加载一次（顶层**不 throw**：任何异常都吞掉并留原因） */
try {
	const loaded = loadHolidayTable();
	loadState.table = loaded.years;
	loadState.source = loaded.source;
	loadState.reasons = loaded.reasons;
} catch (err) {
	loadState.table = Object.fromEntries(Object.entries(BUILTIN_HOLIDAYS).map(([y, l]) => [y, new Set(l)]));
	loadState.reasons = ["load-failed"];
}

/* ---------- 北京时区算术（**唯一 +8h 收敛点**） ---------- */
/** 北京时区 `Date`（**所有 +8h 算术只允许出现在这里**） */
function bjDate(ms) { return new Date(Number(ms) + BEIJING_OFFSET_MS); }

/** 北京时间的日期/时刻分量（纯算术） */
export function bjParts(ms) {
	const d = bjDate(ms);
	const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
	const h = d.getUTCHours(), mi = d.getUTCMinutes(), dow = d.getUTCDay(); // 0=周日
	const p2 = (n) => String(n).padStart(2, "0");
	return { y, mo, da, h, mi, dow, dateStr: `${y}-${p2(mo)}-${p2(da)}` };
}

/** 该时刻的北京日期串 `YYYY-MM-DD` */
export function bjDateStr(ms) { return bjParts(ms).dateStr; }

/** 星期（1=周一 … 7=周日） */
export function bjWeekday(ms) { const d = bjParts(ms).dow; return d === 0 ? 7 : d; }

/** 北京时区 `"HH:MM"`（横幅/命令文案用；搬自 seed `beijingHm`，语义逐字相同） */
export function beijingHm(msOrDate) { return bjDate(toMs(msOrDate)).toISOString().slice(11, 16); }

/* ---------- 入参归一（★签名适配层） ---------- */
const toMs = (v) => (v instanceof Date ? v.getTime() : (typeof v === "number" ? v : (v && Number.isFinite(v.ms) ? v.ms : NaN)));
const isWindowsWrapper = (v) => !!v && typeof v === "object" && !(v instanceof Date) && (Array.isArray(v.windows) || typeof v.weekdaysOnly === "boolean");

/**
 * 把两种调用形态归一：本库形 `(ms|Date, opts)` ／ seed 形 `(windows包装对象|undefined, Date|ms)`。
 * ★seed 形必须被识别，否则 `ms=NaN` ⇒ 恒判平峰（静默失效）。
 */
function adaptArgs(a, b) {
	if (isWindowsWrapper(a)) return { seed: true, win: a, ms: toMs(b === undefined ? Date.now() : b), opts: {} };
	const bIsTime = b instanceof Date || typeof b === "number";
	if (bIsTime && (a === undefined || a === null || Array.isArray(a) || (typeof a === "object" && !("windows" in a)))) {
		return { seed: true, win: a, ms: toMs(b), opts: {} };
	}
	return { seed: false, win: null, ms: toMs(a === undefined ? Date.now() : a), opts: (b && typeof b === "object") ? b : {} };
}

/** 生效窗口：`undefined/null` ⇒ 兜底；显式空/非法 ⇒ **空集**（＝无高峰 ⇒ 恒平峰，并由 healthState 报 `peak-window-empty`） */
export function normalizeWindows(windows) {
	if (windows === undefined || windows === null) return FALLBACK_WINDOWS;
	if (!Array.isArray(windows)) return [];
	return windows.filter((x) => Array.isArray(x) && x.length === 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] > x[0] && x[1] <= 24);
}

/** 归一后的窗口 + 工作日限制（`win` = seed 包装对象时以其 `weekdaysOnly` 为准） */
function winCtx(adapt) {
	if (adapt.win) {
		const wk = adapt.win.weekdaysOnly !== false;
		return { windows: normalizeWindows(adapt.win.windows), weekdaysOnly: wk, synthetic: !wk };
	}
	const o = adapt.opts || {};
	return { windows: normalizeWindows(o.windows), weekdaysOnly: o.weekdaysOnly !== false, synthetic: o.weekdaysOnly === false, opts: o };
}

/* ---------- 节假日 ---------- */
/**
 * 是否为中国法定节假日（**放假日口径 (ii)**）。
 * @returns {boolean|null} `true`/`false`；**表外年份 ⇒ `null`**（不得猜成 false ⇒ 由调用方计入降级）
 */
export function isCnHoliday(ms, table = loadState.table) {
	const { y, dateStr } = bjParts(ms);
	const set = table ? table[String(y)] : null;
	if (!set) return null;
	return set.has(dateStr);
}

/* ---------- 时段判定（唯一实现） ---------- */
/**
 * 某时刻是否高峰（**唯一口径实现**；含头不含尾）。
 * 兼容两形：`isPeakAtMs(ms, opts)`（本库）／`isPeakAtMs(windows, ms)`（seed）。
 */
export function isPeakAtMs(a, b) {
	const adapt = adaptArgs(a, b);
	if (!Number.isFinite(adapt.ms)) return false;                        // 非法输入 ⇒ 不当高峰（由 healthState 报 invalid-time-input）
	const { windows, weekdaysOnly, synthetic, opts } = winCtx(adapt);
	const { h, dow } = bjParts(adapt.ms);
	if (!synthetic) {
		if (weekdaysOnly && (dow === 0 || dow === 6)) return false;      // 周末（**含调休上班的周末**）全天空闲
		if (weekdaysOnly && isCnHoliday(adapt.ms, opts?.table ?? loadState.table) === true) return false;
	}
	return windows.some(([s, e]) => h >= s && h < e);
}

/** 当前(北京时区)是否处于高峰时段（seed 形 `(windows, now)` 亦可用） */
export function isBeijingPeak(a, b) { return isPeakAtMs(a, b); }

/** 时段（**唯一实现**）：`"peak"|"offpeak"` —— 与既有 `tierOf(ms)` 签名逐字兼容 */
export function tierOf(ms, opts = {}) { return isBeijingPeak(ms, opts) ? TIER_PEAK : TIER_OFFPEAK; }

/** 当前所在高峰**窗口定义**（纯小时查表；注意：节假日/周末的窗口小时 `currentWindow` 仍非 null，但 `tierOf` 为 offpeak） */
export function currentWindow(a, b) {
	const adapt = adaptArgs(a, b);
	if (!Number.isFinite(adapt.ms)) return null;
	const { windows } = winCtx(adapt);
	const h = bjParts(adapt.ms).h;
	const win = windows.find(([s, e]) => h >= s && h < e);
	const pad = (n) => String(n).padStart(2, "0");
	return win ? { start: win[0], end: win[1], text: `${pad(win[0])}:00-${pad(win[1])}:00` } : null;
}

/** 当前所在高峰窗口文案（`"14:00-18:00"`；不在窗口内 → `"高峰"`）—— 语义搬自 seed，逐字相同 */
export function currentPeakWindowText(a, b) {
	const w = currentWindow(a, b);
	return w ? w.text : "高峰";
}

/**
 * 下一个“低谷时刻”（严格晚于 now 的第一个非高峰时刻；now 已是低谷 ⇒ 返回 now 本身）。
 * ★**必须吃节假日表**：否则节假日窗口内会算出**假边界**（例如中秋 10:00 被当高峰 ⇒ 报 12:00）。
 * 窗口边界都是整点 ⇒ 按整分钟推进即可精确落在边界上。搬自 seed `nextOffpeakAt`，**语义逐字相同**，只多节假日口径。
 * @returns {Date|null} null = 14 天内找不到低谷（窗口定义异常/全时段高峰）
 */
export function nextOffpeakAt(a, b) {
	const adapt = adaptArgs(a, b);
	if (!Number.isFinite(adapt.ms)) return null;                         // 非法输入 ⇒ null（**不得**静默当平峰）
	if (!isPeakAtMs(a, b)) return new Date(adapt.ms);
	let t = Math.floor(adapt.ms / 60000) * 60000 + 60000;                 // 对齐到下一整分钟
	const limit = adapt.ms + 14 * 24 * 3600 * 1000;                        // 兜底上限（正常最多跨一个周末）
	while (t <= limit) {
		if (!isPeakAtMs(adapt.win ? adapt.win : adapt.opts, t)) return new Date(t);
		t += 60000;
	}
	return null;
}

/**
 * “下一个低谷时刻”的**统一口径**（闸门 min-lead 判定 + 横幅 + `/queue pause` 文案共用）。
 * `mode.debug === "peak"` ⇒ 合成为 now + `DEBUG_OFFPEAK_LEAD_MS` 的“模拟低谷边界”（synthetic=true）。
 * @returns {{ at: Date|null, synthetic: boolean }}
 */
export function effectiveNextOffpeak(mode, windows, now = new Date()) {
	if (mode?.debug === "peak") return { at: new Date(toMs(now) + DEBUG_OFFPEAK_LEAD_MS), synthetic: true };
	return { at: nextOffpeakAt(windows, now), synthetic: false };
}

/** debug 感知的“某时刻是否高峰”（debug=peak/offpeak 强制；auto 走本库口径） */
export function peakAtMs(mode, windows, ms) {
	if (mode?.debug === "peak") return true;
	if (mode?.debug === "offpeak") return false;
	return isPeakAtMs(windows, ms);
}

/**
 * 当前“时段纪元”标识 —— 同一段连续的高峰/平峰内**不变**，跨边界（含跨周末）才变。
 * 算法搬自 seed（按小时逐级回溯），语义逐字相同。
 */
export function currentEpisode(mode, windows, now = new Date()) {
	const ms = toMs(now);
	if (!Number.isFinite(ms)) return "offpeak:invalid";
	const peak = peakAtMs(mode, windows, ms);
	let t = Math.floor(ms / 3600000) * 3600000;
	const limit = t - 14 * 24 * 3600000;
	while (t > limit && peakAtMs(mode, windows, t - 1) === peak) t -= 3600000;
	return `${peak ? "peak" : "offpeak"}:${new Date(t).toISOString().slice(0, 13)}`;
}

/* ---------- 健康态（单状态 + 逐条可执行原因） ---------- */
/**
 * @param {{ms?:number, year?:number, table?:object, parse?:object|null, windows?:unknown}} o
 */
export function healthState(o = {}) {
	const reasons = [];
	const table = o.table ?? loadState.table;
	const year = o.year ?? (Number.isFinite(o.ms) ? bjParts(o.ms).y : bjParts(Date.now()).y);
	if (o.ms !== undefined && !Number.isFinite(toMs(o.ms))) {
		reasons.push(`${REASONS.INVALID_INPUT}:${String(o.ms)} ⇒ 调用方传了非时间值（**兼容形参未走通／参数顺序错**）；本库会判为平峰 ⇒ 闸门将永不暂停，请检查调用形态`);
	}
	if (!table || !table[String(year)]) {
		reasons.push(`${REASONS.TABLE_YEAR_MISSING}:${year} ⇒ 请在 ${TABLE_FILE} 增补该年度放假日集合（口径 (ii)），或等本库升级内置表`);
	}
	if (Array.isArray(loadState.reasons) && loadState.reasons.length && !o.table) {
		reasons.push(`${REASONS.TABLE_UNREADABLE}:${loadState.reasons.join("/")} ⇒ 检查 ${TABLE_FILE}（已回退内置表，节假日判定可能过期）`);
	}
	if (o.windows !== undefined && normalizeWindows(o.windows).length === 0) {
		reasons.push(`${REASONS.PEAK_WINDOW_EMPTY} ⇒ 显式窗口集为空/非法（本库不静默套兜底）⇒ 当前恒判平峰；请修窗口来源（官方页解析或显式传入）`);
	}
	if (o.parse && o.parse.ok !== true) {
		reasons.push(`${REASONS.PEAK_PARSE_FAILED}:${o.parse.reason ?? "unknown"} ⇒ 官方定价页措辞可能又变了，请人工核对锚点（已回退内置窗口 [${normalizeWindows(o.windows).map((w) => w.join("-")).join(", ")}]）`);
	}
	return { degraded: reasons.length > 0, reasons };
}

/** 带健康态的时段（**单状态 + 精确原因**） */
export function tierInfo(ms, opts = {}) {
	const { windows = FALLBACK_WINDOWS, table = loadState.table, parse = null } = opts || {};
	const hol = isCnHoliday(ms, table);
	const { degraded, reasons } = healthState({ ms, table, parse, windows: opts?.windows });
	return { tier: tierOf(ms, { windows, table }), holiday: hol, yearCovered: hol !== null, windows: normalizeWindows(windows), window: currentWindow(ms, { windows }), degraded, reasons };
}

/* ---------- 官方页解析（纯函数；取页由消费方做） ---------- */
/**
 * 锚点按 `PEAK_ANCHORS` 顺序尝试；**禁用作锚点者**（`FORBIDDEN_ANCHORS`）**永不采用**。
 * @returns {{ok:boolean, windows?:number[][], weekdaysOnly?:boolean, excludesHolidays?:boolean, anchor?:string, reason?:string}}
 */
export function parsePeakWindows(text) {
	try {
		const t = stripHtml(String(text ?? ""));
		for (const anchor of [PEAK_ANCHORS.primary, PEAK_ANCHORS.legacy]) {
			if (FORBIDDEN_ANCHORS.includes(anchor)) continue;
			const i = t.indexOf(anchor);
			if (i < 0) continue;
			const seg = t.slice(i, i + 140);
			const windows = [...seg.matchAll(/(\d{1,2}):\d{2}\s*[-–—]\s*(\d{1,2}):\d{2}/g)]
				.map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)])
				.filter(([a, b]) => a >= 0 && a < 24 && b > a && b <= 24);
			if (!windows.length) continue;
			return { ok: true, windows, weekdaysOnly: /周一至周五/.test(seg), excludesHolidays: /不含中国法定节假日|法定节假日/.test(seg), anchor };
		}
		return { ok: false, reason: "no-anchor-matched" };
	} catch (err) {
		return { ok: false, reason: `parse-failed:${String(err?.message ?? err)}` };
	}
}

/** 去 script/style/标签（与既有实现同形；纯函数） */
export function stripHtml(html) {
	return String(html)
		.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** host-compat 兼容的 `probe`（准入清单 B1）：本库无宿主能力依赖 ⇒ `missing/blocked` 恒空；健康度如实上报 */
export function probe(requires = [], pluginId = "@ericality/dsh-cost-tier", version = "0.1.5", ctx = null, blocking = []) {
	void ctx; void blocking;
	const { degraded, reasons } = healthState({});
	const missing = (Array.isArray(requires) ? requires : []).filter((k) => false); // 无宿主能力依赖 ⇒ 恒空集，不自造键名
	return { id: pluginId, version, state: degraded ? "DEGRADED" : "OK", missing, blocked: [], note: degraded ? reasons.join(" ｜ ") : "" };
}

/** 只读快照（供消费方/判据读表与来源） */
export function tableSnapshot() {
	const years = {};
	for (const [y, set] of Object.entries(loadState.table || {})) years[y] = [...set].sort();
	return { source: loadState.source, loadReasons: [...loadState.reasons], years, tableFile: TABLE_FILE };
}
