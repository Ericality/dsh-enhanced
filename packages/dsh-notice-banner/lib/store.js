/**
 * dsh-notice-banner · 自有数据面 store（**host 半**，2026-09-14 阶段 7 · P1-1）
 *
 * 依据：契约 §12-21（台账行 `12-21`）
 *     + `docs/待办/2026-09-14-P1-设计稿-横幅公共设施化.md` **§2（schema 键集）+ §3（store 设计）**
 *
 * 定位（ENV 红线 7 ③ / doctrine R1）：**横幅数据的归属方与唯一写者**。
 *   · 落点 = `${DSH_NOTICE_DIR || DSH_HOME || "$DSH_HOME"}/notice-state/`（**自有面**）；
 *   · 分片 = `<safeSessionId>.json` + `_global.json`（`sessionId` 为 null/undefined/"" ⇒ 全局）；
 *   · 单写者：**本文件是唯一写者**（渲染方只读；host-compat **不持有**业务数据）。
 *
 * 纪律（逐条对应验收判据）：
 *   ① **apply 期零 IO / 零写**：目录与文件**懒创建**（首次真正 append 才 `mkdir`）；
 *      读失败 / 不存在 ⇒ **空结果**（绝不 throw、绝不影响宿主）；
 *   ② **原子写**：`writeFileSync(tmp, {mode:0o600})` + `renameSync`（同目录 rename 原子）；
 *      失败 ⇒ `{ok:false, reason}`（**永不 throw**）；
 *   ③ **每条读出的 entry 过 `validateEntry`**：坏条**丢弃 + 计数**（per-emitter 隔离，
 *      坏条不得影响其它条；`missing` 计数按缺失键名分桶，必须能在面板看到）；
 *   ④ **R6**：文件坏（JSON 解析失败 / 非数组）/ `schemaVersion` 不符 ⇒ 重命名 `.bad-<ts>`
 *      留痕 + 重建（绝不抛、绝不写宿主面）；
 *   ⑤ **清理**：单会话 **2000 条**兜底（按 `at` 淘汰最旧）；`ttlMs` **只影响可见性**（不删档，
 *      判定在 `banner-kit.isVisible`）；会话删除 ⇒ `removeShard(sessionId)`（**本批不接删除钩子**）；
 *   ⑥ **依赖 banner-kit 只走动态 `await import("@ericality/dsh-banner-kit")` + try/catch + 成功后缓存**
 *      （契约 §10.1 禁静态 import 共享包；缺包 ⇒ **store 整体禁用**，**不是半开**）。
 *
 * 形态纪律：本文件**不碰宿主**（无 `ctx` / 无 `session` / 无网络）；只有 `node:fs` 自有面 IO。
 */

import { accessSync, appendFileSync, chmodSync, closeSync, constants as FS, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** schema 版本（契约 §12-21 冻结 = 1）。**必须**与 `banner-kit.SCHEMA_VERSION` 相等
 *  （由 `selftest.mjs` 的键集对撞断言；此处为"banner-kit 缺席时降级返回"仍需该字面量而保留）。 */
export const NOTICE_SCHEMA_VERSION = 1;

/** 单会话兜底上限（设计稿 §3 清理规则④：超出按 `at` 淘汰最旧；≈ 数百字节/条 ⇒ ≤1MB/会话） */
const MAX_ENTRIES = 2000;
/** 全局分片的文件名（`sessionId` 为 null/undefined/"" ⇒ 全局） */
const GLOBAL_FILE = "_global";

/** ★★ `T-E′` 误报修正（2026-09-21 obs3S7 `#A61` ⑤；**批 1 部署前必修**）：**已如实申报的"结构性无行"族**
 *   —— 这些族的卡**天生不属于任何行**（族级申报见 `scripts/banner-payload-key-collision.mjs` 的
 *   `B6_FAMILY_DECLARED` ＋ `B6_FAMILY_CLASS`，`rowless-structural` 类）⇒ **一律不计入异常**
 *   （否则健康会话被点亮 = 误报、直接打扰用户，违反「有异常才显示」与「健康会话 ⇒ 信号 == 0」）。
 *   **可见性**：其条数走**非异常读数** `rowlessDeclared`（**不做屏上分列** —— 那是可见性决定，须用户点头）。
 *   ⚠️ **两处必须逐字一致**（判据：`te2-anomaly-gate` 的对撞项 ⇒ 缺一即红）：
 *      运行时本集合 ↔ 开发侧 `B6_FAMILY_CLASS` 中 `rowless-structural` 的族集合。
 *   ★★ **`#A193` 件④（2026-09-23 obs3S7；用户令「有问题就修问题，不要藏起来」）**：
 *      **撤出 `dsh-graceful-restart|restart`** —— 该族**已获得行身份**（命令面 `invocation.commandId`；工具面按 `exec.callId`
 *      取该次 `tool/call` 的 `seq`；相位/取消/`invalid` 自愈**沿用同一身份**）⇒ **不再属于"结构性无行"**。
 *      ⇒ 其无身份实例**如实计入 `rowless-unknown`（异常面点名）**，**不再被族级豁免静默放行**
 *      （旧写法 ＝「用一个集合把『拿不到能力』变成『合法状态』」＝ **静默放行**反模式，见 `docs/插件开发准入清单.md`）。
 *      **同时补齐 `dsh-host-compat|compat`**（开发侧久已申报 `rowless-structural`、运行时集合此前落后 ⇒ 对撞项 `H⑧` 恒红，
 *      且 compat 的**设计性**无行被误计入异常面）⇒ 运行时集合与开发侧**逐字一致**。 */
/** ★A94（用户现场）：**卡范围是唯一判据**，族名豁免两机制（`DECLARED_ROWLESS_FAMILIES`／
 *  `DECLARED_ROWLESS_PREDICATES`）**整套退役**。`anchorLevel ∈ {row,session,global}`：
 *   · `row`（**含未声明**）⇒ 取不到行身份就计 `rowless-unknown`（真异常）；
 *   · `session` ⇒ 会话级状态，不计异常，计入 `levelSession`；
 *   · `global` ⇒ 跨会话状态，不计异常，计入 `levelGlobal`；
 *   · 未声明 ⇒ 另计 `levelUndeclared`（可见），但**照常按 row 判定**（无行 ⇒ 报警）。
 *  不再按 `owner|kind` 名字放行（含 `#A193` 之后的 `graceful-restart|restart` 正确判断不动）。 */
export const ANCHOR_LEVELS = Object.freeze(["row", "session", "global"]);
const ANCHOR_LEVEL_SET = new Set(ANCHOR_LEVELS);
function anchorLevelOf(e) {
	return typeof e?.anchorLevel === "string" && ANCHOR_LEVEL_SET.has(e.anchorLevel) ? e.anchorLevel : null;
}

/* ★**批4 段A（2026-09-26 `#A313`）历史存量封闭清单**：`data/legacy-anomalies.json`
 *   （判据可用 `DSH_NOTICE_LEGACY_LIST` 指向夹具）。**只读、纯函数、可缓存**；
 *   清单不可读 ⇒ **零存量**（不崩、**不静默放行任何卡** ⇒ 未列出的卡一律照常告警）。 */
let legacyCache = null;
function legacyList() {
	if (legacyCache !== null) return legacyCache;
	legacyCache = { bySid: new Map(), total: 0 };
	try {
		const p = process.env.DSH_NOTICE_LEGACY_LIST || new URL("../data/legacy-anomalies.json", import.meta.url).pathname;
		const j = JSON.parse(readFileSync(p, "utf8"));
		for (const e of (Array.isArray(j && j.entries) ? j.entries : [])) {
			if (!e || typeof e.sid !== "string") continue;
			if (!legacyCache.bySid.has(e.sid)) legacyCache.bySid.set(e.sid, { cards: new Set(), quota: new Map() });
			const b = legacyCache.bySid.get(e.sid);
			if (e.cls === "rowless-unknown") b.cards.add(`${e.owner || "?"}|${e.kind || "?"}|${e.at}`);
			else if (e.cls === "no-anchor") { const k = String(e.owner || "?"); b.quota.set(k, (b.quota.get(k) || 0) + 1); }
			legacyCache.total += 1;
		}
	} catch { /* 见上：零存量 */ }
	return legacyCache;
}
/** 本会话的历史存量视图：`hasCard()` 走**逐张复合键**；`consumeUnplaced()` 走**同 owner 配额的索引序** */
function legacyFor(sid) {
	const b = legacyList().bySid.get(String(sid));
	const cards = b ? b.cards : new Set();
	const quota = new Map(b ? b.quota : []);
	return {
		hasCard: (c) => !!c && cards.has(`${c.owner || "?"}|${c.kind || "?"}|${c.at}`),
		consumeUnplaced: (owner) => { const n = quota.get(owner) || 0; if (n > 0) { quota.set(owner, n - 1); return true; } return false; }
	};
}

/** ★ **`T-G`（2026-09-21 obs3S7 批 2 件①；`#A71` 裁决一/四）**：**写入入口校验的"显式无行"成员**
 *  —— 由 `kind` 承载（`计划.md` `#A53` 四「走零新键」：`banner-kit normalizeEmitPayload()` 在
 *  `emit()` 路径**恒补齐** `turn`/`ctxKey`/`anchorSeq` ⇒ "显式 null"与"键缺席"**在实现上不可区分**
 *  ⇒ 不能由"显式 null"独立承载 ⇒ **唯一成员 = `compat`**，B 自产状态卡不经 POST 入口、不在判据内）。 */
const GATE_ROWLES_KINDS = new Set(["compat"]);

/** 位置键 4（`计划 §4【裁决 #8】`／设计件 §⑭B 允许集合）—— 判"卡有没有可声明的行身份"用的键集。 */
const GATE_POS_KEYS = ["anchorSeq", "ctxKey", "turn", "commandId"];

/** `ctxKey` 内嵌真实锚点 seq 的唯一形态（`buildIndex()` 的 `ctxKey` 臂与入口校验**共用同一常量**）。 */
// ★ A89（`#A88` 批步3）：前缀扩到 restart/queue/error/compat —— 这些族同样把**锚点 seq**嵌在 ctxKey 里
//   （`restart-<seq>` / `queue-<n>-<ts>-<i>` 的 `<n>` 不是 seq ⇒ 只有真正 `<prefix>-<seq>` 形态才命中），
//   扩后这些卡由 `poskey-defer` 变 `poskey`；不合法/seq 不存在的仍 `poskey-defer`（负控）。
const GATE_CTX_RX = /^(?:cost|ledger|restart|queue|error|compat)-(\d{4,})$/;

/* ------------------------------------------------------------------ 写入入口校验（`T-G` 件①） */

/**
 * **`T-G` 入口校验 —— 纯函数判定（`#A71` 裁决一：分两类）**。
 *
 *   · **(i) 形状/取值不合法 ⇒ 拒**（`rejected`）：`turn` 非正整数／`anchorSeq` 非整数／
 *     `commandId` 非非空字符串／`ctxKey` 非合法正则形态／**位置键 4 全缺且该族未申报**；
 *     例外（**必须拒**）：**显式 `anchorSeq` 指向不存在的行**（设计件 §⑮ 正控）。
 *   · **(ii) 形状合法但"行此刻尚未存在" ⇒ 放行 ＋ 如实未定位 ＋ 计数（不拒）** ——
 *     依据 `N67`：卡写入**早于其自身命令行事件 ≈102ms**（既定事实）⇒ 若要求"写入时即解析到真实行"，
 *     **命令类卡几乎全被拒 ＝ 灾难性误拒**。⇒ 只要**有合法形状的位置键被声明**即属允许集合。
 *   · **放行分支**：①（`#A68`③-A）位置键 4 任一合法声明 ∧ **能解析到真实行**；②（-B）`kind ∈ {compat}`；
 *     ③（-C）★A94 起改为：条目声明 `anchorLevel:"session"|"global"`（族名豁免已退役）。
 *
 * ⚠️ **本函数是判定唯一实现**（`commit` 的 `buildIndex()` 与判据夹具共用同序解析臂，禁止两处各写一份）。
 * @param {object} raw 原始 entry（**未归一化也适用**：本函数只按形状判，不做类型归一）
 * @param {{bySeq:Map,byTurn:Map,byCmd:Map}} res 行解析表（`rowResolvers(rows)`）
 * @returns {{reject:false, via:"poskey"|"poskey-defer"|"compat"|"family"|"anchor", declared:string[]}
 *          |{reject:true, code:string, declared:string[]}}
 */
export function gateVerdict(raw, res) {
	const e = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const ok0 = (v) => v === undefined || v === null;   // 缺省/显式 null ⇒ **不算声明**（合法）
	// ---- ① 形状（`#A71` 裁决一 (i)：不合法一律拒、优先级最高） ----
	if (!ok0(e.turn) && !(Number.isInteger(e.turn) && e.turn > 0)) return { reject: true, code: "gate-shape-turn", declared: [] };
	if (!ok0(e.anchorSeq) && !Number.isInteger(e.anchorSeq)) return { reject: true, code: "gate-shape-anchorSeq", declared: [] };
	if (!ok0(e.commandId) && !(typeof e.commandId === "string" && e.commandId)) return { reject: true, code: "gate-shape-commandId", declared: [] };
	if (!ok0(e.ctxKey) && !(typeof e.ctxKey === "string" && e.ctxKey)) return { reject: true, code: "gate-shape-ctxKey", declared: [] };
	// ---- ② 位置键是否"被声明"（合法形状的声明集合） ----
	const declared = [];
	if (Number.isInteger(e.anchorSeq)) declared.push("anchorSeq");
	if (typeof e.ctxKey === "string" && e.ctxKey) declared.push("ctxKey");
	if (Number.isInteger(e.turn) && e.turn > 0) declared.push("turn");
	if (typeof e.commandId === "string" && e.commandId) declared.push("commandId");
	// ---- ③ 显式 `anchorSeq`：**必须解析到真实行**（否则拒 —— 设计件 §⑮ 正控；不适用 (ii)） ----
	if (Number.isInteger(e.anchorSeq)) {
		if (res && res.bySeq instanceof Map && res.bySeq.has(e.anchorSeq)) return { reject: false, via: "anchor", declared };
		return { reject: true, code: "gate-anchor-mismatch", declared };
	}
	// ---- ④ (ii) 形状合法但行可能尚未存在 ⇒ **放行、如实未定位**（不拒） ----
	if (declared.length > 0) {
		const hit = res && res.byCmd instanceof Map && typeof e.commandId === "string" && e.commandId && res.byCmd.has(e.commandId);
		const m = typeof e.ctxKey === "string" ? GATE_CTX_RX.exec(e.ctxKey) : null;
		const byCtx = !!(m && res && res.bySeq instanceof Map && res.bySeq.has(Number(m[1])));
		const byTurn = !!(Number.isInteger(e.turn) && e.turn > 0 && res && res.byTurn instanceof Map && res.byTurn.has(e.turn));
		return { reject: false, via: (hit || byCtx || byTurn) ? "poskey" : "poskey-defer", declared };
	}
	// ---- ⑤ 无位置键声明：显式无行成员 / 结构性无行族 / 否则拒 ----
	if (GATE_ROWLES_KINDS.has(String(e.kind))) return { reject: false, via: "compat", declared };
	// ★A94：非行级范围（session/global）允许无位置键；未声明/row ⇒ 仍须有位置键
	const al = anchorLevelOf(e);
	if (al === "session" || al === "global") return { reject: false, via: "anchorLevel", declared };
	return { reject: true, code: "gate-no-position-key", declared };
}

/** 由行事实面构建**解析表**（`bySeq` / `byTurn` / `byCmd`）—— `buildIndex()` 与 `gateVerdict()` **共用**。 */
export function rowResolvers(rows) {
	const list = Array.isArray(rows) ? rows : [];
	const bySeq = new Map(); const byTurn = new Map(); const byCmd = new Map();
	for (const r of list) {
		if (typeof r?.slotId !== "string" || !r.slotId) continue;
		if (Number.isInteger(r.seq)) bySeq.set(r.seq, r.slotId);
		if (r.defKind === "command" && typeof r.id === "string" && r.id) byCmd.set(r.id, r.slotId);
		if (Number.isInteger(r.turn)) {
			const cur = byTurn.get(r.turn);
			const isTail = slotKindOf(r.slotId) === "turn-tail";
			if (cur === undefined || (isTail && slotKindOf(cur) !== "turn-tail")) byTurn.set(r.turn, r.slotId);
		}
	}
	return { bySeq, byTurn, byCmd };
}

/* ------------------------------------------------------------------ banner-kit 动态加载 */

let kitMod;          // undefined = 尚未尝试；null = 已判定不可用
let kitDead = false; // true = 已判定不可用（不再重试；解析不到 ⇒ **store 整体禁用**）

/**
 * 动态加载 `@ericality/dsh-banner-kit`（纯库面：schema 常量 + 纯函数）。
 * 规范字面量必须**内联写在 `import(...)` 里**（自测脚本按此重写 specifier）。
 * 失败 ⇒ 缓存 `null` 并返回 null（调用方据此把 store 整体判为不可用）。永不 throw。
 */
async function loadKit() {
	if (kitMod !== undefined) return kitMod;
	if (kitDead) return null;
	try {
		kitMod = await import("@ericality/dsh-banner-kit");
	} catch {
		kitDead = true;
		kitMod = null;
	}
	return kitMod;
}

/* ------------------------------------------------------------------ 路径 / 文件名 */

/** store 根：`${DSH_NOTICE_DIR || DSH_HOME || "$DSH_HOME"}/notice-state`（设计稿 §3；env 覆盖**仅测试用**） */
export function storeRoot() {
	return process.env.DSH_NOTICE_DIR || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "plugin-data", "notice-banner", "notice-state");
}

/** sessionId → 安全文件名（口径与 host-compat `safeId` 一致：白名单字符集 + 长度上限，防路径穿越） */
function safeSessionId(sessionId) {
	if (sessionId === null || sessionId === undefined || sessionId === "") return GLOBAL_FILE;
	return String(sessionId).replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 120) || "unknown";
}

/** 分片文件绝对路径 */
function shardFile(sessionId) {
	return join(storeRoot(), `${safeSessionId(sessionId)}.json`);
}

/* ------------------------------------------------------------------ 计数与判据（全部纯函数级） */

/** 空丢弃计数（形状 = 契约 §12-21 端点返回的 `dropped`） */
function emptyDropped() {
	return { missing: {}, badSchema: 0, oversized: 0 };
}

/** 归桶：缺键按**键名**分桶（面板要能显示"丢弃 N 条（缺键 text）"）；其余一律计入 `badSchema` */
function countDrop(dropped, reason, key) {
	if (reason === "missing-key" && typeof key === "string" && key) dropped.missing[key] = (dropped.missing[key] ?? 0) + 1;
	else dropped.badSchema += 1;
}

/** `dropped` 归一化（端点返回形状固定三键，绝不因上游形状漂移而变） */
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

/* ------------------------------------------------------------------ 读（含 R6 重建） */

/**
 * 读一个分片。**永不 throw**。
 * @returns `{ entries, dropped, rebuilt }` —— 不存在/读失败 ⇒ 空结果；坏文件 ⇒ `.bad-<ts>` 留痕 + 重建。
 */
function readShard(kit, sessionId) {
	const dropped = emptyDropped();
	const file = shardFile(sessionId);
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { entries: [], dropped, rebuilt: false }; // 不存在 / 读失败 ⇒ 空结果（绝不 throw）
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const usable = kit.isShardReusable(parsed);
	if (!usable.ok) {
		// R6：坏文件 / schemaVersion 不符 ⇒ **重命名 `.bad-<ts>` 留痕 + 重建**（绝不删档、绝不抛）
		let renamed = false;
		try {
			renameSync(file, `${file}.bad-${Date.now()}`);
			renamed = true;
		} catch {
			/* 留痕失败不阻断重建（例如只读文件系统） */
		}
		dropped.badSchema += Array.isArray(parsed) ? Math.max(parsed.length, 1) : 1;
		return { entries: [], dropped, rebuilt: true, reason: usable.reason, renamed };
	}
	const entries = [];
	for (const raw of parsed) {
		const r = kit.validateEntry(raw);
		if (r.ok) {
			entries.push(r.entry);
			if (r.truncated) dropped.oversized += 1; // 截断的条目**保留**（只计数）
		} else {
			countDrop(dropped, r.reason, r.key); // 坏条丢弃 + 计数（per-emitter 隔离）
		}
	}
	return { entries, dropped, rebuilt: false };
}

/* ------------------------------------------------------------------ 写（原子 + 0600） */

/** 原子写分片：tmp → rename；`mode 0o600`；目录**懒创建**（首次真正写才 mkdir）。永不 throw。 */
function writeShardFile(file, entries) {
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {
			/* 某些文件系统不支持 chmod → 忽略（mode 已在 writeFileSync 生效） */
		}
		renameSync(tmp, file);
		try {
			chmodSync(file, 0o600);
		} catch {
			/* 同上 */
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `io-error:${String(err?.message ?? err)}` };
	}
}

/* ================================================================== ①② 权威流（obs3S7 段W-2a 件B）
 *
 * 依据：计划 v5 §2.1–§2.6 / §3 / §4.1 / §7① / §11 + 仲裁 `#A201` 一（件B）与 `#A199` 一（A1 走 (I)）。
 * 三条纪律（**先①后② · ①只增 · ②可由①重放**）：
 *   ① `oplog/<safeSessionId>.jsonl` = **权威流**（一行一记录，含**完整内容快照**与**结果**）；
 *   ② `index/<safeSessionId>.json`  = **影子索引**（卡片→归属/未定位 + 计数）⇒ 可由 ① 重放得到；
 *   ⇒ 顺序恒为 **写① → 写分片 → 写②**；**① 失败 ⇔ 整体失败且分片不写**；① 的更正一律**追加**（绝不改写旧行）。
 * ⚠️ 2a-1 明确**不做**（`#A201` 一「明确不做」）：端点只增字段 / client 渲染 / replay 与迁移工具 / 版本升级。
 * ================================================================================== */

/** ① 的格式版本（与卡片 `schemaVersion` **分离**：① 的演进不得再逼卡片迁移） */
export const OPLOG_VERSION = 1;
/** ② 的格式版本 */
export const INDEX_VERSION = 2;

function oplogFile(sessionId) {
	return join(storeRoot(), "oplog", `${safeSessionId(sessionId)}.jsonl`);
}
function indexFile(sessionId) {
	return join(storeRoot(), "index", `${safeSessionId(sessionId)}.json`);
}

/** ① 的 `seq` 缓存（模块级可变状态之一；**失效条件 = `size ∨ mtimeMs ∨ 尾部哈希`** —— 设计稿 §12.6） */
const oplogSeqCache = new Map(); // file -> {size, mtimeMs, lastSeq, tailSha}

/** 读文件尾部 `n` 字节（用于取末行 `seq`；**不整份读**） */
function readTail(file, n = 4096) {
	let fd = null;
	try {
		fd = openSync(file, "r");
		const size = statSync(file).size;
		const len = Math.min(n, size);
		if (len <= 0) return { text: "", size };
		const buf = Buffer.allocUnsafe(len);
		readSync(fd, buf, 0, len, size - len);
		return { text: buf.toString("utf8"), size };
	} catch {
		return { text: "", size: -1 };
	} finally {
		if (fd !== null) { try { closeSync(fd); } catch { /* 忽略 */ } }
	}
}

const sha16 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 16);

/** 从尾部文本里取**最后一条**可解析记录的 `seq`（缺失 ⇒ 0） */
function lastSeqOf(text) {
	const lines = String(text).split("\n").filter((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		try { const o = JSON.parse(lines[i]); if (o && Number.isInteger(o.seq)) return o.seq; } catch { /* 半行/坏行 ⇒ 继续往前找 */ }
	}
	return 0;
}

/**
 * 下一个 `seq`（会话内单调）。**失效条件 = `size ∨ mtimeMs ∨ 尾部哈希` 任一变化**（§12.6）⇒
 * 外部**等长改写**（`--apply`/compact/人工修 `seq`）也会被 mtime/尾部哈希抓住，**不再静默沿用旧 `seq`**。
 * 自身成功 append 后由 `appendOplog` 直接**回填缓存**（不重读）⇒ 稳态 O(1)。
 */
function nextOplogSeq(file) {
	let st = null;
	try { st = statSync(file); } catch { st = null; }
	const tail = st ? readTail(file) : { text: "", size: -1 };
	const sig = st ? { size: st.size, mtimeMs: st.mtimeMs, tailSha: sha16(tail.text) } : { size: -1, mtimeMs: -1, tailSha: "" };
	const c = oplogSeqCache.get(file);
	if (c && c.size === sig.size && c.mtimeMs === sig.mtimeMs && c.tailSha === sig.tailSha) return c.lastSeq + 1;
	const lastSeq = st ? lastSeqOf(tail.text) : 0;
	oplogSeqCache.set(file, { ...sig, lastSeq });
	return lastSeq + 1;
}

/** 显式清 ① 的 `seq` 缓存（**写者工具**：`--apply`/compact/迁移后必须调用；设计稿 §12.6 ②） */
export function resetOplogSeqCache() {
	oplogSeqCache.clear();
}

/* ---------------------------------------------------------------- 数据槽登记（2a-2 T1a-2）
 *
 * 事实来源 = 宿主会话事件（**经中间件转发**：`sink.observeSession(session, event)`，(A) 裁定 ⇒ 增量 O(1)/事件）。
 * **行白名单只在 B 侧**（中间件不认识业务类型，红线 §一.7③）。
 * ⚠️ **只登记"官方行身份已钉死且过真 DOM 对撞"的行**（T3 起 = 计划 v5 §4【裁决 #6】白名单的**可对撞子集**）：
 *   `tool/call` ⇒ `tool-call`（`callId`）｜`turn/start`/`turn/end` ⇒ `turn-process`（`turn`）｜
 *   `user/message`（含注入类上下文块）⇒ `input-message`（`data.id`）｜`assistant/message` ⇒ `assistant-step`（`turn:step`）。
 *   **未登记的**：`command/done`（无 DOM 样本 ⇒ 无对撞物）、`agent/inbox/*`（官方 `publication:"none"` ⇒ 无行节点）、
 *   `tool/result`（与 `tool/call` 同行 ⇒ 不另建槽）⇒ **一律不猜**，仅计入 `unknownRowTypes`（§15 观测 #3）。
 * 存储：`slots/<safeSessionId>.json`（**行事实面**；行不是"写操作" ⇒ **不进 ①**）
 *   ⇒ ② 的权威口径 = **f(①, 行事实面)**（重放判据据此表述；见 §7 纪律 3 的精化）。
 */

/** 已钉死身份的行白名单（`type` → `{defKind, idOf, turnOf?, filter?}`）；**新增一行前必须先钉死其官方 `defKind`/`id`**
 *
 * obs3S7 段W-2a **T3**（仲裁 `#A214` 五，计划 v5 §4【裁决 #6】的 7 类行白名单）：由"只有 `tool/call`"补齐为**逐 kind 钉死**。
 *   ★ **id 来源全部取自官方 Definition 本体**（`@deepseek-ai/dsh-client-ui-chat/lib/client.js`，逐条 file:line 见
 *     `log/obs3-s7/segW2b-verdicts.md` §7）：`conversationContextKey(kind,id)` 的 `(kind,id)` 必须与客户端**同源**。
 *   ★ **每条登记都必须过真 DOM 集合对撞**（`w2a2-t3-verdicts.mjs`；A 缺项 ⇒ 该 kind **不得登记**）。
 *   ★ **未登记**（如实回报，见判据件）：`command/done`（本窗口无 DOM 样本 ⇒ 无对撞物）、
 *     `agent/inbox/*`（官方 Definition `publication:()=>"none"` ⇒ **不产生行节点**，无行身份）、
 *     `tool/result`（**与对应 `tool/call` 同行** ⇒ 不另建槽，§4 原话）。
 */
/**
 * ★ **`#A263` S1（依据 = `#A260` 取证 ＋ `#E15`/`#E16` 两路互证）**：`compaction/start|summary|end` 的**行 id**。
 *   宿主 `dsh-client-ui-chat/lib/client.js:5576-5604` `compactionDefinition`：`kind:"compaction"`（:5577）、`target:"chat"`、
 *   `match`（:5585-5592）命中这三类 ⇒ `id = data.compactionId`（**非空字符串**才返回行；`role` = `start`/`update`）；
 *   ★ **带 `data.sourceCommandId` ⇒ :5586 `return null`** ⇒ 该事件改由 `commandDefinition` 认领（`kind:"command"`、
 *   id = `String(sourceCommandId)`，:5525-5535）⇒ 本规则**同样返回 `null`**（= 不建**第二个** `slotId`，不违反
 *   "同一 `commandId` 只允许一个 `slotId`"；代价 = **命令面触发的压缩不建行**，登记为已知残差）。
 * @param {object} d - 事件 `data`
 * @returns {string|null}
 */
function compactionIdOf(d) {
	if (d && d.sourceCommandId !== undefined) return null;
	return d && typeof d.compactionId === "string" && d.compactionId ? d.compactionId : null;
}

const ROW_RULES = new Map([
	["tool/call", { defKind: "tool-call", idOf: (d) => (d && d.callId !== undefined && d.callId !== null ? String(d.callId) : null) }],
	// ★ `#A279` ②（依据 `#E3` ① 取证）：`llm/retry` / `llm/retry-started` —— 宿主**有行身份**：
	//   `@deepseek-ai/dsh-client-ui-chat/lib/client.js:5858-5930` `retryDefinition`（`kind:"model-retry"`、`target:"chat"`、
	//   `match()` ⇒ `{id: data.retryId, role: retry===1?"start":"update"}`；`llm/retry-started` ⇒ `{id: retryId, role:"update"}`；
	//   `buildViewNode` ⇒ `chatNode(context,"model-retry",…)`（**默认 visible**）。
	//   ⚠️ `idOf` **非空才建行**（与官方 `match()` 的非空约束同义；返回 `null` ⇒ `observeRow` 不建行）。
	//   ⚠️ 真 DOM 键对撞**本批未取到**（两会话 retry 事件在已挂载窗口外）⇒ 留 VM/生产臂（第 27 次卡 §4 ③）。
	["llm/retry", { defKind: "model-retry", idOf: (d) => (d && typeof d.retryId === "string" && d.retryId ? d.retryId : null) }],
	["llm/retry-started", { defKind: "model-retry", idOf: (d) => (d && typeof d.retryId === "string" && d.retryId ? d.retryId : null) }],
	// `turn-process`（id = 回合号）＝**回合容器行**：`turn/start` 建行，`turn/end` 只更新（`turnTailDefinition` 之外的那条）
	["turn/start", { defKind: "turn-process", turnOf: (d) => (Number.isInteger(d?.turn) ? d.turn : null), idOf: (d) => (Number.isInteger(d?.turn) ? String(d.turn) : null) }],
	// ★ **T4 修正（仲裁 `#A215` 四；台账 `#41` 三源合判 + 用户实测）**：`turn/end` 的**承载行 = `turn-tail`**（不是 `turn-process`）——
	//   `turnTailDefinition`（官方 chat `:6858`）对 `turn/end` 返回 `role:"update"`，位置取 `closingAnchor()` ⇒
	//   账本/费用/状态卡族落**该回合全部工具/命令行之下**。⇒ 若错映射成 `turn-process`，该族卡会被注入**回合容器行** = 可见位置回归。
	//   三源实测（`log/obs3-s7/segment-W2b` T4 段）：DOM `turn-tail` 回合集 {6,7} **恰等于**窗口内 `turn/end` 回合集（差集空）；
	//   `turn-process` {6,7,8} = `turn/start`{7,8} ∪ `turn/end`{6,7}（回合 8 未结束 ⇒ 无 `turn-tail`）⇒ 两 kind 由**事件**区分。
	["turn/end", { defKind: "turn-tail", turnOf: (d) => (Number.isInteger(d?.turn) ? d.turn : null), idOf: (d) => (Number.isInteger(d?.turn) ? String(d.turn) : null) }],
	// `command`（id = `String(data.commandId)`）：**(f) 段登记（仲裁 `#A234` 三 批准 = 取到样本才登记）**
	//   ★ 样本（**生产只读**两路互证，非推断）：① DOM 键字面量 = `7:commandcmd-<uuid>-<n>`（会话 `517b7894`
	//     19 行，`log/obs3-s7/w2b-t9-dom-517b.out`）② 真事件流 `command/done` 的 `data.commandId = "cmd-<uuid>-<n>"`
	//     （32 条，`log/obs3-s7/w2b-f-command-ids.json`）⇒ `rowSlotId("command", commandId)` **逐字等于** DOM 键。
	["command/done", { defKind: "command", idOf: (d) => (d && d.commandId !== undefined && d.commandId !== null ? String(d.commandId) : null) }],
	// ★ **`#A250` 二 口径收全（子线 C 宿主源码依据，2026-09-20）**：`command/run` **是行类型**（`role:"start"`）——
	//   `dsh-client-ui-chat/lib/client.js:5513-5519` 的 `commandDefinition` match **命中 `command/run`**，id = `String(data.commandId)`，
	//   与上面的 `command/done`（`role:"update"`）**同一 `command` 行**（`dsh-client-ui-goal/lib/client.js:296` 注释亦印证）
	//   ⇒ 原先**漏登记** ⇒ 健康会话把它当"未知行"计数（生产实测 **33 次 / 2 会话**，`log/obs3-s7/segU23-unknown-types-report.md`）
	//   ⇒ 本批**补登记**（**slotId 与 `command/done` 逐字相同 ⇒ 不新增槽、位置轴零变化**；命令面传参**不动**）。
	["command/run", { defKind: "command", idOf: (d) => (d && d.commandId !== undefined && d.commandId !== null ? String(d.commandId) : null) }],
	// ★ **`#A252` 三 判据落地（子线 E 三路互证，2026-09-20）**：`request/header` **官方有行身份** ⇒ 补登记：
	//   宿主源码 `dsh-client-ui-chat/lib/client.js:5802-5809` `requestPromptDefinition`：kind `"request-prompt"`、`match` 命中
	//   `request/header`、`role:"start"`、**id = `String(event.seq)`**（**取自事件本体 ⇒ 需 `idOf(data, event)` 第二参**）、
	//   **无 `publication` ⇒ 默认 `immediate`**（`ui-conversation:844/910`；`:897-905` 每次 match 建行槽）；
	//   生产 DOM 实证：`14:request-prompt<seq>`（`session-2f3bd9b9`=`14:request-prompt73148`、`session-517b7894`=`14:request-prompt355884`）。
	//   ⚠️ `buildViewNode` **有条件**（`showsPrompt && prompt.system !== ""`；生产 **29/29** 满足）⇒ **行槽恒建、可见行可能少**（虚拟化）；
	//   `kind` 与既有 7 条**无一同 slotId** ⇒ 不并槽、不动既有位置轴。
	["request/header", { defKind: "request-prompt", idOf: (d, ev) => (ev && ev.seq !== undefined && ev.seq !== null ? String(ev.seq) : null) }],
	// ★ **`#A263` S1 补登记（三路互证，2026-09-20）**：`compaction/start|summary|end` = **官方有行身份**
	//   ⇒ `defKind:"compaction"`、`id = data.compactionId`（分支口径见 `compactionIdOf` 上注）。
	//   ① 宿主源码：`dsh-client-ui-chat/lib/client.js:5576-5604`（`kind:"compaction"`、`:5585-5592` 命中三类）；
	//   ② 真事件（生产只读，会话 `810db2a5`）：`seq 543624/543625/543627` 三条**同一** `data.compactionId =
	//      "a7bfc43d-8970-4f6d-b871-0fa228db7080"`（非空、**均无 `sourceCommandId`**）；
	//   ③ **真 DOM 键对撞**（生产只读真浏览器，`#E16`）：键 `10:compactiona7bfc43d-8970-4f6d-b871-0fa228db7080`
	//      **found=true**（该节点 `kind="compaction"`、可见、`hidden=null`）＋ 负控（改错 id ⇒ found=false）
	//      ⇒ `store.js` 的"**每条登记都必须过真 DOM 集合对撞**"前置条件**已满足**（本文件 :270-276 所在纪律段）。
	//   ⚠️ **可见行由 checkpoint 承载**：`buildViewNode` 需 `state.checkpoint`（`:5600` 否则 `return null`），而 checkpoint =
	//      `surfaceOp` 为 replacement 的 `user/message`（`compactSource`，`:5433-5441`；真事件 `seq=543626` 存在 ✓）
	//      ⇒ **行槽恒建、可见行可能少**（与 `request/header` 同族口径，不改变既有位置轴）。
	["compaction/start", { defKind: "compaction", idOf: compactionIdOf }],
	["compaction/summary", { defKind: "compaction", idOf: compactionIdOf }],
	["compaction/end", { defKind: "compaction", idOf: compactionIdOf }],
	// `input-message`（id = `String(data.id)`）：**注入类（系统提示/上下文块）走同一行**；官方只排除 compaction 检查点
	["user/message", { defKind: "input-message", filter: (ev) => (ev?.surfaceOp === "append") && !isCompactionCheckpointEvent(ev), idOf: (d) => (d && d.id !== undefined && d.id !== null ? String(d.id) : null) }],
	// `assistant-step`（id = `${turn}:${step}`）：官方 `assistant/message` 仅在 `surfaceOp === "append"` 时更新该行
	["assistant/message", { defKind: "assistant-step", filter: (ev) => ev?.surfaceOp === "append", turnOf: (d) => (Number.isInteger(d?.turn) ? d.turn : null), idOf: (d) => (Number.isInteger(d?.turn) && Number.isInteger(d?.step) ? `${d.turn}:${d.step}` : null) }]
]);

/** 官方 `isCompactionCheckpoint`（`source.kind === "plugin" && source.plugin === "compact"` 的 `user/message`） */
function isCompactionCheckpointEvent(ev) {
	const s = ev?.data?.source;
	return !!(s && typeof s === "object" && s.kind === "plugin" && s.plugin === "compact");
}

/** `slotId = conversationContextKey(defKind, id)` —— **逐字**照官方 `${kind.length}:${kind}${id}`（设计稿 §10.2 钉死） */
export function rowSlotId(defKind, id) {
	return `${defKind.length}:${defKind}${id}`;
}

/**
 * **反解 `slotId` 的契约形态** ⇒ 返回 `kind`；**形态非法 ⇒ `null`（不猜）**。
 * `#A234` 零 唯一要求：族判定**必须**走严格形态（长度前缀 = kind 字符数），
 * 禁止用子串匹配（`includes(":turn-tail")` 会把 kind 里恰含该子串的非 tail 族**误判**为 tail）。
 * @returns `string | null`
 */
function slotKindOf(slotId) {
	if (typeof slotId !== "string") return null;
	const m = /^(\d+):/.exec(slotId);
	if (!m) return null;
	const n = Number(m[1]);
	const rest = slotId.slice(m[0].length);
	if (!Number.isInteger(n) || n <= 0 || rest.length < n) return null;
	return rest.slice(0, n);
}

function slotsFile(sessionId) {
	return join(storeRoot(), "slots", `${safeSessionId(sessionId)}.json`);
}

/** 内存 pending（模块级可变状态之二）：`sessionId → Map<slotId, row>`；**flush 才落盘**（每回合 ≤2–3 次）*/
const pendingSlots = new Map();

/**
 * ★ A84（`#A84` 冷启动回填）：**回填断点**（`sessionId → 本进程已喂入的最大事件 seq`）。
 *   · 写入面 = `slots/<sid>.json` 的顶层 `observedSeq`（**只增键**，旧文件不会被改写形态以外的字节）；
 *   · 语义 = "该 `seq` 及之前的事件都已过 `observeRow`，其行事实已随最近一次 flush 落盘" ⇒ 重启后只喂
 *     `seq > observedSeq` 的尾部事件（**行事实等价性**见 `log/0.2.2升级/证据-A84-冷启动回填.md`）；
 *   · 断点缺失（旧文件/被清）⇒ 调用方退回**全量回填**（负控口径）；**不得**用 `observedSeq=0` 冒充已回填。
 *   ⚠️ 只做存储与查询，**不改变行事实判定**（`observeRow` 的 `ROW_RULES`/位置臂一字未动）。
 */
const observedSeqMax = new Map();
function bumpObservedSeq(sessionId, event) {
	const seq = event?.seq;
	if (!Number.isInteger(seq)) return;
	const cur = observedSeqMax.get(sessionId);
	if (cur === undefined || seq > cur) observedSeqMax.set(sessionId, seq);
}
function observedSeqOf(sessionId) {
	return observedSeqMax.get(sessionId) || 0;
}

/**
 * 观测 #3（obs3S7 段W-2b `(b)`；设计稿 §3.2 行 3）：**白名单外事件类型**的增量计数
 *   （`sessionId → Map<eventType, count>`）。**只增不猜、不建行**（`#A229` 五 F3 的"不猜"口径）。
 *   ⇒ 随**行事实面**一同落盘（`slots/<sid>.json` 的 `stats`）⇒ ② 的 `counters.unknownRowTypes`
 *   仍是 **(①, 行事实面) 的纯函数**（判据 3"清空 ② 用 ① 重放 ⇒ 逐字相同"不破）。
 */
const unknownRowTypeDelta = new Map();

/**
 * ★ **计划 v5 §4「不计入」清单**（仲裁 `#A247` 一 修入；口径 = 这些类型**不是"未知行"**，只是"**不建槽**"）：
 *   流式分片四类（`text-chunks`/`assistant/chunk`/`reasoning-chunks`/`tool-call-chunks`）＋ `tool/result`（与对应 `tool/call` 同行）。
 *   ⚠️ 把它们算进 `unknownRowTypes` ⇒ **健康会话恒亮 `E-ROW` 告警**（"狼来了"，`#A214` 四(i) 同族；`#A247` 零 用户实测 `×251479`/全局 `×1152400`）。
 */
/* ★`#A71`（2026-11-18）：补 **官方作业事件** `job/registered`／`job/settled` —— 依据（现读、非推断）：
 *   · 生产者 `@deepseek-ai/dsh-jobs-local/lib/index.js:617-618` 只 `session.append("job/registered"|"job/settled", …)`；
 *   · 消费者侧 `@deepseek-ai/dsh-client-ui-chat`／`dsh-client-ui-jobs` **grep 0 命中** ⇒ chat 面**不渲染**该事件
 *     ⇒ 与既有项同型（有状态、**无行身份**）。
 *   · 生产量级（现读解码 3 个会话日志）：`kind` 100% = `bash`、`distinctJobIds == registered 数`（无重复/无循环），
 *     即「每次 bash 工具调用注册一个作业、结束结算」⇒ **正常活动量**，不是异常源。
 *   ⚠️ 本项只清"误报的狼来了"；**不等于**把未知类型整类静默 —— 白名单外的其它类型仍照计入（见下方 `isCountedUnknownType`）。 */
const ROW_NOT_COUNTED = new Set(["text-chunks", "assistant/chunk", "reasoning-chunks", "tool-call-chunks", "tool/result", "job/registered", "job/settled"]);

/**
 * ★ **`#A250` 二 口径收全（2026-09-20）：「已知非行清单」** —— 官方**结构上无行身份**的宿主事件类型。
 *   口径：**"真未知行类型" = `ROW_RULES` 白名单外 ∧ 不在 `ROW_NOT_COUNTED` ∧ 不在本清单内**；
 *   本清单内的一律**不计入** `unknownRowTypes`（否则**任何有正常活动的会话恒亮 `E-ROW`** ⇒ 狼来了 ⇒ 真信号被淹）。
 *   **准入纪律**：新增项**必须附"该类型官方无行身份"的依据**（防清单变垃圾桶），逐项依据须同步写进
 *   `docs/plugins/dsh-notice-banner.md` 同名节；**依据不足者不得入清单**（例：`request/header` = **有条件行身份**
 *   ⇒ 待裁，见 `log/obs3-s7/segU23-unknown-types-report.md`「依据不足」子表）。
 *   本批依据链（子线 C 穷举、非推断）：`dsh-session/lib/types/surface.js:11-15`（surface 事件仅
 *   `user/message`/`assistant/message`/`tool/result`）＋ `dsh-client-ui-chat/lib/client.js:5615-5624`
 *   （兜底 Definition 仅 `isAppendSurfaceEvent` 才建节点 ⇒ 非这 3 类**结构上不可能经兜底建行**）
 *   ＋ chat 面 Definition 注册点全库穷举（chat 13 处 ＋ `goal:296` ＋ `workflow-run:573`）
 *   ＋ `publication` 默认 `immediate`、显式 `"none"` 全库仅 4 处。生产读数（26/26 会话）见上述报告。
 */
export const KNOWN_NON_ROW_EVENT_TYPES = [
	"step/start",                // chat:4468 命中，但 :4507-4508 publication → "none"（有状态、无行）
	"step/end",                  // chat 仅 :6489/:6747/:6775（update/谓词），无 match 返回它；生产不带 surfaceOp
	"agent/inbox/spliced",       // chat:5718 publication "none"
	"session/title",             // chat 面 0 引用；会话标题元数据（client-connection）
	"permission/preset",         // chat 面 0 引用；设置帧
	"approval/policy",           // 同上
	"sandbox/mode",              // 同上
	"request/context",           // chat 面 0 引用；元数据帧
	"session/title-llm-request", // chat 面 0 引用；session-title-llm 内部台账
	"subagent/descriptor",       // chat 面 0 引用；subagent 元数据
	"todo/write",                // chat 面 0 引用；会话级 todo 状态
	"session/end-seed"           // chat 面 0 引用（无 **chat 面**行身份）；⚠️ trajectory 面另有 Definition（`dsh-client-ui-trajectory:1106-1111` `target:"trajectory"`）⇒ **若"行"口径扩到 trajectory 面须重判**（依据：`log/obs3-s7/segU23-unknown-types-report.md`）
	, "compaction/prune"          // ★ `#A263` S1（依据 `#E15` §1 三路取证）：**官方无行身份** —— ① chat 面 Definition 全库穷举 **0 引用**；② **非 surface 事件**（唯一写入点 `dsh-compaction-tool-result-pruner/lib/index.js:162` 的 `append` 调用〔写入本次类型〕**未传 `surfaceOp`**，而 `surfaceOp` 仅显式传入时写入（`dsh-session/lib/index.js:1403-1410`），surface 事件仅 3 类（`dsh-session/lib/types/surface.js:13-15`）⇒ chat 兜底 Definition（`client.js:5615-5624` 要求 `isAppendSurfaceEvent`）**结构上不可能建行**）；③ 真事件 `data` 仅 `{shadowedRange, shadowedSeqs, shadowedTokenCount}`（5 条，**无 `compactionId`**）；④ 真 DOM 旁证（缺席证据）：143 流节点 kind 分布**无 `prune` 族**
	// ★ `#A279` ①（依据 `#E3` ① 只读取证）：**官方无行身份** ⇒ 入「已知非行清单」
	, "notice/banner"             // 本插件注入的**合成事件**：宿主全库 **0 引用**（`dsh-session/lib/types/known-event-types.js` 头注：out-of-repo plugin events are outside this list by construction）；DOM 里 `21:notice-banner-context<store-anchor-…>` = **插件 match() 注入的载体节点**、**非宿主行**
	, "notice/banner-replace"     // 同上（同类合成事件）
	, "web/deepseek-search-llm-request" // 40 个 `dsh-client-ui-*` 包**递归 0 引用**；生产者 `dsh-web-search-deepseek/lib/index.js:288` 仅 `session.append`（在 `known-event-types.js` 词汇表内 **≠ 有行身份**）
	, "model/selection"           // UI 包 **0 引用**；宿主引用 = `dsh-api-session-controller/lib/index.js:312`（append）＋`:2004`（重试状态机）＋ `dsh-agent-presets`（类型声明）⇒ **会话状态/投影面**
	// ★`#A76`（依据 `#A75` 逐类取证）：**会话头记录** `{"type":"session",version,id,cwd,…}` ——
	//   **不在**官方事件词汇表（`dsh-session/lib/types/known-event-types.js`，62 类）内（它是日志 header，不是事件），
	//   且**无 `seq`**、chat 面无 definition（`ui-chat` 命中全是 `kind/scope:"session"` 字符串）⇒ **非行**。
	//   ⇒ 入「已知非行清单」（`#A71` 的"无 seq 事件按类型每会话一次"仍生效；本项使其不再计入未知）。
	, "session"
];
const KNOWN_NON_ROW = new Set(KNOWN_NON_ROW_EVENT_TYPES);

/* ★`#A71`：**未知类型计数去重水位** —— 现读实测：同一批事件在盘上被重复累加 ≈7–8 倍
 *  （`b005b8fd` 日志里 `job/registered` **419** 条，`slots.stats` 却记 **3,386**；`23045b6d` 406 → 2,924）。
 *  成因：`host-compat` 首次喂入会**回填该会话全部历史事件**（`lib/index.js:846-856`），而本进程重启后
 *  `observeBackfilled` 复位 ⇒ **每次重启都把整段历史再计一遍**，计数只增不减 ⇒ `E-ROW` 变成"重启次数计量器"。
 *  修：按会话记 **已计最大 `seq` 水位**（落 `slots.stats.unknownSeqMax`，重启后从盘上恢复）⇒ `seq ≤ 水位` 的不再计。
 *  只作用于**未知类型计数**这一路，**不影响行事实面/落位**（红线：禁把诊断数字当成落位修复）。 */
const unknownSeqMax = new Map();
function unknownWatermark(sessionId) {
	if (unknownSeqMax.has(sessionId)) return unknownSeqMax.get(sessionId);
	let v = 0;
	try {
		const j = JSON.parse(readFileSync(slotsFile(sessionId), "utf8"));
		v = Number(j?.stats?.unknownSeqMax) || 0;
	} catch { v = 0; }
	unknownSeqMax.set(sessionId, v);
	return v;
}

/** ★`#A71` 二：**无 `seq` 事件**（如会话头 `session` 事件）的「每会话 × 每类型只计一次」去重集 ——
 *  懒加载盘上 `stats.unknownRowTypes` 的键集（⇒ 跨进程幂等：重放不再 +1）。 */
const noSeqCounted = new Map();
function noSeqCountedTypes(sessionId) {
	if (noSeqCounted.has(sessionId)) return noSeqCounted.get(sessionId);
	const set = new Set();
	try {
		const j = JSON.parse(readFileSync(slotsFile(sessionId), "utf8"));
		const m = j && j.stats && typeof j.stats.unknownRowTypes === "object" && !Array.isArray(j.stats.unknownRowTypes) ? j.stats.unknownRowTypes : null;
		if (m) for (const k of Object.keys(m)) if (isCountedUnknownType(k)) set.add(k);
	} catch { /* 读不到 ⇒ 从空集起（仅本进程内去重；水位缺失时同样如实降级） */ }
	noSeqCounted.set(sessionId, set);
	return set;
}

/* ★`#A76`：**官方事件全集**（`unknownRowTypes` 判据的来源）—— 见 `tools/extract-official-event-types.mjs`。
 *   口径（用户 `#A76` 逐字「应该根据我们自己自定义的 type 做检测 没定义就不应该检测」）：
 *   **只有"不在官方全集内"的类型才算未知** ⇒ 官方新增类型**自动不算未知**，不再靠逐类白名单追。
 *   来源优先级（读到哪个用哪个，**都在 counters 如实标**）：
 *     ① `DSH_OFFICIAL_TYPES_SRC`（显式，测试/紧急用）
 *     ② 宿主安装内 `dsh-session/lib/types/known-event-types.js`（可读 ⇒ **随宿主升级自动跟随**）
 *     ③ 随插件发布的静态快照 `data/official-event-types.json`（构建期由脚本生成）
 *     ④ 都读不到 ⇒ `degraded: true` ＋ **回落到原白名单判据**（会多计数，但**绝不静默**）
 *   ⚠️ 为什么不用官方 `KNOWN_SESSION_EVENT_TYPES` 的 import：该包**不在插件 profile 依赖树**内
 *      （`$DSH_HOME/profiles/web/node_modules/@deepseek-ai/` 无 `dsh-session`）⇒ 运行时无法按依赖解析，
 *      硬编码安装路径属未公开耦合 ⇒ 三档结论＝**丙（未提及/不可依赖）**，故走静态抽取＋可选宿主文件读。
 */
let officialTypesCache = null;
const officialTypesState = { n: 0, source: "none", degraded: true, version: null, at: null };
function parseOfficialTypes(text) {
	const m = /KNOWN_SESSION_EVENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(String(text || ""));
	if (!m) return null;
	const out = new Set();
	for (const mm of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) out.add(mm[1] || mm[2]);
	return out.size ? out : null;
}
function officialEventTypes() {
	if (officialTypesCache) return officialTypesCache;
	officialTypesCache = new Set();
	let source = "none";
	let version = null;
	const set = (s, src) => { if (!s) return false; officialTypesCache = s; source = src; officialTypesState.n = s.size; return true; };
	try {
		const explicit = process.env.DSH_OFFICIAL_TYPES_SRC;
		if (explicit) { try { set(parseOfficialTypes(readFileSync(explicit, "utf8")), "host"); } catch { /* 落到下一档 */ } }
		if (!officialTypesState.n) {
			const host = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js";
			try { set(parseOfficialTypes(readFileSync(host, "utf8")), "host"); } catch { /* 落到快照 */ }
		}
		if (!officialTypesState.n) {
			try {
				const p = new URL("../data/official-event-types.json", import.meta.url).pathname;
				const j = JSON.parse(readFileSync(p, "utf8"));
				version = j && typeof j.version === "string" ? j.version : null;
				const arr = Array.isArray(j && j.types) ? j.types : [];
				set(new Set(arr), "snapshot");
			} catch { /* 落到 degraded */ }
		}
	} catch { /* 忽略：统一走下面的状态结算 */ }
	officialTypesState.source = source;
	officialTypesState.version = version;
	officialTypesState.degraded = officialTypesState.n === 0;
	officialTypesState.at = new Date().toISOString();
	return officialTypesCache;
}

/** 是否应计入 `unknownRowTypes`：**不在官方全集 ∧ 白名单外 ∧ 非「不计入」∧ 非「已知非行」**；
 *  ★`#A71` 三：另**对外导出**给数据修复工具 `tools/recount-unknown.mjs` ⇒ **重算口径与写入路径逐字同源**） */
export function isCountedUnknownType(t) {
	return typeof t === "string" && t.length > 0 && !officialEventTypes().has(t) && !ROW_RULES.has(t) && !ROW_NOT_COUNTED.has(t) && !KNOWN_NON_ROW.has(t);
}

/** 合并"盘上 stats" + "内存增量" ⇒ 新的 stats（**空增量 ⇒ 原样返回**，保证旧文件字节不变） */
function mergeRowStats(base, delta) {
	if (!delta || !delta.size) return base && typeof base === "object" ? base : {};
	const out = { ...(base && typeof base === "object" ? base : {}) };
	const prev = out.unknownRowTypes && typeof out.unknownRowTypes === "object" && !Array.isArray(out.unknownRowTypes) ? out.unknownRowTypes : {};
	const u = {};
	// ★ `#A247` 一：盘上历史若已混入「不计入」类型（= 健康会话被恒亮告警的根因）⇒ **就地剔除**（懒迁移，不写迁移脚本）
	// ★ `#A250` 二：懒迁移 + 读数兜底统一走 `isCountedUnknownType`（白名单外 ∧ 非「不计入」∧ 非「已知非行清单」）
	for (const [k, v] of Object.entries(prev)) if (isCountedUnknownType(k)) u[k] = v;
	for (const [k, v] of delta) if (isCountedUnknownType(k)) u[k] = (u[k] || 0) + v;
	out.unknownRowTypes = u;
	let total = 0;
	for (const k of Object.keys(u)) total += Number(u[k]) || 0;
	out.unknownRowTypesTotal = total;
	return out;
}

/** ★ `#A247` 一：`counters.unknownRowTypes` = **真未知类型**之和（盘上历史混入「不计入」类型时**读数处再兜一层** ⇒ 健康会话基线 = 0） */
function rowUnknownTotal(rowStats) {
	const map = rowStats && typeof rowStats.unknownRowTypes === "object" && !Array.isArray(rowStats.unknownRowTypes) ? rowStats.unknownRowTypes : null;
	if (!map) return Number.isFinite(rowStats?.unknownRowTypesTotal) ? rowStats.unknownRowTypesTotal : 0;
	let n = 0;
	for (const [k, v] of Object.entries(map)) if (isCountedUnknownType(k)) n += Number(v) || 0;
	return n;
}

/**
 * ★ **`#A263` S2（依据 `#A254` 六 机械确认）**：**会话级**告警的 `unknownRowTypes` 改与**全局聚合同源** ——
 *   从**行事实面** `slots/<sid>.json` 的 `stats` 现算（同一 `rowUnknownTotal`）。
 *   理由：盘上 `index/<sid>.json` 的 `counters.unknownRowTypes` 对**自 `#A247`/`#A252` 后从未重写**的会话是
 *   **陈旧未过滤值**（第 23/24 次部署实测：11 会话之和 215376、`session-2f3bd9b9` = 371）；`#A253` 一(c) 的
 *   "读时过滤"此前**只落到全局聚合** ⇒ **会话级 `E-ROW` 卡仍上屏陈旧数**。
 *   **slots 不可读 ⇒ 如实回退**盘上值（**不静默归零**，`#A247` 同族纪律）。
 *   ⚠️ 只改**告警卡条目**；`counts.unknownRowTypes`（写盘面 == 上屏面的对撞口径）**保持盘上原值只观测**（沿 `#A253` 一(b) 先例）。
 * @param {string} sessionId
 * @param {number} fallback - 盘上 `counters.unknownRowTypes`
 * @returns {number}
 */
function sessionRowUnknownTotal(sessionId, fallback) {
	const fb = Number.isFinite(fallback) ? fallback : 0;
	try {
		const j = JSON.parse(readFileSync(slotsFile(sessionId), "utf8"));
		const v = rowUnknownTotal(j && typeof j.stats === "object" && j.stats && !Array.isArray(j.stats) ? j.stats : {});
		return Number.isFinite(v) ? v : fb;
	} catch { return fb; }
}

/**
 * 读行事实面（只读、永不 throw）；`stats` = 行事实面的**观测统计**（旧文件无该键 ⇒ `{}`，向后兼容）。
 * `observedSeq` = **回填断点**（A84）：本行事实面**已处理到的最大事件 `seq`**；旧文件无该键 ⇒ 0（=
 * 未知断点，调用方按"全量回填"如实降级，**不得**把 0 当成"已回填"）。
 */
export function readSlots(sessionId) {
	try {
		const j = JSON.parse(readFileSync(slotsFile(sessionId), "utf8"));
		return { ok: true, rows: Array.isArray(j?.rows) ? j.rows : [], stats: j?.stats && typeof j.stats === "object" && !Array.isArray(j.stats) ? j.stats : {}, observedSeq: Number.isInteger(j?.observedSeq) && j.observedSeq > 0 ? j.observedSeq : 0 };
	} catch {
		return { ok: true, rows: [], stats: {}, observedSeq: 0 };
	}
}

function writeSlots(sessionId, rows, stats = {}, observedSeq = 0) {
	const file = slotsFile(sessionId);
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		// ⚠️ 局部变量名刻意**不叫** `payload`（K-c2 键集对撞把 entry 类变量名的属性读取一律当"消费 entry 键"）
		const face = { v: 1, sessionId: sessionId === undefined ? null : sessionId, rows };
		// **形状只增**：无观测统计（= 常态）⇒ **不写 `stats` 键** ⇒ 现存文件字节逐字不变（inert）
		if (stats && typeof stats === "object" && Object.keys(stats).length) face.stats = stats;
		// ★ A84：**回填断点**（只增键；无值 ⇒ 不写 ⇒ 旧文件字节不变）。断点语义见 `readSlots` 注释。
		if (Number.isInteger(observedSeq) && observedSeq > 0) face.observedSeq = observedSeq;
		writeFileSync(tmp, `${JSON.stringify(face, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `slots-io:${String(err?.message ?? err)}` };
	}
}

/**
 * ★ A84：**回填断点查询**（`host-compat` 通过可选服务方法 `backfillState` 调用；只读、永不 throw）。
 *   - `observedSeq` = 盘上断点（0 = 无断点 ⇒ 中间件按"全量回填"如实降级）；
 *   - `cards` = 该会话**自有分片**里的卡片条数（0 且无断点 ⇒ 中间件可**如实跳过**回填：没有卡就没有
 *     需要落位的对象；行事实只在"给卡定位"时被消费）；
 *   - `rows` = 盘上行数（读数用途）。
 * @returns {{ok:true, observedSeq:number, rows:number, cards:number}}
 */
export function backfillState(sessionId) {
	const slots = readSlots(sessionId);
	let cards = 0;
	try {
		const f = JSON.parse(readFileSync(shardFile(sessionId), "utf8"));
		cards = Array.isArray(f?.entries) ? f.entries.length : (Array.isArray(f) ? f.length : 0);
	} catch { cards = 0; }
	return { ok: true, observedSeq: slots.observedSeq, rows: slots.rows.length, cards };
}

/**
 * ★ A84 一次性**断点播种**（装件时跑；`--apply` 才写）。
 *   口径：`observedSeq = max(disk rows.seq)` —— 行事实是**只有 flush 才写**的，而 flush 只在该批事件
 *   都过完 `observeRow` 之后发生 ⇒ 盘上最大行 seq **之前的事件必然已被处理**（保守下界，绝不跳未处理事件）。
 *   已存在断点 ⇒ 不动（幂等）；空行事实 ⇒ 不种（无断点，下次按全量/跳过策略如实处理）。
 * @param {{apply?: boolean}} [opts]
 * @returns {{ok:boolean, applied:boolean, dir:string, total:number, seeded:number, already:number, empty:number, failed:number, reason?:string}}
 */
export function seedBackfillCheckpoints({ apply = false, minAgeMs = 0 } = {}) {
	const out = { ok: true, applied: apply === true, dir: join(storeRoot(), "slots"), total: 0, seeded: 0, already: 0, empty: 0, recent: 0, failed: 0, minAgeMs };
	let files = [];
	try { files = readdirSync(out.dir); } catch { return { ...out, ok: false, reason: "slots-dir" }; }
	for (const f of files) {
		if (!f.endsWith(".json") || f.includes(".bak-") || f.includes(".tmp-") || f.includes(".bad-")) continue;
		out.total += 1;
		// ⚠️ 与在跑的 dsh 进程并发写同一文件的风险：**跳过最近被写过的文件**（年龄不足 ⇒ 可能正被 live flush 改写）
		try {
			if (Number.isFinite(minAgeMs) && minAgeMs > 0 && Date.now() - statSync(join(out.dir, f)).mtimeMs < minAgeMs) { out.recent += 1; continue; }
		} catch { out.failed += 1; continue; }
		let face = null;
		try { face = JSON.parse(readFileSync(join(out.dir, f), "utf8")); } catch { out.failed += 1; continue; }
		const cur = Number.isInteger(face?.observedSeq) && face.observedSeq > 0 ? face.observedSeq : 0;
		if (cur > 0) { out.already += 1; continue; }
		let maxSeq = 0;
		for (const r of Array.isArray(face?.rows) ? face.rows : []) if (Number.isInteger(r?.seq) && r.seq > maxSeq) maxSeq = r.seq;
		if (maxSeq <= 0) { out.empty += 1; continue; }
		if (apply !== true) { out.seeded += 1; continue; }
		const rows = Array.isArray(face?.rows) ? face.rows : [];
		const stats = face?.stats && typeof face.stats === "object" && !Array.isArray(face.stats) ? face.stats : {};
		const sid = typeof face?.sessionId === "string" && face.sessionId ? face.sessionId : f.replace(/\.json$/, "");
		const w = writeSlots(sid, rows, stats, maxSeq);
		if (w.ok) out.seeded += 1; else out.failed += 1;
	}
	return out;
}

/**
 * 消费一个宿主事件（**O(1) 早退 + 内存累积**，**无 IO**）。永不 throw。
 * @returns `{ok:true, accepted:boolean, slotId?}`（`accepted=false` = 非白名单/形状不合 ⇒ 只计数）
 */
export function observeRow(sessionId, event) {
	try {
		// ★ A84：断点水位（**只记不改判定**；无 seq 的事件不参与）
		bumpObservedSeq(sessionId, event);
		const rule = event && typeof event.type === "string" ? ROW_RULES.get(event.type) : undefined;
		if (!rule) {
			// 观测 #3：**白名单外事件类型** ⇒ 只计数（`counters.unknownRowTypes`，可 grep / 上屏），**绝不建行**
			//   ★ `#A247` 一：**流式分片四类 ＋ `tool/result` 属"不计入"**（计划 v5 §4）⇒ 连计数都不做（否则健康会话恒亮告警）
			const t = event && typeof event.type === "string" ? event.type : null;
			if (isCountedUnknownType(t)) {
				const sq = Number.isInteger(event.seq) ? event.seq : null;
				if (sq !== null) {
					if (sq <= unknownWatermark(sessionId)) return { ok: true, accepted: false };   // ★`#A71`：已计过 ⇒ 不再累加
					unknownSeqMax.set(sessionId, sq);
				} else {
					// ★`#A71` 二（实测缺口）：**无 `seq` 的事件无法用 `seq` 水位去重**（如会话头 `session` 事件）——
					//   旧实现每次重放都 +1（正控实测：42→43→44 / 413→414），仍会随重启线性长。
					//   口径：**同一会话同一类型只计一次**（懒加载盘上 `stats.unknownRowTypes` 的键集 ⇒ 跨进程幂等）。
					const seen = noSeqCountedTypes(sessionId);
					if (seen.has(t)) return { ok: true, accepted: false };
					seen.add(t);
				}
				let um = unknownRowTypeDelta.get(sessionId);
				if (!um) { um = new Map(); unknownRowTypeDelta.set(sessionId, um); }
				um.set(t, (um.get(t) || 0) + 1);
			}
			return { ok: true, accepted: false };
		}
		// T3：**逐 kind 的官方前置条件**（`surfaceOp === "append"` 等）不满足 ⇒ 不建槽（该行不会存在）
		if (typeof rule.filter === "function" && rule.filter(event) !== true) return { ok: true, accepted: false };
		// ★ `#A252` 三：`idOf` 可读**事件本体**（第二参）—— `request/header` 的行 id = `String(event.seq)`（其 `data` 不含 seq）
		const id = rule.idOf(event.data, event);
		if (id === null || id === "") return { ok: true, accepted: false };
		const slotId = rowSlotId(rule.defKind, id);
		let m = pendingSlots.get(sessionId);
		if (!m) { m = new Map(); pendingSlots.set(sessionId, m); }
		if (!m.has(slotId)) {
			m.set(slotId, {
				slotId, defKind: rule.defKind, id, eventType: String(event.type),
				seq: Number.isInteger(event.seq) ? event.seq : null,
				turn: Number.isInteger(event.data?.turn) ? event.data.turn : (typeof rule.turnOf === "function" ? rule.turnOf(event.data) : null),
				step: Number.isInteger(event.data?.step) ? event.data.step : null,
				at: Number.isFinite(event.time) ? event.time : (Number.isFinite(event.at) ? event.at : null)
			});
		}
		return { ok: true, accepted: true, slotId };
	} catch (err) {
		return { ok: false, reason: `observe-failed:${String(err?.message ?? err)}`, accepted: false };
	}
}

/**
 * 落盘 pending 行事实（**唯一 flush 点**：`turn/end` / 显式调用），并**重建 ②**（行到齐后 ⇒ 早先的未定位卡可就地归位）。
 * @returns `{ok:true, added, total, index}` | `{ok:false, reason}`
 */
export async function flushSlots(sessionId) {
	const kit = await loadKit();
	if (!kit) return { ok: false, reason: "banner-kit" };
	const pend = pendingSlots.get(sessionId);
	const slotsSnap = readSlots(sessionId); // ⚠️ 变量名刻意**不叫 entry 类名**：它是**行事实面快照**（`{rows}`），不是卡片 entry
	const have = new Set(slotsSnap.rows.map((r) => r.slotId));
	const add = pend ? [...pend.values()].filter((r) => !have.has(r.slotId)) : [];
	const rows = [...slotsSnap.rows, ...add].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.slotId).localeCompare(String(b.slotId)));
	// 观测 #3：把内存里的"白名单外类型"增量并入行事实面（**无增量 ⇒ 不写 `stats` ⇒ 字节不变**）
	const rowDelta = unknownRowTypeDelta.get(sessionId);
	const rowStats = mergeRowStats(slotsSnap.stats, rowDelta);
	// ★`#A71`：水位随行事实面一起落盘（`seq ≤ 水位` 的事件在下次进程里不再重复计入）
	try {
		const wm = unknownWatermark(sessionId);
		if (wm > 0) rowStats.unknownSeqMax = Math.max(Number(rowStats.unknownSeqMax) || 0, wm);
	} catch { /* 水位写不进 ⇒ 仅本进程内去重 */ }
	const wmDirty = (unknownWatermark(sessionId) || 0) > (Number(slotsSnap.stats?.unknownSeqMax) || 0);
	// ★ A84：**回填断点**（本进程已喂入的最大 seq）⇒ 随本次 flush 落盘（只增；无值不写键）
	const obsSeq = Math.max(observedSeqOf(sessionId), Number(slotsSnap.observedSeq) || 0);
	const rowChanged = add.length > 0 || (rowDelta && rowDelta.size > 0) || wmDirty;
	if (!rowChanged) {
		// ★ A84 **空转短路**（冷启动"断点续"后的常态）：行事实与统计**均无变化** ⇒ `buildIndex` 的输入不变
		//   ⇒ **不重建 ②、不重算全局聚合**（`buildIndex` 是 (①, 行事实) 的纯函数；卡追加/更新走 `commit()`
		//   自己在写分片后重建 ② ⇒ 这里跳过不会让卡停在未定位）。
		//   ⚠️ 若 ② 缺失 ⇒ **不短路**，落到下面重建（不静默留一个"没有索引"的会话）。
		if (obsSeq > (Number(slotsSnap.observedSeq) || 0)) {
			const w = writeSlots(sessionId, slotsSnap.rows, slotsSnap.stats, obsSeq); // 仅推进断点（行事实字节不变）
			if (!w.ok) return { ok: false, reason: w.reason };
			return { ok: true, skipped: "checkpoint", added: 0, total: slotsSnap.rows.length, observedSeq: obsSeq };
		}
		if (existsSync(indexFile(sessionId))) return { ok: true, skipped: "no-change", added: 0, total: slotsSnap.rows.length, observedSeq: obsSeq };
	}
	if (rowChanged) {
		const w = writeSlots(sessionId, rows, rowStats, obsSeq);
		if (!w.ok) return { ok: false, reason: w.reason };
		if (pend) pend.clear();
		if (rowDelta) rowDelta.clear();   // 已落盘 ⇒ 清增量（累计值在盘上）
	}
	const prev = readIndex(sessionId);                       // ★ T5：**先读旧 ②**（迁移审计对照）
	const shard = readShard(kit, sessionId);
	const idx = buildIndex(sessionId, shard.entries, rows, rowStats);
	const wi = writeIndex(sessionId, idx);
	// ★ T5（`#A220` 四⑤）：**由"未定位"迁入 `slots` 的卡如实记进 ①**（**事实不抹**：卡曾被判未定位这件事可 grep 可审计）。
	//   ⚠️ 只写 **①**，**不写 ② 的 `wasUnplaced` 字段** —— 那会让 ② 不再是 (①, 行事实面) 的纯函数 ⇒ **破坏判据 3**
	//   （"清空 ② 用 ① 重放 ⇒ 逐字相同"）。本记录 `snapshot:null` ⇒ 不参与重放折行；字面量只用**冻结枚举**
	//   （`op:"PUT"`、`owner:"system"`、`result:"ok"`、`reason:"unplaced"`）⇒ **零新增字面量**。
	let migrated = 0;
	if (prev.ok === true && prev.index && Array.isArray(prev.index.unplaced)) {
		const was = new Set(prev.index.unplaced.map((x) => x.cardId).filter((c) => typeof c === "string" && c));
		if (was.size) {
			for (const c of idx.cards) {
				if (c.placeState === "placed" && typeof c.cardId === "string" && was.has(c.cardId)) {
					appendOplog(sessionId, { op: "PUT", owner: c.owner ?? "system", cardId: c.cardId, slotId: c.slotId, sessionId, result: "ok", reason: "unplaced", occ: null, snapshot: null });
					migrated += 1;
				}
			}
		}
	}
	// ★ A85：**标脏**，不在这里重算（旧实现每写一次索引就全库重扫 438 个 `index/*.json` ⇒ 主线程单核 100%、RSS 1GB）。
	//   重算改由 `globalCounters()` 在 TTL 到期或脏时做一次（≤60s 有界延迟）；需要实时由显式 `refreshGlobalCounters()`。
	try { globalCountersDirty = true; } catch { /* 观测面失败不影响写路径 */ }
	return { ok: true, added: add.length, total: rows.length, observedSeq: obsSeq, index: idx, migrated, ...(wi.ok ? {} : { indexDegraded: wi.reason }) };
}

/**
 * **一次性重建 ②（索引）的显式服务端入口**（`#A29` 步1 · P2′；依据 = `log/0.2.2升级/证据-P1P2改码与0卡归因.md §3.1(a)`）。
 *
 * **要解决或预防的问题**：生产实证存在「**① 分片有卡片条目、② `index/<sid>.json` 不存在**」的会话
 *   ⇒ `notice/list` 回 `indexDegraded` ＋ `slots: []` ⇒ 客户端没有权威落点 ⇒ **整会话静默 0 卡**
 *   （`#A26 F159` 负控：移走 ② ⇒ 24→0；复位 ⇒ 回 24）。② 是 **(条目, 行事实) 的纯函数**（`buildIndex`）
 *   ⇒ 修法属**数据修复**（重算派生数据），不改判据、不动 ① 的树内容。
 *
 * **硬纪律（三条，缺一即违规）**：
 *   ① **绝不自动执行**：本函数不在任何读/写热路径上被调用（调用面只 `tools/rebuild-index.mjs` 与人工入口）；
 *      B 侧发现 ② 缺失**只如实上报 `indexDegraded`、不自动重建**（禁写放大：重建是一次全量 ② 计算）。
 *   ② **写前备份**：盘上已有 ② ⇒ 先拷 `<file>.bak-<ts>` ＋ `chmod 600`（备份失败 ⇒ **不写**）。
 *   ③ **单一路径**：行事实仍由 `observeRow` → `flushSlots` 产出，② 仍由 `writeIndex` 落盘
 *      （**禁第二套写实现**；`flushSlots` 在无新行时不重写 `slots/` ⇒ 字节逐字不变）。
 *
 * @param {string} sessionId 会话 id（`session-<uuid>` 或裸 uuid，路径归一由 `shardFile()` 负责）
 * @param {object} [opts]
 * @param {Array<object>|null} [opts.events] 可选**会话日志回放**：逐条喂 `observeRow` 补行事实
 *   （缺省 `null` ⇒ 只用盘上既有 `slots/` 行事实重算 ②，**不猜行**）。仅当该会话有日志而 `slots/` 缺失时才需要。
 * @param {boolean} [opts.apply] `false`（默认）⇒ **只读预演**（零写盘，返回将要写入的形状摘要）。
 * @returns {Promise<object>} `{ok, applied, slots, cards, placed, unplaced, sessionCards, hadIndex, observed, backupFile?}`
 */
export async function rebuildIndex(sessionId, { events = null, apply = false } = {}) {
	const sid = sessionId;
	try {
		const kit = await loadKit();
		if (!kit) return { ok: false, reason: "banner-kit" };
		const shard = readShard(kit, sid);
		if (!Array.isArray(shard.entries) || !shard.entries.length) return { ok: false, reason: "shard-empty" };
		// 可选回放：`observeRow` 自己按 `ROW_RULES` 过滤（非白名单类型只计数、不建行）
		let observed = 0;
		if (Array.isArray(events)) {
			for (const ev of events) {
				const r = observeRow(sid, ev);
				if (r && r.accepted === true) observed += 1;
			}
		}
		// 预演：与 `flushSlots` **同一合并函数**算行事实（盘上 rows ＋ 内存 pending），只算不写
		const preview = buildIndex(sid, shard.entries, slotsFor(sid), rowStatsFor(sid));
		const face = {
			ok: true, applied: false, sessionId: sid === undefined ? null : sid,
			shardEntries: shard.entries.length,
			slots: Array.isArray(preview.slots) ? preview.slots.length : 0,
			cards: Array.isArray(preview.cards) ? preview.cards.length : 0,
			placed: Number(preview.counters?.placed) || 0,
			unplaced: Number(preview.counters?.unplaced) || 0,
			sessionCards: Number(preview.counters?.sessionCards) || 0,
			hadIndex: readIndex(sid).ok === true, observed
		};
		if (apply !== true) {
			// 预演不留内存增量（`observeRow` 可能塞了 `pendingSlots`/`unknownRowTypeDelta`）⇒ 清掉，禁副作用
			try { pendingSlots.delete(sid); } catch { /* 忽略 */ }
			try { unknownRowTypeDelta.delete(sid); } catch { /* 忽略 */ }
			return face;
		}
		// 写前备份（盘上已有 ② 时）
		let backupFile = null;
		const file = indexFile(sid);
		try {
			if (existsSync(file)) {
				backupFile = `${file}.bak-${Date.now()}`;
				copyFileSync(file, backupFile);
				try { chmodSync(backupFile, 0o600); } catch { /* 某些 FS 不支持 chmod */ }
			}
		} catch (err) {
			return { ok: false, reason: `backup-failed:${String(err?.message ?? err)}` };
		}
		// 唯一写路径：`flushSlots` 落行事实（有增量才写）＋ `writeIndex` 重建 ②
		const fl = await flushSlots(sid);
		if (!fl || fl.ok !== true) return { ok: false, reason: fl?.reason || "flush-failed", backupFile };
		// ★A90 修（A84 引入的回归）：`flushSlots` 在"行事实无变化"时**空转短路**（不再重建 ②）⇒ 本工具
		//   的 apply 会"报 APPLIED 但 ② 没变"（实测：真源 78 卡已 placed，索引仍 77/1）。⇒ 短路时由工具
		//   自己写回预览（工具是显式写者；写前备份已在上方完成）。
		let idx = fl.index;
		if (!idx) {
			const w = writeIndex(sid, preview);
			if (!w.ok) return { ok: false, reason: w.reason, backupFile };
			idx = preview;
		}
		resetOplogSeqCache();   // §12.6②：同进程写者写完后必须清 ① 的 seq 缓存（跨进程靠 mtime 兜）
		return {
			...face, applied: true, backupFile, file,
			flushed: { added: fl.added, total: fl.total, migrated: fl.migrated },
			slots: Array.isArray(idx.slots) ? idx.slots.length : face.slots,
			cards: Array.isArray(idx.cards) ? idx.cards.length : face.cards,
			placed: Number(idx.counters?.placed) || 0,
			unplaced: Number(idx.counters?.unplaced) || 0,
			sessionCards: Number(idx.counters?.sessionCards) || 0,
			...(fl.indexDegraded ? { indexDegraded: fl.indexDegraded } : {})
		};
	} catch (err) {
		return { ok: false, reason: `rebuild-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * ★ **`#A71` 三（数据修复口，**非热路径**，唯一调用方 = `tools/recount-unknown.mjs`）**：
 *   按「当前会话日志**可见事件**」**重算**未知类型统计，把盘上旧值里升级前重复累加的部分洗掉。
 *
 *   **为什么必须做**（不是"只改数字"）：
 *     · `#A71` 的水位只防**新增**累加（`seq ≤ 水位` 不再计）；盘上旧值在升级前已按"每次进程启动回填一遍"
 *       叠加（实测 `b005b8fd`：日志 `job/registered` 419 条 / 盘上 3,386 = **8.08×**；`assistant/attempt` 30→270 ≈9×）。
 *     · 旧值不清 ⇒ ① `counters.unknownRowTypes` 继续上屏一个**不存在**的数；② 首次重放还会把非 `job` 类型
 *       再叠加一遍（水位从 0 起步）⇒ **修复反而多计一次**。
 *   **口径**：`counts` 必由调用方按 `isCountedUnknownType` 过滤后传入（本文件不另立第二套判据）；
 *     重算结果 = **当前日志里真实存在且应计的行类型外事件数**（日志若已压缩，则**如实少于**历史值 —— 以现存为真）。
 *   **纪律**：① 只改 `stats.unknownRowTypes/unknownRowTypesTotal/unknownSeqMax`，**`rows` 一字不动**；
 *     ② 写前**备份** `<file>.bak-<ts>`（失败 ⇒ **不写**）；③ 写入复用**同一原子写**（`tmp-<pid>-<ts>` + `rename`）
 *     ⇒ **禁第二套写实现**；④ `apply !== true` ⇒ **纯预演零写盘**。
 *   ⚠️ 本函数**不重建 ②**；调用方随后调 `rebuildIndex(sid,{apply:true})` 让 `counters` 同源刷新（② 的 `unknownRowTypes`
 *      由 `buildIndex` 用 `rowUnknownTotal(rowStats)` 算 == 本函数写入的 `stats`）。
 *
 * @param {string} sessionId
 * @param {Map<string,number>|Record<string,number>} counts 已按 `isCountedUnknownType` 过滤的类型→次数
 * @param {number} seqMax 本次重算**覆盖到的最大事件 `seq`**（之后的重放一律 `≤ 水位` ⇒ 不再计）
 * @param {{apply?:boolean}} [opts]
 * @returns {{ok:boolean, applied:boolean, file:string, before:object, after:object, backupFile?:string, reason?:string}}
 */
export function recountUnknownStats(sessionId, counts, seqMax, { apply = false } = {}) {
	const file = slotsFile(sessionId);
	const snap = readSlots(sessionId);
	const before = { unknownRowTypes: { ...(snap.stats.unknownRowTypes || {}) }, unknownRowTypesTotal: Number(snap.stats.unknownRowTypesTotal) || 0, unknownSeqMax: Number(snap.stats.unknownSeqMax) || 0 };
	const u = {};
	for (const [k, v] of (counts instanceof Map ? counts.entries() : Object.entries(counts || {}))) {
		if (!isCountedUnknownType(k)) continue;           // 双保险：调用方传错也不污染口径
		const n = Number(v) || 0;
		if (n > 0) u[k] = n;
	}
	let total = 0;
	for (const v of Object.values(u)) total += v;
	const wm = Number.isFinite(seqMax) && seqMax > 0 ? Math.floor(seqMax) : 0;
	const after = { unknownRowTypes: u, unknownRowTypesTotal: total, unknownSeqMax: Math.max(wm, before.unknownSeqMax) };
	if (apply !== true) return { ok: true, applied: false, file, before, after };
	let backupFile;
	try {
		if (existsSync(file)) {
			backupFile = `${file}.bak-${Date.now()}`;
			copyFileSync(file, backupFile);
			try { chmodSync(backupFile, 0o600); } catch { /* 某些 FS 不支持 chmod */ }
		}
	} catch (err) {
		return { ok: false, applied: false, file, before, after, reason: `backup-failed:${String(err?.message ?? err)}` };
	}
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// 保留盘上既有顶层键（版本、rows 等）⇒ **只替换 `stats`**
		const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { v: 1, sessionId, rows: [] };
		const face = { ...raw, stats: { ...(raw.stats && typeof raw.stats === "object" ? raw.stats : {}), ...after } };
		if (!Array.isArray(face.rows)) face.rows = [];
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(face, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
		unknownSeqMax.set(sessionId, after.unknownSeqMax);   // 同进程内立即可用（否则下一次重放又按 0 起算）
		noSeqCounted.set(sessionId, new Set(Object.keys(u))); // ★`#A71` 二：无 seq 事件的类型去重集同步成盘上键集
		try { unknownRowTypeDelta.delete(sessionId); } catch { /* 忽略 */ }
		return { ok: true, applied: true, file, before, after, ...(backupFile ? { backupFile } : {}) };
	} catch (err) {
		return { ok: false, applied: false, file, before, after, ...(backupFile ? { backupFile } : {}), reason: `recount-io:${String(err?.message ?? err)}` };
	}
}

/** 供写路径用：磁盘行 + pending（**不落盘**）⇒ 使同一次写操作也能立刻看到刚到的行 */
function slotsFor(sessionId) {
	const rows = readSlots(sessionId).rows.slice();
	const pend = pendingSlots.get(sessionId);
	if (pend) for (const r of pend.values()) if (!rows.some((x) => x.slotId === r.slotId)) rows.push(r);
	return rows;
}

/** 供写路径用：行事实面的观测统计（盘上 + 内存增量；**与 `flushSlots` 同一合并函数**，禁两处各写一份） */
function rowStatsFor(sessionId) {
	return mergeRowStats(readSlots(sessionId).stats, unknownRowTypeDelta.get(sessionId));
}

/**
 * 追加 ① 一条记录（**只增、永不改写**）。永不 throw。
 * @returns `{ok:true, seq}` | `{ok:false, reason}`（`oplog-io:<…>`）
 */
function appendOplog(sessionId, rec) {
	const file = oplogFile(sessionId);
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const seq = nextOplogSeq(file);
		const line = `${JSON.stringify({ v: OPLOG_VERSION, seq, at: new Date().toISOString(), ...rec })}\n`;
		appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
		try { chmodSync(file, 0o600); } catch { /* 某些 FS 不支持 chmod */ }
		// 自身写入后**失效缓存**（下次 `nextOplogSeq` 只读 4KB 尾部重建，不整份读）——§12.6
		oplogSeqCache.delete(file);
		return { ok: true, seq };
	} catch (err) {
		oplogSeqCache.delete(file);
		return { ok: false, reason: `oplog-io:${String(err?.message ?? err)}` };
	}
}

/**
 * **`(e)④`（设计稿 §5.2 (ii) 类）"无行 ⇒ 会话级卡"的 kind 白名单** ——
 *   (ii) 类 = **由内部 tick / 排程器相位 / 系统自愈产生、没有任何对应行**的卡：
 *   自动派发（taskqueue）/ 重启相位 `scheduled→observing→exiting` / `invalid` 自愈 / 系统熔断。
 *   ⇒ 机械判据 = **该 kind 属本白名单** **且** **行事实查不到（`reason === "no-anchor"`，即条目自己没声明
 *   `anchorSeq`、`ctxKey`/`turn` 也都试匹配不上）** ⇒ 声明为**会话级卡**（`placeState:"session"`）：
 *   **不进行、不进 `unplaced[]`** ⇒ `counters.unplaced` **不被污染**（判据 8），渲染走状态卡区块
 *   （`stateCards.kind:"session"`，F2 分区）。
 *   ⚠️ **`anchor-mismatch`（自己声明了 `anchorSeq` 却查不到行）不走本分支** ⇒ 仍如实 `unplaced + 降级`
 *     （⇒ "人为塞 `anchorSeq`" 的正控**必红**）。
 *   ⚠️ **不需要生产者新增键**（`#A229` 五 b1–b4 零契约改动；不引入 `rowless` 出网标记）。
 */
const ROWLESS_KINDS = new Set(["queue", "restart"]);

/**
 * 由分片 entries **纯函数**推出 ②（⇒ ② 无隐藏状态、恒可重建）。
 * 形状 = 设计稿 §4.1：`{v, sessionId, orderHash, cards[], unplaced[], counters, updatedAt}`。
 * **"未定位"是一等公民**：`placeState ∈ {placed, unplaced}` 二值 + 独立 `unplaced[]`
 * ⇒ **结构上无法表达"就近落"**（计划 v5 §6 裁决 #7）。
 * ⚠️ 两处**待钉**（2a-2，`#A201` 一「明确不做」）：`slotId`（U5 残留 = 行定义 kind 字面量）
 *    与 `orderHash`（插件注册序快照 `ORDER-SNAPSHOT`）。
 * ★ obs3S7 段W-2b `(e)④`：新增第三值 `placeState:"session"`（会话级卡，**不进 `unplaced[]`**）；
 *   `rowStats` = 行事实面的观测统计（`unknownRowTypes`）⇒ `counters.unknownRowTypes`（观测 #3）。
 */
function buildIndex(sessionId, entries, rows = [], rowStats = {}) {
	const list = Array.isArray(rows) ? rows : [];
	// 行事实 → `seq → slotId`（**全部已登记 kind**，T3 起不再只收 `tool-call`；其余不入表 ⇒ **不猜**）
	// `turn → slotId`（T3：§12.4「生产者未声明 `anchorSeq` ⇒ 由 `ctxKey`/`turn` 试匹配」的 `turn` 臂）
	//   ★ **T9-fix（仲裁 `#A231` 三 采「丙」）**：turn 臂内 **优先 `turn-tail<turn>`**（= 回合尾行，
	//   账本/费用/状态族的**已接受落点**，台账 `#41` 三源合判），**无则回落 `turn-process<turn>`**（回合进行中
	//   尚无 `turn-tail` 行）⇒ **统一规则、不按 kind 分叉**。
	//   不做"后到升级"（`#A231` 三 明确不做「甲」）：`buildIndex` 是 **(条目, 行事实) 的纯函数** ⇒
	//   `turn/end` 到达后的**下一次重建自然收敛**到 `turn-tail`；无需显式升级、**不改 ①**、无计数抖动窗口。
	//   ⚠️ 与 `:282-286` 自身注释一致：若把该族错映射成 `turn-process` = **可见位置回归**（回合容器行）。
	// ★ **T-A（2026-09-21 obs3S7；用户已签）新增 `commandId → slotId` 臂**：命令面卡的**官方行身份**
	//   = `command` 行（`计划 §4【裁决 #8】`／设计件 §⑭B 允许集合成员）⇒ 由行事实面里 `defKind === "command"`
	//   的行按 `id`（= 宿主 `commandId`）反查。**缺此臂 ⇒ 带 `commandId` 的卡在 ② 里恒判 `no-anchor`**
	//   （T-B 起 A 只认权威落点 ⇒ 命令面卡会**全部落到 `pending`**）⇒ 属"位置判定搬回 B"的必要件。
	//   **只增臂、不改既有臂次序**（`anchorSeq` 优先；`ctxKey`/`turn` 保持原位，其次序语义不变）。
	// ★ **`T-G`（`#A71` 裁决一）**：三个臂的构建**下沉到共用 `rowResolvers()`**（入口校验 `gateVerdict()`
	//   用**同一实现**，杜绝"两处各写一份臂、口径漂移"）；臂的**次序与语义逐字未变**。
	// ★ **形态兜底（`#A234` 零 唯一要求）**：`slotId` 的契约形态 = **`<len>:<kind><id>`**（`rowSlotId`）。
	//   **不得用子串匹配判族**（`includes(":turn-tail")` 会把"kind 里恰好含该子串"的**非 tail 族**误判为 tail）；
	//   形态**非法** ⇒ **如实计数 + 不猜**（⇒ `counters.malformedSlots`，可 grep、可上屏）⇒ **绝不静默跳过**。
	const { bySeq, byTurn, byCmd } = rowResolvers(list);
	const malformed = [];
	// 本循环只保留 `malformedSlots` 的**形态观测**（口径与位置臂无关，纯计数）。
	for (const r of list) {
		if (typeof r?.slotId !== "string" || !r.slotId) continue;
		if (Number.isInteger(r.turn) && slotKindOf(r.slotId) === null) {
			if (malformed.length < 5) malformed.push(String(r.slotId).slice(0, 48));
		}
	}
	const cards = [];
	const unplaced = [];
	// `(e)④`：会话级卡（(ii) 类）——**独立集合**（既不进 `slots[]`、也不进 `unplaced[]`）
	const sessionCards = [];
	for (const e of Array.isArray(entries) ? entries : []) {
		const anchor = Number.isInteger(e?.anchorSeq) ? e.anchorSeq : null;
		let slotId = null;
		let reason = null;
		if (anchor !== null) {
			// 声明了锚点：**只认"该 seq 真有对应行"**；查不到 ⇒ **禁止就近落**（计划 v5 §6 / 设计稿 §12.4）
			slotId = bySeq.get(anchor) ?? null;
			if (!slotId) reason = "anchor-mismatch";
		} else {
			// ★ T-A：**`commandId` 臂**（命令面卡的官方行身份 ⇒ `command` 行）—— 命中即权威落点；
			//   未命中**不报错、继续走既有臂**（缺行 ⇒ 最终 `no-anchor`／T-B 下如实 `pending`，不猜）。
			if (typeof e?.commandId === "string" && e.commandId && byCmd.has(e.commandId)) slotId = byCmd.get(e.commandId);
			// §12.4：未声明锚点 ⇒ **由 `ctxKey`（内嵌真实锚点 seq）/`turn` 试匹配**；不中 ⇒ `no-anchor`
			const m = typeof e?.ctxKey === "string" ? /^(?:cost|ledger)-(\d{4,})$/.exec(e.ctxKey) : null;
			if (slotId === null && m && bySeq.has(Number(m[1]))) slotId = bySeq.get(Number(m[1]));
			else if (slotId === null && Number.isInteger(e?.turn) && byTurn.has(e.turn)) slotId = byTurn.get(e.turn);
			if (!slotId) reason = "no-anchor";
		}
		const card = {
			cardId: typeof e?.cardId === "string" ? e.cardId : null,
			owner: typeof e?.source === "string" ? e.source : null,
			kind: e?.kind ?? null,
			at: Number.isFinite(e?.at) ? e.at : null,
			turn: Number.isInteger(e?.turn) ? e.turn : null,
			ctxKey: typeof e?.ctxKey === "string" ? e.ctxKey : null,
			anchorSeq: anchor,
			slotId,
			placeState: slotId ? "placed" : "unplaced",
			reason: slotId ? null : reason,
			// ★A94：范围只影响**异常判定**，不影响落位机制（有行就 placed，没行再按 anchorLevel 归类）
			anchorLevel: anchorLevelOf(e)
		};
		// ★ `(e)④`（设计稿 §5.2 (ii)）：**白名单 kind + 行事实查不到 ⇒ 会话级卡**
		//   ⇒ **不进行、不进 `unplaced[]`**（`counters.unplaced` 不被污染）；A 侧从状态卡区块渲染。
		//   ⚠️ **收紧条件（本行 = 实现细化，理由随附）**：还须 **`turn` 不是整数** ——
		//     ① 真 (ii) 类的发射侧**本来就带 `turn: null`**（机械核查：`dsh-taskqueue/lib/index.js:566`
		//        显式 `turn: null`；`dsh-graceful-restart/lib/index.js` 的 `bannerData()` **不含 `turn`**）
		//        ⇒ 收紧后**仍覆盖全部真 (ii) 类**；
		//     ② 反之，**带整数 `turn` 却查不到行** = "行事实面尚未到达"（窗口/时点问题）而**不是**"设计上无行"
		//        ⇒ 保持 `unplaced`（**不把时点问题伪装成"设计如此"**）；这也让既有正控 `B4-N`
		//        （撤掉回合行登记 ⇒ 该族卡必回 `unplaced`）**继续成立**。
		if (!slotId && reason === "no-anchor" && !Number.isInteger(e?.turn) && ROWLESS_KINDS.has(String(e?.kind))) {
			card.placeState = "session";
			card.reason = null;
			sessionCards.push({ cardId: card.cardId, owner: card.owner, kind: card.kind, ctxKey: card.ctxKey, anchorLevel: card.anchorLevel });
		}
		cards.push(card);
		if (card.placeState === "unplaced") unplaced.push({ cardId: card.cardId, owner: card.owner, reason: card.reason, kind: card.kind, anchorLevel: card.anchorLevel });
	}
	// **T8 乙（b2 残留，如实计数）**：带身份条目若存在**多个**同 `ctxKey` 无身份孪生 ⇒ **未收养**（不猜、不并）
	//   ⇒ `counters.adoptAmbiguous`（② 可 grep、可上屏）；用**同一个** `findLegacyTwins`（b4：禁两处各写一份）。
	let adoptAmbiguous = 0;
	for (const e of Array.isArray(entries) ? entries : []) {
		if (!e || typeof e.cardId !== "string") continue;
		const t = findLegacyTwins(entries, { kind: e.kind, owner: e.source ?? null, ctxKey: e.ctxKey });
		if (t.ok === true && t.hits.length > 1) adoptAmbiguous += 1;
	}
	return {
		v: INDEX_VERSION,
		sessionId: sessionId === undefined ? null : sessionId,
		orderHash: null,
		slots: list.map((r) => ({ slotId: r.slotId, defKind: r.defKind, id: r.id, seq: r.seq, turn: r.turn, step: r.step })),
		cards,
		unplaced,
		// `(e)④`：**会话级卡**集合（(ii) 类；A 侧据此把它们从"行内渲染 / 未定位区"里剔除，
		//   改由状态卡区块（`stateCards.kind:"session"`）承载）——**只增键**，老读者忽略即可。
		sessionCards,
		// `counters` 只增键（`#A201` 一 口径）：新增 `sessionCards`（(ii) 类会话级卡）/`orphans`
		//   （有卡无槽 = `anchor-mismatch`）/`unknownRowTypes`（观测 #3，来自行事实面 `stats`）。
		counters: {
			cards: cards.length,
			placed: cards.length - unplaced.length - sessionCards.length,
			unplaced: unplaced.length,
			slots: list.length,
			malformedSlots: malformed.length,
			adoptAmbiguous,
			sessionCards: sessionCards.length,
			orphans: cards.filter((c) => c.placeState === "unplaced" && c.reason === "anchor-mismatch").length,
			unknownRowTypes: rowUnknownTotal(rowStats)   // ★ `#A247` 一：只含**真未知类型**（「不计入」清单已剔除）
		},
		updatedAt: new Date().toISOString()
	};
}

/* ------------------------------------------------------------------ T8 乙「单向收养」（obs3S7 段W-2b (c) 段） */

/**
 * **收养白名单（b3）**：`ctxKey ↔ 逻辑卡` 的基数**因 kind 而异** —— `cost-<seq>` 是 **1:1**；
 * 而 `queue-<taskId>` 一族同一 `ctxKey` 对应 **≥4 张语义不同的卡**（台账 `#33` Q-2）⇒ 泛化收养会**误并**。
 * ⇒ **本批只 `cost`**；新增 kind 必须先给"1:1"的机械证据 + 一条"同 `ctxKey` 不同卡不得被并"的正控。
 */
const ADOPT_KINDS = new Set(["cost"]);

/** **一键旁路（b6）**：`DSH_NOTICE_ADOPT_LEGACY="0"` ⇒ 关闭收养（回到"两张"现状，**不产生数据不可逆**） */
function adoptEnabled() {
	return process.env.DSH_NOTICE_ADOPT_LEGACY !== "0";
}

/**
 * **b2 谓词（单一实现函数；b4：与重放路径共用，禁两处各写一份）** —— 在既有条目里找"同一逻辑卡"的
 * **无身份孪生**：同 `kind` + 同 `owner`（逐字）+ **对侧 `cardId` 缺失** + `ctxKey` **非空且逐字相等**。
 * @returns `{ok:true, hits:[{index, entry}]}`｜`{ok:false, reason, hits:[]}`（`kind-not-whitelisted` / `no-ctxkey`）
 */
function findLegacyTwins(entries, { kind, owner, ctxKey }) {
	if (!ADOPT_KINDS.has(String(kind))) return { ok: false, reason: "kind-not-whitelisted", hits: [] };
	if (typeof ctxKey !== "string" || ctxKey === "") return { ok: false, reason: "no-ctxkey", hits: [] };
	const hits = [];
	const list = Array.isArray(entries) ? entries : [];
	for (let i = 0; i < list.length; i++) {
		const e = list[i];
		if (!e || typeof e.cardId === "string") continue;      // 对侧**无**身份（有身份者走 cardId 幂等，不收养）
		if (e.kind !== kind) continue;
		if ((e.source ?? null) !== (owner ?? null)) continue;
		if (e.ctxKey !== ctxKey) continue;
		hits.push({ index: i, entry: e });
	}
	return { ok: true, hits };
}

/* ------------------------------------------------------------------ obs3S7 段W-2b `(d)` 写者锁守卫
 * ★ 口径（设计稿 §4.1/§4.2；`#A230` §四 改判后 = **守卫面精确等于工具写回面**）：
 *   · 守卫面 = **只 `index/<sid>.json`（含同族 `.bak-<ts>`）一族** —— 工具侧唯一写回面（`oplog-replay.mjs --apply`
 *     → `applyReplayFromOplog()` → `writeIndex()`）；**卡分片与 `slots/` 不挡**（盲窗最小化）；**① `oplog` 永不挡**。
 *   · 锁由**工具侧**落（`.banner-writer.lock`，形状 `{pid, startedAt, tool}`）；**B 侧只识别、不创建、不删除**。
 *   · 三态：**真锁**（`pid` 存活 **或** `age < LOCK_STALE_MS`）⇒ **跳过 ② 写** ＋ ① 留痕 `reason:"writer-lock"`
 *     （⇒ 告警卡 + `counts.writerLock` 如实可读）＋ **① 照写**；**陈旧锁**（`pid` 不在 **且** `age ≥ LOCK_STALE_MS`）
 *     ⇒ **照写** ＋ 只记一条 `stale-lock` 信息行（**不出告警卡**，防"狼来了"）；**不可读**（权限/IO/非文件）
 *     ⇒ **如实降级**：① 留痕 `writer-lock-unreadable:*` ＋ **不阻断**（阻断 = 永久停写，比盲窗更坏；口径已在插件手册写明）。
 *   · **不重试放大**（沿 `#A220` 四 降级纪律）：一次写尝试最多留一条 ① 痕。
 *   · `pid === 0` / 非整数 ⇒ 视为**不可判** ⇒ **只看 `age`**，并在痕里标注 `pidUnknown`。
 */
const LOCK_NAME = ".banner-writer.lock";
const LOCK_STALE_MS = 120000;

/** 读锁面（**只读**；永不 throw）⇒ `{state: "absent"|"fresh"|"stale"|"unreadable", …}` */
function lockState() {
	const file = join(storeRoot(), LOCK_NAME);
	let st = null;
	try { st = statSync(file); } catch (err) {
		const code = String(err?.code ?? "");
		if (code === "ENOENT") return { state: "absent", file };
		return { state: "unreadable", file, reason: `stat:${code || String(err?.message ?? err)}` };
	}
	let body = null;
	try { body = JSON.parse(readFileSync(file, "utf8")); } catch (err) {
		// 目录 / 权限 / 坏 JSON ⇒ **面不可读**（**不静默**：由调用方留痕降级）
		return { state: "unreadable", file, reason: `read:${String(err?.code ?? err?.message ?? err)}` };
	}
	const pid = Number.isInteger(body?.pid) ? body.pid : null;
	const ageMs = Date.now() - (Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0);
	let alive = null;                                  // null = **不可判**（pid 缺/为 0）
	if (pid !== null && pid > 0) {
		try { process.kill(pid, 0); alive = true; }
		catch (err) { alive = String(err?.code ?? "") === "EPERM" ? true : false; }
	}
	const info = { file, pid, ageMs, alive, pidUnknown: alive === null, tool: typeof body?.tool === "string" ? body.tool : null };
	// **真锁** = `pid` 存活 **或** `age < LOCK_STALE_MS`（沿设计稿 §4.2 表）
	if (alive === true || ageMs < LOCK_STALE_MS) return { state: "fresh", ...info };
	return { state: "stale", ...info };
}

/** 原子写 ②（tmp → rename；0600）。永不 throw。 */
function writeIndex(sessionId, idx, { bypassLock = false } = {}) {
	// ★ `(d)` **写前守卫**（唯一落点 = 本函数 = 工具写回面）：
	//   `bypassLock` **只由 `applyReplayFromOplog()` 传** —— 工具**自己持锁**（它就是锁的持有者，不是受害者），
	//   否则工具写回会被自己的锁挡掉 ⇒ `--apply` 静默失效（**判据 D4 会红**）。
	if (bypassLock !== true) {
		const L = lockState();
		if (L.state === "fresh") {
			const who = `pid=${L.pid ?? (L.pidUnknown ? "unknown" : "?")}/age=${L.ageMs}ms${L.tool ? `/tool=${L.tool}` : ""}`;
			appendOplog(sessionId, { op: "PUT", owner: "system", cardId: null, slotId: null, sessionId, result: "rejected", reason: "writer-lock", snapshot: null });
			return { ok: true, skipped: "writer-lock", lock: { ...L, who } };
		}
		if (L.state === "unreadable") {
			appendOplog(sessionId, { op: "PUT", owner: "system", cardId: null, slotId: null, sessionId, result: "rejected", reason: `writer-lock-unreadable:${String(L.reason ?? "")}`, snapshot: null });
			// 面不可读 ⇒ **照写**（fail-open；口径：阻断 = 永久停写，比一次盲窗更坏）＋ ① 留痕 ⇒ **不静默**
		} else if (L.state === "stale") {
			appendOplog(sessionId, { op: "PUT", owner: "system", cardId: null, slotId: null, sessionId, result: "ok", reason: `stale-lock:pid=${L.pid ?? "unknown"}/age=${L.ageMs}ms`, snapshot: null });
			// 陈旧锁 ⇒ **照写**（**不得永久停写**）；`result:"ok"` ⇒ **不进告警卡**（只作可 grep 的信息痕）
		}
	}
	// 以下为原实现（原子写 tmp → rename；0600；永不 throw）
	const file = indexFile(sessionId);
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(idx, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `index-io:${String(err?.message ?? err)}` };
	}
}

/* ------------------------------------------------------------------ 导出面（设计稿 §3 的 5 项） */

/**
 * **唯一写入口**（obs3S7 段W-2a 件B）：读分片 → **判身份 / 定 `op`** → **写①** → 写分片 → 写②。永不 throw。
 *
 * 身份与 `op`（计划 v5 §3.5 三条硬口径）：
 *   · `entry.cardId` 合法 ⇒ **按 `cardId` 匹配**（命中 ⇒ `PUT` 原地更新、**忽略** `rev`/`mode`；未命中 ⇒ `POST`）；
 *   · 无 `cardId` / 显式 `null` ⇒ **逐字走旧路径**（`decideRevMode` 一字不改；命中旧三元组 ⇒ `PUT`，否则 `POST`）。
 * `occ` = **store 侧生效三元组**（`#53` 教训：日志与分片两处 `rev` 不等 ⇒ 必须在此给出单一权威解释）。
 * 失败语义：**① 失败 ⇒ 分片不写、② 不写**；分片写失败 ⇒ **追加**一条 `rejected` ① 行更正（① 只增、绝不改写）。
 */
async function commit({ entry, owner = null, slotId = null, truncated = false }) {
	const kit = await loadKit();
	if (!kit) return { ok: false, reason: "banner-kit" };
	const sessionId = entry.sessionId;
	const cur = readShard(kit, sessionId);
	const hasCardId = typeof entry.cardId === "string";
	// ---- **T8 乙「单向收养」（b1：落点 = 本函数内、`existed` 判定之前；不得改 `banner-kit`）** ----
	//   b2 谓词（单一实现 = `findLegacyTwins`）：同 kind + 同 owner + 对侧 `cardId` 缺失 + `ctxKey` 非空逐字相等 + **候选唯一**；
	//   **候选 > 1 ⇒ 不收养**（不猜、不并）⇒ 歧义由 ② `counters.adoptAmbiguous` 如实计数。
	//   b4：收养在 ① **留痕**（`op:"PUT"` + `reason:"adopt-legacy:<孪生标识>"`；标识 = `kind@rev<r>/<mode>`，**零新增 ① 键**）。
	//   b6：`DSH_NOTICE_ADOPT_LEGACY="0"` **一键旁路** ⇒ 回到现状（两张），不产生数据不可逆。
	let adoptedOcc = null;
	let baseEntries = cur.entries;
	if (hasCardId && adoptEnabled()) {
		const t = findLegacyTwins(cur.entries, { kind: entry.kind, owner: owner ?? (typeof entry.source === "string" ? entry.source : null), ctxKey: entry.ctxKey });
		if (t.ok === true && t.hits.length === 1) {
			const twin = t.hits[0].entry;
			baseEntries = cur.entries.slice();
			baseEntries[t.hits[0].index] = { ...entry };      // **就地替换**无身份孪生 ⇒ 其后按 `cardId` 幂等 ⇒ 仍恰 1 条
			adoptedOcc = `${String(twin.kind)}@rev${String(twin.rev)}/${String(twin.mode ?? "start")}`;
		}
	}
	const existed = hasCardId
		? (adoptedOcc !== null ? true : cur.entries.some((e) => e.cardId === entry.cardId))
		: cur.entries.some((e) => e.kind === entry.kind && e.rev === entry.rev && (e.mode ?? "start") === (entry.mode ?? "start"));
	const op = existed ? "PUT" : "POST";
	const dec = hasCardId
		? { mode: entry.mode, rev: entry.rev } // ★身份由 cardId 承担 ⇒ **不参与 rev 计数**（两套身份并存即 `#53` 病根）
		: (entry.mode === "replace" ? kit.decideRevMode(cur.entries, { kind: entry.kind, replace: true }) : { mode: "start", rev: entry.rev });
	const finalEntry = { ...entry, mode: dec.mode, rev: dec.rev };
	const merged = kit.mergeEntries(baseEntries, finalEntry, { maxEntries: MAX_ENTRIES });
	const base = {
		op,
		owner: typeof owner === "string" ? owner : (typeof entry.source === "string" ? entry.source : null),
		cardId: hasCardId ? entry.cardId : null,
		slotId,
		sessionId: sessionId === undefined ? null : sessionId,
		occ: { kind: finalEntry.kind, rev: finalEntry.rev, mode: finalEntry.mode, at: Number.isFinite(finalEntry.at) ? finalEntry.at : null }
	};
	const o = appendOplog(sessionId, { ...base, result: "ok", reason: adoptedOcc ? `adopt-legacy:${adoptedOcc}` : null, snapshot: finalEntry });
	if (!o.ok) return { ok: false, reason: o.reason };
	const w = writeShardFile(shardFile(sessionId), merged.entries);
	if (!w.ok) {
		appendOplog(sessionId, { ...base, result: "rejected", reason: w.reason, snapshot: null, correctsSeq: o.seq });
		return { ok: false, reason: w.reason };
	}
	const wi = writeIndex(sessionId, buildIndex(sessionId, merged.entries, slotsFor(sessionId), rowStatsFor(sessionId)));
	return {
		ok: true, mode: dec.mode, rev: dec.rev, evicted: merged.evicted, truncated,
		dropped: cur.dropped, rebuilt: cur.rebuilt === true, op, seq: o.seq,
		cardId: hasCardId ? entry.cardId : null,
		...(wi.ok ? {} : { indexDegraded: wi.reason })
	};
}

/**
 * 追加 / 原地替换一条 entry（**store 是唯一写者**）。
 *   · `cardId` 合法 ⇒ `cardId` 幂等（`PUT` 原地更新；见 `commit`）；
 *   · `raw.mode === "replace"` ⇒ 走 `decideRevMode`（同 kind 的 rev 语义，逐值等价旧 `notice/banner-replace`）；
 *   · 其余 ⇒ `start` + `rev = raw.rev ?? 0`；
 *   · 合并用 `mergeEntries`（同 `(kind,rev,mode)` 幂等覆盖，超 2000 按 `at` 淘汰最旧）。
 *   · 校验失败 ⇒ **写入类错误**：① 记一条 `rejected`（**不降级、不静默**）+ 原样返回原因给生产者。
 * @returns `{ok:true, mode, rev, evicted, truncated, dropped, rebuilt, op, seq, cardId?}` | `{ok:false, reason}`
 */
export async function appendEntry(raw) {
	try {
		const kit = await loadKit();
		if (!kit) return { ok: false, reason: "banner-kit" }; // 缺共享库 ⇒ store 整体禁用（不半开）
		const v = kit.validateEntry(raw);
		if (!v.ok) {
			const sid = raw && typeof raw === "object" && !Array.isArray(raw) && (raw.sessionId === null || typeof raw.sessionId === "string") ? raw.sessionId : null;
			appendOplog(sid, {
				op: "POST", owner: raw && typeof raw.source === "string" ? raw.source : null, cardId: null, slotId: null,
				sessionId: sid, result: "rejected", reason: `${v.reason}${v.key ? `:${v.key}` : ""}`, occ: null,
				// ★段2 `B6`：**被拒载荷整份原样留痕**（与下面 gate 分支同口径：`#A69` 裁决②"不脱敏、可事后重放复现"）
				//   —— 此前写死 `null` ⇒ 该档拒收**不可重放**（判"点名"只到 reason，无法复原违规载荷）。
				snapshot: (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : null
			});
			return { ok: false, reason: `bad-entry:${v.reason}${v.key ? `:${v.key}` : ""}` };
		}
		// ★★ **`T-G` 入口校验（2026-09-21 obs3S7 批 2 件①；`#A69` 派件 ＋ `#A71` 裁决一/四）** ——
		//   **放行 ⟺ (位置键 4 任一合法声明 ∧ 能解析到真实行) ∨ (`kind` ∈ {`compat`}) ∨ (族 ∈ 结构性无行申报)**
		//   的**宽松版**：`(ii)` 形状合法但"行此刻尚未存在" ⇒ **放行 ＋ 如实未定位**（`N67`：卡写入早于其命令行 ≈102ms
		//   ⇒ 严判会**灾难性误拒**全部命令类卡）。**拒收面 = 形状不合法 ＋ 位置键全缺且族未申报 ＋ 显式 `anchorSeq` 指不存在行**。
		//   **拒 ⇒ ① 记「拒绝 ＋ 请求内容」整份原样（不脱敏、须可事后重放复现）＋ `rejectedByReason` 告警面（owner 非空即可见）**。
		const gv = gateVerdict(v.entry, rowResolvers(slotsFor(v.entry.sessionId)));
		if (gv.reject === true) {
			appendOplog(v.entry.sessionId, {
				op: "POST", owner: typeof v.entry.source === "string" ? v.entry.source : null, cardId: null, slotId: null,
				sessionId: v.entry.sessionId, result: "rejected", reason: gv.code, occ: null,
				// `#A69` 裁决②（用户批复原话：「日志不脱敏 但是一定要保证完整 可以事后读取后重放复现问题」）
				//   ⇒ **整份原样**（`v.entry` 已归一化 `mode`/`rev`/`cardId` ⇒ 与真正要落的载荷逐字一致）＋ `gatedKeys` 便于 grep。
				snapshot: v.entry, gatedKeys: gv.declared
			});
			return { ok: false, reason: `gate:${gv.code}` };
		}
		return await commit({ entry: v.entry, owner: v.entry.source, truncated: v.truncated === true });
	} catch (err) {
		return { ok: false, reason: `append-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * 删除**自己的**卡（设计稿 §3 `DELETE`）：① 记一条**含被删内容**的 DELETE（⇒ 可重建）；owner 不符 ⇒ 拒绝。
 * 2a-1 无外部调用方（端点 / 工具在 2a-2），本函数供判据 7 与后续批次使用。
 */
export async function deleteCard({ sessionId = null, cardId, owner } = {}) {
	try {
		const kit = await loadKit();
		if (!kit) return { ok: false, reason: "banner-kit" };
		if (typeof cardId !== "string" || !cardId) return { ok: false, reason: "bad-argument" };
		const cur = readShard(kit, sessionId);
		const i = cur.entries.findIndex((e) => e.cardId === cardId);
		const mkRec = (result, reason, snapshot) => ({
			op: "DELETE", owner: owner ?? null, cardId, slotId: null, sessionId, result, reason,
			occ: snapshot ? { kind: snapshot.kind ?? null, rev: snapshot.rev ?? 0, mode: snapshot.mode ?? "start", at: Number.isFinite(snapshot.at) ? snapshot.at : null } : null,
			snapshot
		});
		if (i < 0) {
			appendOplog(sessionId, mkRec("rejected", "not_found", null));
			return { ok: false, reason: "not_found" };
		}
		const victim = cur.entries[i];
		if (owner !== undefined && victim.source !== owner) {
			appendOplog(sessionId, mkRec("rejected", "owner-mismatch", victim));
			return { ok: false, reason: "owner-mismatch" };
		}
		const o = appendOplog(sessionId, mkRec("ok", null, victim));
		if (!o.ok) return { ok: false, reason: o.reason };
		const rest = cur.entries.filter((_, k) => k !== i);
		const w = writeShardFile(shardFile(sessionId), rest);
		if (!w.ok) {
			appendOplog(sessionId, { ...mkRec("rejected", w.reason, null), owner: victim.source ?? null, correctsSeq: o.seq });
			return { ok: false, reason: w.reason };
		}
		const wi = writeIndex(sessionId, buildIndex(sessionId, rest, slotsFor(sessionId), rowStatsFor(sessionId)));
		return { ok: true, removed: cardId, seq: o.seq, ...(wi.ok ? {} : { indexDegraded: wi.reason }) };
	} catch (err) {
		return { ok: false, reason: `delete-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * 记一条 **渲染结果**（设计稿 §2.2 / §11；obs3S7 段W-2a **T2-a 件C**）：
 *   **只进 ①**（渲染不是写操作 ⇒ **不改分片、不改 ②**）；**同步**返回（读通道端点要求同步 handler）。
 * ★ **四字段语义（T10 定因，`log/obs3-s7/w2b-t10-verdicts.md`；`#A233` 一 更正后定稿）**：
 *   · `expect` = A 侧**本窗口应渲染数**（模型口径 = `keys.length − pending`，**不查 DOM**）；
 *   · `actual` = `expect − unplaced`；· `unplaced` = A 侧未定位键数 ⇒ **`unplaced>0 ⇒ expect≠actual ⇒ result:"mismatch"`（经 `actual` 间接参与判定）**；
 *   · **`cards` = "尾锚点这一个节点"下的卡数（逐锚点诊断口径）—— 不是面板卡数**（观测时勿据此判面板缺失；DOM 口径字段另立名 `cardsPanel`）。
 * @returns `{ok:true, seq, result}`；`result = (expect === actual) ? "ok" : "mismatch"`
 */
/** T11 看门狗阈值（**只观测**；provisional，按 T11(iv)/心跳静默读数复核 —— `#C5` 只观测、不上屏、不降级） */
export const RENDER_STALE_MS = 120000;
/** 每会话"上一次 RENDER 上报时刻 + 判别位"（**内存**；B 侧不落额外状态文件） */
const renderWatch = new Map();

export function recordRender({ sessionId = null, expect = null, actual = null, unplaced = null, unplacedRenderable = null, window = null, cards = null, cardsPanel = null, counters = null, visible = null, kindPanel = null, kindFolded = null, kindUnshown = null } = {}) {
	try {
		const num = (v) => (Number.isFinite(v) ? v : null);
		const e = num(expect), a = num(actual);
		const result = e !== null && a !== null && e === a ? "ok" : "mismatch";
		// ★ T11：`cardsPanel`（DOM 口径）/`visible`（判别位）**只增键、缺省 `null`**；**不参与 `result`**（`#C5` 只观测）
		const cp = num(cardsPanel);
		const vis = visible === true ? true : (visible === false ? false : null);
		const rec = {
			op: "RENDER", owner: "system", cardId: null, slotId: null, sessionId,
			result, reason: result === "ok" ? null : `expect=${e} actual=${a}`,
			occ: null, snapshot: null,
			expect: e, actual: a, unplaced: num(unplaced), cards: num(cards),
			window: window && typeof window === "object" ? { from: num(window.from), to: num(window.to) } : null
		};
		// ★ **缺省 = 不写键**（而非写 `null`）：老客户端（不带这两键）⇒ ① 记录与装前**逐字一致**（判据 T11a）
		if (cp !== null) rec.cardsPanel = cp;
		if (vis !== null) rec.visible = vis;
		// ★★ 批16（`#78`；用户裁「以可渲染为准、服务端同批跟」）：**只增一个键** `unplacedRenderable`
		//   ＝ A 侧算出的"**实际可渲染**的未定位张数"（唯一判据 `nsCardDropped()` 在客户端只算一次）。
		//   · 与 `unplaced`（对齐口径）**并存且不同义**：后者**保持原样**供 B 侧对账（`只登记不判改`）；
		//   · **缺省（老客户端 / 无有限数）⇒ 不写键** ⇒ 下游全部**回退老口径**（同 `cardsPanel`/`visible` 的 T11 口径）；
		//   · **不参与 `result`**（`result` 仍由 `expect/actual` 定，`actual` 仍由对齐口径派生）⇒ 本键**只影响上屏口径**。
		const unr = num(unplacedRenderable);
		if (unr !== null) rec.unplacedRenderable = unr;
		// ★ `T-E′` 前半（2026-09-21 obs3S7 `#A57`）：**只增一个键** `counters` = A 侧四个定位计数
		//   （`pending`/`pendingNoNode`/`slotIdHit`/`newRulesPending`，全为有限数才收）；**缺省 ⇒ 不写键**
		//   （老客户端 ⇒ ① 记录与装前逐字一致，同 `cardsPanel`/`visible` 的 T11 口径）；**不参与 `result`**（只观测）。
		const ctr = counters && typeof counters === "object" && !Array.isArray(counters) ? counters : null;
		const ctrOut = ctr ? { pending: num(ctr.pending), pendingNoNode: num(ctr.pendingNoNode), slotIdHit: num(ctr.slotIdHit), newRulesPending: num(ctr.newRulesPending) } : null;
		if (ctrOut) rec.counters = ctrOut;
		// ★ 批4 `#37`（范围「乙」；沿 `T11`/`T-E′` **同一口径**）：**只增三个键**
		//   · `kindPanel` = 按 `data-family` 分桶的**面板内可见卡数**（`{n, ids[], noId, idsTruncated?}`）
		//   · `kindFolded` = **折叠成因**分因（不算缺陷）｜`kindUnshown` = **真缺**（**会计红的告警信号**）
		//   **缺省（老客户端 / 补发无值 / 结构非法 / 无有限数）⇒ 键一个都不写** ⇒ ① 记录与装前**逐字一致**（判据 A6）；
		//   **不参与 `result`**、不上屏、不降级（`#C5` 只观测）。
		//   ★ **store 侧不复制白名单**（白名单单一来源在 `client.js` 的 `NOTICE_FAMILY_KINDS`；`ENV §一.6②` 禁两处各写一份）
		//     ⇒ 此处**只做结构校验**（形状 / 有限数 / 字符串 id），**不做 kind 白名单**。
		const kpIn = kindPanel && typeof kindPanel === "object" && !Array.isArray(kindPanel) ? kindPanel : null;
		let kpOut = null;
		if (kpIn) {
			kpOut = {};
			for (const k of Object.keys(kpIn)) {
				const v = kpIn[k];
				if (!v || typeof v !== "object" || Array.isArray(v)) continue;
				const nn = num(v.n);
				if (nn === null) continue;
				const ids = Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === "string") : [];
				const noId = num(v.noId);
				const o1 = { n: nn, ids, noId: noId === null ? 0 : noId };
				if (v.idsTruncated === true) o1.idsTruncated = true;   /* 只在真截断时写键（未截断 ⇒ 缺省 ⇒ 不写） */
				kpOut[k] = o1;
			}
			if (Object.keys(kpOut).length === 0) kpOut = null;   /* 全非法 ⇒ 等于缺省 ⇒ 不写键 */
		}
		/** 分因映射（`{kind: 有限数}`）；非对象 / 非有限数 ⇒ 逐项剔除；全空 ⇒ `null`（＝缺省） */
		const kindNumMap = (src) => {
			const raw = src && typeof src === "object" && !Array.isArray(src) ? src : null;
			if (!raw) return null;
			const out = {};
			for (const k of Object.keys(raw)) { const nn = num(raw[k]); if (nn !== null) out[k] = nn; }
			return Object.keys(out).length ? out : null;
		};
		const kfOut = kindNumMap(kindFolded);
		const kuOut = kindNumMap(kindUnshown);
		if (kpOut) rec.kindPanel = kpOut;
		if (kfOut) rec.kindFolded = kfOut;
		if (kuOut) rec.kindUnshown = kuOut;
		const o = appendOplog(sessionId, rec);
		if (!o.ok) return { ok: false, reason: o.reason };
		// ★ T11 心跳看门狗（**只观测、不上屏、不降级**）：**仅当本次 `visible === true`** 且"距上一次上报"超阈值 ⇒
		//   记一条 ① 痕 `reason:"render-stale:<gap>ms"`（`op:"PUT"`/`result:"ok"` ⇒ **不进告警卡、不降级**）；
		//   **判别位缺失（`visible === null`）⇒ 不判**（防把"用户切走/后台标签"报成故障）。
		//   ★ **`#A248` 四（判别位收紧）**：**还要求上一次上报也是 `visible === true`** —— 否则"用户切到别的会话
		//   （A 侧卸载 ⇒ 不再上报）→ 过阈值后切回（首报 `visible:true`）"会被读成"可见却静默" ⇒ **误报**
		//   （实测：仲裁会话 3 条 ＋ 执行会话 3 条，gap 153–551s）。A 侧已在卸载时补发一次 `visible:false`
		//   ⇒ 本条件与它配套 = 只有"**面板挂载中**却停止上报"才判 `render-stale`。
		const nowMs = Date.now();
		const prev = renderWatch.get(sessionId) || null;
		renderWatch.set(sessionId, { at: nowMs, visible: vis });
		if (prev && prev.visible === true && vis === true && Number.isFinite(prev.at) && (nowMs - prev.at) > RENDER_STALE_MS) {
			appendOplog(sessionId, { op: "PUT", owner: "system", cardId: null, slotId: null, sessionId, result: "ok", reason: `render-stale:${Math.round(nowMs - prev.at)}ms`, occ: null, snapshot: null });
		}
		return { ok: true, seq: o.seq, result };
	} catch (err) {
		return { ok: false, reason: `render-report-failed:${String(err?.message ?? err)}` };
	}
}

/** 读 ①（只读；坏行**丢弃并计数**、永不 throw） */
export function readOplog(sessionId) {
	const file = oplogFile(sessionId);
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch { return { ok: true, records: [], badLines: 0, file }; }
	const records = [];
	let badLines = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (o && typeof o === "object" && !Array.isArray(o)) records.push(o);
			else badLines++;
		} catch { badLines++; }
	}
	return { ok: true, records, badLines, file };
}

/** 读 ②（只读；永不 throw） */
export function readIndex(sessionId) {
	const file = indexFile(sessionId);
	try {
		return { ok: true, index: JSON.parse(readFileSync(file, "utf8")), file };
	} catch (err) {
		return { ok: false, reason: `index-read:${String(err?.message ?? err)}`, index: null, file };
	}
}

/* ================================================================== obs3S7 段W-2b `(a)(b)`
 * 状态卡（告警 `alert` / 错误 `degrade` / 会话级 `session`）＋ 观测七项上屏读数（**读通道，同步**）。
 * ★ 口径（设计稿 §1–§3；`#A229` 五 已裁）：
 *   · **只在读通道加一个键 `stateCards`**（`banner-kit` 载荷键集 = 冻结面 ⇒ **不动**）；
 *   · **同源铁律**：卡里的每个数都取自**写盘面**（② `index/<sid>.json` 的 `counters` ＋ ①
 *     `oplog/<sid>.jsonl` 的 `rejected`/`RENDER` 序列）⇒ 与面板读数**同一份**（判据 5 可逐项对撞）；
 *   · **降级面只含行 1/2**（`unplaced` / `expect≠actual`）；行 3–8 **不降级**（只出告警卡）；
 *   · **任何计数都不触发自动回滚**；`#C5` **只观测**；
 *   · **去重不掩盖**：视觉合一条 + `count:N`，而 ① **仍是 N 条**（`count` = ① 中同因条数 ⇒ 改 ① 必变）。
 */
const GLOBAL_TTL_MS = 60000;

/** 全局聚合（设计稿 §3.3 成本护栏）：**只读各会话 ② 的 `counters`，不读 `cards`**；**60s TTL 缓存**
 *  ★ A85：另加**脏标记** —— 写路径只 `globalCountersDirty = true`，不再立即 `computeGlobalCounters()`；
 *  取数时"脏 或 TTL 到期 或 未建"才重算一次（延迟有界 ≤60s）。显式实时入口 `refreshGlobalCounters()`。 */
let globalCountersCache = { at: 0, value: null };
let globalCountersDirty = true;

/**
 * ★ **`#A263` S3**：某会话的**窗口口径** `unplaced` = ① **末条 `RENDER`** 的 `unplaced`（A 侧"本窗口未定位键数"）。
 *   与 `#A253` 一(b) 的降级门同源（窗口外历史卡既不渲染、也不计 `unplaced`）。
 *   **末条 `RENDER` 不可得**（oplog 不可读 / 无 `RENDER` 记录 / 值非有限）⇒ 返回 `null` ⇒ 调用方**如实回退**盘上累计值。
 *   实现：整读 oplog 后**自尾向头**扫（命中即返回），坏行跳过；oplog 总量级 ≈1.3 MB / 23 会话（TTL 60s 内至多一轮）。
 * @param {string} sessionId
 * @returns {number|null}
 */
/** 异常样本**有界**收集（≤6 条；owner ＋ 族/码）——供 A 侧"点名插件名"；**不做全量明细**（体积/脱敏两面）。 */
function pushAnomalySample(out, cls, owner, family) {
	try {
		const arr = out.anomalySamples;
		if (!Array.isArray(arr) || arr.length >= 6) return;
		const key = `${cls}|${owner || "?"}|${family || "?"}`;
		if (arr.some((x) => x && x.key === key)) return;
		arr.push({ key, cls, owner: owner || null, family: family || null });
	} catch { /* 忽略 */ }
}

/**
 * 取某会话 `oplog` 里**末条** `RENDER` 的某个数值键（`#78` 起两用：`unplaced`＝对齐口径／
 * `unplacedRenderable`＝可渲染口径）。
 * ★ 关键：**逐键独立回溯**（不能"取末条 RENDER 再读键"） —— 老客户端/补发路径写出的 `RENDER` 可能**不带**
 *   新键，若只读末条就会把"上一条带该键的真实读数"丢掉、进而回退成老口径（时序型假阴）。
 * @returns {number|null}
 */
function lastRenderNum(sessionId, key) {
	try {
		const lines = readFileSync(oplogFile(sessionId), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || line.indexOf("RENDER") === -1) continue;
			try {
				const o = JSON.parse(line);
				if (o && o.op === "RENDER" && Number.isFinite(o[key])) return o[key];
			} catch { /* 坏行 ⇒ 跳过（与 readOplog 的 badLines 口径一致） */ }
		}
		return null;
	} catch { return null; }
}
function lastRenderUnplaced(sessionId) { return lastRenderNum(sessionId, "unplaced"); }
/** ★批16（`#78`）：**上屏唯一口径** ＝ "可渲染未定位张数"（客户端 `nsUnplacedRenderable()` 算出、随 `RENDER` 落盘）。 */
function lastRenderUnplacedRenderable(sessionId) { return lastRenderNum(sessionId, "unplacedRenderable"); }
/**
 * ★批16（`#78`）：**会话级"未定位"上屏数的唯一取数口**（汇总卡那行 / 降级门 / 点名行 三处共用）。
 * 回退链（**逐级如实、绝不静默归零**）：① 末条 `RENDER.unplacedRenderable`（可渲染口径）
 * → ② 末条 `RENDER.unplaced`（老客户端：对齐口径，与装前逐字一致）→ ③ 盘上 `counters.unplaced`（服务端累计）。
 * @param {string} sessionId
 * @param {object|null} counters 该会话 `index/<sid>.json` 的 `counters`（不可得 ⇒ `null`）
 * @returns {number|null} 三级都取不到 ⇒ `null`（调用方如实 `null`，不编造 0）
 */
function unifiedUnplaced(sessionId, counters) {
	const r = lastRenderUnplacedRenderable(sessionId);
	const u = lastRenderUnplaced(sessionId);
	// ★`#A78`：**陈旧窗口不再覆盖更新的索引** —— 渲染报告是"某一刻的窗口读数"；若索引在其之后被重建过，
	//   以索引计数器为准（否则一条 4 天前 `unplaced:4` 的报告会永久把该会话挂成"有问题"，
	//   且新版修复过的卡已 placed）。判据：两时间都可得 ∧ `index.updatedAt > lastRender.at` ⇒ 报告视为陈旧。
	const idxAt = indexUpdatedAtMs(sessionId);
	const rAt = lastRenderAtMs(sessionId);
	const stale = idxAt !== null && rAt !== null && idxAt > rAt;
	if (!stale) {
		if (Number.isFinite(r)) return r;
		if (Number.isFinite(u)) return u;
		return Number.isFinite(counters && counters.unplaced) ? counters.unplaced : null;
	}
	// 陈旧分支：**不得抬高** —— 取"旧窗口读数"与"新索引计数"的较小者。
	//   理由：① 四天前的 `unplaced:4` 不能压过已重建为 0 的索引；② 索引计数里可能含用户 2026-09-26 裁定
	//   "历史数据不告警"的封闭清单卡，陈旧分支若直接改用索引会把它们**复活**（实测 9 会话 / 23 张）。
	const a = Number.isFinite(r) ? r : (Number.isFinite(u) ? u : null);
	const b = Number.isFinite(counters && counters.unplaced) ? counters.unplaced : null;
	if (a === null) return b;
	if (b === null) return a;
	return Math.min(a, b);
}

/** 会话索引的 `updatedAt`（毫秒；不可得 ⇒ null） */
function indexUpdatedAtMs(sessionId) {
	try {
		const j = JSON.parse(readFileSync(indexFile(sessionId), "utf8"));
		const v = j && (j.updatedAt !== undefined ? j.updatedAt : j.at);
		const ms = typeof v === "number" ? v : Date.parse(String(v || ""));
		return Number.isFinite(ms) ? ms : null;
	} catch { return null; }
}

/** 末条 RENDER 的 `at`（毫秒；不可得 ⇒ null） */
function lastRenderAtMs(sessionId) {
	try {
		const lines = readFileSync(oplogFile(sessionId), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || line.indexOf("RENDER") === -1) continue;
			try {
				const o = JSON.parse(line);
				if (!o || o.op !== "RENDER") continue;
				const ms = Date.parse(String(o.at || ""));
				return Number.isFinite(ms) ? ms : null;
			} catch { /* 坏行跳过 */ }
		}
		return null;
	} catch { return null; }
}

/**
 * ★ `#A264` 点名小件：会话 id ⇒ **短号 8 位**（去 `session-` 前缀后取前 8；供全局行"点名"用；**不新增宿主能力键**）。
 * @param {string} id
 * @returns {string}
 */
function shortSid(id) {
	const s = String(id ?? "");
	return (s.startsWith("session-") ? s.slice(8) : s).slice(0, 8);
}

/** ★ `T-E′` 后半（2026-09-21 obs3S7 `#A60`；用户已裁 4 点）：会话末条 `RENDER` 的 `counters.pendingNoNode`
 *  （A 侧"已判落点但该行本页从未挂载"的如实计数）⇒ 跨会话聚合用；不可得 ⇒ `null`（**不编造 0**）。 */
function lastRenderPendingNoNode(sessionId) {
	try {
		const lines = readFileSync(oplogFile(sessionId), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || line.indexOf("RENDER") === -1) continue;
			try {
				const o = JSON.parse(line);
				if (o && o.op === "RENDER" && o.counters && Number.isFinite(o.counters.pendingNoNode)) return o.counters.pendingNoNode;
			} catch { /* 坏行 ⇒ 跳过 */ }
		}
		return null;
	} catch { return null; }
}

/** A119：确认基线（sid → {ackedSeq, at, note}）；只统计 seq 大于基线的拒收（不用时间窗）。 */
function rejectAcks() {
	try {
		const p = join(storeRoot(), "reject-acks.json");
		if (!existsSync(p)) return {};
		const j = JSON.parse(readFileSync(p, "utf8"));
		return j && typeof j === "object" && !Array.isArray(j) ? (j.sessions || j) : {};
	} catch { return {}; }
}
function ackedSeqOf(sessionId) {
	const a = rejectAcks()[sessionId];
	const v = a && (typeof a === "object" ? a.ackedSeq : a);
	return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/** A117：读会话 oplog 尾部，汇总 emit 拒收（owner 非 system，且 seq 大于确认基线）；供「问题会话」判定点名用。 */
function rejectedTailOf(sessionId, maxBytes = 262144) {
	try {
		const p = join(storeRoot(), "oplog", `${sessionId}.jsonl`);
		if (!existsSync(p)) return { n: 0, top: [] };
		const st = statSync(p);
		const start = Math.max(0, st.size - maxBytes);
		const len = st.size - start;
		const fd = openSync(p, "r");
		const buf = Buffer.alloc(len);
		try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
		const m = new Map();
		let acked = 0;
		const ack = ackedSeqOf(sessionId);
		for (const line of buf.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			let r; try { r = JSON.parse(line); } catch { continue; }
			if (r?.result !== "rejected") continue;
			const owner = typeof r.owner === "string" && r.owner && r.owner !== "system" ? r.owner : null;
			if (!owner) continue;
			if (Number.isFinite(Number(r.seq)) && Number(r.seq) <= ack) { acked += 1; continue; }
			const reason = String(r.reason || r.code || "?");
			const k = `${owner}|${reason}`;
			m.set(k, (m.get(k) || 0) + 1);
		}
		const top = [...m.entries()].map(([k, count]) => { const i = k.indexOf("|"); return { owner: k.slice(0, i), reason: k.slice(i + 1), count }; })
			.sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner)).slice(0, 3);
		return { n: top.reduce((a, b) => a + b.count, 0), top, acked };
	} catch { return { n: 0, top: [], acked: 0 }; }
}

function computeGlobalCounters() {
	const out = { at: new Date().toISOString(), sessions: 0, cards: 0, placed: 0, unplaced: 0, sessionCards: 0, malformedSlots: 0, unknownRowTypes: 0, unreadable: 0,
		// ★ `#A264` 点名小件（**用户已定文案**）：**非零会话点名** = 短号 8 ＋ 两项值，**上限 3** ＋ 总数。
		//   口径：`problemSessions` = **全局**"有问题会话"数（`unplaced`〔窗口口径〕> 0 ∨ `unknownRowTypes`〔过滤后〕> 0）；
		//   `problemTop` = 按 `(unplaced + unknownRowTypes)` 降序（并列按 sid 升序）取**前 3**。
		//   ⚠️ 与"本会话"无关 —— `computeGlobalCounters` 是**会话无关**的全局量（60s TTL）⇒ 文案里"另有 N 个"取**全局计数**。
		problemSessions: 0, problemTop: [],
		// ★ `T-E′` 后半（`#A60`）：**卡位异常三类**（跨会话聚合；**全局只出一条**由 A 侧渲染）。
		//   口径 = **显式白名单**（三类；撤任一类 ⇒ 判据必红）：`no-anchor` / `anchor-mismatch`（② `unplaced[].reason`）
		//   ／ `rowless-unknown`（② `placeState === "session"` **且该族未申报 `rowless-structural`** ⇒ **真异常**）。
		//   ⚠️ **预期类不计**（窗口外历史卡 ⇒ 走 `pending`，且 PEND 行可隐藏；`台账 #34`）。
		// ★★ **`#A68` ② / 批 2 件②（2026-09-21）**：**`pending-no-node` 已移出异常面** ——
		//   依 `§三.18⑩①`：**未载入的历史 ⇒ 卡不渲染 ＋ 计入 `pending` ＝ 预期**（长会话常态）；
		//   若计入异常面，**长会话必被误报**（第 30 次部署实测本执行会话 25）⇒ 该信号与「健康 ⇒ 0」**不可两立**。
		//   ⇒ **保留为读数/日志**（① 末条 `RENDER.counters.pendingNoNode` 原样可读、可 grep），**只是不参与告警面**。
		//   ⇒ 「**健康 ⇒ 0**」**只判异常面**（本三项）；`rowlessDeclared` 仍为非异常读数。
		// ★`#A76`：官方全集来源与降级标记（**如实可查**；读不到 ⇒ degraded:true 且回落白名单判据）
		officialTypes: officialTypesState.n, officialTypesSource: officialTypesState.source,
		officialTypesVersion: officialTypesState.version, officialTypesDegraded: officialTypesState.degraded,
		anomalies: { "no-anchor": 0, "anchor-mismatch": 0, "rowless-unknown": 0 },
		anomalyTotal: 0, anomalySamples: [],
		// ★★ `#A68` ②（批 2 件②）：`pending-no-node` = **非异常读数**（预期类；移出告警面、**读数保留**）。
		pendingNoNode: 0,
		// ★A94：**范围四读数**（`row` 不计在此——`row` 的异常在 anomalies 里）＋ 兼容保留 `rowlessDeclared`
		//   （语义改为"声明为非行级的卡数" = levelSession + levelGlobal，供旧读者平滑）
		levelRow: 0, levelSession: 0, levelGlobal: 0, levelUndeclared: 0,
		rowlessDeclared: 0,
		// ★**批4 段A（2026-09-26 `#A313`；用户裁「剩下的 87 张 ＝ 历史数据 · 不告警 · 不修」）**：
		//   **历史存量**＝在**封闭清单**（`data/legacy-anomalies.json`；逐张身份 `(sid,owner,kind,at)`；**只减不增**）
		//   内的卡数 ⇒ **计入本读数、不计入 `anomalyTotal`**（`ENV §一.6②`："不告警"≠"抹掉"）。
		legacyHistoric: 0,
		// ★**批4 段A**：清单**总容量**（只读；供面板/探针与"逐张可查"对账；≠ 存量时即为"清单被改过"的信号）。
		legacyListTotal: legacyList().total };
	const problemList = [];
	let files = [];
	const dir = join(storeRoot(), "index");
	try { files = readdirSync(dir); } catch { return out; }
	for (const f of files) {
		// 只收**会话索引**：排除同族备份 / 临时文件。⚠️ **不得假定 id 前缀**（真会话 id 形如 `session-<uuid>`
		//   但任意 id 都可能出现 ⇒ 用"排除法"而不是"要求 `session-` 前缀"，否则会静默少数会话）。
		if (!f.endsWith(".json") || f.includes(".bak-") || f.includes(".tmp-")) continue;
		try {
			const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
			const c = j && typeof j.counters === "object" && j.counters && !Array.isArray(j.counters) ? j.counters : null;
			if (!c) { out.unreadable += 1; continue; }
			out.sessions += 1;
			// ⚠️ `unplaced` **不在此累加**（`#A263` S3：改窗口口径，见下方 `lastRenderUnplaced`）；`cards`/`placed`/`sessionCards`/
			//    `malformedSlots` 仍按 `counters` 累加（语义 = 累计量，与窗口无关）。
			for (const k of ["cards", "placed", "sessionCards", "malformedSlots"]) {
				if (Number.isFinite(c[k])) out[k] += c[k];
			}
			// ★ `#A253` 一(c)：`unknownRowTypes` **必须与读通道同源过滤** —— 盘上 `index/<sid>.json` 的值对**自 #A247/#A252 后未重写**
			//   的会话是**陈旧未过滤值**（第 23 次部署实测：11 个非零会话之和 = 215376，逐会话全部满足"== 未过滤原始和"⇒ 陈旧型；
			//   写入路径本身**已过滤**，见 `buildIndex()` 的 `unknownRowTypes: rowUnknownTotal(rowStats)`）⇒ 全局聚合改从**行事实面**
			//   `slots/<sid>.json` 的 `stats` 现算（同一 `rowUnknownTotal`）。**真未知类型仍会计入并在全局行上屏**（不得做成"全局恒 0"）；
			//   slots 不可读 ⇒ **如实回退**盘上值（不静默归零）。
			let filtered = null;
			try {
				const sj = JSON.parse(readFileSync(slotsFile(f.slice(0, -5)), "utf8"));
				filtered = rowUnknownTotal(sj && typeof sj.stats === "object" && sj.stats && !Array.isArray(sj.stats) ? sj.stats : {});
			} catch { filtered = null; }
			out.unknownRowTypes += Number.isFinite(filtered) ? filtered : (Number.isFinite(c.unknownRowTypes) ? c.unknownRowTypes : 0);
			// ★ `#A263` S3：全局行 `unplaced` 改**窗口口径** —— 各会话 ① 末条 `RENDER.unplaced` 之和；
			//   末条不可得 ⇒ **如实回退**盘上 `counters.unplaced`（累计值，**不静默归零**）。
			//   会话级 `counts.unplaced`（写盘面 == 上屏面的对撞口径）**保持原值只观测**（沿 `#A253` 一(b) 先例）。
			// ★ `T-E′` 后半（`#A60`）：逐会话累加**异常四类** ＋ 有界**点名样本**（owner ＋ 族 `source|kind` ＋ 原因码）
			try {
				const rid0 = f.slice(0, -5);
				// ★**批4 段A（`#A313`）**：取本会话的历史存量视图（封闭清单；见 `legacyFor()`）。
				const lg = legacyFor(rid0);
				const un0 = Array.isArray(j.unplaced) ? j.unplaced : [];
				// ★**批4 ⑤（2026-09-26 `#A307`；兑现既有裁决 `#A62`⑤「未申报族才计入异常；已申报族一律不计入」）**：
				//   `cards[]` 面**已执行**族级申报判定（下方 `:1363`），但 `unplaced[]` 面**此前未执行** ⇒
				//   已申报族（如 `dsh-host-compat|compat`）的卡被**误算**成 `no-anchor` 异常。
				//   `unplaced[]` 载荷只带 `{cardId,owner,reason}`（**不带 `kind`**）⇒ **最省且零新键**的关联
				//   ＝ **本会话 `cards[]` 中同一 `owner` 的族已被申报**（`(sid,owner)` 关联，本循环已按会话分片）。
				//   ★A94：改为按**卡自身的 anchorLevel** 判定（`session/global` 不计异常）；族名豁免已退役。
				// ★A94：按**卡的 anchorLevel**（而不是族名）判定；unplaced[] 载荷只有 {cardId,owner,reason} ⇒ 用 cardId 反查 anchorLevel
				const scopeByCardId = new Map();
				for (const c3 of (Array.isArray(j.cards) ? j.cards : [])) {
					if (c3 && typeof c3.cardId === "string") scopeByCardId.set(c3.cardId, c3.anchorLevel ?? null);
				}
				for (const u of un0) {
					const rs = String((u && u.reason) || "");
					const cls = rs === "no-anchor" ? "no-anchor" : (rs === "anchor-mismatch" ? "anchor-mismatch" : null);
					if (!cls) continue;
					const usc = u?.anchorLevel ?? (typeof u?.cardId === "string" ? scopeByCardId.get(u.cardId) : null);
					if (usc === "session" || usc === "global") continue; // 非行级范围 ⇒ 不计异常
					// ★批4 段A：**封闭清单**内的历史存量 ⇒ 不计入异常（改计 `legacyHistoric`）
					if (lg.consumeUnplaced(String((u && u.owner) || "?"))) { out.legacyHistoric += 1; continue; }
					out.anomalies[cls] += 1;
					pushAnomalySample(out, cls, u && u.owner, `${(u && u.owner) || "?"}|${rs}`);
				}
				for (const c2 of (Array.isArray(j.cards) ? j.cards : [])) {
					if (!c2) continue;
					// 四读数：session/global 按**全部卡**统计；`levelUndeclared` 只统计**无行卡**（未定位/会话级），
					//   否则已落位的 7 千张历史卡会把"未声明"抬成噪声（它要回答的是"还有谁没声明且没落行"）。
					const scAll = c2.anchorLevel ?? null;
					if (scAll === "row") out.levelRow += 1;
					else if (scAll === "session") out.levelSession += 1;
					else if (scAll === "global") out.levelGlobal += 1;
					else if (scAll === null && c2.placeState === "session" && c2.owner && !lg.hasCard(c2)) out.levelUndeclared += 1;
					else out.levelRow += 1;   // row 声明 或"未声明但已落位"（按 row 语义）
					if (c2.placeState !== "session") continue;
					const famKey = `${c2.owner || "?"}|${c2.kind || "?"}`;
					// ★A92：**先**判封闭清单（历史存量归历史），再判已申报族（新产生的申报无行）—— 否则历史队列卡会把
					//   `rowlessDeclared` 抬到 51（用户看到的"1 张"会被换成"51 张"），读数反而失真。
					if (lg.hasCard(c2)) { out.legacyHistoric += 1; continue; }   // ★批4 段A：**封闭清单**内的历史存量 ⇒ 不计入异常
					// ★A94：anchorLevel 是唯一判据 —— session/global 不计异常（计数已在上面按全卡统计）；未声明照常按 row 判
					const sc2 = c2.anchorLevel ?? null;
					if (sc2 === "session" || sc2 === "global") continue;
					out.anomalies["rowless-unknown"] += 1;
					pushAnomalySample(out, "rowless-unknown", c2.owner, famKey);
				}
				// ★★ **`#A68` ②（批 2 件②）**：**`pending-no-node` 不再累加进 `anomalies`**（预期类 ⇒ 移出告警面）。
				//   **但读数不丢**：末条 `RENDER.counters.pendingNoNode` 仍原样可读（① 可 grep）⇒ 本处只做**观测读数**，不再进 `anomalyTotal`。
				const pnn0 = lastRenderPendingNoNode(rid0);
				if (Number.isFinite(pnn0) && pnn0 > 0) out.pendingNoNode += pnn0;
			} catch { /* 单会话异常 ⇒ 跳过该会话（不静默归零其它会话） */ }
			// ★批16（`#78`；用户裁「以可渲染为准、服务端同批跟」）：**全局/逐会话 `unplaced` 改"可渲染口径"** ——
			//   取数走**唯一取数口** `unifiedUnplaced()`（末条 `RENDER.unplacedRenderable` → 末条 `RENDER.unplaced`
			//   → 盘上 `counters.unplaced`），与**会话汇总卡那行 / 降级门 / 降级行**三处**同一个数**。
			//   ⚠️ 旧写法只读末条 `RENDER.unplaced`（对齐口径）⇒ 与未定位区头行（过滤后）可差 1（用户 `#78` 现象）。
			//   ⚠️ 盘上 `counters.unplaced`（服务端对齐累计）**保持原样、只观测**（`state().unplacedCount` 同口径，不判改）。
			const unVal = (() => { const v = unifiedUnplaced(f.slice(0, -5), c); return Number.isFinite(v) ? v : 0; })();
			out.unplaced += unVal;
			// ★ `#A264`：逐会话累积"点名"候选（判定与上面的两项**同一来源** ⇒ 不可能出现"计数非零却没被点名"的分叉）
			const unkVal = Number.isFinite(filtered) ? filtered : (Number.isFinite(c.unknownRowTypes) ? c.unknownRowTypes : 0);
			const rj = rejectedTailOf(f.slice(0, -5));
			out.rejectedAcked = (out.rejectedAcked || 0) + (rj.acked || 0);
			if (unVal > 0 || unkVal > 0 || rj.n > 0) problemList.push({ sid: shortSid(f.slice(0, -5)), unplaced: unVal, unknownRowTypes: unkVal, rejectedN: rj.n, rejected: rj.top });
		} catch { out.unreadable += 1; }
	}
	out.rowlessDeclared = out.levelSession + out.levelGlobal;
	problemList.sort((a, b) => ((b.unplaced + b.unknownRowTypes + (b.rejectedN||0)) - (a.unplaced + a.unknownRowTypes + (a.rejectedN||0))) || a.sid.localeCompare(b.sid));
	out.problemSessions = problemList.length;
	out.problemTop = problemList.slice(0, 3);
	return out;
}

/**
 * 取全局聚合（**脏 或 TTL 到期 或 未建** ⇒ 现算一次；否则直接用缓存）。
 * ★ A85：写路径不再强制重算，取数改为 **TTL 有界**（最多每 60s 一次）；返回体带 `staleMs` 与 `dirty`。
 * @param {{force?: boolean}} [opts] `force:true` ⇒ 忽略 TTL/脏标记，立即重算（**显式**入口，别在写路径隐式强刷）
 */
function globalCounters({ force = false } = {}) {
	const now = Date.now();
	// ★ A85 修2（实测 24.6% CPU/1GB RSS）：**脏标记不再"每次读都立刻重算"** —— 否则 GUI 轮询状态卡时
	//   写一次就重算一次（每算 1.7s）。改为 **TTL 有界**：最早一次重算在 `GLOBAL_TTL_MS` 到期时；`dirty` 只用于
	//   "到期时值是否仍可信"的记账与返回体。需要实时 ⇒ 显式 `refreshGlobalCounters()`（force）。
	if (force === true || !globalCountersCache.value || (now - globalCountersCache.at) >= GLOBAL_TTL_MS) {
		globalCountersCache = { at: now, value: computeGlobalCounters() };
		globalCountersDirty = false;
	}
	if (globalCountersCache.value && globalCountersCache.value.anomalies) {
		globalCountersCache.value.anomalyTotal = Object.values(globalCountersCache.value.anomalies).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
	}
	const age = now - globalCountersCache.at;
	return { value: globalCountersCache.value, at: globalCountersCache.at, ageMs: age, staleMs: age, dirty: globalCountersDirty };
}

/** ★ A85：**显式**实时入口（用户主动刷新面板等）；普通读路径一律走 TTL/脏缓存。 */
export function refreshGlobalCounters() {
	return globalCounters({ force: true });
}

/** 拒绝原因 ⇒ 错误码（**只作标签显示**；客户端**不得按 `reason` 取值做分支**，`#A229` 一 条件②） */
function rejectCodeOf(reason) {
	const r = String(reason ?? "");
	if (/^not_found/.test(r)) return "E-NOTFOUND";
	if (/^owner-mismatch/.test(r)) return "E-OWNER";
	if (/^writer-lock-unreadable/.test(r)) return "E-LOCK-UNREADABLE";
	if (/^writer-lock/.test(r)) return "E-LOCK";
	if (/^bad-entry/.test(r)) return "E-SHAPE";
	if (/^bad-argument/.test(r)) return "E-ARG";
	if (/io:/.test(r)) return "E-IO";
	// ★ **段2 `B6`（2026-09-29；"不得静默"整改 · 原因码映射缺口）** —— **store 自写的 reason 无 `bad-entry:` 前缀**
	//   （`validateEntry` 的同一词表：`not-object` / `schema-version` / `missing-key:<k>` / `bad-type:<k>` / `bad-enum:<k>`，
	//   见 `appendEntry` 的形状分支）⇒ 此前落 **`E-OTHER:bad-enum_state`**（＝**等于没点名**；现网 oplog 实测 14 条
	//   `rejected` 全落此码）⇒ 与 `^bad-entry` **同一档**归 `E-SHAPE`（**同一含义、同一码；不新造码**）。
	if (/^(?:not-object|schema-version|missing-key|bad-type|bad-enum)(?::|$)/.test(r)) return "E-SHAPE";
	// ★ **`T-G`（2026-09-21 obs3S7 批 2 件①；`#A71` 裁决一）**：**写入入口校验的 4 个原因码逐码独立上屏**
	//   —— 用户可见面要的是"**点名原因码 ＋ 族 ＋ 插件名**"（`#A60`②）⇒ 打成一团 `E-OTHER` 等于**没点名**。
	if (r === "gate-shape-turn" || r === "gate-shape-anchorSeq" || r === "gate-shape-commandId" || r === "gate-shape-ctxKey") return "E-GATE-SHAPE";
	if (r === "gate-anchor-mismatch") return "E-GATE-ANCHOR";
	if (r === "gate-no-position-key") return "E-GATE-NOKEY";
	// ⚠️ **不静默归并**：未登记的原因码 ⇒ **原样透出**（可 grep、可归因；不得用 `E-OTHER` 把根因抹掉）。
	return r ? `E-OTHER:${r.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}` : "E-OTHER";
}

/**
 * ★ **段2 `B6`（2026-09-29）**：**外部拒收登记**（"不得静默"整改的**唯一**登记点）。
 *
 * 背景（`ENV §一.6②` ＋ `#A394` 段2 B6）：`banner-kit.emit` 在**形状校验不过时就把 entry 退回生产者**
 *   ⇒ entry **到不了 store** ⇒ 面板上**无 `rejected`／无 `rejectedByReason`／无原因码** ⇒ **对用户可见面 ≡ 静默丢弃**。
 * ⇒ 中间件（`host-compat/seams.js` 的 `reportBannerReject`）与生产者（`wrapBannerKit`）把**该条拒收**送到这里，
 *   落**同一条 ① `rejected`**（与 `appendEntry` 的拒收**同形状**、**同一读面**）⇒ 面板 `rejectedByReason`
 *   （`owner|reason|code` 三件）**自动可见**（`readStateCards` 纯函数派生，无需另开读面）。
 *
 * 形状：`{ sessionId?, owner?, reason, snapshot? }` —— `owner` = 生产者名（**点名**）、`reason` = 原因码串、
 *   `snapshot` = 被拒载荷**整份原样**（`#A69` 裁决②：不脱敏、可事后重放复现）。
 * @returns `{ok:true, seq, code}` | `{ok:false, reason}`（**同步**；永不 throw）
 */
export function reportRejected({ sessionId = null, owner = null, reason = "unknown", snapshot = null } = {}) {
	try {
		const sid = (sessionId === null || typeof sessionId === "string") ? sessionId : null;
		const rc = typeof reason === "string" && reason ? reason : "unknown";
		const w = appendOplog(sid, {
			op: "POST", owner: (typeof owner === "string" && owner) ? owner : null, cardId: null, slotId: null,
			sessionId: sid, result: "rejected", reason: rc, occ: null, snapshot: snapshot ?? null
		});
		if (w.ok !== true) return { ok: false, reason: w.reason };
		return { ok: true, seq: w.seq, code: rejectCodeOf(rc) };
	} catch (err) {
		return { ok: false, reason: `report-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * ★ **段2 `B6`**：**同步**形状校验（宿主/中间件直调路径用；`appendNotice` 是**同步**签名 ⇒ 只能用同步面）。
 *   · banner-kit **已加载** ⇒ 返回 `kit.validateEntry(raw)` 的**原物**（**不复制、不自写第二套校验**）；
 *   · **未加载／异常** ⇒ 返回 `null` ＝ **"未知"**（**不伪造 `ok:true`**；调用方不得据此放行判定，
 *     该条随后仍由 `appendEntry` 的异步路径校验并落 `rejected` ⇒ 不静默）。
 * 永不 throw。
 */
export function validateEntrySync(raw) {
	try {
		if (!kitMod || typeof kitMod.validateEntry !== "function") return null;
		return kitMod.validateEntry(raw);
	} catch {
		return null;
	}
}

/**
 * 组装 `stateCards`（**同步**；读通道 handler 要求同步返回）。
 * @returns `{ok:true, stateCards, counts, gate, global}` | `{ok:false, reason}`
 */
export function readStateCards(sessionId) {
	try {
		const idx = readIndex(sessionId);
		const index = idx.ok === true && idx.index && typeof idx.index === "object" ? idx.index : null;
		const counters = index && index.counters && typeof index.counters === "object" && !Array.isArray(index.counters) ? index.counters : {};
		const op = readOplog(sessionId);
		const recs = op.ok === true && Array.isArray(op.records) ? op.records : [];
		// ---- 写盘面（权威）逐条读：① `rejected`（写入类拒绝 / 未命中 / 越权）＋ ① 末条 `RENDER` ----
		const items = [];
		const byKey = new Map();
		let notFound = 0;
		let ownerRejected = 0;
		let writerLock = 0;
		let writerLockUnreadable = 0;
		let renderStale = 0;
		let lastRender = null;
		for (const r of recs) {
			if (r && r.op === "RENDER") { lastRender = r; continue; }
			// T11：心跳静默痕（`op:"PUT"`/`result:"ok"` ⇒ **不属 `rejected`** ⇒ 必须在 rejected 过滤**之前**计数）
			if (r && typeof r.reason === "string" && r.reason.startsWith("render-stale")) renderStale += 1;
			if (!r || r.result !== "rejected") continue;
			const owner = typeof r.owner === "string" ? r.owner : null;
			const reason = typeof r.reason === "string" ? r.reason : String(r.reason ?? "");
			if (reason === "not_found") notFound += 1;
			if (reason === "owner-mismatch") ownerRejected += 1;
			if (reason === "writer-lock") writerLock += 1;                       // `(d)` 段：真锁命中（① 为准）
			if (/^writer-lock-unreadable/.test(reason)) writerLockUnreadable += 1; // `(d)` 段：锁面不可读（如实降级）
			const code = rejectCodeOf(reason);
			const k = `${owner ?? ""}|${reason}|${code}`;
			let it = byKey.get(k);
			if (!it) {
				it = { owner, reason, code, cardId: null, count: 0, firstAt: null, lastAt: null };
				byKey.set(k, it);
				items.push(it);
			}
			it.count += 1;                                   // ★ `count` = ① 中**同因条数**（改 ① ⇒ 必跟着变）
			if (typeof r.cardId === "string") it.cardId = r.cardId;
			if (typeof r.at === "string") { if (!it.firstAt) it.firstAt = r.at; it.lastAt = r.at; }
		}
		// ---- 生产者侧观测计数（② `counters`）⇒ 告警卡（**只观测、不降级**，设计稿 §2.2 行 3/5） ----
		const obsAt = new Date().toISOString();
		const pushObs = (reason, code, count) => {
			if (!Number.isFinite(count) || count <= 0) return;
			items.push({ owner: "system", reason, code, cardId: null, count, firstAt: null, lastAt: obsAt });
		};
		// ★ `#A263` S2：**会话级** `E-ROW` 改走**行事实面同源过滤**（陈旧 `index.counters` 值不再上屏；不可读 ⇒ 如实回退）
		pushObs("unknown-row-types", "E-ROW", sessionRowUnknownTotal(sessionId, counters.unknownRowTypes));
		pushObs("orphans", "E-ORPHAN", counters.orphans);
		// ---- 观测七项（判据 5 的"上屏面"= 本节原样输出；**写盘面 == 上屏面**） ----
		const mism = lastRender ? (lastRender.result === "mismatch" ? 1 : 0) : null;
		const un = Number.isFinite(counters.unplaced) ? counters.unplaced : 0;
		// ★批16（`#78`）：本会话"**可渲染未定位张数**" —— 与全局聚合／降级门走**同一个**取数口 `unifiedUnplaced()`
		//   （回退链：末条 `RENDER.unplacedRenderable` → 末条 `RENDER.unplaced` → 盘上 `counters.unplaced`）。
		const countsUnplacedRenderable = (function () { const v = unifiedUnplaced(sessionId, counters); return Number.isFinite(v) ? v : null; })();
		const counts = {
			// ⚠️ `unplaced` **保持对齐口径原值**（`counters.unplaced` = 服务端累计、含"会被渲染判据过滤掉"的条目）——
			//   它是**观测/对账面**（写盘面 == 上屏面 的既有对撞判据），本批**不判改**（`#78` 只登记项）。
			unplaced: Number.isFinite(counters.unplaced) ? counters.unplaced : null,
			// ★批16（`#78`）：**上屏口径**单独成键 —— 与"头行 / 会话汇总卡那行 / 降级门"同一个数（见 `unifiedUnplaced()`）。
			//   降级卡那一行（`client.js` degrade 段）**必须**读本键；读不到 ⇒ 客户端如实回退 `unplaced`（不编造 0）。
			unplacedRenderable: Number.isFinite(countsUnplacedRenderable) ? countsUnplacedRenderable : null,
			mismatch: mism,
			unknownRowTypes: Number.isFinite(counters.unknownRowTypes) ? counters.unknownRowTypes : 0,
			dupHits: null,                       // ★ **无数据源**（代码里不存在"重复身份被拒"路径）⇒ 如实 null，不编造
			orphans: Number.isFinite(counters.orphans) ? counters.orphans : 0,
			notFound,
			ownerRejected,
			writerLock,                                  // `(d)` 段：① `reason:"writer-lock"` 条数（**真数据源**；② 保持 `(①,行事实面)` 纯函数）
			writerLockUnreadable,                        // `(d)` 段：锁面不可读次数（**不静默**）
			sessionCards: Number.isFinite(counters.sessionCards) ? counters.sessionCards : null,
			lastRenderAt: lastRender && typeof lastRender.at === "string" ? lastRender.at : null,
			cardsPanelLast: lastRender && Number.isFinite(lastRender.cardsPanel) ? lastRender.cardsPanel : null,   // T11（DOM 口径）
			visibleLast: lastRender && typeof lastRender.visible === "boolean" ? lastRender.visible : null,        // T11（判别位）
			renderStale,                                                                                          // T11（只观测：心跳静默次数）
			// ★ `T-E′` 前半（`#A57`）：**A 侧四计数**（取自末条 `RENDER`，缺 ⇒ `null`，**不编造**）＋ **`rejectedByReason`**
			//   （**原因码 → 条数**聚合；只统计"写入类拒绝"条目 —— `owner !== "system"` 排除观测项；已存在 `items` 的纯函数派生）。
			aCounters: lastRender && lastRender.counters && typeof lastRender.counters === "object" ? lastRender.counters : null,
			rejectedByReason: (() => { const m = {}; for (const it of items) { if (!it || !it.owner || it.owner === "system") continue; const k = String(it.code || it.reason || "?"); m[k] = (m[k] || 0) + (Number.isFinite(it.count) ? it.count : 0); } return m; })(),
			indexReadable: idx.ok === true,
			oplogBadLines: Number.isFinite(op.badLines) ? op.badLines : 0
		};
		// ---- 三类卡（F2 分区；**不得混装同一 kind 语义**） ----
		const out = [];
		if (items.length) out.push({ kind: "alert", scope: "session", at: obsAt, counts, items });
		// ★ `#A253` 一(b)：**降级门不用累计口径** —— `counters.unplaced`（原始累计、含窗口外历史卡）**保留为只观测**
		//   （`counts.unplaced` 不变）⇒ 历史 `no-anchor` 残差不再点亮降级；**真·显示面缺口仍必触发**。
		// ★★ 批16（`#78`）：闸门取值**改走唯一取数口** `unifiedUnplaced()`（可渲染口径优先）—— 与未定位区头行、
		//   会话汇总卡那行、降级行**同一个数**；旧写法读末条 `RENDER.unplaced`（对齐口径）⇒ 会出现"头行 8 / 门按 9 亮"。
		//   回退链保序：可渲染 → 对齐（老客户端）→ 盘上累计（冷会话）⇒ 既不假绿也不静默归零。
		const unWin = countsUnplacedRenderable;
		const degraded = (unWin !== null && unWin > 0) || mism === 1;
		if (degraded) {
			const rs = [];
			if (unWin !== null && unWin > 0) rs.push(`unplaced:${unWin}`);
			if (mism === 1) rs.push("expect!=actual");
			out.push({ kind: "degrade", scope: "session", gate: "DEGRADED", reason: rs.join("+"), counts, at: obsAt });
		}
		if (index && Array.isArray(index.sessionCards) && index.sessionCards.length) {
			const sit = [];
			const smap = new Map();
			for (const c of index.sessionCards) {
				const k = `${c?.owner ?? ""}|${c?.kind ?? ""}|${c?.ctxKey ?? ""}`;
				let it = smap.get(k);
				if (!it) { it = { owner: c?.owner ?? null, kind: c?.kind ?? null, ctxKey: c?.ctxKey ?? null, cardId: null, count: 0, lastAt: null }; smap.set(k, it); sit.push(it); }
				it.count += 1;
				if (typeof c?.cardId === "string") it.cardId = c.cardId;
				if (typeof c?.at === "string") it.lastAt = c.at;
			}
			out.push({ kind: "session", scope: "session", at: obsAt, cardIds: index.sessionCards.map((c) => c?.cardId).filter((x) => typeof x === "string" && x), items: sit });
		}
		// ---- 全局聚合（always-on 元素；§1.5 默认键 `"global"` ⇒ **非出事会话也看得见累计条数**，判据 3） ----
		const g = globalCounters();
		out.push({ kind: "alert", scope: "global", at: new Date(g.at).toISOString(), staleMs: g.ageMs, counts: g.value, items: [] });
		return { ok: true, stateCards: out, counts, gate: degraded ? "DEGRADED" : "OK", global: g.value };
	} catch (err) {
		return { ok: false, reason: `state-cards-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * **按 ① 重放**得到 ②（设计稿 §7 纪律 3 / §11）：身份规则**单一来源 = `kit.mergeEntries`**。
 * ⚠️ **重建 ≠ 自愈**：本函数**只读不写**（写回 = 2a-2 的人工工具，且必须独占）；B 发现 ①② 不一致时**只告警、保留现场**。
 * @returns `{ok, index, rebuiltFrom, badLines, matches}`（`matches` = 与磁盘 ② **逐字相同**，`updatedAt` 除外）
 */
export async function replayIndexFromOplog(sessionId = null, { upto = null } = {}) {
	const kit = await loadKit();
	if (!kit) return { ok: false, reason: "banner-kit" };
	const all = readOplog(sessionId);
	const badLines = all.badLines;
	// T2-b 件E（设计稿 §2.5 纪律 4）：`--upto <seq>` = **回到某一刻的现场**（事故取证可复现"当时应渲染多少张"）。
	//   缺省 `null` ⇒ **逐字走全量**（既有行为一字不改）。
	const records = upto === null ? all.records : all.records.filter((r) => Number.isInteger(r?.seq) && r.seq <= upto);
	let entries = [];
	for (const rec of records) {
		if (rec?.result !== "ok" || !rec.snapshot) continue;
		if (rec.op === "DELETE") {
			const id = typeof rec.cardId === "string" ? rec.cardId : null;
			entries = id
				? entries.filter((e) => e.cardId !== id)
				: entries.filter((e) => !(e.kind === rec.snapshot.kind && e.rev === rec.snapshot.rev && (e.mode ?? "start") === (rec.snapshot.mode ?? "start")));
			continue;
		}
		entries = kit.mergeEntries(entries, rec.snapshot, { maxEntries: MAX_ENTRIES }).entries;
	}
	const rebuilt = buildIndex(sessionId === undefined ? null : sessionId, entries, readSlots(sessionId).rows, rowStatsFor(sessionId));
	const disk = readIndex(sessionId);
	const strip = (o) => {
		if (!o || typeof o !== "object") return null;
		const { updatedAt, ...rest } = o;
		return rest;
	};
	const matches = disk.ok === true && JSON.stringify(strip(disk.index)) === JSON.stringify(strip(rebuilt));
	return { ok: true, index: rebuilt, rebuiltFrom: records.length, badLines, matches, diskIndex: disk.ok ? disk.index : null };
}

/**
 * **把重放结果写回 ②**（obs3S7 段W-2a **T2-b 件E**；设计稿 §2.5「人工重放重建入口」）。
 *
 * ⚠️ **重建 ≠ 自愈**（计划 v5 §7）：本函数**绝不自动调用** —— 只有人工显式发起（`tools/oplog-replay.mjs --apply`）
 *    才执行；B 自身发现 ①② 不一致时**只告警、保留现场**。
 * ⚠️ **独占纪律不在本函数内**（store 不探进程 / 不碰宿主）：由调用方（工具）在调用前完成
 *    `.banner-writer.lock` + "写者静默窗口"两道检查；本函数只负责 **备份 → 原子写 → 失效 seq 缓存**。
 *
 * @returns `{ok:true, file, backupFile, matchesBefore, rebuiltFrom, recordsUpto}` | `{ok:false, reason}`
 */
export async function applyReplayFromOplog({ sessionId = null, upto = null, backup = true } = {}) {
	try {
		const r = await replayIndexFromOplog(sessionId, { upto });
		if (!r.ok) return { ok: false, reason: r.reason };
		const file = indexFile(sessionId);
		let backupFile = null;
		if (backup === true) {
			try {
				if (existsSync(file)) {
					backupFile = `${file}.bak-${Date.now()}`;
					copyFileSync(file, backupFile);          // 备份**先于**任何写（失败 ⇒ 不写）
					try { chmodSync(backupFile, 0o600); } catch { /* 某些 FS 不支持 chmod */ }
				}
			} catch (err) {
				return { ok: false, reason: `backup-failed:${String(err?.message ?? err)}` };
			}
		}
		// ★ `(d)`：**工具自身持锁** ⇒ 写回必须 `bypassLock`（否则被自己的锁挡掉 ⇒ `--apply` 静默失效）
		const w = writeIndex(sessionId, r.index, { bypassLock: true });
		if (!w.ok) return { ok: false, reason: w.reason, backupFile };
		// §12.6②：**同进程写者工具**写完后必须显式清 `oplogSeqCache`（跨进程靠 `mtimeMs` 兜）
		resetOplogSeqCache();
		return { ok: true, file, backupFile, matchesBefore: r.matches, rebuiltFrom: r.rebuiltFrom, upto };
	} catch (err) {
		return { ok: false, reason: `apply-replay-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * 读一个会话（`null`/缺省 = 全局）的全部条目（**原始顺序**，不过滤 `ttlMs`、不做去重）。
 * 可见性 / 顺序由 `banner-kit.selectVisible(entries, now)` 在渲染面决定（store 不做业务裁剪）。
 * @returns `{ok:true, entries, dropped, rebuilt}` | `{ok:false, reason, entries:[], dropped}`
 */
export async function listEntries(sessionId) {
	try {
		const kit = await loadKit();
		if (!kit) return { ok: false, reason: "banner-kit", entries: [], dropped: emptyDropped() };
		const shard = readShard(kit, sessionId === undefined ? null : sessionId);
		return { ok: true, entries: shard.entries, dropped: shard.dropped, rebuilt: shard.rebuilt === true };
	} catch (err) {
		return { ok: false, reason: `list-failed:${String(err?.message ?? err)}`, entries: [], dropped: emptyDropped() };
	}
}

/**
 * **同步**读（读通道端点要求 handler **同步返回结果对象**；`host-compat` 的 wrap 不做 await）。
 * 用 apply 期已加载的模块缓存（`storeStatus()` 已 `await` 过 ⇒ 正常路径必然就绪）；
 * 模块未就绪/不可用 ⇒ 直接降级（`reason:"banner-kit"`，**绝不阻塞端点、绝不半开**）。
 * @returns 与 `listEntries` 同形（`{ok, entries, dropped, rebuilt}`）
 */
export function listEntriesSync(sessionId) {
	const kit = kitMod && typeof kitMod === "object" ? kitMod : null;
	if (!kit) return { ok: false, reason: "banner-kit", entries: [], dropped: emptyDropped() };
	try {
		const shard = readShard(kit, sessionId === undefined ? null : sessionId);
		return { ok: true, entries: shard.entries, dropped: shard.dropped, rebuilt: shard.rebuilt === true };
	} catch (err) {
		return { ok: false, reason: `list-failed:${String(err?.message ?? err)}`, entries: [], dropped: emptyDropped() };
	}
}

/** 会话删除 ⇒ 删分片（设计稿 §3 清理规则③；**本批不接删除钩子**，仅供调用方/测试使用）。永不 throw。 */
export function removeShard(sessionId) {
	try {
		unlinkSync(shardFile(sessionId));
		return { ok: true };
	} catch (err) {
		if (err?.code === "ENOENT") return { ok: true };
		return { ok: false, reason: `io-error:${String(err?.message ?? err)}` };
	}
}

/**
 * store 可用性（**供面板如实上报**；ENV 红线 6/7：禁止"报 OK 而功能坏"）。
 * **零写探测**：只做 `accessSync(W_OK)`（不创建目录/文件 ⇒ apply 期仍然零 IO）；
 * 缺 banner-kit ⇒ `reason:"banner-kit"`（store 整体禁用）。
 * @returns `{ok:boolean, reason:string, root:string}`
 */
export async function storeStatus() {
	const root = storeRoot();
	const kit = await loadKit();
	if (!kit || typeof kit.validateEntry !== "function" || typeof kit.isShardReusable !== "function") return { ok: false, reason: "banner-kit", root };
	let dir = root;
	for (let i = 0; i < 16; i++) {
		try {
			if (existsSync(dir)) break;
		} catch {
			break;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	try {
		accessSync(dir, FS.W_OK);
	} catch {
		return { ok: false, reason: `not-writable:${dir}`, root };
	}
	return { ok: true, reason: "ok", root };
}
