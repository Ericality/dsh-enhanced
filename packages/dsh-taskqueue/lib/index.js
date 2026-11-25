import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename, stat, chown, chmod, mkdir, appendFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/taskqueue/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "taskqueue");
const COMPAT_DIR = process.env.DSH_COMPAT_DIR || joinPath(DSH_HOME, "plugin-data", "host-compat");
const LOG_DIR = joinPath(DSH_HOME, "logs", "taskqueue");

/**
 * @ericality/dsh-taskqueue (本地辅助插件, 非官方包)
 *
 * 客户端任务队列:
 *   - 不着急的需求先丢进队列, 到"低谷时段"(官方价半价窗口)自动派发给 agent 执行;
 *   - 也可以指定时间执行 (--at);
 *   - 也可以指定"容器重启后"执行 (--on restart / when="restart", v0.6.0): 容器每次
 *     重启后的首个 tick 自动派发, 每次重启只尝试一次 (派发失败保持排队,
 *     下次重启再试 —— "已重启未发送又重启, 则再次重启后发送");
 *     重启检测基于 /proc/1/stat 的 PID1 starttime 变化 (容器重启必然新进程),
 *     状态文件持久化 lastBootId 记录上次已处理的重启。
 *   - 派发前可随时查看/修改/取消。
 *
 * 低谷时段判定: 每次从官方定价页解析"高峰时段为北京时间..."定义
 * (当前: 周一至周五 9-12/14-18 为高峰, 其余空闲), 缓存 30 分钟;
 * 解析失败回退内置定义。官方调整时段会自动跟随。
 *
 * 会话绑定 (v0.3.1, 默认): 任务直接绑定 queue_add 时的当前会话 —— 横幅、
 * 任务、执行、回复都在同一个会话, 对应关系清晰。若入队时会话还是"新会话"
 * (blank, 无 turn/start), 立即 followup 一条极简确认消息让 agent 跑一个轻量
 * turn 完成"转正"(真实 turn/start → 侧边栏可见、离开不消失、不会被 GUI 当
 * 新会话复用); 该 turn 只回复一句确认, 不执行任何操作, 成本极低
 * (~0.01~0.05 元, 实测待部署后确认)。
 *
 * 专属会话 (v0.3.0, 保留但默认不启用, config.ownSession=true 开启): 每个任务
 * 排队时新建独立会话派发到自己的窗口; 专属会话创建失败时回退绑定创建它的会话。
 * 派发时优先投递回任务绑定会话(离线时按 /queue target 设置的兜底目标,
 * 再退到任意在线会话)。
 *
 * 即时反馈 (v0.3.0): queue_add 成功后向当前会话注入 notice/banner 横幅
 * (kind="queue", 非 surface 事件 → 不进入模型历史、不消耗 token),
 * 由 dsh-notice-banner client 插件渲染成蓝色"任务队列"弹窗 —— 入队唯一提示。
 *
 * 自动标题 (v0.3.1): 入队时即给会话设置确定性标题"任务 #N · 内容前缀"
 * (source="user" 固定, 不触发 LLM 标题生成、不覆盖已有标题), agent 第一次
 * 回复前标题必然已在; 另注册 session_rename 模型工具, agent 可顺手改得更贴切。
 * 派发末尾提示 (v0.3.2): 派发消息在用户任务内容之后追加一段固定提示, 要求
 * agent 第一次回答时根据当前对话内容用 session_rename 把本会话标题重命名为
 * 贴切的任务标题 —— 侧边栏标题由 agent 按实际任务内容定, 而非固定前缀。
 *
 * 取消 (v0.3.1): 转正会话若只绑定本任务一个 pending 任务, 取消时归档该会话
 * (workspaceRegistry.archiveSession → 从侧边栏移出, 可恢复); 专属会话则 dispose。
 * queue_edit 可修改排队中任务内容。
 *
 * 可编辑队列面板 (v0.4.0): 注册框架通用 RPC 通道 /queue (list/edit/cancel/runnow),
 * 供 dsh-notice-banner 的队列横幅内嵌面板调用 —— 浏览器里直接查看/编辑/取消/
 * 立即派发排队任务, 不走模型回合、零 token; 派发前可改, 下发后只读。
 *
 * 派发: 通过 agent.followup 把任务文本作为 user message(source.kind="user",
 * 与 /goal 插件一致)投递到目标会话, 在对话中显示为一条普通用户消息记录,
 * agent 空闲后执行。
 *
 * 斜杠命令:
 *   /queue add <内容>                   入队, 绑当前会话, 等低谷自动执行
 *   /queue add --at "HH:mm|YYYY-MM-DD HH:mm" <内容>   指定时间执行
 *   /queue add --on restart <内容>     容器重启后自动执行 (v0.6.0; v0.8.5 起同样遵循错峰: 高峰重启则等低谷)
 *   /queue add -r <内容>               同 --on restart (v0.6.1, iOS 单横线简写)
 *   /queue list                         查看队列
 *   /queue cancel <id>                  取消
 *   /queue edit <id> <新内容>           修改内容
 *   /queue run-now <id>                 立即执行
 *   /queue target [会话id]              查看/设置兜底派发目标会话
 *
 * 阶段 2（2026-09-13 · C2 线）· 通知 hub 生产者 + 共享库接入:
 *   - **G2/G3 生产者**: `queue.dispatched`(派发成功) / `queue.cancelled`(人工取消两态) /
 *     `queue.failed`(状态机终态统一出口 setTerminal) —— 经 `ctx.get("notifyHub")`,
 *     **优先 `sendNotification`、回退 `send`**; payload `{taskId,title,status,at,by?}`(title ≤60);
 *     缺服务 ⇒ 静默跳过; 全程 try/catch ⇒ **通知失败绝不影响队列主流程**（详见 docs/plugins/dsh-taskqueue.md）;
 *   - **横幅写入**改走 `@ericality/dsh-banner-kit` 的 `emit()`（payload 与 rev 语义逐字等价 ⇒ 恒 start/rev=0）;
 *   - bundle 化（v0.12.1, 2026-11-25 W6a）：补 dsh.manifestVersion / dsh.bundle.patch / engines / locale / icon；数据根改由 DSH_HOME 派生（自有文件落 <root>/plugin-data/taskqueue/）。
 */
export const name = "dsh-taskqueue";

/* ------------------------------------------------------------------ 错误码出口（T2 接线）
 * 内联自 `scripts/errcode/template-helper.js`（守 §1.1「各插件自带薄 helper ≤20 行」+ D19 零跨包 import）。
 * 出口名 = `reportErr`（§1.1 冻结；`report` 在本仓另是闸门申报契约，两者不得混用）；返回 void、永不 throw。
 * 落 `<root>/logs/taskqueue/error-fallback/<PKG>.log`（D23；本批不写宿主数据根，§2.0-4）= 闸门/reporter 缺席时的兜底写入器（D2）。
 * ⚠️ 与模板的唯一差异（已在报告登记）：内层函数**匿名**（模板里叫 `reportErr`）—— 否则门禁
 *    `scripts/error-surface-lint.mjs` 的出口抽取会把**函数定义行**当成一次出口调用（默认参数不是对象属性
 *    => 误计 `joinKeyMissing`），污染既有读数。`site` 帧位与语义逐字不变。
 */
const PKG = "dsh-taskqueue";
function makeReportErr(root = DSH_HOME) {
	const dir = `${root}/logs/taskqueue/error-fallback`;
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
// 注意: 插件 ctx 只能解析 inject 声明的服务 (fiber.store 机制) —— v0.4.0 起
// 队列可编辑面板需要浏览器端 RPC 通道, 故注入 connection (dsh-client-connection,
// web profile 基础 bundle 必有); 未声明的服务 (如 workspaceRegistry) ctx.get 返回
// undefined, 属既有限制。
export const inject = ["commands", "agents", "tools", "connection"];

// ================= host-compat 能力声明 (阶段 1 契约 §3; RD-1) =================
/** 本插件声明需要的能力 (§3 key; 必须与 package.json `dshCompat.seams` 集合相等 — RD-1) */
const REQUIRES = ["sessionEvents", "sessionAppend", "eventTypeRegistry", "rpcHandle", "commands", "tools", "agents"]; // `#A59`: 通道面优先 channelFace（fetch），rpcHandle 仍在 registerRpc 的 fail-safe 回退路径使用 ⇒ 必须与 package.json `dshCompat.seams` 集合相等（RD-1，批一 b.4）
/** 缺这些能力 ⇒ BLOCKED (§3/D1: 缺失会导致"发错指令/写错数据") */
/** 缺这些能力 ⇒ **路径级** BLOCKED (RD-20; 与 package.json `dshCompat.blocked` 同源, 此处仅为"读 package.json 失败"时的回退) */
const BLOCKED_FALLBACK = ["eventTypeRegistry", "agents"];
/** §3 key → §4 seam 函数名 (§4 v1 冻结面); `commands`/`tools`/`agents` 无 seam (RD-10) ⇒ 走宿主服务存在性 */
const SEAM_OF = { sessionEvents: "readSessionEvents", sessionAppend: "appendNotice", eventTypeRegistry: "ensureEventTypes", rpcHandle: "rpcHandle" };
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
		ctx.logger?.warn?.(`dsh-taskqueue: 适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

const STATE_FILE = process.env.DSH_TASKQUEUE_STATE_FILE || joinPath(PLUGIN_DATA, "taskqueue.json");
// v0.7.0: 错峰出行模式 (offpeak mode) —— 设置里开启后, 高峰期间所有用户消息
// (已有/新会话) 默认入队 (客户端把 session.prompt 转成 /queue RPC add), 平峰/关闭时正常发送。
const MODE_FILE = process.env.DSH_TASKQUEUE_MODE_FILE || joinPath(PLUGIN_DATA, "offpeak-mode.json");
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60000;
// 派发后超过该时长仍未消费(消息丢失)才重派发, 避免和正常执行竞态
const REDISPATCH_GRACE_MS = 2 * 60 * 1000; // ⚠️ 已废弃(E): 旧"丢消息重发"宽限期, 由 claim 观测+熔断取代

// ---------- E 降级 / 熔断 (2026-09-10; 原则: 缺能力静默停用, 禁止重试风暴) ----------
// 单向状态机: pending(排队) → dispatched(已派发) → done | failed; cancelled 为人工终态。
// 自动路径**只处理 pending**; dispatched 若无 claim 只会被观测/熔断为 failed, **永不自动重发**。
// 2026-09-09 事故链: 无终态 + "丢消息重发"校验在 0.1.2 resume 语义下把已执行任务误判为丢失
//   → 每 ~3 分钟无限重发历史任务。本段即针对该链的 fail-safe 改造。
const SCHEMA_VERSION = 3;                 // 状态表版本(含终态字段; 落盘后可用于确认新代码已装载)
const TASK_FAIL_BREAKER = 3;              // 同任务连续 N 次无 claim/派发异常 → failed(停发该任务)
const TICK_FAIL_BREAKER = 5;              // tick 全局连续异常 ≥N 次 → 自动派发路径整体停用
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;  // 派发后多久仍无 claim 且不在 inbox → 记一次"未确认"
const TERMINAL_STATUS = new Set(["done", "failed", "cancelled"]);
// 派发消息末尾的固定提示 (v0.3.2): 除用户输入的任务内容外, 追加一段指令,
// 要求 agent 在第一次回答时根据当前对话内容用 session_rename 工具把本会话
// 标题重命名为贴切的任务标题 —— 派发窗口在侧边栏的标题贴合实际任务。
const DISPATCH_TRAILING_HINT =
	"\n\n[末尾提示] 请在第一次回答时, 根据当前对话内容, 用 session_rename 工具把本会话标题重命名为贴切的任务标题。";

/* ================= 批四（2026-11-24 用户要求）: 派发消息开头/结尾可配置 =================
 * 用户原话：「对于队列派发的任务 之前写死了开头和结尾 这两个也要变成可配置项目」。
 * · 两项模板：`prefix`（开头，必填、非空、须让 {content} 出现在 prefix/suffix 之一）与 `suffix`（结尾，可空=不追加）。
 * · 占位符：`{id}` 任务编号、`{content}` 任务内容（单遍替换；内容里的花括号不会被二次展开）；未知占位符**原样保留**并在 get/set 响应里给 warnings（不静默改写）。
 * · 默认值 = 批前逐字：prefix `[任务队列] 【自动调度任务 #{id}】 {content}` + suffix = `DISPATCH_TRAILING_HINT` ⇒ 默认配置下派发消息与批前**字节一致**（判据见批四 harness）。
 * · 持久化：自有文件 `DISPATCH_SETTINGS_FILE`（0600，原子写；缺失/损坏 ⇒ 回落默认值 + diag，绝不阻断派发）。
 * · 实时读取：`dispatchTask` 每次派发前读一次 ⇒ 改动**下次派发生效**（无需重启）。 */
// 位置 = <DSH_HOME>/plugin-data/taskqueue/taskqueue-settings.json；`DSH_TASKQUEUE_SETTINGS_FILE` 仅测试/隔离场重定向用（生产不设）。
const DISPATCH_SETTINGS_FILE = process.env.DSH_TASKQUEUE_SETTINGS_FILE || joinPath(PLUGIN_DATA, "taskqueue-settings.json");
const DISPATCH_SETTINGS_SCHEMA = 1;
const DISPATCH_PLACEHOLDERS = ["id", "content"];
const DISPATCH_TEMPLATE_LIMITS = { prefix: 500, suffix: 2000, total: 20000 };
const DISPATCH_TEMPLATE_DEFAULTS = Object.freeze({
	prefix: "[任务队列] 【自动调度任务 #{id}】 {content}",
	suffix: DISPATCH_TRAILING_HINT
});
/** 批四纯函数：单遍替换合法占位符（{id}/{content}）；未知/非法占位符原样保留（不吞、不改写）。 */
export function applyDispatchPlaceholders(template, vars) {
	const tpl = typeof template === "string" ? template : String(template ?? "");
	const v = vars && typeof vars === "object" ? vars : {};
	return tpl.replace(/\{(id|content)\}/g, (m, k) => (v[k] === undefined || v[k] === null ? m : String(v[k])));
}
/** 批四纯函数：渲染一条派发消息（prefix + suffix；suffix 空串 ⇒ 只返回 prefix 渲染结果）。 */
export function renderDispatchMessage(task, settings) {
	const s = settings && typeof settings === "object" ? settings : DISPATCH_TEMPLATE_DEFAULTS;
	const vars = { id: task?.id ?? "", content: task?.content ?? "" };
	return applyDispatchPlaceholders(s.prefix ?? DISPATCH_TEMPLATE_DEFAULTS.prefix, vars)
		+ applyDispatchPlaceholders(s.suffix ?? DISPATCH_TEMPLATE_DEFAULTS.suffix, vars);
}
/**
 * 批四纯函数：模板校验。返回 { ok, errors[], warnings[], normalized }。
 * 裁决（写入响应/手册）：① 开头**不允许为空**（空开头会让派发消息失去来源标识；若只想"仅内容"可写 `{content}`）；
 *   ② `{content}` 必须出现在 prefix 或 suffix 至少一处（否则任务内容会丢，agent 拿不到任务）；
 *   ③ 未知占位符**不拒绝**、原样保留并给 warnings（用户要求"原样保留并提示"）；
 *   ④ 长度上限 prefix≤500 / suffix≤2000 / 渲染后总长≤20000（防超长注入）。
 */
export function validateDispatchTemplates(input = {}) {
	const errors = [];
	const warnings = [];
	const prefix = typeof input.prefix === "string" ? input.prefix : String(input.prefix ?? "");
	const suffix = typeof input.suffix === "string" ? input.suffix : String(input.suffix ?? "");
	if (!prefix.trim()) errors.push("开头（prefix）不允许为空（若要仅保留任务内容，用 `{content}`）");
	if (prefix.length > DISPATCH_TEMPLATE_LIMITS.prefix) errors.push(`开头长度 ${prefix.length} 超上限 ${DISPATCH_TEMPLATE_LIMITS.prefix}`);
	if (suffix.length > DISPATCH_TEMPLATE_LIMITS.suffix) errors.push(`结尾长度 ${suffix.length} 超上限 ${DISPATCH_TEMPLATE_LIMITS.suffix}`);
	if (prefix.includes("\0") || suffix.includes("\0")) errors.push("模板不得包含 NUL 字符");
	const combo = prefix + suffix;
	if (!/\{content\}/.test(combo)) errors.push("`{content}` 必须出现在开头或结尾至少一处（否则任务内容会丢失）");
	const unknown = new Set();
	for (const m of combo.matchAll(/\{([A-Za-z0-9_.\-]+)\}/g)) {
		if (!DISPATCH_PLACEHOLDERS.includes(m[1])) unknown.add(m[1]);
	}
	for (const k of unknown) warnings.push(`未知占位符 \{${k}\} 将原样保留（可用：{id} 任务编号、{content} 任务内容）`);
	const sampleTask = { id: 1, content: "{content}" };
	const rendered = applyDispatchPlaceholders(prefix, sampleTask) + applyDispatchPlaceholders(suffix, sampleTask);
	if (rendered.length > DISPATCH_TEMPLATE_LIMITS.total) errors.push(`模板渲染后长度 ${rendered.length} 超上限 ${DISPATCH_TEMPLATE_LIMITS.total}`);
	return { ok: errors.length === 0, errors, warnings, normalized: { prefix, suffix } };
}
/** 批四：配置归一（缺失字段回默认值；schemaVersion 恒写 1）。 */
export function normalizeDispatchSettings(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	return {
		schemaVersion: DISPATCH_SETTINGS_SCHEMA,
		prefix: typeof src.prefix === "string" ? src.prefix : DISPATCH_TEMPLATE_DEFAULTS.prefix,
		suffix: typeof src.suffix === "string" ? src.suffix : DISPATCH_TEMPLATE_DEFAULTS.suffix
	};
}
/** 批四：读取配置（缺失=默认可继续；解析/校验失败 ⇒ 默认 + ok:false，由派发方记 diag 后继续）。 */
export async function readDispatchSettings() {
	try {
		const raw = JSON.parse(await readFile(DISPATCH_SETTINGS_FILE, "utf8"));
		const settings = normalizeDispatchSettings(raw);
		const v = validateDispatchTemplates(settings);
		if (!v.ok) return { ok: false, reason: `invalid:${v.errors.join("；")}`, settings: { ...DISPATCH_TEMPLATE_DEFAULTS }, source: "default", warnings: [] };
		return { ok: true, settings, source: "file", warnings: v.warnings };
	} catch (err) {
		if (err && err.code === "ENOENT") return { ok: true, settings: { ...DISPATCH_TEMPLATE_DEFAULTS }, source: "default", warnings: [] };
		return { ok: false, reason: `${err?.code ?? "parse"}:${String(err?.message ?? err).slice(0, 120)}`, settings: { ...DISPATCH_TEMPLATE_DEFAULTS }, source: "default", warnings: [] };
	}
};

// 内置兜底 (2026-08-23 官方: 周一至周五 9-12/14-18 高峰, 其余空闲)
const FALLBACK_WINDOWS = { weekdaysOnly: true, windows: [[9, 12], [14, 18]] };

// ---------- v0.9.0: 高峰暂停闸门 (peak pause gate) ----------
// 错峰出行开启期间, 高峰时段把**正在跑的回合**停在"当前步骤结束后"(agent/pre-step 瀑布中间件),
// 阻塞到低谷再自动继续 —— 不是 abort(不丢上下文/不加一次 LLM 请求), 等待期零 token。
// 两条冻结的安全规则 (2026-09-14 用户拍板):
//   ① 只在 step>=2 且本步 messages.length===0 时暂停: Inbox.claim() 是**持久化删除**, 用户消息
//      要等 pre-step 决策后才 append ⇒ 在第一步/本步有待处理消息时暂停, 该消息在暂停期间只存在
//      于内存, 任何重启 = 静默丢消息 (暂停可长达数小时, 风险不可接受)。
//   ② fail-open: 闸门内任何异常(读模式/解析窗口/横幅/提问卡失败)一律立即 next() 放行并记 diag。
const PAUSE_MIN_LEAD_MS = 5 * 60 * 1000;      // 距下一个低谷不足该时长 ⇒ 不暂停 (避免刚停就放行/白吃冷缓存)
const PAUSE_POLL_MS = 15000;                  // 共享轮询器周期 (只在有等待者时运行, 全部释放后停表)
const PAUSE_SKIP_DIAG_TTL_MS = 5 * 60 * 1000; // 同会话同原因的 skip 诊断节流 (防刷屏)
const PAUSE_ASK_ID = "offpeak-pause";
// 提问卡选项 (顺序冻结): ① 本回合余下步骤放行 ② 保持暂停至低谷 ③ 持久豁免本会话
const PAUSE_ASK_OPTIONS = ["继续到本回合结束", "保持暂停至低谷", "豁免本会话（持久，不再暂停/不再询问）"];
// v0.10.0: 平峰手动暂停没有"低谷"可等 ⇒ 提问卡选项换第三项 (仍是"唯一放行路径"的白名单)
const PAUSE_ASK_OPTIONS_OFFPEAK = ["继续到本回合结束", "豁免本会话（持久，不再暂停/不再询问）", "保持暂停（等你再操作）"];

// ---------- 容器重启检测 (v0.6.0) ----------
// "重启后发送"时机: 任务在容器重启后**且处于低谷时段**的首个 tick 自动派发 (v0.8.5 遵循错峰:
// 重启发生在高峰 → 任务标记 armed 持久化, 等低谷窗口到达再执行; armed 在尝试派发时消费)。
// 检测依据: 容器重启 = PID1 (dsh-entrypoint) 是全新进程 → /proc/1/stat 的
// starttime (第22字段) 必然变化; host 的 boot_id 不随容器重启变化, 不可用。
// 解析: 先按 ")" 切分 (comm 可能含空格/括号), 再取剩余字段第 20 个 (0-based 19)。
// 返回 null 表示无法读取 (此时跳过重启触发检测, 不误派发)。
function readBootId() {
	try {
		const s = readFileSync("/proc/1/stat", "utf8");
		const starttime = s.split(")")[1]?.trim().split(/\s+/)[19];
		return starttime ? `pid1:${starttime}` : null;
	} catch {
		return null;
	}
}

// ---------- 官方页解析: 高峰窗口定义 ----------
async function fetchPeakWindows() {
	try {
		const resp = await fetch(PRICING_PAGE_URL, {
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(12000)
		});
		if (!resp.ok) return null;
		let text = await resp.text();
		text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
		text = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
		const idx = text.indexOf("高峰时段为北京时间");
		if (idx < 0) return null;
		const seg = text.slice(idx, idx + 120);
		const weekdaysOnly = /周一至周五/.test(seg);
		const windows = [...seg.matchAll(/(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/g)]
			.map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)])
			.filter(([a, b]) => a >= 0 && b > a && b <= 24);
		if (windows.length === 0) return null;
		return { weekdaysOnly, windows };
	} catch {
		return null;
	}
}

/* ---------- 时段判定（v0.11.0: **唯一口径 = @ericality/dsh-cost-tier**） ----------
 * 本文件**不再自算**时段：seed 侧的 5 个自算实现（`isPeakAtMs` / `peakAtMs` / `nextOffpeakAt` /
 * `effectiveNextOffpeak` / `currentEpisode`）**未移植**；下面 5 个导出**全部是薄转发**（同名兼容形参）。
 * ★兼容形参：seed 形 `(windows, now)` 与库形 `(ms, opts)` **都由库内 `adaptArgs()` 归一** ⇒ 本层
 *   **原样透传**（既不做形状猜测，也绝不把裸对象/裸数组塞进数值位 —— `#A247`：那会得 `NaN`
 *   ⇒ 恒判平峰 ⇒ 闸门永不暂停，**不报错不降级**）。
 * ★降级口径：库未 warm／不可加载 ⇒ **保守按 peak**（宁可多停），并由 `costTierHealth()` 如实暴露原因。
 */
/** 当前(北京时区)是否处于高峰时段（薄转发；库不可用 ⇒ 保守 true） */
/** ★批5 `T27`（`#A335`；**逐字并自 seed `v0.8.6` 的 `dropCauseOf` 族**）：丢弃来源分类（纯函数、可单测）。
 *  · `task.dispatchedBootId` 有值且 ≠ 当前 boot ⇒ 消息跨了一次容器重启（重启把 inbox 冲掉）⇒ `"restart"`
 *  · 否则若**本会话**观测到的 boot ≠ 当前 boot ⇒ 同上（第二判据，覆盖"派发时未记到 boot"的边）
 *  · 其余 ⇒ 同一次启动内被丢弃（人工删除/主动移除）⇒ `"removed"` */
export function dropCauseOf(task, bootNow, sessionSeenBoot) {
	if (task?.dispatchedBootId && bootNow && task.dispatchedBootId !== bootNow) return "restart";
	if (sessionSeenBoot && bootNow && sessionSeenBoot !== bootNow) return "restart";
	return "removed";
}

/* ================= 批一 b.1/b.2 纯函数（2026-11-24 用户裁；可离线单测，不含 IO） ================= */
/** b.1 豁免匹配: session id 前缀归一 —— 生产两表存在裸 id（无 session- 前缀），带/不带前缀都要命中 */
export function sessionIdAliases(sessionId) {
	const s = String(sessionId ?? "").trim();
	if (!s) return [];
	const PREFIX = "session-";
	return s.startsWith(PREFIX) ? [s, s.slice(PREFIX.length)] : [s, PREFIX + s];
}
/** b.1 单会话豁免判定（S1=exempt / S2=pauseExempt 共用；前缀归一） */
export function isSessionExemptInMap(map, sessionId) {
	if (!map || typeof map !== "object" || Array.isArray(map)) return false;
	for (const k of sessionIdAliases(sessionId)) if (map[k] === true) return true;
	return false;
}
/**
 * b.1 派发门（用户 2026-11-24 裁）: 目标会话此刻是否被挡住（blocked）。
 *   blocked = peakEff ∧ ( (G1 ∧ ¬S1) ∨ (G2 ∧ ¬S1 ∧ ¬S2) )
 *   · `peakEff` 已含 debug 强制（effectivePeak 折叠；debug=offpeak ⇒ 视为平峰）。
 *   · S1（错峰豁免）同时跳过暂停闸门（与 pauseGate:2006-2007 同口径）。
 *   · blocked 为真 ⇒ 等低谷；为假 ⇒ 立即派发（调用方负责 --at 任务跳过本规则）。
 */
export function isDispatchBlocked({ mode, peakEff, sessionId } = {}) {
	const s1 = isSessionExemptInMap(mode?.exempt, sessionId);
	const s2 = isSessionExemptInMap(mode?.pauseExempt, sessionId);
	const queueGate = mode?.enabled === true && !s1;
	const pauseGate = mode?.pause !== false && !s1 && !s2;
	return peakEff === true && (queueGate || pauseGate);
}
/** b.1 可见诊断用: blocked 的具体成因（仅用于文案/证据，不参与判定） */
export function dispatchBlockedDetail({ mode, peakEff, sessionId } = {}) {
	const s1 = isSessionExemptInMap(mode?.exempt, sessionId);
	const s2 = isSessionExemptInMap(mode?.pauseExempt, sessionId);
	const queueGate = mode?.enabled === true && !s1;
	const pauseGate = mode?.pause !== false && !s1 && !s2;
	return { peakEff: peakEff === true, s1, s2, g1: mode?.enabled === true, g2: mode?.pause !== false, queueGate, pauseGate, blocked: peakEff === true && (queueGate || pauseGate) };
}
/** b.2 暂停/恢复卡稳定身份: 同一会话固定 `pause-<sessionId>`（跨"暂停→恢复→再暂停"同一张卡） */
export function pauseCardKey(sessionId) {
	return `pause-${String(sessionId ?? "")}`;
}
/**
 * 横幅卡身份派生（纯函数）—— 批一 b.2 起支持显式稳定 `cardKey`：
 *   · `cardKey` 非空（暂停/恢复卡族）⇒ ctxKey=cardKey，cardId 只由会话+cardKey 派生 ⇒ **稳定同卡**；
 *   · 无 cardKey + 有 taskId ⇒ 维持既有队列卡语义（uniq ⇒ 逐次唯一；否则按 taskId 稳定）；
 *   · 无 cardKey + 无 taskId ⇒ ctxKey=null，cardId 混入 rev ⇒ 逐次不同（既有语义）。
 */
export function deriveCardIdentity({ sessionId, taskId, uniq, rev, uniqSeq, cardKey } = {}) {
	const sid = String(sessionId ?? "");
	const _rev = Number.isFinite(Number(rev)) ? Number(rev) : 0;
	const explicit = typeof cardKey === "string" && cardKey.trim() ? cardKey.trim() : null;
	const key = explicit !== null ? explicit
		: (taskId == null ? null : (uniq === true ? `queue-${taskId}-${_rev}-${uniqSeq}` : `queue-${taskId}`));
	const cardId = createHash("sha256").update(`dsh-taskqueue|queue|${sid}|${key ?? ("t" + _rev)}`).digest("hex").slice(0, 32);
	return { ctxKey: key, cardId };
}
/* b.2 恢复原因文案映射（用户 2026-11-24 裁: 原因如实；只保留简洁状态消息，不加按钮/管理入口） */
export const PAUSE_RELEASE_REASONS = Object.freeze({
	offpeak: { title: "▶ 已恢复执行 · 低谷到达", detail: "低谷时段已到" },
	"debug-offpeak": { title: "▶ 已恢复执行 · 强制平峰(debug)", detail: "已手动强制平峰(debug)，按平峰放行" },
	"pause-off": { title: "▶ 已恢复执行 · 关闭自动暂停", detail: "自动暂停已被关闭" },
	"pause-off-auto": { title: "▶ 已恢复执行 · 按时段自动关闭暂停", detail: "到达平峰时段，自动暂停按策略关闭" },
	exempt: { title: "▶ 已恢复执行 · 本会话已豁免错峰", detail: "本会话错峰豁免已生效（同时不再暂停）" },
	"pause-exempt": { title: "▶ 已恢复执行 · 本会话暂停豁免", detail: "本会话暂停豁免已生效" },
	abort: { title: "▶ 已恢复执行 · 你点了停止", detail: "回合被停止（abort）" },
	"ask-allow-turn": { title: "▶ 已恢复执行 · 提问卡选继续到本回合结束", detail: "提问卡选择：继续到本回合结束" },
	"ask-exempt": { title: "▶ 已恢复执行 · 提问卡选豁免本会话", detail: "提问卡选择：豁免本会话（持久）" },
	error: { title: "▶ 已恢复执行 · 模式读取异常安全放行", detail: "模式读取异常，按 fail-open 放行" },
	replaced: { title: "▶ 已恢复执行 · 被新暂停替换", detail: "同会话重新进入暂停，旧等待者放行" }
});
/** b.2 原因 → 横幅文案（未知原因如实回显，不静默） */
export function pauseReleaseText(reason) {
	const hit = PAUSE_RELEASE_REASONS[String(reason ?? "")];
	if (hit) return hit;
	return { title: "▶ 已恢复执行", detail: `释放原因: ${String(reason ?? "unknown")}` };
}
export function isBeijingPeak(windows, now = new Date()) {
	const ct = costTierNow();
	if (!ct) return true;
	return ct.isBeijingPeak(windows, now);
}
/** debug 感知的"某时刻是否高峰"（薄转发；debug=peak/offpeak 强制；库不可用 ⇒ 保守 true） */
export function peakAtMs(mode, windows, ms) {
	const ct = costTierNow();
	if (!ct) return true;
	return ct.peakAtMs(mode, windows, ms);
}
/** 某时刻是否高峰（薄转发；seed 形 `(windows, ms)` 与库形 `(ms, opts)` 皆由库 `adaptArgs()` 归一） */
export function isPeakAtMs(a, b) {
	const ct = costTierNow();
	if (!ct) return true;
	return ct.isPeakAtMs(a, b);
}
/**
 * 下一个"低谷时刻"（薄转发；库不可用 ⇒ `now + DEBUG_OFFPEAK_LEAD_MS` 的**保守边界**，
 * 与 `mode.debug==="peak"` 的合成口径同值 —— 闸门据此短暂停在 10 分钟后重判，绝不无限阻塞）。
 * @returns {Date|null} null = 14 天内找不到低谷（窗口定义异常/全时段高峰）
 */
export function nextOffpeakAt(windows, now = new Date()) {
	const ct = costTierNow();
	if (ct) return ct.nextOffpeakAt(windows, now);
	return new Date(new Date(now).getTime() + DEBUG_OFFPEAK_LEAD_MS);
}
/** "下一个低谷时刻"的统一口径（薄转发；`mode.debug==="peak"` ⇒ 合成 now+10min, synthetic=true） */
export function effectiveNextOffpeak(mode, windows, now = new Date()) {
	const ct = costTierNow();
	if (ct) return ct.effectiveNextOffpeak(mode, windows, now);
	return { at: new Date(new Date(now).getTime() + DEBUG_OFFPEAK_LEAD_MS), synthetic: true };
}
/** 时段纪元标识（薄转发；跨边界才变）—— 供"每个时段边界只自动应用一次"记账 */
export function currentEpisode(mode, windows, now = new Date()) {
	const ct = costTierNow();
	if (ct) return ct.currentEpisode(mode, windows, now);
	return `unknown:${new Date(new Date(now).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 13)}`;
}
/** 北京时区 "HH:MM"（横幅/命令文案用；薄转发 ⇒ 库不可用时退化为**纯格式化**本地兜底，不含任何判定） */
export function beijingHm(d) {
	const ct = costTierNow();
	if (ct) return ct.beijingHm(d);
	const ms = d instanceof Date ? d.getTime() : (Number.isFinite(Number(d)) ? Number(d) : NaN);
	return Number.isFinite(ms) ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16) : "--:--";
}
/** 当前所在高峰窗口文案（薄转发；"14:00-18:00"；不在窗口内 → "高峰"） */
export function currentPeakWindowText(windows, now = new Date()) {
	const ct = costTierNow();
	if (ct) return ct.currentPeakWindowText(windows, now);
	return "高峰";
}

function beijingNowString(now = new Date()) {
	return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/** 会话 id 短显示: session-xxxxxxxx */
function shortSession(id) {
	if (!id) return "未绑定";
	const m = /^session-([0-9a-f]{8})/.exec(id);
	return m ? `session-${m[1]}` : id.slice(0, 16);
}

// ---------- 状态持久化 ----------
async function readState() {
	try {
		const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
		if (!s.locks) s.locks = {}; // v0.4.3: 编辑锁字段 (兼容旧状态文件)
		return s;
	} catch {
		return { version: 2, targetSessionId: null, tasks: [], locks: {} };
	}
}

let stateFileMeta = null; // 首次写入时记住 STATE_FILE 原属主/权限 (供原子写保留)
async function writeState(state) {
	try {
		// 原子写 (tmp + rename): 避免写一半崩溃/并发截断产生 0 字节 taskqueue.json
		// —— readState 遇解析失败会回退到空表, 那等于丢整个队列历史 (2026-09-10 加固)。
		const tmp = `${STATE_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
		// 保持原属主/权限: 原子 rename 会以当前进程身份生成新 inode, 否则属主会从
		// dockeruser(1028) 漂成 root (权限漂移正是 09-09 credentials 事故的同类风险)。
		try {
			if (stateFileMeta === null) {
				stateFileMeta = await stat(STATE_FILE)
					.then((st) => ({ uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }))
					.catch(() => false);
			}
			if (stateFileMeta) {
				await chown(tmp, stateFileMeta.uid, stateFileMeta.gid);
				await chmod(tmp, stateFileMeta.mode);
			}
		} catch { /* 非 root/无权限 → 忽略, 不影响写盘 */ }
		await rename(tmp, STATE_FILE);
		return true;
	} catch {
		return false;
	}
}

// ---------- 错峰出行模式状态 (v0.7.0 / v0.8.0 / v0.8.3 / v0.9.0 / v0.10.0) ----------
// 独立状态文件 (与队列任务状态分离, 设置项不随队列滚动):
//   { enabled, exempt, debug, pause, pauseManual, pauseExempt, pauseEpoch }
//   v0.8.0 新增 exempt: 单会话豁免 map —— 豁免会话高峰时段照常发送 (客户端拦截器放行) + 不暂停。
//   v0.8.3 新增 debug: 强制时段 (调试用) —— "peak" 强制当前为高峰、"offpeak" 强制平峰,
//     "auto"(默认) = 按官方页判定。强制只影响"时段口径", 不区分客户端拦截与服务端派发:
//     强制 peak → 消息入队且队列不派发; 强制 offpeak → 消息直发且到期任务立即派发。
//   v0.9.0 新增 pause: 高峰暂停子开关 (默认 true) —— 高峰时把正在跑的回合停在步骤边界;
//     归一化: 非法值(非布尔/缺省) 一律回默认 true。
//   v0.10.0 新增 pauseManual(手动覆盖, null=自动管理) / pauseExempt(S2 本会话暂停豁免) /
//     pauseEpoch(时段纪元记账 ⇒ 每个时段边界只自动应用一次)。**G2 真并列**: `pause` 不再依赖 `enabled`。
//   ⚠️ 写侧是 `patchMode()`（收窄读改写, 只覆盖 patch 里出现的键）—— **调用方不得手列键集重建 mode**
//      （那会吞掉并发写入：本文件曾因此丢 exempt/pauseExempt 键）。
/** 模式对象归一（readMode/readModeStrict 共用；无 IO） */
export function normalizeMode(m) {
	return {
		enabled: m?.enabled === true,
		exempt: (m?.exempt && typeof m.exempt === "object" && !Array.isArray(m.exempt)) ? m.exempt : {},
		debug: normalizeDebug(m?.debug),
		pause: m?.pause !== false,
		// v0.10.0: 手动覆盖 (null = 自动管理) / 本会话暂停豁免 / 时段纪元记账
		pauseManual: (m?.pauseManual === true || m?.pauseManual === false) ? m.pauseManual : null,
		pauseExempt: (m?.pauseExempt && typeof m.pauseExempt === "object" && !Array.isArray(m.pauseExempt)) ? m.pauseExempt : {},
		pauseEpoch: typeof m?.pauseEpoch === "string" ? m.pauseEpoch : null
	};
}
export function defaultMode() { return { enabled: false, exempt: {}, debug: "auto", pause: true, pauseManual: null, pauseExempt: {}, pauseEpoch: null }; }
async function readMode() {
	try {
		return normalizeMode(JSON.parse(await readFile(MODE_FILE, "utf8")));
	} catch {
		// 既有语义: 读不到/解析失败 ⇒ 回默认值（调用方若需要"失败安全"请用 readModeStrict）
		return defaultMode();
	}
}
/**
 * ★批一 b.1 失败安全: **严格**读模式 —— 文件缺失(首启)按默认值可继续；**IO/解析失败返回 ok:false**，
 * 调用方（tick 派发门）遇到 ok:false ⇒ 本轮**一律不派发**（保持 pending + 可见诊断），绝不猜测派发。
 */
export async function readModeStrict() {
	try {
		return { ok: true, mode: normalizeMode(JSON.parse(await readFile(MODE_FILE, "utf8"))) };
	} catch (err) {
		if (err && err.code === "ENOENT") return { ok: true, mode: defaultMode() }; // 首启/未写过 ⇒ 默认值（非故障）
		return { ok: false, reason: `${err?.code ?? "parse"}:${String(err?.message ?? err).slice(0, 120)}`, mode: null };
	}
}

async function writeMode(mode) {
	try {
		// 原子写 (tmp + rename): 与 taskqueue.json 同纪律, 避免写一半留下残缺 JSON
		const tmp = `${MODE_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(mode, null, 2), "utf8");
		await rename(tmp, MODE_FILE);
		return true;
	} catch {
		return false;
	}
}

// ---------- 批四: 派发文案配置写盘（串行 + 收窄 patch + 校验 + 0600 原子写） ----------
let dispatchSettingsChain = Promise.resolve();
function serializedDispatchSettings(fn) {
	const p = dispatchSettingsChain.then(fn, fn);
	dispatchSettingsChain = p.then(() => {}, () => {});
	return p;
}
/** 串行读改写：只覆盖 patch 里出现的字段（前缀/结尾），值不变也写（配置面允许显式保存默认值）。 */
async function writeDispatchSettings(patch) {
	return serializedDispatchSettings(async () => {
		const cur = await readDispatchSettings();
		const base = cur.ok ? cur.settings : { ...DISPATCH_TEMPLATE_DEFAULTS };
		const nextRaw = { ...base };
		if (patch && Object.prototype.hasOwnProperty.call(patch, "prefix")) nextRaw.prefix = patch.prefix;
		if (patch && Object.prototype.hasOwnProperty.call(patch, "suffix")) nextRaw.suffix = patch.suffix;
		const next = normalizeDispatchSettings(nextRaw);
		const v = validateDispatchTemplates(next);
		if (!v.ok) return { ok: false, error: { code: "bad-request", message: v.errors.join("；") } };
		try {
			const tmp = `${DISPATCH_SETTINGS_FILE}.tmp`;
			await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
			try { await chmod(tmp, 0o600); } catch { /* 非 root/无权限 ⇒ 忽略（mode 已在 writeFile 生效） */ }
			await rename(tmp, DISPATCH_SETTINGS_FILE);
			return { ok: true, settings: next, warnings: v.warnings };
		} catch (err) {
			return { ok: false, error: { code: "internal", message: `配置写盘失败: ${String(err?.message ?? err)}` } };
		}
	});
}

// ---------- 强制时段 (debug, v0.8.3) ----------
// 目的: 官方低谷/高峰窗口只在工作日固定时段出现, 平峰(周末/夜间)无法实测错峰功能。
// 用法: /queue debug peak|offpeak|auto (或 RPC mode.debug)。
const DEBUG_VALUES = ["auto", "peak", "offpeak"];
function normalizeDebug(v) {
	return DEBUG_VALUES.includes(v) ? v : "auto";
}
/** 当前是否高峰: 强制值优先于官方页判定 (唯一口径, 客户端与服务端共用同一返回值) */
function effectivePeak(mode, windows, now = new Date()) {
	if (mode?.debug === "peak") return true;
	if (mode?.debug === "offpeak") return false;
	return isBeijingPeak(windows, now);
}
/** 时段来源文案: 强制时明确标注 debug, 便于"忘记关"时一眼可见 */
function peakSourceText(mode, windowSource) {
	if (mode?.debug === "peak") return `强制高峰(debug)`;
	if (mode?.debug === "offpeak") return `强制平峰(debug)`;
	return windowSource;
}
/**
 * mode.get / mode.set / mode.pause / mode.exempt / mode.debug 的统一返回体。
 * ⚠️ `paused` / `pauseInstalled` 由调用方**显式传入** (坑 19: 等待者表在 apply() 闭包内,
 *    模块级 helper 不得引用闭包变量)。
 */
function modeValue(mode, windows, windowSource, paused, pauseInstalled) {
	return {
		enabled: mode.enabled,
		peak: effectivePeak(mode, windows),
		windowSource,
		peakSource: peakSourceText(mode, windowSource),
		debug: mode.debug,
		exempt: mode.exempt,
		pause: mode.pause !== false,
		pauseManual: mode.pauseManual ?? null,
		pauseExempt: (mode.pauseExempt && typeof mode.pauseExempt === "object") ? mode.pauseExempt : {},
		pauseEpoch: mode.pauseEpoch ?? null,
		paused: (paused && typeof paused === "object") ? paused : { count: 0, sessions: [] },
		// v0.9.0 可见性: 暂停闸门自检结果 (false = 本版本宿主不兼容, 暂停路径已停用)
		pauseInstalled: pauseInstalled !== false,
		// v0.11.0 可见性: 时段判定库 (cost-tier) 的接入/降级态 —— 未加载 ⇒ 时段按"保守高峰"并如实暴露
		costTier: costTierHealth()
	};
}

// ---------- 客户端诊断上报 (v0.8.3) ----------
// 背景: 错峰拦截器跑在浏览器里, 之前"拦截器没装上"完全静默 —— 只能靠用户现象猜。
// 客户端 apply/药丸渲染/拦截命中都上报一行, 服务端落盘 + 保留最近若干条供 mode.get 回读,
// 这样没有浏览器控制台也能远程取证 (<DSH_HOME>/logs/taskqueue/offpeak-debug.log)。
const DIAG_LOG = joinPath(LOG_DIR, "offpeak-debug.log");
const diagRecent = [];
/* ★批一 b.6（服务端诊断节流）：高频诊断在 60s 窗口内只落首条，窗口结束时补一条 `diag.throttled`
 *   汇总（of=原事件, count=窗口内被抑制条数）⇒ 日志行数量级下降，且「首条 + 计数」都可回读；
 *   `diagRecent`（mode.get/diag.get 的 20 条环形缓冲）同样只收首条与汇总 ⇒ 回读不再被刷屏淹没。
 *   语义事件（低频、诊断价值高）不节流。 */
const DIAG_THROTTLE_MS = 60 * 1000;
// 注: `pause.skip` 已有 diagSkip 自己的「同会话同原因 5min」节流（见 diagSkip），不再套通用节流（防双重节流吞掉不同会话的取证）。
const DIAG_NEVER_THROTTLE = new Set([
	"pause.enter", "pause.release", "pause.auto", "pause.ask", "pause.skip", "pause.install-failed", "pause.policy-timeout",
	"mode.exempt", "mode.debug", "pause.switch-on", "pause.switch-off", "dispatch.no-target",
	"dispatch.gate-unavailable", "dispatch.cancel-recovered", "task.cancel-complete", "diag.get"
]);
const diagThrottleBuckets = new Map(); // event -> { startAt, suppressed }
async function writeDiagLine(record) {
	try {
		diagRecent.push(record);
		if (diagRecent.length > 20) diagRecent.splice(0, diagRecent.length - 20);
		const line = JSON.stringify(record);
		await mkdir(LOG_DIR, { recursive: true });
		await appendFile(DIAG_LOG, line + "\n", "utf8");
	} catch { /* 落盘失败不影响功能 (仅诊断) */ }
}
async function appendDiag(entry) {
	const ev = typeof entry?.event === "string" ? entry.event : "unknown";
	const at = entry?.at ?? new Date().toISOString();
	if (!DIAG_NEVER_THROTTLE.has(ev)) {
		const now = Date.now();
		// 节流键 = 事件 + 原因码 + 会话：**语义不同的事件不得互相合并**（否则"不同 reason/不同会话"的
		// 诊断会被压成一条，取证失真）；只有真正重复的同一种诊断才限流。
		const bucketKey = `${ev}|${String(entry?.reason ?? "")}|${String(entry?.sessionId ?? "")}`;
		const bucket = diagThrottleBuckets.get(bucketKey);
		if (bucket) {
			bucket.suppressed += 1;
			if (now - bucket.startAt < DIAG_THROTTLE_MS) return; // 窗口内：只计数，不落盘/不进环形缓冲
			// 窗口结束：先落一条汇总（保留"有多少条被抑制"的可读证据），本条按新窗口首条落盘
			diagThrottleBuckets.set(bucketKey, { startAt: now, suppressed: 0 });
			await writeDiagLine({ at: new Date(now).toISOString(), event: "diag.throttled", of: ev, reason: entry?.reason ?? null, sessionId: entry?.sessionId ?? null, count: bucket.suppressed, windowMs: now - bucket.startAt });
		} else {
			diagThrottleBuckets.set(bucketKey, { startAt: now, suppressed: 0 });
		}
	}
	await writeDiagLine({ at, ...entry });
}

const STATUS_TEXT = {
	pending: "排队中",
	dispatched: "已派发",
	done: "已完成",
	failed: "已失败",
	cancelled: "已取消"
};

// ---------- 编辑锁 (v0.4.3) ----------
// 客户端面板编辑任务时经 /queue RPC editstart 锁定, 防止 tick 自动派发把正在编辑的
// 任务发出去 (用户编辑中被打断, 内容未保存就跑了); 同会话(id 更大)的任务也暂停派发,
// 编辑期间不被派发消息打断。editend (保存/取消/组件卸载) 释放。
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 分钟无操作自动释放 (防用户关页面导致永久锁)

/** 清理过期编辑锁 (只改内存, 由调用方决定是否落盘) */
function cleanupStaleLocks(state) {
	if (!state.locks) return;
	const now = Date.now();
	for (const tid of Object.keys(state.locks)) {
		const lock = state.locks[tid];
		if (!lock || now - Date.parse(lock.since) > LOCK_TTL_MS) delete state.locks[tid];
	}
}

/** 任务是否被编辑锁阻止派发: 自身被锁, 或同会话有锁且本任务在锁任务之后 (按 id) */
function isTaskLocked(state, task) {
	if (!state.locks || Object.keys(state.locks).length === 0) return false;
	if (state.locks[task.id]) return true;
	for (const [tid, lock] of Object.entries(state.locks)) {
		if (lock && lock.sessionId && lock.sessionId === task.sessionId && task.id > parseInt(tid, 10)) return true;
	}
	return false;
}

/** 列表一行显示用: 压缩连续空白为单空格并去首尾 */
function oneLine(s) {
	return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 解析 --at 参数: "HH:mm"(下一次) 或 "YYYY-MM-DD HH:mm" */
function parseAt(value, now = new Date()) {
	if (!value) return null;
	const m1 = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (m1) {
		const h = parseInt(m1[1], 10), min = parseInt(m1[2], 10);
		if (h > 23 || min > 59) return null;
		const t = new Date(now.getTime() + 8 * 3600 * 1000);
		t.setUTCHours(h, min, 0, 0);
		const target = new Date(t.getTime() - 8 * 3600 * 1000);
		if (target <= now) target.setUTCDate(target.getUTCDate() + 1); // 今天已过 -> 明天
		return target.toISOString();
	}
	const m2 = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value);
	if (m2) {
		const iso = `${m2[1]}T${String(m2[2]).padStart(2, "0")}:${m2[3]}:00+08:00`;
		const t = new Date(iso);
		if (Number.isNaN(t.getTime()) || t <= now) return null;
		return t.toISOString();
	}
	return null;
}

// ---- 动态加载 banner-kit（契约 §10.1 禁静态 import 共享包; RD-28 横幅样板收敛）----
// 队列横幅（notice/banner 注入）**一律经 banner-kit.emit**，本插件不再自己调 §4.4 appendNotice；
// 取不到 ⇒ 横幅路径停用（§10.2 禁直连 session.append 兜底；派发/取消/命令/工具全部照常）。
/** 该插件的 warn 出口（apply 时注入 ctx.logger）。 */
let compatLogger = null;
const LOG = (msg) => { try { compatLogger?.warn?.(`dsh-taskqueue: ${msg}`); } catch { /* ignore */ } };
/** 由 apply 注入的"降级上报"钩子 (§4.10 report; reason 透传) —— 未 apply 时为 null（可选链兜底）。 */
let reportDegraded = null;
let bannerKit;             // undefined = 尚未尝试
let bannerKitDead = false; // true = 已判定不可用（不重试）
export async function loadBannerKit() {
	if (bannerKit !== undefined) return bannerKit;
	if (bannerKitDead) return null;
	try {
		bannerKit = await import("@ericality/dsh-banner-kit");
		// ★段2 `B6`（2026-09-29，"不得静默" · WRAP-B6）：emit **拒收**（形状非法）⇒ **必须面板可见 ＋ 点名** ——
		//   经中间件 `wrapBannerKit` 包一层（emit 非 ok 且属拒收 ⇒ 落 store ① `rejected` ⇒ 面板 `rejectedByReason`）。
		//   中间件不可用/旧版（无该面）⇒ **原样使用模块**（不伪造、不回落直连宿主）。
		try {
			const _smB6 = await import("@ericality/dsh-host-compat/seams");
			if (typeof _smB6.wrapBannerKit === "function") bannerKit = _smB6.wrapBannerKit(bannerKit, "dsh-taskqueue");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch (err) {
		bannerKitDead = true; bannerKit = null;
		LOG(`banner-kit 不可用 → 横幅注入停用: ${String(err?.message ?? err)}`);
		reportDegraded?.("banner-kit");   // 有 host-compat 的插件必须上报（缺则停用，不回落旧直连路径）
	}
	return bannerKit;
}

// ---- 动态加载 dsh-cost-tier（契约 §10.1 禁静态 import 共享包；时段判定**唯一口径**收敛）----
// v0.11.0（批2b 段2）：高峰/低谷判定（含节假日表）／下一个低谷／时段纪元／窗口文案**一律**由
// `@ericality/dsh-cost-tier` 提供 —— 本插件**不再自算**（seed 侧 5 个自算 helper 已删）。
// ★访问模式（父线定，逐条照做）：
//   · **动态 import + 缓存**（幂等、**永不 throw**）；
//   · 失败 ⇒ 记**降级原因**（`costTierHealth()` 如实暴露，不静默）；
//   · **同步访问器**（`costTierNow()`）：未 warm／不可加载 ⇒ **保守按 peak**（宁可多停，绝不静默
//     "恒判平峰 ⇒ 闸门永不暂停"）；`#A247` 陷阱 = 裸对象塞进数值签名 ⇒ `NaN` ⇒ 恒判平峰、不报错不降级。
//   · 同值常量 `DEBUG_OFFPEAK_LEAD_MS` 改为**从库 re-export**（warm 后按库真值覆盖）。
let costTier;              // undefined = 尚未尝试
let costTierDead = false;  // true = 已判定不可用（不重试）
let costTierReason = "";   // 不可加载原因（如实暴露给面板/命令；空 = 未失败）
/** 从库 re-export（值同 = 10 min）；warm 成功后按**库真值**覆盖（ESM live binding）。 */
export let DEBUG_OFFPEAK_LEAD_MS = 10 * 60 * 1000;
/** 幂等加载（永不 throw）；失败 ⇒ 返回 null 并记降级原因 + 上报 */
export async function loadCostTier() {
	if (costTier !== undefined) return costTier;
	if (costTierDead) return null;
	try {
		costTier = await import("@ericality/dsh-cost-tier");
		if (Number.isFinite(costTier?.DEBUG_OFFPEAK_LEAD_MS)) DEBUG_OFFPEAK_LEAD_MS = costTier.DEBUG_OFFPEAK_LEAD_MS;
	} catch (err) {
		costTierDead = true; costTier = null;
		costTierReason = String(err?.message ?? err);
		LOG(`cost-tier 不可用 → 时段判定降级为「保守高峰」: ${costTierReason}`);
		reportDegraded?.("cost-tier", `时段判定(cost-tier) 不可用 → 降级为「保守高峰」并如实暴露 (reason:"${costTierReason}")`);
	}
	return costTier;
}
/** 同步访问器：未 warm／不可加载 ⇒ null（调用方**必须**按"保守高峰"处理，不得当平峰） */
function costTierNow() { return (costTier && typeof costTier.isPeakAtMs === "function") ? costTier : null; }
/** 时段判定降级态（面板/命令可读；`reason` 非空 = loadCostTier 失败原因） */
export function costTierHealth() {
	const ct = costTierNow();
	if (!ct) return { loaded: false, reason: costTierReason || null };
	// ★批4（2026-09-26）**纯追加键**（不改 `loaded`/`reason` 语义）：让设置卡能**常显**「时段口径正常 ·
	//   表覆盖到哪一年」，受限时**点名**受限项（用户令：常显 ＋ 点名受限项 ＋ "当前保守按高峰处理"）。
	try {
		const ti = typeof ct.tierInfo === "function" ? ct.tierInfo(Date.now()) : null;
		return {
			loaded: true,
			reason: null,
			years: ct.BUILTIN_HOLIDAYS ? Object.keys(ct.BUILTIN_HOLIDAYS) : [],
			yearCovered: ti ? ti.yearCovered !== false : null,
			degraded: ti ? ti.degraded === true : false,
			reasons: ti?.reasons ?? []
		};
	} catch { return { loaded: true, reason: null }; }
}
// ★模块级 warm（**不是静态 import** ⇒ 合契约 §10.1）：下面 5 个导出是**同步薄转发**，调用点既有
//   `apply()` 内的闸门/RPC，也有**模块级纯函数调用点**（判据脚本、将来的其它消费方）。若不 warm，
//   会出现"库未就绪"窗口 ⇒ 窗口内 `currentEpisode()` 只能给降级值 ⇒ **时段纪元不稳定**（同一时段内
//   变化 ⇒ "每边界只应用一次"的记账失效 ⇒ 反复覆盖用户手动开关）。`loadCostTier()` 幂等且**永不 throw**，
//   缺包只是立即返回 null（模块加载不失败）⇒ 顶层 await 是安全的。
await loadCostTier();

export async function apply(ctx, config) {
	// ================= host-compat 适配闸门 (阶段 1; 契约 §2/§3/§4/§10) =================
	// 加载强制: 动态 import + try/catch (§2.3)。§10.1 禁静态 import host-compat/共享包 —
	// 缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环。§10.2 禁 legacy 直连兜底双路径 ⇒ 缺能力即停用 + 上报。
	const PLUGIN_ID = name;
	compatLogger = ctx.logger; // 模块级 LOG 出口（loadBannerKit 的降级告警用）
	const { version: PLUGIN_VERSION, blocked: pkgBlocked } = ownMeta();
	// 路径级阻断清单 (RD-20): 运行时取自自身 package.json 的 dshCompat.blocked; 读失败 ⇒ 内置回退 + 告警
	const BLOCKING = (Array.isArray(pkgBlocked) ? pkgBlocked : BLOCKED_FALLBACK).filter((k) => REQUIRES.includes(k));
	if (!Array.isArray(pkgBlocked)) ctx.logger?.warn?.(`${PLUGIN_ID}: dshCompat.blocked 读取失败 → 回退内置清单 [${BLOCKING.join(", ")}]`);
	let seams = null;
	let compat = null;
	try { seams = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { ctx.logger?.warn?.(`dsh-taskqueue: host-compat/seams 不可用 → 会话日志读取/横幅注入/RPC 面板停用 (${String(err?.message ?? err)})`); }
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
	// 能力探测: 优先 host-compat `probe()` (§4.9); 未提供 ⇒ 本地按 §3 语义兜底 (只查本插件声明过的 key)。
	// ⚠️ agents 的口径与下方既有 fail-safe probeCapabilities() (get/list/resume) 保持一致。
	const localMissing = () => REQUIRES.filter((k) => {
		switch (k) {
		case "commands": return typeof ctx.commands?.register !== "function";
		case "tools": return typeof ctx.tools?.register !== "function";
		case "agents": return !ctx.agents
			|| typeof ctx.agents.get !== "function"
			|| typeof ctx.agents.list !== "function"
			|| typeof ctx.agents.resume !== "function";
		default: return typeof seamFn(k) !== "function";
		}
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
		} catch (err) { ctx.logger?.warn?.(`dsh-taskqueue: probe() 失败 → 退回本地探测 (${String(err?.message ?? err)})`); }
	}
	// RD-20 ④: probe 可用 ⇒ 逐字采信其 state/blocked; 不可用 ⇒ 本地按同一清单兜底 (口径一致)
	const capBlocked = capBlockedProbe ?? capMissing.filter((k) => BLOCKING.includes(k));
	const capState = capStateProbe ?? (capBlocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK"));
	const capNote = capState === "OK" ? "" : "缺 agents ⇒ 自动派发/恢复/撤回停用(既有 fail-safe) · 缺 eventTypeRegistry ⇒ 队列横幅停用(写未注册类型会让会话无法加载) · 缺 sessionEvents ⇒ blank 判定退化为 seq===0 快路径+标题去重退化 · 缺 sessionAppend ⇒ 横幅不注入(派发照常) · 缺 rpcHandle ⇒ /queue 面板停用(命令/工具仍可) · 缺 commands/tools ⇒ 对应入口停用";
	// ★批一 b.4（2026-11-24）: note 如实写**已知降级**（批二未完成前，客户端 prompt 层捕获失败 = patch.no-prompt，
	//   属客户端半边的已知缺陷；服务端批一已修，不得因"服务端绿"而报 OK 掩盖它 —— ENV R6 禁止"报 OK 而功能坏"）。
	const KNOWN_DEGRADED_NOTE = "已知降级: 客户端 prompt 层捕获修复与胶囊语义重梳待批二（服务端批一已改）";
	const finalNote = ((capBlocked.length ? `${capNote}${capNote ? " ｜ " : ""}路径级阻断(仅停该能力对应路径): ${capBlocked.join(", ")}` : capNote) + (readySubState !== "absent" ? `${capNote ? " ｜ " : ""}就绪订阅: ${readySubState}${readySubReason ? `(${readySubReason})` : ""}` : "")) + (capBlocked.length || capNote || readySubState !== "absent" ? " ｜ " : "") + KNOWN_DEGRADED_NOTE; // 阻断清单＋就绪订阅＋已知降级并入面板文案
	if (capState !== "OK") ctx.logger?.warn?.(`dsh-taskqueue: 适配状态 ${capState} — 缺能力 [${capMissing.join(", ")}] 阻断 [${capBlocked.join(", ")}]; ${finalNote}`);
	const capEntry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state: capState, missing: capMissing, blocked: capBlocked, note: finalNote };
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	if (reporter) { try { reporter.report(capEntry); } catch { writeShard(ctx, capEntry); } } else writeShard(ctx, capEntry);
	// RD-28: banner-kit 动态加载失败时的降级上报 (§4.10 report) —— state 只降不升 (OK ⇒ DEGRADED)；
	// `reason` 是 additive 元信息 (host-compat 只持久化 §5 分片 8 键) ⇒ 同时写进 note 以便面板可读。
	// v0.11.0: 第二参 `noteText`（可选）—— 非横幅类降级（cost-tier／高峰暂停闸门）必须能写**自己的**文案，
	// 不得借用"横幅注入停用"这句错话（准入红线②：如实降级，不允许"报 OK 而功能坏"）。
	reportDegraded = (reason, noteText) => {
		const entry = {
			...capEntry,
			state: capState === "OK" ? "DEGRADED" : capState,
			reason,
			note: `${finalNote}${finalNote ? " ｜ " : ""}${noteText ?? `${reason} 不可用 → 横幅注入停用 (reason:"${reason}")`}`
		};
		try { if (reporter) reporter.report(entry); else writeShard(ctx, entry); }
		catch { try { writeShard(ctx, entry); } catch { /* 上报失败不影响主流程 */ } }
	};

	const capOk = (key) => !capMissing.includes(key) && !capBlocked.includes(key); // 阻断 key 同样按"该路径停用"处理 (RD-20)
	const seamWarned = new Set();
	/** 能力缺失/调用失败的统一告警 (每组合只报一次; §2.3 禁止静默) */
	function seamFail(what, reason) {
		const k = `${what}|${reason}`;
		if (seamWarned.has(k)) return;
		seamWarned.add(k);
		ctx.logger?.warn?.(`dsh-taskqueue: ${what} 已停用 — ${reason} (契约 §10.2: 不降级为直连宿主)`);
	}
	/** §4.6 rpcHandle: 注册 /queue 面板通道 (缺能力 ⇒ 面板不可用, 命令/工具仍可管理队列) */
	const rpcRegistered = new Set(); // ★ 批 4 件②：**幂等打标**（成功过即跳过，防宿主 `duplicate` 抛错）
	function registerRpc(channel, handler, options) {
		if (rpcRegistered.has(channel)) return { ok: true, already: true };
		// ★`#A59`：0.2.2 先走官方 Fetch 面（`/api/queue/<ep>`）
		try {
			if (typeof seams?.channelFace === "function") {
				// ★批一 b.3（2026-11-24）: EPS 必须与 `queueRpcHandler` 的 case 集合逐项相等 ——
				//   旧表把**命令面**端点（target/pause/help/debug/forcepeak）错列进来、却漏了面板实际调用的
				//   runnow/editstart/editend（旧表写 "run-now" 而 handler 是 "runnow" ⇒ 面板「立即派发」与
				//   编辑锁在 0.2.2 Fetch 面下 404/未知端点）。现表 = RPC handler 全集（含 run-now 兼容别名）。
				const EPS = ["list", "edit", "cancel", "runnow", "run-now", "editstart", "editend", "mode.get", "mode.set", "mode.pause", "mode.exempt", "mode.pauseExempt", "mode.debug", "diag", "diag.get", "config.get", "config.set", "add"];
				const face = seams.channelFace(ctx, channel, EPS, handler);
				if (face?.ok) { rpcRegistered.add(channel); return { ok: true, via: "fetch", routes: face.routes }; }
			}
		} catch (err) { seamFail(`RPC ${channel}`, `channelFace 异常: ${String(err?.message ?? err)}`); }
		if (!capOk("rpcHandle")) { seamFail(`RPC ${channel}`, "缺能力 rpcHandle"); return { ok: false, reason: "rpcHandle" }; }
		try {
			// options 必传 (宿主 register 直接读 options.authority, 缺参会 TypeError) — 作为 seam 第 4 参转发
			const r = seamFn("rpcHandle")(ctx, channel, handler, options);
			if (!r?.ok) { seamFail(`RPC ${channel}`, `rpcHandle 失败: ${r?.reason ?? "unknown"}`); return r ?? { ok: false, reason: "rpcHandle" }; }
			rpcRegistered.add(channel);
			return r;
		} catch (err) {
			seamFail(`RPC ${channel}`, `rpcHandle 异常: ${String(err?.message ?? err)}`);
			return { ok: false, reason: "rpcHandle" };
		}
	}

	// v0.3.1: 专属会话机制保留但默认不启用 —— 默认任务绑当前会话(入队时
	// blank 会话走极简确认 turn 转正)。想回到"每任务新建专属会话"时在
	// cordis.patch.yml 的 taskqueue config 里设 ownSession: true。
	const cfg = { ownSession: false, ...(config ?? {}) };
	let windows = FALLBACK_WINDOWS;
	let windowSource = "内置兜底";
	let lastWindowFetch = 0;

	async function refreshWindows() {
		const fresh = await fetchPeakWindows();
		if (fresh) {
			windows = fresh;
			windowSource = `官方页(${beijingNowString().slice(5)})`;
		}
		lastWindowFetch = Date.now();
	}

	async function resolveWindows() {
		if (Date.now() - lastWindowFetch > WINDOW_CACHE_TTL_MS) await refreshWindows();
		return windows;
	}

	// ---------- 无 token 横幅反馈 (v0.3.0) ----------
	// 自定义会话事件 notice/banner: 非 surface 事件, 不进入模型历史、不消耗 token,
	// 由 dsh-notice-banner client 插件渲染横幅 (kind="queue" = 蓝色"任务队列"徽章)。
	// v1 起经 seam §4.5 注册 (幂等; 持久化读取路径要求注册, 见 DSH 速查坑 A)。
	// 注册失败/能力缺失 ⇒ **停写该类型** (未注册类型会让会话日志无法加载), 不禁用派发本身。
	let noticeTypesOk = false;
	if (!capOk("eventTypeRegistry") || !seamFn("eventTypeRegistry")) seamFail("事件类型注册(notice/banner)", "缺能力 eventTypeRegistry");
	else {
		const r = seamFn("eventTypeRegistry")(["notice/banner"]);
		noticeTypesOk = r?.ok === true;
		if (!noticeTypesOk) seamFail("事件类型注册(notice/banner)", `ensureEventTypes 失败: ${r?.reason ?? "unknown"}`);
	}
	/**
	 * 向会话注入队列横幅。⚠️ 必须在 session/event 观察者派发之外执行 (坑 B:
	 * 观察者内同步 append 会被静默吞掉), 因此一律 setTimeout 延迟。
	 * RD-28 (§10.2): **横幅写入一律经 banner-kit.emit**（本插件不再直调 §4.4 appendNotice）；
	 * 取不到 banner-kit / 类型未注册 ⇒ **停用该路径**, 只记日志（不回落直连 session.append 双路径）。
	 * `{kind:"queue", time, ...payload}` 与改前逐字一致 ⇒ 默认分支 mode="start" / rev = 0（语义不变）。
	 */
	/** 段Q（#A117 §3 口径表 v3；触发面只有发射侧知道 ⇒ 由发射侧把「触发面」编码进**条目身份**）：
	 *  · **命令面**（`/queue list|cancel|edit|run-now`）／**入队**／**系统熔断**／**任何面的「立即派发」**
	 *    ⇒ 传 `uniq: true` ⇒ **唯一 `ctxKey`**（`queue-<taskId>-u<n>`）⇒ **各出一张独立卡**；
	 *  · **工具面 编辑/取消** ⇒ 不传 `uniq` ⇒ **稳定 `ctxKey`**（`queue-<taskId>`）⇒ **原地更新**。
	 *  ⚠️ `uniq` 是**发射侧内部标记、不是条目字段** ⇒ **出网前必须剥掉**（`validateEntry` 只认冻结键集）。 */
	let uniqSeq = 0;
	// ★段U17 B1：缓存"最近一条 queue_add 的 tool/call seq"（按会话）⇒ 入队/熔断卡带上 `anchorSeq`，落回**自己那一行**
	// ★ **(c) 段 · (e) 甲案 ①（仲裁 `#A229` 五 / `#A231` 三）**：把"只认 `queue_add`"**扩到该类全部工具名** ——
	//   旧行为 = 取消/编辑/派发/列表族拿到的是"**上一次入队**的 seq"或 `null` ⇒ **结构性错落**
	//   （台账 `#55`「队列卡落错行仍未解」/ `#A198` 残差）。扩集后它们带上**自己那一次调用**的 seq。
	//   工具名全集 = 本插件注册的 6 个（`:1400` `queue` / `:1576` `queue_add` / `:1609` `queue_list` /
	//   `:1649` `queue_cancel` / `:1674` `queue_edit` / `:1702` `queue_runnow`）。
	let lastQueueToolCall = { sid: "", seq: null, turn: null };
	const QUEUE_ROW_TOOLS = new Set(["queue", "queue_add", "queue_list", "queue_cancel", "queue_edit", "queue_runnow"]);
	const anchorSeqFor = (session) => (lastQueueToolCall.seq != null && lastQueueToolCall.sid === String(session?.id ?? "") ? lastQueueToolCall.seq : null);
	// ★批12 段B（2026-10-17）：**逐族合法身份键** —— 工具面卡的 `turn` 取「与 `anchorSeq` **同一次** `tool/call`」的 `data.turn`
	//   （缓存键含 seq 比对 ⇒ **不会**把命令面/无自身行的卡错锚到上一次工具调用的回合）；取不到 ⇒ 如实 `null`（不猜）。
	const turnForSeq = (session, seq) => (typeof seq === "number" && lastQueueToolCall.seq === seq && lastQueueToolCall.sid === String(session?.id ?? "") && Number.isInteger(lastQueueToolCall.turn) ? lastQueueToolCall.turn : null);
	async function injectNotice(session, payload) {
		if (!bannerReady) { seamFail("队列横幅注入", "banner-kit 不可用或 notice/banner 未注册"); return { ok: false, reason: "banner-kit" }; }
		try {
			const bk = await loadBannerKit();
			if (typeof bk?.emit !== "function") { seamFail("队列横幅注入", "banner-kit 不可用"); return { ok: false, reason: "banner-kit" }; }
			// P1-2: 去 session（`sessionId` 随 payload 走；双轨期旧日志由中间件按 sessionId 反查补写）
			// obs#3 段P（仲裁 #A108 二）：**补唯一 `rev`**（同 `dsh-balance` 段N 成法）——
			//   旧实现不传 `rev` ⇒ 恒 `(queue,0,start)` ⇒ merge 键 `(kind,rev,mode)` 恒同 ⇒ **同 kind 互相覆盖**。
			// obs#3 段Q（#A117 §3）：身份改由 `ctxKey` 承载；客户端 `storeAlignAll` 按 `ctxKey` 分组。
			// ★批一 b.2: `cardKey` = 调用方给的**显式稳定身份**（暂停/恢复卡族用 `pauseCardKey(sid)`）；
			//   与 `uniq` 一样属**发射侧内部标记**，出网前剥离（banner-kit 冻结键集不认这两个键）。
			const { uniq: _uniq, cardKey: _cardKey, ...clean } = payload ?? {};
			const tid = clean.taskId;
			const _rev = Date.now();
			const { ctxKey: ctxKeyVal, cardId: _cardId } = deriveCardIdentity({
				sessionId: session?.id, taskId: tid, uniq: _uniq === true, rev: _rev,
				uniqSeq: _uniq === true ? ++uniqSeq : uniqSeq, cardKey: _cardKey
			});
			// ★段2 `B5`（2026-09-29；用户令「所有发射者都应该有」）：**补 `cardId`**（批7 曾在 `lib/index.js` 加过、被用户令撤除；
			//   本批按新口径**重新补回**，与 `B1` 渲染层别名回落配套）——
			//   身份 = **与 `ctxKey` 同源**：同任务（非 `uniq`）⇒ 同 `ctxKey` ⇒ **同卡、后卡覆盖、恒 1 张**（＝今日渲染语义）；
			//   `uniq` 或 `taskId` 缺失 ⇒ `ctxKey` 本身逐次不同 ⇒ 身份也逐次不同（各 1 张）⇒ **不改现有卡的合并/新增语义**。
			//   派生式含 `sid`：store 分片本就按会话隔离 ⇒ 与旧键（`source|kind|ident|rev`，不含 `sid`）**逐值等价**。
			// ★批12 段B（2026-10-17）：`turn` 由字面量 `null` 改为**可合法取到的归属回合**（仅工具面：与 `anchorSeq` 同一次 tool/call）；
			//   取不到 ⇒ 如实 `null`（命令面/熔断/派发等无自身行者**不猜**，按兜底走可见面）。
			const _anchorFor = (typeof clean.anchorSeq === "number" ? clean.anchorSeq : null);
			const _turnFor = (typeof clean.turn === "number" ? clean.turn : turnForSeq(session, _anchorFor));
			// ★A95（用户裁定）：队列卡是**会话级状态**（该会话排着待执行任务）⇒ 声明 anchorLevel=SESSION，
			//   不再依赖"族名豁免"；未声明或其它非行级卡仍按 row 严格判（无行 ⇒ 异常）。
			const r = await bk.emit({ ...clean, sessionId: String(session?.id ?? ""), turn: _turnFor, anchorSeq: _anchorFor, rev: _rev, ctxKey: ctxKeyVal, cardId: _cardId, anchorLevel: bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD }, { source: "dsh-taskqueue" });
			if (!r?.ok) seamFail("队列横幅注入", `banner-kit.emit 失败: ${r?.reason ?? "unknown"}`);
			return r ?? { ok: false, reason: "banner-kit" };
		} catch (err) {
			seamFail("队列横幅注入", `banner-kit.emit 异常: ${String(err?.message ?? err)}`);
			return { ok: false, reason: "banner-kit" };
		}
	}
	// ---- 横幅写入: 先加载 banner-kit + 幂等注册事件类型（RD-28; 默认分支语义与改前逐字等价）----
	let bannerReady = false;
	{
		const bkm = await loadBannerKit();
		if (typeof bkm?.emit !== "function") seamFail("队列横幅注入", "banner-kit 不可用 (契约 §10.2: 不回落直连兜底)");
		else {
			let reg = null;
			try { reg = await bkm.ensureRegistered(); } // 幂等; 失败 ⇒ 不注入（写未注册类型 = 会话无法加载）
			catch (err) { seamFail("队列横幅注入", `banner-kit.ensureRegistered 异常: ${String(err?.message ?? err)}`); }
			if (reg && reg.ok !== true) seamFail("队列横幅注入", `banner-kit.ensureRegistered 失败: ${reg?.reason ?? "unknown"}`);
			bannerReady = reg?.ok === true && noticeTypesOk;
		}
	}
	// ---- 时段判定: 先动态加载 cost-tier（契约 §10.1；失败 ⇒ 记原因 + 上报 + 时段按保守高峰）----
	// 必须在任何时段判定之前 warm（`isBeijingPeak`/`nextOffpeakAt`/`currentEpisode` 是**同步薄转发**：
	// 未 warm ⇒ 保守按 peak，并把不可加载原因如实暴露给面板/命令，不静默）。
	await loadCostTier();
	/** 段Q §3(a) **文本降级层**（#A118 §3）：**原文逐字保留**，仅在末尾**追加恰好一行**卡片状态。
	 *  位置 = 该命令/工具**自身位置**（宿主把返回 `text` 渲染在命令节点 / 工具结果节点，见 `dsh-client-ui-chat:5411`）；
	 *  **不改模型可执行语义**（原文一字不动、只多一行）。`taskId == null` ⇒ 用「任务队列卡」。 */
	function withCardLine(text, taskId, action) {
		const base = typeof text === "string" ? text : String(text ?? "");
		const hh = new Date().toTimeString().slice(0, 8);
		return `${base}\n（${taskId == null ? "任务队列卡" : `任务 #${taskId} ${action}`} · ${hh}）`;
	}
	function appendQueueBanner(session, payload) {
		if (!session) return;
		setTimeout(() => {
			try {
				void injectNotice(session, { kind: "queue", at: Date.now(), priority: 3, foldable: false, family: "queue", ...payload });
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 横幅注入失败: ${String(err?.message ?? err)}`);
			}
		}, 100);
	}

	// ---------- G2/G3 队列事件生产者 (RD-35) ----------
	// 经 `ctx.get("notifyHub")`（G6/RD-31: 插件间唯一入口; RD-10 白名单 = 插件间服务, 非宿主面）：
	//   **优先 `sendNotification`、回退 `send`**（旧版 dsh-notify 只 provide `send` 别名同函数）。
	//   dsh-notify 未装配 / 未 provide / 抛错 ⇒ **静默跳过**（队列主流程与它无耦合）。
	// 纪律: 通知是 fire-and-forget, **全程 try/catch** —— 通知失败绝不改变队列状态机、绝不阻塞派发。
	// payload 字段 (RD-35 冻结 + RD-50 返工增补): `{ taskId, title, body, status, at, by? }`（不发明其它字段）。
	// ⚠️ **`body` 必须有内容**（2026-09-13 生产实测返工）: dsh-notify 的 `sendNotification` 只从
	//   `pages`/`body` 取推送正文; 只给 `title` 会被判"内容为空"(reason:"no-content") ⇒ **通知被静默丢弃**
	//   （离线桩只断言"被调用 + 字段齐全"查不出这类跨组件形状错配; 只有真机日志/返回值能抓到）。
	const NOTIFY_TITLE_MAX = 60;      // 标题截断上限 (RD-35: 任务标题 ≤60 字符)
	const NOTIFY_BODY_MAX = 200;      // 正文上限 (返工要求: body 非空且 ≤200 字符)
	const NOTIFY_TYPES = { dispatched: "queue.dispatched", cancelled: "queue.cancelled", failed: "queue.failed" };
	/** 任务标题 = 任务内容单行化后截断 ≤60 字符 (任务表无独立 title 字段, 以内容为准)。 */
	function taskNotifyTitle(task) {
		return oneLine(task?.content ?? "").slice(0, NOTIFY_TITLE_MAX);
	}
	/** 人读正文 (中文语气照 notify 既有生产者): `已派发：#7 内容…（操作者 auto）`; 非空且 ≤200 字符。 */
	const NOTIFY_BODY_LEAD = { dispatched: "已派发", cancelled: "已取消", failed: "失败" };
	function taskNotifyBody(kind, task, title, by) {
		const lead = NOTIFY_BODY_LEAD[kind] ?? String(kind);
		const who = by === undefined ? "" : `（操作者 ${by}）`;
		const text = `${lead}：#${task.id} ${title}${who}`;
		return text.length > NOTIFY_BODY_MAX ? `${text.slice(0, NOTIFY_BODY_MAX - 1)}…` : text;
	}
	function notifyQueue(kind, task, extra = {}) {
		try {
			if (!task || task.id === undefined || task.id === null) return; // 无 id 不发 (payload 契约要求 taskId)
			// ⚠️ 服务名必须写成**字面量调用形态** `ctx.get("notifyHub")` —— 不要用 `ctx.get?.("notifyHub")`
			// 之类的花式写法: 契约 §2.4 白名单对撞脚本按字面量扫（RD-10），可选链会让它扫不到 ⇒ 审计面出现假盲区。
			const hub = typeof ctx.get === "function" ? ctx.get("notifyHub") : null;
			const fn = typeof hub?.sendNotification === "function" ? hub.sendNotification
				: typeof hub?.send === "function" ? hub.send : null;
			if (!fn) return; // 服务未提供 ⇒ 静默跳过 (不告警: dsh-notify 未装属正常组合)
			const title = taskNotifyTitle(task);
			const by = extra.by === undefined ? undefined : String(extra.by);
			const payload = {
				taskId: task.id,
				title,
				// RD-50 返工: 必须有 ↓ —— 没有它 dsh-notify 会判"内容为空"并零请求丢弃（真机实测抓到的缺陷）
				body: taskNotifyBody(kind, task, title, by),
				status: String(task.status ?? ""),
				at: extra.at instanceof Date ? extra.at.toISOString() : String(extra.at ?? new Date().toISOString()),
				by
			};
			if (payload.by === undefined) delete payload.by; // `by?` 可缺省 ⇒ 不写空值
			void Promise.resolve(fn.call(hub, NOTIFY_TYPES[kind], payload)).then((r) => {
				// ★T2 接线：旧写法只挂 `.catch` ⇒ **resolve 值从不被检查** ⇒ dsh-notify 的
				//   `{ok:true,sent:0,failed:0,reason:"no-content|no-devices|no-route"}`（零投递）被静默丢弃（ENV §一.6②）。
				//   只**增**一条上报：不改返回值、不改抛、不吞异常；reject 分支逐字保留（`then(f,onR)` ≡ `catch(onR)`）。
				if (r && r.ok === true && r.sent === 0 && r.failed === 0) {
					reportErr({ code: "notify-dropped", detail: "session=" + shortSession(task.sessionId) + " cap=notifyHub task=" + String(task.id) + " reason=" + String(r.reason ?? "-"), severity: "user" });
				}
			}, (err) => {
				ctx.logger?.warn?.(`dsh-taskqueue: 通知 ${NOTIFY_TYPES[kind]} 发送失败 (不影响队列): ${String(err?.message ?? err)}`);
			});
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 通知 ${NOTIFY_TYPES[kind] ?? kind} 构造失败 (忽略): ${String(err?.message ?? err)}`);
		}
	}

	// ---------- 专属会话 (v0.3.0) ----------
	// 每个任务排队时建立独立会话, 派发到自己的窗口, 避免多个任务挤进同一会话。
	// 与会话创建/恢复的宿主路径 (ensureSession) 保持一致: 默认模型 + preset 挂载,
	// 否则恢复/新建的 agent 缺工具集、{{model}} 无值, 无法正常执行 (v0.2.5 踩坑)。
	// ⚠️ 建会话后必须 attach 到 cwd 对应 workspace, 否则 GUI 侧边栏落在"未分组"。
	const taskSessionHandles = new Map(); // sessionId -> AgentHandle (取消任务时销毁)
	async function createTaskSession(cwd) {
		const sessionId = `session-${randomUUID()}`;
		const defaultModel = ctx.get?.("agentDefaultModel")?.currentSelection?.() ?? {};
		const presets = ctx.get?.("agentPresets");
		let agentPreset;
		if (presets) {
			try {
				agentPreset = (await presets.resolve()).id; // 默认 preset id (standard-fetch)
			} catch { /* 无 preset 名单时跳过, 与宿主一致 */ }
		}
		const handle = await ctx.agents.create({
			sessionId,
			agentOptions: {
				...(defaultModel.provider ? { provider: defaultModel.provider } : {}),
				...(defaultModel.model ? { model: defaultModel.model } : {})
			},
			meta: {
				cwd,
				...(agentPreset === void 0 ? {} : { agentPreset })
			},
			setup: async (agentCtx) => {
				if (presets) await presets.mount(agentCtx);
			}
		});
		// attach 到 cwd 对应 workspace (与宿主 sessions.create 一致): 否则会话落在未分组
		try {
			const workspaces = ctx.get?.("workspaceRegistry");
			const workspace = workspaces && cwd ? await workspaces.resolveByPath(cwd) : void 0;
			if (workspace) await workspace.attachSession(sessionId);
			else ctx.logger?.warn?.(`dsh-taskqueue: 专属会话 ${shortSession(sessionId)} 未找到 cwd=${cwd} 对应 workspace, 将显示在未分组`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 专属会话 ${shortSession(sessionId)} attach workspace 失败: ${String(err?.message ?? err)}`);
		}
		taskSessionHandles.set(sessionId, handle);
		return { sessionId, agent: handle.agent };
	}
	/** 取消任务时销毁其专属会话 (释放 agent), 失败仅告警不阻塞 */
	async function disposeTaskSession(sessionId) {
		const handle = taskSessionHandles.get(sessionId);
		if (!handle) return;
		taskSessionHandles.delete(sessionId);
		try {
			await handle.dispose();
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 销毁专属会话 ${shortSession(sessionId)} 失败: ${String(err?.message ?? err)}`);
		}
	}

	// ---------- 会话日志读取 (v0.8.4, 0.1.2 适配) ----------
	// ⚠️ 0.1.2-rc.1 起宿主 `Session` **没有 `events` 属性**了 (dsh-session: 只有
	// header/surface/seq/eventAt/snapshotEvents()/ownEvents())。历史上有 5 处读
	// `session.events`, 于是全部静默失效 —— 其中**最严重的是 blank 判定**:
	// `Array.isArray(session?.events)` 恒 false ⇒ blank 恒 false ⇒ 「新会话转正」
	// (v0.3.1 的防串台机制) **从未触发**, GUI 会继续把 blank 会话当"新会话"复用,
	// 多个任务落进同一个新会话 (2026-09-12 用户实测反馈)。
	// 统一走本 helper: 旧版取 session.events (RD-9: 阶段 1 保留该分支, 待阶段 2 收口),
	// 0.1.2 起改经 host-compat seam §4.1 readSessionEvents (snapshotEvents() 优先 / ownEvents() 兜底,
	// 语义与改造前的 helper 完全一致); 能力缺失 ⇒ 返回 null = "日志不可读" (调用方 fail-safe),
	// **不直连兜底** (§10.2)。
	function readSessionEvents(session) {
		if (!session) return null;
		if (Array.isArray(session.events)) return session.events; // < 0.1.2
		const fn = capOk("sessionEvents") ? seamFn("sessionEvents") : null;
		if (!fn) { seamFail("会话日志读取", "缺能力 sessionEvents"); return null; }
		const r = fn(session);
		return Array.isArray(r) ? r : null;
	}
	/**
	 * 是否仍是 GUI 里的"新会话"(blank)。
	 * 与宿主同口径 (dsh-api-session-controller 服务端半: `blank = metadata?.blank ?? session.seq === 0`,
	 * 增量规则 `state.blank && event.type !== "turn/start"`): 日志里没有 turn/start 即 blank。
	 * 读不到日志 → 返回 false (fail-safe: 宁可不发转正确认 turn, 也不误发/抛错)。
	 */
	function isBlankSession(session) {
		if (!session) return false;
		if (typeof session.seq === "number" && session.seq === 0) return true; // 空日志必为 blank
		const events = readSessionEvents(session);
		if (events === null) return false;
		return !events.some((e) => e && e.type === "turn/start");
	}
	/** 日志里是否已有某类型事件 (读不到日志 → null = 未知, 由调用方决定默认) */
	function hasSessionEvent(session, type) {
		const events = readSessionEvents(session);
		if (events === null) return null;
		return events.some((e) => e && e.type === type);
	}

	// ---------- 入队 (v0.3.1 统一入口: 命令 add / 工具 queue_add 共用) ----------
	// 默认模式: 任务绑当前会话; 会话若为 blank(无 turn/start, 即 GUI 里的"新会话"),
	// 立即 followup 一条极简确认消息让 agent 跑一个轻量 turn 完成"转正" ——
	// 产生真实 turn/start → 侧边栏可见、离开不消失、不会被 connectWorkspace 当
	// 新会话复用。确认 turn 只回一句"已创建, 等待派发", 不执行任何操作。
	// config.ownSession=true 时保留 v0.3.0 行为: 排队即新建专属会话。
	async function enqueueTask({ state, id, content, at, when, agent: agentIn, sessionId: explicitSessionId }) {
		const explicit = explicitSessionId ?? null;
		// v0.8.4: 只给 sessionId 的调用方 (高峰期客户端拦截 RPC add) 内部反查 live agent ——
		// 否则拿不到 session ⇒ blank 判定(转正) 与队列横幅都会静默丢失
		const agent = agentIn ?? (explicit ? ctx.agents?.get?.(explicit) ?? null : null);
		const session = agent?.session;
		// v0.7.0: RPC add (客户端错峰拦截) 无 agent 但带明确 sessionId → 优先用显式会话绑定
		const sessionId = explicit ?? agent?.id ?? session?.id ?? null;
		const task = {
			id, content, createdAt: new Date().toISOString(), status: "pending",
			...(sessionId ? { sessionId } : {}),
			...(at ? { scheduledAt: at } : {}),
			// v0.6.0: when="restart" → 容器重启后派发 (trigger 字段, 不入 scheduledAt)
			...(when === "restart" ? { trigger: "restart" } : {})
		};
		const whenText = at
			? `于 ${beijingNowString(new Date(at))}`
			: when === "restart"
				? "容器重启后"
				: "等低谷时段自动执行";
		let engaged = false; // v0.8.4: 是否因本任务触发 blank 会话转正 (确认 turn)
		if (cfg.ownSession) {
			// 专属会话模式 (默认关闭): 排队时新建独立会话
			const cwd = session?.header?.cwd;
			try {
				const created = await createTaskSession(cwd ?? process.cwd());
				task.sessionId = created.sessionId;
				task.ownSession = true;
				task.taskSession = true; // 真·专属会话: 取消时 dispose
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 专属会话创建失败, 回退绑定当前会话: ${String(err?.message ?? err)}`);
			}
		} else {
			// 默认模式: blank 会话 → 极简确认 turn 转正 (防串台: GUI 会复用 blank 会话当"新会话")
			// v0.8.4 (2026-09-12): 0.1.2 起 `session.events` 已不存在, 旧写法
			// `Array.isArray(session?.events)` 恒 false ⇒ blank 恒 false ⇒ **转正从未触发**;
			// 改用 isBlankSession() (与宿主同口径: 日志无 turn/start 即 blank)。
			// 同一 blank 会话在"第一个确认 turn 真正开始前"连发多条消息时, 不要重复投确认 turn
			// (turn/start 出现前 session 仍是 blank; 已有 pending 的 confirmMessageId 即视为转正中)
			const engaging = state.tasks.some((t) => t.sessionId === sessionId && t.status === "pending" && t.confirmMessageId);
			const blank = !engaging && isBlankSession(session);
			if (blank && !agent) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 命中 blank 会话 ${shortSession(sessionId)} 但该会话无 live agent, 无法转正 (会话仍会被 GUI 当"新会话"复用)`);
				void appendDiag({ event: "enqueue.blank-no-agent", taskId: id, sessionId: shortSession(sessionId) });
			}
			if (blank && agent) {
				try {
					const confirm = createUserMessage({
						content: [{ type: "text", text: `[任务队列] 任务 #${id} 已入队, 等待派发执行。请仅回复"任务 #${id} 已创建, 等待派发", 不要执行任何其他操作、不要读取任何文件。` }],
						source: { kind: "user" }
					});
					task.ownSession = true; // 标记: 会话因本任务转正(取消时可归档移出列表)
					task.confirmMessageId = confirm.id;
					agent.followup(confirm);
					engaged = true;
					void appendDiag({ event: "enqueue.engaged", taskId: id, sessionId: shortSession(sessionId) });
				} catch (err) {
					ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 转正确认消息投递失败: ${String(err?.message ?? err)}`);
					void appendDiag({ event: "enqueue.engage-failed", taskId: id, error: String(err?.message ?? err) });
				}
			}
		}
		// 自动标题 (v0.3.1): 入队即设, agent 第一次回复前标题必然已在; 不覆盖已有标题
		try {
			// v0.8.4: 0.1.2 起 session.events 不存在 → readSessionEvents(); 读不到(null)按"无标题"处理(旧行为)
			const hasTitle = hasSessionEvent(session, "session/title") === true;
			if (session && !hasTitle) {
				session.append("session/title", {
					title: `任务 #${id} · ${oneLine(content).slice(0, 20)}`,
					messageSeqs: [],
					source: { kind: "user" }
				});
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 设置任务 #${id} 会话标题失败: ${String(err?.message ?? err)}`);
		}
		state.tasks.push(task);
		// 入队唯一提示: notice/banner 横幅 (非 surface 事件, 零 token)
		// v0.4.1: 内容完整显示不截断 (原 slice(0,40) 截断已去掉, 横幅可折叠长内容无妨)
		// v0.4.3: openPanel=true → 横幅出现即展开手风琴面板, 新任务可直接编辑 (未派发前)
		// v0.8.5: 横幅内容行只给短预览 (与 v0.4.1 之前一致), 避免把整段长消息糊在会话里;
		// 全文仍在队列面板 (横幅内可展开) 中查看/编辑 —— 面板读的是任务状态文件, 不受此处影响。
		appendQueueBanner(session, {
			openPanel: true,
			taskId: id,
			title: `任务 #${id} 已入队`,
			uniq: true,
			anchorSeq: anchorSeqFor(session),
			lines: [`执行: ${whenText}`, `内容: ${oneLine(content).slice(0, 40)}${oneLine(content).length > 40 ? "…" : ""}`]
		});
		return { id, when: whenText, engaged };
	}

	/** v0.5.0: 已派发且派发消息仍在目标会话收件箱排队 (未被 claim 执行) —— "排队发送中",
	 *  可取消窗口。派发 = followup 进收件箱 + 立即标 dispatched; 若目标会话正在对话
	 *  (回合未结束), 消息躺在 inbox.nextTurn 排队等当前回合结束才被取走执行。
	 *  A7 (2026-09-14 阶段6): 宿主 1.5 的 `Inbox` **公开接口收窄** (只剩
	 *  nextTurn/nextStep/clear/append/prepend/replace/remove/splice, `locate` 是实现细节)
	 *  ⇒ 改用与同文件 `isMessageInInbox()` 相同的自查写法 (1.2 的 locate 就是把
	 *  ["next-turn","next-step"] 两张表都 findIndex, 语义等价); 读不到按"不在 inbox"处理。 */
	function isQueuedSending(t) {
		if (t.status !== "dispatched" || !t.messageId) return false;
		try {
			const agent = ctx.agents.get(t.sessionId);
			if (!agent?.inbox) return false;
			if (agent.inbox.nextTurn?.some((m) => m.id === t.messageId)) return true;
			if (agent.inbox.nextStep?.some((m) => m.id === t.messageId)) return true;
			return false;
		} catch { return false; }
	}

	/**
	 * 取消任务 (命令/工具/RPC 共用):
	 *   - pending: 排队中 → 直接取消 (转正会话归档/专属会话 dispose, 原逻辑)
	 *   - dispatched + 消息仍在收件箱 (v0.5.0): 已派发但目标会话正忙, 消息在
	 *     inbox 排队未执行 —— 视为"排队中"可取消: 标记 cancelled + Inbox.remove
	 *     撤回消息 (与 GUI 会话消息队列编辑同一持久化原语, 纯删除, 会话不会执行)。
	 *   - dispatched + 消息已被 claim 进会话历史: 已开始执行, 不可取消 (删除=改写历史)。
	 */
	async function cancelTask(state, id) {
		const t = state.tasks.find((x) => x.id === id);
		if (!t) return { kind: "error", text: `未找到任务 #${id}` };
		if (t.status === "cancelled") return { kind: "error", text: `任务 #${id} 已取消` };
		// ★批一 b.5（两阶段取消）: **第一步先写持久化取消标记**（caller 的 mutateState 在本函数返回后统一落盘）。
		//   之后所有派发路径（派发前查标记 / followup 后复核 / 重启自补偿）都能看到它；
		//   取消语义不再依赖宿主 inbox 事务的原子性。取消**未生效**（已被 claim）时在第 2 步清掉标记。
		if (t.cancelRequested !== true) { t.cancelRequested = true; t.cancelRequestedAt = new Date().toISOString(); }
		if (t.status === "dispatched") {
			try {
				const agent = ctx.agents.get(t.sessionId);
				if (t.messageId && agent?.inbox && agent.inbox.remove(t.messageId)) {
					t.status = "cancelled";
					t.cancelledAt = new Date().toISOString();
					// G2 (RD-35): 人工取消「排队发送中」任务 ⇒ 发一次 queue.cancelled (by=user)
					notifyQueue("cancelled", t, { at: t.cancelledAt, by: "user" });
					return { kind: "success", text: `任务 #${id} 已取消 (派发消息仍在排队, 已撤回, 会话不会执行)` };
				}
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 撤回任务 #${id} 派发消息失败: ${String(err?.message ?? err)}`);
			}
			// 第二阶段失败（消息已不在收件箱/已被 claim）⇒ 取消未生效，清掉标记并保持既有 dispatched 语义（#276）
			delete t.cancelRequested;
			delete t.cancelRequestedAt;
			return { kind: "error", text: `任务 #${id} 已派发并开始执行 (或绑定会话离线), 无法取消` };
		}
		if (t.status === "pending") {
			t.status = "cancelled";
			t.cancelledAt = new Date().toISOString();
			t.cancelledBy = "user";
			// G2 (RD-35): 人工取消「排队中」任务 ⇒ 发一次 queue.cancelled (by=user)
			notifyQueue("cancelled", t, { at: t.cancelledAt, by: "user" });
			let removed = false;
			if (t.taskSession && t.sessionId) {
				await disposeTaskSession(t.sessionId);
				removed = true;
			} else if (t.ownSession && t.sessionId) {
				const only = state.tasks.filter((x) => x.status === "pending" && x.sessionId === t.sessionId).length === 1;
				if (only) {
					try {
						await ctx.get?.("workspaceRegistry")?.archiveSession(t.sessionId);
						removed = true;
					} catch (err) {
						ctx.logger?.warn?.(`dsh-taskqueue: 归档任务 #${id} 会话失败: ${String(err?.message ?? err)}`);
					}
				}
			}
			return { kind: "success", text: `任务 #${id} 已取消${removed ? " (任务会话已移出列表)" : ""}` };
		}
		return { kind: "error", text: `任务 #${id} 状态异常, 无法取消` };
	}

	// ---------- 派发 ----------
	// 派发是"读状态->派发->写状态"的非原子流程, 并发(定时 tick + 手动 run-now)
	// 时可能基于旧状态互相覆盖, 导致任务被重复派发。用 promise 链把所有派发串行化。
	let dispatchChain = Promise.resolve();
	function serialized(fn) {
		const run = dispatchChain.then(fn, fn);
		dispatchChain = run.catch(() => {});
		return run;
	}
	/** 串行化的"读状态->改->写盘", 所有会写状态的操作都走这里, 避免并发覆盖 */
	function mutateState(fn) {
		return serialized(async () => {
			const state = await readState();
			const result = await fn(state);
			await writeState(state);
			return result;
		});
	}

	// ================= E: 降级 / 熔断 / 终态 (2026-09-10) =================
	// 原则(写进代码与文档): 缺能力 → 静默停用该入口(fail-safe off); 禁止重试风暴;
	//   禁止把失败当成功; 禁止历史任务自动重放; 自动路径只处理 fresh pending。
	let autoDisabled = false;            // 本进程内自动派发是否停用 (重启自动重测能力, 不持久化)
	let autoDisabledReason = null;
	let tickFailStreak = 0;              // tick 全局连续异常计数 (某轮零异常即清零)
	const dispatchedMsgIds = new Map();  // messageId -> taskId (claim 事件快速过滤, 避免无关消息写盘)
	const claimedMsgIds = new Set();     // 已被 claim 成会话内 user/message 的 messageId (0.1.2 事件观察者维护)
	// ★批5 `T27`（`#A335`；并自 seed `v0.8.6` 的 `dropCauseOf` 族）：`sessionId -> 最近观察到的容器启动标识`。
	//   判定：派发时记下的 `task.dispatchedBootId` ≠ 当前 boot ⇒ 消息跨了一次容器重启 ⇒ `dropCause="restart"`；
	//   否则＝同一次启动内被丢弃 ⇒ `dropCause="removed"`（人工删队／主动移除）。
	const sessionBootIds = new Map();
	const titledSessions = new Set();    // 本插件已设过标题的会话 (替代不可用的 session.events 判定)

	/** 能力门闩: boot 时静态探测宿主能力, 缺失即停用自动路径 (宁停勿发) */
	function probeCapabilities() {
		const missing = [];
		const A = ctx.agents;
		if (!A) missing.push("agents 服务");
		else {
			if (typeof A.get !== "function") missing.push("agents.get");
			if (typeof A.list !== "function") missing.push("agents.list");
			if (typeof A.resume !== "function") missing.push("agents.resume");
		}
		if (typeof ctx.on !== "function") missing.push("ctx.on(事件订阅)");
		if (typeof ctx.effect !== "function") missing.push("ctx.effect");
		return missing.length ? { ok: false, reason: `缺少能力: ${missing.join(", ")}` } : { ok: true };
	}

	/** 停用自动派发 (只记日志, 不重试; 人工 run-now --force 不受影响) */
	function disableAuto(reason) {
		if (autoDisabled) return;
		autoDisabled = true;
		autoDisabledReason = reason;
		ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 自动派发已整体停用 — ${reason} (历史任务不再自动处理; 需执行请人工 /queue run-now <id> --force)`);
	}

	const _caps = probeCapabilities();
	if (!_caps.ok) disableAuto(_caps.reason);

	/** 终态置位 (单向: 已到终态不再改; 顺手清掉 claim 索引) */
	function setTerminal(task, status, extra = {}) {
		if (TERMINAL_STATUS.has(task.status)) return false;
		task.status = status;
		task[status === "done" ? "doneAt" : status === "failed" ? "failedAt" : "cancelledAt"] = new Date().toISOString();
		Object.assign(task, extra);
		if (task.messageId) dispatchedMsgIds.delete(task.messageId);
		// G3 (RD-33/RD-35): **置终态的统一出口** —— 状态机把任务置 `failed` 即发一次 queue.failed。
		// 现有 3 条真实触发路径都在此汇合: ① 派发消息被 inbox 丢弃(onDiscarded)
		// ② 派发异常连续 3 次熔断 ③ 派发后连续 3 轮无 claim 且不在 inbox(未确认熔断)。
		// 挂统一出口而非逐点重复: 新增任何置 failed 的路径自动覆盖 (by=auto: 均由状态机自动判定)。
		if (status === "failed") notifyQueue("failed", task, { at: task.failedAt, by: "auto" });
		// ★批5 `T27`：终态改 `cancelled` 后**不静默丢通知能力** —— 同一出口按同一口径发 `queue.cancelled`
		//   （类型/路由皆已存在，无新类型；`by:"auto"` 与人工取消的 `by:"user"` 区分。人工取消路径**不经本出口** ⇒ 无双发）
		else if (status === "cancelled") notifyQueue("cancelled", task, { at: task.cancelledAt, by: "auto" });
		return true;
	}

	/** 熔断/失败/**取消**告警: 日志 warn + (会话在线时)队列横幅; 绝不重发。
	 *  ★批5 `T27`（`#A335`；并自 seed `v0.8.6`）：可传 `opts.title` 覆盖横幅标题 ——
	 *  **取消类告警不该写"已熔断"**（seed 原话）。`taskId`/`anchorSeq`/`uniq` 三个真源侧字段**一字不动**。 */
	function alertTask(task, text, opts = {}) {
		ctx.logger?.warn?.(`dsh-taskqueue: ${text}`);
		try {
			const agent = task.sessionId ? ctx.agents.get?.(task.sessionId) : null;
			if (agent?.session) {
				appendQueueBanner(agent.session, {
					state: "warn",
					taskId: task.id,
					title: opts.title ?? `任务 #${task.id} 已熔断`,
				anchorSeq: anchorSeqFor(agent.session),
					uniq: true,
					lines: [text, `内容: ${oneLine(task.content).slice(0, 120)}`]
				});
			}
		} catch { /* 告警失败不影响主流程 */ }
	}

	/** 是否已被 claim 成会话内 user/message (完成证据; 只看同一进程内的会话视图, 不 resume) */
	function isMessageClaimed(task, agent) {
		if (!task.messageId) return false;
		if (claimedMsgIds.has(task.messageId)) return true; // 0.1.2: 观察者维护的权威来源
		try {
			const evs = readSessionEvents(agent?.session) ?? []; // v0.8.4: 0.1.2 适配 (原 session.events 恒 undefined)
			for (let i = evs.length - 1; i >= 0; i--) {
				const e = evs[i];
				if (e.type === "user/message" && e.data?.id === task.messageId) return true;
			}
		} catch { /* 会话不可读 → 无证据(也不重发) */ }
		return false;
	}

	/** 消息是否仍挂在 inbox (在飞, 非失败) */
	function isMessageInInbox(task, agent) {
		if (!task.messageId) return false;
		try {
			if (agent?.inbox?.nextTurn?.some((m) => m.id === task.messageId)) return true;
			if (agent?.inbox?.nextStep?.some((m) => m.id === task.messageId)) return true;
		} catch { /* 保守: 读不到按不在 inbox 处理 */ }
		return false;
	}

	/** 人工 force 重新排队 (E6: 历史任务只允许人工 run-now; 这是唯一允许回到 pending 的路径) */
	function requeueForManualForce(task) {
		task.lastTerminal = { status: task.status, at: task[task.status + "At"] ?? null };
		task.status = "pending";
		// ★批一 b.5: 人工 force 是唯一允许重排的路径 ⇒ 显式清除取消标记（否则 b.5 自补偿会把它再置 cancelled）
		delete task.cancelRequested;
		delete task.cancelRequestedAt;
		task.requeuedAt = new Date().toISOString();
		task.requeuedBy = "manual-force";
		delete task.dispatchedAt;
		delete task.messageId;
		delete task.dispatchedBootId; // ★批5 `T27`: 重新排队 ⇒ 丢弃分类基线一并清掉（同 seed `v0.8.6`）
		task.roundId = null;
		task.dispatchCount = 0;
		task.unconfirmedCount = 0;
		task.failCount = 0;
		delete task.failReason;
	}

	/** claim = 消息被 agent 真正取走执行 → done (E3 完成依据; 只置终态, 从不重发) */
	async function onClaimed(payload) {
		try {
			const msgId = payload?.message?.id;
			if (!msgId || !dispatchedMsgIds.has(msgId)) return; // 快速过滤: 与队列无关的消息零写盘
			await mutateState((state) => {
				let hit = 0;
				for (const t of state.tasks) {
					if (t.status !== "dispatched" || t.messageId !== msgId) continue;
					if (setTerminal(t, "done", { doneTurn: payload?.turn ?? null, failCount: 0, unconfirmedCount: 0 })) hit++;
				}
				if (hit) ctx.logger?.info?.(`dsh-taskqueue: claim 确认 ${hit} 个任务 → done (messageId=${String(msgId).slice(0, 8)}${payload?.turn != null ? `, turn=${payload.turn}` : ""})`);
				return hit;
			});
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: claim 处理失败(忽略, 不重发): ${String(err?.message ?? err)}`);
		}
	}

	/** discarded = 派发消息被 inbox 丢弃, 从未执行 → **`cancelled`（人工终态）**；绝不重发。
	 *  ★批5 `T27`（`#A335`；并自 seed `v0.8.6`，seed 原话：2026-09-14 用户实测「我在 GUI 队列里手动删除, 却被记成熔断」）：
	 *  消息被移出 inbox 有两种来源，**都必须记 `cancelled` 而非 `failed`**，且**标识要分开**（用户拍板）：
	 *   · `dropCause="restart"` ← `task.dispatchedBootId ≠ 当前 boot`（消息跨了一次容器重启，inbox 被冲掉）
	 *   · `dropCause="removed"` ← 同一次启动内被丢弃 ⇒ 人工删队／主动移除
	 *  宿主语义背书（`dsh-agent` 的 `types/inbox.js`）：discard 恒带 `outcome:"canceled"`（"work dropped unrun"）。 */
	async function onDiscarded(payload) {
		try {
			const msgId = payload?.message?.id;
			if (!msgId || !dispatchedMsgIds.has(msgId)) return;
			const bootNow = readBootId();
			const dropped = [];
			await mutateState((state) => {
				for (const t of state.tasks) {
					if (t.status !== "dispatched" || t.messageId !== msgId) continue;
					const cause = dropCauseOf(t, bootNow, sessionBootIds.get(t.sessionId));
					const extra = cause === "restart"
						? { dropCause: "restart", failReason: "容器重启清空 inbox, 派发消息未执行 (不重发)" }
						: { dropCause: "removed", failReason: "派发消息已被移出队列 (人工删除/主动移除), 未执行" };
					if (setTerminal(t, "cancelled", extra)) dropped.push({ task: t, cause });
					sessionBootIds.delete(t.sessionId);
				}
				return dropped.length;
			});
			for (const { task, cause } of dropped) {
				const text = cause === "restart"
					? `任务 #${task.id} 因容器重启清空 inbox 而未执行 → 已取消(重启丢弃, 不重发; 需执行请 /queue run-now ${task.id} --force)`
					: `任务 #${task.id} 的派发消息已被移出队列 → 已取消(人工删除, 未执行; 需执行请 /queue run-now ${task.id} --force)`;
				alertTask(task, text, { title: cause === "restart" ? `任务 #${task.id} 已取消(重启丢弃)` : `任务 #${task.id} 已取消(人工删除)` });
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: discarded 处理失败(忽略, 不重发): ${String(err?.message ?? err)}`);
		}
	}

	// 订阅 claim/discarded (全局钩子: cordis dispatch 对 global 不做作用域过滤, 与 reconcile 同法)
	// 2026-09-10 (0.1.2 适配): agent.session.events 不再可用 → 用 session/event 观察者
	// 自行跟踪"派发消息已被 claim 成会话内 user/message"(只记我们关心的 messageId, 内存有界)
	ctx.on("session/event", (_session, event) => {
		try {
			const id = event?.data?.id;
			// ★批5 `T27`：记录"本会话被观察到的容器启动标识" —— `dropCauseOf` 的第二判据（容器重启后首次观测即刷新）
			const _sid = _session?.id ? String(_session.id) : null;
			if (_sid) { const _b = readBootId(); if (_b && sessionBootIds.get(_sid) !== _b) sessionBootIds.set(_sid, _b); }
			if (event?.type === "user/message" && id && dispatchedMsgIds.has(id)) claimedMsgIds.add(id);
			// ★段U17 B1：识别"本条 tool/call 是不是 queue_add"（字段名按实测：`event.data.name`；生产日志核验 seq=438828 dataKeys=[turn,step,callId,name,arguments]）
			if (event?.type === "tool/call" && QUEUE_ROW_TOOLS.has(String(event?.data?.name ?? "")) && typeof event.seq === "number") lastQueueToolCall = { sid: String(_session?.id ?? ""), seq: event.seq, turn: Number.isInteger(event?.data?.turn) ? event.data.turn : null };
		} catch { /* 忽略 */ }
	}, { global: true });
	ctx.on("agent/inbox/claimed", (payload) => { void onClaimed(payload); }, { global: true });
	ctx.on("agent/inbox/discarded", (payload) => { void onDiscarded(payload); }, { global: true });

	// boot 引导: 建 claim 索引 + 状态表版本标记 (只读+一次版本落盘; 不触发任何派发)
	void serialized(async () => {
		try {
			const st = await readState();
			for (const t of st.tasks ?? []) if (t.status === "dispatched" && t.messageId) dispatchedMsgIds.set(t.messageId, t.id);
			if (st.schemaVersion !== SCHEMA_VERSION) {
				st.schemaVersion = SCHEMA_VERSION;
				await writeState(st);
			}
			ctx.logger?.info?.(`dsh-taskqueue: 状态表 v${st.schemaVersion ?? 2} → v${SCHEMA_VERSION} 就绪; 待确认派发消息 ${dispatchedMsgIds.size} 个; 自动派发=${autoDisabled ? `停用(${autoDisabledReason})` : "启用"}`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 启动引导失败(自动路径保守停用): ${String(err?.message ?? err)}`);
			disableAuto("启动引导异常");
		}
	});

	async function dispatchTask(state, task, agent, opts = {}) {
		const force = opts.force === true;
		// E 硬门闩: 自动路径只允许 pending; 历史/终态任务必须人工 force 显式重排 (防任何未来 bug 造成重放)
		if (task.status !== "pending" && !force) {
			ctx.logger?.warn?.(`dsh-taskqueue: 拒绝隐式重发任务 #${task.id} (status=${task.status}); 历史任务只能人工 /queue run-now ${task.id} --force`);
			return false;
		}
		if (autoDisabled && !force) {
			ctx.logger?.warn?.(`dsh-taskqueue: 自动派发停用中(${autoDisabledReason}), 跳过任务 #${task.id}`);
			return false;
		}
		// ★批一 b.5: 派发前查**持久化取消标记**（任务可能来自旧内存快照 / 取消在窗口内写入）⇒ 不投递
		if (task.cancelRequested === true && !force) {
			ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task.id} 已请求取消 (cancelRequested) ⇒ 不派发`);
			return false;
		}
		// 去重键 (E4): (sessionId + taskId + roundId) 幂等; 本轮已有 claim 证据 → 直接终态, 不重复发送
		const roundId = force ? randomUUID() : (task.roundId ?? randomUUID());
		task.roundId = roundId;
		task.dedupeKey = `${task.sessionId ?? "-"}|${task.id}|${roundId}`;
		if (task.messageId && isMessageClaimed(task, agent)) {
			setTerminal(task, "done", { failCount: 0 });
			ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task.id} 本轮(${roundId.slice(0, 8)})已有 claim 证据 → 判 done, 不重复发送`);
			return true;
		}
		// ★批四（2026-11-24 用户要求）: 开头/结尾模板**每次派发前实时读取**（改配置下次派发生效）。
		//   读取失败/文件损坏 ⇒ 回落默认模板 + 可见 diag，绝不阻断派发（fail-safe）。
		const dispatchSettingsRes = await readDispatchSettings();
		if (!dispatchSettingsRes.ok) {
			ctx.logger?.warn?.(`dsh-taskqueue: 派发文案配置不可用 (${dispatchSettingsRes.reason}) ⇒ 本次回落默认模板`);
			void appendDiag({ event: "dispatch.settings-invalid", reason: dispatchSettingsRes.reason, action: "fallback-default" });
		}
		const dispatchText = renderDispatchMessage(task, dispatchSettingsRes.settings);
		const message = createUserMessage({
			// 批四：正文 = 可配置开头模板（默认 `[任务队列] 【自动调度任务 #{id}】 {content}`）+ 可配置结尾模板
			//   （默认 = 批前 DISPATCH_TRAILING_HINT：要求 agent 首次回答用 session_rename 改标题；空结尾=不追加）。
			content: [{ type: "text", text: dispatchText }],
			// source.kind="user" 让 GUI 把它渲染成普通用户气泡(与 /goal 插件一致),
			// 派发后在对话中形成可见的记录, 而不是折叠的"上下文注入"灰条。
			source: { kind: "user" }
		});
		// ★批一 b.5 派发前**二次核对持久化状态**（fail-safe）：状态不可读 / 任务消失 / 已请求取消 / 已终态 ⇒ 不派发。
		//   人工 force 重排路径跳过本核对（其状态由 mutateState 内的重新入队保证，且必须在同一事务内完成）。
		if (!force) {
			let freshBefore = null;
			try { freshBefore = await readState(); } catch { freshBefore = null; }
			if (freshBefore === null) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发前状态不可读 ⇒ 不派发 (保持 pending, 等下一轮)`);
				return false;
			}
			const curBefore = Array.isArray(freshBefore.tasks) ? freshBefore.tasks.find((x) => x.id === task.id) : null;
			if (!curBefore || curBefore.cancelRequested === true || TERMINAL_STATUS.has(curBefore.status)) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发前复核不通过 (消失/已请求取消/已终态) ⇒ 不派发`);
				if (curBefore?.cancelRequested === true) task.cancelRequested = true;
				return false;
			}
		}
		task.messageId = message.id; // 记录消息 id (claim 匹配/去重键的核心)
		task.dispatchedBootId = readBootId(); // ★批5 `T27`: 派发时的容器启动标识 (丢弃来源分类基线)
		task.dispatchCount = (task.dispatchCount || 0) + 1;
		task.dispatchedBy = force ? "manual-force" : "auto";
		task.status = "dispatched";
		task.dispatchedAt = new Date().toISOString();
		// ⚠️ 不要在此重置 failCount: 它是"连续失败"熔断计数, 只有 claim/done 才清零;
		//    否则投递失败会被每轮重置, 熔断永远不触发 (2026-09-10 harness 实测踩到)。
		task.unconfirmedCount = 0;
		// ⚠️ 顺序关键 (2026-09-10 E2E 实测教训): 必须在 followup 之前完成
		//   ① 置 dispatched ② 登记 claim 索引 ③ 落盘 —— claim 事件可能紧随 followup
		//   触发; 若登记/落盘在后, 处理函数会因"索引未命中"或"状态文件里还是 pending"
		//   而漏掉本次 claim, 任务将永远停在 dispatched (无终态)。
		dispatchedMsgIds.set(task.messageId, task.id);
		await writeState(state);
		// ④ 最后才真正投递 (此处可能同步/紧随触发 claim 事件 → 上面三步保证能被匹配到)
		try {
			agent.followup(message);
		} catch (err) {
			// 投递失败 = 消息未送达: 回滚为 pending(清掉 messageId/索引, 避免留下"假 dispatched"),
			// 再由 tick 的熔断计数决定是否重试/停发 (最多 TASK_FAIL_BREAKER 次, 不是重试风暴)。
			dispatchedMsgIds.delete(task.messageId);
			delete task.messageId;
			delete task.dispatchedBootId; // ★批5 `T27`: 派发失败回滚 ⇒ 丢弃分类基线清掉
			delete task.dispatchedAt;
			task.status = "pending";
			await writeState(state);
			throw err;
		}
		// 自动标题 (v0.3.0): 若目标会话尚无标题, 按任务内容设置确定性标题 —
		// 让派发窗口在侧边栏立即可辨识 (source.kind="user" 固定标题, 不触发 LLM 生成)。
		try {
			const session = agent.session;
			// v0.8.4: 优先读会话日志 (0.1.2 用 snapshotEvents); 日志不可读时退回内存集合 (2026-09-10 的兜底)
			const titleInLog = hasSessionEvent(session, "session/title");
			const hasTitle = titleInLog === null ? titledSessions.has(String(session?.id ?? "")) : titleInLog;
			if (session && !hasTitle) {
				const title = `任务 #${task.id} · ${oneLine(task.content).slice(0, 20)}`;
				session.append("session/title", {
					title,
					messageSeqs: [],
					source: { kind: "user" }
				});
				titledSessions.add(String(session.id ?? ""));
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 设置任务 #${task.id} 会话标题失败: ${String(err?.message ?? err)}`);
		}
		// followup 期间 claim 处理函数可能已把本任务置终态并落盘 → 合并回来再写,
		// 否则会用陈旧的内存状态覆盖掉刚写入的 done (stale write)。
		try {
			const fresh = await readState();
			const ft = fresh?.tasks?.find((x) => x.id === task.id);
			// ★批一 b.5 第三阶段: followup 后复核 —— 派发窗口内被取消 ⇒ 用现有 inbox.remove 撤回消息并自补偿置 cancelled
			if (ft && (ft.cancelRequested === true || ft.status === "cancelled") && !TERMINAL_STATUS.has(task.status)) {
				let withdrew = false;
				try { withdrew = agent?.inbox?.remove?.(task.messageId) === true; } catch { withdrew = false; }
				setTerminal(task, "cancelled", { cancelRequested: true, cancelledBy: ft.cancelledBy ?? "user", dropCause: "removed", failReason: withdrew ? "派发窗口内被取消: 派发消息已撤回" : "派发窗口内被取消: 消息可能已被消费, 已置 cancelled 并如实记录" });
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 在派发窗口内被取消 ⇒ ${withdrew ? "已撤回派发消息" : "撤回失败(可能已消费)"}, 置 cancelled`);
				void appendDiag({ event: "task.cancel-complete", taskId: task.id, stage: "post-followup", withdrew, messageId: task.messageId ?? null });
			} else if (ft && TERMINAL_STATUS.has(ft.status) && !TERMINAL_STATUS.has(task.status)) {
				task.status = ft.status;
				task.doneAt = ft.doneAt ?? task.doneAt;
				task.doneTurn = ft.doneTurn ?? task.doneTurn;
				task.failReason = ft.failReason ?? task.failReason;
			}
		} catch { /* 读回失败则按内存状态落盘 */ }
		const ok = await writeState(state);
		if (!ok) ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 已派发但状态落盘失败, 重启后可能重复派发`);
		ctx.logger?.info?.(`dsh-taskqueue: 已派发任务 #${task.id} 到 agent ${agent.id} (round=${roundId.slice(0, 8)}, by=${task.dispatchedBy})`);
		// G2 (RD-35): 任务**真正派发成功**(含自动派发与人工 run-now) ⇒ 发一次 queue.dispatched。
		// status 取当前真实状态: 若 followup 期间已收到 claim(上面的合并), 此处 task.status 已是 done,
		// 通知如实带 done 而**不谎报 dispatched**; by 取既有语义值 (auto / manual-force / ...)。
		notifyQueue("dispatched", task, { at: task.dispatchedAt, by: task.dispatchedBy });
		return true;
	}

	/**
	 * 校验派发消息是否仍存活:
	 *   - 在 agent 的 inbox 里排队等待消费 -> 存活
	 *   - 已被 claim 成会话里的 user/message (id 匹配) -> 已消费
	 *   - 都没有 -> 消息丢失(典型: 派发后未消费就遇到容器重启, dispose 会清空 inbox)
	 */
	function isMessageAlive(task, agent) {
		if (!task.messageId) return true; // 旧任务无 messageId, 不参与校验
		try {
			if (agent.inbox?.nextTurn?.some((m) => m.id === task.messageId)) return true;
			if (agent.inbox?.nextStep?.some((m) => m.id === task.messageId)) return true;
			const evs = readSessionEvents(agent?.session) ?? []; // v0.8.4: 0.1.2 适配
			for (let i = evs.length - 1; i >= 0; i--) {
				const e = evs[i];
				if (e.type === "user/message" && e.data?.id === task.messageId) return true;
			}
		} catch { /* 会话不可读时保守跳过 */ }
		return false;
	}

	// 目标会话解析优先级:
	//   1) 任务创建时的会话 (task.sessionId), 不在线则尝试 resume 恢复(无人值守也能派发)
	//   2) /queue target 设置的兜底目标会话 (state.targetSessionId)
	//   ★批4 T30 (2026-09-26 用户裁定「宁可不发，不可错发」): **撤除**原第 3 级「任意在线 agent」——
	//     绑定靶与兜底靶都不可达 ⇒ **不发**(返回 null, 任务保持 pending) ＋ **如实上报**。
	//     依据: 批4 段1 定因 —— 第 38 次重启后绑定靶离线, 旧第 3 级把自测消息投进了**无关会话**
	//     (taskqueue.json #238 记 sessionId=兜底会话, 消息实际落执行线会话; 见
	//      `log/obs3s7/2026-09-26-批4-段1-只读定位.md` §2)。
	const noTargetDiagAt = new Map(); // taskId -> 上次如实上报时刻 (节流, 防每 tick 刷屏)
	const NO_TARGET_DIAG_TTL_MS = 10 * 60 * 1000;
	function reportNoTarget(state, task, boundId) {
		const online = (() => { try { return (ctx.agents?.list?.() ?? []).length; } catch { return -1; } })();
		ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task?.id} 目标会话不可达 (绑定靶 ${shortSession(boundId)}, 兜底靶 ${shortSession(state?.targetSessionId)}); 按"宁可不发"保持 pending, 不落其它会话`);
		const key = task?.id ?? -1;
		const now = Date.now();
		if (now - (noTargetDiagAt.get(key) ?? 0) < NO_TARGET_DIAG_TTL_MS) return;
		noTargetDiagAt.set(key, now);
		// 如实上报走 diag (落 log/taskqueue/offpeak-debug.log ＋ mode.get 回读最近 8 条 ⇒ 远程可取证;
		// ctx.logger 在 dsh web 下不转出 ⇒ 只写 logger 等于静默)。
		void appendDiag({ event: "dispatch.no-target", taskId: task?.id ?? null, bound: shortSession(boundId), fallback: shortSession(state?.targetSessionId), online, action: "skip-keep-pending" });
	}

	/* ================= 批一 b.1 派发门（2026-11-24 用户裁）: blocked 才等低谷 ================= */
	// 规则: blocked = peakEff ∧ ((G1 ∧ ¬S1) ∨ (G2 ∧ ¬S1 ∧ ¬S2))，按**实际投递目标会话**判定；
	//   blocked ⇒ 保持 pending 等低谷（绑定会话 blocked 时**不主动 resume**，避免高峰把人叫醒）；
	//   blocked=false ⇒ 立即派发；--at 指定时间任务按点派发（不受本规则影响）；restart 类同规则。
	//   失败安全: 读模式/窗口失败、目标不可解析、状态不确定 ⇒ 一律不派发 + 可见诊断（绝不猜测派发）。
	const dispatchWaitDiagAt = new Map(); // `${taskId}:${kind}` -> 上次诊断时刻 (节流，防每 tick 刷屏)
	const DISPATCH_WAIT_DIAG_TTL_MS = 10 * 60 * 1000;
	const gateDiagAt = new Map(); // reason -> 上次诊断时刻
	const GATE_DIAG_TTL_MS = 5 * 60 * 1000;
	function reportDispatchWaitBlocked(task, sessionId, gate) {
		const d = dispatchBlockedDetail({ mode: gate.mode, peakEff: gate.peakEff, sessionId });
		ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task?.id} 等待低谷 — 目标会话 ${shortSession(sessionId)} 当前被错峰/自动暂停挡住 (peak=${d.peakEff} g1=${d.g1} g2=${d.g2} s1=${d.s1} s2=${d.s2})`);
		const key = `${task?.id ?? -1}:bound`;
		const now = Date.now();
		if (now - (dispatchWaitDiagAt.get(key) ?? 0) < DISPATCH_WAIT_DIAG_TTL_MS) return;
		dispatchWaitDiagAt.set(key, now);
		void appendDiag({ event: "dispatch.wait-blocked", taskId: task?.id ?? null, sessionId: shortSession(sessionId), where: "bound", peak: d.peakEff, g1: d.g1, g2: d.g2, s1: d.s1, s2: d.s2, action: "skip-keep-pending" });
	}
	function reportDispatchBlockedTarget(task, sessionId, gate) {
		const d = dispatchBlockedDetail({ mode: gate.mode, peakEff: gate.peakEff, sessionId });
		ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task?.id} 实际落点 ${shortSession(sessionId)} 被 blocked ⇒ 保持 pending 不投递 (宁可不发, 不可错发)`);
		const key = `${task?.id ?? -1}:target`;
		const now = Date.now();
		if (now - (dispatchWaitDiagAt.get(key) ?? 0) < DISPATCH_WAIT_DIAG_TTL_MS) return;
		dispatchWaitDiagAt.set(key, now);
		void appendDiag({ event: "dispatch.blocked-target", taskId: task?.id ?? null, sessionId: shortSession(sessionId), where: "resolved", peak: d.peakEff, g1: d.g1, g2: d.g2, s1: d.s1, s2: d.s2, action: "skip-keep-pending" });
	}
	function reportGateUnavailable(reason) {
		const now = Date.now();
		const key = String(reason ?? "unknown");
		if (now - (gateDiagAt.get(key) ?? 0) < GATE_DIAG_TTL_MS) return;
		gateDiagAt.set(key, now);
		ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 派发门状态不确定 (${key}) ⇒ 本轮自动派发全部跳过, 任务保持 pending`);
		void appendDiag({ event: "dispatch.gate-unavailable", reason: key, action: "skip-all-keep-pending" });
	}
	async function findTargetAgent(state, task) {
		const agents = ctx.agents;
		const boundId = task?.sessionId ?? state.targetSessionId;
		if (boundId) {
			const a = agents.get(boundId);
			if (a) return a;
			// 绑定会话不在线: 主动恢复其持久 agent (dsh 重启后不会自动恢复会话,
			// 不恢复的话低谷任务在无人值守时会一直滞留)
			try {
				// resume 必须带 agentOptions(provider/model) 和 setup(挂载默认 preset):
				// 否则恢复出来的 agent 没有 preset(standard-fetch) 组合, 工具集只剩插件工具、
				// 系统提示词 {{model}} 无值, 无法正常执行。与宿主冷恢复路径
				// (createApiRemoteAgentResolver + composeAgent) 保持一致。
				const defaultModel = ctx.get?.("agentDefaultModel")?.currentSelection?.() ?? {};
				const handle = await agents.resume?.({
					resumeSessionId: boundId,
					agentOptions: {
						...(defaultModel.provider ? { provider: defaultModel.provider } : {}),
						...(defaultModel.model ? { model: defaultModel.model } : {})
					},
					setup: async (agentCtx) => {
						// 挂载部署默认 preset (当前 standard-fetch), 恢复的 agent 才能
						// 解析到该 preset 的工具集/提示词段; 无 preset 名单时跳过(与宿主一致)。
						const presets = ctx.get?.("agentPresets");
						if (presets) await presets.mount(agentCtx);
					}
				});
				const restored = handle?.agent ?? agents.get(boundId);
				if (restored) {
					ctx.logger?.info?.(`dsh-taskqueue: 已恢复会话 ${shortSession(boundId)} 的 agent 用于派发`);
					return restored;
				}
			} catch (e) {
				ctx.logger?.warn?.(`dsh-taskqueue: 恢复会话 ${shortSession(boundId)} 失败: ${e?.message ?? e}`);
			}
		}
		if (state.targetSessionId && state.targetSessionId !== boundId) {
			const a = agents.get(state.targetSessionId);
			if (a) return a;
		}
		// ★批4 T30: **到此为止 ⇒ 不发**（撤除旧「兜底: 第一个在线 agent」，否则会落到无关会话）。
		reportNoTarget(state, task, boundId);
		return null;
	}

	// ---------- 定时检查 ----------
	async function tick() {
		await serialized(async () => {
			const state = await readState();
			// ★批一 b.1 失败安全: 读模式/窗口严格化 —— 任一步失败 ⇒ 本轮自动派发**一条都不发**
			//   （任务保持 pending + 可见诊断 dispatch.gate-unavailable），降级绝不变成误发。
			let gate = { ok: true, mode: null, peakEff: null, reason: null };
			try {
				const mr = await readModeStrict();
				if (!mr.ok) gate = { ok: false, mode: null, peakEff: null, reason: `read-mode:${mr.reason}` };
				else {
					const wsNow = await resolveWindows();
					if (!wsNow || !Array.isArray(wsNow.windows) || wsNow.windows.length === 0) {
						gate = { ok: false, mode: mr.mode, peakEff: null, reason: "windows-unavailable" };
					} else {
						gate = { ok: true, mode: mr.mode, peakEff: effectivePeak(mr.mode, wsNow), reason: null };
					}
				}
			} catch (err) {
				gate = { ok: false, mode: null, peakEff: null, reason: `gate:${String(err?.message ?? err).slice(0, 120)}` };
			}
			const now = Date.now();
			// v0.6.0: 容器重启检测 —— PID1 starttime 变化 = 发生一次重启。
			// trigger=restart 的任务只在"检测到重启的这一次 tick"派发 (尝试一次;
			// 派发失败保持 pending, 下次重启再试 —— 满足"已重启未发送又重启,
			// 再次重启后发送"); 尝试后消费事件 (更新 lastBootId 落盘)。
			const bootId = readBootId();
			const restartDetected = bootId !== null && state.lastBootId !== bootId;
			if (bootId === null) ctx.logger?.warn?.("dsh-taskqueue: 无法读取容器启动标识 (/proc/1/stat), 跳过重启触发检测");
			// 1) 派发到期任务 (**仅 pending**); v0.4.3: 编辑锁中的任务 (及同会话后续任务) 跳过
			cleanupStaleLocks(state);
			let changed = false;
			const pendingAlerts = [];
			let tickHadError = false;
			// E 可观测性: 自动路径的熔断/恢复状态落盘 (dsh web 不转出插件 logger, 日志不可取证)
			if (autoDisabled && state.failSafe?.disabled !== true) {
				state.failSafe = { disabled: true, reason: autoDisabledReason, at: new Date().toISOString() };
				changed = true;
			} else if (!autoDisabled && state.failSafe?.disabled === true) {
				state.failSafe = { disabled: false, at: new Date().toISOString(), note: "能力探测通过, 自动路径恢复" };
				changed = true;
			}
			if (autoDisabled) {
				ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 自动派发停用中 (${autoDisabledReason}); 本轮只观测不派发, 待人工 run-now`);
			}
			// v0.8.5: 「重启后发送」类任务也遵循错峰出行 —— 重启发生即把这类任务标记为
			// **已就绪(armed, 持久化)**, 但只有**当前是低谷**才真正派发 (用户在高峰期重启时,
			// 任务不再立刻按高峰价执行, 而是等低谷窗口)。armed 在"真正尝试派发"时消费掉,
			// 保持原有语义: 每次重启只尝试一次, 失败/异常保持 pending 等下次重启。
			if (restartDetected) {
				for (const t of state.tasks) {
					if (t.status === "pending" && t.trigger === "restart" && t.armed !== true) {
						t.armed = true;
						t.armedAt = new Date().toISOString();
						changed = true;
					}
				}
			}
			// ★批一 b.5 自补偿（两阶段取消的第二阶段）：重启/遗留的「已请求取消但未落终态」任务
			//   ⇒ 本轮统一置 cancelled，**绝不重派**（不依赖宿主、fail-safe）。
			const cancelRecovered = [];
			for (const t of state.tasks) {
				if (t.cancelRequested === true && !TERMINAL_STATUS.has(t.status)) {
					if (setTerminal(t, "cancelled", { cancelRequested: true, dropCause: t.dropCause ?? "removed", failReason: "取消标记兜底: 派发前生命周期未完成, 重启后补偿置 cancelled" })) {
						changed = true;
						cancelRecovered.push(t.id);
					}
				}
			}
			if (cancelRecovered.length) {
				ctx.logger?.warn?.(`dsh-taskqueue: 批一 b.5 自补偿 — 已请求取消的遗留任务置 cancelled: [${cancelRecovered.join(", ")}]`);
				void appendDiag({ event: "dispatch.cancel-recovered", taskIds: cancelRecovered, action: "terminal-cancelled-no-redispatch" });
			}
			// 时间到达条件（blocked 判定在下面逐任务做，不在这里）；--at 只看时间（b.1: 指定时间任务不受等待规则影响）
			const due = (autoDisabled || !gate.ok) ? [] : state.tasks.filter((t) => t.status === "pending"
				&& t.cancelRequested !== true
				&& !isTaskLocked(state, t)
				&& (t.trigger === "restart"
					? (t.armed === true)
					: (t.scheduledAt ? now >= Date.parse(t.scheduledAt) : true)));
			if (autoDisabled) reportGateUnavailable(`auto-disabled:${autoDisabledReason ?? "unknown"}`);
			else if (!gate.ok) reportGateUnavailable(gate.reason);
			let blockedBound = 0, blockedTarget = 0;
			for (const task of due) {
				try {
					if (!gate.ok) break; // 失败安全: 状态不确定 ⇒ 一条都不发（上面已留诊断）
					const atTask = typeof task.scheduledAt === "string" && task.scheduledAt;
					// ① 先按**绑定会话**判 blocked：blocked ⇒ 跳过，且**不主动 resume**（用户裁：别在高峰把人叫醒）
					const boundId = task.sessionId ?? state.targetSessionId ?? null;
					if (!atTask && boundId && isDispatchBlocked({ mode: gate.mode, peakEff: gate.peakEff, sessionId: boundId })) {
						blockedBound += 1;
						reportDispatchWaitBlocked(task, boundId, gate);
						continue;
					}
					const agent = await findTargetAgent(state, task);
					if (!agent) continue; // 该任务无可用会话, 下次再试 (armed 保留, 下轮可派发时继续找)
					// ② 可发后**复核实际落点**：落点被 blocked ⇒ 保持 pending 不投递（宁可不发，不可错发）
					if (!atTask && isDispatchBlocked({ mode: gate.mode, peakEff: gate.peakEff, sessionId: agent.id })) {
						blockedTarget += 1;
						reportDispatchBlockedTarget(task, agent.id, gate);
						continue;
					}
					// ③ 真正尝试派发即消费"重启已就绪"标记 (每次重启只尝试一次)
					if (task.trigger === "restart" && task.armed === true) { delete task.armed; delete task.armedAt; changed = true; }
					const sent = await dispatchTask(state, task, agent);
					if (sent) changed = true;
				} catch (err) {
					// E 熔断: 派发异常 → 任务失败计数 + 全局连续异常计数(按异常次数累加); 达限即停发
					tickHadError = true;
					tickFailStreak += 1;
					task.failCount = (task.failCount || 0) + 1;
					task.lastFailReason = String(err?.message ?? err);
					ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发异常 (任务失败计数 ${task.failCount}/${TASK_FAIL_BREAKER}, 全局连续异常 ${tickFailStreak}/${TICK_FAIL_BREAKER}): ${task.lastFailReason}`);
					changed = true;
					if (tickFailStreak >= TICK_FAIL_BREAKER) disableAuto(`tick 连续 ${tickFailStreak} 次派发异常`);
					if (task.failCount >= TASK_FAIL_BREAKER) {
						if (setTerminal(task, "failed", { failReason: `连续 ${task.failCount} 次派发异常: ${task.lastFailReason}` })) pendingAlerts.push(task);
					}
				}
			}
			if (gate.ok && (blockedBound || blockedTarget)) {
				ctx.logger?.info?.(`dsh-taskqueue: 批一 b.1 派发等待 — 绑定会话 blocked 跳过 ${blockedBound} 个 / 实际落点 blocked 保持 pending ${blockedTarget} 个`);
			}
			// 消费重启事件: 无论 restart 任务是否全部派发成功, 都更新 lastBootId,
			// 防止后续 tick 重复触发 (派发失败的任务保持 pending, 等下次重启再试)
			if (restartDetected) {
				state.lastBootId = bootId;
				await writeState(state);
				const armedN = state.tasks.filter((t) => t.status === "pending" && t.trigger === "restart" && t.armed === true).length;
				const restartNote = !gate.ok ? " (派发门不可用, 本轮未派发; armed 保留待可派发)" : (gate.peakEff ? " (当前高峰 → 遵循 b.1 等待规则, 待非 blocked 再派发)" : "");
				ctx.logger?.info?.(`dsh-taskqueue: 检测到容器重启 (bootId=${bootId}), restart 触发任务 本次派发 ${due.filter((t) => t.trigger === "restart").length} 个 / 已就绪待派发 ${armedN} 个${restartNote}`);
			}
			// 2) E: 已派发任务的**完成观测 (claim 驱动)** —— 本段只观测/置终态, **绝不重发**。
			//    历史 dispatched: 目标会话已含同 messageId 的 user/message → done;
			//    仍挂在 inbox → 在飞(不计数); 既不在 inbox 又无 claim 且超过 CLAIM_TIMEOUT_MS
			//    → 记一次"未确认", 连续 TASK_FAIL_BREAKER 次 → failed + 告警。
			//    ⚠️ 本段**不使用 agents.resume**: 只读在线 agent 视图, 避免重现 0.1.2
			//    resume 语义误判("已执行任务被判丢失") → 无限重发的原始事故链。
			for (const task of state.tasks) {
				// (D, 2026-09-10) 2026-09-09 的 kill switch `if (true) continue;` 已删除:
				// E 的 claim 驱动完成 + 熔断已接管, 且本块**不含任何重发调用**(只观测/置终态)。
				if (task.status !== "dispatched" || !task.dispatchedAt) continue;
				const sid = task.sessionId ?? state.targetSessionId;
				const agent = sid ? ctx.agents.get?.(sid) : null;
				if (!agent) continue; // 会话不在线: 无证据, 状态不动 (等人工或下次在线)
				if (isMessageClaimed(task, agent)) {
					if (setTerminal(task, "done", { failCount: 0, unconfirmedCount: 0 })) {
						changed = true;
						ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task.id} 观测到 claim 证据 → done`);
					}
					continue;
				}
				if (isMessageInInbox(task, agent)) { task.unconfirmedCount = 0; continue; }
				if (now - Date.parse(task.dispatchedAt) < CLAIM_TIMEOUT_MS) continue;
				task.unconfirmedCount = (task.unconfirmedCount || 0) + 1;
				task.lastUnconfirmedAt = new Date().toISOString();
				changed = true;
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发后无 claim 且不在 inbox (未确认 ${task.unconfirmedCount}/${TASK_FAIL_BREAKER})`);
				if (task.unconfirmedCount >= TASK_FAIL_BREAKER) {
					if (setTerminal(task, "failed", { failReason: `派发后连续 ${task.unconfirmedCount} 轮无 claim 且不在 inbox (未执行/凭据失败等)` })) pendingAlerts.push(task);
				}
			}
			// E 熔断: 某轮零异常 → 全局连续异常计数清零 (累计在 catch 内按异常次数进行)
			if (!tickHadError) tickFailStreak = 0;
			for (const t of pendingAlerts) alertTask(t, `任务 #${t.id} 已熔断为 failed: ${t.failReason ?? "未知原因"} (不重发; 需重跑请人工 /queue run-now ${t.id} --force)`);
			if (changed) await writeState(state);
		});
	}

	const timer = setInterval(() => { void tick().catch(() => {}); }, CHECK_INTERVAL_MS);
	timer.unref?.();
	setTimeout(() => { void tick().catch(() => {}); }, 3000);
	ctx.effect(() => () => clearInterval(timer));

	// ================= v0.9.0: 高峰暂停闸门 (+ v0.10.0 规格 v2) =================
	// 挂点: `ctx.on("agent/pre-step", async (payload, next) => …)` —— 每一步开始前的**瀑布中间件**。
	//   在 next() 之前 await ⇒ 本步的模型调用与工具照常跑完, **下一步的 LLM 请求被挡住** ⇒
	//   回合停在"当前步骤结束后", 等待期零 token。`next()` 必须**恰好调用一次**。
	// 释放(任一即立即恢复执行): 低谷到达 / pause=false / 本会话被豁免(S1 或 S2) /
	//   提问卡答①(本回合余下步骤放行) / signal.aborted(用户点停止)。
	// v0.10.0 真并列: `enabled`(错峰出行) **不再是**暂停的开关或释放条件。
	// ★可见性: 全部横幅**一律**经既有 `appendQueueBanner()` → `loadBannerKit()` → `bk.emit({…, anchorSeq})`
	//   （`ENV §一.7①`：不新增任何直连宿主的接触点；本闸门**不出现** `session.append`）。
	const pauseWaiters = new Map();    // sessionId -> waiter (等待中的回合; 也是 mode.get 的 paused 摘要来源)
	const pauseAsked = new Map();      // sessionId -> 已弹过提问卡的高峰窗口 key (每会话每高峰窗口最多一次)
	const pauseTurnAllow = new Set();  // `${sessionId}:${turn}` 提问卡答① ⇒ 本回合余下步骤放行
	const pauseSkipDiagAt = new Map(); // `${sessionId}:${reason}` -> 上次 skip 诊断时刻 (节流, 防刷屏)
	let pauseTimer = null;             // 共享轮询器 (只在有等待者时运行)
	let pauseGateReason = null;        // 非空 = 闸门自检失败, 暂停路径停用 (其余功能照旧)

	function windowKey(windows, now = new Date()) {
		return `${new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)} ${currentPeakWindowText(windows, now)}`;
	}

	// P1 (2026-09-14 修): mode 文件的**串行化读改写** —— 同文件读写不得并发 (与 STATE_FILE 的 serialized 同纪律)。
	let modeChain = Promise.resolve();
	function serializedMode(fn) {
		const p = modeChain.then(fn, fn);
		modeChain = p.then(() => {}, () => {});
		return p;
	}
	/** 自有三键 (时段自动管理只准动这三个) */
	const MODE_POLICY_KEYS = ["pause", "pauseManual", "pauseEpoch"];
	/**
	 * **收窄**的原子读改写: 只覆盖 patch 里出现的键, 其余键一律原样保留 (避免"整份写回用旧快照"覆盖并发写入);
	 * 值真的变化才写盘 (避免每 15s 轮询抖动写)。返回 { mode, wrote }。
	 * ⚠️ 纪律: 调用方**不得**手列键集去重建 mode 对象 (那是本次事故的根因 —— 手列会丢键)。
	 */
	async function patchMode(patch) { return serializedMode(() => patchModeLocked(patch)); }
	/** ⚠️ 只允许在 serializedMode 段内调用 (否则请用 patchMode) —— 防重入死锁 */
	async function patchModeLocked(patch) {
		const cur = await readMode();
		const next = { ...cur, ...patch };
		const keys = Object.keys(patch);
		const changed = keys.some((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(next[k] ?? null));
		if (!changed) return { mode: cur, wrote: false };
		await writeMode(next);
		return { mode: next, wrote: true };
	}

	/**
	 * v0.10.0 (G2 时段自动管理): 进入新高/平峰时段时自动设定 pause, 并**每个时段边界只应用一次**
	 *   (用 currentEpisode 记账, 持久化 pauseEpoch; 否则每分钟 tick 都会覆盖用户手动值)。
	 *   规则: 高峰 ⇒ pause=true 且清手动覆盖; 平峰 ⇒ pause=(手动覆盖===true); 手动切换 ⇒ pauseManual 记账。
	 *   ★写面**只准动 `MODE_POLICY_KEYS` 三键**（`patchMode` 收窄写）—— 手列键集重建 mode 会吞并发写入。
	 * @returns {Promise<object|null>} 应用后的 mode (未跨边界则 null)
	 */
	async function syncPausePolicy(now = new Date()) {
		try {
			const mode = await readMode();
			const ws = await resolveWindows();
			const ep = currentEpisode(mode, ws, now);
			if (mode.pauseEpoch === ep) return null; // 本时段已应用过 ⇒ 不反复覆盖
			const peak = peakAtMs(mode, ws, now.getTime());
			const prevPause = mode.pause, prevEpoch = mode.pauseEpoch;
			// **只写自有三键** + 串行化 + 值不变不写盘 (P1)
			const patch = { pauseEpoch: ep };
			if (peak) { patch.pause = true; patch.pauseManual = null; }   // 进高峰: 自动开 + 清手动覆盖
			else { patch.pause = mode.pauseManual === true; }            // 进平峰: 默认关; 手动开的保持
			// 不变量 (2026-09-14 事故根因防护): 本函数的**写面键集必须 ⊆ MODE_POLICY_KEYS** ——
			//   手列键集重建 mode 会吞掉并发写入的 exempt/pauseExempt 等键。
			if (!Object.keys(patch).every((k) => MODE_POLICY_KEYS.includes(k))) {
				throw new Error(`syncPausePolicy 越界写: [${Object.keys(patch).join(", ")}] ⊄ MODE_POLICY_KEYS`);
			}
			const { mode: next, wrote } = await patchMode(patch);
			void appendDiag({ event: "pause.auto", epoch: ep, prevEpoch, peak, pause: next.pause, pauseManual: next.pauseManual, changed: next.pause !== prevPause, wrote, via: "boundary" });
			ctx.logger?.info?.(`dsh-taskqueue: 时段边界自动应用 — ${peak ? "高峰" : "平峰"} (epoch=${ep}) ⇒ pause=${next.pause}${next.pauseManual === null ? " (自动)" : " (手动覆盖)"}`);
			if (!next.pause) releaseAllForReason("pause-off-auto"); // ★批一 b.2: 时段边界自动关闭 ⇒ 独立原因码
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 时段边界自动应用失败(忽略, 沿用现值): ${String(err?.message ?? err)}`);
			return null;
		}
	}

	/** mode.get 的 paused 摘要: { count, sessions:[{sessionId, since, turn, step, nextOffpeakAt, mode, syntheticNext}] } */
	function pauseSummary() {
		const sessions = [];
		for (const w of pauseWaiters.values()) {
			if (w.released) continue;
			sessions.push({ sessionId: w.sessionId, since: w.since, turn: w.turn, step: w.step, nextOffpeakAt: w.nextOffpeakAt, syntheticNext: w.synthetic === true, mode: w.mode });
		}
		return { count: sessions.length, sessions };
	}

	/** skip 诊断: 同会话同原因 5 分钟内只记一条 (闸门每步都会评估, 不节流会刷屏) */
	function diagSkip(sessionId, reason) {
		const key = `${sessionId ?? "-"}:${reason}`;
		const now = Date.now();
		if (now - (pauseSkipDiagAt.get(key) ?? 0) < PAUSE_SKIP_DIAG_TTL_MS) return;
		pauseSkipDiagAt.set(key, now);
		void appendDiag({ event: "pause.skip", reason, sessionId: shortSession(sessionId) });
	}

	function stopPauseTimerIfIdle() {
		if (pauseTimer && pauseWaiters.size === 0) { clearInterval(pauseTimer); pauseTimer = null; }
	}

	function ensurePauseTimer() {
		if (pauseTimer || pauseGateReason) return;
		pauseTimer = setInterval(() => { void checkPauseWaiters(); }, PAUSE_POLL_MS);
		pauseTimer.unref?.();
	}

	/** 释放一个等待者 (幂等): 恢复回合 + 恢复横幅 + diag; 任何可见性失败都不影响释放本身 */
	function releaseWaiter(w, reason) {
		if (!w || w.released) return;
		w.released = true;
		w.releasedReason = reason;
		pauseWaiters.delete(w.sessionId);
		try { if (w.abortHandler && typeof w.signal?.removeEventListener === "function") w.signal.removeEventListener("abort", w.abortHandler); } catch { /* 忽略 */ }
		try {
			// ★批一 b.2: 恢复卡与暂停卡**同一稳定身份**（cardKey=pause-<sid>）⇒ 走同卡替换、常留不收起；
			//   原因按下表如实映射（用户 2026-11-24 裁：低谷到达/手动放行/关闭自动暂停/时段自动关闭/
			//   两豁免/停止/提问卡两选项/模式异常/被替换；重启或外部中断按无横幅处理，见 tick/报告说明）。
			//   只保留简洁状态消息：不加按钮、不加任务列表、不加管理入口。
			const releaseText = pauseReleaseText(reason);
			appendQueueBanner(w.session, {
				cardKey: pauseCardKey(w.sessionId),
				title: releaseText.title,
				lines: [`第 ${w.step} 步后继续 · ${releaseText.detail}`]
			});
		} catch { /* 横幅失败不影响恢复 */ }
		// ★批一 b.6: `pause.handoff.next` 只在**真实交接**（等待者被释放、next() 即将执行）时记录一条，
		//   不再对每个 step≥2 的普通步骤无条件刷屏（原实现每步一条 ⇒ 日志洪泛、diag 环形缓冲被淹没）。
		void appendDiag({ event: "pause.handoff.next", reason, sessionId: shortSession(w.sessionId), step: w.step, turn: w.turn });
		void appendDiag({ event: "pause.release", reason, sessionId: shortSession(w.sessionId), step: w.step, waitedSec: Math.max(0, Math.round((Date.now() - Date.parse(w.since)) / 1000)) });
		stopPauseTimerIfIdle();
		try { w.resolve(); } catch { /* 忽略 */ }
	}

	function releaseAllForReason(reason) {
		for (const w of [...pauseWaiters.values()]) releaseWaiter(w, reason);
	}

	/** 共享轮询器: 一轮读完模式/窗口, 再逐个判定释放 (单会话异常不影响其他等待者) */
	async function checkPauseWaiters() {
		if (pauseWaiters.size === 0) { stopPauseTimerIfIdle(); return; }
		let mode = null, ws = null, err = null;
		try { mode = await readMode(); ws = await resolveWindows(); } catch (e) { err = e; }
		const now = new Date();
		for (const w of [...pauseWaiters.values()]) {
			try {
				if (w.signal?.aborted) { releaseWaiter(w, "abort"); continue; }
				// 规则②: 读不到模式 = 异常 ⇒ 立即放行 (绝不无限阻塞)
				if (err || !mode) { releaseWaiter(w, "error"); continue; }
				// v0.10.0 真并列: `enabled`(错峰出行) 不再是暂停的释放条件
				if (mode.pause === false) { releaseWaiter(w, "pause-off"); continue; }
				if (w.sessionId && mode.pauseExempt?.[w.sessionId]) { releaseWaiter(w, "pause-exempt"); continue; }
				if (w.sessionId && mode.exempt?.[w.sessionId]) { releaseWaiter(w, "exempt"); continue; }
				// 仅"高峰中停"等低谷; 平峰手动暂停**不自动恢复**(提问卡是唯一放行路径)
				// ★批一 b.2: 原因如实 —— debug 强制平峰导致的释放要与"真实低谷到达"区分（不同文案）。
				if (w.mode === "peak" && !peakAtMs(mode, ws, now.getTime())) { releaseWaiter(w, mode?.debug === "offpeak" ? "debug-offpeak" : "offpeak"); continue; }
			} catch { /* 单个等待者判定异常: 保持暂停, 下轮再判 */ }
		}
	}

	/** 豁免开关 (RPC mode.exempt 与提问卡③ 共用): 写 offpeak-mode.json 的 exempt map */
	async function setExemptMap(sessionId, exempt) {
		return serializedMode(async () => {
			const cur = await readMode();
			const exemptMap = { ...cur.exempt };
			if (exempt) exemptMap[sessionId] = true;
			else delete exemptMap[sessionId];
			const { mode: next } = await patchModeLocked({ exempt: exemptMap });
			return next.exempt ?? exemptMap;
		});
	}

	/**
	 * 提问卡 (每会话每高峰窗口最多一次): ① 继续到本回合结束 ② 保持暂停至低谷 ③ 豁免本会话。
	 * 无人应答/解析失败/异常(含子 agent 的 DELEGATED_CALLER) ⇒ **保持暂停** (静默, 不抛)。
	 */
	function askPauseChoice(w) {
		let uq = null;
		try { uq = ctx.get?.("userQuestions"); } catch { uq = null; }
		if (!uq || typeof uq.ask !== "function") {
			void appendDiag({ event: "pause.ask", reason: "no-service", sessionId: shortSession(w.sessionId) });
			return;
		}
		Promise.resolve()
			.then(() => uq.ask({
				questions: [{
					id: PAUSE_ASK_ID,
					header: "高峰暂停",
					question: `已进入高峰（${w.windowText}），本会话已暂停在第 ${w.step} 步后。是否继续？`,
					detail: w.mode === "offpeak"
						? "平峰手动暂停：不会自动继续，需要你选择（不回答 = 保持暂停；等待期零 token）。"
						: `低谷时段预计 ${beijingHm(new Date(w.nextOffpeakAt))} 到达；不回答 = 保持暂停至低谷（等待期零 token）。`,
					options: (w.mode === "offpeak" ? PAUSE_ASK_OPTIONS_OFFPEAK : PAUSE_ASK_OPTIONS).map((label) => ({ label }))
				}],
				agent: w.agent,
				signal: w.signal
			}))
			.then((res) => {
				const answers = Array.isArray(res?.answers) ? res.answers : [];
				const ans = answers.find((a) => a?.id === PAUSE_ASK_ID) ?? answers[0] ?? null;
				const selected = Array.isArray(ans?.selected) ? ans.selected : [];
				const OPTS = w.mode === "offpeak" ? PAUSE_ASK_OPTIONS_OFFPEAK : PAUSE_ASK_OPTIONS;
				const idx = selected.map((s) => OPTS.indexOf(s)).find((i) => i >= 0);
				if (idx === 0) {
					pauseTurnAllow.add(`${w.sessionId}:${w.turn}`);
					void appendDiag({ event: "pause.ask", reason: "allow-turn", sessionId: shortSession(w.sessionId) });
					releaseWaiter(w, "ask-allow-turn");
					return;
				}
				if (OPTS[idx] === PAUSE_ASK_OPTIONS[2] || OPTS[idx] === PAUSE_ASK_OPTIONS_OFFPEAK[1]) { // 「豁免本会话」
					void appendDiag({ event: "pause.ask", reason: "exempt", sessionId: shortSession(w.sessionId) });
					void setExemptMap(w.sessionId, true)
						.then(() => releaseWaiter(w, "ask-exempt"))
						.catch(() => releaseWaiter(w, "ask-exempt")); // 写盘失败也放行 (不阻塞回合)
					return;
				}
				// ② 保持暂停至低谷 / 未识别答案 ⇒ 保持暂停
				void appendDiag({ event: "pause.ask", reason: idx >= 0 ? "stay" : "unparsed", sessionId: shortSession(w.sessionId) });
			})
			.catch((err) => {
				const msg = String(err?.message ?? err);
				void appendDiag({ event: "pause.ask", reason: /DELEGATED_CALLER/.test(msg) ? "delegated" : "error", error: msg, sessionId: shortSession(w.sessionId) });
			});
	}

	/** 进入暂停: 登记等待者 + 横幅 + diag + 提问卡 + abort 监听; 返回的 promise 在释放时 resolve */
	async function waitForPause(info) {
		const sessionId = info.sessionId ?? `agent:${randomUUID()}`;
		const previous = pauseWaiters.get(sessionId);
		if (previous) releaseWaiter(previous, "replaced"); // 同会话重复进入(理论不会) ⇒ 先放行旧的, 防悬挂
		const w = {
			sessionId,
			agent: info.agent,
			session: info.session,
			step: info.step,
			turn: info.turn,
			signal: info.signal,
			since: new Date().toISOString(),
			nextOffpeakAt: info.nextAt ? info.nextAt.toISOString() : null, // 平峰手动暂停无 ETA
			windowText: currentPeakWindowText(info.windowsNow),
			synthetic: info.synthetic === true,
			degraded: info.degraded === true,
			mode: info.mode === "offpeak" ? "offpeak" : "peak",
			released: false,
			resolve: null,
			abortHandler: null
		};
		const promise = new Promise((resolve) => { w.resolve = resolve; });
		pauseWaiters.set(sessionId, w);
		ensurePauseTimer();
		// 状态下发: 进入暂停 (v0.11.0 ⇒ 经既有 appendQueueBanner → banner-kit.emit; 可见性失败绝不影响暂停本身)
		try {
			appendQueueBanner(info.session, {
				state: "warn",
				cardKey: pauseCardKey(sessionId), // ★批一 b.2: 暂停/恢复共用稳定身份 ⇒ 同一张卡原地更新（常留不收起）
				title: w.mode === "offpeak"
					? `⏸ 已暂停 · 等待你确认（平峰手动暂停）（第 ${w.step} 步后）`
					: `⏸ 已暂停 · 高峰窗口 ${w.windowText} · 预计 ${beijingHm(info.nextAt)} 继续（第 ${w.step} 步后）${w.degraded ? "（时段库不可用：保守暂停 10 分钟后重判）" : (w.synthetic ? "（debug 模拟低谷边界）" : "")}`,
				lines: w.mode === "offpeak"
					? ["平峰手动暂停：**不会自动继续**，请在提问卡里选择（等待期零 token）", "或 /queue pause off 关闭自动暂停以恢复"]
					: ["等待期零 token（下一步的 LLM 请求已挡住）", "立即继续: 提问卡选「继续到本回合结束」, 或 /queue pause off; 查看: /queue pause"]
			});
		} catch { /* 横幅失败不影响暂停 */ }
		void appendDiag({ event: "pause.enter", sessionId: shortSession(sessionId), step: w.step, turn: w.turn, nextOffpeakAt: w.nextOffpeakAt, window: w.windowText, syntheticNext: w.synthetic, degraded: w.degraded, mode: w.mode });
		// 提问卡: 每会话每高峰窗口最多一次
		const key = `${sessionId}:${windowKey(info.windowsNow)}`;
		if (!pauseAsked.has(key)) { pauseAsked.set(key, Date.now()); askPauseChoice(w); }
		// abort (用户点停止) 立即释放; 轮询器只作兜底
		try {
			if (info.signal && typeof info.signal.addEventListener === "function") {
				w.abortHandler = () => releaseWaiter(w, "abort");
				info.signal.addEventListener("abort", w.abortHandler);
				if (info.signal.aborted) releaseWaiter(w, "abort");
			}
		} catch { /* 无 signal 能力 ⇒ 靠轮询 */ }
		void appendDiag({ event: "pause.handoff.begin", sessionId: shortSession(sessionId), step: w.step, turn: w.turn, mode: w.mode });
		await promise;
		void appendDiag({ event: "pause.handoff.done", sessionId: shortSession(sessionId), step: w.step, turn: w.turn, releasedReason: w.releasedReason });
	}

	/**
	 * 闸门评估 (返回即"可以放行"): 触发条件见文首冻结契约。
	 * 任一条件不满足 ⇒ 记 skip diag 并立即返回 (调用方随即 next())。
	 */
	async function pauseGate(payload) {
		const sessionId = payload?.agent?.session?.id ? String(payload.agent.session.id) : null;
		const step = Number(payload?.step) || 1;
		const turn = Number(payload?.turn) || 0;
		const messages = payload?.messages;
		const mode0 = await readMode();
		const windowsNow = await resolveWindows();
		// 时段边界自动管理 (每 epoch 一次; 未跨边界返回 null ⇒ 沿用现值)
		// P6.3: 加**超时兜底** —— 策略要读窗口/写盘, 绝不允许把闸门(进而 next())拖住; 超时即沿用现值并记诊断
		let policy = null;
		try {
			policy = await Promise.race([
				syncPausePolicy(),
				new Promise((r) => { const t = setTimeout(() => r("timeout"), 2500); t?.unref?.(); })
			]);
		} catch { policy = null; }
		if (policy === "timeout") void appendDiag({ event: "pause.policy-timeout", sessionId: shortSession(sessionId) });
		const mode = (policy && policy !== "timeout") ? policy : mode0;
		// v0.11.0: 时段判定库未接入 ⇒ 如实记一条 (时段按"保守高峰"; 绝不静默失效)
		const ctHealth = costTierHealth();
		if (!ctHealth.loaded) void appendDiag({ event: "pause.cost-tier-unavailable", reason: ctHealth.reason ?? "not-warmed", sessionId: shortSession(sessionId) });
		// v0.10.0 真并列: **不再要求 enabled** —— 错峰出行关着时"自动暂停"照样生效
		if (mode.pause === false) return diagSkip(sessionId, "pause-off");
		if (sessionId && mode.pauseExempt?.[sessionId]) return diagSkip(sessionId, "pause-exempt");
		if (sessionId && mode.exempt?.[sessionId]) return diagSkip(sessionId, "exempt");
		if (sessionId && pauseTurnAllow.has(`${sessionId}:${turn}`)) return diagSkip(sessionId, "turn-allowed");
		if (step < 2) return diagSkip(sessionId, "step1");                                  // 规则①: 第一步永不拦
		if (!Array.isArray(messages) || messages.length !== 0) return diagSkip(sessionId, "has-messages"); // 规则①: 本步有消息不拦
		const now = new Date();
		const peakNow = peakAtMs(mode, windowsNow, now.getTime());
		let nextAt = null, synthetic = false;
		if (peakNow) {
			// 高峰中停: 等低谷 (debug=peak 时合成"模拟低谷边界"); 距低谷不足 5min ⇒ 不暂停
			const r = effectiveNextOffpeak(mode, windowsNow, now);
			nextAt = r.at; synthetic = r.synthetic;
			if (!nextAt || nextAt.getTime() - now.getTime() < PAUSE_MIN_LEAD_MS) return diagSkip(sessionId, "min-lead");
		}
		// 平峰手动暂停: **立刻停**, 无 min-lead、不等低谷, 提问卡是唯一放行路径
		await waitForPause({ sessionId, agent: payload?.agent ?? null, session: payload?.agent?.session ?? null, step, turn, signal: payload?.signal, nextAt, synthetic, degraded: !ctHealth.loaded, mode: peakNow ? "peak" : "offpeak", windowsNow });
	}

	/** RPC 统一返回体: 注入闸门自检结果 (坑 19: 闭包变量必须显式传参, 不用模块级 helper 读闭包) */
	const modeOut = (mode, windows) => modeValue(mode, windows, windowSource, pauseSummary(), pauseGateReason === null);

	// 安装自检 (路径级降级): pre-step 订不上 ⇒ **只停用"高峰暂停"这一条路径**, 其余功能照旧。
	try {
		if (typeof ctx.on !== "function") throw new Error("ctx.on 不可用");
		// ⚠️ 必须带 { global: true }: cordis dispatch 对非 global 订阅做**作用域过滤** ⇒ 本插件作用域外的
		// agent(pre-step 属于 agent 自己的作用域) 事件根本不会到达本 handler —— 表现为"闸门装上了但从不触发"
		// (VM 真机实测: turn 跑完也无任何 pause.* diag)。本插件既有观察者(session/event、inbox/claimed)同法。
		ctx.on("agent/pre-step", async (payload, next) => {
			try {
				if (!pauseGateReason) await pauseGate(payload);
			} catch (err) {
				// 规则② fail-open: 闸门内任何异常立即放行 (绝不阻塞、绝不吞消息)
				void appendDiag({ event: "pause.skip", reason: "error", error: String(err?.message ?? err) });
			}
			// P6: 释放后必须"纯内存置位 + 立即 next()" —— next() 不得跨任何锁/网络/文件 IO
			// ★批一 b.6: 此处不再记 `pause.handoff.next`（原实现每个 step≥2 都记一条 ⇒ 每会话每步刷屏）；
			//   真实交接的 `pause.handoff.next` 已移到 releaseWaiter 释放点（只在等待者被放行时记一条）。
			return next(); // ⚠️ next() 恰好调用一次 (暂停/放行两条路径都走这里)
		}, { global: true });
		ctx.effect(() => () => { if (pauseTimer) { clearInterval(pauseTimer); pauseTimer = null; } });
	} catch (err) {
		pauseGateReason = String(err?.message ?? err);
		void appendDiag({ event: "pause.install-failed", reason: pauseGateReason });
		ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 高峰暂停闸门未安装 — ${pauseGateReason} (仅暂停路径停用; 入队/派发/豁免等其余功能照旧)`);
	}
	// 准入红线② (路径级 SKIPPED, 如实标注): 暂停闸门/提问卡/横幅/时段库的降级必须写进适配状态 note ——
	//   否则面板显示 OK 而"高峰暂停"这条路径其实是坏的 (= 禁止的"报 OK 而功能坏")。
	try {
		const uqOk = (() => { try { return typeof ctx.get?.("userQuestions")?.ask === "function"; } catch { return false; } })();
		const extra = [];
		if (pauseGateReason) extra.push(`高峰暂停: 未安装(${pauseGateReason})`);
		if (!uqOk) extra.push("提问卡降级为自动暂停");
		if (capBlocked.includes("eventTypeRegistry")) extra.push("无横幅但暂停仍生效");
		const ctH = costTierHealth();
		if (!ctH.loaded) extra.push(`时段判定(cost-tier) 未接入(${ctH.reason ?? "not-warmed"}) ⇒ 按保守高峰`);
		if (extra.length) reportDegraded?.("高峰暂停", extra.join(" · "));
	} catch { /* 上报失败不影响功能 */ }

	// ---------- 命令 ----------
	ctx.commands.register({
		name: "queue",
		description: "任务队列: 入队等低谷自动执行 / 指定时间 / 查看修改取消",
		input: { hint: "add [--at \"HH:mm\"] <内容> | list | cancel <id> | edit <id> <内容> | run-now <id> | target [会话id]" },
		handler: async (invocation) => {
			const raw = (invocation?.rawInput ?? "").trim();
			const parts = raw.split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();
			const rest = raw.slice(parts[0]?.length ?? 0).trim();

			switch (sub) {
			case "add": {
				let at = null;
				let on = null;
				let content = rest;
				const atMatch = /^--at\s+("[^"]*"|'[^']*'|\S+)\s*(.*)$/.exec(rest);
				const onMatch = /^--on\s+("[^"]*"|'[^']*'|\S+)\s*(.*)$/.exec(rest);
				// v0.6.1: -r = --on restart 的单横线简写 (iOS 上 -- 难输入); 无需再打 restart
				const rMatch = /^-r\s+(.*)$/.exec(rest);
				if ((atMatch && onMatch) || ((atMatch || onMatch) && rMatch)) return { kind: "error", text: "--at / --on / -r 只能同时用一个" };
				if (atMatch) {
					at = parseAt(atMatch[1].replace(/^["']|["']$/g, ""));
					content = atMatch[2];
				} else if (onMatch) {
					on = onMatch[1].replace(/^["']|["']$/g, "");
					content = onMatch[2];
				} else if (rMatch) {
					on = "restart";
					content = rMatch[1];
				}
				if (!content || /^(?:--at|--on|-r)$/.test(rest.trim())) return { kind: "error", text: "用法: /queue add [--at \"HH:mm\" | --on restart | -r] <内容>" };
				if (rest.includes("--at") && !at) return { kind: "error", text: "--at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)" };
				if (on !== null && on !== "restart") return { kind: "error", text: "--on/-r 目前仅支持 restart (容器重启后派发)" };
				return await mutateState(async (state) => {
					const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
					// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
					const r = await enqueueTask({ state, id, content, at, when: on, agent: invocation?.agent });
					return { kind: "success", text: withCardLine(`任务 #${r.id} 已入队`, r.id, "已入队") };
				});
			}
			case "list": {
				const state = await readState();
				const pending = state.tasks.filter((t) => t.status === "pending");
				const queued = state.tasks.filter((t) => isQueuedSending(t)); // v0.5.0: 已派发未执行也算排队中
				const rest2 = state.tasks.filter((t) => t.status !== "pending" && !isQueuedSending(t));
				const queueN = pending.length + queued.length;
				const windowsNow = await resolveWindows();
				const modeNow = await readMode();
				const peak = effectivePeak(modeNow, windowsNow);
				// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
				appendQueueBanner(invocation?.agent?.session, {
					// ★(乙) T18 键1（2026-09-20 用户已签）：带上**宿主发放的同源标识** `commandId`
					//   —— 宿主一处铸造、三处同用（`dsh-commands/lib/index.js:308 mintCommandId` ⇒ `command/run` `:309` / `invocation` `:359` / `command/done` `:316`/`:379`），
					//   并自带不变量校验（`invariant.js:24`）⇒ **与 `command/done.data.commandId` 逐字同值**。
					//   ⚠️ **仍不传 `anchorSeq`**（不推宿主 seq，`计划.md:30` 不变）。
					commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
					// #A247 三 已裁（C）：命令面（/queue …）在事件流里只发 command/run + command/done、**不发 tool/call**（320 会话实测 name=="queue" 的 tool/call = 0）⇒ 缓存拿不到其自身 seq；naive 传 anchorSeqFor 会错锚到上一次队列工具调用 ⇒ 暂不传（待裁项）
					openPanel: true,
					title: `任务队列 · 排队中 ${queueN} 个`,
					uniq: true,
					lines: [
						queueN === 0
							? "(队列为空)"
							: `排队中 ${queueN} 个 / 历史 ${rest2.length} 个`,
						`时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}`,
						"任务列表见下方面板: 点行展开可 编辑/取消/立即派发 (已派发未执行的也可取消)"
					]
				});
				return { kind: "success", text: withCardLine(`任务队列: ${queueN} 排队中 / ${rest2.length} 历史 (详情见横幅面板)`, null, "队列列表") };
			}
			case "cancel": {
				const id = parseInt(rest, 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue cancel <id>" };
				return await mutateState(async (state) => {
					const r = await cancelTask(state, id);
					if (r.kind === "error") return r;
					// v0.4.2: 取消反馈注入横幅卡片 (完整内容)
					const t = state.tasks.find((x) => x.id === id);
					appendQueueBanner(invocation?.agent?.session, {
					// ★(乙) T18 键1（2026-09-20 用户已签）：带上**宿主发放的同源标识** `commandId`
					//   —— 宿主一处铸造、三处同用（`dsh-commands/lib/index.js:308 mintCommandId` ⇒ `command/run` `:309` / `invocation` `:359` / `command/done` `:316`/`:379`），
					//   并自带不变量校验（`invariant.js:24`）⇒ **与 `command/done.data.commandId` 逐字同值**。
					//   ⚠️ **仍不传 `anchorSeq`**（不推宿主 seq，`计划.md:30` 不变）。
					commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
						// #A247 三 已裁（C）：命令面（/queue …）在事件流里只发 command/run + command/done、**不发 tool/call**（320 会话实测 name=="queue" 的 tool/call = 0）⇒ 缓存拿不到其自身 seq；naive 传 anchorSeqFor 会错锚到上一次队列工具调用 ⇒ 暂不传（待裁项）
						taskId: id,
						title: `任务 #${id} 已取消`,
						uniq: true,
						lines: t ? [`内容: ${t.content}`] : []
					});
					return { kind: "success", text: withCardLine(r.text, (typeof id !== "undefined" ? id : null), "已取消") };
				});
			}
			case "edit": {
				const m = /^(\d+)\s+(.+)$/.exec(rest);
				if (!m) return { kind: "error", text: "用法: /queue edit <id> <新内容>" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === parseInt(m[1], 10) && x.status === "pending");
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${m[1]}` };
					t.content = m[2];
					// v0.4.2: 修改反馈注入横幅卡片 (完整新内容)
					appendQueueBanner(invocation?.agent?.session, {
					// ★(乙) T18 键1（2026-09-20 用户已签）：带上**宿主发放的同源标识** `commandId`
					//   —— 宿主一处铸造、三处同用（`dsh-commands/lib/index.js:308 mintCommandId` ⇒ `command/run` `:309` / `invocation` `:359` / `command/done` `:316`/`:379`），
					//   并自带不变量校验（`invariant.js:24`）⇒ **与 `command/done.data.commandId` 逐字同值**。
					//   ⚠️ **仍不传 `anchorSeq`**（不推宿主 seq，`计划.md:30` 不变）。
					commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
						// #A247 三 已裁（C）：命令面（/queue …）在事件流里只发 command/run + command/done、**不发 tool/call**（320 会话实测 name=="queue" 的 tool/call = 0）⇒ 缓存拿不到其自身 seq；naive 传 anchorSeqFor 会错锚到上一次队列工具调用 ⇒ 暂不传（待裁项）
						taskId: t.id,
						title: `任务 #${t.id} 内容已更新`,
						uniq: true,
						lines: [`新内容: ${t.content}`]
					});
					return { kind: "success", text: withCardLine(`任务 #${t.id} 内容已更新`, t.id, "内容已更新") };
				});
			}
			case "run-now": {
				// E6: 历史/终态任务只允许人工强制重排 (--force); 自动路径永远不会重放历史
				const force = /(^|\s)--force(\s|$)/.test(rest);
				const id = parseInt(rest.replace(/--force/g, "").trim(), 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue run-now <id> [--force]  (--force = 人工重新派发历史/终态任务)" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && (x.status === "pending" || force));
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${id} (历史/终态任务需 --force)` };
					if (t.status !== "pending") requeueForManualForce(t);
					if (isTaskLocked(state, t)) return { kind: "error", text: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` };
					const agent = await findTargetAgent(state, t);
					if (!agent) return { kind: "error", text: "任务绑定会话已离线且无兜底会话, 稍后再试" };
					await dispatchTask(state, t, agent, { force: true });
					// v0.4.2: 派发反馈注入横幅卡片 (完整内容)
					appendQueueBanner(invocation?.agent?.session, {
					// ★(乙) T18 键1（2026-09-20 用户已签）：带上**宿主发放的同源标识** `commandId`
					//   —— 宿主一处铸造、三处同用（`dsh-commands/lib/index.js:308 mintCommandId` ⇒ `command/run` `:309` / `invocation` `:359` / `command/done` `:316`/`:379`），
					//   并自带不变量校验（`invariant.js:24`）⇒ **与 `command/done.data.commandId` 逐字同值**。
					//   ⚠️ **仍不传 `anchorSeq`**（不推宿主 seq，`计划.md:30` 不变）。
					commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
						// #A247 三 已裁（C）：命令面（/queue …）在事件流里只发 command/run + command/done、**不发 tool/call**（320 会话实测 name=="queue" 的 tool/call = 0）⇒ 缓存拿不到其自身 seq；naive 传 anchorSeqFor 会错锚到上一次队列工具调用 ⇒ 暂不传（待裁项）
						taskId: id,
						title: `任务 #${id} 已派发`,
						uniq: true,
						lines: [`内容: ${t.content}`, `派发到: ${shortSession(agent.id)}`]
					});
					return { kind: "success", text: withCardLine(`任务 #${id} 已立即派发到 ${shortSession(agent.id)}`, id, "已派发") };
				});
			}
			case "target": {
				if (!rest) {
					const state = await readState();
					return { kind: "success", text: `兜底派发目标会话: ${state.targetSessionId ? shortSession(state.targetSessionId) : "未设置(任务默认派发回创建它的会话)"}` };
				}
				return await mutateState(async (state) => {
					state.targetSessionId = rest;
					return { kind: "success", text: `兜底派发目标会话已设为 ${rest}` };
				});
			}
			// v0.8.3 debug: 强制当前时段 (平峰期实测错峰功能; 客户端拦截与服务端派发同口径)
			case "debug": case "forcepeak": {
				const arg = rest.trim().toLowerCase();
				const cur = await readMode();
				if (!arg) {
					return { kind: "success", text: `当前强制时段: ${cur.debug}${cur.debug === "auto" ? " (按官方页判定)" : ""}\n用法: /queue debug peak | offpeak | auto` };
				}
				if (!DEBUG_VALUES.includes(arg)) {
					return { kind: "error", text: `用法: /queue debug peak | offpeak | auto (当前: ${cur.debug})` };
				}
				await patchMode({ debug: arg }); // P1: 收窄写 (绝不手列键集重建 mode)
				await appendDiag({ event: "mode.debug", debug: arg, via: "slash" });
				if (arg === "offpeak") releaseAllForReason("debug-offpeak"); // ★批一 b.2: 强制平峰 ≠ 真实低谷 ⇒ 独立原因码（文案如实）
				const windowsNow = await resolveWindows();
				const peak = effectivePeak({ ...cur, debug: arg }, windowsNow);
				const label = arg === "peak" ? "强制高峰" : arg === "offpeak" ? "强制平峰" : "自动(官方页判定)";
				return { kind: "success", text: [
					`已设置: ${label} (debug=${arg})`,
					arg === "peak" ? "→ 客户端: 高峰时段消息自动入队; 服务端: 队列暂停派发" :
						arg === "offpeak" ? "→ 客户端: 消息正常直发; 服务端: 到期任务立即派发" :
							`→ 恢复官方页判定: 当前${peak ? "高峰" : "平峰"} (${windowSource})`,
					"恢复: /queue debug auto"
				].join("\n") };
			}
			// v0.9.0 高峰暂停 (子开关): 高峰时把**正在跑的回合**停在当前步骤结束后, 阻塞到低谷自动继续
			//   (不是 abort, 等待期零 token)。无参 = 查看暂停中的会话/开始时刻/恢复时刻/下一低谷。
			case "pause": {
				const arg = rest.trim().toLowerCase();
				if (arg === "on" || arg === "off") {
					const cur = await readMode();
					const pause = arg === "on";
					// v0.10.0: 命令切 pause = **手动覆盖** (记 pauseManual); P1: 收窄写
					await patchMode({ pause, pauseManual: pause });
					await appendDiag({ event: pause ? "pause.switch-on" : "pause.switch-off", via: "slash", pauseManual: pause });
					if (!pause) releaseAllForReason("pause-off");
					return { kind: "success", text: [
						`高峰暂停(全局)已${pause ? "开启" : "关闭"} (offpeak-mode.json 的 pause=${pause})`,
						pause ? "高峰时段正在跑的回合会停在步骤边界, 到低谷自动继续" : "等待中的回合已立即恢复执行; 其余错峰功能不变"
					].join("\n") };
				}
				if (arg && arg !== "status") return { kind: "error", text: `用法: /queue pause [on|off|status] (当前: ${arg})` };
				const mode = await readMode();
				const ws = await resolveWindows();
				const sum = pauseSummary();
				const nx = effectiveNextOffpeak(mode, ws);
				const nextAt = nx.at;
				const ex1 = Object.keys(mode.exempt ?? {}).filter((k) => mode.exempt[k]);
				const ex2 = Object.keys(mode.pauseExempt ?? {}).filter((k) => mode.pauseExempt[k]);
				const ctH = costTierHealth();
				return { kind: "success", text: [
					`暂停闸门: ${pauseGateReason === null ? "已安装" : `未安装(${pauseGateReason})`}`,
					`自动暂停(G2, 全局): ${mode.pause === false ? "关" : "开"}${mode.pauseManual === null ? " (自动管理)" : ` (手动覆盖 pauseManual=${mode.pauseManual})`} · 时段纪元 epoch=${mode.pauseEpoch ?? "—"}`,
					`当前时段: ${effectivePeak(mode, ws) ? "高峰" : "平峰"} (${peakSourceText(mode, windowSource)}) · 高峰窗口 ${(ws?.windows ?? []).map(([s, e]) => `${String(s).padStart(2, "0")}:00-${String(e).padStart(2, "0")}:00`).join(" ")}`,
					`时段判定库: ${ctH.loaded ? "已接入(@ericality/dsh-cost-tier, 含节假日表)" : `未接入 ⇒ 按保守高峰 (${ctH.reason ?? "not-warmed"})`}`,
					`暂停中的回合: ${sum.count} 个`,
					...sum.sessions.map((s) => `  · ${shortSession(s.sessionId)}: 自 ${beijingHm(new Date(s.since))} 起暂停 (第 ${s.step} 步后, ${s.mode === "offpeak" ? "平峰手动暂停·等你确认" : `预计 ${beijingHm(new Date(s.nextOffpeakAt))} 恢复`})`),
					`错峰豁免(S1) 会话: ${ex1.length ? ex1.map(shortSession).join(", ") : "无"}`,
					`暂停豁免(S2) 会话: ${ex2.length ? ex2.map(shortSession).join(", ") : "无"}`,
					`下一个低谷: ${nextAt ? beijingHm(nextAt) : "—"}${nx.synthetic ? "（debug 模拟低谷边界）" : ""} (距不足 5 分钟则不暂停)`,
					"用法: /queue pause on | off | status"
				].join("\n") };
			}
			case "help": case "":
				return { kind: "success", text: [
					"/queue add <内容>                   入队(绑当前会话), 等低谷自动执行",
					"/queue add --at \"HH:mm\" <内容>    指定时间执行 (HH:mm 或 YYYY-MM-DD HH:mm)",
					"/queue add --on restart <内容>     容器重启后、到低谷时段自动执行 (v0.8.5 遵循错峰; 每次重启尝试一次, 失败等下次重启)",
					"/queue add -r <内容>               同 --on restart (iOS 单横线简写)",
					"/queue list                         查看队列(含各任务绑定会话)",
					"/queue cancel <id>                  取消任务(排队中/已派发未执行的均可取消)",
					"/queue edit <id> <新内容>           修改任务内容",
					"/queue run-now <id>                 立即派发(不等低谷)",
					"/queue target [会话id]              查看/设置兜底派发目标会话",
					"/queue debug peak|offpeak|auto      强制当前时段 (调试: 平峰期实测错峰功能)",
					"/queue pause [on|off|status]        高峰暂停: 高峰期把正在跑的回合停在步骤边界, 到低谷自动继续 (默认开)",
					"/queue help                         本帮助",
					"低谷时段由官方页动态解析(当前: 周一至周五 9-12/14-18 高峰, 其余低谷)"
				].join("\n") };
			default:
				return { kind: "error", text: "未知子命令, 用 /queue help 查看用法" };
			}
		}
	});

	// ---------- 模型工具 (不依赖客户端斜杠命令, 自然语言即可调用) ----------
	ctx.tools.register(defineTool({
		name: "queue_add",
		description: "把任务加入低谷时段任务队列(任务绑定当前会话执行): 默认等官方低谷价时段(动态解析官方页)自动派发到当前会话执行, 也可用 at 指定时间(北京时区 HH:mm 或 YYYY-MM-DD HH:mm), 或用 when=\"restart\" 指定容器重启后(且在低谷时段)自动派发",
		parameters: {
			content: { type: "string", required: true, description: "任务内容" },
			at: { type: "string", description: "可选指定时间: HH:mm 或 YYYY-MM-DD HH:mm (北京时区)" },
			when: { type: "string", description: "可选发送时机: restart=容器重启后自动派发 (v0.8.5 起同样遵循错峰: 重启发生在高峰时等到低谷再执行; 每次重启尝试一次, 失败等下次重启; 默认缺省=等低谷时段自动派发)" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "integer", required: true },
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const at = args.at ? parseAt(args.at) : null;
			if (args.at && !at) throw new Error("at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)");
			if (args.when && args.when !== "restart") throw new Error("when 仅支持 restart (容器重启后派发)");
			return await mutateState(async (state) => {
				const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
				// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
				const r = await enqueueTask({ state, id, content: args.content, at, when: args.when, agent: exec?.agent });
				return { id: r.id, text: `任务 #${r.id} 已入队` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "加入任务队列", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_list",
		description: "查看任务队列(排队中任务及各自绑定会话/历史/兜底目标会话/当前高峰窗口来源)",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (_args, exec) => {
			const state = await readState();
			const windowsNow = await resolveWindows();
			const modeNow = await readMode();
			const peak = effectivePeak(modeNow, windowsNow);
			const pending = state.tasks.filter((t) => t.status === "pending");
			const queued = state.tasks.filter((t) => isQueuedSending(t)); // v0.5.0
			const done = state.tasks.filter((t) => t.status !== "pending" && !isQueuedSending(t));
			const queueN = pending.length + queued.length;
			// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
			appendQueueBanner(exec?.agent?.session, {
				anchorSeq: anchorSeqFor(exec?.agent?.session),
				openPanel: true,
				title: `任务队列 · 排队中 ${queueN} 个`,
				lines: [
					queueN === 0
						? "(队列为空)"
						: `排队中 ${queueN} 个 / 历史 ${done.length} 个`,
					`时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}`,
					"任务列表见下方面板: 点行展开可 编辑/取消/立即派发 (已派发未执行的也可取消)"
				]
			});
			return { text: withCardLine(`任务队列: ${queueN} 排队中 / ${done.length} 历史 (时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}, 详情见横幅面板)`, null, "队列列表") };
		},
		presentCall: () => ({ card: "generic", title: "查看任务队列", kind: "other" })
	}));

	ctx.tools.register(defineTool({
		name: "queue_cancel",
		description: "取消任务(按 id; 排队中的, 或已派发但派发消息仍在目标会话排队未执行的均可取消, 已开始执行的无法取消)",
		parameters: { id: { type: "integer", required: true, description: "任务 id" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			return await mutateState(async (state) => {
				const r = await cancelTask(state, args.id);
				if (r.kind === "error") throw new Error(r.text);
				// v0.4.2: 取消反馈注入横幅卡片 (完整内容)
				const t = state.tasks.find((x) => x.id === args.id);
				appendQueueBanner(exec?.agent?.session, {
					anchorSeq: anchorSeqFor(exec?.agent?.session),
					taskId: args.id,
					title: `任务 #${args.id} 已取消`,
					lines: t ? [`内容: ${t.content}`] : []
				});
				return { text: withCardLine(r.text, (typeof id !== "undefined" ? id : null), "已取消") };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "取消任务", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_edit",
		description: "修改排队中任务的内容(按 id)",
		parameters: {
			id: { type: "integer", required: true, description: "任务 id" },
			content: { type: "string", required: true, description: "新内容" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				t.content = args.content;
				// v0.4.2: 修改反馈注入横幅卡片 (完整新内容)
				appendQueueBanner(exec?.agent?.session, {
					anchorSeq: anchorSeqFor(exec?.agent?.session),
					taskId: t.id,
					title: `任务 #${t.id} 内容已更新`,
					lines: [`新内容: ${t.content}`]
				});
				return { text: withCardLine(`任务 #${t.id} 内容已更新`, t.id, "内容已更新") };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "修改任务", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_runnow",
		description: "立即派发排队中的任务(不等低谷时段, 按 id; force=true 才可人工重排历史/终态任务)",
		parameters: {
			id: { type: "integer", required: true, description: "任务 id" },
			force: { type: "boolean", description: "人工强制重新派发历史/终态任务 (E6: 自动路径永不重放历史; 缺省 false)" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const force = args.force === true;
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && (x.status === "pending" || force));
				if (!t) throw new Error(`未找到排队中的任务 #${args.id} (历史/终态任务需 force=true)`);
				if (t.status !== "pending") requeueForManualForce(t);
				if (isTaskLocked(state, t)) throw new Error(`任务 #${args.id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)`);
				const agent = await findTargetAgent(state, t);
				if (!agent) return { text: `任务 #${t.id} 绑定会话已离线且无兜底会话, 保持排队` };
				await dispatchTask(state, t, agent, { force: true });
				// v0.4.2: 派发反馈注入横幅卡片 (完整内容)
				appendQueueBanner(exec?.agent?.session, {
					anchorSeq: anchorSeqFor(exec?.agent?.session),
					taskId: t.id,
					title: `任务 #${t.id} 已派发`,
					uniq: true,
					lines: [`内容: ${t.content}`, `派发到: ${shortSession(agent.id)}`]
				});
				return { text: withCardLine(`任务 #${t.id} 已立即派发到 ${shortSession(agent.id)}`, t.id, "已派发") };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "立即派发任务", kind: "other", rawInput: args })
	}));

	// ---------- /queue RPC 通道 (v0.4.0) ----------
	// 浏览器端 client 插件 (dsh-notice-banner 队列面板) 通过框架通用 RPC
	// (ctx.connection.rpc.call("/queue", "<endpoint>", payload)) 直接读写队列,
	// 不走模型回合、零 token —— 解决"查看/修改任务列表不方便、修改无弹窗反馈"。
	// 通道信任策略与 /api 一致 (不传 authority → 沿用 client-connection 的
	// trustedHosts, 隧道/局域网域名均可访问)。端点:
	//   list   → { tasks: [...], pendingCount, peak, windowSource, targetSession* }
	//   edit   { id, content }   → 改排队中任务内容
	//   cancel { id }            → 取消
	//   runnow { id }            → 立即派发 (不等低谷; 编辑锁中阻止)
	//   editstart { id }         → 锁定任务 (客户端开始编辑, 防派发) (v0.4.3)
	//   editend { id }           → 释放锁 (保存/取消/卸载) (v0.4.3)
	// 返回 { ok: true, value } | { ok: false, error: { code, message } }。
	// options 传 {}: 不设 authority → register 用 this.trustedHosts (与 /api 同源
	// 信任列表, 隧道/局域网域名可访问); 传 { authority: "loopback" } 则只认回环。
	// ⚠️ options 不能省略: register 里直接读 options.authority, 缺参会 TypeError。
	const queueRpcHandler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "list": {
				const state = await readState();
				const windowsNow = await resolveWindows();
				const modeNow = await readMode();
				const peak = effectivePeak(modeNow, windowsNow);
				cleanupStaleLocks(state);
				const tasks = state.tasks.map((t) => ({
					id: t.id,
					content: t.content,
					status: t.status,
					statusText: STATUS_TEXT[t.status] ?? t.status,
					queuedSending: isQueuedSending(t), // v0.5.0: 已派发且消息仍在收件箱排队 (可撤回)
					createdAt: t.createdAt,
					scheduledAt: t.scheduledAt ?? null,
					trigger: t.trigger ?? null, // v0.6.0: "restart" = 容器重启后派发
					sessionShort: shortSession(t.sessionId),
					// ★批5 `T27`：RPC `list` 带上 `dropCause`（`"restart"`／`"removed"`／缺省 `null`）——
					//   消费侧**早已在位**（`dsh-notice-banner` 队列面板 `lib/client.js:2124`：`status==="cancelled" && dropCause==="restart"` ⇒ 标签「已取消 · 重启丢弃」）
					//   ⇒ 只增服务端一侧，**不改 notice-banner**；缺省 `null` 显式给键（形状恒在，`E22`）
					dropCause: t.dropCause ?? null,
					// ★批一 b.1: 等待文案按**实际投递目标会话**的 blocked 判定（不再只看全局时段）——
					//   面板显示的"等低谷/立即派发"必须与服务端真实派发决策同口径。
					whenText: t.trigger === "restart"
						? (t.armed === true
							? (isDispatchBlocked({ mode: modeNow, peakEff: peak, sessionId: t.sessionId ?? state.targetSessionId }) ? "重启后 · 等低谷" : "重启后 · 待派发")
							: "等待容器重启")
						: (t.scheduledAt
							? `定于 ${beijingNowString(new Date(t.scheduledAt)).slice(5, 16)}`
							: (isDispatchBlocked({ mode: modeNow, peakEff: peak, sessionId: t.sessionId ?? state.targetSessionId }) ? "等低谷" : "立即派发")),
					locked: isTaskLocked(state, t) // v0.4.3: 编辑锁标记 (客户端显示"编辑中")
				}));
				return { ok: true, value: {
					tasks,
					pendingCount: tasks.filter((t) => t.status === "pending").length,
					targetSessionId: state.targetSessionId,
					targetSessionShort: shortSession(state.targetSessionId),
					peak,
					windowSource,
					peakSource: peakSourceText(modeNow, windowSource),
					debug: modeNow.debug
				} };
			}
			case "edit": {
				const id = payload?.id;
				const content = typeof payload?.content === "string" ? payload.content.trim() : "";
				if (!Number.isInteger(id) || !content) {
					return { ok: false, error: { code: "bad-request", message: "需要 id(整数) 与 content(非空字符串)" } };
				}
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					t.content = content;
					if (state.locks) delete state.locks[id]; // 保存成功即释放编辑锁
					return { ok: true, value: { id: t.id, content: t.content } };
				});
			}
			case "cancel": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const r = await cancelTask(state, id);
					if (r.kind === "error") return { ok: false, error: { code: "not-found", message: r.text } };
					if (state.locks) delete state.locks[id];
					return { ok: true, value: { id, text: r.text } };
				});
			}
			case "runnow": case "run-now": {
				// E6: payload.force=true 才允许人工重排历史/终态任务 (面板按钮不带 force, 行为不变)
				// ★批一 b.3: `runnow` 为主端点；旧名 `run-now` 保留为**别名**（EPS 两者都注册，不破坏既有调用方）
				const id = payload?.id;
				const force = payload?.force === true;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && (x.status === "pending" || force));
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					if (t.status !== "pending") requeueForManualForce(t);
					if (isTaskLocked(state, t)) {
						return { ok: false, error: { code: "locked", message: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` } };
					}
					const agent = await findTargetAgent(state, t);
					if (!agent) return { ok: false, error: { code: "unavailable", message: "任务绑定会话已离线且无兜底会话, 稍后再试" } };
					await dispatchTask(state, t, agent, { force: true });
					// 段Q（#A117 §3 口径表 v3）：**面板按钮「立即派发」⇒ 独立卡**（唯一例外）。
					appendQueueBanner(agent?.session, {
						taskId: id,
						title: `任务 #${id} 已派发`,
						lines: [`内容: ${t.content}`, `派发到: ${shortSession(agent.id)}`],
						uniq: true
					});
					return { ok: true, value: { id, text: `任务 #${id} 已立即派发到 ${shortSession(agent.id)}` } };
				});
			}
			case "editstart": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					state.locks = state.locks ?? {};
					state.locks[id] = { sessionId: t.sessionId ?? null, since: new Date().toISOString() };
					return { ok: true, value: { id } };
				});
			}
			case "editend": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					if (state.locks) delete state.locks[id];
					return { ok: true, value: { id } };
				});
			}
			// ── v0.7.0 错峰出行模式 ────────────────────────────────────────────
			// mode.get    → { enabled, peak, windowSource, peakSource, debug, exempt } 开关 + 实时时段 + 豁免 map
			// mode.set    { enabled }                               持久化开关 (写 MODE_FILE, 保留 exempt/debug)
			// mode.exempt { sessionId, exempt } (v0.8.0)            单会话豁免切换 (高峰照常发送)
			// mode.debug  { debug: auto|peak|offpeak } (v0.8.3)     强制当前时段 (调试; 客户端拦截与服务端派发同口径)
			// diag        { event, ...} (v0.8.3)                    客户端诊断上报 (落 log/taskqueue/offpeak-debug.log)
			// diag.get    → { recent, file }                        回读最近诊断 (无控制台远程取证)
			// add         { content, sessionId }                    客户端拦截后入队 (绑指定会话,
			//                                                        与 queue_add 工具同路径, 零 token)
			case "mode.get": {
				await syncPausePolicy(); // 边界自动管理 (每 epoch 一次; UI 15s 轮询即能反映)
				const mode = await readMode();
				const windowsNow = await resolveWindows();
				return { ok: true, value: { ...modeOut(mode, windowsNow), diag: diagRecent.slice(-8) } };
			}
			case "mode.set": {
				// 缺省 = 不改动该字段; ⚠️ P1: 用 patchMode **收窄写**, 绝不手列键集重建 mode (会丢 pauseExempt/pauseEpoch)
				const patch = {};
				if (payload && Object.prototype.hasOwnProperty.call(payload, "enabled")) patch.enabled = payload.enabled === true;
				if (payload && Object.prototype.hasOwnProperty.call(payload, "pause")) {
					patch.pause = payload.pause !== false;
					patch.pauseManual = patch.pause; // v0.10.0: RPC/命令切 pause = **手动覆盖**
				}
				const { mode: next } = await patchMode(patch);
				if (next.pause === false) releaseAllForReason("pause-off");
				const windowsNow = await resolveWindows();
				return { ok: true, value: modeOut(next, windowsNow) };
			}
			case "mode.pause": {
				if (typeof payload?.pause !== "boolean") {
					return { ok: false, error: { code: "bad-request", message: "需要 pause(布尔)" } };
				}
				const { mode: next } = await patchMode({ pause: payload.pause, pauseManual: payload.pause }); // 手动覆盖 (收窄写)
				await appendDiag({ event: payload.pause ? "pause.switch-on" : "pause.switch-off", via: "rpc" });
				if (!payload.pause) releaseAllForReason("pause-off");
				const windowsNow = await resolveWindows();
				return { ok: true, value: modeOut(next, windowsNow) };
			}
			// v0.10.0: payload 支持 {sessionId, exempt?} 与 {sessionId, pauseExempt?} —— 两个会话级豁免同端点 (返回两者)
			case "mode.exempt": case "mode.pauseExempt": {
				const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
				if (!sessionId) {
					return { ok: false, error: { code: "bad-request", message: "需要 sessionId(当前会话)" } };
				}
				const cur = await readMode();
				const has1 = payload && Object.prototype.hasOwnProperty.call(payload, "exempt");
				const has2 = payload && Object.prototype.hasOwnProperty.call(payload, "pauseExempt");
				if (!has1 && !has2) return { ok: false, error: { code: "bad-request", message: "需要 exempt 或 pauseExempt(布尔)" } };
				if (has1) await setExemptMap(sessionId, payload.exempt === true);
				if (has2) {
					const m = { ...cur.pauseExempt };
					if (payload.pauseExempt === true) m[sessionId] = true; else delete m[sessionId];
					await patchMode({ pauseExempt: m }); // P1: 收窄写, 不整份回写
					// S2 打开 ⇒ 该会话已暂停的回合立即释放 (不等轮询)
					if (payload.pauseExempt === true) { const w = pauseWaiters.get(sessionId); if (w) releaseWaiter(w, "pause-exempt"); }
				}
				if (has1 && payload.exempt === true) { const w = pauseWaiters.get(sessionId); if (w) releaseWaiter(w, "exempt"); }
				await appendDiag({ event: "mode.exempt", via: "rpc", exempt: has1 ? payload.exempt === true : undefined, pauseExempt: has2 ? payload.pauseExempt === true : undefined, sessionId: shortSession(sessionId) });
				const windowsNow = await resolveWindows();
				return { ok: true, value: modeOut(await readMode(), windowsNow) };
			}
			// v0.8.3 强制时段 (debug): 平峰期实测错峰功能用 —— "peak" = 当作高峰(消息入队/队列不派发),
			// "offpeak" = 当作平峰(消息直发/到期任务立即派发), "auto" = 恢复官方页判定。
			case "mode.debug": {
				const debug = normalizeDebug(payload?.debug);
				const raw = typeof payload?.debug === "string" ? payload.debug : "";
				if (raw && debug === "auto" && raw !== "auto") {
					return { ok: false, error: { code: "bad-request", message: `debug 只接受 ${DEBUG_VALUES.join(" / ")}` } };
				}
				const cur = await readMode();
				await patchMode({ debug }); // P1: 收窄写 (绝不手列键集重建 mode)
				const windowsNow = await resolveWindows();
				await appendDiag({ event: "mode.debug", debug });
				if (debug === "offpeak") releaseAllForReason("debug-offpeak"); // ★批一 b.2: 强制平峰 ≠ 真实低谷 ⇒ 独立原因码
				return { ok: true, value: modeOut({ enabled: cur.enabled, exempt: cur.exempt, debug, pause: cur.pause }, windowsNow) };
			}
			// v0.8.3 客户端诊断: 错峰拦截器在浏览器里, 静默失效时无从取证 —— 客户端 apply/渲染/命中都上报。
			case "diag": {
				const event = typeof payload?.event === "string" ? payload.event.slice(0, 64) : "unknown";
				const rest = (payload && typeof payload === "object") ? { ...payload } : {};
				delete rest.event;
				await appendDiag({ event, ...rest });
				return { ok: true, value: { file: DIAG_LOG } };
			}
			case "diag.get": {
				return { ok: true, value: { recent: diagRecent.slice(-20), file: DIAG_LOG } };
			}
			// ── 批四: 派发文案配置（开头/结尾模板） ──────────────────────────
			// config.get → { settings:{prefix,suffix}, defaults, placeholders, limits, schemaVersion, source, warnings, invalid }
			// config.set {prefix?, suffix?} → { settings, warnings } | { ok:false, error }
			case "config.get": {
				const r = await readDispatchSettings();
				return { ok: true, value: {
					settings: r.settings,
					defaults: { ...DISPATCH_TEMPLATE_DEFAULTS },
					placeholders: DISPATCH_PLACEHOLDERS,
					limits: DISPATCH_TEMPLATE_LIMITS,
					schemaVersion: DISPATCH_SETTINGS_SCHEMA,
					source: r.source,
					warnings: r.warnings ?? [],
					invalid: r.ok ? null : r.reason
				} };
			}
			case "config.set": {
				const patch = {};
				if (payload && Object.prototype.hasOwnProperty.call(payload, "prefix")) patch.prefix = typeof payload.prefix === "string" ? payload.prefix : String(payload.prefix ?? "");
				if (payload && Object.prototype.hasOwnProperty.call(payload, "suffix")) patch.suffix = typeof payload.suffix === "string" ? payload.suffix : String(payload.suffix ?? "");
				if (!Object.keys(patch).length) return { ok: false, error: { code: "bad-request", message: "需要 prefix 或 suffix（字符串）" } };
				const r = await writeDispatchSettings(patch);
				if (!r.ok) return { ok: false, error: r.error };
				void appendDiag({ event: "dispatch.settings-set", fields: Object.keys(patch), prefixLen: r.settings.prefix.length, suffixLen: r.settings.suffix.length, warnings: (r.warnings ?? []).length });
				return { ok: true, value: { settings: r.settings, defaults: { ...DISPATCH_TEMPLATE_DEFAULTS }, warnings: r.warnings ?? [] } };
			}
			case "add": {
				const content = typeof payload?.content === "string" ? payload.content.trim() : "";
				const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
				if (!content) {
					return { ok: false, error: { code: "bad-request", message: "需要 content(非空字符串)" } };
				}
				if (!sessionId) {
					return { ok: false, error: { code: "bad-request", message: "需要 sessionId(当前会话)" } };
				}
				return await mutateState(async (state) => {
					const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
					// 绑客户端传来的会话: 先查 live agent (有则走完整入队含转正/横幅), 无则仅绑会话 id
					const agent = ctx.agents?.get?.(sessionId) ?? null;
					const r = await enqueueTask({ state, id, content, at: null, when: null, agent, sessionId });
					// v0.8.4: 回传 engaged (blank 会话已发转正确认 turn) —— 客户端诊断用, 也可远程确证防串台机制生效
					return { ok: true, value: { id: r.id, when: r.when, engaged: r.engaged === true } };
				});
			}
			default:
				return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: /queue RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	registerRpc("/queue", queueRpcHandler, {});
	/** ★ 批 4 件②（「丙」）：**仅"能力未就绪"才订阅** ⇒ 就绪后补注册（`registerRpc` 内部幂等打标 ⇒ 防 `duplicate`）。 */
	try {
		if (!capOk("rpcHandle")) {
			const sub = subscribeCompatReady(ctx, (reason, r) => {
				readySubState = r.ok ? "registered" : "failed";
				readySubReason = r.ok ? `就绪订阅触发(${reason}) ⇒ RPC 已补注册` : `就绪订阅触发(${reason}) ⇒ 补注册失败: ${r.reason}`;
				ctx.logger?.info?.(`dsh-taskqueue: ${readySubReason}`);
			}, () => registerRpc("/queue", queueRpcHandler, {}));
			readySubState = sub.state;
			readySubReason = sub.reason;
		}
	} catch (err) { readySubState = "failed"; readySubReason = `订阅接线异常: ${String(err?.message ?? err)}`; }

	// ---------- 会话标题工具 (v0.3.0) ----------
	// agent 发现本会话第一条消息是队列自动派发任务时, 可在回答时顺手把会话标题
	// 改成更贴切的标题 (用户需求: "agent 顺便把当前的会话标题修改成合适的标题")。
	ctx.tools.register(defineTool({
		name: "session_rename",
		description: "把当前会话的标题修改为指定标题 (固定标题, 不会再次被自动生成覆盖; 适合在队列自动派发任务等场景给会话起个贴切的名字)",
		parameters: { title: { type: "string", required: true, description: "新会话标题" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const session = exec?.agent?.session;
			if (!session) throw new Error("无法获取当前会话");
			const normalized = String(args.title ?? "").trim();
			if (!normalized) throw new Error("标题不能为空");
			// 优先走 sessionTitle 服务 (规范化 + 固定 + 取代在途自动生成), 退化则直接 append
			// (source=user + messageSeqs=[] 满足标题不变式: user 来源必须空 messageSeqs)。
			const titles = ctx.get?.("sessionTitle");
			if (titles?.rename) {
				const accepted = titles.rename(session, normalized);
				return { text: `会话标题已改为: ${accepted.title}` };
			}
			session.append("session/title", {
				title: normalized,
				messageSeqs: [],
				source: { kind: "user" }
			});
			return { text: `会话标题已改为: ${normalized}` };
		},
		presentCall: (args) => ({ card: "generic", title: "修改会话标题", kind: "other", rawInput: args })
	}));
}
