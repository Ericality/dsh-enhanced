/**
 * @ericality/dsh-host-compat — 插件面（主入口）
 *
 * 契约：`docs/待办/2026-09-13-契约-host-compat-v1.md`（v1 冻结；禁止发明字段）
 * 落点：`docs/待办/2026-09-13-阶段1-契约落点与决策.md`（§2 落点表 / §3 裁决 / §5 文件分区）
 *
 * 职责（§1「主入口是插件」）：
 *   探测（boot 一次，§4.8/§4.9 转出）· 状态（§5 分片 + 汇总，**单写者**）·
 *   RPC（§6 通道 `/host-compat`）· 横幅（§8，仅 DEGRADED/BLOCKED）· 聚合（§4.10 report）·
 *   **总线端点注册表**（P1-1 additive，契约 §12-21：`ctx.provide("compatBus", {registerEndpoint,
 *   listEndpoints})` —— 通用端点注册、**不写死任何具体消费者**、不新增 RPC 通道/宿主能力 key；
 *   `rpcHandler` 的 `default` 分支先查注册表，未注册仍回 `not-found`）
 *
 * 纪律：零第三方依赖；**顶层 import 永不 throw**；`apply` 内部全程 try/catch（缺包/缺服务
 * 不得让宿主崩溃循环，§10.1/§10.2）；探测不用有副作用 API（§10.8）；本包内**不放业务逻辑**
 * （§10.6，只做适配与状态聚合）。
 *
 * 消费方用法（一律动态 import + try/catch，§1/§2.3/§10.1）：
 *   const seams = await import("@ericality/dsh-host-compat/seams");   // §4.1–§4.9 纯函数面
 *   const compat = await import("@ericality/dsh-host-compat");        // §4.10 report（+ probe/hostInfo 转出）
 */

import {
	appendNotice,
	ensureEventTypes,
	hostInfo,
	onReadySubscribe,
	probe,
	readSessionEvents,
	readyStats,
	rpcHandle,
	fetchRoute,
	setNoticeSinkResolver,
	setRpcRegistration,
	rpcRegistrationState,
	resolveTurnForEvent,
	setProbeRootCtx,
	setSessionResolver,
	setWebServerService,
} from "./seams.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 插件名（= 面板卡 key = Loader entry id 约定，RD-7） */
export const name = "dsh-host-compat";
/** 宿主服务依赖：RPC 注册 + 客户端连接（apply 在 connection 就绪后执行，保证 §4.6 注册成功） */
export const inject = ["connection", "webServer"];

const VERSION = "0.1.0";
const CHANNEL = "/host-compat"; // §6
const BANNER_KIND = "compat"; // §8（RD-7）
const OWN_ID = "dsh-host-compat";
const OWN_REQUIRES = ["sessionEvents", "sessionAppend", "eventTypeRegistry", "rpcHandle"];
const BANNER_TYPES = ["notice/banner", "notice/banner-replace"];
const STATE_RANK = { OK: 0, DEGRADED: 1, BLOCKED: 2 };

/** 日志句柄（apply 注入；仅为告警用，不是业务状态） */
let logger = null;
/** §5 内存态（写盘失败时的唯一兜底，绝不跨进程当数据源；不是业务缓存） */
const memShards = new Map();
let memDismiss = null;

const nowIso = () => new Date().toISOString();
const warn = (message) => {
	try {
		logger?.warn?.(`dsh-host-compat: ${message}`);
	} catch {
		/* 日志不可用 → 静默 */
	}
};

/* ------------------------------------------------------------------ §5 状态文件路径 */

/** `${DSH_COMPAT_DIR:-$DSH_HOME:-$DSH_HOME}`（§5 / RD-8） */
function statusRoot() {
	return process.env.DSH_COMPAT_DIR || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "plugin-data", "host-compat");
}
/** §5 汇总：`<root>/compat-status.json`（0600） */
function statusPath() {
	return join(statusRoot(), "compat-status.json");
}
/** §5 分片目录：`<root>/compat-status.d/<pluginId>.json` */
function shardDir() {
	return join(statusRoot(), "compat-status.d");
}
/** pluginId → 安全文件名（防路径穿越；契约只约定目录，未约定字符集） */
function safeId(id) {
	return String(id).replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 120) || "unknown";
}
function shardPath(id) {
	return join(shardDir(), `${safeId(id)}.json`);
}

/** 原子写 + 0600（失败抛错，由调用方决定是否降级为内存态） */
function writeJson0600(file, value) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
}

/* ------------------------------------------------------------------ §5 分片读写 + 聚合 */

const asStringArray = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : []);
const asString = (value) => (typeof value === "string" ? value : "");

/** 状态取值：非法/缺失时**由 missing/blocked 推导**（等价于 §4.9 的判定规则，绝不凭空默认 OK） */
function normalizeState(value, missing = [], blocked = []) {
	if (value === "OK" || value === "DEGRADED" || value === "BLOCKED") return value;
	if (blocked.length) return "BLOCKED";
	if (missing.length) return "DEGRADED";
	return value === undefined || value === null ? "OK" : "DEGRADED"; // 非法值 ⇒ 按降级处置（fail-safe）
}

/**
 * 规范化一条插件记录。
 * **分片文件形状（RD-15 冻结，8 键）**：`{schema,id,version,state,missing,blocked,note,probedAt}`
 *   = §5 `plugins[]` 的一条（6 键）+ `probedAt`（汇总 `probedAt` 的来源）+ `schema`
 *   （与汇总同版本号，供 C 线"缺 host-compat 时自写分片"逐字段复刻）。
 * 汇总里只映射 §5 的 6 键（见 `buildStatus()`），故 `schema`/`probedAt` **不会**泄漏进 `compat-status.json`。
 */
function normalizeEntry(raw) {
	const missing = asStringArray(raw?.missing);
	const blocked = asStringArray(raw?.blocked);
	return {
		schema: 1,
		id: asString(raw?.id),
		version: asString(raw?.version),
		state: normalizeState(raw?.state, missing, blocked),
		missing,
		blocked,
		note: asString(raw?.note),
		probedAt: typeof raw?.probedAt === "string" && raw.probedAt ? raw.probedAt : null
	};
}

/** 读全部分片（盘上 → 内存覆盖：内存至少与盘一样新）。坏分片跳过，绝不 throw。 */
function readShards() {
	const byId = new Map();
	try {
		const dir = shardDir();
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (!entry.endsWith(".json")) continue;
				try {
					const raw = JSON.parse(readFileSync(join(dir, entry), "utf8"));
					const normalized = normalizeEntry({ ...raw, id: asString(raw?.id) || entry.slice(0, -5) });
					if (normalized.id) byId.set(normalized.id, normalized);
				} catch {
					/* 坏分片 → 跳过（不因单个分片拖垮面板） */
				}
			}
		}
	} catch {
		/* 目录不可读 → 只用内存态 */
	}
	for (const [id, entry] of memShards) byId.set(id, entry);
	return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** dismiss 记录：内存优先（本进程刚写过），其次盘上（§5 `dismiss`） */
function readDismiss() {
	if (memDismiss) return memDismiss;
	try {
		const raw = JSON.parse(readFileSync(statusPath(), "utf8"));
		const dismiss = raw?.dismiss;
		if (dismiss && typeof dismiss === "object") {
			return {
				hostVersion: asString(dismiss.hostVersion),
				capabilitySignature: asString(dismiss.capabilitySignature),
				at: asString(dismiss.at)
			};
		}
	} catch {
		/* 无文件 / 坏 JSON → null */
	}
	return null;
}

/** 全域最坏者（§5 `state`） */
/** ★`#A60`：第三态（未参与探测／被版本门停用）**只进面板列表、不抬聚合 state** ——
 *  否则每会话都会注入 compat 横幅（噪声）；面板侧照旧按 `state !== "OK"` 计数与着色。 */
const NON_AGGREGATING_STATES = new Set(["NOT-INSTRUMENTED", "DISABLED-BY-PREFLIGHT"]);
function worstState(plugins) {
	let worst = "OK";
	for (const plugin of plugins) {
		if (NON_AGGREGATING_STATES.has(plugin.state)) continue;
		if ((STATE_RANK[plugin.state] ?? 1) > (STATE_RANK[worst] ?? 0)) worst = plugin.state;
	}
	return worst;
}

/**
 * `capabilitySignature` = **两段**排序串的 sha256 **前 16 位**（§5，D2；**RD-16 增补**）：
 *   ① 既有段 ＝ 全域 `missing`/`blocked` **去重 → 字典序 → 逗号连接**
 *   ② **新增段** ＝ **全插件 `id@version` → 字典序 → 逗号连接**（批 14，用户 2026-10-17 签）
 *   两段以 `|` 连接后取 UTF-8 sha256 前 16 位；两段皆空（无分片且无缺失键）则等价旧口径（对空串取摘要）。
 *
 * **为什么要加 ②（目的与背景，`§g`）**：旧口径只在 `missing∪blocked` 变化时变 ⇒ **全 OK 时签名恒为空串 sha256**
 * （生产盘上 `dismiss.capabilitySignature = sha256:e3b0c44298fc1c14` 即此），一旦用户 `dismiss` 过，
 * **此后任何版本的降级都永久静默**（`#74` 用户实测「我没关闭却显示已关闭」的同族）。并入插件版本后：
 * **任一插件升版 ⇒ 签名变 ⇒ `dismiss` 失配 ⇒ 真降级时重新提示**；版本不变 ⇒ 签名不变 ⇒ 仍静默（负控）。
 * 禁项（同批硬口径）：**不改 §3 键集**（`missing[]` 仍只收 §3 服务端能力键）、**不改 §8 注入条件**、
 * **不改 `dismiss` 数据结构**（`{hostVersion, capabilitySignature, at}`）。
 */
function capabilitySignature(plugins) {
	const keys = new Set();
	for (const plugin of plugins) {
		for (const key of plugin.missing) keys.add(key);
		for (const key of plugin.blocked) keys.add(key);
	}
	const keyPart = [...keys].sort().join(",");
	// ② 全插件身份段：`id@version`（id 必非空；version 缺失按空串，仍确定性）
	const verPart = plugins.map((plugin) => `${plugin.id}@${plugin.version || ""}`).sort().join(",");
	const joined = `${keyPart}|${verPart}`;
	return `sha256:${createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 16)}`;
}

/** dismiss 记忆键：`hostVersion + capabilitySignature`（§8：任一变化 ⇒ 视为新事件） */
const dismissKey = (hostVersion, signature) => `${hostVersion}\u0000${signature}`;

/**
 * 组装 §5 完整对象（RPC `status` 的 value）。
 * 额外含 `capabilitySignature`（**追加字段，已提契约变更申请 A-1**）：§5 没有当前签名的落点，
 * 而 §8 的 dismiss 按钮必须回传"用户看到的那个签名"。落盘文件**不含**该字段（严格 §5）。
 */
/** ★`#A60` 步1：已装但**未参与** host-compat 探测的插件 ⇒ 面板必须如实列出（第三态）。
 *  来源 = 生产 profile 的 node_modules（只认声明了 `dsh` 的包）∪ loader 里指向该目录的条目；
 *  状态取 loader 的 `disabled`：true ⇒ `DISABLED-BY-PREFLIGHT`，否则 `NOT-INSTRUMENTED`。
 *  **禁**把"没检查"当"检查通过"（`ENV §一.6②`）。 */
/* ★`#A64` 步2：`unprobedPluginRows` 的**目录扫描**是整个 `status` 里唯一的常数级 I/O
 *  （`readdirSync` ＋ 逐包 `readFileSync(package.json)`），原先**每次 status 都重扫**。
 *  实测：`POST /api/host-compat/status` 冷 30.3ms／温 14.7ms（`#A63` curl），而客户端在**每次切会话**时都会打一发
 *  ⇒ 会话切换的固定开销里我方占一项本可省的常数成本。改为进程级缓存（TTL 60s，key = node_modules 路径），
 *  命中期只重做**廉价的 loader 状态合并**（`loader.entries()` 是内存遍历）。禁把"缓存"做成"永不刷新"：
 *  TTL 到期即重扫；`knownIds` 变化不影响本缓存（缓存的是"已装且声明 dsh 的包清单"，与分片无关）。 */
const PROBE_SCAN_TTL_MS = 60000;
let probeScanCache = { at: 0, nm: "", installed: null };
function scanInstalledDshPackages(nm) {
	const now = Date.now();
	if (probeScanCache.installed && probeScanCache.nm === nm && now - probeScanCache.at < PROBE_SCAN_TTL_MS) {
		return probeScanCache.installed;
	}
	const installed = new Map();
	try {
		const dirs = [];
		for (const name of readdirSync(nm)) {
			if (name.startsWith(".")) continue;
			if (name.startsWith("@")) {
				try { for (const sub of readdirSync(join(nm, name))) dirs.push(`${name}/${sub}`); } catch { /* 忽略 */ }
			} else dirs.push(name);
		}
		for (const id of dirs) {
			try {
				const pkg = JSON.parse(readFileSync(join(nm, id, "package.json"), "utf8"));
				if (!pkg || typeof pkg !== "object" || pkg.dsh === undefined) continue;
				installed.set(id, { version: pkg.version || "unknown" });
			} catch { /* 非包目录 / 读不到 ⇒ 跳过 */ }
		}
	} catch { /* 目录不可读 ⇒ 空集 */ }
	probeScanCache = { at: now, nm, installed };
	return installed;
}

function unprobedPluginRows(knownIds) {
	const rows = [];
	try {
		const profileDir = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", "web");
		const nm = join(profileDir, "node_modules");
		// ① node_modules 里声明了 dsh 的包（★`#A64`：常数级扫描走缓存）
		const installedAll = scanInstalledDshPackages(nm);
		const installed = new Map();
		// ★`#A60`：分片 id 是**短名**（`dsh-cost-guard`），包名带 scope（`@deepseek-ai/dsh-cost-guard`）
		//   ⇒ 用 **basename** 对撞，否则会把已参与探测的 8 件重复列一遍。
		for (const [id, meta] of installedAll) {
			const base = String(id).split("/").pop();
			if (knownIds.has(id) || knownIds.has(base)) continue;
			installed.set(id, meta);
		}
		// ② loader 里的 disabled 状态（用于区分"被版本门停用"与"仅未参与探测"）
		let disabled = new Set();
		try {
			const loader = rootCtx?.get?.("loader", false);
			if (loader && typeof loader.entries === "function") {
				for (const e of loader.entries()) {
					const n = e?.options?.name;
					if (typeof n === "string" && n && e?.disabled === true) disabled.add(n);
				}
			}
		} catch { disabled = new Set(); }
		for (const [id, meta] of installed) {
			const off = disabled.has(id) || disabled.has(String(id).split("/").pop());
			rows.push({
				id,
				version: meta.version,
				state: off ? "DISABLED-BY-PREFLIGHT" : "NOT-INSTRUMENTED",
				missing: [],
				blocked: [],
				note: off
					? "被 0.2.2 profile 兼容 preflight 停用（版本门；原文见 dsh 启动 stderr `disabling profile plugin`）⇒ 未运行、未自评"
					: "未参与 host-compat 能力探测（无自评分片）⇒ **状态未知，不等于 OK**"
			});
		}
	} catch { /* 目录不可读 ⇒ 只回已知项 */ }
	return rows;
}

/* ★`#A64` 步3（用户令「先解决面板假绿」）：**面板与 loader 同源**。
 *  背景：`#A63` 现读发现 `bg-image` 在 `plugin_manager` 是 `fiberPhase:"failed"`
 *  （诊断 `cannot get property "webServer" without inject`），而 host-compat 面板仍报 **OK** ——
 *  因为旧实现只认 `entry.disabled`（preflight 停用），**不认 fiber 失败** ⇒ 假 OK，违 `ENV §一.6②`。
 *  ⇒ 现读 `loader.entries()[].fiber.state`（cordis 跨包 const enum：0 pending／1 loading／2 active／
 *  3 failed／4 disposed／5 unloading），**非 active 一律不得报 OK**：failed ⇒ `BLOCKED`（跑不起来，
 *  与"能力缺失被拦"同档，客户端既有红点/横幅规则可直接复用），pending/loading ⇒ `DEGRADED`。
 *  诊断原文：cordis 的失败原因要 `await fiber.await()` 才拿到（同步 API 没有），故后台惰性补采一次，
 *  写进 `fiberDiag` 供下一次 status 带上（**不阻塞 status**，也不伪造：拿不到就如实写"待补采"）。 */
const FIBER_PHASE = { 0: "pending", 1: "loading", 2: "active", 3: "failed", 4: null, 5: "unloading" };
const fiberDiag = new Map();
let fiberDiagScanAt = 0;
function loaderEntryPhases() {
	const map = new Map();
	try {
		const loader = rootCtx?.get?.("loader", false);
		if (!loader || typeof loader.entries !== "function") return map;
		for (const e of loader.entries()) {
			const n = e?.options?.name;
			if (typeof n !== "string" || !n) continue;
			const st = typeof e?.fiber?.state === "number" ? e.fiber.state : null;
			const rec = { phase: st === null ? null : FIBER_PHASE[st], state: st, fiber: e?.fiber, disabled: e?.disabled === true, name: n };
			map.set(n, rec);
			// ★`#A64` 修正：分片/未探测行的 id 是**短名**（`dsh-bg-image`），loader 的 `options.name` 是**全名**
			//   （`@deepseek-ai/dsh-bg-image`）⇒ 只按全名查会 miss（实测 `loaderPhase:null`）。双向都建键。
			const short = String(n).split("/").pop();
			if (short && !map.has(short)) map.set(short, rec);
		}
	} catch { /* 取不到 loader ⇒ 空表（保持分片原值，不臆造） */ }
	return map;
}
function refreshFiberDiags(entries) {
	const now = Date.now();
	if (now - fiberDiagScanAt < 5000) return;
	fiberDiagScanAt = now;
	for (const [name, meta] of entries) {
		if (meta.state !== 3 || fiberDiag.has(name)) continue;
		try {
			Promise.resolve(meta.fiber?.await?.()).then(() => { fiberDiag.set(name, "（fiber 已恢复，无异常）"); },
				(err) => { fiberDiag.set(name, String(err?.message ?? err).slice(0, 300)); });
		} catch (err) { fiberDiag.set(name, String(err?.message ?? err).slice(0, 300)); }
	}
}

function buildStatus() {
	const info = hostInfo();
	const plugins = readShards();
	let probedAt = null;
	for (const plugin of plugins) if (plugin.probedAt && (!probedAt || plugin.probedAt > probedAt)) probedAt = plugin.probedAt;
	// ★`#A60`：**分片存在但条目被 loader 停用** ⇒ 不得沿用旧分片冒充 OK（否则是"陈分片假绿"）
	try {
		const loader0 = rootCtx?.get?.("loader", false);
		if (loader0 && typeof loader0.entries === "function") {
			const off = new Set();
			for (const e of loader0.entries()) {
				const n = e?.options?.name;
				if (typeof n === "string" && n && e?.disabled === true) { off.add(n); off.add(n.split("/").pop()); }
			}
			for (const p of plugins) {
				if (off.has(p.id) || off.has(String(p.id).split("/").pop())) {
					p.state = "DISABLED-BY-PREFLIGHT";
					p.note = "被 0.2.2 profile 兼容 preflight 停用（版本门）⇒ 分片为历史读数，**不代表当前在跑**";
				}
			}
		}
	} catch { /* 取不到 loader ⇒ 保持分片原值 */ }

	// ★`#A60`：把"已装但未参与探测"的插件并入（第三态），并整体排序
	const _known = new Set(plugins.map((p) => p.id));
	const _extras = unprobedPluginRows(_known);
	const _all = [...plugins, ..._extras].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	// ★`#A64` 步3：**loader 相位并入**（同一真源 ⇒ 禁假绿）。非 active 一律不得报 OK：
	//   failed ⇒ `BLOCKED`（跑不起来）｜pending/loading ⇒ `DEGRADED`（没跑起来，别当跑通）。
	const _phases = loaderEntryPhases();
	refreshFiberDiags(_phases);
	const _phaseOf = (id) => {
		const k = String(id);
		return _phases.get(k) ?? _phases.get(k.split("/").pop()) ?? null;
	};
	// ★`#A64`：**失败即隐身**也要堵 —— 无分片、package.json 又没声明 `dsh` 的插件（实测 `dsh-bing-wallpaper`）
	//   原本既不进分片行也不进未探测行 ⇒ 面板 16 行里根本没有它。凡 loader 里**非 active 且未停用**的条目，
	//   一律补进面板（failed ⇒ BLOCKED / pending|loading ⇒ DEGRADED），确保「跑不起来」不可能被面板藏掉。
	const _seenKeys = new Set();
	for (const p of _all) { _seenKeys.add(String(p.id)); _seenKeys.add(String(p.id).split("/").pop()); }
	const _ghosts = [];
	for (const [nm2, ph] of _phases) {
		if (!ph || !ph.phase || ph.phase === "active" || ph.disabled) continue;
		const short2 = String(nm2).split("/").pop();
		if (_seenKeys.has(String(nm2)) || _seenKeys.has(short2)) continue;
		if (String(nm2).split("/").pop() === short2 && _ghosts.some((g) => g.id === nm2)) continue;
		const diag2 = [...fiberDiag.entries()].find(([n]) => n === nm2 || n === short2)?.[1];
		_ghosts.push({
			id: nm2,
			version: "unknown",
			state: ph.phase === "failed" ? "BLOCKED" : "DEGRADED",
			missing: [],
			blocked: [],
			note: `loader fiber ${ph.phase}（未 active；面板与 loader 同源）${diag2 ? `：${diag2}` : ""}`,
			loaderPhase: ph.phase
		});
	}
	const _all2 = _all.map((plugin) => {
		const ph = _phaseOf(plugin.id);
		let state = plugin.state;
		let note = plugin.note;
		if (ph && ph.phase && ph.phase !== "active" && state !== "BLOCKED") {
			const diag = [...fiberDiag.entries()].find(([n]) => n === String(plugin.id) || n === String(plugin.id).split("/").pop())?.[1];
			if (ph.phase === "failed") {
				state = "BLOCKED";
				note = `loader fiber failed（面板与 loader 同源：source=loader.entries().fiber.state=3）${diag ? `：${diag}` : "：诊断原文待补采（下一次 status 带上）"}`;
			} else if (state === "OK") {
				state = "DEGRADED";
				note = `loader fiber ${ph.phase}（未 active；面板与 loader 同源）`;
			}
		}
		return { ...plugin, state, note, loaderPhase: ph ? ph.phase : null };
	});
	const _all3 = [..._all2, ..._ghosts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return {
		schema: 1,
		host: { version: info.version, detectedAt: info.detectedAt },
		probedAt,
		state: (selfIssues.length && worstState(_all3) === "OK") ? "DEGRADED" : worstState(_all3),
		plugins: _all3.map((plugin) => ({
			id: plugin.id,
			version: plugin.version,
			state: plugin.state,
			missing: plugin.missing,
			blocked: plugin.blocked,
			note: plugin.note,
			loaderPhase: plugin.loaderPhase
		})),
		dismiss: readDismiss(),
		// ★`ENV §一.7④`"端点注册表必须可见可查"：把注册表**进面板数据**（原仅服务级可查 ⇒ 缺口）
		endpoints: (() => { try { return listEndpoints(); } catch (e) { return null; } })(),
		// ★自检异常（如实上屏，不静默）
		issues: selfIssues.slice(),
		capabilitySignature: capabilitySignature(plugins)
	};
}

/** 把当前聚合写回 §5 汇总文件（单写者：只有本包写；失败抛错 → 调用方降级为内存态） */
function persistAggregate() {
	const status = buildStatus();
	writeJson0600(statusPath(), {
		schema: status.schema,
		host: status.host,
		probedAt: status.probedAt,
		state: status.state,
		plugins: status.plugins,
		dismiss: status.dismiss
	});
}

/* ------------------------------------------------------------------ §4.10 report */

/**
 * §4.10 `report(result)` → `void`
 *
 * 入参 = §4.9 的返回 + 元信息：`{state, missing, blocked, notes?, id|pluginId, version|pluginVersion, note?}`。
 * 行为：**自己写分片**（`compat-status.d/<id>.json`，形状见 `normalizeEntry`：RD-15 的 8 键）
 * + 触发汇总（`compat-status.json`，严格 §5 六键）。
 * 本函数**不依赖任何"另一个 host-compat 实例"**（即使插件面没被装配，动态 import 本文件即可用）。
 * 写失败 ⇒ **静默降级为只用内存态**（§5）。永不 throw。
 */
export function report(result) {
	try {
		const id = asString(result?.id) || asString(result?.pluginId);
		if (!id) {
			warn("report() 缺少 id/pluginId → 无法定位分片，已忽略");
			return;
		}
		const entry = normalizeEntry({
			id,
			version: asString(result?.version) || asString(result?.pluginVersion),
			state: result?.state,
			missing: result?.missing,
			blocked: result?.blocked,
			note: asString(result?.note) || asString(result?.notes),
			probedAt: nowIso()
		});
		memShards.set(id, entry); // 内存态先落地：后面任何写盘失败都不影响面板读数
		try {
			writeJson0600(shardPath(id), entry);
		} catch (err) {
			warn(`分片写入失败 → 只用内存态 (${id}: ${String(err?.message ?? err)})`);
		}
		try {
			persistAggregate();
		} catch (err) {
			warn(`汇总写入失败 → 只用内存态 (${String(err?.message ?? err)})`);
		}
	} catch (err) {
		warn(`report() 异常已忽略: ${String(err?.message ?? err)}`);
	}
}

/* ------------------------------------------------------------------ 总线端点注册表（P1-1 additive） */

/**
 * 通用端点注册表（契约 §12-21 / ENV 红线 7；2026-09-14 用户拍板「通用端点注册」，**不做专用 case**）。
 *   · 中间件**不认识任何具体消费者**（**禁止**写死 `case "notice/list"` 之类），只做路由；
 *   · **不持有业务数据**（契约 §10.6）：注册表里只有 `name → handler` 函数引用；
 *   · `inject` 保持 `["connection"]` 不变；**不新增 RPC 通道、不新增宿主能力 key**（additive 面）。
 *   · 保留名 `status` / `dismiss`（§6 内置端点）⇒ 注册被拒（`{ok:false, reason:"reserved"}`）。
 */
const RESERVED_ENDPOINTS = Object.freeze(["status", "dismiss"]);
const endpointRegistry = new Map();

/**
 * 注册一个总线端点（永不 throw）。
 * @param name 端点名（字符串；建议命名空间式，如 `notice/list`）
 * @param handler `(payload) => 结果对象`（handler 抛错由 `rpcHandler` 包成 `io-error`，**不抛到宿主**）
 * @returns `{ok:true}` | `{ok:true, replaced:true}`（同名重复注册 ⇒ 覆盖）| `{ok:false, reason}`
 */
/* ★`#A55` 步1：0.2.2 起 `connection.rpc.handle` 必失败（官方面 = `connection.fetch.register`）。
 *   每个端点额外（**幂等**）注册一条精确 Fetch 路由 `/api/host-compat/<name>`；
 *   旧宿主没有 `connection.fetch` ⇒ 返回 `{ok:false}`，只走既有 `rpcHandle` 回落，**不改变 0.1.2 行为**。 */
const fetchRouteSet = new Set();
let fetchRouteFailures = 0;
let fetchRouteLastReason = "";

function ensureFetchRoute(name, handler) {
	try {
		if (rootCtx === null) return { ok: false, reason: "no-ctx" };
		const path = `/api/host-compat/${name}`;
		if (fetchRouteSet.has(path)) return { ok: true, already: true };
		const r = fetchRoute(rootCtx, path, name, handler);
		if (r?.ok) {
			fetchRouteSet.add(path);
			return { ok: true, via: "fetch" };
		}
		fetchRouteFailures += 1;
		fetchRouteLastReason = String(r?.reason ?? "unknown");
		return { ok: false, reason: fetchRouteLastReason };
	} catch (err) {
		fetchRouteFailures += 1;
		fetchRouteLastReason = `ensure-fetch-threw:${String(err?.message ?? err)}`;
		return { ok: false, reason: fetchRouteLastReason };
	}
}

/** 把已注册端点全部补注册 Fetch 路由（apply 末尾/惰性重试时调用；幂等）。 */
function flushFetchRoutes() {
	let ok = 0;
	let failed = 0;
	for (const [name, handler] of endpointRegistry) {
		const r = ensureFetchRoute(name, handler);
		if (r.ok) ok += 1;
		else failed += 1;
	}
	return { ok, failed };
}

function registerEndpoint(name, handler) {
	try {
		if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "bad-name" };
		if (typeof handler !== "function") return { ok: false, reason: "bad-handler" };
		if (RESERVED_ENDPOINTS.includes(name)) return { ok: false, reason: "reserved" };
		const replaced = endpointRegistry.has(name);
		endpointRegistry.set(name, handler);
		// ★`#A55`/`#A56`：0.2.2 通道面 —— 顺带（幂等）注册 Fetch 路由；失败**不阻断**端点注册（读通道降级由 probe 上屏）。
		// ⚠️ 必须用 **rpcHandler**（= 旧通道同一分发器）：compatBus 端点 handler 的签名是 `(payload)`，
		//    而信封层给的是 `(endpoint, payload)`；且 rpcHandler 负责包 `{ok:true,value}` 外壳
		//    ⇒ 用原 handler 会把 endpoint 字符串当 payload（实测：`notice/list` 恒 0 条）。
		const fetchReg = ensureFetchRoute(name, rpcHandler);
		// ★`#A63` 步1：返回值**严格守契约 §12-21 形状** —— `{ok:true}` / `{ok:true,replaced:true}`。
		//   `#A57` 曾在返回值上挂 `via`（诊断哪条通道注册成功）⇒ `notice-banner/selftest.mjs` 的
		//   `E-h`（契约深等于）变红 `pass=63 fail=4`。`via` 现读**零消费者**（grep `\.via`：仅
		//   `channelFaceStatus` 自己的 `reg.via`，与本函数无关），且通道面成败已由
		//   `fetchRouteSet`/`fetchRouteFailures` + `channelFaceStatus()` 上屏、失败另有 warn
		//   ⇒ 诊断能力不减，返回形状回归契约（不与调用方隐含耦合）。
		if (!fetchReg.ok && fetchReg.reason !== "no-ctx") warn(`Fetch 路由 /api/host-compat/${name} 注册失败 (${fetchReg.reason})`);
		return replaced ? { ok: true, replaced: true } : { ok: true };
	} catch (err) {
		return { ok: false, reason: `register-failed:${String(err?.message ?? err)}` };
	}
}

/** 已注册端点名（**排序数组**；可见可查 —— ENV 红线 7 ④「端点注册表必须可见可查」）。永不 throw。 */
function listEndpoints() {
	try {
		return [...endpointRegistry.keys()].sort();
	} catch {
		return [];
	}
}

/* ------------------------------------------------------------------ §6 RPC 通道 `/host-compat` */

const badRequest = (message) => ({ ok: false, error: { code: "bad-request", message } });

/** §6 handler：`(endpoint, payload)` → `{ok:true,value}` | `{ok:false,error:{code,message}}` */
function rpcHandler(endpoint, payload) {
	try {
		switch (endpoint) {
		case "status":
			return { ok: true, value: buildStatus() };
		case "dismiss": {
			const hostVersion = asString(payload?.hostVersion).trim();
			if (!hostVersion) return badRequest("需要 hostVersion（非空字符串）");
			const rawSignature = payload?.capabilitySignature;
			if (rawSignature !== undefined && rawSignature !== null && typeof rawSignature !== "string") {
				return badRequest("capabilitySignature 必须是字符串");
			}
			const status = buildStatus();
			// 允许空字符串 ⇒ 用服务端**当前**签名（客户端拿不到当前签名的兼容路径，见 README）
			const dismiss = {
				hostVersion,
				capabilitySignature: asString(rawSignature).trim() || status.capabilitySignature,
				at: nowIso()
			};
			memDismiss = dismiss;
			try {
				persistAggregate();
			} catch (err) {
				return { ok: false, error: { code: "io-error", message: String(err?.message ?? err) } };
			}
			return { ok: true, value: { ok: true, dismiss } };
		}
		default: {
			// P1-1 additive：**先查总线注册表**（通用端点注册；host-compat 不认识任何具体消费者）。
			// 未注册 ⇒ **保持现行** `{ok:false,error:{code:"not-found"}}`（**不新增错误码**）。
			let handler = null;
			try {
				handler = endpointRegistry.get(endpoint) ?? null;
			} catch {
				handler = null;
			}
			if (typeof handler !== "function") return { ok: false, error: { code: "not-found", message: `未知端点: ${String(endpoint)}` } };
			try {
				return { ok: true, value: handler(payload) };
			} catch (err) {
				// handler 抛错 ⇒ 包成 io-error（**不抛到宿主**：宿主侧失败面 = 500/崩树面）
				return { ok: false, error: { code: "io-error", message: String(err?.message ?? err) } };
			}
		}
		}
	} catch (err) {
		return { ok: false, error: { code: "io-error", message: String(err?.message ?? err) } };
	}
}

/* ------------------------------------------------------------------ §8 横幅 */

const isCompatBanner = (event) =>
	(event?.type === "notice/banner" || event?.type === "notice/banner-replace") && event?.data?.kind === BANNER_KIND;

/** §8 payload（字段严格按契约：kind/rev/severity/title/body/buttons；`rev` 由 §4.4 计算覆盖）
 *  P1-2：**追加 §2 schema 必填键**（`schemaVersion/sessionId/source/role/state/text/at`）——
 *  缺键 ⇒ store 逐条丢弃 + 计数（设计稿 §2「不许静默」）；旧键**逐字保留**（旧客户端/旧会话回放）。 */
/** A113：卡身份单点派生（写入与查重共用；同会话恒定 ⇒ 覆盖写）。 */
function compatCardIdOf(sessionId) {
	return sessionId ? createHash("sha256").update("dsh-host-compat|compat|" + String(sessionId)).digest("hex").slice(0, 32) : null;
}

function bannerPayload(status, sessionId = null) {
	const affected = status.plugins.filter((plugin) => plugin.state !== "OK");
	const severity = status.state === "BLOCKED" ? "blocked" : "degraded";
	const title = `插件适配状态：${affected.length} 项${severity === "blocked" ? "阻断" : "降级"}`;
	// ★`#A58`：结构化条目（供对话内降级卡片逐项渲染）；`body` 保留**一行摘要**（旧客户端仍可读）
	const adviceOf = (keys) => {
		if (keys.some((k) => /eventTypeRegistry/.test(k))) return "装/修 host-compat（事件类型注册面）";
		if (keys.some((k) => /projcache/.test(k))) return "检查 projcache 文件可读";
		if (keys.some((k) => /agents/.test(k))) return "该功能已 fail-safe 停用，无需处理";
		if (keys.some((k) => /rpcHandle|channel/.test(k))) return "通道未注册 ⇒ 待迁 /api 新面";
		return "见 设置 → 本地插件 → 适配状态";
	};
	const items = affected.map((plugin) => {
		const keys = [...plugin.missing, ...plugin.blocked];
		return {
			id: plugin.id,
			capState: plugin.state,
			missing: keys,
			why: plugin.note || (keys.length ? `缺少 ${keys.join("、")} 能力` : "适配降级"),
			advice: adviceOf(keys)
		};
	});
	const body = items.map((it) => `${it.id} ${it.why}`).join("；");
	return {
		// ---- §2 schema 必填键（P1-2）----
		schemaVersion: 1,
		sessionId: sessionId ?? null,
		source: OWN_ID,
		role: "banner",
		state: severity === "blocked" ? "error" : "warn",
		text: title,
		at: Date.now(),
		// ---- §8 旧键（逐字保留：旧客户端 bundle + 旧会话日志回放）----
		kind: BANNER_KIND,
		priority: 2, foldable: true, family: "compat",
		rev: 0,
		// ★批7 `T15`（`#A342`）：**稳定身份**（每会话一条）；**本家绕开 `banner-kit`** ⇒ 无其形状校验保护 ⇒ 必须自保 32 hex 形状
		cardId: compatCardIdOf(sessionId),
		severity,
		title,
		body,
		// ★`#A58`：结构化降级条目（additive；旧客户端忽略未知键）
		items,
		buttons: [{ label: "本版本不再提示", action: "dismiss" }],
		// ★A95（用户裁定）：适配状态卡是**跨会话聚合**的状态 ⇒ 声明 anchorLevel=global（不再靠族名豁免）。
		//   中间件自身不发 banner-kit（R7：不认识消费者）⇒ 本行是唯一手工声明点。 anchor-level-lint: allow
		anchorLevel: "global",
		form: "card" // ★A97：compat 卡为常规卡（中间件手工声明） anchor-level-lint: allow
	};
}

/**
 * §8 注入判定（全同步，无并发窗口）：
 *   ① 全域 `state` 必须是 `DEGRADED`/`BLOCKED`（全 OK **不注入**）；
 *   ② `dismiss` 记忆的 `hostVersion + capabilitySignature` 与当前**一致** ⇒ 不注入（用户已关闭）；
 *      任一变化 ⇒ 视为新事件，可再提示；
 *   ③ **每会话一条**：优先查**自有 store**（P1-2 起横幅权威面是 store；步③ 断开日志写入后
 *      "日志里已有 compat 横幅"这条判据会失效 ⇒ 必须有 store 侧判据），store 不可用 ⇒ 退回
 *      会话日志扫描（双轨期/旧会话仍有效）。**不扫描、不改写历史/不活跃会话**（D11/§10.4）。
 */
/* ------------------------------------------------------------------ P1-2 写路径注入（中间件侧） */

/** apply 期注入的宿主 ctx（**只用于惰性 `ctx.get(...)`**；绝不缓存任何服务引用 —— 契约 §12-21 ⑤） */
let rootCtx = null;

/** `noticeState` 服务惰性解析（**字面量形态 + try/catch**；失败 ⇒ `null`，调用方按"服务缺失"降级） */
/* ★`#A66` 步2（**发射侧唯一落点**）：给 `noticeState.append` 包一层**回合号补全**。
 *  背景：`banner-kit.emit()` 直连 sink（不经过 §4.4 `appendNotice`），所以补全必须挂在这里；
 *  `restart`/`queue`/`error`/`compat` 全部经同一 sink ⇒ **四个生产者都覆盖，零业务语义改动**。
 *  只补 `turn === null` 的条目（有值的逐字不动）；取不到就保持 null（消费侧有可诊断兜底）。 */
let wrappedSinkOf = { raw: null, wrapped: null };
function noticeSinkOf() {
	try {
		if (!rootCtx || typeof rootCtx.get !== "function") return null;
		const raw = rootCtx.get("noticeState");
		if (!raw || typeof raw.append !== "function") return raw;
		if (wrappedSinkOf.raw === raw) return wrappedSinkOf.wrapped;
		const wrapped = {
			...raw,
			append: async (entry) => {
				let out = entry;
				try {
					if (entry && typeof entry === "object" && (entry.turn === undefined || entry.turn === null)) {
						const session = entry.sessionId ? rootCtx.get("agents")?.get?.(entry.sessionId)?.session : null;
						const t = resolveTurnForEvent(session, entry);
						if (Number.isFinite(t) && t > 0) out = { ...entry, turn: t };
					}
				} catch { /* 取不到 ⇒ 原样写 */ }
				return raw.append(out);
			}
		};
		wrappedSinkOf = { raw, wrapped };
		return wrapped;
	} catch {
		return null;
	}
}

function hasCompatBanner(sessionId, cardId) {
	// A113：同 cardId 已存在才跳过；无 cardId 的旧式条目不阻断写入。
	if (!cardId) return false;
	try {
		const sink = noticeSinkOf();
		if (sink && typeof sink.list === "function") {
			const r = sink.list(sessionId ?? null);
			if (r && r.ok === true && Array.isArray(r.entries)) {
				return r.entries.some((entry) => entry?.kind === BANNER_KIND && entry?.cardId === cardId);
			}
		}
	} catch {
		/* store 不可用 ⇒ 不阻断（宁写一张，交给同 cardId 覆盖） */
	}
	return false;
}

function maybeInjectBanner(session) {
	try {
		if (!session || !session.id) return;
		// 子 agent 会话不是用户可见会话 ⇒ 不注入 UI 横幅（同 cost-ledger「滤注入 ≠ 抑制写入」先例）
		if (session.header?.origin === "subagent") return;
		const status = buildStatus();
		// A113：状态 OK 也写一张同 cardId 的当前状态卡（客户端按 OK 隐藏），保证"降级→OK"能覆盖旧卡。
		const cardId = compatCardIdOf(session.id);
		const key = dismissKey(status.host.version ?? "", status.capabilitySignature);
		if (status.dismiss && dismissKey(status.dismiss.hostVersion, status.dismiss.capabilitySignature) === key) return;
		// A114（用户裁 A）：状态 OK ⇒ 按稳定 cardId 删本会话 compat 卡（store.deleteCard，oplog 留 snapshot），不再写零降级卡。
		if (status.state === "OK") {
			if (!hasCompatBanner(session.id, cardId)) return;
			const sink = noticeSinkOf();
			if (!sink || typeof sink.deleteCard !== "function") { warn("compat 删卡跳过：noticeState.deleteCard 不可用"); return; }
			void Promise.resolve(sink.deleteCard({ sessionId: session.id, cardId, owner: OWN_ID }))
				.then((r) => { if (!r?.ok) warn(`compat 删卡未成: ${String(r?.reason ?? "unknown")}`); })
				.catch((err) => warn(`compat 删卡异常已忽略: ${String(err?.message ?? err)}`));
			return;
		}
		if (hasCompatBanner(session.id, cardId)) return;
		const result = appendNotice(session, bannerPayload(status, session.id));
		if (result?.ok) {
			warn(`已向会话 ${String(session.id).slice(0, 12)} 注入适配状态横幅 (rev=${result.rev})`);
		}
	} catch (err) {
		warn(`横幅注入异常已忽略: ${String(err?.message ?? err)}`);
	}
}

/** 派发路径外执行（避免在 created/append 发布过程中重入 append） */
function defer(fn) {
	try {
		const timer = setTimeout(fn, 0);
		timer?.unref?.();
	} catch {
		/* 定时器不可用 → 放弃本次（绝不同步 append，避免重入） */
	}
}

/* ------------------------------------------------------------------ 插件装配 */

/* ---------------------------------------------------------------- 可选「会话喂入」注入点
 * obs3S7 段W-2a **2a-2 T1a 骨架件**（仲裁 `#A203` 一 = 六条硬条件，逐条落点）：
 *   ① **`seams.js` 的 §4 冻结面一字不动** ⇒ 本件**完全不碰 `seams.js`**（注入点落在本文件，同 `:524` 先例的位置）；
 *   ② **零新增宿主接触点** ⇒ 只复用 `:541`(`session/created`) 与既有 `session/event`(`turn/start`) 回调里**本就拿到**的 `session`；
 *   ③ 走既有先例（`:524` `setNoticeSinkResolver(() => noticeSinkOf())` 同款"**惰性解析 + try/catch**"）⇒
 *      **存在性检查 + try/catch + 缺失/异常 no-op + 如实降级**（禁"报 OK 而功能坏"）；
 *   ④ **正控**：摘掉 `observeSession` ⇒ 本函数退化为纯 no-op，**既有写入路径逐字不变**（`defer(() => maybeInjectBanner(…))` 一字未改）；
 *   ⑤ **双登记**：`docs/plugins/dsh-host-compat.md`（内部注入点 + 降级语义）+ 设计稿 §12；
 *   ⑥ **可见可查**：`observeSessionState` 进状态分片 `note`（**标注"apply 时快照"**，不冒充运行态）+ 首次定性结果打一条 log。
 *
 * 语义：B（`dsh-notice-banner`）可在其 `noticeState` 服务上加**可选方法** `observeSession(session, event)`；
 *  本中间件**只做转发**、**不持有业务数据**、不认识具体消费者（红线 §一.7③）；**不消费返回值**。
 *  **触发面 = 设计稿 §12.8 裁定 (A)**（`#A205` 四）：`session/created` ⇒ `event = null`；**`session/event` 的每个事件都转发**
 *  （**增量 O(1)/事件**，避免 `readSessionEvents` 整份快照被每事件调用 ⇒ O(n²)）；**行白名单判定留在消费者侧**
 *  （中间件不塞业务类型知识）。
 */
let observeSessionState = "absent"; // absent | ok | throw:<msg> | guard-throw:<msg>
let observeLogged = false;
/* ★ T5（`#A220` 四①）：**冷启动回填** —— 行事实**不跨 boot 存活**（B 侧 `slots/<sid>.json` 只在 `turn/end` 落盘，
 *   进程内 pending 随 boot 丢失）⇒ 首次喂入时把该会话**既有事件**补喂给消费者。
 *   触发面 = **每进程每会话恰一次**（`readSessionEvents` 是整份快照 ⇒ 绝不能每事件调，见 §12.8 裁定 (A) 的成本论证）。
 *
 * ★ A84（`#A84`，2026-11-19）：上版**每次重启都从头回填**（逐事件喂 + 每 `turn/end` 一次 flush ⇒ 全库分钟级主线程独占：
 *   node22 ≈5min／node24 ≈15m42s）。本版三件（**不删回填、不静默、不改官方件、不降功能**）：
 *     ① **断点续（乙）**：`sink.backfillState(sessionId).observedSeq > 0` ⇒ 只喂 `seq > 断点` 的尾部（断点由 B 侧随行事实落盘）；
 *     ② **空转短路（B 侧 `flushSlots`）**：行事实/统计无变化 ⇒ 不重建 ②、不重算全局聚合；
 *     ③ **分片让出（丙）**：待喂 > `OBSERVE_SYNC_MAX` 条时异步分片（每 `OBSERVE_FEED_CHUNK` 条让出一次事件循环），
 *        期间到达的 live 事件**排队保序**（历史先、live 后）⇒ 行事实顺序与全量回填一致。
 *   **"未回填"一律如实上报**：每 boot 一条汇总 log ＋ `compat-backfill.json` 状态件（禁静默）。
 *   ⚠️ 断点缺失（旧会话/被清）⇒ **退回全量回填**（负控口径）；无卡片且无断点 ⇒ 如实"跳过"并记账。 */
const OBSERVE_SYNC_MAX = 400;    // ≤ 此条数同步直喂（断点续常态 = 0–数十条）
const OBSERVE_FEED_CHUNK = 200;  // 分片让出：每 200 条让出一次（实测单块 ≪ 300ms）
const observeBackfilled = new Set();   // sessionId（字符串）：本进程已处理过首次喂入
let observeBackfillCount = 0;          // 最近一次回填喂入的事件数（可见可查）
const observeBackfillStats = { sessions: 0, resumed: 0, full: 0, skipped: 0, feed: 0, skippedEvents: 0, async: 0, maxBlockMs: 0, at: null };
/** ★ A84 ②判据：单次主线程占用峰值（同步直喂 / 单个分片块含其 flush） */
function recordBlock(startedAt) { try { const ms = Number(process.hrtime.bigint() - startedAt) / 1e6; if (ms > observeBackfillStats.maxBlockMs) observeBackfillStats.maxBlockMs = Math.round(ms * 10) / 10; } catch { /* 忽略 */ } }
const observeInFlight = new Map();     // sid → { queue: [] }（回填未完时 live 事件排队）
let observeSummaryTimer = null;

/** 汇总落三处：log ＋ `<statusRoot>/compat-backfill.json`（可见可查；写失败 ⇒ 只影响可见面，不影响任何写路径）。 */
function writeBackfillSummary() {
	const body = { at: nowIso(), ...observeBackfillStats };
	try { writeJson0600(join(statusRoot(), "compat-backfill.json"), body); } catch { /* 状态件写失败 ⇒ 仍有 log */ }
	try {
		logger?.info?.(`dsh-host-compat: 会话行事实冷启动回填汇总 会话=${body.sessions} 按断点续=${body.resumed} 全量=${body.full} 跳过无卡片=${body.skipped} 喂入=${body.feed} 跳过事件=${body.skippedEvents} 分片异步=${body.async} 单次峰值=${body.maxBlockMs}ms`);
	} catch { /* 日志失败不影响任何路径 */ }
}
/** 回填静默 2s 后写汇总（多次 backfill 合并成一条，避免刷屏）。 */
function scheduleBackfillSummary() {
	try {
		observeBackfillStats.at = nowIso();
		if (observeSummaryTimer) clearTimeout(observeSummaryTimer);
		observeSummaryTimer = setTimeout(() => { observeSummaryTimer = null; writeBackfillSummary(); }, 2000);
		observeSummaryTimer?.unref?.();
	} catch { /* 定时器不可用 ⇒ 放弃汇总（每会话回填仍有 log） */ }
}
/** live 事件转发（原 `notifyObserveSession` 尾段逐字保留语义）。 */
function forwardObserve(sink, session, event) {
	try {
		sink.observeSession(session, event);
		observeSessionState = "ok";
		if (!observeLogged) {
			observeLogged = true;
			try { logger?.info?.(`dsh-host-compat: 会话喂入注入点已启用（observeSession ok；会话 ${String(session.id).slice(0, 12)}）`); } catch { /* 日志失败不影响任何路径 */ }
		}
	} catch (err) {
		observeSessionState = `throw:${String(err?.message ?? err)}`;
		if (!observeLogged) {
			observeLogged = true;
			try { warn(`会话喂入注入点抛错 ⇒ **如实降级为 no-op**（不影响既有写入路径）: ${String(err?.message ?? err)}`); } catch { /* 同上 */ }
		}
	}
}
/** 分片异步回填（丙）：每 `OBSERVE_FEED_CHUNK` 条 `setImmediate` 让出；结束后 flush 一次并排空 live 队列。 */
async function runObserveBackfill(sink, session, feed, entry) {
	try {
		for (let i = 0; i < feed.length; i += OBSERVE_FEED_CHUNK) {
			const blockAt = process.hrtime.bigint();
			const chunk = feed.slice(i, i + OBSERVE_FEED_CHUNK);
			for (const ev of chunk) { try { sink.observeSession(session, ev); } catch { /* 逐事件隔离 */ } }
			recordBlock(blockAt);
			await new Promise((resolve) => setImmediate(resolve));
		}
		const flushAt = process.hrtime.bigint();
		try { if (typeof sink.flushRows === "function") sink.flushRows(session); } catch { /* 可选方法 */ }
		recordBlock(flushAt);
	} catch { /* 兜底：异步路径绝不冒泡 */ } finally {
		const sid = String(session.id);
		try { for (const ev of entry.queue) forwardObserve(sink, session, ev); } catch { /* 逐事件隔离 */ }
		observeInFlight.delete(sid);
		scheduleBackfillSummary();
	}
}

/**
 * ★ A84：**回填计划**（纯函数；导出供判据仪器直接对撞 —— 与 `notifyObserveSession` 用**同一实现**，禁止两处各写一份）。
 * @param {Array<object>|null} hist 既有事件快照（`readSessionEvents` 的返回）
 * @param {object|null} bstate 消费者断点（`sink.backfillState` 的返回；旧消费者 ⇒ null）
 * @returns {{mode:"empty"|"skip-nocard"|"resume"|"resume-none"|"full", feed:Array, resumeSeq:number, cards:number|null, total:number, skipped:number}}
 */
export function planObserveBackfill(hist, bstate) {
	const total = Array.isArray(hist) ? hist.length : 0;
	const known = !!(bstate && bstate.ok !== false);
	const resumeSeq = known && Number.isFinite(Number(bstate.observedSeq)) ? Number(bstate.observedSeq) : 0;
	const cards = known && Number.isFinite(Number(bstate.cards)) ? Number(bstate.cards) : null;
	let feed = [];
	let mode = "full";
	if (!Array.isArray(hist) || total === 0) mode = "empty";
	else if (known && resumeSeq <= 0 && cards === 0) mode = "skip-nocard";
	else if (resumeSeq > 0) {
		const lastSeq = (() => { for (let i = hist.length - 1; i >= 0; i -= 1) { const sq = hist[i]?.seq; if (Number.isInteger(sq)) return sq; } return 0; })();
		if (lastSeq <= resumeSeq) mode = "resume-none";
		else { feed = hist.filter((e) => Number.isInteger(e?.seq) && e.seq > resumeSeq); mode = "resume"; }
	} else feed = hist;
	return { mode, feed, resumeSeq, cards, total, skipped: Math.max(0, total - feed.length) };
}

function notifyObserveSession(session, event = null) {
	try {
		if (!session || session.id === undefined || session.id === null) return;
		const sink = noticeSinkOf();
		if (!sink || typeof sink.observeSession !== "function") {
			observeSessionState = "absent";
			return;
		}
		const bkey = String(session.id);
		const inflight = observeInFlight.get(bkey);
		if (inflight) { inflight.queue.push(event); return; }   // ★ 回填未完 ⇒ live 事件排队（保序）
		if (observeBackfilled.has(bkey)) { forwardObserve(sink, session, event); return; }
		// ★ T5：**首次喂入 ⇒ 断点续/回填该会话既有事件**（只读既存 §4.1 面；失败 ⇒ 如实降级、不影响既有路径）
		try {
			observeBackfilled.add(bkey);                        // 先占位（防重入；失败也不再重试 ⇒ 不放大成本）
			let bstate = null;
			try { if (typeof sink.backfillState === "function") bstate = sink.backfillState(bkey); } catch { bstate = null; }
			const hist = readSessionEvents(session);
			const plan = planObserveBackfill(hist, bstate);   // ★ 与判据仪器同一实现
			const { mode, feed, resumeSeq, skipped } = plan;
			observeBackfillStats.sessions += 1;
			observeBackfillCount = feed.length;
			if (mode === "skip-nocard") {
				observeBackfillStats.skipped += 1;
				observeBackfillStats.skippedEvents += skipped;
			} else if (feed.length) {
				observeBackfillStats.feed += feed.length;
				observeBackfillStats.skippedEvents += skipped;
				if (mode === "resume") observeBackfillStats.resumed += 1; else observeBackfillStats.full += 1;
			}
			try {
				if (feed.length) logger?.info?.(`dsh-host-compat: 会话行事实冷启动回填 ${mode === "resume" ? "按断点续" : "全量"} 喂 ${feed.length} 条 / 跳过 ${skipped} 条（断点 seq=${resumeSeq}；会话 ${bkey.slice(0, 12)}）`);
				else if (mode === "skip-nocard") logger?.info?.(`dsh-host-compat: 会话行事实冷启动回填 跳过（无卡片且无断点；${skipped} 条事件未回填；会话 ${bkey.slice(0, 12)}）`);
			} catch { /* 日志失败不影响任何路径 */ }
			if (feed.length > OBSERVE_SYNC_MAX) {
				observeBackfillStats.async += 1;
				const entry = { queue: [event] };
				observeInFlight.set(bkey, entry);
				void runObserveBackfill(sink, session, feed, entry);   // ★ 丙：分片异步（不 await、不阻塞宿主事件分发）
				scheduleBackfillSummary();
				return;
			}
			const syncAt = process.hrtime.bigint();
			for (const ev of feed) { try { sink.observeSession(session, ev); } catch { /* 逐事件隔离 */ } }
			if (feed.length) { try { if (typeof sink.flushRows === "function") sink.flushRows(session); } catch { /* 同上：可选方法，失败即 no-op */ } }
			if (feed.length) recordBlock(syncAt);
			forwardObserve(sink, session, event);
			scheduleBackfillSummary();
			return;
		} catch (err) {
			try { warn(`会话行事实冷启动回填失败 ⇒ **如实降级为 no-op**（不影响既有写入路径）: ${String(err?.message ?? err)}`); } catch { /* 同上 */ }
		}
		forwardObserve(sink, session, event);
	} catch (err) {
		observeSessionState = `guard-throw:${String(err?.message ?? err)}`;
	}
}

/* ------------------------------------------------ 就绪订阅面（批 4 件②：「丙」） */

/** RPC 通道是否已成功注册（**幂等打标** —— `#A96` 条 2 ②③：已注册成功 ⇒ 不再注册，防 `duplicate`）。 */
let ownRpcRegistered = false;
/** 就绪订阅的接入状态（**如实降级用** —— `#A98` 补充约束②）。 */
let readySubState = "absent"; // absent | subscribed | catch-up | unsupported | failed
let readySubReason = "";

/**
 * 尝试注册 §6 RPC 通道（**幂等**：成功过即跳过）。
 * @returns `{ok:true, already?:true}` | `{ok:false, reason}`
 */
function tryRegisterOwnRpc() {
	if (ownRpcRegistered) return { ok: true, already: true };
	try {
		const r = rpcHandle(rootCtx, CHANNEL, rpcHandler);
		if (r?.ok) {
			ownRpcRegistered = true;
			return { ok: true };
		}
		// ★ 失败语义**如实点名**（不得折成模糊码）：`rpcHandle`（能力未就绪）／`duplicate …`（打标失效）
		return { ok: false, reason: String(r?.reason ?? "unknown") };
	} catch (err) {
		return { ok: false, reason: `rpc-handle-threw:${String(err?.message ?? err)}` };
	}
}

/**
 * 向 `compatBus` 订阅「能力就绪」（**含 catch-up**；`#A98` 裁定 1）。
 * 兼容性（`#A98` 补充约束③）：**旧版/桩 bus 无 `onReady` ⇒ 不抛崩**、如实记 `unsupported`。
 * 耗尽/失败 ⇒ **不得只 `warn` 了事**（补充约束②）⇒ 记 `readySubState/readySubReason`，由 `report()` 进分片 note。
 */
function subscribeReady() {
	const bus = (() => {
		try {
			// ★ 件⑪ 修法（`#A113` 条 1）：**必须传 `false`（非 strict）** —— `provide()` 走 fiber effect，
			//   同一 fiber 的**同步阶段** strict 取不到（实测 `strict=undefined` / `loose=取到`）⇒ 否则自订阅恒落 `unsupported`。
			return rootCtx?.get?.("compatBus", false) ?? null;
		} catch {
			return null;
		}
	})();
	if (!bus || typeof bus.onReady !== "function") {
		readySubState = "unsupported";
		readySubReason = "compatBus 无 onReady（旧版/桩 bus）⇒ 未接入就绪订阅（如实降级，不抛崩）";
		warn(`dsh-host-compat: ${readySubReason}`);
		return;
	}
	const r = bus.onReady((reason) => {
		const before = ownRpcRegistered;
		const reg = tryRegisterOwnRpc();
		readySubState = reg.ok ? (reg.already ? "subscribed" : "registered") : "failed";
		readySubReason = reg.ok ? `就绪订阅触发(${reason}) ⇒ RPC 通道${reg.already ? "此前已注册" : "已补注册"}` : `就绪订阅触发(${reason}) ⇒ 补注册失败: ${reg.reason}`;
		logger?.info?.(`dsh-host-compat: ${readySubReason}（前值 registered=${before}）`);
	});
	if (r && r.ok === false) {
		readySubState = "failed";
		readySubReason = `订阅失败: ${String(r.reason ?? "unknown")}`;
		return;
	}
	readySubState = r?.ready === true ? "catch-up" : "subscribed";
	readySubReason = r?.ready === true ? "订阅时能力已就绪 ⇒ 已按 catch-up 补注册" : "已订阅，等待能力就绪";
}

/**
 * 装配（永不 throw）：
 *   ① boot 能力探测一次（§4.8，填 §1 允许的缓存）；
 *   ② 注册自定义事件类型（否则横幅落盘后会话无法加载）；
 *   ③ 注册 §6 RPC 通道（自动带 GUI cookie 门禁）；
 *   ④ 自检 + §4.10 report 自己的分片（触发首次聚合）；
 *   ⑤ 挂 §8 横幅注入（`session/created` = 新会话/恢复会话；`turn/start` = 用到的会话）
 *      ＋ **可选会话喂入**（2a-2 T1a；见上，no-op 安全）。
 */
/** ★自检异常（`ENV §一.6②`：禁"报 OK 而功能坏"）——只在**确实发生**时入列，并由 `buildStatus()` 如实上屏 */
const selfIssues = [];

export async function apply(ctx) {
	try {
		logger = ctx?.logger ?? null;
		try {
			let ws = null;
			try { ws = ctx?.webServer ?? null; } catch {}
			if (!ws) { try { ws = ctx?.root?.get?.("webServer", false) ?? null; } catch {} }
			setWebServerService(ws);
		} catch { /* 宿主无 webServer ⇒ 路由出口如实不可用 */ }
		const info = hostInfo(ctx); // ① boot 探测

		const types = ensureEventTypes(BANNER_TYPES); // ②
		if (!types.ok) {
			// ★顺带修既有缺口（`ENV §一.6②`）：原实现**只 warn** ⇒ 出现"报 OK 而功能（横幅注入）坏"。
			//   现在：入 `selfIssues` ⇒ `buildStatus()` 把它上屏（面板可见）＋ 聚合 `state` 如实降级。
			selfIssues.push({ code: "event-types", reason: String(types.reason) });
			warn(`自定义事件类型注册失败 (${types.reason}) → 横幅将不注入（已如实登记到面板）`);
		}

		// ②b P1-1 additive：总线端点注册表（`ctx.provide` 写法照 dsh-notify 的 notifyHub）。
		// 中间件**不持有业务数据**、不认识具体消费者；消费方（如 notice-banner）自行注册端点。
		try {
			// ②b P1-1 additive ＋ **批 4 件②「丙」第 3 键 `onReady(cb)`**（`#A98` 补充约束①）：
		//   `compatBus` 键集**可见可查**；旧版/桩 bus 只有两键 ⇒ 消费方须如实降级、**不得抛崩**。
		ctx.provide?.("compatBus", {
			registerEndpoint,
			listEndpoints,
			/** 订阅「服务类能力首次就绪」（含 **catch-up**：订阅时已就绪 ⇒ 立即回调一次）。
			 *  @returns `{ok:true, ready, unsubscribes}` | `{ok:false, reason}` —— **永不 throw**。 */
			onReady: (cb) => onReadySubscribe(cb),
			/** 就绪面只读读数（判据用）：`{fired, subs, lastRpcHandle}`。 */
			readyStats: () => readyStats()
		});
		} catch (err) {
			warn(`compatBus 服务注册失败 (${String(err?.message ?? err)}) → 端点注册面不可用（读通道随之降级）`);
		}

		// ②c P1-2：把 §4.4 的写入 sink 解析器注入 seams（**中间件是唯一持有宿主 ctx 的地方**；
		// 解析一律「字面量 + 惰性 + try/catch」——服务可能后到/退出，**禁止** apply 期缓存服务引用）。
		rootCtx = ctx;
		// ★`#A66`：把根上下文交给 seams（`rpcHandle` 探测的兜底视野；见 seams `setProbeRootCtx`）
		try { setProbeRootCtx(rootCtx); } catch { /* 旧 seams 无此导出 ⇒ 忽略 */ }
		// ★`#A66`：给 `appendNotice` 注入会话解析器（banner-kit 的 emit 传 null session）
		try {
			setSessionResolver((sid) => {
				try { return rootCtx?.get?.("agents")?.get?.(sid)?.session || null; } catch { return null; }
			});
		} catch { /* 旧 seams ⇒ 忽略 */ }
		try {
			setNoticeSinkResolver(() => noticeSinkOf());
		} catch (err) {
			warn(`§4.4 写入 sink 注入失败 (${String(err?.message ?? err)}) → 横幅写自有 store 面将降级为 reason:"noticeState"`);
		}

		const rpc = tryRegisterOwnRpc(); // ③（幂等：成功过即跳过）
		if (!rpc.ok) warn(`RPC 通道 ${CHANNEL} 注册失败 (${rpc.reason})`);
		// ★`#A55` 步1/步3：0.2.2 通道面 = `/api/host-compat/<endpoint>` 精确 Fetch 路由（复用 /api cookie 门禁）。
		// ★`#A56`：host-compat **自身**端点（status/dismiss）不在 compatBus 里 ⇒ 单独补注册（同一条 rpcHandler）
		try {
			ensureFetchRoute("status", rpcHandler);
			ensureFetchRoute("dismiss", rpcHandler);
		} catch (err) {
			warn(`自身端点 Fetch 路由注册异常: ${String(err?.message ?? err)}`);
		}
		const flushed = flushFetchRoutes();
		const viaFetch = fetchRouteSet.size > 0;
		setRpcRegistration({
			via: rpc.ok ? "rpc" : (viaFetch ? "fetch" : "none"),
			ok: rpc.ok === true || viaFetch === true,
			reason: rpc.ok || viaFetch ? "" : String(rpc.reason ?? fetchRouteLastReason ?? "unknown"),
			routes: fetchRouteSet.size,
			failed: flushed.failed
		});
		if (!rpc.ok) warn(`旧通道 rpc.handle 不可用（${rpc.reason}）⇒ 已改用 /api Fetch 路由 ${fetchRouteSet.size} 条${flushed.failed ? `（另有 ${flushed.failed} 条失败：${fetchRouteLastReason}）` : ""}`);

		// ③b ★「丙」（批 4 件②）：**必须覆盖 host-compat 自身**（`#A96` 裁定③）——它既播报也需自订阅
		try {
			subscribeReady();
		} catch (err) {
			readySubState = "failed";
			readySubReason = `就绪订阅异常: ${String(err?.message ?? err)}`;
			warn(`dsh-host-compat: ${readySubReason}`);
		}

		const own = probe(OWN_REQUIRES, OWN_ID, VERSION, ctx); // ④
		// ★`#A55` 步3：**实际注册结果**进面板（不能只判方法存在）；两路都失败 ⇒ 如实 DEGRADED 并点名。
		const reg = rpcRegistrationState();
		const channelOk = reg?.ok === true;
		const channelNote = reg === null
			? "通道面: 未尝试"
			: channelOk
				? `通道面: OK（${reg.via === "fetch" ? `fetch ${reg.routes} 条 /api/host-compat/*` : "rpc.handle 旧通道"}）`
				: `通道面: **未注册**（rpc.handle 与 fetch 均失败：${reg.reason}）`;
		// ★`#A57`：自身已走 Fetch 面时，`rpcHandle`（旧通道）失败**不构成降级** —— 只按"其余能力 + 通道面"判定
		const ownMissing = own.missing.filter((k) => !(channelOk && k === "rpcHandle"));
		const ownBlocked = (own.blocked || []).filter((k) => !(channelOk && k === "rpcHandle"));
		const ownState = ownBlocked.length ? "BLOCKED" : (ownMissing.length ? "DEGRADED" : "OK");
		const stateOut = ownState === "OK" && !channelOk && reg !== null ? "DEGRADED" : ownState;
		// 去重（`#A55` 曾出现 missing ["rpcHandle","rpcHandle"]）
		const missingOut = channelOk || reg === null
			? [...new Set(ownMissing)]
			: [...new Set([...ownMissing, "rpcHandle"])];
		report({
			...own,
			state: stateOut,
			missing: missingOut,
			id: OWN_ID,
			version: VERSION,
			// ★`#A60` 步2：note 与 `state/missing` **同源**（此前 note 用过滤前 `own.missing`，会出现
			//   `state=OK` 却写"缺失 rpcHandle"的自相矛盾）
			note: `${ownState === "OK" ? "适配层自身能力齐备" : `适配层自身能力缺失: ${[...ownMissing, ...ownBlocked].join(", ") || "(未列明)"}`}｜ ${channelNote}｜ 会话喂入注入点(apply 时快照): ${observeSessionState}｜ 就绪订阅: ${readySubState}${readySubReason ? `(${readySubReason})` : ""}`
		});

		if (typeof ctx?.on === "function") { // ⑤
			ctx.on("session/created", (session) => {
				notifyObserveSession(session, null); // 2a-2 T1a：可选喂入（缺失/异常 = no-op；**不改** 下面 defer 的既有语义）
				defer(() => maybeInjectBanner(session));
			}, { global: true });
			ctx.on(
				"session/event",
				(session, event) => {
					// §12.8 裁定 (A)：**每个事件**都转发（增量 O(1)/事件）；白名单在消费者侧早退
					notifyObserveSession(session, event);
					if (event?.type === "turn/start") defer(() => maybeInjectBanner(session)); // 既有行为一字不变
				},
				{ global: true }
			);
		}

		logger?.info?.(
			`dsh-host-compat: 就绪 v${VERSION}（宿主 ${info.version ?? "未知"}，状态 ${buildStatus().state}，通道 ${CHANNEL}${rpc.ok ? "" : " 未注册"}）`
		);
	} catch (err) {
		warn(`apply 异常已忽略（不阻断宿主装配）: ${String(err?.message ?? err)}`);
	}
}

/* ------------------------------------------------------------------ 主入口转出（§4.8/§4.9/§4.10 见上面的实现） */

export { hostInfo, probe };
