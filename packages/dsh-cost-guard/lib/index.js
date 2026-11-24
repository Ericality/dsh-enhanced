import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/cost-guard/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "cost-guard");
const COMPAT_DIR = process.env.DSH_COMPAT_DIR || joinPath(DSH_HOME, "plugin-data", "host-compat");
const LOG_DIR = joinPath(DSH_HOME, "logs", "cost-guard");
const ensureDataDir = () => { try { mkdirSync(PLUGIN_DATA, { recursive: true }); } catch { /* ignore */ } };

/**
 * @deepseek-ai/dsh-cost-guard (本地辅助插件, 非官方包)
 *
 * 回合结束 (turn/end) 时计算两个成本并注入费用提醒横幅 (notice/banner, kind=cost):
 *   - C_新建 ≈ 新开对话后跑 N 回合的总账 (N = estimateTurns, 默认 5):
 *       首回合 = (实测系统提示词+工具定义+agent-instructions + 任务文件 + 首条消息)×P_miss
 *                + 首回合输出×P_out
 *       后续回合 = 新会话稳态上下文×P_hit + 每回合新增输入×P_miss + 每回合输出×P_out
 *   - C_继续 ≈ 继续本对话 N 回合总账 =
 *       N×(当前上下文×P_hit + 每回合新增输入×P_miss + 每回合输出×P_out)
 *   横幅显示两者的数字对比 ("未来 N 回合: 新开对话约 ¥X · 继续本对话约 ¥Y")。
 *   横幅为结构化布局 (与 /cost 同款设计): 统计格高亮两个费用 + 结论决策芯片
 *   (切换=橙/继续=绿/差异不大=靛蓝) + 累计费用 + 键值行明细, 替代一大段文字。
 *
 * 触发规则 (2026-08-27 v5 双模式, 用户确认):
 *   每次回合结束同时评估两套规则 (并行, 互不干扰), 任一条件超限 → 该模式输出"建议切换":
 *     保守模式 (省钱优先): 当前回合费 > 0.40元 | 累计 > 3.00元 | 上下文 > 180k | 回合 > 15
 *     激进模式 (效率优先): 当前回合费 > 1.20元 | 累计 > 7.00元 | 上下文 > 400k | 回合 > 30
 *   状态合成 (保守阈值全部 ≤ 激进阈值 ⇒ 只可能三态): 双切 → A"建议切换" |
 *     双留 → B (不显示横幅) | 保守切+激进留 → C"丰俭由人"。
 *   展示节奏: A 每回合替换显示 (最紧急); C 状态变为 C 时首次显示一次, 持续 C 不重复,
 *     状态变化后重新触发; B 完全不显示。
 *   v5.1 (2026-08-27): turn/end 先注入"费用计算中…"灰气泡 (kind=status, 仿 think/bash 迷你行,
 *     非 surface 事件不进模型历史), 计算完成后原地替换:
 *     B → "费用计算完成 · 无需切换" | A → "费用计算完成 · 建议切换" | C → "费用计算完成 · 丰俭由人"
 *     (v5.3.3 改: 原 A/C 统一"已显示提醒"表述模糊, 用户要求直接给结论词) | 数据不足 → "费用计算完成";
 *     对账路径只修复遗留"卡在计算中"的气泡。
 *   v5.3 (2026-08-29): 状态气泡改为**每回合发 start** (payload 带 turn, client 按回合分组
 *     context id="costguard-status-<turn>", running→ok 原地更新)。修复根因: 旧逻辑只有会话
 *     第一条状态事件是 start, 后续永远 banner-replace; 客户端会话窗口只加载末尾 50 条消息,
 *     start 在窗口外时 update 被静默丢弃 → 重启/换窗口后气泡与横幅永不渲染 (2026-08-29 生产实测)。
 *   预测 (未来 predictTurns=5 回合): 基数 = 近 ≤5 回合平均每回合费用 (不足 5 回合取全部);
 *     继续本会话 = 基数×continueFactor(1.2)×N, 切换新会话 = 基数×switchFactor(0.6)×N,
 *     两模式共用同一基数 (费用数字相同, 仅结论不同 — 规则语义如此)。
 *   卡片布局 (v5, 与 dsh-notice-banner v0.7 配合):
 *     区域一 状态标题行 (标题按状态着色, 单行不换行) + 触发原因;
 *     区域二 双建议面板固定左右两列 (各含 结论芯片/继续5回合/切换5回合/差值/仅"切换"时显示 /handoff 按钮);
 *     区域三 左下裸数据 (当前回合/累计/上下文/回合数) + 右下 /costguard-stats 按钮;
 *     底部辅助说明 (仅状态 C): "深度开发/调试可参考激进建议；简单查询/批量任务请参考保守建议。"
 *
 * 估算口径 v2 (修复"一开新对话就被提示切换"的偏置):
 *   首回合输出不再用固定 firstTurnOutputTokens, 而是与"每回合输出"同源,
 *   都取实测统计中位数 (ov 手动覆盖仍优先) — 同一把尺子, 结论才可信。
 *
 * 估算口径 v4.1 (2026-08-25 修复"每回合成本低估 10~20 倍", 校验见任务记录):
 *   ① 缓存读取按"步骤"计费: DeepSeek 每步 API 调用都重读全量上下文计缓存命中费,
 *      一个回合 = 多步工具调用 = 多次缓存读取。历史统计的 cacheRead 改为
 *      "回合内所有步骤求和" (与 projcache totals 口径一致), 估算用
 *      每回合缓存读取的统计均值, 不再用"当前上下文只读一次"。
 *   ② 被中断回合也入统计: turn/end {kind:interrupted} 由会话重载时种子注入、
 *      不触发 session/event 观察者, 旧逻辑只记到 completed 小回合 (选择偏差)。
 *      改为每次检查从会话事件全量聚合所有回合 usage (含被中断回合), 重建统计。
 *   ③ 输出估算含推理 tokens (reasoning 按输出价计费); 累计费用同样补上推理。
 *   统计字段: {t, at, input, output, reasoning, cacheRead(步骤求和), steps}。
 *
 * 实测原则 (用户强调, 勿用固定常量):
 *   系统提示词/工具定义/agent-instructions 大小从会话事件实测 (request/header 的
 *   system + tools JSON, 与首个 <system-reminder> 注入文本), CJK 1字≈1 token、
 *   其他 3字符≈1 token 粗估。
 *
 * 历史统计 (用户要求, 2026-08-24; v4.1 改均值):
 *   插件安装后每个会话的每回合 usage 记入 $DSH_HOME/cost-guard-stats.json
 *   (从今天之后开始); 每回合新增输入/输出/缓存读取/步骤数优先取本会话最近 10
 *   回合的均值 (v4.1: 成本可加, 均值=期望成本; 中位数系统性低估重尾成本),
 *   数据不足时取全部会话统计均值, 再回退配置/实测兜底。
 *   命令: /costguard-stats 查看 (2026-09-06 起 set/clear 移除, 设计方案 §11);
 *         配置(阈值/覆盖)唯一入口 = 设置 > 本地插件 > 费用提醒 卡 (/costguard-cfg RPC
 *         写 $DSH_HOME/cost-guard-settings.json, 读取链 默认←patch←覆盖, 即时生效);
 *         /costguard-test 验证计算 (不再推送任何外部通知)。
 *
 * 横幅替换机制 (阶段 2 起由 @ericality/dsh-banner-kit 统一实现): 同一会话第一条费用横幅为
 * `notice/banner` (client 侧固定 context id="cost" start), 后续为 `notice/banner-replace`
 * (client 侧同 context update 原地替换) → 会话中始终只有一条费用提醒。rev/mode 语义的唯一实现
 * 收归 banner-kit (`emit(session, payload, {replace:true})`, 本插件是全仓唯一 replace 调用点)。
 *
 * 费用提醒只显示在对话横幅, **不推送 Synology Chat**;
 * ⚠️ 阶段 2 起"建议切换"(状态 A) **会**经 notifyHub 推一条 `cost.alert` (G1, 见 emitCostAlert)。
 *
 * ============ 阶段 2 变更集 (2026-09-13; 待阶段 3 统一 bump 版本号, 本阶段保持 0.3.0) ============
 *   ① host-compat 接入 (RD-27): dependencies + dshCompat{host,seams,blocked} + probe()/report() 分片;
 *      宿主访问改经 §4 seam (rpcHandle), 缺能力 ⇒ **路径级停用** + 告警, 无 legacy 直连兜底 (§10.2);
 *      `blocked: ["eventTypeRegistry"]` (缺它 ⇒ 未注册事件类型落盘 ⇒ 含该事件的会话打不开)。
 *   ② 取价收敛 (RD-42/RD-43): 删本地 parseOfficialPrices/currentTier/resolvePrices/costOf/
 *      readProjcacheShard+Legacy ⇒ 改调 @ericality/dsh-cost-pricing (`loadPrices`/`tierOf`/`costOf`/
 *      `readProjcacheOne`); **停止写 cost-guard-state.json 的 prices/pricesFetchedAt**
 *      (价格缓存归共享库 cost-pricing-cache.json); 缺库 ⇒ 内联纯数据常量 + warn + report()。
 *   ③ 横幅改走 banner-kit (RD-26/RD-28): 费用横幅 `emit(..., {replace:true})` (全仓唯一),
 *      stats/test 横幅走默认分支 (恒 start/rev=0); **状态气泡仍为本插件自有节奏逻辑 (本阶段未迁移)**。
 *   ④ G1 `cost.alert` 生产者 (RD-34/RD-31/RD-36): 状态**跃迁进入 A** 时经 notifyHub
 *      (优先 sendNotification, 回退 send) 推一条, 去重靠 stats 里持久化的 lastStatus, 子会话不发。
 *   ⑤ F6 口径统一 (RD-39): 5 处 `session?.events` 旧口径 → 唯一入口 `eventsOf()` (§4.1 seam),
 *      删死代码 `sessionTitle()`。
 *   ⑥ reconcile 动态化 (RD-37): 静态 import 删除 ⇒ `loadReconcile()`, 缺则对账路径停用 + 上报。
 */
export const name = "dsh-cost-guard";
export const inject = ["commands", "connection"];

// ================= 共享基座接入 (阶段 2; 契约 §2/§3/§4/§10; RD-27/RD-37/RD-42/RD-43) =================
// §10.1: **禁静态 import** host-compat / 任何共享包 (缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环) ⇒
// 一律 `await import()` + try/catch; §10.2: 缺能力即**停用该路径** + report(), 不写 legacy 兜底双路径。
const PLUGIN_ID = name;
/** 本插件声明需要的能力 (§3 key; 必须与 package.json `dshCompat.seams` 集合相等 — RD-1) */
const REQUIRES = ["sessionEvents", "sessionAppend", "eventTypeRegistry", "projcache", "commands"]; // `#A57`: 通道面改走 channelFace（fetch），不再依赖 rpcHandle
/** §3/D1: 缺失会"写错数据"的 key ⇒ **路径级** BLOCKED (与 package.json `dshCompat.blocked` 同源;
 *  此处仅为"读自身 package.json 失败"时的回退清单)。取值理由见回报 §② D-C1-1。 */
const BLOCKED_FALLBACK = ["eventTypeRegistry"];
/** §3 key → §4 seam 函数名 (§4 v1 冻结面; 缺 key 即视为该面不可用) */
const SEAM_OF = {
	sessionEvents: "readSessionEvents",
	sessionAppend: "appendNotice",
	eventTypeRegistry: "ensureEventTypes",
	rpcHandle: "rpcHandle"
};

let pluginCtx = null; // apply 时捕获, 供模块级降级路径告警 (契约 §2.3: 禁止静默)
/** 统一告警出口: ctx.logger.warn (有 ctx 时) + 插件 debug 日志 */
function LOG(msg) {
	try { pluginCtx?.logger?.warn?.(`${PLUGIN_ID}: ${msg}`); } catch { /* ignore */ }
	debug(msg);
}

/** 自身元信息 (RD-20): 版本 + 路径级阻断清单。**禁静态 import JSON** (避免与 package.json 双写漂移);
 *  运行时读自身 package.json; 读失败 ⇒ {version:"unknown", blocked:null} (调用方回退内置清单并告警)。 */
function ownMeta() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return {
			version: pkg?.version ?? "unknown",
			blocked: Array.isArray(pkg?.dshCompat?.blocked) ? pkg.dshCompat.blocked : null
		};
	} catch { return { version: "unknown", blocked: null }; }
}

/** §4.10 report(): host-compat 不可用时插件自己写状态分片 (§5 单写者: 只写自己的分片; 0600)。
 *  落点 = `${DSH_COMPAT_DIR:-<本插件数据根>}/compat-status.d/<id>.json`。
 *  ⚠️ 默认取本插件数据根 (= stats/settings 所在目录; 生产即 $DSH_HOME, 与契约 §5 等价), 而不是硬编码
 *  $DSH_HOME —— 离线测试/副本把数据根重写到 /tmp 后, 分片随之落 /tmp ⇒ 测试绝不写穿生产
 *  (阶段 1 真实事故 RD-23/L-3: 副本写 $DSH_HOME)。 */
function writeShard(ctx, entry) {
	try {
		const dir = `${COMPAT_DIR}/compat-status.d`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/${entry.id}.json`, JSON.stringify({ schema: 1, ...entry, probedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
	} catch (err) {
		LOG(`适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

/** 运行期降级项 (共享库缺失: banner-kit / cost-pricing / reconcile)。**不并入 missing/blocked**
 *  (§5 的 missing 只放 §3 key), 而是并入 note 文案并置 DEGRADED ⇒ 面板可见 (契约 §2.3 禁止静默)。 */
const runtimeDegraded = new Set();
/** §2.3 降级上报出口: apply 前只记录, apply 后重写分片 (由 apply 内重新赋值) */
let reportDegraded = (reason) => { runtimeDegraded.add(String(reason)); };

// ---- 动态加载共享包 (契约 §10.1; 结果缓存, 失败不重试) ----
let compatMod;          // @ericality/dsh-host-compat (probe/report)
let seamsMod;           // @ericality/dsh-host-compat/seams (纯函数面)
let compatLoaded = false;
let seamsRef = null;    // 供同步纯函数读事件的 §4 seam 面
const msgOf = (err) => String(err?.message ?? err);

async function loadCompat() {
	if (compatLoaded) return { compat: compatMod, seams: seamsMod };
	compatLoaded = true;
	try { seamsMod = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { seamsMod = null; LOG(`host-compat/seams 不可用 → 宿主访问面停用 (${msgOf(err)})`); }
	try { compatMod = await import("@ericality/dsh-host-compat"); } catch { compatMod = null; }
	return { compat: compatMod, seams: seamsMod };
}

let bannerKit;              // undefined = 尚未尝试
let bannerKitDead = false;  // true = 已判定不可用 (不重试)
async function loadBannerKit() {
	if (bannerKit !== undefined) return bannerKit;
	if (bannerKitDead) return null;
	try { bannerKit = await import("@ericality/dsh-banner-kit"); }
	catch (err) {
		bannerKitDead = true; bannerKit = null;
		LOG(`banner-kit 不可用 → 横幅注入停用 (不回落直连 session.append): ${msgOf(err)}`);
		reportDegraded("banner-kit");
	}
		// ★段2 `B6`（2026-09-29，"不得静默" · WRAP-B6）：emit **拒收**（形状非法）⇒ **必须面板可见 ＋ 点名** ——
		//   经中间件 `wrapBannerKit` 包一层（emit 非 ok 且属拒收 ⇒ 落 store ① `rejected` ⇒ 面板 `rejectedByReason`）。
		//   中间件不可用/旧版（无该面）⇒ **原样使用模块**（不伪造、不回落直连宿主）。
		try {
			const _smB6 = await import("@ericality/dsh-host-compat/seams");
			if (typeof _smB6.wrapBannerKit === "function") bannerKit = _smB6.wrapBannerKit(bannerKit, "dsh-cost-guard");
		} catch { /* 中间件不可用 ⇒ 保持原模块（随后 emit 自身会如实返回原因） */ }
	return bannerKit;
}

let pricingMod;             // undefined = 尚未尝试
let pricingDead = false;    // true = 已判定不可用 (不重试)
let pricingRef = null;      // 已加载的共享取价库 (供同步 costOfSync 优先复用)
async function loadPricing() {
	if (pricingMod !== undefined) return pricingMod;
	if (pricingDead) return null;
	try { pricingMod = await import("@ericality/dsh-cost-pricing"); pricingRef = pricingMod; }
	catch (err) {
		pricingDead = true; pricingMod = null;
		LOG(`cost-pricing 不可用 → 取价用内联纯数据常量(**时段无 tierOf 可算 ⇒ 按高峰价保守估算**, 宁可高估报警), 投影缓存读取停用 (契约 §2.6 唯一豁免): ${msgOf(err)}`);
		reportDegraded("cost-pricing");
	}
	return pricingMod;
}

// ---- RD-37: 动态加载 reconcile（契约 §10.1 禁静态 import 共享包）----
let reconcileMod;             // undefined = 尚未尝试
let reconcileDead = false;    // true = 已判定不可用（不重试）
export async function loadReconcile() {
	if (reconcileMod !== undefined) return reconcileMod;
	if (reconcileDead) return null;
	try {
		reconcileMod = await import("@ericality/dsh-reconcile");
	} catch (err) {
		reconcileDead = true; reconcileMod = null;
		LOG(`reconcile 不可用 → 对账路径停用: ${msgOf(err)}`);
		reportDegraded("reconcile");
	}
	return reconcileMod;
}

/**
 * §4.1 事件源**唯一入口** (阶段 0 F6 收口 / RD-37): 运行期一律经 host-compat §4.1
 * `readSessionEvents` (0.1.2 起宿主 Session 无 `events` 属性, 旧写法 `session?.events ?? []`
 * 恒空 ⇒ 静默失效, 阶段 0 血案)。⇒ 全插件只剩这一个事件读取点。
 * seam 不可用 (host-compat 未部署, 或未跑 apply 的纯函数单测) 时返回 null; 调用方沿用 `?? []`,
 * 此时才落旧属性读法 (<0.1.2 旧宿主 / 单测桩; RD-9 登记项, 与 §4.1 实现路径 1 同源, 不新增语义)。
 * ⚠️ 可见性 (协调人 2026-09-13 中途裁决 ①): **第一次**落到兼容读法时 warn 一次/进程 ——
 * 静默会让"seam 根本没起来"查不出来 (阶段 0/1 的真实事故都是静默型);
 * 且**不能**靠 report() 充当可见性: host-compat 完全缺失时 0.1.2 宿主仍有 `snapshotEvents`
 * ⇒ 本地探测可能仍判 sessionEvents=OK, state 报 OK 并不揭示"走了兼容读法"。
 */
let compatReadWarned = false;
function eventsOf(session) {
	const fn = seamsRef?.readSessionEvents;
	if (typeof fn === "function") {
		try { const ev = fn(session); if (ev !== null) return ev; } catch { /* 落兼容读法 */ }
	}
	if (!compatReadWarned) {
		compatReadWarned = true;
		LOG("host-compat §4.1 seam 不可用 → 走只读兼容读法(events/snapshotEvents/ownEvents); 生产 0.1.2 应恒走 seam, 若反复出现说明 host-compat 未加载/未部署");
	}
	// seam 不可用时的**只读兼容读法** (三条路径与 §4.1 实现逐字同源): 旧宿主 `session.events`
	// → `snapshotEvents()` → `ownEvents()`。⚠️ 仅在 host-compat 缺失/未 apply 时可达 (生产 0.1.2 恒走 seam);
	// 这不是 §10.2 所禁的"legacy 直连兜底双路径"(那条针对**写**宿主)。⚠️ 与 D12 严格读法的偏差
	// 已登记为**限期偏差**: 计划在阶段 5 随剩余插件接入时删除 (依据 = 既有套件断言 + 生产不可达, 见回报 §② D-C1-5)。
	// 保留原因: scripts/test-cost-guard-v5.mjs G2/G2b 等既有断言用"只有 snapshotEvents() 的桩 session"
	// 直接调本文件的纯函数/对账判据 (先于 apply 或 host-compat 不可用), 删掉会让既有套件变红 (回报 §② D-C1-5)。
	try { if (Array.isArray(session?.events)) return session.events; } catch { /* 试下一个 */ }
	try { if (typeof session?.snapshotEvents === "function") { const ev = session.snapshotEvents(); if (Array.isArray(ev)) return ev; } } catch { /* 试下一个 */ }
	try { if (typeof session?.ownEvents === "function") { const ev = session.ownEvents(); if (Array.isArray(ev)) return ev; } } catch { /* 都拿不到 */ }
	return null;
}

export const Config = z.object({
	// ---- v5 双模式阈值 (保守=省钱优先 / 激进=效率优先), 任一条件超限 → 该模式建议切换 ----
	consTurnYuan: z.number().default(0.40),      // 保守: 当前回合费用 > 该值 (元)
	consCumYuan: z.number().default(3.00),       // 保守: 会话累计费用 > 该值 (元)
	consCtxTokens: z.number().default(180000),   // 保守: 当前上下文 > 该值 (tokens)
	consTurns: z.number().default(15),           // 保守: 当前会话回合数 > 该值
	aggTurnYuan: z.number().default(1.20),       // 激进: 当前回合费用 > 该值 (元)
	aggCumYuan: z.number().default(7.00),        // 激进: 累计费用 > 该值 (元)
	aggCtxTokens: z.number().default(400000),    // 激进: 上下文 > 该值 (tokens)
	aggTurns: z.number().default(30),            // 激进: 回合数 > 该值
	// ---- v5 预测 (未来 predictTurns 回合): 继续 = 近5回合平均×continueFactor, 切换 = ×switchFactor ----
	continueFactor: z.number().default(1.2),     // 继续本会话预测乘数 (上下文持续增长, 输出膨胀)
	switchFactor: z.number().default(0.6),       // 切换新会话预测乘数 (无历史噪音, 更精简)
	predictTurns: z.number().default(5),         // 预测未来回合数
	// ---- v4 及以前字段 (已废弃, 保留兼容旧 patch 配置, 不再作为触发依据) ----
	thresholdYuan: z.number().default(1),
	taskFileTokens: z.number().default(10000),
	outputTokensPerTurn: z.number().default(15000),
	firstTurnOutputTokens: z.number().default(3000),
	estimateTurns: z.number().default(5),
	diffThresholdYuan: z.number().default(0.05),
	/** 卡内覆盖（白名单键，宿主校验并落盘；volatile ⇒ 保存即生效）。 */
	overrides: z.dict(z.union([z.number(), z.string()])).default({}).volatile()
});

// ---- projcache 路径 (阶段 2: 读取已收敛到共享库 readProjcacheOne; 此处仅保留路径供 §3 能力探测) ----
// 0.1.2 起投影缓存按会话分片落盘: <root>/session_projcache/sessions/<sid>.json
// (镜像 dsh-session-projection-cache 自述: json 后端 "per-record ... one document per session
//  ... instead of the whole unit")。单体 session_projcache.json 自 09-09 05:31 起不再更新,
// 仅作历史会话回退 —— 旧代码只读单体表 → 新会话 "无数据"、老会话数值陈旧 (生产实测)。
// 环境变量与共享库 @ericality/dsh-cost-pricing 的读取口径对齐 (默认值与生产逐字相同)。
const PROJCACHE_FILE = process.env.DSH_PROJCACHE_FILE || joinPath(DSH_HOME, "storages", "session_projcache.json");
const PROJCACHE_SHARD_DIR = process.env.DSH_PROJCACHE_DIR || joinPath(DSH_HOME, "storages", "session_projcache", "sessions");
/** §3 `projcache` 探测 = 路径/形状探测 (只 existsSync, 不读内容/无副作用; 落点同 §2 契约) */
function projcacheReadable() {
	try { return existsSync(PROJCACHE_FILE) || existsSync(PROJCACHE_SHARD_DIR); } catch { return false; }
}
const lastHeaderCache = new Map(); // sid -> request/header (观察者缓存, 供 measurePrompt 回退)

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

// 2026-09-10 (0.1.2 适配): agent.session.events 已移除 → 观察者侧维护 measurePrompt 需要的事件视图
// (上下文 tokens / usage 步数与回合数 / system-reminder 与首条用户消息), 否则"上下文"维度恒为 0
// → "上下文 > 180k/400k" 这条切换触发条件静默失效。
const sessionMeasureCache = new Map(); // sid -> { lastUsage, lastCtx, usageEvents, usageTurns[], usageByTurn(Map), instructions, firstUser }
const MEASURE_CACHE_MAX = 300;
function cacheMeasureEvent(sid, event) {
	try {
		if (!sid || !event?.type) return;
		let e = sessionMeasureCache.get(sid);
		if (!e) {
			// 2026-09-11 (0.1.2 适配补漏): usageByTurn 按回合聚合 usage (键 = turn, 口径同 collectAllTurnUsage)
			e = { lastUsage: null, lastCtx: null, usageEvents: 0, usageTurns: [], usageByTurn: new Map(), instructions: "", firstUser: "" };
			sessionMeasureCache.set(sid, e);
			if (sessionMeasureCache.size > MEASURE_CACHE_MAX) sessionMeasureCache.delete(sessionMeasureCache.keys().next().value);
		}
		const u = settlementUsage(event); // A4: message 直带 usage / attempt 取 stream 末帧
		if (u) {
			e.lastUsage = u;
			if (u.cacheReadTokens != null) e.lastCtx = u.cacheReadTokens;
			if (Number.isInteger(event.data.turn)) {
				e.usageEvents += 1;
				if (!e.usageTurns.includes(event.data.turn)) e.usageTurns.push(event.data.turn);
				// 2026-09-11 (0.1.2 适配补漏): 增量按回合累积 usage (O(1)), 供 collectAllTurnUsage
				// / sumReasoningTokens 在 session.events 取不到 assistant/message 时回退
				// (口径与 collectAllTurnUsage 一致: 回合内所有步骤求和, steps 计 usage 事件数)
				let r = e.usageByTurn.get(event.data.turn);
				if (!r) {
					r = { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 };
					e.usageByTurn.set(event.data.turn, r);
				}
				r.input += u.inputTokens ?? 0;
				r.output += u.outputTokens ?? 0;
				r.reasoning += u.reasoningTokens ?? 0;
				r.cacheRead += u.cacheReadTokens ?? 0;
				r.steps++;
			}
		}
		if (event.type === "user/message" && Array.isArray(event.data?.content)) {
			const text = event.data.content.map((c) => c.text ?? "").join("");
			if (text.includes("<system-reminder>")) { if (!e.instructions) e.instructions = text; }
			else if (!e.firstUser && !text.startsWith("[系统通知]")) e.firstUser = text;
		}
	} catch { /* 缓存失败不影响主流程 */ }
}
// 阶段 2 (RD-42): 本地 readProjcacheShard/readProjcacheLegacy 已删除 ⇒ 收敛到共享库
// `@ericality/dsh-cost-pricing.readProjcacheOne` (分片优先 + 单体回退, 逐字同源), 见 sessionUsage()。
const STATS_FILE = joinPath(PLUGIN_DATA, "cost-guard-stats.json");
// 配置状态文件 (设计方案 §11, 2026-09-06): 设置 > 本地插件 > 费用提醒 卡经 /costguard-cfg RPC
// 写入; 与 cost-guard-stats.json(回合统计) 互不干扰。
// ⚠️ RD-42: 旧 `cost-guard-state.json` (价格缓存 prices/pricesFetchedAt + 展示节奏注释) 已**停止使用** ——
// 价格缓存归属迁到共享库的 `${DSH_PRICING_CACHE_DIR:-$DSH_HOME}/cost-pricing-cache.json`;
// 展示节奏 (lastStatus) 一直存在 stats 文件里 ⇒ 本插件不再读写 cost-guard-state.json 任何字段。
// 路径可用环境变量覆盖 (仅测试用, 生产/VM 默认落 $DSH_HOME)。
const SETTINGS_FILE = process.env.COST_GUARD_SETTINGS_FILE || joinPath(PLUGIN_DATA, "cost-guard-settings.json");
const DEBUG_ENABLED = process.env.DSH_COST_GUARD_DEBUG === "1";
const DEBUG_LOG = LOG_DIR + "/cost-guard-debug.log";
// v5.3.1 曾应急屏蔽状态气泡 (STATUS_BUBBLE_DISABLED=true, 2026-08-29) — 起因是 v0.10.0 客户端
// bug (cost banner-replace 映射 start 致 start() 抛错 → 历史加载失败), 与气泡本身无关。
// v0.10.1 已修复该客户端 bug (start() 接受 banner-replace), 用户强刷后历史恢复;
// 2026-08-29 恢复气泡: 每回合 running(notice/banner start, turn)→ok(banner-replace update),
// 新 bundle 按回合分组渲染, 无抛错。费用横幅 (kind=cost) 不受影响。
const STATUS_BUBBLE_DISABLED = false;
const STATS_MAX_TURNS = 30;
// 本会话统计不足该回合数时, 不下"切换更划算"结论 (首回合工具调用密集, 不可代表每回合典型值)
const MIN_ADVICE_TURNS = 3;

// 内置常量兜底 (RD-29: 现行官方价 Flash 列, ¥/百万tokens; 契约 §2.6 **唯一豁免** = 纯数据常量可内联)。
// ⚠️ 阶段 2 用途收窄 (RD-43): 仅在共享库 @ericality/dsh-cost-pricing 动态 import 失败时使用,
// 同时 warn + report() 上报 (旧值 3/0.1/9 与 1.5/0.05/4.5 是 Pro 列时代的兜底, 已按现行价更新)。
const FALLBACK_PRICES = {
	peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
	offpeak: { inputMiss: 1, inputHit: 0.02, output: 4 }
};

function debug(msg) {
	if (!DEBUG_ENABLED) return;
	try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

function beijingHm(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/**
 * 当前会话 tokenUsage.totals (projcache 落盘后), 无则 null。
 * 阶段 2 (RD-42): 本地分片/单体读取已删除 ⇒ 收敛到共享库 `readProjcacheOne`
 * (分片优先 + 单体回退, 逐字同源); 库不可用 ⇒ 读不到 ⇒ 返回 null (调用方按"projcache 无数据"跳过 + 已 report())。
 */
async function sessionUsage(sessionId) {
	const pick = (tu) => (tu && (tu.uncachedInputTokens !== undefined || tu.cacheReadTokens !== undefined || tu.outputTokens !== undefined)) ? tu : null;
	const mod = await loadPricing();
	if (typeof mod?.readProjcacheOne !== "function") {
		debug("sessionUsage: cost-pricing 不可用 → 投影缓存读取停用");
		return null;
	}
	try {
		const rec = await mod.readProjcacheOne(sessionId);
		return pick(rec?.rows?.tokenUsage?.val?.totals ?? rec?.rows?.tokenUsage?.totals);
	} catch (err) {
		LOG(`投影缓存读取异常 (按无数据处理): ${String(err?.message ?? err)}`);
		return null;
	}
}

/**
 * 取价 + 时段 (RD-42 / RD-43): 一律走共享库
 *   `loadPrices()`  = 缓存(30min) → 官方页解析 → 上次缓存 → 内置常量 (永不 null/throw, 内部单飞);
 *   `tierOf(ms)`    = 北京时区高峰/空闲 (逐字复刻原 currentTier)。
 * **本插件不再自己抓页 / 解析 / 写价格缓存** —— 价格缓存归属已迁到共享库的
 * `${DSH_PRICING_CACHE_DIR:-$DSH_HOME}/cost-pricing-cache.json`, 旧 cost-guard-state.json 的
 * `prices`/`pricesFetchedAt` 两键**停止写入** (RD-42; 全局抓页由最坏 5 次/30min 降为 1 次/30min)。
 * 库不可用 ⇒ 内联纯数据常量 + warn + report() (RD-43); 此时无 `tierOf` 可算 ⇒ 按 "peak" 取价
 * (宁可高估报警, 不静默低估; 决策登记 D-C1-3, 不复制库的时段逻辑)。
 */
async function currentPricesAndTier() {
	const mod = await loadPricing();
	if (mod?.loadPrices) {
		try {
			const r = await mod.loadPrices();
			let tier = "peak";
			if (typeof mod.tierOf === "function") tier = mod.tierOf(Date.now());
			else LOG("cost-pricing.tierOf 缺失 → 时段按高峰价保守估算 (宁可高估报警)");
			if (r?.prices) return { prices: r.prices, tier, source: String(r.source ?? "") };
			LOG("loadPrices 未返回 prices → 用内联常量");
		} catch (err) {
			LOG(`loadPrices 异常 → 用内联常量 (不影响主流程): ${String(err?.message ?? err)}`);
		}
	}
	return { prices: FALLBACK_PRICES, tier: "peak", source: "内联常量 (共享库不可用; 时段按高峰价保守估算)" };
}

/**
 * 计费 (元) — 全插件唯一算式入口 (**同步**): 优先共享库 `@ericality/dsh-cost-pricing.costOf`
 * (RD-30: reasoning 按输出价), 库未加载时用同源同步镜像 (4 行)。
 * ⚠️ 镜像存在的唯一原因: `subtreeCumYuan` / `turnCostOf` / `predictFiveTurns` 是对外导出的
 * **同步纯函数** (scripts/test-cost-guard-v5.mjs 直接调用), 不可 async; 镜像算式与库 costOf
 * 逐字同源, **库可用时永不执行** ⇒ 不是 §10.2 所禁的"legacy 宿主直连兜底"(那条针对宿主访问)。
 */
function costOfSync(totals, p, opts = {}) {
	if (typeof pricingRef?.costOf === "function") {
		try {
			const v = pricingRef.costOf(totals, p, opts);
			if (Number.isFinite(v)) return v;
		} catch { /* 落镜像 */ }
	}
	const t = totals ?? {};
	const price = p ?? {};
	const num = (x) => (Number.isFinite(x) ? x : 0);
	return ((num(t.uncachedInputTokens) + num(t.cacheWriteTokens ?? 0)) * num(price.inputMiss)
		+ num(t.cacheReadTokens ?? 0) * num(price.inputHit)
		+ num(t.outputTokens) * num(price.output)) / 1e6
		+ num(opts.reasoning ?? 0) * num(price.output) / 1e6;
}

// ---- dsh-cost-tree 动态加载 (复用策略 B: optionalDependency, 缺失/失败 → null 降级) ----
// ⚠️ 禁止顶层静态 import("@deepseek-ai/dsh-cost-tree") — 会重建"缺包崩溃"硬链 (设计 §0.2/§8.3)。
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
 * 子树 reasoning 补全 (设计 §3.2): guard 自己写的 stats 文件里子会话各回合 reasoning 之和 × 输出价。
 * 正交性: projcache 四类不含 reasoning → stats 只补 reasoning 维度, 绝不把 stats 的
 * input/output/cacheRead 拿去求和 (那会与 projcache 双计)。child 无 stats 键 → 记 0。
 * 纯函数 (stats 由调用方 readStats 已加载, 零额外 IO)。
 */
export function statsReasoningYuan(stats, childSid, p) {
	let sum = 0;
	for (const t of stats?.sessions?.[childSid]?.turns ?? []) sum += t?.reasoning ?? 0;
	return (sum * (p?.output ?? 0)) / 1e6;
}

/**
 * cumTree 纯函数 (设计 §3.2): 树化累计 = 树(自身+全部后代) projcache 四类×当期价
 * + 自身 reasoning×输出价 (原 cost 已含, 单加一次) + Σ 子树 reasoning (stats 补)。
 * 无 treeTotals → 返回 cost (现状降级)。禁止把 stats 的 input/output/cacheRead 求和 (双计)。
 */
export function subtreeCumYuan(treeTotals, ownReasoningYuan, childReasoningYuan, p) {
	if (!treeTotals || !p) return null;
	return costOfSync(treeTotals, p) + ownReasoningYuan + childReasoningYuan;
}

function hitPercent(totals) {
	const billed = totals.uncachedInputTokens + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0);
	if (billed <= 0) return null;
	return Math.round(((totals.cacheReadTokens ?? 0) / billed) * 100);
}

const fmtMoney = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fmtTokens = (n) => `${(Math.round(n / 1000)).toLocaleString("zh-CN")}k`;

/**
 * 单回合成本 (统计字段口径): 未命中输入 + 缓存读取命中 + (输出+推理)×输出价。
 * 阶段 2 起经 costOfSync ⇒ 与共享库 `costOf` 同源 (RD-30: reasoning 按输出价),
 * 统计字段 (input/cacheRead/output/reasoning) 映射到 totals 同名语义字段。
 */
function turnCostOf(u, p) {
	return costOfSync(
		{ uncachedInputTokens: u?.input ?? 0, cacheReadTokens: u?.cacheRead ?? 0, outputTokens: u?.output ?? 0 },
		p,
		{ reasoning: u?.reasoning ?? 0 }
	);
}

/**
 * v5: 单模式评估 — 4 条件任一超限 → 建议切换 (hits 记录被触发的条件明细)。
 * 保守阈值全部 ≤ 激进阈值 ⇒ "保守留+激进切" 不可能出现, 全局只可能 A/B/C 三态。
 */
function evaluateMode(turnCost, cumCost, ctxTokens, turnCount, th) {
	const hits = [];
	if (turnCost > th.turnYuan) hits.push({ kind: "turn", label: "单回合费用", value: turnCost, threshold: th.turnYuan });
	if (cumCost > th.cumYuan) hits.push({ kind: "cum", label: "累计费用", value: cumCost, threshold: th.cumYuan });
	if (ctxTokens > th.ctxTokens) hits.push({ kind: "ctx", label: "上下文", value: ctxTokens, threshold: th.ctxTokens });
	if (turnCount > th.turns) hits.push({ kind: "turns", label: "回合数", value: turnCount, threshold: th.turns });
	return { switch: hits.length > 0, hits };
}

/** 取两模式被触发条件中"超出阈值比例最高"的一项作为最主要触发原因 */
function mainReason(hits) {
	if (!hits.length) return null;
	let best = null;
	for (const h of hits) {
		const ratio = h.value / h.threshold;
		if (!best || ratio > best.ratio) best = { ...h, ratio };
	}
	return best;
}

/** 触发原因单行文案, 如 "单回合 ¥0.50 超限 (阈值 ¥0.40)" / "上下文 200k 超限 (阈值 180k)" */
function fmtReason(r) {
	let base;
	if (r.kind === "turn") base = `单回合 ¥${fmtMoney(r.value)} 超限 (阈值 ¥${fmtMoney(r.threshold)})`;
	else if (r.kind === "cum") base = `累计 ¥${fmtMoney(r.value)} 超限 (阈值 ¥${fmtMoney(r.threshold)})`;
	else if (r.kind === "ctx") base = `上下文 ${fmtTokens(r.value)} 超限 (阈值 ${fmtTokens(r.threshold)})`;
	else base = `回合 ${r.value} 超限 (阈值 ${r.threshold})`;
	return r.ratio >= 2 ? `${base} (超 ${(Math.round(r.ratio * 10) / 10).toFixed(1)}×)` : base;
}

/**
 * v5: 展示节奏 — A 每回合显示; C 状态变为 C 时首次显示一次 (持续 C 不重复, 状态变化重新触发); B 不显示。
 */
function shouldShow(status, lastStatus) {
	if (status === "B") return false;
	if (status === "C") return lastStatus !== "C";
	return true; // A
}

/**
 * v5.1: 状态气泡收尾文案。v5.3.3 (用户要求): 直接给结论词, 弃用模糊的"已显示提醒" —
 * B → "无需切换" | A → "建议切换" | C → "丰俭由人"; 数据不足路径不走本函数 (直接"费用计算完成")。
 * 纯函数, 供 checkAndNotify 与独立测试使用。
 */
function statusFinishText(status) {
	if (status === "B") return "费用计算完成 · 无需切换";
	if (status === "A") return "费用计算完成 · 建议切换";
	if (status === "C") return "费用计算完成 · 丰俭由人";
	return "费用计算完成";
}

/**
 * v5: 未来 predictTurns 回合预测 — 基数 = 近 ≤5 回合平均每回合费用 (不足 5 回合取全部);
 * 继续 = 基数×continueFactor×N, 切换 = 基数×switchFactor×N (两模式共用同一基数)。
 * 无回合数据返回 null。
 */
function predictFiveTurns(turns, p, config) {
	const recent = (turns ?? []).slice(-5);
	if (!recent.length) return null;
	const perTurn = recent.map((u) => turnCostOf(u, p));
	const base = perTurn.reduce((a, b) => a + b, 0) / perTurn.length;
	const n = Math.max(1, Math.round(config.predictTurns ?? 5));
	const continue5 = base * (config.continueFactor ?? 1.2) * n;
	const switch5 = base * (config.switchFactor ?? 0.6) * n;
	return { base, continue5, switch5, diff: continue5 - switch5, turns: recent.length };
}

// 阶段 2 (F6/RD-39): 本地 `sessionTitle(session)` 已删除 —— 它读 `session?.events` (0.1.2 恒 undefined)
// 且**全仓无调用点** (死代码)。需要标题时走 §4.3 `sessionText` (阶段 3 面) 或宿主 sessionTitle 服务。

/** tokens 粗估: CJK 1 字 ≈ 1 token, 其他字符 3 字 ≈ 1 token */
function estimateTokens(text) {
	let cjk = 0, other = 0;
	for (const ch of String(text ?? "")) {
		if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch)) cjk++;
		else other++;
	}
	return Math.ceil(cjk + other / 3);
}

/**
 * 从会话事件实测系统提示词+工具定义+agent-instructions+首条消息大小:
 *   - 最近 request/header → header.system + header.tools (JSON) 换算 tokens
 *   - 首个 <system-reminder> user/message → AGENTS.md/ENV.md 注入文本 tokens
 *   - 首个普通 user/message → 首条消息 tokens (新会话首条消息的代理估算)
 *   - 最近 assistant/message usage → 当前上下文 (cacheReadTokens)
 * 无 request/header 时返回 null。
 * 阶段 2 (F6/RD-39): 事件源统一走 eventsOf() ⇒ host-compat §4.1 seam (0.1.2 真事件源),
 * 事件不可用时仍以观察者缓存为初值/回退 (口径与改前一致)。
 */
function measurePrompt(session) {
	const events = eventsOf(session) ?? [];
	// 0.1.2: 事件不可用时以观察者缓存为初值 (事件可用时下方循环会覆盖)
	const mc = sessionMeasureCache.get(String(session?.id ?? "")) ?? null;
	let header = null;
	let instructions = mc?.instructions ?? "";
	let firstUser = mc?.firstUser ?? "";
	let lastUsage = mc?.lastUsage ?? null;
	let lastCtx = mc?.lastCtx ?? null;
	let usageEvents = mc?.usageEvents ?? 0;
	const usageTurns = new Set(mc?.usageTurns ?? []);
	for (const ev of events) {
		if (ev.type === "request/header" && ev.data?.header) header = ev.data.header;
		{
			const u = settlementUsage(ev); // A4: message 直带 usage / attempt 取 stream 末帧
			if (u) {
				lastUsage = u;
				if (u.cacheReadTokens != null) lastCtx = u.cacheReadTokens;
				if (Number.isInteger(ev.data.turn)) {
					usageEvents++;
					usageTurns.add(ev.data.turn);
				}
			}
		}
		if (ev.type === "user/message" && Array.isArray(ev.data?.content)) {
			const text = ev.data.content.map((c) => c.text ?? "").join("");
			if (text.includes("<system-reminder>")) {
				if (!instructions) instructions = text;
			} else if (!firstUser && !text.startsWith("[系统通知]")) {
				firstUser = text;
			}
		}
	}
	// 2026-09-10: 0.1.2 的 session.events 视图取不到 request/header → 回退到观察者缓存
	if (!header) header = lastHeaderCache.get(String(session?.id ?? "")) ?? null;
	if (!header) return null;
	// v4.1: 实测平均步骤数 (usage 事件数 / 有 usage 的回合数) — 每步都重读上下文计缓存费
	const avgStepsPerTurn = usageTurns.size ? Math.round(usageEvents / usageTurns.size) : 1;
	return {
		systemTokens: estimateTokens(header.system ?? ""),
		toolsTokens: estimateTokens(JSON.stringify(header.tools ?? [])),
		instructionsTokens: estimateTokens(instructions),
		firstUserTokens: estimateTokens(firstUser),
		ctxTokens: lastCtx ?? (lastUsage?.cacheReadTokens ?? 0),
		avgStepsPerTurn,
		toolsCount: (header.tools ?? []).length
	};
}

/**
 * 从会话事件聚合**所有回合**的 usage (含被中断回合; 事件日志是权威来源):
 * 输入/输出/推理按回合内所有步骤求和; 缓存读取同样按所有步骤求和
 * (DeepSeek 每步 API 调用都重读上下文计缓存命中费, 与 projcache totals 口径一致)。
 * v4.1: 取代旧 collectTurnUsage (只取最后一步 cacheRead, 且观察者收不到被中断回合)。
 * v5.x 阶段 2 (F6/RD-39): 事件源统一走 eventsOf() ⇒ host-compat §4.1 seam (阶段 0 新口径);
 * 仍保留"事件里没有 assistant/message 时回退观察者缓存"这条既有回退 (口径不变)。
 */
function collectAllTurnUsage(session) {
	const events = eventsOf(session) ?? [];
	const byTurn = new Map();
	for (const ev of events) {
		const u = settlementUsage(ev); // A4: message 直带 usage / attempt 取 stream 末帧
		if (u && Number.isInteger(ev.data.turn)) {
			let r = byTurn.get(ev.data.turn);
			if (!r) {
				r = { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 };
				byTurn.set(ev.data.turn, r);
			}
			r.input += u.inputTokens ?? 0;
			r.output += u.outputTokens ?? 0;
			r.reasoning += u.reasoningTokens ?? 0;
			r.cacheRead += u.cacheReadTokens ?? 0;
			r.steps++;
		}
	}
	// 2026-09-11 (0.1.2 适配补漏): 0.1.2 起 session.events 视图不再包含 assistant/message
	// → 结果为空时回退观察者缓存的按回合聚合 Map (旧版本宿主事件可用, 保留原路径优先)。
	// 回退项为缓存快照的浅拷贝, 避免调用方 (rebuildSessionStats) 写穿缓存。
	if (!byTurn.size) {
		const mc = sessionMeasureCache.get(String(session?.id ?? ""));
		if (mc?.usageByTurn?.size) for (const [t, u] of mc.usageByTurn) byTurn.set(t, { ...u });
	}
	return byTurn;
}

/** 会话全部 usage 的推理 tokens 之和 (projcache totals 不含 reasoning, 需从事件补, 按输出价计费)。
 *  阶段 2 (F6/RD-39): 事件源统一走 eventsOf() ⇒ host-compat §4.1 seam (阶段 0 新口径)。 */
function sumReasoningTokens(session) {
	const events = eventsOf(session) ?? [];
	let sum = 0;
	let seen = false;
	for (const ev of events) {
		const u = settlementUsage(ev); // A4: 含 assistant/attempt (1.5)
		if (u) {
			sum += u.reasoningTokens ?? 0;
			seen = true;
		}
	}
	// 2026-09-11 (0.1.2 适配补漏): 事件视图无 assistant/message → 回退观察者缓存按回合合计。
	// 用 seen 判据而非 sum===0: 事件存在但 reasoning 恰为 0 时不回退, 避免两套口径混用。
	if (!seen) {
		const mc = sessionMeasureCache.get(String(session?.id ?? ""));
		if (mc?.usageByTurn?.size) for (const u of mc.usageByTurn.values()) sum += u.reasoning ?? 0;
	}
	return sum;
}

/**
 * 从会话事件全量重建本会话回合统计 (v4.1): 含被中断回合, 覆盖旧格式记录,
 * cacheRead 为回合内所有步骤求和。事件日志是权威来源; 有数据返回 true。
 */
function rebuildSessionStats(stats, sid, session) {
	const sRec = (stats.sessions[sid] ??= { turns: [] });
	const allUsage = collectAllTurnUsage(session);
	if (!allUsage.size) return false;
	sRec.turns = [...allUsage.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([t, u]) => ({
			t,
			at: new Date().toISOString(),
			input: u.input,
			output: u.output,
			reasoning: u.reasoning,
			cacheRead: u.cacheRead,
			steps: u.steps
		}))
		.slice(-STATS_MAX_TURNS);
	return true;
}

// ---- 历史统计 (插件安装后每个会话每回合 usage; 从今天之后开始) ----
let statsWriteChain = Promise.resolve();

async function readStats() {
	try {
		const stats = JSON.parse(await readFile(STATS_FILE, "utf8"));
		// §11.4: 旧 stats.overrides (per-session 覆盖) 退役 — 忽略不迁移 (用户从未用过, 生产应为空);
		// 读时剥离 → 下次 writeStats 自然写盘清除; 仅 debug 提示一次。
		if (stats?.overrides) {
			const n = Object.keys(stats.overrides).length;
			if (n) debug(`readStats: 检测到旧 stats.overrides 残留 (${n} 会话), 已忽略 — 覆盖源改为全局状态文件 ${SETTINGS_FILE}`);
			delete stats.overrides;
		}
		return stats;
	} catch {
		return { since: new Date().toISOString(), sessions: {} };
	}
}

function writeStats(state) {
	const serialized = JSON.stringify(state, null, 2);
	ensureDataDir();
	statsWriteChain = statsWriteChain.then(() => writeFile(STATS_FILE, serialized, "utf8")).catch(() => {});
	return statsWriteChain;
}

// ============ 配置层 (设计方案 §11, 2026-09-06): 读取链 默认←patch←状态文件 overrides ============
// 可配置项全部迁到 设置 > 本地插件 > 费用提醒 卡 (client bundle 经 /costguard-cfg RPC 读写本状态文件);
// overrides 只含白名单键 (§11.2 A-D: 保守/激进阈值×8 + 预测参数×3 + 全局覆盖×4),
// 原 /costguard-stats set 的 cacheReadPerTurn/stepsPerTurn 不入卡、随 set/clear 移除退役 (回落实测均值链)。
// 即时生效策略 (§11.3 决策): 状态文件 <1KB、仅用户改卡时写入 → 每回合/每次读取点直读
// (JSON.parse 亚 ms), 不引入 TTL 缓存 / 文件 watch。

/** 内置默认 (与 Config zod default 同值; RPC get.defaults / merge 兜底层)。 */
export const DEFAULT_CFG = {
	consTurnYuan: 0.4, consCumYuan: 3.0, consCtxTokens: 180000, consTurns: 15,
	aggTurnYuan: 1.2, aggCumYuan: 7.0, aggCtxTokens: 400000, aggTurns: 30,
	continueFactor: 1.2, switchFactor: 0.6, predictTurns: 5,
	thresholdYuan: 1, taskFileTokens: 10000, outputTokensPerTurn: 15000,
	firstTurnOutputTokens: 3000, estimateTurns: 5, diffThresholdYuan: 0.05
};

/** 设置服务（显式解析，避免 inject 守卫）。 */
const settingsOf = (ctx) => { try { return ctx.get?.("settings", false) || null; } catch { return null; } };

/** volatile 叶子在运行态是带 get() 的引用。 */
const cfgVal = (x, fallback) => { try { return x && typeof x.get === "function" ? x.get() : (x === undefined || x === null ? fallback : x); } catch { return fallback; } };

/** apply 期注入的配置引用（volatile 字段原地更新）。 */
let costGuardConfig = null;
let costGuardCtx = null;
const patchLayerOf = () => {
	const out = {};
	const src = costGuardConfig ?? {};
	for (const k of Object.keys(DEFAULT_CFG)) out[k] = cfgVal(src[k], DEFAULT_CFG[k]);
	return out;
};

/** 可覆盖键白名单 (A 保守×4 + B 激进×4 + C 预测×3 + D 全局覆盖×4 = 15)。 */
export const OVERRIDE_KEYS = [
	"consTurnYuan", "consCumYuan", "consCtxTokens", "consTurns",
	"aggTurnYuan", "aggCumYuan", "aggCtxTokens", "aggTurns",
	"continueFactor", "switchFactor", "predictTurns",
	"inputPerTurn", "outputPerTurn", "firstTurnOutput", "taskFileTokens"
];

/** 键值规格: tokens/turns 存整数, yuan/factor 保留小数; 全部要求有限正数。 */
const KEY_KIND = {
	consTurnYuan: "yuan", consCumYuan: "yuan", aggTurnYuan: "yuan", aggCumYuan: "yuan",
	consCtxTokens: "tokens", aggCtxTokens: "tokens",
	consTurns: "turns", aggTurns: "turns", predictTurns: "turns",
	continueFactor: "factor", switchFactor: "factor",
	inputPerTurn: "tokens", outputPerTurn: "tokens", firstTurnOutput: "tokens", taskFileTokens: "tokens"
};

/** 校验单个覆盖值 (纯函数, 供 RPC set / 清洗共用): { ok:true, value } | { ok:false, error } */
export function validateOverrideValue(key, value) {
	if (!OVERRIDE_KEYS.includes(key)) return { ok: false, error: `未知键 ${key}; 可选: ${OVERRIDE_KEYS.join("/")}` };
	if (typeof value === "string" && value.trim() === "") return { ok: false, error: "值不能为空" };
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return { ok: false, error: "值需为数字" };
	if (n <= 0) return { ok: false, error: "值需为正数" };
	const kind = KEY_KIND[key];
	if ((kind === "tokens" || kind === "turns") && n < 1) return { ok: false, error: "值需 ≥ 1" };
	if (kind === "factor" && n > 10) return { ok: false, error: "乘数需 ≤ 10" };
	return { ok: true, value: (kind === "tokens" || kind === "turns") ? Math.round(n) : n };
}

/** 白名单过滤 + 数值校验 (读文件/写盘前清洗, 防脏数据)。 */
function sanitizeOverrides(overrides) {
	const out = {};
	if (overrides && typeof overrides === "object") {
		for (const k of OVERRIDE_KEYS) {
			if (overrides[k] === undefined || overrides[k] === null) continue;
			const r = validateOverrideValue(k, overrides[k]);
			if (r.ok) out[k] = r.value;
		}
	}
	return out;
}

/** 合并 默认←patch←overrides (纯函数, export 供单测): defaults = 内置默认, patch = apply 入参 config
 *  (zod 校验后的 patch 配置), overrides = 状态文件覆盖 (空对象 → 结果等同 patch, 缺省键落内置默认)。
 *  只覆盖白名单键, 其余键 (含遗留只读键 estimateTurns 等) 透传 patch / 默认。 */
export function mergeCostGuardCfg(defaults, patchCfg, overrides) {
	const out = { ...(defaults ?? DEFAULT_CFG), ...(patchCfg ?? {}) };
	const ov = sanitizeOverrides(overrides ?? {});
	for (const k of OVERRIDE_KEYS) if (ov[k] !== undefined) out[k] = ov[k];
	return out;
}

// ---- 设置读写: 覆盖值存宿主官方 Config（volatile），旧 settings 文件只作迁移源 ----
let settingsWriteChain = Promise.resolve();
let settingsUpdatedAt = null;

/** 读覆盖值（白名单清洗后）；缺省空对象。 */
export async function readSettings() {
	return { overrides: sanitizeOverrides(cfgVal(costGuardConfig?.overrides, {})), updatedAt: settingsUpdatedAt };
}

/** 读 overrides (每回合/命令/读取点调用; volatile 字段现读即最新)。 */
export async function readOverrides() {
	return (await readSettings()).overrides;
}

/** 写覆盖值到官方 Config（宿主负责校验与落盘；失败只告警，不阻断回合）。 */
function writeSettingsFile(overrides, updatedAt) {
	const next = sanitizeOverrides(overrides);
	settingsUpdatedAt = updatedAt ?? new Date().toISOString();
	settingsWriteChain = settingsWriteChain
		.then(async () => {
			const settings = settingsOf(costGuardCtx);
			if (!settings || typeof settings.update !== "function") throw new Error("settings 服务不可用");
			await settings.update("cost-guard", { overrides: next });
		})
		.catch((err) => { try { costGuardCtx?.logger?.warn?.(`dsh-cost-guard: 覆盖值保存失败: ${String(err?.message ?? err)}`); } catch { /* ignore */ } });
	return settingsWriteChain;
}

/** 旧 settings 文件一次性迁移到官方 Config（只在用户层为空时执行）。 */
async function migrateLegacySettings(ctx) {
	try {
		if (!existsSync(SETTINGS_FILE)) return false;
		let user = null;
		try { user = settingsOf(ctx)?.describe?.()?.find((row) => row.ns === "cost-guard")?.user; } catch { user = null; }
		if (user && Object.keys(user).length) return false;
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		const overrides = sanitizeOverrides(parsed?.overrides);
		if (Object.keys(overrides).length) {
			try { await settingsOf(ctx)?.update("cost-guard", { overrides }); }
			catch (err) { try { ctx.logger?.warn?.(`dsh-cost-guard: 旧设置迁移失败（保留旧文件）: ${String(err?.message ?? err)}`); } catch { /* ignore */ } return false; }
		}
		try { renameSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak`); } catch { /* ignore */ }
		return true;
	} catch (err) {
		try { ctx.logger?.warn?.(`dsh-cost-guard: 旧设置迁移异常（已忽略）: ${String(err?.message ?? err)}`); } catch { /* ignore */ }
		return false;
	}
}

/** 预测参数: 全局覆盖(状态文件, 语义 = 原 /costguard-stats set, 覆盖优先) > 本会话最近回合均值
 *  > 全部会话统计均值 > 配置/实测兜底 (设计方案 §11.4: 原 per-session overrides 退役, 会话级 → 全局);
 *  v4.1: 均值 (期望值) 取代中位数 — 成本分布重尾 (少数大回合占大头), 中位数系统性低估;
 * 成本可加, 每回合期望成本 = E[cacheRead]×P_hit + E[input]×P_miss + E[输出+推理]×P_out */
function predictParams(sid, m, config, stats, overrides) {
	const ov = overrides ?? {};
	const turns = stats.sessions?.[sid]?.turns ?? [];
	const recent = turns.slice(-10);
	const all = Object.values(stats.sessions ?? {}).flatMap((s) => s.turns ?? []);
	const meanOf = (rows, key, dflt) => {
		const vals = rows.map((t) => (typeof key === "function" ? key(t) : t[key])).filter(Number.isFinite);
		return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : dflt;
	};
	const inputPerTurn = ov.inputPerTurn
		?? meanOf(recent, "input")
		?? meanOf(all, "input")
		?? m?.avgInputTokens ?? 3000;
	// v4.1: 输出含推理 (reasoning 按输出价计费)
	const outputPerTurn = ov.outputPerTurn
		?? meanOf(recent, (t) => (t.output ?? 0) + (t.reasoning ?? 0))
		?? meanOf(all, (t) => (t.output ?? 0) + (t.reasoning ?? 0))
		?? config.outputTokensPerTurn;
	// v4.1: 缓存读取按"回合内所有步骤求和"计费; 统计均值优先, 兜底 当前上下文 × 实测平均步数
	// §11: cacheReadPerTurn/stepsPerTurn 不再可覆盖 (set 移除, 不入卡) → 一律走统计均值链
	const cacheReadPerTurn = meanOf(recent, "cacheRead")
		?? meanOf(all, "cacheRead")
		?? (m?.ctxTokens ?? 0) * (m?.avgStepsPerTurn ?? 1);
	const stepsPerTurn = meanOf(recent, "steps")
		?? meanOf(all, "steps")
		?? m?.avgStepsPerTurn ?? 1;
	return {
		inputPerTurn,
		outputPerTurn,
		// v2: 首回合输出与每回合输出同源 (同一把尺子), 全局覆盖仍优先; 消除"新建永远更便宜"的偏置
		firstTurnOutput: ov.firstTurnOutput ?? outputPerTurn ?? config.firstTurnOutputTokens,
		taskFileTokens: ov.taskFileTokens ?? config.taskFileTokens,
		cacheReadPerTurn,
		stepsPerTurn
	};
}

/**
 * 成本对比 (v2: 未来 N 回合总账; v4.1: 缓存读取按"回合内所有步骤求和"计费);
 * 无实测/定价时返回 null。
 * condition 三态: "new"(新建明显更划算) | "continue"(继续明显更划算) | "similar"(差异不大)。
 */
function computeComparison(m, params, config, prices, tier) {
	const p = prices?.[tier];
	if (!m || !p) return null;
	const ctxTokens = m.ctxTokens ?? 0;               // 当前上下文 (展示用)
	const cacheReadPerTurn = params.cacheReadPerTurn; // 每回合缓存读取总和 (历史统计均值; 兜底 ctx×步数)
	const stepsPerTurn = params.stepsPerTurn;         // 每回合步骤数 (统计均值/实测)
	const newInputTokens = params.inputPerTurn;       // 每回合新增未命中输入 (历史统计)
	const outTokens = params.outputPerTurn;           // 每回合输出+推理 (历史统计/配置)
	const sysPlusTools = m.systemTokens + m.toolsTokens + m.instructionsTokens;
	const taskFileTokens = params.taskFileTokens;
	const firstMsg = m.firstUserTokens;
	const firstOut = params.firstTurnOutput;
	const turns = Math.max(1, Math.round(config.estimateTurns ?? 1));
	// 新会话稳态上下文 ≈ 系统提示+工具+指令+任务文件+首条消息 (首回合后基本稳定, 后续回合走命中价)
	const newCtxTokens = sysPlusTools + taskFileTokens + firstMsg;
	// 新会话每回合缓存读取: 新稳态上下文 × 每回合步骤数 (与"继续"口径同源)
	const newCacheReadPerTurn = newCtxTokens * stepsPerTurn;

	const continuePerTurn = (cacheReadPerTurn * p.inputHit + newInputTokens * p.inputMiss + outTokens * p.output) / 1e6;
	const cContinue = continuePerTurn * turns; // 继续本对话 N 回合总账
	// 新会话首回合: 初始上下文全部未命中 + (步骤数-1) 次命中读取 + 首回合输出
	const cNewFirst = (newCtxTokens * p.inputMiss + (stepsPerTurn - 1) * newCtxTokens * p.inputHit + firstOut * p.output) / 1e6;
	const cNewLater = (newCacheReadPerTurn * p.inputHit + newInputTokens * p.inputMiss + outTokens * p.output) / 1e6;
	const cNew = cNewFirst + Math.max(0, turns - 1) * cNewLater; // 新建后跑 N 回合总账
	const diff = cContinue - cNew;
	const diffThreshold = config.diffThresholdYuan ?? 0.05;
	const condition = Math.abs(diff) < diffThreshold ? "similar" : diff > 0 ? "new" : "continue";
	return {
		cContinue, cNew, continuePerTurn, turns, diff,
		ctxTokens, cacheReadPerTurn, stepsPerTurn, newInputTokens, outTokens,
		sysPlusTools, taskFileTokens, firstMsg, firstOut,
		condition
	};
}

/**
 * v5.1: 注入/替换"费用计算"状态气泡 (kind=status, client 侧 context 按回合分组
 * id="costguard-status-<turn>"): **每回合首条状态事件发 notice/banner (start)**,
 * 同回合后续发 notice/banner-replace (原地替换) → 每回合一条灰线, running→ok 原地更新。
 * 非 surface 事件 → 不进模型历史、不消耗 token; 灰字迷你行仿 think/bash 样式 (见 dsh-notice-banner)。
 * ⚠️ v5.2: 必须在 turn/end 事件派发完成后再调用 (setImmediate), 否则 session.append 会因
 * dsh-session 的 appending 重入保护抛 "session append cannot reenter" 被此 catch 吞掉。
 * v5.3 (2026-08-29): 修复"重启后气泡/横幅永不渲染"根因 — 旧逻辑只有会话第一条状态事件是
 * start, 后续永远 replace; 客户端会话窗口只加载末尾 50 条消息, start 在窗口外时 update 被
 * 丢弃 → 气泡不可见。改为按回合发 start (payload 带 turn), 保证每回合的 start 都在窗口内。
 */
// 本进程内跟踪各会话的状态气泡 (0.1.2 起 session.events 看不到 notice/banner 这类非 surface 事件,
// 旧实现靠反扫 session.events 判 hasStart/找 running 气泡 → 气泡永远停在"计算中", 生产实测 09-09 05:31 起)
const statusBubbleState = new Map(); // sid -> { turn, state }

/** P1-2：状态气泡写入源 = **banner-kit.emit（去 session）** ⇒ 经 §4.4 seam 写自有 store。
 *  `mode` 语义与改前逐值等价（回合首条 start / 同回合后续 replace）；**不再直连 `session.append`**（R1）。 */
const STATUS_BUBBLE_SOURCE = "dsh-cost-guard";

function appendStatusBubble(session, text, state, turn) {
	try {
		const sid0 = String(session?.id ?? "");
		if (!sid0) return;
		const t = turn ?? statusBubbleState.get(sid0)?.turn ?? null;
		const hasStart = t != null && statusBubbleState.get(sid0)?.turn === t;
		const payload = { kind: "status", state, text, at: Date.now(), priority: 1, foldable: false, family: "status" };
		if (t != null) payload.turn = t;
		// A 阶段（obs#3）：ctxKey = 旧版 context id 原样（`costguard-status-<turn>`；无 turn ⇒ null，不猜）
		payload.ctxKey = t != null ? "costguard-status-" + t : null;
		if (!bannerKit) {
			debug(`status ${sid0.slice(0, 12)}: 注入跳过 (banner-kit 不可用)`);
			return;
		}
		// ★G1-b（2026-09-20）：status 路径补 **确定性 `cardId`**（同会话同回合恒定 ⇒ store 走 `cardId` 幂等分支，
		//   与 cost 卡同口径 `sha256("dsh-cost-guard|<kind>|<sid>|<turn>")[:32]`）。
		// ★段2 `B5`（2026-09-29；用户令「所有发射者都应该有」）：**由"条件带"改"恒带"** ——
		//   无 `turn` ⇒ 身份取"本会话的无回合相位"（哨兵 `no-turn`，**不会**与任何整数回合同值）。
		//   恒带后与旧路径**等价**：旧键 = `source|kind|turn`（无 turn ⇒ `-`）⇒ 同会话的无回合 status 卡本来也只 1 张。
		const _cardIdStatus = createHash("sha256").update(`dsh-cost-guard|status|${sid0}|${t != null ? t : "no-turn"}`).digest("hex").slice(0, 32);
		Promise.resolve(bannerKit.emit({ ...payload, cardId: _cardIdStatus, sessionId: sid0, anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bannerKit.ANCHOR_LEVEL.ROW : bannerKit.ANCHOR_LEVEL.SESSION, form: bannerKit.CARD_FORM.BUBBLE }, { replace: hasStart, source: STATUS_BUBBLE_SOURCE }))
			.then((r) => {
				if (!r?.ok) debug(`status ${sid0.slice(0, 12)}: 注入跳过: ${r?.reason ?? "unknown"}`);
				else debug(`status ${sid0.slice(0, 12)}: ${state} ${text}${t != null ? ` (回合 ${t})` : ""}`);
			})
			.catch((err) => debug(`status ${sid0.slice(0, 12)}: 注入异常: ${String(err?.message ?? err)}`));
		if (t != null) statusBubbleState.set(sid0, { turn: t, state });
	} catch (err) {
		debug(`status ${String(session?.id ?? "").slice(0, 12)}: 注入失败: ${String(err?.message ?? err)}`);
	}
}

/** 会话最后一条状态气泡 (含其回合号), 无则 null; state==="running" 时才允许收尾替换。
 *  ⚠️ 生产路径已不再调用本函数 (finishStatusBubble 改用内存 statusBubbleState), 属**死代码**;
 *  阶段 2 保留原因: 它是本插件对外导出面之一, 且 scripts/test-cost-guard-status-v53.mjs:30/83 直接
 *  import 断言 (**scripts/** 不在本线写权限内, 删掉会让既有套件整体报错**) ⇒ 只统一事件源, 删除留待
 *  阶段 5 与状态气泡一起迁到 banner-kit 时收口 (回报 §② D-C1-5 登记)。 */
function lastStatusBubble(session) {
	const events = eventsOf(session) ?? [];
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if ((e.type === "notice/banner" || e.type === "notice/banner-replace") && e.data?.kind === "status") {
			return { running: e.data?.state === "running", turn: e.data?.turn };
		}
	}
	return null;
}

/**
 * v5.1: 收尾状态气泡。实时路径 (turn/end) 必有 running 气泡 → 原地替换为结果文案;
 * 对账路径 (重启恢复) 只修复遗留"卡在计算中"的气泡, 不移动已收尾的气泡。
 * v5.3: ok 始终替换到 running 气泡所在回合的 context (同回合 start→replace)。
 */
function finishStatusBubble(session, text) {
	if (STATUS_BUBBLE_DISABLED) return; // v5.3.1 应急屏蔽: 见顶部注释
	// 2026-09-10: 改为按内存跟踪决定收尾 (不再反扫 session.events —— 0.1.2 取不到非 surface 事件)
	const cur = statusBubbleState.get(String(session?.id ?? ""));
	if (!cur || cur.state !== "running") return;
	appendStatusBubble(session, text, "ok", cur.turn);
}

export async function apply(ctx, config) {
	pluginCtx = ctx;
	costGuardCtx = ctx;
	costGuardConfig = config;
	try {
		ctx.inject(["settings"], (child) => { Promise.resolve().then(() => migrateLegacySettings(child)).catch(() => {}); });
	} catch { Promise.resolve().then(() => migrateLegacySettings(ctx)).catch(() => {}); }
	// ================= host-compat 适配闸门 (阶段 2; 契约 §2/§3/§4/§10; RD-27) =================
	// 加载强制: 动态 import + try/catch (§2.3)。§10.2: 缺能力即**停用该路径** + report(), 不写直连兜底。
	const { version: PLUGIN_VERSION, blocked: pkgBlocked } = ownMeta();
	// 路径级阻断清单 (RD-20): 运行时取自自身 package.json 的 dshCompat.blocked; 读失败 ⇒ 内置回退 + 告警
	const BLOCKING = (Array.isArray(pkgBlocked) ? pkgBlocked : BLOCKED_FALLBACK).filter((k) => REQUIRES.includes(k));
	if (!Array.isArray(pkgBlocked)) LOG(`dshCompat.blocked 读取失败 → 回退内置清单 [${BLOCKING.join(", ")}]`);
	const { compat, seams } = await loadCompat();
	seamsRef = seams; // 模块级: 供 eventsOf() 同步读事件 (§4.1)
	const seamFn = (key) => (typeof seams?.[SEAM_OF[key]] === "function" ? seams[SEAM_OF[key]] : null);
	/** ★ 批 4 件②（「丙」）：**就绪订阅接入状态**（如实降级用；`#A98` 补充约束②/③）。
	 *  · 取值：`absent`（未订阅）／`subscribed`（已订阅、待就绪）／`catch-up`（订阅时已就绪 ⇒ 已补注册）／
	 *    `unsupported`（旧版/桩 bus 无 `onReady` ⇒ 如实降级、**不抛崩**）／`failed`（订阅或补注册失败）；
	 *  · **必须在 `capNoteText()` 之前声明**（该函数会引用它们；在下方注册点之前引用会 TDZ 抛错）。 */
	let readySubState = "absent";
	let readySubReason = "";
	/** 惰性订阅 `compatBus.onReady`（**退避 0/200/500/1000/2000 ms**，照 `notice-banner` 既有惯例）；
	 *  `cb(reason, regResult)` 由订阅触发；`register` = 订阅方的幂等补注册函数。**永不 throw**。 */
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
			if (bus && typeof bus.registerEndpoint === "function") {
				// 旧版/桩 bus：只有两键 ⇒ **如实降级、不抛崩**（`#A98` 补充约束③）
				return { state: "unsupported", reason: "compatBus 无 onReady（旧版/桩 bus）⇒ 未接入就绪订阅（如实降级）" };
			}
			if (i >= delays.length) return { state: "failed", reason: `compatBus 不可用（重试 ${i} 次耗尽）⇒ 未接入就绪订阅` };
			const d = delays[i++];
			setTimeout(tick, d);
			return { state: "absent", reason: `compatBus 暂不可用，重试中（第 ${i} 次，退避 ${d}ms）` };
		};
		return tick();
	};

	// 能力探测: 优先 host-compat `probe()` (§4.9, keys 与 dshCompat.seams 同集); 未提供 ⇒ 本地按 §3 语义兜底。
	// 本地兜底: 有 seam 的 key 按"seam 函数是否存在", `projcache` 按路径形状, `commands` 按服务存在性 (RD-10 无 seam)。
	const localMissing = () => REQUIRES.filter((k) => {
		if (k === "projcache") return !projcacheReadable();
		if (k === "commands") { try { return (ctx?.commands ?? (typeof ctx.get === "function" ? ctx.get("commands") : undefined)) == null; } catch { return true; } }
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
		} catch (err) { LOG(`probe() 失败 → 退回本地探测: ${String(err?.message ?? err)}`); }
	}
	const capBlocked = capBlockedProbe ?? capMissing.filter((k) => BLOCKING.includes(k));
	let capState = capStateProbe ?? (capBlocked.length ? "BLOCKED" : (capMissing.length ? "DEGRADED" : "OK"));
	/** 能力缺失的后果文案 (§3 末: 由插件提供 ⇒ 面板"影响哪条功能") + 运行期共享库降级 (§2.3) */
	const capNoteText = () => {
		const miss = new Set([...capMissing, ...capBlocked]);
		const consequence = [];
		if (miss.has("eventTypeRegistry")) consequence.push("缺 eventTypeRegistry ⇒ 自定义事件类型无法注册, 横幅/气泡注入停用(写未注册类型 ⇒ 含该事件的会话打不开)");
		if (miss.has("sessionAppend")) consequence.push("缺 sessionAppend ⇒ 横幅/气泡写不进会话(回合统计与评估照常)");
		if (miss.has("sessionEvents")) consequence.push("缺 sessionEvents ⇒ 读不到会话事件, 费用横幅退化为每回合新卡(start/rev=0), 补账判据失效");
		if (miss.has("projcache")) consequence.push("缺 projcache ⇒ 读不到 tokenUsage, 回合费用评估停用");
		if (miss.has("rpcHandle")) consequence.push("缺 rpcHandle ⇒ /costguard-cfg 通道不注册(设置卡读取失败)");
		if (miss.has("commands")) consequence.push("缺 commands ⇒ /costguard-test 与 /costguard-stats 命令消失");
		const parts = [];
		if (consequence.length) parts.push(consequence.join(" · "));
		if (runtimeDegraded.size) parts.push(`运行期降级(共享库缺失) [${[...runtimeDegraded].join("/")}]: banner-kit 缺 ⇒ 横幅注入停用 · cost-pricing 缺 ⇒ 取价用内联常量(时段按高峰价保守估算) + 投影缓存读取停用(计入 missing.projcache, RD-47) · reconcile 缺 ⇒ 补账路径停用`);
		// ★ 批 4 件②：**就绪订阅接入状态如实进分片 note**（`#A98` 补充约束②：耗尽不得只 warn 了事）
		if (readySubState !== "absent") parts.push(`就绪订阅: ${readySubState}${readySubReason ? `(${readySubReason})` : ""}`);
		return parts.join(" ｜ ");
	};
	const capEntry = () => ({ id: PLUGIN_ID, version: PLUGIN_VERSION, state: capState, missing: capMissing, blocked: capBlocked, note: capNoteText() });
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	function republishCap() {
		if (capState === "OK" && runtimeDegraded.size) capState = "DEGRADED";
		const entry = capEntry();
		if (reporter) { try { reporter.report(entry); return; } catch { /* 落自写分片 */ } }
		writeShard(ctx, entry);
	}
	republishCap();
	reportDegraded = (reason) => {
		runtimeDegraded.add(String(reason));
		// RD-47: 缺 cost-pricing ⇒ 投影缓存读取停用 = §3 `projcache` **真实能力缺失** ⇒ 计入 missing
		// (§5 的 missing 只放 §3 key; 共享库名本身只进 note, 不进 missing/blocked)。
		if (reason === "cost-pricing" && !capMissing.includes("projcache")) capMissing = [...capMissing, "projcache"];
		try { republishCap(); } catch { /* 上报失败不影响主流程 */ }
	};
	if (capState !== "OK") LOG(`适配状态 ${capState} — 缺能力 [${capMissing.join(", ")}] 阻断 [${capBlocked.join(", ")}]; ${capNoteText()}`);

	const capOk = (key) => !capMissing.includes(key) && !capBlocked.includes(key); // 阻断 key 同样按"该路径停用"处理 (RD-20)
	const seamWarned = new Set();
	/** 能力缺失/调用失败的统一告警 (每组合只报一次; §2.3 禁止静默) */
	function seamFail(what, reason) {
		const k = `${what}|${reason}`;
		if (seamWarned.has(k)) return;
		seamWarned.add(k);
		LOG(`${what} 已停用 — ${reason} (契约 §10.2: 不降级为直连宿主)`);
	}

	// ---- 横幅闸门 (RD-26/RD-28): 事件类型幂等注册 + rev/mode 语义唯一实现都收归 banner-kit ----
	// ⚠️ 双路径只留一条: 原 `KNOWN_SESSION_EVENT_TYPES.add(...)` 直连已删除, 改走 §4.5 ensureEventTypes
	// (banner-kit.ensureRegistered 内部实现), 未注册成功 ⇒ **禁止注入** (未注册类型落盘 ⇒ 会话无法加载)。
	const bk = await loadBannerKit();
	let bannerTypesOk = false;
	if (!bk) seamFail("横幅注入", "banner-kit 不可用");
	else if (!capOk("eventTypeRegistry") || !seamFn("eventTypeRegistry")) seamFail("事件类型注册(notice/banner, notice/banner-replace)", "缺能力 eventTypeRegistry");
	else {
		const reg = await bk.ensureRegistered();
		bannerTypesOk = reg?.ok === true;
		if (!bannerTypesOk) seamFail("事件类型注册(notice/banner, notice/banner-replace)", `ensureEventTypes 失败: ${reg?.reason ?? "unknown"}`);
	}
	const thresholdYuan = config.thresholdYuan ?? 1; // 已废弃 (v5 起不再作为触发依据), 仅 /costguard-test 兼容展示
	// 读取链 (设计方案 §11): 内置默认(DEFAULT_CFG) ← patch config(入参) ← 状态文件 overrides;
	// 每回合/命令直读即时生效 (决策 §11.3: 无 TTL/无 watch)。patchLayer = 未覆盖时的生效值 (= 卡"默认层")。
	const patchLayer = mergeCostGuardCfg(DEFAULT_CFG, patchLayerOf(), {});
	// 遗留只读键 (卡只读展示区, 不再参与触发; 值 = patch 生效值, 缺省落内置默认)
	const legacyCfg = () => ({
		thresholdYuan: config.thresholdYuan ?? DEFAULT_CFG.thresholdYuan,
		estimateTurns: config.estimateTurns ?? DEFAULT_CFG.estimateTurns,
		diffThresholdYuan: config.diffThresholdYuan ?? DEFAULT_CFG.diffThresholdYuan,
		firstTurnOutputTokens: config.firstTurnOutputTokens ?? DEFAULT_CFG.firstTurnOutputTokens,
		outputTokensPerTurn: config.outputTokensPerTurn ?? DEFAULT_CFG.outputTokensPerTurn
	});
	debug(`apply: v5 双模式 保守(回合¥${patchLayer.consTurnYuan}/累计¥${patchLayer.consCumYuan}/上下文${fmtTokens(patchLayer.consCtxTokens)}/回合${patchLayer.consTurns}) 激进(回合¥${patchLayer.aggTurnYuan}/累计¥${patchLayer.aggCumYuan}/上下文${fmtTokens(patchLayer.aggCtxTokens)}/回合${patchLayer.aggTurns}) 预测 继续×${patchLayer.continueFactor} 切换×${patchLayer.switchFactor} N=${patchLayer.predictTurns} (旧 threshold=${thresholdYuan} 已废弃; 卡内覆盖经 ${SETTINGS_FILE} 即时生效)`);

	/**
	 * 注入/替换费用横幅 (同一会话只保留一条: 首条 notice/banner rev=0 作为 client 侧 start,
	 * 后续 notice/banner-replace 作为 update 原地替换; 兼容旧版遗留无 rev 横幅)。
	 * 阶段 2 (RD-26/RD-28): rev/mode 语义的**唯一实现已收归 @ericality/dsh-banner-kit** ——
	 * `emit(session, payload, { replace: true })` 是**全仓唯一 replace:true 调用点**; 本插件不得再自行
	 * 扫描事件推断 mode (RD-19/L-4: seam 扫历史推断 mode 曾被判为数据面行为改动)。
	 * 库内实现与改前 appendBanner 逐值等价 (同 kind 有 rev===0 起点 ⇒ replace, rev = 同 kind 事件总数)。
	 * 缺 banner-kit / 类型未注册 ⇒ 不注入 (契约 §10.2: 不回落 session.append 直连)。
	 */
	async function appendBanner(session, sid, payload) {
		if (!bk || !bannerTypesOk) { seamFail("费用横幅注入", "banner-kit 不可用或事件类型未注册"); return false; }
		// obs3S7 段W-2a **件G**（仲裁 `#A201` 一；A1 走 (I)：用户 2026-09-19 裁「甲」）：
		//   **补确定性 `cardId`** = 该卡的**稳定身份**（同会话同回合恒定）⇒ store 走 `cardId` 幂等分支
		//   ⇒ **同回合重发 / 跨重启重放都只留一条**（A1 目标）。派生式与计划 v5 §3.4 判据式**逐字一致**：
		//       cardId = sha256("dsh-cost-guard|cost|<sid>|<turn>")[:32]（32 位十六进制）
		//   ⚠️ `rev` / `replace` **原样保留**（既有语义零改动；中间件 `rev>0 ⇒ replace` **不动** —— 台账 `#53` 更正段 2）。
		//   ⚠️ 段2 `B5`（2026-09-29；用户令「所有发射者都应该有」）：**由"条件带"改"恒带"** ——
		//      整数 `turn` ⇒ 派生式**逐字不变**（`sha256("dsh-cost-guard|cost|<sid>|<turn>")[:32]`）；
		//      非整数 `turn` ⇒ 身份取**旧键的同一判别式**（`ctxKey` ＋ `rev`，即 `storeEntryKey` 的 `source|kind|ident|rev` 语义）
		//      ⇒ 带 `cardId` 与不带**合并/新增语义一致**（同 ctxKey 同 rev ⇒ 同卡；否则各 1 张），**不猜**身份。
		const _sid = sid || String(session?.id ?? "");
		const _turnKey = Number.isInteger(payload?.turn)
			? String(payload.turn)
			: `no-turn|${(typeof payload?.ctxKey === "string" && payload.ctxKey) ? payload.ctxKey : "-"}|${String(payload?.rev ?? 0)}`;
		const _cardId = createHash("sha256").update(`dsh-cost-guard|cost|${_sid}|${_turnKey}`).digest("hex").slice(0, 32);
		const r = await bk.emit({ ...payload, cardId: _cardId, sessionId: _sid, anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD }, { replace: false, source: STATUS_BUBBLE_SOURCE });   /* 段U15 A1：cost 卡改用 start+稳定 rev；段W-2a 件G：+cardId 幂等 */
		if (!r?.ok) {
			LOG(`check ${sid.slice(0, 12)}: 费用横幅注入跳过: ${r?.reason ?? "unknown"}`);
			return false;
		}
		debug(`check ${sid.slice(0, 12)}: 注入会话成功 (${r.mode === "replace" ? "notice/banner-replace" : "notice/banner"} rev=${r.rev} kind=cost)`);
		return true;
	}

	/**
	 * 注入 /costguard-stats 结果横幅: kind=balance 紫色家族 (与 /cost 同款,
	 * mode=stats 徽章"参数统计"), 独立 context 每次保留 (不走 cost 替换语义) ⇒ banner-kit **默认分支**
	 * (恒 start / rev=0, 与改前 `session.append("notice/banner", {time, ...payload})` 逐字节等价)。
	 * 非 surface 事件不进模型历史; 失败返回 false, 调用方回退气泡文本。
	 */
	async function appendStatsBanner(session, payload) {
		if (!bk || !bannerTypesOk) { seamFail("stats/test 横幅注入", "banner-kit 不可用或事件类型未注册"); return false; }
		// obs#3 段O（#A102 二/四 ①）：**补唯一身份键** —— 原注释称「独立 context 每次保留」，
		//   但**不传 `replace` ⇒ 恒 `rev:0` / `mode:"start"`** ⇒ merge 键 `(kind,rev,mode)` 恒同
		//   ⇒ **每次替换同一张**（实测：分片无任何 `src=dsh-cost-guard` 的 `balance` 条目）。
		//   ⇒ 补**逐次唯一**的 `rev`（毫秒时间戳）；**不改 `mode`**（mode 由 kit/seams 归一，见段O 登记）。
		const _at = Date.now();
		// ★G1-b（2026-09-20）：逐次唯一的 `cardId`（本卡语义 = 每次一张新卡 ⇒ 取 `sha256("dsh-cost-guard|stats|<sid>|<at>")[:32]`；
		//   **逐次不同 ⇒ POST 语义不变**，不会撞 store 的"cardId 已存在 ⇒ 拒绝"）。
		const _cardIdStats = createHash("sha256").update(`dsh-cost-guard|stats|${String(session?.id ?? "")}|${_at}`).digest("hex").slice(0, 32);
		const r = await bk.emit({ ...payload, at: _at, sessionId: String(session?.id ?? ""), rev: _at, cardId: _cardIdStats, anchorLevel: (Number.isInteger(payload.turn) || Number.isInteger(payload.anchorSeq) || payload.commandId) ? bk.ANCHOR_LEVEL.ROW : bk.ANCHOR_LEVEL.SESSION, form: bk.CARD_FORM.CARD }, { source: STATUS_BUBBLE_SOURCE });
		if (!r?.ok) {
			LOG(`stats 横幅注入失败: ${r?.reason ?? "unknown"}`);
			return false;
		}
		return true;
	}

	/**
	 * G1 生产者 (RD-34/RD-31/RD-36): 状态**跃迁进入 A** 时经 `notifyHub` 推一条 `cost.alert`。
	 * - 入口: **字面量形态** `ctx.get("notifyHub")`(不用可选链 `?.`, RD-10 白名单对撞脚本按字面量扫;
	 *   可选链会形成审计盲区), **优先 `sendNotification`、回退 `send`** (RD-31 别名 additive);
	 * - payload: `{ sid, status:"A", title, body, turnCost, cumCost, reason, turn }`;
	 *   ⚠️ **`body` 必填**(2026-09-13 返工): `dsh-notify.sendNotification` 只认 `{title, body|pages}` ——
	 *   无 `body`/`pages` 时 `pages.length===0` ⇒ **零请求静默丢弃**(还会被 notify 误归因 `no-route`)。
	 *   故此处用人读文案当 `body`(≤200 字符, 永不为空), 结构化字段保留给未来富文本消费方。
	 * - 子会话 (header.origin==="subagent") 不发 (与"子会话只跳过 UI 注入"一致);
	 * - notifyHub 不存在/无发送方法 ⇒ 静默跳过 (debug 一行); **整段 try/catch** ⇒ 推送失败
	 *   绝不影响横幅/统计主流程; 路由由用户在 设置 > 通知 卡为 `cost.alert` 配 (未配只走 routeDefault)。
	 */
	async function emitCostAlert(session, sid, { turn, turnCost, cumCost, reason }) {
		try {
			if (session?.header?.origin === "subagent") {
				debug(`check ${sid.slice(0, 12)}: 子会话不推 cost.alert`);
				return;
			}
			let hub = null;
			try { hub = typeof ctx.get === "function" ? ctx.get("notifyHub") : null; } catch { hub = null; }
			if (!hub) { debug(`check ${sid.slice(0, 12)}: notifyHub 不存在, 跳过 cost.alert`); return; }
			const send = typeof hub.sendNotification === "function" ? hub.sendNotification.bind(hub)
				: typeof hub.send === "function" ? hub.send.bind(hub)
					: null;
			if (!send) { debug(`check ${sid.slice(0, 12)}: notifyHub 无 sendNotification/send, 跳过 cost.alert`); return; }
			const money = (v) => fmtMoney(Number.isFinite(v) ? v : 0);
			// body = 人读文案 (notify 的唯一必填内容字段); title 与结构化字段一并保留
			const body = `单回合 ¥${money(turnCost)} / 累计 ¥${money(cumCost)}${reason ? ` — ${reason}` : ""}（建议切换模式）`.slice(0, 200);
			const r = await send("cost.alert", { sid, status: "A", title: "建议切换", body, turnCost, cumCost, reason, turn });
			debug(`check ${sid.slice(0, 12)}: cost.alert 已推送 (sent=${r?.sent ?? "?"} failed=${r?.failed ?? "?"}${r?.reason ? ` reason=${r.reason}` : ""})`);
		} catch (err) {
			debug(`check ${sid.slice(0, 12)}: cost.alert 推送异常 (不影响横幅/统计): ${String(err?.message ?? err)}`);
		}
	}

	async function checkAndNotify(session, event) {
		const sid = String(session?.id ?? "");
		if (!sid) return;
		// §9.3 Q3 折中 (滤注入保写入): 子会话自身只跳过 UI 注入 (气泡/横幅),
		// stats 写入/评估照常 — writeStats/rebuildSessionStats 不受此标志影响。
		const isSubagent = session?.header?.origin === "subagent";
		const usage = await sessionUsage(sid);
		if (!usage) {
			if (!isSubagent) finishStatusBubble(session, "费用计算完成");
			debug(`check ${sid.slice(0, 12)}: projcache 无数据, 跳过`);
			return;
		}
		// RD-42/43: 取价 + 时段全部来自共享库 @ericality/dsh-cost-pricing (本插件不再抓页/解析/写价格缓存)
		const { prices, tier } = await currentPricesAndTier();
		const p = prices[tier];
		// v4.1: 累计费用补上推理 tokens (projcache totals 不含 reasoning, 按输出价计费; RD-30 reasoning 按输出价)
		const cost = costOfSync(usage, p, { reasoning: sumReasoningTokens(session) });
		const stats = await readStats();
		const m = measurePrompt(session);
		if (!m) {
			if (!isSubagent) finishStatusBubble(session, "费用计算完成");
			debug(`check ${sid.slice(0, 12)}: 会话事件无 request/header, 无法实测, 跳过`);
			return;
		}
		// v4.1: 从会话事件全量聚合所有回合 usage (含被中断回合) 重建统计。
		// 旧逻辑只记 turn/end 观察者能收到的 completed 小回合; 被中断回合的
		// turn/end 由会话重载种子注入、观察者收不到 → 统计选择偏差导致估算低估。
		if (rebuildSessionStats(stats, sid, session)) void writeStats(stats);
		// ===== 树聚合 (设计 §3.2, 2026-09-06): 累计口径 cum → cumTree (自身 + 全部后代) =====
		// 现状 cost = 自身 projcache 四类×当期价 + 自身 reasoning×输出价 (L659 已算)。
		// cumTree = costOf(树 totals 含自身, p) + 自身 reasoning + Σ 子树 reasoning (guard 自身 stats 补)
		// 正交性 (无双计): projcache 四类不含 reasoning; stats 只补 reasoning 维度 —
		//   禁止把 stats 的 input/output/cacheRead 也求和 (那会与 projcache 双计)。
		let cumTree = cost;
		// 注: 子会话 (origin=subagent) 也照常做树聚合评估 (与父会话同口径); Q3 只抑制 UI 注入, 不改评估
		{
			const treeMod = await loadCostTree();
			if (treeMod) {
				try {
					const t = await treeMod.subtreeTotalsFromProjcache(sid); // 含自身; 树索引 TTL 15s 缓存
					if (t?.totals) {
						const ownReasoningYuan = (sumReasoningTokens(session) * p.output) / 1e6;
						let childReasoningYuan = 0;
						for (const c of t.children ?? []) childReasoningYuan += statsReasoningYuan(stats, c.sid, p);
						const treeCum = subtreeCumYuan(t.totals, ownReasoningYuan, childReasoningYuan, p);
						if (treeCum != null) cumTree = treeCum;
						if (t.children?.length) debug(`check ${sid.slice(0, 12)}: 树聚合 ${t.children.length} 个子 agent, 累计 ¥${fmtMoney(cost)} → ¥${fmtMoney(cumTree)}`);
					}
				} catch (err) {
					debug(`check ${sid.slice(0, 12)}: 树聚合失败, 退回单会话口径: ${String(err?.message ?? err)}`);
					// 降级: cumTree = cost (现状)
				}
			}
		}
		const sRec = stats.sessions[sid] ?? { turns: [] };
		// §11 读取链: 有效配置 = 默认←patch←全局覆盖 (每回合直读状态文件, 即时生效)
		const overrides = await readOverrides();
		const cfg = mergeCostGuardCfg(DEFAULT_CFG, config, overrides);
		const params = predictParams(sid, m, cfg, stats, overrides);
		const cmp = computeComparison(m, params, cfg, prices, tier);
		if (!cmp) {
			if (!isSubagent) finishStatusBubble(session, "费用计算完成");
			debug(`check ${sid.slice(0, 12)}: 对比计算失败, 跳过`);
			return;
		}
		debug(`check ${sid.slice(0, 12)}: 实测 system=${m.systemTokens} tools=${m.toolsTokens} (${m.toolsCount}个) instr=${m.instructionsTokens} firstMsg=${m.firstUserTokens} ctx=${fmtTokens(m.ctxTokens)} 步数/回合=${m.avgStepsPerTurn} 统计 inputPerTurn=${fmtTokens(params.inputPerTurn)} outputPerTurn=${fmtTokens(params.outputPerTurn)} cacheRead/回合=${fmtTokens(params.cacheReadPerTurn)}`);
		// ================= v5: 双模式评估 + 未来5回合预测 + 展示节奏 =================
		const turns = sRec.turns ?? [];
		const turnCount = turns.length;
		const last = turns[turnCount - 1];
		const lastTurnCost = last ? turnCostOf(last, p) : 0;
		const ctxTokens = m.ctxTokens ?? 0;
		const consTh = { turnYuan: cfg.consTurnYuan, cumYuan: cfg.consCumYuan, ctxTokens: cfg.consCtxTokens, turns: cfg.consTurns };
		const aggTh = { turnYuan: cfg.aggTurnYuan, cumYuan: cfg.aggCumYuan, ctxTokens: cfg.aggCtxTokens, turns: cfg.aggTurns };
		const cons = evaluateMode(lastTurnCost, cumTree, ctxTokens, turnCount, consTh);
		const agg = evaluateMode(lastTurnCost, cumTree, ctxTokens, turnCount, aggTh);
		const status = cons.switch ? (agg.switch ? "A" : "C") : "B";
		debug(`check ${sid.slice(0, 12)}: 回合费 ¥${fmtMoney(lastTurnCost)} 累计 ¥${fmtMoney(cumTree)} 上下文 ${fmtTokens(ctxTokens)} 回合 ${turnCount} → 保守${cons.switch ? "切" : "留"} 激进${agg.switch ? "切" : "留"} 状态${status}`);
		// 展示节奏: B → 不显示; C → 状态变为 C 时首次显示一次 (持续 C 不重复, 状态变化重新触发); A → 每回合替换显示
		if (!shouldShow(status, sRec.lastStatus)) {
			if (sRec.lastStatus !== status) { sRec.lastStatus = status; void writeStats(stats); }
			if (!isSubagent) finishStatusBubble(session, statusFinishText(status));
			debug(`check ${sid.slice(0, 12)}: 状态 ${status} ${status === "B" ? "无切换建议, 不显示" : "已显示过一次, 跳过 (状态变化后重新触发)"}`);
			return;
		}
		// ================= G1: cost.alert 生产者 (RD-34/RD-36) =================
		// 状态模型 A/B/C (L1158): A=建议切换 / B=无需切换 / C=丰俭由人。触发条件 = **跃迁进入 A**
		// (status==="A" 且 sRec.lastStatus !== "A"); 去重直接用 stats 里已持久化的 lastStatus
		// ⇒ **跨重启不重复** (不新增进程内 Map); A 回落 B/C 后再进 A ⇒ 再发一次。
		// 判定必须在写 sRec.lastStatus **之前** (下方即赋值点)。
		const alertEnterA = status === "A" && sRec.lastStatus !== "A";
		sRec.lastStatus = status;
		void writeStats(stats);
		if (alertEnterA) {
			// 通知失败绝不影响横幅/统计主流程 (整段 try/catch + fire-and-forget)
			void emitCostAlert(session, sid, {
				turn: Number.isInteger(event?.data?.turn) ? event.data.turn : turnCount,
				turnCost: Math.round(lastTurnCost * 100) / 100,
				cumCost: Math.round(cumTree * 100) / 100,
				reason: cons.hits.length ? fmtReason(mainReason(cons.hits)) : ""
			}).catch(() => { /* emitCostAlert 内部已 try/catch, 这里再兜一层 */ });
		}
		// 未来 5 回合预测 (两模式共用同一基数)
		const pred = predictFiveTurns(turns, p, cfg);
		const fmtPred = (v) => (v == null ? "—" : `¥${fmtMoney(v)}`);
		const modeOf = (name, tag, res) => ({
			name,
			tag,
			conclusion: res.switch ? "switch" : "keep",
			continue5: pred ? Math.round(pred.continue5 * 100) / 100 : null,
			switch5: pred ? Math.round(pred.switch5 * 100) / 100 : null,
			diff: pred ? Math.round(pred.diff * 100) / 100 : null
		});
		const modes = [
			modeOf("保守建议", "省钱优先", cons),
			modeOf("激进建议", "效率优先", agg)
		];
		// 最主要触发原因 (两模式被触发条件里超出比例最高的一项; 保守阈值≤激进 ⇒ 并集即保守 hits)
		const reason = mainReason(cons.hits);
		const title = status === "A" ? "建议切换" : "丰俭由人";
		debug(`check ${sid.slice(0, 12)}: ${status === "A" ? "每回合" : "首次"}触发 ${reason ? fmtReason(reason) : ""} 继续5回合 ${fmtPred(pred?.continue5)} vs 切换5回合 ${fmtPred(pred?.switch5)}`);
		if (!isSubagent) {
			await appendBanner(session, sid, {
				// A 阶段（obs#3）：cost 卡补 turn + anchorSeq + ctxKey（旧 id 形态 `cost-<seq>`，seq 取**触发事件** seq）
				turn: Number.isInteger(event?.data?.turn) ? event.data.turn : (Number.isInteger(turnCount) ? turnCount : null),
				anchorSeq: Number.isInteger(event?.seq) ? event.seq : null,
				// 段U15 A1：**稳定单调 rev**（该回合回合号；无回合回落触发事件 seq；**禁止时间戳**）
				//   ⇒ store 走 `start` 分支并尊重本值 ⇒ 合并键 `(kind,rev,mode)` 同回合恒定 ⇒ 幂等覆盖、不累积。
				rev: (Number.isInteger(event?.data?.turn) ? event.data.turn : (Number.isInteger(turnCount) ? turnCount : (Number.isInteger(event?.seq) ? event.seq : 0))),
				ctxKey: Number.isInteger(event?.seq) ? "cost-" + event.seq : null,
				kind: "cost",
				priority: 3, foldable: false, family: "cost",
				title,
				status,
				trigger: reason ? fmtReason(reason) : "",
				modes,
				raw: { turn: Math.round(lastTurnCost * 100) / 100, cum: Math.round(cumTree * 100) / 100, ctx: ctxTokens, turns: turnCount },
				turns: Math.max(1, Math.round(cfg.predictTurns ?? 5)),
				helper: status === "C" ? "深度开发/调试可参考激进建议；简单查询/批量任务请参考保守建议。" : "",
				costYuan: Math.round(cumTree * 100) / 100,
				tier,
				sessionShort: sid.slice(8, 16),
				at: Date.now()
			});
			finishStatusBubble(session, statusFinishText(status));
		} else {
			// §9.3 Q3: 子会话只跳过 UI 注入, 评估/统计已照常 (lastStatus 已更新 + writeStats 已调)
			debug(`check ${sid.slice(0, 12)}: 子会话 (origin=subagent), 跳过横幅/气泡注入, 评估与 stats 已照常`);
		}
	}

	ctx.on("session/event", (session, event) => {
		// 2026-09-10: 观察者侧缓存 measurePrompt 所需事件 (0.1.2 下 session.events 不可用)
		if (session?.id) cacheMeasureEvent(String(session.id), event);
		// 缓存 request/header (0.1.2 下 session.events 不再暴露该事件)
		if (session?.id && event?.type === "request/header" && event.data?.header) {
			lastHeaderCache.set(String(session.id), event.data.header);
		}
		if (event?.type !== "turn/end" || !session?.id) return;
		const sid = String(session.id);
		// v5.2: turn/end 事件自身 append 的派发过程中 session.append 不可重入
		// (dsh-session appending 标志抛 "session append cannot reenter") —
		// 必须 setImmediate 等派发完成再注入"费用计算中…"气泡, 否则气泡被静默丢弃
		// (2026-08-27 生产实测 bug: 重启后 0 条 status 记录, 已复现修复)。
		if (!STATUS_BUBBLE_DISABLED) {
			// v5.3.1: STATUS_BUBBLE_DISABLED=true 时不再注入"费用计算中…"气泡 (应急屏蔽, 见顶部注释)
			// §9.3 Q3 (2026-09-06): 子会话 (origin=subagent) 只跳过 UI 注入 → 不注入 running 气泡;
			// stats 写入与评估照常 (checkAndNotify 内完成, writeStats/rebuildSessionStats 不动)。
			const isSubagent = session?.header?.origin === "subagent";
			if (!isSubagent) {
				setImmediate(() => { appendStatusBubble(session, "费用计算中…", "running", event?.data?.turn); });
			}
		}
		// 再延迟 1s 等 projection 缓存落盘后计算; 计算结果在 checkAndNotify 内原地替换气泡
		setTimeout(() => { void checkAndNotify(session, event); }, 1000);
	});

	// ---- 幂等对账 (v4.2; RD-37 动态化): 重启掐断回合的 turn/end 不派发观察者 → 会话恢复时
	// 以"最后一张费用横幅 vs 最新 turn/end 时间"为判据补评: 横幅缺失或落后即重算
	// (checkAndNotify 内部从事件全量重建统计, 含被中断回合; 横幅是 replace 语义,
	// 同一会话只保留最新一条 → 重复执行天然幂等)。
	// 阶段 2: 静态 `import { attachReconcile, lastTurnEnd }` 已删除 ⇒ 经 loadReconcile() 动态加载;
	// **取不到 ⇒ 对账路径停用 + reportDegraded("reconcile")**, 不保留任何静态兜底 (D12/§10.2)。
	// 事件源同 F6 收口: `readSessionEvents` 改走 host-compat §4.1 seam (eventsOf ⇒ seamsRef)。
	const rc = await loadReconcile();
	if (typeof rc?.attachReconcile !== "function" || typeof rc?.lastTurnEnd !== "function") {
		LOG("对账路径停用 — dsh-reconcile 不可用 (契约 §10.2: 不保留静态兜底双路径)");
	} else {
		rc.attachReconcile(ctx, {
			name: "cost-guard",
			shouldReconcile: (session) => {
				const end = rc.lastTurnEnd(session);
				if (!end) return false;
				const events = eventsOf(session) ?? [];
				let lastBannerTime = 0;
				for (const ev of events) {
					if ((ev.type === "notice/banner" || ev.type === "notice/banner-replace")
						&& ev.data?.kind === "cost" && typeof ev.time === "number") {
						if (ev.time > lastBannerTime) lastBannerTime = ev.time;
					}
				}
				// 最新回合结束晚于最后一张费用横幅 → 该回合未被实时路径处理过
				// (中断回合: 观察者根本没收到; 完成回合: 1s 延迟计时器随进程被杀)
				return end.time > lastBannerTime;
			},
			reconcile: async (session) => {
				await checkAndNotify(session, rc.lastTurnEnd(session)?.event ?? null);
			}
		});
	}

	// ---- /costguard-cfg RPC 通道 (设计方案 §11.3, 2026-09-06) ----
	// 浏览器设置卡 (lib/client.js, settings.localplugin.item key=cost-guard) 经框架通用 RPC
	// (ctx.connection.rpc.call("/costguard-cfg", "<endpoint>", payload)) 读写配置 — 卡 = 唯一配置入口。
	// 权限/通道同现有 RPC 先例 (host connection client-request, 无新增认证); handler 只读写
	// 状态文件 SETTINGS_FILE, 不碰 stats/不注入横幅。返回 { ok:true, value } | { ok:false, error:{code,message} }。
	// 端点:
	//   get                  → value = { defaults, patch(卡"默认层"), overrides, effective, legacy, updatedAt }
	//   set { key, value }   → 白名单+类型+范围校验 → 写盘 → value 同上 (非法 → ok:false)
	//   reset { key }        → 删单键 (单项恢复默认 → 回到 patch 值)
	//   resetAll             → overrides = {} (整卡重置到 patch 默认)
	// 阶段 2: 注册改走 §4.6 seam `rpcHandle(ctx, channel, handler)` (契约 §2.1: 宿主访问一律经 seam;
	// 该面自动带 GUI cookie 门禁)。缺能力 ⇒ 通道不注册 + 告警 (设置卡显示读取失败), 不直连 ctx.get。
	const cfgHandler = async (endpoint, payload) => {
		try {
			const raw = await readSettings();
			let ov = raw.overrides;
			let updatedAt = raw.updatedAt;
			const value = () => ({
				defaults: { ...DEFAULT_CFG },
				patch: mergeCostGuardCfg(DEFAULT_CFG, patchLayerOf(), {}),
				overrides: ov,
				effective: mergeCostGuardCfg(DEFAULT_CFG, patchLayerOf(), ov),
				legacy: legacyCfg(),
				updatedAt
			});
			switch (endpoint) {
			case "get":
				return { ok: true, value: value() };
			case "set": {
				const r = validateOverrideValue(payload?.key, payload?.value);
				if (!r.ok) return { ok: false, error: { code: "bad-request", message: r.error } };
				ov = { ...ov, [payload.key]: r.value };
				updatedAt = new Date().toISOString();
				await writeSettingsFile(ov, updatedAt);
				return { ok: true, value: value() };
			}
			case "reset": {
				const key = payload?.key;
				if (!OVERRIDE_KEYS.includes(key)) return { ok: false, error: { code: "bad-request", message: `未知键 ${key}` } };
				if (ov[key] !== undefined) {
					ov = { ...ov };
					delete ov[key];
					updatedAt = new Date().toISOString();
					await writeSettingsFile(ov, updatedAt);
				}
				return { ok: true, value: value() };
			}
			case "resetAll":
				ov = {};
				updatedAt = new Date().toISOString();
				await writeSettingsFile(ov, updatedAt);
				return { ok: true, value: value() };
			default:
				return { ok: false, error: { code: "not-found", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-cost-guard: /costguard-cfg RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	/** ★ 批 4 件②（「丙」）：注册抽成具名函数 ⇒ **幂等**（成功过即跳过，防宿主 `duplicate` 抛错）。 */
	let rpcCfgRegistered = false;
	const tryRegisterCfgRpc = () => {
		if (rpcCfgRegistered) return { ok: true, already: true };
		// ★`#A57`：0.2.2 起先试官方 Fetch 面（`/api/costguard-cfg/<ep>`，复用 /api cookie 门禁）
		try {
			if (typeof seams?.channelFace === "function") {
				const face = seams.channelFace(ctx, "/costguard-cfg", ["get", "set", "reset", "resetAll"], cfgHandler);
				if (face?.ok) { rpcCfgRegistered = true; return { ok: true, via: "fetch", routes: face.routes }; }
			}
		} catch (err) { seamFail("RPC /costguard-cfg", `channelFace 异常: ${String(err?.message ?? err)}`); }
		if (!capOk("rpcHandle") || !seamFn("rpcHandle")) { seamFail("RPC /costguard-cfg", "缺能力 rpcHandle"); return { ok: false, reason: "rpcHandle" }; }
		try {
			const r = seamFn("rpcHandle")(ctx, "/costguard-cfg", cfgHandler);
			if (!r?.ok) { seamFail("RPC /costguard-cfg", `rpcHandle 失败: ${r?.reason ?? "unknown"}`); return { ok: false, reason: String(r?.reason ?? "unknown") }; }
			rpcCfgRegistered = true;
			return { ok: true };
		} catch (err) {
			seamFail("RPC /costguard-cfg", `rpcHandle 异常: ${String(err?.message ?? err)}`);
			return { ok: false, reason: `threw:${String(err?.message ?? err)}` };
		}
	};
	/** 就绪订阅接入状态已在上方声明（`readySubState`/`readySubReason`；此处只需接线）。 */
	const firstReg = tryRegisterCfgRpc();
	if (!firstReg.ok && firstReg.reason === "rpcHandle") {
		// 仅"能力未就绪"才订阅；其它失败＝真问题，不靠订阅掩盖
		const sub = subscribeCompatReady(ctx, (reason, r) => {
			readySubState = r.ok ? "registered" : "failed";
			readySubReason = r.ok ? `就绪订阅触发(${reason}) ⇒ RPC 已补注册` : `就绪订阅触发(${reason}) ⇒ 补注册失败: ${r.reason}`;
			LOG(readySubReason);
			try { republishCap(); } catch { /* 上报失败不影响主流程 */ }
		}, tryRegisterCfgRpc);
		readySubState = sub.state;
		readySubReason = sub.reason;
	}

	ctx.commands.register({
		name: "costguard-test",
		description: "验证成本对比计算 (实测数值 + 未来N回合 切换新会话 vs 继续本会话 费用对比, 不推送任何外部通知, 横幅展示)",
		handler: async (invocation) => {
			const sid = String(invocation?.agent?.session?.id ?? "");
			const session = invocation?.agent?.session;
			const usage = await sessionUsage(sid);
			const { prices, tier } = await currentPricesAndTier();
			const stats = await readStats();
			// v4.1: 与 checkAndNotify 同口径 — 从事件全量重建统计 (含被中断回合)
			if (rebuildSessionStats(stats, sid, session)) void writeStats(stats);
			const enoughStatsT = (stats.sessions?.[sid]?.turns?.length ?? 0) >= MIN_ADVICE_TURNS;
			const m = measurePrompt(session);
			// §11 读取链: /costguard-test 与横幅同口径 — 阈值/预测/覆盖走 有效配置 (默认←patch←全局覆盖)
			const overrides = await readOverrides();
			const cfg = mergeCostGuardCfg(DEFAULT_CFG, config, overrides);
			const params = m ? predictParams(sid, m, cfg, stats, overrides) : null;
			const cmp = m ? computeComparison(m, params, cfg, prices, tier) : null;
			const adviceT = !cmp ? "" : cmp.condition === "new" ? "切换更划算" : cmp.condition === "similar" ? "差异不大" : "继续更划算";
			// v4.1: 累计费用含推理 tokens (按输出价; RD-30)
			const totalCost = usage ? costOfSync(usage, prices[tier], { reasoning: sumReasoningTokens(session) }) : null;
			// v5: 双模式评估 + 未来5回合预测 (与 checkAndNotify 同口径)
			const turnsT = stats.sessions?.[sid]?.turns ?? [];
			const lastT = turnsT[turnsT.length - 1];
			const lastTurnCostT = lastT && prices ? turnCostOf(lastT, prices[tier]) : null;
			const ctxT = m?.ctxTokens ?? 0;
			const consThT = { turnYuan: cfg.consTurnYuan, cumYuan: cfg.consCumYuan, ctxTokens: cfg.consCtxTokens, turns: cfg.consTurns };
			const aggThT = { turnYuan: cfg.aggTurnYuan, cumYuan: cfg.aggCumYuan, ctxTokens: cfg.aggCtxTokens, turns: cfg.aggTurns };
			const consT = evaluateMode(lastTurnCostT ?? 0, totalCost ?? 0, ctxT, turnsT.length, consThT);
			const aggT = evaluateMode(lastTurnCostT ?? 0, totalCost ?? 0, ctxT, turnsT.length, aggThT);
			const statusT = consT.switch ? (aggT.switch ? "A" : "C") : "B";
			const predT = prices ? predictFiveTurns(turnsT, prices[tier], cfg) : null;
			const hitsText = (res) => res.hits.length
				? res.hits.map((h) => h.kind === "ctx" ? `上下文 ${fmtTokens(h.value)}>${fmtTokens(h.threshold)}` : h.kind === "turns" ? `回合 ${h.value}>${h.threshold}` : `${h.label} ¥${fmtMoney(h.value)}>¥${fmtMoney(h.threshold)}`).join(" / ")
				: "全部未超限";
			const statusChip = statusT === "A"
				? { t: "建议切换", c: "#ef4444", bg: "rgba(239,68,68,0.14)", bd: "rgba(239,68,68,0.5)" }
				: statusT === "C"
					? { t: "丰俭由人", c: "#f59e0b", bg: "rgba(245,158,11,0.14)", bd: "rgba(245,158,11,0.5)" }
					: { t: "建议继续", c: "#22c55e", bg: "rgba(34,197,94,0.14)", bd: "rgba(34,197,94,0.5)" };
			const lines = [
				"dsh-cost-guard 计算验证 (无 Synology 推送)",
				`实测: 系统提示词 ${m?.systemTokens ?? "N/A"} + 工具定义 ${m?.toolsTokens ?? "N/A"} (${m?.toolsCount ?? "?"}个) + agent-instructions ${m?.instructionsTokens ?? "N/A"} tokens`,
				`统计: 每回合新增输入约 ${params?.inputPerTurn ? fmtTokens(params.inputPerTurn) : "N/A"} · 输出+推理约 ${params?.outputPerTurn ? fmtTokens(params.outputPerTurn) : "N/A"} · 缓存读取约 ${params?.cacheReadPerTurn ? fmtTokens(params.cacheReadPerTurn) : "N/A"} (${params?.stepsPerTurn ?? "?"} 步/回合) · 首回合输出约 ${params?.firstTurnOutput ? fmtTokens(params.firstTurnOutput) : "N/A"} (同源实测均值, 本会话 ${stats.sessions?.[sid]?.turns?.length ?? 0} 回合)`,
				`估算: 任务文件 ${params?.taskFileTokens ?? cfg.taskFileTokens} tokens · 首条消息 ${m?.firstUserTokens ?? "N/A"} tokens`,
				`上下文: 当前约 ${m?.ctxTokens ? fmtTokens(m.ctxTokens) : "N/A"} (实测 cacheRead)`,
				`双模式 (v5): 回合费 ${lastTurnCostT != null ? `¥${fmtMoney(lastTurnCostT)}` : "N/A"} · 保守建议: ${consT.switch ? "切换" : "继续"} (${hitsText(consT)}) · 激进建议: ${aggT.switch ? "切换" : "继续"} (${hitsText(aggT)}) → 状态 ${statusT === "A" ? "A·建议切换" : statusT === "C" ? "C·丰俭由人" : "B·不显示"}`,
				predT
					? `预测: 近${predT.turns}回合均值 ¥${fmtMoney(predT.base)}/回合 → 继续5回合 ¥${fmtMoney(predT.continue5)} (×${cfg.continueFactor}) vs 切换5回合 ¥${fmtMoney(predT.switch5)} (×${cfg.switchFactor}), 切换可省 ¥${fmtMoney(predT.diff)}`
					: "预测: 无回合统计, 无法预测",
				cmp
					? `对比 (${tier === "peak" ? "高峰" : "低谷"}价, 未来 ${cmp.turns} 回合总账): 切换新会话 ¥${fmtMoney(cmp.cNew)} vs 继续本会话 ¥${fmtMoney(cmp.cContinue)} → ${adviceT}${!enoughStatsT ? ` (统计不足 ${MIN_ADVICE_TURNS} 回合, 未超阈值时不提示切换建议)` : ""}`
					: "对比: 无实测数据, 无法计算",
				usage ? `累计费用: ¥${fmtMoney(totalCost)} (含推理, 阈值 ¥${thresholdYuan}, ${totalCost >= thresholdYuan ? "超阈值 → 每回合提醒" : "未超阈值 → 统计充足且明显更实惠时才提醒"})` : "(无 tokenUsage 数据)"
			];

			// 横幅 (kind=balance, mode=test 徽章"计算验证", 与 /cost 同款家族): 统计格 + 键值行
			const ok = await appendStatsBanner(session, {
				kind: "balance",
				priority: 3, foldable: false, family: "balance",
				variant: "test",
				// ★T-F′（2026-09-21 obs3S7；用户已签）：**命令↔行配对键** —— 命令面取宿主发放的同源 `commandId`
				//   （与 `command/done.data.commandId` 逐字同值；`invocation` 由 handler 作用域提供）；取不到 ⇒ null（不猜）
				commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
				turn: null,
				ctxKey: "balance-" + Date.now(),
				title: "cost-guard 计算验证",
				subtitle: `${tier === "peak" ? "高峰" : "低谷"}价 · 未来 ${cmp ? cmp.turns : cfg.estimateTurns} 回合总账 · 会话 ${sid.slice(8, 16)}`,
				stats: [
					{ label: "切换新会话", value: cmp ? `¥${fmtMoney(cmp.cNew)}` : "N/A", strong: !!cmp },
					{ label: "继续本会话", value: cmp ? `¥${fmtMoney(cmp.cContinue)}` : "N/A", strong: !!cmp },
					{ label: "双模式状态", value: statusChip.t, color: statusChip.c, bg: statusChip.bg, border: "1px solid " + statusChip.bd, size: 15, key: true },
					{ label: "累计费用", value: totalCost !== null ? `¥${fmtMoney(totalCost)}` : "N/A", note: totalCost !== null ? `保守阈值 ¥${cfg.consCumYuan}` : "" }
				],
				kv: [
					{ k: "实测", v: `系统提示词 ${m?.systemTokens ?? "N/A"} · 工具定义 ${m?.toolsTokens ?? "N/A"} (${m?.toolsCount ?? "?"}个) · agent-instructions ${m?.instructionsTokens ?? "N/A"} tokens` },
					{ k: "统计", v: `每回合输入 ${params?.inputPerTurn ? fmtTokens(params.inputPerTurn) : "N/A"} · 输出+推理 ${params?.outputPerTurn ? fmtTokens(params.outputPerTurn) : "N/A"} · 缓存读取 ${params?.cacheReadPerTurn ? fmtTokens(params.cacheReadPerTurn) : "N/A"} (${params?.stepsPerTurn ?? "?"} 步/回合) · 首回合输出 ${params?.firstTurnOutput ? fmtTokens(params.firstTurnOutput) : "N/A"} (同源实测均值, 本会话 ${stats.sessions?.[sid]?.turns?.length ?? 0} 回合)` },
					{ k: "估算", v: `任务文件 ${params?.taskFileTokens ?? cfg.taskFileTokens} tokens · 首条消息 ${m?.firstUserTokens ?? "N/A"} tokens · 当前上下文约 ${m?.ctxTokens ? fmtTokens(m.ctxTokens) : "N/A"} (cacheRead)` },
					{ k: "对比", v: cmp ? `切换新会话 ¥${fmtMoney(cmp.cNew)} vs 继续本会话 ¥${fmtMoney(cmp.cContinue)} → ${adviceT}${!enoughStatsT ? ` · 统计不足 ${MIN_ADVICE_TURNS} 回合, 未超阈值时不提示切换建议` : ""}` : "无实测数据, 无法计算" },
					{ k: "双模式", v: `保守建议: ${consT.switch ? "切换" : "继续"} (${hitsText(consT)}) · 激进建议: ${aggT.switch ? "切换" : "继续"} (${hitsText(aggT)}) → 状态 ${statusT}` },
					{ k: "预测", v: predT ? `近${predT.turns}回合均值 ¥${fmtMoney(predT.base)}/回合 → 继续5回合 ¥${fmtMoney(predT.continue5)} (×${cfg.continueFactor}) vs 切换5回合 ¥${fmtMoney(predT.switch5)} (×${cfg.switchFactor}), 切换可省 ¥${fmtMoney(predT.diff)}` : "无回合统计, 无法预测" }
				],
				metaText: `无 Synology 推送 · 本提示不会进入模型历史`,
				advice: `状态 ${statusT === "A" ? "A·建议切换 → 每回合提醒" : statusT === "C" ? "C·丰俭由人 → 首次显示一次" : "B·不显示"}`
			});
			if (!ok) return { kind: "success", text: lines.join("\n") };
			return { kind: "success", text: "" };
		}
	});

	ctx.commands.register({
		name: "costguard-stats",
		description: "查看 cost-guard 历史统计与预测参数 (插件安装后每会话每回合 usage; 配置修改请到 设置 > 本地插件 > 费用提醒 卡)",
		input: { hint: "查看 (不带参数)" },
		handler: async (invocation) => {
			const sid = String(invocation?.agent?.id ?? "");
			const raw = (invocation?.rawInput ?? "").trim();
			const stats = await readStats();
			const m = measurePrompt(invocation?.agent?.session);
			// §11: 覆盖 = 全局状态文件 (per-session overrides 退役); 命令只读, 阈值/覆盖修改走设置卡
			const overrides = await readOverrides();
			const cfg = mergeCostGuardCfg(DEFAULT_CFG, config, overrides);
			const params = m ? predictParams(sid, m, cfg, stats, overrides) : null;
			const sRec = stats.sessions?.[sid];
			const sessionObj = invocation?.agent?.session;
			const ovText = Object.keys(overrides).length
				? Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(", ")
				: "(无 · 到 设置 > 本地插件 > 费用提醒 卡修改)";

			// ---- 查看模式: 紫色 balance 家族横幅 (mode=stats, 与 /cost 同款) ----
			if (!raw) {
				const turns = sRec?.turns ?? [];
				const sum = (key) => {
					const vals = turns.slice(-10).map((t) => t[key]).filter(Number.isFinite);
					return vals.length ? `${fmtTokens(vals.reduce((a, b) => a + b, 0) / vals.length)}` : "N/A";
				};
				const lines = [
					`会话 ${sid.slice(8, 16)} · 统计自 ${(stats.since ?? "").slice(0, 16).replace("T", " ")} (UTC)`,
					`记录回合数: ${turns.length}${turns.length ? ` (最近: 输入 ${sum("input")}/回合 · 输出+推理 ${sum("output")}+${sum("reasoning")}/回合 · 缓存读取 ${sum("cacheRead")}/回合 · ${sum("steps")} 步/回合)` : " (尚无数据, 从下个回合开始记录)"}`,
					`预测参数: 输入 ${params ? fmtTokens(params.inputPerTurn) : "N/A"}/回合 · 输出+推理 ${params ? fmtTokens(params.outputPerTurn) : "N/A"}/回合 · 缓存读取 ${params ? fmtTokens(params.cacheReadPerTurn) : "N/A"}/回合 (${params?.stepsPerTurn ?? "?"} 步) · 首回合输出 ${params ? fmtTokens(params.firstTurnOutput) : "N/A"} · 任务文件 ${params ? fmtTokens(params.taskFileTokens) : "N/A"}`,
					`全局覆盖 (设置>本地插件>费用提醒): ${ovText}`
				];
				const ok = await appendStatsBanner(sessionObj, {
					kind: "balance",
					priority: 3, foldable: false, family: "balance",
					variant: "stats",
					// ★T-F′（2026-09-21 obs3S7；用户已签）：**命令↔行配对键** —— 命令面取宿主发放的同源 `commandId`
					//   （与 `command/done.data.commandId` 逐字同值；`invocation` 由 handler 作用域提供）；取不到 ⇒ null（不猜）
					commandId: (typeof invocation?.commandId === "string" && invocation.commandId) ? invocation.commandId : null,
					title: "cost-guard 预测参数",
					subtitle: `会话 ${sid.slice(8, 16)}`,
					stats: [
						{ label: "记录回合数", value: `${turns.length}`, note: turns.length ? "最近10回合均值" : "从下回合开始" },
						{ label: "预测输入", value: params ? fmtTokens(params.inputPerTurn) : "N/A", note: "/回合" },
						{ label: "预测输出(+推理)", value: params ? fmtTokens(params.outputPerTurn) : "N/A", note: "/回合" },
						{ label: "缓存读取", value: params ? fmtTokens(params.cacheReadPerTurn) : "N/A", note: `${params?.stepsPerTurn ?? "?"} 步/回合` },
						{ label: "首回合输出", value: params ? fmtTokens(params.firstTurnOutput) : "N/A" }
					],
					kv: [
						{ k: "最近10回合", v: turns.length ? `输入 ${sum("input")}/回合 · 输出+推理 ${sum("output")}+${sum("reasoning")}/回合 · 缓存读取 ${sum("cacheRead")}/回合 · ${sum("steps")} 步/回合` : "尚无数据, 从下个回合开始记录" },
						{ k: "任务文件", v: `${params ? fmtTokens(params.taskFileTokens) : "N/A"} tokens` },
						{ k: "全局覆盖", v: ovText }
					],
					metaText: `统计自 ${(stats.since ?? "").slice(0, 16).replace("T", " ")} (UTC)`,
					advice: "阈值/覆盖修改: 设置 > 本地插件 > 费用提醒 卡 (改后即时生效); /costguard-stats set|clear 已移除"
				});
				if (!ok) return { kind: "success", text: lines.join("\n") };
				return { kind: "success", text: "" };
			}

			// ---- 带参数: set/clear 已移除 (设计方案 §11.4, 用户从未用过) → 红色 error 横幅提示 ----
			const msg = "/costguard-stats 为查看命令 (不带参数); set/clear 已移除 — 阈值与预测覆盖请到 设置 > 本地插件 > 费用提醒 卡修改 (即时生效)";
			const ok = await appendStatsBanner(sessionObj, {
				kind: "error",
				priority: 0, foldable: true, family: "error",
				title: "参数错误",
				lines: [msg],
				metaText: "用法: /costguard-stats (查看)"
			});
			if (ok) return { kind: "success", text: "" };
			return { kind: "error", text: msg };
		}
	});
}

// 导出纯函数供独立测试 import (无副作用, cordis 加载不受影响);
// §11 配置层纯函数 (DEFAULT_CFG/OVERRIDE_KEYS/mergeCostGuardCfg/validateOverrideValue/
// readOverrides/readSettings) 已在定义处 inline export。
export { turnCostOf, evaluateMode, mainReason, fmtReason, predictFiveTurns, shouldShow, statusFinishText, appendStatusBubble, finishStatusBubble, lastStatusBubble };
