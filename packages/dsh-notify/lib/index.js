import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
/** ★批7 `T15`（`#A342`）：**稳定身份** `cardId`；缺身份输入 ⇒ 显式 `null`（不伪造）。
 *  ★段2 `B3`（2026-09-29）：身份 = **`(ns, sid)`** —— **不含 `turn`**（批7 的 `(sid,turn)` 是 bug：
 *  `notify` 卡语义 = **每会话 1 张、后卡覆盖**（`ctxKey: "notify-<turn>"` 只作位置键），
 *  ⇒ 带上 `turn` 会让 3 个回合渲染成 **3 张**（段0 已证必红）。 */
const _cardId = (ns, ...parts) => (parts.some((x) => x === null || x === undefined || x === "") ? null
	: createHash("sha256").update([ns, ...parts].join("|")).digest("hex").slice(0, 32));
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/notify/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "notify");
const COMPAT_DIR = process.env.DSH_COMPAT_DIR || joinPath(DSH_HOME, "plugin-data", "host-compat");
const LOG_DIR = joinPath(DSH_HOME, "logs", "notify");

/**
 * @deepseek-ai/dsh-notify (本地辅助插件, 非官方包)
 *
 * 任务完成推送通知, 两个通道可同时用:
 *   - Bark (支持多设备 Key): POST https://api.day.app/push
 *   - Synology Chat 机器人: POST 到外部收件 webhook (SYNO.Chat.External incoming)
 *
 * 触发: 每个 agent 回合 (turn/end) 结束时, 若回合耗时 >= minTurnMs (默认 60s,
 * 避免聊天短回复刷屏) 才推送。配置见 profile patch 的 notify 行;
 * 也支持环境变量 DSH_BARK_KEYS(逗号分隔) / DSH_SYNOLOGY_WEBHOOK_URL。
 *
 * 内容演进:
 * v0.2.0: 通知里带会话标题、本轮用户问题摘要、agent 答复摘要。
 * v0.3.0 (2026-08-24, 用户要求): 本地横幅不再与外部通知重复 —
 *   仅当 agent 回复含"新的总结信息"时, 才注入本地横幅 (【总结】展示)。
 * v0.4.0 (2026-08-26): 被中断回合 (容器重启) 在会话恢复时补推"回合被中断"通知 (幂等对账)。
 * v0.5.0 (2026-08-29, 用户要求): 群晖推送**完整问答内容** —
 *   - 去掉 60/100 字符截断, 问题/回复全文推送;
 *   - 代码层去除 Markdown 格式 (stripMarkdown), 推送纯文本, 不依赖 agent 另答;
 *   - Synology Chat 单条消息硬上限 2000 字符 → 按页分块 (composeSynologyPages),
 *     每条都带【问题】+ 页码 [x/N] + 会话短 id, 多个会话同时结束推送也不会混淆。
 * v0.5.1 (2026-08-29, 用户要求): **纯文本增强排版** — 群晖 Chat 不渲染 markdown,
 *   改用 emoji 标签 (📌标题 / ❓问题 / 🤖回复) + 全角分隔线 (━━━) 突出字段;
 *   修复分页**并发发送触发 entry.cgi 限流 (411) 丢页** → 改为逐页串行 + 1.5s 间隔;
 *   分页**优先在段落/换行边界切断** (cutAtBoundary), 避免长段落被拦腰截断。
 * v0.5.2 (2026-08-29, 用户要求): **提问回合通知** — agent 回复以提问结尾 (在等用户回应) 时,
 *   不受 minTurnMs 限制**无条件推送** (标题"DSH 需要你回应"), 不注入总结横幅, 也不重复推"任务完成"。
 * v0.5.3 (2026-08-29, 用户要求): **格式再设计 + 全局串行发送** —
 *   - 块首尾都用 34 个等号线 (=) 包裹; 块内去掉 [x/y] 页码, 多页无缝拼接
 *     (群晖 Chat 拼接短时间推送, 用等号线区分块即可);
 *   - emoji 换跨平台通用: ✅完成 / ❌中断 / ⁉️提问 放标题前, 👀 问题, 💡 回复, ➡️ 选项
 *     (回复中 markdown 列表行自动转 ➡️);
 *   - 问题↔回复之间保留 30 个 ─ 横向分隔线;
 *   - 续页 (截断部分) 直接发内容不加装饰, 页脚 (回合/用时/原因/会话) 放最后页结束等号前;
 *   - **通知发送全局 FIFO 串行**: 一个通知的所有页发完 (含 1.5s 限流间隔) 才发下一个,
 *     杜绝多会话/多回合通知交错导致的分页乱序 (用户 2026-08-29 确认)。
 * v0.5.4 (2026-08-29, 用户要求): **提问通知改为真实 asking 状态触发** —
 *   仅当 agent 调用 **ask_user_question 工具** (tool/call 事件, 前端渲染选择组件等用户回答)
 *   才推送「⁉️ DSH 需要你回应」; 问题/选项从工具参数解析, 选项转 ➡️ 行;
 *   不再用文本问句启发式 (isQuestionText) 判定 (普通问句结尾会误触发,
 *   用户 2026-08-29 实测困惑后确认); isQuestionText 函数保留但不再参与推送。
 *
 * v0.6.0 (2026-09-12, 用户要求 · 通知中枢 Stage 1): **多设备 + 类型路由 + group/level 规范 +
 *   设置卡** — 配置文件 $DSH_HOME/notify-hub.json (0600, dsh-notify 写 / auth-proxy 读),
 *   设备列表 (Bark 多台 + 群晖 Chat) + routeDefault + routes[type]; 类型枚举与 Bark
 *   group/level/isArchive 见下方 NOTIFY_TYPES (§2.2 冻结表);
 *   现有三处推送 (完成/提问/中断) 全部走 type=task.done, 分页逻辑不变;
 *   标题里冗余的 "DSH" 字样移除 (改由 Bark 的 "[DSH] " 前缀统一承载, 用户 2026-09-12 确认);
 *   新增已认证 RPC 通道 /notify-hub (get/saveDevice/deleteDevice/setRoutes/test) 与
 *   服务名 notifyHub (ctx.provide), 供设置卡与其它插件使用。
 *
 * v0.7.0 (2026-09-12, 用户裁定 · 通知设置整改): **独立 type + options + 显式关闭** —
 *   契约 docs/任务记录/2026-09-12-通知设置整改-契约v0.7.0.md (逐字实现):
 *   - 三处推送拆成独立 type: turn/end → task.done, ask_user_question → task.asking,
 *     重启补推 → task.interrupted (group 统一 DSH-任务 / level active); NOTIFY_TYPES 12 项
 *     全部带 hasProducer (false = 预留类型, 暂无生产者);
 *   - `routes[type] = []` **落盘保留** = 该 type 显式关闭 (零请求, 不回落默认) —— 本次唯一
 *     破坏性变更 (旧版把空数组当"未配置");
 *   - 新增 `options` { minTurnMs, bannerSummary, reconcile } + RPC `setOptions`;
 *     `get` 增补 options / effective / types[].hasProducer;
 *     minTurnMs 初值取 patch config.minTurnMs, 但运行期一律以 options 为准 (改完即时生效)。
 *
 * v0.8.2 (2026-09-13, 阶段 2 · 通知 hub 缺口 G3/G6/G7 + 契约 §10.1 动态化) ——
 *   ⚠️ package.json 的 version 仍为 0.8.1（**本阶段不 bump**；版本对齐由**阶段 3「发布 1.2 兼容版」**统一做）:
 *   - **G6 (RD-31) 插件间唯一入口**: `ctx.provide("notifyHub", { send, sendNotification: send })`
 *     —— `sendNotification(type, payload)` 是**插件间唯一入口** (生产者优先调 `sendNotification`,
 *     缺失时回退 `send`); `send` 为同函数别名, **additive, 行为逐字不变**;
 *   - **G3 (RD-33) 新 type `queue.failed`** (label 队列失败 / group DSH-队列 / level timeSensitive /
 *     hasProducer:true) ⇒ NOTIFY_TYPES 共 **14 项** (新增 1 项 / 原 13 项); 客户端兜底表同批加同一行;
 *   - **G1/G2 (RD-36)**: `cost.alert` / `queue.dispatched` / `queue.cancelled` 的 `hasProducer`
 *     `false → true` (服务端权威表 + 客户端兜底表同批; 生产者由 dsh-cost-guard / dsh-taskqueue 提供);
 *   - **G7 (RD-32) `sent:0` 上报**: `sendNotification` 在 `sent===0 && failed===0` 时**不改既有四键**
 *     (ok/sent/failed/results), 追加 `reason:"no-route"|"no-devices"` + 一行 `logger.warn` (含 type):
 *     有启用设备但路由解析为空 ⇒ `no-route`; 无启用设备 ⇒ `no-devices`;
 *   - **RD-50 (additive 第三态, 2026-09-13 生产实测返工)**: payload **既无 `pages` 也无 `body`** ⇒
 *     `reason:"no-content"`（**先判内容为空, 再判设备/路由**）。生产实况: `queue.*` 生产者只给了
 *     `{taskId,title,status,at}` ⇒ 零请求静默丢弃, 且旧实现误报 `no-route`（hub 里明明有 3 台 enabled 设备）。
 *     生产者**必须**带 `body` 或 `pages`;
 *   - **RD-37**: `@deepseek-ai/dsh-reconcile` 的**静态 import 已删除**, 改 `loadReconcile()` 动态
 *     `import()` + 缺则对账路径停用并上报 `reason:"reconcile"` (契约 §10.1/§10.2, 禁静态 import / 禁双路径)。
 *
 * v0.9.0 (2026-11-22, 用户令「用户允许完全自定义通知形式 然后我们能提供的文本用 {{}} 的形式提供占位」):
 *   - **模板系统**: hub 级 templates.{bark,synology}.{title,body} + 设备级 tplTitle/tplBody;
 *     继承顺序 **设备 override → 渠道默认 → legacy**; 全空 ⇒ 发送结果与 v0.8.x 逐字一致。
 *   - **31 个占位符** (`{{title}}`/`{{status}}`/`{{question}}`/`{{answer}}`/`{{body}}`/`{{sep*}}` 等);
 *     未知占位符原样保留 + 返回 note (不静默); 渲染后仍按群晖 2000 / Bark 3800 切分。
 *   - **Bark 渠道参数**: barkGroup/barkLevel/barkSound/barkIcon/barkIsArchive/barkTitlePrefix;
 *     默认图标 = DSH 大肥鱼 `https://example.com/dsh-icon-512.png` (可自定义; none/- 关闭)。
 *   - **RPC**: setTemplates / preview (零网络零写盘); get 增 templates/tplMeta/defaults;
 *     saveDevice 接受模板 2 键 + Bark 参数 6 键 (tplReset 只删本设备模板)。
 *   - **左栏页**: 客户端成对注册 sidebar.panellist + main (key=notify); 设置卡保留。
 *
 * v0.9.1 (2026-11-22, 用户更正「以模板化的方式去配置；没配置和初始状态就是两个通道各自一个模板，
 *   剩下的可以自己添加 然后自己配置」): **模板库模型** ——
 *   - hub.templates 改为数组 [{id,name,title,body}]；两条内置模板始终存在（bark-default/synology-default，
 *     正文 `{{body}}` 包装旧版组稿 ⇒ 初始外观与 v0.8.x 逐字一致）；可编辑、不可删除。
 *   - 每台设备 `templateId` 选一个模板（一个模板可多台共用、不限制 Bark/群晖）；未选 ⇒ 渠道内置默认。
 *   - 每设备 `tplTitle`/`tplBody` 高级覆盖仍保留，优先级最高。
 *   - RPC: saveTemplate / deleteTemplate / preview（setTemplates 保留为 v0.9.0 兼容别名）。
 *
 * v0.9.2 (2026-11-22, 用户更正「拆的不够细 title应该就是标题正文 emoji是另一个维度 然后我应该改的时候
 *   就能实时预览 而不是保存之后才能预览」): **维度拆分 + 实时预览** ——
 *   - `{{title}}` = 纯标题（去掉开头 emoji，如「任务完成 · 会话名」）；`{{titleFull}}` = 原样完整标题；
 *     `{{emoji}}` 是独立维度（模板 `emoji` 字段 > 通知类型 emoji）；内置 Bark 模板改为 `{{emoji}} {{title}}`。
 *   - 客户端模板编辑器/设备高级覆盖：输入即本地实时预览（不再等保存）；预览只填真实可获取字段
 *     （设备名/时间/类型/emoji/分隔符），标题/正文/问答等留空并在 notes 点名（不编造示例）。
 *   - `preview` RPC 同步改为真实上下文；客户端本地预览为主。
 *
 * 附带命令 /notify-test 用于验证各通道。
 * 通知发送是 fire-and-forget, 失败只记日志, 不影响任务。
 */
export const name = "dsh-notify";
export const inject = ["commands", "connection"];

// ================= host-compat 能力声明 (阶段 1 契约 §3; RD-1) =================
/** 本插件声明需要的能力 (§3 key; 必须与 package.json `dshCompat.seams` 集合相等 — RD-1)
 *  ★2026-10-05 obs3S7「通知标题退化成字面量 `会话`」修复（#A481）：**补申报 `sessionEvents`** ——
 *    它 ＝ 会话标题/用户提问/答复的**唯一读取面**（宿主 0.1.2-rc.1 起 `Session` 无 `events` 属性，
 *    只有 `snapshotEvents()`／`ownEvents()`）；缺它 ⇒ 标题**如实降级为会话短 id** ＋ 日志 ＋ 面板可见。
 *    §3 冻结键集**已含该 key**（`host-compat/seams.js:32-43`）⇒ **零契约变更、零新键**（复用现成资产）。 */
const REQUIRES = ["sessionEvents", "sessionAppend", "eventTypeRegistry", "rpcHandle", "commands"]; // `#A57`: 通道面优先 channelFace（fetch）；rpcHandle 仍作旧宿主回落，须申报
/** 缺这些能力 ⇒ BLOCKED (§3/D1: 缺失会写坏数据 — 未注册事件类型进会话日志 ⇒ 会话无法加载) */
/** 缺这些能力 ⇒ **路径级** BLOCKED (RD-20; 与 package.json `dshCompat.blocked` 同源, 此处仅为"读 package.json 失败"时的回退) */
const BLOCKED_FALLBACK = ["eventTypeRegistry"];
/** §3 key → §4 seam 函数名 (§4 v1 冻结面); 无 seam 的 key (§3 `commands`, RD-10) 走宿主服务存在性 */
const SEAM_OF = { sessionAppend: "appendNotice", eventTypeRegistry: "ensureEventTypes", rpcHandle: "rpcHandle" };
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
		ctx.logger?.warn?.(`dsh-notify: 适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

export const Config = z.object({
	barkKeys: z.array(z.string()).default([]),
	synologyWebhookUrl: z.string().default(""),
	minTurnMs: z.number().default(60000)
});

// ============================================================================
// 通知中枢 (Stage 1, 2026-09-12): 多设备 + 类型路由 + group/level 规范
// 契约 (冻结, 不得擅自改): docs/任务记录/2026-09-12-通知中枢Stage1-接口细化.md
//   + docs/任务记录/2026-09-11-通知中枢与访问安全-实施任务书.md §2
// 配置文件 $DSH_HOME/notify-hub.json (0600; dsh-notify 写 / auth-proxy 读 ⇒ 跨进程契约)。
// ============================================================================
const SEND_TIMEOUT_MS = 10000;
/** Synology Chat incoming webhook 单条消息硬上限: 超过被拒收 (entry.cgi success:false) */
export const SYNOLOGY_PAGE_LIMIT = 2000;
/** 配置文件路径 (§2.1)。可用 env 覆盖 (仅供测试隔离, 生产走默认值)。 */
const HUB_FILE = process.env.DSH_NOTIFY_HUB_FILE || joinPath(PLUGIN_DATA, "notify-hub.json");
const HUB_VERSION = 2; // v0.7.0: 读侧兼容 version 1 (旧文件无 options ⇒ 用默认值, 不写盘)
/** RPC 通道名 (§3.3)。 */
export const CHANNEL = "/notify-hub";

/** 设备 id 语法 (§2.1)。 */
export const DEVICE_ID_RE = /^[a-z0-9_-]{1,32}$/;
/** 设备类型枚举 (§2.1)。 */
export const DEVICE_KINDS = ["bark", "synology"];
/** 标题前缀 (§2.2, 仅作用于 Bark)。 */
export const TITLE_PREFIX = "[DSH] ";
/** v0.9.0：Bark 通知图标默认值（用户 2026-11-22：「通知最好像 MFA 一样 带一个 DSH 的图标
 *  默认是大肥鱼的那个图标 然后允许自定义」）—— 与 auth-proxy 的 `auth.otp` 默认图标同源。
 *  设备级 `barkIcon` 可覆盖；显式写 `none` / `-` ⇒ 不发送 icon 字段。 */
export const DEFAULT_BARK_ICON = "";

/**
 * 通知类型枚举 + group/level 规范 (§2.2 冻结表, 逐字一致, 不得擅自改)。
 * isArchive 统一 1 (见 sendBarkDevice)。
 * v0.7.0: 新增 task.asking / task.interrupted (三者独立路由), 全部 12 项带 `hasProducer`
 * (false = 预留类型, 当前无任何生产者 ⇒ 客户端置灰不可交互, 服务端仍可发送)。
 * v0.8.1 (2026-09-13, 通知中枢 Stage 4): 新增通知类型 `auth.otp`（登录一次性码发到手机）
 * ⇒ NOTIFY_TYPES 共 **13 项**。该 type 由 auth-proxy 产生（`POST /login?step=code&action=send-otp`
 * 同步下发）；Bark payload 新增 `icon` 字段**仅对 auth.otp 生效**（默认 DSH 图标, 见 auth-proxy 侧
 * `DSH_NOTIFY_ICON_URL`），其余 5 类 auth.* payload 逐字不变。路由由用户在设置卡里配。
 * v0.8.2 (2026-09-13, 阶段 2 · RD-33/RD-36): **加一行** `queue.failed`（队列状态机熔断为 failed
 * 时由 dsh-taskqueue 发出）⇒ NOTIFY_TYPES 共 **14 项**（13 + 1, 原 13 行逐字未动）;
 * 同批把 `cost.alert` / `queue.dispatched` / `queue.cancelled` 的 `hasProducer` 由 false 翻为 true
 * （生产者 = dsh-cost-guard / dsh-taskqueue, 见 RD-34/RD-35）。客户端 `TYPES_FALLBACK` **同批逐字一致**。
 * 2026-10-02 (`#A424`, 用户令「**他也要像其他的通知一样 做成一个可以选择推送渠道的选项**」):
 * 加一行 `subagent.done`（**子 agent 会话回合结束**）⇒ 共 **15 项**。它**只占"选渠道"这一维**：
 * `minTurnMs` 阈值 / 横幅注入 / 标题正文分页**与主会话逐字同路**；**完全遵守既有路由规则**
 * （缺键 ⇒ `routeDefault` 兜底；配了 ⇒ 按配置；配成 `[]` ⇒ 不推）——**无任何特判、不播种 hub**；
 * **主会话恒走 `task.done`**。生产者 = 本插件 `turn/end`（判据 `SessionHeader.origin === "subagent"`）。
 */
export const NOTIFY_TYPES = [
	{ type: "auth.login_failed", label: "登录失败（密码/验证码错误）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.locked", label: "触发锁定（含全站闸）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.unlocked", label: "锁定期满 / 手动解除", group: "DSH-安全", level: "active", hasProducer: true },
	{ type: "auth.new_device", label: "新设备通过 TOTP 验证", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.mfa_changed", label: "MFA 启用 / 停用 / 重生成", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.otp", label: "登录一次性码（发到手机）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "task.done", label: "对话完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "task.asking", label: "需要你回应（agent 提问）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "task.interrupted", label: "回合被中断（重启后补推）", group: "DSH-任务", level: "active", hasProducer: true },
	// 2026-10-02 (`#A424`) 新增第 15 项：子 agent 会话的 `turn/end` 走本 type（独立可路由, 可单独选渠道/关闭）。
	// `group`/`level` 与 `task.done` 同档（DSH-任务 / active）—— 只增"选渠道"这一维, 不新增文案分叉。
	{ type: "subagent.done", label: "子 agent 完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "cost.alert", label: "费用提醒", group: "DSH-费用", level: "active", hasProducer: true },
	{ type: "queue.dispatched", label: "队列派发", group: "DSH-队列", level: "passive", hasProducer: true },
	{ type: "queue.cancelled", label: "队列取消", group: "DSH-队列", level: "passive", hasProducer: true },
	{ type: "queue.failed", label: "队列失败", group: "DSH-队列", level: "timeSensitive", hasProducer: true },
	{ type: "test", label: "测试推送（设置卡逐台）", group: "DSH-测试", level: "active", hasProducer: true }
];
const TYPE_MAP = new Map(NOTIFY_TYPES.map((t) => [t.type, t]));
/** 未在 §2.2 表中列出的 type 的兜底规范 (仍可发送, 不阻断)。 */
export const FALLBACK_TYPE_SPEC = { group: "DSH-任务", level: "active" };

/** 取某 type 的 group/level 规范; 未知 type 走兜底。 */
export function typeSpec(type) {
	return TYPE_MAP.get(String(type)) ?? { type: String(type), label: String(type), ...FALLBACK_TYPE_SPEC };
}

// ---- options (§3, v0.7.0 新增) ---------------------------------------------

/** options 键白名单 (§4 setOptions「仅接受上表三键」)。
 *  ★件G（2026-10-06 用户令「按照甲做」＋窄屏选 B）：**新增 5 键「全局公共参数」**（★件J-乙 起为 **6 键**）——
 *    bark／群晖**各自一份全局**、同类型共享；**默认值 ＝ 逐字现状**（见 `optionsDefaults`）；
 *    ★**白名单三处必须同改**（本处 ＋ `optionsDefaults`/`normalizeOptions` ＋ `setOptions`/回读面 ＋ client `DEFAULT_OPTIONS`），
 *    只改一半 ⇒「写了但读不回」。 */
export const OPTION_KEYS = ["minTurnMs", "bannerSummary", "reconcile", "barkTimeoutMs", "barkRetries", "barkConcurrency", "synologyTimeoutMs", "synologyRetries", "synologyConcurrency"];
/** minTurnMs 取值范围 (§3): 0…3600000 ms (0 = 不设门槛)。 */
export const MIN_TURN_MS_MAX = 3600000;
/**
 * options 默认值 (§3): `minTurnMs` 初值 = patch `config.minTurnMs ?? 60000`
 * (由 apply/configureHub 注入, 保证升级前后行为一致); `reconcile` 恒 true;
 * **`bannerSummary` 自 2026-10-02 (`#A428` 件①, 用户令「默认关的就行」) 起 ＝ `false`**
 * —— 语义＝**只对"配置里没有该键"的新建/旧 hub 与客户端兜底生效**；**已显式配 `true` 的现网
 * 运行态 `notify-hub.json` 一字不动 ⇒ 运行中的横幅行为不变**（用户自行在设置卡手动关）。
 * 与 `lib/client.js` 的 `DEFAULT_OPTIONS.bannerSummary` **必须同值**（否则出"界面显示开、
 * 实际关"的假象）。
 */
let optionsDefaults = { minTurnMs: 60000, bannerSummary: false, reconcile: true,
	// ★件G：5 键全局公共参数；★件J-乙：新增 `synologyConcurrency`
	//   原文（件G，逐字现状）：bark 10000／0／1；synology 10000／0（不开并发）
	//   ★件J-乙：bark 三键默认值按用户 `T51` 调整 ⇒ 20000／1／2（**只改默认值**：
	//     对"配置里已显式写了该键"的运行态 hub **零影响** —— 见 normalizeOptions（显式值优先于默认值）；
	//     现网 hub 显式 `barkRetries=5`／`barkConcurrency=5` ⇒ 装机后行为逐字不变）。
	//   ★`synologyConcurrency` 默认 **1 ＝ 逐台串行 ＝ 逐字现状**。
	barkTimeoutMs: 20000, barkRetries: 1, barkConcurrency: 2, synologyTimeoutMs: 10000, synologyRetries: 0,
	synologyConcurrency: 1 };
/** 当前默认值副本 (供测试/诊断)。 */
export function optionDefaults() {
	return { ...optionsDefaults };
}
/** 用 patch 配置的 minTurnMs 覆盖 options.minTurnMs 初值 (§3)。 */
export function setOptionsDefaults(patchMinTurnMs) {
	if (Number.isFinite(patchMinTurnMs)) {
		optionsDefaults = { ...optionsDefaults, minTurnMs: clampMinTurnMs(patchMinTurnMs, optionsDefaults.minTurnMs) };
	}
	return optionDefaults();
}
/** 夹到 [0, 3600000] 整数 (§3); 非 number/NaN ⇒ 用 fallback。 */
function clampMinTurnMs(v, fallback) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(MIN_TURN_MS_MAX, Math.max(0, Math.round(v)));
}

/* ★件G：全局公共参数（★件J-乙 起 6 键）的夹取（越界 ⇒ 夹到边界；非法类型 ⇒ 回落默认值；**不抛错**） */
/** 超时：1000–120000 ms（整数） */
export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 120000;
export function clampTimeoutMs(v, fallback) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(v)));
}
/** 重试次数：0–5 */
export const RETRIES_MAX = 5;
export function clampRetries(v, fallback) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(RETRIES_MAX, Math.max(0, Math.round(v)));
}
/** Bark／群晖**并发**：1–8（1 ＝ 串行 ＝ 现状）；**bark 桶与群晖桶共用本夹取**（同套口径）。 */
export const BARK_CONCURRENCY_MIN = 1;
export const BARK_CONCURRENCY_MAX = 8;
export function clampConcurrency(v, fallback) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(BARK_CONCURRENCY_MAX, Math.max(BARK_CONCURRENCY_MIN, Math.round(v)));
}
/**
 * 规整 options (§3): 缺失键 ⇒ 用默认值; `minTurnMs` 非整数/越界 ⇒ 夹到 [0, 3600000];
 * 非布尔 ⇒ 用默认值; 未知键一律丢弃。**不抛错** (setOptions 也走这里)。
 */
export function normalizeOptions(raw, defaults = optionsDefaults) {
	const base = defaults ?? optionsDefaults;
	const out = {
		minTurnMs: clampMinTurnMs(base?.minTurnMs, optionsDefaults.minTurnMs),
		bannerSummary: typeof base?.bannerSummary === "boolean" ? base.bannerSummary : optionsDefaults.bannerSummary,
		reconcile: typeof base?.reconcile === "boolean" ? base.reconcile : true,
		// ★件G：5 键（默认＝逐字现状；越界夹取、非法回落）；★件J-乙：＋ `synologyConcurrency`（共 6 键）
		barkTimeoutMs: clampTimeoutMs(base?.barkTimeoutMs, optionsDefaults.barkTimeoutMs),
		barkRetries: clampRetries(base?.barkRetries, optionsDefaults.barkRetries),
		barkConcurrency: clampConcurrency(base?.barkConcurrency, optionsDefaults.barkConcurrency),
		synologyTimeoutMs: clampTimeoutMs(base?.synologyTimeoutMs, optionsDefaults.synologyTimeoutMs),
		synologyRetries: clampRetries(base?.synologyRetries, optionsDefaults.synologyRetries),
		synologyConcurrency: clampConcurrency(base?.synologyConcurrency, optionsDefaults.synologyConcurrency)
	};
	if (raw && typeof raw === "object") {
		if (raw.minTurnMs !== undefined) out.minTurnMs = clampMinTurnMs(raw.minTurnMs, out.minTurnMs);
		if (typeof raw.bannerSummary === "boolean") out.bannerSummary = raw.bannerSummary;
		if (typeof raw.reconcile === "boolean") out.reconcile = raw.reconcile;
		// ★件G：5 键（**未知键仍一律丢弃**）；★件J-乙：＋ `synologyConcurrency`（白名单共 **6** 个全局参数键）
		if (raw.barkTimeoutMs !== undefined) out.barkTimeoutMs = clampTimeoutMs(raw.barkTimeoutMs, out.barkTimeoutMs);
		if (raw.barkRetries !== undefined) out.barkRetries = clampRetries(raw.barkRetries, out.barkRetries);
		if (raw.barkConcurrency !== undefined) out.barkConcurrency = clampConcurrency(raw.barkConcurrency, out.barkConcurrency);
		if (raw.synologyTimeoutMs !== undefined) out.synologyTimeoutMs = clampTimeoutMs(raw.synologyTimeoutMs, out.synologyTimeoutMs);
		if (raw.synologyRetries !== undefined) out.synologyRetries = clampRetries(raw.synologyRetries, out.synologyRetries);
		if (raw.synologyConcurrency !== undefined) out.synologyConcurrency = clampConcurrency(raw.synologyConcurrency, out.synologyConcurrency);
	}
	return out;
}

/** 运行时 options 快照 (v0.7.0): 由 loadHub() 按 mtime 刷新 ⇒ 设置卡改完即刻生效, 无需重启。 */
let hubOptions = { ...optionsDefaults };
/** 运行时模板库快照 (v0.9.1): 随 loadHub 刷新；始终含两条内置模板（默认 `{{body}}` ⇒ 逐字现状）。 */
let hubTemplateList = [];
/** 当前生效 options (同步读快照; 供 apply 的事件路径与诊断用)。 */
export function currentOptions() {
	return { ...hubOptions };
}
/** 当前生效模板库（只读副本；供发送链路与诊断）。 */
export function currentTemplateList() {
	return hubTemplateList.map((t) => ({ ...t }));
}

/** 分页串行发送间隔: 避开 Synology entry.cgi 限流 (code 411, 实测 1.5s 安全; v0.5.1 结论保留)。 */
const SEND_PAGE_INTERVAL_MS = 1500;

/** 进程内日志器 (apply 时注入)。 */
let logger = null;
/** 迁移源 (apply 时由 patch config + env 填充, 见 §2.1 迁移)。 */
let hubMigrationSource = {};
/** 运行时 hub 缓存 (设置卡改配置即刻生效) + 其 mtime (外部改文件时自动失效)。 */
let hubCache = null;
let hubCacheMtime = 0;
/** 是否存在可用通道 (enabled 设备数 > 0); 供同步事件路径做快速短路。 */
let hubHasChannel = false;
/** 全局 FIFO 串行发送队列 (v0.5.3 语义保留: 一个通知所有页/设备发完才发下一个)。 */
let sendQueue = Promise.resolve();

const asArray = (v) => (Array.isArray(v) ? v : []);

/** 脱敏: 日志/响应里绝不出现明文 URL / key / token (§3.2)。 */
export function sanitize(text) {
	return String(text ?? "")
		.replace(/https?:\/\/[^\s"'<>]+/g, (u) => urlTail(u))
		.replace(/((?:device_key|token|key|apikey|api_key)=)[^&\s"']+/gi, "$1…");
}

/** 只回 URL 尾号 (§3.2/§7); 响应与日志永不回明文。 */
export function urlTail(url) {
	const s = String(url ?? "").replace(/\/+$/, "");
	return `…${s.slice(-4)}`;
}

/** 标题前缀统一 "[DSH] " (§2.2), 幂等 (已带前缀不重复加)。 */
export function barkTitle(title) {
	const t = String(title ?? "").trim();
	return t.startsWith(TITLE_PREFIX.trim()) ? t : `${TITLE_PREFIX}${t}`;
}

/**
 * 由设备 URL 推导 Bark 端点 + device_key (§4)。
 * 兼容自建/路径前缀: `https://api.day.app/AbC` → `POST https://api.day.app/push` + key AbC;
 * `https://mydomain/bark/AbC` → `POST https://mydomain/bark/push` + key AbC。
 * URL 自带的 query 参数原样带回 (own), 由调用方以"自带优先"的顺序合并。
 */
export function resolveBark(deviceUrl) {
	const u = new URL(String(deviceUrl));
	const own = {};
	for (const [k, v] of u.searchParams) own[k] = v;
	const segments = u.pathname.split("/").filter(Boolean);
	let key = own.device_key ?? "";
	// 末段不是 push 且 query 未给 device_key ⇒ 末段即设备 key (标准 Bark URL 形态)
	if (!key && segments.length && segments[segments.length - 1] !== "push") key = segments.pop();
	const path = `/${segments.join("/")}`;
	const isPushPath = segments[segments.length - 1] === "push";
	const endpoint = u.origin + (isPushPath ? path : `${path === "/" ? "" : path}/push`);
	return { endpoint, key, own };
}

/**
 * 规整一份原始配置为合法 hub (不写盘): **只做形状校验, 不解析路由语义**。
 * - 非法/重复设备静默丢弃;
 * - `routes` 的 key 必须是 §2.2 表内 type (未知 type 丢弃);
 * - **v0.7.0: 显式空数组的 route 键必须原样保留** ⇒ 语义 = 该 type 显式关闭 (零请求, 不回落默认);
 *   仅**非数组**的脏值 (手工编辑出错) 才丢弃该键 ⇒ 回落默认路由 (避免脏数据把通知静默静音);
 * - **非空数组原样保留路由里的 id, 不在读盘期按设备表过滤** ——
 *   否则 `routes[type] = ["已删设备"]` 会被压成 `[]` 再被当"显式关闭"⇒ 语义漂移;
 *   现在的语义是: 该 type **有**显式路由, 但解析后无可用设备 ⇒ **零请求** (§2.1 "结果为空 ⇒ 不发送")。
 *   语义判定统一放在 resolveRouteIds()。
 * - v0.7.0: `options` 缺失 (旧文件/version 1) ⇒ 内存里用默认值, **不写盘** (首次保存才落盘)。
 */
export function normalizeHub(raw) {
	const devices = [];
	const seen = new Set();
	for (const d of asArray(raw?.devices)) {
		if (!d || typeof d !== "object") continue;
		const id = String(d.id ?? "");
		if (!DEVICE_ID_RE.test(id) || seen.has(id)) continue;
		const kind = DEVICE_KINDS.includes(d.kind) ? d.kind : "";
		const url = typeof d.url === "string" ? d.url.trim() : "";
		if (!kind || !url) continue;
		seen.add(id);
		const dev = { id, name: String(d.name ?? id).slice(0, 64) || id, kind, url, enabled: d.enabled !== false };
		if (Number.isInteger(d.order) && d.order >= 1) dev.order = d.order; // ★件F: 组内序号原样搬运（缺失/重复由下方迁移补位）
		// 件B: 只搬运**文件里确实存在**的分隔符键（**不播种**默认键 ⇒ 老 hub / 未配置设备行为逐字不变）
		for (const k of SEP_KEYS) {
			const v = d[k];
			if (typeof v === "string" && v.trim()) dev[k] = v.trim().slice(0, 128);
		}
		// 件C: 「内容段」3 键同样**只搬运文件里确实存在的值**，且**只认 `false`（＝关）**
		//   （`true`／脏值 ⇒ 语义上＝默认「开」⇒ 归一化丢弃、不建键 ⇒ 未配置设备输出逐字不变）
		for (const k of SEG_KEYS) if (d[k] === false) dev[k] = false;
		// v0.9.1: 设备选择的模板 id（空 ⇒ 按 kind 内置默认；模板本身在 hub.templates 列表里）
		if (typeof d.templateId === "string" && TEMPLATE_ID_RE.test(d.templateId.trim())) dev.templateId = d.templateId.trim();
		// v0.9.0: 模板 override（只搬运非空串；空 ⇒ 继承所选模板/内置默认 ⇒ 空 ⇒ legacy）
		for (const k of TEMPLATE_KEYS) {
			if (typeof d[k] !== "string") continue;
			const v = d[k].trim();
			if (v) dev[k] = v.slice(0, k === "tplTitle" ? TPL_TITLE_MAX : TPL_BODY_MAX);
		}
		// v0.9.0: Bark 设备级参数（只搬运合法值；空/非法 ⇒ 不建键 ⇒ 走 type 冻结表默认）
		for (const k of BARK_PARAM_KEYS) {
			if (k === "barkTitlePrefix") { if (d[k] === false) dev[k] = false; continue; }
			if (k === "barkIsArchive") { if (d[k] === 0 || d[k] === 1) dev[k] = d[k]; continue; }
			if (k === "barkLevel") { if (BARK_LEVELS.includes(d[k])) dev[k] = d[k]; continue; }
			if (typeof d[k] === "string" && d[k].trim()) dev[k] = d[k].trim().slice(0, k === "barkIcon" ? 500 : 64);
		}
		devices.push(dev);
	}
	/* ★件F（2026-10-05，用户令「可以 order也加 签卡吧」）：**组内序号 `order`**（1..N，按 `kind` 各一套）
	 *   语义（冻结）：**单一真值 = `order`**；显示与 order-sensitive 路径一律按 **（组序, order）** 排 ——
	 *     组序固定 **bark → 群晖**（用户裁定「仅同类型组内排序、不跨组」）。
	 *   ★迁移口径：**只补字段、不动 `devices` 数组**（现网数组是交错插入的 `chat,bark1,bark2,chat2,chat3`
	 *     ⇒ 重排数组会**静默改变发送顺序**）；已有的合法且组内唯一的 `order` **原样保留**（保存后可往返）；
	 *     缺失/重复/非法 ⇒ 按**数组内该组的出现顺序**补最小空位。
	 *   不变量：每个 `kind` 组内 `order` 恰为 1..N、无重复、无空洞（写端 `normalizeHub`/`saveDevice`/`deleteDevice`/`reorderDevices` 维护）。 */
	{
		const taken = new Map(); // kind -> Set<order>
		for (const d of devices) {
			if (!Number.isInteger(d.order) || d.order < 1) continue;
			if (!taken.has(d.kind)) taken.set(d.kind, new Set());
			const s = taken.get(d.kind);
			if (s.has(d.order)) delete d.order;   // 组内重复 ⇒ 视为缺失，交补位
			else s.add(d.order);
		}
		for (const d of devices) {
			if (Number.isInteger(d.order) && d.order >= 1) continue;
			if (!taken.has(d.kind)) taken.set(d.kind, new Set());
			const s = taken.get(d.kind);
			let n = 1; while (s.has(n)) n++;
			s.add(n); d.order = n;
		}
	}

	const normList = (v) => [...new Set(asArray(v).map((x) => String(x)).filter(Boolean))];
	const routes = {};
	if (raw?.routes && typeof raw.routes === "object") {
		for (const [k, v] of Object.entries(raw.routes)) {
			if (!TYPE_MAP.has(k)) continue;
			if (!Array.isArray(v)) continue; // 脏值丢弃 ⇒ 回落默认 (见上方注释)
			routes[k] = normList(v); // v0.7.0: 空数组原样保留 = 显式关闭 (§1 语义变更)
		}
	}
	// v0.9.1: hub 级模板库（数组；兼容 v0.9.0 的 {bark,synology} 旧形状）。空 ⇒ 不建键（读取侧补内置两条）
	const templates = normalizeTemplateList(raw?.templates);
	const out = { version: HUB_VERSION, devices, routeDefault: normList(raw?.routeDefault), routes, options: normalizeOptions(raw?.options) };
	if (Object.keys(templates).length) out.templates = templates;
	return out;
}

/** 首次读取无该文件时的迁移 (§2.1): 现有 patch 配置 barkKeys + synologyWebhookUrl。 */
export function migrateHub(source = {}) {
	const devices = [];
	const barkKeys = [...new Set([...asArray(source.barkKeys), ...asArray(source.envBarkKeys)]
		.map((s) => String(s).trim()).filter(Boolean))];
	barkKeys.forEach((key, i) => {
		devices.push({ id: `bark${i + 1}`, name: `Bark ${i + 1}`, kind: "bark", url: `https://api.day.app/${key}`, enabled: true });
	});
	const chat = String(source.synologyWebhookUrl || source.envSynologyUrl || "").trim();
	if (chat) devices.push({ id: "chat", name: "群晖 Chat", kind: "synology", url: chat, enabled: true });
	// routeDefault 空数组 ⇒ 语义 = 发全部 enabled 设备 = 与迁移前行为一致 (§2.1)
	// v0.9.1：首次迁移即写入两条内置模板（初始状态 = 两通道各一条）
	return { version: HUB_VERSION, devices, routeDefault: [], routes: {}, options: optionDefaults(), templates: defaultTemplates() };
}

/**
 * ★件F（2026-10-05）：**组序 ＋ 组内 `order`** —— 单一真值 = `order`，显示与 order-sensitive 路径一律按本键排。
 *   组序固定 **bark(0) → synology(1)**（用户裁定「仅同类型组内排序、不跨组」）；`order` 缺失/非法 ⇒ 排组尾（**不静默丢**）。
 */
export const KIND_RANK = { bark: 0, synology: 1 };
export function deviceSortKey(d) {
	return [KIND_RANK[d?.kind] ?? 9, Number.isInteger(d?.order) && d.order >= 1 ? d.order : Number.MAX_SAFE_INTEGER];
}
/** 按（组序, 组内 order）稳定排序；**不改原数组**（返回副本）。 */
export function sortedDevices(devices) {
	return asArray(devices).map((d, i) => [d, i]).sort((a, b) => {
		const ka = deviceSortKey(a[0]), kb = deviceSortKey(b[0]);
		return ka[0] - kb[0] || ka[1] - kb[1] || a[1] - b[1];
	}).map((x) => x[0]);
}

/**
 * 类型路由 (§2.1): routes[type] 存在 ⇒ 只用它 (可为空 ⇒ 不发);
 * 否则 routeDefault 非空 ⇒ 用它; 否则全部 enabled 设备。
 * 停用设备与未知 id 一律静默忽略。
 * ★件F 口径变更（登记）：第三条"全部 enabled"路径的顺序**由「`devices` 数组插入顺序」改为「（组序, order）」**
 *   —— 仅当 `routeDefault` 为空且该 type 无显式 `routes[type]` 时可见；现网 `routeDefault=['chat2']` 非空 ⇒ 零影响（现读证据）。
 */
export function resolveRouteIds(hub, type) {
	const enabled = asArray(hub?.devices).filter((d) => d.enabled !== false);
	const enabledIds = new Set(enabled.map((d) => d.id));
	const pick = (list) => [...new Set(asArray(list).map((x) => String(x)))].filter((id) => enabledIds.has(id));
	if (Object.prototype.hasOwnProperty.call(hub?.routes ?? {}, String(type))) return pick(hub.routes[String(type)]);
	if (asArray(hub?.routeDefault).length) return pick(hub.routeDefault);
	return sortedDevices(enabled).map((d) => d.id);
}

/** 广播用: 全部 enabled 设备 (banner/诊断命令)。 */
export function allEnabledIds(hub) {
	return asArray(hub?.devices).filter((d) => d.enabled !== false).map((d) => d.id);
}

function refreshHubFlags(hub) {
	hubHasChannel = asArray(hub?.devices).some((d) => d.enabled !== false);
	// v0.7.0: 同步 options 快照 ⇒ 事件路径 (turn/end, reconcile) 可同步取到最新阈值/开关
	hubOptions = normalizeOptions(hub?.options);
	// v0.9.1: 同步模板库快照（内置两条始终存在；自定义追加）
	hubTemplateList = templateListOf(hub);
	return hub;
}

/** 读配置文件: 无文件 → null (走迁移); **损坏 → 记 warn 后也返回 null** (降级为迁移配置,
 *  通知功能绝不因配置损坏而中断 —— 契约 §1)。两种情况用 `corrupt` 标记区分, 便于日志定位。 */
async function readHubFile() {
	let text;
	try { text = await readFile(HUB_FILE, "utf8"); } catch { return null; } // 文件不存在
	try { return JSON.parse(text); }
	catch (e) {
		logger?.warn?.(`dsh-notify: ${HUB_FILE} 解析失败 (已降级为迁移配置, 原文件未改动): ${sanitize(e?.message ?? e)}`);
		debug(`notify-hub: 解析失败, 降级为迁移配置: ${sanitize(e?.message ?? e)}`);
		return null;
	}
}

async function writeHubFile(hub) {
	try { mkdirSync(PLUGIN_DATA, { recursive: true }); } catch { /* 目录已存在或不可建，交给下面报错 */ }
	await writeFile(HUB_FILE, `${JSON.stringify(hub, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	// 已存在的文件 mode 不会因 writeFile 改变 ⇒ 显式收紧到 0600 (§3 验收)
	try { await chmod(HUB_FILE, 0o600); } catch { /* 文件系统不支持时忽略 */ }
}

/** 确保配置文件权限为 0600 (§3 验收: 明文 key 只落在 0600 文件里)。 */
async function enforceOwnerOnly() {
	try { if (((await stat(HUB_FILE)).mode & 0o777) !== 0o600) await chmod(HUB_FILE, 0o600); }
	catch { /* 文件系统不支持 chmod 时忽略 ($DSH_HOME 挂载即如此) */ }
}

/** 读 hub (带缓存); 无文件 ⇒ 迁移 + 落盘 0600; JSON 损坏 ⇒ 降级为迁移结果, 绝不抛错断通知。
 *  缓存按 **mtime** 失效: 外部直接改文件 (手工编辑/测试脚本/未来的 auth-proxy 写侧) 也能即时生效,
 *  不必等重启或显式 force。 */
export async function loadHub({ force = false } = {}) {
	if (hubCache && !force) {
		try { if ((await stat(HUB_FILE)).mtimeMs === hubCacheMtime) return hubCache; }
		catch { return hubCache; } // stat 失败(文件被删) 交给下面走迁移
	}
	const raw = await readHubFile();
	if (raw) {
		hubCache = normalizeHub(raw);
		try { hubCacheMtime = (await stat(HUB_FILE)).mtimeMs; } catch { hubCacheMtime = 0; }
		// 手工创建/备份还原可能带来宽松权限 ⇒ 读到就收紧
		await enforceOwnerOnly();
		return refreshHubFlags(hubCache);
	}
	const migrated = migrateHub(hubMigrationSource);
	hubCache = migrated;
	try {
		await writeHubFile(migrated);
		debug(`notify-hub: 首次迁移生成 ${HUB_FILE} (devices=${migrated.devices.length}, routeDefault=[])`);
	} catch (e) {
		logger?.warn?.(`dsh-notify: notify-hub.json 写盘失败 (继续用内存配置): ${sanitize(e?.message ?? e)}`);
		debug(`notify-hub: 迁移写盘失败: ${sanitize(e?.message ?? e)}`);
	}
	return refreshHubFlags(hubCache);
}

/** 写 hub (0600) + 刷新缓存。 */
export async function saveHub(hub) {
	const next = normalizeHub(hub);
	await writeHubFile(next);
	hubCache = next;
	try { hubCacheMtime = (await stat(HUB_FILE)).mtimeMs; } catch { hubCacheMtime = 0; }
	return refreshHubFlags(next);
}

/** 单台 Bark 发送 (§4): POST + device_key; URL 自带 query 参数优先于我们附加的。
 *  v0.9.0: 设备级渠道参数（group/level/sound/icon/isArchive/标题前缀）生效；未配置 ⇒ type 冻结表默认。 */
async function sendBarkDevice(device, title, body, spec, timeoutMs = SEND_TIMEOUT_MS, params = null) {
	const { endpoint, key, own } = resolveBark(device.url);
	if (!key) throw new Error("Bark 设备 URL 未解析出 device_key");
	const bp = params ?? resolveBarkParams(device, spec?.type ?? "");
	const payload = {
		device_key: key,
		title: String(title ?? ""),
		body,
		group: bp.group,
		level: bp.level,
		isArchive: bp.isArchive,
		...(bp.sound ? { sound: bp.sound } : {}),
		...(bp.icon ? { icon: bp.icon } : {}),
		...own // ← URL 自带同名参数最后合并 ⇒ 用户手填 group/level 不被覆盖 (§2.2)
	};
	const resp = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!resp.ok) {
		// ★件B (`#A449` ⑦): 非 2xx **读并记响应体**（`413`/`500` 定因的唯一路径）；**成功路径逐字不变**。
		let detail = "";
		try { detail = sanitize(String(await resp.text())).replace(/\s+/g, " ").trim().slice(0, 400); } catch { /* 读体失败不得掩盖原始状态码 */ }
		throw new Error(`Bark HTTP ${resp.status}${detail ? ` body=${detail}` : " (响应体为空/读取失败)"}`);
	}
	const data = await resp.json().catch(() => null);
	if (data?.code !== 200) throw new Error(`Bark code ${data?.code}: ${sanitize(data?.message ?? "")}`);
	return true;
}

/** 单台 Synology Chat 发送 (§5): form-urlencoded payload; 必须检查 success (入口失败也回 200)。 */
async function sendSynologyDevice(device, text, timeoutMs = SEND_TIMEOUT_MS) {
	const payload = JSON.stringify({ text });
	const resp = await fetch(device.url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `payload=${encodeURIComponent(payload)}`,
		signal: AbortSignal.timeout(timeoutMs)
	});
	const data = await resp.json().catch(() => null);
	if (!resp.ok) throw new Error(`Synology HTTP ${resp.status}`);
	if (data?.success !== true) throw new Error(`Synology success:false: ${sanitize(JSON.stringify(data?.error ?? data))}`);
	return true;
}

/**
 * ★件G（2026-10-06 用户令）：**失败重试**（`<类型>Retries`，退避 `500ms×2^(n−1)`、上限 8000ms）。
 *   **不得静默**：**每次尝试都留一行**（成功也记：`send retry ok: …`；彻底失败记 `send failed: …`）。
 *   群晖**重试期间仍逐页**（页间隔恒 `SEND_PAGE_INTERVAL_MS`，本函数不碰间隔）；Bark／群晖重试都在各自并发池内、**不抬高并发上限**。
 */
async function withRetry(d, label, fn, retries) {
	let lastErr = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fn();
			if (attempt > 0) debug(`send retry ok: ${label} 第 ${attempt + 1} 次尝试成功（已重试 ${attempt} 次）`);
			return { ok: true, attempts: attempt + 1 };
		} catch (err) {
			lastErr = err;
			if (attempt < retries) {
				const backoff = Math.min(8000, 500 * Math.pow(2, attempt));
				debug(`send retry: ${label} 第 ${attempt + 1} 次失败（${sanitize(err?.message ?? err)}）⇒ ${backoff}ms 后第 ${attempt + 2}/${retries + 1} 次尝试`);
				await new Promise((r) => setTimeout(r, backoff));
			} else {
				debug(`send failed: ${label} 共 ${attempt + 1} 次尝试仍失败（${sanitize(err?.message ?? err)}）`);
			}
		}
	}
	return { ok: false, error: lastErr, attempts: retries + 1 };
}

/**
 * 发送核心: 全局 FIFO 串行 (v0.5.3 语义保留), 单设备失败不阻断其它设备。
 * ★件G：**Bark 桶按 `barkConcurrency` 有界并发**（默认 1 ＝ 逐字现状）；**群晖桶当时仍逐设备逐页串行**。
 * ★件J-乙：**群晖桶改为按 `synologyConcurrency` 有界并发**（默认 **1 ＝ 逐台严格串行 ＝ 逐字现状**）；
 *   **并发只作用于"多台之间"** —— **每台设备内部仍逐页 `SEND_PAGE_INTERVAL_MS`(1500ms)**（限流语义不变，见下方 worker 内注释）。
 *   两桶各自独立、各自有界；**两桶都跑在同一个 `sendQueue` 全局 FIFO 之内**（一条通知发完才发下一条）。
 * @returns {{ok:boolean, sent:number, failed:number, results:Array<{deviceId:string,status:string,error?:string}>}}
 */
async function sendToDevices(devices, type, title, pages, compose, varsIn = {}) {
	const run = sendQueue.then(async () => {
		const list = asArray(pages).map((p) => String(p)).filter((p) => p !== "");
		const results = [];
		if (!devices.length) {
			debug(`send ${type}: 无目标设备 ⇒ 零请求`);
			return results;
		}
		if (!list.length) {
			debug(`send ${type}: 内容为空 ⇒ 零请求`);
			return results;
		}
		// ★ 件B: 分隔符**按设备生效**（缺键 ⇒ 逐字＝现状）；生效面＝对话组四项，其余类型恒走默认。
		//   `compose(seps)` 由生产者提供（＝同一份正文按该设备的分隔符重新成形）；
		//   **非对话组四项 ⇒ 连 composer 都不调用**（其余类型波形逐字不变，含 `test`）。
		const scoped = PAYLOAD_TYPES.has(type);
		const pagesFor = (d, seps, segs) => {
			// ★件D／T50（`#A476`）接缝硬化：消费者是**两参**调用（`compose(seps, segs)`）——
			//   生产者若给一参闭包 ⇒ `segs` 被静默丢弃 ⇒ 段配置**看似保存成功、实发全量**。
			//   ⇒ 只**打一行 debug**（不静默；不改行为、不抛错）。
			if (compose && scoped && deviceHasCustomSegs(d) && compose.length < 2) {
				debug(`payload: 设备 ${d.id} composer 忽略 segs（形参数 ${compose.length}）⇒ 段配置不会生效`);
			}
			if (!compose || !scoped) { takeComposeAdjust(); return { pages: list, adjusted: [] }; }
			const p = asArray(compose(seps, segs)).map((x) => String(x)).filter((x) => x !== "");
			// ★件B-补：渲染期「总开销夹取」的记录 ⇒ debug ＋ lastSend.adjusted（面板可见，不静默）
			const adjusted = takeComposeAdjust();
			adjusted.forEach((n) => debug(`payload: 设备 ${d.id} ${n}`));
			if (!p.length) {
				debug(`payload: 设备 ${d.id} 按分隔符重排后为空 ⇒ 回退默认成形（不静默）`);
				return { pages: list, adjusted };
			}
			return { pages: p, adjusted };
		};
		// ★v0.9.0：模板按设备生效（设备 override → kind 默认 → 空=legacy）。
		//   `legacy.pages` 同时作为 `{{body}}` 的值与「模板渲染为空」的回退，**绝不因自定义模板而丢通知**。
		const tplList = currentTemplateList();
		const buildFor = (d, seps, segs) => {
			const legacy = pagesFor(d, seps, segs);
			const eff = effectiveTemplateFor(d, tplList);
			let titleOut = title;
			let pagesOut = legacy.pages;
			const notes = [];
			if (eff.missing) notes.push(`设备选择的模板 "${eff.selectedTemplateId}" 不存在 ⇒ 已回落 "${eff.templateName}"（不静默）`);
			if (eff.title || eff.body) {
				const vars = buildTemplateVars({ type, title, pages: legacy.pages, seps, device: d, extra: { ...varsIn, tplEmoji: eff.emoji } });
				if (eff.title) {
					const tr = renderTemplate(eff.title, vars);
					if (tr.unknown.length) notes.push(`标题模板含未知占位符：${tr.unknown.map((k) => `{{${k}}}`).join("、")}（原样保留）`);
					// 群晖没有独立标题字段 ⇒ title 模板只作用于 Bark（正文里可用 {{title}} 自行嵌入）
					if (d.kind === "bark" && tr.text.trim()) titleOut = tr.text;
				}
				if (eff.body) {
					const br = renderTemplate(eff.body, vars);
					if (br.unknown.length) notes.push(`正文模板含未知占位符：${br.unknown.map((k) => `{{${k}}}`).join("、")}（原样保留）`);
					const p = splitTemplatedText(d.kind, br.text, seps);
					if (p.length) pagesOut = p;
					else notes.push("模板渲染结果为空 ⇒ 已回退旧版组稿（不静默）");
				}
			}
			return { pages: pagesOut, adjusted: legacy.adjusted, title: titleOut, tpl: { mode: eff.body ? "custom" : "legacy", titleSource: eff.titleSource, bodySource: eff.bodySource }, notes };
		};
		// ★件G：Bark 桶**有界并发**（`barkConcurrency`，默认 1 ＝ 串行 ＝ 逐字现状）；Synology 桶**仍逐设备逐页串行**（页间隔恒 1.5s，限流语义不变）
		const _opts = currentOptions();
		const barkList = devices.filter((d) => d.kind === "bark");
		const _conc = clampConcurrency(_opts.barkConcurrency, 1);
		const barkOut = new Array(barkList.length);
		let _cursor = 0;
		const _worker = async () => {
			for (;;) {
				const i = _cursor++;
				if (i >= barkList.length) return;
				const d = barkList[i];
				const { seps, notes } = resolveDeviceSeps(d, type);
				notes.forEach((n) => debug(`payload: ${n}`));
				const segRes = resolveDeviceSegs(d, type);
				segRes.notes.forEach((n) => debug(`payload: ${n}`));
				const built = buildFor(d, seps, segRes.segs);
				const devPages = built.pages;
				const body = devPages.join(seps.sepPageJoin);
				const bp = resolveBarkParams(d, type);
				for (const n of built.notes) debug(`payload: 设备 ${d.id} ${n}`);
				lastSendStats.set(d.id, { at: Date.now(), type, pages: devPages.length, bodyLen: body.length, adjusted: built.adjusted, segs: segRes.segs, tpl: built.tpl, tplNotes: built.notes });
				// 「将推 N 条」的实测来源（设置卡显示用）＋ 413 定因所需的请求体长度
				debug(`send ${type} → ${d.id}(bark): pages=${devPages.length} body=${body.length}B${deviceHasCustomSeps(d) ? " [自定义分隔符]" : ""}${built.tpl.mode === "custom" ? " [自定义模板]" : ""}`);
				const r = await withRetry(d, `${type} → ${d.id}(bark)`, () => sendBarkDevice(d, built.title, body, typeSpec(type), _opts.barkTimeoutMs, bp), _opts.barkRetries);
				barkOut[i] = r.ok ? { deviceId: d.id, status: "fulfilled" } : { deviceId: d.id, status: "rejected", error: sanitize(r.error?.message ?? r.error) };
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(_conc, barkList.length || 1)) }, _worker));
		for (const r of barkOut) if (r) results.push(r);
		// ★件J-乙：**群晖桶按 `synologyConcurrency` 有界并发**（默认 1 ＝ 逐台严格串行 ＝ 逐字现状）。
		//   ★不破坏项（硬）：**并发只作用于"多台之间"** —— 每台设备内部**仍逐页 `SEND_PAGE_INTERVAL_MS`(1500ms)**，
		//     worker 里那个 `await` 写在**页循环之内** ⇒ 同一台的页与页之间间隔恒 1500ms，与并发度无关。
		//   ★顺序：结果按 `devices` 原序遍历回填（**对外顺序与逐字现状相同**）；并发只是并发，**不重排 results**。
		const synList = devices.filter((d) => d.kind === "synology");
		const _synConc = clampConcurrency(_opts.synologyConcurrency, 1);
		const synOut = [];
		let _synCursor = 0;
		const _synWorker = async () => {
			for (;;) {
				const i = _synCursor++;
				if (i >= synList.length) return;
				const d = synList[i];
				const { seps, notes } = resolveDeviceSeps(d, type);
				notes.forEach((n) => debug(`payload: ${n}`));
				const segRes = resolveDeviceSegs(d, type);
				segRes.notes.forEach((n) => debug(`payload: ${n}`));
				const built = buildFor(d, seps, segRes.segs);
				const devPages = built.pages;
				for (const n of built.notes) debug(`payload: 设备 ${d.id} ${n}`);
				debug(`send ${type} → ${d.id}(synology): pages=${devPages.length}${deviceHasCustomSeps(d) ? " [自定义分隔符]" : ""}${built.tpl.mode === "custom" ? " [自定义模板]" : ""}`);
				const devOut = [];
				for (let pi = 0; pi < devPages.length; pi++) {
					const p = devPages[pi];
					// ★件G：群晖重试**在逐页循环内**（重试不改变页间隔 ⇒ 限流语义不变）
					const r = await withRetry(d, `${type} → ${d.id}(synology) 第 ${pi + 1} 页`, () => sendSynologyDevice(d, p, _opts.synologyTimeoutMs), _opts.synologyRetries);
					// ★件J-乙：「将推 N 条」统计**按页更新**（逐页串行时最后一页即末态；并发时不再由"设备开始时的快照"抢占）
					lastSendStats.set(d.id, { at: Date.now(), type, pages: devPages.length, bodyLen: String(p).length, adjusted: built.adjusted, segs: segRes.segs, tpl: built.tpl, tplNotes: built.notes });
					devOut.push(r.ok ? { deviceId: d.id, status: "fulfilled" } : { deviceId: d.id, status: "rejected", error: sanitize(r.error?.message ?? r.error) });
					// ★不破坏项（硬）：**页间隔恒 1500ms**（与 `synologyConcurrency` 取值无关；并发只作用在"多台之间"）
					await new Promise((r2) => setTimeout(r2, SEND_PAGE_INTERVAL_MS));
				}
				synOut[i] = devOut;
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(_synConc, synList.length || 1)) }, _synWorker));
		for (const arr of synOut) if (arr) for (const r of arr) results.push(r);
		for (const r of results) {
			debug(`send ${r.status} type=${type} device=${r.deviceId}${r.status === "rejected" ? `: ${r.error}` : ""}`);
			if (r.status === "rejected") logger?.warn?.(`dsh-notify: 推送失败 [${type} → ${r.deviceId}]: ${r.error}`);
		}
		return results;
	});
	// 队列吞掉异常, 保证后续通知不被卡死 (v0.5.3 同款)
	sendQueue = run.then(() => {}, () => {});
	const results = await run;
	const sent = results.filter((r) => r.status === "fulfilled").length;
	const failed = results.length - sent;
	return { ok: failed === 0, sent, failed, results };
}

/** 按 type 路由发送 (§2.1 路由语义)。
 *  v0.9.0: 第 5 参 `vars` 供模板占位符使用（`{{question}}`/`{{answer}}`/`{{turn}}`…）；不传 ⇒ 空值。 */
export async function sendByType(type, title, pages, compose, vars) {
	const hub = await loadHub();
	const byId = new Map(asArray(hub.devices).map((d) => [d.id, d]));
	const devices = resolveRouteIds(hub, type).map((id) => byId.get(id)).filter(Boolean);
	return sendToDevices(devices, type, title, pages, compose, vars);
}

/** body → 页数组 (Synology 2000 硬上限; 供外部调用方的简易入口)。 */
function bodyPages(body) {
	const t = String(body ?? "");
	if (!t) return [];
	if (t.length <= SYNOLOGY_PAGE_LIMIT) return [t];
	return chunkText(t, SYNOLOGY_PAGE_LIMIT - 8);
}

/**
 * G7 (RD-32): `sent===0 && failed===0` 的零请求归因 —— 区分
 *   ① 「无启用设备」⇒ `no-devices`；② 「有启用设备但没有任何设备命中路由」⇒ `no-route`。
 *   (路由为空 = 该 type 显式关闭 / routeDefault 指向已删设备 / 未知 id 被过滤, §2.1)
 * 读配置失败 ⇒ 保守归 `no-route`（绝不谎报 no-devices）。
 * ⚠️ **第三态「内容为空」⇒ `no-content`**：由 `reportNoContent()` **先判**（RD-50），本函数只处理"内容非空"的零请求。
 */
async function zeroSendReason() {
	try {
		const hub = await loadHub();
		return allEnabledIds(hub).length === 0 ? "no-devices" : "no-route";
	} catch { return "no-route"; }
}

/**
 * G7 (RD-32): 零请求上报 —— 只在 `sent===0 && failed===0` 时**追加** `reason`，
 * 既有四键 `ok/sent/failed/results` 的形状与取值**逐字不变**（additive），并打一行 warn（文案含 type）。
 */
async function reportZeroSend(type, res) {
	if (res?.sent !== 0 || res?.failed !== 0) return res;
	const reason = await zeroSendReason();
	try {
		logger?.warn?.(reason === "no-devices"
			? `dsh-notify: 通知未送出 [${type}] — 无启用设备 (sent:0 failed:0, reason:no-devices)`
			: `dsh-notify: 通知未送出 [${type}] — 有启用设备但无设备命中路由 (sent:0 failed:0, reason:no-route)`);
	} catch { /* 日志失败不影响返回值 */ }
	debug(`send ${type}: 零请求上报 reason=${reason}`);
	return { ...res, reason };
}

/**
 * 返工修复 (2026-09-13 生产实测 · 跨组件形状错配): **内容为空是第三态** `no-content`。
 *
 * 生产实况: `dsh-taskqueue` 的 `queue.*` payload 只有 `{taskId,title,status,at,by}`（**无 `body`/`pages`**）
 * ⇒ `pages.length===0` ⇒ 零请求静默丢弃，而旧实现复用 `zeroSendReason()` 只看设备/路由 ⇒ **误报 `no-route`**
 * （`notify-debug.log`: `send queue.dispatched: 零请求上报 reason=no-route`，而 hub 里明明有 3 台 enabled 设备）。
 *
 * **判据顺序写死**（RD-50，additive 第三态；RD-32 只定义了前两态）：
 *   ① `pages.length===0`（payload 既无 `pages` 也无 `body`）⇒ **`no-content`**（先判，不看设备/路由）；
 *   ② 内容非空却仍零请求 ⇒ 才按设备/路由归因 ⇒ `no-devices` / `no-route`。
 * 形状：`reason` 仍是同一字段的附加值，既有四键 `ok/sent/failed/results` **逐字不变**。
 */
async function reportNoContent(type) {
	try {
		logger?.warn?.(`dsh-notify: 通知未送出 [${type}] — 内容为空 (payload 缺 body/pages) (sent:0 failed:0, reason:no-content)`);
	} catch { /* 日志失败不影响返回值 */ }
	debug(`send ${type}: 零请求上报 reason=no-content`);
	return { ok: true, sent: 0, failed: 0, results: [], reason: "no-content" };
}

/**
 * 对外接口 (G6/RD-31: **插件间唯一入口** —— 经 `ctx.provide("notifyHub")` 暴露为
 * `sendNotification`; 亦保留同函数别名 `send`。生产者优先 `sendNotification`、回退 `send`)。
 * @param {string} type 见 NOTIFY_TYPES
 * @param {{title?:string, body?:string, pages?:string[], vars?:object}} payload
 *   ⚠️ **`body` 或 `pages` 至少给一个** —— 只给 `title` 会被判内容为空（`reason:"no-content"`，通知不会发出）。
 *   v0.9.0：`vars` 是**模板占位符的附加变量**（可选；如 `{question,answer,turn,elapsed}`），
 *   只用于自定义模板；未配置模板时**完全不参与渲染**（legacy 逐字不变）。
 * @returns {Promise<{ok:boolean, sent:number, failed:number, results:Array, reason?:"no-route"|"no-devices"|"no-content"}>}
 *          `reason` 仅在 `sent===0 && failed===0`（零请求）时出现 (G7/RD-32 + RD-50)
 */
export async function sendNotification(type, payload = {}) {
	const title = String(payload?.title ?? "");
	const pages = Array.isArray(payload?.pages) && payload.pages.length
		? payload.pages.map((p) => String(p))
		: bodyPages(payload?.body);
	// ① 先判内容为空（RD-50 第三态）——**不要**复用 zeroSendReason(): 那会把"调用方没给 body"误报成路由问题
	if (!pages.length) return reportNoContent(type);
	// ② 内容非空 ⇒ 零请求才按 设备/路由 归因 (RD-32)
	const vars = payload?.vars && typeof payload.vars === "object" ? payload.vars : {};
	return reportZeroSend(type, await sendByType(type, title, pages, undefined, vars));
}

// ---- RPC 层 (§3.3 / §7) ----------------------------------------------------

class HubError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

function publicDevice(d, hub) {
	// 件B: 7 项分隔符**规整后的记法 + 实际文本**（客户端不得自行重算 ⇒ 单一来源）
	const seps = {};
	for (const s of SEP_SPECS) {
		const r = parseSepNotation(d[s.key], s.def, s.label);
		seps[s.key] = { spec: r.spec, text: r.text, configured: r.configured, note: r.note };
	}
	// 件C: 3 个「内容段」开关**规整后的值**（缺省/true ⇒ 开；显式 false ⇒ 关；客户端不得自行重算 ⇒ 单一来源）
	const segs = {};
	for (const s of SEG_SPECS) {
		const r = parseSegFlag(d[s.key], s.label);
		segs[s.key] = { value: r.value, configured: d[s.key] !== undefined, note: r.note };
	}
	return { id: d.id, name: d.name, kind: d.kind, urlTail: urlTail(d.url), enabled: d.enabled !== false, order: Number.isInteger(d.order) ? d.order : null, seps, segs, tpl: publicTpl(d, hub), bark: publicBark(d), lastSend: lastSendStats.get(d.id) ?? null };
}

/** v0.9.1: 设备模板的对外形状（**不含明文 URL**；回配置值 + 生效来源 + 所选模板）。 */
function publicTpl(d, hub) {
	const eff = effectiveTemplateFor(d, templateListOf(hub));
	return {
		templateId: typeof d.templateId === "string" ? d.templateId : "",
		effectiveId: eff.templateId,
		effectiveName: eff.templateName,
		missing: eff.missing,
		title: typeof d.tplTitle === "string" ? d.tplTitle : "",
		body: typeof d.tplBody === "string" ? d.tplBody : "",
		effectiveTitle: eff.title,
		effectiveBody: eff.body,
		titleSource: eff.titleSource,
		bodySource: eff.bodySource
	};
}

/** v0.9.0: Bark 渠道参数对外形状（未配置 ⇒ 空串/默认值；`configured` 标明哪些是设备 override）。 */
function publicBark(d) {
	const configured = {};
	for (const k of BARK_PARAM_KEYS) configured[k] = d[k] !== undefined;
	const bp = resolveBarkParams(d, "test");
	return {
		group: typeof d.barkGroup === "string" ? d.barkGroup : "",
		level: BARK_LEVELS.includes(d.barkLevel) ? d.barkLevel : "",
		sound: typeof d.barkSound === "string" ? d.barkSound : "",
		icon: typeof d.barkIcon === "string" ? d.barkIcon : "",
		effectiveIcon: bp.icon,
		iconDefault: DEFAULT_BARK_ICON,
		iconDisabled: bp.iconDisabled,
		isArchive: d.barkIsArchive === 0 ? 0 : 1,
		titlePrefix: d.barkTitlePrefix !== false,
		configured
	};
}

function assertDeviceUrl(url, kind) {
	let u;
	try { u = new URL(url); } catch { throw new HubError("bad-request", "URL 格式非法"); }
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HubError("bad-request", "URL 必须是 http/https");
	if (kind === "bark" && !resolveBark(url).key) throw new HubError("bad-request", "Bark URL 未含设备 key (形如 api.day.app/<KEY>)");
}

/** 新建设备时生成唯一 id (§7): bark → bark1/bark2/…; synology → chat/chat2/… */
export function nextDeviceId(hub, kind) {
	const used = new Set(asArray(hub?.devices).map((d) => d.id));
	if (kind !== "synology") {
		for (let i = 1; i < 1000; i++) if (!used.has(`bark${i}`)) return `bark${i}`;
		throw new HubError("bad-request", "设备数量已达上限");
	}
	if (!used.has("chat")) return "chat";
	for (let i = 2; i < 1000; i++) if (!used.has(`chat${i}`)) return `chat${i}`;
	throw new HubError("bad-request", "设备数量已达上限");
}

/** 设置卡快照 (get) —— v0.7.0 增补 `options` / `effective` / `types[].hasProducer` (§4)。 */
export async function snapshotHub() {
	const hub = await loadHub();
	// effective[type] = resolveRouteIds 的结果 (客户端"实际发往谁"以此为准, 不得自行重算)
	const effective = {};
	for (const t of NOTIFY_TYPES) effective[t.type] = resolveRouteIds(hub, t.type);
	return {
		version: hub.version,
		devices: asArray(hub.devices).map((d) => publicDevice(d, hub)),
		routeDefault: hub.routeDefault,
		routes: hub.routes,
		options: normalizeOptions(hub.options),
		types: NOTIFY_TYPES.map((t) => ({ type: t.type, label: t.label, group: t.group, level: t.level, hasProducer: t.hasProducer === true })),
		effective,
		allDeviceIds: asArray(hub.devices).map((d) => d.id),
		// 件B: 分隔符元数据（位置/默认/键）+ 生效面（客户端按此渲染，避免两套口径）
		sepMeta: SEP_SPECS.map((s) => ({ key: s.key, label: s.label, pos: s.pos, def: s.def })),
		// 件C: 「内容段」三开关元数据（默认全开＝现状；缺省/true ⇒ 开，显式 false ⇒ 关）
		segMeta: SEG_SPECS.map((s) => ({ key: s.key, label: s.label, pos: s.pos, def: s.def, missing: s.missing })),
		payloadTypes: [...PAYLOAD_TYPES],
		// v0.9.1: 模板库（内置两条始终在最前；usedBy = 实际生效到该模板的设备，含继承）
		templates: (() => {
			const list = templateListOf(hub);
			return list.map((t) => ({
				...t,
				usedBy: asArray(hub.devices).filter((d) => effectiveTemplateFor(d, list).templateId === t.id).map((d) => d.id)
			}));
		})(),
		tplMeta: {
			kinds: TEMPLATE_KINDS,
			keys: TEMPLATE_KEYS,
			placeholders: TPL_PLACEHOLDERS,
			examples: TPL_EXAMPLES,
			defaultTemplates: defaultTemplates(),
			limits: { title: TPL_TITLE_MAX, body: TPL_BODY_MAX, name: TEMPLATE_NAME_MAX, emoji: TPL_EMOJI_MAX },
			typeStatus: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.type, { emoji: (TYPE_STATUS[t.type] ?? ["", t.label])[0], status: (TYPE_STATUS[t.type] ?? ["", t.label])[1] }])),
			unavailablePreview: [...TPL_UNAVAILABLE_PREVIEW],
			barkLevels: BARK_LEVELS,
			barkParams: BARK_PARAM_KEYS,
			defaultBarkIcon: DEFAULT_BARK_ICON
		},
		defaults: internalDefaults(hub)
	};
}

/**
 * v0.9.0: 「内部默认配置」只读暴露 —— 用户要求「现在我们内部的对于 bark 和群晖的配置
 * 就当作默认配置暴露出来」。**只暴露默认值/生效值/结构，绝不暴露明文 URL 或 key**。
 */
export function internalDefaults(hub) {
	const opts = normalizeOptions(hub?.options);
	return {
		source: HUB_FILE,
		optionsDefaults: optionDefaults(),
		optionsEffective: opts,
		delivery: {
			synologyPageLimit: SYNOLOGY_PAGE_LIMIT,
			synologyPageIntervalMs: SEND_PAGE_INTERVAL_MS,
			barkTextLimit: BARK_TEXT_LIMIT,
			barkTimeoutMs: opts.barkTimeoutMs,
			barkRetries: opts.barkRetries,
			barkConcurrency: opts.barkConcurrency,
			synologyTimeoutMs: opts.synologyTimeoutMs,
			synologyRetries: opts.synologyRetries,
			synologyConcurrency: opts.synologyConcurrency
		},
		bark: {
			isArchive: 1,
			sound: "",
			icon: DEFAULT_BARK_ICON,
			iconHint: "默认 DSH 大肥鱼图标；设备级 barkIcon 可自定义 URL，写 none/- 可不带图标",
			groupByType: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.type, t.group])),
			levelByType: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.type, t.level]))
		},
		synology: { pageLimit: SYNOLOGY_PAGE_LIMIT, pageIntervalMs: SEND_PAGE_INTERVAL_MS },
		devices: sortedDevices(hub?.devices).map((d) => ({ id: d.id, name: d.name, kind: d.kind, order: d.order ?? null, enabled: d.enabled !== false, urlTail: urlTail(d.url) })),
		routeDefault: asArray(hub?.routeDefault),
		routes: hub?.routes ?? {},
		templates: templateListOf(hub)
	};
}

/** 生成新模板 id（tpl1…；避开内置与已有 id）。 */
export function nextTemplateId(list) {
	const used = new Set(asArray(list).map((t) => t.id));
	for (let i = 1; i < 1000; i++) if (!used.has(`tpl${i}`)) return `tpl${i}`;
	throw new HubError("bad-request", "模板数量已达上限");
}

/**
 * v0.9.1: 新增/编辑模板（模板库）。`{id?, name, title?, body?}`。
 * - 不传 id ⇒ 新增（自动 tplN）；传 id ⇒ 编辑（内置两条也可编辑，但不可删除）。
 * - 未给出的字段保持原值；空串允许（该字段回落 legacy）。
 * - 落盘的是**完整模板库**（含两条内置 + 自定义；不存 `builtin` 标记）。
 */
export async function saveTemplate(payload = {}) {
	const hub = await loadHub();
	const list = templateListOf(hub);
	const idIn = payload?.id == null ? "" : String(payload.id).trim();
	const name = String(payload?.name ?? "").trim();
	if (!name) throw new HubError("bad-request", "模板名称不能为空");
	if (name.length > TEMPLATE_NAME_MAX) throw new HubError("bad-request", `模板名称过长 (≤${TEMPLATE_NAME_MAX} 字符)`);
	let id;
	let prev = null;
	if (idIn) {
		if (!TEMPLATE_ID_RE.test(idIn)) throw new HubError("bad-request", "模板 id 非法");
		prev = list.find((t) => t.id === idIn) ?? null;
		if (!prev) throw new HubError("not-found", `模板 "${idIn}" 不存在`);
		id = idIn;
	} else {
		id = nextTemplateId(list);
	}
	const info = [];
	const normField = (field, max) => {
		const raw = payload?.[field];
		if (raw === undefined) return prev ? (prev[field] ?? "") : "";
		if (raw === null) return "";
		const v = String(raw).trim();
		if (v.length > max) info.push({ id, field, note: `${field} 超过 ${max} 字符 ⇒ 已截断` });
		return v.slice(0, max);
	};
	const emoji = normField("emoji", TPL_EMOJI_MAX);
	const title = normField("title", TPL_TITLE_MAX);
	const body = normField("body", TPL_BODY_MAX);
	const entry = { id, name, emoji, title, body };
	const next = idIn ? list.map((t) => (t.id === id ? entry : t)) : [...list, entry];
	const persisted = next.map(({ builtin, ...rest }) => rest);
	const saved = await saveHub({ ...hub, templates: persisted });
	debug(`notify-hub: saveTemplate id=${id} name=${name} title=${title ? title.length + "B" : "empty"} body=${body ? body.length + "B" : "empty"} (${idIn ? "edit" : "add"})`);
	for (const n of info) debug(`notify-hub: saveTemplate id=${id} ${n.note}`);
	return { id, template: { ...entry, builtin: id === "bark-default" || id === "synology-default" }, templates: templateListOf(saved), info };
}

/**
 * v0.9.1: 删除模板。内置两条（bark-default / synology-default）**不可删除**（可编辑）；
 * 仍被设备显式选用 ⇒ `bad-request` 并点名设备（不静默改绑）。
 */
export async function deleteTemplate(payload = {}) {
	const hub = await loadHub();
	const id = String(payload?.id ?? "").trim();
	if (!TEMPLATE_ID_RE.test(id)) throw new HubError("bad-request", "模板 id 非法");
	if (id === "bark-default" || id === "synology-default") throw new HubError("bad-request", "两条内置模板不可删除（可编辑内容；设备会按渠道默认回落）");
	const list = templateListOf(hub);
	if (!list.some((t) => t.id === id)) throw new HubError("not-found", `模板 "${id}" 不存在`);
	const users = asArray(hub.devices).filter((d) => d.templateId === id);
	if (users.length) throw new HubError("bad-request", `模板 "${id}" 仍被设备使用：${users.map((d) => d.name || d.id).join("、")} ⇒ 请先改绑到其它模板再删除`);
	const next = list.filter((t) => t.id !== id).map(({ builtin, ...rest }) => rest);
	const saved = await saveHub({ ...hub, templates: next });
	debug(`notify-hub: deleteTemplate id=${id} (remaining=${templateListOf(saved).length})`);
	return { id, templates: templateListOf(saved) };
}

/**
 * v0.9.0 兼容别名（旧客户端仍可能调用）：按 kind 编辑该渠道的内置默认模板。
 * 新 UI 用 saveTemplate/deleteTemplate；本端点保留为 additive，不删除旧调用方。
 */
export async function setTemplates(payload = {}) {
	const kind = String(payload?.kind ?? "").trim();
	if (!TEMPLATE_KINDS.includes(kind)) throw new HubError("bad-request", `kind 必须是 ${TEMPLATE_KINDS.join(" / ")}`);
	const id = defaultTemplateIdFor(kind);
	const hub = await loadHub();
	const cur = templateListOf(hub).find((t) => t.id === id) ?? { id, name: kind === "bark" ? "Bark 默认" : "群晖 默认", title: "", body: "{{body}}" };
	const r = await saveTemplate({ id, name: cur.name, ...(payload.title !== undefined ? { title: payload.title } : {}), ...(payload.body !== undefined ? { body: payload.body } : {}) });
	return { kind, templates: r.templates, info: r.info };
}

/**
 * v0.9.1: 模板预览（**零网络、零写盘**）。
 * payload：`{ templateId? , deviceId? , kind?, type?, ...样例句柄 }`。
 * - `deviceId` ⇒ 按该设备实际生效模板（含设备 override）；
 * - `templateId` ⇒ 预览该模板（不绑定设备）；`kind` 只决定 Bark 标题是否加前缀 / 分页上限；
 * - 都没给 ⇒ 该 kind 的内置默认模板。
 */
export async function previewTemplate(payload = {}) {
	const hub = await loadHub();
	const list = templateListOf(hub);
	let device = null;
	const deviceId = payload?.deviceId == null ? "" : String(payload.deviceId);
	if (deviceId) {
		device = asArray(hub.devices).find((d) => d.id === deviceId) ?? null;
		if (!device) throw new HubError("not-found", `设备 "${deviceId}" 不存在`);
	}
	const templateId = payload?.templateId == null ? "" : String(payload.templateId);
	let tplRec = null;
	if (templateId) {
		tplRec = list.find((t) => t.id === templateId) ?? null;
		if (!tplRec) throw new HubError("not-found", `模板 "${templateId}" 不存在`);
	}
	const kind = device?.kind ?? (TEMPLATE_KINDS.includes(payload?.kind) ? payload.kind : (templateId === "bark-default" ? "bark" : "synology"));
	const type = TYPE_MAP.has(payload?.type) ? payload.type : "task.done";
	const eff = device
		? effectiveTemplateFor(device, list)
		: (tplRec
			? { id: tplRec.id, name: tplRec.name, title: tplRec.title, body: tplRec.body, titleSource: "template", bodySource: "template", templateId: tplRec.id, templateName: tplRec.name, selectedTemplateId: tplRec.id, missing: false }
			: effectiveTemplateFor({ kind }, list));
	const typeSeps = resolveDeviceSeps(device ?? { id: "preview" }, type).seps;
	const [defEmoji, defStatus] = TYPE_STATUS[type] ?? ["", typeSpec(type).label];
	const sample = {
		...TPL_SAMPLE,
		status: defStatus, emoji: defEmoji,
		...(device ? { device: device.id, deviceName: device.name, kind: device.kind } : { kind })
	};
	for (const k of ["title", "status", "emoji", "session", "sid", "turn", "elapsedMs", "reason", "question", "answer", "summary", "footer", "body"]) {
		if (payload?.[k] !== undefined) sample[k] = payload[k];
	}
	const vars = buildTemplateVars({ type, title: sample.title, pages: [sample.body || ""], seps: typeSeps, device: device ?? { id: "preview", name: "预览设备", kind }, extra: { ...sample, tplEmoji: eff.emoji } });
	const base = {
		kind, type, deviceId: device?.id ?? null, templateId: eff.templateId ?? tplRec?.id ?? "", templateName: eff.templateName ?? tplRec?.name ?? "",
		source: { title: eff.titleSource, body: eff.bodySource }
	};
	if (!eff.body) {
		const segs = resolveDeviceSegs(device ?? {}, type).segs;
		const legacy = composeSynologyPages(sample.title, sample.question, sample.answer, sample.footer, typeSeps, segs);
		return {
			...base, mode: "legacy",
			title: sample.title,
			body: legacy.join("\n\n"),
			pages: legacy,
			notes: ["该模板正文为空 ⇒ 本次预览＝旧版组稿（真实发送同样走 legacy，逐字不变）", "预览不含真实标题/正文/问答（发送时才有）"]
		};
	}
	const r = renderForDevice({ kind, tpl: eff, vars, seps: typeSeps });
	const used = new Set(r.used || []);
	const missing = [...used].filter((k) => TPL_UNAVAILABLE_PREVIEW.has(k));
	if (missing.length) r.notes.push(`预览中这些占位符无真实值，按空串渲染：${missing.map((k) => "{{" + k + "}}").join("、")}（真实发送时才有）`);
	if (!device) r.notes.push("未指定预览设备 ⇒ 设备名/kind/分隔符按空/默认渲染");
	return {
		...base, mode: "custom",
		title: r.title,
		body: r.pages.join("\n"),
		pages: r.pages,
		notes: r.notes,
		used: r.used
	};
}

/** saveDevice (§7): 新建/编辑; 编辑时 url 留空 = 保留原值 (卡上只显示尾号)。 */
export async function saveDevice(payload) {
	const hub = await loadHub();
	const name = String(payload?.name ?? "").trim();
	const kind = String(payload?.kind ?? "").trim();
	const url = typeof payload?.url === "string" ? payload.url.trim() : "";
	const idIn = payload?.id == null ? "" : String(payload.id);
	if (!DEVICE_KINDS.includes(kind)) throw new HubError("bad-request", `kind 必须是 ${DEVICE_KINDS.join(" / ")}`);
	if (!name) throw new HubError("bad-request", "名称不能为空");
	if (name.length > 64) throw new HubError("bad-request", "名称过长 (≤64 字符)");
	let id;
	let finalUrl;
	let enabled;
	if (idIn) {
		if (!DEVICE_ID_RE.test(idIn)) throw new HubError("bad-request", "设备 id 非法");
		const prev = asArray(hub.devices).find((d) => d.id === idIn);
		if (!prev) throw new HubError("not-found", `设备 "${idIn}" 不存在`);
		id = idIn;
		finalUrl = url || prev.url;
		enabled = payload?.enabled === undefined ? prev.enabled !== false : payload.enabled === true;
	} else {
		id = nextDeviceId(hub, kind);
		if (!url) throw new HubError("bad-request", "新增设备必须填完整 URL");
		finalUrl = url;
		enabled = payload?.enabled === undefined ? true : payload.enabled === true;
	}
	assertDeviceUrl(finalUrl, kind);
	// ★件F: 组内序号（新增 ⇒ 该组 max+1；编辑 ⇒ 保持原 `order`；**不静默丢**）
	const _grp = asArray(hub.devices).filter((d) => d.kind === kind);
	const _maxOrder = _grp.reduce((m, d) => (Number.isInteger(d.order) && d.order > m ? d.order : m), 0);
	const _prevOrder = idIn ? _grp.find((d) => d.id === id)?.order : null;
	const device = { id, name, kind, url: finalUrl, enabled, order: Number.isInteger(_prevOrder) ? _prevOrder : _maxOrder + 1 };
	// ---- 件B: 分隔符 7 键（**additive**：未传的键 ⇒ 保持原值；新增设备不传 ⇒ 不建键）----
	const prevDev = idIn ? asArray(hub.devices).find((d) => d.id === id) : null;
	const sepInfo = [];
	// ---- 件C: 「内容段」3 键（**additive**：未传 ⇒ 保持原值；`true`/空/非法 ⇒ **删键**（回默认＝开）；`false` ⇒ 落盘 `false`）----
	const segInfo = [];
	if (payload?.sepReset === true) {
		// ★硬边界 (e)：『↩ 恢复默认（本设备）』**必须连带三开关一起复位**（同一开关量，不额外加控件）
		segInfo.push({ key: "*", label: "全部 3 个内容段开关", input: "(重置)", spec: "(默认＝开)", note: `已恢复设备 ${id} 的全部 3 个内容段开关默认（会话标题／问题／回答＝开；删除该设备的 3 个键；范围严格限本设备）` });
	} else {
		for (const s of SEG_SPECS) {
			const rawIn = payload?.[s.key];
			if (rawIn === undefined) {
				if (prevDev?.[s.key] !== undefined) device[s.key] = prevDev[s.key]; // 老客户端不传 ⇒ 不动
				continue;
			}
			const r = parseSegFlag(rawIn, s.label);
			if (r.drop) { segInfo.push({ key: s.key, label: `${s.label}段`, input: String(rawIn), spec: "开", note: r.note }); continue; }
			device[s.key] = false; // 只落盘「显式关」这一种值（＝true 不建键）
			segInfo.push({ key: s.key, label: `${s.label}段`, input: "false", spec: "关", note: `内容段「${s.label}」＝关 ⇒ 输出将省略该段与其相邻分隔符（甲）` });
		}
	}
	if (payload?.sepReset === true) {
		sepInfo.push({ key: "*", label: "全部 7 项", input: "(重置)", spec: "(默认)", note: `已恢复设备 ${id} 的全部 7 项分隔符默认（删除该设备的 7 个键；范围严格限本设备）` });
	} else {
		for (const s of SEP_SPECS) {
			const rawIn = payload?.[s.key];
			if (rawIn === undefined) {
				if (typeof prevDev?.[s.key] === "string") device[s.key] = prevDev[s.key]; // 老客户端不传 ⇒ 不动
				continue;
			}
			if (rawIn === null || String(rawIn).trim() === "") {
				sepInfo.push({ key: s.key, label: s.label, input: String(rawIn ?? ""), spec: "(删除键)", note: `${s.label} 配置为空 ⇒ 已按默认 ${s.def} 处理（删除该键）` });
				continue;
			}
			const r = parseSepNotation(rawIn, s.def, s.label);
			device[s.key] = r.spec; // 落盘**规整后的记法**（夹取/回退后的值 ⇒ 盘上不存越界值）
			sepInfo.push({ key: s.key, label: s.label, input: String(rawIn).slice(0, 64), spec: r.spec, note: r.note });
		}
	}
	// ---- v0.9.1: 设备选择的模板（templateId；空 ⇒ 删键，按渠道内置默认）----
	const tplInfo = [];
	if (payload?.templateId !== undefined) {
		const raw = payload.templateId;
		if (raw === null || String(raw).trim() === "") {
			tplInfo.push({ key: "templateId", note: "未指定模板 ⇒ 删除本设备的 templateId（按渠道内置默认模板）" });
		} else {
			const tid = String(raw).trim();
			if (!TEMPLATE_ID_RE.test(tid)) throw new HubError("bad-request", `模板 id 非法：${tid}`);
			if (!templateListOf(hub).some((t) => t.id === tid)) throw new HubError("bad-request", `模板 "${tid}" 不存在（先保存模板或刷新列表）`);
			device.templateId = tid;
			tplInfo.push({ key: "templateId", note: `本设备使用模板 "${tid}"` });
		}
	}
	// ---- v0.9.0: 模板 2 键（additive；空 ⇒ 删键回继承；`tplReset` ⇒ 两键全删）----
	if (payload?.tplReset === true) {
		tplInfo.push({ key: "*", note: `已恢复设备 ${id} 的模板配置（删除 tplTitle/tplBody ⇒ 继承渠道默认；范围严格限本设备）` });
	} else {
		for (const k of TEMPLATE_KEYS) {
			const rawIn = payload?.[k];
			if (rawIn === undefined) { if (typeof prevDev?.[k] === "string") device[k] = prevDev[k]; continue; }
			const max = k === "tplTitle" ? TPL_TITLE_MAX : TPL_BODY_MAX;
			if (rawIn === null || String(rawIn).trim() === "") {
				tplInfo.push({ key: k, note: `${k} 为空 ⇒ 删除本设备键（继承渠道默认 / legacy）` });
				continue;
			}
			const v = String(rawIn).trim();
			if (v.length > max) tplInfo.push({ key: k, note: `${k} 超过 ${max} 字符 ⇒ 已截断（不静默）` });
			device[k] = v.slice(0, max);
		}
	}
	// ---- v0.9.0: Bark 渠道参数 6 键（additive；空/非法 ⇒ 删键/忽略并报；默认＝type 冻结表）----
	const barkInfo = [];
	for (const k of BARK_PARAM_KEYS) {
		const rawIn = payload?.[k];
		if (k === "barkTitlePrefix") {
			if (rawIn === undefined) { if (prevDev?.barkTitlePrefix === false) device[k] = false; continue; }
			if (rawIn === false || rawIn === "false") device[k] = false;
			else barkInfo.push({ key: k, note: "barkTitlePrefix=true ⇒ 删除本设备键（恢复 [DSH] 前缀）" });
			continue;
		}
		if (k === "barkIsArchive") {
			if (rawIn === undefined) { if (prevDev?.barkIsArchive === 0) device[k] = 0; continue; }
			const n = Number(rawIn);
			if (n === 0 || n === 1) { if (n === 0) device[k] = 0; }
			else barkInfo.push({ key: k, note: `barkIsArchive=${String(rawIn)} 非法（只接受 0/1）⇒ 已忽略，保持原值` });
			continue;
		}
		if (rawIn === undefined) { if (typeof prevDev?.[k] === "string" && prevDev[k]) device[k] = prevDev[k]; continue; }
		const v = String(rawIn).trim();
		if (!v) { barkInfo.push({ key: k, note: `${k} 为空 ⇒ 删除本设备键（按 type 冻结表默认）` }); continue; }
		if (k === "barkLevel" && !BARK_LEVELS.includes(v)) {
			barkInfo.push({ key: k, note: `barkLevel=${v} 非法（只接受 ${BARK_LEVELS.join("/")}）⇒ 已忽略，保持原值` });
			continue;
		}
		if (k === "barkIcon" && v !== "none" && v !== "-" && !/^https?:\/\//i.test(v)) {
			barkInfo.push({ key: k, note: `barkIcon=${v} 非 http(s) URL（allowed: 空=默认 DSH 图标 / none / - / http(s) URL）⇒ 已忽略，保持原值` });
			continue;
		}
		const max = k === "barkIcon" ? 500 : 64;
		if (v.length > max) barkInfo.push({ key: k, note: `${k} 超过 ${max} 字符 ⇒ 已截断` });
		device[k] = v.slice(0, max);
	}
	// ★件B-补（`#A451` ②，用户口径）：「定义的总额外字符超过上限或者上限的 90% ⇒ 不接受更改（不然全是分隔符了）」
	const effTexts = {};
	for (const s of SEP_SPECS) if (typeof device[s.key] === "string") effTexts[s.key] = expandSepSpec(device[s.key]).text;
	const sepTotal = sepPageTotal(effTexts);
	if (sepTotal > SEP_TOTAL_BUDGET) {
		const worst = SEP_PAGE_KEYS.map((k) => [k, (effTexts[k] || "").length]).sort((a, b) => b[1] - a[1])[0];
		debug(`notify-hub: saveDevice id=${id} 分隔符总开销 ${sepTotal} 字符 > 上限 ${SEP_TOTAL_BUDGET}（页上限 ${SYNOLOGY_PAGE_LIMIT} 的 90%）⇒ 拒绝该次更改`);
		throw new HubError("bad-request", `分隔符总开销 ${sepTotal} 字符 超过上限 ${SEP_TOTAL_BUDGET}（＝页上限 ${SYNOLOGY_PAGE_LIMIT} 的 90%）⇒ 不接受该次更改；请减少其中一项（当前最长：${worst[0]} ${worst[1]} 字符）`);
	}
	const devices = idIn ? asArray(hub.devices).map((d) => (d.id === id ? device : d)) : [...asArray(hub.devices), device];
	const next = await saveHub({ ...hub, devices });
	debug(`notify-hub: saveDevice id=${id} kind=${kind} url=${urlTail(finalUrl)} enabled=${enabled} (url 明文不落日志)`);
	if (deviceHasCustomSeps(device)) debug(`notify-hub: saveDevice id=${id} 分隔符=${SEP_KEYS.filter((k) => typeof device[k] === "string").map((k) => `${k}=${device[k]}`).join(" ")}`);
	for (const n of sepInfo) if (n.note) debug(`notify-hub: saveDevice id=${id} 分隔符降级/变更: ${n.note}`);
	if (deviceHasCustomSegs(device)) debug(`notify-hub: saveDevice id=${id} 内容段=${SEG_KEYS.filter((k) => device[k] === false).map((k) => `${k}=关`).join(" ")}`);
	for (const n of segInfo) if (n.note) debug(`notify-hub: saveDevice id=${id} 内容段变更: ${n.note}`);
	if (typeof device.tplTitle === "string" || typeof device.tplBody === "string") debug(`notify-hub: saveDevice id=${id} 模板 override title=${device.tplTitle ? device.tplTitle.length + "B" : "继承"} body=${device.tplBody ? device.tplBody.length + "B" : "继承"}`);
	for (const n of tplInfo) if (n.note) debug(`notify-hub: saveDevice id=${id} 模板变更: ${n.note}`);
	for (const n of barkInfo) if (n.note) debug(`notify-hub: saveDevice id=${id} 渠道参数变更: ${n.note}`);
	return { id, devices: next.devices.map((d) => publicDevice(d, next)), sepInfo, segInfo, tplInfo, barkInfo };
}

/**
 * deleteDevice (§7): 同时从 routeDefault 与各 routes 中剔除。
 * v0.7.0 删设备规则 (§4): 原数组**非空**且过滤后为空 ⇒ **删键** (回落默认路由, 与旧行为一致,
 * 避免意外静音); 原数组**本来就是空** (显式关闭) ⇒ **保持空键**。
 */
export async function deleteDevice(payload) {
	const hub = await loadHub();
	const id = String(payload?.id ?? "");
	if (!asArray(hub.devices).some((d) => d.id === id)) throw new HubError("not-found", `设备 "${id}" 不存在`);
	const devices = asArray(hub.devices).filter((d) => d.id !== id);
	// ★件F: 删除后**该组** order 压缩为 1..N（消除空洞；不静默留洞）
	{
		const gone = asArray(hub.devices).find((d) => d.id === id);
		if (gone) { let n = 1; for (const d of sortedDevices(devices.filter((x) => x.kind === gone.kind))) d.order = n++; }
	}
	const routes = {};
	for (const [k, v] of Object.entries(hub.routes ?? {})) {
		const orig = asArray(v);
		const list = orig.filter((x) => x !== id);
		if (list.length) routes[k] = list; // 过滤后仍非空 ⇒ 保留
		else if (!orig.length) routes[k] = []; // 本就是显式关闭 ⇒ 保持空键
		// 原非空且过滤后为空 ⇒ 删键 (回落默认)
	}
	const next = await saveHub({ ...hub, devices, routes, routeDefault: asArray(hub.routeDefault).filter((x) => x !== id) });
	debug(`notify-hub: deleteDevice id=${id}`);
	return { devices: next.devices.map((d) => publicDevice(d, next)), routeDefault: next.routeDefault, routes: next.routes };
}

/**
 * setRoutes (§7): 未知 id 过滤; 未知 type 报 bad-request; routeDefault 只接受字符串数组。
 * v0.7.0 语义变更 (§1/§4): **空数组键原样保留** ⇒ 该 type 显式关闭 (零请求, 不回落默认);
 * 非数组的 route 值 ⇒ bad-request (避免脏值变成"静默关闭")。
 */
export async function setRoutes(payload) {
	const hub = await loadHub();
	const ids = new Set(asArray(hub.devices).map((d) => d.id));
	const clean = (v) => [...new Set(asArray(v).map((x) => String(x)))].filter((x) => ids.has(x));
	let routes = hub.routes ?? {};
	if (payload?.routes !== undefined) {
		if (!payload.routes || typeof payload.routes !== "object" || Array.isArray(payload.routes)) {
			throw new HubError("bad-request", "routes 必须是对象");
		}
		routes = {};
		for (const [k, v] of Object.entries(payload.routes)) {
			if (!TYPE_MAP.has(k)) throw new HubError("bad-request", `未知通知类型 "${k}"`);
			if (!Array.isArray(v)) throw new HubError("bad-request", `routes["${k}"] 必须是字符串数组`);
			routes[k] = clean(v); // 空数组保留 = 显式关闭 (§1); 未知 id 已过滤
		}
	}
	if (payload?.routeDefault !== undefined && !Array.isArray(payload.routeDefault)) {
		throw new HubError("bad-request", "routeDefault 必须是字符串数组"); // 契约 §7「只接受字符串数组」
	}
	const routeDefault = payload?.routeDefault === undefined ? asArray(hub.routeDefault) : clean(payload.routeDefault);
	const next = await saveHub({ ...hub, routes, routeDefault });
	debug(`notify-hub: setRoutes typeGroups=${Object.keys(next.routes).length} routeDefault=${next.routeDefault.length}`);
	return { routeDefault: next.routeDefault, routes: next.routes };
}

/**
 * setOptions (§4, v0.7.0 新增): 仅接受 minTurnMs / bannerSummary / reconcile;
 * 未给出的键保持原值; 非法值按 §3 规整 (**不报错**, 回写规整后的值)。
 */
export async function setOptions(payload) {
	const hub = await loadHub();
	const cur = normalizeOptions(hub.options);
	const raw = payload && typeof payload === "object" ? payload : {};
	// 逐键规整: 未给出 ⇒ 原值; 非法 ⇒ 原值 (§3 "非布尔 → 用默认", 此处默认即当前生效值)
	const next = normalizeOptions({
		...(raw.minTurnMs !== undefined ? { minTurnMs: raw.minTurnMs } : { minTurnMs: cur.minTurnMs }),
		...(raw.bannerSummary !== undefined ? { bannerSummary: raw.bannerSummary } : { bannerSummary: cur.bannerSummary }),
		...(raw.reconcile !== undefined ? { reconcile: raw.reconcile } : { reconcile: cur.reconcile }),
		// ★件G：5 键逐键透传（未给出 ⇒ 原值）；★件J-乙：＋ `synologyConcurrency`（共 6 键）
		...(raw.barkTimeoutMs !== undefined ? { barkTimeoutMs: raw.barkTimeoutMs } : { barkTimeoutMs: cur.barkTimeoutMs }),
		...(raw.barkRetries !== undefined ? { barkRetries: raw.barkRetries } : { barkRetries: cur.barkRetries }),
		...(raw.barkConcurrency !== undefined ? { barkConcurrency: raw.barkConcurrency } : { barkConcurrency: cur.barkConcurrency }),
		...(raw.synologyTimeoutMs !== undefined ? { synologyTimeoutMs: raw.synologyTimeoutMs } : { synologyTimeoutMs: cur.synologyTimeoutMs }),
		...(raw.synologyRetries !== undefined ? { synologyRetries: raw.synologyRetries } : { synologyRetries: cur.synologyRetries }),
		...(raw.synologyConcurrency !== undefined ? { synologyConcurrency: raw.synologyConcurrency } : { synologyConcurrency: cur.synologyConcurrency })
	}, cur);
	const saved = await saveHub({ ...hub, options: next });
	debug(`notify-hub: setOptions minTurnMs=${saved.options.minTurnMs} bannerSummary=${saved.options.bannerSummary} reconcile=${saved.options.reconcile} barkTimeoutMs=${saved.options.barkTimeoutMs} barkRetries=${saved.options.barkRetries} barkConcurrency=${saved.options.barkConcurrency} synologyTimeoutMs=${saved.options.synologyTimeoutMs} synologyRetries=${saved.options.synologyRetries} synologyConcurrency=${saved.options.synologyConcurrency}`);
	return { options: saved.options };
}

/** test (§7): 只打被点的那台设备 (不受 enabled / 路由影响)。 */
export async function testDevice(payload) {
	const hub = await loadHub();
	const id = String(payload?.id ?? "");
	const device = asArray(hub.devices).find((d) => d.id === id);
	if (!device) throw new HubError("not-found", `设备 "${id}" 不存在`);
	const title = `测试推送 · ${device.name}`;
	const body = `通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n设备: ${device.id} (${device.kind})\n这是一条来自 DSH 通知中枢的测试消息。`;
	// v0.9.0：测试推送同样走模板（用户可用真实通道验证自定义格式）；未配置模板 ⇒ legacy 逐字不变
	const res = await sendToDevices([device], "test", title, [body], undefined, {
		title, body, status: "测试推送", emoji: "🔔", session: device.name, sid: device.id, deviceName: device.name
	});
	const r = res.results[0];
	return { id, status: r?.status === "fulfilled" ? "ok" : "fail", ...(r?.status === "fulfilled" ? {} : { error: r?.error ?? "未发送" }) };
}

/**
 * ★件F（2026-10-05，用户令「可以 order也加 签卡吧」）：**渠道排序**（**仅同类型组内**，不跨组）。
 * payload `{ kind, ids }`：`ids` 必须是**该 kind 组现有设备的全集**的一个**不重复排列**（顺序即新顺序）。
 * 校验失败 ⇒ `bad-request` **指名原因**（**不得静默**）；成功 ⇒ 该组 `order` 写为 1..N，**不动 `devices` 数组**（数组＝存储顺序）。
 * RPC 形状 **additive**（新端点；不改既有端点载荷；零新增直连宿主接触点）。
 */
export async function reorderDevices(payload) {
	const hub = await loadHub();
	const kind = String(payload?.kind ?? "").trim();
	if (!DEVICE_KINDS.includes(kind)) throw new HubError("bad-request", `kind 必须是 ${DEVICE_KINDS.join(" / ")}`);
	const ids = asArray(payload?.ids).map((x) => String(x));
	const group = asArray(hub.devices).filter((d) => d.kind === kind);
	const groupIds = group.map((d) => d.id);
	const dup = ids.length !== new Set(ids).size;
	if (ids.length !== groupIds.length || dup || !ids.every((x) => groupIds.includes(x)))
		throw new HubError("bad-request", `ids 必须是「${kind} 组全部 ${groupIds.length} 台设备」的一个不重复排列（收到 ${ids.length} 项${dup ? "，含重复" : ""}；当前组内 = ${groupIds.join(",")}）`);
	ids.forEach((devId, i) => { group.find((d) => d.id === devId).order = i + 1; });
	const next = await saveHub({ ...hub, devices: asArray(hub.devices) });
	debug(`notify-hub: reorderDevices kind=${kind} ids=${ids.join(",")}`);
	return { kind, ids, devices: next.devices.map((d) => publicDevice(d, next)) };
}

/** 组装 /notify-hub handler (apply 与单测共用, 同 /model-console 先例)。 */export function createRpcHandler() {
	return async function handle(endpoint, payload) {
		try {
			switch (endpoint) {
			case "get": return { ok: true, value: await snapshotHub() };
			case "saveDevice": return { ok: true, value: await saveDevice(payload) };
			case "deleteDevice": return { ok: true, value: await deleteDevice(payload) };
			case "setRoutes": return { ok: true, value: await setRoutes(payload) };
			case "setOptions": return { ok: true, value: await setOptions(payload) };
			case "reorderDevices": return { ok: true, value: await reorderDevices(payload) };   // ★件F：渠道排序（仅同类型组内）
			case "saveTemplate": return { ok: true, value: await saveTemplate(payload) };       // v0.9.1：模板库新增/编辑
			case "deleteTemplate": return { ok: true, value: await deleteTemplate(payload) };   // v0.9.1：模板库删除（内置不可删）
			case "setTemplates": return { ok: true, value: await setTemplates(payload) };       // v0.9.0 兼容别名：按 kind 编辑内置默认
			case "preview": return { ok: true, value: await previewTemplate(payload) };         // v0.9.x：模板预览（零网络/零写盘）
			case "test": return { ok: true, value: await testDevice(payload) };
			default: return { ok: false, error: { code: "not-found", message: `未知端点 ${String(endpoint)}` } };
			}
		} catch (err) {
			const code = err instanceof HubError ? err.code : "internal";
			const msg = sanitize(err?.message ?? err);
			// 只打 endpoint 与脱敏后的消息, 绝不打 payload (可能含明文 url/key)
			logger?.warn?.(`dsh-notify: /notify-hub RPC ${String(endpoint)} 失败: ${msg}`);
			debug(`rpc ${String(endpoint)} 失败: ${msg}`);
			return { ok: false, error: { code, message: msg } };
		}
	};
}

/** 注入 apply 侧上下文 (迁移源/日志器/patch 阈值); 单测可直接设 env + 调 loadHub。 */
export function configureHub({ migration, log, minTurnMs } = {}) {
	if (migration) hubMigrationSource = migration;
	if (log) logger = log;
	// v0.7.0 (§3): options.minTurnMs 初值 = patch config.minTurnMs ?? 60000
	if (minTurnMs !== undefined) setOptionsDefaults(minTurnMs);
}

const fmtElapsed = (ms) => {

	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} 秒`;
	return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

/**
 * 代码层去除 Markdown 格式符号, 输出纯文本 (不依赖模型另答纯文本)。
 * 处理: 代码块/行内代码/标题/粗体/斜体/删除线/链接/图片/引用/表格/列表/分隔线/行内HTML。
 */
export function stripMarkdown(text) {
	if (!text) return "";
	let t = String(text);
	// 1) 代码块 ```lang\n...\n``` → 保留内部代码 (去围栏与语言标注)
	t = t.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
	// 2) 图片 ![alt](url) → alt
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	// 3) 链接 [text](url "title") → text (url)
	t = t.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (m, txt, url) => {
		const label = String(txt ?? "").trim();
		return label ? `${label} (${url})` : url;
	});
	// 3.5) 自动链接 <https://...> → 保留 URL (须在 HTML 标签去除之前)
	t = t.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");
	// 4) 行内代码 `code` → code
	t = t.replace(/`([^`]+)`/g, "$1");
	// 5) 粗体/斜体/删除线: **x** __x__ ~~x~~ *x* _x_ → x
	t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
	t = t.replace(/~~(.*?)~~/g, "$1");
	t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2");
	t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1$2");
	// 6) 标题 # → 去井号
	t = t.replace(/^#{1,6}\s+/gm, "");
	// 7) 引用 > → 去符号
	t = t.replace(/^\s*>\s?/gm, "");
	// 8) 表格: 分隔线行 (|--|) 删除(连行尾换行); 内容行去首尾竖线, 内竖线 → ·
	//    ⚠ 内容行必须用 [^\n]* 且不能以 \s*$ 跨界吞换行, 否则两行会粘成一行
	t = t.replace(/^\s*\|?[\s:|-]+\|?\s*(?:\n|$)/gm, "");
	t = t.replace(/^\s*\|([^\n]*)\|\s*$/gm, "$1");
	t = t.replace(/\s*\|\s*/g, " · ");
	// 9) 无序列表 - * + → - ; 有序列表保留数字
	t = t.replace(/^\s*[-*+]\s+/gm, "- ");
	// 10) 分隔线 --- *** ___ → 删除(连行尾换行)
	t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\n|$)/gm, "");
	// 11) 行内 HTML 标签 → 去标签
	t = t.replace(/<[^>]+>/g, "");
	// 12) 行首尾空白清理 + 压缩多余空行, 收尾
	t = t.replace(/^ +/gm, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
	return t;
}

/**
 * 按上限切块, 不切在 UTF-16 代理对中间 (emoji 等不产生乱码)。
 */
export function chunkText(text, limit) {
	if (!text) return [];
	const chunks = [];
	let rest = String(text);
	while (rest.length > limit) {
		let cut = limit;
		const c = rest.charCodeAt(cut - 1);
		if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/**
 * 按 Synology Chat 单条 2000 字符上限把通知拆成多条 (页), **纯文本格式** (v0.5.3):
 *   页 1:   ================================== (块首, 34 个 =)
 *           ✅ 标题 (✅完成/❌中断/⁉️提问 + 会话标题)
 *           ────────────────────────────── (问题↔回复分隔线, 30 个 ─)
 *           👀 问题
 *           <完整提问>
 *
 *           💡 回复
 *           <回答分块>
 *   续页:   <纯内容, 无页码无标签无装饰> (群晖 Chat 拼接短时间推送, 无缝续接)
 *   最后页: <内容结尾>
 *
 *           [回合/用时/原因/会话 页脚]
 *           ================================== (块尾)
 * 块首尾等号线区分不同通知块; 页脚只在最后页、结束等号前;
 * 回复中的 markdown 列表行自动转 ➡️ 选项; 提问极长 (>1500) 兜底截断。
 */
/** 纯文本分隔线 (Synology Chat 不渲染 markdown, 用全角字符做视觉分隔) */
const SEP = "=".repeat(34);
/** 问题↔回复 横向分隔线 (v0.5.3, 30 个 ─) —— ★件B 起其**真实位置**＝「标题与问题之间」（见 SEP_SPECS.sepTitleQ） */
const FIELD_SEP = "─".repeat(30);

// ---- 件B (2026-10-03 `#A449`): **分隔符按「位置」可配（7 处，逐台设备）** ----------
/**
 * ★7 个分隔符键（用户 `#A449`「全选」＝**全部 7 处**都要能单独配）。
 * **位置由「相邻两侧」定义**（不按常量沿革命名 —— 现读 `FIELD_SEP` 的名字与其真实位置并不一致）。
 * 默认值一律 ＝ **现读逐字现状**（未配置 ⇒ 输出与改动前 byte 级一致；判据① 用基线夹具对撞）。
 */
export const SEP_SPECS = [
	{ key: "sepHead", label: "消息开头", pos: "每条消息的第 1 行", def: "=*34" },
	{ key: "sepTail", label: "消息结尾", pos: "每条消息的最后 1 行", def: "=*34" },
	{ key: "sepTitleQ", label: "标题与问题之间", pos: "标题行下面（切开标题与正文/问题）", def: "─*30" },
	{ key: "sepQa", label: "问题与回答之间", pos: "「👀 问题」之后、「💡 回复」之前", def: "\\n*2" },
	{ key: "sepReplyFooter", label: "回答与页脚之间", pos: "回答之后、页脚行之前（单页消息）", def: "\\n*2" },
	{ key: "sepBodyFooter", label: "正文与页脚之间（多页最后一条）", pos: "多页时最后一条：正文之后、页脚行之前", def: "\\n*2" },
	{ key: "sepPageJoin", label: "分页消息之间的连接", pos: "仅 Bark：多页拼成一条时、页与页之间", def: "\\n*2" }
];
/** 7 键白名单（设备对象上只认这些键）。 */
export const SEP_KEYS = SEP_SPECS.map((s) => s.key);
/** 默认记法表（键 ⇒ `字符*次数`）。 */
export const SEP_DEFAULTS = Object.fromEntries(SEP_SPECS.map((s) => [s.key, s.def]));

// ---- 件C (2026-10-04 `#A462`): **「内容段」三开关（逐台设备各一份，additive）** ----------
/**
 * ★3 个内容段开关（用户裁定：「**选甲 保持简洁**」＝ 段关掉 ⇒ 相邻分隔符一并省略）。
 * **语义（固定，不得再改）**：**缺省 或 `true` ＝ 开；显式 `false` ＝ 关** ⇒ **未配置 ⇒ 逐字现状**。
 * 生效面与分隔符同（`PAYLOAD_TYPES` 四项）；其余类型（`test`／`queue.*`／`auth.*`）恒不读本组键。
 * **甲的实现口径**（`segPlanOf`）：某段被关 ⇒ 该段**与其相邻分隔符**一并省略；
 *   **该段本就不在输出里（空段）⇒ 开关无变化**（不得多出空行／孤立分隔符 ⇒ 逐字不变）。
 */
export const SEG_SPECS = [
	{ key: "segTitle", label: "会话标题", def: true, pos: "标题行（含状态前缀，如「✅ 任务完成 · 」）；相邻分隔符 sepTitleQ", missing: "四类均有该段" },
	{ key: "segQuestion", label: "问题", def: true, pos: "「👀 问题」块；相邻分隔符 sepTitleQ／sepQa", missing: "只有「需要你回应」类（task.asking）有该段；其余三类本就无 ⇒ 开关对其无效（关掉 ⇒ 输出逐字不变）" },
	{ key: "segAnswer", label: "回答", def: true, pos: "「💡 回复」块 ＋ **随附页脚**；相邻分隔符 sepQa／sepReplyFooter／sepBodyFooter", missing: "关掉本开关 ⇒ 回答段与**随附页脚**一并省略（用户逐字意图「只发标题和会话状态」）" }
];
/** 3 键白名单（设备对象上只认这些键）。 */
export const SEG_KEYS = SEG_SPECS.map((s) => s.key);
/** 默认值表（键 ⇒ `true`）。 */
export const SEG_DEFAULTS = Object.fromEntries(SEG_SPECS.map((s) => [s.key, s.def]));
/** ★生效面（`#A449` ⑥）：**只有「对话（回合级）」组四项**读设备分隔符；其余类型（含 `test`）恒走默认。 */
export const PAYLOAD_TYPES = new Set(["task.done", "task.asking", "task.interrupted", "subagent.done"]);

// ============================================================================
// 2026-11-22 v0.9.0：**通知格式完全自定义（{{占位符}}）+ 渠道参数**
//   需求（用户逐字）：「增加各个通知渠道的设置项目 用户允许完全自定义通知形式
//   然后我们能提供的文本用 {{}} 的形式提供占位」；「bark/群晖各自的默认模板 + 每台设备可覆盖」；
//   「内部 Bark/群晖 配置当作默认配置暴露出来」。
//   设计硬边界（与既有件B/C/E 不冲突）：
//   ① **未配置任何模板 / 渠道参数 ⇒ 走既有 legacy 组稿路径，输出逐字不变**（默认＝现状）；
//   ② 模板是**按设备（override）→ 按 kind（默认）** 的两级继承；空串 ＝ 继承；
//   ③ 未知占位符**原样保留 + 返回 note**（不静默），前端预览/保存后就地显示；
//   ④ 模板渲染后仍受群晖 2000 字符分页 / Bark 长度切分约束（不因自定义而拒收）。
// ============================================================================

/** 模板键（设备级 override；空 ⇒ 继承 kind 默认 ⇒ 再空 ⇒ legacy）。 */
export const TEMPLATE_KEYS = ["tplTitle", "tplBody"];
/** 模板 id / 名称 / 长度上限（v0.9.1 模板库）。 */
export const TEMPLATE_ID_RE = /^[a-z0-9_-]{1,32}$/;
export const TEMPLATE_NAME_MAX = 64;
export const TEMPLATE_KINDS = ["bark", "synology"];
export const TPL_TITLE_MAX = 300;
export const TPL_BODY_MAX = 4000;
export const TPL_EMOJI_MAX = 16;
/**
 * v0.9.1（用户 2026-11-22 更正）：「以模板化的方式去配置；没配置和初始状态就是两个通道各自一个模板，
 * 剩下的可以自己添加，然后自己配置」。
 * ⇒ 模板是**独立列表**（可增删改），每台设备**选一个模板**（一个模板可被多台设备共用；不按渠道限制）。
 * 两条内置模板用 `{{body}}` 包装旧版组稿 ⇒ **初始推送外观与 v0.8.x 逐字一致**；
 * Bark 的内置标题用 `{{title}}`，群晖内置标题为空（群晖无独立标题字段，正文里自带标题行）。
 */
export const DEFAULT_TEMPLATES = [
	{ id: "bark-default", name: "Bark 默认", emoji: "", title: "{{titleFull}}", body: "{{body}}", builtin: true },
	{ id: "synology-default", name: "群晖 默认", emoji: "", title: "", body: "{{body}}", builtin: true }
];
/** 内置模板副本（**两通道各一条，始终存在**；不可删除，可编辑）。 */
export function defaultTemplates() {
	return DEFAULT_TEMPLATES.map((t) => ({ ...t }));
}
/** 某渠道的内置默认模板 id。 */
export function defaultTemplateIdFor(kind) {
	return kind === "bark" ? "bark-default" : "synology-default";
}
/** Bark 设备级参数键（默认＝逐字现状；空/缺省 ⇒ 按 type 冻结表）。 */
export const BARK_PARAM_KEYS = ["barkGroup", "barkLevel", "barkSound", "barkIcon", "barkIsArchive", "barkTitlePrefix"];
/** Bark level 合法取值（官方 Bark 文档枚举）。 */
export const BARK_LEVELS = ["active", "timeSensitive", "passive", "critical"];
/** Bark 单条正文切分上限（保守值；超长按页切分后用 sepPageJoin 拼回）。 */
export const BARK_TEXT_LIMIT = 3800;

/** type ⇒ [emoji, status]（模板 `{{emoji}}`/`{{status}}` 的默认来源；未知 type 回落 label）。 */
const TYPE_STATUS = {
	"task.done": ["✅", "任务完成"],
	"task.asking": ["⁉️", "需要你回应"],
	"task.interrupted": ["❌", "回合被中断"],
	"subagent.done": ["🤖", "子 agent 完成"],
	"test": ["🔔", "测试推送"],
	"cost.alert": ["💰", "费用提醒"],
	"queue.dispatched": ["⛰", "队列派发"],
	"queue.cancelled": ["⛰", "队列取消"],
	"queue.failed": ["⛰", "队列失败"],
	"auth.login_failed": ["🔒", "登录失败"],
	"auth.locked": ["🔒", "触发锁定"],
	"auth.unlocked": ["🔓", "锁定期满"],
	"auth.new_device": ["✅", "新设备验证"],
	"auth.mfa_changed": ["🔐", "MFA 变更"],
	"auth.otp": ["🔢", "登录一次性码"]
};

/** 可在模板里使用的占位符（**唯一来源**：服务端 `get.tplMeta.placeholders` ⇒ 面板 chips）。 */
export const TPL_PLACEHOLDERS = [
	{ key: "title", label: "标题（纯标题）", desc: "纯标题文本，不含 emoji 前缀（如「任务完成 · 会话名」）；emoji 用 {{emoji}} 单独控制", sample: "任务完成 · 通知模板预览", group: "basic", common: true },
	{ key: "titleFull", label: "完整标题（含 emoji）", desc: "生产者原样标题（含 ✅/⁉️ 前缀）；兼容旧模板", sample: "✅ 任务完成 · 通知模板预览", group: "basic", common: false },
	{ key: "status", label: "状态文字", desc: "任务完成 / 需要你回应 / 回合被中断 / 子 agent 完成 等", sample: "任务完成", group: "basic", common: true },
	{ key: "emoji", label: "emoji（独立维度）", desc: "状态 emoji；模板里填了 emoji 字段时优先用它，否则按通知类型自动", sample: "✅", group: "basic", common: true },
	{ key: "session", label: "会话标题", desc: "会话名；取不到时由发送链路降级为会话短 id", sample: "通知模板预览", group: "basic", common: false },
	{ key: "sid", label: "会话短 id", desc: "8 位短 id，便于多会话区分", sample: "ab12cd34", group: "basic", common: false },
	{ key: "turn", label: "回合号", desc: "turn 编号（无则空串）", sample: "12", group: "basic", common: false },
	{ key: "elapsed", label: "回合用时（可读）", desc: "如「1分23秒」；非回合类通知为空", sample: "1分23秒", group: "basic", common: false },
	{ key: "elapsedMs", label: "回合用时（毫秒）", desc: "原始毫秒数", sample: "83000", group: "basic", common: false },
	{ key: "reason", label: "结束原因", desc: "turn/end 的 reason（done / interrupted…）", sample: "done", group: "basic", common: false },
	{ key: "question", label: "问题", desc: "本轮用户提问 / ask_user_question 的问题（已去 markdown）", sample: "帮我看看这个通知模板怎么配？", group: "content", common: false },
	{ key: "answer", label: "回答", desc: "本轮 assistant 答复（已去 markdown）", sample: "在「自定义格式」里用 {{占位符}} 组合标题和正文。", group: "content", common: true },
	{ key: "summary", label: "总结段落", desc: "回复里的总结段落（有则填）", sample: "总结：已支持自定义模板。", group: "content", common: false },
	{ key: "footer", label: "页脚", desc: "旧版格式的页脚（回合/用时/原因/会话）", sample: "回合 #12 完成 (用时 1分23秒) · 原因: done · 会话 ab12cd34", group: "content", common: false },
	{ key: "body", label: "旧版正文", desc: "按当前分隔符/内容段组好的旧版完整正文（可整段嵌入）", sample: "（旧版完整正文）", group: "content", common: true },
	{ key: "time", label: "当前时间", desc: "发送时刻 HH:mm:ss", sample: "16:31:16", group: "context", common: true },
	{ key: "date", label: "当前日期", desc: "发送日期 YYYY-MM-DD", sample: "2026-11-22", group: "context", common: false },
	{ key: "iso", label: "ISO 时间", desc: "带时区的 ISO 时间戳", sample: "2026-11-22T08:31:16.000Z", group: "context", common: false },
	{ key: "type", label: "通知类型", desc: "如 task.done / auth.otp", sample: "task.done", group: "context", common: false },
	{ key: "typeLabel", label: "类型中文名", desc: "通知项目表里的 label", sample: "对话完成（回合结束汇总）", group: "context", common: false },
	{ key: "group", label: "Bark group", desc: "该设备实际生效的 group（按 type 冻结表）", sample: "DSH-任务", group: "context", common: false },
	{ key: "level", label: "Bark level", desc: "该设备实际生效的 level", sample: "active", group: "context", common: false },
	{ key: "device", label: "设备 id", desc: "当前发送设备 id", sample: "bark1", group: "context", common: false },
	{ key: "deviceName", label: "设备名称", desc: "当前发送设备名称", sample: "iPhone 15", group: "context", common: true },
	{ key: "kind", label: "渠道类型", desc: "bark / synology", sample: "bark", group: "context", common: false },
	{ key: "sepHead", label: "分隔符：消息开头", desc: "该设备生效的 sepHead 文本", sample: "==================================", group: "sep", common: false },
	{ key: "sepTail", label: "分隔符：消息结尾", desc: "该设备生效的 sepTail 文本", sample: "==================================", group: "sep", common: false },
	{ key: "sepTitleQ", label: "分隔符：标题与问题之间", desc: "该设备生效的 sepTitleQ 文本", sample: "──────────────────────────────", group: "sep", common: false },
	{ key: "sepQa", label: "分隔符：问题与回答之间", desc: "该设备生效的 sepQa 文本", sample: "", group: "sep", common: false },
	{ key: "sepReplyFooter", label: "分隔符：回答与页脚之间", desc: "该设备生效的 sepReplyFooter 文本", sample: "", group: "sep", common: false },
	{ key: "sepBodyFooter", label: "分隔符：正文与页脚之间", desc: "该设备生效的 sepBodyFooter 文本", sample: "", group: "sep", common: false },
	{ key: "sepPageJoin", label: "分隔符：分页连接", desc: "Bark 多页拼接用的连接符", sample: "", group: "sep", common: false }
];
/** 示例模板（**只作起点**，不自动启用；应用后输出与 legacy 的差异由用户自己确认）。 */
export const TPL_EXAMPLES = {
	bark: {
		title: "{{emoji}} {{status}} · {{session}}",
		body: "{{status}}｜回合 #{{turn}}（{{elapsed}}）\n{{answer}}"
	},
	synology: {
		title: "",
		body: "{{sepHead}}\n{{title}}\n{{sepTitleQ}}\n👀 问题\n{{question}}\n💡 回复\n{{answer}}\n{{sepReplyFooter}}{{footer}}\n{{sepTail}}"
	}
};

/**
 * 规整模板列表：新数组 ／ v0.9.0 旧对象（`{bark,synology}`，读侧兼容）。
 * 只保留合法且唯一的 id；name/title/body 夹到上限。**空列表原样返回空**（由 templateListOf 补内置两条）。
 */
export function normalizeTemplateList(raw) {
	const out = [];
	const seen = new Set();
	const push = (t) => {
		if (!t || typeof t !== "object") return;
		const id = String(t.id ?? "").trim();
		if (!TEMPLATE_ID_RE.test(id) || seen.has(id)) return;
		seen.add(id);
		const name = String(t.name ?? id).trim().slice(0, TEMPLATE_NAME_MAX) || id;
		const emoji = typeof t.emoji === "string" ? t.emoji.trim().slice(0, TPL_EMOJI_MAX) : "";
		const title = typeof t.title === "string" ? t.title.trim().slice(0, TPL_TITLE_MAX) : "";
		const body = typeof t.body === "string" ? t.body.trim().slice(0, TPL_BODY_MAX) : "";
		out.push({ id, name, emoji, title, body });
	};
	if (Array.isArray(raw)) {
		for (const t of raw) push(t);
	} else if (raw && typeof raw === "object") {
		// v0.9.0 旧形状：渠道默认模板对象 ⇒ 转成两条内置模板
		for (const kind of TEMPLATE_KINDS) {
			const src = raw[kind];
			if (!src || typeof src !== "object") continue;
			push({
				id: defaultTemplateIdFor(kind),
				name: kind === "bark" ? "Bark 默认" : "群晖 默认",
				title: typeof src.title === "string" ? src.title : (kind === "bark" ? "{{title}}" : ""),
				body: typeof src.body === "string" ? src.body : "{{body}}"
			});
		}
	}
	return out;
}

/**
 * 实际生效的模板列表：两条内置模板**始终存在且排在最前**（可编辑、不可删除），
 * 自定义模板按存储顺序追加。**读取不写盘**（hub 里没有模板时也能得到初始两条）。
 */
export function templateListOf(hub) {
	const stored = normalizeTemplateList(hub?.templates);
	const map = new Map(stored.map((t) => [t.id, t]));
	const list = defaultTemplates().map((d) => {
		const s = map.get(d.id);
		if (!s) return d;
		// v0.9.2：旧版「Bark 默认」股票模板升级为 `{{titleFull}}`（保留原样完整标题 ⇒ 初始外观逐字不变；
		// 只命中股票值 `{{title}}` / `{{emoji}} {{title}}` + `{{body}}`，用户改过的不动）
		const stock = d.id === "bark-default" && !s.emoji && s.body === "{{body}}" && (s.title === "{{title}}" || s.title === "{{emoji}} {{title}}");
		const title = stock ? "{{titleFull}}" : s.title;
		return { id: d.id, name: s.name || d.name, emoji: s.emoji || "", title, body: s.body, builtin: true };
	});
	for (const t of stored) if (!list.some((x) => x.id === t.id)) list.push({ ...t, builtin: false });
	return list;
}

/**
 * 取设备实际生效的模板（v0.9.1 顺序）：
 *   **设备 override（tplTitle/tplBody，高级项）→ 设备选择的模板 → 该渠道内置模板 → legacy**
 * 设备选择了一个不存在的模板（被删/手工改盘）⇒ 回落内置模板并置 `missing`（调用方须上屏/记日志，不静默）。
 */
export function effectiveTemplateFor(device, templateList = hubTemplateList) {
	const list = asArray(templateList).length ? templateList : defaultTemplates();
	const want = typeof device?.templateId === "string" ? device.templateId.trim() : "";
	const selected = want ? list.find((t) => t.id === want) : null;
	const fallback = list.find((t) => t.id === defaultTemplateIdFor(device?.kind)) || list[0] || { id: "", name: "", title: "", body: "" };
	const base = selected || fallback;
	const tplTitle = typeof device?.tplTitle === "string" ? device.tplTitle.trim() : "";
	const tplBody = typeof device?.tplBody === "string" ? device.tplBody.trim() : "";
	return {
		id: base.id,
		name: base.name,
		emoji: base.emoji || "",
		title: tplTitle || base.title || "",
		body: tplBody || base.body || "",
		titleSource: tplTitle ? "device" : (base.title ? (selected ? "template" : "kind") : "legacy"),
		bodySource: tplBody ? "device" : (base.body ? (selected ? "template" : "kind") : "legacy"),
		templateId: base.id,
		templateName: base.name,
		selectedTemplateId: want,
		missing: !!want && !selected
	};
}

/** Bark 渠道实际生效参数：设备 override → type 冻结表 → 内置默认（isArchive=1 / 标题前缀开）。 */
export function resolveBarkParams(device, type) {
	const spec = typeSpec(type);
	const level = BARK_LEVELS.includes(device?.barkLevel) ? device.barkLevel : spec.level;
	const group = typeof device?.barkGroup === "string" && device.barkGroup.trim() ? device.barkGroup.trim() : spec.group;
	const sound = typeof device?.barkSound === "string" ? device.barkSound.trim() : "";
	const rawIcon = typeof device?.barkIcon === "string" ? device.barkIcon.trim() : "";
	// v0.9.0：默认 DSH 图标（大肥鱼）；`none` / `-` ⇒ 显式不发送 icon；其它值＝自定义 URL
	const icon = rawIcon === "none" || rawIcon === "-" ? "" : (rawIcon || DEFAULT_BARK_ICON);
	const isArchive = device?.barkIsArchive === 0 || device?.barkIsArchive === "0" ? 0 : 1;
	const titlePrefix = device?.barkTitlePrefix === false ? false : true;
	return { group, level, sound, icon, isArchive, titlePrefix, iconDefault: DEFAULT_BARK_ICON, iconDisabled: rawIcon === "none" || rawIcon === "-" };
}

/** 去掉标题开头的 emoji/空白（`{{title}}` 是纯标题；emoji 走 `{{emoji}}` 独立维度）。 */
export function stripLeadingEmoji(text) {
	return String(text ?? "").replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\s]+/u, "").trim();
}

/** 模板变量（**白名单构造**；未给值的一律空串，不把 undefined 写进输出）。 */
export function buildTemplateVars({ type, title, pages, seps, device, extra } = {}) {
	const spec = typeSpec(type);
	const [defEmoji, defStatus] = TYPE_STATUS[type] ?? ["", spec.label];
	const ex = (extra && typeof extra === "object") ? extra : {};
	const now = new Date();
	const list = asArray(pages).map((p) => String(p));
	const bp = resolveBarkParams(device, type);
	const fullTitle = String(title ?? "");
	// v0.9.6（用户 2026-11-23「DSH 直接去掉吧 没用了」）：标题前缀整体下线。
	// {{prefix}} 保留但恒为空串（旧模板里写了也不会变成未知占位符、不会原样输出）。
	const prefixText = "";
	const vars = {
		prefix: prefixText,
		title: stripLeadingEmoji(fullTitle),
		titleFull: fullTitle,
		body: list.join(seps?.sepPageJoin ?? "\n\n"),
		status: String(ex.status ?? defStatus ?? ""),
		emoji: String(ex.tplEmoji || ex.emoji || defEmoji || ""),
		session: String(ex.session ?? ""),
		sid: String(ex.sid ?? ""),
		turn: ex.turn == null ? "" : String(ex.turn),
		elapsed: String(ex.elapsed ?? (ex.elapsedMs != null ? fmtElapsed(Number(ex.elapsedMs)) : "")),
		elapsedMs: ex.elapsedMs == null ? "" : String(ex.elapsedMs),
		reason: String(ex.reason ?? ""),
		question: String(ex.question ?? ""),
		answer: String(ex.answer ?? ""),
		summary: String(ex.summary ?? ""),
		footer: String(ex.footer ?? ""),
		time: now.toLocaleTimeString("zh-CN", { hour12: false }),
		date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
		iso: now.toISOString(),
		type: String(type ?? ""),
		typeLabel: spec.label,
		group: bp.group,
		level: bp.level,
		device: String(device?.id ?? ""),
		deviceName: String(device?.name ?? ""),
		kind: String(device?.kind ?? ""),
		sepHead: seps?.sepHead ?? "",
		sepTail: seps?.sepTail ?? "",
		sepTitleQ: seps?.sepTitleQ ?? "",
		sepQa: seps?.sepQa ?? "",
		sepReplyFooter: seps?.sepReplyFooter ?? "",
		sepBodyFooter: seps?.sepBodyFooter ?? "",
		sepPageJoin: seps?.sepPageJoin ?? ""
	};
	return vars;
}

/**
 * 渲染模板：`{{name}}`（允许 `{{ name }}` 空格）；**未知占位符原样保留**并进 `unknown`（不静默）。
 * 永不 throw（非串入参按 String 处理；循环替换只做一遍，避免占位符值里的 `{{…}}` 被二次展开）。
 */
export function renderTemplate(tpl, vars) {
	const text = String(tpl ?? "");
	const used = new Set();
	const unknown = new Set();
	const out = text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, name) => {
		if (Object.prototype.hasOwnProperty.call(vars ?? {}, name)) {
			used.add(name);
			const v = vars[name];
			return v == null ? "" : String(v);
		}
		unknown.add(name);
		return m;
	});
	return { text: out, used: [...used], unknown: [...unknown] };
}

/** 模板渲染后的正文按渠道切分（群晖 2000 硬上限；Bark 3800 保守上限）。 */
export function splitTemplatedText(kind, text, seps) {
	const t = String(text ?? "");
	if (!t) return [];
	const limit = kind === "bark" ? BARK_TEXT_LIMIT : SYNOLOGY_PAGE_LIMIT;
	if (t.length <= limit) return [t];
	const out = [];
	let rest = t;
	while (rest.length > limit) {
		const cut = cutAtBoundary(rest, limit);
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) out.push(rest);
	return out;
}

/** 渲染模板 + 切分；返回 `{title, pages, notes}`（notes 含未知占位符/空输出等降级说明）。 */
export function renderForDevice({ kind, tpl, vars, seps }) {
	const notes = [];
	const titleR = renderTemplate(tpl?.title, vars);
	if (titleR.unknown.length) notes.push(`标题模板含未知占位符：${titleR.unknown.map((k) => `{{${k}}}`).join("、")}（原样保留）`);
	const bodyR = renderTemplate(tpl?.body, vars);
	if (bodyR.unknown.length) notes.push(`正文模板含未知占位符：${bodyR.unknown.map((k) => `{{${k}}}`).join("、")}（原样保留）`);
	const pages = splitTemplatedText(kind, bodyR.text, seps);
	if (!pages.length) notes.push("模板渲染结果为空 ⇒ 已回退旧版组稿（不静默）");
	return { title: titleR.text, pages, notes, used: [...new Set([...titleR.used, ...bodyR.used])] };
}

/** 预览用默认样例（`preview` RPC；不写盘、不发网络）。 */
const TPL_SAMPLE = {
	// v0.9.2：预览只给**真实可获取**的字段（设备名/时间/类型/状态/分隔符）；
	// 标题/正文/问答等无法在发送前取得 ⇒ 空串（不编造示例），由 notes 点名。
	title: "", titleFull: "", status: "", emoji: "", session: "", sid: "", turn: "", elapsed: "", elapsedMs: "", reason: "",
	question: "", answer: "", summary: "", footer: "", body: ""
};
/** 预览时无真实值、按空串渲染的占位符（必须在 notes 里点名，避免用户误以为坏了）。 */
const TPL_UNAVAILABLE_PREVIEW = new Set(["title", "titleFull", "body", "session", "sid", "turn", "elapsed", "elapsedMs", "reason", "question", "answer", "summary", "footer"]);

/** 记号次数范围（`#A449` ⑤）。 */
export const SEP_COUNT_MIN = 1;
export const SEP_COUNT_MAX = 60;
/** 字符部分上限（本线取值；`#A449` 未给 ⇒ 可改）。 */
export const SEP_BODY_MAX = 32;
/** 单条分隔符超过此长度即报一行（会明显挤占页预算）。 */
const SEP_LEN_WARN = 200;
// ---- 件B-补（`#A450`/`#A451` 用户令「截断长度要动态计算，不然输入 =*64 直接就炸了」＋「总额外字符超过上限或上限的 90% 就不接受更改」）----
/** **最小正文量**（本线取值，写明）：每页除头尾外，正文至少这么多字符；不足即触发降级。 */
export const PAGE_MIN_BODY = 200;
/** 页预算**安全余量**：避免正文余量正好顶到页上限，从而把『硬切』变成常规路径。 */
export const PAGE_SAFETY = 64;
/** **分隔符总开销上限** ＝ 页上限的 **90%**（用户口径）；超出 ⇒ **不接受该次更改**（拒配）。 */
export const SEP_TOTAL_BUDGET = Math.floor(SYNOLOGY_PAGE_LIMIT * 0.9);
/** 参与「上页开销」的 6 项（`sepPageJoin` 是页与页之间的连接、不计入单页长度）。 */
export const SEP_PAGE_KEYS = ["sepHead", "sepTail", "sepTitleQ", "sepQa", "sepReplyFooter", "sepBodyFooter"];
/** 渲染期降级记录（本轮调整说明；由 `takeComposeAdjust()` 取走 ⇒ 上屏/落 debug，不静默）。 */
let composeAdjust = [];
/** 最终硬切发生次数（判据③(c)：常规路径**不得**依赖它；>0 即说明页容量没算对）。 */
let hardSplits = 0;
export function takeHardSplits() { const n = hardSplits; hardSplits = 0; return n; }
/** 最近一次页面预算读数（判据③(a)：正文余量必须 >= PAGE_MIN_BODY）。 */
let lastBudget = { b1: 0, bl: 0, overhead: 0 };
export function lastComposeBudget() { return { ...lastBudget }; }
export function takeComposeAdjust() { const n = composeAdjust; composeAdjust = []; return n; }
/** 6 项「上页开销」字符合计（用于写入端总开销护栏）。 */
export function sepPageTotal(seps) {
	let t = 0;
	for (const k of SEP_PAGE_KEYS) if (typeof seps?.[k] === "string") t += seps[k].length;
	return t;
}

/** 转义还原：`\n` / `\t` / `\\`（其余字符原样）。 */
function expandEscapes(s) {
	return String(s).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}
/** 把记法 `字符*次数` 展开成实际文本（**不校验**；校验走 parseSepNotation）。 */
export function expandSepSpec(spec) {
	const s = String(spec ?? "");
	const i = s.lastIndexOf("*");
	if (i <= 0) return { spec: s, text: s };
	const body = expandEscapes(s.slice(0, i));
	const n = parseInt(s.slice(i + 1), 10);
	return { spec: s, text: body.repeat(Number.isFinite(n) ? Math.max(0, n) : 1) };
}
/**
 * 解析 + 规整分隔符记法（`#A449` ⑤）：越界 ⇒ 夹取；缺 `*次数`／非整数／空 ⇒ 回退默认；
 * **一切降级都返回 `note`（调用方必须上屏 ＋ 落一行 debug —— 不得静默）**。
 * `raw === undefined/null` ＝ **未配置** ⇒ 静默走默认（这是"逐字＝现状"的合法路径）。
 */
export function parseSepNotation(raw, defSpec, label = "") {
	const def = expandSepSpec(defSpec);
	if (raw === undefined || raw === null) return { spec: defSpec, text: def.text, note: null, configured: false };
	const t = String(raw).trim();
	const tag = `${label || "分隔符"}（默认 ${defSpec}）`;
	const bad = (why) => ({ spec: defSpec, text: def.text, note: `${tag}${why} ⇒ 回退默认 ${defSpec}，已按 ${defSpec} 处理`, configured: true });
	if (!t) return bad("配置为空");
	const i = t.lastIndexOf("*");
	if (i <= 0) return bad(`记法不合语法（须写「字符或短串*次数」，如 ${defSpec}）：${JSON.stringify(t)}`);
	let body = expandEscapes(t.slice(0, i));
	const cntRaw = t.slice(i + 1).trim();
	if (!/^-?\d+$/.test(cntRaw)) return bad(`次数非法：${JSON.stringify(cntRaw)}`);
	if (!body) return bad("字符部分为空");
	const cnt = parseInt(cntRaw, 10);
	let use = cnt, clipped = false, cut = false;
	if (cnt < SEP_COUNT_MIN) { use = SEP_COUNT_MIN; clipped = true; }
	else if (cnt > SEP_COUNT_MAX) { use = SEP_COUNT_MAX; clipped = true; }
	if (body.length > SEP_BODY_MAX) { body = body.slice(0, SEP_BODY_MAX); cut = true; }
	const spec = `${body}*${use}`;
	let note = null;
	if (clipped) note = `${tag}次数越界（${cnt} 不在 [${SEP_COUNT_MIN},${SEP_COUNT_MAX}]）⇒ 夹取到边界，已按 ${spec} 处理`;
	else if (cut) note = `${tag}字符部分超长（>${SEP_BODY_MAX}）⇒ 截断并报，已按 ${spec} 处理`;
	return { spec, text: body.repeat(use), note, configured: true };
}
/**
 * 取某设备在某 type 下**实际生效**的 7 项分隔符文本 ＋ 降级说明。
 * 生效面（`#A449` ⑥）：**非对话组四项 ⇒ 恒用默认**（其余类型波形逐字不变）。
 */
export function resolveDeviceSeps(device, type) {
	const on = PAYLOAD_TYPES.has(type);
	const seps = {};
	const notes = [];
	for (const s of SEP_SPECS) {
		if (!on) { seps[s.key] = expandSepSpec(s.def).text; continue; }
		const r = parseSepNotation(device?.[s.key], s.def, s.label);
		seps[s.key] = r.text;
		if (r.note) notes.push(`设备 ${device?.id ?? "?"} ${r.note}`);
		if (r.text.length > SEP_LEN_WARN) notes.push(`设备 ${device?.id ?? "?"} ${s.label} 生效长度 ${r.text.length} 字符（>${SEP_LEN_WARN}）⇒ 明显挤占页预算；页仍由最终硬切保证 ≤${SYNOLOGY_PAGE_LIMIT}`);
	}
	if (on) {
		// 件B-补：写入端已拒配超限值；此处兜「历史脏值 / 手工改盘」（渲染期会夹取并记录，不静默）
		const total = sepPageTotal(seps);
		if (total > SEP_TOTAL_BUDGET) notes.push(`设备 ${device?.id ?? "?"} 上页分隔符合计 ${total} 字符 > 上限 ${SEP_TOTAL_BUDGET}（页上限的 90%）⇒ 渲染期将夹取并记录（不静默）`);
	}
	return { seps, notes, scoped: on };
}
/** 设备是否配了任一分隔符键（仅用于 debug/诊断，不改变行为）。 */
export function deviceHasCustomSeps(device) {
	return SEP_KEYS.some((k) => typeof device?.[k] === "string" && device[k].trim() !== "");
}

/**
 * ★件C：解析单个「内容段」开关值。
 * **缺省 ⇒ 开（不建键）；`false` ⇒ 关（落盘 false）；`true`/空/非法 ⇒ 回退默认开（删键）**。
 * `absent`（`undefined`）＝ 老客户端不传 ⇒ **保持原值**（additive，不播种）。
 * 一切回退都返回 `note`（调用方必须上屏 ＋ 落一行 debug —— 不得静默）。
 */
export function parseSegFlag(raw, label = "") {
	const tag = `内容段「${label || "?"}」开关`;
	if (raw === undefined) return { value: true, drop: false, configured: false, absent: true, note: null };
	if (raw === false || raw === "false") return { value: false, drop: false, configured: true, absent: false, note: null };
	if (raw === true || raw === "true") return { value: true, drop: true, configured: true, absent: false, note: `${tag}显式设为「开」＝默认 ⇒ 保持默认（删除该键，不建键）` };
	if (raw === null || String(raw).trim() === "") return { value: true, drop: true, configured: true, absent: false, note: `${tag}配置为空 ⇒ 回退默认「开」（删除该键）` };
	return { value: true, drop: true, configured: true, absent: false, note: `${tag}值非法（${JSON.stringify(String(raw))}；只接受 true/false）⇒ 回退默认「开」（删除该键）` };
}

/**
 * ★件C：取某设备在某 type 下**实际生效**的 3 个内容段开关 ＋ 说明。
 * 生效面与分隔符同：**非对话组四项 ⇒ 恒全开**（其余类型波形逐字不变，含 `test`）。
 */
export function resolveDeviceSegs(device, type) {
	const segs = { ...SEG_DEFAULTS };
	const notes = [];
	if (!PAYLOAD_TYPES.has(type)) return { segs, notes, scoped: false };
	for (const s of SEG_SPECS) {
		const r = parseSegFlag(device?.[s.key], s.label);
		segs[s.key] = r.value;
		if (r.note) notes.push(`设备 ${device?.id ?? "?"} ${r.note}`);
		if (r.value === false) notes.push(`设备 ${device?.id ?? "?"} 内容段「${s.label}」＝关 ⇒ 该段与其相邻分隔符一并省略（甲）；${s.missing}`);
	}
	return { segs, notes, scoped: true };
}

/** 设备是否显式关掉任一段（仅用于 debug/诊断）。 */
export function deviceHasCustomSegs(device) {
	return SEG_KEYS.some((k) => device?.[k] === false);
}

/**
 * ★件C：把「内容段三开关」解析成**组稿计划**（`#A462` 甲口径）。
 * 关键不变式：
 *   · `emit.*` ＝ **该段真的会出现在输出里**（`present && on`）；**`present === false` ⇒ 开关无变化**（空段 ⇒ 逐字不变）。
 *   · `p3`（sepTitleQ）＝ 标题段的尾部：标题被关 ⇒ 随标题省略；**问题段存在却被关** ⇒ 随问题段省略；**问题段本就不存在 ⇒ 保留**（＝逐字现状，硬边界 (b)）。
 *   · `p4`／`p5` ＝ 两侧都还有内容才存在（一侧被关 ⇒ 一并省略，不留孤立分隔符／空行）。
 *   · `footer.on` ＝ **随「回答」开关**（用户逐字意图：「只发标题和会话状态」⇒ 关「回答」时页脚一并省略）。
 *   · `anyRemoved` ＝ 本次是否**真的**移除了东西 ⇒ 只有真移除才走「按实际输出重算页预算」的公式（否则逐字沿用现读公式 ⇒ byte 级不变）。
 */
export function segPlanOf(title, qLine, answer, footerText, segs) {
	const on = (k) => segs?.[k] !== false; // 缺省/true ⇒ 开
	const has = (x) => String(x ?? "").length > 0;
	const p = {
		title: { on: on("segTitle"), present: has(title), text: String(title ?? "") },
		question: { on: on("segQuestion"), present: has(qLine), text: String(qLine ?? "") },
		answer: { on: on("segAnswer"), present: has(answer), text: String(answer ?? "") }
	};
	p.footer = { on: p.answer.on, present: has(footerText), text: String(footerText ?? "") };
	p.emit = {
		title: p.title.present && p.title.on,
		question: p.question.present && p.question.on,
		answer: p.answer.present && p.answer.on,
		footer: p.footer.present && p.footer.on
	};
	p.p3 = p.emit.title && !(p.question.present && !p.question.on);
	p.p4 = p.emit.question && p.emit.answer;
	p.p5 = p.emit.answer && p.emit.footer;
	p.removed = {
		title: p.title.present && !p.title.on,
		question: p.question.present && !p.question.on,
		answer: p.answer.present && !p.answer.on,
		footer: p.footer.present && !p.footer.on
	};
	p.anyRemoved = p.removed.title || p.removed.question || p.removed.answer || p.removed.footer;
	return p;
}
/** 计划里的移除说明（供 debug ＋ 面板可见；**不静默**）。 */
export function segPlanNotes(plan) {
	const n = [];
	if (plan.removed.title) n.push("内容段「会话标题」＝关 ⇒ 已省略标题行与其相邻分隔符 sepTitleQ（甲）");
	if (plan.removed.question) n.push("内容段「问题」＝关 ⇒ 已省略问题块与其相邻分隔符 sepTitleQ／sepQa（甲）");
	if (plan.removed.answer) n.push("内容段「回答」＝关 ⇒ 已省略回答块与其相邻分隔符 sepQa／sepReplyFooter／sepBodyFooter（甲）");
	if (plan.removed.footer) n.push("页脚随「回答」段一并省略（随附尾部；用户口径「只发标题和会话状态」）");
	if (plan.answer.on && !plan.answer.present && plan.footer.present) n.push("本类型无「回答」段 ⇒ 该开关只影响随附页脚（已按「随回答」处理，如实登记）");
	if (!plan.question.on && !plan.question.present) n.push("本类型无「问题」段 ⇒ 该开关无变化（输出逐字不变，不留空行／孤立分隔符）");
	return n;
}
/** 每设备「上一次推送」读数（**仅内存**，不落盘；供设置卡显示"将推 N 条"的实测值）。 */
const lastSendStats = new Map();

/**
 * 检测 agent 回复是否以"提问"结尾 (v0.5.2, 用户要求: 回合结束在向用户提问时也要通知,
 * 否则用户不知道需要回应)。判定: 末尾或最后一行以 ?/？ 结尾, 或以中文问句短语结尾,
 * 或最后一行含强"等待回应"短语。启发式, 可能有个别误判, 但只影响通知文案不误伤功能。
 */
const QUESTION_SUFFIX = /[?？]\s*$/;
const QUESTION_PHRASE = /(可以吗|行吗|好吗|对吗|怎么样|如何|行不行|要不要|是否|确认吗|同意吗)\s*$/;
const WAITING_MARKS = ["请确认", "确认一下", "等你确认", "等你回应", "请回复", "请选择", "请回答", "需要你确认", "等待你的"];
export function isQuestionText(text) {
	if (!text) return false;
	let t = String(text).trim();
	// 去掉末尾的 markdown 装饰与闭合括号再判断 — 如 "你确认吗？**" (加粗结尾)、"（你确认吗？）"
	// 2026-08-29 实测: agent 常以 **...？** 提问, 不剥掉会漏判
	let prev;
	do {
		prev = t;
		t = t.replace(/[*_`~）)】》」』\s]+$/, "");
	} while (t !== prev && t.length > 0);
	if (!t) return false;
	if (QUESTION_SUFFIX.test(t) || QUESTION_PHRASE.test(t)) return true;
	const lastLine = t.split("\n").pop().trim();
	if (!lastLine) return false;
	if (QUESTION_SUFFIX.test(lastLine) || QUESTION_PHRASE.test(lastLine)) return true;
	return WAITING_MARKS.some((m) => lastLine.includes(m));
}

/**
 * 在预算内找最近的**段落/换行边界**切断 (v0.5.1 改进): 优先段落后 (\n\n),
 * 其次换行后 (\n), 都找不到 (超长单行) 才硬切; 窗口 = max(200, limit*50%)
 * 覆盖常见段落长度 (LLM 输出段落一般 <500 字, 50% 窗口足以命中其断点);
 * 同时不切碎 UTF-16 代理对 (emoji)。
 * @returns 实际切断位置 (切点之后的内容进入下一页)
 */
function cutAtBoundary(text, limit) {
	let cut = limit;
	const c = text.charCodeAt(cut - 1);
	if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
	const window = Math.max(200, Math.floor(cut * 0.5));
	const head = text.slice(0, cut);
	// 段落断点 (\n\n) 优先
	const paraIdx = head.lastIndexOf("\n\n");
	if (paraIdx >= cut - window) return paraIdx + 2;
	// 单换行其次
	const nlIdx = head.lastIndexOf("\n");
	if (nlIdx >= cut - window) return nlIdx + 1;
	// 都没有 → 硬切
	return cut;
}

/**
 * 按 Synology Chat 单条 2000 字符上限把通知拆成多条 (页), **纯文本格式** (v0.5.3):
 *   title 已含状态 emoji (✅ 完成 / ❌ 中断 / ⁉️ 提问)。
 *   块首尾 34 个 = ; 问题↔回复 30 个 ─ ; 👀 问题 / 💡 回复;
 *   回复中 markdown 列表行自动转 ➡️ 选项; 无 [x/y] 页码;
 *   续页 = 纯内容 (无缝拼接); 页脚只在最后页、结束等号前。
 * 提问极长 (>1500) 兜底截断, 保证任何输入都不产生超限消息。
 */
/**
 * 件B: 把「按设备生效的分隔符文本」规整成排版用的取色板。
 * 缺省/类型不符 ⇒ 逐字回落现读常量（⇒ 未配置设备的输出与改动前 byte 级一致）。
 */
function sepSetOf(seps) {
	const g = (k, fb) => (typeof seps?.[k] === "string" ? seps[k] : fb);
	return {
		head: g("sepHead", SEP),
		tail: g("sepTail", SEP),
		titleQ: g("sepTitleQ", FIELD_SEP),
		qa: g("sepQa", "\n\n"),
		replyFooter: g("sepReplyFooter", "\n\n"),
		bodyFooter: g("sepBodyFooter", "\n\n")
	};
}
/**
 * 历史多扣项（**保持与现读逐字等价**）：`:996-998` 的页预算里多算了一个 `FIELD_SEP.length`，
 * 而现读输出在「问题↔回答」处**已是空行** ⇒ 预算比实际多扣 31 字符（方向保守、不会超限）。
 * **留/删须用户裁**（删 ⇒ 每页多容纳 31 字符 ＝ 行为变化）；件B 按「留」实现。
 */
const GHOST_QA_RESERVE = FIELD_SEP.length;

/** 单页固定头尾合计（标题/两条分隔线/提问/回复标签/页脚/幽灵扣减 + 各 1 个换行）。 */
function pageOverheadOf(S, title, qLine, footerText) {
	return S.head.length + 1 + title.length + 1 + S.titleQ.length + 1
		+ qLine.length + 1 + GHOST_QA_RESERVE + 1 + "💡 回复".length + 1
		+ footerText.length + 1 + S.tail.length + 1;
}
/**
 * ★件C：**按实际输出**算首条固定开销（只数真的会写出去的段与其分隔符）。
 * 仅在「本次真的移除了段」（`plan.anyRemoved`）时启用 —— 三开关全开／空段开关无变化 ⇒ 仍走 `pageOverheadOf`
 *   （历史 GHOST 扣减按「留」实现），保证默认路径 **byte 级不变**（硬边界 (a)(b)）。
 */
function pageOverheadActual(S, plan, title, qLine, footerText) {
	let n = S.head.length;
	if (plan.emit.title) n += 1 + plan.title.text.length;
	if (plan.p3) n += 1 + S.titleQ.length;
	if (plan.emit.question) n += 1 + plan.question.text.length;
	if (plan.p4) n += S.qa.length;
	if (plan.emit.answer) n += 2 + "💡 回复".length; // 前导换行 ＋ 标签行后的换行（正文紧跟其后）
	if (plan.emit.footer) n += (plan.emit.answer ? S.replyFooter.length : 1) + plan.footer.text.length;
	return n + 1 + S.tail.length;
}
/** ★件C：**按实际输出**算「续页/末页」除正文外的开销。 */
function lastPageExtra(S, plan) {
	return (plan.emit.footer ? (plan.emit.answer ? S.bodyFooter.length : 1) + plan.footer.text.length : 0) + 1 + S.tail.length;
}
/** 开销取值器（**唯一取值点**：写入端护栏与组稿页预算都走它）：真移除 ⇒ 实际输出；否则 ⇒ 现读公式（逐字不变）。 */
function overheadFor(S, plan, title, qLine, footerText) {
	return plan && plan.anyRemoved ? pageOverheadActual(S, plan, title, qLine, footerText) : pageOverheadOf(S, title, qLine, footerText);
}
/**
 * ★件B-补（`#A451` ②）：**总开销护栏（渲染期）** —— 当「上页开销」大到正文余量 < `PAGE_MIN_BODY`
 * 时，按「最长者减半」逐轮**夹取**参与页面的 6 项分隔符；仍不够 ⇒ 该设备**整组回退默认**。
 * **一切调整都进 `composeAdjust`（⇒ debug ＋ 面板可见），不得静默**；默认分隔符下恒不触发（见套件断言）。
 */
function shrinkSepsToBudget(S, title, qLine, footerText, plan) {
	const notes = [];
	const KEYS = ["head", "tail", "titleQ", "qa", "replyFooter", "bodyFooter"];
	// 目标：正文余量 >= PAGE_MIN_BODY + PAGE_SAFETY（留安全余量，避免把"硬切"变成常规路径）
	const target = SYNOLOGY_PAGE_LIMIT - PAGE_MIN_BODY - PAGE_SAFETY;
	const defaults = sepSetOf(null);
	// ★只夹取「与默认不同」的项 ⇒ **未配置（走默认）的项一律不动** ⇒ 默认路径对任何输入都逐字不变
	const shrinkable = KEYS.filter((k) => typeof S[k] === "string" && S[k].length > 1 && S[k] !== defaults[k]);
	let cur = { ...S };
	if (overheadFor(cur, plan, title, qLine, footerText) <= target) return { S: cur, notes };
	if (!shrinkable.length) {
		notes.push(`页容量不足（题面/标题/页脚过长；无「已配置」的分隔符可夹取）⇒ 默认分隔符保持不变，末页由最终硬切兜底`);
		return { S: cur, notes };
	}
	for (let round = 0; round < 6; round++) {
		const over = overheadFor(cur, plan, title, qLine, footerText);
		if (over <= target) break;
		const ks = shrinkable.filter((k) => cur[k].length > 1);
		if (!ks.length) break;
		const before = ks.reduce((n, k) => n + cur[k].length, 0);
		const keep = Math.max(ks.length, before + (target - over));
		const scale = keep / before;
		for (const k of ks) cur[k] = cur[k].slice(0, Math.max(1, Math.floor(cur[k].length * scale)));
		const after = ks.reduce((n, k) => n + cur[k].length, 0);
		notes.push(`上页开销超出页预算（${over} > ${target}）⇒ 夹取 ${ks.join("/")}：${before} -> ${after} 字符（保证每页正文 >= ${PAGE_MIN_BODY}）`);
	}
	if (SYNOLOGY_PAGE_LIMIT - overheadFor(cur, plan, title, qLine, footerText) < PAGE_MIN_BODY) {
		for (const k of shrinkable) cur[k] = cur[k].slice(0, 1);
		notes.push(`已把已配置的分隔符夹取到最小（1 字符）仍不足 ⇒ 题面/标题/页脚过长，末页由最终硬切兜底`);
	}
	return { S: cur, notes };
}

export function composeSynologyPages(title, question, answer, footerText, seps, segs) {
	const q = String(question ?? "").trim();
	const qLine = q.length > 1500 ? `👀 问题\n${q.slice(0, 1500)}…` : (q ? `👀 问题\n${q}` : "");
	// 回复中 markdown 列表行 (- / * / + / 数字.) 自动转 ➡️ 选项 (v0.5.3, 用户确认)
	let rest = String(answer ?? "").trim()
		.replace(/^\s*[-*+]\s+/gm, "➡️ ")
		.replace(/^\s*\d+[.、]\s+/gm, "➡️ ");
	// ★件C（`#A462`）：「内容段」三开关 ⇒ 组稿计划（缺省/`true` ＝ 开 ⇒ **与改动前逐字同路**）
	const plan = segPlanOf(title, qLine, rest, footerText, segs);
	// ★件B-补：**页容量动态计算** —— 先按当前生效值算开销；余量不足 ⇒ 显式夹取（不靠固定下限掩盖）
	let S = sepSetOf(seps);
	const g = shrinkSepsToBudget(S, title, qLine, footerText, plan);
	S = g.S;
	for (const n of g.notes) composeAdjust.push(n);
	// ★件C：段被真的移除时落一行 debug（**不静默**；面板可见走 `lastSend.segs/segOmitted`）
	if (plan.anyRemoved) for (const n of segPlanNotes(plan)) debug(`payload: 内容段 ${n}`);
	// ---- 段级版式（甲）：消息头（恒在）→ 标题（＋P3）→ 问题（＋P4）→ 回答（＋P5/P6）→ 页脚 → 消息尾（恒在）----
	//   `sepHead`／`sepTail` 是**消息头尾**，不受段开关影响（用户口径）。
	let body = S.head;
	if (plan.emit.title) {
		body += `\n${plan.title.text}`;
		if (plan.p3) body += `\n${S.titleQ}`;
	}
	if (plan.emit.question) {
		body += `\n${plan.question.text}`;
		if (plan.p4) body += S.qa;
	}
	const pages = [];
	if (!plan.emit.answer) {
		// 无「回答」段（本类型无该段／被关／内容为空）⇒ 单条消息：标题（＋问题）＋页脚（未被关时）＋消息尾
		if (plan.emit.footer) body += `\n${plan.footer.text}`;
		pages.push(`${body}\n${S.tail}`);
		return pages;
	}
	// 页预算 = 上限 - 该页固定头尾 (标题/分隔线/提问/回复标签/页脚), 答案本体按预算切块;
	// 第 1 页按"单页含全部头尾"最坏情况算 (多页时第 1 页会略短, 安全);
	// 最后页 = 内容 + 页脚 + 块尾等号线; 中间续页 = 纯内容 (预算最大)。
	// ★件B: 头尾长度一律取**当前生效的分隔符长度**（不再是常量），否则页预算算错 ⇒ 群晖可能整条拒收。
	// ★件B-补: 下限由 120 改 **PAGE_MIN_BODY（200）**，且下限**不再掩盖问题** —— 余量不足已在上面显式夹取并记录。
	// ★件C: 只要**真的移除了段** ⇒ 开销按**实际输出**重算（关段省下的字符不挪作放宽预算的理由）；
	//        三开关全开／空段开关无变化 ⇒ 仍走现读公式（含历史 GHOST 扣减按「留」实现）⇒ byte 级不变。
	const overhead1 = overheadFor(S, plan, title, qLine, footerText);
	const extraLast = plan.anyRemoved ? lastPageExtra(S, plan) : (footerText.length + 1 + S.tail.length + 1);
	const b1 = Math.max(PAGE_MIN_BODY, SYNOLOGY_PAGE_LIMIT - overhead1);
	const bl = Math.max(PAGE_MIN_BODY, SYNOLOGY_PAGE_LIMIT - extraLast);
	lastBudget = { b1: b1, bl: bl, overhead: overhead1 };
	const chunks = [];
	let r = rest;
	let first = true;
	while (r.length > (first ? b1 : bl)) {
		chunks.push(r.slice(0, cutAtBoundary(r, first ? b1 : bl)));
		r = r.slice(chunks[chunks.length - 1].length);
		first = false;
	}
	if (r) chunks.push(r);
	const total = chunks.length;
	// P4 已作为「问题」段尾随写在 body 末尾 ⇒ 有它时不再补换行（缺 ⇒ 用 1 个换行接「💡 回复」）
	const answerHead = `${body}${plan.emit.question && plan.p4 ? "" : "\n"}💡 回复\n`;
	const footerTail = plan.emit.footer ? plan.footer.text : null;
	if (total === 1) {
		pages.push(`${answerHead}${chunks[0]}${footerTail === null ? "" : `${S.replyFooter}${footerTail}`}\n${S.tail}`);
		return pages;
	}
	chunks.forEach((chunk, i) => {
		if (i === 0) {
			pages.push(`${answerHead}${chunk}`);
		} else if (i === total - 1) {
			// 最后页: 内容 + 页脚 + 块尾等号线
			pages.push(`${chunk}${footerTail === null ? "" : `${S.bodyFooter}${footerTail}`}\n${S.tail}`);
		} else {
			// 续页: 纯内容, 无页码无标签无装饰
			pages.push(chunk);
		}
	});
	// 兜底: 极端输入仍超限时硬切 (宁丢格式不丢消息) —— ★自定义超长分隔符也由此保证**不拒收**
	return pages.flatMap((p) => (p.length > SYNOLOGY_PAGE_LIMIT ? (hardSplits++, chunkText(p, SYNOLOGY_PAGE_LIMIT)) : [p]));
}

// ---- 2026-09-10 (0.1.2 适配): agent.session.events 已不可用 ----
// 旧实现在这里直接 `session.events.findLast(...)` / `session.events` 反扫 → 0.1.2 抛
// "Cannot read properties of undefined" 且被上层静默吞掉 → **推送自 09-09 05:19 起完全停摆**
// (日志证据: 最后一次 send fulfilled = 05:19:54, 之后 turn/end 只到 hasChannel=true 就没了)。
// 改为: 观察者逐事件维护"各会话最近标题/用户问题/回答"缓存 (有界), 旧版仍回退扫 events。
const sessionEventCache = new Map(); // sid -> { title, userQ, assistantA }
const SESSION_CACHE_MAX = 300;
function cacheSessionEvent(session, event) {
	try {
		const sid = String(session?.id ?? "");
		if (!sid || !event?.type) return;
		let e = sessionEventCache.get(sid);
		if (!e) {
			e = { title: "", userQ: "", assistantA: "" };
			sessionEventCache.set(sid, e);
			if (sessionEventCache.size > SESSION_CACHE_MAX) {
				const oldest = sessionEventCache.keys().next().value;
				sessionEventCache.delete(oldest);
			}
		}
		if (event.type === "session/title" && typeof event.data?.title === "string") e.title = event.data.title;
		if (event.type === "user/message" && event.data?.source?.kind === "user") {
			const b = event.data?.content?.[0];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) e.userQ = b.text.trim();
		}
		if (event.type === "assistant/message") {
			const msg = event.data?.message ?? event.data;
			const blocks = Array.isArray(msg?.content) ? msg.content : [];
			const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
			if (text) e.assistantA = text;
		}
	} catch { /* 缓存失败不影响主流程 */ }
}

/* ==========================================================================================
 * ★2026-10-05 obs3S7（`#A481`）「通知标题退化成字面量 `会话`」修复 —— 根因 ＋ 口径
 *   · 根因（只读子线定死）：宿主 0.1.2-rc.1 起 `Session` **没有 `events` 属性**
 *     （公开面 = `surface`/`id`/`eventAt()`/`snapshotEvents()`/`ownEvents()`；`private eventsSnapshot` 才是私有的）；
 *     旧回退 `session?.events ?? []` ⇒ **恒空（死代码）**；进程内自建缓存又随**插件进程重启**清空
 *     （第 51 次部署 `20:56:29`）⇒ 标题恒 `""` ⇒ 三个 emit 点落到 `|| "会话"` 字面量。
 *   · 修法 ＝ **走官方面 ＋ 复用现成资产**：取值一律经 `@deepseek-ai/dsh-reconcile` 的 `readSessionEvents()`
 *     （三级回退 `session.events` → `snapshotEvents()` → `ownEvents()`；**从不抛错**、失败返回 `null`；
 *     `dsh-reconcile/lib/index.js:61-77`）—— **优先复用、禁自行重写**（`ENV §三.8`）。
 *     取用方式沿用既有 `loadReconcile()` 动态 import（`§10.1` 禁静态 import 共享包 ／ RD-37）。
 *   · 降级（**不得静默**）：取不到 ⇒ ① 标题显示**会话短 id**（复用既有 `sidShort` 口径，**不写字面量「会话」**）
 *     ② **记一行降级日志**（`LOG`，每会话首见）③ 经 host-compat `report` **面板可见**（能力键 `sessionEvents`）。
 * ========================================================================================== */
/** 会话事件读取器 —— apply 内由 `loadReconcile()` 取到（**唯一来源**；取不到 ⇒ `null` ⇒ 走降级，不伪造） */
let readSessionEvents = null;
/** 读会话事件：**从不抛错**；不可用/读不到 ⇒ `null`（调用方据此如实降级，禁静默吞掉） */
function sessionEventsOf(session) {
	if (typeof readSessionEvents !== "function") return null;
	try {
		const events = readSessionEvents(session);
		return Array.isArray(events) ? events : null;
	} catch { return null; }
}

/** 标题降级上报出口（apply 注入；未注入 ⇒ 只记日志 —— 仍然不静默） */
let reportTitleDegraded = null;
/** 标题降级计数（sid → 次数）：日志每会话只记一行，次数进面板文案（**可见、可 grep**）；上界与事件缓存同向 */
const titleDegradedCount = new Map();
const TITLE_DEGRADE_MAX = 300;

/** 最近一次会话标题 (session/title 事件), 无则空串（**取不到由调用方降级**） */
function sessionTitle(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.title) return cached.title;
	const events = sessionEventsOf(session);
	if (!events) return "";
	const ev = events.findLast((e) => e.type === "session/title" && typeof e.data?.title === "string");
	return ev?.data?.title ?? "";
}

/** 本轮最后一个真实用户消息 (source.kind="user") 的文本（**同一读取面，一并收敛**；取不到 ⇒ ""） */
function lastUserQuestion(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.userQ) return cached.userQ;
	const events = sessionEventsOf(session);
	if (!events) return "";
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type !== "user/message") continue;
		if (e.data?.source?.kind !== "user") continue;
		const block = e.data?.content?.[0];
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim();
	}
	return "";
}

/** 本轮最后一个 assistant 文本答复 (content 在 data.message.content, 兼容 data.content)（同形收敛） */
function lastAssistantAnswer(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.assistantA) return cached.assistantA;
	const events = sessionEventsOf(session);
	if (!events) return "";
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type !== "assistant/message") continue;
		const msg = e.data?.message ?? e.data;
		const blocks = Array.isArray(msg?.content) ? msg.content : [];
		const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
		if (text) return text;
	}
	return "";
}

/**
 * 通知标题里那一段「会话名」：真标题 ⇒ 用它；**取不到 ⇒ 会话短 id**（**禁字面量「会话」**）＋ 降级留痕。
 * `sidShort` = 调用点已算好的会话短 id（既有 `sidShort` 口径，三处 emit 点同款 ⇒ 恒非空）。
 */
function titleOrShort(session, sidShort) {
	const title = sessionTitle(session);
	if (title) return title;
	const sid = String(session?.id ?? "");
	const n = (titleDegradedCount.get(sid) ?? 0) + 1;
	if (!titleDegradedCount.has(sid) && titleDegradedCount.size >= TITLE_DEGRADE_MAX) {
		titleDegradedCount.delete(titleDegradedCount.keys().next().value); // 只淘汰最旧计数，不淘汰"已上报"事实
	}
	titleDegradedCount.set(sid, n);
	if (n === 1) LOG(`会话标题降级：取不到 session/title（会话 ${sidShort}；readSessionEvents=${typeof readSessionEvents === "function" ? "可用" : "不可用"}）⇒ 标题改显会话短 id（不静默）`);
	let total = 0;
	for (const v of titleDegradedCount.values()) total += v;
	reportTitleDegraded?.({ sidShort, count: n, total });
	return sidShort;
}

/**
 * 启发式提取回复文本中的"总结信息"段落, 无则返回 ""。
 * 匹配: 总结/小结/汇总/完成情况/任务总结/续接提示词 等标记开头的段落
 * (支持 "总结：", "## 总结", "【续接提示词】" 等常见形式)。
 * 提取自标记行起至回复尾部, 截断 400 字符 (横幅展示上限)。
 * 注: 横幅展示用原始文本 (保留 markdown), 与外部推送的去 markdown 纯文本互不影响。
 */
const SUMMARY_MARKS = ["总结", "小结", "汇总", "完成情况", "任务总结", "续接提示词"];
function extractSummary(text) {
	if (!text) return "";
	const lines = String(text).split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const isMark = SUMMARY_MARKS.some((m) =>
			line === m
			|| line.startsWith(`${m}：`) || line.startsWith(`${m}:`)
			|| (line.startsWith("#") && line.includes(m))
			|| line.includes(`【${m}】`) || line.includes(`[${m}]`)
		);
		if (isMark) { start = i; break; }
	}
	if (start < 0) return "";
	const out = lines.slice(start).join("\n").trim();
	return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

const DEBUG_ENABLED = process.env.DSH_NOTIFY_DEBUG === "1";
const DEBUG_LOG = joinPath(LOG_DIR, "notify-debug.log");
function debug(msg) {
	if (!DEBUG_ENABLED) return;
	try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

// 对账去重标记: 已补推过的中断回合 "会话id:回合号"
const RECONCILE_FILE = process.env.DSH_NOTIFY_RECONCILE_FILE || joinPath(PLUGIN_DATA, "notify-reconcile.json");

// ---- RD-37: 动态加载 reconcile（契约 §10.1 禁静态 import 共享包）----
// 静态 import 已删除（原 L2 `import { attachReconcile, … } from "@deepseek-ai/dsh-reconcile"`）：
// 缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环（阶段 0 F2 事故）。这里是**唯一**的对账入口，
// **禁止**再补一条"缺 reconcile 就退回旧路径"的静态兜底（§10.2 / D12）：取不到即停用该路径。
/** 该插件的 warn 出口（logger 在 apply 时注入；debug 落 $DSH_HOME/logs/notify）。 */
const LOG = (msg) => {
	try { logger?.warn?.(`dsh-notify: ${msg}`); } catch { /* ignore */ }
	debug(msg);
};
/** 由 apply 注入的"降级上报"钩子 (§4.10 report; reason 透传) —— 未 apply 时为 null（可选链兜底）。 */
let reportDegraded = null;
/** apply 早期（`reportDegraded` 就位之前）发生的降级暂存 ⇒ 就位后**补报**（禁止静默丢失）。 */
const pendingDegrades = [];
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
		if (reportDegraded) reportDegraded("reconcile");   // 有 host-compat 的插件必须上报（reason:"reconcile"）
		else pendingDegrades.push("reconcile");            // 早期加载 ⇒ 先暂存，就位后补报（不静默）
	}
	return reconcileMod;
}

// ---- 动态加载 banner-kit（契约 §10.1 禁静态 import 共享包; RD-28 横幅样板收敛）----
// 横幅写入（notice/banner 注入）**一律经 banner-kit.emit**，本插件不再自己调 §4.4 appendNotice；
// 取不到 ⇒ 横幅路径停用（§10.2 禁直连 session.append 兜底；外部推送/Bark 不受影响）。
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
			if (typeof _smB6.wrapBannerKit === "function") bannerKit = _smB6.wrapBannerKit(bannerKit, "dsh-notify");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	} catch (err) {
		bannerKitDead = true; bannerKit = null;
		LOG(`banner-kit 不可用 → 横幅注入停用: ${String(err?.message ?? err)}`);
		if (reportDegraded) reportDegraded("banner-kit");  // 有 host-compat 的插件必须上报（缺则停用，不回落旧直连路径）
		else pendingDegrades.push("banner-kit");           // 同上：早期加载 ⇒ 暂存待补报
	}
	return bannerKit;
}

export async function apply(ctx, config) {
	// ================= host-compat 适配闸门 (阶段 1; 契约 §2/§3/§4/§10) =================
	// 加载强制: 动态 import + try/catch (§2.3)。§10.1 禁静态 import host-compat/共享包 —
	// 缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环。§10.2 禁 legacy 直连兜底双路径 ⇒ 缺能力即停用 + 上报。
	const PLUGIN_ID = name;
	// v0.8.2 (RD-37/RD-28): 模块级 warn 出口 (LOG) 供 loadReconcile/loadBannerKit 的降级告警使用 ——
	// 必须在两处动态 import **之前**注入, 否则"缺包 ⇒ 路径停用"的告警会被静默吞掉 (§2.3 禁止静默)。
	logger = ctx.logger;
	// ★本件（标题取回 `#A481`）：**先解析** reconcile —— `readSessionEvents` 是会话标题/提问/答复的
	//   **唯一读取面**（官方面 = `snapshotEvents()`/`ownEvents()`），必须在**注册 `session/event` 订阅之前**
	//   取到（该回调是同步的，里面不能 await）；取不到 ⇒ 如实降级（标题显会话短 id ＋ 日志 ＋ 面板上报），**不静默**。
	const rcTitle = await loadReconcile();
	readSessionEvents = typeof rcTitle?.readSessionEvents === "function" ? rcTitle.readSessionEvents : null;
	if (!readSessionEvents) ctx.logger?.warn?.(`${PLUGIN_ID}: reconcile.readSessionEvents 不可用 → 会话标题/提问读取面停用（降级：标题如实显示会话短 id ＋ 面板可见，不静默）`);
	const { version: PLUGIN_VERSION, blocked: pkgBlocked } = ownMeta();
	// 路径级阻断清单 (RD-20): 运行时取自自身 package.json 的 dshCompat.blocked; 读失败 ⇒ 内置回退 + 告警
	const BLOCKING = (Array.isArray(pkgBlocked) ? pkgBlocked : BLOCKED_FALLBACK).filter((k) => REQUIRES.includes(k));
	if (!Array.isArray(pkgBlocked)) ctx.logger?.warn?.(`${PLUGIN_ID}: dshCompat.blocked 读取失败 → 回退内置清单 [${BLOCKING.join(", ")}]`);
	let seams = null;
	let compat = null;
	try { seams = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { ctx.logger?.warn?.(`dsh-notify: host-compat/seams 不可用 → 横幅注入/RPC 设置卡停用 (外部推送不受影响) (${String(err?.message ?? err)})`); }
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
	// 能力探测: 优先 host-compat `probe()` (§4.9); 未提供 ⇒ 本地按 §3 语义兜底 (只查本插件声明过的 key)
	const localMissing = () => REQUIRES.filter((k) => (k === "commands"
		? typeof ctx.commands?.register !== "function"
		// ★本件: `sessionEvents` 的本地口径 = 「会话事件读取器取到了没有」（＝标题面是否可用；probe 为权威面）
		: (k === "sessionEvents" ? typeof readSessionEvents !== "function" : typeof seamFn(k) !== "function")));
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
		} catch (err) { ctx.logger?.warn?.(`dsh-notify: probe() 失败 → 退回本地探测 (${String(err?.message ?? err)})`); }
	}
	// RD-20 ④: probe 可用 ⇒ 逐字采信其 state/blocked; 不可用 ⇒ 本地按同一清单兜底 (口径一致)
	const capBlocked = capBlockedProbe ?? capMissing.filter((k) => BLOCKING.includes(k));
	const capState = capStateProbe ?? (capBlocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK"));
	const capNote = capState === "OK" ? "" : "缺 eventTypeRegistry ⇒ 总结横幅停用(写未注册类型会让会话无法加载) · 缺 sessionAppend ⇒ 横幅不注入(外部推送照发) · 缺 rpcHandle ⇒ /notify-hub 设置卡停用(推送按已存配置继续) · 缺 commands ⇒ /notify-test 不可用 · 缺 sessionEvents ⇒ 会话标题/提问读取面停用(标题如实降级为会话短 id，不静默)";
	const finalNote = (capBlocked.length ? `${capNote}${capNote ? " ｜ " : ""}路径级阻断(仅停该能力对应路径): ${capBlocked.join(", ")}` : capNote) + (readySubState !== "absent" ? `${capNote ? " ｜ " : ""}就绪订阅: ${readySubState}${readySubReason ? `(${readySubReason})` : ""}` : ""); // 阻断清单＋就绪订阅状态并入面板文案
	if (capState !== "OK") ctx.logger?.warn?.(`dsh-notify: 适配状态 ${capState} — 缺能力 [${capMissing.join(", ")}] 阻断 [${capBlocked.join(", ")}]; ${finalNote}`);
	const capEntry = { id: PLUGIN_ID, version: PLUGIN_VERSION, state: capState, missing: capMissing, blocked: capBlocked, note: finalNote };
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	if (reporter) { try { reporter.report(capEntry); } catch { writeShard(ctx, capEntry); } } else writeShard(ctx, capEntry);
	// RD-37: reconcile 动态加载失败时的降级上报 (§4.10 report) —— state 只降不升 (OK ⇒ DEGRADED)；
	// `reason` 是 additive 元信息 (host-compat 只持久化 §5 分片 8 键) ⇒ 同时写进 note 以便面板可读。
	reportDegraded = (reason) => {
		const entry = {
			...capEntry,
			state: capState === "OK" ? "DEGRADED" : capState,
			reason,
			note: `${finalNote}${finalNote ? " ｜ " : ""}${reason} 不可用 → 对账路径停用 (reason:"${reason}")`
		};
		try { if (reporter) reporter.report(entry); else writeShard(ctx, entry); }
		catch { try { writeShard(ctx, entry); } catch { /* 上报失败不影响主流程 */ } }
	};
	// ★本件（标题取回 `#A481`）：**标题面降级上报** —— `ENV §一.6①`（闸门申报）＋`§一.7①`（走中间件、降级如实报）
	//   与 `reportDegraded` 同形（state **只降不升**）；host-compat 只持久化 §5 分片 8 键 ⇒ 细节写进 `note` 面板可读。
	reportTitleDegraded = ({ sidShort, count, total }) => {
		const entry = {
			...capEntry,
			state: capState === "OK" ? "DEGRADED" : capState,
			note: `${finalNote}${finalNote ? " ｜ " : ""}会话标题降级: 取不到 \`session/title\`（会话 ${sidShort}；本会话第 ${count} 次／累计 ${total} 次）⇒ 标题如实显示会话短 id (reason:"session-title")`
		};
		try { if (reporter) reporter.report(entry); else writeShard(ctx, entry); }
		catch { try { writeShard(ctx, entry); } catch { /* 上报失败不影响主流程 */ } }
	};
	// apply 早期（`reportDegraded` 就位之前）发生的降级 ⇒ **补报**（`loadReconcile` 已提前到 apply 开头）
	for (const reason of pendingDegrades.splice(0)) reportDegraded(reason);

	const capOk = (key) => !capMissing.includes(key) && !capBlocked.includes(key); // 阻断 key 同样按"该路径停用"处理 (RD-20)
	const seamWarned = new Set();
	/** 能力缺失/调用失败的统一告警 (每组合只报一次; §2.3 禁止静默) */
	function seamFail(what, reason) {
		const k = `${what}|${reason}`;
		if (seamWarned.has(k)) return;
		seamWarned.add(k);
		ctx.logger?.warn?.(`dsh-notify: ${what} 已停用 — ${reason} (契约 §10.2: 不降级为直连宿主)`);
	}
	/** §4.6 rpcHandle: 注册 /notify-hub (缺能力 ⇒ 设置卡不可用, 外部推送不受影响) */
	const rpcRegistered = new Set(); // ★ 批 4 件②：**幂等打标**（成功过即跳过，防宿主 `duplicate` 抛错）
	function registerRpc(channel, handler, options) {
		if (rpcRegistered.has(channel)) return { ok: true, already: true };
		// ★`#A57`：先试官方 Fetch 面（`/api/notify-hub/<ep>`）
		try {
			if (typeof seams?.channelFace === "function") {
				const eps = ["get", "saveDevice", "deleteDevice", "setRoutes", "setOptions", "reorderDevices", "saveTemplate", "deleteTemplate", "setTemplates", "preview", "test"];
				const face = seams.channelFace(ctx, channel, eps, handler);
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
			seamFail(`RPC ${channel}`, `rpcHandle 异常: ${sanitize(err?.message ?? err)}`);
			return { ok: false, reason: "rpcHandle" };
		}
	}

	// 注册自定义会话事件类型 notice/banner (dsh-notice-banner client 插件渲染横幅):
	// 非 surface 事件, 不进入模型历史; 经 seam §4.5 注册后持久化读取路径
	// (dsh-session-persistence assertEventsSupported) 才接受该类型, 否则会话日志重建会拒绝
	// 未知类型事件。注册幂等, 可重复执行; 注册失败 ⇒ 本插件停写该类型 (禁止直连宿主)。
	let noticeTypesOk = false;
	if (!capOk("eventTypeRegistry") || !seamFn("eventTypeRegistry")) seamFail("事件类型注册(notice/banner)", "缺能力 eventTypeRegistry");
	else {
		const r = seamFn("eventTypeRegistry")(["notice/banner"]);
		noticeTypesOk = r?.ok === true;
		if (!noticeTypesOk) seamFail("事件类型注册(notice/banner)", `ensureEventTypes 失败: ${r?.reason ?? "unknown"}`);
	}
	// ---- 横幅写入: 一律经 banner-kit (RD-28 收敛 appendNotice 样板; 语义逐字等价) ----
	// 默认分支（不传 opts.replace）⇒ 事件类型 notice/banner、mode="start"、rev = payload.rev ?? 0
	// —— 与改前直接 `seamFn("sessionAppend")(session, {kind:"notify", …})`（payload 无 rev ⇒ 0）逐字等价。
	// 取不到 banner-kit ⇒ 横幅路径停用（§10.2: 不回落直连 session.append 兜底）。
	let bannerReady = false;
	{
		const bkm = await loadBannerKit();
		if (typeof bkm?.emit !== "function") seamFail("总结横幅注入", "banner-kit 不可用 (契约 §10.2: 不回落直连兜底)");
		else {
			let reg = null;
			try { reg = await bkm.ensureRegistered(); } // 幂等; 失败 ⇒ 不注入（写未注册类型 = 会话无法加载）
			catch (err) { seamFail("总结横幅注入", `banner-kit.ensureRegistered 异常: ${sanitize(err?.message ?? err)}`); }
			if (reg && reg.ok !== true) seamFail("总结横幅注入", `banner-kit.ensureRegistered 失败: ${reg?.reason ?? "unknown"}`);
			bannerReady = reg?.ok === true && noticeTypesOk;
		}
	}
	/** 总结横幅注入 (RD-28/RD-26): 经 banner-kit.emit; **payload 与改前逐字一致**
	 *  ({kind:"notify", title, lines, turn, elapsedMs, reason, sessionShort, time}), rev 语义不变。
	 *  未就绪(banner-kit 缺失/类型未注册) ⇒ 停用该路径, 只记日志（外部推送已完成, 不静默）。永不 throw。 */
	async function injectNotice(session, payload) {
		if (!bannerReady) { seamFail("总结横幅注入", "banner-kit 不可用或 notice/banner 未注册"); return { ok: false, reason: "banner-kit" }; }
		try {
			const bk = await loadBannerKit();
			if (typeof bk?.emit !== "function") { seamFail("总结横幅注入", "banner-kit 不可用"); return { ok: false, reason: "banner-kit" }; }
			// P1-2: 去 session（`sessionId` 随 payload 走；双轨期旧日志由中间件按 sessionId 反查补写）
			// ★批7 `T15`：**稳定身份**
			// ★段2 `B3`：身份 = **`(dsh-notify|notify, sid)`** —— **去掉 `turn`**（每会话恒 1 张、后卡原地覆盖）；
			//   `ctxKey: "notify-<turn>"` **原样保留**（它是位置键，不是身份键）。
			const _cid = _cardId("dsh-notify|notify", String(session?.id ?? ""));
			const r = await bk.emit({ ...payload, sessionId: String(session?.id ?? ""), ctxKey: payload.turn != null ? "notify-" + payload.turn : null, cardId: _cid, anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD }, { source: "dsh-notify" });
			if (!r?.ok) seamFail("总结横幅注入", `banner-kit.emit 失败: ${r?.reason ?? "unknown"}`);
			return r ?? { ok: false, reason: "banner-kit" };
		} catch (err) {
			seamFail("总结横幅注入", `banner-kit.emit 异常: ${sanitize(err?.message ?? err)}`);
			return { ok: false, reason: "banner-kit" };
		}
	}
	// ---- 通知中枢接线 (Stage 1, 2026-09-12) ----
	// 迁移源 = 现有 patch 配置 + env 兜底 (§2.1 迁移); 无 notify-hub.json 时自动生成
	logger = ctx.logger;
	configureHub({
		migration: {
			barkKeys: config?.barkKeys ?? [],
			synologyWebhookUrl: config?.synologyWebhookUrl ?? "",
			envBarkKeys: process.env.DSH_BARK_KEYS ? process.env.DSH_BARK_KEYS.split(",").map((s) => s.trim()).filter(Boolean) : [],
			envSynologyUrl: process.env.DSH_SYNOLOGY_WEBHOOK_URL ?? ""
		},
		log: ctx.logger,
		// v0.7.0 (§3): patch config.minTurnMs 只作 options.minTurnMs 的初值
		minTurnMs: config?.minTurnMs
	});
	const minTurnMs = config?.minTurnMs ?? 60000;
	const hub = await loadHub();
	// v0.7.0: 运行时阈值/开关一律取 options 快照 (refreshHubFlags 随 loadHub 刷新)
	const opts0 = currentOptions();
	debug(`apply: patchMinTurnMs=${minTurnMs} options.minTurnMs=${opts0.minTurnMs} bannerSummary=${opts0.bannerSummary} reconcile=${opts0.reconcile} hub=${HUB_FILE} devices=${hub.devices.length} enabled=${allEnabledIds(hub).length} (url 明文不落日志)`);

	// /notify-hub RPC 通道 (§3.3; 已认证 = dsh 既有浏览器登录会话 RPC 面, 不新增免登录端点)。
	// 第三参 `{}` 必传 (宿主 register 读 options.authority), 作为 seam §4.6 第 4 参转发。
	/** ★ 批 4 件②：注册抽成具名幂等函数（`registerRpc` 内部已按 channel 打标 ⇒ 重复调用安全）。 */
	const triggerRegisterRpc = () => registerRpc(CHANNEL, createRpcHandler(), {});
	const rpcRes = triggerRegisterRpc();
	if (rpcRes?.ok) debug("apply: /notify-hub RPC 已注册");
	else ctx.logger?.warn?.(`dsh-notify: /notify-hub RPC 未注册 — ${rpcRes?.reason ?? "unknown"} (设置卡不可用; 外部推送不受影响)`);
	// ★ 批 4 件②（「丙」）：**仅"能力未就绪"才订阅**（其它失败＝真问题，不靠订阅掩盖）
	if (!rpcRes?.ok && rpcRes?.reason === "rpcHandle") {
		const sub = subscribeCompatReady(ctx, (reason, r) => {
			readySubState = r.ok ? "registered" : "failed";
			readySubReason = r.ok ? `就绪订阅触发(${reason}) ⇒ RPC 已补注册` : `就绪订阅触发(${reason}) ⇒ 补注册失败: ${r.reason}`;
			ctx.logger?.info?.(`dsh-notify: ${readySubReason}`);
		}, triggerRegisterRpc);
		readySubState = sub.state;
		readySubReason = sub.reason;
	}
	// 服务名 notifyHub (§2.3; G6/RD-31): **`sendNotification(type, payload)` 是插件间唯一入口** ——
	// 生产者一律 `ctx.get("notifyHub")` 后优先调 `sendNotification`; `send` 是同一函数的别名
	// (**additive**, 行为逐字不变, 老调用方不受影响)。
	try { ctx.provide?.("notifyHub", { send: sendNotification, sendNotification }); }
	catch (e) { ctx.logger?.warn?.(`dsh-notify: notifyHub 服务注册失败: ${sanitize(e?.message ?? e)}`); }

	// 回合计时: sessionId -> { turn, startTs }
	const turnStarts = new Map();

	/** ★ **子会话判定**（`#A410` 件1 → `#A424` **判据收窄**；仅用于**选 type**，不再用于"过滤掉不推"）。
	 *  **判据 ＝ 单一字段 `s.header.origin === "subagent"`** —— 官方类型面**明文**：
	 *    `dsh-session/lib/types/types.d.ts:83` `readonly origin?: 'subagent';`，逐字注释
	 *    「Coarse product classification for **a session created as a subagent child**」；
	 *    `session/event` 观测者拿到的是官方 `Session`（`dsh-session/lib/types/index.d.ts:64`
	 *    `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent)`；`readonly header: SessionHeader` `:118`）
	 *    ⇒ **（甲）明文允许**，未新增 `host-compat` 能力键、未扩包。
	 *  ★**`parentSession` 不作判据**（`types.d.ts:73` `readonly parentSession?: SessionId;`，逐字注释
	 *    「The session this one was **forked from (seed lineage)**, if any」＝ fork/种子血缘、**非子 agent 专有**）；
	 *    实测（`$DSH_HOME/sessions` 全量 463 会话首帧 header）**仅靠 `parentSession` 命中 5 个（≈1.1%）**，
	 *    全是 `origin` 缺失、`delegationDepth: 0` 的 **fork/种子会话** ⇒ 带上它会把它们**误判成子会话**
	 *    （行为偏差：这些会话的完成通知会错走 `subagent.done` 的渠道）。
	 *  ★**`delegationDepth` 亦不参与判据**（`types.d.ts:89`）：实测「仅靠它命中」＝ **0**，且与 `parentSession`
	 *    同属血缘字段 ⇒ 保留它＝在 `origin` 之外多一条口径（本件裁定「判据 ＝ `origin === 'subagent'`」，**无特例**）。
	 *  **缺 `header`／形状异常 ⇒ 返回 `false`（fail-open＝维持旧行为：仍按 `task.done` 推送/路由）**。 */
	function isChildSession(s) {
		const h = s?.header;
		if (!h || typeof h !== "object") return false;
		return h.origin === "subagent";
	}

	ctx.on("session/event", (session, event) => {
		cacheSessionEvent(session, event); // 2026-09-10: 0.1.2 无 session.events → 观察者侧自建缓存
		if (event.type === "turn/start" || event.type === "turn/end") debug(`event ${event.type} turn=${event.data?.turn} sid=${String(session?.id ?? "").slice(0, 12)}`);
		if (!session?.id || !event?.type) return;
		if (event.type === "turn/start" && typeof event.data?.turn === "number") {
			turnStarts.set(session.id, { turn: event.data.turn, startTs: Date.now() });
			// v0.7.0: 回合开始时刷新一次 hub/options 快照 (loadHub 按 mtime 失效) ⇒
			// 设置卡里刚改的 minTurnMs / bannerSummary 在本回合结束时即生效, 无需重启
			void loadHub().catch(() => {});
			return;
		}
		// v0.5.4 (用户要求): **仅真实 asking 状态触发"需要你回应"** —
		// agent 调用 ask_user_question 工具 (前端渲染选择组件等用户回答) 才推送,
		// 不再用文本问句启发式 (isQuestionText) 判定, 避免普通问句误触发。
		// 推送时机: tool/call 事件到达时 (回合仍在进行中, 用户在等前端选择),
		// 问题/选项从工具参数 arguments (JSON) 解析, 列表转 ➡️ 选项行。
		if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
			const turn = event.data?.turn;
			if (typeof turn !== "number") return;
			const sid = String(session.id ?? "");
			const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
			debug(`ask_user_question: turn=${turn} → 推送"需要你回应"`);
			let qText = "";
			let optionLines = [];
			try {
				const args = JSON.parse(String(event.data?.arguments ?? "{}"));
				const qs = Array.isArray(args?.questions) ? args.questions : [];
				qText = qs.map((q) => String(q?.question ?? "")).filter(Boolean).join("\n");
				optionLines = qs.flatMap((q) => Array.isArray(q?.options)
					? q.options.map((o) => String(o?.label ?? o ?? "")).filter(Boolean)
					: []);
			} catch { /* arguments 解析失败则回退到会话历史 */ }
			const rawQ = qText || lastUserQuestion(session);
			const rawA = optionLines.length
				? `请选择：\n${optionLines.map((o) => `➡️ ${o}`).join("\n")}`
				: lastAssistantAnswer(session);
			// v0.6.0: 标题里冗余的 "DSH" 字样移除 — 改由 Bark 统一 "[DSH] " 前缀承载 (§2.2),
			// 避免出现 "[DSH] ⁉️ DSH 需要你回应" 的双 DSH 字样 (2026-09-12 用户确认)。
			const qTitle = `⁉️ 需要你回应 · ${titleOrShort(session, sidShort)}`;
			const qFooter = `回合 #${turn} 在等你回应 · 会话 ${sidShort}`;
			const qPages = composeSynologyPages(qTitle, stripMarkdown(rawQ), stripMarkdown(rawA), qFooter);
			// 件B: composer 供「按设备分隔符」重排（未配置设备的 seps ＝ 默认 ⇒ 结果与 qPages 逐字相同）
			// ★件D／T50（`#A476`）修复：**必须两参透传**（消费者 `sendToDevices` 是 `compose(seps, segs)` 两参调用；
			//   一参闭包 ⇒ `segs` 被 JS 静默丢弃 ⇒ 内容段开关在**生产 emit 路径**上恒不生效）
			const qComposeForDevice = (seps, segs) => composeSynologyPages(qTitle, stripMarkdown(rawQ), stripMarkdown(rawA), qFooter, seps, segs);
			// v0.7.0 (§2 映射): 提问推送走独立 type task.asking (不受 options.minTurnMs 限制)
			// v0.9.0: 传 vars 供自定义模板使用（未配置模板时零影响）
			void sendByType("task.asking", qTitle, qPages, qComposeForDevice, {
				status: "需要你回应", emoji: "⁉️", session: titleOrShort(session, sidShort), sid: sidShort, turn,
				question: stripMarkdown(rawQ), answer: stripMarkdown(rawA), footer: qFooter
			});
			return;
		}
		if (event.type !== "turn/end") return;
		const start = turnStarts.get(session.id);
		turnStarts.delete(session.id);
		if (!start) return;
		/* ★ **子 agent 会话不再被过滤掉**（`#A424` 路线化；用户令「他也要像其他的通知一样 做成一个可以选择推送渠道的选项」）——
		 *   子会话的 `turn/end` 改走**独立可路由 type** `subagent.done`（判据见 `isChildSession`：
		 *   `origin === "subagent"`；**取不到 `header` ⇒ fail-open，仍走 `task.done`**）。
		 *   ★**只占"选渠道"这一维**：`elapsed` / `minTurnMs` 阈值 / 横幅注入 / 标题正文分页
		 *     **与主会话逐字同路**（**不特判、不分叉**）；`subagent.done` **完全遵守既有路由规则**
		 *     （缺键 ⇒ `routeDefault` 兜底；配了 ⇒ 按配置；配成 `[]` ⇒ 不推）——**严禁为其写任何特判，
		 *     严禁播种／写 `$DSH_HOME/notify-hub.json`**。
		 *   ★**主会话恒走 `task.done`**，不受本改动影响。
		 *   ★**不覆盖**：`ask_user_question`（`task.asking`）／`interrupted`（`task.interrupted`）两条路径
		 *     未加会话维度（本件范围外，如实登记）。
		 *   ★**不受本改动影响**：宿主 `dsh-subagent` 注入的 `subagent-settled` notice 及其**唤醒父会话**行为（用户已裁「不做」）。 */
		const isChild = isChildSession(session);
		const doneType = isChild ? "subagent.done" : "task.done";
		const elapsed = Date.now() - start.startTs;
		if (!hubHasChannel) return;
		// v0.7.0 (§3): 门槛取 options.minTurnMs (设置卡可改, 立即生效); patch 配置只提供初值
		const thresholdMs = currentOptions().minTurnMs;
		debug(`turn/end: elapsed=${elapsed}ms threshold=${thresholdMs}ms hubHasChannel=${hubHasChannel}`);
		const turn = event.data?.turn ?? start.turn;
		const rawReason = event.data?.reason;
		const reasonText = typeof rawReason === "string"
			? rawReason
			: rawReason && typeof rawReason === "object"
				? (rawReason.kind ?? JSON.stringify(rawReason))
				: "unknown";
		const sid = String(session.id ?? "");
		const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
		// v0.5.0: 外部推送用去 markdown 的完整问答; 横幅总结仍用原始文本
		const rawQ = lastUserQuestion(session);
		const rawA = lastAssistantAnswer(session);
		if (elapsed < thresholdMs) return;
		const summary = extractSummary(rawA);
		const title = `✅ 任务完成 · ${titleOrShort(session, sidShort)}`;
		const footer = `回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 原因: ${reasonText} · 会话 ${sidShort}`;
		const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
		// 件B: composer 供「按设备分隔符」重排（未配置设备的 seps ＝ 默认 ⇒ 与 pages 逐字相同）
		// ★件D／T50（`#A476`）修复：两参透传（同 `:1916` 口径；一参 ⇒ `segs` 静默丢）
		const composeForDevice = (seps, segs) => composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer, seps, segs);
		// v0.7.0 (§2 映射): 回合结束推送走独立 type task.done
		// `#A424`: 子 agent 会话（`origin === "subagent"`）改走 subagent.done（**可独立选渠道/关闭**）——
		// 只换 type，其余（阈值命中、路由规则、正文分页）逐字同路；**不特判、不播种 hub**。
		debug(`turn/end: type=${doneType}${isChild ? " (子 agent 会话)" : ""} turn=${turn} sid=${sid.slice(0, 12)}`);
		// v0.9.0: 传 vars 供自定义模板使用（未配置模板时零影响；模板里的 {{title}} 仍是完整标题）
		void sendByType(doneType, title, pages, composeForDevice, {
			status: isChild ? "子 agent 完成" : "任务完成", emoji: isChild ? "🤖" : "✅",
			session: titleOrShort(session, sidShort), sid: sidShort, turn,
			elapsed: fmtElapsed(elapsed), elapsedMs: elapsed, reason: reasonText,
			question: stripMarkdown(rawQ), answer: stripMarkdown(rawA), footer, summary
		});
		// 本地横幅 (v0.3.0, 用户要求): 普通完成通知内容与外部推送相同,
		// 不再在 GUI 重复弹"任务完成"浮窗; 仅当回复含"新的总结信息"
		// (总结段落, extractSummary 启发式) 时注入, 以【总结】展示
		// 通知里没有的新内容。注入需 setTimeout 延迟到 turn/end 事件
		// 派发之外, 避免 session.append 重入被吞 (与 cost-guard 同法)。
		// v0.7.0 (§3): options.bannerSummary=false ⇒ 完全不注入 notice/banner (外部推送不受影响)
		if (!currentOptions().bannerSummary) {
			debug(`注入跳过: options.bannerSummary=false (turn=${turn} elapsed=${elapsed}ms)`);
			return;
		}
		if (!summary) {
			debug(`注入跳过: 无总结信息 (turn=${turn} elapsed=${elapsed}ms)`);
			return;
		}
		setTimeout(async () => {
			// v1 (§4.4)→RD-28: 经 banner-kit 注入; 失败/能力缺失 ⇒ 只记日志, 外部推送已完成 (不静默)
			const injected = await injectNotice(session, {
				kind: "notify",
				priority: 2, foldable: true, family: "notify",
				title,
				lines: [`【总结】${summary}`, `回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 会话 ${sidShort}`],
				turn,
				elapsedMs: elapsed,
				reason: reasonText,
				sessionShort: sidShort,
				at: Date.now()
			});
			if (injected.ok) debug(`注入会话成功 (notice/banner kind=notify 含总结 turn=${turn} mode=${injected.mode} rev=${injected.rev})`);
			else debug(`注入会话失败/停用: ${injected.reason} (turn=${turn})`);
		}, 100);
	});

	// ---- 幂等对账 (v0.4.0): 重启掐断的回合, 其 turn/end (reason=interrupted)
	// 由会话重载修复机制合成但观察者收不到 → 会话恢复 (session/created) 时补推
	// 一条"回合被中断"外部通知。中断回合不注入本地总结横幅 (避免与"任务完成"
	// 语义混淆, GUI 里用户本就能看到会话被中断)。去重: 状态文件记录已补推的
	// "会话id:回合号", 重启后同一会话只补推一次。----
	let reconcileWriteChain = Promise.resolve();
	async function readReconcileState() {
		try { return JSON.parse(await readFile(RECONCILE_FILE, "utf8")); } catch { return { pushed: {} }; }
	}
	async function markPushed(key) {
		try {
			reconcileWriteChain = reconcileWriteChain.then(async () => {
				const state = await readReconcileState();
				state.pushed[key] = new Date().toISOString();
				try { mkdirSync(PLUGIN_DATA, { recursive: true }); } catch { /* ignore */ }
				await writeFile(RECONCILE_FILE, JSON.stringify(state, null, 2), "utf8");
			});
			await reconcileWriteChain;
		} catch (e) {
			ctx.logger.warn(`dsh-notify: 对账标记写盘失败: ${String(e?.message ?? e)}`);
		}
	}
	// ---- RD-37: 对账路径改为经 loadReconcile() 动态取 —— 取不到即**停用该路径**（禁静态兜底双路径）----
	const rc = await loadReconcile();
	if (!rc || typeof rc.attachReconcile !== "function") {
		ctx.logger?.warn?.("dsh-notify: reconcile 不可用 → 「重启后补推中断回合通知」路径停用 (外部推送/横幅不受影响)");
		debug("reconcile: 模块不可用 → 对账路径停用 (不 attach)");
	} else rc.attachReconcile(ctx, {
		name: "notify",
		shouldReconcile: async (session) => {
			// v0.7.0 (§3): options.reconcile=false ⇒ 恒 false (不补推、不写去重标记)
			if (!currentOptions().reconcile) return false;
			if (!hubHasChannel) return false;
			const end = rc.lastTurnEnd(session);
			if (!end || end.reason !== "interrupted" || !Number.isInteger(end.turn)) return false;
			const state = await readReconcileState();
			return !state.pushed?.[`${session.id}:${end.turn}`];
		},
		reconcile: async (session) => {
			const end = rc.lastTurnEnd(session);
			if (!end) return;
			const key = `${session.id}:${end.turn}`;
			const elapsed = rc.turnElapsedMs(session, end);
			const thresholdMs = currentOptions().minTurnMs; // v0.7.0: options.minTurnMs
			debug(`reconcile: 中断回合 #${end.turn} elapsed=${elapsed}ms threshold=${thresholdMs}ms hubHasChannel=${hubHasChannel}`);
			if (elapsed === null || elapsed < thresholdMs) {
				// 短回合被打断不值得打扰; 标记避免每次启动重算
				await markPushed(key);
				return;
			}
			const sid = String(session.id ?? "");
			const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
			const rawQ = lastUserQuestion(session);
			const rawA = lastAssistantAnswer(session);
			const title = `❌ 回合被中断 · ${titleOrShort(session, sidShort)}`;
			const footer = `回合 #${end.turn} 被中断 (用时 ${fmtElapsed(elapsed)}) · 会话 ${sidShort}`;
			const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
			// 件B: composer 供「按设备分隔符」重排（未配置设备的 seps ＝ 默认 ⇒ 与 pages 逐字相同）
			// ★件D／T50（`#A476`）修复：两参透传（同 `:1961` 口径）
			const composeForDevice = (seps, segs) => composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer, seps, segs);
			// v0.7.0 (§2 映射): 中断补推走独立 type task.interrupted
			// v0.9.0: 传 vars 供自定义模板使用（未配置模板时零影响）
			const res = await sendByType("task.interrupted", title, pages, composeForDevice, {
				status: "回合被中断", emoji: "❌", session: titleOrShort(session, sidShort), sid: sidShort, turn: end.turn,
				elapsed: fmtElapsed(elapsed), elapsedMs: elapsed, reason: "interrupted",
				question: stripMarkdown(rawQ), answer: stripMarkdown(rawA), footer
			});
			await markPushed(key);
			debug(`reconcile: 中断回合 #${end.turn} 推送完成 ${res.sent}/${res.results.length}`);
		}
	});

	// 验证命令: 走通知中枢路由 (type=test), 目标设备由 notify-hub.json 决定
	ctx.commands.register({
		name: "notify-test",
		description: "发送测试通知 (走通知中枢路由: Bark 多设备 / Synology Chat)",
		handler: async () => {
			const h = await loadHub();
			const ids = resolveRouteIds(h, "test");
			if (!ids.length) {
				return {
					kind: "error",
					text: `没有可发送的设备 (共 ${h.devices.length} 台, 启用 ${allEnabledIds(h).length} 台) — 检查插件配置页的通知设置, 或插件数据目录下的 notify-hub.json`
				};
			}
			const body = `通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n目标设备: ${ids.join(", ")}`;
			const res = await sendByType("test", "DSH 测试通知", [body], undefined, { status: "测试推送", emoji: "🔔", body });
			return {
				kind: res.failed ? "error" : "success",
				text: `已发送: ${res.sent} 成功, ${res.failed} 失败${res.failed > 0 ? " (详见服务日志)" : ""}`
			};
		}
	});
}
