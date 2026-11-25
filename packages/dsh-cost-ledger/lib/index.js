import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
/** ★批7 `T15`（`#A342`）：横幅卡的**真实身份** ⇒ 32 hex `cardId`（形状由 `dsh-banner-kit` 校验：非法 ⇒ 整条被拒 ⇒ 故必须 32 hex）。
 *  口径 = **该卡既有身份输入**（同 `ctxKey` 同源）；本卡语义 = **每回合一张**（`turn`）⇒ 稳定身份，缺身份输入 ⇒ 显式 `null`（走旧路径，不伪造）。 */
const _cardId = (ns, ...parts) => (parts.some((x) => x === null || x === undefined || x === "") ? null
	: createHash("sha256").update([ns, ...parts].join("|")).digest("hex").slice(0, 32));
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/cost-ledger/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "cost-ledger");

// ---------- 插件配置（/api/cost-ledger/config，落 plugin-data/cost-ledger/settings.json，schemaVersion 1） ----------
const SETTINGS_FILE = process.env.DSH_COST_LEDGER_SETTINGS_FILE || joinPath(PLUGIN_DATA, "settings.json");
const SETTINGS_SCHEMA = 1;
// 默认值 = 改造前常量（LEDGER_MAX_ENTRIES = 50），默认折叠/注入与旧行为一致
const SETTINGS_DEFAULTS = Object.freeze({ maxEntriesPerSession: 50, defaultCollapsed: true, injectTurnCard: true });
const SETTINGS_NUMBERS = Object.freeze({ maxEntriesPerSession: [5, 500] });
const SETTINGS_BOOLS = Object.freeze(["defaultCollapsed", "injectTurnCard"]);
const settingsState = { mtimeMs: -1, value: { ...SETTINGS_DEFAULTS } };

/** 归一化：缺省/坏值一律回默认值。 */
function cleanSettings(input) {
	const src = input && typeof input === "object" ? input : {};
	const out = { ...SETTINGS_DEFAULTS };
	for (const [key, [min, max]] of Object.entries(SETTINGS_NUMBERS)) {
		const v = src[key];
		if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) out[key] = v;
	}
	for (const key of SETTINGS_BOOLS) if (typeof src[key] === "boolean") out[key] = src[key];
	return out;
}

/** 现读配置（按 mtime 失效；文件缺失回默认值，永不 throw）。 */
async function readSettings() {
	try {
		const st = await stat(SETTINGS_FILE);
		if (st.mtimeMs === settingsState.mtimeMs) return settingsState.value;
		const raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
		const clean = cleanSettings(raw && typeof raw === "object" && raw.settings ? raw.settings : raw);
		settingsState.mtimeMs = st.mtimeMs;
		settingsState.value = clean;
		return clean;
	} catch {
		return { ...SETTINGS_DEFAULTS };
	}
}

/** 落盘（合并后写全量，schemaVersion 1）。 */
async function writeSettings(patch) {
	const next = cleanSettings({ ...(await readSettings()), ...(patch || {}) });
	try {
		mkdirSync(PLUGIN_DATA, { recursive: true });
		await writeFile(SETTINGS_FILE, JSON.stringify({ schemaVersion: SETTINGS_SCHEMA, settings: next }, null, 2), "utf8");
		settingsState.mtimeMs = -1;
		settingsState.value = next;
		return { ok: true, settings: next };
	} catch (err) {
		return { ok: false, message: String(err?.message ?? err) };
	}
}

/** set 的前置校验：类型与范围不符 ⇒ ok:false（原值不变）。 */
function validateSettings(payload) {
	const src = payload && typeof payload === "object" && payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
	if (!src || typeof src !== "object") return { ok: false, message: "缺少配置对象" };
	const patch = {};
	for (const [key, value] of Object.entries(src)) {
		if (Object.hasOwn(SETTINGS_NUMBERS, key)) {
			const [min, max] = SETTINGS_NUMBERS[key];
			if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return { ok: false, message: `${key} 必须是 ${min} 到 ${max} 之间的数字` };
			patch[key] = value;
		} else if (SETTINGS_BOOLS.includes(key)) {
			if (typeof value !== "boolean") return { ok: false, message: `${key} 必须是布尔值` };
			patch[key] = value;
		} else {
			return { ok: false, message: `未知字段 ${key}` };
		}
	}
	if (!Object.keys(patch).length) return { ok: false, message: "没有可保存的字段" };
	return { ok: true, patch };
}

/** 注册 /api/cost-ledger/config 的 get / set / reset（经 host-compat 通道面；失败如实 warn）。 */
function registerConfigApi(ctx) {
	const handler = async (endpoint, payload) => {
		try {
			if (endpoint === "get") return { ok: true, value: { settings: await readSettings(), defaults: { ...SETTINGS_DEFAULTS } } };
			if (endpoint === "reset") {
				const r = await writeSettings({ ...SETTINGS_DEFAULTS });
				return r.ok ? { ok: true, value: { settings: r.settings, defaults: { ...SETTINGS_DEFAULTS } } } : { ok: false, error: { code: "internal", message: r.message } };
			}
			if (endpoint === "set") {
				const v = validateSettings(payload);
				if (!v.ok) return { ok: false, error: { code: "bad-request", message: v.message } };
				const r = await writeSettings(v.patch);
				return r.ok ? { ok: true, value: { settings: r.settings, defaults: { ...SETTINGS_DEFAULTS } } } : { ok: false, error: { code: "internal", message: r.message } };
			}
			return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
		} catch (err) {
			ctx.logger?.warn?.(`dsh-cost-ledger: /api/cost-ledger/config ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") { ctx.logger?.warn?.("dsh-cost-ledger: host-compat 未提供 channelFace，/api/cost-ledger/config 不可用"); return; }
		const face = seams.channelFace(ctx, "/cost-ledger/config", ["get", "set", "reset"], handler);
		if (!face?.ok) ctx.logger?.warn?.(`dsh-cost-ledger: /api/cost-ledger/config 注册失败 ${JSON.stringify(face?.results ?? [])}`);
	}).catch((err) => { ctx.logger?.warn?.(`dsh-cost-ledger: host-compat 加载失败 ${String(err?.message ?? err)}`); });
}
const COMPAT_DIR = process.env.DSH_COMPAT_DIR || joinPath(DSH_HOME, "plugin-data", "host-compat");
const LOG_DIR = joinPath(DSH_HOME, "logs", "cost-ledger");
// v0.3.3 (2026-09-14): 模型工具 session_cost —— agent 自查实时费用
// (算式复用本插件既有 costOf / tierOf / resolvePrices, 不新写公式; 出处见
//  docs/待办/2026-09-14-实时费用工具与人工删队取消-讨论稿.md §A)
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @deepseek-ai/dsh-cost-ledger (本地辅助插件, 非官方包)
 *
 * 会话账本: 回合结束 (turn/end) 自动记账 —— 每回合注入一张 ledger 横幅卡片
 * (青绿家族, 由 dsh-notice-banner client 渲染), 记录:
 *   - 当前会话费用合计预估 (复用 /cost 口径: projcache tokenUsage × 定价)
 *   - 与上次计算相比的差值 (本回合增量)
 *   - 本会话历史纪录 (每次计算的 {回合, 时间, 合计, 差值})
 *
 * 数据设计 (用户确认):
 *   - 每回合结束追加一张新卡 (独立 context ledger-<seq>, 不替换, 不刷屏: 默认折叠)
 *   - 历史按会话 id 分桶存 $DSH_HOME/cost-ledger.json (每会话最多 50 条), 不全局共享
 *   - 所有卡片共享同一份账本: 客户端展开卡片时经 /cost-ledger RPC 通道实时拉取
 *     (零 token, 与 dsh-taskqueue /queue 同机制) → 任何旧卡片点开都与最新卡片一致;
 *     RPC 失败回退横幅内嵌的静态快照
 *   - 统计格 (合计/本回合/次数) = 该卡创建时刻的快照 (记录当时账本状态)
 *
 * 定价: 状态缓存(30min) → 官方定价页 → 内置常量 (与 cost-guard 同款回退链)。
 * 零 token: 横幅为非 surface 事件 (不进模型历史); RPC 不消耗模型 token。
 */
export const name = "dsh-cost-ledger";
// v0.3.3: 追加 "tools"/"commands" —— 注册模型工具 session_cost + 斜杠命令 /cost-now
// (仅追加, 不改顺序; 与 dsh-graceful-restart / dsh-taskqueue 同一写法)
export const inject = ["commands", "tools", "connection"];

const PROJCACHE_FILE = joinPath(DSH_HOME, "storages", "session_projcache.json");
// ---- projcache 兼容读取 (2026-09-10, 0.1.2 适配) ----
// 0.1.2 起投影缓存按会话分片落盘 <root>/session_projcache/sessions/<sid>.json
// (镜像 dsh-session-projection-cache 自述: "per-record ... one document per session
//  ... instead of the whole unit"); 单体 session_projcache.json 自 09-09 05:31 起不再更新,
// 只作历史会话回退。旧代码只读单体表 → 新会话无数据 / 老会话数值陈旧 (生产实测)。
const PROJCACHE_SHARD_DIR = joinPath(DSH_HOME, "storages", "session_projcache", "sessions");

// ================= host-compat 能力声明 (阶段 1 契约 §3; RD-1) =================
/** 本插件声明需要的能力 (§3 key; 必须与 package.json `dshCompat.seams` 集合相等 — RD-1) */
const REQUIRES = ["sessionAppend", "eventTypeRegistry", "projcache", "commands", "tools"]; // `#A59`: 通道面走 channelFace
/** 缺这些能力 ⇒ BLOCKED (§3/D1: 缺失会写坏数据 — 未注册事件类型进会话日志 ⇒ 会话无法加载) */
/** 缺这些能力 ⇒ **路径级** BLOCKED (RD-20; 与 package.json `dshCompat.blocked` 同源, 此处仅为"读 package.json 失败"时的回退) */
const BLOCKED_FALLBACK = ["eventTypeRegistry"];
/** §3 key → §4 seam 函数名 (§4 v1 冻结面; 缺 key 即视为该面不可用) */
const SEAM_OF = { sessionAppend: "appendNotice", eventTypeRegistry: "ensureEventTypes", rpcHandle: "rpcHandle" };
/** §3 `projcache` 探测 = 路径/形状探测 (本插件直读文件, 不经宿主 API) */
function projcacheReadable() {
	try { return existsSync(PROJCACHE_FILE) || existsSync(PROJCACHE_SHARD_DIR); } catch { return false; }
}
/** 自身元信息: 版本 + 路径级阻断清单 (RD-20)。**禁止静态 import JSON** (避免与 package.json 双写漂移);
 *  运行时读自身 package.json; 读失败 ⇒ {version:"unknown", blocked:null} (调用方回退内置常量并告警)。 */
function ownMeta() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return {
			version: pkg?.version ?? "unknown",
			blocked: Array.isArray(pkg?.dshCompat?.blocked) ? pkg.dshCompat.blocked : null
		};
	} catch { return { version: "unknown", blocked: null }; }
}
/** §4.10: host-compat 不可用时插件自己写状态分片 (§5 单写者: 只写自己的分片; 0600) */
function writeShard(ctx, entry) {
	try {
		const dir = `${COMPAT_DIR}/compat-status.d`;
		mkdirSync(dir, { recursive: true });
		// 分片形状照 RD-15 裁定 (扁平 8 键, 不套 plugins[]): schema/id/version/state/missing/blocked/note/probedAt
		writeFileSync(`${dir}/${entry.id}.json`, JSON.stringify({ schema: 1, ...entry, probedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
	} catch (err) {
		ctx.logger?.warn?.(`dsh-cost-ledger: 适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

// ================= 共享库动态加载 (契约 §10.1: 禁静态 import 共享包) =================
/** 本插件告警出口 (apply 内接 ctx.logger.warn; 未接时退回 debug 文件) */
let logWarn = null;
function LOG(msg) {
	try { (logWarn ?? debug)(`[${name}] ${msg}`); } catch { /* noop */ }
}
/** RD-43/RD-26/RD-37: 共享库缺失 ⇒ 上报 (apply 内注入; 未注入时静默) */
let reportDegraded = null;

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
		reportDegraded?.("cost-pricing", "取价库缺失 → 用内置常量");
	}
	return pricingMod ?? DEGRADED_PRICING;
}

// ---- RD-37: 动态加载 reconcile (契约 §10.1 禁静态 import 共享包) ----
let reconcileMod;             // undefined = 尚未尝试
let reconcileDead = false;    // true = 已判定不可用（不重试）
export async function loadReconcile() {
	if (reconcileMod !== undefined) return reconcileMod;
	if (reconcileDead) return null;
	try {
		reconcileMod = await import("@ericality/dsh-reconcile");
	} catch (err) {
		reconcileDead = true; reconcileMod = null;
		LOG(`reconcile 不可用 → 对账路径停用: ${String(err?.message ?? err)}`);
		reportDegraded?.("reconcile", "reconcile 缺失 → 对账路径停用");   // 有 host-compat 的插件必须上报
	}
	return reconcileMod;
}

// ---- RD-26/RD-28: 动态加载横幅库 `@ericality/dsh-banner-kit` ----
let bannerKitMod;             // undefined = 尚未尝试
let bannerKitDead = false;    // true = 已判定不可用（不重试）
export async function loadBannerKit() {
	if (bannerKitMod !== undefined) return bannerKitMod;
	if (bannerKitDead) return null;
	try {
		bannerKitMod = await import("@ericality/dsh-banner-kit");
		// ★段2 `B6`（2026-09-29，"不得静默" · WRAP-B6）：emit **拒收**（形状非法）⇒ **必须面板可见 ＋ 点名** ——
		//   经中间件 `wrapBannerKit` 包一层（emit 非 ok 且属拒收 ⇒ 落 store ① `rejected` ⇒ 面板 `rejectedByReason`）。
		//   中间件不可用/旧版（无该面）⇒ **原样使用模块**（不伪造、不回落直连宿主）。
		try {
			const _smB6 = await import("@ericality/dsh-host-compat/seams");
			if (typeof _smB6.wrapBannerKit === "function") bannerKitMod = _smB6.wrapBannerKit(bannerKitMod, "dsh-cost-ledger");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch (err) {
		bannerKitDead = true; bannerKitMod = null;
		LOG(`banner-kit 不可用 → 横幅注入停用: ${String(err?.message ?? err)}`);
		reportDegraded?.("banner-kit", "banner-kit 缺失 → 横幅注入停用");
	}
	return bannerKitMod;
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
/** 全部会话 record: 共享库导出; 缺库 ⇒ 停用(空) */
async function readProjcacheAll() {
	try { return await (await pricingLib()).readProjcacheAll(); } catch { return {}; }
}
/** 单会话 record: 共享库导出 (分片优先, 单体回退); 缺库 ⇒ 停用(null) */
async function readProjcacheOne(sid) {
	try { return await (await pricingLib()).readProjcacheOne(sid); } catch { return null; }
}
/** 时段判定 (逐字复刻口径): 共享库已加载 ⇒ tierOf(Date.now()); 缺库 ⇒ 降级垫片同规则 */
function tierOf(ms) {
	const f = pricingMod?.tierOf;
	return typeof f === "function" ? f(ms) : DEGRADED_PRICING.tierOf(ms);
}
/** 计费 (RD-30): 共享库 costOf(totals, price, {reasoning}); 缺库 ⇒ 降级垫片同算式 */
function costOf(totals, price, opts) {
	const f = pricingMod?.costOf;
	return typeof f === "function" ? f(totals, price, opts) : DEGRADED_PRICING.costOf(totals, price, opts);
}

const LEDGER_FILE = joinPath(PLUGIN_DATA, "cost-ledger.json");
const LEDGER_MAX_ENTRIES = 50;
const DEBUG_ENABLED = process.env.DSH_COST_LEDGER_DEBUG === "1";
const DEBUG_LOG = joinPath(LOG_DIR, "cost-ledger-debug.log");

function debug(msg) {
	if (!DEBUG_ENABLED) return;
	try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

function beijingHm(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** ISO → 北京 "MM-DD HH:mm" */
function beijingMd(iso) {
	if (!iso) return "";
	try { return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " "); } catch { return ""; }
}

/** 当前会话 tokenUsage.totals (projcache 落盘后), 无则 null */
async function readSessionUsage(sessionId) {
	try {
		const s = await readProjcacheOne(sessionId); // 0.1.2: 分片优先, 单体表回退
		const tu = s?.rows?.tokenUsage?.val?.totals ?? s?.rows?.tokenUsage?.totals;
		return tu && (tu.uncachedInputTokens !== undefined || tu.cacheReadTokens !== undefined || tu.outputTokens !== undefined) ? tu : null;
	} catch {
		return null;
	}
}

// ── v0.3.3 (2026-09-14): 实时会话费用快照 + agent 工具 session_cost ──────────
// 动因: 账本 entries 是**回合结束后**才落一条 ⇒ 回合进行中读账本 = 读到"上一回合的累计"
//   (实测: 读到 ¥0.27, 实际该回合增量 ¥1.05 / 累计 ¥1.32, 差近 4×)。
// 实时口径 = projcache `rows.tokenUsage.val.totals`(每次 LLM 请求增量写) × 现行价
//   (costOf / tierOf / resolvePrices 全为本插件既有函数, 不新写公式)。
// 出参刻意极简: 默认 4 行文本, 不吐 JSON —— agent 只要"现在的数 + 口径", 不要明细。
async function sessionCostSnapshot(sessionId, session = null, opts = {}) {
	const usage = await readSessionUsage(sessionId);
	const { prices, source: priceSource } = await resolvePrices();
	const tier = tierOf(Date.now());
	const p = prices[tier];
	// 账本读数 (回合结算快照; 也提供"已结算的累计 reasoning")
	let entry = null, entryCount = 0, entries = [];
	try {
		const ledger = await readLedger();
		entries = ledger?.sessions?.[sessionId]?.entries ?? [];
		entryCount = entries.length;
		entry = entries.length ? entries[entries.length - 1] : null;
	} catch { /* 账本不可读 ⇒ entry 保持 null */ }
	// reasoning 累计值 (RD-30: 按输出价计): 账本最后一条已含累计 reasoning ⇒ 以它为准;
	// 无账本记录时保守取 0 (避免重复计入 observer 缓存的增量读数)。
	const reasoning = entry?.reasoning ?? 0;
	const liveTotal = usage ? costOf(usage, p, { reasoning }) : null;
	let children = null;
	if (opts.includeChildren) {
		try {
			const treeMod = await loadCostTree();
			if (treeMod) {
				const ids = (await treeMod.subtreeIds(sessionId)).filter((id) => id !== sessionId);
				if (ids.length) children = treeLedgerLatestTotal(await readLedger(), ids);
			}
		} catch { children = null; }
	}
	return { sessionId, usage, tier, price: p, priceSource, reasoning, liveTotal, entry, entryCount, entries, children };
}

/** 快照 → 紧凑文本 (默认 4 行; detail=true 展开分项与单价; turns>0 附最近 N 回合账本 delta) */
function formatSessionCost(sn, opts = {}) {
	const tierCn = sn.tier === "peak" ? "高峰" : "低谷";
	const L = [];
	if (!sn.usage && !sn.entry) {
		return `会话 ${String(sn.sessionId).slice(0, 12)} 暂无费用数据 (projcache 未落盘且账本无记录; 该会话可能尚未跑过模型请求)`;
	}
	const live = sn.liveTotal === null ? "—" : "¥" + sn.liveTotal.toFixed(2);
	const led = sn.entry ? "¥" + sn.entry.total.toFixed(2) : "—";
	L.push(`实时费用 ${live} (${tierCn}价 · projcache 每次请求增量写, 含进行中回合)`);
	L.push(`账本已结算 ${led}${sn.entryCount ? ` (${sn.entryCount} 回合` + (sn.entry ? ` · 末回合 #${sn.entry.t} +¥${(sn.entry.delta ?? 0).toFixed(2)} @${beijingMd(sn.entry.at)}` : "") + ")" : ""} · 回合结束后才落账 ⇒ 进行中回合未计入`);
	if (sn.liveTotal !== null && sn.entry) {
		const diff = sn.liveTotal - sn.entry.total;
		L.push(`差额 ¥${diff.toFixed(2)}${diff > 0.005 ? ` = 账本口径未含的增量(末回合结算后新产生的 token; 主要来自缓存读)` : diff < -0.005 ? " (实时低于账本: 疑似价格/口径差异, 请核价)" : " (一致)"}`);
	}
	if (sn.children && sn.children.count > 0) L.push(`含子 agent 树: ${sn.children.count} 个 · 树合计 +¥${sn.children.total.toFixed(2)} (账本口径)`);
	if (opts.detail) {
		const u = sn.usage ?? {};
		L.push(`token: 未命中输入 ${fmtTokens(u.uncachedInputTokens ?? 0)} · 缓存读 ${fmtTokens(u.cacheReadTokens ?? 0)} · 缓存写 ${fmtTokens(u.cacheWriteTokens ?? 0)} · 输出 ${fmtTokens(u.outputTokens ?? 0)}${sn.reasoning > 0 ? ` · 推理 ${fmtTokens(sn.reasoning)}` : ""}`);
		L.push(`单价(¥/百万): 输入 ${sn.price.inputMiss} / 缓存命中 ${sn.price.inputHit} / 输出 ${sn.price.output} · 定价来源: ${sn.priceSource}`);
	}
	if (opts.turns > 0 && sn.entryCount > 0) {
		const tail = (sn.entries ?? []).slice(-opts.turns);
		L.push(`最近 ${tail.length} 回合账本: ${tail.map((e) => `#${e.t} ¥${e.total.toFixed(2)}(+${(e.delta ?? 0).toFixed(2)} ${e.tier === "peak" ? "峰" : "谷"})`).join(" · ")}`);
	}
	L.push(`口径: 实时=projcache×现行价(含进行中回合) · 账本=回合结算快照; 报数请注明用的是哪个`);
	return L.join("\n");
}


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

// 2026-09-10 (0.1.2 适配): agent.session.events 已移除 → 观察者侧维护最近事件视图
// (推理 tokens 累计 / 最新回合号 / 会话标题), 否则这三个维度静默取空值。
const ledgerEventCache = new Map(); // sid -> { reasoning, maxTurn, title }
const LEDGER_CACHE_MAX = 300;
function cacheLedgerEvent(session, event) {
	try {
		const sid = String(session?.id ?? "");
		if (!sid || !event?.type) return;
		let e = ledgerEventCache.get(sid);
		if (!e) {
			e = { reasoning: 0, maxTurn: 0, title: "" };
			ledgerEventCache.set(sid, e);
			if (ledgerEventCache.size > LEDGER_CACHE_MAX) ledgerEventCache.delete(ledgerEventCache.keys().next().value);
		}
		const u = settlementUsage(event); // A4: message 直带 usage / attempt 取 stream 末帧
		if (u) {
			e.reasoning += u.reasoningTokens ?? 0;
			if (Number.isInteger(event.data.turn) && event.data.turn > e.maxTurn) e.maxTurn = event.data.turn;
		}
		if (event.type === "session/title" && typeof event.data?.title === "string") e.title = event.data.title;
	} catch { /* ignore */ }
}

/** 会话全部 usage 的推理 tokens 之和 (projcache totals 不含 reasoning, 需从事件补, 按输出价计费) */
function sumReasoningTokens(session) {
	return reasoningReading(session).value;
}

/**
 * reasoning 读数 + 来源标记 (projcache totals 不含 reasoning, 需从事件补, 按输出价计费)。
 * 0.1.2 起宿主 `session.events` 不再是事件视图 (Session.prototype 无 `events`) → 读数来自
 * 观察者侧缓存 `ledgerEventCache` (源="cache"); 旧宿主仍走事件视图 (源="events")。
 * ⚠️ 两个源的读数都**不是持久累计值**: 缓存会因容器重启 / 300 条 FIFO 淘汰重建 / 插件重载
 * 整体回退 → 必须经 carryReasoning 折算, 不能直接当累计值写账本。
 * @returns {{ value: number, source: "cache" | "events" }}
 */
function reasoningReading(session) {
	if (!Array.isArray(session?.events)) {
		return { value: ledgerEventCache.get(String(session?.id ?? ""))?.reasoning ?? 0, source: "cache" };
	}
	let sum = 0;
	for (const ev of session.events) {
		const u = settlementUsage(ev); // A4: 含 assistant/attempt (1.5)
		if (u) sum += u.reasoningTokens ?? 0;
	}
	return { value: sum, source: "events" };
}

/**
 * reasoning 增量 carry-forward 纯函数 (2026-09-12 修, 诊断见
 * docs/任务记录/2026-09-12-账本负差值诊断.md): 把"读数"当**增量源**而非累计值。
 *
 * 背景: `total = usage×价 + reasoning×价` 是**全量累计重算**, 而 reasoning 读数会因
 * 容器重启 / 观察者缓存 300 条 FIFO 淘汰重建 / 插件重载而整体回退 ⇒ 旧实现直接把读数写进
 * `reasoning` 会让 total 比上一条小 → 差值为负 + 合计被低估 (实测 session-3de24f50 t=8:
 * 日志全量 74519, 账本仅 1721 → −¥0.24)。
 *
 * 规则:
 *  - 基线 = 上一条 entry.rc (上一条记账时刻的同源读数);
 *  - 同源且读数未回退: 累计 = 上条 reasoning + (读数 − 基线) —— 只吃真实增量;
 *  - 同源但读数回退 (重置): 累计 = 上条 reasoning (不回退、不虚增), 基线重置为当前读数,
 *    其后按新基线继续吃增量;
 *  - 旧条目无 rc 或数据源切换 (cache ⇄ events): 累计 = max(上条 reasoning, 读数) —— 不回退、
 *    也不把已经算进去的历史重复加一遍。
 * @param prev - 上一条账本条目 (可含 reasoning / rc / rcs); 无 → 首条
 * @param rc - 当前 reasoning 读数
 * @param rcs - 当前读数来源 ("cache" | "events")
 * @returns {{ reasoning: number, rc: number, rcs: string, reset: boolean }}
 */
export function carryReasoning(prev, rc, rcs) {
	const now = Number.isFinite(rc) && rc > 0 ? rc : 0;
	const prevR = Number.isFinite(prev?.reasoning) && prev.reasoning > 0 ? prev.reasoning : 0;
	if (!prev) return { reasoning: now, rc: now, rcs, reset: false };
	if (typeof prev.rcs === "string" && prev.rcs === rcs && Number.isFinite(prev.rc)) {
		const reset = now < prev.rc;
		const base = reset ? now : prev.rc;
		return { reasoning: prevR + (now - base), rc: now, rcs, reset };
	}
	return { reasoning: Math.max(prevR, now), rc: now, rcs, reset: false };
}

/** 会话最新回合号 (assistant/message usage 事件的最大 turn), 无则 null */
function latestTurn(session) {
	if (!Array.isArray(session?.events)) return ledgerEventCache.get(String(session?.id ?? ""))?.maxTurn || null;
	let max = 0;
	for (const ev of session.events) {
		if (ev.type === "assistant/message" && Number.isInteger(ev.data?.turn)) {
			if (ev.data.turn > max) max = ev.data.turn;
		}
	}
	return max || null;
}

function sessionTitle(session) {
	const cached = ledgerEventCache.get(String(session?.id ?? ""))?.title;
	if (cached) return cached;
	const ev = session?.events?.findLast?.((e) => e.type === "session/title" && typeof e.data?.title === "string");
	return ev?.data?.title ?? "";
}

const fmtMoney = (n) => (Math.round(n * 100) / 100).toLocaleString("zh-CN");

// ---- dsh-cost-tree 动态加载 (复用策略 B: optionalDependency, 缺失/失败 → null 降级) ----
// ⚠️ 禁止顶层静态 import("@ericality/dsh-cost-tree") — 会重建"缺包崩溃"硬链 (设计 §0.2/§8.3)。
let costTreePromise = null;
export function loadCostTree() {
	costTreePromise ??= import("@ericality/dsh-cost-tree/lib/index.js")
		.catch((err) => {
			debug(`dsh-cost-tree 不可用, 退回单会话口径: ${String(err?.message ?? err)}`);
			return null;
		});
	return costTreePromise;
}

/**
 * 树合计纯函数 (设计 §3.3): Σ 各子会话 cost-ledger.json 子桶**最新一条 entry.total**。
 * ledger 已是账本口径 (含 reasoning/按记账时刻 tier 计价) → 不再乘价、不碰 projcache, 天然无双计。
 * child 无子桶/无 entries → 贡献 0; 返回 { count, total, settledIds }。
 * 纯函数, 供 checkAndAppend / RPC history / 单测共用。
 */
export function treeLedgerLatestTotal(ledger, childIds) {
	const childList = Array.isArray(childIds) ? childIds : [];
	const settledIds = [];
	let total = 0;
	for (const cid of childList) {
		const entries = ledger?.sessions?.[cid]?.entries;
		if (!Array.isArray(entries) || entries.length === 0) continue;
		const last = entries[entries.length - 1];
		if (typeof last?.total !== "number") continue;
		settledIds.push(cid);
		total += last.total;
	}
	return { count: settledIds.length, total, settledIds };
}

// ================= v0.3.4 团队口径小改（批三 2026-11-24；规格 d.2） =================
// ① 主数字标注「本会话口径」；② 团队附录＝成员数/团队累计/团队本回合增量（账本口径，参考既有子
//   agent 树合计做法，不做面板与成员明细）；③ 成员超阈值聚合提醒（按成员账本条目+节流，不依赖
//   guard 数据）。阈值仅数值对齐 guard 保守单回合默认 consTurnYuan=0.40。导出纯函数供离线判据/正控。
export const TEAM_ALERT_TURN_YUAN = 0.4;
export const TEAM_ALERT_THROTTLE_MS = 30 * 60 * 1000;
export const TEAM_ALERT_MAX_SHOW = 3;

/** 主数字 3 格（口径显式标注「本会话口径」；团队口径见附录行） */
export function ledgerMainStats(entry, prev, t) {
	const delta = entry.delta;
	const pct = delta !== null && prev && prev.total > 0 ? Math.round((delta / prev.total) * 100) : null;
	return [
		{ label: "合计预估（本会话）", value: `¥${fmtMoney(entry.total)}`, strong: true, note: "本会话口径" },
		{ label: "本回合（本会话）", value: delta !== null ? `+¥${fmtMoney(delta)}` : "—", note: delta !== null ? `本会话口径 · 较上次${pct !== null ? ` +${pct}%` : ""}` : "本会话口径 · 首次记账" },
		{ label: "计算次数", value: String(t), note: "每回合自动" }
	];
}

/** 团队附录行：团队成员 N 个 · 团队累计（自身+成员，账本口径）+ 团队本回合增量 */
export function teamAppendixStat(teamChildCount, teamCum, teamDelta) {
	const n = Number(teamChildCount) || 0;
	if (n <= 0) return null;
	const cum = Number.isFinite(teamCum) ? teamCum : 0;
	const deltaNote = Number.isFinite(teamDelta) ? `团队本回合 +¥${fmtMoney(teamDelta)}` : "团队本回合 —（首次统计）";
	return { label: "团队成员", value: `${n} 个 · 团队累计 +¥${fmtMoney(cum)}`, note: `${deltaNote} · 账本口径` };
}

/** 成员超阈值（按成员账本最新一条：优先回合增量 delta，首条无 delta 用累计 total 判定） */
export function overThresholdMembers(ledger, childIds, threshold = TEAM_ALERT_TURN_YUAN) {
	const out = [];
	for (const cid of Array.isArray(childIds) ? childIds : []) {
		const entries = ledger?.sessions?.[cid]?.entries;
		if (!Array.isArray(entries) || entries.length === 0) continue;
		const last = entries[entries.length - 1];
		const v = typeof last?.delta === "number" && Number.isFinite(last.delta) ? last.delta : (typeof last?.total === "number" ? last.total : null);
		if (v === null || !(v > threshold)) continue;
		out.push({ sid: cid, turn: Number.isInteger(last.t) ? last.t : null, yuan: Math.round(v * 100) / 100, basis: typeof last?.delta === "number" ? "delta" : "total" });
	}
	return out.sort((a, b) => b.yuan - a.yuan);
}

/** 聚合提醒签名＝成员 id 集合（金额变化不触发"新成员"，仅成员集合变化才提前提示） */
export function teamAlertSignature(alerts) {
	return (Array.isArray(alerts) ? alerts : []).map((a) => String(a.sid)).sort().join("|");
}

/** 节流判定：无历史/超窗口/窗口内出现新成员 ⇒ 发；否则抑制（默认 30min） */
export function shouldAnnounceTeamAlert(alerts, prevState, now = Date.now(), throttleMs = TEAM_ALERT_THROTTLE_MS) {
	if (!Array.isArray(alerts) || alerts.length === 0) return false;
	if (!prevState || !Number.isFinite(prevState.at)) return true;
	if (now - prevState.at >= throttleMs) return true;
	return teamAlertSignature(alerts) !== String(prevState.sig ?? "");
}

/** 聚合提醒行（最多列 3 名，其余折叠为"等 N 名"） */
export function teamAlertStat(alerts) {
	if (!Array.isArray(alerts) || alerts.length === 0) return null;
	const shown = alerts.slice(0, TEAM_ALERT_MAX_SHOW).map((a) => `${String(a.sid).slice(0, 12)}=¥${fmtMoney(a.yuan)}${a.turn !== null ? `@#${a.turn}` : ""}`);
	const more = alerts.length > TEAM_ALERT_MAX_SHOW ? ` 等 ${alerts.length} 名` : "";
	return { label: "团队成员提醒", value: `${alerts.length} 名超阈值（${shown.join(" · ")}${more}）`, note: `阈值 ¥${fmtMoney(TEAM_ALERT_TURN_YUAN)}/回合 · 账本口径` };
}

/** 渲染层组装（离线判据与在线发射共用）：主数字 + 团队附录/降级如实行 + 聚合提醒 */
export function buildLedgerStats({ entry, prev, t, teamChildCount = 0, teamCum = null, teamDelta = null, teamAlerts = null, teamDegraded = false }) {
	const stats = ledgerMainStats(entry, prev, t);
	if (teamDegraded) stats.push({ label: "团队口径", value: "不可用（cost-tree 缺失）", note: "降级：仅本会话口径，非静默" });
	else { const teamStat = teamAppendixStat(teamChildCount, teamCum, teamDelta); if (teamStat) stats.push(teamStat); }
	const alertStat = teamAlertStat(teamAlerts);
	if (alertStat) stats.push(alertStat);
	return stats;
}

/**
 * 后代行级明细 (期乙 §4.1, 2026-09-06): 供 client 委托树区渲染每行
 * { sid, parentSid, depth, label, total }。
 * - total = 该子桶**最新一条 entry.total** (账本口径, 未结算 0);
 * - label = 树库 childLabel (projcache subagent.identity.label → title → 短 sid);
 *   任一环节失败 → undefined (client 以短 sid 兜底), 整函数异常 → [] (RPC 忽略 rows)。
 * 只读 readTreeIndex (TTL 缓存) + readProjcacheSessions + readLedger 已有数据, 零写入。
 * @param {string[]} childIds 后代 id 列表 (不含自身, subtreeIds 先序)
 * @param {object} treeMod dsh-cost-tree 模块 (loadCostTree 返回值)
 * @param {object} ledger 账本对象 (readLedger 返回值)
 * @returns {Promise<Array<object>>}
 */
async function treeSubtreeRows(childIds, treeMod, ledger) {
	try {
		const index = await treeMod.readTreeIndex();
		const byId = index?.byId instanceof Map ? index.byId : new Map();
		let proj = null;
		try { proj = treeMod.readProjcacheSessions(); } catch { /* 无 projcache → label 兜底 */ }
		/** 委托深度: delegationDepth → 沿 parentSession 链回退计数 (防环) */
		const depthOf = (cid) => {
			const rec = byId.get(cid);
			if (rec && Number.isInteger(rec.delegationDepth) && rec.delegationDepth >= 0) return rec.delegationDepth;
			let depth = 0;
			const seen = new Set();
			let cur = rec;
			while (cur?.parentSession && !seen.has(cur.parentSession)) {
				seen.add(cur.parentSession);
				depth += 1;
				cur = byId.get(cur.parentSession);
			}
			return depth;
		};
		return childIds.map((cid) => {
			const edge = byId.get(cid);
			let label;
			const row = proj?.[cid];
			if (row) {
				try { label = treeMod.childLabel(row, cid); } catch { /* undefined 兜底 */ }
			}
			const entries = ledger?.sessions?.[cid]?.entries;
			const last = Array.isArray(entries) && entries.length ? entries[entries.length - 1] : null;
			return {
				sid: cid,
				parentSid: typeof edge?.parentSession === "string" && edge.parentSession ? edge.parentSession : undefined,
				depth: depthOf(cid),
				label: typeof label === "string" && label ? label : undefined,
				total: last && typeof last.total === "number" ? Math.round(last.total * 100) / 100 : 0
			};
		});
	} catch (err) {
		debug(`ledger subtree rows 计算失败, 忽略 rows: ${String(err?.message ?? err)}`);
		return [];
	}
}
const fmtTokens = (n) => `${(Math.round(n / 1000)).toLocaleString("zh-CN")}k`;

// ---- 账本读写 (v0.2.1 原子串行化): 读-改-写整段进写链, 防多回合并发基于旧
//      状态互相覆盖丢条目 (旧版只串行化 writeFile, 读在链外 → 竞态丢账);
//      临时文件+rename 原子落盘, 防写一半被杀留下损坏文件 (损坏会让 readLedger
//      回退空账本 → 对账把已记账回合误判缺失而重复补记) ----
let ledgerChain = Promise.resolve();

async function readLedger() {
	try {
		return JSON.parse(await readFile(LEDGER_FILE, "utf8"));
	} catch {
		return { version: 1, sessions: {} };
	}
}

function serializeLedger(fn) {
	const run = ledgerChain.then(async () => {
		const ledger = await readLedger();
		const result = await fn(ledger);
		try { mkdirSync(PLUGIN_DATA, { recursive: true }); } catch { /* ignore */ }
		const tmp = `${LEDGER_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
		await rename(tmp, LEDGER_FILE);
		return result;
	});
	ledgerChain = run.catch(() => {});
	return run;
}

export async function apply(ctx) {
	registerConfigApi(ctx);
	// ================= host-compat 适配闸门 (阶段 1; 契约 §2/§3/§4/§10) =================
	// 加载强制: 动态 import + try/catch (§2.3)。§10.1 禁静态 import host-compat/共享包 —
	// 缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环。§10.2 禁 legacy 直连兜底双路径 ⇒ 缺能力即停用 + 上报。
	const PLUGIN_ID = name;
	// 共享库降级的统一告警出口 (RD-37/43/26: §2.3 禁止静默)
	logWarn = (m) => { try { ctx.logger?.warn?.(m); } catch { /* noop */ } };
	const { version: PLUGIN_VERSION, blocked: pkgBlocked } = ownMeta();
	// 路径级阻断清单 (RD-20): 运行时取自自身 package.json 的 dshCompat.blocked; 读失败 ⇒ 内置回退 + 告警
	const BLOCKING = (Array.isArray(pkgBlocked) ? pkgBlocked : BLOCKED_FALLBACK).filter((k) => REQUIRES.includes(k));
	if (!Array.isArray(pkgBlocked)) ctx.logger?.warn?.(`${PLUGIN_ID}: dshCompat.blocked 读取失败 → 回退内置清单 [${BLOCKING.join(", ")}]`);
	let seams = null;
	let compat = null;
	try { seams = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { ctx.logger?.warn?.(`dsh-cost-ledger: host-compat/seams 不可用 → 横幅注入/RPC 通道停用 (${String(err?.message ?? err)})`); }
	try { compat = await import("@ericality/dsh-host-compat"); } catch { compat = null; }

	const seamFn = (key) => (typeof seams?.[SEAM_OF[key]] === "function" ? seams[SEAM_OF[key]] : null);
	/** ★ 批 4 件②（「丙」）：**就绪订阅接入状态**（如实降级用；`#A98` 补充约束②/③）。
	 *  `absent`／`subscribed`／`catch-up`／`unsupported`（旧版/桩 bus 无 `onReady` ⇒ 如实降级、不抛崩）／`failed`。
	 *  **必须在 `capNote`/`finalNote` 拼接之前声明**（该处会引用它）。 */
	let readySubState = "absent";
	let readySubReason = "";
	/** 惰性订阅 `compatBus.onReady`（**退避 0/200/500/1000/2000 ms**，照既有惯例）；`register` = 订阅方的幂等补注册函数。**永不 throw**。 */
	const subscribeCompatReady = (c, cb, register) => {
		const delays = [0, 200, 500, 1000, 2000];
		let i = 0;
		const tick = () => {
			let bus = null;
			try { bus = c?.get?.("compatBus") ?? null; } catch { bus = null; }
			if (bus && typeof bus.onReady === "function") {
				try {
					const r = bus.onReady((reason) => { let reg = { ok: false, reason: "no-register" }; try { reg = register() || reg; } catch (err) { reg = { ok: false, reason: `threw:${String(err?.message ?? err)}` }; } try { cb(reason, reg); } catch { /* 回调异常不影响他人 */ } });
					const st = r?.ready === true ? "catch-up" : (r?.ok === false ? "failed" : "subscribed");
					return { state: st, reason: r?.ok === false ? `订阅失败: ${String(r.reason ?? "unknown")}` : (st === "catch-up" ? "订阅时能力已就绪 ⇒ 已补注册" : "已订阅，等待能力就绪") };
				} catch (err) { return { state: "failed", reason: `订阅异常: ${String(err?.message ?? err)}` }; }
			}
			if (bus && typeof bus.registerEndpoint === "function") return { state: "unsupported", reason: "compatBus 无 onReady（旧版/桩 bus）⇒ 未接入就绪订阅（如实降级）" };
			if (i >= delays.length) return { state: "failed", reason: `compatBus 不可用（重试 ${i} 次耗尽）⇒ 未接入就绪订阅` };
			const d = delays[i++]; setTimeout(tick, d);
			return { state: "absent", reason: `compatBus 暂不可用，重试中（第 ${i} 次，退避 ${d}ms）` };
		};
		return tick();
	};
	// 能力探测: 优先 host-compat `probe()` (§4.9, 与 dshCompat.seams 同集); 未提供 ⇒ 本地按 §3 语义兜底。
	// obs#3 段P 小件（仲裁 #A109①/红线 6②）：`commands`/`tools` 是**宿主原生面**（无 §4 seam 函数），
	//   须按 `dsh-taskqueue` 既有口径探测（否则会恒判缺失 ⇒ 假 DEGRADED）——**只补声明，不改任何行为**。
	const localMissing = () => REQUIRES.filter((k) => {
		if (k === "projcache") return !projcacheReadable();
		if (k === "commands") return typeof ctx.commands?.register !== "function";
		if (k === "tools") return typeof ctx.tools?.register !== "function";
		return typeof seamFn(k) !== "function";
	});
	let capMissing = localMissing();
	let capBlockedProbe = null; // RD-20 ④: 三态判定权在 probe (单一权威)
	let capStateProbe = null;
	const prober = typeof compat?.probe === "function" ? compat : (typeof seams?.probe === "function" ? seams : null);
	if (prober) {
		try {
			const r = prober.probe(REQUIRES, PLUGIN_ID, PLUGIN_VERSION, ctx, BLOCKING); // RD-20: 第 5 参 = 路径级阻断清单
			if (Array.isArray(r?.blocked)) capBlockedProbe = r.blocked.filter((k) => REQUIRES.includes(k));
			if (typeof r?.state === "string") capStateProbe = r.state;
			if (Array.isArray(r?.missing)) capMissing = [...new Set([...r.missing.filter((k) => REQUIRES.includes(k)), ...localMissing()])]; // 只认本插件声明过的 key (RD-1)
		} catch (err) { ctx.logger?.warn?.(`dsh-cost-ledger: probe() 失败 → 退回本地探测 (${String(err?.message ?? err)})`); }
	}
	// RD-20 ④: probe 可用 ⇒ 逐字采信其 state/blocked; 不可用 ⇒ 本地按同一清单兜底 (口径一致)
	const capBlocked = capBlockedProbe ?? capMissing.filter((k) => BLOCKING.includes(k));
	const capState = capStateProbe ?? (capBlocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK"));
	const capNote = capState === "OK" ? "" : "缺 eventTypeRegistry ⇒ 横幅注入停用(写未注册类型会让会话无法加载) · 缺 projcache ⇒ 记账停摆(不写) · 缺 sessionAppend ⇒ 卡片不注入(账本照写) · 缺 rpcHandle ⇒ 卡片实时拉取回退卡内快照";
	const finalNote = (capBlocked.length ? `${capNote}${capNote ? " ｜ " : ""}路径级阻断(仅停该能力对应路径): ${capBlocked.join(", ")}` : capNote) + (readySubState !== "absent" ? `${capNote ? " ｜ " : ""}就绪订阅: ${readySubState}${readySubReason ? `(${readySubReason})` : ""}` : ""); // 阻断清单＋就绪订阅状态并入面板文案
	if (capState !== "OK") ctx.logger?.warn?.(`dsh-cost-ledger: 适配状态 ${capState} — 缺能力 [${capMissing.join(", ")}] 阻断 [${capBlocked.join(", ")}]; ${finalNote}`);
	const capEntry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state: capState, missing: capMissing, blocked: capBlocked, note: finalNote };
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	if (reporter) { try { reporter.report(capEntry); } catch { writeShard(ctx, capEntry); } } else writeShard(ctx, capEntry);

	/** RD-37/RD-43/RD-26 + **RD-47**(2026-09-13 协调人裁决): 共享库缺失 (晚于 probe 才发现) ⇒ 重报。
	 *  ⚠️ `missing[]`/`blocked[]`/`state` **只由 §3 能力探测结果决定**(面板 §7 按 §3 语义渲染) ⇒ 共享库名
	 *  **不得**塞进 `missing`;成因写 `note`(§5 允许的自由文本) + `ctx.logger.warn`。
	 *  **唯一例外(真实能力缺失, 契约正确)**: 缺 `cost-pricing` 会让本插件**读取 projcache 也停用**
	 *  (RD-43 降级垫片不含第二套 fs 实现) ⇒ 此时把 §3 key **`projcache`** 计入 `missing`。
	 *  §4.10/§5 单写者: 只写自己的分片; 形状仍是 §5 的扁平 8 键。 */
	const DEGRADE_NOTES = {
		"reconcile": "reconcile 缺失 → 对账路径停用",
		"cost-pricing": "取价库缺失 → 用内置常量（projcache 读取随之停用）",
		"banner-kit": "banner-kit 缺失 → 横幅注入停用"
	};
	function reportDegradedLib(key, note) {
		try {
			const text = note ?? DEGRADE_NOTES[key] ?? key;
			if (key === "cost-pricing" && !capMissing.includes("projcache")) capMissing.push("projcache"); // RD-47: §3 key 计入
			capEntry.state = capEntry.blocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK");
			capEntry.note = `${capEntry.note}${capEntry.note ? " ｜ " : ""}${text}`;
			if (reporter) { try { reporter.report(capEntry); } catch { writeShard(ctx, capEntry); } } else writeShard(ctx, capEntry);
			debug(`适配状态重报: [${key}] ${text}`);
		} catch (err) { debug(`适配状态重报失败: ${String(err?.message ?? err)}`); }
	}
	reportDegraded = reportDegradedLib;   // 供模块级 loadPricing/loadBannerKit/loadReconcile 回调
	// RD-43: 启动期探测共享取价库 —— 缺库立即 warn + report (不等首次记账才暴露; §2.3 禁止静默)
	await pricingLib();

	const capOk = (key) => !capMissing.includes(key) && !capBlocked.includes(key); // 阻断 key 同样按"该路径停用"处理 (RD-20)
	const seamWarned = new Set();
	/** 能力缺失/调用失败的统一告警 (每组合只报一次; §2.3 禁止静默) */
	function seamFail(what, reason) {
		const k = `${what}|${reason}`;
		if (seamWarned.has(k)) return;
		seamWarned.add(k);
		ctx.logger?.warn?.(`dsh-cost-ledger: ${what} 已停用 — ${reason} (契约 §10.2: 不降级为直连宿主)`);
	}
	/** §4.6 rpcHandle: 注册已认证 RPC 通道 (缺能力 ⇒ 通道不可用, 客户端回退卡内静态快照) */
	const rpcRegistered = new Set(); // ★ 批 4 件②：**幂等打标**（成功过即跳过，防宿主 `duplicate` 抛错）
	function registerRpc(channel, handler, options) {
		if (rpcRegistered.has(channel)) return { ok: true, already: true };
		// ★`#A59`：0.2.2 先走官方 Fetch 面（`/api/cost-ledger/<ep>`）
		try {
			if (typeof seams?.channelFace === "function") {
				const face = seams.channelFace(ctx, channel, ["history"], handler);
				if (face?.ok) { rpcRegistered.add(channel); return { ok: true, via: "fetch", routes: face.routes }; }
			}
		} catch (err) { seamFail(`RPC ${channel}`, `channelFace 异常: ${String(err?.message ?? err)}`); }
		if (!capOk("rpcHandle")) { seamFail(`RPC ${channel}`, "缺能力 rpcHandle"); return { ok: false, reason: "rpcHandle" }; }
		try {
			const r = seamFn("rpcHandle")(ctx, channel, handler, options);
			if (!r?.ok) { seamFail(`RPC ${channel}`, `rpcHandle 失败: ${r?.reason ?? "unknown"}`); return r ?? { ok: false, reason: "rpcHandle" }; }
			rpcRegistered.add(channel);
			return r;
		} catch (err) {
			seamFail(`RPC ${channel}`, `rpcHandle 异常: ${String(err?.message ?? err)}`);
			return { ok: false, reason: "rpcHandle" };
		}
	}

	// 自定义会话事件类型注册 (幂等; 非 surface 事件不进模型历史)。
	// ledger 无 replace 语义 (每回合一张新卡), 只需 notice/banner。
	// RD-26/RD-28: **唯一注册路径 = banner-kit `ensureRegistered()`** (它经 §4.5 ensureEventTypes
	// + 模块级幂等缓存); 本插件**不再**直接调 seam ensureEventTypes (同一进程只保留一条注册路径)。
	// 注册失败/能力缺失/库缺失 ⇒ **禁止注入** (未注册类型会让会话日志无法加载)。
	let bannerKit = null;
	let bannerKitOk = false;
	if (!capOk("eventTypeRegistry")) { seamFail("事件类型注册(notice/banner)", "缺能力 eventTypeRegistry(路径级阻断)"); }
	else {
		bannerKit = await loadBannerKit();
		if (!bannerKit) seamFail("事件类型注册(notice/banner)", "banner-kit 不可用");
		else {
			const reg = await bannerKit.ensureRegistered();
			bannerKitOk = reg?.ok === true;
			if (!bannerKitOk) seamFail("事件类型注册(notice/banner)", `ensureRegistered 失败: ${reg?.reason ?? "unknown"}`);
		}
	}
	/** RD-26/RD-28: 注入一张 ledger 提醒卡 —— 经 banner-kit `emit(session, payload)`
	 *  (**不传 opts** ⇒ 恒 `mode:"start"` / `rev = payload.rev ?? 0`, 与改前 §4.4 直调逐字等价) */
	async function injectNotice(session, payload) {
		if (!bannerKitOk || !bannerKit) { seamFail("横幅注入", "notice/banner 类型未注册"); return { ok: false, reason: "eventTypeRegistry" }; }
		// P1-2: 去 session（`sessionId` 随 payload 走；双轨期旧日志由中间件按 sessionId 反查补写）
		const r = await bannerKit.emit({ ...payload, sessionId: String(session?.id ?? ""), anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bannerKit.ANCHOR_LEVEL.ROW : bannerKit.ANCHOR_LEVEL.SESSION, form: bannerKit.CARD_FORM.CARD }, { source: "dsh-cost-ledger" });
		if (!r?.ok) seamFail("横幅注入", `banner-kit emit 失败: ${r?.reason ?? "unknown"}`);
		return r ?? { ok: false, reason: "banner-kit" };
	}

	/** 回合结束自动记账: usage → 定价 → 追加本会话历史 → 注入一张新卡
	 *  opts.turn: 指定记账回合号 (对账补记用; 实时路径省略则取日志最新回合) */
	async function checkAndAppend(session, opts = {}) {
		const sid = String(session?.id ?? "");
		if (!sid) return;
		// §9.3 Q3 (2026-09-06): 子会话 (origin=subagent) 只跳过卡片/横幅 UI 注入,
		// 记账照常 (serializeLedger/对账/t 去重 一律不动) — "滤注入 ≠ 抑制写入"。
		const isSubagent = session?.header?.origin === "subagent";
		const settings = await readSettings();
		const usage = await readSessionUsage(sid);
		if (!usage) {
			debug(`ledger ${sid.slice(0, 12)}: projcache 无数据, 跳过`);
			return;
		}
		const { prices, source } = await resolvePrices();
		const tier = tierOf(Date.now()); // 共享库 tierOf (缺库 ⇒ 降级垫片同规则)
		const p = prices[tier];
		// reasoning 读数 (数据源可能整体回退) → 在写锁内经 carryReasoning 折算成累计值 + 记基线 rc
		const reading = reasoningReading(session);

		const t = opts.turn ?? latestTurn(session);
		if (!Number.isInteger(t)) return { skipped: true };

		// §d.2 团队口径：成员子树 id 预计算（只对将要出卡的会话；subagent 记账仍走原路径）。
		//   cost-tree 缺失/异常 ⇒ treeDegraded=true，卡片如实标「团队口径不可用」（不静默降级）。
		let teamChildIds = [];
		let teamTreeDegraded = false;
		if (!isSubagent) {
			const treeMod = await loadCostTree();
			if (!treeMod) teamTreeDegraded = true;
			else {
				try { teamChildIds = (await treeMod.subtreeIds(sid)).filter((id) => id !== sid); }
				catch (err) { teamTreeDegraded = true; debug(`ledger ${sid.slice(0, 12)}: 团队子树计算失败, 团队口径如实降级: ${String(err?.message ?? err)}`); }
			}
		}

		// 读-改-写原子串行: 防并发覆盖; t 去重幂等 (实时/对账重复调用同一回合只记一次);
		// 按回合号排序 (补记的旧回合插到前面, 历史列表/游标才正确)
		let out;
		try {
			out = await serializeLedger(async (ledger) => {
				const rec = (ledger.sessions[sid] ??= { entries: [] });
				const entries = rec.entries;
				if (entries.some((e) => e.t === t)) return { skipped: true };
				const prev = entries.length ? entries[entries.length - 1] : null;
				// reasoning 累计 = 上条基线 + 真实增量 (2026-09-12: 数据源回退不再击穿 total)
				const cr = carryReasoning(prev, reading.value, reading.source);
				const reasoning = cr.reasoning;
				// 累计费用补上推理 tokens (RD-30: 按输出价计费, 与 cost-guard 同口径)
				const total = costOf(usage, p, { reasoning });
				const delta = prev ? total - prev.total : null;
				if (cr.reset) {
					debug(`ledger ${sid.slice(0, 12)}: reasoning 数据源回退 (rc ${prev?.rc} → ${cr.rc}, 源=${reading.source}), 基线重置, 累计保持 ¥${cr.reasoning}`);
				}
				const entry = {
					t,
					at: new Date().toISOString(),
					total,
					delta,
					tier,
					u: usage.uncachedInputTokens ?? 0,
					r: usage.cacheReadTokens ?? 0,
					w: usage.cacheWriteTokens ?? 0,
					o: usage.outputTokens ?? 0,
					reasoning,
					rc: cr.rc,
					rcs: cr.rcs,
					priceSource: source
				};
				// §d.2 团队口径采样（账本口径＝自身已结算 + 各成员最新已结算；不依赖 cost-guard 数据）
				let team = { childCount: 0, cum: total, delta: null, alerts: [] };
				if (!isSubagent) {
					const childInfo = treeLedgerLatestTotal(ledger, teamChildIds);
					const cum = total + childInfo.total;
					const teamDelta = prev && Number.isFinite(prev.teamCum) ? cum - prev.teamCum : null;
					const alerts = overThresholdMembers(ledger, teamChildIds); // 按成员账本条目判定
					const announce = shouldAnnounceTeamAlert(alerts, rec.teamAlertState ?? null); // 节流
					if (announce) rec.teamAlertState = { at: Date.now(), sig: teamAlertSignature(alerts), count: alerts.length };
					entry.teamChildCount = childInfo.count;
					entry.teamCum = Math.round(cum * 100) / 100;
					entry.teamDelta = teamDelta === null ? null : Math.round(teamDelta * 100) / 100;
					team = { childCount: childInfo.count, cum: entry.teamCum, delta: entry.teamDelta, alerts: announce ? alerts : [] };
				}
				entries.push(entry);
				entries.sort((a, b) => a.t - b.t);
				if (entries.length > settings.maxEntriesPerSession) entries.splice(0, entries.length - settings.maxEntriesPerSession);
				return { entry, prev, entries, team, treeDegraded: teamTreeDegraded };
			});
		} catch (err) {
			ctx.logger.warn(`dsh-cost-ledger: 账本写入失败: ${String(err?.message ?? err)}`);
			return { skipped: true };
		}
		if (out?.skipped) return out;

		// §9.3 Q3 (2026-09-06): 子会话只跳过 UI 注入 → 卡片/横幅不发, 记账已照常
		// (out 来自 serializeLedger, 账本写入已完成; 注入抑制 ≠ 写入抑制)。
		if (isSubagent) {
			debug(`ledger ${sid.slice(0, 12)}: 子会话 (origin=subagent), 跳过卡片注入, 记账已照常`);
			return { entry: out.entry };
		}
		if (!settings.injectTurnCard) {
			debug(`ledger ${sid.slice(0, 12)}: 配置 injectTurnCard=false, 跳过卡片注入, 记账已照常`);
			return { entry: out.entry };
		}

		// ---- 注入一张 ledger 新卡 (独立 context, 每回合追加) ----
		const { entry, prev } = out;
		const entries = out.entries;
		const delta = entry.delta;
		const tierName = tier === "peak" ? "高峰" : "低谷";
		const u = entry.u, r = entry.r, w = entry.w, o = entry.o;
		const hit = (() => {
			const billed = u + r + w;
			return billed > 0 ? Math.round((r / billed) * 100) : null;
		})();
		let deltaKv;
		if (prev) {
			const du = Math.max(0, u - prev.u);
			const dr = Math.max(0, r - prev.r);
			const dout = Math.max(0, (o + entry.reasoning) - (prev.o + prev.reasoning));
			deltaKv = `输入 +${fmtTokens(du)} · 缓存 +${fmtTokens(dr)} · 输出+推理 +${fmtTokens(dout)} → +¥${fmtMoney(delta)}`;
		} else {
			deltaKv = "首次记账（下回合起显示增量）";
		}
		// v0.3.4 §d.2：主数字标注「本会话口径」＋团队附录（成员数/团队累计/团队本回合增量，账本口径）
		// ＋成员超阈值聚合提醒（节流）。组装逻辑在模块级 buildLedgerStats（离线判据同源、可正控）。
		const stats = buildLedgerStats({
			entry, prev, t,
			teamChildCount: out.team.childCount, teamCum: out.team.cum, teamDelta: out.team.delta,
			teamAlerts: out.team.alerts, teamDegraded: out.treeDegraded
		});
		const kv = [
			{ k: "计算细则", v: `输入 ${fmtTokens(u + w)}×¥${p.inputMiss} + 缓存 ${fmtTokens(r)}×¥${p.inputHit} + 输出+推理 ${fmtTokens(o + entry.reasoning)}×¥${p.output} = ¥${fmtMoney(entry.total)}` },
			{ k: "本回合增量", v: deltaKv },
			{ k: "定价", v: `${tierName}价 ¥${p.inputMiss} / ${p.inputHit} / ${p.output}（每百万）· 来源: ${source}` }
		];
		// 历史快照 (最新在前): 客户端展开时优先实时 RPC, RPC 失败回退此快照
		const history = entries.slice().reverse().map((e) => ({
			t: e.t,
			clock: beijingMd(e.at),
			total: `¥${fmtMoney(e.total)}`,
			delta: e.delta !== null ? `+${fmtMoney(e.delta)}` : null
		}));
		// ★批7 `T15`：**稳定身份**（同会话同回合恒定 ⇒ store 走 `cardId` 幂等分支、原地更新不新增卡）
		const _ledgerCtxKey = "ledger-" + (Number.isInteger(t) ? t : (Number.isInteger(opts?.event?.seq) ? opts.event.seq : Date.now()));
		const _ledgerCardId = _cardId("dsh-cost-ledger|ledger", sid, _ledgerCtxKey);
		const payload = {
			// A 阶段（obs#3）：ledger 卡补 turn + anchorSeq + ctxKey（旧 id 形态 `ledger-<seq>`）
			turn: Number.isInteger(t) ? t : null,
			anchorSeq: Number.isInteger(opts?.event?.seq) ? opts.event.seq : null,
			// obs#3 段M（#A83 五）：**发射侧给身份键** —— store 覆盖键 = (kind, rev, mode) 三者全等；
			//   不传 `replace` 时 `rev` 恒 0 ⇒ 每回合的账本卡会**互相覆盖**（实测分片 `ledger` 仅剩 1 条）。
			//   ⇒ `ctxKey` 用**回合身份**、`rev` 用**回合号**（每回合恰 1 条；无回合号时退化为时间戳保证唯一）。
			ctxKey: _ledgerCtxKey,
			cardId: _ledgerCardId,
			kind: "ledger",
			priority: 3, foldable: settings.defaultCollapsed === true, family: "ledger",
			rev: Number.isInteger(t) ? t : Date.now(),
			title: `回合 #${t} · 会话费用`,
			subtitle: `会话 ${sid.slice(8, 16)} · ${tierName}价${hit !== null ? ` · 命中 ${hit}%` : ""}`,
			stats,
			kv,
			history,
			sessionId: sid,
			metaText: `回合 #${t} 结束 · 每回合自动记账 · 本地估算，实际扣费以官方账单为准`,
			advice: "",
			at: Date.now()
		};
		// v1 (§4.4): 经 seam 注入; 能力缺失 ⇒ 停用注入但**记账已落盘/照常返回**(不静默, seamFail 已告警)
		const injected = await injectNotice(session, payload);
		if (injected.ok) debug(`ledger ${sid.slice(0, 12)}: 回合 #${t} 注入成功 合计 ¥${fmtMoney(entry.total)}${delta !== null ? ` (+¥${fmtMoney(delta)})` : ""} 历史 ${entries.length} 条`);
		else debug(`ledger ${sid.slice(0, 12)}: 回合 #${t} 卡片未注入 (${injected.reason}) — 账本已写入, 客户端仍可经 RPC 拉取`);
		return { entry };
	}

	// ---- turn/end 钩子: 延迟 1s 等 projcache 落盘, 读不到则跳过 (下回合自然再记)。
	// 显式传 turn/end 事件自己的回合号 (不用 latestTurn: 并发/多回合时 latestTurn
	// 取全日志最大回合号会记错回合; 事件回合号是权威) ----
	ctx.on("session/event", (session, event) => {
		cacheLedgerEvent(session, event); // 2026-09-10: 0.1.2 无 session.events → 观察者侧缓存
		if (event?.type !== "turn/end" || !session?.id) return;
		setTimeout(() => { void checkAndAppend(session, { turn: event.data?.turn }); }, 1000);
	});

	// ---- 幂等对账 (v0.2.2): 容器重启掐断的回合, 其 turn/end 由会话重载修复
	// 机制合成 (reason=interrupted) 并持久化, 但种子事件不派发观察者 → 这里在
	// 会话恢复 (session/created) 时**只补"被中断的尾回合"** (一次最多补 1 张)。
	// ⚠️ v0.2.1 教训: "缺失回合集合"对账会把历史上从未记过账的会话全部补记
	// (启动扫描 ctx.sessions.list() 覆盖所有会话 → 31 会话全量刷屏, total 全相同)。
	// 账本有时效性: 历史缺失一律不补, 只补被重启掐断、且账本未记录的回合。
	// RD-37: reconcile 改**动态加载** (契约 §10.1 禁静态 import 共享包); 取不到 ⇒
	// **对账路径整体停用** + report() 上报 (reason:"reconcile"), **禁止**静态兜底双路径 (§10.2/D12)。
	const rc = await loadReconcile();
	if (rc && typeof rc.attachReconcile === "function" && typeof rc.lastTurnEnd === "function") {
		rc.attachReconcile(ctx, {
			name: "cost-ledger",
			shouldReconcile: async (session) => {
				const end = rc.lastTurnEnd(session);
				// 只认"最后一个 turn/end 是被中断的"——修复机制只在日志尾部合成一个
				// interrupted turn/end (重启场景的唯一真实缺失); completed 尾回合
				// 说明没有未处理的中断, 历史缺账不补
				if (!end || end.reason !== "interrupted" || !Number.isInteger(end.turn)) return false;
				const ledger = await readLedger();
				const recorded = new Set((ledger.sessions?.[session.id]?.entries ?? []).map((e) => e.t));
				return !recorded.has(end.turn); // 该中断回合尚未记账才补 (已补过不再补)
			},
			reconcile: async (session) => {
				const end = rc.lastTurnEnd(session);
				if (!end) return;
				await checkAndAppend(session, { turn: end.turn });
			}
		});
	} else {
		ctx.logger?.warn?.(`${PLUGIN_ID}: 对账路径停用 — reconcile 不可用 (契约 §10.2: 不降级为静态兜底)`);
	}

	// ---- /cost-ledger RPC 通道 (v0.1.0) ----
	// 浏览器端 client (dsh-notice-banner 账本历史区) 经框架通用 RPC
	// (ctx.connection.rpc.call("/cost-ledger", "<endpoint>", payload)) 实时拉取本会话账本,
	// 不走模型回合、零 token —— 任何一张旧卡片点开都与最新卡片一致。
	// 信任策略与 /api 一致 (options 省略 → trustedHosts, 隧道/局域网域名可访问)。
	// 端点:
	//   history { sessionId, includeDescendants? } → { count, entries: [{ t, at, total, delta }] (最新在前),
	//     subtree?: { count, ids, total, at, rows: [{ sid, parentSid, depth, label, total }] } }
	//     — includeDescendants=true 时**恒附 subtree** (账本口径: Σ 各后代子桶最新 entry.total, 不再乘价;
	//       缺省 = 现状单桶, 向后兼容, §3.3); 库缺失/子树计算异常 → { count:0, ids:[], total:0, at, rows:[] }
	//       (接口形状不变, 客户端判 rows 空/缺 → 不渲染委托树行)。
	//     rows (期乙 §4.1, 2026-09-06 追加, v0.3.1): 每个后代一行供 client 委托树区渲染 —
	//       sid=后代全 id / parentSid=树索引直系父 (加: 供 client 推导树形线/分支合计/孙行 dim;
	//       undefined=父不在索引) / depth=delegationDepth (孙行>1; 索引无则沿 parentSession 链回退计数) /
	//       label=projcache subagent.identity.label → title (childLabel 回退; 无 projcache 行 → undefined,
	//       client 以短 sid 兜底) / total=该子桶最新 entry.total (未结算 0, 账本口径, 不再乘价);
	//       rows 顺序 = subtreeIds DFS 先序; 服务端只算行值, 「占子树 %」由 client 按 rows 合计算。
	const ledgerRpcHandler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "history": {
				const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
				if (!sid) return { ok: false, error: { code: "bad-request", message: "需要 sessionId" } };
				const ledger = await readLedger();
				const entries = ledger.sessions?.[sid]?.entries ?? [];
				const value = {
					count: entries.length,
					entries: entries.slice().reverse().map((e) => ({
						t: e.t,
						clock: beijingMd(e.at),
						total: `¥${fmtMoney(e.total)}`,
						delta: e.delta !== null ? `+${fmtMoney(e.delta)}` : null
					}))
				};
				// §3.3/§4.1 (2026-09-06 期甲+期乙定稿): 可选 includeDescendants=true → **恒附 subtree**:
				//   { count, ids, total, at, rows } — rows 行级明细 (委托树区渲染, treeSubtreeRows);
				//   **降级: dsh-cost-tree 缺失 / 子树计算异常 → subtree { count:0, ids:[], total:0, rows:[] }**
				//   (接口形状不变, 客户端判 rows 空/缺 → 不渲染委托树行); 缺省/非 true → 现状单桶 (向后兼容)
				if (payload?.includeDescendants === true) {
					const at = new Date().toISOString();
					const treeMod = await loadCostTree();
					if (treeMod) {
						try {
							const ids = await treeMod.subtreeIds(sid, { force: true });
							const childIds = ids.filter((id) => id !== sid);
							const { count, total } = treeLedgerLatestTotal(ledger, childIds);
							const rows = await treeSubtreeRows(childIds, treeMod, ledger);
							value.subtree = { count, ids: childIds, total: Math.round(total * 100) / 100, at, rows };
						} catch (err) {
							debug(`rpc history includeDescendants 失败, 附空 subtree: ${String(err?.message ?? err)}`);
							value.subtree = { count: 0, ids: [], total: 0, at, rows: [] };
						}
					} else {
						value.subtree = { count: 0, ids: [], total: 0, at, rows: [] };
					}
				}
				return { ok: true, value };
			}
			default:
				return { ok: false, error: { code: "not-found", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	registerRpc("/cost-ledger", ledgerRpcHandler, {}); // options 不能省略: register 直接读 options.authority (与 dsh-taskqueue 同)

	/** ★ 批 4 件②（「丙」）：**仅"能力未就绪"才订阅** ⇒ 就绪后补注册（`registerRpc` 内部幂等打标 ⇒ 防 `duplicate`）。 */
	try {
		if (!capOk("rpcHandle")) {
			const sub = subscribeCompatReady(ctx, (reason, r) => {
				readySubState = r.ok ? "registered" : "failed";
				readySubReason = r.ok ? `就绪订阅触发(${reason}) ⇒ RPC 已补注册` : `就绪订阅触发(${reason}) ⇒ 补注册失败: ${r.reason}`;
				ctx.logger?.info?.(`dsh-cost-ledger: ${readySubReason}`);
			}, () => registerRpc("/cost-ledger", ledgerRpcHandler, {}));
			readySubState = sub.state;
			readySubReason = sub.reason;
		}
	} catch (err) { readySubState = "failed"; readySubReason = `订阅接线异常: ${String(err?.message ?? err)}`; }

	// ============ v0.3.3 (2026-09-14): 模型工具 session_cost + 斜杠命令 /cost-now ============
	// 为什么加: 账本 entries 回合结束才落账, 回合进行中读它是"上一回合的累计"(实测差近 4×);
	//   而 agent 此前**没有**实时费用入口 ⇒ 只能手拼 shell 读 projcache, 口径易错。
	// 出参: 默认 4 行文本(实时 / 账本已结算 / 差额 / 口径), detail|turns 才展开 —— 不吐 JSON。
	async function runSessionCost(args = {}, exec = null) {
		const execSid = exec?.agent?.session?.id ?? null;
		const requested = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : null;
		const sid = requested ?? execSid;
		if (!sid) throw new Error("无法确定会话: 未传 sessionId 且当前回合无绑定会话");
		// 只允许在"本会话"或"本会话的委托子树"上查 (避免 agent 顺手侦察其它会话);
		// 目标会话在 projcache 里完全没有行 ⇒ 不是"该不该查"的问题, 直接回"无数据"(避免误导性拒绝)
		let scope = "current";
		if (requested && execSid && requested !== execSid) {
			const hasRows = (await readSessionUsage(requested)) !== null;
			let inSubtree = false;
			try {
				const treeMod = await loadCostTree();
				if (treeMod) inSubtree = (await treeMod.subtreeIds(execSid)).includes(requested);
			} catch { inSubtree = false; }
			if (!inSubtree && hasRows) {
				return { text: `拒绝: 会话 ${requested.slice(0, 12)} 不是本会话的委托子会话(只允许查本会话及其子 agent)` };
			}
			scope = inSubtree ? "subtree-of-current" : "unknown-session";
		}
		const sn = await sessionCostSnapshot(sid, exec?.agent?.session ?? null, { includeChildren: args.includeChildren === true });
		const text = formatSessionCost(sn, { detail: args.detail === true, turns: Number.isInteger(args.turns) ? Math.max(0, Math.min(10, args.turns)) : 0 });
		return { text, scope };
	}

	ctx.tools.register(defineTool({
		name: "session_cost",
		description: "查询会话实时费用(元): 实时口径取 projcache(每次请求增量写, 含进行中回合), 账本口径为回合结算快照 —— 报告成本/判断是否接近预算时用本工具, 不要只看历史账本汇总。缺省查本会话 (参数全可选); 查子 agent 会话需 includeChildren 语义外的显式 sessionId(仅限本会话的委托子树)",
		parameters: {
			sessionId: { type: "string", description: "可选: 目标会话 id (缺省=本会话; 非本会话时仅允许本会话的委托子会话)" },
			detail: { type: "boolean", description: "可选: 展开 token 分项与单价 (缺省 false, 只给 4 行摘要)" },
			turns: { type: "integer", description: "可选: 附最近 N 回合账本明细 (0–10, 缺省 0 = 不附)" },
			includeChildren: { type: "boolean", description: "可选: 附委托子树合计 (账本口径, 缺省 false)" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const r = await runSessionCost(args, exec);
			return { text: r.text };
		},
		presentCall: () => ({ card: "generic", title: "查询会话实时费用", kind: "other" })
	}));

	ctx.commands.register({
		name: "cost-now",
		description: "实时会话费用 (projcache 口径, 含进行中回合) + 账本已结算 + 差额; 可带会话 id 或 --detail",
		input: { hint: "[会话id] [--detail]" },
		handler: async (invocation) => {
			const raw = String(invocation?.rawInput ?? "").trim();
			const detail = /--detail\b/.test(raw);
			const sidArg = raw.replace(/--detail\b/g, "").trim() || null;
			try {
				const r = await runSessionCost({ sessionId: sidArg ?? undefined, detail }, { agent: invocation?.agent });
				return { kind: "success", text: r.text };
			} catch (err) {
				return { kind: "error", text: `实时费用查询失败: ${String(err?.message ?? err)}` };
			}
		}
	});
}
