import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import z from "@deepseek-ai/schemastery";

/** 图标取自包内 assets/（随包发布，不依赖部署机路径）。 */
const assetUrl = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));

/**
 * @ericality/dsh-pwa
 *
 * 让 iOS Safari / 移动浏览器可以把 dsh 网页“添加到主屏幕”当独立 App 用：
 *   - /apple-touch-icon.png（180）与 /dsh-icon-512.png（512）按当前配置的图标主题实时出图
 *   - /manifest.webmanifest 按当前配置实时生成（name/short_name/theme_color/background_color/display）
 *   - 每页头部注入 apple-mobile-web-app-capable、theme-color 与 apple-touch-icon
 *   - 三套图标（sky/lav/mint）供配置页预览：/pwa-icon-<theme>-<size>.png
 *   - /api/pwa/config/get|set 读写宿主官方 Config，保存后下一次请求即生效，无需重启
 *
 * 全部响应都在请求期读配置、读文件，模块加载期不留任何图标或清单常量。
 */
export const name = "dsh-pwa";
export const inject = ["webServer", "connection"];

/** 三套图标；sky 沿用既有的 dsh-icon-180/512 两个文件名。 */
const THEMES = ["sky", "lav", "mint"];
const ICON_FILES = {
	sky: { 180: "dsh-icon-180.png", 512: "dsh-icon-512.png" },
	lav: { 180: "dsh-icon-lav-180.png", 512: "dsh-icon-lav-512.png" },
	mint: { 180: "dsh-icon-mint-180.png", 512: "dsh-icon-mint-512.png" }
};
const SIZES = [180, 512];
const DISPLAYS = ["standalone", "fullscreen", "minimal-ui", "browser"];
const DEFAULTS = {
	icon: "sky",
	name: "DeepSeek Harness",
	shortName: "DSH",
	themeColor: "#4D6BFE",
	backgroundColor: "#101320",
	display: "standalone"
};

/** 官方 Config：六项均可在插件页编辑并即时生效。 */
export const Config = z.object({
	icon: z.union(THEMES).default(DEFAULTS.icon).volatile(),
	name: z.string().default(DEFAULTS.name).volatile(),
	shortName: z.string().default(DEFAULTS.shortName).volatile(),
	themeColor: z.string().default(DEFAULTS.themeColor).volatile(),
	backgroundColor: z.string().default(DEFAULTS.backgroundColor).volatile(),
	display: z.union(DISPLAYS).default(DEFAULTS.display).volatile()
});

/** volatile 叶子在运行态是带 get() 的引用。 */
const val = (x, fallback) => {
	try { return x && typeof x.get === "function" ? x.get() : (x === undefined || x === null ? fallback : x); } catch { return fallback; }
};

/** 十六进制颜色；不合法即回退（防注入进 meta 属性）。 */
function cleanColor(input, fallback) {
	const text = String(input === undefined || input === null ? "" : input).trim();
	return /^#[0-9a-fA-F]{3,8}$/.test(text) ? text : fallback;
}

/** 单行文本；去控制字符并按上限截断，空串回退默认值。 */
function cleanText(input, fallback, max) {
	const text = String(input === undefined || input === null ? "" : input).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	if (!text) return fallback;
	return text.length > max ? text.slice(0, max) : text;
}

/** 当前生效配置（每次调用现读，不在加载期缓存）。 */
function current(config) {
	const raw = config || {};
	const icon = val(raw.icon, DEFAULTS.icon);
	const display = val(raw.display, DEFAULTS.display);
	return {
		icon: THEMES.includes(icon) ? icon : DEFAULTS.icon,
		name: cleanText(val(raw.name, DEFAULTS.name), DEFAULTS.name, 60),
		shortName: cleanText(val(raw.shortName, DEFAULTS.shortName), DEFAULTS.shortName, 30),
		themeColor: cleanColor(val(raw.themeColor, DEFAULTS.themeColor), DEFAULTS.themeColor),
		backgroundColor: cleanColor(val(raw.backgroundColor, DEFAULTS.backgroundColor), DEFAULTS.backgroundColor),
		display: DISPLAYS.includes(display) ? display : DEFAULTS.display
	};
}

// ---------- 最小 PNG 编码器（纯 Node；仅在三套图缺失时兜底） ----------
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 兜底图标：底色 + 白色内边框，尺寸随请求。 */
function buildFallbackPng(size, color) {
	const hex = String(color).replace("#", "");
	const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.padEnd(6, "0");
	const rgb = [0, 2, 4].map((i) => {
		const n = parseInt(full.slice(i, i + 2), 16);
		return Number.isFinite(n) ? n : 0;
	});
	const border = Math.round(size / 9);
	const raw = Buffer.alloc(size * (size * 3 + 1));
	let o = 0;
	for (let y = 0; y < size; y++) {
		raw[o++] = 0; // filter: none
		for (let x = 0; x < size; x++) {
			const edge = x < border || y < border || x >= size - border || y >= size - border;
			const px = edge ? [255, 255, 255] : rgb;
			raw[o++] = px[0];
			raw[o++] = px[1];
			raw[o++] = px[2];
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

/** 文件缓存：按 mtime 失效，请求期读盘，加载期零读取。 */
const fileCache = new Map();
function readAsset(file) {
	const path = assetUrl(file);
	try {
		const mtimeMs = statSync(path).mtimeMs;
		const hit = fileCache.get(path);
		if (hit && hit.mtimeMs === mtimeMs) return hit.buf;
		const buf = readFileSync(path);
		fileCache.set(path, { mtimeMs, buf });
		return buf;
	} catch {
		return fileCache.get(path)?.buf ?? null;
	}
}

/** 指定主题与尺寸的图标字节；文件缺失时用实时主题色生成占位图。 */
function iconBytes(theme, size, config) {
	const buf = readAsset(ICON_FILES[theme][size]);
	if (buf) return buf;
	return buildFallbackPng(size, current(config).themeColor);
}

function versionTag(buf) {
	return createHash("sha1").update(buf).digest("hex").slice(0, 10);
}

/** 清单按当前配置生成（请求期调用，不缓存）。 */
function buildManifest(cfg, config) {
	const big = iconBytes(cfg.icon, 512, config);
	return JSON.stringify({
		id: "/",
		name: cfg.name,
		short_name: cfg.shortName,
		start_url: "/",
		scope: "/",
		display: cfg.display,
		background_color: cfg.backgroundColor,
		theme_color: cfg.themeColor,
		icons: [
			{ src: `/apple-touch-icon.png?v=${versionTag(iconBytes(cfg.icon, 180, config))}`, sizes: "180x180", type: "image/png", purpose: "any" },
			{ src: `/dsh-icon-512.png?v=${versionTag(big)}`, sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
		]
	});
}

/** 设置服务（显式解析，避免 inject 守卫）。 */
const settingsOf = (ctx) => { try { return ctx.get?.("settings", false) || null; } catch { return null; } };

function sendPng(res, buf) {
	res.writeHead(200, {
		"Content-Type": "image/png",
		"Content-Length": buf.length,
		// 配置可随时切换 ⇒ 不缓存，保存后刷新即见新图
		"Cache-Control": "no-store"
	});
	res.end(buf);
}

/**
 * 插件主体。
 * @param ctx - cordis 上下文（webServer 经 inject 注入）。
 * @param config - 宿主官方 Config（volatile 字段现读）。
 */
export async function apply(ctx, config) {
	// 180 apple-touch-icon：按当前配置的图标主题实时出图
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/apple-touch-icon.png",
		handler: (req, res) => sendPng(res, iconBytes(current(config).icon, 180, config))
	}));

	// 512 主屏图标：同源、同主题
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-icon-512.png",
		handler: (req, res) => sendPng(res, iconBytes(current(config).icon, 512, config))
	}));

	// 三套 × 两尺寸的预览图（配置页图标网格用，与当前选中项无关）
	for (const theme of THEMES) {
		for (const size of SIZES) {
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: `/pwa-icon-${theme}-${size}.png`,
				handler: (req, res) => sendPng(res, iconBytes(theme, size, config))
			}));
		}
	}

	// 清单：每次请求现读配置
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/manifest.webmanifest",
		handler: (req, res) => {
			const cfg = current(config);
			const body = buildManifest(cfg, config);
			res.writeHead(200, {
				"Content-Type": "application/manifest+json",
				"Content-Length": Buffer.byteLength(body),
				"Cache-Control": "no-store"
			});
			res.end(body);
		}
	}));

	// 页头注入：theme-color 与 apple-touch-icon 都取当前配置
	ctx.on("webserver/index-inject", (table) => {
		const cfg = current(config);
		const tag = versionTag(iconBytes(cfg.icon, 180, config));
		table.push({
			kind: "html",
			placement: "head",
			html: "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">"
				+ "<meta name=\"mobile-web-app-capable\" content=\"yes\">"
				+ `<meta name="theme-color" content="${cfg.themeColor}">`
				+ `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${tag}">`
		});
	});

	// /api/pwa/config/get|set：配置页与 curl 共用，读写宿主官方 Config
	const handler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "get":
				return { ok: true, value: { config: current(config) } };
			case "set": {
				const input = payload && typeof payload === "object" && payload.config && typeof payload.config === "object" ? payload.config : payload;
				if (!input || typeof input !== "object") return { ok: false, error: { code: "bad-request", message: "缺少配置对象" } };
				const next = {};
				if (input.icon !== undefined) {
					if (!THEMES.includes(input.icon)) return { ok: false, error: { code: "bad-request", message: `icon 只能是 ${THEMES.join("/")}` } };
					next.icon = input.icon;
				}
				if (input.display !== undefined) {
					if (!DISPLAYS.includes(input.display)) return { ok: false, error: { code: "bad-request", message: `display 只能是 ${DISPLAYS.join("/")}` } };
					next.display = input.display;
				}
				if (input.name !== undefined) next.name = cleanText(input.name, DEFAULTS.name, 60);
				if (input.shortName !== undefined) next.shortName = cleanText(input.shortName, DEFAULTS.shortName, 30);
				if (input.themeColor !== undefined) {
					const color = cleanColor(input.themeColor, "");
					if (!color) return { ok: false, error: { code: "bad-request", message: "themeColor 必须是 #RGB/#RRGGBB 形式" } };
					next.themeColor = color;
				}
				if (input.backgroundColor !== undefined) {
					const color = cleanColor(input.backgroundColor, "");
					if (!color) return { ok: false, error: { code: "bad-request", message: "backgroundColor 必须是 #RGB/#RRGGBB 形式" } };
					next.backgroundColor = color;
				}
				if (!Object.keys(next).length) return { ok: false, error: { code: "bad-request", message: "没有可保存的字段" } };
				const settings = settingsOf(ctx);
				if (!settings || typeof settings.update !== "function") {
					return { ok: false, error: { code: "unavailable", message: "settings 服务不可用，配置未保存" } };
				}
				await settings.update("pwa", next);
				return { ok: true, value: { config: current(config) } };
			}
			default:
				return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-pwa: /api/pwa/config ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};

	const endpoints = ["get", "set"];
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") {
			ctx.logger?.warn?.("dsh-pwa: host-compat 未提供 channelFace，/api/pwa/config 不可用");
			return;
		}
		const face = seams.channelFace(ctx, "/pwa/config", endpoints, handler);
		if (!face?.ok) ctx.logger?.warn?.(`dsh-pwa: /api/pwa/config 注册失败 ${JSON.stringify(face?.results ?? [])}`);
	}).catch((err) => {
		ctx.logger?.warn?.(`dsh-pwa: host-compat 加载失败 ${String(err?.message ?? err)}`);
	});
}
