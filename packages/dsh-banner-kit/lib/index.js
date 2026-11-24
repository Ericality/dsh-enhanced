/**
 * @ericality/dsh-banner-kit v0.1.0 —— 横幅共享库（本地辅助库，非官方包）
 *
 * 契约: `docs/待办/2026-09-13-契约-host-compat-v1.md` §1/§2/§9/§10
 *       + 冻结接口 `docs/任务记录/2026-09-13-阶段2-共享派单模板.md` §2.2（RD-26）
 *
 * 职责（**只做两件事**）:
 *   1. `ensureRegistered(session?)` —— 经 §4.5 `ensureEventTypes(TYPES)` 幂等注册两个自定义事件类型；
 *   2. `emit(payload, opts)` —— **P1-2 起去 session**：把旧展示 payload 归一化为 §2 schema entry
 *      （`normalizeEmitPayload`），经 §4.4 `appendNotice(null, entry)` 写自有 store。
 *      **rev/mode 语义的唯一实现**收归 store 侧 `decideRevMode`（`dsh-notice-banner/lib/store.js` 调用它）：
 *      · 默认（`opts.replace !== true`）：`mode:"start"`（每回合一张新卡，与改前逐值等价）；
 *      · `opts.replace === true`：`mode:"replace"` ⇒ store 按同 `kind` 已存在 start 与否决定 `rev`。
 *      **双轨期**由**中间件**（host-compat `seams.js`）按 `payload.sessionId` 反查会话补写旧日志事件，
 *      生产者**不碰** `session`（R1 方向：只写自有数据）。
 *
 * 形态纪律（契约 §1/§2/§10）:
 *   · 零第三方依赖；**无** `apply`、**无** ctx、**无** `dsh.client`（纯库，不进 Loader entries）；
 *   · 加载强制：动态 `import("@ericality/dsh-host-compat/seams")` + try/catch + 模块级缓存
 *     （§10.1 禁静态 import 共享包：缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环）；**顶层永不 throw**；
 *   · 失败一律 `{ ok:false, reason }`，**不写 legacy 直连兜底双路径**（§10.2 / D12）；
 *   · **不做**：不决定 kind、不做文案、不做节流、不加 `time`、不缓存业务状态
 *     （只允许模块级「已注册」标志 + 探测结果缓存，§10.6）。
 *
 * ⚠️ RD-19 / 教训 L-4（阶段 1 血的教训）：本库**只在 `opts.replace === true` 时**读会话历史，
 *    且**只读** `type` / `data.kind` / `data.rev` 三个字段用于 rev 计数；
 *    **禁止**由历史推断其它 mode、**禁止**改写事件类型之外的任何语义。
 *
 * 导出面（2026-09-14 阶段 7 · P1-1 扩面；**依据 = 契约 §12-21（台账行 12-21）+ P1 设计稿 §2**）:
 *   · 旧 3 项（**逐字保留、语义不变**）: `TYPES` · `ensureRegistered` · `emit`
 *     —— 注意 `emit` 去 session 依赖属 **P1-2 接线**，本批**不改**；
 *   · 新增 schema 面（设计稿 §2 键级冻结）: `SCHEMA_VERSION` · `REQUIRED_KEYS` · `OPTIONAL_KEYS`
 *     · `ROLES` · `STATES` · `MODES` · `TEXT_MAX_BYTES`；
 *   · 新增纯函数面（无 IO、无宿主、不持有业务数据）: `constructEntry` · `validateEntry`
 *     · `decideRevMode` · `mergeEntries` · `isVisible` · `selectVisible` · `isShardReusable`。
 *   ~~旧句「导出面冻结为 3 个，不得多一个、不得少一个」~~ 已由本次扩面取代（同一行不得两说）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { isRegisteredKey, statusOfKey } from "./fields.js";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const LOG_DIR = joinPath(DSH_HOME, "logs", "banner-kit");

/* ------------------------------------------------------------------ 错误码出口（T2 接线）
 * 内联自 `scripts/errcode/template-helper.js`（守 §1.1「各插件自带薄 helper ≤20 行」+ D19 零跨包 import）。
 * 出口名 = `reportErr`（§1.1 冻结；`report` 在本仓另是闸门申报契约，两者不得混用）；返回 void、永不 throw。
 * 落 `<root>/log/error-fallback/<PKG>.log`（D23；本批不写 $DSH_HOME，§2.0-4）= 闸门/reporter 缺席时的兜底写入器（D2）。
 * ⚠️ 与模板的唯一差异（已在报告登记）：内层函数**匿名**（模板里叫 `reportErr`）—— 否则门禁
 *    `scripts/error-surface-lint.mjs` 的出口抽取会把**函数定义行**当成一次出口调用（默认参数不是对象属性
 *    => 误计 `joinKeyMissing`），污染既有读数。`site` 帧位与语义逐字不变。
 */
const PKG = "dsh-banner-kit";
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

/** 本库负责注册的两个自定义会话事件类型（契约 §4.5；§8 横幅由 dsh-notice-banner 客户端渲染） */
export const TYPES = ["notice/banner", "notice/banner-replace"];

/* ------------------------------------------------------------------ host-compat/seams 动态加载 */

let seamsMod;              // undefined = 尚未尝试；null = 已判定不可用
let seamsDead = false;     // true = 已判定不可用（不再重试，避免每次调用都抛一次）

/**
 * 动态加载 host-compat 的纯函数面（§1/§2.3）。
 * 规范字面量必须**内联写在 `import(...)` 里**（静态对撞脚本 `host-compat-requires-smoke.mjs` 按此判定）。
 * 失败 ⇒ 缓存 `null` 并返回 null（调用方据此返回 `reason:"host-compat"`）。永不 throw。
 */
async function loadSeams() {
	if (seamsMod !== undefined) return seamsMod;
	if (seamsDead) return null;
	try {
		seamsMod = await import("@ericality/dsh-host-compat/seams");
	} catch {
		seamsDead = true;
		seamsMod = null;
	}
	return seamsMod;
}

/* ------------------------------------------------------------------ §4.5 ensureRegistered */

let registeredOk = false; // 幂等：成功过一次就不再调 seam（唯一允许的模块级状态，§10.6）

/**
 * 幂等注册 `TYPES`（§4.5 `ensureEventTypes`）。
 * 未注册的自定义事件类型一旦落盘，会话读取会被 `assertEventsSupported` 拒绝 ⇒ 整个会话加载失败，
 * 因此**注入横幅前必须先注册**。
 *
 * @param session 冻结签名里的可选入参（§4.5 seam 只收 types，本库不消费该参数）
 * @returns `{ ok:true, registered:string[] }` | `{ ok:false, reason }`；seam 缺失 ⇒ `reason:"eventTypeRegistry"`。永不 throw。
 */
export async function ensureRegistered(session) {
	if (registeredOk) return { ok: true, registered: [...TYPES] };
	const seams = await loadSeams();
	if (!seams || typeof seams.ensureEventTypes !== "function") {
		// ★T2 接线：注册面缺失 ⇒ 注入横幅会被 `assertEventsSupported` 拒绝 ⇒ 用户看不到本该看到的横幅。
		reportErr({ code: "event-type-registry", detail: "cap=eventTypeRegistry", severity: "state" });
		return { ok: false, reason: "eventTypeRegistry" };
	}
	try {
		const res = seams.ensureEventTypes(TYPES);
		if (!res || res.ok !== true) {
			return { ok: false, reason: typeof res?.reason === "string" ? res.reason : "eventTypeRegistry" };
		}
		registeredOk = true; // 只在成功后缓存（失败不缓存 ⇒ 运行期环境变了仍可恢复）
		return { ok: true, registered: Array.isArray(res.registered) ? res.registered : [...TYPES] };
	} catch (err) {
		return { ok: false, reason: `register-failed:${String(err?.message ?? err)}` };
	}
}

/* ------------------------------------------------------------------ §4.4 emit（P1-2：去 session） */

/** `text` 兜底链（旧 payload 的展示键 → schema 必填 `text`；全缺 ⇒ `kind`，保证非空字符串） */
function pickText(payload, kind) {
	const candidates = [
		payload?.text, payload?.title, payload?.body, payload?.metaText,
		Array.isArray(payload?.pages) ? payload.pages[0] : undefined,
		kind
	];
	for (const c of candidates) if (typeof c === "string" && c) return c;
	return String(kind ?? "");
}

/**
 * 把**旧展示 payload** 归一化成 §2 schema entry（**纯函数**，不改入参）。
 * 归一化补齐：`schemaVersion`（= 1）· `sessionId`（payload ⇒ opts）· `source`（payload ⇒ opts，**必填**）·
 * `role`（缺省：`kind==="status"` ⇒ `status`，否则 `banner`）· `state`（缺省：`kind==="error"` ⇒ `error`，否则 `info`）·
 * `text`（`text`/`title`/`body`/`pages[0]`/`metaText`/`kind` 兜底链）· `at`（`at` ⇒ `time` ⇒ `Date.now()`）·
 * `mode`（`opts.replace === true` ⇒ `replace`）· `rev`（缺省 0）。
 * **旧展示键逐字保留**（`kind/title/lines/stats/pages/severity/...`）：旧客户端 bundle 与旧会话回放靠它们。
 * @returns `{ok:true, entry}` | `{ok:false, reason}`
 */
export function normalizeEmitPayload(payload, opts = {}) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "bad-argument" };
	const kind = typeof payload.kind === "string" ? payload.kind.trim() : "";
	if (!kind) return { ok: false, reason: "bad-argument" };
	const source = typeof payload.source === "string" && payload.source
		? payload.source
		: (typeof opts?.source === "string" && opts.source ? opts.source : "");
	if (!source) return { ok: false, reason: "bad-entry:missing-key:source" };
	const sessionId = payload.sessionId !== undefined
		? payload.sessionId
		: (opts?.sessionId !== undefined ? opts.sessionId : null);
	if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) {
		return { ok: false, reason: "bad-entry:bad-type:sessionId" };
	}
	const role = ROLES.includes(payload.role) ? payload.role : (kind === "status" ? "status" : "banner");
	const state = STATES.includes(payload.state) ? payload.state : (kind === "error" ? "error" : "info");
	const at = isNum(payload.at) ? payload.at : (isNum(payload.time) ? payload.time : Date.now());
	const mode = (opts?.replace === true || payload.mode === "replace") ? "replace" : "start";
	const rev = isNum(payload.rev) ? payload.rev : 0;
	// A 阶段数据补全（2026-09-15，obs#3）：**附加键，语义未定不改行为**（R3 折叠语义暂缓）。
	//   · `turn`   = 该卡所属回合（宿主 turn 语义；无 turn 语义的产生方显式写 null ⇒ 键**恒在**，"必填形状"）
	//   · `ctxKey` = **旧版 context id 原样透传**（status: `costguard-status-<turn>`；cost: `cost-<seq>`；
	//                ledger: `ledger-<seq|at>`；balance: `balance-<at>`；compat: `compat`）——
	//                取不到的形态**写 null，严禁猜**（写入侧不猜，读侧降级）
	//   · `anchorSeq` = 触发本次发射的宿主事件 seq（可选；有它就能锚定"原位"）
	const turn = Number.isInteger(payload.turn) && payload.turn >= 0 ? payload.turn : null;
	const ctxKey = typeof payload.ctxKey === "string" && payload.ctxKey ? payload.ctxKey : null;
	const anchorSeq = Number.isInteger(payload.anchorSeq) ? payload.anchorSeq : null;
	return {
		ok: true,
		entry: {
			...payload,
			schemaVersion: SCHEMA_VERSION,
			sessionId,
			source,
			role,
			state,
			text: pickText(payload, kind),
			at,
			mode,
			rev,
			turn,
			ctxKey,
			anchorSeq
		}
	};
}

/**
 * 注入 / 原地替换一张横幅（**P1-2 起：去 session**；§4.4 `appendNotice` 的**唯一**调用入口）。
 *
 * 写路径（唯一）：`emit(payload, opts)` → `seams.appendNotice(null, entry)`（签名保持）→ 中间件解析
 * sink → `noticeState.append(entry)` → store。`sessionId` 由 **payload**（或 `opts.sessionId`）携带；
 * 双轨期（`seams.DUAL_TRACK_LOG === true`）由**中间件**按 `sessionId` 反查会话补写旧日志事件
 * （生产者**不碰** `session`）。
 *
 * @param payload 展示 payload（**必须**含非空 `kind`；§2 必填键由 `normalizeEmitPayload` 归一化补齐）
 * @param opts    `{ replace?: boolean, sessionId?: string, source?: string }` —— **只有 `replace === true`**
 *                才走 replace 语义（store 侧由 `banner-kit.decideRevMode` 统一计数）
 * @returns `{ ok:true, mode:"start"|"replace", rev, entry }` | `{ ok:false, reason }`
 *          · payload 不合法 ⇒ `bad-argument`；缺 `source` ⇒ `bad-entry:missing-key:source`；
 *          · host-compat 不可用 ⇒ `reason:"host-compat"`；sink 缺失 ⇒ `reason:"noticeState"`（**不写日志、不上屏**）。
 *          · 误用旧签名（首参传 session）⇒ `bad-argument:session-first-arg`（**显式报错，不静默错位**）。
 * 永不 throw。
 */
export async function emit(payload, opts = {}) {
	try {
		const norm = normalizeEmitPayload(payload, opts);
		if (!norm.ok) {
			// 旧签名误用（首参是 session 对象）⇒ 明确拒绝，避免"看起来成功其实错位"
			if (payload && typeof payload === "object" && typeof payload.append === "function" && typeof payload.id === "string") {
				return { ok: false, reason: "bad-argument:session-first-arg" };
			}
			return { ok: false, reason: norm.reason };
		}
		const entry = norm.entry;
		// ★A104 字段门禁：**未登记键 / 退役键在写前拒收**（只加在 emit，validateEntry 的 extraKeys 不动 ⇒ 老卡零迁移）
		for (const _k of Object.keys(entry)) {
			if (!isRegisteredKey(_k)) return { ok: false, reason: `bad-entry:unregistered-key:${_k}` };
			if (statusOfKey(_k) === "retired") return { ok: false, reason: `bad-entry:retired-key:${_k}` };
		}
		// ★A108：`turn=0` 非行身份（store 门禁会整卡拒收）⇒ 写前拒收
		if (entry.turn === 0) return { ok: false, reason: "bad-entry:bad-type:turn" };
		// ★A95 四道硬束缚②：**入口校验**（写前拒绝，不是警告）——
		//   必填 `anchorLevel`；值域三值；`row` 必须至少带一个位置键（禁猜默认值、禁静默接受）。
		if (entry.anchorLevel === undefined || entry.anchorLevel === null) return { ok: false, reason: "bad-entry:missing-key:anchorLevel" };
		if (!ANCHOR_LEVELS.includes(entry.anchorLevel)) return { ok: false, reason: `bad-entry:bad-enum:anchorLevel:${String(entry.anchorLevel)}` };
		// ★A97 四道束缚扩到 `form`：缺/非法 ⇒ 拒收（不猜默认）
		if (entry.form === undefined || entry.form === null) return { ok: false, reason: "bad-entry:missing-key:form" };
		if (!CARD_FORMS.includes(entry.form)) return { ok: false, reason: `bad-entry:bad-enum:form:${String(entry.form)}` };
		// ★A110：三字段写前强制（缺/非法/不变量不满足 ⇒ 拒收，不猜默认）
		if (entry.priority === undefined || entry.priority === null) return { ok: false, reason: "bad-entry:missing-key:priority" };
		if (!CARD_PRIORITIES.includes(entry.priority)) return { ok: false, reason: `bad-entry:bad-enum:priority:${String(entry.priority)}` };
		if (typeof entry.foldable !== "boolean") return { ok: false, reason: "bad-entry:bad-type:foldable" };
		if (entry.family === undefined || entry.family === null) return { ok: false, reason: "bad-entry:missing-key:family" };
		if (!CARD_FAMILIES.includes(entry.family)) return { ok: false, reason: `bad-entry:bad-enum:family:${String(entry.family)}` };
		if (entry.form === CARD_FORM.BUBBLE && entry.foldable !== false) return { ok: false, reason: "bad-state:foldable-bubble" };
		if (typeof entry.commandId === "string" && entry.commandId && entry.foldable !== false) return { ok: false, reason: "bad-state:foldable-command" };
		if (entry.anchorLevel === ANCHOR_LEVEL.ROW) {
			const hasPos = Number.isInteger(entry.anchorSeq) || Number.isInteger(entry.turn) || (typeof entry.commandId === "string" && entry.commandId);
			if (!hasPos) return { ok: false, reason: "bad-entry:row-without-position-key" };
		}
		const check = validateEntry(entry);
		if (!check.ok) return { ok: false, reason: `bad-entry:${check.reason}${check.key ? `:${check.key}` : ""}` };

		const seams = await loadSeams();
		if (!seams || typeof seams.appendNotice !== "function") return { ok: false, reason: "host-compat" };

		let res = null;
		try {
			res = seams.appendNotice(null, check.entry);
		} catch (err) {
			return { ok: false, reason: `append-failed:${String(err?.message ?? err)}` };
		}
		if (res && res.ok === true) {
			return { ok: true, mode: res.mode ?? check.entry.mode, rev: res.rev ?? check.entry.rev, entry: check.entry };
		}
		return { ok: false, reason: typeof res?.reason === "string" ? res.reason : "append-failed" };
	} catch (err) {
		return { ok: false, reason: `emit-failed:${String(err?.message ?? err)}` };
	}
}

/* ==================================================================================
 * 统一横幅 schema（2026-09-14 阶段 7 · **P1-1**）
 *   依据：契约 §12-21（台账行 `12-21`，用户 2026-09-14 批准走 §12 流程）
 *        + `docs/待办/2026-09-14-P1-设计稿-横幅公共设施化.md` §2（键集 + 必填/可选 + 枚举）
 *   K9 = `notice` / `banner` / `status` 三合一到**一套 schema**；键集**冻结到键级**
 *   （血案教训：只冻结调用形态不冻键集 ⇒ 生产者传键、消费者不认 ⇒ 零请求静默丢弃）。
 *
 *   本段**全部是纯函数 / 纯常量**：零 IO、零宿主、零业务状态、零模块级可变缓存
 *   （契约 §10.6 + doctrine R1/R2；`banner-kit` 永远保持"纯库"——K8）。
 * ================================================================================== */

/** schema 版本（设计稿 §2；不匹配 ⇒ 单条丢弃 / 分片重建，见 `validateEntry` / `isShardReusable`） */
export const SCHEMA_VERSION = 1;

/** 必填键（设计稿 §2 **逐字冻结**，顺序即契约行序） */
export const REQUIRED_KEYS = ["schemaVersion", "sessionId", "source", "role", "kind", "state", "text", "at"];
/** 可选键（同上；未知键**保留**并计入 `extraKeys`，不计丢弃）
 *  obs#3（2026-09-15 仲裁 #A62 三）：**补声明** `ctxKey` / `anchorSeq` —— 二者自 A 阶段起已由
 *  `normalizeEmitPayload` **实际写入**（见本文件 `:156-157`），但此前**未在 schema 声明** ⇒ 离线
 *  `dsh-notice-banner/selftest.mjs` 的「K-c 对撞①」恒红（`schema 未定义却被读取`）。
 *  ⚠️ **本批只补声明**：不改 `normalizeEmitPayload` 行为、不改 `validateEntry`、不动契约 §3 冻结键集。
 *
 *  obs3S7 段W-2a（2026-09-19 仲裁 `#A201` 一，用户裁「甲」；依计划 v5 §3/§3.5 + `#A199` 一）：**补声明 `cardId`**。
 *  · 语义 = 生产者提供的**卡身份**（32 位十六进制，无连字符 UUID v4 去横线）；**同会话内唯一**；
 *    B（store）**不解析其内容**，只当键（去重 / 更新 / 归属校验）。
 *  · **优先级 = `cardId` > `(kind,rev,mode)`**（有 `cardId` ⇒ 不参与 rev 计数；见 `cardIdentityOf` / `mergeEntries`）。
 *  · **缺省 / 显式 `null` ⇒ 逐字走既有 rev 身份路径** ⇒ 四家在产生产者（`taskqueue:557` / `sessions-cost:551` /
 *    `cost-guard:1166` / `balance:418`）的"每次一张"语义**零改动**。
 *  · 本次**不动 `SCHEMA_VERSION`**：加"可选键"即向后兼容；版本号与"读时兼容 + 迁移"必须**同批**落地，
 *    否则新版读旧分片会走 R6（`schemaVersion` 不符 ⇒ 重命名 `.bad` + 重建）⇒ 卡片全部看不见。 */
// ★2026-09-20（用户已签）：新增 `commandId` —— **命令↔行配对键**（宿主发放的同源标识；`#A27` 选型 (乙)）。
//   ⚠️ 走**声明**而非 `extraKeys` 偷渡（`T17`/B6：可选键静默未定义地带）。
export const OPTIONAL_KEYS = ["turn", "rev", "mode", "pages", "ttlMs", "ctxKey", "anchorSeq", "cardId", "commandId", "anchorLevel", "form", "priority", "foldable", "family"];
/**
 * ★A95：**卡锚定级别（anchorLevel）** —— 本字段属 `dsh-notice-banner` **私有契约**，不是宿主字段；
 *   若将来宿主定义同名/同义冲突字段，本插件**让位改名**（契约注见 `docs/plugins/dsh-notice-banner.md`）。
 *   · `row`     ⇒ 卡必须落到某一行（`anchorSeq`/`turn`/`commandId` 至少一个位置键）；
 *   · `session` ⇒ 会话级状态（如队列卡：该会话排着待执行任务）；
 *   · `global`  ⇒ 跨会话状态（如适配状态卡）。
 *   出口只允许这三个常量，**禁裸字符串字面量**（静态检查 `scripts/anchor-level-lint.mjs`）。
 */
export const ANCHOR_LEVEL = Object.freeze({ ROW: "row", SESSION: "session", GLOBAL: "global" });
/**
 * ★A97：**卡的呈现形态** —— `bubble`＝会话内迷你气泡行（状态类），`card`＝常规卡。
 *   属 `dsh-notice-banner` 私有契约；与 `anchorLevel` 同族（数据自声明，不按 kind 名字猜）。
 */
export const CARD_FORM = Object.freeze({ BUBBLE: "bubble", CARD: "card" });
/**
 * ★A110：**渲染属性自声明**（T2/T3）—— 与 `form` 同族，数据自声明，客户端不再按 kind 猜。
 *   · `priority ∈ {0,1,2,3}`：0 告警 / 1 状态 / 2 通知与适配 / 3 其余；
 *   · `foldable:boolean`：能否进折叠族；`form=bubble` 与带 `commandId` 的卡必须 false；
 *   · `family`：家族（决定图标/徽章/色板/历史色），取值见 `CARD_FAMILIES`，新 kind 复用已有 family。
 *   三者由 `emit` 写前强制（缺/非法/不满足不变量即拒收）；老卡无字段 ⇒ 客户端回落旧 kind 规则。
 */
export const CARD_PRIORITY = Object.freeze({ ALERT: 0, STATUS: 1, NOTICE: 2, NORMAL: 3 });
export const CARD_PRIORITIES = Object.freeze([0, 1, 2, 3]);
export const CARD_FAMILY = Object.freeze({
	COST: "cost", NOTIFY: "notify", QUEUE: "queue", BALANCE: "balance", ERROR: "error",
	LEDGER: "ledger", COSTS: "costs", RESTART: "restart", COMPAT: "compat", STATUS: "status"
});
export const CARD_FAMILIES = Object.freeze(Object.values(CARD_FAMILY));
export const CARD_FORMS = Object.freeze([CARD_FORM.BUBBLE, CARD_FORM.CARD]);
export const ANCHOR_LEVELS = Object.freeze([ANCHOR_LEVEL.ROW, ANCHOR_LEVEL.SESSION, ANCHOR_LEVEL.GLOBAL]);
/** @typedef {"row"|"session"|"global"} AnchorLevel */
/** `role` 枚举（K9 三合一） */
export const ROLES = ["banner", "notice", "status"];
/** `state` 枚举（**渲染配色唯一依据**） */
export const STATES = ["running", "ok", "warn", "error", "info"];
/** `mode` 枚举（默认 `start`） */
export const MODES = ["start", "replace"];
/** `text` 上限（**UTF-8 字节**，超长按码点安全截断并计数） */
export const TEXT_MAX_BYTES = 2048;

const utf8 = new TextEncoder();
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** `cardId` 形状（obs3S7 段W-2a）：32 位十六进制 = 无连字符 UUID v4 去横线；**大小写不敏感**（归一为小写） */
const CARD_ID_RE = /^[0-9a-fA-F]{32}$/;

/**
 * 构造一条 entry（**只补默认值，不校验** —— 校验是 `validateEntry` 的事）。
 *   默认：`schemaVersion = 1` · `at = opts.at ?? Date.now()` · `mode = "start"` · `rev = 0`；
 *   `sessionId` / `source` 缺省时取 `opts`（`sessionId` 允许 `null` = 全局；`notice` 类常用）。
 * @returns 新对象（**不修改 `partial`**）
 */
export function constructEntry(partial = {}, opts = {}) {
	const src = isPlainObject(partial) ? partial : {};
	const entry = { ...src };
	if (entry.schemaVersion === undefined) entry.schemaVersion = SCHEMA_VERSION;
	if (entry.sessionId === undefined) entry.sessionId = opts?.sessionId === undefined ? null : opts.sessionId;
	if (entry.source === undefined && opts?.source !== undefined) entry.source = opts.source;
	if (entry.at === undefined) entry.at = isNum(opts?.at) ? opts.at : Date.now();
	if (entry.mode === undefined) entry.mode = "start";
	if (entry.rev === undefined) entry.rev = 0;
	return entry;
}

/** 按码点安全截断到 `maxBytes` 个 UTF-8 字节（不丢半个字符；surrogate pair 整体保留） */
function truncateUtf8(text, maxBytes) {
	if (utf8.encode(text).length <= maxBytes) return { text, truncated: false };
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = utf8.encode(ch).length;
		if (used + size > maxBytes) break;
		out += ch;
		used += size;
	}
	return { text: out, truncated: true };
}

/**
 * 校验 / 归一化一条 entry（设计稿 §2「校验」）。
 * @returns `{ ok:true, entry, extraKeys, truncated }` —— `entry` 是**新对象**（未知键保留）；
 *          `{ ok:false, reason, key }`，`reason ∈ {not-object, schema-version, missing-key, bad-type, bad-enum}`。
 * 纪律：**缺必填 ⇒ 丢弃**（调用方负责计数，必须能在面板看到"丢弃 N 条（缺键 text）"，不许静默）；
 *       未知键 ⇒ **保留** + 进 `extraKeys`（**不计丢弃**，只作"黄"）。
 */
export function validateEntry(raw) {
	if (!isPlainObject(raw)) return { ok: false, reason: "not-object", key: undefined };
	if (raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: "schema-version", key: "schemaVersion" };
	for (const key of REQUIRED_KEYS) if (raw[key] === undefined) return { ok: false, reason: "missing-key", key };
	// 类型（strict：非法类型一律丢弃，绝不用 `String(x)` 兜成假数据）
	if (raw.sessionId !== null && !isStr(raw.sessionId)) return { ok: false, reason: "bad-type", key: "sessionId" };
	for (const key of ["source", "role", "kind", "state", "text"]) {
		if (!isStr(raw[key])) return { ok: false, reason: "bad-type", key };
	}
	if (!isNum(raw.at)) return { ok: false, reason: "bad-type", key: "at" };
	// 枚举
	if (!ROLES.includes(raw.role)) return { ok: false, reason: "bad-enum", key: "role" };
	if (!STATES.includes(raw.state)) return { ok: false, reason: "bad-enum", key: "state" };
	// 可选键：出现即必须合法（**不合法 ⇒ 丢弃该条**，避免"半可信"数据进渲染）
	if (raw.mode !== undefined && !MODES.includes(raw.mode)) return { ok: false, reason: "bad-enum", key: "mode" };
	if (raw.rev !== undefined && !(isNum(raw.rev) && raw.rev >= 0)) return { ok: false, reason: "bad-type", key: "rev" };
	if (raw.turn !== undefined && raw.turn !== null && !isNum(raw.turn)) return { ok: false, reason: "bad-type", key: "turn" }; // A 阶段（obs#3）：turn 允许显式 null（"无回合语义"的产生方，如命令类 balance）
	if (raw.ttlMs !== undefined && !(isNum(raw.ttlMs) && raw.ttlMs >= 0)) return { ok: false, reason: "bad-type", key: "ttlMs" };
	if (raw.pages !== undefined && !(Array.isArray(raw.pages) && raw.pages.every(isStr))) return { ok: false, reason: "bad-type", key: "pages" };
	if (raw.anchorLevel !== undefined && raw.anchorLevel !== null && !(isStr(raw.anchorLevel) && ANCHOR_LEVELS.includes(raw.anchorLevel))) return { ok: false, reason: "bad-enum", key: "anchorLevel" };
	// `cardId`（obs3S7 段W-2a）：出现即必须合法（**不合法 ⇒ 丢弃该条**，属**写入类**错误 ⇒ 调用方如实返回给生产者、**不降级**）
	//   · 形状 = 32 位十六进制（大小写均可，`entry.cardId` 归一为小写）；`null` = 显式"无卡身份"（合法，走旧路径）
	if (raw.cardId !== undefined && raw.cardId !== null && !(isStr(raw.cardId) && CARD_ID_RE.test(raw.cardId))) {
		return { ok: false, reason: "bad-type", key: "cardId" };
	}

	const { text, truncated } = truncateUtf8(raw.text, TEXT_MAX_BYTES);
	const entry = { ...raw };
	if (truncated) entry.text = text;
	if (entry.mode === undefined) entry.mode = "start";
	if (entry.rev === undefined) entry.rev = 0;
	if (typeof entry.cardId === "string") entry.cardId = entry.cardId.toLowerCase(); // 归一：同一身份不因大小写分叉
	const known = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
	const extraKeys = Object.keys(raw).filter((k) => !known.has(k));
	return { ok: true, entry, extraKeys, truncated };
}

/**
 * rev/mode 判定（设计稿 §2 的 **逐值等价旧语义**；`notice/banner` ↔ `notice/banner-replace` 的算法原样收编）。
 *   · `replace !== true` ⇒ `{ mode:"start", rev:0 }`（每回合一张新卡）；
 *   · 否则 `rev = hasStart ? sameKind : 0`，`mode = rev > 0 ? "replace" : "start"`；
 *   `hasStart = entries.some(e => e.kind === kind && e.rev === 0)`；`sameKind = entries.filter(e => e.kind === kind).length`。
 */
export function decideRevMode(entries, opts = {}) {
	const list = Array.isArray(entries) ? entries : [];
	const kind = opts?.kind;
	if (opts?.replace !== true) return { mode: "start", rev: 0 };
	const hasStart = list.some((e) => e?.kind === kind && e?.rev === 0);
	const sameKind = list.filter((e) => e?.kind === kind).length;
	const rev = hasStart ? sameKind : 0;
	return { mode: rev > 0 ? "replace" : "start", rev };
}

/**
 * **卡身份键**（obs3S7 段W-2a）：**`cardId` 优先**（合法 32 hex），缺失 / 显式 `null` ⇒ 回落旧键 `(kind,rev,mode)`。
 * ⚠️ **刻意不导出**：`banner-kit` 的导出面 = **契约 §12-21 冻结面**（见 `selftest.mjs` T0-a）⇒ 新增导出 = 改契约面，
 * 需仲裁批准。消费方无需它：`store` 判定"同卡"只需读 `entry.cardId` 字段本身（B 件按此写，禁复制本函数）。
 * @returns `{ by:"cardId"|"legacy", key:string }`
 */
function cardIdentityOf(entry) {
	const id = entry?.cardId;
	if (typeof id === "string" && CARD_ID_RE.test(id)) return { by: "cardId", key: id.toLowerCase() };
	return { by: "legacy", key: `${entry?.kind ?? ""}|${entry?.rev ?? 0}|${entry?.mode ?? "start"}` };
}

/**
 * 合并（**纯函数，不改入参**）：同一**身份** ⇒ **幂等覆盖**（原位替换，不追加）；否则追加；
 * 超 `maxEntries` ⇒ 按 `at` **淘汰最旧**（`at` 缺失按 `0` 视为最旧；同 `at` 先入先出）。
 *
 * **身份判定（obs3S7 段W-2a，计划 v5 §3.5）**：
 *   · 有 `cardId`（合法 32 hex）⇒ **按 `cardId` 匹配**（**忽略** `kind`/`rev`/`mode`）⇒ 幂等更新同一张卡；
 *   · 无 `cardId`（或显式 `null`）⇒ **逐字走旧键 `(kind, rev, mode)`**（原有语义一字不改）。
 * @returns `{ entries, evicted }`（`evicted` = 被淘汰的条数）
 */
export function mergeEntries(existing, incoming, opts = {}) {
	const maxEntries = isNum(opts?.maxEntries) && opts.maxEntries > 0 ? Math.floor(opts.maxEntries) : 2000;
	const base = Array.isArray(existing) ? existing.map((e) => ({ ...e })) : [];
	const add = Array.isArray(incoming) ? incoming : [incoming];
	for (const raw of add) {
		if (!isPlainObject(raw)) continue;
		const item = { ...raw };
		const ident = cardIdentityOf(item);
		let i = -1;
		if (ident.by === "cardId") {
			i = base.findIndex((e) => { const o = cardIdentityOf(e); return o.by === "cardId" && o.key === ident.key; });
		} else {
			i = base.findIndex((e) => e?.kind === item.kind && e?.rev === item.rev && (e?.mode ?? "start") === (item.mode ?? "start"));
		}
		if (i >= 0) base[i] = item;
		else base.push(item);
	}
	let evicted = 0;
	while (base.length > maxEntries) {
		let oldest = 0;
		for (let i = 1; i < base.length; i++) if ((isNum(base[i]?.at) ? base[i].at : 0) < (isNum(base[oldest]?.at) ? base[oldest].at : 0)) oldest = i;
		base.splice(oldest, 1);
		evicted++;
	}
	return { entries: base, evicted };
}

/**
 * 是否**仍应渲染**（`ttlMs` 过期 ⇒ 不再渲染，**不删档** —— 设计稿 §3 清理规则②）。
 * 非对象 / 无 `ttlMs` ⇒ 视为可见（无 TTL = 永久）。
 */
export function isVisible(entry, now = Date.now()) {
	if (!isPlainObject(entry)) return false;
	const ttl = entry.ttlMs;
	if (!isNum(ttl)) return true;
	const at = isNum(entry.at) ? entry.at : 0;
	const t = isNum(now) ? now : Date.now();
	return t < at + ttl;
}

/**
 * 可渲染集合（设计稿 §5 顺序）：先过 `isVisible`；**同 `kind` 只留 `rev` 最大者**；
 * 跨 `kind` 按 `at` **升序**（同 `at` 保持原顺序 = 稳定排序）。
 */
export function selectVisible(entries, now = Date.now()) {
	const list = Array.isArray(entries) ? entries.filter((e) => isVisible(e, now)) : [];
	const best = new Map();
	for (const e of list) {
		const cur = best.get(e?.kind);
		if (cur === undefined) best.set(e?.kind, e);
		else if ((isNum(e?.rev) ? e.rev : 0) > (isNum(cur?.rev) ? cur.rev : 0)) best.set(e.kind, e);
	}
	return [...best.values()].sort((a, b) => (isNum(a?.at) ? a.at : 0) - (isNum(b?.at) ? b.at : 0));
}

/**
 * 分片文件是否可用（**R6**：非数组 / `schemaVersion` 不符 ⇒ 不可用 ⇒ 丢弃重建）。
 * 只判"文件级"可用性：单条坏键由 `validateEntry` 逐条丢弃 + 计数（per-emitter 隔离）。
 */
export function isShardReusable(parsed) {
	if (!Array.isArray(parsed)) return { ok: false, reason: "not-array" };
	for (const e of parsed) {
		if (!isPlainObject(e)) return { ok: false, reason: "not-object" };
		if (e.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: "schema-version" };
	}
	return { ok: true, reason: "ok" };
}
