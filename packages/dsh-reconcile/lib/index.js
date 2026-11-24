/**
 * @deepseek-ai/dsh-reconcile (本地辅助库, 非官方包, v0.1.0)
 *
 * 会话日志幂等对账工具 —— 把"回合结束"从一次性事件变成可重放的对账。
 *
 * 背景 (源码验证, 2026-08-26):
 *   容器重启会掐断当前 agent 回合。dsh-session-persistence 在会话重载时用
 *   interruptedTurnClosers() 合成缺失的闭合事件 (未落盘的 tool/result 错误结果 +
 *   step/end + turn/end {reason:{kind:'interrupted'}}) 并持久化 (commitRepair),
 *   但源码注释明确 "constructor seeds do not emit": 种子事件不派发
 *   session/event 观察者 → 依赖实时 turn/end 的插件 (dsh-cost-ledger /
 *   dsh-cost-guard / dsh-notify) 收不到, 回合结束的活 (记账/费用提醒/完成通知)
 *   静默丢失。
 *
 * 解法 (幂等对账, 事件溯源消费者模式):
 *   插件 apply 时调用 attachReconcile(ctx, { shouldReconcile, reconcile }):
 *     - shouldReconcile(session): 该会话是否需要补做。用插件自己的持久状态判定
 *       (典型: 日志里最新的 turn/end 尚未被本插件处理过, 或该回合注入的产物缺失)。
 *     - reconcile(session): 补做缺失回合的活。必须与实时 turn/end 路径复用同一套
 *       处理函数, 且幂等 (重复执行无副作用, 出错留日志、下个进程自然重试)。
 *   attachReconcile 内置:
 *     - session/created 钩子: 新建/恢复会话都会触发 (恢复时 session.events 已含
 *       修复后的完整日志), {global:true} 保证任意作用域可收到 (与 dsh-compaction 同法);
 *     - 启动延迟扫描 ctx.sessions.list(): 兜底 apply 时已在线、之后不会再触发
 *       created 的会话;
 *     - 每会话每进程只对账一次 + 并发保护。
 */
export const name = "dsh-reconcile";

/** 规范化 turn/end 事件的 reason 文本 (completed/interrupted/aborted/...) */
export function turnEndReason(ev) {
	const r = ev?.data?.reason;
	if (typeof r === "string") return r;
	if (r && typeof r === "object") return r.kind ?? "unknown";
	return "unknown";
}

// 2026-09-10 (0.1.2 适配): agent.session.events 已不可用 → 各导出函数改为"显式告警 + 空结果",
// 不再静默返回空(那会让自动对账永久静默失效, 排查时完全看不到原因)。
// 2026-09-13 (阶段 0 修死链): 上条的"告警 + 空结果"其实是**恒空**(判定条件本身失效) →
// 新增 readSessionEvents() 双路径, listTurnEnds/turnElapsedMs 改走它; 告警路径保留给"真不可用"。
let logWarn = null;                       // apply() 内注入 ctx.logger.warn (导出函数无 ctx)
const warnedNoEvents = new Set();
function warnNoEvents(where, session) {
	const sid = String(session?.id ?? "?");
	const key = `${where}:${sid}`;
	if (warnedNoEvents.has(key)) return;   // 每(函数,会话)只告警一次
	warnedNoEvents.add(key);
	logWarn?.(`dsh-reconcile: 会话 ${sid.slice(0, 12)} 的 session.events 不可用(0.1.2 起移除) → ${where} 跳过事件扫描`);
}

/**
 * 会话日志读取 (2026-09-13 阶段 0 修死链, 形态照抄 dsh-taskqueue/lib/index.js:455-467):
 * 0.1.2-rc.1 起宿主 `Session` **没有 `events` 属性** (dsh-session 公开面 =
 * header/surface/seq/eventAt()/snapshotEvents()/ownEvents()) ⇒ 旧写法
 * `Array.isArray(session?.events)` 恒 false ⇒ listTurnEnds 恒 []、lastTurnEnd/turnElapsedMs
 * 恒 null ⇒ 三个消费方 (cost-guard / cost-ledger / notify) 的补账/补推永不执行。
 * 统一走本 helper: 旧版取 session.events; 0.1.2 取 snapshotEvents() → ownEvents()。
 * 都拿不到才返回 null (调用方据此走 warnNoEvents 告警路径, 不退化为静默)。
 */
export function readSessionEvents(session) {
	if (!session) return null;
	if (Array.isArray(session.events)) return session.events; // < 0.1.2
	try {
		if (typeof session.snapshotEvents === "function") {
			const ev = session.snapshotEvents();
			if (Array.isArray(ev)) return ev;
		}
	} catch { /* 日志不可读 → 试下一个 */ }
	try {
		if (typeof session.ownEvents === "function") {
			const ev = session.ownEvents();
			if (Array.isArray(ev)) return ev;
		}
	} catch { /* 都拿不到 */ }
	return null;
}

/** 会话日志中所有 turn/end 事件 (含修复注入的 interrupted), 按日志顺序 */
export function listTurnEnds(session) {
	const events = readSessionEvents(session);
	if (events === null) { warnNoEvents("listTurnEnds", session); return []; }
	const out = [];
	for (const ev of events) {
		if (ev?.type !== "turn/end") continue;
		out.push({
			turn: ev.data?.turn,
			seq: ev.seq,
			time: ev.time,
			reason: turnEndReason(ev),
			event: ev
		});
	}
	return out;
}

/** 日志中最后一个 turn/end (含 interrupted), 无则 null */
export function lastTurnEnd(session) {
	const all = listTurnEnds(session);
	return all.length ? all[all.length - 1] : null;
}

/**
 * 回合耗时 (ms): 从本回合 turn/start 到 turn/end 的事件时间戳差值。
 * 中断回合没有实时计时, 用事件时间算 (repair 注入的 turn/end.time 复用最后
 * 真实事件的 time, 所以耗时 ≈ 实际存活时长)。找不到 turn/start 返回 null。
 */
export function turnElapsedMs(session, end) {
	const events = readSessionEvents(session);
	if (events === null) { warnNoEvents("turnElapsedMs", session); return null; }
	const seq = end?.seq;
	if (typeof seq !== "number") return null;
	let startTime = null;
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.seq >= seq) continue; // 跳过本回合 end 及其后的修复事件
		if (ev.type === "turn/start" && ev.data?.turn === end.turn) { startTime = ev.time; break; }
		if (ev.type === "turn/end") break; // 遇到上一回合的 end → 本回合无 start (异常日志)
	}
	if (startTime === null || typeof end.time !== "number") return null;
	return Math.max(0, end.time - startTime);
}

/**
 * 挂载对账调度: session/created (新建/恢复) + 启动延迟扫描在线会话。
 * 每会话每进程只对账一次 (Set 去重) + 并发保护。
 *
 * @param ctx cordis ctx
 * @param opts
 *   - shouldReconcile(session): boolean|Promise<boolean> — 是否需要补做
 *   - reconcile(session): Promise<void> — 补做 (必须幂等)
 *   - bootScanMs 默认 2000 — apply 后延迟扫描 ctx.sessions.list() 的毫秒数
 *   - name 日志前缀 (默认 "reconcile")
 */
export function attachReconcile(ctx, opts) {
	// 2026-09-10: 注入降级告警通道 (导出函数在 apply 之外, 无 ctx)
	try { logWarn = (m) => ctx.logger?.warn?.(m); } catch { /* ignore */ }
	const { shouldReconcile, reconcile, bootScanMs = 2000, name = "reconcile" } = opts ?? {};
	if (typeof shouldReconcile !== "function" || typeof reconcile !== "function") {
		throw new Error(`dsh-reconcile(${name}): attachReconcile 需要 shouldReconcile 与 reconcile 函数`);
	}
	const done = new Set();    // 本进程已对账过的会话 id
	const pending = new Set(); // 正在对账的会话 id (防并发)

	async function run(session) {
		if (!session?.id || done.has(session.id) || pending.has(session.id)) return;
		done.add(session.id); // 先占位: 本进程不再重复触发 (对账失败下个进程自然重试)
		pending.add(session.id);
		try {
			let need = false;
			try {
				need = await shouldReconcile(session);
			} catch (e) {
				ctx.logger?.warn?.(`dsh-reconcile(${name}): shouldReconcile 异常: ${String(e?.message ?? e)}`);
			}
			if (!need) return;
			await reconcile(session);
			ctx.logger?.info?.(`dsh-reconcile(${name}): 会话 ${String(session.id).slice(0, 12)} 对账完成`);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-reconcile(${name}): 会话 ${String(session.id).slice(0, 12)} 对账失败: ${String(e?.message ?? e)}`);
		} finally {
			pending.delete(session.id);
		}
	}

	// 新建/恢复会话都会触发 session/created (恢复时事件日志已含修复 closers)。
	// {global:true}: 与 dsh-compaction 对 session/created 的注册同法, 保证
	// 任意作用域 (agent 子 ctx 等) 派发的 created 事件本插件都能收到。
	ctx.on("session/created", (session) => {
		// 延迟到 created 派发之外, 避免在 announce 派发过程中做异步工作
		setTimeout(() => { void run(session); }, 0);
	}, { global: true });

	// 启动兜底扫描: apply 时已在线、之后不再触发 created 的会话
	setTimeout(() => {
		try {
			const sessions = ctx.sessions?.list?.() ?? ctx.get?.("sessions")?.list?.() ?? [];
			for (const s of sessions) void run(s);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-reconcile(${name}): 启动扫描异常: ${String(e?.message ?? e)}`);
		}
	}, bootScanMs);

	return { run }; // 供测试/手动触发
}
