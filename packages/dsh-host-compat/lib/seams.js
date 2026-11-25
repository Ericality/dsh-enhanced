/**
 * @ericality/dsh-host-compat — seams（纯函数库，**无 ctx**，可被任何自家插件动态 import）
 *
 * 契约：`docs/待办/2026-09-13-契约-host-compat-v1.md`（v1 冻结；禁止发明字段）
 * 落点：`docs/待办/2026-09-13-阶段1-契约落点与决策.md` §2（seam 落点表）
 *
 * 本文件实现 §4 的：
 *   §4.1 readSessionEvents(session)      → Event[] | null
 *   §4.2 turnEndsOf(session)             → Array<{turn,seq,time,reason}>（不可用返回 []）
 *   §4.4 appendNotice(session, payload)  → {ok,mode:"start"|"replace",rev} | {ok:false,reason}
 *   §4.5 ensureEventTypes(types)         → {ok,registered:string[]}
 *   §4.6 rpcHandle(ctx, channel, handler) → {ok} | {ok:false,reason}   ← 唯一按契约收 ctx 的面
 *   §4.8 hostInfo(ctx?)                  → {version,capabilities,detectedAt}
 *   §4.9 probe(requires,pluginId,pluginVersion,ctx?) → {state,missing,blocked,notes?}
 * 阶段 3 才实现（本文件**故意不做**）：§4.3 sessionText / §4.7 readProjcache / §4.10 之外的
 * 客户端面 clientSeams()（契约 §4 末、任务书 §6）。
 *
 * 纪律（契约 §1/§10）：
 *   - **零第三方依赖**；宿主包只用 `createRequire` 懒加载 + try/catch（**顶层 import 永不 throw**）。
 *   - 顶层无副作用；**永不 throw**（失败一律返回 `{ok:false,reason}` 或该面的"不可用值"）。
 *   - 探测**只用无副作用 API**（方法存在性 / 路径形状 / 服务存在性；绝不用 resume 类，§10.8）。
 *   - 唯一模块级缓存 = 能力探测结果（§1）；存放业务数据/业务状态 = 违规。
 */

import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ 错误码出口（T2 接线）
 * 内联自 `scripts/errcode/template-helper.js`（守 §1.1「各插件自带薄 helper ≤20 行」+ D19 零跨包 import）。
 * 出口名 = `reportErr`（§1.1 冻结；`report` 在本仓另是闸门申报契约，两者不得混用）；返回 void、永不 throw。
 * 落 `<root>/log/error-fallback/<PKG>.log`（D23；本批不写 $DSH_HOME，§2.0-4）= 闸门/reporter 缺席时的兜底写入器（D2）。
 * ⚠️ 与模板的唯一差异（已在报告登记）：内层函数**匿名**（模板里叫 `reportErr`）—— 否则门禁
 *    `scripts/error-surface-lint.mjs` 的出口抽取会把**函数定义行**当成一次出口调用（默认参数不是对象属性
 *    => 误计 `joinKeyMissing`），污染既有读数。`site` 帧位与语义逐字不变。
 */
const PKG = "dsh-host-compat";
function makeReportErr(root = process.env.DSH_HOME || process.cwd()) {
	const dir = `${root}/log/error-fallback`;
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

/* ------------------------------------------------------------------ §3 能力标识 */

/** §3 冻结的 10 个 `requires` key（顺序 = 契约表顺序）。**不对外导出**：§4 之外不加面（§7）。 */
const CAPABILITY_KEYS = Object.freeze([
	"sessionEvents",
	"sessionAppend",
	"eventTypeRegistry",
	"projcache",
	"rpcHandle",
	"commands",
	"tools",
	"agents",
	// 2026-11-24 增补 r6（Agent Teams 团队成员判定，**待契约登记与用户签**）：团队服务存在性
	"agentTeams",
	"webServerRoute",
	"hostVersion",
	// 2026-11-21 增补 r5（用户批准，观察期至 2026-12-05）：同源中继用的两条路由 seam
	"webServerPrefix",
	"webServerUpgrade"
]);

/** §3：缺失即 **BLOCKED** 的 key（其余一律 DEGRADED）；D1「写错数据/发错指令」判定 */
const BLOCKED_BY_DEFAULT = Object.freeze(["agents"]);

/** §1 允许的唯一模块级缓存：能力探测结果（boot 时算一次） */
let detectionCache = null; // { capabilities, version, detectedAt }

/* ==========================================================================================
 * P1-2 · §4.4 写路径接线（**内部注入点，非 §4 冻结面**）
 *
 * 写路径（唯一）：生产者 → `bannerKit.emit(payload, opts)`（**去 session**；payload 必含 schema
 *   必填键，含 `sessionId`）→ 本文件 `appendNotice(session, payload)`（**签名保持**） → 经下面
 *   注入的 sink 解析 → `noticeState.append(entry)` → store（`dsh-notice-banner` 自有面）。
 *
 * 纪律（ENV 红线 7 / doctrine R1）：
 *   · `seams.js` **禁止直接 import** `dsh-notice-banner`（N×N 点对点）——只认"宿主/中间件注入的
 *     解析函数"；注入由 `lib/index.js` 的 `apply` 完成（`ctx.get("noticeState")` 字面量 + 惰性 + try/catch）；
 *   · sink 缺失 ⇒ `{ok:false, reason:"noticeState"}`：**不写日志、不 throw、不上屏**；
 *   · 下面两个 setter 是**内部面**（仅供同包 `lib/index.js` 调用），**不进契约 §4 冻结面**。
 * ========================================================================================== */

/** sink 解析器（`() => noticeState 服务 | null`；由 `lib/index.js` 在 apply 期注入） */
let noticeSinkResolver = null;

/**
 * **内部（非 §4 冻结面）**：注入 `noticeState` 服务解析器。
 * 传非函数 ⇒ 视为清除。永不 throw。
 */
export function setNoticeSinkResolver(fn) {
	try {
		noticeSinkResolver = typeof fn === "function" ? fn : null;
		return { ok: true };
	} catch {
		return { ok: false, reason: "bad-argument" };
	}
}


/**
 * R1 · 步③（2026-09-14 本批）：**双轨期已结束** —— 旧会话日志写入**物理删除**（不再有 `session.append`）。
 *
 * ⚠️ 与派单口径的**唯一偏离（已报协调人）**：协调人冻结的是"用模块常量 `DUAL_TRACK_LOG` 控制是否仍写旧日志，
 * 步③ 改成 `false`"。但硬门禁 ② 的检查器 `plugin-independence-check.mjs` 规则 A 是**纯语法判定**
 * （`.append("<自定义类型>"` 出现即红，**不看常量取值**）⇒ 只要双轨代码还在文件里，"全量红 0" 就不可能达成。
 * 二者不可兼得 ⇒ 本批选择**物理删除**（真断开、红 0），**回退方式 = 恢复本段代码块**（备份/patch），
 * 不再是"一个常量翻转"。其余（sink 缺失 ⇒ `{ok:false,reason:"noticeState"}`、签名保持、不写日志不 throw 不上屏）逐条照办。
 */
export const DUAL_TRACK_LOG = false; // 仅供外部文档/测试断言读取；写入路径已无日志分支

/** 惰性解析 sink（每次调用都重解析；**禁止**缓存服务引用 —— 契约 §12-21 ⑤）。永不 throw。 */
function resolveNoticeSink() {
	try {
		if (typeof noticeSinkResolver !== "function") return null;
		const sink = noticeSinkResolver();
		return sink && typeof sink.append === "function" ? sink : null;
	} catch {
		return null;
	}
}


/* ==========================================================================================
 * 段2 `B6`（2026-09-29；"不得静默"整改 —— `ENV §一.6②`）· **拒收必须 ① 落原因码 ② 面板可见 ③ 点名**
 *
 * 缺口（`#A394` 段2 B6）：`banner-kit.emit` 在**形状校验不过时就把 entry 退回生产者**（`:191`）⇒ entry
 *   **到不了 store** ⇒ 无 `rejected`／无 `rejectedByReason`／无原因码 ⇒ **对用户可见面 ≡ 静默丢弃**。
 * 处置（**不改 `dsh-banner-kit/**` 契约面**）：
 *   · `reportBannerReject(...)` —— 登记点到 `noticeState.reportRejected`（store 侧**同一条 ① `rejected`**）；
 *   · `wrapBannerKit(mod, owner)` —— 生产者把 banner-kit 模块**包一层**（emit 拒收自动上报）。
 * ========================================================================================== */

/** 该 `reason` 是否属**拒收**（形状/参数非法）。环境类降级（`host-compat`／`noticeState`／`append-failed`）
 *  走各家既有的 `reportDegraded`／日志面，**不**在此重复登记（避免一次能力缺失被刷成 N 条 `rejected`）。 */
function isRejectReason(reason) {
	const r = String(reason ?? "");
	return /^bad-entry/.test(r) || /^bad-argument/.test(r);
}

/**
 * 登记一条**生产者侧拒收**到用户可见面（① 落原因码 ＋ 面板 `rejectedByReason` 可见 ＋ 点名 `owner`）。
 *   sink 不具备该面（旧部署）⇒ **如实返回** `{ok:false, reason:"reject-sink-unavailable"}`（**不伪造成功**）。永不 throw。
 */
export function reportBannerReject({ owner = null, reason = "unknown", sessionId = null, snapshot = null } = {}) {
	try {
		const sink = resolveNoticeSink();
		if (!sink) {
			// ★T2 接线：notice sink 缺失 ⇒ 拒收原因码进不了面板 ⇒ 用户看不到本该看到的横幅拒收面。
			reportErr({ code: "reject-sink-missing", detail: "cap=noticeState", severity: "state" });
			return { ok: false, reason: "noticeState" };
		}
		if (typeof sink.reportRejected !== "function") return { ok: false, reason: "reject-sink-unavailable" };
		const r = sink.reportRejected({ owner, reason, sessionId, snapshot });
		return (r && typeof r === "object") ? r : { ok: true };
	} catch (err) {
		return { ok: false, reason: `report-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * 把 `banner-kit` 模块包一层：**`emit` 拒收 ⇒ 经 `reportBannerReject` 上报**（路径 A 不再静默）。
 *   · **只包 `emit`**，其余导出**原样透传**（不新增/不改契约键，不改 `OPTIONAL_KEYS`/`SCHEMA_VERSION`）；
 *   · `mod` 无 `emit` ⇒ **原样返回**（调用方行为逐字不变）；上报失败**绝不影响** emit 返回值（主流程优先）。
 */
export function wrapBannerKit(mod, owner) {
	try {
		if (!mod || typeof mod.emit !== "function") return mod;
		const raw = mod.emit.bind(mod);
		const who = (typeof owner === "string" && owner) ? owner : "unknown-producer";
		return {
			...mod,
			emit: async (payload, opts) => {
				const r = await raw(payload, opts);
				if (r && r.ok !== true && isRejectReason(r.reason)) {
					try {
						reportBannerReject({
							owner: who,
							reason: String(r.reason),
							sessionId: (payload && payload.sessionId !== undefined)
								? payload.sessionId
								: (opts && opts.sessionId !== undefined ? opts.sessionId : null),
							snapshot: (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : null
						});
					} catch { /* 上报失败不影响主流程（store 侧 `appendEntry` 另有兜底） */ }
				}
				return r;
			}
		};
	} catch {
		return mod;
	}
}


/* ------------------------------------------------------------------ 宿主探测（同步、无副作用） */

/**
 * 宿主数据根目录：`${DSH_HOME:-$DSH_HOME}`。
 * 注意**不用** `DSH_COMPAT_DIR`：那个是 §5 状态文件的落点覆盖（`lib/index.js` 用），
 * 而投影缓存路径是宿主自己的数据面（各插件现状即 `${DSH_HOME}/storages/...`），两者不能绑死。
 */
function hostDataRoot() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** ★ **测试注入点（`#A77` 判据用；默认关闭、零副作用）**：`DSH_HC_TEST_RESOLVE_FAIL=<specifier>`
 *  ⇒ 让该 specifier 的解析**强制失败**并抛"解析不到该 specifier"形态的错误 ⇒ 供判据验证
 *  「**瞬时失败 ⇒ `unprobed`（不得 `BLOCKED`）**」与「**连续确认 ⇒ `missing`（`BLOCKED`）**」两臂。
 *  默认（未设该 env）时下方 `if` **恒不进入** ⇒ 生产路径**逐字不变**。 */
function testForcedResolveFail(specifier) {
	const forced = process.env.DSH_HC_TEST_RESOLVE_FAIL;
	if (!forced || forced !== specifier) return false;
	const err = new Error(`Cannot find module '${specifier}' (test-forced)`);
	err.code = "MODULE_NOT_FOUND";
	err.requireStack = [];                 // 空栈 ⇒ 走 `unresolvableSpecifier()` 的"解析不到该 specifier"分支
	throw err;
}

/**
 * 懒加载宿主包（同步）。
 * 用 `createRequire` 而不是静态 `import`：宿主包缺失时**顶层 import 不 throw**（§1）。
 * 注意：Node ≥20.19 / ≥22.12 的 require(esm) 才能直接拿到 ESM 命名空间；失败即 null。
 */
function hostPackage(specifier) {
	try {
		testForcedResolveFail(specifier);
		return createRequire(import.meta.url)(specifier);
	} catch {
		return null;
	}
}

/** ★ **`#A77` 裁定 (c1)**：该次 `require` 失败是否属**"specifier 本身解析不到"**（⇒ 能力**无法取证**）。
 *  区分口径（**写死、勿放宽**）：`code === "MODULE_NOT_FOUND"` **且** `requireStack` 为空
 *  ⇒ 是**解析不到该 specifier 本身**；**有** `requireStack` ⇒ 是**包内**依赖缺失（包**在**、其内部坏）
 *  ⇒ **不算"无法取证"**（仍按缺能力如实报）。其余错误码（如 `ERR_REQUIRE_ESM`）**一律不算**（属真实不兼容）。
 *  ⇒ 本判定**只用于把"未取证"与"真缺"分开**，**不改变**任何 `false` 的既有含义。 */
export function unresolvableSpecifier(err, specifier) {
	if (!err || err.code !== "MODULE_NOT_FOUND") return false;
	const stack = err.requireStack;
	if (Array.isArray(stack) && stack.length > 0) return false;
	const msg = String(err.message || "");
	return msg.includes(`'${specifier}'`) || msg.includes(`"${specifier}"`);
}

function hostSessionModule() {
	return hostPackage("@deepseek-ai/dsh-session");
}

/** 宿主版本：`@deepseek-ai/dsh/package.json` 的 version（§3 第 10 行：package.json 或运行时） */
function detectHostVersion() {
	try {
		const require_ = createRequire(import.meta.url);
		const file = require_.resolve("@deepseek-ai/dsh/package.json");
		const version = JSON.parse(readFileSync(file, "utf8"))?.version;
		return typeof version === "string" && version ? version : null;
	} catch {
		return null;
	}
}

/** 投影缓存路径（§3 `projcache`：路径/形状探测；不读内容、不写、无副作用） */
function projcachePaths() {
	const root = hostDataRoot();
	return {
		shardDir: join(root, "storages", "session_projcache", "sessions"), // 0.1.2 起分片
		monolith: join(root, "storages", "session_projcache.json") // <0.1.2 单体
	};
}

function projcacheDetected() {
	try {
		const p = projcachePaths();
		return existsSync(p.shardDir) || existsSync(p.monolith);
	} catch {
		return false;
	}
}

/** ctx.get 安全封装（cordis 服务；get 抛错/返回 null 都当"服务不存在"） */
function ctxService(ctx, name) {
	if (ctx == null) return null;
	try {
		const viaGet = ctx.get?.(name);
		if (viaGet !== undefined && viaGet !== null) return viaGet;
	} catch {
		/* get 抛错 → 试直取属性 */
	}
	try {
		return ctx[name] ?? null;
	} catch {
		return null;
	}
}

/**
 * 全量能力探测（§3 十个 key）。
 * ctx 为空时：6 个"无 ctx 也能测"的 key 照测（宿主包方法存在性 / 路径形状 / 版本），
 * 4 个服务类 key（rpcHandle/commands/tools/agents/webServerRoute）取不到 → false。
 * 绝不调用有副作用的宿主 API（§10.8）。
 */
/** 功能性自检：`connection.rpc.handle` 到底能不能注册（`#A57`）。
 *  0.2.2 上方法存在但**调用必抛**（connection 用自身 ctx 取 webServer）⇒ 只判方法存在＝假阳。
 *  只测一次并缓存；失败路径不会留下路由（抛错发生在注册之前）。 */
let rpcHandleCapability = null;
let rpcHandleVia = null;   // "legacy" | "fetch" | null（面板/诊断用）
/** ★`#A65` 步2（用户令「把已迁 channelFace 的插件能力键归一，面板别报假红」）：
 *  `rpcHandle` 这个键的**语义**是"本插件的 RPC 面可用"，0.2.2 起这个面**就是** `connection.fetch.register`
 *  （官方 Fetch 面：`/api/<channel>/<endpoint>`），旧 `rpc.handle` 已废（调用必抛
 *  `cannot get property "webServer" without inject`）。
 *  ⇒ 判定改为：① 旧面能真注册 ⇒ `via:"legacy"`；② 旧面抛但**新面存在且可注册一条探针路由** ⇒ `via:"fetch"`（视同可用）；
 *  ③ 两面都不行 ⇒ false（**真红**，不许洗绿）。探针路由绝不产生副作用（注册即弃用、路径带 `__` 前缀）。
 *  §g 目的与背景：只认旧面 ⇒ 所有已迁新面的插件永远 `missing:["rpcHandle"]` ⇒ 面板 5 项"降级"里
 *  有多项是**历史遗留假红**，用户无法从面板分辨"真坏"与"已修好"。 */
/* ★`#A66` 步5②：**根上下文兜底** —— 消费方插件的 ctx 上取不到 `connection.fetch`（`#E20` 实测：
 *  `bg-image` 在自己的 ctx 上探测恒 false，而 host-compat 在 `rootCtx` 上能注册 2 条路由 ⇒ 那是"面在、
 *  但不在消费方 ctx 视野里"）。⇒ host-compat 在 apply 时把 `rootCtx` 登记进来，探测先试消费方 ctx，
 *  失败再试根 ctx；两者皆无 ⇒ false（**真红不洗白**）。 */
let probeRootCtx = null;
export function setProbeRootCtx(ctx) { probeRootCtx = ctx || null; }

function probeFetchFace(ctx) {
	/* ★`#A65` 修（首轮实测仍 false 的真因）：**必须复用 `fetchRoute()` 的注册形状**
	 *  —— 官方 `connection.fetch.register` 吃的是 `{path, methods:["POST"], requestBody:"buffered", fetch}`，
	 *  自造 `{kind:"exact", path, handler}` 会被宿主判非法 ⇒ 抛 ⇒ 探测恒 false（等于没改）。
	 *  ⇒ 用与本包在役通道**逐字同一条**注册路径（探针路径带 `__` 前缀，注册即弃用、无副作用）。 */
	const tryOne = (c) => {
		try {
			const r = fetchRoute(c, "/api/__dsh-compat-cap-probe/probe", "probe", () => ({ ok: false }));
			return r?.ok === true || /already registered/i.test(String(r?.reason || ""));
		} catch { return false; }
	};
	if (tryOne(ctx)) return true;
	if (probeRootCtx && probeRootCtx !== ctx) return tryOne(probeRootCtx);
	return false;
}
function probeRpcHandle(ctx) {
	/* ★`#A66`：**只缓存 `true`** —— `false` 只在"根上下文已就绪"时才定案。
	 *  背景：能力探测被**第一个调用者**定格（模块级缓存），而插件 apply 顺序不定 ⇒ 早于 host-compat
	 *  设置 `probeRootCtx` 的探测会把 `false` 永久写死（实测：`bg-image` 的 shard `probedAt 15:41:39Z`
	 *  仍 `missing:["rpcHandle"]`，而同一进程里 host-compat 自身能注册 fetch 路由）。 */
	if (rpcHandleCapability === true) return true;
	const rpc = ctxService(ctx, "connection")?.rpc;
	if (rpc && typeof rpc.handle === "function") {
		try {
			rpc.handle("/__dsh-compat-cap-probe", () => ({ ok: false, error: { code: "probe", message: "capability probe" } }));
			rpcHandleCapability = true; rpcHandleVia = "legacy";
			return rpcHandleCapability;
		} catch { /* 0.2.2：cannot get property "webServer" without inject ⇒ 落到新面判定 */ }
	}
	if (probeFetchFace(ctx)) { rpcHandleCapability = true; rpcHandleVia = "fetch"; return true; }
	if (probeRootCtx) { rpcHandleCapability = false; rpcHandleVia = null; }   /* 根上下文已就绪 ⇒ 可定案 */
	return false;
}
/** 现读：`rpcHandle` 由哪一面满足（`"legacy"|"fetch"|null`；未测亦 null）。 */
export function rpcHandleCapabilityVia() { return rpcHandleVia; }

/** 现读自检结果（供面板/诊断；`null`＝尚未测）。 */
export function rpcHandleCapabilityState() {
	return rpcHandleCapability;
}

/** 2026-11-21 增补 r5：webServer 解析 —— 先消费方 ctx，再中间件根 ctx（#A66 同源兜底）。 */
function webServerAny(ctx) {
	const direct = ctxService(ctx, "webServer");
	if (direct) return direct;
	return probeRootCtx ? ctxService(probeRootCtx, "webServer") : null;
}

/** 2026-11-21 增补 r5：webServerPrefix 功能性探测 —— 试注册唯一前缀并立即 dispose，不留残留路由。 */
function probeWebServerPrefix(ws) {
	if (!ws || typeof ws.register !== "function") return false;
	const path = `/__compat-cap-${Math.random().toString(36).slice(2, 10)}`;
	let dispose = null;
	try {
		dispose = ws.register({ kind: "prefix", path, handler: () => {} });
		return true;
	} catch {
		return false;
	} finally {
		try { if (typeof dispose === "function") dispose(); } catch {}
	}
}

/** 2026-11-21 增补 r5：webServerUpgrade 探测 —— registerUpgrade 方法存在性。 */
function probeWebServerUpgrade(ws) {
	return Boolean(ws && typeof ws.registerUpgrade === "function");
}

/** 2026-11-24 增补 r6：`agentTeams` 探测 = 宿主团队服务存在且具备 membership/listMembers。 */
function probeAgentTeams(ctx) {
	const svc = ctxService(ctx, "agentTeams");
	return Boolean(svc && typeof svc.membership === "function" && typeof svc.listMembers === "function");
}

function detectCapabilities(ctx) {
	const session = hostSessionModule();
	const proto = session?.Session?.prototype;
	// ★ **`#A77` 裁定 (c1)**：宿主包**解析不到** ⇒ 由它承载的 3 个 key **不是"缺"、而是"未取证"**。
	//   实测血案：`compat-status` 曾把一次瞬时解析失败持久化成 `BLOCKED`（`#A76` 定因件 §5）。
	//   ⇒ 用符号量 `UNPROBED` 表示"**没能测**"（≠ `false`＝"测了、确实没有"）。
	//   ★★ **取证规则（写死；两正控共用同一判据点，须可区分）**：
	//     · **首次**观测到"解析不到该 specifier" ⇒ **`UNPROBED`（未取证）** —— 单次失败不足以断言"缺"；
	//     · **仅当相邻两次失败都落在 `CONFIRM_WINDOW_MS` 内**（**紧邻**的连续失败）才计入"确认" ⇒ **`missing` / `BLOCKED`**；
	//       两次失败**相隔过久**（中间无探测）⇒ **不确认**（视同新的瞬时失败 ⇒ 继续 `UNPROBED`，**不得**升 `BLOCKED`）；
	//     · 任何一次**探测成功**（含惰性复检成功）⇒ **计数归零 ＋ 记号清除**（＝自愈）。
	const sessionUnresolvable = session === null && sessionPackageUnresolvable();
	const nowMs = Date.now();
	if (!sessionUnresolvable) { sessionUnresolvableStrikes = 0; sessionUnresolvableLastAt = 0; }
	else {
		const withinWindow = sessionUnresolvableLastAt > 0 && (nowMs - sessionUnresolvableLastAt) <= CONFIRM_WINDOW_MS;
		sessionUnresolvableStrikes = withinWindow ? sessionUnresolvableStrikes + 1 : 1;   // 相隔过久 ⇒ 重新起算（不确认）
		sessionUnresolvableLastAt = nowMs;
	}
	sessionUnresolvableConfirmed = sessionUnresolvable && sessionUnresolvableStrikes >= 2;
	const P = (sessionUnresolvable && !sessionUnresolvableConfirmed) ? UNPROBED : null;
	const caps = {
		// 方法存在性（§3 第 1/2/3 行）
		sessionEvents: sessionUnresolvable ? P : (typeof proto?.snapshotEvents === "function" || typeof proto?.ownEvents === "function"),
		sessionAppend: sessionUnresolvable ? P : typeof proto?.append === "function",
		eventTypeRegistry: sessionUnresolvable ? P : typeof session?.KNOWN_SESSION_EVENT_TYPES?.add === "function",
		// 路径/形状（§3 第 4 行）
		projcache: projcacheDetected(),
		// 服务存在性（§3 第 5–9 行）—— 服务类能力只在有 ctx（或 boot 缓存）时可判
		// ★`#A57` 假绿修正：**撤销 `#A55` 的模块级全局覆盖**（那是 host-compat 自身的注册结果，被所有
		//   消费者的 `probe()` 共用 ⇒ host-compat 修好后全体"一起变绿"，是本线制造的假绿）。
		//   改为**功能性自检**（只测一次并缓存）：真的调一次 `rpc.handle()`，抛错即 false。
		//   ⇒ 0.2.2 上 `rpc.handle` 恒抛 ⇒ 所有未迁新面的消费者 `probe()` 如实 DEGRADED（面板非绿、点名）。
		rpcHandle: probeRpcHandle(ctx),
		commands: ctxService(ctx, "commands") != null,
		tools: ctxService(ctx, "tools") != null,
		agents: ctxService(ctx, "agents") != null,
		agentTeams: probeAgentTeams(ctx),
		webServerRoute: webServerAny(ctx) != null,
		// 2026-11-21 增补 r5（同源中继）：prefix 功能性探测（注册即 dispose）、upgrade 方法存在性
		webServerPrefix: probeWebServerPrefix(webServerAny(ctx)),
		webServerUpgrade: probeWebServerUpgrade(webServerAny(ctx)),
		// 版本（§3 第 10 行）
		hostVersion: detectHostVersion() !== null
	};
	return caps;
}

/** `@deepseek-ai/dsh-session` 是否**解析不到**（而非"在但坏"）。判据同 `unresolvableSpecifier`。 */
function sessionPackageUnresolvable() {
	const spec = "@deepseek-ai/dsh-session";
	try {
		testForcedResolveFail(spec);        // 测试注入点：默认恒不进入
		createRequire(import.meta.url)(spec);
		return false;                       // 能解析 ⇒ 不是"未取证"
	} catch (err) {
		return unresolvableSpecifier(err, spec);
	}
}

/** ★ **`#A77` 裁定 (c1)**：**能力"未取证"的符号标记**（既不是 `true` 也不是 `false`）。
 *  语义 = **"没能测"**（探测前置解析失败）；**`false` 仍严格表示"测了、确实没有"**。
 *  ⚠️ **`caps[key] !== true` 的既有读法不因此改变**（`UNPROBED !== true` ⇒ 仍视作"非在位"）
 *  ⇒ **任何功能路径的判定逐字不变**（裁定边界②）；三态**只在申报/面板面**体现。 */
const UNPROBED = Symbol.for("dsh-host-compat.unprobed");

/** 宿主包解析失败是否已在本进程内**确认**（`true`＝连续 ≥2 次解析不到 ⇒ 按真缺处置；`null` = 尚未探测） */
let sessionUnresolvableConfirmed = null;
/** ★ **`#A77` (c1)** 取证计数：**紧邻**的连续"解析不到"观测次数（任何一次成功 ⇒ 归零）。 */
let sessionUnresolvableStrikes = 0;
/** 上次"解析不到"的观测时刻（判"是否紧邻"；相隔 > `CONFIRM_WINDOW_MS` ⇒ 不确认、重新起算）。 */
let sessionUnresolvableLastAt = 0;
/** **确认窗口**（写死，可用 `DSH_HC_CONFIRM_WINDOW_MS` 覆盖）：两次"解析不到"须落在本窗口内才构成"真缺"。
 *  ⚠️ **必须 > 节流窗口**（否则一个进程内永远凑不到第二次观测 ⇒ 真缺永远报不出 `BLOCKED`）——
 *  缺省 **300000 ms（5 分钟）** 与节流缺省 30 s 相差 10 倍，留足余量；相隔过久 ⇒ 视同**新的瞬时失败**（继续 `unprobed`）。 */
const CONFIRM_WINDOW_MS = (() => {
	const v = Number(process.env.DSH_HC_CONFIRM_WINDOW_MS);
	return Number.isFinite(v) && v >= 1000 ? v : 300000;
})();

/** 探测结果快照（返回副本，避免外部改写缓存） */
function snapshot(entry) {
	return {
		version: entry.version,
		capabilities: { ...entry.capabilities },
		detectedAt: entry.detectedAt
	};
}

/* ------------------------------------------------------------------ §4.8 hostInfo */

/** ★ **`#A77` 裁定 (c2)**：**"缺能力"结论的惰性复检** —— 复检**节流口径与上界**（写死）：
 *  · 节流窗口 `REPROBE_TTL_MS`（缺省 **30000 ms**，可用 `DSH_HC_REPROBE_TTL_MS` 覆盖，**下限 1000 ms**）；
 *  · **有 boot 缓存时**：仅在**距上次探测 ≥ 窗口**时**现场重探一次**并**刷新缓存**（⇒ 瞬时失败自愈）；
 *    窗口内 ⇒ 直接用缓存（**不做 IO、不重探**）。
 *  · **上界**：任一调用方（`probe` / `status` / 端点）在本进程内**每窗口最多触发 1 次**重探
 *    ⇒ **探测次数上界 = ⌈进程存活时长 ÷ 窗口⌉ ＋ 1**（不随上报次数增长）。 */
const REPROBE_TTL_MS = (() => {
	const v = Number(process.env.DSH_HC_REPROBE_TTL_MS);
	return Number.isFinite(v) && v >= 1000 ? v : 30000;
})();

/** 探测计数器（**只增**；供判据"节流生效"读数 —— 正常路径无副作用、零 IO） */
let probeCount = 0;

/* ---------------------------------------------------------------- 服务类键 ＋ 就绪通知（2026-09-21 批 4 件②） */

/** **服务类 key 子集**（取值 = "某宿主服务此刻在不在"，**随时间可变** ⇒ **不进 boot 快照**）。
 *  ★ 甲（`#A98` 裁定 2）：这 4 个键**每次 `hostInfo()` 都现探**；包/路径类键**仍走 boot 快照 ＋ 节流**。
 *  ⚠️ 节流口径**未变**：窗内复用、超窗重探 ⇒ **延迟上界 = 一个 `REPROBE_TTL_MS`**（不是"每次调用都真读"）。 */
const SERVICE_KEYS = Object.freeze(["rpcHandle", "commands", "tools", "agents", "agentTeams", "webServerRoute"]);

/** **就绪通知**（丙）：`rpcHandle` 由"非 true"→"true" 的那一趟 `probe()` ⇒ **播报一次**（进程内恒 ≤1）。
 *  · 判据由**读数**驱动（`#A96` 裁定①），**不得**用 `inject` 是否存在代替；
 *  · `onReady(cb)` 订阅时**先探一次**（catch-up，`#A98` 裁定 1）：若**已就绪** ⇒ 立即回调一次；
 *  · 回调**逐个 try/catch 隔离**：一个订阅方抛错不影响他人（失败语义如实点名，不吞）。 */
const readySubs = new Set();
let readyFired = false;
let lastRpcHandle = null;          // 上一次观测到的 `rpcHandle` 取值（判"跃迁"用）
/** 上一次的服务类读数（**无 ctx 的调用**沿用此值 ⇒ 不假报缺；2026-09-21 实测血案）。 */
const lastSvcCaps = {};

/** 判"是否已就绪"（就绪 = `rpcHandle === true`）。 */
function isReady(caps) {
	return caps != null && caps.rpcHandle === true;
}

/** 播报就绪（幂等）：`reason` 供日志溯源（`transition` = 跃迁那一刻／`catch-up` = 订阅时已就绪）。 */
function fireReady(reason) {
	if (readyFired) return 0;
	readyFired = true;
	let n = 0;
	for (const sub of [...readySubs]) {
		try {
			sub(reason);
			n += 1;
		} catch (err) {
			// 单个订阅方抛错 ⇒ 隔离，不阻断他人（调用方另有日志面）
			readySubs.delete(sub);
		}
	}
	return n;
}

/**
 * ★ **`compatBus.onReady(cb)` 的 seam 实现**（additive；**永不 throw**）。
 * @param cb `(reason: "catch-up"|"transition") => void`
 * @returns `{ok:true, ready:boolean, unsubscribes:boolean}` | `{ok:false, reason}`
 *   · `ready:true` ⇒ **订阅时已就绪 ⇒ 已立即回调一次**（catch-up）；
 *   · 旧版/桩 bus 无本键 ⇒ 调用方**须如实降级**（本函数不负责那一步）。
 */
export function onReadySubscribe(cb) {
	try {
		if (typeof cb !== "function") return { ok: false, reason: "bad-cb" };
		// catch-up 判据（`#A98` 裁定 1）：**以最后一次服务类读数为准**（`hostInfo(null)` 会因无 ctx 而看不到服务）
		const alreadyReady = readyFired || lastSvcCaps.rpcHandle === true;
		if (alreadyReady) {
			try {
				cb("catch-up");
			} catch (err) {
				return { ok: false, reason: `ready-cb-threw:${String(err?.message ?? err)}` };
			}
			return { ok: true, ready: true, unsubscribes: false };
		}
		readySubs.add(cb);
		return { ok: true, ready: false, unsubscribes: true };
	} catch (err) {
		return { ok: false, reason: `subscribe-failed:${String(err?.message ?? err)}` };
	}
}

/** 就绪面读数（只读；判据/自检用）。 */
export function readyStats() {
	return { fired: readyFired, subs: readySubs.size, lastRpcHandle };
}

/** 导出面（判据/自检用）：`{ count, ttlMs, bootDetectedAt }` —— 只读快照。 */
export function probeStats() {
	return {
		count: probeCount,
		ttlMs: REPROBE_TTL_MS,
		bootDetectedAt: detectionCache ? detectionCache.detectedAt : null,
		ready: readyFired
	};
}

/**
 * §4.8 `hostInfo(ctx?)` → `{ version, capabilities: Record<key, boolean>, detectedAt }`
 *
 * 契约签名为无参；此处 `ctx` 为**可选**入参（不改变无参调用的形状与语义）：
 *   - 传 ctx：现场全量探测，并**写入** §1 允许的"boot 探测缓存"（`lib/index.js` apply 时传一次）；
 *   - 不传 ctx：有 boot 缓存 → **窗口内**返回 boot 快照（服务类能力以 boot 时为准）；
 *     **超窗口 ⇒ 重探一次并刷新缓存**（`#A77` (c2) 惰性复检；⇒ 瞬时失败自愈、不再被钉死）；
 *     无 boot 缓存 → 现场做**无 ctx 探测**（6 个 key 可判；4 个服务类 key 为 false），**不写缓存**。
 * 永不 throw。
 */
export function hostInfo(ctx) {
	try {
		const detectedAt = new Date().toISOString();
		const svcCaps = {};
		for (const k of SERVICE_KEYS) svcCaps[k] = false;
		// ★ **甲（`#A98` 裁定 2）**：**服务类 key 不进 boot 快照、每趟现探**（节流口径不变 ⇒ 延迟上界 = 一个窗口）。
		// ⚠️ **无 ctx 的调用**（`__A98` 实测血案）：`detectCapabilities(null)` 恒取不到服务 ⇒ **不得**据此把
		//   服务类键清零（那会假报"缺"、并把 `lastRpcHandle` 拽回 false）。⇒ 无 ctx 时**沿用上一次服务类读数**
		//   （初始值 = `false`，语义同旧行为：无 ctx ⇒ 服务类键 unknown ⇒ 按"非在位"处置）。
		let liveCaps = null;
		if (ctx != null) {
			try {
				liveCaps = detectCapabilities(ctx);
				for (const k of SERVICE_KEYS) svcCaps[k] = liveCaps[k];
			} catch {
				/* 现探异常 ⇒ 服务类沿用上一次读数（不假报缺） */
			}
		} else {
			for (const k of SERVICE_KEYS) svcCaps[k] = lastSvcCaps[k];
		}
		// ★ **丙**：`rpcHandle` 由"非 true"→"true" ⇒ 播报一次（幂等；catch-up 在订阅侧）
		if (lastRpcHandle !== null && lastRpcHandle !== true && svcCaps.rpcHandle === true) fireReady("transition");
		lastRpcHandle = svcCaps.rpcHandle;
		for (const k of SERVICE_KEYS) lastSvcCaps[k] = svcCaps[k];
		if (detectionCache) {
			const age = Date.now() - (Date.parse(detectionCache.detectedAt) || 0);
			// 窗内 ⇒ 复用**包/路径类**快照；服务类一律用本次现探值覆盖
			if (Number.isFinite(age) && age < REPROBE_TTL_MS) {
				const snap = snapshot(detectionCache);
				for (const k of SERVICE_KEYS) snap.capabilities[k] = svcCaps[k];
				return snap;
			}
		}
		probeCount += 1;
		const caps = liveCaps ?? detectCapabilities(ctx == null ? null : ctx);
		for (const k of SERVICE_KEYS) caps[k] = svcCaps[k];
		detectionCache = { capabilities: caps, version: detectHostVersion(), detectedAt };
		return snapshot(detectionCache);
	} catch {
		// 探测本身异常 → 退化为"全 false + 未知版本"，绝不 throw
		const fallback = { capabilities: {}, version: null, detectedAt: new Date().toISOString() };
		for (const k of CAPABILITY_KEYS) fallback.capabilities[k] = false;
		return fallback;
	}
}

/** boot 缓存是否已就位（被 ctx 探测填充过）。供 §4.9 在"无 ctx 且缓存冷"时加显式注记。 */
function hasBootDetection() {
	return detectionCache !== null;
}

/* ------------------------------------------------------------------ §4.9 probe */

/**
 * §4.9 `probe(requires, pluginId, pluginVersion, ctx?, blocking?)` → `{state, missing, blocked, notes?}`
 *
 * `state`：`blocked` 非空 → `BLOCKED`；否则 `missing` 非空 → `DEGRADED`；否则 `OK`（D1）。
 * 未知 key（不在 §3 十个之内）按**缺失**处置并写进 `notes`（§3 keys v1 冻结）。
 * `ctx` 为可选第 4 参（同 §4.8 理由）；不传则用 boot 探测缓存。
 *
 * `blocking` 为可选第 5 参（**RD-20**，`string[]`，缺省 `[]`，additive）：
 * 插件把自己的"缺失即阻断"清单传进来 ⇒ `missing` 中命中它的 key**同时进入** `blocked`、`state` 置 `BLOCKED`
 * （默认只有 §3 的 `agents` 是阻断项，见 `BLOCKED_BY_DEFAULT`）。这样**阻断清单由插件声明**，
 * host-compat 里不硬编码任何插件 id（§10.6）。`blocking` 里不缺失的 key 忽略；缺省/空 = 旧行为逐字相同。
 * **RD-12（冻结）**：`missing` 永远保留**全部**缺失 key（含被阻断的），`blocked` 是其**子集**
 * ⇒ `blocked ⊆ missing` 恒成立（面板只渲染 `missing` 摘要，移出会造出"BLOCKED 但摘要为空"的静默行）；
 * §3 默认阻断项与声明命中的 key 处理一致。
 * 非法 `blocking`（非"干净字符串数组"）⇒ 视同缺省（永不 throw）。
 * 永不 throw。
 */
export function probe(requires, pluginId, pluginVersion, ctx, blocking) {
	const who = typeof pluginId === "string" && pluginId ? pluginId : "unknown-plugin";
	const coldCache = ctx == null && !hasBootDetection();
	const info = hostInfo(ctx);
	try {
		const caps = info.capabilities ?? {};
		if (!Array.isArray(requires)) {
			return { state: "DEGRADED", missing: [], blocked: [], notes: `${who}: requires 不是字符串数组 → 无法探测` };
		}
		const known = new Set(CAPABILITY_KEYS);
		const wanted = [];
		for (const key of requires) {
			if (typeof key === "string" && key && !wanted.includes(key)) wanted.push(key);
		}
		// RD-20：只接受"干净的字符串数组"；其余（含 undefined/null/字符串/混合数组）视同缺省（不 throw）
		const declaredBlocking = Array.isArray(blocking) && blocking.every((k) => typeof k === "string" && k) ? blocking : [];
		const unknown = wanted.filter((k) => !known.has(k));
		// RD-12（冻结）：`missing` = 探测到的**全部**缺失 key；`blocked` = 其中造成 BLOCKED 的**子集**
		//   ⇒ `blocked ⊆ missing` **恒成立**（面板只渲染 `missing` 摘要、不渲染 `blocked[]`；
		//     若把被阻断的 key 从 missing 移出，"仅缺 eventTypeRegistry"的插件会渲染成
		//     "红色 BLOCKED 但缺能力摘要为空"的静默行 —— 正是闸门要避免的静默）。
		//   §3 默认阻断项（agents）与插件声明命中的 key **处理完全一致**（不再有两套）。
		// ★ **`#A77` 裁定 (c1)**：三态取数 —— `true`＝在位；`UNPROBED`＝**未取证**（**实测失败**导致的解不出包）；
		//   **`false`／缺省 ＝ 测了、确实没有**（既有语义**逐字不变**）。
		//   ⇒ 未取证者**不得**进 `missing`（否则 `blocked ⊆ missing` 会把它升级成 BLOCKED）、
		//     也**不得**进 `blocked`；仅在 `unprobed[]` ＋ `notes` 里**如实**出现。
		//   ⚠️ **边界②**：`caps[k] !== true` 的既有功能判定**未改**（`UNPROBED !== true` ⇒ 仍"非在位"）。
		//   ★ **取证口径（判据④）**：仅当"**解析不到该 specifier**"时才算未取证（`unresolvableSpecifier`，
		//     见 `detectCapabilities()`）；**包已确认不可解析**（`sessionUnresolvableConfirmed === true`）
		//     ⇒ 是**真实缺能力** ⇒ 落回 `missing`（⇒ 正控A「撤掉能力必回 BLOCKED」成立）。
		const unprobed = wanted.filter((k) => caps[k] === UNPROBED && sessionUnresolvableConfirmed !== true);
		const missing = wanted.filter((k) => caps[k] !== true && !unprobed.includes(k));
		const blocked = missing.filter((k) => BLOCKED_BY_DEFAULT.includes(k) || declaredBlocking.includes(k));
		// 因插件声明的清单（而非 §3 默认）成为阻断项的那些 key —— 仅用于 notes 溯源
		const byDeclaration = blocked.filter((k) => declaredBlocking.includes(k) && !BLOCKED_BY_DEFAULT.includes(k));
		// 状态（**未取证恒不得晋级 BLOCKED** —— 裁定边界②/③ 的判据）
		const state = blocked.length ? "BLOCKED" : (missing.length || unprobed.length) ? "DEGRADED" : "OK";

		const notes = [];
		if (unknown.length) notes.push(`${who}: 未知能力键（按缺失处置）: ${unknown.join(", ")}`);
		if (info.version == null) notes.push(`${who}: 宿主版本探测失败`);
		if (coldCache) {
			notes.push(`${who}: 无 ctx 且无 boot 探测缓存 → 服务类能力按缺失处置（请传第 4 参 ctx 或等 host-compat 装配完成）`);
		}
		if (unprobed.length) {
			// ★ 面板如实文案（`#A77` (c1) 硬要求）：必须出现「未取证」，且**不得**说成"缺少"
			notes.push(`${who}: 未取证（探测前置解析失败，未能判定是否在位）: ${unprobed.join(", ")}`);
		}
		if (byDeclaration.length) {
			notes.push(`${who}: 依据插件声明的阻断清单判定 BLOCKED: ${byDeclaration.join(", ")}`);
		}
		if (missing.length && !notes.length) {
			notes.push(`${who}: 缺少 ${missing.join(", ")}`);
			if (typeof pluginVersion === "string" && pluginVersion) notes[notes.length - 1] += ` (v${pluginVersion})`;
		}
		const out = { state, missing, blocked };
		if (notes.length) out.notes = notes.join("；");
		if (unprobed.length) out.unprobed = unprobed;   // ★ 三态的机器可读面（additive 新键；不改 state 值域）
		return out;
	} catch (err) {
		return {
			state: "DEGRADED",
			missing: [],
			blocked: [],
			notes: `${who}: 探测异常 → 按降级处置 (${String(err?.message ?? err)})`
		};
	}
}

/* ------------------------------------------------------------------ §4.1 / §4.2 会话日志读取 */

/**
 * §4.1 `readSessionEvents(session)` → `Event[]` 或 `null`（能力不可用 / 读不到）。
 * 三路径：`session.events`（<0.1.2）→ `snapshotEvents()` → `ownEvents()`（0.1.2-rc.1 起无 events 属性）。
 * 每条路径**各自** try/catch（一个抛错不阻断下一个）。永不 throw。
 */
export function readSessionEvents(session) {
	if (!session) return null;
	try {
		if (Array.isArray(session.events)) return session.events;
	} catch {
		/* 属性读取抛错 → 试方法 */
	}
	try {
		if (typeof session.snapshotEvents === "function") {
			const events = session.snapshotEvents();
			if (Array.isArray(events)) return events;
		}
	} catch {
		/* 快照不可读 → 试 ownEvents */
	}
	try {
		if (typeof session.ownEvents === "function") {
			const events = session.ownEvents();
			if (Array.isArray(events)) return events;
		}
	} catch {
		/* 都拿不到 → null */
	}
	return null;
}

/** turn/end 的 reason 规范化（字符串原样；对象取 kind；缺失 unknown） */
function turnEndReason(event) {
	const r = event?.data?.reason;
	if (typeof r === "string") return r;
	if (r && typeof r === "object") return r.kind ?? "unknown";
	return "unknown";
}

/**
 * §4.2 `turnEndsOf(session)` → `Array<{turn,seq,time,reason}>`；不可用返回 `[]`。
 * 形状严格照契约（**不附 event 字段**；需要原始事件用 §4.1）。永不 throw。
 */
export function turnEndsOf(session) {
	try {
		const events = readSessionEvents(session);
		if (!Array.isArray(events)) return [];
		const out = [];
		for (const event of events) {
			if (!event || event.type !== "turn/end") continue;
			out.push({
				turn: event.data?.turn,
				seq: event.seq,
				time: event.time,
				reason: turnEndReason(event)
			});
		}
		return out;
	} catch {
		return [];
	}
}

/* ------------------------------------------------------------------ §4.4 appendNotice */

/**
 * §4.4 `appendNotice(session, payload)` → `{ok, mode:"start"|"replace", rev}` | `{ok:false,reason}`
 *
 * **P1-2 语义变更（契约 §12-21 / P1 设计稿 §9，签名保持、调用方零改动）**：
 *   由「写会话日志事件」→「**经中间件解析 sink 写自有 store + 通知渲染**」：
 *     ① 解析 sink（`dsh-notice-banner` 经 `ctx.provide("noticeState", …)` 提供，host-compat 的
 *        `apply` 注入解析器）；**缺失 ⇒ `{ok:false, reason:"noticeState"}`（不写日志、不 throw、不上屏）**；
 *     ② `sink.append(entry)`（异步 provider ⇒ 挂 `.catch` 吞掉，**绝不产生 unhandledRejection**）；
 *     ③ 双轨期（`DUAL_TRACK_LOG === true`）**仍写旧会话日志事件**（仅供旧客户端/旧会话回放；
 *        步③ 把它置 false ⇒ R1 达标）。日志写入需要的 `session` 由 `payload.sessionId` 经注入的
 *        session 解析器反查（生产者已"去 session"）。
 *
 * 语义（**RD-19 冻结**，2026-09-13 返工）：**mode 的决策权在调用方**，本函数**不扫会话历史推断**。
 *   - 缺省 / `rev === 0` 且未显式 `mode:"replace"` → `start`（每事件一张新卡）；
 *   - 显式 `mode:"replace"` 或 `rev > 0` → `replace`（原地替换语义；store 侧由
 *     `banner-kit.decideRevMode` 统一实现 rev 计数）。
 *   - `payload` 必须含非空字符串 `kind`（§8 payload 形状）+ §2 schema 必填键（由 `banner-kit.emit` 归一化）。
 *   - **不读会话日志**：§4.1 能力缺失只影响 §4.1/§4.2，**不影响追加**。
 * 永不 throw。
 */
/* ★`#A66`：**会话级卡补回合号**（发射侧唯一落点＝中间件，避免 4 个生产者各写一遍）。
 *  背景：`#E20` 把「turn=null 的会话级卡」统一兜底到最后一个回合尾行 ⇒ 多回合的重启卡**全堆在结尾**
 *  （用户现场：「每个回合的重启卡片都堆积在这里 看起来他们没找到锚点」）。
 *  真因是**发射侧没写 turn**（`restart`/`queue` 只带 `anchorSeq`/`commandId`/`at`），而渲染落位依赖回合号。
 *  取法（只读、不猜）：用会话事件表的 `turn/end` 边界反查 ——
 *    · 有 `anchorSeq` ⇒ 取**第一个 `turn/end.seq >= anchorSeq`** 的回合（＝该 seq 所属回合）；
 *    · 只有 `at`/`time` ⇒ 取**第一个 `turn/end.time >= at`** 的回合；
 *    · 都取不到 / 事件表不可读 ⇒ 返回 null（**不编造**，由消费侧走"可诊断兜底"）。
 *  缓存键＝sessionId＋事件条数（事件只增，条数变即失效）。 */
const turnBoundaryCache = new Map();
function turnBoundaries(session, sessionId) {
	const key = String(sessionId || (session && session.id) || "-");
	const events = readSessionEvents(session);
	if (!Array.isArray(events)) return null;
	const hit = turnBoundaryCache.get(key);
	if (hit && hit.n === events.length) return hit.ends;
	const ends = [];
	for (const e of events) {
		if (!e || e.type !== "turn/end") continue;
		const t = e.data && Number.isFinite(e.data.turn) ? Number(e.data.turn) : null;
		if (t === null) continue;
		ends.push({ turn: t, seq: Number(e.seq), time: Number(e.time) });
	}
	ends.sort((a, b) => (Number.isFinite(a.seq) ? a.seq : 0) - (Number.isFinite(b.seq) ? b.seq : 0));
	turnBoundaryCache.set(key, { n: events.length, ends });
	if (turnBoundaryCache.size > 64) turnBoundaryCache.delete(turnBoundaryCache.keys().next().value);
	return ends;
}
export function resolveTurnForEvent(session, payload) {
	try {
		if (!payload || typeof payload !== "object") return null;
		if (Number.isFinite(payload.turn) && Number(payload.turn) > 0) return Number(payload.turn);
		const ends = turnBoundaries(session, payload.sessionId);
		if (!ends || !ends.length) return null;
		const seq = Number.isFinite(payload.anchorSeq) ? Number(payload.anchorSeq) : null;
		if (seq !== null) {
			for (const b of ends) if (Number.isFinite(b.seq) && b.seq >= seq) return b.turn;
			return ends[ends.length - 1].turn;   /* 末回合内 ⇒ 归末回合（有下界锚点） */
		}
		const at = Number.isFinite(payload.at) ? Number(payload.at) : (Number.isFinite(payload.time) ? Number(payload.time) : null);
		if (at !== null) {
			for (const b of ends) if (Number.isFinite(b.time) && b.time >= at) return b.turn;
			return ends[ends.length - 1].turn;
		}
		return null;
	} catch { return null; }
}

/* ★`#A66`：**会话解析器注入** —— `banner-kit.emit()` 走 `seams.appendNotice(null, entry)`（**session 恒为 null**），
 *  于是 `resolveTurnForEvent(null, …)` 拿不到事件表 ⇒ 回合号永远补不上（实测 6 张卡 `turn:null`）。
 *  ⇒ host-compat 在 apply 时注入解析器，`appendNotice` 在 `session == null` 时按 `payload.sessionId` 反查。 */
let sessionResolver = null;
export function setSessionResolver(fn) { sessionResolver = typeof fn === "function" ? fn : null; }
function sessionOf(payload, session) {
	if (session) return session;
	try {
		const sid = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
		if (!sid || !sessionResolver) return null;
		return sessionResolver(sid) || null;
	} catch { return null; }
}

/* ==========================================================================================
 * 2026-11-24 增补 r6 `agentTeams` —— **Agent Teams 团队成员判定（R7：中间件持唯一宿主接触点）**
 *
 * 背景：宿主团队服务 `agentTeams`（`dsh-experimental-agent-team`）的 `membership(agent)` 需
 *   **live Agent 作凭据**；插件不得直连宿主服务（ENV R7 / 契约 §2.4）。
 *   ⇒ 本文件只提供 **seam 纯函数**；两个解析器由 `lib/index.js` 的 apply 注入（字面量 ctx.get +
 *     惰性 + try/catch，**不外泄、不缓存服务引用**）。永不 throw、失败一律 `{ok:false,reason}`。
 * @param session 会话对象或会话 id（取 `.id` / `.sessionId`）
 * @returns {{ok:true,isMember:boolean,role:string,name:string|null,teamId:string|null}} | {{ok:false,reason:string}}
 *   · `isMember` **只对 teammate 为 true**（lead 也是团队成员但主会话回合恒走 task.done，不吃本分类）
 *   · 非团队成员（普通 subagent）⇒ 宿主 `membership()` 抛 TEAM_NOT_MEMBER ⇒ `{ok:false,reason}`，
 *     调用方须回退 `subagent.done` 并如实记诊断（禁静默改写语义）。
 * ========================================================================================== */

let teamServiceResolver = null;
let liveAgentResolver = null;

/** **内部（非 §4 冻结面）**：注入团队服务/live Agent 解析器（仅同包 `lib/index.js` 调用）。 */
export function setTeamResolvers(resolvers = {}) {
	try {
		teamServiceResolver = typeof resolvers?.teamService === "function" ? resolvers.teamService : null;
		liveAgentResolver = typeof resolvers?.agentOf === "function" ? resolvers.agentOf : null;
		return { ok: true };
	} catch {
		return { ok: false, reason: "bad-argument" };
	}
}

/** 取团队服务：优先注入解析器，否则退回调用方传入 ctx（兼容测试/旧装配）。永不 throw。 */
function teamServiceOf(ctx) {
	try {
		if (teamServiceResolver) return teamServiceResolver() || null;
		return ctxService(ctx, "agentTeams");
	} catch { return null; }
}

/** 取 live Agent：优先注入解析器，否则 ctx.get("agents").get(sid)。永不 throw。 */
function liveAgentOf(sid, ctx) {
	try {
		if (liveAgentResolver) return liveAgentResolver(String(sid)) || null;
		return ctxService(ctx, "agents")?.get?.(String(sid)) ?? null;
	} catch { return null; }
}

/**
 * §4.15 `teamMemberOf(session, ctx?)` —— 团队成员判定（seam；永不 throw）。
 * 判定取不到（无服务/无 live agent/非成员/异常）⇒ `{ok:false,reason}`，**不猜测**。
 */
export function teamMemberOf(session, ctx) {
	try {
		const sid = typeof session === "string"
			? session
			: (session && (session.id ?? session.sessionId));
		if (typeof sid !== "string" || !sid) return { ok: false, reason: "bad-session" };
		const svc = teamServiceOf(ctx);
		if (!svc || typeof svc.membership !== "function") return { ok: false, reason: "agentTeams" };
		const agent = liveAgentOf(sid, ctx);
		if (!agent) return { ok: false, reason: "agent-not-live" };
		const m = svc.membership(agent);
		if (!m || typeof m !== "object") return { ok: false, reason: "bad-membership" };
		const role = typeof m.role === "string" ? m.role : "";
		return {
			ok: true,
			isMember: role === "teammate",
			role,
			name: typeof m.name === "string" ? m.name : null,
			teamId: m.id !== undefined ? String(m.id) : null
		};
	} catch (err) {
		return { ok: false, reason: `not-member-or-error:${String(err?.message ?? err)}` };
	}
}

export function appendNotice(session, payload) {
	try {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return { ok: false, reason: "bad-argument" };
		}
		const kind = typeof payload.kind === "string" ? payload.kind.trim() : "";
		if (!kind) return { ok: false, reason: "bad-argument" };
		const rawRev = payload.rev;
		if (rawRev !== undefined && (typeof rawRev !== "number" || !Number.isFinite(rawRev) || rawRev < 0)) {
			return { ok: false, reason: "bad-argument" };
		}
		const rev = rawRev === undefined ? 0 : rawRev;
		const wantReplace = payload.mode === "replace" || rev > 0;
		const mode = wantReplace ? "replace" : "start";

		// ① sink 解析（**唯一**写路径入口；缺失即静默降级，绝不写日志/上屏）
		const sink = resolveNoticeSink();
		if (!sink) {
			// ★T2 接线：**只补"不静默"，不改"降级"语义**（原注释的"静默降级"即本批要消的静默点）。
			reportErr({ code: "notice-sink-missing", detail: "cap=noticeState session=" + (payload?.sessionId ?? session?.id ?? "-"), severity: "state" });
			return { ok: false, reason: "noticeState" };
		}

		const sessionId = payload.sessionId !== undefined
			? payload.sessionId
			: (session && session.id !== undefined ? session.id : null);
		const entry = { ...payload, kind, sessionId, mode, rev };
		// ★`#A66`：**回合号补全**（发射侧唯一落点）。取不到就保持 null（**不编造**；消费侧有可诊断兜底）。
		try {
			if (entry.turn === undefined || entry.turn === null) {
				const t = resolveTurnForEvent(sessionOf(entry, session), entry);
				if (t !== null && Number.isFinite(t) && t > 0) { entry.turn = t; }
			}
		} catch { /* 取不到 ⇒ 保持 null */ }

		// ③ ★ **段2 `B6`（2026-09-29）**：**直调路径也判形状** —— 此前只判三件（对象／`kind` 非空／`rev` 形状）
		//   ⇒ 与 `banner-kit` 路**两条写入纪律**（同库条目键形态不一致、且拒收落桶更深）。
		//   校验面取 **sink 的 `validate`** ＝ `banner-kit.validateEntry` **原物**（**不自写第二套**；同步，符合本函数同步签名）。
		//   `validate` 缺失／返回 `null`（banner-kit 尚未加载）⇒ **不作判定**（该条仍由 store 的 `appendEntry` 校验并落 `rejected`）。
		//   判非法 ⇒ **① 落原因码（原样）＋ 面板可见（`reportRejected`）＋ 点名 `owner`** ⇒ 返回 `bad-entry:…`（**不静默**）。
		if (typeof sink.validate === "function") {
			let v = null;
			try { v = sink.validate(entry); } catch { v = null; }
			if (v && v.ok === false) {
				const reason = `bad-entry:${v.reason}${v.key ? `:${v.key}` : ""}`;
				try {
					if (typeof sink.reportRejected === "function") {
						sink.reportRejected({ owner: typeof entry.source === "string" ? entry.source : null, reason, sessionId, snapshot: entry });
					}
				} catch { /* 上报失败不改变判定（拒收本身仍如实返回） */ }
				return { ok: false, reason };
			}
		}

		// ② 写自有 store（异步 provider ⇒ 结果无法同步取回；同步抛错则如实返回）
		let res = null;
		try {
			res = sink.append(entry);
		} catch (err) {
			return { ok: false, reason: `append-failed:${String(err?.message ?? err)}` };
		}
		if (res && typeof res.then === "function") {
			try {
				res.catch(() => { /* store 内部已把失败转成 {ok:false}，这里只防 unhandledRejection */ });
			} catch {
				/* 非标准 thenable ⇒ 忽略 */
			}
		}

		// ③ 步③（本批）：**不再写旧会话日志**（R1 达标）—— 这里**故意没有** `session.append` 调用；
		//    旧的 `notice/banner(-replace)` 事件只存在于 P1-2 之前的历史会话里（客户端日志折叠 = 旧会话回退路径）。
		return { ok: true, mode, rev };
	} catch (err) {
		return { ok: false, reason: `append-failed:${String(err?.message ?? err)}` };
	}
}

/* ------------------------------------------------------------------ §4.5 ensureEventTypes */

/**
 * §4.5 `ensureEventTypes(types)` → `{ok, registered: string[]}`
 *
 * 直连宿主 `KNOWN_SESSION_EVENT_TYPES.add`（幂等；落点 §2 实证：notice-banner / cost-ledger 同法）。
 * 未注册的自定义事件类型一旦落盘，会话读取会被 `assertEventsSupported` 拒绝 ⇒ 整个会话加载失败，
 * 因此**追加 notice/banner 前必须先注册**。
 * 注册表不可用 ⇒ `{ok:false, reason:"eventTypeRegistry"}`。永不 throw。
 */
export function ensureEventTypes(types) {
	try {
		if (!Array.isArray(types)) return { ok: false, reason: "bad-argument" };
		const registry = hostSessionModule()?.KNOWN_SESSION_EVENT_TYPES;
		if (!registry || typeof registry.add !== "function") {
			// ★T2 接线：事件类型注册表缺失 ⇒ 自定义事件落盘会让整个会话加载失败 ⇒ 注入方必须停写。
			reportErr({ code: "event-type-registry", detail: "cap=eventTypeRegistry", severity: "state" });
			return { ok: false, reason: "eventTypeRegistry" };
		}
		const registered = [];
		for (const type of types) {
			if (typeof type !== "string" || !type) continue;
			registry.add(type); // Set.add 幂等，多插件重复调用无副作用
			registered.push(type);
		}
		return { ok: true, registered };
	} catch (err) {
		return { ok: false, reason: `register-failed:${String(err?.message ?? err)}` };
	}
}

/* ------------------------------------------------------------------ §4.6 rpcHandle */

/**
 * §4.6 `rpcHandle(ctx, channel, handler)` → `{ok}` | `{ok:false, reason}`
 *
 * 宿主实调点：`ctx.get("connection").rpc.handle(channel, handler)`
 * （落点 §2 实证：taskqueue:1453 / cost-ledger:595 / notify:1048）。
 * 经此注册的通道**自动带 GUI cookie 门禁**（契约 §6；0.1.2 起必须带）。
 * 本面是 §4 中**唯一**按契约收 `ctx` 的面。永不 throw。
 */
export function rpcHandle(ctx, channel, handler) {
	try {
		if (typeof channel !== "string" || !channel) return { ok: false, reason: "bad-argument" };
		if (typeof handler !== "function") return { ok: false, reason: "bad-argument" };
		const connection = ctxService(ctx, "connection");
		const rpc = connection?.rpc;
		if (!rpc || typeof rpc.handle !== "function") return { ok: false, reason: "rpcHandle" };
		rpc.handle(channel, handler);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `rpc-handle-failed:${String(err?.message ?? err)}` };
	}
}

/* ==========================================================================================
 * §4.12 `fetchRoute` —— **0.2.2 起插件自有通道的唯一可用面**（`#A54` 定因 / `#A55` 授权）
 *
 * 背景（现读 `dsh-client-connection/lib/index.js`）：
 *   · 0.2.2 里 `connection.rpc.handle(channel, handler)` → `register(this.ctx, …)` → `owner.webServer.register(route)`，
 *     而 connection 自身 `inject = ["credentials"]`、cordis `Service.ctx` ＝ **构造时** ctx
 *     ⇒ 严格服务访问下 `owner.webServer` **抛** `cannot get property "webServer" without inject`
 *     ⇒ **通道路由从未注册**（请求落到 SPA 资源兜底 ⇒ `405 allow: GET, HEAD`）。
 *   · 官方替代面 = `connection.fetch.register({path, methods, requestBody, fetch})`（`dsh-client-connection/lib/index.js:840-860`）：
 *     纯 Map 注册、由 `/api` 路由的 `createSharedFetchHandler`（`:820-838`）**优先分发**，
 *     **复用 `/api` 既有 cookie 门禁**（`peer.principal.kind === "owner"`）⇒ 不新增任何认证代码。
 *
 * 纪律：
 *   · **不碰业务语义**：只把 `/host-compat/<endpoint>` 的信封搬运到 `/api/host-compat/<endpoint>`；
 *   · **绝不 throw**（失败一律 `{ok:false, reason}`，由调用方降级并上屏）；
 *   · 旧宿主没有 `connection.fetch` ⇒ 返回 `{ok:false, reason:"fetchRoute"}`，调用方回落旧 `rpcHandle`。
 * ========================================================================================== */

/** 实际注册结果（供 §3 能力判定与 `probe()` 使用；`null` ＝ 尚未注册） */
let rpcRegistration = null; // { via:"rpc"|"fetch", ok:boolean, reason?:string }

/** 记录一次实际注册结果（`lib/index.js` 在 apply 期调用；供能力判定使用「真结果」而非「方法存在」）。 */
export function setRpcRegistration(state) {
	rpcRegistration = state && typeof state === "object" ? { ...state } : null;
}

/** 现读注册结果（`null` ＝ 未尝试）。 */
export function rpcRegistrationState() {
	return rpcRegistration === null ? null : { ...rpcRegistration };
}

/** 组装一个把 `client-request` 信封包成 `server-response` 的 Fetch handler（与宿主 `rpcFetchHandler` 同形）。 */
function makeEnvelopeFetch(endpoint, handler, prefix) {
	const reply = (rpcId, result) => new Response(JSON.stringify({ type: "server-response", rpcId, result }), {
		status: 200,
		headers: { "content-type": "application/json" }
	});
	return async function fetchHandler(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return reply("invalid", { ok: false, error: { code: "gateway/bad-request", message: "body is not JSON" } });
		}
		const rpcId = typeof body?.rpcId === "string" ? body.rpcId : "invalid";
		if (body?.type !== "client-request") {
			return reply(rpcId, { ok: false, error: { code: "gateway/bad-request", message: "not a client-request" } });
		}
		// ★`#A56`：客户端 channel 只能是单段（`CHANNEL_PATTERN=/^\/[A-Za-z0-9._~-]+$/`）⇒ 只能
		//   `rpc.call("/api", "host-compat/<endpoint>")`，于是信封 `method` 带 `host-compat/` 前缀；
		//   URL 段与 handler 需要的是**去前缀**的端点名 ⇒ 两者都接受。
		const methodRaw = typeof body.method === "string" ? body.method : "";
		const methodOk = methodRaw === endpoint || (prefix !== undefined && methodRaw === `${prefix}/${endpoint}`);
		if (!methodOk) {
			return reply(rpcId, { ok: false, error: { code: "gateway/bad-request", message: `method ${JSON.stringify(methodRaw)} does not match endpoint ${JSON.stringify(endpoint)}` } });
		}
		try {
			return reply(rpcId, await handler(endpoint, body.payload, request.signal, null));
		} catch (err) {
			return reply(rpcId, { ok: false, error: { code: "gateway/internal", message: String(err?.message ?? err) } });
		}
	};
}

/**
 * §4.12 `fetchRoute(ctx, path, endpoint, handler)` → `{ok, via}` | `{ok:false, reason}`
 *
 * 注册一条**精确** Fetch 路由（`path` 必须形如 `/api/<seg>/<seg>`）。永不 throw。
 * @param {object} ctx - 持有 `connection` 服务的上下文
 * @param {string} path - 精确路径（`/api/host-compat/<endpoint>`）
 * @param {string} endpoint - 端点名（信封 `method` 必须与之相等）
 * @param {(endpoint:string, payload:any, signal?:AbortSignal, peer?:any)=>any} handler - 端点处理函数
 */
export function fetchRoute(ctx, path, endpoint, handler) {
	try {
		if (typeof path !== "string" || !path.startsWith("/api/")) return { ok: false, reason: "bad-path" };
		if (typeof endpoint !== "string" || !endpoint) return { ok: false, reason: "bad-endpoint" };
		if (typeof handler !== "function") return { ok: false, reason: "bad-handler" };
		const connection = ctxService(ctx, "connection");
		const register = connection?.fetch?.register;
		if (typeof register !== "function") return { ok: false, reason: "fetchRoute" };
		const prefix = path.slice("/api/".length, path.length - endpoint.length - 1); // 例："host-compat"
		register({ path, methods: ["POST"], requestBody: "buffered", fetch: makeEnvelopeFetch(endpoint, handler, prefix) });
		return { ok: true, via: "fetch" };
	} catch (err) {
		return { ok: false, reason: `fetch-route-failed:${String(err?.message ?? err)}` };
	}
}

/* ==========================================================================================
 * §4.13 `channelFace` —— 把"插件自有 RPC 通道"整条迁到官方 Fetch 面（`#A57`）
 *
 * 背景：0.2.2 的 `connection.rpc.handle(channel, handler)` 必抛（见 `probeRpcHandle`）；
 *   官方替代面 = `connection.fetch.register` 的**精确**路由（挂 `/api` 下、复用 cookie 门禁）。
 *   本函数把一个通道的所有端点一次性注册成 `/api/<channel>/<endpoint>`：
 *     · `handler(endpoint, payload)` 的返回契约与旧通道**逐字一致**（`{ok:true,value}` / `{ok:false,error}`）；
 *     · **幂等**（已注册的路径视为成功）＋ **永不 throw**；
 *     · 旧宿主无 `connection.fetch` ⇒ 全部 `{ok:false, reason:"fetchRoute"}`，调用方回落 `rpcHandle`。
 * ========================================================================================== */

/**
 * @param {object} ctx - 持有 connection 服务的上下文
 * @param {string} channel - 旧通道名（例：`/costguard-cfg`）
 * @param {string[]} endpoints - 端点名清单（例：`["get","set","reset","resetAll"]`）
 * @param {(endpoint:string, payload:any)=>any} handler - 与旧通道同签名的端点分发器
 * @returns {{ok:boolean, routes:number, total:number, results:Array<{endpoint:string,ok:boolean,reason?:string}>}}
 */
export function channelFace(ctx, channel, endpoints, handler) {
	const results = [];
	try {
		const ch = String(channel).replace(/^\/+/, "");
		const list = Array.isArray(endpoints) ? endpoints : [];
		for (const ep of list) {
			const path = `/api/${ch}/${ep}`;
			const r = fetchRoute(ctx, path, ep, handler);
			const already = r.ok !== true && /already registered/i.test(String(r.reason || ""));
			results.push({ endpoint: ep, ok: r.ok === true || already, reason: r.ok === true || already ? "" : String(r.reason || "") });
		}
	} catch (err) {
		results.push({ endpoint: "*", ok: false, reason: `channel-face-threw:${String(err?.message ?? err)}` });
	}
	const routes = results.filter((r) => r.ok).length;
	return { ok: routes > 0, routes, total: results.length, results };
}

/* ==========================================================================================
 * §4.14 `webServerPrefix` / `webServerUpgrade` —— 宿主 Web 路由的中间件出口（件12 新增，additive）
 *
 * 背景：件12 的“同源中继”需要在 A 的 Web 服务上挂 `/mesh/<peer>/` 前缀路由与 WebSocket 升级
 *   路由；插件面向的 `connection.fetch.register` 只吃精确路径、只挂 /api、且不支持升级。
 *   宿主 `webServer` 服务支持 `register({kind:"prefix"})` 与 `registerUpgrade({path})`，
 *   但不由插件直连（ENV R7）。本出口由中间件持宿主接触点，插件只调本函数。
 *   · 永不 throw；未就绪返回 `{ok:false,reason}`；注册成功返回 `{ok:true,dispose}`。
 * ========================================================================================== */
let webServerService = null;

/** host-compat 在 apply 时登记宿主 webServer 服务；不可用则留 null（如实降级）。 */
export function setWebServerService(service) {
	webServerService = service || null;
}

/** 现读：路由出口是否可用（面板/诊断用）。 */
export function webServerState() {
	const ws = webServerService;
	let origin = "";
	try { if (ws && typeof ws.getOrigin === "function") origin = String(ws.getOrigin() || ""); } catch {}
	return {
		ok: Boolean(ws && typeof ws.register === "function"),
		upgrade: Boolean(ws && typeof ws.registerUpgrade === "function"),
		host: ws && typeof ws.host === "string" ? ws.host : "",
		port: Number(ws && ws.port) || 0,
		protocol: ws && typeof ws.protocol === "string" ? ws.protocol : "",
		origin,
	};
}

/**
 * 注册一条前缀路由（`path` 与 `path/<anything>` 都匹配）。
 * @param path 绝对路径，不带尾斜杠（例：`/mesh`）
 * @param handler `(req, res) => void|Promise<void>`，独占响应生命周期
 */
export function webServerPrefix(path, handler) {
	try {
		if (!webServerService || typeof webServerService.register !== "function") return { ok: false, reason: "webServer-unavailable" };
		if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, reason: "bad-path" };
		if (typeof handler !== "function") return { ok: false, reason: "bad-handler" };
		const dispose = webServerService.register({ kind: "prefix", path, handler });
		return { ok: true, dispose };
	} catch (err) {
		return { ok: false, reason: `prefix-failed:${String(err?.message ?? err)}` };
	}
}

/**
 * 注册一条精确路径的 HTTP 升级路由（WebSocket）。
 * @param path 绝对路径，不带尾斜杠（例：`/mesh/<id>/api/remote.mux`）
 * @param handler `(req, socket, head) => void|Promise<void>`
 */
export function webServerUpgrade(path, handler) {
	try {
		if (!webServerService || typeof webServerService.registerUpgrade !== "function") return { ok: false, reason: "webServer-upgrade-unavailable" };
		if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, reason: "bad-path" };
		if (typeof handler !== "function") return { ok: false, reason: "bad-handler" };
		const dispose = webServerService.registerUpgrade({ path, handler });
		return { ok: true, dispose };
	} catch (err) {
		return { ok: false, reason: `upgrade-failed:${String(err?.message ?? err)}` };
	}
}
