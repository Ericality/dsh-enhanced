/**
 * W7 历史条幅归档读取器（2026-11-12）—— **插件自有数据面的只读口**
 *
 * §g 目的与背景（要解决或预防的问题）：
 *   0.2.2 的 v0→v1 迁移链**必须**把自定义事件 `notice/banner` / `notice/banner-replace` 从会话日志里
 *   清洗掉（改名冒充已收录类型已被判死 —— `仲裁档案 A-018`）。用户令「**历史记录不能丢**」并且明写
 *   **不接受「清洗时丢弃横幅事件」的口径** ⇒ 交付形态是「**归档 ＋ 可显**」两半（`任务档案 §1.2`）。
 *   W2 已把 3520 条 / 130 会话归档到 `log/0.2.2升级/archive/`；**本模块是该归档的唯一读取口**：
 *   它把「某会话的历史条幅事件」按 `turn` 分组吐给 `notice/history` 端点（`lib/index.js`），
 *   再由客户端按轮渲染到 `conversation.chat.turnTail` 槽（`lib/client.js`）。
 *   没有本模块时，归档只是死文件 —— 「可显」这半条用户诉求落不了地，W6 runbook 也无消费方凭证。
 *
 * 边界（写死，改需先问用户）：
 *   · **只读**：不改归档、不写任何文件、不碰宿主数据（`ENV §一.7③` 中间件不持业务数据）。
 *   · **永不 throw 到宿主**：任何异常 ⇒ 结构化 `{ok:false, degraded:true, reason}`。
 *   · **降级必须可见**：归档不可读 ≠ 无归档（前者 `degraded:true`，后者 `ok:true, hasArchive:false`），
 *     客户端据此分别渲染「归档不可用」与「无归档」两类提示（`ENV §一.6②` 禁「报 OK 而功能坏」）。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 响应 schema 版本（键集变更须 +1，客户端与载荷对撞按它判代） */
export const HISTORY_SCHEMA_VERSION = 1;

/** 默认归档目录（生产/VM 场的插件自有数据目录；W7 只读副本落此） */
export const DEFAULT_ARCHIVE_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "plugin-data", "notice-banner", "notice-history");

/** 归档解析缓存（键 = 两文件的 size+mtime；归档是只读基线，命中即可复用） */
let cache = { key: "", archive: null };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** 指纹：`index.json` / `events.jsonl` 的 size+mtime（缺一则记 `missing`，交给读路径如实降级） */
function fingerprint(dir) {
	const parts = [];
	for (const f of ["index.json", "events.jsonl"]) {
		try {
			const st = statSync(join(dir, f));
			parts.push(`${f}:${st.size}:${st.mtimeMs}`);
		} catch {
			parts.push(`${f}:missing`);
		}
	}
	return parts.join("|");
}

/**
 * 目录解析优先级：显式配置 > 环境变量 `DSH_NOTICE_HISTORY_DIR` > 默认目录。
 * （VM 场与生产都不用配；环境变量只服务测试与 A/B。）
 */
export function resolveArchiveDir(configured) {
	const v = typeof configured === "string" ? configured.trim() : "";
	if (v) return v;
	const env = typeof process !== "undefined" && process.env ? process.env.DSH_NOTICE_HISTORY_DIR : "";
	const e = typeof env === "string" ? env.trim() : "";
	return e || DEFAULT_ARCHIVE_DIR;
}

/**
 * 读归档并建索引（只读、幂等、带缓存）。
 * 返回 `{ready, dir, schemaVersion, indexSha256, builtAt, totalEvents, totalSessions, withTurn, nullTurn, bySid, eventCount}`；
 * 读失败 ⇒ throw（由 `historyFor` 归一为 `degraded` 响应 —— 这里 throw 是因为调用点唯一且必须区分「不可读」与「无归档」）。
 */
function readArchive(dir) {
	const key = fingerprint(dir);
	if (cache.archive && cache.key === key) return cache.archive;
	const indexRaw = readFileSync(join(dir, "index.json"), "utf8");
	const index = JSON.parse(indexRaw);
	const eventsRaw = readFileSync(join(dir, "events.jsonl"), "utf8");
	const bySid = new Map();
	let eventCount = 0;
	let nullTurn = 0;
	for (const line of eventsRaw.split("\n")) {
		if (!line) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue; // 坏行跳过但计数会与 index 不符 ⇒ 由 totals 暴露（不静默：archive.eventCount vs index.totalEvents）
		}
		eventCount += 1;
		if (e && e.turn === null) nullTurn += 1;
		const sid = e && typeof e.sid === "string" ? e.sid : "";
		if (!sid) continue;
		let arr = bySid.get(sid);
		if (!arr) {
			arr = [];
			bySid.set(sid, arr);
		}
		arr.push(e);
	}
	for (const arr of bySid.values()) arr.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
	// 索引内的会话集合：`hasArchive` 的判据是「**该会话被归档器收录**」，与「本次读到几条」分开
	//   （否则「会话不在索引里」会被误报成 hasArchive:true + count:0 ⇒ 客户端静默空白，正是 P4 负控要抓的假绿）
	const sids = new Set();
	if (Array.isArray(index.sessions)) for (const s of index.sessions) if (s && typeof s.sid === "string") sids.add(s.sid);
	const archive = {
		ready: true,
		dir,
		schemaVersion: Number(index.schemaVersion) || 1,
		indexSha256: sha256(indexRaw),
		builtAt: new Date().toISOString(),
		totalEvents: Number(index.totalEvents) || eventCount,
		totalSessions: Number(index.totalSessions) || bySid.size,
		withTurn: eventCount - nullTurn,
		nullTurn,
		eventCount,
		bySid,
		sids
	};
	cache = { key, archive };
	return archive;
}

/** 单条归档事件的**下发投影**：身份（seq/turn）+ 展示面（data 原样保留 = 「可显」不失真） */
function projectEvent(e) {
	return {
		seq: Number(e.seq) || 0,
		type: String(e.type || ""),
		turn: e.turn === null || e.turn === undefined ? null : Number(e.turn),
		turnFrom: e.turnFrom === undefined ? null : e.turnFrom,
		afterTurnEnd: e.afterTurnEnd === undefined ? null : e.afterTurnEnd,
		time: Number(e.time) || 0,
		data: e && typeof e.data === "object" && e.data !== null ? e.data : {}
	};
}

/**
 * 端点主函数：`historyFor(dir, sid)` ⇒ 响应对象（键集见 `计划.md §4.2`）。
 * 三态：① `ok:true, hasArchive:true` ② `ok:true, hasArchive:false`（会话不在索引内 = 「无归档」）③ `ok:false, degraded:true`（归档不可读）。
 */
export function historyFor(archiveDir, sid) {
	const dir = resolveArchiveDir(archiveDir);
	const sidOk = typeof sid === "string" && /^session-[0-9a-z-]{8,}$/i.test(sid) ? sid : null;
	const base = {
		ok: false,
		sid: sidOk,
		schemaVersion: HISTORY_SCHEMA_VERSION,
		hasArchive: false,
		count: 0,
		groups: [],
		archive: { ready: false, dir, indexSha256: "", builtAt: null, totalSessions: 0, totalEvents: 0 },
		totals: { allSessions: 0, allEvents: 0, withTurn: 0, nullTurn: 0 },
		degraded: true,
		reason: ""
	};
	if (sidOk === null) return { ...base, degraded: false, reason: "bad-request" };
	let a;
	try {
		a = readArchive(dir);
	} catch (err) {
		return { ...base, reason: `history-archive-unavailable:${String(err?.message ?? err).slice(0, 160)}` };
	}
	const events = a.bySid.get(sidOk) || [];
	const archivedSid = a.sids.has(sidOk) || events.length > 0;
	// 分组：数值回合升序，`turn === null` 单独一组且恒排**最后**（「无回合落点」组，P3② 要求它可见且不并入任何回合）
	const byTurn = new Map();
	const nulls = [];
	for (const e of events) {
		if (e.turn === null || e.turn === undefined) {
			nulls.push(projectEvent(e));
			continue;
		}
		const t = Number(e.turn);
		let g = byTurn.get(t);
		if (!g) {
			g = [];
			byTurn.set(t, g);
		}
		g.push(projectEvent(e));
	}
	const groups = [];
	for (const t of Array.from(byTurn.keys()).sort((x, y) => x - y)) {
		const evs = byTurn.get(t);
		groups.push({ turn: t, count: evs.length, events: evs });
	}
	if (nulls.length) groups.push({ turn: null, count: nulls.length, events: nulls });
	return {
		ok: true,
		sid: sidOk,
		schemaVersion: HISTORY_SCHEMA_VERSION,
		hasArchive: archivedSid,
		count: events.length,
		groups,
		archive: {
			ready: true,
			dir: a.dir,
			indexSha256: a.indexSha256,
			builtAt: a.builtAt,
			totalSessions: a.totalSessions,
			totalEvents: a.totalEvents
		},
		totals: { allSessions: a.totalSessions, allEvents: a.totalEvents, withTurn: a.withTurn, nullTurn: a.nullTurn },
		degraded: false,
		reason: ""
	};
}

/** 供探针/自检用：只回全库口径（不拖单会话明细）；失败同样归一为 degraded */
export function archiveSummary(archiveDir) {
	const dir = resolveArchiveDir(archiveDir);
	try {
		const a = readArchive(dir);
		return {
			ok: true,
			degraded: false,
			dir: a.dir,
			schemaVersion: a.schemaVersion,
			indexSha256: a.indexSha256,
			builtAt: a.builtAt,
			totals: { allSessions: a.totalSessions, allEvents: a.totalEvents, withTurn: a.withTurn, nullTurn: a.nullTurn, eventsJsonlCount: a.eventCount }
		};
	} catch (err) {
		return { ok: false, degraded: true, reason: `history-archive-unavailable:${String(err?.message ?? err).slice(0, 160)}`, dir };
	}
}
