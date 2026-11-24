// @ericality/dsh-cost-pricing v0.1.0 — 共享取价/计费纯库
// ============================================================
// 契约: docs/任务记录/2026-09-13-阶段2-共享派单模板.md §2.1 (签名即契约, 逐字一致)
// 职责 (铁律):
//   - 官方定价页解析 (Flash 列: 每时段首个数字) / 高峰低谷时段判定 / 计费 (含 reasoning 按输出价);
//   - projcache 兼容读取 (分片优先 + 单体补历史);
//   - 价格缓存: 自己的 cost-pricing-cache.json (单飞 + 内存单例) + 旧四插件 state 迁移读取。
// 形态 (契约 §1/§10):
//   - 零第三方依赖; 无 apply/inject; 顶层永不 throw; exports 只有 "." 与 "./package.json";
//   - 消费方一律 await import() + try/catch (契约 §10.1 禁静态 import 共享包)。
// 降级路径 (loadPrices 永不 null / 永不 throw):
//   状态缓存(30 分钟内) → 官方页解析 → 上次缓存 → 内置常量 FALLBACK_PRICES
// 只读铁律: 本库只写 `${DSH_PRICING_CACHE_DIR:-$DSH_HOME/plugin-data/cost-pricing}/cost-pricing-cache.json` 一个文件,
//   绝不写其它插件的 `*-state.json` (模板 §2.1 状态文件归属写死)。
// ============================================================
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本库缓存落 <root>/plugin-data/cost-pricing/。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
import { readFile, readdir, writeFile } from "node:fs/promises";

/** 官方定价页 (裸请求 302, fetch 默认跟随重定向) */
export const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

/** 内置兜底常量 (RD-29: 2026-09-13 官方页实取 Flash 列, ¥/百万 tokens) */
export const FALLBACK_PRICES = {
	peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
	offpeak: { inputMiss: 1, inputHit: 0.02, output: 4 }
};

const PRICING_TIMEOUT_MS = 12000;
const PRICING_CACHE_TTL_MS = 30 * 60 * 1000;
/** 锚点后片段长度 (模板 §2.1 写死 ≤260 字符) */
const ANCHOR_SPAN = 260;
const TIER_OFF = "空闲时段";
const TIER_PEAK = "高峰时段";
const KW_HIT = "（缓存命中）";
const KW_MISS = "（缓存未命中）";
const KW_OUT = "百万tokens输出";
/** 三个行标签锚点 (RD-41: 片段边界 = 紧邻的下一个锚点 / 260 字符 / 文本末尾, 取先到者) */
const ANCHORS = [KW_HIT, KW_MISS, KW_OUT];

const DEFAULT_DATA_DIR = join(DSH_HOME, "plugin-data", "cost-pricing");
const PRICING_CACHE_NAME = "cost-pricing-cache.json";
/** 迁移期: 旧的四插件 state (按序, 见模板 §2.1) */
const LEGACY_STATE_FILES = [
	"cost-ledger-state.json",
	"cost-guard-state.json",
	"balance-state.json",
	"sessions-cost-state.json"
];
const DEFAULT_PROJCACHE_FILE = join(DSH_HOME, "storages", "session_projcache.json");
const DEFAULT_PROJCACHE_SHARD_DIR = join(DSH_HOME, "storages", "session_projcache", "sessions");

// ---- 路径解析 (环境变量覆盖仅供测试/本地校验) ----
function dataDir() {
	return process.env.DSH_PRICING_CACHE_DIR || DEFAULT_DATA_DIR;
}
function pricingCacheFile() {
	return `${dataDir()}/${PRICING_CACHE_NAME}`;
}
function projcacheFile() {
	return process.env.DSH_PROJCACHE_FILE || DEFAULT_PROJCACHE_FILE;
}
function projcacheShardDir() {
	return process.env.DSH_PROJCACHE_DIR || DEFAULT_PROJCACHE_SHARD_DIR;
}

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

function beijingHm(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** 时段判定 (逐字复刻 dsh-cost-ledger currentTier): 北京时区, 周末全天空闲, 否则 9-12/14-18 高峰 */
/* ── 时段权威（2026-09-25 offpeak-fix 批2a）：**本库不再自算时段**，唯一权威 = `@ericality/dsh-cost-tier` ──
 *  纪律：契约 §10.1 **禁静态 import 共享包** ⇒ 用 `await import()` ＋ 缓存（`warmTier()`）；`tierOf` 保持**同步签名**。
 *  ★未 warm 成功 ⇒ **保守按 `peak`**（宁可多算不可少算）并记**降级原因**（供面板/判据读），**绝不静默自算**。
 *  ★节假日口径（放假日 (ii)）与边界算法全部由权威提供 ⇒ 修复「节假日被当成高峰」。 */
let tierMod = null;
let tierTried = false;
const TIER_REASONS = [];
/** 解析时段权威（幂等、永不 throw）。消费方在 `await loadPrices()` 前后调用即可就绪。 */
export async function warmTier() {
	if (tierTried) return tierMod;
	tierTried = true;
	try {
		const m = await import("@ericality/dsh-cost-tier");
		tierMod = (m && typeof m.tierOf === "function") ? m : null;
		if (!tierMod) TIER_REASONS.push("cost-tier 已加载但无 tierOf ⇒ 时段判定降级为保守 peak");
	} catch (err) {
		tierMod = null;
		TIER_REASONS.push(`cost-tier 不可加载 ⇒ 时段判定降级为保守 peak（${String(err?.message ?? err).slice(0, 60)}）`);
	}
	return tierMod;
}
/** 时段判定（**唯一权威在 `@ericality/dsh-cost-tier`**；未就绪 ⇒ 保守 peak ＋ 记降级） */
export function tierOf(ms) {
	if (tierMod && typeof tierMod.tierOf === "function") return tierMod.tierOf(ms);
	if (!tierTried) void warmTier();
	return "peak";
}
/** 时段判定健康态（单状态 ＋ 逐条原因）—— 供面板/判据读取，禁静默 */
export function tierHealth() {
	return { degraded: !tierMod, reasons: [...TIER_REASONS], authority: "@ericality/dsh-cost-tier" };
}
/** 权威是否已就绪（判据用） */
export function tierAuthorityReady() { return !!tierMod; }

/** HTML → 单行纯文本 (与既有实现同款: 去 script/style/标签, 压空白) */
function stripHtml(text) {
	return String(text ?? "")
		.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");
}

function firstNumber(s) {
	const m = String(s).match(/(\d+(?:\.\d+)?)/);
	return m ? parseFloat(m[1]) : null;
}

/**
 * 锚点片段 (RD-41): 从锚点起, 到「紧邻的下一个锚点 / 260 字符 / 文本末尾」先到者为止。
 * ⚠️ 必须按锚点截断: 否则某行缺自己的标签时, 窗口会溢到下一行并静默借到下一行的数字 (真实页面
 * `（缓存命中）` 与 `（缓存未命中）` 仅相距 52 字符), 与「解析异常 ⇒ null」冲突。
 */
function segmentOf(text, keyword) {
	const idx = text.indexOf(keyword);
	if (idx < 0) return null;
	let end = Math.min(idx + ANCHOR_SPAN, text.length);
	for (const other of ANCHORS) {
		if (other === keyword) continue;
		const j = text.indexOf(other, idx + keyword.length);
		if (j >= 0 && j < end) end = j;
	}
	return text.slice(idx, end);
}

/**
 * 单个锚点片段 → { offpeak, peak }: 片段内按「空闲时段 / 高峰时段」切分, 每段第一个数字 = Flash 列。
 * 任一锚点/时段缺失或段内无数字 ⇒ null (绝不套兜底)。
 */
function tierPairOf(text, keyword) {
	const seg = segmentOf(text, keyword);
	if (seg === null) return null;
	const offIdx = seg.indexOf(TIER_OFF);
	const peakIdx = seg.indexOf(TIER_PEAK);
	if (offIdx < 0 || peakIdx < 0) return null;
	const offEnd = peakIdx > offIdx ? peakIdx : seg.length;
	const peakEnd = offIdx > peakIdx ? offIdx : seg.length;
	const offpeak = firstNumber(seg.slice(offIdx + TIER_OFF.length, offEnd));
	const peak = firstNumber(seg.slice(peakIdx + TIER_PEAK.length, peakEnd));
	if (offpeak === null || peak === null) return null;
	return { offpeak, peak };
}

/**
 * 解析官方定价页 (Flash 列)。
 * 不传 htmlText 时自己 fetch (UA Mozilla/5.0, 12s 超时, 跟随重定向)。
 * 任何异常 / 锚点缺失 / 段内无数字 ⇒ null (绝不返回兜底常量)。
 */
export async function parseOfficialPrices(htmlText) {
	try {
		let raw = htmlText;
		if (typeof raw !== "string") {
			const resp = await fetch(PRICING_PAGE_URL, {
				headers: { "User-Agent": "Mozilla/5.0" },
				signal: AbortSignal.timeout(PRICING_TIMEOUT_MS)
			});
			if (!resp?.ok) return null;
			raw = await resp.text();
		}
		const text = stripHtml(raw);
		const hit = tierPairOf(text, KW_HIT);
		const miss = tierPairOf(text, KW_MISS);
		const out = tierPairOf(text, KW_OUT);
		if (!hit || !miss || !out) return null;
		return {
			peak: { inputMiss: miss.peak, inputHit: hit.peak, output: out.peak },
			offpeak: { inputMiss: miss.offpeak, inputHit: hit.offpeak, output: out.offpeak }
		};
	} catch {
		return null;
	}
}

/** 读价格状态缓存: 自己的缓存文件优先, 其次按序读旧四插件 state (迁移期) */
async function readPricingCache() {
	try {
		const d = JSON.parse(await readFile(pricingCacheFile(), "utf8"));
		if (d?.prices) return { prices: d.prices, pricesFetchedAt: num(d.pricesFetchedAt) };
	} catch { /* 无自有缓存 */ }
	for (const name of LEGACY_STATE_FILES) {
		try {
			const d = JSON.parse(await readFile(`${dataDir()}/${name}`, "utf8"));
			if (d?.prices) return { prices: d.prices, pricesFetchedAt: num(d.pricesFetchedAt) };
		} catch { /* next */ }
	}
	return null;
}

async function writePricingCache(prices) {
	try {
		mkdirSync(dataDir(), { recursive: true });
		await writeFile(pricingCacheFile(), JSON.stringify({ prices, pricesFetchedAt: Date.now() }, null, 2), "utf8");
	} catch { /* non-fatal: 写失败不影响本次取价 */ }
}

/** 内存单例 (上次成功取到的价; 状态文件不可用时的最后回退) */
let memPrices = null;
/** 单飞: 并发调用共享同一个 in-flight Promise */
let inflight = null;

function ttlFresh(state, force) {
	return !!state?.prices && force !== true && Date.now() - (state.pricesFetchedAt ?? 0) < PRICING_CACHE_TTL_MS;
}

async function loadPricesInner(force) {
	const state = await readPricingCache();
	if (ttlFresh(state, force)) {
		memPrices = state;
		return { prices: state.prices, source: `缓存(30分钟内) ${beijingHm(state.pricesFetchedAt)}` };
	}
	if (!state && ttlFresh(memPrices, force)) {
		return { prices: memPrices.prices, source: `缓存(30分钟内) ${beijingHm(memPrices.pricesFetchedAt)}` };
	}
	const fresh = await parseOfficialPrices();
	if (fresh) {
		memPrices = { prices: fresh, pricesFetchedAt: Date.now() };
		await writePricingCache(fresh);
		return { prices: fresh, source: `官方页解析 ${beijingHm(Date.now())}` };
	}
	// 解析失败 ⇒ 保留旧缓存 (任务书 §4.1), 绝不套兜底
	const old = state?.prices ?? memPrices?.prices ?? null;
	return { prices: old ?? FALLBACK_PRICES, source: old ? "上次缓存" : "内置常量" };
}

/**
 * 取价 (永不 null / 永不 throw)。顺序: 状态缓存(<30min, force!==true) → 官方页解析 → 上次缓存 → 内置常量。
 * 内置单飞 + 内存单例; force:true 绕过 TTL 但仍走单飞。
 */
export async function loadPrices(opts = {}) {
	void warmTier(); // 批2a：进入取价流程即并行预热时段权威（不改变本函数语义/时序）
	const force = opts?.force === true;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			return await loadPricesInner(force);
		} catch {
			const old = memPrices?.prices ?? null;
			return { prices: old ?? FALLBACK_PRICES, source: old ? "上次缓存" : "内置常量" };
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/**
 * 计费 (元)。totals 缺字段按 0, 非有限数一律 0 ⇒ 永不 throw / 不返回 NaN。
 * **逐字复刻既有实现**的算式 (balance/cost-ledger/cost-guard 同源), 仅追加 RD-30 的 reasoning 项:
 *   ((uncached + cacheWrite) * inputMiss + cacheRead * inputHit + output * output) / 1e6 + reasoning * output / 1e6
 * ⇒ 与旧 costOf 逐位一致 (reasoning 缺省为 0 时加 0 不改变取值), golden 对撞不会出现浮点末位差。
 */
export function costOf(totals, price, opts = {}) {
	const t = totals ?? {};
	const p = price ?? {};
	return (
		((num(t.uncachedInputTokens) + num(t.cacheWriteTokens)) * num(p.inputMiss)
			+ num(t.cacheReadTokens) * num(p.inputHit)
			+ num(t.outputTokens) * num(p.output)) / 1e6
		+ (num(opts?.reasoning) * num(p.output)) / 1e6
	);
}

/**
 * 计费分桶 (元): 各桶分项元值 + total (= costOf 的值, **与 costOf 逐值相等**)。
 * ⚠️ 浮点结合律: `total` 与「四项字面相加」在末位 (≲1e-9 相对) 可能不同 —— 契约模板 §2.1 同时要求
 * 「total = 各项和」与「total 与 costOf 逐值一致」, 二者在同一浮点体系下不可兼得; 本库以
 * 「与 costOf 逐值一致 + costOf 与旧实现逐位一致」为先 (golden 对撞硬要求), 见回报「决策登记 D-2」。
 * 对撞建议: 用 1e-9 容差比对 total 与四项之和, 或直接对 costOf 逐值比对。
 */
export function costOfBuckets(totals, price, opts = {}) {
	const t = totals ?? {};
	const p = price ?? {};
	const inputMiss = ((num(t.uncachedInputTokens) + num(t.cacheWriteTokens)) * num(p.inputMiss)) / 1e6;
	const inputHit = (num(t.cacheReadTokens) * num(p.inputHit)) / 1e6;
	const output = (num(t.outputTokens) * num(p.output)) / 1e6;
	// RD-30: reasoning tokens 按输出价计
	const reasoning = (num(opts?.reasoning) * num(p.output)) / 1e6;
	return { inputMiss, inputHit, output, reasoning, total: costOf(totals, price, opts) };
}

/** 全部会话 record: 分片优先, 单体表补历史 (逐字复刻 dsh-balance readProjcacheAll) */
export async function readProjcacheAll() {
	const out = {};
	try {
		for (const n of await readdir(projcacheShardDir())) {
			if (!n.endsWith(".json")) continue;
			const sid = n.slice(0, -5);
			try {
				const d = JSON.parse(await readFile(`${projcacheShardDir()}/${n}`, "utf8"));
				if (d?.record?.rows) out[sid] = d.record;
			} catch { /* 坏分片跳过 */ }
		}
	} catch { /* 无分片目录 */ }
	try {
		const cache = JSON.parse(await readFile(projcacheFile(), "utf8"));
		for (const [sid, v] of Object.entries(cache?.tables?.sessions ?? {})) if (!out[sid]) out[sid] = v;
	} catch { /* ignore */ }
	return out;
}

/** 单会话 record (分片优先, 单体表回退), 无 ⇒ null */
export async function readProjcacheOne(sid) {
	try {
		const d = JSON.parse(await readFile(`${projcacheShardDir()}/${sid}.json`, "utf8"));
		if (d?.record?.rows) return d.record;
	} catch { /* 回退 */ }
	try {
		const cache = JSON.parse(await readFile(projcacheFile(), "utf8"));
		return cache?.tables?.sessions?.[sid] ?? null;
	} catch { return null; }
}
