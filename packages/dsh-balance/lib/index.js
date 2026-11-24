import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/balance/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "balance");
import { createHash } from "node:crypto";   // ★G1-b（2026-09-20）：逐卡身份 `cardId`

/**
 * @deepseek-ai/dsh-balance (本地辅助插件, 非官方包)
 *
 * 斜杠命令:
 *   /balance        简洁版: 余额 / 间隔(时间范围+时段) / 本次差值预估 / 官方扣费
 *   /balance-detail 详细版: token 差值明细 + 运算过程 + 定价来源 + 累计
 *   /cost           当前会话费用预估 (纯本地, 不打官方 API)
 *
 * 数据源:
 *   - 实时余额: DeepSeek /user/balance API (CNY)
 *   - 累计用量: session_projcache 各会话 tokenUsage.totals 汇总
 *   - 快照: $DSH_HOME/plugin-data/balance/balance-state.json（持久卷）, 用于计算与上次的差值
 *
 * 定价 (阶段 2 / RD-42/43): 取价与计费一律经共享库 `@ericality/dsh-cost-pricing`
 *   (动态 import; 缺库 ⇒ 内置纯数据常量 FALLBACK_PRICES + 一行 warn)。
 *   库内回退链 = 价格缓存(<30min) → 官方页解析 → 上次缓存 → 内置常量;
 *   价格缓存**归共享库** (`cost-pricing-cache.json`), 本插件 state 不再存 prices/pricesFetchedAt。
 *   时段: 高峰=北京 9-12 点 / 14-18 点 (周末全天空闲);
 *   间隔完全落在高峰=高峰, 完全落在其余=低谷, 横跨=混合。
 * reasoning (RD-30/RD-44): projcache totals 不含 reasoning ⇒ `/cost` 的合计额按
 *   `costOf(totals, p, { reasoning })` 计 (推理 tokens 按输出价); 读数来自
 *   `(await loadReconcile())?.readSessionEvents(session)` 的**全会话全量求和**(无 carry-forward)。
 *
 * 结果展示 (v0.4.0): 三个命令不再返回气泡文本, 改为向会话注入 notice/banner 横幅
 *   (kind=balance 紫色"余额"家族 / kind=error 红色"错误"家族), 由 dsh-notice-banner
 *   client 插件渲染。横幅是非 surface 会话事件: 不进模型历史、不消耗模型 token。
 *   balance 横幅携带结构化 stats(统计格) + kv(键值行) + metaText + advice 字段。
 */
export const name = "dsh-balance";
export const inject = ["commands"];

// ================= 共享库动态加载 (契约 §10.1: 禁静态 import 共享包) =================
/** 本插件告警出口 (apply 内接 ctx.logger.warn; 未接时退回 console.warn) */
let logWarn = null;
function LOG(msg) {
	try { (logWarn ?? ((m) => console.warn(m)))(`[${name}] ${msg}`); } catch { /* noop */ }
}

// ---- RD-43: 动态加载取价/计费库 `@ericality/dsh-cost-pricing` ----
/** RD-43 内置兜底常量 (契约 §2.6「纯数据常量」唯一豁免; 2026-09-13 官方页 Flash 列, ¥/百万tokens) */
const FALLBACK_PRICES = {
	peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
	offpeak: { inputMiss: 1, inputHit: 0.02, output: 4 }
};
/**
 * RD-43 降级垫片: **仅**当共享取价库不可加载时使用。
 * 只含「纯数据常量 + 契约 §2.1 的时段规则/计费算式」——**不含**解析逻辑、**不含** URL、**不抓页**;
 * projcache 读取一律**停用**(空结果), **不写第二套 fs 实现** (契约 §10.2 / D12)。
 */
const DEGRADED_PRICING = {
	degraded: false,
	reasons: [],
	loadPrices: async () => ({ prices: FALLBACK_PRICES, source: "内置常量" }),
	// ★批2a：**本地不再自算时段**（点判定唯一权威 = `@ericality/dsh-cost-tier`，经 `@ericality/dsh-cost-pricing` 转发）。
	//   本垫片只在共享库整体不可加载时使用 ⇒ 时段判定**如实降级**：保守按 `peak`（宁可多算不可少算）＋ 置降级标记。
	tierOf: () => { DEGRADED_PRICING.degraded = true; if (!DEGRADED_PRICING.reasons.length) DEGRADED_PRICING.reasons.push("共享取价/时段库不可加载 ⇒ 时段判定降级：保守按 peak（批2a 起本地不再自算）"); return "peak"; },
	costOf: (totals, price, opts = {}) => {
		const t = totals ?? {}, p = price ?? {};
		const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
		return ((n(t.uncachedInputTokens) + n(t.cacheWriteTokens)) * n(p.inputMiss)
			+ n(t.cacheReadTokens) * n(p.inputHit)
			+ n(t.outputTokens) * n(p.output)) / 1e6
			+ (n(opts?.reasoning) * n(p.output)) / 1e6;
	},
	readProjcacheAll: async () => ({}),
	readProjcacheOne: async () => null
};
let pricingMod;             // undefined = 尚未尝试
let pricingDead = false;    // true = 已判定不可用（不重试）
/** 取价库 (RD-43): 动态 import 成功 ⇒ 真库; 失败 ⇒ DEGRADED_PRICING + 一行 warn (永不 throw) */
async function pricingLib() {
	if (pricingMod !== undefined) return pricingMod ?? DEGRADED_PRICING;
	if (pricingDead) return DEGRADED_PRICING;
	try {
		pricingMod = await import("@ericality/dsh-cost-pricing");
			await pricingMod?.warmTier?.();   // 批2a：预热时段权威（失败不抛，垫片如实降级）
	} catch (err) {
		pricingDead = true; pricingMod = null;
		LOG(`取价库缺失 → 用内置常量: ${String(err?.message ?? err)}`);
	}
	return pricingMod ?? DEGRADED_PRICING;
}

// ---- RD-44: 动态加载 reconcile (理由同 §10.1; balance 只用其 readSessionEvents 取 reasoning) ----
let reconcileMod;             // undefined = 尚未尝试
let reconcileDead = false;    // true = 已判定不可用（不重试）
export async function loadReconcile() {
	if (reconcileMod !== undefined) return reconcileMod;
	if (reconcileDead) return null;
	try {
		reconcileMod = await import("@ericality/dsh-reconcile");
	} catch (err) {
		reconcileDead = true; reconcileMod = null;
		LOG(`reconcile 不可用 → reasoning 计 0: ${String(err?.message ?? err)}`);
	}
	return reconcileMod;
}

/** 取价 (RD-43): 共享库 loadPrices (缓存/解析/回退链全在库里) → 缺库降级内置常量。永不 throw */
async function resolvePrices(opts) {
	const m = await pricingLib();
	try {
		const r = await m.loadPrices(opts);
		if (r?.prices) return { prices: r.prices, source: r.source ?? "内置常量" };
	} catch (err) {
		LOG(`取价库调用异常 → 用内置常量: ${String(err?.message ?? err)}`);
	}
	return { prices: FALLBACK_PRICES, source: "内置常量" };
}
/** 全部会话 record: 共享库导出 (分片优先 + 单体表补历史); 缺库 ⇒ 停用(空) */
async function readProjcacheAll() {
	try { return await (await pricingLib()).readProjcacheAll(); } catch { return {}; }
}
/** 单会话 record: 共享库导出 (分片优先, 单体回退); 缺库 ⇒ 停用(null) */
async function readProjcacheOne(sid) {
	try { return await (await pricingLib()).readProjcacheOne(sid); } catch { return null; }
}
/** 时段判定 (逐字复刻口径): 共享库已加载 ⇒ tierOf(ms); 缺库 ⇒ 降级垫片同规则 */
function tierOf(ms) {
	const f = pricingMod?.tierOf;
	return typeof f === "function" ? f(ms) : DEGRADED_PRICING.tierOf(ms);
}
/** 计费 (RD-30): 共享库已加载 ⇒ costOf(totals, price, {reasoning}); 缺库 ⇒ 降级垫片同算式 */
function costOf(totals, price, opts) {
	const f = pricingMod?.costOf;
	return typeof f === "function" ? f(totals, price, opts) : DEGRADED_PRICING.costOf(totals, price, opts);
}

// ── A4 (2026-09-14 阶段6): 结算事件 usage 口径, 与宿主 dsh-token-meter 的 usageOf() 对齐 ──
// 1.5 起 assistant/attempt (失败/重试/取消的尝试结算) 不带 data.usage, 用量在 stream 末帧;
// 宿主 tokenUsageProjection 两类都吃 ⇒ 只扫 assistant/message 会系统性少计。
// 1.2 无 assistant/attempt 且 assistant/message 无 data.stream ⇒ 本函数对 1.2 是纯 additive 空操作。
// 末帧 = 记录数组里最后一个 { type:"chunk", chunk:{ type:"usage", usage } }。
function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return undefined;
	for (let i = stream.length - 1; i >= 0; i -= 1) {
		const rec = stream[i];
		if (rec?.type === "chunk" && rec.chunk?.type === "usage" && rec.chunk.usage) return rec.chunk.usage;
	}
	return undefined;
}

/** 结算事件 (assistant/message | assistant/attempt) 的 usage; 无用量返回 undefined (跳过, 不抛)。 */
function settlementUsage(event) {
	const type = event?.type;
	if (type !== "assistant/message" && type !== "assistant/attempt") return undefined;
	return event.data?.usage ?? lastStreamUsage(event.data?.stream);
}

/** RD-44: 当前会话 reasoningTokens 之和 (projcache totals 不含 reasoning)。
 *  每次**全量重算** (命令式语义, 不照抄 cost-ledger 的增量 carry-forward);
 *  reconcile 不可用 / 读不到事件 ⇒ 0 (不估算、不虚增)。
 *  A4 (2026-09-14): 结算事件含 `assistant/attempt` (1.5 的 usage 在 stream 末帧)。 */
async function sessionReasoningTokens(session) {
	const rc = await loadReconcile();
	if (typeof rc?.readSessionEvents !== "function") return 0;
	try {
		const events = rc.readSessionEvents(session);
		if (!Array.isArray(events)) return 0;
		let sum = 0;
		for (const ev of events) {
			const u = settlementUsage(ev);
			if (u) sum += u.reasoningTokens ?? 0;
		}
		return Number.isFinite(sum) ? sum : 0;
	} catch (err) {
		LOG(`reasoning 读数失败 → 计 0: ${String(err?.message ?? err)}`);
		return 0;
	}
}

const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE || joinPath(DSH_HOME, ".credentials.yaml");
const STATE_FILE = process.env.DSH_BALANCE_STATE_FILE || joinPath(PLUGIN_DATA, "balance-state.json");
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TIMEOUT_MS = 15000;

function beijingHour() {
	return (new Date().getUTCHours() + 8) % 24;
}

/** 北京时刻字符串 HH:MM */
function beijingHm(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** 间隔时段分类: 高峰 / 低谷 / 混合(长间隔) */
function classifyInterval(startMs, endMs) {
	const ms = Math.max(0, endMs - startMs);
	if (ms <= 0) return "瞬时";
	const mins = Math.round(ms / 60000);
	if (mins > 60 * 24 * 2) return "混合(长间隔)";
	const startMin = (((startMs + 8 * 3600 * 1000) / 60000) % 1440 + 1440) % 1440;
	let peak = 0, off = 0;
	for (let i = 0; i < mins; i++) {
		// 周末(北京时间周六/周日)全天低谷
		const day = new Date(startMs + i * 60000 + 8 * 3600 * 1000).getUTCDay();
		if (day === 0 || day === 6) { off++; continue; }
		const h = Math.floor(((startMin + i) % 1440) / 60);
		if ((h >= 9 && h < 12) || (h >= 14 && h < 18)) peak++; else off++;
	}
	if (peak > 0 && off > 0) return "混合";
	return peak > 0 ? "高峰" : "低谷";
}

async function resolveApiKey() {
	if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
	try {
		const txt = await readFile(CREDENTIALS_FILE, "utf8");
		const m = txt.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
		if (m) return m[1];
	} catch { /* fallthrough */ }
	return undefined;
}

async function fetchBalance(key) {
	const resp = await fetch(BALANCE_URL, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS)
	});
	if (!resp.ok) throw new Error(`balance API HTTP ${resp.status}`);
	return await resp.json();
}

async function readUsageTotals() {
	try {
		const sessions = await readProjcacheAll(); // 0.1.2: 分片优先 + 单体表补历史
		const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
		let count = 0;
		for (const session of Object.values(sessions)) {
			const tu = session?.rows?.tokenUsage?.val?.totals ?? session?.rows?.tokenUsage?.totals;
			if (!tu) continue;
			count += 1;
			totals.uncachedInputTokens += tu.uncachedInputTokens ?? 0;
			totals.cacheReadTokens += tu.cacheReadTokens ?? 0;
			totals.cacheWriteTokens += tu.cacheWriteTokens ?? 0;
			totals.outputTokens += tu.outputTokens ?? 0;
		}
		return { ...totals, sessions: count };
	} catch {
		return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, sessions: 0 };
	}
}

async function readState() {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		return undefined;
	}
}

async function writeState(state) {
	try {
		mkdirSync(PLUGIN_DATA, { recursive: true });
		await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
		return true;
	} catch {
		return false;
	}
}

// ---- dsh-cost-tree 动态加载 (复用策略 B: optionalDependency, 缺失/失败 → null 降级) ----
// ⚠️ 禁止顶层静态 import("@deepseek-ai/dsh-cost-tree") — 会重建"缺包崩溃"硬链 (设计 §0.2/§8.3)。
let costTreePromise = null;
export function loadCostTree() {
	costTreePromise ??= import("@ericality/dsh-cost-tree/lib/index.js")
		.catch((err) => {
			// debug/warn 一条即可 (缺失=降级现状, 不弹错不崩)
			try { console.warn(`[dsh-balance] dsh-cost-tree 不可用, 退回单会话口径: ${String(err?.message ?? err)}`); } catch { /* noop */ }
			return null;
		});
	return costTreePromise;
}

/**
 * /cost 树口径展示纯函数 (供单测): 子树聚合对象 → 文案/kv/stat 三件套; 无后代 → null。
 * - 说明行: `含 N 个子 agent（树口径: 自身 + 后代, 截至当前已结算）`
 * - childrenKV: 每子一行 { k: `子 agent · <label>`, v: `¥x` } (label/sid/金额, n 小文本行即可)
 * - stat: { label: "子 agent", value: "N 个", note: "树口径 · 截至当前已结算" }
 */
export function costTreePresentation(agg, price) {
	const children = agg?.children ?? [];
	const n = children.length;
	if (n === 0) return null;
	const childrenKV = children.map((c) => ({
		k: `子 agent · ${typeof c.label === "string" && c.label ? c.label : c.sid}`,
		v: `¥${fmtYuan(costOf(c.totals ?? {}, price))}`
	}));
	return {
		note: `含 ${n} 个子 agent（树口径: 自身 + 后代, 截至当前已结算）`,
		stat: { label: "子 agent", value: `${n} 个`, note: "树口径 · 截至当前已结算" },
		childrenKV
	};
}

/** 单个会话的 tokenUsage.totals (projcache), 无则 null */
async function readSessionUsage(sessionId) {
	try {
		const s = await readProjcacheOne(sessionId); // 0.1.2: 分片优先
		const tu = s?.rows?.tokenUsage?.val?.totals ?? s?.rows?.tokenUsage?.totals;
		return tu ?? null;
	} catch {
		return null;
	}
}

/** 两位小数金额 (费用分解用) */
const fmtYuan = (n) => (Math.round(n * 100) / 100).toFixed(2);

const fmtMoney = (n) => (Math.round(n * 100) / 100).toLocaleString("zh-CN");
const fmtTokens = (n) => `${(Math.round(n / 1000)).toLocaleString("zh-CN")}k`;
const fmtSignedTokens = (n) => `${n >= 0 ? "+" : ""}${fmtTokens(n)}`;
const fmtElapsed = (ms) => {
	const min = Math.max(1, Math.round(ms / 60000));
	if (min < 60) return `${min} 分钟`;
	return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
};

/** 收集一次完整快照(余额/用量/差值/时段/定价), 两个命令共用 */
async function collect() {
	const usage = await readUsageTotals();
	const key = await resolveApiKey();
	const state = await readState();

	// 并行: 余额查询 + 取价 (RD-42: 价格缓存归共享库 cost-pricing-cache.json, 本插件 state 不再存价)
	const [balanceResult, priceResult] = await Promise.allSettled([
		key ? fetchBalance(key) : Promise.resolve(null),
		resolvePrices()
	]);

	let cny = null, available = null;
	const data = balanceResult.status === "fulfilled" ? balanceResult.value : null;
	if (data) {
		const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
		const found = infos.find((i) => i.currency === "CNY");
		cny = found ? parseFloat(found.total_balance) : null;
		available = data.is_available;
	}

	// 定价 (RD-43): 回退链在共享库内 = 价格缓存(<30min) → 官方页解析 → 上次缓存 → 内置常量
	const priceInfo = priceResult.status === "fulfilled" ? priceResult.value : null;
	const prices = priceInfo?.prices ?? FALLBACK_PRICES;
	const priceSource = priceInfo?.source ?? "内置常量";

	const now = Date.now();
	const lastCheckAt = state?.lastCheckAt ?? null;
	const interval = lastCheckAt ? { from: lastCheckAt, to: now, ms: now - lastCheckAt } : null;
	const tier = interval ? classifyInterval(lastCheckAt, now) : null;
	const p = tier === "高峰" ? prices.peak : prices.offpeak;

	const delta = state?.totals ? {
		uncachedInputTokens: Math.max(0, usage.uncachedInputTokens - (state.totals.uncachedInputTokens ?? 0)),
		cacheReadTokens: Math.max(0, usage.cacheReadTokens - (state.totals.cacheReadTokens ?? 0)),
		cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - (state.totals.cacheWriteTokens ?? 0)),
		outputTokens: Math.max(0, usage.outputTokens - (state.totals.outputTokens ?? 0))
	} : null;

	const balanceMoved = interval && cny !== null && typeof state?.balanceCny === "number"
		? state.balanceCny - cny
		: null;

	// 仅"有意义"的间隔才更新 lastDelta (间隔>=60s 且预估>=¥0.001):
	// 这样先 /balance 记账、紧跟 /balance-detail 时, detail 不会因自己
	// 产生的小间隔覆盖掉 balance 算好的那段明细 (解决两命令不共享数据的问题)。
	const deltaCost = delta ? costOf(delta, p) : null;
	const meaningfulDelta = delta && interval && interval.ms >= 60000 && (deltaCost ?? 0) >= 0.001;
	const lastDelta = meaningfulDelta ? {
		from: interval.from, to: now, ms: interval.ms, tier,
		delta, deltaCost, p, priceSource
	} : (state?.lastDelta ?? null);

	await writeState({
		version: 2,
		lastCheckAt: now,
		totals: {
			uncachedInputTokens: usage.uncachedInputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			outputTokens: usage.outputTokens
		},
		balanceCny: cny,
		// RD-42: 价格缓存归共享库 (cost-pricing-cache.json) ⇒ 本 state **不再写** prices/pricesFetchedAt
		lastDelta
	});

	return {
		usage, cny, available, interval, tier, p, prices,
		delta, deltaCost,
		totalCost: costOf(usage, p),
		balanceMoved, stateBalance: state?.balanceCny ?? null,
		priceSource, lastDelta
	};
}

/**
 * 向会话注入 notice/banner 横幅 (kind=balance / kind=error)。
 * - 非 surface 事件: 不进模型历史、不消耗 token, 由 dsh-notice-banner client 渲染。
 * - 命令 handler 不在 session/event 观察者派发内 (dsh-commands 在调用 handler 前已
 *   同步完成 command/run append), 因此可直接注入。
 * - 失败返回 false, 调用方回退到旧版气泡文本, 保证命令始终有反馈。
 *
 * P1-2 (2026-09-14): 写路径**唯一** = `bannerKit.emit(payload, opts)`（**去 session**）⇒ §4.4 seam
 *   → 中间件解析 sink → `noticeState.append` → 自有 store。本文件**不再直连 `session.append`**（R1），
 *   也**不再静态 import 宿主包**（`@deepseek-ai/dsh-session` 已移除 ⇒ B1 顶层宿主访问清零）。
 */
function appendBanner(session, payload) {
	const sid = String(session?.id ?? "");
	if (!sid) return Promise.resolve(false);
	return (async () => {
		try {
			const bk = await loadBannerKit();
			if (typeof bk?.emit !== "function") {
				logWarn?.(`dsh-balance: banner-kit 不可用 → 横幅注入停用 (回退命令气泡文本)`);
				return false;
			}
			// ★G1-b（2026-09-20）：补 **确定性 `cardId`**（逐次唯一：`ctxKey` 已含毫秒时间戳）
			//   ⇒ 本卡语义"每次命令一张新卡"不变（**不是**同身份原地更新）；`ctxKey` 变体入摘要 ⇒ 可溯源。
			const _cardIdB = (payload && typeof payload.cardId === "string" && payload.cardId)
				? payload.cardId
				: createHash("sha256").update(`dsh-balance|balance|${sid}|${String(payload?.ctxKey ?? payload?.rev ?? Date.now())}`).digest("hex").slice(0, 32);
			const r = await bk.emit({ at: Date.now(), ...payload, sessionId: sid, cardId: _cardIdB, anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD }, { source: "dsh-balance" });
			if (!r?.ok) {
				logWarn?.(`dsh-balance: 横幅注入失败 (${r?.reason ?? "unknown"}) → 回退命令气泡文本`);
				return false;
			}
			return true;
		} catch (err) {
			logWarn?.(`dsh-balance: 横幅注入异常 (${String(err?.message ?? err)}) → 回退命令气泡文本`);
			return false;
		}
	})();
}

/* ---------------- banner-kit 动态加载 (契约 §10.1: 禁静态 import 共享包 + 缺库即停用) ---------------- */

let bannerKitMod;          // undefined = 尚未尝试；null = 已判定不可用
let bannerKitDead = false; // true = 已判定不可用（不再重试）
async function loadBannerKit() {
	if (bannerKitMod !== undefined) return bannerKitMod;
	if (bannerKitDead) return null;
	try {
		bannerKitMod = await import("@ericality/dsh-banner-kit");
		// ★段2 `B6`（2026-09-29，"不得静默" · WRAP-B6）：emit **拒收**（形状非法）⇒ **必须面板可见 ＋ 点名** ——
		//   经中间件 `wrapBannerKit` 包一层（emit 非 ok 且属拒收 ⇒ 落 store ① `rejected` ⇒ 面板 `rejectedByReason`）。
		//   中间件不可用/旧版（无该面）⇒ **原样使用模块**（不伪造、不回落直连宿主）。
		try {
			const _smB6 = await import("@ericality/dsh-host-compat/seams");
			if (typeof _smB6.wrapBannerKit === "function") bannerKitMod = _smB6.wrapBannerKit(bannerKitMod, "dsh-balance");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch {
		bannerKitDead = true;
		bannerKitMod = null;
	}
	return bannerKitMod;
}

export async function apply(ctx) {
	// 插件告警出口 (RD-43/RD-44 降级必须可观测, §2.3 禁止静默)
	logWarn = (m) => { try { ctx.logger?.warn?.(m); } catch { /* noop */ } };
	// RD-43: 启动期探测共享取价库 —— 缺库立即 warn (不等首次命令才暴露)
	await pricingLib();
	// notice/banner 事件类型注册 (P1-2 收敛: **唯一注册路径** = banner-kit `ensureRegistered()`，
	// 它经 §4.5 `ensureEventTypes` seam；本插件**不再**直连宿主 `KNOWN_SESSION_EVENT_TYPES` ——
	// 注册动作本身保留（1.5 的进程内读路径靠它），只是改走中间件）。
	try {
		const bk = await loadBannerKit();
		const reg = typeof bk?.ensureRegistered === "function" ? await bk.ensureRegistered() : { ok: false, reason: "banner-kit" };
		if (reg?.ok !== true) logWarn?.(`dsh-balance: notice/banner 类型注册失败 (${reg?.reason ?? "unknown"}) → 横幅注入停用, 回退命令气泡文本`);
	} catch (err) {
		logWarn?.(`dsh-balance: 事件类型注册异常 (已忽略): ${String(err?.message ?? err)}`);
	}

	// ---- 简洁版 ----
	ctx.commands.register({
		name: "balance",
		description: "余额/间隔差值预估/官方扣费 (简洁, 横幅展示)",
		handler: async (invocation) => {
			const d = await collect();
			const fallback = [];
			fallback.push(`余额: ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}${d.available !== null ? ` (可用: ${d.available ? "是" : "否"})` : ""}`);

			if (d.interval && d.delta) {
				fallback.push(`间隔: ${fmtElapsed(d.interval.ms)} (${beijingHm(d.interval.from)}→${beijingHm(d.interval.to)}) · 时段: ${d.tier}`);
				fallback.push(`本次预估: ¥${fmtMoney(d.deltaCost)}`);
				if (d.balanceMoved !== null) {
					fallback.push(`官方扣费(计费有延迟): ${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))}`);
				}
			} else {
				fallback.push("(首次记账: 从本次开始, 下次运行显示差值)");
			}

			// 横幅 (kind=balance, mode=overview): 余额标题 + 统计格 + 间隔/定价 meta
			const stats = [];
			if (d.interval && d.delta) {
				stats.push({ label: "本次预估", value: `¥${fmtMoney(d.deltaCost)}`, strong: true });
				stats.push({ label: "时段", value: d.tier });
				if (d.balanceMoved !== null) {
					stats.push({ label: "官方扣费", value: `${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))}`, note: "延迟" });
				}
			} else {
				stats.push({ label: "记账状态", value: "首次记账", note: "下次运行显示差值" });
			}
			const ok = await appendBanner(invocation.agent.session, {
				// A 阶段（obs#3）：balance 卡无 turn 语义（命令触发）⇒ turn 显式 null；ctxKey 取旧 id 形态
				turn: null,
				anchorSeq: null,
				ctxKey: "balance-" + Date.now(),
				kind: "balance",
				priority: 3, foldable: false, family: "balance",
				// ★T-F′（2026-09-21 obs3S7；用户已签）：**命令↔行配对键** —— 命令面取宿主发放的同源 `commandId`
				//   （与 `command/done.data.commandId` 逐字同值；`invocation` 由 handler 作用域提供）；取不到 ⇒ null（不猜）
				commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
				// obs#3 段N（#A97 二 (a)）：**补唯一身份键** —— kit 会静默压平 mode（banner-kit:131）⇒
				//   同一 (kind,rev,mode) 会互相覆盖；本插件**不得用 mode 表达身份**，改用逐次唯一的 `rev`。
				rev: Date.now(),
				variant: "overview",
				title: `账户余额 ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}`,
				subtitle: d.available !== null ? `可用: ${d.available ? "是" : "否"}` : "",
				stats,
				metaText: d.interval && d.delta
					? `间隔 ${fmtElapsed(d.interval.ms)} · ${beijingHm(d.interval.from)} → ${beijingHm(d.interval.to)} · 定价来源: ${d.priceSource}`
					: `定价来源: ${d.priceSource}`,
				advice: ""
			});
			if (!ok) return { kind: "success", text: fallback.join("\n") };
			return { kind: "success", text: "" };
		}
	});

	// ---- 详细版 ----
	ctx.commands.register({
		name: "balance-detail",
		description: "余额/用量/费用全量明细 (token + 运算 + 定价来源, 横幅展示)",
		handler: async (invocation) => {
			const d = await collect();
			const fallback = [];
			fallback.push(`余额: ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}${d.available !== null ? ` (可用: ${d.available ? "是" : "否"})` : ""}`);

			// 优先展示最近一次 /balance 记账的间隔明细 (10 分钟内), 解决
			// "先 /balance 简洁, 再 /balance-detail 想看同一段分解" 的需求。
			const last = d.lastDelta;
			const lastFresh = last && (Date.now() - last.to) < 10 * 60 * 1000;
			const useLast = lastFresh && (!d.interval || d.interval.ms < 2 * 60 * 1000);
			const seg = useLast ? last : (d.interval && d.delta ? {
				from: d.interval.from, to: d.interval.to, ms: d.interval.ms, tier: d.tier,
				delta: d.delta, deltaCost: d.deltaCost, p: d.p, priceSource: d.priceSource
			} : null);
			const segLabel = useLast ? "记账间隔" : "本次间隔";

			if (seg) {
				fallback.push(`-- ${segLabel} ${fmtElapsed(seg.ms)} (${beijingHm(seg.from)}→${beijingHm(seg.to)}) · 时段: ${seg.tier}${useLast ? " (来自最近一次 /balance)" : ""} --`);
				fallback.push(`token 差值: 输入 ${fmtSignedTokens(seg.delta.uncachedInputTokens)} · 缓存命中 ${fmtSignedTokens(seg.delta.cacheReadTokens)} · 缓存未命中 ${fmtSignedTokens(seg.delta.cacheWriteTokens)} · 输出 ${fmtSignedTokens(seg.delta.outputTokens)}`);
				fallback.push(`本次预估: ¥${fmtMoney(seg.deltaCost)} = 输入${fmtTokens(seg.delta.uncachedInputTokens + seg.delta.cacheWriteTokens)}×¥${seg.p.inputMiss} + 缓存${fmtTokens(seg.delta.cacheReadTokens)}×¥${seg.p.inputHit} + 输出${fmtTokens(seg.delta.outputTokens)}×¥${seg.p.output} (每百万, ${seg.tier}价, ${seg.priceSource})`);
				if (d.balanceMoved !== null) {
					fallback.push(`官方扣费(计费有延迟): ${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))} (上次 ¥${fmtMoney(d.stateBalance)} → 现在 ¥${fmtMoney(d.cny)})`);
				}
			} else {
				fallback.push("-- 本次间隔 --\n(首次记账: 从本次开始, 下次运行显示差值)");
			}

			fallback.push(`-- 累计 (${d.usage.sessions} 会话) --`);
			fallback.push(`输入 ${fmtTokens(d.usage.uncachedInputTokens)} · 缓存 ${fmtTokens(d.usage.cacheReadTokens)} · 输出 ${fmtTokens(d.usage.outputTokens)}`);
			fallback.push(`累计预估: ¥${fmtMoney(d.totalCost)}`);
			fallback.push(`定价来源: ${d.priceSource} | 高峰 输入${d.prices.peak.inputMiss}/缓存${d.prices.peak.inputHit}/输出${d.prices.peak.output} · 低谷 ${d.prices.offpeak.inputMiss}/${d.prices.offpeak.inputHit}/${d.prices.offpeak.output} (¥/百万)`);

			// 横幅 (kind=balance, mode=detail): 统计格 + 键值行 (token 差值/运算过程/累计)
			const stats = [
				{ label: "本次预估", value: seg ? `¥${fmtMoney(seg.deltaCost)}` : "—", strong: seg },
				...(d.balanceMoved !== null ? [{ label: "官方扣费", value: `${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))}`, note: "延迟" }] : []),
				{ label: "累计预估", value: `¥${fmtMoney(d.totalCost)}`, note: `${d.usage.sessions} 会话` }
			];
			const kv = [];
			if (seg) {
				kv.push({ k: "token 差值", v: `输入 ${fmtSignedTokens(seg.delta.uncachedInputTokens)} · 缓存命中 ${fmtSignedTokens(seg.delta.cacheReadTokens)} · 缓存未命中 ${fmtSignedTokens(seg.delta.cacheWriteTokens)} · 输出 ${fmtSignedTokens(seg.delta.outputTokens)}` });
				kv.push({ k: "运算过程", v: `输入 ${fmtTokens(seg.delta.uncachedInputTokens + seg.delta.cacheWriteTokens)} × ¥${seg.p.inputMiss} + 缓存 ${fmtTokens(seg.delta.cacheReadTokens)} × ¥${seg.p.inputHit} + 输出 ${fmtTokens(seg.delta.outputTokens)} × ¥${seg.p.output}（每百万 · ${seg.tier}价 · ${seg.priceSource}）` });
			} else {
				kv.push({ k: "记账状态", v: "首次记账: 从本次开始, 下次运行显示差值" });
			}
			kv.push({ k: "累计用量", v: `输入 ${fmtTokens(d.usage.uncachedInputTokens)} · 缓存 ${fmtTokens(d.usage.cacheReadTokens)} · 输出 ${fmtTokens(d.usage.outputTokens)}` });

			const metaParts = [];
			if (seg) metaParts.push(`${segLabel} ${fmtElapsed(seg.ms)} · ${beijingHm(seg.from)} → ${beijingHm(seg.to)}`);
			if (d.balanceMoved !== null && d.stateBalance !== null && d.cny !== null) {
				metaParts.push(`上次 ¥${fmtMoney(d.stateBalance)} → 现在 ¥${fmtMoney(d.cny)}`);
			}
			const ok = await appendBanner(invocation.agent.session, {
				turn: null,
				anchorSeq: null,
				ctxKey: "balance-" + Date.now(),
				kind: "balance",
				priority: 3, foldable: false, family: "balance",
				// ★T-F′（2026-09-21 obs3S7；用户已签）：**命令↔行配对键** —— 命令面取宿主发放的同源 `commandId`
				//   （与 `command/done.data.commandId` 逐字同值；`invocation` 由 handler 作用域提供）；取不到 ⇒ null（不猜）
				commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
				// obs#3 段N（#A97 二 (a)）：**补唯一身份键** —— kit 会静默压平 mode（banner-kit:131）⇒
				//   同一 (kind,rev,mode) 会互相覆盖；本插件**不得用 mode 表达身份**，改用逐次唯一的 `rev`。
				rev: Date.now(),
				variant: "detail",
				title: `账户余额 ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}`,
				subtitle: d.available !== null ? `可用: ${d.available ? "是" : "否"}` : "",
				stats,
				kv,
				metaText: metaParts.join(" · "),
				advice: `定价: ${d.priceSource} · 高峰 输入${d.prices.peak.inputMiss} / 缓存${d.prices.peak.inputHit} / 输出${d.prices.peak.output} · 低谷 ${d.prices.offpeak.inputMiss} / ${d.prices.offpeak.inputHit} / ${d.prices.offpeak.output}（¥/百万）`
			});
			if (!ok) return { kind: "success", text: fallback.join("\n") };
			return { kind: "success", text: "" };
		}
	});

	// ---- 当前会话费用预估 (纯本地, 不打官方 API/余额) ----
	ctx.commands.register({
		name: "cost",
		description: "当前会话费用预估: 按输入/缓存命中/输出分列 + 整体合计 (本地计算, 横幅展示)",
		handler: async (invocation) => {
			const sessionId = invocation?.agent?.session?.id;
			if (!sessionId) {
				return { kind: "error", text: "无法确定当前会话 (agent.session.id 为空)" };
			}
			const usage = await readSessionUsage(sessionId);
			// 树聚合 (设计 §3.1): 当前会话 + 全部后代(subagent) projcache 四类 → agg;
			// 库缺失/异常/无后代 → agg=null/不可用 → 完全走现状 (含 usage null 的 error 路径)。
			const treeMod = await loadCostTree();
			let agg = null;
			if (treeMod) {
				try { agg = await treeMod.subtreeTotalsFromProjcache(sessionId, { force: true }); }
				catch { agg = null; }
			}
			// agg.totals 含自身行(如有)+后代; 自身无行但后代有消耗时也可用 (treeUsable)
			const treeUsable = !!(agg?.totals && (agg?.children?.length > 0 || agg?.ownTotals));
			if (!usage && !treeUsable) {
				// 无数据 → 红色 error 家族横幅
				const ok = await appendBanner(invocation.agent.session, {
					kind: "error",
					priority: 0, foldable: true, family: "error",
					title: "暂时无法计算",
					lines: ["当前会话暂无 tokenUsage 数据（projcache 未落盘）"],
					metaText: "稍后再试即可 · 本提示不会进入模型历史"
				});
				if (ok) return { kind: "success", text: "" };
				return { kind: "error", text: "当前会话暂无 tokenUsage 数据 (projcache 未落盘, 稍后再试)" };
			}
			// 定价 (RD-42/RD-43): 价格归共享库; 本插件 state 不再存价
			const { prices, source: priceSource } = await resolvePrices();
			const tier = tierOf();
			const p = prices[tier];
			// reasoning (RD-30/RD-44): 全会话 reasoningTokens 之和 (每次全量重算); 不可用 ⇒ 0
			const reasoning = await sessionReasoningTokens(invocation.agent.session);
			// 计算源: 树聚合可用 → 用 agg.totals (聚合含父自身行); 否则现状 usage
			const src = treeUsable ? agg.totals : usage;
			const u = src.uncachedInputTokens ?? 0;
			const r = src.cacheReadTokens ?? 0;
			const w = src.cacheWriteTokens ?? 0;
			const o = src.outputTokens ?? 0;
			const billed = u + r + w;
			const hit = billed > 0 ? Math.round((r / billed) * 100) : null;
			const present = costTreePresentation(treeUsable ? agg : null, p); // 有后代时的文案/kv/stat; 无 → null
			const lines = [];
			lines.push(`当前会话费用预估 (${tier === "peak" ? "高峰" : "低谷"}价) · ${sessionId.slice(8, 16)}${present ? " · 含子 agent 树口径" : ""}`);
			if (present) lines.push(present.note);
			lines.push(`token: 输入 ${fmtTokens(u)} · 缓存命中 ${fmtTokens(r)} · 缓存未命中 ${fmtTokens(w)} · 输出 ${fmtTokens(o)}${reasoning > 0 ? ` · 推理 ${fmtTokens(reasoning)}` : ""}`);
			lines.push(`单价(¥/百万): 输入 ${p.inputMiss} / 缓存命中 ${p.inputHit} / 输出 ${p.output}`);
			lines.push(`输入(未命中) ${fmtTokens(u + w)} × ¥${p.inputMiss} = ¥${fmtYuan((u + w) * p.inputMiss / 1e6)}`);
			if (w > 0) lines.push(`  ├ 其中缓存未命中 ${fmtTokens(w)} × ¥${p.inputMiss} = ¥${fmtYuan(w * p.inputMiss / 1e6)}`);
			lines.push(`缓存命中 ${fmtTokens(r)} × ¥${p.inputHit} = ¥${fmtYuan(r * p.inputHit / 1e6)}`);
			lines.push(`输出 ${fmtTokens(o)} × ¥${p.output} = ¥${fmtYuan(o * p.output / 1e6)}${reasoning > 0 ? ` · 推理 ${fmtTokens(reasoning)} × ¥${p.output}（按输出价, RD-30）= ¥${fmtYuan(reasoning * p.output / 1e6)}` : ""}`);
			if (present) for (const row of present.childrenKV) lines.push(`${row.k}: ${row.v}`);
			lines.push(`──────────────`);
			lines.push(`合计预估 ¥${fmtYuan(costOf(src, p, { reasoning }))}${hit !== null ? ` (缓存命中率 ${hit}%)` : ""}`);
			lines.push(`定价来源: ${priceSource} · 本地估算, 实际以官方账单为准`);

			// 横幅 (kind=balance, mode=session): 合计高亮统计格 + 分项键值行
			const total = costOf(src, p, { reasoning });
			const stats = [
				{ label: "合计预估", value: `¥${fmtYuan(total)}`, strong: true },
				...(hit !== null ? [{ label: "缓存命中率", value: `${hit}%` }] : []),
				{ label: "token 总量", value: fmtTokens(u + r + w + o) },
				...(present ? [present.stat] : [])
			];
			const kv = [
				{ k: "输入(未命中)", v: `${fmtTokens(u + w)} × ¥${p.inputMiss} = ¥${fmtYuan((u + w) * p.inputMiss / 1e6)}${w > 0 ? `（其中缓存未命中 ${fmtTokens(w)} → ¥${fmtYuan(w * p.inputMiss / 1e6)}）` : ""}` },
				{ k: "缓存命中", v: `${fmtTokens(r)} × ¥${p.inputHit} = ¥${fmtYuan(r * p.inputHit / 1e6)}` },
				{ k: "输出", v: `${fmtTokens(o)} × ¥${p.output} = ¥${fmtYuan(o * p.output / 1e6)}${reasoning > 0 ? `（推理 ${fmtTokens(reasoning)} × ¥${p.output} 按输出价 = ¥${fmtYuan(reasoning * p.output / 1e6)}）` : ""}` },
				...(present?.childrenKV ?? [])
			];
			const ok = await appendBanner(invocation.agent.session, {
				turn: null,
				anchorSeq: null,
				ctxKey: "balance-" + Date.now(),
				kind: "balance",
				priority: 3, foldable: false, family: "balance",
				// ★T-F′（2026-09-21 obs3S7；用户已签）：**命令↔行配对键** —— 命令面取宿主发放的同源 `commandId`
				//   （与 `command/done.data.commandId` 逐字同值；`invocation` 由 handler 作用域提供）；取不到 ⇒ null（不猜）
				commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
				// obs#3 段N（#A97 二 (a)）：**补唯一身份键** —— kit 会静默压平 mode（banner-kit:131）⇒
				//   同一 (kind,rev,mode) 会互相覆盖；本插件**不得用 mode 表达身份**，改用逐次唯一的 `rev`。
				rev: Date.now(),
				variant: "session",
				title: "当前会话费用预估",
				subtitle: `(${tier === "peak" ? "高峰" : "低谷"}价 · 会话 ${sessionId.slice(8, 16)})`,
				stats,
				kv,
				metaText: `单价(¥/百万): 输入 ${p.inputMiss} / 缓存命中 ${p.inputHit} / 输出 ${p.output} · 定价来源: ${priceSource}`,
				advice: "本地估算，实际扣费以官方账单为准"
			});
			if (!ok) return { kind: "success", text: lines.join("\n") };
			return { kind: "success", text: "" };
		}
	});
}
