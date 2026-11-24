#!/usr/bin/env node
/**
 * 生成插件市场索引（format 1）：docs/market/index.json
 *
 * 数据来源：
 *   - packages/<pkg>/package.json   包名、版本、engines.dsh、icon 路径、keywords
 *   - packages/<pkg>/locale/en.json 与 zh.json 的 meta.title / meta.description
 *   - npm registry 的 time 字段    该版本的真实发布时间（Unix 秒）
 *
 * 规则：
 *   - 只列 12 个可安装 bundle（package.json 带 dsh.bundle.patch）；5 个纯库不列。
 *   - 每项单条 versions（当前 package.json 版本），source.type 为 npm。
 *   - 图标内联为 data URI：SVG 直接内联；位图超过 32 KiB 时按整数倍降采样重编码，
 *     保证解码后不超过 format 1 的上限（校验器 MAX_INLINE_ICON_BYTES）。
 *   - 幂等：输出不含生成时间，插件按包名排序，同一输入重复运行字节一致。
 *
 * 用法：
 *   node scripts/gen-market-index.mjs
 *   node scripts/gen-market-index.mjs --out docs/market/index.json --registry https://registry.npmjs.org
 *   DSH_MARKET_INDEX_MODULE=/path/to/@deepseek-ai/dsh-plugin-market-index/lib/index.js \
 *     node scripts/gen-market-index.mjs    # 额外用官方 parseMarketIndex 校验
 */
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "docs", "market", "index.json");
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** 索引发布后的公开地址；校验器需要它来解析相对图标。 */
const INDEX_URL = "https://ericality.github.io/dsh-enhanced/market/index.json";
/** format 1 内联图标解码后上限。 */
const MAX_ICON_BYTES = 32 * 1024;
/** 位图图标降采样的首选边长（取不超过该边的最大整数倍）。 */
const MAX_ICON_SIDE = 128;

const INDEX_TITLE = { en: "DSH Enhanced Plugins", zh: "DSH 增强插件" };
const INDEX_DESCRIPTION = {
	en: "Community-maintained plugin set for DeepSeek Harness: cost visibility, gentle restarts, notifications, and one place for settings.",
	zh: "社区维护的 DeepSeek Harness 插件集：费用可见、重启不慌、通知到位、配置集中。"
};

/** @param {string[]} argv */
function parseArgs(argv) {
	const options = { out: DEFAULT_OUT, registry: DEFAULT_REGISTRY };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") options.out = resolve(argv[++i] ?? "");
		else if (arg === "--registry") options.registry = String(argv[++i] ?? DEFAULT_REGISTRY);
		else if (arg === "--help" || arg === "-h") {
			console.log("用法: node scripts/gen-market-index.mjs [--out <path>] [--registry <url>]");
			process.exit(0);
		} else throw new Error(`未知参数: ${arg}`);
	}
	return options;
}

function toDataUrl(mime, bytes) {
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

// ---------- 最小 PNG 解码 / 降采样 / 编码（无第三方依赖） ----------

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

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 解码 8 位、非隔行 PNG（支持灰度/RGB/RGBA）为 RGBA 像素。 */
function decodePng(buf) {
	let offset = 8;
	const idat = [];
	let width = 0, height = 0, colorType = -1;
	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8) throw new Error("图标 PNG 仅支持 8 位深度");
			colorType = data[9];
			if (data[12] !== 0) throw new Error("图标 PNG 不支持隔行扫描");
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
	if (!bpp) throw new Error(`图标 PNG 不支持的颜色类型: ${colorType}`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const pixels = new Uint8Array(height * stride);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const rowIn = raw.subarray(pos, pos + stride);
		pos += stride;
		const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? rowOut[x - bpp] : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
			let value = rowIn[x];
			if (filter === 1) value += a;
			else if (filter === 2) value += b;
			else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			rowOut[x] = value & 0xff;
		}
	}
	return { width, height, colorType, bpp, pixels };
}

/** 按整数倍做 box 平均降采样，输出 RGBA。 */
function downsample(img, factor) {
	const outWidth = Math.floor(img.width / factor);
	const outHeight = Math.floor(img.height / factor);
	const out = new Uint8Array(outWidth * outHeight * 4);
	const alphaChannel = img.colorType === 6 ? 3 : img.colorType === 4 ? 1 : -1;
	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			let r = 0, g = 0, b = 0, a = 0, n = 0;
			for (let dy = 0; dy < factor; dy++) {
				for (let dx = 0; dx < factor; dx++) {
					const si = ((y * factor + dy) * img.width + (x * factor + dx)) * img.bpp;
					r += img.pixels[si];
					g += img.pixels[si + 1] ?? r;
					b += img.pixels[si + 2] ?? r;
					a += alphaChannel >= 0 ? img.pixels[si + alphaChannel] : 255;
					n++;
				}
			}
			const oi = (y * outWidth + x) * 4;
			out[oi] = Math.round(r / n);
			out[oi + 1] = Math.round(g / n);
			out[oi + 2] = Math.round(b / n);
			out[oi + 3] = Math.round(a / n);
		}
	}
	return { width: outWidth, height: outHeight, colorType: 6, bpp: 4, pixels: out };
}

/** 编码 RGBA PNG（filter 0 + 最高压缩，输出可复现）。 */
function encodePng(img) {
	const stride = img.width * 4;
	const raw = Buffer.alloc(img.height * (stride + 1));
	for (let y = 0; y < img.height; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(img.pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(img.width, 0);
	ihdr.writeUInt32BE(img.height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0))
	]);
}

/** 把一个图标文件转成内联 data URI，位图超限时降采样。 */
async function iconDataUrl(pkgDir, iconRel) {
	const file = resolve(pkgDir, iconRel.replace(/^\.\//, ""));
	const bytes = await readFile(file);
	const lower = file.toLowerCase();
	if (lower.endsWith(".svg")) {
		if (bytes.length > MAX_ICON_BYTES) throw new Error(`图标超过 ${MAX_ICON_BYTES} 字节: ${file}`);
		return toDataUrl("image/svg+xml", bytes);
	}
	if (lower.endsWith(".png")) {
		if (bytes.length <= MAX_ICON_BYTES) return toDataUrl("image/png", bytes);
		const img = decodePng(bytes);
		for (const factor of [2, 4, 8, 16]) {
			if (img.width % factor !== 0 || img.height % factor !== 0) continue;
			if (img.width / factor > MAX_ICON_SIDE) continue;
			const small = downsample(img, factor);
			const encoded = encodePng(small);
			if (encoded.length <= MAX_ICON_BYTES) return toDataUrl("image/png", encoded);
		}
		throw new Error(`图标降采样后仍超过 ${MAX_ICON_BYTES} 字节: ${file}`);
	}
	throw new Error(`不支持的图标格式（只接受 svg/png）: ${file}`);
}

// ---------- 元数据读取 ----------

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readLocaleMeta(pkgDir) {
	const out = {};
	for (const [language, file] of [["en", "en.json"], ["zh", "zh.json"]]) {
		const path = join(pkgDir, "locale", file);
		if (!existsSync(path)) continue;
		const meta = (await readJson(path)).meta ?? {};
		if (typeof meta.title === "string" && meta.title.trim() !== "") out[language] = out[language] ?? {};
		if (typeof meta.title === "string" && meta.title.trim() !== "") out[language].title = meta.title;
		if (typeof meta.description === "string" && meta.description.trim() !== "") out[language].description = meta.description;
	}
	return out;
}

async function fetchRegistryMetadata(name, registry, attempts = 3) {
	const base = registry.replace(/\/+$/, "");
	const url = `${base}/${name.replace("/", "%2f")}`;
	let lastError;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} catch (err) {
			lastError = err;
			if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
		}
	}
	throw new Error(`读取 npm 元数据失败 ${url}: ${String(lastError?.message ?? lastError)}`);
}

/** 版本发布时间：registry time 字段（ISO 8601）转 Unix 秒。 */
function publishTimestampOf(metadata, name, version) {
	const iso = metadata?.time?.[version];
	const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name}@${version} 在 registry 中没有可用的 time 字段`);
	return Math.floor(ms / 1000);
}

// ---------- 主流程 ----------

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const packagesDir = join(ROOT, "packages");
	const entries = (await readdir(packagesDir, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	const plugins = [];
	for (const dir of entries) {
		const pkgDir = join(packagesDir, dir);
		const manifestPath = join(pkgDir, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = await readJson(manifestPath);
		// 只列可安装 bundle；纯库（无 dsh.bundle.patch）不列
		if (manifest.dsh?.bundle?.patch === undefined) continue;
		const name = manifest.name;
		const version = manifest.version;
		const locales = await readLocaleMeta(pkgDir);
		const title = localsOrManifest(locales, "title", manifest.description ?? name);
		const description = locales.en?.description ?? manifest.description;
		const keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((keyword) => typeof keyword === "string") : [];
		const metadata = await fetchRegistryMetadata(name, options.registry);
		const publishTimestamp = publishTimestampOf(metadata, name, version);
		const icon = typeof manifest.icon === "string" ? await iconDataUrl(pkgDir, manifest.icon) : undefined;
		if (icon !== undefined) assertIconWithinLimit(icon, name);
		plugins.push({
			name,
			...(title ? { title } : {}),
			...(description === undefined ? {} : { description }),
			...(icon === undefined ? {} : { icon }),
			metadata: { keywords },
			versions: [{
				version,
				publishTimestamp,
				source: { type: "npm" },
				...(manifest.engines?.dsh === undefined ? {} : { engines: { dsh: manifest.engines.dsh } })
			}]
		});
	}

	const index = {
		format: 1,
		title: INDEX_TITLE,
		description: INDEX_DESCRIPTION,
		metadata: {},
		plugins
	};

	assertIndex(index);
	const validatorPath = process.env.DSH_MARKET_INDEX_MODULE;
	if (validatorPath) {
		const { parseMarketIndex } = await import(pathToFileURL(resolve(validatorPath)).href);
		parseMarketIndex(index, INDEX_URL);
		console.log("parseMarketIndex: ok");
	}
	const body = `${JSON.stringify(index, null, 2)}\n`;
	await writeFile(options.out, body, "utf8");
	console.log(`写入 ${options.out}: ${plugins.length} 个插件, ${Buffer.byteLength(body)} 字节`);
}

function localsOrManifest(locales, key, fallback) {
	const out = {};
	for (const [language, meta] of Object.entries(locales)) {
		const value = meta[key];
		if (typeof value === "string" && value.trim() !== "") out[language] = value;
	}
	if (Object.keys(out).length) return out;
	return typeof fallback === "string" && fallback.trim() !== "" ? { en: fallback } : undefined;
}

function decodedIconLength(dataUrl) {
	const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
	return Buffer.from(base64, "base64").length;
}

function assertIconWithinLimit(dataUrl, name) {
	const size = decodedIconLength(dataUrl);
	if (size > MAX_ICON_BYTES) throw new Error(`${name} 图标解码后 ${size} 字节，超过上限 ${MAX_ICON_BYTES}`);
}

function assertIndex(index) {
	if (index.plugins.length === 0) throw new Error("索引没有任何插件");
	const names = new Set();
	for (const plugin of index.plugins) {
		if (names.has(plugin.name)) throw new Error(`插件重复: ${plugin.name}`);
		names.add(plugin.name);
		if (plugin.versions.length !== 1) throw new Error(`${plugin.name} 必须只有一条 versions`);
		if (!plugin.title?.en) throw new Error(`${plugin.name} 缺少 title.en`);
		if (plugin.icon !== undefined) assertIconWithinLimit(plugin.icon, plugin.name);
	}
}

main().catch((err) => {
	console.error(`gen-market-index: ${String(err?.message ?? err)}`);
	process.exitCode = 1;
});
