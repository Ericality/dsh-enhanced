import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * dsh-bg-image 服务端壁纸模块（v8.0.0 合并 dsh-bing-wallpaper）。
 *
 * 提供七个同源端点（统一挂在 /api/wallpaper/ 下）：
 *   GET /api/wallpaper/daily         当日壁纸图片（Bing 直连，或 daily.source 指定的自建源）
 *   GET /api/wallpaper/daily-meta    当日壁纸介绍 JSON
 *   GET /api/wallpaper/folder        文件夹随机壁纸（every / daily / interval 三策略）
 *   GET /api/wallpaper/folder-meta   当前文件夹壁纸介绍
 *   GET /api/wallpaper/list          图片清单（设置页“图片列表”用）
 *   GET /api/wallpaper/thumb         缩略图（缺 ImageMagick 时回落原图并记一条 warn）
 *   GET /api/wallpaper/current       本页当前壁纸（按页面 token 精确返回）
 *
 * 数据落点：$DSH_HOME/plugin-data/bg-image/（缺省 ~/.dsh），含 wallpaper-lists.json 与缩略图缓存。
 * 配置由宿主官方 Config 提供，本模块每次请求现读，保存即生效。
 */
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), ".dsh");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const DATA_DIR = process.env.DSH_DATA_DIR || path.join(DSH_HOME, "plugin-data", "bg-image");
export const DEFAULT_WALLPAPER_ROOT = path.join(DATA_DIR, "wallpapers");

/** 调试日志：默认关闭，置 DSH_BG_WALLPAPER_DEBUG=1 后落 $DSH_HOME/logs/bg-image/wallpaper-debug.log。 */
const LOG_DIR = path.join(DSH_HOME, "logs", "bg-image");
const DEBUG_ENABLED = process.env.DSH_BG_WALLPAPER_DEBUG === "1";
const DEBUG_LOG = path.join(LOG_DIR, "wallpaper-debug.log");
let debugLogReady = false;
function debug(msg) {
	if (!DEBUG_ENABLED) return;
	try {
		if (!debugLogReady) {
			mkdirSync(LOG_DIR, { recursive: true });
			debugLogReady = true;
		}
		appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
	} catch { /* 日志失败绝不影响功能 */ }
}

// ═══════════════════════════════════════════════════════════════════
//  配置适配层：官方 Config（嵌套段）→ 本模块的扁平运行配置
// ═══════════════════════════════════════════════════════════════════
/** 旧版 bing-wallpaper 覆盖文件：只用于一次性迁移（迁移后改名 .bak）。 */
export const LEGACY_CONFIG_FILE = path.join(DATA_DIR, "bing-wallpaper-config.json");

/** 官方 Config → 扁平运行配置（每次请求现读，保存即生效）。 */
export function flatConfig(c) {
	const folder = c?.folder ?? {}, daily = c?.daily ?? {};
	const exts = Array.isArray(folder.allowedExts) && folder.allowedExts.length ? folder.allowedExts : [".jpg", ".jpeg", ".png", ".webp", ".gif"];
	return {
		baseDir: folder.root || DEFAULT_WALLPAPER_ROOT,
		allowedExts: exts.map((x) => String(x).toLowerCase()),
		recursive: folder.recursive !== false,
		folderLockMs: Number(folder.lockMs) > 0 ? Number(folder.lockMs) : 120000,
		dailyRefreshTime: /^\d{2}:\d{2}$/.test(String(daily.refreshTime ?? "")) ? String(daily.refreshTime) : "00:10",
		cacheTtlMs: Number(daily.cacheTtlMs) > 0 ? Number(daily.cacheTtlMs) : 43200000,
		fetchTimeoutMs: Number(daily.fetchTimeoutMs) > 0 ? Number(daily.fetchTimeoutMs) : 20000,
		dailySource: String(daily.source ?? "").trim()
	};
}

// ═══════════════════════════════════════════════════════════════════
//  图片列表状态 (v7.0.0): 黑名单 / 收藏夹 / 自定义列表
//  存储 $DSH_HOME/plugin-data/bg-image/wallpaper-lists.json（所有浏览器统一，经 RPC 读写）。
//  选图来源 source:
//    all       全随机: 壁纸库里所有图, **应用黑名单** (默认)
//    likes     只从收藏夹取 (**不受黑名单影响**)
//    list:<id> 只从某个自定义列表取 (**不受黑名单影响**)
//  列表/黑名单里的路径一律存"相对 baseDir 的路径" (如 2023/2023-04/xxx.jpg)。
// ═══════════════════════════════════════════════════════════════════
export const LISTS_FILE = path.join(DATA_DIR, "wallpaper-lists.json");
/** 单个列表最多条目 (防呆: 别把状态文件写爆) */
const LISTS_MAX_ITEMS = 20000;
/** 最多自定义列表数 */
const LISTS_MAX_NAMES = 40;
/** 本进程内列表修订号: 写列表即 +1, 进随机缓存 key ⇒ 改列表后立刻重选 */
let listsRevision = 0;
/** 列表读取缓存 (2s): 每次请求都读盘没必要, 又要能感知手改文件 */
let listsCache = null;
let listsCacheAt = 0;

/** 规范化相对路径: 反斜杠转 /, 去 ./ 与首尾 /, 拒绝绝对路径/.. /空段; 非法返回 null。 */
export function normRelPath(p) {
	if (typeof p !== "string") return null;
	let s = p.trim().replace(/\\/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	s = s.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!s || s.length > 512) return null;
	const segs = s.split("/");
	if (segs.some((seg) => seg === ".." || seg === "." || seg === "")) return null;
	return s;
}

/** 去重 + 规范化 + 截断 (容量上限), 非字符串/非法路径直接丢。 */
function uniqPaths(arr) {
	const out = [];
	const seen = new Set();
	for (const v of Array.isArray(arr) ? arr : []) {
		const p = normRelPath(v);
		if (!p || seen.has(p)) continue;
		seen.add(p);
		out.push(p);
		if (out.length >= LISTS_MAX_ITEMS) break;
	}
	return out;
}

/** 清洗列表状态 (缺字段/超量/脏路径一律丢弃, 永不 throw)。导出供单测。 */
export function sanitizeLists(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const lists = [];
	const ids = new Set();
	for (const l of Array.isArray(src.lists) ? src.lists : []) {
		if (!l || typeof l !== "object") continue;
		const id = String(l.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
		if (!id || ids.has(id)) continue;
		ids.add(id);
		lists.push({ id, name: String(l.name || "").slice(0, 40) || id, items: uniqPaths(l.items) });
		if (lists.length >= LISTS_MAX_NAMES) break;
	}
	return { version: 1, blacklist: uniqPaths(src.blacklist), likes: uniqPaths(src.likes), lists };
}

/** 读列表状态 (缺失/损坏 ⇒ 空列表)。 */
export function readLists() {
	try {
		return sanitizeLists(JSON.parse(readFileSync(LISTS_FILE, "utf8")));
	} catch {
		return sanitizeLists({});
	}
}

/** 写列表状态 (清洗后落盘) → 返回清洗结果; 写盘失败只 debug 不抛。 */
function writeLists(next) {
	const clean = sanitizeLists(next);
	try {
		mkdirSync(path.dirname(LISTS_FILE), { recursive: true });
		writeFileSync(LISTS_FILE, JSON.stringify(clean, null, 2), "utf8");
	} catch (err) {
		debug(`writeLists failed: ${String(err?.message ?? err)}`);
	}
	listsRevision += 1;
	listsCache = clean;
	listsCacheAt = Date.now();
	return clean;
}

/** 当前列表状态 (2s 缓存)。 */
function currentLists() {
	if (!listsCache || Date.now() - listsCacheAt > 2000) {
		listsCache = readLists();
		listsCacheAt = Date.now();
	}
	return listsCache;
}

/**
 * 按来源从"壁纸库现有图片"里算出候选池。
 * all = 全部 - 黑名单; likes = 收藏夹 ∩ 现有图片; list:<id> = 该列表 ∩ 现有图片。
 * 导出供单测。
 */
export function selectPool(files, lists, source) {
	const set = new Set(files);
	const uniq = (arr) => {
		const out = [];
		const seen = new Set();
		for (const p of Array.isArray(arr) ? arr : []) {
			if (set.has(p) && !seen.has(p)) {
				seen.add(p);
				out.push(p);
			}
		}
		return out;
	};
	const src = String(source || "all");
	if (src === "likes") return uniq(lists.likes);
	if (src.startsWith("list:")) {
		const l = (lists.lists || []).find((x) => x.id === src.slice(5));
		return l ? uniq(l.items) : [];
	}
	const black = new Set(lists.blacklist || []);
	return files.filter((f) => !black.has(f));
}

/** 清理配置相关缓存 (改配置后立即生效: 每日图缓存 + 文件夹随机缓存 + 登录页锁定)。 */
function invalidateCaches() {
	cache = null;
	inflight = null;
	folderCache = null;
	folderCacheKey = "";
	folderLockUntil = 0;
	folderListCache.clear();
	listsCache = null;
	listsCacheAt = 0;
}

/** 当日壁纸状态缓存: { url, bytes, type, note, fetchedAt } */
let cache = null;
let inflight = null;

// ═══════════════════════════════════════════════════════════════════
//  北京时间工具 + 缓存绕过参数
// ═══════════════════════════════════════════════════════════════════
const HOUR_MS = 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");

/** 北京时间 (UTC+8) 的 Date 对象, 用 getUTC* 读取即北京时间 */
function beijingNow() {
	return new Date(Date.now() + 8 * HOUR_MS);
}
/** 北京时间 YYYYMMDD (用于 ?d= 日期参数, 按天绕过 CDN 缓存) */
function beijingDateStr() {
	const d = beijingNow();
	return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}
/** 北京时间 HHMM (用于重试去重参数 &t=) */
function beijingHHMM() {
	const d = beijingNow();
	return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}
/**
 * 距下一个 dailyRefreshTime (北京时间 HH:mm) 的毫秒数。
 * 导出便于 VM 无 token 单测 (传入固定 now 断言结果)。
 */
export function nextFireDelayMs(refreshTime = "00:10", now = Date.now()) {
	const [h, m] = refreshTime.split(":").map((s) => Number(s));
	const bj = new Date(now + 8 * HOUR_MS);
	let fire = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), h, m, 0, 0) - 8 * HOUR_MS;
	if (fire <= now) fire += 24 * HOUR_MS;
	// 配置非法 (NaN) 时兜底 24h, 避免 setTimeout(NaN)→0ms 忙循环
	return Number.isFinite(fire) ? fire - now : 24 * HOUR_MS;
}
/** 给 path 追加缓存绕过参数: 默认 ?d=YYYYMMDD; opts.bustTime 时另加 &t=HHMM (每次重试 URL 唯一, 强制回源) */
function withBust(path, opts = {}) {
	const sep = path.includes("?") ? "&" : "?";
	let q = `d=${beijingDateStr()}`;
	if (opts.bustTime) q += `&t=${beijingHHMM()}`;
	return `${path}${sep}${q}`;
}

/** 按顺序尝试多个源, 返回第一个成功的 fetch 响应 (带 raw 供缓存来源标记) */
/** Bing 每日壁纸接口（无需自有服务）。 */
const BING_API = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN";

/** 抓取每日壁纸：daily.source 为空走 Bing 直连；非空时把 source 当自建源根或用图片直链。 */
async function fetchDaily(config, opts = {}) {
	const signal = AbortSignal.timeout(config.fetchTimeoutMs);
	const headers = { "User-Agent": UA, Accept: "*/*" };
	const source = config.dailySource;
	if (source) {
		if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(source)) {
			const resp = await fetch(source, { headers, signal });
			if (!resp.ok) throw new Error(`wallpaper source HTTP ${resp.status}`);
			return { bytes: Buffer.from(await resp.arrayBuffer()), type: resp.headers.get("content-type") || "image/jpeg", note: "", imgBase: source, noteBase: "" };
		}
		const base = source.replace(/\/$/, "");
		const imgPath = withBust("/today.jpg", opts), notePath = withBust("/note.txt", opts);
		const imgResp = await fetch(base + imgPath, { headers, signal });
		if (!imgResp.ok) throw new Error(`wallpaper source HTTP ${imgResp.status}`);
		let note = "";
		try {
			const noteResp = await fetch(base + notePath, { headers, signal });
			if (noteResp.ok) note = (await noteResp.text()).trim();
		} catch { /* 介绍容错 */ }
		return { bytes: Buffer.from(await imgResp.arrayBuffer()), type: imgResp.headers.get("content-type") || "image/jpeg", note, imgBase: base, noteBase: base };
	}
	const apiResp = await fetch(BING_API + (opts.bust ? `&_=${opts.bust}` : ""), { headers: { ...headers, Accept: "application/json" }, signal });
	if (!apiResp.ok) throw new Error(`Bing HPImageArchive HTTP ${apiResp.status}`);
	const data = await apiResp.json();
	const img = Array.isArray(data?.images) ? data.images[0] : null;
	if (!img?.urlbase) throw new Error("Bing HPImageArchive: empty images");
	const imgUrl = `https://www.bing.com${img.urlbase}_UHD.jpg`;
	const imgResp = await fetch(imgUrl, { headers, signal });
	if (!imgResp.ok) throw new Error(`Bing image HTTP ${imgResp.status}`);
	const note = [img.copyright, img.title].filter(Boolean).join("\n").trim();
	return { bytes: Buffer.from(await imgResp.arrayBuffer()), type: imgResp.headers.get("content-type") || "image/jpeg", note, imgBase: "https://www.bing.com", noteBase: "https://www.bing.com" };
}

/** 获取 (或刷新) 当日壁纸缓存; force 用于客户端主动强制刷新 (跨天)。 */
async function getWallpaper(config, force = false, opts = {}) {
	if (!force && cache && Date.now() - cache.fetchedAt < config.cacheTtlMs) return cache;
	try {
		const wall = await fetchDaily(config, opts);
		cache = { ...wall, fetchedAt: Date.now() };
		debug(`refreshed: ${wall.imgBase} (${wall.bytes.length}B) note ${wall.note.length} chars`);
		return cache;
	} catch (error) {
		debug(`refresh failed: ${String(error?.message ?? error)}; stale=${!!cache}`);
		if (cache) return cache;
		throw error;
	}
}

// ═══════════════════════════════════════════════════════════════════
//  文件夹随机壁纸 (dsh-bg-image 设置里切换"文件夹随机"模式)
//  策略: every=每次请求随机 / daily=当天固定 / interval=固定 intervalMs 毫秒
// ═══════════════════════════════════════════════════════════════════
const EXT_MIME = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif"
};

/**
 * 页面 token → 最近一次返回给该页面的图 (v7.0.1)。
 * 为什么需要: /wallpaper-folder 的 every 策略是"谁来要就重随机", 多个标签页会互相顶掉;
 * 调试图标角标/“加入列表”要的是**本页正在显示的那一张**, 所以按页面 token (client.js 的
 * PAGE_BUST) 记一份; /wallpaper-current?c=<token> 优先返回它, 查不到再回落全局 folderCache。
 */
const clientPicks = new Map();
const CLIENT_PICKS_MAX = 64;
const CLIENT_PICK_TTL_MS = 15 * 60 * 1000;
function rememberClientPick(token, wall) {
	if (!token) return;
	const key = String(token).slice(0, 64);
	clientPicks.set(key, { path: wall.name, at: Date.now(), source: wall.source || "all", pool: wall.pool || 0 });
	if (clientPicks.size > CLIENT_PICKS_MAX) {
		let oldestKey = "";
		let oldestAt = Infinity;
		for (const [k, v] of clientPicks) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
		if (oldestKey) clientPicks.delete(oldestKey);
	}
}
function recallClientPick(token) {
	if (!token) return null;
	const hit = clientPicks.get(String(token).slice(0, 64));
	if (!hit) return null;
	if (Date.now() - hit.at > CLIENT_PICK_TTL_MS) {
		clientPicks.delete(String(token).slice(0, 64));
		return null;
	}
	return hit;
}

/** 文件夹随机选择缓存: { bytes, type, name, pickedAt } (全局单例, 单用户场景够用) */
let folderCache = null;
let folderCacheKey = "";
/** mode=current 锁定截止时间戳: 登录页 current 访问后锁定, 锁期内所有 folder 请求跟随同一张 */
let folderLockUntil = 0;

/** 校验 relPath (相对 baseDir 的子目录) 安全: realpath 后必须仍在 baseDir 内; 非法返回 null */
function safeResolveDir(baseDir, relPath) {
	try {
		const base = realpathSync(baseDir);
		const full = path.resolve(base, relPath || ".");
		if (!statSync(full).isDirectory()) return null;
		const real = realpathSync(full);
		const rel = path.relative(base, real);
		if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
		return real;
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════
//  文件夹图片清单 (v6.0.0: 递归)
//  壁纸库常按 年/月 分子目录 (实测 $DSH_HOME/wallpapers/2022/2022-01/...),
//  只读第一层会漏掉绝大多数图 ⇒ 默认递归子目录。
//  · 跳过隐藏/系统目录: Synology 的 @eaDir(@SynoResource/@SynoEAStream, 里面是缩略图!)
//    、#recycle、.DS_Store 等; 不跟随符号链接 (防环/防越权);
//  · 深度上限 FOLDER_MAX_DEPTH 兜底, 防止异常目录树把请求拖死;
//  · 结果按 (目录|扩展名|递归) 缓存 FOLDER_LIST_TTL_MS, 避免 every 策略每请求都遍历。
// ═══════════════════════════════════════════════════════════════════
/** 目录清单缓存: key = dir|exts|recursive → { files: 相对路径[], at } */
const folderListCache = new Map();
/** 清单缓存有效期 (毫秒): 新图放进来最多 1 分钟就能被随机到 */
const FOLDER_LIST_TTL_MS = 60000;
/** 递归深度上限 (相对指定目录) */
const FOLDER_MAX_DEPTH = 8;
/** 系统/隐藏目录名: 以 @ . # _ 开头的一律不进 (下划线保留给用户目录, 只挡 _ 开头的隐藏约定) */
function skipDirName(name) {
	if (!name) return true;
	const c = name[0];
	return c === "@" || c === "." || c === "#" || c === "$";
}

/** 递归收集 dir 下的图片, 结果写进 out (相对 base 的路径)。 */
function collectImages(dir, base, exts, depth, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const name = ent.name;
		if (ent.isSymbolicLink()) continue; // 不跟随软链 (环/越权)
		if (ent.isDirectory()) {
			if (depth >= FOLDER_MAX_DEPTH || skipDirName(name)) continue;
			collectImages(path.join(dir, name), base, exts, depth + 1, out);
			continue;
		}
		if (!ent.isFile()) continue;
		if (name[0] === ".") continue; // .DS_Store / ._xxx
		const lower = name.toLowerCase();
		if (!exts.some((e) => lower.endsWith(e))) continue;
		out.push(path.relative(base, path.join(dir, name)));
	}
}

/**
 * 列出图片清单 (相对 dir 的路径, 按名字排序保证稳定)。
 * recursive=false 时只看第一层 (旧行为)。
 * 导出供单测 (VM/容器内可直接 import 调)。
 */
export function listImages(dir, exts, recursive) {
	const norm = (exts || []).map((e) => String(e).toLowerCase());
	if (!recursive) {
		try {
			return readdirSync(dir)
				.filter((f) => norm.some((e) => f.toLowerCase().endsWith(e)))
				.sort();
		} catch {
			return [];
		}
	}
	const key = `${dir}|${norm.join(",")}|1`;
	const hit = folderListCache.get(key);
	const now = Date.now();
	if (hit && now - hit.at < FOLDER_LIST_TTL_MS) return hit.files;
	const files = [];
	collectImages(dir, dir, norm, 0, files);
	files.sort();
	// 缓存上限: 单用户场景只会有两三个目录, 超过 8 条清掉最旧的, 防长跑累积
	if (folderListCache.size >= 8) folderListCache.delete(folderListCache.keys().next().value);
	folderListCache.set(key, { files, at: now });
	return files;
}

// ═══════════════════════════════════════════════════════════════════
//  按宽度出图 (v7.5.0): /api/wallpaper/folder?...&w=1920 与 /api/wallpaper/daily?w=1920
//  为什么由客户端传 w: 服务端拿不到可靠的"设备/链路"判据 (UA 可伪造, Client Hints 未开,
//  隧道与内网在容器里看是同一个来源)。客户端知道 视口宽度/是否移动端/location.hostname 是否内网,
//  所以由客户端决定 w: 桌面内网不传(出原图), 移动端或外网传 1920 (1080p)。
//  成本: 4K 原图 → 1920 约 0.6~0.7 s (ImageMagick, 单核), 之后落盘缓存命中 ~1 ms; 体积 3.28 MB → 0.57 MB (-83%)。
// ═══════════════════════════════════════════════════════════════════
const RESIZE_DIR = process.env.DSH_RESIZE_DIR || path.join(DATA_DIR, "wallpaper-cache");
const RESIZE_MIN_W = 320;
const RESIZE_MAX_W = 3840;
/** 缓存上限 (字节); 超了按 mtime 删最旧的 */
const RESIZE_MAX_BYTES = 512 * 1024 * 1024;
/** 出图质量 (JPEG) */
const RESIZE_QUALITY = 82;

function clampWidth(raw) {
	// 缺省/空/非法/非正 ⇒ 0 = 不出图 (原图直出)。注意: Number(null)=0, 不能直接夹下限,
	// 否则"没带 w"会被夹成 320px (2026-11-22 实测踩到: 桌面内网背景一度只有 320px 宽)。
	if (raw === null || raw === undefined || raw === "") return 0;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(RESIZE_MAX_W, Math.max(RESIZE_MIN_W, Math.round(n)));
}

/** 缓存键: 源标识 + 宽度 (+ 源 mtime) ⇒ sha1 短串 */
function resizeKey(id, w, stamp) {
	return createHash("sha1").update(String(id)).update("|").update(String(w)).update("|").update(String(stamp || 0)).digest("hex").slice(0, 24);
}

/** 超限时按 mtime 删旧文件 (静默)。 */
function trimResizeCache() {
	try {
		const names = readdirSync(RESIZE_DIR);
		let total = 0;
		const rows = [];
		for (const n of names) {
			try {
				const st = statSync(path.join(RESIZE_DIR, n));
				total += st.size;
				rows.push({ n, size: st.size, mtime: st.mtimeMs });
			} catch { /* 单个失败忽略 */ }
		}
		if (total <= RESIZE_MAX_BYTES) return;
		rows.sort((a, b) => a.mtime - b.mtime);
		let cur = total;
		for (const r of rows) {
			if (cur <= RESIZE_MAX_BYTES * 0.8) break;
			try { rmSync(path.join(RESIZE_DIR, r.n), { force: true }); cur -= r.size; } catch { /* ignore */ }
		}
		debug(`resize cache trimmed: ${Math.round(total / 1048576)}MB → ${Math.round(cur / 1048576)}MB`);
	} catch { /* 目录不存在等, 忽略 */ }
}

/** 从真实文件出指定宽度的 JPEG; 失败回 null (调用方回原图)。 */
export async function resizedFromFile(real, w, mtimeMs) {
	try {
		const out = path.join(RESIZE_DIR, `${resizeKey(real, w, mtimeMs)}.jpg`);
		if (existsSync(out)) return out;
		mkdirSync(RESIZE_DIR, { recursive: true });
		await withThumbSlot(() => runConvert2(real, out, w));
		if (!existsSync(out)) return null;
		trimResizeCache();
		return out;
	} catch (err) {
		debug(`resize(file) failed: ${String(err?.message ?? err)}`);
		return null;
	}
}

/** 从内存字节出指定宽度的 JPEG (每日壁纸走这条); 失败回 null。 */
export async function resizedFromBytes(bytes, w, id) {
	let tmp = "";
	try {
		const key = resizeKey(id, w, bytes.length);
		const out = path.join(RESIZE_DIR, `${key}.jpg`);
		if (existsSync(out)) return out;
		mkdirSync(RESIZE_DIR, { recursive: true });
		tmp = path.join(RESIZE_DIR, `${key}.src`);
		writeFileSync(tmp, bytes);
		await withThumbSlot(() => runConvert2(tmp, out, w));
		return existsSync(out) ? out : null;
	} catch (err) {
		debug(`resize(bytes) failed: ${String(err?.message ?? err)}`);
		return null;
	} finally {
		if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
	}
}

/** 全尺寸图的重采样 (与缩略图共用并发闸, 避免同时跑一堆 convert)。 */
function runConvert2(src, dst, w) {
	return new Promise((resolve, reject) => {
		execFile("convert", ["-define", `jpeg:size=${w}x${w}`, src, "-auto-orient", "-resize", `${w}x${w}>`, "-quality", String(RESIZE_QUALITY), "-strip", dst], { timeout: 60000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
	});
}

// ═══════════════════════════════════════════════════════════════════
//  缩略图 (v7.0.0): 设置里图片列表用, 按需压缩 + 落盘缓存
//  · 源图 → ImageMagick convert (容器内有 /usr/bin/convert) → 缓存 JPEG
//  · 缓存键含源文件 mtime ⇒ 换图/改图自动失效; 并发闸 3, 防滚屏时并发 convert 打满 CPU
//  · convert 失败回落到原图直出 (浏览器自己缩), 绝不让列表变空
// ═══════════════════════════════════════════════════════════════════
/** 缩略图缓存目录 (默认 $DSH_DATA_DIR/wallpaper-thumbs, 可用 DSH_THUMB_DIR 覆盖) */
const THUMB_DIR = process.env.DSH_THUMB_DIR || path.join(DATA_DIR, "wallpaper-thumbs");
const THUMB_MIN_W = 64;
const THUMB_MAX_W = 3840; // v7.6.0: 预览整屏壁纸也走这个端点 (默认仍 160)
let thumbActive = 0;
const thumbQueue = [];

/** 校验 rel 指向 baseDir 内的一个真实文件 (realpath 兜底, 防 ../ 与软链越权); 非法返回 null。 */
function safeResolveFile(baseDir, rel) {
	try {
		const p = normRelPath(rel);
		if (!p) return null;
		const base = realpathSync(baseDir);
		const real = realpathSync(path.resolve(base, p));
		const r = path.relative(base, real);
		if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
		return statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

/** 并发闸: 同时最多 THUMB_CONCURRENCY 个 convert (默认按 CPU 核数取, 可用 DSH_THUMB_CONCURRENCY 覆盖)。 */
const THUMB_CONCURRENCY = (() => {
	const n = Number(process.env.DSH_THUMB_CONCURRENCY);
	if (Number.isFinite(n) && n >= 1 && n <= 32) return Math.round(n);
	let cpus = 4;
	try { cpus = Math.max(2, cpus().length); } catch { /* 取不到就按 4 算 */ }
	return Math.min(6, Math.max(2, cpus - 2));
})();
async function withThumbSlot(fn) {
	while (thumbActive >= THUMB_CONCURRENCY) await new Promise((r) => thumbQueue.push(r));
	thumbActive += 1;
	try {
		return await fn();
	} finally {
		thumbActive -= 1;
		const next = thumbQueue.shift();
		if (next) next();
	}
}

function runConvert(src, dst, w) {
	// -define jpeg:size 让 libjpeg 直接 DCT 缩放到 2 倍目标尺寸再 resize:
	// 实测 3840x2160 → 160px 从 ~470 ms 降到 ~95 ms (输出字节数基本一致)。
	const hint = `${w * 2}x${w * 2}`;
	return new Promise((resolve, reject) => {
		execFile("convert", ["-define", `jpeg:size=${hint}`, src, "-auto-orient", "-resize", `${w}x${w}>`, "-quality", "78", "-strip", dst], { timeout: 20000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
	});
}

/** 取缩略图文件路径 (必要时生成); 失败回 null。 */
export async function getThumbFile(real, w, mtimeMs) {
	let h;
	try {
		h = createHash("sha1").update(real).update("|").update(String(mtimeMs)).update("|").update(String(w)).digest("hex").slice(0, 24);
	} catch {
		return null;
	}
	const out = path.join(THUMB_DIR, `${h}.jpg`);
	if (existsSync(out)) return out;
	try {
		mkdirSync(THUMB_DIR, { recursive: true });
		await withThumbSlot(() => runConvert(real, out, w));
		return existsSync(out) ? out : null;
	} catch (err) {
		debug(`thumb convert failed (${path.basename(real)}): ${String(err?.message ?? err)}`);
		return null;
	}
}

/**
 * mode=current 锁定毫秒数: 请求带 lockSec=<秒> (1..3600) 优先, 否则用 config.folderLockMs。
 */
function lockMsFor(config, query) {
	const sec = Number(query.get("lockSec"));
	if (Number.isFinite(sec) && sec >= 1 && sec <= 3600) return sec * 1000;
	return config.folderLockMs;
}

/**
 * 从文件夹随机选一张图返回缓存 (每请求/每天/按间隔三种策略)。
 * query: path(相对 baseDir, 默认根) / mode(every|daily|interval|current) / intervalMs
 *        / lockSec(秒, 覆盖锁定窗口, 默认 config.folderLockMs)
 * mode=current: 跟随"最近一次随机选中的图"并锁定 lockSec 秒 (登录页与聊天背景同步用);
 *               服务重启后无记录 → 回退根目录 every 随机一张并锁定。锁期内任何
 *               folder 请求 (含聊天页 every) 都返回同一张, 锁过期后恢复随机。
 */
export async function getFolderWallpaper(config, query, listsOverride) {
	const isCurrent = String(query.get("mode") || "") === "current";
	if (isCurrent && folderCache) {
		folderLockUntil = Date.now() + lockMsFor(config, query); // 锁定: 从登录页访问时刻起算
		debug(`folder locked ${lockMsFor(config, query)}ms (mode=current, follow cache)`);
		return folderCache;
	}
	if (isCurrent) {
		// 无记录: 降级随机并锁定 — 保留 lockSec, 否则首次登录锁会回退 config 默认时长
		const lockSec = query.get("lockSec");
		query = new URLSearchParams([["mode", "every"]]);
		if (lockSec) query.set("lockSec", lockSec);
	}
	const relPath = String(query.get("path") || "");
	const mode = String(query.get("mode") || "every");
	const intervalMs = Number(query.get("intervalMs")) || 0;
	const dir = safeResolveDir(config.baseDir, relPath);
	if (!dir) throw new Error(`folder not found: ${config.baseDir}${relPath ? "/" + relPath : ""}`);
	// 递归子目录 (config.recursive, 默认开): 只读第一层时子目录里的图永远随机不到
	// ★ 路径口径 (v7.0.0): 一律换算成"相对 baseDir"的路径 —— 列表(黑名单/收藏/自定义)
	//   存的就是这个口径, 换 folderPath 也依然对得上; 读文件时再拼回 baseDir。
	let baseDirReal;
	try { baseDirReal = realpathSync(config.baseDir); } catch { baseDirReal = config.baseDir; }
	const files = listImages(dir, config.allowedExts, config.recursive !== false)
		.map((p) => path.relative(baseDirReal, path.join(dir, p)))
		.filter(Boolean);
	if (files.length === 0) throw new Error(`no images in folder: ${relPath || "/"}`);

	// 选图来源 (v7.0.0): all=全部减黑名单 / likes=收藏夹 / list:<id>=自定义列表
	// (后两者不受黑名单影响, 见 selectPool 注释)。来源池为空时回落全随机, 并记 debug。
	const askedSource = String(query.get("source") || "all");
	const lists = listsOverride || currentLists(); // listsOverride = 单测注入缝 (生产不传)
	let pool = selectPool(files, lists, askedSource);
	let usedSource = askedSource;
	if (pool.length === 0 && askedSource !== "all") {
		const fallback = selectPool(files, lists, "all");
		debug(`folder source "${askedSource}" empty ⇒ fallback to all (${fallback.length})`);
		pool = fallback;
		usedSource = "all";
	}
	if (pool.length === 0) throw new Error("no images available (everything blacklisted?)");

	// 缓存 key: daily 带日期 (当天固定, 跨天自动换), interval 带间隔, every 固定 key
	// recursive / source / 列表修订号 也进 key: 改来源或改列表后立刻重选, 不沿用旧选择
	let key = `${dir}|${mode}${config.recursive !== false ? "" : "|flat"}|${usedSource}|${listsRevision}`;
	if (mode === "daily") key += `|${beijingDateStr()}`;
	else if (mode === "interval") key += `|${intervalMs}`;
	// every 换图间隔: 默认 1s (仅覆盖客户端同一页面内皮肤探测的重复请求), 客户端可带
	// refreshSec=<秒> 覆盖 — "N 秒内刷新不换图, 超过 N 秒刷新才换" (设置面板可配)
	let ttlMs = mode === "interval" ? intervalMs : mode === "daily" ? 24 * 3600 * 1000 : 1000;
	if (mode === "every") {
		const refreshSec = Number(query.get("refreshSec"));
		if (Number.isFinite(refreshSec) && refreshSec >= 1 && refreshSec <= 3600) ttlMs = refreshSec * 1000;
	}

	// 锁期内非 current 请求 (聊天页 every 等) 跟随锁定图, 保证登录流程内登录页与聊天背景一致
	if (!isCurrent && folderLockUntil && Date.now() < folderLockUntil) {
		debug(`folder lock hit (remaining ${folderLockUntil - Date.now()}ms)`);
		return folderCache;
	}

	if (folderCache && folderCacheKey === key && Date.now() - folderCache.pickedAt < ttlMs) {
		return folderCache;
	}

	const name = pool[Math.floor(Math.random() * pool.length)];
	const bytes = readFileSync(path.join(baseDirReal, name));
	const ext = path.extname(name).toLowerCase();
	folderCache = {
		bytes,
		type: EXT_MIME[ext] || "application/octet-stream",
		name,
		pickedAt: Date.now(),
		source: usedSource,
		pool: pool.length
	};
	folderCacheKey = key;
	// current 无记录降级随机后也锁定 (首次登录流程同样同步); 普通随机换图则清除锁
	folderLockUntil = isCurrent ? Date.now() + lockMsFor(config, query) : 0;
	debug(`folder picked: ${relPath || "/"} -> ${name} (mode=${mode}${mode === "interval" ? ` interval=${intervalMs}ms` : ""}${config.recursive !== false ? `, recursive, candidates=${files.length}` : ", flat"}, source=${usedSource}, pool=${pool.length})`);
	return folderCache;
}

/**
 * 每日定时强刷 (北京时间 dailyRefreshTime, 默认 00:10):
 * 强制重抓图片+介绍; 若 note 与刷新前相同 (daily 服务还没写完), 每 5 分钟重试,
 * 最多 ~40 分钟。重试请求带 &t=HHMM (URL 每次唯一) 强制回源, 拿当天新图。
 */
async function dailyRefresh(config) {
	const prevNote = cache?.note ?? "";
	for (let i = 0; i < 8; i++) {
		try {
			const wall = await getWallpaper(config, true, { bustTime: true });
			if (wall.note && wall.note !== prevNote) {
				debug(`daily refresh ok (attempt ${i + 1}): note changed (${wall.note.length} chars)`);
				return true;
			}
			debug(`daily refresh attempt ${i + 1}: note unchanged (${wall.note.length} chars), retry in 5min`);
		} catch (error) {
			debug(`daily refresh attempt ${i + 1} failed: ${String(error?.message ?? error)}`);
		}
		if (i < 7) await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
	}
	debug("daily refresh gave up after retries (upstream may be down)");
	return false;
}

function sendJson(res, data) {
	const body = Buffer.from(JSON.stringify(data));
	res.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": body.length,
		"Cache-Control": "no-store"
	});
	res.end(body);
}

export async function mountWallpaper(ctx, readConfig) {
	const webServer = (() => { try { return ctx.get("webServer", false) || null; } catch { return null; } })();
	if (!webServer) debug("mount: webServer 不可用 ⇒ 跳过路由注册（如实降级，不 throw）");
	let cfg = flatConfig(readConfig());
	const refreshCfg = () => { try { cfg = flatConfig(readConfig()); } catch { /* 保持上次 */ } };
	/** 路由注册单点兜底：单条失败只记 debug 并跳过，不连带整条 fiber 判死。 */
	const registerRoute = (spec) => {
		try {
			if (!webServer || typeof webServer.register !== "function") return undefined;
			const handler = spec.handler;
			return webServer.register({ ...spec, handler: (req, res) => { refreshCfg(); return handler(req, res); } });
		}
		catch (err) { debug(`mount: webServer.register 失败（跳过该路由，不 throw）: ${String(err?.message ?? err)}`); return undefined; }
	};
	debug(`mount: ttl=${cfg.cacheTtlMs} daily=${cfg.dailyRefreshTime}`);

	// ── 每日定时强刷（北京时间 daily.refreshTime）：跨天准时换图 ──
	let dailyTimer = null;
	const scheduleDaily = () => {
		if (dailyTimer) clearTimeout(dailyTimer);
		refreshCfg();
		const delay = nextFireDelayMs(cfg.dailyRefreshTime);
		debug(`daily refresh scheduled at +${Math.round(delay / 60000)}min`);
		dailyTimer = setTimeout(async () => {
			try { await dailyRefresh(flatConfig(readConfig())); }
			catch (error) { debug(`daily refresh error: ${String(error?.message ?? error)}`); }
			finally { scheduleDaily(); }
		}, delay);
	};
	ctx.effect(() => () => { if (dailyTimer) clearTimeout(dailyTimer); });
	scheduleDaily();

	// ── 图片列表 RPC (v7.0.0): 设置 > 本地插件 > 壁纸 > 图片列表 ──
	//   get         → { ok, value:{ lists:{ blacklist, likes, lists[] } } }
	//   set {lists} → 清洗后落盘 + 清随机缓存 (改列表后立刻重选) → 返回清洗结果
	const __listsHandler = (async (endpoint, payload) => {
		refreshCfg();
		try {
			if (endpoint === "get") return { ok: true, value: { lists: currentLists() } };
			if (endpoint === "set") {
				const next = writeLists(payload?.lists ?? {});
				folderCache = null; // 刚被拉黑的图可能正是缓存里那张 ⇒ 清空, 下次请求重选
				folderCacheKey = "";
				debug(`lists set: black=${next.blacklist.length} likes=${next.likes.length} lists=${next.lists.length}`);
				return { ok: true, value: { lists: next } };
			}
			if (endpoint === "delete") {
				// v7.6.0 删除壁纸: 把图片**从磁盘移除** (省空间) + 从所有列表里剔除
				// 安全: 只允许 baseDir 内的真实图片文件 (realpath 校验), 路径非法/不存在一律拒绝
				const rel = normRelPath(payload?.path);
				if (!rel) return { ok: false, error: { code: "bad-request", message: "缺少合法 path" } };
				const real = safeResolveFile(cfg.baseDir, rel);
				if (!real) return { ok: false, error: { code: "not-found", message: `文件不存在或越界: ${rel}` } };
				// 只允许删"允许的图片扩展名", 防止误删同目录里的说明文件等
				const ext = path.extname(real).toLowerCase();
				const allowed = (cfg.allowedExts || []).map((e) => String(e).toLowerCase());
				if (allowed.indexOf(ext) < 0) {
					return { ok: false, error: { code: "bad-request", message: `只允许删除图片文件 (${ext || "无扩展名"})` } };
				}
				let size = 0;
				try { size = statSync(real).size; } catch { /* 取不到大小也能删 */ }
				try {
					rmSync(real, { force: true });
				} catch (err) {
					return { ok: false, error: { code: "delete-failed", message: String(err?.message ?? err) } };
				}
				const cur = currentLists();
				const next = writeLists({
					version: cur.version,
					blacklist: (cur.blacklist || []).filter((x) => x !== rel),
					likes: (cur.likes || []).filter((x) => x !== rel),
					lists: (cur.lists || []).map((l) => Object.assign({}, l, { items: (l.items || []).filter((x) => x !== rel) }))
				});
				// 清掉"缓存里正好是它"的情况, 并让清单缓存失效 (下次 /wallpaper-list 不含它)
				if (folderCache && folderCache.name === rel) { folderCache = null; folderCacheKey = ""; }
				folderListCache.clear();
				// 顺手删它的缩略图/出图缓存 (按 sha1 前缀找不到原文件名, 只能靠整目录清理策略;
				// 这里不做精确删除, 缓存有 512MB 上限会自动淘汰)
				debug(`deleted wallpaper: ${rel} (${size} bytes)`);
				return { ok: true, value: { lists: next, deleted: rel, bytes: size } };
			}
			return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
		} catch (err) {
			ctx.logger?.warn?.(`dsh-bg-image: 壁纸列表 RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	});
	try {
		const __seams2 = await import("@ericality/dsh-host-compat/seams");
		__seams2?.channelFace?.(ctx, "wallpaper-lists", ["get", "set", "delete"], __listsHandler);
	} catch (err) { /* 缺包 ⇒ 回落旧面 */ }
	try {
		const __rpc2 = ctx.get?.("connection")?.rpc;
		if (typeof __rpc2?.handle === "function") __rpc2.handle("/wallpaper-lists", __listsHandler);
	} catch (err) { /* 0.2.2 旧面已废, 静默回落 */ }

	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/daily",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				const wall = await getWallpaper(cfg);
				// v7.5.0: w= 时按目标宽度出图 (每日壁纸原图 ~3.5MB, 1920 约 0.6MB)
				const w = clampWidth(new URL(req.url, "http://localhost").searchParams.get("w"));
				let body = wall.bytes;
				let ctype = wall.type;
				if (w) {
					try {
						const out = await resizedFromBytes(wall.bytes, w, `${wall.imgBase || ""}|${wall.bytes.length}`);
						if (out) { body = readFileSync(out); ctype = "image/jpeg"; }
					} catch (err) { debug(`daily resize fallback: ${String(err?.message ?? err)}`); }
				}
				res.writeHead(200, {
					"Content-Type": ctype,
					"Content-Length": body.length,
					"Cache-Control": "public, max-age=3600", // 1h 内浏览器可缓存, 每天换图够用
					"X-Wallpaper-Width": String(w || 0),
					"X-Content-Type-Options": "nosniff"
				});
				if (req.method === "HEAD") {
					res.end();
				} else {
					res.end(body);
				}
			} catch (error) {
				debug(`request failed: ${String(error?.message ?? error)}`);
				res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`wallpaper unavailable: ${String(error?.message ?? error)}`);
			}
		}
	}));

	// 壁纸介绍 JSON (右下角展示用)
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/daily-meta",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				// ?refresh=1 强制重抓 (跨天切换), 默认用缓存
				const force = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
				const wall = await getWallpaper(cfg, force);
				const note = wall?.note ?? "";
				// note.txt 首行通常是标题/版权行, 其余为正文段落
				const lines = note.split(/\n+/).map((s) => s.trim()).filter(Boolean);
				const title = lines[0] ?? "";
				const body = lines.slice(1).join("\n");
				sendJson(res, {
					ok: true,
					title,
					body,
					note,
					imageUrl: "/api/wallpaper/daily",
					source: wall?.imgBase ?? ""
				});
			} catch (error) {
				debug(`meta request failed: ${String(error?.message ?? error)}`);
				sendJson(res, { ok: false, error: String(error?.message ?? error) });
			}
		}
	}));

	// 文件夹随机壁纸 (dsh-bg-image "文件夹随机" 模式): 从 baseDir 随机选一张返回
	// query: path=相对子目录 / mode=every|daily|interval / intervalMs=间隔毫秒
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/folder",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				const query = new URL(req.url, "http://localhost").searchParams;
				const wall = await getFolderWallpaper(cfg, query);
				rememberClientPick(query.get("c"), wall); // 记下"这次给这个页面的图"
				// v7.5.0: w= 时按目标宽度出图 (移动端/外网省带宽); 生成失败或未给 w ⇒ 原图
				const w = clampWidth(query.get("w"));
				let body = wall.bytes;
				let ctype = wall.type;
				if (w) {
					try {
						const real = safeResolveFile(cfg.baseDir, wall.name);
						if (real) {
							const mt = statSync(real).mtimeMs;
							const out = await resizedFromFile(real, w, mt);
							if (out) { body = readFileSync(out); ctype = "image/jpeg"; }
						}
					} catch (err) { debug(`folder resize fallback: ${String(err?.message ?? err)}`); }
				}
				res.writeHead(200, {
					"Content-Type": ctype,
					"Content-Length": body.length,
					"Cache-Control": "no-store", // 随机模式不能长缓存, 每次/按策略换图
					"X-Wallpaper-Name": encodeURIComponent(wall.name), // 文件名给 meta 展示用
					"X-Wallpaper-Width": String(w || 0),
					"X-Content-Type-Options": "nosniff"
				});
				if (req.method === "HEAD") {
					res.end();
				} else {
					res.end(body);
				}
			} catch (error) {
				debug(`folder request failed: ${String(error?.message ?? error)}`);
				res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`folder wallpaper unavailable: ${String(error?.message ?? error)}`);
			}
		}
	}));

	// 文件夹随机壁纸介绍 (文件名): 返回最近一次随机选择的名字, 供右下角展示
	// 客户端先请求 /wallpaper-folder 触发选择, 再请求本端点读名字 (竞态窗口极小, 可接受)
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/folder-meta",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				if (!folderCache) {
					sendJson(res, { ok: false, error: "no folder wallpaper selected yet" });
					return;
				}
				sendJson(res, {
					ok: true,
					title: folderCache.name.replace(/\.[^.]+$/, ""), // 去掉扩展名当标题
					body: "",
					note: folderCache.name,
					imageUrl: "/api/wallpaper/folder",
					source: folderCacheKey.split("|")[0]
				});
			} catch (error) {
				debug(`folder meta request failed: ${String(error?.message ?? error)}`);
				sendJson(res, { ok: false, error: String(error?.message ?? error) });
			}
		}
	}));

	// ── 图片清单 (v7.0.0): 设置里"图片列表"用, 返回相对路径 + 字节数 + mtime ──
	// GET /wallpaper-list?path=<子目录>&recursive=0|1
	//   递归默认跟随配置 (config.recursive); 只读, 不返回图片内容 (缩略图走 /wallpaper-thumb)
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/list",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				const query = new URL(req.url, "http://localhost").searchParams;
				const relPath = String(query.get("path") || "");
				const dir = safeResolveDir(cfg.baseDir, relPath);
				if (!dir) throw new Error(`folder not found: ${relPath || "/"}`);
				const rq = query.get("recursive");
				const recursive = rq === null ? cfg.recursive !== false : rq === "1" || rq === "true";
				let baseDirReal;
				try { baseDirReal = realpathSync(cfg.baseDir); } catch { baseDirReal = cfg.baseDir; }
				// 口径同 /wallpaper-folder: 一律返回"相对 baseDir"的路径 (列表里存的就是这个)
				const files = listImages(dir, cfg.allowedExts, recursive)
					.map((p) => path.relative(baseDirReal, path.join(dir, p)))
					.filter(Boolean);
				// 上限兜底 (超大壁纸库不至于一次吐几十万条)
				const items = files.slice(0, 20000).map((p) => {
					let size = 0;
					let mtime = 0;
					try {
						const st = statSync(path.join(baseDirReal, p));
						size = st.size;
						mtime = Math.floor(st.mtimeMs / 1000);
					} catch { /* 读不到 stat 就留 0, 不影响清单 */ }
					return { p, s: size, t: mtime };
				});
				sendJson(res, { ok: true, baseDir: cfg.baseDir, dir: relPath || "/", recursive, total: files.length, items });
			} catch (error) {
				debug(`list request failed: ${String(error?.message ?? error)}`);
				sendJson(res, { ok: false, error: String(error?.message ?? error) });
			}
		}
	}));

	// ── 缩略图 (v7.0.0): /wallpaper-thumb?p=<相对路径>&w=160 ──
	// 生成失败 ⇒ 回落原图直出 (宁可让浏览器自己缩, 别让列表变空)
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/thumb",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				const query = new URL(req.url, "http://localhost").searchParams;
				const rel = String(query.get("p") || "");
				const rawW = Number(query.get("w"));
				const w = Number.isFinite(rawW) ? Math.min(THUMB_MAX_W, Math.max(THUMB_MIN_W, Math.round(rawW))) : 160;
				const real = safeResolveFile(cfg.baseDir, rel);
				if (!real) {
					res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("not found");
					return;
				}
				let mtimeMs = 0;
				try { mtimeMs = statSync(real).mtimeMs; } catch { /* 用 0 也能生成, 只是缓存键不随改图变 */ }
				const thumb = await getThumbFile(real, w, mtimeMs);
				const file = thumb || real;
				const bytes = readFileSync(file);
				const ext = path.extname(file).toLowerCase();
				res.writeHead(200, {
					"Content-Type": thumb ? "image/jpeg" : (EXT_MIME[ext] || "application/octet-stream"),
					"Content-Length": bytes.length,
					"Cache-Control": thumb ? "public, max-age=86400" : "public, max-age=3600",
					"X-Content-Type-Options": "nosniff"
				});
				if (req.method === "HEAD") res.end();
				else res.end(bytes);
			} catch (error) {
				debug(`thumb request failed: ${String(error?.message ?? error)}`);
				res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`thumb unavailable: ${String(error?.message ?? error)}`);
			}
		}
	}));

	// ── 当前壁纸 (v7.0.0): 调试角标/快捷加入列表用, 读最近一次随机结果 ──
	// GET /wallpaper-current → { ok, path, dir, name, source, pool, pickedAt }
	ctx.effect(() => registerRoute({
		kind: "exact",
		path: "/api/wallpaper/current",
		handler: async (req, res) => {
			try {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("method not allowed");
					return;
				}
				const token = new URL(req.url, "http://localhost").searchParams.get("c");
				const mine = recallClientPick(token);
				// 优先返回"发给这个页面 token 的那张"; 没带 token/没记录才回落全局最近一次
				const p = mine ? mine.path : folderCache ? folderCache.name : "";
				if (!p) {
					sendJson(res, { ok: false });
					return;
				}
				const dir = path.dirname(p);
				sendJson(res, {
					ok: true,
					path: p,
					dir: dir === "." ? "/" : dir,
					name: path.basename(p),
					source: mine ? mine.source : (folderCache && folderCache.source) || "all",
					pool: mine ? mine.pool : (folderCache && folderCache.pool) || 0,
					pickedAt: mine ? mine.at : (folderCache && folderCache.pickedAt) || 0,
					scoped: !!mine
				});
			} catch (error) {
				debug(`current request failed: ${String(error?.message ?? error)}`);
				sendJson(res, { ok: false, error: String(error?.message ?? error) });
			}
		}
	}));
}
