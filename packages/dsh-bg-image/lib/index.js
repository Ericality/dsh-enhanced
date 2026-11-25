import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { DATA_DIR, DEFAULT_WALLPAPER_ROOT, LEGACY_CONFIG_FILE, mountWallpaper } from "./wallpaper.js";

/**
 * @ericality/dsh-bg-image —— 页面背景壁纸插件（web）。
 *
 * v8.0.0：合并原 dsh-bing-wallpaper 的服务端壁纸能力，四个模式共用一套端点与一份配置：
 *   每日（Bing 直连，可换成自建源）／文件夹随机（every、daily、interval 三策略）／自定义图片。
 * 七个同源端点在 /api/wallpaper/* 下，见 lib/wallpaper.js。
 *
 * 配置走宿主官方 Config（volatile 字段）：插件页保存即生效，不再读写自建设置 RPC。
 * 首次启动会把旧 bg-image-settings.json 与 bing-wallpaper-config.json 合并迁移到新配置，
 * 旧文件改名 .bak 留档。
 */
export const name = "dsh-bg-image";
export const inject = ["connection"];

/** 数据目录：$DSH_HOME/plugin-data/bg-image（可用 DSH_DATA_DIR 覆盖）。 */
export const dataDir = () => process.env.DSH_DATA_DIR || DATA_DIR;

/** 官方 Config：全部为可在线保存的 volatile 字段。 */
export const Config = z.object({
	mode: z.union(["daily", "folder", "custom"]).default("daily").volatile(),
	strategy: z.union(["every", "daily", "interval"]).default("every").volatile(),
	intervalMin: z.number().default(30).volatile(),
	image: z.string().default("").volatile(),
	debugPath: z.boolean().default(false).volatile(),
	look: z.object({
		// 8.0.1：单位与 client 消费口径对齐（0-100 百分比 / px）。8.0.0 的 0.45/0.6 是比例口径，
		// 经 client 的 Math.max(50, ...) 夹取与 0=跟随面板语义后会得到错误观感（侧栏近透明、无磨砂）。
		opacity: z.number().default(78),
		blur: z.number().default(14),
		surfaceBlur: z.number().default(18),
		// 0 = 跟随「面板不透明度」（client sidebarRaw>0 才单独生效）
		sidebarOpacity: z.number().default(0)
	}).volatile(),
	folder: z.object({
		root: z.string().default(""),
		path: z.string().default(""),
		recursive: z.boolean().default(true),
		allowedExts: z.array(z.string()).default([".jpg", ".jpeg", ".png", ".webp", ".gif"]),
		lockMs: z.number().default(120000)
	}).volatile(),
	daily: z.object({
		source: z.string().default(""),
		refreshTime: z.string().default("00:10"),
		cacheTtlMs: z.number().default(43200000),
		fetchTimeoutMs: z.number().default(20000)
	}).volatile()
});


/** 8.0.1：旧值归一 —— 历史配置里若出现 0-1 比例（如 0.45/0.6），按百分比 ×100；其余原样。 */
const toPercent = (v, fallback) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	if (n > 0 && n <= 1) return Math.round(n * 1000) / 10;
	return n;
};

/** 设置服务（显式解析，避免 inject 守卫）。 */
const settingsOf = (ctx) => { try { return ctx.get?.("settings", false) || null; } catch { return null; } };

/** volatile 叶子在运行态是带 get() 的引用，统一取当前值。 */
const val = (x, fallback) => {
	try { return x && typeof x.get === "function" ? x.get() : (x === undefined || x === null ? fallback : x); } catch { return fallback; }
};

/** 供壁纸模块现读的配置快照。 */
export function readConfig(config) {
	const look = val(config?.look, {}) || {};
	const folder = val(config?.folder, {}) || {};
	const daily = val(config?.daily, {}) || {};
	return {
		mode: val(config?.mode, "daily"),
		strategy: val(config?.strategy, "every"),
		intervalMin: Number(val(config?.intervalMin, 30)) || 30,
		image: val(config?.image, ""),
		debugPath: val(config?.debugPath, false) === true,
		look: { opacity: Number(look.opacity ?? 78), blur: Number(look.blur ?? 14), surfaceBlur: Number(look.surfaceBlur ?? 18), sidebarOpacity: Number(look.sidebarOpacity ?? 0) },
		folder: { root: String(folder.root ?? ""), path: String(folder.path ?? ""), recursive: folder.recursive !== false, allowedExts: Array.isArray(folder.allowedExts) ? folder.allowedExts : [".jpg", ".jpeg", ".png", ".webp", ".gif"], lockMs: Number(folder.lockMs ?? 120000) },
		daily: { source: String(daily.source ?? ""), refreshTime: String(daily.refreshTime ?? "00:10"), cacheTtlMs: Number(daily.cacheTtlMs ?? 43200000), fetchTimeoutMs: Number(daily.fetchTimeoutMs ?? 20000) }
	};
}

/** 本插件声明需要的能力（与 package.json dshCompat.seams 集合相等）。 */
const REQUIRES = ["rpcHandle"];
const SEAM_OF = { rpcHandle: "rpcHandle" };
/** 自有总线端点名：浏览器侧回传「设壁纸主通道」取用结果。 */
const SEAM_STATE_ENDPOINT = "bg-image/seam-state";
/** 端点注册退避（ms）。 */
const REGISTER_DELAYS = [0, 200, 500, 1000, 2000];
/** 运行期降级码（与客户端三处降级分支逐条对应）。 */
const DEGRADE_REASONS = ["unavailable", "bad-response", "transport"];

/** 自身元信息：版本。禁静态 import JSON，读失败回退 unknown。 */
function ownMeta() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return { version: typeof pkg?.version === "string" && pkg.version ? pkg.version : "unknown" };
	} catch { return { version: "unknown" }; }
}

/** 旧文件路径（迁移源）。 */
const legacyPaths = () => {
	const root = dataDir();
	const home = process.env.DSH_HOME || path.join(homedir(), ".dsh");
	return {
		bg: [path.join(root, "bg-image-settings.json"), path.join(home, "bg-image-settings.json")],
		bing: [LEGACY_CONFIG_FILE, path.join(home, "bing-wallpaper-config.json")],
		lists: [path.join(root, "wallpaper-lists.json"), path.join(home, "wallpaper-lists.json")]
	};
};

const readJson = (p) => {
	for (const f of p) {
		try { if (existsSync(f)) return { file: f, data: JSON.parse(readFileSync(f, "utf8")) }; } catch { /* 下一个候选 */ }
	}
	return null;
};

const backup = (file) => {
	try { if (existsSync(file) && !existsSync(`${file}.bak`)) renameSync(file, `${file}.bak`); } catch { /* 迁移备份失败不阻断 */ }
};

/** 旧配置 → 官方 Config 的迁移（只在用户层为空时执行一次）。 */
export async function migrateLegacy(ctx) {
	try {
		const mergedPath = path.join(dataDir(), "bg-image-settings.json");
		const lists = readJson(legacyPaths().lists);
		if (lists?.data && lists.file !== path.join(dataDir(), "wallpaper-lists.json")) {
			const target = path.join(dataDir(), "wallpaper-lists.json");
			try {
				mkdirSync(path.dirname(target), { recursive: true });
				if (lists.file !== target) writeFileSync(target, JSON.stringify(lists.data, null, 2), "utf8");
				backup(lists.file);
			} catch { /* 列表迁移失败只影响图片列表 */ }
		}
		let current = null;
		try { current = settingsOf(ctx)?.describe?.()?.find((row) => row.ns === "bg-image")?.user; } catch { current = null; }
		if (current && Object.keys(current).length) return false;
		// 合并记录已存在 ⇒ 迁移已完成（防止把合并文件当旧文件二次导入）。
		if (existsSync(mergedPath)) { try { const m = JSON.parse(readFileSync(mergedPath, "utf8")); if ((m?.schemaVersion ?? 0) >= 2) return false; } catch { /* 坏文件 ⇒ 继续按旧文件迁移 */ } }
		const bgRaw = readJson(legacyPaths().bg);
		const bg = bgRaw && (bgRaw.data?.schemaVersion ?? 0) >= 2 ? null : bgRaw;
		const bing = readJson(legacyPaths().bing);
		if (!bg && !bing) return false;
		const b = bg?.data ?? {}, c = bing?.data ?? {};
		const patch = {
			mode: b.mode ?? "daily",
			strategy: b.strategy ?? "every",
			intervalMin: Number(b.intervalMin) > 0 ? Number(b.intervalMin) : 30,
			image: String(b.image ?? ""),
			debugPath: b.debugPath === true,
			// 8.0.1：旧根状态只有 opacity/blur（百分比/px）。新键（surfaceBlur/sidebarOpacity）缺省时
			// **回填 client 同口径默认值**（18px / 0=跟随面板），而不是 8.0.0 的 0 / 0.6（单位错 ⇒ 遮罩关闭）。
			look: {
				opacity: toPercent(b.opacity, 78),
				blur: Number.isFinite(Number(b.blur)) ? Number(b.blur) : 14,
				surfaceBlur: Number.isFinite(Number(b.surfaceBlur)) ? Math.max(0, Math.min(40, Number(b.surfaceBlur))) : 18,
				sidebarOpacity: b.sidebarOpacity === undefined || b.sidebarOpacity === null || b.sidebarOpacity === "" ? 0 : Math.max(0, Math.min(100, toPercent(b.sidebarOpacity, 0)))
			},
			folder: {
				root: String(c.baseDir || b.baseDir || ""),
				path: String(b.folderPath || ""),
				recursive: c.recursive !== false,
				allowedExts: Array.isArray(c.allowedExts) && c.allowedExts.length ? c.allowedExts : [".jpg", ".jpeg", ".png", ".webp", ".gif"],
				lockMs: Number(c.folderLockMs) > 0 ? Number(c.folderLockMs) : (Number(b.lockSec) > 0 ? Number(b.lockSec) * 1000 : 120000)
			},
			daily: {
				source: String(c.wanBase || c.lanBase || ""),
				refreshTime: String(c.dailyRefreshTime || "00:10"),
				cacheTtlMs: Number(c.cacheTtlMs) > 0 ? Number(c.cacheTtlMs) : 43200000,
				fetchTimeoutMs: Number(c.fetchTimeoutMs) > 0 ? Number(c.fetchTimeoutMs) : 20000
			}
		};
		// 合并后的设置文件留档（schemaVersion 2），配置本身由宿主保存。
		const merged = mergedPath;
		const record = { schemaVersion: 2, migratedAt: new Date().toISOString(), ...patch };
		try {
			mkdirSync(path.dirname(merged), { recursive: true });
			if (!existsSync(merged)) writeFileSync(merged, JSON.stringify(record, null, 2), "utf8");
		} catch { /* 留档失败不阻断迁移 */ }
		try { await settingsOf(ctx)?.update("bg-image", patch); } catch (err) {
			try { ctx.logger?.warn?.(`${name}: 旧配置迁移到官方 Config 失败（保留旧文件）: ${String(err?.message ?? err)}`); } catch { /* ignore */ }
			return false;
		}
		for (const f of [bg?.file, bing?.file]) if (f) backup(f);
		return true;
	} catch (err) {
		try { ctx.logger?.warn?.(`${name}: 旧配置迁移异常（已忽略）: ${String(err?.message ?? err)}`); } catch { /* ignore */ }
		return false;
	}
}

/**
 * §4.10 兜底: host-compat 不可用/未装配时插件**自己写**状态分片 (§5 单写者: 只写自己的分片; 0600)。
 * 分片形状照 RD-15 裁定 (扁平 8 键: schema/id/version/state/missing/blocked/note/probedAt)。
 * 失败 ⇒ 只告警 (禁止静默: 至少容器日志留痕)。
 */
function writeShard(ctx, shardEntry) {
	try {
		const dir = `${process.env.DSH_COMPAT_DIR || path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "plugin-data", "host-compat")}/compat-status.d`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/${shardEntry.id}.json`, JSON.stringify({ schema: 1, ...shardEntry, probedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
	} catch (err) {
		ctx?.logger?.warn?.(`${name}: 适配状态分片写入失败 (仅内存态): ${String(err?.message ?? err)}`);
	}
}

/**
 * 经 `compatBus` 注册**本插件自有**端点 `bg-image/seam-state` (惰性重试; 退避 0/200/500/1000/2000ms)。
 * 纪律: `ctx.get("compatBus")` **字面量 + 每次惰性解析**、apply 期不缓存服务引用;
 * 注册失败 ⇒ **warnOnce 且绝不 throw**(/bg-image 主通道照常)。
 */
function registerSeamStateEndpoint(ctx, handler) {
	let attempt = 0;
	let stopped = false;
	let warned = false;
	const warnOnce = (message) => {
		if (warned) return;
		warned = true;
		try { ctx.logger?.warn?.(`${name}: ${message}`); } catch { /* 日志不可用 ⇒ 静默 */ }
	};
	const tick = () => {
		if (stopped) return;
		attempt++;
		let bus = null;
		try { bus = ctx.get("compatBus"); } catch { bus = null; } // ← 字面量形态 + 每次惰性解析
		if (bus && typeof bus.registerEndpoint === "function") {
			let res = null;
			try { res = bus.registerEndpoint(SEAM_STATE_ENDPOINT, handler); }
			catch (err) { res = { ok: false, reason: `register-threw:${String(err?.message ?? err)}` }; }
			if (res && res.ok === true) {
				stopped = true;
				try { ctx.logger?.info?.(`${name}: 已注册总线端点 ${SEAM_STATE_ENDPOINT}${res.replaced ? "（覆盖同名）" : ""}（第 ${attempt} 次尝试）`); } catch { /* 忽略 */ }
				return;
			}
			if (res && res.reason === "reserved") {
				stopped = true;
				warnOnce(`总线端点 ${SEAM_STATE_ENDPOINT} 命中保留名 ⇒ 放弃注册（配置错误，重试无意义）`);
				return;
			}
		}
		if (attempt >= REGISTER_DELAYS.length) {
			stopped = true;
			warnOnce(`总线端点 ${SEAM_STATE_ENDPOINT} 注册失败（compatBus 未提供，已重试 ${attempt} 次）⇒ 设壁纸主通道降级无法自报（面板将不反映；/bg-image 主通道照常）`);
			return;
		}
		const delay = REGISTER_DELAYS[attempt] ?? REGISTER_DELAYS[REGISTER_DELAYS.length - 1];
		try {
			const timer = setTimeout(tick, delay);
			if (timer && typeof timer.unref === "function") timer.unref();
		} catch {
			stopped = true;
			warnOnce(`定时器不可用 ⇒ 端点 ${SEAM_STATE_ENDPOINT} 不再重试`);
		}
	};
	try { tick(); } catch (err) { warnOnce(`端点注册异常（已忽略，不影响宿主）: ${String(err?.message ?? err)}`); }
}

/**
 * 插件主体。
 * @param ctx - cordis 上下文 (connection 服务经 inject 注入)。
 */
export async function apply(ctx, config) {
	// settings 服务可能在 apply 之后才就绪：等它可用再做旧配置迁移（只跑一次）。
	try {
		ctx.inject(["settings"], (child) => {
			Promise.resolve().then(() => migrateLegacy(child)).catch(() => { /* 迁移失败不阻断插件 */ });
		});
	} catch { Promise.resolve().then(() => migrateLegacy(ctx)).catch(() => {}); }
	await mountWallpaper(ctx, () => readConfig(config));

	// 设置 RPC（卡片仍经此通道逐项保存；落盘走宿主官方 Config）
	const sectionOf = (c) => {
		const cfg = readConfig(c);
		return {
			mode: cfg.mode, image: cfg.image, strategy: cfg.strategy, intervalMin: cfg.intervalMin,
			debugPath: cfg.debugPath, opacity: cfg.look.opacity, blur: cfg.look.blur,
			surfaceBlur: cfg.look.surfaceBlur, sidebarOpacity: cfg.look.sidebarOpacity,
			folderPath: cfg.folder.path, lockSec: Math.round(cfg.folder.lockMs / 1000),
			source: cfg.daily.source, refreshSec: 0,
			lanBase: "", wanBase: cfg.daily.source, baseDir: cfg.folder.root, recursive: cfg.folder.recursive,
			allowedExts: cfg.folder.allowedExts, dailyRefreshTime: cfg.daily.refreshTime,
			cacheTtlMs: cfg.daily.cacheTtlMs, fetchTimeoutMs: cfg.daily.fetchTimeoutMs, folderLockMs: cfg.folder.lockMs
		};
	};
	const patchOf = (section) => {
		if (!section || typeof section !== "object") return null;
		const patch = {};
		if (section.mode !== undefined) patch.mode = String(section.mode);
		if (section.image !== undefined) patch.image = String(section.image);
		if (section.strategy !== undefined) patch.strategy = String(section.strategy);
		if (section.intervalMin !== undefined) patch.intervalMin = Number(section.intervalMin) || 30;
		if (section.debugPath !== undefined) patch.debugPath = section.debugPath === true;
		const look = {};
		for (const [from, to] of [["opacity", "opacity"], ["blur", "blur"], ["surfaceBlur", "surfaceBlur"], ["sidebarOpacity", "sidebarOpacity"]]) {
			if (section[from] !== undefined) look[to] = Number(section[from]);
		}
		if (Object.keys(look).length) patch.look = { ...readConfig(config).look, ...look };
		const folder = {};
		if (section.folderPath !== undefined) folder.path = String(section.folderPath);
		if (section.lockSec !== undefined) folder.lockMs = Math.max(0, Number(section.lockSec) || 0) * 1000;
		if (Object.keys(folder).length) patch.folder = { ...readConfig(config).folder, ...folder };
		const daily = {};
		if (section.source !== undefined) daily.source = String(section.source);
		// 兼容旧「壁纸源」段的字段名（内外网源、缓存与超时）。
		if (section.wanBase !== undefined) daily.source = String(section.wanBase || section.lanBase || "");
		if (section.lanBase !== undefined && section.wanBase === undefined) daily.source = String(section.lanBase || "");
		if (section.dailyRefreshTime !== undefined) daily.refreshTime = String(section.dailyRefreshTime);
		if (section.cacheTtlMs !== undefined) daily.cacheTtlMs = Number(section.cacheTtlMs) || 43200000;
		if (section.fetchTimeoutMs !== undefined) daily.fetchTimeoutMs = Number(section.fetchTimeoutMs) || 20000;
		if (Object.keys(daily).length) patch.daily = { ...readConfig(config).daily, ...daily };
		const legacyFolder = {};
		if (section.baseDir !== undefined) legacyFolder.root = String(section.baseDir);
		if (section.recursive !== undefined) legacyFolder.recursive = section.recursive === true || section.recursive === "true" || section.recursive === 1 || section.recursive === "1";
		if (Array.isArray(section.allowedExts)) legacyFolder.allowedExts = section.allowedExts.map((x) => String(x).toLowerCase()).filter(Boolean);
		if (section.folderLockMs !== undefined) legacyFolder.lockMs = Number(section.folderLockMs) || 120000;
		if (Object.keys(legacyFolder).length) patch.folder = { ...readConfig(config).folder, ...legacyFolder };
		return patch;
	};
	const cfgHandler = async (endpoint, payload) => {
		try {
			const both = () => {
				const c = readConfig(config);
				const current = {
					lanBase: "", wanBase: c.daily.source, imagePath: "/today.jpg", notePath: "/note.txt",
					cacheTtlMs: c.daily.cacheTtlMs, fetchTimeoutMs: c.daily.fetchTimeoutMs, dailyRefreshTime: c.daily.refreshTime,
					baseDir: c.folder.root, allowedExts: c.folder.allowedExts, folderLockMs: c.folder.lockMs, recursive: c.folder.recursive
				};
				return { section: sectionOf(config), current, overrides: {} };
			};
			if (endpoint === "get") return { ok: true, value: both() };
			if (endpoint === "reset") return { ok: true, value: both() };
			if (endpoint === "set") {
				const patch = patchOf(payload?.section ?? payload?.patch);
				if (!patch) return { ok: false, error: { code: "bad-request", message: "缺少 section" } };
				const settings = settingsOf(ctx);
				if (!settings || typeof settings.update !== "function") return { ok: false, error: { code: "unavailable", message: "settings 服务不可用" } };
				await settings.update("bg-image", patch);
				return { ok: true, value: both() };
			}
			return { ok: false, error: { code: "bad-request", message: "未知端点 " + String(endpoint) } };
		} catch (err) {
			ctx.logger?.warn?.("dsh-bg-image: 设置 RPC " + String(endpoint) + " 失败: " + String(err?.message ?? err));
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};
	try {
		const seams = await import("@ericality/dsh-host-compat/seams");
		if (typeof seams?.channelFace === "function") {
			seams.channelFace(ctx, "bg-image", ["get", "set", "reset"], cfgHandler);
			seams.channelFace(ctx, "bing-wallpaper", ["get", "set", "reset"], cfgHandler);
		}
	} catch { /* 缺 host-compat ⇒ 设置卡显示读取失败，壁纸本体照常 */ }
	// =====================================================================================
	//  适配闸门申报 (契约 §3.1 `dshCompat` / §4.9 `probe` / §4.10 `report`; 路线 A)
	//  ① host-compat 只做**动态 import + try/catch** (§2.3/§10.1: 禁静态 import ⇒ 缺包不得崩树);
	//  ② `probe` 的 keys = `REQUIRES`，与 package.json `dshCompat.seams` **集合相等** (RD-1);
	//  ③ host-compat 不可用 ⇒ **自写分片兜底**(禁静默); ④ 运行期失败码进 `note`，**不塞 `missing[]`**(只收 §3 键)。
	// =====================================================================================
	const PLUGIN_ID = name;
	const { version: PLUGIN_VERSION } = ownMeta();
	let seams = null;
	let compat = null;
	try { seams = await import("@ericality/dsh-host-compat/seams"); }
	catch (err) { ctx.logger?.warn?.(`${PLUGIN_ID}: host-compat/seams 不可用 → 自写分片兜底 (${String(err?.message ?? err)})`); }
	try { compat = await import("@ericality/dsh-host-compat"); } catch { compat = null; }

	const seamFn = (key) => (typeof seams?.[SEAM_OF[key]] === "function" ? seams[SEAM_OF[key]] : null);
	// 能力探测: 优先 host-compat `probe()` (§4.9, 第 4 参传 ctx —— `rpcHandle` 是服务类 key, 不传 ctx 会误判缺失);
	// 不可用 ⇒ 本地按"§4 seam 是否在位"兜底(host-compat 缺席 ⇒ seam 缺席 ⇒ 如实 DEGRADED, 不当 OK)。
	const localMissing = () => REQUIRES.filter((k) => typeof seamFn(k) !== "function");
	const prober = typeof seams?.probe === "function" ? seams : (typeof compat?.probe === "function" ? compat : null);
	const reporter = typeof compat?.report === "function" ? compat : (typeof seams?.report === "function" ? seams : null);
	let capMissing = localMissing();
	let capBlocked = [];
	let capState = capMissing.length ? "DEGRADED" : "OK";
	let capNotes = "";
	if (prober) {
		try {
			const r = prober.probe(REQUIRES, PLUGIN_ID, PLUGIN_VERSION, ctx);
			if (Array.isArray(r?.missing)) capMissing = r.missing.filter((k) => REQUIRES.includes(k));
			if (Array.isArray(r?.blocked)) capBlocked = r.blocked.filter((k) => REQUIRES.includes(k));
			if (typeof r?.state === "string") capState = r.state;
			if (typeof r?.notes === "string") capNotes = r.notes;
		} catch (err) {
			capMissing = localMissing();
			capBlocked = [];
			capState = capMissing.length ? "DEGRADED" : "OK";
			capNotes = `probe() 失败 → 退回本地探测 (${String(err?.message ?? err)})`;
		}
	} else {
		capNotes = "host-compat 不可用 ⇒ 本地探测（闸门未取证）";
	}

	/** 闸门层 note (能力面) —— `missing[]` 只收 §3 键，原因文案一律人可读文本。 */
	const gateNote = capState === "OK" ? ""
		: (capMissing.length ? `缺少能力 ${capMissing.join(", ")} ⇒ 设壁纸主通道适配未就绪` : "设壁纸主通道适配闸门未取证");

	// 运行期自报态: 浏览器侧「设壁纸主通道」取用失败码（"" = 正常）
	let seamReason = "";
	/** §4.10 上报: host-compat 可用 ⇒ `report()`; 不可用 ⇒ `writeShard()`（禁静默）。永不 throw。 */
	const publish = () => {
		const state = seamReason ? "DEGRADED" : capState;
		const runtimeNote = seamReason ? `设壁纸主通道降级(${seamReason})` : "";
		const entry = {
			id: PLUGIN_ID,
			version: PLUGIN_VERSION,
			state,
			missing: capMissing,        // §5.1: 只收 §3 键（运行期失败码不进这里）
			blocked: capBlocked,        // 当前不填非空（阻断清单待用户列表审）
			note: [runtimeNote, gateNote, capNotes && state !== "OK" ? capNotes : ""].filter(Boolean).join(" ｜ ")
		};
		try {
			if (reporter) reporter.report(entry);
			else writeShard(ctx, entry);
		} catch (err) {
			try { writeShard(ctx, entry); } catch { /* 分片也失败 ⇒ 上面已告警 */ }
			ctx.logger?.warn?.(`${PLUGIN_ID}: 适配状态上报失败 (仅内存态): ${String(err?.message ?? err)}`);
		}
	};
	publish();

	/** `bg-image/seam-state` handler: `{state:"OK"}` 清空降级; `{state:"DEGRADED", reason, section}` 如实降级。
	 *  归一后经 §4.10 写自有分片（形状 = 契约 §5.1 八键）。永不 throw（异常由 `/host-compat` 包成 io-error）。 */
	const onSeamState = (payload) => {
		const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
		// 错误面如实上报（不用"豁免/静默"消化：协议误用必须留痕，否则等于把缺面藏起来）
		if (!p) {
			ctx.logger?.warn?.(`${PLUGIN_ID}: bg-image/seam-state 载荷非对象 ⇒ 已忽略 (bad-request)`);
			return { ok: false, reason: "bad-request" };
		}
		if (p.state !== "OK" && p.state !== "DEGRADED") {
			ctx.logger?.warn?.(`${PLUGIN_ID}: bg-image/seam-state 未知 state=${String(p.state)} ⇒ 已忽略 (bad-request:state)`);
			return { ok: false, reason: "bad-request:state" };
		}
		if (p.state === "OK") {
			seamReason = "";
		} else if (DEGRADE_REASONS.includes(p.reason)) {
			seamReason = p.reason;
		} else {
			seamReason = "unknown";
			ctx.logger?.warn?.(`${PLUGIN_ID}: bg-image/seam-state 未知降级码 ${String(p.reason)} ⇒ 按 unknown 如实上报`);
		}
		publish();
		return { ok: true, state: seamReason ? "DEGRADED" : "OK", reason: seamReason || null };
	};

	// 自有端点注册 (惰性退避; 失败只 warnOnce —— /bg-image 主通道与已有可见面零影响)
	registerSeamStateEndpoint(ctx, onSeamState);
}
