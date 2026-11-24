import { mkdirSync, appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
/** ★批7 `T15`（`#A342`）：**稳定身份** `cardId` —— **同一次排程的 `scheduleId` 恒定**（排程卡与 `phase="invalid"` 自扫卡**共用同一身份** ⇒ 相位更新原地继承，不跳位）；缺 `scheduleId` ⇒ 显式 `null`。 */
const _cardIdOfSchedule = (scheduleId) => ((scheduleId === null || scheduleId === undefined || scheduleId === "") ? null
	: createHash("sha256").update("dsh-graceful-restart|restart|" + String(scheduleId)).digest("hex").slice(0, 32));
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/graceful-restart/。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PLUGIN_DATA = join(DSH_HOME, "plugin-data", "graceful-restart");

// ---------- 插件配置（/api/graceful-restart/config，落 plugin-data/graceful-restart/settings.json，schemaVersion 1） ----------
const SETTINGS_FILE = process.env.DSH_GR_SETTINGS_FILE || join(PLUGIN_DATA, "settings.json");
const SETTINGS_SCHEMA = 1;
// 默认值 = 改造前常量（QUIET_WINDOW_MS=10s、TIMEOUT_MS=15min、允许模型工具触发）
const SETTINGS_DEFAULTS = Object.freeze({ quietWindowSec: 10, timeoutMin: 15, allowAgentTrigger: true });
const SETTINGS_NUMBERS = Object.freeze({ quietWindowSec: [3, 120], timeoutMin: [1, 120] });
const SETTINGS_BOOLS = Object.freeze(["allowAgentTrigger"]);
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

/** 注册 /api/graceful-restart/config 的 get / set / reset（经 host-compat 通道面；失败如实 warn）。 */
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
			ctx.logger?.warn?.(`dsh-graceful-restart: /api/graceful-restart/config ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") { ctx.logger?.warn?.("dsh-graceful-restart: host-compat 未提供 channelFace，/api/graceful-restart/config 不可用"); return; }
		const face = seams.channelFace(ctx, "/graceful-restart/config", ["get", "set", "reset"], handler);
		if (!face?.ok) ctx.logger?.warn?.(`dsh-graceful-restart: /api/graceful-restart/config 注册失败 ${JSON.stringify(face?.results ?? [])}`);
	}).catch((err) => { ctx.logger?.warn?.(`dsh-graceful-restart: host-compat 加载失败 ${String(err?.message ?? err)}`); });
}
const LOG_DIR = join(DSH_HOME, "logs", "graceful-restart");
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @deepseek-ai/dsh-graceful-restart (本地辅助插件, 非官方包)
 *
 * 优雅重启: 解决"重启容器 = 当前回合被掐断成 interrupted, 重启后缓存失效全量重传"的痛点。
 *
 * 原理 (源码验证):
 *   - dsh-session 的 interruptedTurnClosers() 只会在会话日志尾部存在"未闭合 turn/start"
 *     时合成 turn/end {reason:{kind:'interrupted'}} + 未落盘 tool 的 error 结果。
 *   - 因此只要重启时所有会话日志 balanced (回合已闭合落盘), 重启后就是干净的"完成",
 *     无 interrupted 合成、无对账重做、无 token 浪费。
 *   - SIGTERM (kill 7) 走 process interrupt 路径: abort 信号 + 5s 强制 forceExit,
 *     运行中回合来不及闭合 → 粗鲁。本插件改用 ctx.appExit (= shutdown.shutdown):
 *     dispose 完成后自然退出, 不强制掐断。前提是触发时所有 agent 已 idle。
 *
 * 触发 (两种都会弹横幅 kind=restart, 内嵌按钮面板经 /graceful-restart RPC, 零 token):
 *   - 用户: /graceful-restart [原因] → 排程, 空闲后横幅 [确认重启] 按钮 = 二次确认
 *   - agent: graceful_restart 工具 (描述要求: 调用前必须先 ask_user_question 问用户,
 *     用户确认后才调用 → 工具被调用即视为用户已确认, 空闲后自动进入观察, 无需按钮)
 *
 * 状态机 (横幅通过 notice/banner + notice/banner-replace 原地替换同一条, 固定 context):
 *   scheduled(等待空闲) → ready(空闲待确认) → observing(静默观察10s) → exiting(appExit)
 *   └── cancelled / timedout (取消 / 15分钟超时)
 *
 * 兜底:
 *   - 静默观察重置: 观察期间任何活动(新消息/新任务唤醒 agent)重置 10s 倒计时
 *   - 超时取消: 15min 未就绪/未确认自动取消, 绝不强制
 *   - 重启后 taskqueue 自动重新派发 pending 任务 (已有机制)
 */
export const name = "dsh-graceful-restart";
// connection 注入: 浏览器端 RPC 通道 (/graceful-restart) 需要 dsh-client-connection
export const inject = ["commands", "agents", "tools", "connection"];

/* ==========================================================================================
 * P1-2 · R3 修复（B1 清零）：模块顶层**不得**碰宿主
 *   改前：模块顶层 `KNOWN_SESSION_EVENT_TYPES.add(...)` ×2（静态 import 宿主包 `@deepseek-ai/dsh-session`）
 *        ⇒ 违反 doctrine R3/ENV 红线 6（加载期必须 inert）。
 *   改后：**注册动作本身保留**（1.5 的进程内读路径 `ownEvents()/readSessionEvents` 仍需要该类型在白名单里，
 *        也仍是持久化读取路径的硬要求），但改在 **apply 内**、经**中间件**（host-compat §4.5
 *        `ensureEventTypes` seam，动态 import + try/catch）+ 幂等（成功过一次就不再调）。
 *   能力缺失 / 共享库缺失 ⇒ **停用注册并如实告警**（不回落直连宿主；契约 §10.2）。
 * ========================================================================================== */
const BANNER_TYPES = ["notice/banner", "notice/banner-replace"];
let bannerTypesRegistered = false;
/** banner-kit 模块缓存（**只缓存共享库模块**；不缓存任何宿主服务引用 —— 契约 §12-21 ⑤） */
let bannerKitMod;
let bannerKitDead = false;
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
			if (typeof _smB6.wrapBannerKit === "function") bannerKitMod = _smB6.wrapBannerKit(bannerKitMod, "dsh-graceful-restart");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch {
		bannerKitDead = true;
		bannerKitMod = null;
	}
	return bannerKitMod;
}
/** 幂等注册 notice/banner 事件类型（经 banner-kit → §4.5 `ensureEventTypes` seam）。永不 throw。 */
async function ensureBannerTypes(logger) {
	if (bannerTypesRegistered) return { ok: true, cached: true };
	try {
		const bk = await loadBannerKit();
		if (!bk || typeof bk.ensureRegistered !== "function") {
			logger?.warn?.(`${name}: 事件类型注册停用 — banner-kit 不可用（契约 §10.2: 不回落直连宿主）`);
			return { ok: false, reason: "banner-kit" };
		}
		const r = await bk.ensureRegistered();
		if (r?.ok === true) {
			bannerTypesRegistered = true;
			return { ok: true, registered: r.registered };
		}
		logger?.warn?.(`${name}: 事件类型注册失败 — ${r?.reason ?? "unknown"}（注入方须停写）`);
		return { ok: false, reason: r?.reason ?? "unknown" };
	} catch (err) {
		logger?.warn?.(`${name}: 事件类型注册异常（已忽略）: ${String(err?.message ?? err)}`);
		return { ok: false, reason: `register-failed:${String(err?.message ?? err)}` };
	}
}

const DEBUG_ENABLED = process.env.DSH_GR_DEBUG === "1";
const DEBUG_LOG = join(LOG_DIR, "debug.log");
function debug(msg) {
	if (!DEBUG_ENABLED) return;
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
	} catch { /* ignore */ }
}

/** 默认配置: 轮询间隔 / 静默观察窗口 / 总超时 */
const POLL_INTERVAL_MS = 2000;
const QUIET_WINDOW_MS = 10000;
const TIMEOUT_MS = 15 * 60 * 1000;

/** 正常重启路径的"硬退兜底"（`#57`；2026-10-17 批 11 落码）：
 *  背景 —— 2026-10-15 实况：`appExit(0)` 只关监听、进程停在 `ep_poll`（socket 数 0、RSS 2.5 GB）
 *  ⇒ 容器不退出、`unless-stopped` 不触发 ⇒ GUI 不可用 ≈18 min 22 s（"假活"），最后靠用户侧
 *  `docker restart -t 15` 才恢复。本函数只兜"正常重启路径"（SIGTERM 路径已由宿主 5 s `forceExit` 兜）。
 *  行为：`appExit(0)` 之后起一个 **8 s 定时器**（**unref**，见下 `#57` 修法），
 *  到时进程仍在 ⇒ `process.exit(0)` 强制退出，让容器重建。
 *  负控（不得提前杀）：进程若在 8 s 内自行退出 ⇒ `exit` 钩子清掉定时器并留痕（`cleared`）。
 *  debug 留痕：开火记 `fired`、清除记 `cleared`（两行可机械判别"兜底是否生效/是否被提前触发"）。 */
const HARD_EXIT_DELAY_MS = 8000;
function armHardExitWatchdog() {
	let fired = false;
	let timer = null;
	try {
		timer = setTimeout(() => {
			fired = true;
			debug(`hard-exit watchdog fired: process still alive ${HARD_EXIT_DELAY_MS}ms after appExit(0) ⇒ process.exit(0)`);
			try { process.exit(0); } catch (err) { debug(`hard-exit watchdog exit unavailable: ${String(err?.message ?? err)}`); }
		}, HARD_EXIT_DELAY_MS);
		// ★ `#57`（2026-10-17 批 16；离线三臂定因件 §4 修法 (a)）：**unref** ⇒ 定时器**不再钉住事件循环**。
		//   旧行为（不 unref）＝ 定时器自己就是"撑住 loop 的最后一个人" ⇒ 进程**必然**活到 8 s ⇒ `fired`
		//   恒真、不可证伪（用户可见后果：明明 dispose 已排空，GUI 仍白等 8 s，且日志里永远有一条假告警）。
		//   新语义（三臂实测）：**无残留句柄 ⇒ 0–2 s 自然退出且不误报 `cleared/fired`**；
		//   **有残留句柄 ⇒ 仍 8 s 开火**（兜底不削牙，臂 C 已证）⇒ `fired` 从此**有判别力**（开火 ⇒ 确实有别的句柄）。
		try { timer.unref?.(); } catch { /* 忽略 */ }
		process.once("exit", () => {
			if (fired) return; // 已开火 ⇒ 无需清（此时进程正因兜底退出）
			try { clearTimeout(timer); } catch { /* 忽略 */ }
			debug(`hard-exit watchdog cleared: process exited within ${HARD_EXIT_DELAY_MS}ms (normal exit, not killed early)`);
		});
	} catch (err) {
		debug(`hard-exit watchdog unavailable: ${String(err?.message ?? err)}`);
	}
}

// ---------- 件A（`#A222`）：自记账（跨重启）＋ 开机自扫（取代已失效的 `invalid-scan`）----------
// 为什么：容器重启后内存 `intent` 消失，重启前"未终态"的排程卡会以"还在等待空闲"的僵尸形态留在屏上
//   （点确认报 not-found）。原 `invalid-scan` 读 `session.ownEvents()`（会话日志面），而 P1-2 后写入源
//   已改 `banner-kit.emit` 且 `seams.DUAL_TRACK_LOG=false`（写入路径已无日志分支）⇒ 它读的那个面**不再被写入**，
//   结构性失明 ⇒ 改由**本插件自有记账文件**承载"哪次排程可能跨了重启"，开机时据此如实标 `invalid`。
// 纪律：只读写**自有**数据（doctrine R2）；文件放持久卷（`/tmp` 重启即丢，正是本件要跨的那一次重启）；
//   原子写 `.tmp → rename`（照抄 `dsh-taskqueue/lib/index.js:116/220-240` 先例）；env 可覆盖（供判据隔离）。
/** 记账目录/文件（`DSH_GR_DIR` / `DSH_GR_STATE_FILE` 仅测试用；缺省 = `$DSH_HOME/plugin-data/graceful-restart`） */
const GR_DIR = process.env.DSH_GR_DIR || PLUGIN_DATA;
const GR_STATE_FILE = process.env.DSH_GR_STATE_FILE || join(GR_DIR, "graceful-restart-state.json");
const GR_TMP_FILE = `${GR_STATE_FILE}.tmp`;
const GR_LEDGER_SCHEMA = 1;
/** 上界：超出按 `askedAt` 淘汰最旧（与 store 单会话 2000 条兜底同向，这里更紧是因为条目语义等长于"排程"） */
const MAX_LEDGER = 20;
/** 终态相位：这些相位一旦 emit 成功 ⇒ 该排程已收束 ⇒ 划账（不再参与开机自扫） */
const TERMINAL_PHASES = new Set(["cancelled", "timedout", "error"]);

/** ★A90：自扫用锚点判定（纯函数，导出供夹具对撞）。
 *  规则：记账里的 `anchorSeq` 只是**提示**；必须在该会话行事实（`index.slots[].seq`）里命中才带，
 *  否则返回 null（宁可退回无锚，也不让写入闸门以 `gate-anchor-mismatch` 整卡拒收）。
 *  @param {{anchorSeq?:number}} entry 记账条目
 *  @param {(sid:string)=>{ok?:boolean,index?:{slots?:Array<{seq?:number}>}}|null} readIndex 注入的读索引函数（`noticeState.readIndex`）
 *  @returns {number|null}
 */
export function pickAnchorFromIndex(entry, readIndex) {
	const seq = Number.isInteger(entry?.anchorSeq) && entry.anchorSeq > 0 ? entry.anchorSeq : null;
	if (!seq || typeof readIndex !== "function") return null;
	try {
		const r = readIndex(entry?.sessionId);
		const slots = r && r.ok === true && r.index && Array.isArray(r.index.slots) ? r.index.slots : null;
		return slots && slots.some((x) => x && x.seq === seq) ? seq : null;
	} catch { return null; }
}

/** 只读记账（缺文件/坏 JSON ⇒ 空表，**绝不 throw** —— 记账故障不得挡住重启流程） */
function readLedger() {
	try {
		if (!existsSync(GR_STATE_FILE)) return [];
		const raw = JSON.parse(readFileSync(GR_STATE_FILE, "utf8"));
		const arr = Array.isArray(raw?.entries) ? raw.entries : [];
		return arr.filter((e) => e && typeof e.scheduleId === "string" && e.scheduleId && typeof e.sessionId === "string" && e.sessionId);
	} catch (err) {
		debug(`ledger read fail: ${String(err?.message ?? err)}`);
		return [];
	}
}

/** 原子写（`.tmp` → `rename`，`0600`；目录 `0700`）。失败 ⇒ 返回 false（后果仅"漏划"，不 throw） */
function writeLedger(entries) {
	try {
		mkdirSync(dirname(GR_STATE_FILE), { recursive: true, mode: 0o700 });
		writeFileSync(GR_TMP_FILE, `${JSON.stringify({ schema: GR_LEDGER_SCHEMA, entries }, null, "\t")}\n`, { mode: 0o600 });
		try { chmodSync(GR_TMP_FILE, 0o600); } catch { /* 平台不支持 ⇒ 忽略 */ }
		renameSync(GR_TMP_FILE, GR_STATE_FILE);
		try { chmodSync(GR_STATE_FILE, 0o600); } catch { /* 同上 */ }
		return true;
	} catch (err) {
		debug(`ledger write fail: ${String(err?.message ?? err)}`);
		return false;
	}
}

/** upsert（**唯一键 = `scheduleId`** ⇒ 天然防重复）；超上界淘汰最旧 */
function ledgerUpsert(entry) {
	try {
		if (!entry?.scheduleId || !entry?.sessionId) return false;
		const list = readLedger().filter((e) => e.scheduleId !== entry.scheduleId);
		list.push(entry);
		list.sort((a, b) => ((a.askedAt ?? a.requestedAt) ?? 0) - ((b.askedAt ?? b.requestedAt) ?? 0));
		return writeLedger(list.slice(-MAX_LEDGER));
	} catch (err) {
		debug(`ledger upsert fail: ${String(err?.message ?? err)}`);
		return false;
	}
}

/** 划账（终态 emit 成功 / `exiting` / 自扫成功后）。
 *  失败最坏后果 = "下次开机重复 emit 一次 invalid"（同 `ctxKey` ＋ `replace` ⇒ 可见卡恒 1 张，幂等无害）。 */
function ledgerSettle(scheduleId) {
	try {
		if (!scheduleId) return false;
		const list = readLedger();
		const next = list.filter((e) => e.scheduleId !== scheduleId);
		if (next.length === list.length) return true; // 本就不在账上 ⇒ 无事可做
		return writeLedger(next);
	} catch (err) {
		debug(`ledger settle fail: ${String(err?.message ?? err)}`);
		return false;
	}
}

/* ==========================================================================================
 * ★`#A193` 件③（2026-09-23 obs3S7）：**host-compat 申报面**（准入三条①"闸门申报"／②"未适配即降级"）
 *   · 本插件此前 **0 处 `requires`** ⇒ **不参加能力探测** ⇒ 能力缺失（`sessionEvents` 订阅不到）**静默**。
 *   · 现申报 `sessionEvents`（＝工具面「按 `exec.callId` 取 `tool/call` seq」的唯一来源）。
 *   · 缺失时：**如实 `DEGRADED` ＋ `report` 面板可见**；工具面**如实无行身份**（不猜）。
 *     ⇒ 撤族级豁免后，该情形由**写入闸门如实拒收**（可见、可 grep），**不静默**（用户令）。
 *   · 本插件**不依赖 host-compat 做写入** ⇒ host-compat 不可用时**不阻断**（只不申报）。
 * ========================================================================================== */
const REQUIRES = ["sessionEvents"];
function ownMeta() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return { version: pkg?.version ?? "unknown" };
	} catch { return { version: "unknown" }; }
}
async function reportCapability(ctx) {
	try {
		const seams = await import("@ericality/dsh-host-compat/seams").catch(() => null);
		const compat = await import("@ericality/dsh-host-compat").catch(() => null);
		const localMissing = REQUIRES.filter((k) => (k === "sessionEvents" ? typeof ctx?.on !== "function" : false));
		const prober = (typeof compat?.probe === "function") ? compat : ((typeof seams?.probe === "function") ? seams : null);
		let missing = localMissing;
		let state = localMissing.length ? "DEGRADED" : "OK";
		if (prober) {
			try {
				const r = prober.probe(REQUIRES, name, ownMeta().version, ctx);
				if (Array.isArray(r?.missing)) missing = [...new Set([...r.missing.filter((k) => REQUIRES.includes(k)), ...localMissing])];
				if (typeof r?.state === "string") state = r.state;
			} catch { /* probe 失败 ⇒ 退回本地探测（口径一致，不升级） */ }
		}
		const entry = {
			id: name, version: ownMeta().version, state, missing, blocked: [],
			note: state === "OK" ? "" : `缺 ${missing.join(", ")} ⇒ 工具面（\`graceful_restart\`）取不到行身份 ⇒ 该卡**如实无行身份**（不猜；由写入闸门如实处理，不静默）`
		};
		const reporter = (typeof compat?.report === "function") ? compat : ((typeof seams?.report === "function") ? seams : null);
		if (reporter) { try { reporter.report(entry); } catch { /* 上报失败不影响主流程 */ } }
		else ctx?.logger?.warn?.(`${name}: host-compat 不可用 ⇒ 能力申报未上报（state=${state} missing=[${missing.join(", ")}]）`);
	} catch { /* 绝不 throw（准入三条③：加载期 inert） */ }
}

export const apply = (ctx) => {
	registerConfigApi(ctx);
	// ★`#A193` 件③（2026-09-23 obs3S7；用户令「有问题就修问题，不要藏起来」）：**补 host-compat 申报面**。
	//   本插件此前 **0 处 `requires`** ⇒ 不参加能力探测 ⇒ 「拿不到 `sessionEvents`（工具面行身份的唯一来源）」是**静默的**。
	//   现申报 `sessionEvents`：缺失 ⇒ **如实 `DEGRADED` ＋ 面板可见**（`report`），且工具面**如实无行身份**（不猜、不静默）。
	void reportCapability(ctx);
	// P1-2 (R3/B1 清零)：事件类型注册从**模块顶层**移进 apply —— 经中间件 + 幂等 + try/catch，
	// **注册动作本身保留**（1.5 进程内读路径 / 持久化白名单仍需要它）。异步启动、不阻塞 apply。
	void ensureBannerTypes(ctx?.logger ?? null);
	/** 重启意图状态 (内存态; 重启后自然消失, 取消也自然) */
	const bannerStarted = new Set(); // scheduleId 集合: 本进程内已 start 过的重启横幅 (0.1.2 无 events 可用)
	let intent = null; // { reason, askedAt, cutoffMs, notifySessionId, userOk, phase, pollTimer, quietTimer, quietSince }
	let inboxShapeWarned = false; // v0.1.10: inbox 形状异常只告警一次
	let lastParkedSig = ""; // v0.1.10: 滞留 nextStep 上下文日志签名 (去重)

	/** 检查所有 live agent (含子 agent) 是否全部空闲。
	 *  必须包含触发会话自身 (v0.1.3): appExit 前要等自己回合闭合落盘,
	 *  否则退出时掐断自己回合 → interrupted → 重传 token (v0.1.2 的 excludeSelf 是错误修复)。
	 *
	 *  ⚠️ v0.1.10 (2026-09-12, 0.1.2 语义修正 —— 排程卡死根因):
	 *  `inbox.hasPending` = nextTurn **或** nextStep 非空, 但两者语义完全不同:
	 *    · nextTurn = 排队等自己回合的普通消息 (followup 必然唤醒 driver) → 算"忙";
	 *    · nextStep = `agent.inject()` 注入的模型上下文。dsh 官方类型定义原文:
	 *      "Queue model-facing context for the next pre-step **without waking the driver** …
	 *       idle drivers leave it pending until follow-up or steering wakes them"
	 *      ⇒ idle 会话里的 nextStep **永远不会被消费** (没人唤醒 driver), 不能当"忙",
	 *      否则一旦有滞留 nextStep, 全空闲判定永远为假 → 排程卡死到 15min 超时。
	 *  实测 (2026-09-12 14:22-14:27 生产): 回合以 TRANSPORT 错误结束时, 后台子 agent 结算通知
	 *  (inject → next-step) 永久滞留在 session-0d27 的 idle inbox → 旧判定刷 "busy 1/6 … pending=true"
	 *  直到 15min 超时, 优雅重启完全不可用。
	 *  代价说明: nextStep 里的注入上下文会在 appExit 的 dispose 里被 canceled (与手动重启相同) —
	 *  调试日志会记一行 `parked-context` 以便追查丢了什么。
	 */
	function allAgentsIdle() {
		try {
			const agents = ctx.agents.list?.() ?? [];
			// 兼容未知 inbox 形状: 拿不到 nextTurn 时只认 status (宁可放行, 不再永久卡死), 并记一次告警
			const pendingTurns = (a) => {
				const t = a?.inbox?.nextTurn;
				if (Array.isArray(t)) return t.length;
				if (t === undefined && !inboxShapeWarned) {
					inboxShapeWarned = true;
					debug(`warn: agent inbox.nextTurn 不可读 (inbox 形状变化?), 本进程只按 status 判定空闲`);
				}
				return 0;
			};
			const busy = agents.filter((a) => a.status !== "idle" || pendingTurns(a) > 0);
			// 2026-09-10: 加可观测性 —— 超时后能直接从日志看出是谁在忙 (原来完全查不到)
			if (busy.length) {
				debug(`busy ${busy.length}/${agents.length}: ${busy.slice(0, 5).map((a) => `${String(a.id ?? "?").slice(0, 12)}(status=${a.status},pending=${a.inbox?.hasPending},nextTurn=${pendingTurns(a)})`).join(" ")}`);
				lastParkedSig = "";
			} else {
				// 滞留的 nextStep 注入上下文: 不阻塞排程, 但记一行 (签名去重, 避免每 2s 刷日志)
				const parked = agents.filter((a) => a.status === "idle" && (a.inbox?.nextStep?.length ?? 0) > 0);
				const sig = parked.map((a) => `${a.id}:${a.inbox?.nextStep?.length ?? 0}`).join(",");
				if (parked.length && sig !== lastParkedSig) {
					lastParkedSig = sig;
					debug(`parked-context ${parked.length}/${agents.length} (不阻塞空闲判定, 重启会丢弃): ${parked.slice(0, 5).map((a) => `${String(a.id ?? "?").slice(0, 12)}(nextStep=${a.inbox?.nextStep?.length ?? 0})`).join(" ")}`);
				}
			}
			return busy.length === 0;
		} catch (err) {
			debug(`allAgentsIdle error: ${String(err?.message ?? err)}`);
			return false;
		}
	}

	/** 横幅数据 (client 按 phase 渲染状态与按钮) */
	/** ★本插件**不再给横幅传 `ttlMs`**（2026-09-24 obs3S7 `#A211`/`#A217`：用户裁「不能做 30 分钟有效期」；`#A212` 只读可行性确认 + `#A214`–`#A216` 机制链）。
	 *  原实现：`RESTART_BANNER_TTL_MS = 30*60*1000` 写进**每张**卡 ⇒ 排程结束（`pushBanner(); clearIntent();`，含 `cancelled`/`timedout`/`exiting`）后**不再刷新 `at`** ⇒
	 *  `at + 30min` 一到整张卡**不再渲染** —— 而那正是用户最想看"结果"的时刻（活跃相位靠 `at` 自刷新本就永不过期 ⇒ TTL 实际只咬终局后）。
	 *  **"永久可见"的写法 ＝ 不传 `ttlMs`**（`dsh-banner-kit` `OPTIONAL_KEYS`；`isVisible`：无 `ttlMs`／非有限数 ⇒ 可见）⇒ **少传一个可选键 ⇒ 非键集变更**，不触读面契约、不新增键。
	 *  僵尸卡（容器重启后残留的 `scheduled`/`observing`）不再靠"消失"掩盖，改由**客户端自愈**如实显示"已失效"（`dsh-notice-banner/lib/client.js` 活跃相位向 `/graceful-restart status` 核对）。
	 *  口径见 `docs/DSH内部机制速查.md` §2.16 ／ `docs/plugins/dsh-notice-banner.md` ★可见期口径 ／ `docs/测试踩坑手册.md` E43。 */

	function bannerData(extra = {}) {
		const remainMs = intent ? Math.max(0, intent.cutoffMs - Date.now()) : 0;
		return {
			kind: "restart",
			priority: 3, foldable: (typeof intent?.commandId === "string" && intent.commandId) ? false : true, family: "restart",
			scheduleId: intent?.scheduleId ?? "", // v0.1.4: client context id 用, 每次排程独立横幅
			reason: intent?.reason ?? "",
			phase: intent?.phase ?? "none",
			at: Date.now(),
			remainSec: Math.ceil(remainMs / 1000),
			...extra
		};
	}

	/** 向通知会话 append 横幅 (start 或 replace 原地替换, log-only 不唤醒 agent)。
	 *  每次 schedule 新排程时强制 start (forceStart=true) — 不用历史 hasStart 判断,
	 *  否则历史 60+ 条 restart replace 会让 client context 错乱, 新横幅无法渲染 (v0.1.4)。
	 *  P1-2: 写入源 = **banner-kit.emit（去 session）**（经 §4.4 seam → 中间件 sink → 自有 store）；
	 *  本插件**不再直连 `session.append`**（R1）。 */
	function pushBanner(extra, forceStart = false) {
		const session = ctx.agents.get?.(intent?.notifySessionId)?.session;
		const sid = String(session?.id ?? intent?.notifySessionId ?? "");
		if (!sid) return;
		// ★件A 记账写入点：**必须在上面 `if (!sid) return` 之后**（`#A222` 硬口径）——
		//   否则会出现"记账有、卡没有" ⇒ 下次开机凭空 emit 一张 invalid 卡。记账记的是"**这条排程真的在跑**"，
		//   与"本进程有没有把卡发出去"分开：`sid` 都取不到 ⇒ 连卡都发不出 ⇒ 不该记。
		const ledgerId = intent?.scheduleId ?? "";
		if (ledgerId) {
			ledgerUpsert({
				scheduleId: ledgerId,
				sessionId: sid,
				// ★A90 修：记账存**真实 anchorSeq**（仅作提示）；开机自扫前必须经 `pickAnchorFromIndex()` 验证该 seq
				//   在行事实里可解析才带上，否则退回无锚 —— 原写法恒 null ⇒ 重启后的 invalid 卡必然丢锚（rowless-unknown）。
				anchorSeq: Number.isInteger(intent?.anchorSeq) && intent.anchorSeq > 0 ? intent.anchorSeq : null,
				commandId: (typeof intent?.commandId === "string" && intent.commandId) ? intent.commandId : null,
				face: intent?.commandId ? "command" : (Number.isInteger(intent?.anchorSeq) ? "tool" : "none"),
				reason: intent?.reason ?? "",
			});
		}
		try {
			// 2026-09-10 (0.1.2 适配): agent.session 不再暴露 events 数组 → 旧实现
			// session.events.some(...) 抛 "Cannot read properties of undefined (reading 'some')"
			// → 横幅**所有后续更新(含 timedout/invalid 收尾)被静默丢弃**, 客户端永远停在
			// "等待空闲"。改为内存跟踪每个 scheduleId 是否已 start (本进程内)。
			const schedId = intent?.scheduleId ?? "";
			const hasStart = forceStart ? false : (schedId !== "" && bannerStarted.has(schedId));
			// ★`#A193` 件⑥ **VM 门亲验到的竞态修复**：身份必须**同步捕获** —— `bk.emit()` 在 `.then` 异步回调里执行，
			//   而 `clearIntent()` 可能先跑（取消/超时路径：`pushBanner(); clearIntent();`）⇒ 回调里读 `intent` 会拿到 `null`
			//   ⇒ 身份丢失 ⇒ 该卡落 `session`（**pre 臂 VM 门实测到**：`restart` 命令面卡 placed、取消卡 session）。
			const rowId = { anchorSeq: intent?.anchorSeq ?? null, commandId: intent?.commandId ?? null };
			const payload = { ...bannerData(extra), sessionId: sid };
			// ★件A 划账（`exiting` ＝ **真重启** ⇒ 必须**当刻同步**划，不能等 emit promise：进程 1s 后即退）
			//   —— 漏了这条 ⇒ 下次开机把"正在优雅重启"的卡改写成"已失效"（**语义反转、误导用户**，`#A222` 硬口径）。
			if (String(payload.phase ?? "") === "exiting" && ledgerId) ledgerSettle(ledgerId);
			if (schedId !== "") bannerStarted.add(schedId);
			void loadBannerKit().then((bk) => {
				if (!bk || typeof bk.emit !== "function") {
					debug(`banner 跳过: banner-kit 不可用 (phase=${intent?.phase ?? "none"})`);
					return null;
				}
				return bk.emit({ ...payload, cardId: _cardIdOfSchedule(payload.scheduleId),
					anchorLevel: (Number.isInteger(rowId.anchorSeq) || rowId.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD,
					// ★`#A67`：**ctxKey 带真实锚点 seq**（工具面 `anchorSeq`／命令面 `commandId` 对应的 seq 在客户端解析）
					//   ⇒ 客户端 ② 身份臂可把卡钉到"自己那一行"（0.1.2 靠事件信封 `turn/turnFrom`，0.2.2 该字段已丢）。
					//   取不到 seq ⇒ 退回 `restart-<scheduleId>`（**不编造 seq**，客户端按回合兜底并标 `turn`）。
					ctxKey: (Number.isInteger(rowId.anchorSeq) && rowId.anchorSeq > 0) ? ("restart-" + rowId.anchorSeq) : (payload.scheduleId ? "restart-" + payload.scheduleId : null),
					// ★`#A193` 件②：身份随**本次排程的一等身份**走（命令面 `commandId`／工具面 `anchorSeq`），**相位更新沿用同一身份** ⇒ 落位继承、不跳位。
					//   注意：发射侧表达式**只引用键名**（`anchorSeq`/`commandId`），归一化在 `schedule()` 里做 —— 否则静态键集对撞器会把
					//   `Number.isInteger`/`intent.rowAnchorSeq` 记成"引用未解析键"（站点红）。
					anchorSeq: rowId.anchorSeq,
					commandId: rowId.commandId }, { replace: hasStart, source: "dsh-graceful-restart" });
			}).then((r) => {
				if (r && r.ok !== true) debug(`banner fail: ${r?.reason ?? "unknown"}`);
				else if (r) debug(`banner ${hasStart ? "replace" : "start"} phase=${intent?.phase ?? "none"} sid=${sid.slice(0, 12)}${forceStart ? " (forced start)" : ""}`);
				// ★件A 划账（`#A222` 硬口径「**emit `ok===true` 才划**」）：终态相位 emit 成功 ⇒ 该排程已收束 ⇒ 从记账移除。
				//   失败/异常 ⇒ **保留**（最坏后果 = 下次开机重复 emit 一次 invalid；同 ctxKey＋replace ⇒ 幂等无害）。
				if (r && r.ok === true && ledgerId && TERMINAL_PHASES.has(String(payload.phase ?? ""))) {
					debug(`ledger 划账（${payload.phase} emit ok）: ${ledgerId}`);
					ledgerSettle(ledgerId);
				}
			}).catch((err) => debug(`banner fail: ${String(err?.message ?? err)}`));
		} catch (err) {
			debug(`banner fail: ${String(err?.message ?? err)}`);
		}
	}

	/** 清意图与定时器 */
	function clearIntent(reason) {
		if (!intent) return;
		debug(`clear intent: ${reason}`);
		if (intent.pollTimer) clearInterval(intent.pollTimer);
		if (intent.quietTimer) clearInterval(intent.quietTimer);
		intent = null;
	}

	/** 空闲检测轮询: 全空闲 → phase=ready → 停轮询; agent 触发(userOk)直接进观察。
	 *  进入 ready 后保持轮询: 若又有会话/子agent 活跃 (如队列低谷自动派发),
	 *  退回 scheduled 并更新横幅, 避免横幅停留在 ready 误导用户点确认 (v0.1.1 修复)。
	 *  ⚠️ v0.1.5: 进观察前必须先停本 timer, 否则 polling 与 observing 双 timer 竞态
	 *  (每 2s 重复 new 观察 timer + 覆盖 phase → 10s 窗口永远被重置, 卡死)。 */
	function startPolling() {
		const timer = setInterval(() => {
			if (!intent) { clearInterval(timer); return; }
			if (Date.now() > intent.cutoffMs) {
				intent.phase = "timedout";
				pushBanner({ phase: "timedout" });
				clearIntent("timeout");
				return;
			}
			if (intent.phase === "ready" && !allAgentsIdle()) {
				intent.phase = "scheduled"; // 重新活跃 → 退回等待
				debug("ready → scheduled (activity detected), keep waiting");
				pushBanner({ phase: "scheduled" });
				return;
			}
			if (allAgentsIdle()) {
				if (intent.userOk) {
					clearInterval(timer); // v0.1.5: 先停 polling, 再进观察
					intent.pollTimer = null;
					startQuietObservation();
					return;
				}
				// v0.1.10 (2026-09-12): 仅在相位真正切换时推横幅 —— 旧实现每 2s 重复
				// pushBanner({phase:"ready"}) (实测日志 58 条、间隔 2s 成串), 每条都是落盘的
				// 会话事件 → 会话日志膨胀 + 客户端反复重渲染。
				if (intent.phase !== "ready") {
					intent.phase = "ready";
					debug("all idle → ready");
					pushBanner({ phase: "ready" });
				}
			}
		}, POLL_INTERVAL_MS);
		intent.pollTimer = timer;
	}

	/** 静默观察: 等所有 agent (含触发会话自身) 全 idle 后, 连续 QUIET_WINDOW_MS 无活动
	 *  → exiting → appExit(0)。确认时若自身还在跑 (如用户触发后会话仍在处理),
	 *  先等它自然结束 (completed 落盘), 从全 idle 那一刻起算 10s — 绝不掐断自己回合 (v0.1.3)。
	 *  ⚠️ v0.1.5: 防重入 — 已有 quietTimer 直接返回; 调用前须确保 pollTimer 已停
	 *  (confirm handler 与 startPolling 内部都先 clearInterval 再调本函数)。 */
	function startQuietObservation() {
		if (!intent || intent.quietTimer) return;
		if (intent.pollTimer) { clearInterval(intent.pollTimer); intent.pollTimer = null; } // 兜底停 polling
		intent.phase = "observing";
		intent.quietSince = null; // null = 尚未全 idle, 不开始计时
		// v0.1.8: 确认即进观察; 若此刻仍有活动, 通知"等待所有会话空闲" (不开始倒计时)
		pushBanner({ phase: "observing", statusNote: allAgentsIdle() ? "" : "等待所有会话空闲…" });
		const timer = setInterval(() => {
			if (!intent) { clearInterval(timer); return; }
			if (Date.now() > intent.cutoffMs) {
				intent.phase = "timedout";
				pushBanner({ phase: "timedout" });
				clearIntent("timeout");
				return;
			}
			if (!allAgentsIdle()) {
				// v0.1.7: 活动重置时发横幅带原因 — client 收到后更新文案并重新倒计时,
				// 避免 client 到 0s 误显示"正在优雅重启" (实际还在等待)
				if (intent.quietSince !== null) {
					intent.quietSince = null;
					pushBanner({ phase: "observing", statusNote: "检测到活动，重新等待静默" });
					debug("quiet observation: activity → reset, notify client");
				}
				return;
			}
			if (intent.quietSince === null) {
				intent.quietSince = Date.now(); // 首次全 idle → 开始 10s 计时
				pushBanner({ phase: "observing", statusNote: "" }); // v0.1.7: 清除原因, 重新倒计时
				debug(`quiet observation: all idle, ${Math.round((intent.quietWindowMs ?? QUIET_WINDOW_MS) / 1000)}s window starts`);
				return;
			}
			if (Date.now() - intent.quietSince >= (intent.quietWindowMs ?? QUIET_WINDOW_MS)) {
				clearInterval(timer);
				intent.phase = "exiting";
				pushBanner({ phase: "exiting" });
				debug("quiet window passed, appExit(0) in 1s (let client render exiting)");
				const exit = ctx.get?.("appExit");
				if (typeof exit !== "function") {
					debug("appExit unavailable!");
					intent.phase = "error";
					pushBanner({ phase: "error" });
					clearIntent("appExit unavailable");
					return;
				}
				intent = null; // 清状态后退出
				// v0.1.6: 延迟 1s 再退出 — 让客户端先收到/渲染 exiting 横幅 (否则进程秒退,
				// 客户端卡在 observing+0s 看不到"正在优雅重启")。exit 由进程退出, 无需 await。
				// ★批 11（2026-10-17）：正常重启路径补"硬退兜底"（#57）—— appExit(0) 后 8s 进程仍在 ⇒ process.exit(0)。
				setTimeout(() => {
					try { exit(0); } catch (err) { debug(`appExit threw: ${String(err?.message ?? err)}`); }
					armHardExitWatchdog();
				}, 1000);
			}
		}, POLL_INTERVAL_MS);
		intent.quietTimer = timer;
	}

	/** 新建意图并启动流程 (命令/工具共用)
	 *  ★`#A193` 件②（2026-09-23）：第 4 参 `row` ＝ **本次排程的行身份**（`{ commandId }` 命令面 ／ `{ anchorSeq }` 工具面）；
	 *  取不到 ⇒ `null`（**不猜**）⇒ 该卡如实无行身份，由写入闸门如实处理（撤族级豁免后＝拒收 ＋ 面板可见）。 */
	function schedule(reason, sessionId, confirmedByAgent, row = null, settings = null) {
		const quietWindowMs = Math.max(1000, Math.round((Number(settings?.quietWindowSec) || SETTINGS_DEFAULTS.quietWindowSec) * 1000));
		const timeoutMs = Math.max(60000, Math.round((Number(settings?.timeoutMin) || SETTINGS_DEFAULTS.timeoutMin) * 60000));
		intent = {
			reason,
			askedAt: Date.now(),
			// 配置在排程时快照: 排程中的重启不因改配置取消, 下一次排程生效（规格 b.4 边界）
			quietWindowMs,
			cutoffMs: Date.now() + timeoutMs,
			notifySessionId: sessionId,
			userOk: confirmedByAgent, // agent 触发 = 已问过用户 = 已确认
			phase: "scheduled",
			pollTimer: null,
			quietTimer: null,
			quietSince: 0,
			scheduleId: `rs-${Date.now()}`, // v0.1.4: 排程实例 id, 横幅 context 用 (每次排程独立横幅, 不串历史)
			anchorSeq: Number.isInteger(row?.anchorSeq) ? row.anchorSeq : null,
			commandId: (typeof row?.commandId === "string" && row.commandId) ? row.commandId : null
		};
		debug(`schedule: reason="${reason}" userOk=${confirmedByAgent} sid=${String(sessionId).slice(0, 12)} scheduleId=${intent.scheduleId} anchorSeq=${intent.anchorSeq} commandId=${intent.commandId ? intent.commandId.slice(0, 8) : "null"}`);
		if (allAgentsIdle()) {
			intent.phase = "ready";
			debug("already idle → ready");
			if (intent.userOk) { startQuietObservation(); return "ready-observing"; }
			pushBanner({ phase: "ready" }, true); // 新排程强制 start 新横幅 (v0.1.4)
			return "ready";
		}
		startPolling();
		pushBanner({ phase: "scheduled" }, true); // 新排程强制 start 新横幅 (v0.1.4)
		return "scheduled";
	}

	// ---------- 命令: /graceful-restart [原因] (用户触发, 需按钮二次确认) ----------
	ctx.commands.register({
		name: "graceful-restart",
		description: "优雅重启排程: 等待所有会话/子agent空闲后, 横幅 [确认重启] 按钮二次确认, 静默观察(默认10s, 配置页可调)无活动再自然退出(不打断回合, 重启后无interrupted不浪费token); 后跟文字为重启原因",
		input: { hint: "[重启原因(可选)]" },
		handler: async (invocation) => {
			const agent = invocation?.agent;
			if (!agent) return { kind: "error", text: "未找到当前会话 agent, 无法排程重启" };
			if (intent) return { kind: "error", text: "已有重启排程进行中: 运行 /graceful-restart-cancel 或点横幅 [取消] 后再试" };
			const reason = String(invocation?.rawInput ?? "").trim() || "用户手动触发";
			// ★`#A193` 件②：命令面把**宿主发放的同源 `commandId`** 交给排程（与 `dsh-balance:507` 逐字同形）⇒ 该卡落**自己那条命令行**下。
			const settings = await readSettings();
			const quietSec = settings.quietWindowSec;
			const r = schedule(reason, agent.session.id, false, { commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null }, settings);
			if (r === "ready") return { kind: "success", text: `重启已排程（原因: ${reason}）。当前环境已空闲: 点横幅 [确认重启] 后 ${quietSec}s 优雅重启（期间有活动自动顺延），[取消] 可随时取消，${settings.timeoutMin} 分钟未确认自动取消。` };
			if (r === "ready-observing") return { kind: "success", text: `重启已排程（原因: ${reason}）。当前环境已空闲，已进入 ${quietSec}s 静默观察，即将优雅重启。` };
			return { kind: "success", text: `重启已排程（原因: ${reason}）。当前有会话/子agent活跃，等待全部空闲后横幅会变为可确认。点 [确认重启] 执行，[取消] 取消，${settings.timeoutMin} 分钟超时自动取消。` };
		}
	});

	ctx.commands.register({
		name: "graceful-restart-cancel",
		description: "取消优雅重启排程",
		handler: async () => {
			if (!intent) return { kind: "error", text: "没有进行中的重启排程" };
			intent.phase = "cancelled";
			pushBanner({ phase: "cancelled" });
			clearIntent("user cancelled");
			return { kind: "success", text: "重启排程已取消。" };
		}
	});

	// ---------- 模型工具: graceful_restart (agent 触发, 描述要求先 ask_user_question) ----------
	ctx.tools.register(defineTool({
		name: "graceful_restart",
		description: "优雅重启容器排程: 部署/改动需要重启生效时使用。调用前必须先 ask_user_question 询问用户是否确认重启, 用户确认后才调用本工具 (调用即视为用户已确认); 本工具只排程, 会等所有会话/子agent空闲后静默观察(默认10s, 配置页可调)再自然退出, 不打断任何回合; 重启后 GUI 断开约10-30s自动恢复, 已排队的任务会由任务队列自动重新派发",
		parameters: {
			reason: { type: "string", required: true, description: "重启原因, 如: 部署新插件 xxx 生效" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const session = exec?.agent?.session;
			if (!session) throw new Error("无法获取当前会话");
			const reason = String(args?.reason ?? "").trim() || "agent 触发";
			const settings = await readSettings();
			if (settings.allowAgentTrigger !== true) throw new Error("配置已关闭模型工具发起重启（allowAgentTrigger=false）；用户可用 /graceful-restart 命令排程");
			if (intent) throw new Error(`已有重启排程进行中 (原因: ${intent.reason}), 请先取消再排新程`);
			// ★`#A193` 件②（路 A）：按**本次调用的 `exec.callId`** 精确取该次 `tool/call` 的 `seq`（**不再取"最近一条"**）。
			//   `exec.callId` ＝ 甲级明文（上游 `ToolExecutionInput.callId`）；取不到 ⇒ `null`（**不猜**）⇒ 如实无身份。
			const _callId = String(exec?.callId ?? "");
			const _row = { anchorSeq: (_callId && restartRowByCallId.has(_callId)) ? restartRowByCallId.get(_callId) : null };
			const r = schedule(reason, session.id, true, _row, settings);
			const base = `优雅重启已排程（原因: ${reason}）。已视为用户确认，等待所有会话空闲后静默观察 ${settings.quietWindowSec}s 自然退出，不打断任何回合。`;
			if (r === "scheduled") return { text: `${base} 当前有会话/子agent活跃，将自动等待。` };
			if (r === "ready-observing") return { text: `${base} 当前环境已空闲，已进入 ${settings.quietWindowSec}s 静默观察。` };
			return { text: `${base} 当前环境已空闲，已进入 ${settings.quietWindowSec}s 静默观察。` };
		},
		presentCall: (args) => ({ card: "generic", title: "优雅重启容器", kind: "other", rawInput: args })
	}));

	// ---------- /graceful-restart RPC 通道 (浏览器端横幅按钮面板, 零 token) ----------
	// 端点:
	//   status  {}        → 当前意图状态 (无排程时 intent:null)
	//   confirm {}        → 横幅 [确认重启] 按钮 → 进入静默观察
	//   cancel  {}        → 横幅 [取消] 按钮 → 取消排程
	// 返回 { ok: true, value } | { ok: false, error: { code, message } }。
	const _grHandler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "status":
				return { ok: true, value: intent ? {
					reason: intent.reason,
					phase: intent.phase,
					// v0.1.10: client 用它核对横幅是否为"僵尸"(重启前遗留的排程) — scheduleId 不匹配 = 已失效
					scheduleId: intent.scheduleId,
					userOk: intent.userOk,
					askedAt: intent.askedAt,
					cutoffMs: intent.cutoffMs,
					remainSec: Math.max(0, Math.ceil((intent.cutoffMs - Date.now()) / 1000))
				} : { phase: "none" } };
			case "confirm": {
				if (!intent) return { ok: false, error: { code: "not-found", message: "没有进行中的重启排程" } };
				if (intent.quietTimer) return { ok: false, error: { code: "busy", message: "已在静默观察中" } };
				if (intent.phase === "cancelled" || intent.phase === "timedout" || intent.phase === "exiting") {
					return { ok: false, error: { code: "stale", message: `排程已${intent.phase}，请重新 /graceful-restart` } };
				}
				// v0.1.8: 确认即进入观察 — 不再因"当前有活动"拒绝。观察期自带等待逻辑:
				// 有活动 → note 通知 + 不开始计时 (quietSince=null); 全空闲后才起算 10s。
				// 用户点确认 = 意愿表达, 环境是否安静交给观察期检测, 不再让确认报错。
				intent.userOk = true;
				if (intent.pollTimer) { clearInterval(intent.pollTimer); intent.pollTimer = null; } // v0.1.5: 先停 polling
				startQuietObservation();
				return { ok: true, value: { phase: "observing" } };
			}
			case "cancel": {
				if (!intent) return { ok: false, error: { code: "not-found", message: "没有进行中的重启排程" } };
				intent.phase = "cancelled";
				pushBanner({ phase: "cancelled" });
				clearIntent("user cancelled via banner");
				return { ok: true, value: { phase: "cancelled" } };
			}
			default:
				return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-graceful-restart: /graceful-restart RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};

	// ★`#A57`：0.2.2 起 `rpc.handle` 必抛 ⇒ 先走官方 Fetch 面 `/api/graceful-restart/<ep>`，失败回落旧通道；
	//   apply 不得抛崩（旧实现把 throw 冒到 apply ⇒ fiber failed，命令与横幅全失效）。
	const _grEps = ["status", "confirm", "cancel"];
	const _grLegacy = () => { try { ctx.get?.("connection")?.rpc?.handle?.("/graceful-restart", _grHandler); } catch (err) { ctx.logger?.warn?.(`dsh-graceful-restart: 旧通道注册失败（预期，0.2.2）${String(err?.message ?? err)}`); } };
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") { _grLegacy(); return; }
		const face = seams.channelFace(ctx, "/graceful-restart", _grEps, _grHandler);
		if (!face?.ok) { ctx.logger?.warn?.(`dsh-graceful-restart: Fetch 通道注册失败 ${JSON.stringify(face?.results ?? [])}`); _grLegacy(); }
	}).catch(() => _grLegacy());

	// ---------- 件A（`#A222`）：开机自扫（**取代**已失效的 `invalid-scan`，**不并存**）----------
	// ★段U17 B1：新增同源订阅 —— 缓存"最近一条 graceful_restart 的 tool/call seq"（按会话）⇒ 重启卡带上 `anchorSeq`，落回**自己那一行**
	// ★ **(c) 段 · (e) 甲案 ①（仲裁 `#A229` 五 / `#A231` 三）**：改为**工具名集合**判定（当前 = {`graceful_restart`}，
	//   与旧行为**逐字等价**；将来新增重启族工具只需扩集）。⚠️ 如实登记：本插件的**相位 / `invalid` 自愈**发射点
	//   **不是由工具调用触发**（排程器 tick）⇒ 属 `(e)` 的 **(ii) 无行**类，**不由本扩集解决**（处置归 `(a)` 段）。
	// ★`#A193` 件②（2026-09-23 obs3S7；用户已签）：**工具面改「路 A · 按 `exec.callId` 精确取」**（**替换**旧"最近一条猜法"）。
	//   旧法 `lastRestartToolCall` 取"最近一条 tool/call" ⇒ **并发/交错会取错**、缓存缺失时**静默无身份**（＝猜）。
	//   新法：订阅里按 `event.data.callId` 落表（`Map<callId, seq>`），工具 `execute(args, exec)` 用**自己这次的 `exec.callId`** 查 ⇒ 不猜、不串。
	//   依据（甲级明文，`#A193` 〇 外派件）：`ToolExecutionInput.callId`（上游 `packages/core/tools/src/index.ts:236/327`）＋
	//   序号取 `tool/call` 事件 `seq`（`docs/subsystems/session.md:1258`，事件"exactly as recorded"）。
	//   兜底（如实降级、**不猜**）：`ctx.on` 不可用 / 事件未送达 ⇒ 表为空 ⇒ 该卡**如实无行身份** ⇒ 由写入闸门如实拒收 ＋ 面板可见（`requires:["sessionEvents"]` 已申报）。
	const RESTART_ROW_TOOLS = new Set(["graceful_restart"]);
	const restartRowByCallId = new Map(); // callId -> tool/call 事件 seq
	try {
		if (typeof ctx.on === "function") {
			ctx.on("session/event", (session, event) => {
				try {
					if (event?.type === "tool/call" && RESTART_ROW_TOOLS.has(String(event?.data?.name ?? "")) && typeof event.seq === "number") {
						const cid = String(event?.data?.callId ?? "");
						if (cid) restartRowByCallId.set(cid, event.seq);
					}
				} catch { /* 忽略 */ }
			});
		}
	} catch { /* 缺能力 ⇒ 不建表（如实无身份，不猜） */ }
	/** ★开机自扫（**不得复用 `pushBanner()`**：开机时 `intent === null` ⇒ `sid === ""` ⇒ `:235` 静默 return，一张卡都发不出）
	 *  ⇒ 直接构造 payload 调 `bk.emit()`（照旧 `invalid-scan` 的绕开写法）。
	 *  ★位置键：**只带 `ctxKey`（`anchorSeq: null`）** —— 写入闸门（`store.js:90-122`）对"显式但解析不到的 `anchorSeq`"
	 *  是**整卡拒收**（`gate-anchor-mismatch`），而"只带 `ctxKey`"必放行（`poskey-defer`；B7 Q2 实跑 9 例/3 拒）。
	 *  ★划账：**emit `ok===true` 才划**（失败保留 ⇒ 下一轮/下次开机重试；同 `ctxKey` ＋ `replace` ⇒ 重复 emit 幂等无害）。
	 *  ★重试：sink 可能尚未就绪（两插件 `apply` 先后未取证）⇒ 有界重试（`MAX` 轮 × `RETRY_MS`），**清零即停**。 */
	const SELF_SCAN_RETRY_MS = 3000;
	const SELF_SCAN_MAX_ATTEMPTS = 5;
	let selfScanAttempts = 0;
	function selfScanOnce() {
		const entries = readLedger();
		if (entries.length === 0) return 0;
		for (const e of entries) {
			// ★A90：记账里的 anchorSeq 先验证可解析才继承（见 `pickAnchorFromIndex`）；解析不到 ⇒ 退回无锚（原行为）
			const anchor = pickAnchorFromIndex(e, (sid) => ctx.get?.("noticeState")?.readIndex?.(sid));
			void loadBannerKit().then((bk) => (bk && typeof bk.emit === "function" ? bk.emit({
				kind: "restart",
				priority: 3, foldable: e.commandId ? false : true, family: "restart",
				scheduleId: e.scheduleId,
				cardId: _cardIdOfSchedule(e.scheduleId),
				ctxKey: anchor ? ("restart-" + anchor) : ("restart-" + e.scheduleId),
				anchorSeq: anchor,
				anchorLevel: anchor ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD,
				commandId: (typeof e.commandId === "string" && e.commandId) ? e.commandId : null, // 指向不存在的行也放行
				reason: e.reason ?? "",
				phase: "invalid", // 重启前未走到终态 ⇒ 如实标失效（**不再靠"到点消失"掩盖**）
				at: Date.now(),
				remainSec: 0,
				statusNote: "容器已重启，该重启排程已失效",
				sessionId: e.sessionId
			}, { replace: true, source: "dsh-graceful-restart" }) : null))
				.then((r) => {
					if (r && r.ok === true) {
						ledgerSettle(e.scheduleId);
						debug(`自扫: 已标 invalid 并划账 ${e.scheduleId} sid=${String(e.sessionId).slice(0, 12)}`);
					} else {
						debug(`自扫: emit 未成功（保留记账待重试）${e.scheduleId} reason=${r?.reason ?? "banner-kit 不可用"}`);
					}
				})
				.catch((err) => debug(`自扫: emit 异常（保留记账）${e.scheduleId} ${String(err?.message ?? err)}`));
		}
		return entries.length;
	}
	function selfScanTick() {
		try {
			const pending = selfScanOnce();
			selfScanAttempts++;
			if (pending === 0) { debug(`自扫: 记账为空 ⇒ 零 emit（第 ${selfScanAttempts} 轮）`); return; }
			if (selfScanAttempts >= SELF_SCAN_MAX_ATTEMPTS) { debug(`自扫: 到重试上限仍未清空（如实降级，留待下次开机）attempts=${selfScanAttempts}`); return; }
			setTimeout(selfScanTick, SELF_SCAN_RETRY_MS);
		} catch (err) {
			debug(`自扫 error: ${String(err?.message ?? err)}`);
		}
	}
	selfScanTick();

	debug(`apply: graceful-restart loaded (poll=${POLL_INTERVAL_MS}ms quiet=${QUIET_WINDOW_MS}ms timeout=${TIMEOUT_MS}ms)`);
};
