/**
 * @deepseek-ai/dsh-notice-banner (本地辅助插件, 非官方包) — Node 侧 host half
 *
 * 职责: 把自定义会话事件类型 `notice/banner` 与 `notice/banner-replace` 注册进宿主
 * KNOWN_SESSION_EVENT_TYPES (阶段 1 起经 host-compat seam §4.5 `ensureEventTypes`),
 * 使持久化读取路径 (dsh-session-persistence 的 assertEventsSupported) 接受该类型 —
 * 否则会话日志重建时会拒绝未知事件类型, 导致整个会话无法加载。
 * (dsh-notify / dsh-cost-ledger / dsh-taskqueue 注入该事件; notice/banner-replace 由
 * cost-guard 用于费用横幅原地替换, 同一会话只保留最新一条; 注册幂等, 多插件重复执行无副作用。)
 *
 * 浏览器侧 bundle 在 ./client.js (exports["./client"]), 由 client-modules 注册表
 * 扫描并 serve /plugins/@deepseek-ai/dsh-notice-banner/client.js, 渲染横幅。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/notice-banner/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "notice-banner");
const COMPAT_DIR = process.env.DSH_COMPAT_DIR || joinPath(DSH_HOME, "plugin-data", "host-compat");
const LOG_DIR = joinPath(DSH_HOME, "logs", "notice-banner");
// 自有数据面（P1-1：横幅数据归本插件；host-compat **不持有**业务数据 —— ENV 红线 7 ③）
// 注意：`store.js` 内部对 `@ericality/dsh-banner-kit` 只做**动态 import + try/catch**（契约 §10.1 禁静态 import 共享包）
import { NOTICE_SCHEMA_VERSION, appendEntry, deleteCard, backfillState, flushSlots, listEntriesSync, observeRow, readIndex, readStateCards, recordRender, reportRejected, storeRoot, storeStatus, validateEntrySync } from "./store.js";
// W7（2026-11-12）：历史条幅归档的**唯一读取口**（插件自有数据面、只读、永不 throw；头注见 `lib/history.js`）
import { historyFor } from "./history.js";

import z from "@deepseek-ai/schemastery";

/** 官方 Config：折叠开关可在插件页保存，保存即生效（缺省关）。 */
export const Config = z.object({
	foldKeep: z.boolean().default(false).volatile()
});

/* ------------------------------------------------------------------ 错误码出口（T2 接线）
 * 内联自 `scripts/errcode/template-helper.js`（守 §1.1「各插件自带薄 helper ≤20 行」+ D19 零跨包 import）。
 * 出口名 = `reportErr`（§1.1 冻结；`report` 在本仓另是闸门申报契约，两者不得混用）；返回 void、永不 throw。
 * 落 `<root>/log/error-fallback/<PKG>.log`（D23；本批不写 $DSH_HOME，§2.0-4）= 闸门/reporter 缺席时的兜底写入器（D2）。
 * ⚠️ 与模板的唯一差异（已在报告登记）：内层函数**匿名**（模板里叫 `reportErr`）—— 否则门禁
 *    `scripts/error-surface-lint.mjs` 的出口抽取会把**函数定义行**当成一次出口调用（默认参数不是对象属性
 *    => 误计 `joinKeyMissing`），污染既有读数。`site` 帧位与语义逐字不变。
 */
const PKG = "dsh-notice-banner";
function makeReportErr(root = LOG_DIR) {
	const dir = `${root}/error-fallback`;
	return function ({ code, detail = "", severity = "log", site = "" } = {}) {
		try {
			if (typeof code !== "string" || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(code) || code.length > 24) return;
			const d = String(detail).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
			const sv = ["log", "state", "user"].includes(severity) ? severity : "log";
			const s = site || (new Error().stack || "").split("\n")[2]?.trim().replace(/^at\s+/, "").replace(/^(.+?)\s+\((.+)\)$/, "$2#$1").replace("file://", "") || "(anon)";
			mkdirSync(dir, { recursive: true });
			appendFileSync(`${dir}/${PKG}.log`, `${new Date().toISOString()} | ${PKG}.${code} | ${sv} | ${s} | ${d}\n`);
		} catch (e) { process.stderr.write(`errcode: ${PKG} ${e?.message ?? e}\n`); }
	};
}
const reportErr = makeReportErr();


export const name = "dsh-notice-banner";

/** 本插件声明需要的能力 (§3 key; 与 package.json `dshCompat.seams` 集合相等 — RD-1) */
const REQUIRES = ["eventTypeRegistry"];
/** 缺这些能力 ⇒ BLOCKED (§3/D1: 缺失会导致"写错数据" — 未注册类型进会话日志 ⇒ 会话无法加载) */
/** 缺这些能力 ⇒ **路径级** BLOCKED (RD-20; 与 package.json `dshCompat.blocked` 同源, 此处仅为"读 package.json 失败"时的回退) */
const BLOCKED_FALLBACK = ["eventTypeRegistry"];
/** 本插件负责注册的事件类型 (与改造前两处 KNOWN_SESSION_EVENT_TYPES.add 逐条一致) */
const EVENT_TYPES = ["notice/banner", "notice/banner-replace"];
/** §3 key → §4 seam 函数名 (§4 v1 只冻结这 5 面) */
const SEAM_OF = { eventTypeRegistry: "ensureEventTypes" };

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

/** §4.10: host-compat 不可用时插件自己写状态分片 (§5 单写者: 只写自己的分片; 0600)
 *  注: 形参名用 `shardEntry` —— 它读的是**契约 §5.1 分片键**, 不是横幅 schema 键;
 *  命名区分可让"横幅 schema 键集对撞"抽取零歧义 (P1-1 selftest ③)。 */
function writeShard(ctx, shardEntry) {
	try {
		const dir = `${COMPAT_DIR}/compat-status.d`;
		mkdirSync(dir, { recursive: true });
		// 分片形状照 RD-15 裁定 (扁平 8 键, 不套 plugins[]): schema/id/version/state/missing/blocked/note/probedAt
		writeFileSync(`${dir}/${shardEntry.id}.json`, JSON.stringify({ schema: 1, ...shardEntry, probedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
	} catch (err) {
		ctx.logger?.warn?.(`${name}: 适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

/* ==========================================================================================
 * 读通道桥接（P1-1；契约 §12-21 / P1 设计稿 §4）
 *   · 数据归属方 = 本插件（`ctx.provide("noticeState", {list, append})`）；
 *   · `dsh-host-compat` **additive** 提供 `ctx.provide("compatBus", {registerEndpoint, listEndpoints})`
 *     —— 它**不认识**任何具体消费者（**不写死 case**），本插件启动时**注册** `notice/list`；
 *   · 依赖方向 = **notice-banner → host-compat**；`compatBus` 暂不可用（加载顺序不定）⇒ **惰性重试**；
 *   · 解析纪律：一律 **`ctx.get("…")` 字面量形态**（禁属性访问 / 禁可选链）、**每次调用惰性解析**、
 *     整段 try/catch、**apply 期禁止缓存服务引用**（这里只闭包持有 `ctx` 本身，不持有任何服务）。
 * ========================================================================================== */

/** 总线端点名（命名空间式；契约 §12-21） */
const LIST_ENDPOINT = "notice/list";
/** obs3S7 段W-2a **T2-a（件C）**：渲染回报端点（**新增通道**；只写 ① 的 `RENDER` 记录） */
const RENDER_ENDPOINT = "notice/render-report";
/** ★`#A581` ①（路线 1 · **应用侧自报**；2026-10-13）：**消费方**（本插件 client 半）把**客户端面服务** `hostScroll`
 *  的**取用结果**回传给本插件 host 半 ⇒ 本半写**自有分片**（§4.10）⇒ `buildStatus().plugins[notice-banner].state`
 *  与面板**如实**反映"补滚停用"（`ENV §一.6②` 禁"报 OK 而功能坏"）。
 *  **中间件零改动**：本插件**自有**端点，经 `compatBus` 通用端点注册（不新增"直连宿主"接触点，`§一.7①`）。
 *  口径（本件裁）：`missing[]` **只收 §3 服务端能力键**（不混客户端面服务名 ⇒ 免 `capabilitySignature`/"缺能力"语义漂移）；
 *  客户端面服务缺失走 **`state:"DEGRADED"` ＋ `note` 点名**。 */
const SEAM_STATE_ENDPOINT = "notice/seam-state";
/** W7（2026-11-12）：**历史条幅读通道**。数据源 = 本插件自有归档（`lib/history.js`，只读），
 *  经 `compatBus` 通用端点注册 → 客户端走**既有** `/host-compat` RPC 路由取数。
 *  **不新增宿主直连接触点**（`ENV §一.7①`）、**中间件不持业务数据**（`§一.7③`：归档在本插件的自有目录）。 */
const HISTORY_ENDPOINT = "notice/history";

/**
 * `notice/render-report`（T2-a 件C；设计稿 §5.2）：A 侧回报"应渲染 N / 实渲染 M / 未定位 K" ⇒ B 记 ① `RENDER`。
 * **同步** handler（与读通道同口径）；**错误分类**（计划 v5 §3）：**调用方形状错 ⇒ `{ok:false}` 且 `degraded:false`**；
 * **store/sink 不可用或失败 ⇒ `degraded:true`**（如实降级，禁"报 OK 而功能坏"）。永不 throw。
 */
function makeRenderReportHandler(ctxRef, loggerRef) {
	const bad = (reason) => ({ ok: false, degraded: false, reason });
	const degraded = (reason) => ({ ok: false, degraded: true, reason });
	return (payload) => {
		let p = null;
		try { p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null; } catch { p = null; }
		if (!p) return bad("bad-request");
		const sid = p.sessionId === undefined ? null : p.sessionId;
		if (sid !== null && typeof sid !== "string") return bad("bad-request:sessionId");
		if (!Number.isFinite(p.expect) || !Number.isFinite(p.actual)) return bad("bad-request:expect/actual");
		let state = null;
		try {
			state = ctxRef.get("noticeState"); // ← 字面量形态（与读通道同纪律）
		} catch (err) {
			loggerRef?.warn?.(`${name}: noticeState 解析异常 → 渲染回报降级: ${String(err?.message ?? err)}`);
			state = null;
		}
		if (!state || typeof state.recordRender !== "function") return degraded("noticeState");
		try {
			// ★★ `#A63` ① 前置修复（补链；2026-09-21 obs3S7）：**端点侧逐字段透传 ⇒ 必须补 `counters`** ——
			//   否则客户端发了、store 也收了，但**这一跳白名单把它丢掉**（R6 实测：① 行无 `counters` 键、正控无区分度）。
			//   ⚠️ 教训：凡「只增键」类改动，**链上每一跳的显式字段清单都要同批补**（客户端 → 端点 → store）。
			// ★★ 批4 `#37`（范围「乙」；**同批补链**，即上一条 `#A63` ① 教训）：客户端新增的
			//   `kindPanel`／`kindFolded`／`kindUnshown` **必须在这一跳也逐字段透传** —— 否则客户端发了、store 也收了，
			//   但**端点侧白名单把它丢掉**（静默丢键）。三键**只落 ① 的 `RENDER` 记录**：不进 `result`、不上屏、不降级。
			// ★★ 批16（`#78`；**同批补链**，承 `#A63` ①／批4 `#37` 的同一条教训）：
			//   `unplacedRenderable`（＝客户端"可渲染未定位张数"，**上屏唯一口径**）必须在这一跳逐字段透传 ——
			//   否则客户端发了、store 也收了，但**端点侧白名单把它丢掉**（静默丢键 ⇒ 汇总卡又退回老口径）。
			//   该键**只落 ① 的 `RENDER` 记录**：不进 `result`、不改 `unplaced`（对齐口径留作 B 侧对账）。
			const r = state.recordRender({ sessionId: sid, expect: p.expect, actual: p.actual, unplaced: p.unplaced, unplacedRenderable: p.unplacedRenderable, window: p.window, cards: p.cards, cardsPanel: p.cardsPanel, visible: p.visible, counters: p.counters, kindPanel: p.kindPanel, kindFolded: p.kindFolded, kindUnshown: p.kindUnshown });
			if (r && typeof r.then === "function") return degraded("noticeState-async"); // 同步形状（同读通道）
			if (!r || r.ok !== true) return degraded(String(r?.reason ?? "store"));
			return { ok: true, degraded: false, seq: r.seq, result: r.result };
		} catch (err) {
			return degraded(`render-report-threw:${String(err?.message ?? err)}`);
		}
	};
}
/** ★`#A581` ①：客户端面服务取用结果回传端点 handler（同步；**只写自有分片**，不碰宿主、不碰其它插件）。
 *  `{state:"ok"}` ⇒ 回到 §3 探测态（不留假红）；`{state:"missing", reason}` ⇒ `state:"DEGRADED"` ＋ note 点名。永不 throw。 */
function makeSeamStateHandler(onSeamState, loggerRef) {
	const bad = (reason) => ({ ok: false, degraded: false, reason });
	return (payload) => {
		let p = null;
		try { p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null; } catch { p = null; }
		if (!p) return bad("bad-request");
		const st = p.state === "ok" ? "ok" : (p.state === "missing" ? "missing" : null);
		if (st === null) return bad("bad-request:state");
		try {
			if (typeof onSeamState === "function") onSeamState(st === "missing", typeof p.reason === "string" ? p.reason : "", { service: typeof p.service === "string" ? p.service : null, host: typeof p.host === "string" ? p.host : null });
		} catch (err) {
			return { ok: false, degraded: true, reason: `seam-state-report-threw:${String(err?.message ?? err)}` };
		}
		return { ok: true, degraded: false, seam: st };
	};
}
/** 惰性重试退避（ms）—— **可配常量**（契约 §12-21 / 2026-09-15 硬化线）。
 *  硬化依据：原窗口 `[0,200,500,1000,2000]`（≈3.7s）**不足以覆盖冷启动** ——
 *  `compatBus` 由 **另一个插件**（host-compat）在自己的 apply 期 `provide`，而两者 apply 顺序**无任何保证**
 *  （0.1.2/1.5 外壳对全部插件条目 `Promise.all` 并发 create，见契约 §12-18 RD-81）；NAS 生产的启动显著慢于 VM。
 *  新窗口 ≈ **90s**（0→1s→3s→8s→20s→30s→60s→90s 累计）+ 之后每 60s 复检一次、**最多再 5 次**（≈5 分钟封顶），
 *  成功或封顶即停（**不重试风暴**）；封顶后**经分片 NOTE 如实上报**（见 `reportRegistryFailure`）。 */
export const REGISTER_DELAYS = [0, 1000, 2000, 5000, 12000, 10000, 30000, 30000];
/** 复检间隔与上限（累计 ≈5 分钟；`REGISTER_DELAYS` 与这两个常量即本项的"可配面"） */
const REGISTER_RECHECK_MS = 60000;
const REGISTER_RECHECK_MAX = 5;

/** 空丢弃计数（形状 = 契约 §12-21 的 `dropped` 三键） */
function emptyDropped() {
	return { missing: {}, badSchema: 0, oversized: 0 };
}

/** `dropped` 归一化（三键固定；上游形状漂移不改返回形状） */
function normalizeDropped(raw) {
	const out = emptyDropped();
	const missing = raw && typeof raw.missing === "object" && raw.missing !== null ? raw.missing : {};
	for (const [k, v] of Object.entries(missing)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out.missing[k] = v;
	for (const k of ["badSchema", "oversized"]) {
		const v = raw?.[k];
		if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
	}
	return out;
}

/**
 * `notice/list` 端点 handler（`(payload) => 结果对象`；契约 §12-21 形状）。
 *   `{entries, dropped:{missing,badSchema,oversized}, schemaVersion:1, degraded:false}`；
 * 降级（`noticeState` 缺失 / `sessionId` 非字符串且非 null）⇒ **200 语义等价返回 + `degraded:true` + `reason`**，
 * **绝不抛**（抛到宿主 = 500/崩树面）。
 * 每次调用**惰性**解析 `ctx.get("noticeState")`（禁 apply 期缓存服务引用）。
 */
function makeNoticeListHandler(ctxRef, loggerRef) {
	const degraded = (reason) => ({ entries: [], dropped: emptyDropped(), schemaVersion: NOTICE_SCHEMA_VERSION, degraded: true, reason });
	return (payload) => {
		let sid;
		try {
			sid = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.sessionId : undefined;
		} catch {
			sid = undefined;
		}
		if (sid !== undefined && sid !== null && typeof sid !== "string") return degraded("bad-request");
		const sessionId = sid === undefined ? null : sid;
		let state = null;
		try {
			state = ctxRef.get("noticeState"); // ← 字面量形态（可选链/属性访问会让审计与对撞脚本扫不到）
		} catch (err) {
			loggerRef?.warn?.(`${name}: noticeState 解析异常 → 端点降级返回: ${String(err?.message ?? err)}`);
			state = null;
		}
		if (!state || typeof state.list !== "function") return degraded("noticeState");
		try {
			const r = state.list(sessionId);
			// 端点必须**同步**给结果：provider 返回 thenable ⇒ 如实降级（不静默、不 await 进 wrap）
			if (r && typeof r.then === "function") return degraded("noticeState-async");
			const dropped = normalizeDropped(r?.dropped);
			if (!r || r.ok !== true) return { entries: [], dropped, schemaVersion: NOTICE_SCHEMA_VERSION, degraded: true, reason: String(r?.reason ?? "store") };
			const base = { entries: Array.isArray(r.entries) ? r.entries : [], dropped, schemaVersion: NOTICE_SCHEMA_VERSION, degraded: false };
			// ---- obs3S7 段W-2a **T2-a（件C）**：**只增字段**（设计稿 §5.2）----
			//   · **`want` 缺省 ⇒ 逐字返回旧四键**（`#A209` 三 追加要求 2：旧形状请求的返回须与装前逐字一致）；
			//   · `want` 出现 ⇒ **追加** `slots/unplaced/counters/orderHash/indexDegraded`（**形状恒在**，值可为空）；
			//   · `want.window = {from,to}`（seq 区间）只过滤 `slots`（行级视图）；`entries` 不受窗口影响。
			let want = null;
			try {
				// ⚠️ 用**独立命名的请求信封**变量（`req`），不要把端点请求对象读成"entry"：
				//   ⚠️ 键集对撞器把 `payload` 归入 entry 类变量，且**连注释一起扫** ⇒ 注释里不要写字面量
				//      "payload 紧跟点号 want" 那种形态（会被抽成"schema 未定义却被读取"）。
				const req = payload;
				want = req && typeof req === "object" && !Array.isArray(req) && req.want && typeof req.want === "object" && !Array.isArray(req.want) ? req.want : null;
			} catch { want = null; }
			if (!want) return base;
			const extra = { slots: [], unplaced: [], counters: null, orderHash: null, indexDegraded: false };
			try {
				const idx = typeof state.readIndex === "function" ? state.readIndex(sessionId) : null;
				if (idx && idx.ok === true && idx.index && typeof idx.index === "object") {
					const win = want.window && typeof want.window === "object" && !Array.isArray(want.window) ? want.window : null;
					const from = Number.isFinite(win?.from) ? win.from : null;
					const to = Number.isFinite(win?.to) ? win.to : null;
					const inWin = (s) => (from === null || (Number.isInteger(s?.seq) && s.seq >= from)) && (to === null || (Number.isInteger(s?.seq) && s.seq <= to));
					extra.slots = Array.isArray(idx.index.slots) ? idx.index.slots.filter(inWin) : [];
					extra.unplaced = Array.isArray(idx.index.unplaced) ? idx.index.unplaced : [];
					extra.counters = idx.index.counters ?? null;
					extra.orderHash = idx.index.orderHash ?? null;
					// ---- ★ T-A（2026-09-21 obs3S7；用户已签）：**读面新增「每卡 `slotId`（含 `placeState`）」** ----
					//   来源 = ② `index.cards[]`（`buildIndex` 对 `entries` **1:1 同序**产出）⇒ 按位贴回 `entries[i]`；
					//   **长度不等 ⇒ 一律不贴**（如实标 `place.aligned=false`，不猜、不错位）。语义冻结见
					//   `docs/plugins/dsh-notice-banner.md` §「`slotId` 语义冻结」（`T-D` 写死：形状／无数据形状／幂等／窗口）。
					//   ⚠️ **只增字段**：`want` 缺省的旧形状请求**不受影响**（上一步已 `return base`）⇒ 旧客户端逐字不回归（L-a）。
					const placeCards = Array.isArray(idx.index.cards) ? idx.index.cards : [];
					const placeAligned = placeCards.length === base.entries.length;
					if (placeAligned) {
						for (let pi = 0; pi < base.entries.length; pi++) {
							const pe = base.entries[pi], pc = placeCards[pi];
							if (!pe || typeof pe !== "object" || Array.isArray(pe) || !pc || typeof pc !== "object") continue;
							pe.slotId = typeof pc.slotId === "string" && pc.slotId ? pc.slotId : null;
							pe.placeState = typeof pc.placeState === "string" ? pc.placeState : null;
						}
					}
					extra.place = {
						aligned: placeAligned, cards: placeCards.length, entries: base.entries.length,
						placed: placeCards.filter((c) => c && c.placeState === "placed").length,
						session: placeCards.filter((c) => c && c.placeState === "session").length,
						unplaced: placeCards.filter((c) => c && c.placeState === "unplaced").length
					};
				} else {
					extra.indexDegraded = String(idx?.reason ?? "index-unavailable"); // ② 不可读 ⇒ **如实标降级**（不假绿）
				}
			} catch (err) {
				extra.indexDegraded = `index-failed:${String(err?.message ?? err)}`;
			}
			// obs3S7 段W-2b `(a)(b)`：`want` 增 **一个**键 ⇒ 响应追加 **`stateCards`**（**形状恒在**，值可为空，
			//   防"键消失"型断链；老客户端 / 老形状请求**不带**该键 ⇒ 返回与装前**逐字一致**）。
			//   ⚠️ 不可读 ⇒ **不静默**：`stateCards:[]` ＋ 既有 `degraded/reason` 如实降级（**不新增第二个键**）。
			if (want.stateCards === true) {
				let sc = null;
				try {
					sc = typeof state.readStateCards === "function" ? state.readStateCards(sessionId) : null;
				} catch (err2) {
					sc = { ok: false, reason: `state-cards-threw:${String(err2?.message ?? err2)}` };
				}
				if (!sc || sc.ok !== true) {
					return { ...base, ...extra, stateCards: [], degraded: true, reason: String(sc?.reason ?? "state-cards-unavailable") };
				}
				extra.stateCards = Array.isArray(sc.stateCards) ? sc.stateCards : [];
			}
			return { ...base, ...extra };
		} catch (err) {
			return degraded(`list-failed:${String(err?.message ?? err)}`);
		}
	};
}

/**
 * W7（2026-11-12）`notice/history` 端点 handler：`({sid}) => 响应对象`（键集见 `docs/协作任务/0.2.2升级/计划.md §4.2`）。
 * **永不 throw**：读归档异常 ⇒ `{ok:false, degraded:true, reason:"history-archive-unavailable:…"}`；
 * 请求形状错 ⇒ `{ok:false, degraded:false, reason:"bad-request"}`（调用方 bug 不算降级）。
 * 归档目录解析顺序：`ctx.get("noticeHistoryDir")`（宿主/配置注入，可选）> 环境变量 `DSH_NOTICE_HISTORY_DIR` > `$DSH_HOME/notice-history`。
 * **不在 apply 期读盘**（加载期 inert，`ENV §一.6③` R3）：本 handler 只在被调用时读，且有 size+mtime 缓存。
 */
function makeHistoryHandler(ctxRef, loggerRef) {
	const dirOf = () => {
		let configured = "";
		try {
			const v = ctxRef.get("noticeHistoryDir"); // ← 字面量形态（审计/对撞脚本可扫）
			if (typeof v === "string") configured = v;
		} catch {
			configured = "";
		}
		return configured;
	};
	return (payload) => {
		let sid;
		try {
			sid = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.sid : undefined;
		} catch {
			sid = undefined;
		}
		try {
			return historyFor(dirOf(), sid);
		} catch (err) {
			try {
				loggerRef?.warn?.(`${name}: notice/history 异常 → 降级返回: ${String(err?.message ?? err)}`);
			} catch {
				/* 日志不可用 ⇒ 静默 */
			}
			return {
				ok: false,
				sid: typeof sid === "string" ? sid : null,
				schemaVersion: 1,
				hasArchive: false,
				count: 0,
				groups: [],
				archive: { ready: false, dir: "", indexSha256: "", builtAt: null, totalSessions: 0, totalEvents: 0 },
				totals: { allSessions: 0, allEvents: 0, withTurn: 0, nullTurn: 0 },
				degraded: true,
				reason: `history-threw:${String(err?.message ?? err).slice(0, 160)}`
			};
		}
	};
}

/**
 * 注册 `notice/list`（惰性重试 ≤ `REGISTER_DELAYS.length` 次）。
 * 停手条件（三者任一）：① 注册成功；② 命中保留名（`reserved`，重试无意义）；③ 次数耗尽（`warn` **一次**）。
 * 定时器 `unref()` ⇒ 不吊住宿主进程；全程同步，**不产生 unhandledRejection**。
 */
function registerNoticeEndpoint(ctxRef, loggerRef, onRegistryFailure, onSeamState) {
	let attempt = 0;
	let stopped = false;
	let recheck = 0;
	/** 复检（硬化①的配套：extend-window 的尾部），封顶后彻底停下（不重试风暴） */
	const scheduleRecheck = () => {
		if (stopped) return;
		if (recheck >= REGISTER_RECHECK_MAX) {
			warnOnce(`总线端点 ${LIST_ENDPOINT} 复检 ${REGISTER_RECHECK_MAX} 次仍未注册 ⇒ 停止重试（读通道保持降级；分片 NOTE 已如实上报）`);
			return;
		}
		try {
			const timer = setTimeout(() => {
				recheck += 1;
				attempt = 0; // 复用同一条 tick 路径（它会先查 compatBus，成功则 stopped=true）
				tick();
			}, REGISTER_RECHECK_MS);
			if (timer && typeof timer.unref === "function") timer.unref();
		} catch {
			/* 定时器不可用 ⇒ 放弃复检（已上报） */
		}
	};
	const warnOnce = (message) => {
		try {
			loggerRef?.warn?.(`${name}: ${message}`);
		} catch {
			/* 日志不可用 ⇒ 静默 */
		}
	};
	const tick = () => {
		if (stopped) return;
		attempt++;
		let bus = null;
		try {
			bus = ctxRef.get("compatBus"); // ← 字面量形态 + 每次惰性解析
		} catch {
			bus = null;
		}
		if (bus && typeof bus.registerEndpoint === "function") {
			let res = null;
			try {
				res = bus.registerEndpoint(LIST_ENDPOINT, makeNoticeListHandler(ctxRef, loggerRef));
			} catch (err) {
				res = { ok: false, reason: `register-threw:${String(err?.message ?? err)}` };
			}
			// ★`#A581` ①（2026-10-13）：**best-effort** 注册"客户端面服务取用结果"回传端点（失败只 warn）
			try {
				const ss = bus.registerEndpoint(SEAM_STATE_ENDPOINT, makeSeamStateHandler(onSeamState, loggerRef));
				if (!ss || ss.ok !== true) warnOnce(`总线端点 ${SEAM_STATE_ENDPOINT} 注册失败（${String(ss?.reason ?? "unknown")}）⇒ 补滚停用无法自报（面板将不反映）`);
			} catch (err) {
				warnOnce(`总线端点 ${SEAM_STATE_ENDPOINT} 注册异常（${String(err?.message ?? err)}）⇒ 补滚停用无法自报（面板将不反映）`);
			}
			// obs3S7 段W-2a T2-a（件C）：**best-effort** 注册渲染回报端点（失败只 warn，不影响读通道）
			try {
				const rr = bus.registerEndpoint(RENDER_ENDPOINT, makeRenderReportHandler(ctxRef, loggerRef));
				if (!rr || rr.ok !== true) warnOnce(`总线端点 ${RENDER_ENDPOINT} 注册失败（${String(rr?.reason ?? "unknown")}）⇒ 渲染回报不可用`);
			} catch (err) {
				warnOnce(`总线端点 ${RENDER_ENDPOINT} 注册异常（${String(err?.message ?? err)}）⇒ 渲染回报不可用`);
			}
			// W7（2026-11-12）：**best-effort** 注册历史条幅读通道（失败只 warn，不影响 `notice/list`；
			//   失败时客户端如实降级为「归档不可用」提示 —— `ENV §一.6②` 禁「报 OK 而功能坏」）
			try {
				const hr = bus.registerEndpoint(HISTORY_ENDPOINT, makeHistoryHandler(ctxRef, loggerRef));
				if (!hr || hr.ok !== true) warnOnce(`总线端点 ${HISTORY_ENDPOINT} 注册失败（${String(hr?.reason ?? "unknown")}）⇒ 历史条幅读通道不可用`);
			} catch (err) {
				warnOnce(`总线端点 ${HISTORY_ENDPOINT} 注册异常（${String(err?.message ?? err)}）⇒ 历史条幅读通道不可用`);
			}
			if (res && res.ok === true) {
				stopped = true;
				try {
					loggerRef?.info?.(`${name}: 已注册总线端点 ${LIST_ENDPOINT}${res.replaced ? "（覆盖同名）" : ""}（第 ${attempt} 次尝试）`);
				} catch {
					/* 忽略 */
				}
				return;
			}
			if (res && res.reason === "reserved") {
				stopped = true;
				warnOnce(`总线端点 ${LIST_ENDPOINT} 命中保留名 ⇒ 放弃注册（配置错误，重试无意义）`);
				return;
			}
		}
		if (attempt >= REGISTER_DELAYS.length) {
			// 硬化①：**失败必须可见**（原先只有一次 warn，真机实测连 warn 都到不了容器日志层 ⇒ 静默）。
			// 口径（2026-09-14 裁决）：`compatBus` 缺失属**能力/服务缺失** ⇒ `state` 仍由 §3 探测决定
			// （本插件只声明 `eventTypeRegistry`，host-compat 缺席时它已把 state 拉到 DEGRADED/BLOCKED；
			//  经复核**现有键已覆盖 ⇒ 不新增 §3 键**），这里只写 `note` + 计数（`registryFailures`）。
			if (typeof onRegistryFailure === "function") {
				try { onRegistryFailure(`compatBus 不可用：${LIST_ENDPOINT} 未注册（重试 ${attempt} 次后进入复检）`); } catch { /* 上报失败不影响重试 */ }
			}
			warnOnce(`总线端点 ${LIST_ENDPOINT} 注册失败（compatBus 未提供，已重试 ${attempt} 次）⇒ 读通道降级：/host-compat 调 ${LIST_ENDPOINT} 将回 not-found`);
			// 复检：冷启动可能只是"host-compat 尚未 apply 完"（顺序无保证）⇒ 每 60s 再试，最多 5 次
			recheck = 0;
			scheduleRecheck();
			return;
		}
		const delay = REGISTER_DELAYS[attempt] ?? REGISTER_DELAYS[REGISTER_DELAYS.length - 1];
		try {
			const timer = setTimeout(tick, delay);
			if (timer && typeof timer.unref === "function") timer.unref();
		} catch {
			stopped = true;
			warnOnce(`定时器不可用 ⇒ 端点 ${LIST_ENDPOINT} 不再重试`);
		}
	};
	try {
		tick();
	} catch (err) {
		warnOnce(`端点注册异常（已忽略，不影响宿主）: ${String(err?.message ?? err)}`);
	}
}


export const apply = async (ctx) => {
	const PLUGIN_ID = name;
	const { version: PLUGIN_VERSION, blocked: pkgBlocked } = ownMeta();
	// 路径级阻断清单 (RD-20): 运行时取自自身 package.json 的 dshCompat.blocked; 读失败 ⇒ 内置回退 + 告警
	const BLOCKING = (Array.isArray(pkgBlocked) ? pkgBlocked : BLOCKED_FALLBACK).filter((k) => REQUIRES.includes(k));
	if (!Array.isArray(pkgBlocked)) ctx.logger?.warn?.(`${PLUGIN_ID}: dshCompat.blocked 读取失败 → 回退内置清单 [${BLOCKING.join(", ")}]`);

	// ================= host-compat 适配闸门 (阶段 1; 契约 §2/§3/§4/§10) =================
	// 加载强制: 动态 import + try/catch (§2.3)。§10.1 禁静态 import host-compat/共享包 —
	// 缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环(已踩)。§10.2 禁 legacy 直连兜底双路径 ⇒ 缺能力即停用 + 上报。
	let seams = null;
	let compat = null;
	try { seams = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { ctx.logger?.warn?.(`${PLUGIN_ID}: host-compat/seams 不可用 → 事件类型注册停用 (${String(err?.message ?? err)})`); }
	try { compat = await import("@ericality/dsh-host-compat"); } catch { compat = null; }

	const seamFn = (key) => (typeof seams?.[SEAM_OF[key]] === "function" ? seams[SEAM_OF[key]] : null);
	// 能力探测: 优先 host-compat `probe()` (§4.9); 不可用 ⇒ 本地按 §3 语义兜底 (只查本插件声明过的 key)
	const localMissing = () => REQUIRES.filter((k) => typeof seamFn(k) !== "function");
	const prober = typeof compat?.probe === "function" ? compat : (typeof seams?.probe === "function" ? seams : null);
	let capMissing = localMissing();
	let capBlockedProbe = null; // RD-20 ④: 三态判定权在 probe (单一权威)
	let capStateProbe = null;
	// ★ **`#A77` 裁定 (c1)**：`probe()` 的**第三态**读数 —— 「**未取证**」（探测前置解析失败 ⇒ 未能判定是否在位）。
	//   面板口径（硬）：未取证 ⇒ **`DEGRADED` ＋ note 含「未取证」**，**不得**渲染成 `BLOCKED`、**不得**说成"缺少"。
	let capUnprobed = [];
	let capProbeNotes = "";
	if (prober) {
		try {
			const r = prober.probe(REQUIRES, PLUGIN_ID, PLUGIN_VERSION, ctx, BLOCKING); // RD-20: 第 5 参 = 路径级阻断清单
			if (Array.isArray(r?.blocked)) capBlockedProbe = r.blocked.filter((k) => REQUIRES.includes(k));
			if (typeof r?.state === "string") capStateProbe = r.state;
			if (Array.isArray(r?.missing)) capMissing = r.missing.filter((k) => REQUIRES.includes(k)); // 只认本插件声明过的 key (RD-1)
			if (Array.isArray(r?.unprobed)) capUnprobed = r.unprobed.filter((k) => REQUIRES.includes(k)); // ★ 三态（additive）
			if (typeof r?.notes === "string") capProbeNotes = r.notes;                                    // ★ 如实文案（含「未取证」）
		} catch (err) {
			capMissing = localMissing();
			ctx.logger?.warn?.(`${PLUGIN_ID}: probe() 失败 → 退回本地探测 (${String(err?.message ?? err)})`);
		}
	}
	// RD-20 ④: probe 可用 ⇒ 逐字采信其 state/blocked; 不可用 ⇒ 本地按同一清单兜底 (口径一致)
	const capBlocked = capBlockedProbe ?? capMissing.filter((k) => BLOCKING.includes(k));
	const capState = capStateProbe ?? (capBlocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK"));
	// ★ **`#A77` (c1) 面板文案分流**：
	//   · **真缺**（`capMissing` 命中本插件声明的 key）⇒ 保留原「类型未注册 ⇒ 必须停写」后果句（**逐字未改**）；
	//   · **未取证**（`capUnprobed` 非空）⇒ **不得**说成"缺少"、**不得**渲染"必须停写" ⇒ 只如实写「**未取证**」
	//     ＋ **原样带上 probe 的 notes**（面板/分片可 grep 到根因）。
	const capMissingDeclared = capMissing.filter((k) => REQUIRES.includes(k));
	const capNote = capState === "OK" ? ""
		: (capUnprobed.length && capMissingDeclared.length === 0)
			? `能力未取证（探测前置解析失败，未能判定是否在位）: ${capUnprobed.join(", ")}${capProbeNotes ? ` ｜ ${capProbeNotes}` : ""}`
			: `notice/banner 类型未注册 ⇒ 注入该事件类型的插件(cost-ledger/notify/taskqueue)必须停写, 否则会话日志无法加载${capProbeNotes ? ` ｜ ${capProbeNotes}` : ""}`;
	const finalNote = capBlocked.length ? `${capNote}${capNote ? " ｜ " : ""}路径级阻断(仅停该能力对应路径): ${capBlocked.join(", ")}` : capNote; // 阻断清单并入面板文案 (路径级 BLOCKED)

	// ================= 自有 store 能力判据 (P1-1; ENV 红线 6/7: 未适配即降级 + 禁止"报 OK 而功能坏") =================
	// 零写探测 (只 access(W_OK), 不创建目录/文件 ⇒ apply 期仍零 IO)。
	let storeAvail = { ok: false, reason: "unknown", root: storeRoot() };
	try {
		storeAvail = await storeStatus();
	} catch (err) {
		// ★T2 接线：store 状态探测抛错 ⇒ 自有 store 不可用 ⇒ 横幅读通道整体降级（不半开）。
		//   注：下方 `if (state !== "OK") ctx.logger?.warn?.(...)` 受 `capState` 门控 ⇒
		//   `capState === "OK"` 且 store 挂掉时**原本零日志、零上屏**（真静默点）。
		reportErr({ code: "store-status-failed", detail: "cap=store", severity: "state" });
		storeAvail = { ok: false, reason: `store-status:${String(err?.message ?? err)}`, root: storeRoot() };
	}
	const storeOk = storeAvail?.ok === true;
	const storeNote = storeOk ? "" : `自有 store 不可用 (${storeAvail?.reason ?? "unknown"} @ ${storeAvail?.root ?? "?"}) ⇒ 横幅读通道整体降级 (不半开)`;
	// P1-2 报告口径改判（**用户 2026-09-14 裁决 / §10.13 RD-47 + §12-21 ③**）：
	//   · **能力/服务缺失**（`noticeState`/`compatBus`/`eventTypeRegistry` 等 §3 键不满足）⇒ 经 §3 能力键反映 `state`；
	//     本插件只声明 `eventTypeRegistry`，而它与 `noticeState`/`compatBus` **同源于 host-compat**
	//     ⇒ host-compat 缺失时 `state` 已被拉到 DEGRADED/BLOCKED ⇒ **不新增键**（只写 `note`）。
	//   · **运行期故障**（磁盘不可写 / 原子写失败 / 坏文件重建 / 缺 banner-kit 共享库）⇒ **只写 `note` + 计数**，
	//     `state` 仍由 §3 探测决定（RD-47）；`dropped` 计数经 RPC 暴露给面板。
	//   ⚠️ 改前实现是"store 不可用 ⇒ DEGRADED"，按裁决改判为口径内的 note（RPC 里 `degraded:true|reason` 保持不变）。
	const state = capState;
	const finalNote2 = [finalNote, storeNote].filter(Boolean).join(" ｜ ");
	if (state !== "OK") ctx.logger?.warn?.(`${PLUGIN_ID}: 适配状态 ${state} — 缺能力 [${capMissing.join(", ")}] 阻断 [${capBlocked.join(", ")}]; ${finalNote2}`);

	// §4.10 report: host-compat 可用 → 走 report(); 不可用 → 自己写分片 (禁止静默, §2.3)
	const shardEntry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state, missing: capMissing, blocked: capBlocked, note: finalNote2 }; // §5.1 分片 8 键
		// ---- ★`#A581` ①（2026-10-13）：**客户端面服务** `hostScroll` 取用结果 ⇒ **自有分片**（state/note 如实）----
	//   来源 = 本插件 client 半经**既有** `/host-compat` 路由的**自有**端点 `notice/seam-state` 回传（`§一.7①` 合规）。
	//   缺失 ⇒ `state:"DEGRADED"` ＋ `note` 点名"补滚停用"；恢复 ⇒ 回到 §3 探测出的 `state`（**不留假红**）。
	let seamMissing = false;
	const reportSeamState = (isMissing, reason, levels) => {
		seamMissing = isMissing === true;
		const lv = levels || null;
		const seamNote = seamMissing
			? `补滚停用：hostScroll **服务=${String((lv && lv.service) || "?")}／宿主面=${String((lv && lv.host) || "?")}**（${reason || "unknown"}）⇒ 卡片照常渲染, 仅丢补滚`
			: "";
		const entry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state: seamMissing ? "DEGRADED" : state, missing: capMissing, blocked: capBlocked, note: [finalNote2, seamNote].filter(Boolean).join(" ｜ ") };
		try { if (reporter) reporter.report(entry); else writeShard(ctx, entry); } catch (err) {
			ctx.logger?.warn?.(`${PLUGIN_ID}: 补滚降级分片上报失败 (仅内存态): ${String(err?.message ?? err)}`);
		}
	};
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	if (reporter) { try { reporter.report(shardEntry); } catch { writeShard(ctx, shardEntry); } } else writeShard(ctx, shardEntry);

	// ---- 数据归属方: `ctx.provide("noticeState", {list, append})` (写法照 dsh-notify 的 notifyHub) ----
	// 注: 只 provide **服务**, 不缓存引用 (消费方一律 `ctx.get("noticeState")` 惰性解析)。
	try {
		ctx.provide?.("noticeState", {
			list: (sessionId) => listEntriesSync(sessionId), // 同步（读通道 handler 同步返回）
			append: (raw) => appendEntry(raw),               // 异步（生产者 await；P1-2 接线）
			deleteCard: (p) => deleteCard(p),                // A114：按 cardId 删除（oplog 记 DELETE＋snapshot）
			// ★ **段2 `B6`（2026-09-29，"不得静默"整改；`#A394`）** —— 两个**加成**面（既有键语义零改动）：
			//   · `validate`       = **同步**形状校验（`banner-kit.validateEntry` **原物**；未加载 ⇒ `null`＝未知，不伪造）
			//     ⇒ 供**中间件直调路径**（`host-compat/seams.js` 的 `appendNotice` 是**同步**签名）就地判形状，
			//       不再"绕过 banner-kit 一路走到 store 才被拒"（同库两条写入纪律 → 收起为一条）。
			//   · `reportRejected` = **同步**登记一条 `rejected`（① 落原因码 ＋ 面板 `rejectedByReason` 可见 ＋ 点名 `owner`）
			//     ⇒ 供 `banner-kit.emit` **在进 store 之前**就退回生产者那档（路径 A）**不再静默**。
			validate: (raw) => validateEntrySync(raw),
			reportRejected: (rec) => reportRejected(rec),
			readIndex: (sessionId) => readIndex(sessionId),  // 同步（T2-a 件C：`want` 时读 ②）
			// obs3S7 段W-2b `(a)(b)`：**状态卡 + 观测七项**（同步；读通道 handler 要求同步返回）。
			//   ⚠️ 只读**写盘面**（② counters ＋ ① rejected/RENDER）⇒ 与面板读数同源（判据 5）。
			readStateCards: (sessionId) => readStateCards(sessionId),
			recordRender: (p) => recordRender(p),            // 同步（T2-a 件C：渲染回报 ⇒ 只写 ① 的 RENDER）
			/**
			 * **可选**「会话喂入」（2a-2 T1a-2；注入点 = 中间件 `#A203` 一，设计稿 §12.8 裁定 (A)）：
			 *   中间件把**既有的** `session`（＋**增量** `event`）转发进来 ⇒ 本侧 **O(1) 白名单早退 + 内存累积**，
			 *   落盘只发生在 `turn/end`（`flushSlots`）⇒ **每回合 ≤1 次写盘**（不把成本推回 O(n) IO）。
			 *   **绝不 throw**；非白名单事件直接早退（`observeRow` 返回 `accepted:false`）。
			 */
			// ★ A84：**可选方法** `backfillState(sessionId)` —— 中间件在**首次喂入**前查断点（存在性检查；缺失即退回全量回填）
			//   返回 `{observedSeq, rows, cards}`：`observedSeq>0` ⇒ 只喂尾部；`observedSeq===0 && cards===0` ⇒ 无卡可落位、可如实跳过。
			backfillState: (sessionId) => {
				try { return backfillState(sessionId); } catch { return { ok: false }; }
			},
			// ★ T5：**可选方法** `flushRows(session)` —— 中间件在**冷启动回填**后调用一次（存在性检查；缺失即 no-op）
			flushRows: (session) => {
				try {
					const sid = session && session.id !== undefined ? session.id : null;
					if (sid === null) return;
					const p = flushSlots(sid);
					if (p && typeof p.catch === "function") p.catch(() => { /* store 内已把失败转成 {ok:false}；此处只防 unhandledRejection */ });
				} catch { /* 喂入路径**绝不 throw** */ }
			},
			observeSession: (session, event) => {
				try {
					const sid = session && session.id !== undefined ? session.id : null;
					if (sid === null) return;
					if (event && typeof event.type === "string") observeRow(sid, event);
					if (event?.type === "turn/end") {
						const p = flushSlots(sid);
						if (p && typeof p.catch === "function") p.catch(() => { /* store 内已把失败转成 {ok:false}；此处只防 unhandledRejection */ });
					}
				} catch { /* 喂入路径**绝不 throw**（禁影响中间件/宿主） */ }
			}
		});
	} catch (err) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: noticeState 服务注册失败 → 读通道降级 (${String(err?.message ?? err)})`);
	}

	// ---- 经 compatBus **注册**端点 `notice/list` (通用端点注册; host-compat 不认识本插件) ----
	// 硬化①：注册失败 ⇒ **分片 NOTE 可见**（含失败原因 + 计数），`state` 仍由 §3 探测决定（不新增键）。
	let registryFailures = 0;
	const reportRegistryFailure = (why) => {
		registryFailures += 1;
		const note = [finalNote2, `读通道降级: ${why} (第 ${registryFailures} 次上报)`].filter(Boolean).join(" ｜ ");
		const entry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state, missing: capMissing, blocked: capBlocked, note };
		try {
			if (reporter) reporter.report(entry);
			else writeShard(ctx, entry);
		} catch (err) {
			ctx.logger?.warn?.(`${PLUGIN_ID}: 读通道降级分片上报失败: ${String(err?.message ?? err)}`);
		}
	};
	try {
		registerNoticeEndpoint(ctx, ctx?.logger ?? null, reportRegistryFailure, reportSeamState);
	} catch (err) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: 端点注册异常 (已忽略): ${String(err?.message ?? err)}`);
	}

	// ---- §4.5 ensureEventTypes: 注册 notice/banner(-replace) ----
	if (capMissing.includes("eventTypeRegistry") || capBlocked.includes("eventTypeRegistry")) { // 阻断 key 同样按"路径停用"处理 (RD-20)
		ctx.logger?.warn?.(`${PLUGIN_ID}: 事件类型注册已停用 — 缺能力 eventTypeRegistry (契约 §10.2: 不降级为直连宿主; 注入方须一并停写)`);
		return;
	}
	const r = seamFn("eventTypeRegistry")(EVENT_TYPES);
	if (r?.ok) ctx.logger?.info?.(`${PLUGIN_ID}: 事件类型已注册 [${(Array.isArray(r.registered) ? r.registered : EVENT_TYPES).join(", ")}]`);
	else ctx.logger?.warn?.(`${PLUGIN_ID}: 事件类型注册失败 — ${r?.reason ?? "unknown"} (注入方须停写, 否则会话日志可能无法加载)`);
};
