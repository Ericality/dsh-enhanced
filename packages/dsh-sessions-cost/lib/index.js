import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；会话日志与投影缓存都从它派生。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
/** 本插件自有数据：<root>/plugin-data/sessions-cost/（配置 settings.json 落这里）。 */
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "sessions-cost");

// ---------- 插件配置（/api/sessions-cost/config，落 plugin-data/sessions-cost/settings.json，schemaVersion 1） ----------
const SETTINGS_FILE = process.env.DSH_SESSIONS_COST_SETTINGS_FILE || joinPath(PLUGIN_DATA, "settings.json");
const SETTINGS_SCHEMA = 1;
// 默认值 = 改造前常量（默认窗口 24 小时；横幅默认折叠、明细全显示）
const SETTINGS_DEFAULTS = Object.freeze({ defaultHours: 24, defaultCollapsed: true, showBreakdown: true });
const SETTINGS_NUMBERS = Object.freeze({ defaultHours: [1, 720] });
const SETTINGS_BOOLS = Object.freeze(["defaultCollapsed", "showBreakdown"]);
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

/** 注册 /api/sessions-cost/config 的 get / set / reset（经 host-compat 通道面；失败如实 warn）。 */
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
			ctx.logger?.warn?.(`dsh-sessions-cost: /api/sessions-cost/config ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") { ctx.logger?.warn?.("dsh-sessions-cost: host-compat 未提供 channelFace，/api/sessions-cost/config 不可用"); return; }
		const face = seams.channelFace(ctx, "/sessions-cost/config", ["get", "set", "reset"], handler);
		if (!face?.ok) ctx.logger?.warn?.(`dsh-sessions-cost: /api/sessions-cost/config 注册失败 ${JSON.stringify(face?.results ?? [])}`);
	}).catch((err) => { ctx.logger?.warn?.(`dsh-sessions-cost: host-compat 加载失败 ${String(err?.message ?? err)}`); });
}
import { createHash } from "node:crypto";
/** ★批7 `T15`（`#A342`）：`costs` 卡语义 = **每次命令一张新卡**（`:546-548` 注释：两次 `/cost` 曾互相覆盖）
 *  ⇒ `key` 缺省（逐次唯一）时 `cardId` **必须逐次不同**（否则被 store 判同卡 ⇒ 幂等覆盖、卡不再新增）。
 *  ★段2 `B2`/`B4`（2026-09-29）：
 *    · **命名空间按 `kind` 分、且 `error` 三类型各自一段** ⇒ 不同 kind/类型**永不共用同一个 `cardId` 空间**；
 *    · **身份键 `key` 承载合并语义** —— 同 `(ns, sid, key)` ⇒ 同卡（原地更新、恒 1 张）／异 `key` ⇒ 各 1 张；
 *    · `key` **显式 `null`/空** ⇒ **不伪造身份** ⇒ 返 `null`（调用方**回落旧路径 ＋ 落码点名**，不静默）。 */
const _cardIdOf = (ns, sid, key) => (key === null || key === undefined || key === "")
	? null
	: createHash("sha256").update(["dsh-sessions-cost|" + String(ns), sid, String(key)].join("|")).digest("hex").slice(0, 32);
import { zstdDecompressSync } from "node:zlib";

/**
 * @deepseek-ai/dsh-sessions-cost (本地辅助插件, 非官方包)
 *
 * 斜杠命令:
 *   /sessions-cost [小时数]  — 本地计算时间窗口内各会话的费用 (默认 24 小时)
 *
 * 用法/口径:
 *   - 小时数为以当前时间倒退的窗口长度 (如 /sessions-cost 48 = 近 48 小时),
 *     支持小数 (0.5 = 半小时), 上限 8760 (一年), 非法输入报错并提示默认值。
 *   - "匹配会话" = 窗口内存在 token 消耗 (assistant/message usage) 的会话;
 *     预筛选用 projcache 的 lastPromptAt/createdAt (含 2h 裕量防跨窗长回合漏算)。
 *   - 窗口内用量: 解码会话日志 (多 zstd 帧逐帧解压), 按行字符串过滤
 *     "assistant/message" 快速解析 (跳过 99% 的 chunk 行, 不必 JSON.parse 全部),
 *     取事件 time ∈ [now-H, now] 的 usage 求和:
 *       inputTokens=未命中 / cacheReadTokens=命中 / outputTokens=输出 /
 *       reasoningTokens=推理 (projcache totals 不含推理, 按输出价计费, 与
 *       cost-guard/cost-ledger 同口径)。
 *   - 计价: 逐事件按北京时段分高峰/低谷 (周末全天低谷, 9-12/14-18 高峰),
 *     每会话展示计算过程 (token × 单价); 定价链 = 共享库 `@ericality/dsh-cost-pricing`
 *     (动态 import; 缺库 ⇒ 内置纯数据常量 + 一行 warn) = 价格缓存(30min) → 官方页解析 →
 *     上次缓存 → 内置常量; **价格缓存归共享库** (`cost-pricing-cache.json`),
 *     本插件 state 不再写 prices/pricesFetchedAt (RD-42)。
 *     HTTP 抓页在库内, 不调计费 API → 不消耗 token。
 *   - 结果: notice/banner 横幅 (kind=costs 天蓝"多会话费用"家族, v0.8.0 起玫红→天蓝, 由
 *     dsh-notice-banner client 渲染), **默认折叠** (一行 = 窗口合计), 点标题
 *     展开看每会话明细 (kv 键值行); 非 surface 事件 → 不进模型历史 → 零 token。
 *   - 树分组 (v0.2.0 期乙, 设计 §3.4/§4.2): computeWindowCosts 之后、buildSessionCards 之前
 *     动态 import dsh-cost-tree → 行级标注 treeGroup { parentSid?, childCount } (parentSid =
 *     窗口内最近祖先行) + 逐行 windowTreeTotal (窗口内树合计, 每行只算自己不双计) → client
 *     树形分组渲染 (父行展开 = 自身明细 + 缩进子会话行, 子行可再展开); 库缺失/无窗口内父子
 *     结构 → 不加分组字段 (平铺, 兼容旧服务端/旧 client)。
 *
 * 数据源:
 *   - 会话清单/标题/最后活动: $DSH_HOME/storages/session_projcache.json
 *   - 会话日志: $DSH_HOME/sessions/<projectKey(cwd)>/<sid>/**session.v<N>.jsonl(.zstd)**
 *     (projectKey 与 dsh-session-persistence-jsonl 同规则: 分隔符→'-', 包装 '--x--')
 *     A1 (2026-09-14 阶段6): 文件名**版本化** —— 1.2 = `session.jsonl[.zstd]` (v0),
 *     1.5 = `session.v3.jsonl[.zstd]`; 本插件枚举目录取**最高版本** (旧实现写死
 *     `session.jsonl.zstd` ⇒ 升 1.5 后静默归零)。
 *   - 定价缓存: 归共享库 `@ericality/dsh-cost-pricing` (`cost-pricing-cache.json`)
 *
 * 复用: 定价解析/费用公式/横幅注入 均与 dsh-balance / dsh-cost-ledger 同款
 * (逻辑同源), 命令 handler 内可直接 append (dsh-commands 已同步完成 command/run append,
 * 不在 session/event 观察者派发内, 无需 setTimeout — 见 dsh-balance 手册坑 6)。
 */
export const name = "dsh-sessions-cost";
export const inject = ["commands", "connection"];

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
/** 计费 (RD-30): 共享库 costOf(totals, price, {reasoning}); 缺库 ⇒ 降级垫片同算式 */
function costOf(totals, price, opts) {
	const f = pricingMod?.costOf;
	return typeof f === "function" ? f(totals, price, opts) : DEGRADED_PRICING.costOf(totals, price, opts);
}

const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR || joinPath(DSH_HOME, "sessions");

// ── A1 (2026-09-14 阶段6): 会话日志落盘名的**格式版本选择** ─────────────────────
// 契约 §3.2 盲区②: 文件名版本化 —— 1.2 `session.jsonl[.zstd]` (v0) / 1.5 `session.v3.jsonl[.zstd]`。
// 规则: 取目录内**版本号最大**者; **v0 与 v3 并存只取 v3, 绝不叠加** (叠加 = 同会话双计);
// 同版本优先 `.zstd` (与 readdir 顺序无关); 无日志/目录不可读 ⇒ null (静默跳过, 不 throw 不告警)。
function latestSessionLog(dir) {
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	let best = null;
	let bestV = -1;
	let bestZstd = false;
	for (const name of names) {
		const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
		if (!m) continue;
		const v = m[1] === undefined ? 0 : Number(m[1]);
		const zstd = m[2] !== undefined;
		if (v > bestV || (v === bestV && zstd && !bestZstd)) {
			bestV = v;
			bestZstd = zstd;
			best = `${dir}/${name}`;
		}
	}
	return best;
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
// 预筛选裕量: lastPromptAt 略早于窗口起点也可能有跨窗长回合的用量, 多扫 2h 兜底
const PREFILTER_SLACK_MS = 2 * 3600 * 1000;

// ---- 会话目录 projectKey (与 dsh-session-persistence-jsonl 同规则) ----
function projectKey(cwd) {
	if (!cwd) return "--_no-cwd--";
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

// ---- 时间/时段 ----
/** ISO/ms → 北京 "MM-DD HH:mm" */
function beijingMd(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ");
}

/** 事件所在北京时段 (共享库 `tierOf` 的同义导出; 缺库 ⇒ 降级垫片同规则)。
 *  保留本导出名: VM 套件 `scripts/sessions-cost-test.mjs` 直接调用。 */
export function tierOfMs(ms) {
	const f = pricingMod?.tierOf;
	return typeof f === "function" ? f(ms) : DEGRADED_PRICING.tierOf(ms);
}

// ---- 定价 (RD-42/RD-43): 取价/解析/缓存 全部在共享库 `@ericality/dsh-cost-pricing` ----

// ---- 会话清单 (projcache) ----
/** projcache 全部会话: { sid, cwd, title, createdAt, lastPromptAt, totals } */
async function readSessions() {
	try {
		const sessions = await readProjcacheAll(); // 0.1.2: 分片优先 + 单体表补历史
		const out = [];
		for (const [sid, s] of Object.entries(sessions)) {
			const totals = s?.rows?.tokenUsage?.val?.totals ?? s?.rows?.tokenUsage?.totals;
			if (!totals) continue; // 从未消耗 token 的会话直接跳过
			out.push({
				sid,
				cwd: s?.identity?.cwd ?? "",
				title: s?.rows?.title?.val ?? "",
				createdAt: s?.identity?.createdAt ?? 0,
				lastPromptAt: s?.rows?.sessionListMetadata?.val?.lastPromptAt ?? 0,
				totals
			});
		}
		return out;
	} catch {
		return null;
	}
}

// ---- 会话日志扫描 (多 zstd 帧 + 按行字符串过滤快速解析) ----
/**
 * 扫描单个会话日志, 统计 [startMs, endMs] 窗口内的 token 用量 (按高峰/低谷分桶)。
 * A1: 日志文件按目录枚举取**最高格式版本** (`session[.v<N>].jsonl[.zstd]`);
 * A4: 结算事件扫 `assistant/message` **与** `assistant/attempt` (attempt 取 stream 末帧 usage)。
 * 返回 { peak, off, msgs, first, last } (各桶 { miss, hit, out, reason }), 文件缺失返回 null。
 * 导出供 VM 功能测试直接调用。
 */
export function scanSessionUsage(sid, cwd, startMs, endMs) {
	const dir = `${SESSIONS_ROOT}/${projectKey(cwd)}/${sid}`;
	const file = latestSessionLog(dir);
	if (!file) return null; // 无会话日志 (含目录不存在) → 保持原有静默语义
	let buf;
	try {
		buf = readFileSync(file);
	} catch {
		return null;
	}
	// 多 zstd 帧扫描 (魔数 0xFD2FB528, 与 dsh-session-persistence-jsonl 一致);
	// 未压缩日志 (`*.jsonl`, compression=off) ⇒ 整体作单段明文 (A1)
	const zstd = file.endsWith(".zstd");
	const parts = [];
	if (zstd) {
		let offset = 0;
		while (offset < buf.length) {
			const start = offset;
			if (buf.length - offset < 4) break;
			if (buf.readUInt32LE(offset) !== 0xfd2fb528) break;
			offset += 4;
			const d = buf.readUInt8(offset); offset += 1;
			const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
			const db = df === 3 ? 4 : df, csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
			offset += (ss ? 0 : 1) + db + csb;
			for (;;) {
				const bh = buf.readUIntLE(offset, 3); offset += 3;
				const last = (bh & 1) !== 0, bt = bh >>> 1 & 3, bs = bh >>> 3;
				offset += (bt === 1 ? 1 : bs);
				if (last) break;
			}
			if (ck) offset += 4;
			parts.push(buf.subarray(start, offset));
		}
	} else {
		parts.push(buf);
	}
	const acc = {
		peak: { miss: 0, hit: 0, out: 0, reason: 0 },
		off: { miss: 0, hit: 0, out: 0, reason: 0 },
		msgs: 0, first: 0, last: 0
	};
	for (const part of parts) {
		let text;
		if (zstd) {
			try { text = zstdDecompressSync(part).toString("utf8"); } catch { continue; }
		} else {
			text = part.toString("utf8");
		}
		// 按行扫描: 只有结算事件行需要 JSON.parse (跳过 99% 的 chunk 行)
		let idx = 0;
		for (;;) {
			const nl = text.indexOf("\n", idx);
			const line = nl < 0 ? text.slice(idx) : text.slice(idx, nl);
			if (!line.includes('"type":"assistant/message"') && !line.includes('"type":"assistant/attempt"')) {
				if (nl < 0) break;
				idx = nl + 1;
				continue;
			}
			let rec;
			try { rec = JSON.parse(line); } catch { if (nl < 0) break; idx = nl + 1; continue; }
			const t = rec.time;
			if (typeof t === "number" && t >= startMs && t <= endMs) {
				const u = settlementUsage(rec); // A4: message 直带 usage / attempt 取 stream 末帧
				if (u) {
					const g = tierOfMs(t) === "peak" ? acc.peak : acc.off;
					g.miss += u.inputTokens ?? 0;
					g.hit += u.cacheReadTokens ?? 0;
					g.out += u.outputTokens ?? 0;
					g.reason += u.reasoningTokens ?? 0;
					acc.msgs += 1;
					if (!acc.first || t < acc.first) acc.first = t;
					if (t > acc.last) acc.last = t;
				}
			}
			if (nl < 0) break;
			idx = nl + 1;
		}
	}
	return acc;
}

// ---- 费用 ----
/** 单档费用 (**RD-47 裁决: 与改前逐位一致**) —— 推理 tokens **并入 output 桶**后交共享库 `costOf`:
 *  `costOf({…, outputTokens: out + reason}, p)` ≡ 改前 `(miss×输入价 + hit×缓存价 + (out+reason)×输出价)/1e6`。
 *  语义仍是 RD-30「推理按输出价」(同价同桶), 但避免 `out×价/1e6 + reason×价/1e6` 的浮点末位漂移
 *  (分离式实测 30% 例差 ≤2.9e-16; 合并式 40,000 例 0 差)。展示面本就合并为「输出+推理」一行 ⇒ 显示不变。 */
const costOfTier = (t, p) => costOf(
	{ uncachedInputTokens: t?.miss, cacheReadTokens: t?.hit, cacheWriteTokens: 0, outputTokens: (t?.out ?? 0) + (t?.reason ?? 0) },
	p
);

const fmtMoney = (n) => (Math.round(n * 100) / 100).toLocaleString("zh-CN");
const fmtYuan = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmtTokens = (n) => (n < 1000 ? String(n) : `${(Math.round(n / 1000)).toLocaleString("zh-CN")}k`);

/** 解析 /sessions-cost 参数: 小时数 (支持小数); 非法返回 null */
export function parseHours(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return 24; // 默认 24 小时
	const m = /^(\d+(?:\.\d+)?)/.exec(s);
	if (!m) return null;
	const v = parseFloat(m[1]);
	if (!Number.isFinite(v) || v <= 0) return null;
	return Math.min(8760, Math.max(0.5, v));
}

// ---- 树分组标注 (期乙 §3.4/§4.2, 2026-09-06) ----
// 血缘索引 byId: Map<sid, {parentSession, origin, delegationDepth}> (dsh-cost-tree readTreeIndex 输出)。
// 委托边口径与树库 subtreeIds 默认一致: 只跟随 origin==="subagent" 的边 (fork 续接不算子 agent)。
// 展示语义: parentSid 一律指向**窗口内最近的祖先行** (中间祖先不在窗口 → 直接挂最近在窗口祖先,
// 使"窗口内树合计"无漏算); 窗口内无任何祖先 → parentSid 缺省 (顶层行)。

/** 纯函数辅助: 该行是否经 subagent 委托边挂在父下 */
function subagentParentOf(byId, sid) {
	const rec = byId.get(sid);
	return rec?.origin === "subagent" && typeof rec?.parentSession === "string" && rec.parentSession ? rec.parentSession : undefined;
}

/**
 * 行级分组标注 (纯函数, §3.4): rows 克隆后每行附 treeGroup { parentSid?, childCount }。
 * - parentSid: 窗口内最近祖先行 (仅 subagent 委托边; 窗口内无祖先 → undefined);
 * - childCount: 该行**全树** subagent 后代数 (含窗口外; 索引无 → 0);
 * - byId 空 / sid 不在索引 → parentSid undefined、childCount 0 (不 throw)。
 * @param {Array<{sid:string,...}>} rows computeWindowCosts 结果行
 * @param {Map} byId 树索引 byId (dsh-cost-tree readTreeIndex().byId)
 * @returns {Array} 新数组 (原 rows 不改)
 */
export function attachTreeGroups(rows, byId) {
	const list = Array.isArray(rows) ? rows : [];
	const index = byId instanceof Map ? byId : byId?.byId instanceof Map ? byId.byId : new Map();
	const sidSet = new Set(list.map((r) => r.sid).filter((s) => typeof s === "string"));
	// 字面直系父 map (只沿 subagent 委托边) + 子 map (后代数用)
	const parentOf = new Map();
	const childrenOf = new Map();
	for (const [sid, rec] of index) {
		if (typeof sid !== "string" || !rec) continue;
		const p = subagentParentOf(index, sid);
		if (!p) continue;
		parentOf.set(sid, p);
		const arr = childrenOf.get(p) ?? [];
		arr.push(sid);
		childrenOf.set(p, arr);
	}
	const descCount = new Map();
	const countDesc = (sid) => {
		if (descCount.has(sid)) return descCount.get(sid);
		descCount.set(sid, 0);
		const kids = childrenOf.get(sid);
		let n = 0;
		if (kids) for (const k of kids) n += 1 + countDesc(k);
		descCount.set(sid, n);
		return n;
	};
	return list.map((r) => {
		let parentSid;
		if (typeof r.sid === "string") {
			// 沿字面父链上溯, 取窗口内最近祖先 (防环)
			let cur = parentOf.get(r.sid);
			const seen = new Set();
			while (typeof cur === "string" && cur && !seen.has(cur)) {
				seen.add(cur);
				if (sidSet.has(cur)) { parentSid = cur; break; }
				cur = parentOf.get(cur);
			}
		}
		return {
			...r,
			treeGroup: {
				parentSid,
				childCount: typeof r.sid === "string" ? countDesc(r.sid) : 0
			}
		};
	});
}

/**
 * 窗口内树合计 (纯函数, §3.4): sid 行自身 + 窗口内出现的其后代行费用和 — **每行只算自己、不双计**
 * (后代行的费用只在其祖先链上的窗口内祖先处计入一次; 自身行只计自身一次)。
 * 依赖 rows 已带 treeGroup.parentSid (attachTreeGroups 产物); sid 不在 rows → 0。
 * @param {Array} rows computeWindowCosts 行 (已附 treeGroup)
 * @param {string} sid
 * @returns {number}
 */
export function windowTreeTotal(rows, sid) {
	if (typeof sid !== "string" || !Array.isArray(rows)) return 0;
	const bySid = new Map();
	for (const r of rows) if (typeof r?.sid === "string") bySid.set(r.sid, r);
	let total = 0;
	for (const r of rows) {
		if (typeof r?.cost !== "number") continue;
		if (r.sid === sid) { total += r.cost; continue; }
		let cur = r?.treeGroup?.parentSid;
		const seen = new Set();
		let isDesc = false;
		while (typeof cur === "string" && cur) {
			if (cur === sid) { isDesc = true; break; }
			if (seen.has(cur)) break; // 防环
			seen.add(cur);
			cur = bySid.get(cur)?.treeGroup?.parentSid;
		}
		if (isDesc) total += r.cost;
	}
	return total;
}

/**
 * 生产入口 (computeWindowCosts 之后 / buildSessionCards 之前, §3.4): 动态 import
 * @deepseek-ai/dsh-cost-tree → readTreeIndex → attachTreeGroups + 逐行 windowTreeTotal。
 * 库缺失 / 索引异常 / 窗口行间无 subagent 父子结构 → 返回原 rows (**现行为不变**, 平铺渲染,
 * 兼容缺库/旧服务端); 任何单点失败 catch 后跳过, 不 throw。
 * @param {Array} rows computeWindowCosts 结果行
 * @param {{readIndex?: Function}} [opts] 可选: readIndex(treeMod) 覆盖索引读取 (本地测试注入合成 byId,
 *   免真实 $DSH_HOME IO); 生产不传
 * @returns {Promise<Array>}
 */
export async function addTreeGrouping(rows, opts = {}) {
	if (!Array.isArray(rows) || rows.length === 0) return rows;
	let treeMod;
	try {
		treeMod = await import("@ericality/dsh-cost-tree/lib/index.js");
	} catch {
		return rows; // 缺库 → 降级 (不加分组字段)
	}
	if (!treeMod || typeof treeMod.readTreeIndex !== "function") return rows;
	try {
		const index = typeof opts.readIndex === "function" ? await opts.readIndex(treeMod) : await treeMod.readTreeIndex();
		const byId = index?.byId instanceof Map ? index.byId : new Map();
		if (byId.size === 0) return rows;
		const grouped = attachTreeGroups(rows, byId);
		const sidSet = new Set(rows.map((r) => r.sid));
		// 仅当窗口内存在可见父子结构 (有行的 parentSid 指向窗口内另一行) 才下发分组字段,
		// 避免无委托结构的窗口也带冗余字段 (VM/旧断言形状不受扰)
		const hasVisibleLink = grouped.some((r) => typeof r.treeGroup?.parentSid === "string" && sidSet.has(r.treeGroup.parentSid));
		if (!hasVisibleLink) return rows;
		return grouped.map((r) => ({ ...r, windowTreeTotal: windowTreeTotal(grouped, r.sid) }));
	} catch {
		return rows;
	}
}

/**
 * 主计算: 窗口内各会话费用。
 * 返回 { rows, total, matched, startMs, endMs, prices, priceSource }
 *   rows: [{ sid, title, peak, off, cost }] 按费用降序
 * 出错返回 { error: "no-data" } (projcache 不可读)。
 * 导出供 VM 功能测试直接调用 (固定读 $DSH_HOME 路径, 测试用夹具备份/恢复)。
 */
export async function computeWindowCosts(hours) {
	const endMs = Date.now();
	const startMs = endMs - hours * 3600 * 1000;
	const { prices, source } = await resolvePrices();
	const sessions = await readSessions();
	if (!sessions) return { error: "no-data" };

	const rows = [];
	for (const s of sessions) {
		// 预筛选: lastPromptAt 在窗口内 (含裕量) 或会话创建于窗口内才扫描日志
		if (s.lastPromptAt < startMs - PREFILTER_SLACK_MS && s.createdAt < startMs) continue;
		const u = scanSessionUsage(s.sid, s.cwd, startMs, endMs);
		if (!u || u.msgs === 0) continue; // 窗口内无 token 消耗 → 不匹配
		const peakCost = costOfTier(u.peak, prices.peak);
		const offCost = costOfTier(u.off, prices.offpeak);
		rows.push({
			sid: s.sid,
			title: s.title,
			peak: u.peak,
			off: u.off,
			peakCost,
			offCost,
			cost: peakCost + offCost
		});
	}
	rows.sort((a, b) => b.cost - a.cost);
	return {
		rows,
		total: rows.reduce((sum, r) => sum + r.cost, 0),
		matched: rows.length,
		startMs, endMs,
		prices,
		priceSource: source
	};
}

// ---- 横幅 (与 dsh-balance appendBanner 同款; P1-2: 写路径唯一 = banner-kit.emit, **去 session**) ----
function appendBanner(session, payload, identity) {
	const sid = String(session?.id ?? "");
	if (!sid) return Promise.resolve(false);
	return (async () => {
		try {
			const bk = await loadBannerKit();
			if (typeof bk?.emit !== "function") {
				logWarn?.(`dsh-sessions-cost: banner-kit 不可用 → 横幅注入停用 (回退命令气泡文本)`);
				return false;
			}
			// obs#3 段M（#A83 五）：**发射侧给身份键** —— 覆盖键 = (kind, rev, mode) 三者全等，而 `decideRevMode`
			//   对不传 replace 者 `rev` 恒 0 ⇒ 两次 `/cost` 会**互相覆盖**（实测分片 `costs` n=1）。
			//   ⇒ 每次发射给**唯一 `rev`**（毫秒时间戳，单调且跨重启不复用）+ `ctxKey` 身份（`costs-<at>`）。
			const _at = Date.now();
			// ★批7 `T15`：**逐次唯一身份**（与 `rev`/`ctxKey` 同源的 `_at`）
			// ★段2 `B2`/`B4`：命名空间 `ns` 由调用方给（缺省 = 本卡 `kind`）⇒ **按 kind／按 error 类型分段、不共用**；
			//   身份键 `key` 由调用方给（缺省 = `_at` ⇒ 逐次唯一 ＝ 本卡原有语义）；显式 `null` ⇒ 不伪造 ⇒ 落码点名。
			const _ns = (identity && typeof identity.ns === "string" && identity.ns) ? identity.ns : String(payload?.kind ?? "card");
			const _key = (identity && Object.prototype.hasOwnProperty.call(identity, "key")) ? identity.key : _at;
			const _cid = _cardIdOf(_ns, sid, _key);
			if (!_cid) logWarn?.(`E-CARDID-NOKEY:dsh-sessions-cost|${_ns} 身份输入缺失 ⇒ 不带 cardId、按旧路径发射（不伪造身份）`);
			const r = await bk.emit({ at: _at, ...payload, sessionId: sid, ...(_cid ? { cardId: _cid } : {}), anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD,
				rev: Number.isFinite(payload && payload.rev) ? payload.rev : _at,
				ctxKey: (payload && typeof payload.ctxKey === "string" && payload.ctxKey) ? payload.ctxKey : ("costs-" + _at) }, { source: "dsh-sessions-cost" });
			if (!r?.ok) {
				logWarn?.(`dsh-sessions-cost: 横幅注入失败 (${r?.reason ?? "unknown"}) → 回退命令气泡文本`);
				return false;
			}
			return true;
		} catch (err) {
			logWarn?.(`dsh-sessions-cost: 横幅注入异常 (${String(err?.message ?? err)}) → 回退命令气泡文本`);
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
			if (typeof _smB6.wrapBannerKit === "function") bannerKitMod = _smB6.wrapBannerKit(bannerKitMod, "dsh-sessions-cost");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch {
		bannerKitDead = true;
		bannerKitMod = null;
	}
	return bannerKitMod;
}

function shortTitle(title, sid) {
	const t = title || `会话 ${sid.slice(8, 16)}`;
	return t.length > 14 ? `${t.slice(0, 14)}…` : t;
}

/**
 * 构建横幅 sessions 结构化明细 (客户端手风琴渲染, 每会话一个卡片):
 *   [{ title, sid, costText, peakCostText?, offCostText?,
 *      peak?: { label, costText, lines: [{k,v}×3] }, off?: {...} }]
 * 每种类型一行: 输入(未命中) / 缓存命中 / 输出+推理, 各含 `token × 单价 = 金额`;
 * 高峰/低谷分档 (该档无 token 则省略该档); **不省略任何会话** (全量, 客户端滚动查看)。
 */
function buildSessionCards(rows, prices) {
	return rows.map((r) => {
		const tierCard = (name, t, p, cost) => {
			if (!t || (t.miss === 0 && t.hit === 0 && t.out + t.reason === 0)) return null;
			return {
				label: name,
				costText: `¥${fmtYuan(cost)}`,
				rows: [
					{ k: "输入(未命中)", v: `${fmtTokens(t.miss)} × ¥${p.inputMiss} = ¥${fmtYuan((t.miss * p.inputMiss) / 1e6)}` },
					{ k: "缓存命中", v: `${fmtTokens(t.hit)} × ¥${p.inputHit} = ¥${fmtYuan((t.hit * p.inputHit) / 1e6)}` },
					{ k: "输出+推理", v: `${fmtTokens(t.out + t.reason)} × ¥${p.output} = ¥${fmtYuan(((t.out + t.reason) * p.output) / 1e6)}` }
				]
			};
		};
		const peak = tierCard("高峰", r.peak, prices.peak, r.peakCost);
		const off = tierCard("低谷", r.off, prices.offpeak, r.offCost);
		const card = {
			title: r.title || `会话 ${r.sid.slice(8, 16)}`,
			sid: r.sid.slice(8, 16),
			costText: `¥${fmtMoney(r.cost)}`,
			peakCostText: peak ? `¥${fmtMoney(r.peakCost)}` : null,
			offCostText: off ? `¥${fmtMoney(r.offCost)}` : null,
			peak,
			off
		};
		// §3.4 (期乙): 树分组字段 (addTreeGrouping 标注后才有; 缺库/无结构 → 无 → client 平铺兼容)
		if (r.treeGroup) {
			card.fullSid = r.sid;
			card.treeGroup = r.treeGroup; // { parentSid?, childCount } — parentSid = 窗口内最近祖先行
			if (typeof r.windowTreeTotal === "number") card.windowTreeTotal = r.windowTreeTotal;
		}
		return card;
	});
}

/** 单个会话的回退文本 (横幅注入失败时用, 每类型一行) */
function fallbackSessionLines(r, prices) {
	const out = [`- ${shortTitle(r.title, r.sid)}: 合计 ¥${fmtMoney(r.cost)}`];
	const tierLines = (name, t, p) => {
		if (!t || (t.miss === 0 && t.hit === 0 && t.out + t.reason === 0)) return;
		out.push(`    ${name}: 输入 ${fmtTokens(t.miss)}×¥${p.inputMiss} = ¥${fmtYuan((t.miss * p.inputMiss) / 1e6)} · 缓存 ${fmtTokens(t.hit)}×¥${p.inputHit} = ¥${fmtYuan((t.hit * p.inputHit) / 1e6)} · 输出+推理 ${fmtTokens(t.out + t.reason)}×¥${p.output} = ¥${fmtYuan(((t.out + t.reason) * p.output) / 1e6)}`);
	};
	tierLines("高峰", r.peak, prices.peak);
	tierLines("低谷", r.off, prices.offpeak);
	return out;
}

export async function apply(ctx) {
	registerConfigApi(ctx);
	// 插件告警出口 (RD-43 缺库降级必须可观测, §2.3 禁止静默)
	logWarn = (m) => { try { ctx.logger?.warn?.(m); } catch { /* noop */ } };
	// RD-43: 启动期探测共享取价库 —— 缺库立即 warn (不等首次命令才暴露)
	await pricingLib();
	// notice/banner 事件类型注册 (P1-2 收敛: **唯一注册路径** = banner-kit `ensureRegistered()`，
	// 经 §4.5 `ensureEventTypes` seam；**不再直连宿主 `KNOWN_SESSION_EVENT_TYPES`** —— 注册动作保留)。
	try {
		const bk = await loadBannerKit();
		let reg = { ok: false, reason: "banner-kit" };
		if (bk && typeof bk.ensureRegistered === "function") reg = await bk.ensureRegistered();
		if (reg && reg.ok !== true) { if (logWarn) logWarn("dsh-sessions-cost: notice/banner 类型注册失败 (" + String(reg.reason || "unknown") + ")"); }
	} catch (err) {
		if (logWarn) logWarn("dsh-sessions-cost: 事件类型注册异常: " + String(err && err.message ? err.message : err));
	}

/** ★T-F′（2026-09-21 obs3S7；用户已签）：本会话**当前回合号** —— 取 projcache `turnBoundary.lastTurn`
 *  （分片形态 `{ver,seq,val}` 与旧单体表形态都兼容）；**取不到 ⇒ null（键恒在、不猜）**。
 *  ★★ **`#A71` 裁决二（2026-09-21；同日）**：**`0` 必须归 `null`** —— `lastTurn: 0` 是 projcache 的
 *  **"尚无回合"初始值**（实测该会话 `{openTurnStartSeq:null, lastStepStartSeq:null, lastStepBoundary:null, lastTurn:0}`），
 *  **不是行身份**（`turn` 臂要求**正整数**回合尾/首行）⇒ 若原样写 0，B 侧入口校验会判 `gate-shape-turn`
 *  （`0` 非正整数）**拒收整个卡**。既有 T-F′ 口径「取不到 ⇒ null，不猜」据此**收紧到 `> 0`**。 */
async function latestTurnOf(sid) {
	try {
		const rec = await readProjcacheOne(sid);
		const tb = rec && rec.rows ? rec.rows.turnBoundary : null;
		const t = tb && tb.val ? tb.val.lastTurn : (tb ? tb.lastTurn : null);
		return Number.isInteger(t) && t > 0 ? t : null;
	} catch {
		return null;
	}
}

	ctx.commands.register({
		name: "sessions-cost",
		description: "多会话费用统计: 本地计算近 N 小时 (默认取配置页 defaultHours，出厂 24) 内各会话费用, 按会话日志逐事件统计 token + 分高峰/低谷计价, 每会话展示计算过程, 玫红横幅默认折叠 (零 token)",
		input: {
			hint: "[小时数，缺省取配置页 defaultHours]"
		},
		handler: async (invocation) => {
			const session = invocation?.agent?.session;
			const settings = await readSettings();
			// 配置 defaultHours: 命令不带参数时用它（显式带小时数以参数优先；显式但非法仍报参数无效）
			const rawHours = String(invocation?.rawInput ?? "").trim();
			const hours = rawHours === "" ? settings.defaultHours : parseHours(rawHours);
			// ★段2 `B2`（2026-09-29）：`error` 卡**按类型**定身份（三类型**命名空间各自一段、不共用**）——
			//   `参数无效` ⇒ 取**命令**（`commandId`：同命令重复 ⇒ 恒 1 张；异命令 ⇒ 各 1 张）；
			//   `projcache 未就绪` ⇒ 取**会话**（`sid`：重复 ⇒ 恒 1 张）；
			//   `窗口无活动` ⇒ **逐次唯一**（缺 `key` ⇒ `_at`，不合并 —— 与"每次调用都是一次现况"语义一致）。
			//   身份输入取不到（`commandId` 非字符串）⇒ `key = null` ⇒ **不伪造**、回落旧路径 ＋ `E-CARDID-NOKEY` 点名。
			const errBanner = async (title, lines, type) => {
				const _commandId = (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null;
				const _ident = type === "invalid-arg" ? { ns: "error|invalid-arg", key: _commandId }
					: type === "projcache-not-ready" ? { ns: "error|projcache-not-ready", key: String(session?.id ?? "") }
						: { ns: "error|no-window-activity" };
				const ok = await appendBanner(session, {
					kind: "error",
				priority: 0, foldable: true, family: "error",
					// ★`#A235` 件6b（obs3S7 T24 机械成因修复；件1件 §4 件6 表）：**error 卡此前只带 `ctxKey`**（`appendBanner`
					//   自动补 `costs-<ms>`）⇒ 该 ctxKey 形态**不属** store 的 ctxKey 臂可解析形态（`cost-<seq>`/`ledger-<seq>` 的数字
					//   是**真锚点 seq**，不是 ms）⇒ 落 `no-anchor`（面板异常面）。现补**同源位置键**，与正路站点（本文件 `:735` 那条）
					//   **逐字同形**：命令面 `commandId`（宿主发放、与 `command/done.data.commandId` 同值）+ `turn`（回合尾兜底）。
					//   **取不到 ⇒ null（不猜）**；`turn` 已由 `latestTurnOf` 收紧到 `> 0`（`#A71` 裁决二）。
					commandId: _commandId,
					turn: await latestTurnOf(String(session?.id ?? "")),
					title,
					lines,
					metaText: "本提示不会进入模型历史"
				}, _ident);
				if (ok) return { kind: "success", text: "" };
				return { kind: "error", text: `${title}\n${lines.join("\n")}` };
			};

			if (hours === null) {
				return await errBanner("参数无效", [`请输入小时数（如 /sessions-cost 48），默认 ${settings.defaultHours} 小时`], "invalid-arg");
			}
			const hoursLabel = `${hours} 小时`;
			const res = await computeWindowCosts(hours);
			if (res.error === "no-data" || !res) {
				return await errBanner("暂时无法计算", ["无法读取会话数据（projcache 未就绪），稍后再试"], "projcache-not-ready");
			}
			if (res.matched === 0) {
				return await errBanner("窗口内没有会话活动", [`近 ${hoursLabel}没有会话产生 token 消耗`], "no-window-activity");
			}

			const { rows, total, matched, startMs, endMs, prices, priceSource } = res;
			// §3.4 (期乙): 树分组标注 — computeWindowCosts 之后、buildSessionCards 之前;
			// 动态 import dsh-cost-tree, 库缺失/无窗口内父子结构 → rows 原样 (平铺兼容旧服务端)
			const rows2 = await addTreeGrouping(rows);
			// 会话明细 (全量不省略): 客户端手风琴渲染, 每会话每种类型一行; 有 treeGroup → 客户端树分组渲染
			// 配置 showBreakdown=false ⇒ 只保留合计与窗口统计, 逐会话明细不展示
			const sessions = settings.showBreakdown ? buildSessionCards(rows2, prices) : [];

			const stats = [
				{ label: "窗口合计", value: `¥${fmtMoney(total)}`, strong: true, note: `${matched} 会话` },
				{ label: "有活动会话", value: `${matched} 个` },
				{ label: "窗口", value: hoursLabel }
			];
			const metaText = `窗口 ${beijingMd(startMs)} → ${beijingMd(endMs)} · 本地按会话日志逐事件统计 · 定价来源: ${priceSource}`;
			const advice = `单价(¥/百万) 高峰 输入${prices.peak.inputMiss} / 缓存${prices.peak.inputHit} / 输出${prices.peak.output} · 低谷 ${prices.offpeak.inputMiss} / ${prices.offpeak.inputHit} / ${prices.offpeak.output} · 本地估算，实际扣费以官方账单为准`;

			// 回退文本 (横幅注入失败时)
			const lines = [`近 ${hoursLabel}会话费用 (${matched} 个会话, 合计 ¥${fmtMoney(total)})`];
			if (settings.showBreakdown) for (const r of rows) lines.push(...fallbackSessionLines(r, prices));
			else lines.push("(已按配置关闭逐会话明细)");
			lines.push(`定价来源: ${priceSource}`);

			const ok = await appendBanner(session, {
				kind: "costs",
				priority: 3, foldable: false, family: "costs",
				// ★`#A193` 件①（2026-09-23 obs3S7；用户已签「有问题就修问题，不要藏起来」）：
				//   **命令↔行配对键** —— 本族由 `/sessions-cost` 命令触发，此前只带 `turn`（回合级）⇒ 落回合尾行、与其它回合卡"堆积"。
				//   命令面取宿主发放的同源 `commandId`（与 `command/done.data.commandId` 逐字同值；`invocation` 由本 handler 作用域提供）；
				//   与 `dsh-balance:507`／`dsh-taskqueue:1489` 逐字同形。取不到 ⇒ null（不猜）。**`turn` 保留作兜底**。
				commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
				// ★T-F′（2026-09-21 obs3S7；用户已签）：补 `turn`（回合尾行身份）——源 = projcache `turnBoundary.lastTurn`
				turn: await latestTurnOf(String(session?.id ?? "")),
				title: `近 ${hoursLabel} 会话费用`,
				subtitle: `${matched} 个会话有活动 · ${beijingMd(startMs)} → ${beijingMd(endMs)}`,
				stats,
				sessions,
				metaText,
				advice,
				at: Date.now()
			});
			if (!ok) return { kind: "success", text: lines.join("\n") };
			return { kind: "success", text: "" };
		}
	});
}
