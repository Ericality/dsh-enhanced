// @deepseek-ai/dsh-cost-tree v0.1.0 — 会话树用量聚合纯库 (零依赖, 只读不写)
// ============================================================
// 设计: docs/任务记录/2026-09-05-cost多agent费用聚合-设计方案.md §2
// 职责 (铁律 §1.4):
//   - 只做 "血缘索引 + projcache tokenUsage 四类 totals 按会话树求和";
//   - 不做计价 / tier / 高峰低谷 (各消费插件用自己的 resolvePrices/costOf);
//   - 不写任何文件 (索引仅内存 TTL 缓存); 不注册钩子/命令/RPC/事件 (仿 dsh-reconcile 纯库);
//   - 任何单点失败 catch 后跳过该项, 不 throw 至调用方 (返回 null / missing 清单)。
// 血缘: 子会话 JSONL 首帧 header.parentSession (宿主 dsh-subagent childSessionMeta 唯一落点)。
// A1 (2026-09-14 阶段6): 会话日志**文件名版本化** (1.2 `session.jsonl[.zstd]` v0 /
//   1.5 `session.v3.jsonl[.zstd]`) ⇒ 按目录枚举取最高版本 (latestSessionLog), 不写死文件名。
// 聚合源: $DSH_HOME/storages/session_projcache.json tables.sessions[<sid>].rows.tokenUsage.val.totals
//   (调研报告 §1.1: 每个 LLM API 调用只记入调用方所在会话行 → 父子互斥、无重复源)。
// fork-seed 双计防御: 本库只读 projcache totals (继承行不产生新 API 调用, 口径安全);
//   若未来启用带 seed 的 fork provider 仍安全 — 见调研报告 §3.8/§6.5。
// 消费方接入样板: await import() + try/catch, 缺失 → 降级单会话口径 (见设计 §0.2 复用策略 B)。
// ============================================================
import {
	readdirSync,
	readFileSync,
	openSync,
	readSync,
	closeSync,
	fstatSync,
	createReadStream,
	statSync
} from "node:fs";
import { zstdDecompressSync, createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

export const DEFAULTS = {
	/** 与 dsh-sessions-cost L54 同硬编码模式 */
	sessionsRoot: process.env.DSH_SESSIONS_DIR || join(DSH_HOME, "sessions"),
	/** 与 dsh-balance 同 */
	projcacheFile: process.env.DSH_PROJCACHE_FILE || join(DSH_HOME, "storages", "session_projcache.json"),
	/** 树索引内存缓存 TTL (血缘只在子会话创建时刻变化, 15s 足够, §2.4) */
	ttlMs: 15000
};

/** 首帧读取前缀步长 (header 单行 <4KB, 64KB 有界读足够, §2.3) */
const PREFIX_STEP = 64 * 1024;
/** 首帧读取前缀上限 (防御性, header 不可能这么大) */
const PREFIX_CAP = 4 * 1024 * 1024;

// ---------------- 内部: 会话日志版本选择 (A1) + 只读首帧 header ----------------

/**
 * 会话日志落盘名的**格式版本选择** (A1 / 2026-09-14 阶段 6 宿主 1.5 适配)。
 *
 * 契约 §3.2 盲区②: 会话日志文件名**版本化** —— 1.2 = `session.jsonl[.zstd]` (格式 v0),
 * 1.5 = `session.v3.jsonl[.zstd]` (`SESSION_FORMAT_VERSION` 0→3)。旧实现写死
 * `session.jsonl.zstd` ⇒ 宿主升 1.5 后**静默归零** (血缘索引空, 且无任何报错)。
 * 规则:
 *   - `session.jsonl[.zstd]` ⇒ v0; `session.v<N>.jsonl[.zstd]` ⇒ 版本 N;
 *   - 取目录内**版本号最大**者; **v0 与 v3 并存时只取 v3, 绝不叠加/合并** ——
 *     迁移期同目录双名是常态, 两个都读 = 同一会话双计;
 *   - 同版本不同压缩后缀 (`.jsonl` vs `.jsonl.zstd`) 时**优先 `.zstd`** (生产用 zstd,
 *     明文多为残留) ⇒ 结果与 readdir 顺序无关;
 *   - 无任何会话日志 / 目录不可读 ⇒ null (保持原有静默语义: 调用方跳过该项, 不 throw 不告警)。
 * @param {string} dir 单个会话目录 (`<sessionsRoot>/<projectKey>/<sid>/`)
 * @returns {string|null} 会话日志绝对路径
 */
function latestSessionLog(dir) {
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return null; // 目录不存在 / 不可读 → 静默跳过
	}
	let best = null;
	let bestV = -1;
	let bestZstd = false;
	for (const name of names) {
		const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
		if (!m) continue;
		const v = m[1] === undefined ? 0 : Number(m[1]);
		const zstd = m[2] !== undefined;
		if (v > bestV || (v === bestV && zstd && !bestZstd)) {
			bestV = v;
			bestZstd = zstd;
			best = `${dir}/${name}`;
		}
	}
	return best;
}

/**
 * 读会话日志 JSONL 首帧 header 并 JSON.parse (只读第一帧, 不整文件读入)。
 * 帧格式: 多 zstd 帧拼接, 首帧恰好是一行 header (速查 §1.4 读取器硬约束);
 * node:zlib zstdDecompressSync 只解第一帧、尾部多余字节忽略。
 * 未压缩日志 (`*.jsonl`, 宿主 compression=off) ⇒ 首行明文即 header (A1 一并支持)。
 * 有界 IO: 64KB 前缀 → 失败(截断帧)则倍增重试, 上限 PREFIX_CAP。
 * 文件不存在 / 空文件 / 全部尝试失败 → null (跳过, 不 throw)。
 * @param {string} file 会话日志绝对路径 (xxx/session[.v<N>].jsonl[.zstd])
 * @returns {object|null} header 对象
 */
export function readFirstHeaderLine(file) {
	let fd = null;
	try {
		fd = openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		if (!Number.isFinite(size) || size <= 0) return null;
		if (!file.endsWith(".zstd")) {
			// 未压缩日志 (A1): 首行明文即 header, 无需 zstd 解压 (无帧 → 不倍增重试)
			const buf = Buffer.alloc(Math.min(PREFIX_STEP, size));
			const n = readSync(fd, buf, 0, buf.length, 0);
			if (n <= 0) return null;
			const text = buf.subarray(0, n).toString("utf8");
			const nl = text.indexOf("\n");
			const line = (nl < 0 ? text : text.slice(0, nl)).trim();
			if (!line) return null;
			try {
				const h = JSON.parse(line);
				return h && typeof h === "object" ? h : null;
			} catch {
				return null;
			}
		}
		let want = Math.min(PREFIX_STEP, size);
		const cap = Math.min(size, PREFIX_CAP);
		while (want <= cap) {
			const buf = Buffer.alloc(want);
			const n = readSync(fd, buf, 0, want, 0);
			if (n <= 0) return null;
			const chunk = buf.subarray(0, n);
			try {
				const text = zstdDecompressSync(chunk).toString("utf8");
				const nl = text.indexOf("\n");
				const line = (nl < 0 ? text : text.slice(0, nl)).trim();
				if (!line) return null;
				const h = JSON.parse(line);
				if (h && typeof h === "object") return h;
				return null;
			} catch {
				// 首帧被截断 (want 未覆盖帧 1) → 倍增重试; 尾部截断不影响 (zstd 只解帧 1)
				want *= 2;
			}
		}
		return null;
	} finally {
		try { closeSync(fd); } catch { /* noop */ }
	}
}

/**
 * ★ A85：**流式**读首帧 header（读到第一个换行就停）—— 旧实现对 64KB→4MB 前缀反复 `zstdDecompressSync`，
 * 大帧会话会把同一帧解压多次（实测 700 会话 19.2s、多数还返回 null）。流式读到首行即销毁，单文件约 1ms。
 * `readFirstHeaderLine` 导出面保留不动，树索引改用本函数。
 */
async function readHeaderViaStream(file) {
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (v) => {
			if (settled) return;
			settled = true;
			try { rs.destroy(); } catch { /* noop */ }
			try { dec.destroy(); } catch { /* noop */ }
			clearTimeout(timer);
			resolve(v);
		};
		const rs = createReadStream(file, { highWaterMark: 64 * 1024 });
		const dec = createZstdDecompress();
		const timer = setTimeout(() => finish(null), 3000);
		timer?.unref?.();
		let text = "";
		rs.on("error", () => finish(null));
		dec.on("error", () => finish(null));
		dec.on("data", (chunk) => {
			try {
				text += chunk.toString("utf8");
				const nl = text.indexOf("\n");
				if (nl >= 0) {
					const line = text.slice(0, nl).trim();
					let h = null;
					try { h = JSON.parse(line); } catch { h = null; }
					finish(h && typeof h === "object" ? h : null);
				} else if (text.length > 256 * 1024) finish(null);
			} catch { finish(null); }
		});
		rs.pipe(dec);
	});
}

/** 每文件 header 缓存（键 = 绝对路径；值 = { size, mtimeMs, header }）。首帧 header 不变 ⇒ 命中即免 IO。 */
const headerCache = new Map();

async function headerOf(file) {
	try {
		const st = statSync(file);
		const c = headerCache.get(file);
		if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.header;
		const header = await readHeaderViaStream(file);
		headerCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, header });
		return header;
	} catch { return null; }
}

// ---------------- 内部: 树索引 ----------------

/** 模块级 TTL 缓存: { index, root, edgeMode, builtAt } */
let _indexCache = null;

/**
 * 扫 sessionsRoot 下全部 workspace 目录 → 每会话目录读 JSONL 首帧 header
 * → { byId: Map<sid, {parentSession?, origin?, delegationDepth?}>, builtAt }
 * 缓存: 距 builtAt < ttlMs 且 sessionsRoot/edgeMode 未变 → 直接返回同一对象;
 * opts.force=true 强制重建。
 * @param {{sessionsRoot?: string, projcacheFile?: string, ttlMs?: number, force?: boolean, edgeMode?: string}} opts
 */
export async function readTreeIndex(opts = {}) {
	const root = opts.sessionsRoot ?? DEFAULTS.sessionsRoot;
	const ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
	const edgeMode = opts.edgeMode ?? "subagent";
	if (
		!opts.force &&
		_indexCache &&
		_indexCache.root === root &&
		_indexCache.edgeMode === edgeMode &&
		Date.now() - _indexCache.builtAt < ttlMs
	) {
		return _indexCache.index;
	}
	const byId = new Map();
	let wsDirs = [];
	try {
		wsDirs = readdirSync(root, { withFileTypes: true });
	} catch {
		// root 不存在/不可读 → 空索引 (不 throw)
	}
	for (const ws of wsDirs) {
		if (!ws.isDirectory() || ws.name.startsWith(".")) continue;
		const wsPath = `${root}/${ws.name}`;
		let entries = [];
		try {
			entries = readdirSync(wsPath, { withFileTypes: true });
		} catch {
			continue; // 单个 workspace 不可读 → 跳过
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			// A1 (2026-09-14): 会话日志名版本化 (`session[.v<N>].jsonl[.zstd]`) ⇒
			// 枚举目录内日志取**最高格式版本** (v0 与 v3 并存只取 v3, 不叠加)。
			const file = latestSessionLog(`${wsPath}/${e.name}`);
			if (!file) continue; // 非会话目录 (如配置/临时目录) / 无日志 → 跳过
			const h = await headerOf(file);
			if (!h) continue; // header 缺失/坏 → 跳过该会话 (容错 §2.5)
			const sid = typeof h.id === "string" && h.id ? h.id : e.name;
			byId.set(sid, {
				parentSession: typeof h.parentSession === "string" && h.parentSession ? h.parentSession : undefined,
				origin: h.origin,
				delegationDepth: h.delegationDepth
			});
		}
	}
	const index = { byId, builtAt: Date.now() };
	_indexCache = { index, root, edgeMode, builtAt: index.builtAt };
	return index;
}

// ---------------- 内部: 子树闭包 ----------------

/**
 * 子树 id 闭包 (含自身, 递归; visited 防环; 深度不限) → [sid, ...desc]
 * 边语义: 默认只跟随 origin==="subagent" 的委托边 (fork 续接会话 session.fork 写
 * parentSession 但无 origin, 属"会话延续"而非多 agent 委托, 不计入子树 —
 * 防 fork 链把"延续会话"误并进父费用); opts.edgeMode="all" 时跟随任意 parentSession 边。
 * sid 不在索引内 (孤儿/新建未落 header) → 仅自身 (不阻断, §2.5)。
 * @param {string} sid
 * @param {{sessionsRoot?: string, ttlMs?: number, force?: boolean, edgeMode?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function subtreeIds(sid, opts = {}) {
	const index = await readTreeIndex(opts);
	const edgeMode = opts.edgeMode ?? "subagent";
	const childrenOf = new Map();
	for (const [csid, rec] of index.byId) {
		if (!rec?.parentSession) continue;
		if (edgeMode === "subagent" && rec.origin !== "subagent") continue;
		const arr = childrenOf.get(rec.parentSession) ?? [];
		arr.push(csid);
		childrenOf.set(rec.parentSession, arr);
	}
	const out = [];
	const visited = new Set();
	const stack = [sid];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (visited.has(cur)) continue; // 防环
		visited.add(cur);
		out.push(cur);
		const kids = childrenOf.get(cur);
		if (kids) for (const k of kids) stack.push(k);
	}
	return out;
}

// ---------------- 内部: projcache 读取 ----------------

const TOTAL_KEYS = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];

/**
 * 读单会话 projcache 行四类 totals (兼容 .val.totals 与 .totals 两种结构)。
 * @returns {{uncachedInputTokens:number, cacheReadTokens:number, cacheWriteTokens:number, outputTokens:number}|null}
 */
export function projcacheTotalsOf(row) {
	if (!row) return null;
	const t =
		row?.rows?.tokenUsage?.val?.totals ??
		row?.rows?.tokenUsage?.totals ??
		null;
	if (!t || typeof t !== "object") return null;
	const out = {};
	for (const k of TOTAL_KEYS) out[k] = typeof t[k] === "number" ? t[k] : 0;
	return out;
}

function sumTotals(target, src) {
	for (const k of TOTAL_KEYS) target[k] = (target[k] ?? 0) + (src?.[k] ?? 0);
}

/** 读 projcache 文件 → tables.sessions (失败返回 null, 不 throw) */
export function readProjcacheSessions(projcacheFile = DEFAULTS.projcacheFile) {
	// 2026-09-10 (0.1.2 适配): 投影缓存改为每会话分片 <root>/session_projcache/sessions/<sid>.json,
	// 单体 projcacheFile 不再更新 → 分片优先, 单体表只补历史; 全部不可读仍返回 null (不变式保持)。
	const out = {};
	let any = false;
	const shardDir = `${String(projcacheFile).replace(/\.json$/, "")}/sessions`;
	try {
		for (const n of readdirSync(shardDir)) {
			if (!n.endsWith(".json")) continue;
			try {
				const d = JSON.parse(readFileSync(`${shardDir}/${n}`, "utf8"));
				if (d?.record?.rows) { out[n.slice(0, -5)] = d.record; any = true; }
			} catch { /* 坏分片跳过 */ }
		}
	} catch { /* 无分片目录 */ }
	try {
		const raw = JSON.parse(readFileSync(projcacheFile, "utf8"));
		for (const [sid, v] of Object.entries(raw?.tables?.sessions ?? {})) if (!out[sid]) { out[sid] = v; any = true; }
	} catch { /* ignore */ }
	return any ? out : null;
}

/**
 * 子会话展示 label: subagent identity.label → title 回退 → 短 sid 回退
 * (projcache rows.subagent.val.identity.label / rows.title.val, 设计 §2.2)
 */
export function childLabel(row, sid) {
	const label =
		row?.rows?.subagent?.val?.identity?.label ??
		row?.rows?.subagent?.identity?.label;
	if (typeof label === "string" && label) return label;
	const title = row?.rows?.title?.val ?? row?.rows?.title;
	if (typeof title === "string" && title) return title;
	const short = sid.startsWith("session-") ? sid.slice("session-".length) : sid;
	return short.slice(0, 12);
}

// ---------------- 公开 API ----------------

/**
 * 子树四类用量聚合 (含自身): subtreeIds 逐会话 projcache totals 求和。
 * → { totals:{四类}, ids:[...], children:[{sid,totals,label,origin}],
 *     ownTotals|null, missing:[sid...] }
 * - totals: 自身 + 全部后代 (含自身行; 无 projcache 行的后代记 0 并入 missing, totals 不受污染);
 * - children: 后代中 projcache 有行的 (缺行者入 missing, §2.6 测试 4);
 * - ownTotals: 自身行 totals; 无 → null;
 * - projcache 文件整体不可读 → null (消费方降级, 不 throw)。
 * @param {string} sid
 * @param {{sessionsRoot?: string, projcacheFile?: string, ttlMs?: number, force?: boolean, edgeMode?: string}} opts
 * @returns {Promise<object|null>}
 */
export async function subtreeTotalsFromProjcache(sid, opts = {}) {
	const index = await readTreeIndex(opts);
	const sessions = readProjcacheSessions(opts.projcacheFile ?? DEFAULTS.projcacheFile);
	if (!sessions) return null;
	const ids = await subtreeIds(sid, { ...opts, index: undefined });
	const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const children = [];
	const missing = [];
	let ownTotals = null;
	for (const id of ids) {
		const row = sessions[id];
		const t = projcacheTotalsOf(row);
		if (!t) {
			missing.push(id); // 无 projcache 行 (孤儿/新建) → totals 记 0, 不污染, §2.5
			continue;
		}
		if (id === sid) ownTotals = { ...t };
		sumTotals(totals, t);
		if (id !== sid) {
			children.push({
				sid: id,
				totals: { ...t },
				label: childLabel(row, id),
				origin: index.byId.get(id)?.origin
			});
		}
	}
	return { totals, ids, children, ownTotals, missing };
}

/**
 * 单会话 projcache 元信息 (cwd/title/subagent label + 树边身份) → 对象; 无行 → null。
 * @param {string} sid
 * @param {{sessionsRoot?: string, projcacheFile?: string, ttlMs?: number, force?: boolean, edgeMode?: string}} opts
 * @returns {Promise<object|null>}
 */
export async function sessionMeta(sid, opts = {}) {
	const sessions = readProjcacheSessions(opts.projcacheFile ?? DEFAULTS.projcacheFile);
	if (!sessions) return null;
	const row = sessions[sid];
	if (!row) return null;
	const index = await readTreeIndex(opts);
	const edge = index.byId.get(sid);
	return {
		sid,
		cwd: row?.identity?.cwd,
		title: row?.rows?.title?.val ?? row?.rows?.title,
		label: childLabel(row, sid),
		parentSession: edge?.parentSession,
		origin: edge?.origin,
		delegationDepth: edge?.delegationDepth
	};
}
