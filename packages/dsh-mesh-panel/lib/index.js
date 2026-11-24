// dsh-mesh-panel · 宿主半（件17：自签 TLS + 指纹钉住 + 配对限流 + 凭据不入日志/状态明文）
// 两个面：
//   A 面（本机面板用）：/api/mesh-panel/{get,add,code,pair,open,reconnect,delete,settings,set-settings}
//   B 面（对端自监听）：GET /health、POST /pair、POST /ctl/*（需配对 token），其余路径反向代理本机 GUI
// 安全默认：监听 127.0.0.1 + https（自签、首次启动生成，私钥 0600）；显式改 0.0.0.0 / http 由面板给出风险提示。
// 对端连接：证书指纹钉住 —— 握手阶段用对端证书做 ca 校验，指纹不符直接失败，绝不回退明文。
// 凭据：状态文件里的出站 token 用本机 secret.key 做 AES-256-GCM 封存；入站 token 只存哈希；配对码只存哈希。
// 只读宿主；状态只写自有 $DSH_HOME/mesh-panel/*；无 DSH_HOME 时只内存态、不落盘。
// GUI 反代凭 $DSH_HOME/.dsh-launch-token 换 dsh-auth cookie；读不到就如实报，不静默。
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { createSelfSignedCertificate, displayFingerprint, fingerprintOf, fingerprintPrefix, inspectCertificate } from "./x509.js";

export const name = "dsh-mesh-panel";
export const inject = ["connection"];

const PLUGIN_ID = "dsh-mesh-panel";
const VERSION = "0.5.6";
const REQUIRES = ["rpcHandle", "webServerPrefix", "webServerUpgrade"];
const CHANNEL = "/mesh-panel";
const ENDPOINTS = ["get", "add", "code", "pair", "request", "pair-status", "pending", "approve", "reject", "open", "reconnect", "probe", "delete", "rename", "settings", "set-settings", "set-address", "trust-check", "trust-cert", "logs", "retry-listen"];
// 件19：DSH_HOME 缺失时兜底到 os.homedir()/.dsh（Windows 桌面常不注入 DSH_HOME）；
// 兜底仍不可写时由 saveState/probeWritable 如实报错，不再静默假保存。
const DSH_HOME_ENV = String(process.env.DSH_HOME || "").trim();
const DSH_HOME = DSH_HOME_ENV || join(os.homedir(), ".dsh");
const HOME_SOURCE = DSH_HOME_ENV ? "env" : "homedir-fallback";
const DATA_DIR = join(DSH_HOME, "mesh-panel");
const STATE_FILE = join(DATA_DIR, "state.json");
const PEER_STATE_FILE = join(DATA_DIR, "peer-state.json");
const SECRET_FILE = join(DATA_DIR, "secret.key");
const TLS_KEY_FILE = join(DATA_DIR, "tls-key.pem");
const TLS_CERT_FILE = join(DATA_DIR, "tls-cert.pem");
let lastSaveError = "";

const MAX_BODY = 1024 * 1024;
const IO_TIMEOUT_MS = 15_000;
const PEER_TIMEOUT_MS = 8_000;
const MAX_CODE_FAILS = 5;
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 10;

function numberEnv(key, fallback) {
	const raw = Number(process.env[key]);
	return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : fallback;
}
const LISTEN_PORT = numberEnv("MESH_PANEL_PORT", 8470);
const LISTEN_BIND = String(process.env.MESH_PANEL_BIND || "127.0.0.1").trim() || "127.0.0.1";
const LISTEN_PROTOCOL = String(process.env.MESH_PANEL_PROTOCOL || "https").trim() === "http" ? "http" : "https";
const GUI_TIMEOUT_MS = 6000;
const MAX_NODES = 20;
// 件23：自动地址写回节流（每节点最多每分钟一次）与对端日志读取上限。
const ADDRESS_SYNC_MS = 60_000;
const LOG_LINES_MAX = 300;
const LOG_LINES_DEFAULT = 100;

let seams = null;
let lastCap = null;
let state = null;
let peerState = null;
let secretKey = null;
let tlsMaterial = null;

/* ---------------- 本机监听状态 ---------------- */
const listener = { ok: false, port: LISTEN_PORT, bind: LISTEN_BIND, protocol: LISTEN_PROTOCOL, error: "not-started", errorCode: "", startedAt: null, requests: 0, inflight: 0, maxConcurrency: 32, certFingerprint: "", tlsError: "", timeouts: 0, rejected: 0 };
let listenerServer = null;
let guiCookie = { value: "", at: 0 };
let guiExchangeError = "";

let guiPortObserved = 0;
let guiPortResolved = 0;
function argvGuiPort() {
	for (let i = 0; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === "--port" && process.argv[i + 1]) return Number(process.argv[i + 1]);
		if (a.startsWith("--port=")) return Number(a.slice(7));
	}
	return 0;
}
function envGuiPort() {
	const env = Number(process.env.DSH_PORT || process.env.PORT);
	return env > 0 && env < 65536 ? env : 0;
}
function contextGuiPort() {
	try {
		const ws = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("webServer") : null;
		const port = Number(ws?.port);
		if (port > 0 && port < 65536) return port;
	} catch {}
	for (const arg of process.argv) {
		const m = /^--(?:gui-|web-|https?-)?port=(\d{1,5})$/.exec(String(arg));
		if (m) return Number(m[1]);
	}
	const env = Number(process.env.DSH_GUI_PORT || process.env.DSH_WEB_PORT);
	return env > 0 && env < 65536 ? env : 0;
}
function guiPort() {
	const override = Number(ensureState().settings.guiPort) || 0;
	if (override > 0) return override;
	if (guiPortObserved > 0) return guiPortObserved;
	if (guiPortResolved > 0) return guiPortResolved;
	return contextGuiPort() || argvGuiPort() || envGuiPort() || 0;
}
function probeTcpHost(host, port, timeout = 400) {
	return new Promise((resolve) => {
		let settled = false;
		const socket = net.connect({ host, port });
		const done = (value) => { if (settled) return; settled = true; try { socket.destroy(); } catch {} resolve(value); };
		socket.setTimeout(timeout);
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.once("timeout", () => done(false));
	});
}
async function probeTcpPort(port, timeout = 400) {
	for (const host of ["127.0.0.1", "::1"]) {
		if (await probeTcpHost(host, port, timeout)) { relayLogAdd("info", `gui probe ${host}:${port} ok`); return true; }
	}
	relayLogAdd("info", `gui probe ${port} closed (127.0.0.1/::1)`);
	return false;
}
/** 件22 修补：旧 host-compat 不报 webServer.port 时，按常见 GUI 端口探测，避免 Windows 8091 被写成 3081。 */
async function resolveGuiPort(force) {
	if (guiPortResolved > 0 && !force) return guiPortResolved;
	const candidates = [];
	const add = (value) => { const p = Number(value); if (p > 0 && p < 65536 && !candidates.includes(p)) candidates.push(p); };
	const ctxPort = contextGuiPort();
	if (ctxPort > 0 && guiPortObserved === 0) { guiPortObserved = ctxPort; relayLogAdd("info", `guiPort from ctx.webServer=${ctxPort}`); }
	add(ctxPort);
	add(guiPortObserved);
	add(8091);
	add(3081);
	add(argvGuiPort());
	add(envGuiPort());
	for (const port of candidates) {
		if (await probeTcpPort(port)) { guiPortResolved = port; relayLogAdd("info", `guiPort resolved ${port} (candidates ${candidates.join(",")})`); return port; }
	}
	relayLogAdd("warn", `guiPort unresolved (candidates ${candidates.join(",")})；停止猜测，不再回退 3081`);
	return guiPortResolved || 0;
}

function fingerprint() {
	const st = ensureState();
	return crypto.createHash("sha256").update(`${st.instanceId}|${VERSION}`).digest("hex").slice(0, 16);
}
function nodeIdentity() {
	const basis = `${DSH_HOME || os.hostname()}|${VERSION}`;
	return { nodeId: `node-${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 10)}`, fingerprint: crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16) };
}

function redact(value) {
	return String(value === undefined || value === null ? "" : value)
		.replace(/(x-mesh-token\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
		.slice(0, 600);
}
function safeLog(ctx, level, message) {
	try {
		const logger = ctx?.logger;
		if (logger && typeof logger[level] === "function") logger[level](redact(message));
	} catch {}
}
const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
const sha256Hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const tokenHashOf = (token) => sha256Hex(token);

// 恒定时间比较：两边先各自 sha256（定长），再用 timingSafeEqual；长度差异不参与分支。
function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ""));
	const right = Buffer.from(String(b ?? ""));
	if (!left.length || !right.length) return false;
	const ha = crypto.createHash("sha256").update(left).digest();
	const hb = crypto.createHash("sha256").update(right).digest();
	return crypto.timingSafeEqual(ha, hb) && left.length === right.length;
}

/* ---------------- 本机密钥与凭据封存 ---------------- */
function ensureSecret() {
	if (secretKey) return secretKey;
	if (!SECRET_FILE) { secretKey = crypto.randomBytes(32); return secretKey; }
	try {
		const raw = readFileSync(SECRET_FILE, "utf8").trim();
		if (/^[0-9a-f]{64}$/i.test(raw)) { secretKey = Buffer.from(raw, "hex"); return secretKey; }
	} catch {}
	const key = crypto.randomBytes(32);
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(SECRET_FILE, `${key.toString("hex")}\n`, { mode: 0o600 });
		chmodSync(SECRET_FILE, 0o600);
	} catch {}
	secretKey = key;
	return secretKey;
}
function sealValue(plain) {
	if (!plain) return "";
	try {
		const key = ensureSecret();
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
		return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
	} catch { return ""; }
}
function openValue(sealed) {
	try {
		const m = /^v1\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]*)$/.exec(String(sealed || ""));
		if (!m) return "";
		const decipher = crypto.createDecipheriv("aes-256-gcm", ensureSecret(), Buffer.from(m[1], "base64url"));
		decipher.setAuthTag(Buffer.from(m[2], "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(m[3], "base64url")), decipher.final()]).toString("utf8");
	} catch { return ""; }
}

/* ---------------- 自签 TLS 材料 ---------------- */
function ensureTls() {
	if (tlsMaterial) return tlsMaterial;
	const make = () => createSelfSignedCertificate({ commonName: `mesh-${ensureState().instanceId}`.slice(0, 64) });
	if (!TLS_KEY_FILE || !TLS_CERT_FILE) {
		const made = make();
		tlsMaterial = { key: made.keyPem, cert: made.certPem, fingerprint: made.fingerprint, notBefore: made.notBefore, notAfter: made.notAfter, ephemeral: true };
		return tlsMaterial;
	}
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		const key = readFileSync(TLS_KEY_FILE, "utf8");
		const cert = readFileSync(TLS_CERT_FILE, "utf8");
		const info = inspectCertificate(cert);
		if (key.includes("PRIVATE KEY") && info) {
			chmodSync(TLS_KEY_FILE, 0o600);
			tlsMaterial = { key, cert, fingerprint: info.fingerprint, notBefore: null, notAfter: info.validTo, ephemeral: false };
			return tlsMaterial;
		}
	} catch {}
	const made = make();
	try {
		writeFileSync(TLS_KEY_FILE, made.keyPem, { mode: 0o600 });
		chmodSync(TLS_KEY_FILE, 0o600);
		writeFileSync(TLS_CERT_FILE, made.certPem, { mode: 0o644 });
		chmodSync(TLS_CERT_FILE, 0o644);
	} catch {}
	tlsMaterial = { key: made.keyPem, cert: made.certPem, fingerprint: made.fingerprint, notBefore: made.notBefore, notAfter: made.notAfter, ephemeral: false };
	return tlsMaterial;
}
function certFingerprint() {
	try { return ensureTls().fingerprint; } catch { return ""; }
}
function tlsSummary() {
	try {
		const m = ensureTls();
		return { enabled: true, fingerprint: m.fingerprint, fingerprintDisplay: displayFingerprint(m.fingerprint), fingerprintPrefix: fingerprintPrefix(m.fingerprint, 6), notAfter: m.notAfter, ephemeral: Boolean(m.ephemeral) };
	} catch (err) {
		return { enabled: false, error: redact(err?.message ?? err) };
	}
}

/* ---------------- 配对限流 ---------------- */
function codeHashOf(code) { return sha256Hex(`mesh-code:${String(code)}`); }
function peerIpOf(req) {
	const raw = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
	return raw || "unknown";
}
function pruneLimits(db) {
	const now = Date.now();
	db.limits ||= { ip: {}, codes: {}, stats: { redemptions: 0, blocked: 0, lockedCodes: 0, lastBlockedAt: null } };
	db.limits.ip ||= {};
	db.limits.codes ||= {};
	db.limits.stats ||= { redemptions: 0, blocked: 0, lockedCodes: 0, lastBlockedAt: null };
	for (const [ip, stamps] of Object.entries(db.limits.ip)) {
		const kept = (Array.isArray(stamps) ? stamps : []).filter((t) => now - Number(t) < IP_WINDOW_MS);
		if (kept.length) db.limits.ip[ip] = kept; else delete db.limits.ip[ip];
	}
	for (const [key, rec] of Object.entries(db.limits.codes)) {
		if (!rec || now - Number(rec.at || 0) > 24 * 3600 * 1000) delete db.limits.codes[key];
	}
	return db.limits;
}
function checkPairRate(db, ip) {
	const limits = pruneLimits(db);
	const now = Date.now();
	const stamps = (limits.ip[ip] || []).filter((t) => now - t < IP_WINDOW_MS);
	if (stamps.length >= IP_MAX_ATTEMPTS) {
		limits.stats.blocked += 1;
		limits.stats.lastBlockedAt = new Date().toISOString();
		savePeerState();
		return { ok: false, attempts: stamps.length, limit: IP_MAX_ATTEMPTS, retryAfterMs: Math.max(1000, IP_WINDOW_MS - (now - stamps[0])) };
	}
	stamps.push(now);
	limits.ip[ip] = stamps;
	return { ok: true, attempts: stamps.length, limit: IP_MAX_ATTEMPTS };
}
function noteCodeFailure(db, codeHash) {
	const limits = pruneLimits(db);
	const rec = limits.codes[codeHash] || { count: 0, at: Date.now(), lockedAt: null };
	rec.count += 1;
	rec.at = Date.now();
	if (rec.count >= MAX_CODE_FAILS && !rec.lockedAt) { rec.lockedAt = Date.now(); limits.stats.lockedCodes += 1; }
	limits.codes[codeHash] = rec;
	return rec;
}
function codeLocked(db, codeHash) {
	const rec = pruneLimits(db).codes[codeHash];
	return Boolean(rec && rec.lockedAt);
}
function limitsView(db) {
	const limits = pruneLimits(db);
	const ipAttempts = Object.entries(limits.ip).map(([ip, stamps]) => ({ ip, attempts: stamps.length }));
	return {
		ipLimit: IP_MAX_ATTEMPTS,
		ipWindowMs: IP_WINDOW_MS,
		codeMaxFails: MAX_CODE_FAILS,
		ipAttempts: ipAttempts.sort((a, b) => b.attempts - a.attempts).slice(0, 8),
		ipBlocked: ipAttempts.filter((x) => x.attempts >= IP_MAX_ATTEMPTS).length,
		lockedCodes: Object.values(limits.codes).filter((x) => x.lockedAt).length,
		stats: limits.stats,
	};
}

/* ---------------- 对端 TLS（指纹钉住） ---------------- */
function certPemDerToPem(der) {
	const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
	return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}
function probePeerCert(host, port, timeout = 6000) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => { if (settled) return; settled = true; try { socket.destroy(); } catch {} resolve(value); };
		const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: "TLSv1.2", timeout });
		socket.once("secureConnect", () => {
			try {
				const x5 = typeof socket.getPeerX509Certificate === "function" ? socket.getPeerX509Certificate() : null;
				const der = x5 && x5.raw ? x5.raw : socket.getPeerCertificate()?.raw;
				if (!der) return done({ ok: false, error: "no-peer-cert" });
				done({ ok: true, fingerprint: fingerprintOf(der), certPem: certPemDerToPem(der) });
			} catch (err) { done({ ok: false, error: redact(err?.message ?? err) }); }
		});
		socket.once("error", (err) => done({ ok: false, error: redact(err?.code || err?.message || err) }));
		socket.once("timeout", () => done({ ok: false, error: "timeout" }));
	});
}
function peerTransport(node) {
	let target;
	try { target = new URL(node.viewUrl); } catch { return { ok: false, error: { code: "bad-peer-url", message: "对端地址无效" } }; }
	const isHttps = target.protocol === "https:";
	const host = target.hostname.replace(/^\[|\]$/g, "");
	const port = Number(target.port) || (isHttps ? 443 : 80);
	if (!isHttps) {
		if (node.certFingerprint || node.certPem) return { ok: false, error: { code: "insecure-transport", message: "对端已钉住 https 指纹，拒绝明文连接" } };
		return { ok: true, isHttps, host, port, origin: target.origin, options: {} };
	}
	if (!node.certPem) return { ok: false, error: { code: "no-pin", message: "未钉住对端证书指纹，请先点“生成配对码”记录指纹" } };
	const info = inspectCertificate(node.certPem);
	if (!info || String(node.certFingerprint || "") !== info.fingerprint) return { ok: false, error: { code: "pin-corrupt", message: "本机保存的指纹与证书不一致，请重新配对" } };
	return { ok: true, isHttps, host, port, origin: target.origin, options: { ca: [node.certPem], rejectUnauthorized: true, checkServerIdentity: () => undefined, servername: net.isIP(host) ? undefined : host, minVersion: "TLSv1.2" } };
}
async function pinMismatchError(node, expected) {
	const t = peerTransport(node);
	let actual = "";
	if (t.ok) { const probe = await probePeerCert(t.host, t.port); actual = probe.ok ? probe.fingerprint : ""; }
	return { code: "fingerprint-mismatch", message: `对端证书指纹不符（期望 ${fingerprintPrefix(expected, 6)}，实际 ${actual ? fingerprintPrefix(actual, 6) : "握手失败"}），已拒绝连接`, details: { expected, actual } };
}
function isTlsError(err) {
	const code = String(err?.code || "");
	return /CERT|TLS|SSL|SELF_SIGNED|VERIFY|ISSUER|ALTNAME/i.test(code) || /certificate|handshake/i.test(String(err?.message || ""));
}

async function loadSeams() {
	if (seams) return seams;
	try { seams = await import("@ericality/dsh-host-compat/seams"); } catch { seams = null; }
	return seams;
}

export async function capability(ctx) {
	const seam = await loadSeams();
	let compat = null;
	try { compat = await import("@ericality/dsh-host-compat"); } catch {}
	let result = null;
	if (compat && typeof compat.probe === "function") {
		try { result = compat.probe(REQUIRES, PLUGIN_ID, VERSION, ctx); } catch (err) { result = { state: "DEGRADED", missing: ["rpcHandle"], reason: String(err?.message ?? err) }; }
	}
	const seamOk = Boolean(seam && typeof seam.rpcHandle === "function");
	// 2026-11-21 修复：两条路由 seam 的可用性以中间件自身的服务状态为准（探测面在插件 ctx 里可能看不到 webServer）
	if (result && typeof seam?.webServerState === "function") {
		try {
			const ws = seam.webServerState();
			if (ws && Number(ws.port) > 0) guiPortObserved = Number(ws.port);
			if (ws && ws.ok && Array.isArray(result.missing)) result.missing = result.missing.filter((k) => k !== "webServerPrefix");
			if (ws && ws.upgrade && Array.isArray(result.missing)) result.missing = result.missing.filter((k) => k !== "webServerUpgrade");
			if (result.state !== "OK" && Array.isArray(result.missing) && result.missing.length === 0 && !(result.blocked || []).length) result.state = "OK";
			if (ws && (!ws.ok || !ws.upgrade)) result.reason = result.reason || "webServerRoute-unavailable";
		} catch {}
	}
	if (!result) result = seamOk ? { state: "OK", missing: [] } : { state: "DEGRADED", missing: ["rpcHandle"], reason: "host-compat-unavailable" };
	if (!seamOk) {
		result.state = result.state === "OK" ? "DEGRADED" : result.state;
		result.missing = [...new Set([...(result.missing || []), "rpcHandle"])];
		result.reason = result.reason || "seam-unavailable";
	}
	return { ...result, seams: seamOk, compat: Boolean(compat) };
}

/* ---------------- control state ---------------- */
/** 件26：本机对外地址（publicBase）。空=未配置；只接受 http(s)，裸域名按 https 补全；存 origin。 */
function normalizePublicBase(raw) {
	let s = String(raw === undefined || raw === null ? "" : raw).trim();
	if (!s) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
	try {
		const u = new URL(s);
		if (u.protocol !== "http:" && u.protocol !== "https:") return "";
		if (!u.hostname) return "";
		return u.origin;
	} catch { return ""; }
}
function isPrivateHost(host) {
	const h = String(host || "").replace(/^\[|\]$/g, "");
	if (/^10\./.test(h)) return true;
	if (/^192\.168\./.test(h)) return true;
	const m = /^172\.(\d{1,2})\./.exec(h);
	if (m) { const n = Number(m[1]); return n >= 16 && n <= 31; }
	return false;
}
function defaultSettings() {
	return { port: numberEnv("MESH_PANEL_PORT", 8470), bind: String(process.env.MESH_PANEL_BIND || "127.0.0.1").trim() || "127.0.0.1", protocol: String(process.env.MESH_PANEL_PROTOCOL || "https").trim() === "http" ? "http" : "https", maxConcurrency: 32, autoApprove: false, guiPort: 0, publicBase: "" };
}
function defaultState() {
	return { version: 3, instanceId: `inst-${crypto.randomBytes(4).toString("hex")}`, label: String(process.env.MESH_PANEL_LABEL || os.hostname() || "node"), settings: defaultSettings(), nodes: {}, pending: {} };
}
function ensureState() {
	if (state) return state;
	if (!STATE_FILE) { state = defaultState(); return state; }
	try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { state = defaultState(); }
	if (!state || typeof state !== "object") state = defaultState();
	const previousVersion = Number(state.version) || 1;
	state.nodes ||= {};
	state.pending ||= {};
	state.instanceId ||= `inst-${crypto.randomBytes(4).toString("hex")}`;
	if (!state.settings || typeof state.settings !== "object") state.settings = defaultSettings();
	state.settings.port = Number(state.settings.port) || LISTEN_PORT;
	state.settings.bind = String(state.settings.bind || LISTEN_BIND);
	// 件17 迁移：旧版默认是 http；升级到 v3 时一次性切到 https（明文需在面板显式改回）。
	if (previousVersion < 3) state.settings.protocol = "https";
	else state.settings.protocol = state.settings.protocol === "http" ? "http" : "https";
	state.settings.maxConcurrency = Math.min(1024, Math.max(1, Number(state.settings.maxConcurrency) || 32));
	if (typeof state.settings.autoApprove !== "boolean") state.settings.autoApprove = false;
	state.settings.guiPort = Number(state.settings.guiPort) > 0 && Number(state.settings.guiPort) < 65536 ? Number(state.settings.guiPort) : 0;
	state.settings.publicBase = normalizePublicBase(state.settings.publicBase);
	state.version = 3;
	state.label ||= String(process.env.MESH_PANEL_LABEL || os.hostname() || "node");
	for (const [id, node] of Object.entries(state.nodes)) {
		if (!node || typeof node !== "object" || !node.viewUrl) { delete state.nodes[id]; continue; }
		// 凭据不落明文：旧字段 refreshToken 直接丢弃；accessToken 由密文解出，只留在内存。
		delete node.refreshToken;
		if (node.accessTokenSealed && !node.accessToken) node.accessToken = openValue(node.accessTokenSealed);
		if (node.pendingTokenSealed && !node.pendingToken) node.pendingToken = openValue(node.pendingTokenSealed);
		if (node.certFingerprint) node.certFingerprint = String(node.certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, "");
		if (node.certFingerprint && !node.certPem) { node.certFingerprint = ""; node.certPem = ""; }
		// 件23 迁移：旧节点没有地址来源，保守记为手动（自动更新一律不碰），用户可在面板“交给自动”。
		if (node.addressSource !== "manual" && node.addressSource !== "observed") node.addressSource = "manual";
	}
	for (const p of Object.values(state.pending || {})) {
		if (p?.from?.token) { p.from.tokenHash = tokenHashOf(p.from.token); delete p.from.token; }
		if (p?.result?.tokenSealed && !p.result.token) p.result.token = openValue(p.result.tokenSealed);
	}
	return state;
}
function serializableState() {
	const copy = JSON.parse(JSON.stringify(ensureState()));
	for (const node of Object.values(copy.nodes || {})) {
		if (node.accessToken) node.accessTokenSealed = sealValue(node.accessToken);
		if (node.pendingToken) node.pendingTokenSealed = sealValue(node.pendingToken);
		delete node.pendingToken;
		delete node.accessToken;
		delete node.refreshToken;
		delete node.tokenHash;
	}
	for (const p of Object.values(copy.pending || {})) {
		if (p?.result?.token) { p.result.tokenSealed = sealValue(p.result.token); delete p.result.token; }
		if (p?.from?.token) delete p.from.token;
	}
	return copy;
}
function saveState() {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		const tmp = `${STATE_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify(serializableState(), null, 1), { mode: 0o600 });
		renameSync(tmp, STATE_FILE);
		chmodSync(STATE_FILE, 0o600);
		lastSaveError = "";
		return true;
	} catch (err) {
		lastSaveError = redact(err?.message ?? err);
		return false;
	}
}
/** 写盘自检：目录可否创建/写入；返回诊断给面板与 set-settings 用。 */
function probeWritable() {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		const probe = join(DATA_DIR, `.write-probe-${process.pid}`);
		writeFileSync(probe, "ok", { mode: 0o600 });
		unlinkSync(probe);
		return { writable: true, error: "" };
	} catch (err) {
		return { writable: false, error: redact(err?.message ?? err) };
	}
}
function stateInfo() {
	const w = probeWritable();
	return {
		home: DSH_HOME,
		homeSource: HOME_SOURCE,
		dir: DATA_DIR,
		file: STATE_FILE,
		exists: existsSync(STATE_FILE),
		writable: w.writable,
		writeError: w.error,
		lastSaveError,
	};
}

/* ---------------- peer state (本机作为对端) ---------------- */
function defaultPeerState() {
	return { version: 2, peers: {}, codes: {}, limits: { ip: {}, codes: {}, stats: { redemptions: 0, blocked: 0, lockedCodes: 0, lastBlockedAt: null } }, stats: { codes: 0, redeems: 0, authorizes: 0, deletes: 0 } };
}
function ensurePeerState() {
	if (peerState) return peerState;
	if (!PEER_STATE_FILE) { peerState = defaultPeerState(); return peerState; }
	try { peerState = JSON.parse(readFileSync(PEER_STATE_FILE, "utf8")); } catch { peerState = defaultPeerState(); }
	peerState.peers ||= {};
	peerState.codes ||= {};
	peerState.stats ||= { codes: 0, redeems: 0, authorizes: 0, deletes: 0 };
	peerState.version = 2;
	// 迁移：入站 token 只留哈希；配对码只留哈希。
	for (const rec of Object.values(peerState.peers)) {
		if (!rec || typeof rec !== "object") continue;
		if (rec.accessToken && !rec.tokenHash) rec.tokenHash = tokenHashOf(rec.accessToken);
		delete rec.accessToken;
	}
	const codes = {};
	for (const [key, rec] of Object.entries(peerState.codes)) {
		if (/^[0-9a-f]{64}$/.test(key)) codes[key] = rec;
		else if (/^\d{6}$/.test(key)) codes[codeHashOf(key)] = { ...(rec || {}), hash: codeHashOf(key) };
	}
	peerState.codes = codes;
	peerState.limits ||= { ip: {}, codes: {}, stats: { redemptions: 0, blocked: 0, lockedCodes: 0, lastBlockedAt: null } };
	pruneLimits(peerState);
	return peerState;
}
function savePeerState() {
	if (!PEER_STATE_FILE) return false;
	try {
		mkdirSync(dirname(PEER_STATE_FILE), { recursive: true });
		const tmp = `${PEER_STATE_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify(ensurePeerState(), null, 1), { mode: 0o600 });
		renameSync(tmp, PEER_STATE_FILE);
		chmodSync(PEER_STATE_FILE, 0o600);
		return true;
	} catch { return false; }
}

/* ---------------- 校验与地址推导 ---------------- */
function normalizeHost(raw) {
	const s = String(raw || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
	if (!s) return "";
	if (!/^[A-Za-z0-9._:\-\[\]]+$/.test(s)) return "";
	if (s.length > 120) return "";
	return s;
}
function normalizePort(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return LISTEN_PORT;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}
function deriveUrls(protocol, host, port) {
	const p = protocol === "https" ? "https" : "http";
	const hp = port === 80 && p === "http" || port === 443 && p === "https" ? host : `${host}:${port}`;
	return { origin: `${p}://${hp}`, viewUrl: `${p}://${hp}/`, controlBase: `${p}://${hp}/ctl` };
}

/* ---------------- 对端 HTTP（https 走指纹钉住） ---------------- */
async function httpJson(node, path, body, opts = {}) {
	const t = peerTransport(node);
	if (!t.ok) return { ok: false, status: 0, error: t.error };
	const url = new URL(String(path || "/").replace(/^\/+/, ""), node.viewUrl.endsWith("/") ? node.viewUrl : `${node.viewUrl}/`);
	const headers = { "content-type": "application/json", ...(opts.headers || {}) };
	if (opts.token) headers["x-mesh-token"] = opts.token;
	const payload = body === undefined ? undefined : JSON.stringify(body);
	if (payload) headers["content-length"] = Buffer.byteLength(payload);
	const timeout = opts.timeout || PEER_TIMEOUT_MS;
	const lib = t.isHttps ? https : http;
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
		let req;
		try {
			req = lib.request({ host: t.host, port: t.port, method: body === undefined ? "GET" : "POST", path: `${url.pathname}${url.search}`, headers, ...t.options }, (res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
				res.on("end", () => {
					let json = null;
					try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
					if (!json || typeof json !== "object") return finish({ ok: false, status: res.statusCode || 0, error: { code: "bad-json", message: `HTTP ${res.statusCode}` } });
					if (json.ok === false) return finish({ ok: false, status: res.statusCode || 0, error: json.error || { code: "peer-error", message: `HTTP ${res.statusCode}` } });
					finish({ ok: true, status: res.statusCode || 0, value: json.value === undefined ? json : json.value, raw: json });
				});
				res.on("error", (err) => finish({ ok: false, status: 0, error: { code: "response-error", message: redact(err?.message ?? err) } }));
			});
		} catch (err) { return finish({ ok: false, status: 0, error: { code: "request-error", message: redact(err?.message ?? err) } }); }
		req.setTimeout(timeout, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
		req.on("error", async (err) => {
			if (isTlsError(err)) {
				const expected = String(node.certFingerprint || "");
				const snapped = await pinMismatchError(node, expected);
				if (snapped.details?.actual && snapped.details.actual === expected) return finish({ ok: false, status: 0, error: { code: "tls-error", message: `TLS 握手失败：${redact(err?.code || err?.message || err)}` } });
				return finish({ ok: false, status: 0, error: snapped });
			}
			if (err.code === "ETIMEDOUT") return finish({ ok: false, status: 0, error: { code: "timeout", message: `对端超时（${timeout}ms）` } });
			finish({ ok: false, status: 0, error: { code: "unreachable", message: redact(err?.code || err?.message || err) } });
		});
		if (payload) req.write(payload);
		req.end();
	});
}

/* ---------------- 本机 GUI 反代（仅 B 面） ---------------- */
const TOKEN_NAMES = [".dsh-launch-token", "dsh-launch-token"];
let launchTokenCache = { token: "", path: "", searched: [], at: 0 };
function launchTokenCandidates() {
	const dirs = [DSH_HOME, join(os.homedir(), ".dsh"), os.homedir()];
	if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "dsh"), join(process.env.APPDATA, "DeepSeek Harness"), join(process.env.APPDATA, "dsh-desktop"));
	if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "dsh"), join(process.env.LOCALAPPDATA, "DeepSeek Harness"));
	const out = [];
	for (const dir of dirs) for (const name of TOKEN_NAMES) {
		const p = join(dir, name);
		if (!out.includes(p)) out.push(p);
	}
	return out;
}
function launchTokenInfo(force) {
	if (!force && launchTokenCache.at && Date.now() - launchTokenCache.at < 5000) return launchTokenCache;
	const envToken = String(process.env.DSH_LAUNCH_TOKEN || "").trim();
	if (envToken) { launchTokenCache = { token: envToken, path: "$DSH_LAUNCH_TOKEN", searched: [], at: Date.now() }; return launchTokenCache; }
	const searched = launchTokenCandidates();
	for (const p of searched) {
		try {
			const t = readFileSync(p, "utf8").trim();
			if (t) { launchTokenCache = { token: t, path: p, searched, at: Date.now() }; return launchTokenCache; }
		} catch {}
	}
	launchTokenCache = { token: "", path: "", searched, at: Date.now() };
	return launchTokenCache;
}
function readLaunchToken() { return launchTokenInfo().token; }
let browserSecretCache = { value: null, at: 0 };
/** 读 .credentials.yaml 里 client-connection/browser-session 的签名密钥（base64url，32 字节）。 */
function browserSessionSecret() {
	if (browserSecretCache.at && Date.now() - browserSecretCache.at < 30_000) return browserSecretCache.value;
	let secret = null;
	try {
		const text = readFileSync(join(DSH_HOME, ".credentials.yaml"), "utf8");
		const lines = text.split(/\r?\n/);
		let inRecord = false;
		let inPayload = false;
		for (const raw of lines) {
			const line = raw.replace(/\s+$/, "");
			if (/^  client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; inPayload = false; continue; }
			if (inRecord && /^    payload:\s*$/.test(line)) { inPayload = true; continue; }
			if (inPayload) {
				const m = line.match(/^      secret:\s*(.+?)\s*$/);
				if (m) {
					const rawSecret = m[1].replace(/^["']|["']$/g, "");
					if (/^[A-Za-z0-9_-]{40,}$/.test(rawSecret)) {
						const buf = Buffer.from(rawSecret.replaceAll("-", "+").replaceAll("_", "/"), "base64");
						if (buf.byteLength === 32) secret = buf;
					}
					break;
				}
			}
			if (inRecord && /^  \S/.test(line) && !/^  client-connection/.test(line)) inRecord = false;
		}
	} catch { secret = null; }
	browserSecretCache = { value: secret, at: Date.now() };
	return secret;
}
function b64url(value) {
	return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
/** 按宿主格式自签 dsh-auth-<authority> cookie；authority 固定 127.0.0.1:<guiPort>（只注入回环上游）。 */
function mintBrowserCookie() {
	const secret = browserSessionSecret();
	const port = guiPort();
	if (!secret || !port) return "";
	const authority = `127.0.0.1:${port}`;
	const name = `dsh-auth-${b64url(crypto.createHash("sha256").update(authority).digest())}`;
	const now = Date.now();
	const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 };
	const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
	const signature = b64url(crypto.createHmac("sha256", secret).update(body).digest());
	return `${name}=v1.${body}.${signature}`;
}
async function exchangeGuiCookie(force) {
	if (!guiPort()) throw new Error("no-gui-port");
	if (!force && guiCookie.value && Date.now() - guiCookie.at < 3_600_000) return guiCookie.value;
	// ① 自签 browser-session cookie（Windows 桌面无 launch token 时靠它）
	try {
		const minted = mintBrowserCookie();
		if (minted) { guiCookie = { value: minted, at: Date.now() }; guiExchangeError = ""; return minted; }
	} catch {}
	// ② 退到 launch token 换 cookie
	const token = readLaunchToken();
	if (!token) {
		guiExchangeError = "no-credential";
		throw new Error("no-credential");
	}
	const res = await fetch(`http://127.0.0.1:${guiPort()}/?token=${encodeURIComponent(token)}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
	const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
	const jar = setCookie.map((c) => c.split(";")[0]).filter((c) => c.startsWith("dsh-auth-"));
	if (!jar.length) {
		guiExchangeError = `no-cookie:HTTP ${res.status}`;
		throw new Error(guiExchangeError);
	}
	guiCookie = { value: jar.join("; "), at: Date.now() };
	guiExchangeError = "";
	return guiCookie.value;
}
function upstreamHeaders(req, cookie) {
	const out = { ...req.headers };
	delete out.cookie;
	delete out.host;
	delete out.origin;
	delete out.referer;
	delete out["accept-encoding"];
	out.host = `127.0.0.1:${guiPort()}`;
	if (cookie) out.cookie = cookie;
	return out;
}
function proxyHttp(req, res) {
	if (!guiPort()) {
		res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
		res.end("无法确定本机 GUI 端口：宿主 webServer 没有提供端口，也不再猜测 3081。请在面板“本机设置 → GUI 端口（反代）”手动填写当前端口。\n");
		return;
	}
	let portRetried = false;
	const go = (force) => {
		exchangeGuiCookie(force).then((cookie) => {
			const up = http.request({ host: "127.0.0.1", port: guiPort(), path: req.url, method: req.method, headers: upstreamHeaders(req, cookie) }, (upRes) => {
				if (upRes.statusCode === 401 && !force) { upRes.resume(); return go(true); }
				const out = { ...upRes.headers };
				delete out["set-cookie"];
				if (out.location && /^http:\/\/127\.0\.0\.1:/.test(out.location)) out.location = out.location.replace(/^http:\/\/127\.0\.0\.1:\d+/, `http://${req.headers.host || `127.0.0.1:${LISTEN_PORT}`}`);
				res.writeHead(upRes.statusCode || 502, out);
				upRes.pipe(res);
			});
			up.on("error", (err) => {
				if (!res.headersSent && !portRetried && (err?.code === "ECONNREFUSED" || err?.code === "EHOSTUNREACH")) {
					portRetried = true;
					relayLogAdd("warn", `gui upstream ${guiPort()} refused; re-probing GUI port`);
					resolveGuiPort(true).then(() => go(false)).catch(() => {
						if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
						res.end(`本机 GUI 反代失败：连不上 127.0.0.1:${guiPort()}。请确认桌面端 GUI 端口（Windows 常见 8091）。\n`);
					});
					return;
				}
				if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end(`本机 GUI 反代失败：连不上 127.0.0.1:${guiPort()}（${String(err?.code || err?.message || err)}）。请确认桌面端 GUI 端口（Windows 常见 8091）；0.4.5+ 会自动探测。\n`);
			});
			req.pipe(up);
		}).catch(() => {
			if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
			const info = launchTokenInfo(true);
			res.end(`本机 GUI 反代不可用：既没有可用的 browser-session 签名密钥（.credentials.yaml），也没有 launch token。已查 token 路径：${(info.searched || []).join("；") || "无候选路径"}。请从 DSH 界面直接用“打开”按钮（会改为直连对端）。\n`);
		});
	};
	go(false);
}
function proxyUpgrade(req, socket, head) {
	exchangeGuiCookie(false).then((cookie) => {
		const headers = upstreamHeaders(req, cookie);
		headers.connection = "Upgrade";
		headers.upgrade = req.headers.upgrade || "websocket";
		const up = http.request({ host: "127.0.0.1", port: guiPort(), path: req.url, method: "GET", headers }, (upRes) => {
			socket.write(`HTTP/1.1 ${upRes.statusCode || 502} ${upRes.statusMessage || "OK"}\r\n`);
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (k === "set-cookie") continue;
				if (Array.isArray(v)) for (const x of v) socket.write(`${k}: ${x}\r\n`);
				else socket.write(`${k}: ${v}\r\n`);
			}
			socket.write("\r\n");
			upRes.pipe(socket); socket.pipe(upRes);
		});
		up.on("upgrade", (upRes, upSocket, upHead) => {
			socket.write(`HTTP/1.1 101 ${upRes.statusMessage || "Switching Protocols"}\r\n`);
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (k === "set-cookie") continue;
				if (Array.isArray(v)) for (const x of v) socket.write(`${k}: ${x}\r\n`);
				else socket.write(`${k}: ${v}\r\n`);
			}
			socket.write("\r\n");
			if (upHead && upHead.length) socket.write(upHead);
			if (head && head.length) upSocket.write(head);
			upSocket.pipe(socket); socket.pipe(upSocket);
		});
		up.on("error", () => socket.destroy());
		up.end();
		socket.on("error", () => up.destroy());
	}).catch(() => socket.destroy());
}

/* ---------------- B 面：/health、/pair、/ctl/* ---------------- */
function jsonReply(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff" });
	res.end(body);
}
function readBody(req, limit = MAX_BODY) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let done = false;
		const finish = (value) => { if (!done) { done = true; resolve(value); } };
		req.on("data", (c) => {
			if (done) return;
			size += c.length;
			if (size > limit) { finish({ ok: false, code: "too-large", size }); req.resume(); return; }
			chunks.push(c);
		});
		req.on("end", () => {
			if (done) return;
			try { finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }); }
			catch { finish({ ok: true, value: {} }); }
		});
		req.on("error", () => finish({ ok: false, code: "read-error" }));
	});
}
function tokenOf(req) {
	const h = String(req.headers["x-mesh-token"] || "");
	if (h) return h;
	const a = String(req.headers.authorization || "");
	return a.startsWith("Bearer ") ? a.slice(7) : "";
}
function peerCertOf(req) {
	try {
		const x5 = typeof req?.socket?.getPeerX509Certificate === "function" ? req.socket.getPeerX509Certificate() : null;
		const der = x5 && x5.raw ? x5.raw : req?.socket?.getPeerCertificate?.()?.raw;
		if (!der) return null;
		return { fingerprint: fingerprintOf(der), certPem: certPemDerToPem(der) };
	} catch { return null; }
}
function advertisedAddress() { return reportedHostOf(String(process.env.MESH_PANEL_PUBLIC || "").trim()) ? String(process.env.MESH_PANEL_PUBLIC || "").trim() : ""; }
function healthValue(req) {
	const st = ensureState();
	const fp = certFingerprint();
	return {
		nodeId: st.instanceId,
		fingerprint: fp,
		certFingerprint: displayFingerprint(fp),
		certFingerprintPrefix: fingerprintPrefix(fp, 6),
		instanceFingerprint: crypto.createHash("sha256").update(`${st.instanceId}|${VERSION}`).digest("hex").slice(0, 16),
		version: VERSION,
		port: listener.port,
		protocol: listener.protocol,
		tls: listener.protocol === "https",
		pinning: "sha256-of-der",
		label: st.label,
		// 件23/26：自动地址来源之一——优先设置的 publicBase，其次 MESH_PANEL_PUBLIC。
		address: st.settings.publicBase || advertisedAddress(),
		publicBase: st.settings.publicBase || "",
		// 件23：连接来源——请求方在本次连接里被看到的地址（对端据此校正本机地址）。
		observedFrom: req ? peerIpOf(req) : "",
		gui: true,
		hasLaunchToken: Boolean(readLaunchToken()),
		hasBrowserSecret: Boolean(browserSessionSecret()),
		canProxyGui: Boolean(readLaunchToken() || browserSessionSecret()),
	};
}
async function handleB(req, res, pathname) {
	if (pathname === "/health" && req.method === "GET") {
		return jsonReply(res, 200, { ok: true, value: healthValue(req) });
	}
	if (pathname === "/pair" && req.method === "POST") {
		const db = ensurePeerState();
		const ip = peerIpOf(req);
		const rate = checkPairRate(db, ip);
		if (!rate.ok) {
			savePeerState();
			return jsonReply(res, 429, { ok: false, error: { code: "rate-limited", message: `同一 IP 每分钟最多 ${rate.limit} 次配对尝试，请稍后再试`, details: rate } });
		}
		const parsed = await readBody(req);
		if (!parsed.ok) return jsonReply(res, 413, { ok: false, error: { code: parsed.code || "too-large", message: `请求体超过 ${MAX_BODY} 字节` } });
		const body = parsed.value || {};
		if (body && body.code) {
			const r = await peerRedeem(String(body.code), body.from || {}, req);
			if (!r.ok) savePeerState();
			return jsonReply(res, r.ok ? 200 : (r.status || 400), r.ok ? { ok: true, value: r } : { ok: false, error: r.error });
		}
		const r = await peerCode(req.headers.host || "");
		return jsonReply(res, r.ok ? 200 : 500, r.ok ? { ok: true, value: r } : { ok: false, error: r.error });
	}
	if (pathname === "/pair/request" && req.method === "POST") {
		const parsed = await readBody(req);
		if (!parsed.ok) return jsonReply(res, 413, { ok: false, error: { code: parsed.code || "too-large", message: `请求体超过 ${MAX_BODY} 字节` } });
		const body = parsed.value || {};
		const from = body.from || {};
		if (!from.instanceId || !from.token) return jsonReply(res, 400, { ok: false, error: { code: "bad-request" } });
		const st = ensureState();
		const cert = peerCertOf(req);
		const id = crypto.randomUUID();
		st.pending[id] = {
			id,
			from: { instanceId: String(from.instanceId).slice(0, 80), label: String(from.label || "").slice(0, 60), address: peerEndpoint(from, req.socket?.remoteAddress).viewUrl, reportedAddress: String(from.address || ""), tokenHash: tokenHashOf(from.token), certFingerprint: (cert && cert.fingerprint) || normalizeFp(from.certFingerprint), certPem: String(from.certPem || "") },
			fingerprint: fingerprint(),
			at: Date.now(),
			status: "pending",
			result: null,
		};
		saveState();
		return jsonReply(res, 200, { ok: true, value: { requestId: id, status: "pending" } });
	}
	if (pathname === "/pair/result" && req.method === "GET") {
		let id = "";
		try { id = new URL(req.url || "/", "http://x").searchParams.get("id") || ""; } catch {}
		const st = ensureState();
		const p = st.pending[id];
		if (!p) return jsonReply(res, 404, { ok: false, error: { code: "unknown-request" } });
		const value = { status: p.status };
		if (p.status === "approved" && p.result) {
			Object.assign(value, p.result);
			if (value.tokenSealed) { value.token = openValue(value.tokenSealed); delete value.tokenSealed; }
		}
		return jsonReply(res, 200, { ok: true, value });
	}
	if (pathname.startsWith("/ctl/")) return handleCtl(req, res, pathname);
	return null;
}
/** 件23：控制面统一入口——鉴权先于一切读写；GET 只开 health/logs（日志只读、无命令面），命令一律 POST。 */
function queryOf(req) {
	try { return new URL(req.url || "/", "http://x").searchParams; } catch { return new URLSearchParams(); }
}
async function handleCtl(req, res, pathname) {
	const token = tokenOf(req);
	const q = queryOf(req);
	let body = {};
	if (req.method === "POST") {
		const parsed = await readBody(req);
		if (!parsed.ok) return jsonReply(res, 413, { ok: false, error: { code: parsed.code || "too-large", message: `请求体超过 ${MAX_BODY} 字节` } });
		body = parsed.value || {};
	} else if (req.method !== "GET") {
		return jsonReply(res, 405, { ok: false, error: { code: "method-not-allowed", message: "控制面只接受 GET（health/logs）与 POST（命令）" } });
	}
	const peerId = String(body?.peerId || q.get("peerId") || "");
	const db = ensurePeerState();
	const rec = peerId ? db.peers[peerId] : null;
	// 判据 4：无 token / 无 peerId / 未登记 / 哈希不符一律 401，且在读取任何文件之前。
	if (!token || !peerId || !rec || !safeEqual(tokenHashOf(token), rec.tokenHash)) {
		return jsonReply(res, 401, { ok: false, error: { code: "unauthorized" } });
	}
	const cert = peerCertOf(req);
	if (cert && rec.certFingerprint !== cert.fingerprint) { rec.certFingerprint = cert.fingerprint; }
	// 件23：已鉴权的入站请求＝一次“连接来源”观测；异步校正自动地址（不阻塞响应）。
	noteObservedPeer(req, rec, peerId).catch(() => {});
	const op = pathname.slice(5);
	if (req.method === "GET") {
		if (op === "health") return jsonReply(res, 200, { ok: true, value: { peerId, online: true, version: VERSION } });
		if (op === "logs") return jsonReply(res, 200, { ok: true, value: logsValue(q) });
		return jsonReply(res, 405, { ok: false, error: { code: "read-only", message: `GET /ctl/${op} 不可用；日志面只读` } });
	}
	if (op === "authorize") {
		db.stats.authorizes++;
		savePeerState();
		return jsonReply(res, 200, { ok: true, value: { peerId, online: true } });
	}
	if (op === "revoke") {
		delete db.peers[peerId];
		db.stats.deletes++;
		savePeerState();
		purgePeer(peerId);
		saveState();
		return jsonReply(res, 200, { ok: true, value: { peerId, revoked: true } });
	}
	if (op === "logs") return jsonReply(res, 405, { ok: false, error: { code: "read-only", message: "日志面只读：只有 GET /ctl/logs，没有写入/清除/命令能力" } });
	if (op === "health") return jsonReply(res, 200, { ok: true, value: { peerId, online: true, version: VERSION } });
	return jsonReply(res, 404, { ok: false, error: { code: "unknown-ctl-op", op } });
}
/* ---------------- 件23：只读日志面（脱敏、无命令能力、路径与大小可见） ---------------- */
function meshLogLines() {
	const file = join(DATA_DIR, "mesh.log");
	let size = 0;
	let text = "";
	try { size = statSync(file).size; text = readFileSync(file, "utf8"); } catch { return { file, size: 0, lines: [] }; }
	const lines = [];
	for (const raw of text.split(/\r?\n/)) {
		if (!raw) continue;
		const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(info|warn|error|debug)\s+([\s\S]*)$/.exec(raw);
		if (m) lines.push({ at: m[1], level: m[2], message: redact(m[3]) });
		else lines.push({ at: "", level: "raw", message: redact(raw) });
	}
	return { file, size, lines };
}
function logsValue(q) {
	const limit = Math.min(LOG_LINES_MAX, Math.max(1, Number(q.get("limit")) || LOG_LINES_DEFAULT));
	const since = String(q.get("since") || "").trim().slice(0, 40);
	const info = meshLogLines();
	let lines = info.lines;
	if (since) lines = lines.filter((l) => !l.at || l.at > since);
	const totalLines = lines.length;
	lines = lines.slice(-limit);
	const rotated = `${info.file}.1`;
	let rotatedSize = 0;
	try { rotatedSize = statSync(rotated).size; } catch {}
	return {
		path: info.file,
		sizeBytes: info.size,
		rotatedPath: rotatedSize ? rotated : "",
		rotatedSizeBytes: rotatedSize,
		redacted: true,
		readOnly: true,
		limit,
		totalLines,
		returned: lines.length,
		since: since || null,
		nextSince: lines.length ? lines[lines.length - 1].at : (since || null),
		fetchedAt: new Date().toISOString(),
		lines,
	};
}
function makePeerCode(hostHeader) {
	const db = ensurePeerState();
	const now = Date.now();
	// 清理过期码（只留哈希，状态文件没有明文）
	for (const [key, rec] of Object.entries(db.codes)) if (!rec || now > Number(rec.expiresAt || 0)) delete db.codes[key];
	let code;
	let codeHash;
	for (;;) {
		code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
		codeHash = codeHashOf(code);
		if (!db.codes[codeHash]) break;
	}
	const ttlMs = 300_000;
	const expiresAt = now + ttlMs;
	db.codes[codeHash] = { hash: codeHash, createdAt: now, expiresAt, usedAt: null, fails: 0 };
	db.stats.codes++;
	savePeerState();
	const host = String(hostHeader || "").replace(/:\d+$/, "") || os.hostname();
	const fp = certFingerprint();
	const publicBase = ensureState().settings.publicBase || "";
	return { code, host, port: listener.port, protocol: listener.protocol, ttlMs, expiresAt, certFingerprint: fp, certFingerprintDisplay: displayFingerprint(fp), fingerprintPrefix: fingerprintPrefix(fp, 6), publicBase, displayAddress: publicBase || `${host}:${listener.port}` };
}
async function peerCode(hostHeader) {
	return { ok: true, ...makePeerCode(hostHeader) };
}
async function peerRedeem(code, from, req) {
	const db = ensurePeerState();
	const codeHash = codeHashOf(code);
	if (codeLocked(db, codeHash)) return { ok: false, status: 423, error: { code: "code-locked", message: `该配对码错误次数已达 ${MAX_CODE_FAILS} 次，已作废；请重新生成配对码` } };
	const c = db.codes[codeHash];
	if (!c) { noteCodeFailure(db, codeHash); return { ok: false, status: 404, error: { code: "unknown-code", message: "配对码不存在" } }; }
	if (c.usedAt || c.claimedAt) return { ok: false, status: 409, error: { code: "code-used", message: "配对码已被使用或正在等待确认" } };
	if (Date.now() > c.expiresAt) return { ok: false, status: 410, error: { code: "code-expired", message: "配对码已过期" } };
	if (!from || !from.instanceId || !from.token) {
		const rec = noteCodeFailure(db, codeHash);
		return { ok: false, status: 400, error: { code: "missing-from", message: `配对请求缺少身份（本码已错 ${rec.count}/${MAX_CODE_FAILS} 次）` } };
	}
	const st = ensureState();
	const myToken = newToken();
	const cert = peerCertOf(req);
	const peerFp = (cert && cert.fingerprint) || normalizeFp(from.certFingerprint);
	const peerCert = String(from.certPem || "");
	const endpoint = peerEndpoint(from, req?.socket?.remoteAddress);
	const viewUrl = endpoint.viewUrl;
	// 件20：默认两步——先在对端生成待确认卡片，确认后才建立（设置 autoApprove 才直接通过）。
	if (!st.settings.autoApprove) {
		const id = crypto.randomUUID();
		st.pending[id] = {
			id,
			via: "code",
			codeHash,
			from: { instanceId: String(from.instanceId).slice(0, 80), label: String(from.label || "peer").slice(0, 60), address: viewUrl, reportedAddress: endpoint.reportedAddress, addressUnreliable: endpoint.addressUnreliable, tokenHash: tokenHashOf(from.token), certFingerprint: peerFp, certPem: peerCert, listenPort: Number(from.listenPort) || 0, protocol: String(from.protocol || "") === "http" ? "http" : "https" },
			fingerprint: fingerprint(),
			at: Date.now(),
			status: "pending",
			result: null,
		};
		c.claimedAt = Date.now();
		db.stats.redeems++;
		savePeerState();
		saveState();
		const fp0 = certFingerprint();
		return { ok: true, status: "pending", pending: true, requestId: id, instanceId: st.instanceId, label: st.label, certFingerprint: fp0, certFingerprintDisplay: displayFingerprint(fp0), fingerprintPrefix: fingerprintPrefix(fp0, 6), protocol: listener.protocol, listenPort: listener.port };
	}
	db.peers[from.instanceId] = { peerId: from.instanceId, tokenHash: tokenHashOf(from.token), certFingerprint: (cert && cert.fingerprint) || normalizeFp(from.certFingerprint), listenPort: Number(from.listenPort) || 0, protocol: String(from.protocol || "") === "http" ? "http" : "https", createdAt: Date.now() };
	c.host = c.host || "";
	c.usedAt = Date.now();
	c.fails = Number(c.fails || 0);
	db.stats.redeems++;
	savePeerState();
	const node = upsertPeerNode({ peerId: from.instanceId, label: String(from.label || "peer").slice(0, 60), viewUrl, token: myToken, pairedAt: new Date().toISOString(), certFingerprint: peerFp, certPem: peerCert });
	const fp = certFingerprint();
	return { ok: true, instanceId: st.instanceId, label: st.label, token: myToken, fingerprint: fp, certFingerprint: fp, certFingerprintDisplay: displayFingerprint(fp), fingerprintPrefix: fingerprintPrefix(fp, 6), protocol: listener.protocol, node: publicNode(node, "online"), listenPort: listener.port };
}
/* ---------------- 双向身份与地址 ---------------- */
function selfInfo(req) {
	const st = ensureState();
	const addr = st.settings.publicBase || String(process.env.MESH_PANEL_PUBLIC || "").trim();
	let material = null;
	try { material = ensureTls(); } catch {}
	const tlsOn = String(st?.settings?.protocol || "https") === "https";
	return {
		instanceId: st.instanceId,
		label: st.label,
		listenPort: listener.port,
		address: addr || null,
		publicBase: st.settings.publicBase || "",
		protocol: listener.protocol,
		certFingerprint: material ? material.fingerprint : "",
		certPem: material && tlsOn ? material.cert : "",
	};
}
function normalizeFp(value) { const hex = String(value || "").toLowerCase().replace(/[^0-9a-f]/g, ""); return hex.length === 64 ? hex : ""; }
function reportedHostOf(raw) {
	let value = String(raw || "").trim();
	if (!value) return "";
	value = value.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
	const m = value.match(/^\[([^\]]+)\](?::\d+)?$/);
	if (m) return m[1];
	const idx = value.lastIndexOf(":");
	if (idx > -1 && value.indexOf(":") === idx) value = value.slice(0, idx);
	return value;
}
/** 容器网段/链路本地：谁报的都不能当对端可达地址。 */
function isBridgeHost(host) {
	const h = String(host || "").replace(/^\[|\]$/g, "");
	if (!h) return true;
	if (h === "0.0.0.0" || h === "::") return true;
	if (/^169\.254\./.test(h)) return true;
	if (/^172\.(1[7-9]|2\d|3[01])\./.test(h)) return true;
	if (/^fe80:/i.test(h)) return true;
	return false;
}
/** 回环/桥地址：对端自报时不可信；观测到的回环（同机）可用。 */
function isUnreliableHost(host) {
	const h = String(host || "").replace(/^\[|\]$/g, "");
	if (isBridgeHost(h)) return true;
	if (h === "localhost" || h === "::1") return true;
	if (/^127\./.test(h)) return true;
	return false;
}
function fmtHost(host) { return String(host).includes(":") ? `[${host}]` : String(host); }
function peerEndpoint(from, remoteAddress) {
	const scheme = from?.protocol === "https" ? "https" : "http";
	const port = Number(from?.listenPort) || listener.port;
	const reported = String(from?.address || "").trim();
	const observed = String(remoteAddress || "").replace(/^::ffff:/, "");
	const reportedHost = reportedHostOf(reported);
	const observedHost = observed.replace(/^\[|\]$/g, "");
	let host = "";
	// 观测到的回环是真实的同机地址；观测到的桥地址是 NAT 网关，不是对端 → 仍拒绝。
	if (observedHost && !isBridgeHost(observedHost)) host = observedHost;
	else if (reportedHost && !isUnreliableHost(reportedHost)) host = reportedHost;
	const viewUrl = host ? `${scheme}://${fmtHost(host)}:${port}/` : "";
	return { viewUrl, reportedAddress: reported, observedAddress: observedHost, addressUnreliable: !host };
}
function originOf(url) {
	try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ""; }
}
/* ---------------- 件23：地址口径（手动优先，自动需旧 token 仍被接受） ---------------- */
function parseViewUrl(viewUrl) {
	try {
		const u = new URL(viewUrl);
		const protocol = u.protocol.replace(":", "") === "https" ? "https" : "http";
		const host = u.hostname.replace(/^\[|\]$/g, "");
		const port = Number(u.port) || (protocol === "https" ? 443 : 80);
		return { host, port, protocol };
	} catch { return null; }
}
/** 自动地址候选只排除容器桥/链路本地/通配；回环是合法连接来源（同机部署）。 */
function autoHostOf(host) {
	const h = String(host || "").replace(/^\[|\]$/g, "").trim();
	if (!h || isBridgeHost(h) || h === "0.0.0.0") return "";
	return h;
}
/** 对端 /health 给的地址字段（MESH_PANEL_PUBLIC）优先，其次连接来源。 */
function deriveFromHealth(node, health, dialedHost) {
	const v = health || {};
	const rawProtocol = String(v.protocol || "").toLowerCase();
	const protocol = rawProtocol === "http" ? "http" : (rawProtocol === "https" ? "https" : (String(node.protocol) === "http" ? "http" : "https"));
	const port = Number(v.port) > 0 && Number(v.port) < 65536 ? Number(v.port) : Number(node.port) || LISTEN_PORT;
	const host = autoHostOf(reportedHostOf(String(v.address || ""))) || autoHostOf(dialedHost) || autoHostOf(node.host);
	if (!host) return null;
	return { host, port, protocol, ...deriveUrls(protocol, host, port) };
}
function applyAutoAddress(node, candidate, reason) {
	if (!candidate || node.addressSource === "manual") return null;
	if (candidate.viewUrl === node.viewUrl) return null;
	if (node.certFingerprint && candidate.protocol === "http") {
		relayLogAdd("warn", `auto-address 拒绝降级明文 node=${node.id}（已钉住 https 指纹）`);
		return { skipped: "downgrade" };
	}
	const from = node.viewUrl;
	node.host = candidate.host;
	node.port = candidate.port;
	node.protocol = candidate.protocol;
	node.viewUrl = candidate.viewUrl;
	node.controlBase = candidate.controlBase;
	node.addressSource = "observed";
	node.addressUpdatedAt = new Date().toISOString();
	node.lastAddressSync = { at: node.addressUpdatedAt, from, to: candidate.viewUrl, reason, result: "updated" };
	saveState();
	relayLogAdd("info", `auto-address ${from} -> ${candidate.viewUrl}（${reason}；旧 token 仍被接受）`);
	return { updated: true, from, to: candidate.viewUrl };
}
/**
 * 判据 1：自动地址写回的唯一入口。
 * 顺序固定：旧 token 先被对端接受（/ctl/health 200）→ 再取 /health 与连接来源 → 仅在非手动时写回；401 一律不写。
 */
async function syncObservedAddress(node, tokenAccepted) {
	if (!node || node.revoked || !node.viewUrl || !node.accessToken) return null;
	if (node.addressSource === "manual") return { skipped: "manual" };
	if (Date.now() - Number(node.addressSyncAt || 0) < ADDRESS_SYNC_MS) return { skipped: "throttled" };
	const t = peerTransport(node);
	if (!t.ok) return { skipped: "transport" };
	node.addressSyncAt = Date.now();
	let accepted = Boolean(tokenAccepted);
	if (!accepted) {
		const auth = await httpJson(node, "/ctl/health", { peerId: ensureState().instanceId }, { token: node.accessToken, timeout: 4000 });
		accepted = Boolean(auth.ok);
		if (!accepted) {
			node.lastAddressSync = { at: new Date().toISOString(), skipped: auth.status === 401 ? "token-rejected" : "auth-failed", result: "none" };
			saveState();
			relayLogAdd("warn", `auto-address 跳过 node=${node.id}：旧 token 未被接受（${auth.status === 401 ? "401" : (auth.error?.code || "error")}），不写回`);
			return { skipped: "token-rejected", rejected: auth.status === 401 };
		}
	}
	const health = await httpJson(node, "/health", undefined, { timeout: 4000 });
	if (!health.ok) {
		node.lastAddressSync = { at: new Date().toISOString(), skipped: "health-failed", result: "none" };
		saveState();
		return { skipped: "health-failed" };
	}
	const candidate = deriveFromHealth(node, health.value, t.host);
	const applied = applyAutoAddress(node, candidate, "对端 /health + 连接来源");
	if (!applied) {
		node.lastAddressSync = { at: new Date().toISOString(), skipped: candidate ? "unchanged" : "no-candidate", result: "none" };
		saveState();
		return { skipped: candidate ? "unchanged" : "no-candidate" };
	}
	return applied;
}
function newNodeId(label) {
	const nodes = ensureState().nodes;
	const base = String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "node";
	let id = `${base}-${crypto.randomBytes(3).toString("hex")}`;
	while (nodes[id]) id = `${base}-${crypto.randomBytes(3).toString("hex")}`;
	return id;
}
function findNode(nodeId) {
	const nodes = ensureState().nodes;
	if (nodeId && nodes[nodeId]) return nodes[nodeId];
	const ids = Object.keys(nodes);
	if (!nodeId && ids.length === 1) return nodes[ids[0]];
	return null;
}
function findNodeByPeer(peerId) {
	for (const node of Object.values(ensureState().nodes)) if (node.peerId === peerId) return node;
	return null;
}
function publicNode(node, status) {
	return {
		id: node.id,
		label: node.label,
		host: node.host || "",
		port: node.port || LISTEN_PORT,
		protocol: node.protocol || "http",
		controlBase: node.controlBase,
		viewUrl: node.viewUrl,
		peerId: node.peerId,
		status: status || node.status || "unpaired",
		revoked: Boolean(node.revoked),
		pairedAt: node.pairedAt || null,
		createdAt: node.createdAt || null,
		pending: node.pendingRequestId || null,
		certFingerprint: node.certFingerprint || "",
		certFingerprintPrefix: node.certFingerprint ? fingerprintPrefix(node.certFingerprint, 6) : "",
		pinned: Boolean(node.certFingerprint && node.certPem),
		pinSource: node.pinSource || "",
		lastProbe: node.lastProbe || null,
		reportedAddress: node.reportedAddress || "",
		addressUnreliable: Boolean(node.addressUnreliable),
		privateAddress: isPrivateHost(node.host),
		// 件23：地址来源与最近一次自动同步读数（面板展示“手动/自动”，手动永不被自动覆盖）。
		addressSource: node.addressSource === "manual" ? "manual" : (node.addressSource === "observed" ? "observed" : ""),
		addressUpdatedAt: node.addressUpdatedAt || null,
		lastAddressSync: node.lastAddressSync || null,
	};
}
function upsertPeerNode({ peerId, label, viewUrl, token, pairedAt, certFingerprint, certPem, reportedAddress, addressUnreliable, addressSource }) {
	const st = ensureState();
	let node = findNodeByPeer(peerId);
	const wantSource = addressSource === "manual" ? "manual" : "observed";
	if (!node) {
		let host = "";
		let port = LISTEN_PORT;
		let protocol = "http";
		try { const u = new URL(viewUrl); host = u.hostname; port = Number(u.port) || (u.protocol === "https:" ? 443 : 80); protocol = u.protocol.replace(":", ""); } catch {}
		node = { id: newNodeId(label), label, host, port, protocol, viewUrl, controlBase: `${originOf(viewUrl)}/ctl`, peerId, status: "unpaired", revoked: false, addressSource: wantSource, addressUpdatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
		st.nodes[node.id] = node;
	}
	node.label = label || node.label;
	// 判据 1：手动地址永不被自动覆盖；只有自动来源才接受自动写回。
	if (viewUrl && node.addressSource !== "manual") {
		const parsed = parseViewUrl(viewUrl);
		if (parsed) { node.host = parsed.host; node.port = parsed.port; node.protocol = parsed.protocol; }
		node.viewUrl = viewUrl;
		node.controlBase = `${originOf(node.viewUrl)}/ctl`;
		node.addressSource = wantSource;
		node.addressUpdatedAt = new Date().toISOString();
	}
	if (reportedAddress !== undefined) node.reportedAddress = reportedAddress;
	if (addressUnreliable !== undefined) node.addressUnreliable = Boolean(addressUnreliable);
	node.accessToken = token;
	node.status = "online";
	node.pairedAt = pairedAt || new Date().toISOString();
	node.pendingRequestId = null;
	if (certFingerprint) node.certFingerprint = String(certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, "");
	if (certPem) {
		const info = inspectCertificate(certPem);
		if (info && info.fingerprint === node.certFingerprint) { node.certPem = String(certPem); node.pinSource = "peer-reported"; }
	}
	delete node.invalid;
	return node;
}
function markInvalid(node) {
	if (!node) return;
	node.status = "invalid";
	node.invalidAt = new Date().toISOString();
	saveState();
}

/* ---------------- A 面：本机面板端点 ---------------- */
function incomingPending() {
	const st = ensureState();
	return Object.entries(st.pending).filter(([, p]) => String(p.status || "").startsWith("pending")).map(([id, p]) => ({ id, label: p.from.label || "?", fingerprint: p.fingerprint || "", certFingerprint: p.from.certFingerprint || "", certFingerprintPrefix: p.from.certFingerprint ? fingerprintPrefix(p.from.certFingerprint, 6) : "", at: p.at, address: p.from.address || "", reportedAddress: p.from.reportedAddress || "", addressUnreliable: Boolean(p.from.addressUnreliable || !p.from.address) }));
}
async function refreshStatus(node) {
	if (node.revoked) return "revoked";
	if (!node.viewUrl) return "address-unavailable";
	if (node.pendingRequestId) return "pending";
	if (!node.accessToken) {
		const probe = await probeNodeHealth(node, 2000);
		return probe.ok ? "unpaired" : "unreachable";
	}
	if (node.protocol === "https" && !node.certPem) return "needs-pin";
	const r = await httpJson(node, "/ctl/health", { peerId: ensureState().instanceId }, { token: node.accessToken, timeout: 4000 });
	if (r.ok) {
		// 件23：旧 token 仍被接受时，才按对端 /health 与连接来源校正自动地址（每节点 60s 节流）。
		try { await syncObservedAddress(node, true); } catch {}
		return "online";
	}
	if (r.status === 401) return "invalid";
	if (r.error?.code === "fingerprint-mismatch") return "fingerprint-mismatch";
	if (r.error?.code === "no-pin" || r.error?.code === "pin-corrupt") return "needs-pin";
	if (r.error?.code === "insecure-transport") return "insecure";
	return "offline";
}
function settingsView() {
	const saved = ensureState().settings;
	const pending = Number(saved.port) !== listener.port || String(saved.bind) !== listener.bind || String(saved.protocol) !== listener.protocol || Number(saved.maxConcurrency) !== listener.maxConcurrency;
	return { saved: { port: saved.port, bind: saved.bind, protocol: saved.protocol, maxConcurrency: saved.maxConcurrency, autoApprove: Boolean(saved.autoApprove), guiPort: Number(saved.guiPort) || 0, publicBase: saved.publicBase || "" }, active: { port: listener.port, bind: listener.bind, protocol: listener.protocol, maxConcurrency: listener.maxConcurrency, autoApprove: Boolean(saved.autoApprove), guiPort: Number(saved.guiPort) || 0, publicBase: saved.publicBase || "" }, pending };
}
async function getView(req) {
	try { ensureRelay(); } catch {}
	const st = ensureState();
	const nodes = await Promise.all(Object.values(st.nodes).map(async (node) => {
		let status = node.status || "unpaired";
		try { status = await refreshStatus(node); } catch { status = "offline"; }
		if (node.status !== status) { node.status = status; saveState(); }
		return publicNode(node, status);
	}));
	const tlsInfo = tlsSummary();
	return {
		ok: true,
		version: VERSION,
		nodes,
		pending: incomingPending(),
		self: selfInfo(req),
		listener: {
			ok: listener.ok,
			port: listener.port,
			bind: listener.bind,
			protocol: listener.protocol,
			error: listener.error,
			errorCode: listener.errorCode || "",
			guiPort: guiPort(),
			startedAt: listener.startedAt,
			hasLaunchToken: Boolean(readLaunchToken()),
			launchTokenPath: launchTokenInfo().path || "",
			launchTokenSearched: (launchTokenInfo().searched || []).slice(0, 8),
			hasBrowserSecret: Boolean(browserSessionSecret()),
			canProxyGui: Boolean(readLaunchToken() || browserSessionSecret()),
			certFingerprint: tlsInfo.fingerprint || "",
			certFingerprintPrefix: tlsInfo.fingerprintPrefix || "",
			certNotAfter: tlsInfo.notAfter || null,
			inflight: listener.inflight,
			maxConcurrency: listener.maxConcurrency,
			timeouts: listener.timeouts,
			rejected: listener.rejected,
			requests: listener.requests,
		},
		limits: limitsView(ensurePeerState()),
		state: stateInfo(),
		meshLogFile: DATA_DIR ? join(DATA_DIR, "mesh.log") : "",
		relay: { ok: Boolean(relayState.localPort) || (relayState.prefix && !relayState.stale), prefix: relayState.prefix, stale: relayState.stale, localPort: relayState.localPort, reason: relayState.localPort ? "" : relayState.reason, upgrades: relayState.upgrades, lastError: relayState.lastError, log: relayLog.slice(-20) },
		settings: settingsView(),
		compat: lastCap ? { state: lastCap.state, missing: lastCap.missing || [] } : null,
	};
}
async function probePeerHealth(host, port, protocol, timeout = 4000) {
	const started = Date.now();
	const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	const base = `${protocol}://${bracketed}:${port}/`;
	if (protocol === "https") {
		const cert = await probePeerCert(host, port, timeout);
		if (!cert.ok) return { ok: false, protocol, error: cert.error, latencyMs: Date.now() - started };
		const h = await httpJson({ viewUrl: base, protocol: "https", certPem: cert.certPem, certFingerprint: cert.fingerprint }, "/health", undefined, { timeout });
		if (!h.ok) return { ok: false, protocol, error: h.error?.code || `HTTP ${h.status}`, latencyMs: Date.now() - started };
		return { ok: true, protocol, value: h.value || {}, certFingerprint: cert.fingerprint, latencyMs: Date.now() - started };
	}
	const h = await httpJson({ viewUrl: base, protocol: "http" }, "/health", undefined, { timeout });
	if (!h.ok) return { ok: false, protocol, error: h.error?.code || `HTTP ${h.status}`, latencyMs: Date.now() - started };
	return { ok: true, protocol, value: h.value || {}, latencyMs: Date.now() - started };
}
function detectionSummary(d) {
	if (!d) return null;
	return {
		protocol: d.protocol,
		reachable: Boolean(d.ok),
		latencyMs: d.latencyMs,
		version: d.ok ? String(d.value?.version || "") : "",
		peerProtocol: d.ok ? String(d.value?.protocol || "") : "",
		certFingerprint: d.certFingerprint || "",
		certFingerprintPrefix: d.certFingerprint ? fingerprintPrefix(d.certFingerprint, 6) : "",
		error: d.ok ? "" : String(d.error || ""),
	};
}
async function addNode(payload) {
	const requested = payload?.protocol === "http" ? "http" : (payload?.protocol === "https" ? "https" : "auto");
	const host = normalizeHost(payload?.host);
	const port = normalizePort(payload?.port);
	if (!host) return { ok: false, status: 400, error: { code: "missing-host", message: "需要主机地址" } };
	if (!port) return { ok: false, status: 400, error: { code: "bad-port", message: "端口需为 1 到 65535" } };
	const st = ensureState();
	let protocol = requested === "auto" ? "https" : requested;
	let detection = null;
	// 件20：自动探测先 https 后 http；显式 http 时若对端是 https，拒绝且不建节点。
	if (requested === "auto") {
		const httpsProbe = await probePeerHealth(host, port, "https");
		if (httpsProbe.ok) { protocol = "https"; detection = httpsProbe; }
		else {
			const httpProbe = await probePeerHealth(host, port, "http");
			if (httpProbe.ok) { protocol = "http"; detection = httpProbe; }
			else {
				return { ok: false, status: 503, error: { code: "unreachable", message: `https 与 http 都不可达（https: ${httpsProbe.error}；http: ${httpProbe.error}）。请检查对端是否监听、端口与防火墙。`, details: { https: detectionSummary(httpsProbe), http: detectionSummary(httpProbe) } } };
			}
		}
	} else if (requested === "http") {
		const pinned = Object.values(st.nodes).find((n) => String(n.host) === host && Number(n.port) === port && n.protocol === "https" && n.certFingerprint);
		const httpsProbe = pinned ? { ok: true, certFingerprint: pinned.certFingerprint, value: {} } : await probePeerHealth(host, port, "https");
		if (pinned || httpsProbe.ok) {
			const fp = httpsProbe.certFingerprint || "";
			return { ok: false, status: 409, error: { code: "https-required", message: `对端是 https${fp ? `（证书 ${fingerprintPrefix(fp, 6)}…）` : ""}；请把协议改成 https 再添加，明文 http 不会建立节点。`, details: { fingerprintPrefix: fp ? fingerprintPrefix(fp, 6) : "" } } };
		}
	}
	const derived = deriveUrls(protocol, host, port);
	const viewUrl = String(payload?.viewUrl || "").trim() || derived.viewUrl;
	const controlBase = String(payload?.controlBase || "").trim() || derived.controlBase;
	const label = String(payload?.label || "").trim().slice(0, 60) || (port === LISTEN_PORT ? host : `${host}:${port}`);
	if (Object.keys(st.nodes).length >= MAX_NODES) return { ok: false, status: 409, error: { code: "too-many-nodes", message: `最多 ${MAX_NODES} 个节点` } };
	if (Object.values(st.nodes).some((n) => String(n.viewUrl || "").toLowerCase() === viewUrl.toLowerCase())) return { ok: false, status: 409, error: { code: "duplicate-node", message: "该地址已存在" } };
	const node = { id: newNodeId(label), label, host, port, protocol, controlBase, viewUrl, peerId: String(payload?.peerId || "").trim(), status: "unpaired", revoked: false, addressSource: payload?.addressSource === "observed" ? "observed" : "manual", createdAt: new Date().toISOString() };
	if (protocol === "https" && payload?.certPem && payload?.certFingerprint) {
		const info = inspectCertificate(payload.certPem);
		const fp = String(payload.certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, "");
		if (info && info.fingerprint === fp) { node.certPem = String(payload.certPem); node.certFingerprint = fp; node.pinSource = "import"; }
	}
	st.nodes[node.id] = node;
	if (!saveState()) { delete st.nodes[node.id]; return { ok: false, status: 500, error: { code: "state-write-failed", message: `未保存：${lastSaveError || "状态文件不可写"}（${STATE_FILE}）` } }; }
	const summary = detectionSummary(detection);
	const warning = requested === "https" && !detection ? "已按 https 添加；未探测（可点“测试连通”确认）" : "";
	return { ok: true, node: publicNode(node, "unpaired"), detection: summary, warning };
}

async function makeCode(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	let pinNote = "pinned";
	if (String(node.protocol) === "https") {
		let target;
		try { target = new URL(node.viewUrl); } catch { return { ok: false, status: 400, error: { code: "bad-peer-url" } }; }
		const host = target.hostname.replace(/^\[|\]$/g, "");
		const port = Number(target.port) || 443;
		const probe = await probePeerCert(host, port);
		if (!probe.ok) return { ok: false, status: 503, error: { code: "unreachable", message: `取对端证书失败：${probe.error}` } };
		if (node.certPem && node.certFingerprint) {
			if (probe.fingerprint !== node.certFingerprint) return { ok: false, status: 409, error: await pinMismatchError(node, node.certFingerprint) };
		} else {
			// 首次点“生成配对码”＝一次显式信任动作：记录指纹并在面板展示前缀，供与对端本机面板核对。
			node.certFingerprint = probe.fingerprint;
			node.certPem = probe.certPem;
			node.pinSource = "bootstrap";
			node.pinAt = new Date().toISOString();
			pinNote = "adopted";
			saveState();
		}
	}
	const r = await httpJson(node, "/pair", {}, { timeout: 8000 });
	if (!r.ok) return { ok: false, status: r.status && r.status >= 400 ? r.status : 502, error: r.error || { code: "pair-request-failed" } };
	const v = r.value || {};
	if (node.protocol === "https" && v.certFingerprint) {
		const returned = String(v.certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, "");
		if (returned && returned !== node.certFingerprint) return { ok: false, status: 409, error: await pinMismatchError(node, node.certFingerprint) };
	}
	return { ok: true, code: v.code, host: v.host, port: v.port, ttlMs: v.ttlMs, expiresAt: v.expiresAt, protocol: v.protocol || node.protocol, publicBase: v.publicBase || "", displayAddress: v.displayAddress || "", certFingerprint: node.certFingerprint || "", certFingerprintPrefix: node.certFingerprint ? fingerprintPrefix(node.certFingerprint, 6) : "", pin: pinNote };
}
function newToken() { return crypto.randomBytes(32).toString("hex"); }
async function pairNode(nodeId, code) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (!code || typeof code !== "string") return { ok: false, status: 400, error: { code: "missing-code" } };
	if (String(node.protocol) === "https" && (!node.certPem || !node.certFingerprint)) {
		return { ok: false, status: 409, error: { code: "no-pin", message: "未钉住对端证书指纹：请先点“生成配对码”，核对指纹前缀后再提交配对" } };
	}
	const st = ensureState();
	const myToken = newToken();
	const from = { ...selfInfo(null), token: myToken };
	const r = await httpJson(node, "/pair", { code: code.trim(), from }, { timeout: 10000 });
	if (!r.ok) return { ok: false, status: r.status && r.status >= 400 ? r.status : 502, error: r.error || { code: "pair-failed" } };
	const v = r.value || {};
	if (String(node.protocol) === "https" && v.certFingerprint) {
		const returned = String(v.certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, "");
		if (returned && returned !== node.certFingerprint) return { ok: false, status: 409, error: await pinMismatchError(node, node.certFingerprint) };
	}
	if (v.status === "pending" && v.requestId) {
		node.pendingRequestId = v.requestId;
		node.pendingToken = myToken;
		node.status = "unpaired";
		saveState();
		return { ok: true, status: "pending", requestId: v.requestId, message: "配对码已提交，等待对方在本机面板确认；确认前不建立" };
	}
	node.peerId = v.instanceId || node.peerId || `peer-${crypto.randomBytes(3).toString("hex")}`;
	node.accessToken = myToken;
	node.status = "online";
	node.revoked = false;
	node.pairedAt = new Date().toISOString();
	node.pendingRequestId = null;
	delete node.invalid;
	peerState = ensurePeerState();
	peerState.peers[node.peerId] = { peerId: node.peerId, tokenHash: tokenHashOf(v.token), certFingerprint: v.certFingerprint || node.certFingerprint || "", listenPort: Number(v.listenPort) || 0, protocol: String(v.protocol || "") === "http" ? "http" : "https", createdAt: Date.now() };
	savePeerState();
	saveState();
	return { ok: true, node: publicNode(node, "online") };
}
async function requestPair(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	const myToken = newToken();
	const from = { ...selfInfo(null), token: myToken };
	const r = await httpJson(node, "/pair/request", { from }, { timeout: 10000 });
	if (!r.ok) return { ok: false, status: r.status && r.status >= 400 ? r.status : 502, error: r.error || { code: "request-failed" } };
	const v = r.value || {};
	node.pendingRequestId = v.requestId;
	node.pendingToken = myToken;
	node.status = "pending";
	saveState();
	return { ok: true, requestId: v.requestId, status: "pending" };
}
async function pairStatus(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (!node.pendingRequestId) return { ok: true, status: "none" };
	const r = await httpJson(node, `/pair/result?id=${encodeURIComponent(node.pendingRequestId)}`, undefined, { timeout: 8000 });
	if (!r.ok) return { ok: false, status: r.status || 502, error: r.error || { code: "status-failed" } };
	const v = r.value || {};
	if (v.status === "approved") {
		node.peerId = v.instanceId || node.peerId;
		node.accessToken = node.pendingToken;
		node.status = "online";
		node.pairedAt = new Date().toISOString();
		node.pendingRequestId = null;
		if (v.certFingerprint && !node.certFingerprint) { node.certFingerprint = String(v.certFingerprint).toLowerCase().replace(/[^0-9a-f]/g, ""); node.pinSource = "pair-result"; }
		peerState = ensurePeerState();
		peerState.peers[node.peerId] = { peerId: node.peerId, tokenHash: tokenHashOf(v.token), certFingerprint: v.certFingerprint || node.certFingerprint || "", listenPort: Number(v.listenPort) || 0, protocol: String(v.protocol || "") === "http" ? "http" : "https", createdAt: Date.now() };
		delete node.pendingToken;
		savePeerState();
		saveState();
		return { ok: true, status: "approved", node: publicNode(node, "online") };
	}
	if (v.status === "rejected") {
		node.pendingRequestId = null;
		delete node.pendingToken;
		node.status = "unpaired";
		saveState();
		return { ok: true, status: "rejected" };
	}
	return { ok: true, status: "pending" };
}
async function approvePending(requestId) {
	const st = ensureState();
	const p = st.pending[requestId];
	if (!p || p.status !== "pending") return { ok: false, status: 404, error: { code: "unknown-request" } };
	const myToken = newToken();
	peerState = ensurePeerState();
	peerState.peers[p.from.instanceId] = { peerId: p.from.instanceId, tokenHash: p.from.tokenHash || "", certFingerprint: p.from.certFingerprint || "", listenPort: Number(p.from.listenPort) || 0, protocol: String(p.from.protocol || "") === "http" ? "http" : "https", createdAt: Date.now() };
	savePeerState();
	const viewUrl = p.from.address || "";
	const node = upsertPeerNode({ peerId: p.from.instanceId, label: p.from.label || "peer", viewUrl, token: myToken, pairedAt: new Date().toISOString(), certFingerprint: p.from.certFingerprint || "", certPem: p.from.certPem || "", reportedAddress: p.from.reportedAddress || p.from.address || "", addressUnreliable: p.from.addressUnreliable || !viewUrl });
	p.status = "approved";
	if (p.codeHash) {
		const db = ensurePeerState();
		if (db.codes[p.codeHash]) { db.codes[p.codeHash].usedAt = Date.now(); savePeerState(); }
	}
	p.result = { instanceId: st.instanceId, label: st.label, token: myToken, fingerprint: fingerprint(), certFingerprint: certFingerprint(), certFingerprintDisplay: displayFingerprint(certFingerprint()), fingerprintPrefix: fingerprintPrefix(certFingerprint(), 6), protocol: listener.protocol, listenPort: listener.port };
	saveState();
	return { ok: true, node: publicNode(node, "online") };
}
async function rejectPending(requestId) {
	const st = ensureState();
	const p = st.pending[requestId];
	if (!p || p.status !== "pending") return { ok: false, status: 404, error: { code: "unknown-request" } };
	p.status = "rejected";
	saveState();
	return { ok: true, rejected: requestId };
}
async function openNode(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	if (!node.viewUrl) return { ok: false, status: 409, error: { code: "address-unavailable", message: "对端地址不可用（对端只报了容器/回环地址），请删除后手动添加对端可达地址" } };
	if (!node.accessToken) return { ok: false, status: 403, error: { code: "not-paired", message: "未配对" } };
	if (String(node.protocol) === "https" && (!node.certPem || !node.certFingerprint)) return { ok: false, status: 409, error: { code: "no-pin", message: "未钉住对端证书指纹，请重新配对" } };
	const r = await httpJson(node, "/ctl/authorize", { peerId: ensureState().instanceId }, { token: node.accessToken });
	if (!r.ok) {
		if (r.status === 401) { markInvalid(node); return { ok: false, status: 403, error: { code: "authorization-invalid", message: "授权无效，需重新配对" } }; }
		if (r.error?.code === "fingerprint-mismatch") return { ok: false, status: 409, error: r.error };
		if (r.error?.code === "insecure-transport" || r.error?.code === "no-pin") return { ok: false, status: 409, error: r.error };
		const unreachable = r.error?.code === "unreachable";
		return { ok: false, status: unreachable ? 503 : 502, error: unreachable ? r.error : { code: "unauthorized", message: "对端异常" } };
	}
	let peerCanProxy = false;
	if (node.viewUrl) {
		const h = await httpJson(node, "/health", undefined, { timeout: 4000 });
		peerCanProxy = Boolean(h.ok && h.value?.canProxyGui);
	}
	const localCanProxy = Boolean(readLaunchToken() || browserSessionSecret());
	const relayRegistered = Boolean(relayState.localPort || (relayState.prefix && !relayState.stale));
	const relayReady = localCanProxy && peerCanProxy && relayRegistered;
	const token = relayReady ? relayToken(node.id) : "";
	return { ok: true, url: node.viewUrl, nodeId: node.id, protocol: node.protocol, relayReady, localCanProxy, peerCanProxy, relayRegistered, relayLocalPort: relayState.localPort, relayReason: relayRegistered ? "" : relayState.reason, relayToken: token, relayPath: relayReady ? `/mesh/${encodeURIComponent(node.id)}/?mt=${token}` : "" };
}
async function reconnectNode(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	if (!node.accessToken) return { ok: false, status: 401, error: { code: "not-paired" } };
	const r = await httpJson(node, "/ctl/authorize", { peerId: ensureState().instanceId }, { token: node.accessToken });
	if (r.ok) { node.status = "online"; saveState(); return { ok: true, status: 200 }; }
	if (r.status === 401) { markInvalid(node); return { ok: false, status: 403, error: { code: "authorization-invalid", message: "授权无效，需重新配对" } }; }
	if (r.error?.code === "fingerprint-mismatch") { node.status = "fingerprint-mismatch"; saveState(); return { ok: false, status: 409, error: r.error }; }
	if (r.error?.code === "no-pin" || r.error?.code === "insecure-transport") return { ok: false, status: 409, error: r.error };
	return { ok: false, status: 503, error: r.error || { code: "unreachable" } };
}
async function probeNodeHealth(node, timeout = 2500) {
	let target = node;
	let tlsFingerprint = node.certFingerprint || "";
	if (String(node.protocol) === "https" && !node.certPem) {
		let targetUrl;
		try { targetUrl = new URL(node.viewUrl); } catch { return { ok: false, error: "bad-peer-url" }; }
		const host = targetUrl.hostname.replace(/^\[|\]$/g, "");
		const port = Number(targetUrl.port) || 443;
		const probe = await probePeerCert(host, port, timeout);
		if (!probe.ok) return { ok: false, error: probe.error };
		tlsFingerprint = probe.fingerprint;
		target = { ...node, certPem: probe.certPem, certFingerprint: probe.fingerprint };
	}
	const h = await httpJson(target, "/health", undefined, { timeout });
	if (!h.ok) return { ok: false, error: h.error?.code || `HTTP ${h.status}`, code: h.error?.code };
	return { ok: true, value: h.value || {}, fingerprint: tlsFingerprint };
}
async function probeNode(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	const started = Date.now();
	let target = node;
	let tlsFingerprint = node.certFingerprint || "";
	if (String(node.protocol) === "https" && !node.certPem) {
		let targetUrl;
		try { targetUrl = new URL(node.viewUrl); } catch { return { ok: false, status: 400, error: { code: "bad-peer-url" } }; }
		const host = targetUrl.hostname.replace(/^\[|\]$/g, "");
		const port = Number(targetUrl.port) || 443;
		const probe = await probePeerCert(host, port);
		if (!probe.ok) {
			node.lastProbe = { at: new Date().toISOString(), reachable: false, authorized: "unknown", latencyMs: Date.now() - started, error: `unreachable: ${probe.error}` };
			saveState();
			return { ok: false, status: 503, error: { code: "unreachable", message: `不可达：${probe.error}` } };
		}
		tlsFingerprint = probe.fingerprint;
		target = { ...node, certPem: probe.certPem, certFingerprint: probe.fingerprint };
	}
	const h = await httpJson(target, "/health", undefined, { timeout: 5000 });
	if (!h.ok) {
		node.lastProbe = { at: new Date().toISOString(), reachable: false, authorized: "unknown", latencyMs: Date.now() - started, error: h.error?.code || "unreachable" };
		saveState();
		const message = h.error?.code === "fingerprint-mismatch" ? h.error.message : `不可达：${h.error?.message || `HTTP ${h.status}`}`;
		return { ok: false, status: h.status || 503, error: { code: h.error?.code || "unreachable", message, details: h.error?.details } };
	}
	const health = h.value || {};
	let authorized = "unpaired";
	if (node.accessToken) {
		const a = await httpJson(node, "/ctl/health", { peerId: ensureState().instanceId }, { token: node.accessToken, timeout: 5000 });
		authorized = a.ok ? "authorized" : (a.status === 401 ? "unauthorized" : "error");
	}
	const latencyMs = Date.now() - started;
	node.lastProbe = { at: new Date().toISOString(), reachable: true, authorized, latencyMs, version: String(health.version || ""), protocol: String(health.protocol || node.protocol), certFingerprint: node.certFingerprint || tlsFingerprint };
	if (authorized === "authorized") node.status = "online";
	saveState();
	return { ok: true, reachable: true, authorized, latencyMs, version: String(health.version || ""), protocol: String(health.protocol || node.protocol), certFingerprint: node.certFingerprint || tlsFingerprint, certFingerprintPrefix: tlsFingerprint ? fingerprintPrefix(tlsFingerprint, 6) : "", status: node.status };
}
/**
 * 判据 1（连接来源）：对端主动连到本机时，用它的来源地址 + 配对时登记的 listenPort/protocol 作为自动地址候选。
 * 写回前仍要拿旧 token 调一次 /ctl/health：200 才写，401 一律不写。
 */
async function noteObservedPeer(req, rec, peerId) {
	if (!peerId || !rec) return null;
	const node = findNodeByPeer(peerId);
	if (!node || node.revoked || !node.accessToken) return null;
	// 手动地址：只记录“被跳过”，永不写地址（判据 1）。
	if (node.addressSource === "manual") {
		if (node.lastAddressSync?.skipped !== "manual") node.lastAddressSync = { at: new Date().toISOString(), skipped: "manual", result: "none" };
		return { skipped: "manual" };
	}
	if (Date.now() - Number(node.addressSyncAt || 0) < ADDRESS_SYNC_MS) return null;
	node.addressSyncAt = Date.now();
	const observed = autoHostOf(String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, ""));
	if (!observed) return null;
	const protocol = String(rec.protocol || node.protocol || "https") === "http" ? "http" : "https";
	const port = Number(rec.listenPort) || Number(node.port) || LISTEN_PORT;
	const candidate = { host: observed, port, protocol, ...deriveUrls(protocol, observed, port) };
	if (candidate.viewUrl === node.viewUrl) return null;
	const temp = { ...node, host: candidate.host, port: candidate.port, protocol: candidate.protocol, viewUrl: candidate.viewUrl, controlBase: candidate.controlBase };
	const auth = await httpJson(temp, "/ctl/health", { peerId: ensureState().instanceId }, { token: node.accessToken, timeout: 4000 });
	if (!auth.ok) {
		node.lastAddressSync = { at: new Date().toISOString(), skipped: auth.status === 401 ? "token-rejected" : "auth-failed", from: node.viewUrl, to: candidate.viewUrl, result: "none" };
		saveState();
		relayLogAdd("warn", `auto-address 跳过 node=${node.id}：连接来源候选 ${candidate.viewUrl}，旧 token 未被接受（${auth.status === 401 ? "401" : (auth.error?.code || "error")}）`);
		return { skipped: "token-rejected", rejected: auth.status === 401 };
	}
	return applyAutoAddress(node, candidate, "对端连接来源 + 配对时 /health 端口/协议");
}
async function setAddress(nodeId, payload) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	// 只切换来源（手动 -> 自动）时不改地址，交给下次 token 校验后的自动写回。
	const wantObserved = payload?.addressSource === "observed";
	if (wantObserved && !String(payload?.host || "").trim()) {
		node.addressSource = "observed";
		node.addressSyncAt = 0;
		saveState();
		relayLogAdd("info", `address-source node=${node.id} -> observed（地址仍 ${node.viewUrl}）`);
		return { ok: true, node: publicNode(node, node.status || "unpaired") };
	}
	const host = normalizeHost(payload?.host);
	const port = normalizePort(payload?.port);
	if (!host) return { ok: false, status: 400, error: { code: "missing-host", message: "需要主机地址" } };
	if (!port) return { ok: false, status: 400, error: { code: "bad-port", message: "端口需为 1 到 65535" } };
	const protocol = payload?.protocol === "http" ? "http" : (payload?.protocol === "https" ? "https" : (String(node.protocol) === "http" ? "http" : "https"));
	const derived = deriveUrls(protocol, host, port);
	node.host = host;
	node.port = port;
	node.protocol = protocol;
	node.viewUrl = derived.viewUrl;
	node.controlBase = derived.controlBase;
	node.addressSource = wantObserved ? "observed" : "manual";
	if (wantObserved) node.addressSyncAt = 0;
	node.addressUpdatedAt = new Date().toISOString();
	node.lastAddressSync = { at: node.addressUpdatedAt, result: wantObserved ? "observed-set" : "manual-set", to: derived.viewUrl };
	node.addressUnreliable = false;
	node.lastProbe = null;
	saveState();
	relayLogAdd("info", `set-address manual node=${node.id} -> ${derived.viewUrl}`);
	return { ok: true, node: publicNode(node, node.status || "unpaired") };
}
/* ---------------- 件23：强制信任新证书（仅当旧 token 仍被对端接受） ---------------- */
async function inspectCertChange(node) {
	if (String(node.protocol) !== "https") return { ok: false, status: 409, error: { code: "not-https", message: "明文 http 节点没有证书可信任；请改用 https 配对" } };
	if (!node.certPem || !node.certFingerprint) return { ok: false, status: 409, error: { code: "no-old-pin", message: "本机没有旧指纹：请先“生成配对码”记录并核对指纹，再配对（强制信任只用于替换已钉住的旧指纹）" } };
	let target;
	try { target = new URL(node.viewUrl); } catch { return { ok: false, status: 400, error: { code: "bad-peer-url" } }; }
	const host = target.hostname.replace(/^\[|\]$/g, "");
	const port = Number(target.port) || 443;
	const probe = await probePeerCert(host, port);
	if (!probe.ok) return { ok: false, status: 503, error: { code: "unreachable", message: `取对端证书失败：${probe.error}` } };
	const oldPrefix = fingerprintPrefix(node.certFingerprint, 6);
	const newPrefix = fingerprintPrefix(probe.fingerprint, 6);
	const changed = probe.fingerprint !== node.certFingerprint;
	let tokenAccepted = false;
	let check = changed ? "" : "unchanged";
	if (changed) {
		if (!node.accessToken) check = "no-token";
		else {
			// 关键：用**新证书**建立连接，但只发旧 token 做“对端是否仍认我”的验证；401 一律不放行。
			const temp = { ...node, certPem: probe.certPem, certFingerprint: probe.fingerprint };
			const a = await httpJson(temp, "/ctl/health", { peerId: ensureState().instanceId }, { token: node.accessToken, timeout: 5000 });
			tokenAccepted = Boolean(a.ok);
			check = a.ok ? "token-accepted" : (a.status === 401 ? "unauthorized" : (a.error?.code || `HTTP ${a.status}`));
		}
	}
	return {
		ok: true,
		changed,
		oldFingerprint: node.certFingerprint,
		newFingerprint: probe.fingerprint,
		oldPrefix,
		newPrefix,
		tokenAccepted,
		check,
		newCertPem: probe.certPem,
		nodeId: node.id,
	};
}
async function trustCheck(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	const info = await inspectCertChange(node);
	if (!info.ok) return info;
	const { newCertPem, ...rest } = info;
	return { ok: true, ...rest, canTrust: Boolean(info.changed && info.tokenAccepted) };
}
async function trustCert(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	const info = await inspectCertChange(node);
	if (!info.ok) return info;
	if (!info.changed) return { ok: true, changed: false, oldPrefix: info.oldPrefix, newPrefix: info.newPrefix, message: "证书未变化，无需强制信任" };
	if (!info.tokenAccepted) {
		relayLogAdd("warn", `trust-cert 拒绝 node=${node.id}：对端不认旧 token（${info.check}），旧 ${info.oldPrefix} 新 ${info.newPrefix}`);
		return { ok: false, status: 403, error: { code: "token-rejected", message: `已拒绝：对端不认本机保存的 token（${info.check}），必须重新配对。旧指纹 ${info.oldPrefix}…，新指纹 ${info.newPrefix}…`, details: { oldPrefix: info.oldPrefix, newPrefix: info.newPrefix, check: info.check } } };
	}
	const previous = node.certFingerprint;
	node.certPem = info.newCertPem;
	node.certFingerprint = info.newFingerprint;
	node.pinSource = "force-trust";
	node.pinAt = new Date().toISOString();
	node.trustHistory = [...(Array.isArray(node.trustHistory) ? node.trustHistory : []), { at: node.pinAt, oldPrefix: info.oldPrefix, newPrefix: info.newPrefix, reason: "token-still-accepted" }].slice(-5);
	delete node.invalid;
	saveState();
	relayLogAdd("warn", `trust-cert 已换 pin node=${node.id} 旧 ${info.oldPrefix} 新 ${info.newPrefix}（旧 token 仍被对端接受）`);
	return { ok: true, changed: true, oldPrefix: info.oldPrefix, newPrefix: info.newPrefix, pinSource: "force-trust", node: publicNode(node, node.status || "unpaired") };
}
/* ---------------- 件23：拉取对端只读日志 ---------------- */
async function peerLogs(nodeId, payload) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	if (node.revoked) return { ok: false, status: 403, error: { code: "node-revoked", message: "节点已删除" } };
	if (!node.viewUrl) return { ok: false, status: 409, error: { code: "address-unavailable", message: "对端地址不可用，先补地址" } };
	if (!node.accessToken) return { ok: false, status: 403, error: { code: "not-paired", message: "未配对：日志面只对已配对节点开放" } };
	if (String(node.protocol) === "https" && (!node.certPem || !node.certFingerprint)) return { ok: false, status: 409, error: { code: "no-pin", message: "未钉住对端证书指纹，无法拉取日志" } };
	const st = ensureState();
	const qs = new URLSearchParams({ peerId: st.instanceId, limit: String(Math.min(LOG_LINES_MAX, Math.max(1, Number(payload?.limit) || LOG_LINES_DEFAULT))) });
	if (payload?.since) qs.set("since", String(payload.since).slice(0, 40));
	const r = await httpJson(node, `/ctl/logs?${qs.toString()}`, undefined, { token: node.accessToken, timeout: 8000 });
	if (!r.ok) {
		if (r.status === 401) {
			markInvalid(node);
			return { ok: false, status: 403, error: { code: "authorization-invalid", message: "对端拒绝日志请求（401）：token 无效或已撤销，需重新配对" } };
		}
		if (r.error?.code === "fingerprint-mismatch" || r.error?.code === "no-pin") return { ok: false, status: 409, error: r.error };
		return { ok: false, status: r.status || 502, error: r.error || { code: "logs-failed", message: `拉取失败 HTTP ${r.status || 0}` } };
	}
	const v = r.value || {};
	relayLogAdd("info", `peer logs node=${node.id} lines=${(v.lines || []).length} size=${v.sizeBytes || 0}`);
	return {
		ok: true,
		nodeId: node.id,
		path: String(v.path || ""),
		sizeBytes: Number(v.sizeBytes) || 0,
		rotatedPath: String(v.rotatedPath || ""),
		rotatedSizeBytes: Number(v.rotatedSizeBytes) || 0,
		lines: Array.isArray(v.lines) ? v.lines : [],
		returned: Number(v.returned) || 0,
		totalLines: Number(v.totalLines) || 0,
		nextSince: v.nextSince || null,
		redacted: Boolean(v.redacted),
		readOnly: Boolean(v.readOnly),
		peerVersion: String(v.version || ""),
		fetchedAt: new Date().toISOString(),
	};
}
async function renameNode(nodeId, label) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	const name = String(label || "").trim().slice(0, 60);
	if (!name) return { ok: false, status: 400, error: { code: "missing-label" } };
	node.label = name;
	saveState();
	return { ok: true, node: publicNode(node) };
}
async function getSettings() {
	const st = ensureState();
	const saved = st.settings;
	return { ok: true, ...settingsView(), state: stateInfo(), listener: { ok: listener.ok, error: listener.error, errorCode: listener.errorCode || "", protocol: listener.protocol, bind: listener.bind, port: listener.port }, tls: tlsSummary() };
}
async function setSettings(payload) {
	const st = ensureState();
	const port = Number(payload?.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, status: 400, error: { code: "bad-port", message: "端口需为 1 到 65535" } };
	const bind = String(payload?.bind || "").trim();
	if (bind !== "0.0.0.0" && bind !== "127.0.0.1") return { ok: false, status: 400, error: { code: "bad-bind", message: "bind 只能是 127.0.0.1 或 0.0.0.0" } };
	const protocol = payload?.protocol === "http" ? "http" : "https";
	const maxConcurrency = Math.min(1024, Math.max(1, Number(payload?.maxConcurrency) || st.settings.maxConcurrency || 32));
	const autoApprove = Boolean(payload?.autoApprove);
	const guiPort = Number(payload?.guiPort) > 0 && Number(payload?.guiPort) < 65536 ? Number(payload.guiPort) : 0;
	const rawPublicBase = String(payload?.publicBase === undefined || payload?.publicBase === null ? "" : payload.publicBase).trim();
	const publicBase = normalizePublicBase(rawPublicBase);
	if (rawPublicBase && !publicBase) return { ok: false, status: 400, error: { code: "bad-public-base", message: "对外地址只能是 http(s) 地址或域名（可留空）" } };
	const prev = { ...st.settings };
	const next = { port, bind, protocol, maxConcurrency, autoApprove, guiPort, publicBase };
	// 件19：先落盘校验，落不下去就报错回滚，不再“假保存”。
	st.settings = { ...next };
	if (!saveState()) {
		st.settings = prev;
		return { ok: false, status: 500, error: { code: "state-write-failed", message: `未保存：${lastSaveError || "状态文件不可写"}（${STATE_FILE}）`, details: { file: STATE_FILE, writable: false, error: lastSaveError } } };
	}
	const needRebuild = !listener.ok || next.port !== listener.port || next.bind !== listener.bind || next.protocol !== listener.protocol;
	if (!needRebuild) {
		listener.maxConcurrency = next.maxConcurrency;
		return await getSettings();
	}
	const switched = await switchListener(next);
	if (!switched.ok) {
		st.settings = prev;
		const restored = saveState();
		return { ok: false, status: 500, error: { code: "listen-switch-failed", message: `未生效：${switched.error}${restored ? "" : "（旧设置回写也失败）"}`, details: { rolledBack: Boolean(switched.rolledBack) } } };
	}
	return await getSettings();
}

/** 件21：删节点一次清干净——state.nodes、peer-state.peers、涉及该实例的 pending、以及节点上的证书/token。 */
function purgePeer(peerId) {
	const st = ensureState();
	if (!peerId) return;
	for (const [id, n] of Object.entries(st.nodes)) if (n.peerId === peerId) delete st.nodes[id];
	for (const [id, p] of Object.entries(st.pending || {})) {
		if (p?.from?.instanceId === peerId || p?.result?.peerId === peerId) delete st.pending[id];
	}
	const db = ensurePeerState();
	delete db.peers[peerId];
}
function purgeLocalNode(node) {
	const st = ensureState();
	if (!node) return { peerId: "" };
	const peerId = node.peerId || "";
	delete st.nodes[node.id];
	for (const [id, p] of Object.entries(st.pending || {})) {
		const pid = p?.from?.instanceId || p?.result?.peerId || "";
		if ((peerId && pid === peerId) || (p?.nodeId && p.nodeId === node.id)) delete st.pending[id];
	}
	const db = ensurePeerState();
	if (peerId) delete db.peers[peerId];
	return { peerId };
}
async function deleteNode(nodeId) {
	const node = findNode(nodeId);
	if (!node) return { ok: false, status: 404, error: { code: "unknown-node" } };
	const st = ensureState();
	const backup = JSON.parse(JSON.stringify(node));
	const upPath = `/mesh/${node.id}/api/remote.mux`;
	const upDispose = relayUpgrades.get(upPath);
	if (typeof upDispose === "function") { try { upDispose(); } catch {} relayUpgrades.delete(upPath); relayState.upgrades = relayUpgrades.size; }
	purgeLocalNode(node);
	if (node.peerId) purgePeer(node.peerId);
	if (!saveState()) { st.nodes[node.id] = backup; return { ok: false, status: 500, error: { code: "state-write-failed", message: `本地删除失败：${lastSaveError || "状态文件不可写"}` } }; }
	savePeerState();
	let remote = "ok";
	if (node.accessToken && viewUrlUsable(node.viewUrl)) {
		const r = await httpJson(node, "/ctl/revoke", { peerId: st.instanceId }, { token: node.accessToken, timeout: 5000 });
		if (!r.ok) remote = "unreachable";
	} else remote = "skipped";
	return { ok: true, deleted: node.id, remote };
}
function viewUrlUsable(url) { try { new URL(url); return true; } catch { return false; } }

/* ---------------- 同源中继（件12）：/mesh/<nodeId>/ → 对端 viewUrl ---------------- */
const relayState = { prefix: false, reason: "", upgrades: 0, lastError: "", stale: false, localPort: 0 };
let relayPrefixDispose = null;
let localRelayServer = null;
const relayLog = [];
function meshLogLine(level, message) {
	relayLog.push({ at: new Date().toISOString(), level, message: redact(message) });
	if (relayLog.length > 80) relayLog.shift();
	try {
		const file = join(DATA_DIR, "mesh.log");
		mkdirSync(DATA_DIR, { recursive: true });
		try { if (existsSync(file) && statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`); } catch {}
		writeFileSync(file, `${new Date().toISOString()} ${level} ${redact(message)}\n`, { mode: 0o600, flag: "a" });
		chmodSync(file, 0o600);
	} catch {}
}
const relayLogAdd = meshLogLine;
const relayUpgrades = new Map();
let relayRetryAt = 0;

function relayAuthCacheKey(req) {
	const cookie = String(req.headers?.cookie || "");
	return cookie ? crypto.createHash("sha256").update(cookie).digest("hex") : "";
}
const authCache = new Map();
/** 用浏览器实际访问的 loopback authority 校验 cookie（Windows 桌面可能是 localhost:8091 而不是 127.0.0.1）。 */
function guiAuthBase(req) {
	const host = String(req.headers?.host || "");
	if (/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/i.test(host)) return `http://${host}`;
	return `http://127.0.0.1:${guiPort()}`;
}
async function relayAuthed(req) {
	const cookie = String(req.headers?.cookie || "");
	if (!cookie) return false;
	const key = relayAuthCacheKey(req);
	const hit = authCache.get(key);
	if (hit && Date.now() - hit.at < 60_000) return hit.ok;
	let ok = false;
	try {
		const r = await fetch(`${guiAuthBase(req)}/`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(3000) });
		ok = r.status === 200;
	} catch { ok = false; }
	if (!ok) relayLogAdd("warn", `relay auth fetch ${guiAuthBase(req)} -> ${ok ? 200 : "fail"}`);
	authCache.set(key, { ok, at: Date.now() });
	return ok;
}
/** 件27：本机回环中继的短时签名（iframe/桌面端拿不到 cookie 时用；10 分钟有效，按节点绑定）。 */
function relayToken(nodeId, ttlMs = 10 * 60 * 1000) {
	const exp = Date.now() + ttlMs;
	const sig = crypto.createHmac("sha256", ensureSecret()).update(`relay:${nodeId}.${exp}`).digest("base64url");
	return `${exp}.${sig}`;
}
function mtFromRequest(req, nodeId) {
	let mt = "";
	try { mt = new URL(req.url || "/", "http://x").searchParams.get("mt") || ""; } catch {}
	if (mt) return mt;
	const ref = String(req.headers?.referer || "");
	if (ref) {
		try {
			const u = new URL(ref);
			if (u.pathname.startsWith(`/mesh/${encodeURIComponent(nodeId)}/`)) mt = u.searchParams.get("mt") || "";
		} catch {}
	}
	if (!mt) {
		const cookie = String(req.headers?.cookie || "");
		const m = new RegExp(`(?:^|;\\s*)mesh-relay-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "")}=([^;]+)`).exec(cookie);
		if (m) mt = decodeURIComponent(m[1]);
	}
	return mt;
}
function checkRelayToken(nodeId, token) {
	const m = /^(\d{13})\.([A-Za-z0-9_-]{20,})$/.exec(String(token || ""));
	if (!m) return false;
	const exp = Number(m[1]);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const expect = crypto.createHmac("sha256", ensureSecret()).update(`relay:${nodeId}.${exp}`).digest("base64url");
	const a = Buffer.from(expect);
	const b = Buffer.from(m[2]);
	if (a.length !== b.length) return false;
	try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
function relayHeaders(req, target) {
	const out = { ...req.headers };
	delete out.cookie;
	delete out.host;
	delete out.origin;
	delete out.referer;
	delete out["accept-encoding"];
	out.host = target.host;
	return out;
}
function proxyRelay(req, res, node, rest) {
	const transport = peerTransport(node);
	if (!transport.ok) {
		const code = transport.error.code === "no-pin" ? 409 : 400;
		res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
		res.end(`relay refused: ${transport.error.message}\n`);
		return;
	}
	let target;
	try { target = new URL(node.viewUrl); } catch { res.writeHead(502); res.end("bad peer url"); return; }
	const lib = transport.isHttps ? https : http;
	const opts = { host: transport.host, port: transport.port, path: rest, method: req.method, headers: relayHeaders(req, target), ...transport.options };
	const up = lib.request(opts, (upRes) => {
		const out = { ...upRes.headers };
		if (out.location && /^https?:\/\//.test(out.location)) {
			try { const loc = new URL(out.location, node.viewUrl); if (loc.origin === target.origin) out.location = `/mesh/${encodeURIComponent(node.id)}${loc.pathname}${loc.search}`; } catch {}
		}
		delete out["set-cookie"];
		res.writeHead(upRes.statusCode || 502, out);
		upRes.pipe(res);
	});
	up.setTimeout(IO_TIMEOUT_MS, () => up.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
	up.on("error", async (err) => { relayLogAdd("warn", `relay upstream error: ${err?.code || err?.message || err}`);
		relayState.lastError = redact(err?.code || err?.message || err);
		if (res.headersSent) return;
		if (isTlsError(err) && node.certFingerprint) {
			const snapped = await pinMismatchError(node, node.certFingerprint);
			if (!snapped.details?.actual || snapped.details.actual !== node.certFingerprint) {
				res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
				res.end(`relay refused: ${snapped.message}\n`);
				return;
			}
		}
		res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end(`relay upstream error: ${relayState.lastError}\n`);
	});
	req.pipe(up);
}
async function relayHandler(req, res) {
	let pathname = "/";
	let search = "";
	let mt = "";
	try {
		const u = new URL(req.url || "/", "http://x");
		pathname = u.pathname;
		mt = u.searchParams.get("mt") || "";
		// 关键：没有 mt 时必须原样保留 query（插件 bundle 用 `plugins/??a,b&rev=`，重序列化会把 ??/@/, 编码掉→404）。
		if (mt) {
			const params = new URLSearchParams(u.search);
			params.delete("mt");
			const q = params.toString();
			search = q ? `?${q}` : "";
		} else search = u.search;
	} catch {}
	const m = pathname.match(/^\/mesh\/([^/]+)(\/.*)?$/);
	if (!m) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
	const nodeId = decodeURIComponent(m[1]);
	const rest = (m[2] || "/") + search;
	relayLogAdd("info", `relay request ${req.method} ${pathname}${search} node=${nodeId}`);
	const node = findNode(nodeId);
	if (!node) { relayLogAdd("warn", `relay unknown node ${nodeId}`); res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("unknown node"); return; }
	const cookieOk = await relayAuthed(req);
	const token = cookieOk ? "" : mtFromRequest(req, nodeId);
	const tokenOk = !cookieOk && checkRelayToken(nodeId, token);
	if (tokenOk && !/mesh-relay-/.test(String(req.headers.cookie || ""))) {
		// 给回环中继发一个路径级会话 cookie，后续 assets/plugins/WS 都能带上来
		try { res.setHeader("set-cookie", `mesh-relay-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "")}=${encodeURIComponent(token)}; Path=/mesh/${encodeURIComponent(nodeId)}/; Max-Age=3600; HttpOnly; SameSite=Lax`); } catch {}
	}
	relayLogAdd(cookieOk || tokenOk ? "info" : "warn", `relay auth ${cookieOk ? "ok" : tokenOk ? "ok-token" : "denied"} cookie=${Boolean(req.headers.cookie)} ref=${Boolean(req.headers.referer)}`);
	if (!cookieOk && !tokenOk) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("unauthorized"); return; }
	proxyRelay(req, res, node, rest);
}
function makeRelayUpgrade(nodeId) {
	return async (req, socket, head) => {
		const node = findNode(nodeId);
		if (!node) { socket.destroy(); return; }
		if (!(await relayAuthed(req)) && !checkRelayToken(nodeId, mtFromRequest(req, nodeId))) { socket.destroy(); return; }
		const transport = peerTransport(node);
		if (!transport.ok) { socket.destroy(); return; }
		let target;
		try { target = new URL(node.viewUrl); } catch { socket.destroy(); return; }
		const lib = transport.isHttps ? https : http;
		const headers = relayHeaders(req, target);
		headers.connection = "Upgrade";
		headers.upgrade = req.headers.upgrade || "websocket";
		const up = lib.request({ host: transport.host, port: transport.port, path: "/api/remote.mux", method: "GET", headers, ...transport.options });
		up.setTimeout(IO_TIMEOUT_MS, () => up.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
		up.on("upgrade", (upRes, upSocket, upHead) => {
			socket.write(`HTTP/1.1 101 ${upRes.statusMessage || "Switching Protocols"}\r\n`);
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (k === "set-cookie") continue;
				if (Array.isArray(v)) for (const x of v) socket.write(`${k}: ${x}\r\n`);
				else socket.write(`${k}: ${v}\r\n`);
			}
			socket.write("\r\n");
			if (upHead && upHead.length) socket.write(upHead);
			if (head && head.length) upSocket.write(head);
			upSocket.pipe(socket);
			socket.pipe(upSocket);
		});
		up.on("error", (err) => { relayState.lastError = redact(err?.code || err?.message || err); socket.destroy(); });
		up.end();
		socket.on("error", () => up.destroy());
	};
}
/**
 * 件26e：插件自带的回环中继（127.0.0.1 随机端口、http）。桌面端热更后宿主的 /mesh 旧路由可能还在，
 * 新实例不再依赖它：自己起一个中继口，用 mt 鉴权，热更后立即可用，无需重启。
 */
function startLocalRelay(ctx) {
	if (localRelayServer) return;
	const server = http.createServer((req, res) => {
		let pathname = "/";
		let search = "";
		let mt = "";
		try {
			const u = new URL(req.url || "/", "http://x");
			pathname = u.pathname;
			mt = u.searchParams.get("mt") || "";
			if (mt) {
				const params = new URLSearchParams(u.search);
				params.delete("mt");
				const q = params.toString();
				search = q ? `?${q}` : "";
			} else search = u.search;
		} catch {}
		const m = pathname.match(/^\/mesh\/([^/]+)(\/.*)?$/);
		if (!m) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
		const nodeId = decodeURIComponent(m[1]);
		const node = findNode(nodeId);
		if (!node) { res.writeHead(404, { "content-type": "text/plain" }); res.end("unknown node"); return; }
		const token = mtFromRequest(req, nodeId);
		const tokenOk = checkRelayToken(nodeId, token);
		if (!tokenOk) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("unauthorized"); return; }
		relayLogAdd("info", `local relay ${req.method} ${pathname} node=${nodeId} mt=ok`);
		proxyRelay(req, res, node, (m[2] || "/") + search);
	});
	server.on("upgrade", (req, socket, head) => {
		let pathname = "/";
		try { pathname = new URL(req.url || "/", "http://x").pathname; } catch {}
		const m = pathname.match(/^\/mesh\/([^/]+)\/api\/remote\.mux$/);
		if (!m) { socket.destroy(); return; }
		const nodeId = decodeURIComponent(m[1]);
		const node = findNode(nodeId);
		if (!node || !checkRelayToken(nodeId, mtFromRequest(req, nodeId))) { socket.destroy(); return; }
		const transport = peerTransport(node);
		if (!transport.ok) { socket.destroy(); return; }
		let target;
		try { target = new URL(node.viewUrl); } catch { socket.destroy(); return; }
		const lib = transport.isHttps ? https : http;
		const headers = relayHeaders(req, target);
		headers.connection = "Upgrade";
		headers.upgrade = req.headers.upgrade || "websocket";
		const up = lib.request({ host: transport.host, port: transport.port, path: "/api/remote.mux", method: "GET", headers, ...transport.options });
		up.on("upgrade", (upRes, upSocket, upHead) => {
			socket.write(`HTTP/1.1 101 ${upRes.statusMessage || "Switching Protocols"}\r\n`);
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (k === "set-cookie") continue;
				if (Array.isArray(v)) for (const x of v) socket.write(`${k}: ${x}\r\n`);
				else socket.write(`${k}: ${v}\r\n`);
			}
			socket.write("\r\n");
			if (upHead && upHead.length) socket.write(upHead);
			if (head && head.length) upSocket.write(head);
			upSocket.pipe(socket);
			socket.pipe(upSocket);
		});
		up.on("error", () => socket.destroy());
		up.end();
		socket.on("error", () => up.destroy());
	});
	server.requestTimeout = IO_TIMEOUT_MS;
	server.headersTimeout = IO_TIMEOUT_MS;
	server.keepAliveTimeout = 5000;
	server.listen(0, "127.0.0.1", () => {
		try {
			relayState.localPort = server.address().port;
			relayLogAdd("info", `local relay listening 127.0.0.1:${relayState.localPort}`);
			safeLog(ctx, "info", `dsh-mesh-panel: 本机中继 http://127.0.0.1:${relayState.localPort} 就绪`);
		} catch {}
	});
	server.on("error", (err) => { relayState.lastError = redact(err?.code || err?.message || err); });
	localRelayServer = server;
}
function stopLocalRelay() {
	const server = localRelayServer;
	localRelayServer = null;
	relayState.localPort = 0;
	if (!server) return;
	try { server.closeAllConnections?.(); } catch {}
	try { server.close(); } catch {}
}
function ensureRelay() {
	const seam = seams || null;
	if (!relayState.prefix) {
		if (Date.now() < relayRetryAt) return;
		relayRetryAt = Date.now() + 5000;
		if (!seam || typeof seam.webServerPrefix !== "function") { relayState.reason = "seam-no-route"; return; }
		relayLogAdd("info", `register prefix /mesh attempt seam=${Boolean(seam && typeof seam.webServerPrefix === "function")}`);
		const r = seam.webServerPrefix("/mesh", relayHandler);
		if (r && r.ok) {
			relayState.prefix = true; relayState.stale = false; relayState.reason = "";
			relayPrefixDispose = typeof r.dispose === "function" ? r.dispose : null;
			relayLogAdd("info", "register prefix /mesh ok");
		} else {
			relayState.reason = String(r?.reason || "prefix-failed");
			if (/duplicate prefix route/i.test(relayState.reason)) {
				// 旧实例的路由还挂在宿主上：不能当作可用中继（旧 handler 不认新令牌）。停用/重启插件后由 dispose 注销。
				relayState.prefix = true;
				relayState.stale = true;
				relayState.reason = "duplicate-existing-route";
				relayLogAdd("warn", "register prefix /mesh duplicate（旧实例路由仍在，中继暂不可用；请停用再启用插件或重启宿主）");
			} else relayLogAdd("warn", `register prefix /mesh failed: ${relayState.reason}`);
		}
	}
	if (!relayState.prefix) return;
	const st = ensureState();
	for (const node of Object.values(st.nodes)) {
		const path = `/mesh/${node.id}/api/remote.mux`;
		if (relayUpgrades.has(path)) continue;
		const r = seam.webServerUpgrade(path, makeRelayUpgrade(node.id));
		if (r && r.ok) { relayUpgrades.set(path, r.dispose); relayState.upgrades = relayUpgrades.size; }
		else relayState.reason = String(r?.reason || "upgrade-failed");
	}
}

/* ---------------- RPC handler ---------------- */
async function handler(endpoint, payload) {
	let result;
	try {
		if (endpoint === "get") result = await getView();
		else if (endpoint === "add") result = await addNode(payload);
		else if (endpoint === "code") result = await makeCode(payload?.nodeId);
		else if (endpoint === "pair") result = await pairNode(payload?.nodeId, payload?.code);
		else if (endpoint === "request") result = await requestPair(payload?.nodeId);
		else if (endpoint === "pair-status") result = await pairStatus(payload?.nodeId);
		else if (endpoint === "pending") result = { ok: true, pending: incomingPending(), self: selfInfo(null) };
		else if (endpoint === "approve") result = await approvePending(payload?.requestId);
		else if (endpoint === "reject") result = await rejectPending(payload?.requestId);
		else if (endpoint === "delete") result = await deleteNode(payload?.nodeId);
		else if (endpoint === "rename") result = await renameNode(payload?.nodeId, payload?.label);
		else if (endpoint === "settings") result = await getSettings();
		else if (endpoint === "set-settings") result = await setSettings(payload);
		else if (endpoint === "open") result = await openNode(payload?.nodeId);
		else if (endpoint === "reconnect") result = await reconnectNode(payload?.nodeId);
		else if (endpoint === "probe") result = await probeNode(payload?.nodeId);
		else if (endpoint === "set-address") result = await setAddress(payload?.nodeId, payload);
		else if (endpoint === "trust-check") result = await trustCheck(payload?.nodeId);
		else if (endpoint === "trust-cert") result = await trustCert(payload?.nodeId);
		else if (endpoint === "logs") result = await peerLogs(payload?.nodeId, payload);
		else if (endpoint === "retry-listen") result = await retryListen();
		else result = { ok: false, status: 404, error: { code: "unknown-endpoint", message: "unknown endpoint" } };
	} catch (err) {
		result = { ok: false, status: 500, error: { code: "exception", message: redact(err?.message ?? err) } };
	}
	if (result && result.ok) {
		const { ok, ...value } = result;
		return { ok: true, value };
	}
	const details = { status: result?.status || 0, ...(result?.error?.details || {}) };
	return { ok: false, error: { code: result?.error?.code || "error", message: result?.error?.message || String(result?.status || "error"), details } };
}

/* ---------------- 监听启动与热切换（件19） ---------------- */
let pluginCtx = null;
function buildListener(cfg, ctx) {
	let material = null;
	if (cfg.protocol === "https") {
		try {
			material = ensureTls();
		} catch (err) {
			return { error: `tls-init-failed: ${redact(err?.message ?? err)}` };
		}
	}
	const onRequest = (req, res) => {
		listener.requests++;
		if (listener.inflight >= listener.maxConcurrency) {
			listener.rejected++;
			return jsonReply(res, 503, { ok: false, error: { code: "busy", message: `并发上限 ${listener.maxConcurrency} 已满` } });
		}
		listener.inflight++;
		res.on("close", () => { listener.inflight = Math.max(0, listener.inflight - 1); });
		let pathname = "/";
		try { pathname = new URL(req.url || "/", "http://x").pathname; } catch {}
		if (pathname === "/health" || pathname === "/pair" || pathname.startsWith("/pair/") || pathname.startsWith("/ctl/")) {
			handleB(req, res, pathname).then((handled) => { if (handled === null) jsonReply(res, 404, { ok: false, error: { code: "not-found" } }); }).catch((err) => jsonReply(res, 500, { ok: false, error: { code: "exception", message: redact(err?.message ?? err) } }));
			return;
		}
		proxyHttp(req, res);
	};
	const onUpgrade = (req, socket, head) => {
		let pathname = "/";
		try { pathname = new URL(req.url || "/", "http://x").pathname; } catch {}
		if (pathname.startsWith("/ctl/") || pathname.startsWith("/pair") || pathname === "/health") { socket.destroy(); return; }
		proxyUpgrade(req, socket, head);
	};
	let server;
	try {
		server = cfg.protocol === "https"
			? https.createServer({ key: material.key, cert: material.cert, minVersion: "TLSv1.2" }, onRequest)
			: http.createServer(onRequest);
	} catch (err) {
		return { error: `server-create-failed: ${redact(err?.message ?? err)}` };
	}
	server.requestTimeout = IO_TIMEOUT_MS;
	server.headersTimeout = IO_TIMEOUT_MS;
	server.keepAliveTimeout = 5000;
	server.setTimeout(IO_TIMEOUT_MS, (socket) => { listener.timeouts++; socket.destroy(); });
	server.on("upgrade", onUpgrade);
	server.on("error", (err) => {
		listener.ok = false;
		listener.error = `${err.code || "listen-error"}: ${String(err.message || err)}`;
		safeLog(ctx, "warn", `dsh-mesh-panel: 监听 ${listener.bind}:${listener.port} 失败 ${listener.error}`);
	});
	const sockets = new Set();
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.__meshSockets = sockets;
	return { server, material };
}
function listenAsync(server, cfg) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => { if (settled) return; settled = true; server.off("error", onError); server.off("listening", onListening); resolve(value); };
		const onError = (err) => finish({ ok: false, error: `${err.code || "listen-error"}: ${String(err.message || err)}` });
		const onListening = () => finish({ ok: true });
		server.once("error", onError);
		server.once("listening", onListening);
		try { server.listen(cfg.port, cfg.bind); } catch (err) { finish({ ok: false, error: `${err.code || "listen-error"}: ${String(err.message || err)}` }); }
	});
}
async function closeServer(server) {
	if (!server) return;
	try { server.closeAllConnections?.(); } catch {}
	try { for (const socket of server.__meshSockets || []) { try { socket.destroy(); } catch {} } } catch {}
	await new Promise((resolve) => {
		let done = false;
		const finish = () => { if (!done) { done = true; resolve(); } };
		try { server.close(finish); } catch { finish(); }
		setTimeout(finish, 1500);
	});
}
/* ---------------- 监听接管（件23b：热更/升级不再报“端口已被使用”） ---------------- */
const LISTENER_REGISTRY_KEY = Symbol.for("dsh-mesh-panel.listeners.v1");
const LISTEN_RETRY_MS = 3000;
const LISTEN_RETRY_MAX = 20;
let listenRetryTimer = null;
let listenRetryCount = 0;
function listenerRegistry() {
	const g = globalThis;
	if (!g[LISTENER_REGISTRY_KEY]) g[LISTENER_REGISTRY_KEY] = new Map();
	return g[LISTENER_REGISTRY_KEY];
}
function listenerKey(cfg) { return `${DSH_HOME}|${cfg.protocol}|${cfg.bind}|${cfg.port}`; }
/** 同一进程内的旧模块实例：直接关掉它再绑定（热更新主路径）。 */
async function takeOverRegistered(cfg) {
	const reg = listenerRegistry();
	const prev = reg.get(listenerKey(cfg));
	if (!prev) return false;
	reg.delete(listenerKey(cfg));
	try { await closeServer(prev.server); } catch {}
	relayLogAdd("info", `接管同进程上一实例监听 ${listenerKey(cfg)}（v${prev.version}）`);
	return true;
}
function rememberListener(server, cfg) { listenerRegistry().set(listenerKey(cfg), { server, version: VERSION, at: Date.now(), pid: process.pid }); }
function forgetListener(cfg, server) {
	try {
		const reg = listenerRegistry();
		const key = listenerKey(cfg);
		const cur = reg.get(key);
		if (!cur) return;
		if (!server || cur.server === server) reg.delete(key);
	} catch {}
}
function clearListenRetry() { if (listenRetryTimer) { clearInterval(listenRetryTimer); listenRetryTimer = null; } listenRetryCount = 0; }
/** 端口探测：拿 /health 的 nodeId 判断占用者是不是“同一插件实例”（同 DSH_HOME 共享 instanceId）。 */
async function probeSelfHealth(cfg) {
	const host = cfg.bind === "0.0.0.0" || cfg.bind === "::" || !cfg.bind ? "127.0.0.1" : cfg.bind;
	const lib = cfg.protocol === "http" ? http : https;
	return await new Promise((resolve) => {
		let settled = false;
		const done = (v) => { if (settled) return; settled = true; resolve(v); };
		const req = lib.request({ host, port: cfg.port, path: "/health", method: "GET", rejectUnauthorized: false, timeout: 2500, headers: { accept: "application/json" } }, (res) => {
			let text = "";
			res.on("data", (c) => { text += c; });
			res.on("end", () => { let j = null; try { j = JSON.parse(text); } catch {} done(j?.value || null); });
		});
		req.on("error", () => done(null));
		req.on("timeout", () => { try { req.destroy(); } catch {} done(null); });
		req.end();
	});
}
async function classifyListenError(errText, cfg) {
	if (/EADDRINUSE/.test(String(errText || ""))) {
		const v = await probeSelfHealth(cfg);
		if (v && v.nodeId && v.nodeId === ensureState().instanceId) {
			return { code: "self-held", message: `端口 ${cfg.bind}:${cfg.port} 被同一插件的上一实例占用（热更新未释放）；正在等待其释放，30 秒内未恢复请重启 DSH` };
		}
		if (v && v.nodeId) return { code: "port-other", message: `端口 ${cfg.bind}:${cfg.port} 被另一个 mesh 节点占用（nodeId ${String(v.nodeId).slice(0, 14)}），请改端口` };
		return { code: "port-in-use", message: `端口 ${cfg.bind}:${cfg.port} 被其它程序占用，请改端口或停掉占用进程` };
	}
	return { code: "listen-failed", message: String(errText || "listen failed") };
}
function scheduleListenRetry(ctx) {
	if (listenRetryTimer) return;
	listenRetryTimer = setInterval(() => {
		listenRetryCount++;
		if (listenRetryCount > LISTEN_RETRY_MAX) {
			clearListenRetry();
			listener.errorCode = "self-held-timeout";
			listener.error = `端口 ${listener.bind}:${listener.port} 仍被上一实例占用；请重启 DSH 完成切换（或改端口）`;
			return;
		}
		startListener(ctx, { noRetry: true }).then((r) => { if (r.ok) relayLogAdd("info", "监听接管成功（上一实例已释放）"); }).catch(() => {});
	}, LISTEN_RETRY_MS);
	if (typeof listenRetryTimer.unref === "function") listenRetryTimer.unref();
}
/** 进程退出/热更 dispose：关监听、释放中继路由、清注册表，下一次加载才能拿到端口。 */
function disposeListener() {
	clearListenRetry();
	stopLocalRelay();
	for (const [, dispose] of relayUpgrades) { try { dispose(); } catch {} }
	relayUpgrades.clear();
	try { if (typeof relayPrefixDispose === "function") relayPrefixDispose(); } catch {}
	relayPrefixDispose = null;
	relayState.prefix = false;
	relayState.stale = false;
	relayState.reason = "";
	relayState.upgrades = 0;
	const server = listenerServer;
	listenerServer = null;
	listener.ok = false;
	if (server) {
		try { forgetListener(ensureState().settings, server); } catch {}
		closeServer(server).catch(() => {});
	}
}
function applyListenerInfo(cfg) {
	listener.port = cfg.port;
	listener.bind = cfg.bind;
	listener.protocol = cfg.protocol;
	listener.maxConcurrency = cfg.maxConcurrency;
	listener.certFingerprint = cfg.protocol === "https" ? certFingerprint() : "";
}
async function startListener(ctx, opts = {}) {
	if (listenerServer && listener.ok) return { ok: true };
	const cfg = ensureState().settings;
	applyListenerInfo(cfg);
	await takeOverRegistered(cfg);
	if (listenerServer && listener.ok) return { ok: true };
	const built = buildListener(cfg, ctx);
	if (built.error) {
		listener.ok = false;
		listener.tlsError = built.error;
		listener.error = built.error;
		listener.errorCode = "build-failed";
		safeLog(ctx, "warn", `dsh-mesh-panel: 监听构建失败 ${built.error}（拒绝降级明文）`);
		return { ok: false, error: built.error, code: "build-failed" };
	}
	const server = built.server;
	const r = await listenAsync(server, cfg);
	if (!r.ok) {
		try { server.close(); } catch {}
		const cls = await classifyListenError(r.error, cfg);
		listener.ok = false;
		listener.error = cls.message;
		listener.errorCode = cls.code;
		safeLog(ctx, "warn", `dsh-mesh-panel: 监听 ${cfg.bind}:${cfg.port} 失败 ${cls.message}`);
		if (cls.code === "self-held" && !opts.noRetry) scheduleListenRetry(ctx);
		return { ok: false, error: cls.message, code: cls.code };
	}
	clearListenRetry();
	listenerServer = server;
	rememberListener(server, cfg);
	listener.ok = true;
	listener.error = "";
	listener.errorCode = "";
	listener.startedAt = new Date().toISOString();
	safeLog(ctx, "info", `dsh-mesh-panel: 监听 ${listener.protocol}://${cfg.bind}:${cfg.port} 就绪 cert=${fingerprintPrefix(listener.certFingerprint, 4)}`);
	return { ok: true };
}
async function retryListen() {
	const r = await startListener(pluginCtx, { noRetry: false });
	return { ok: Boolean(r.ok), listener: { ok: listener.ok, port: listener.port, bind: listener.bind, protocol: listener.protocol, error: listener.error, errorCode: listener.errorCode || "" }, error: r.error || "" };
}
/** 热切换：先关旧监听再按新配置重建；新监听失败则按旧配置回滚。 */
async function switchListener(cfg) {
	const ctx = pluginCtx;
	const oldCfg = { port: listener.port, bind: listener.bind, protocol: listener.protocol, maxConcurrency: listener.maxConcurrency };
	const oldServer = listenerServer;
	listenerServer = null;
	applyListenerInfo(cfg);
	const built = buildListener(cfg, ctx);
	if (built.error) {
		const rollback = await rollbackListener(oldServer, oldCfg, ctx);
		return { ok: false, error: `${built.error}${rollback.ok ? "；已回滚旧监听" : `；回滚失败：${rollback.error}`}`, rolledBack: rollback.ok };
	}
	await closeServer(oldServer);
	forgetListener(oldCfg, oldServer);
	const res = await listenAsync(built.server, cfg);
	if (!res.ok) {
		const rollback = await rollbackListener(oldServer, oldCfg, ctx);
		return { ok: false, error: `${res.error}${rollback.ok ? "；已回滚旧监听" : `；回滚失败：${rollback.error}`}`, rolledBack: rollback.ok };
	}
	listenerServer = built.server;
	rememberListener(built.server, cfg);
	listener.ok = true;
	listener.error = "";
	listener.errorCode = "";
	listener.startedAt = new Date().toISOString();
	safeLog(ctx, "info", `dsh-mesh-panel: 监听热切换到 ${cfg.protocol}://${cfg.bind}:${cfg.port} cert=${fingerprintPrefix(listener.certFingerprint, 4)}`);
	return { ok: true };
}
async function rollbackListener(oldServer, oldCfg, ctx) {
	applyListenerInfo(oldCfg);
	if (oldServer && oldServer.listening) {
		listenerServer = oldServer;
		rememberListener(oldServer, oldCfg);
		listener.ok = true;
		listener.error = "";
		listener.errorCode = "";
		return { ok: true };
	}
	const built = buildListener(oldCfg, ctx);
	if (built.error) { listener.ok = false; listener.error = built.error; return { ok: false, error: built.error }; }
	const r = await listenAsync(built.server, oldCfg);
	if (!r.ok) { listener.ok = false; listener.error = r.error; return { ok: false, error: r.error }; }
	listenerServer = built.server;
	rememberListener(built.server, oldCfg);
	listener.ok = true;
	listener.error = "";
	listener.errorCode = "";
	return { ok: true };
}

export async function apply(ctx) {
	pluginCtx = ctx;
	try {
		try { ensureState(); saveState(); } catch {}
		let cap = await capability(ctx);
		for (let i = 0; i < 5 && cap.state !== "OK"; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			cap = await capability(ctx);
		}
		lastCap = cap;
		try {
			const compat = await import("@ericality/dsh-host-compat");
			if (compat && typeof compat.report === "function") compat.report({ ...cap, id: PLUGIN_ID, version: VERSION, note: "mesh panel" });
		} catch {}
		if (cap.state !== "OK") {
			safeLog(ctx, "warn", `dsh-mesh-panel: DEGRADED missing=[${(cap.missing || []).join(",")}] reason=${cap.reason || "-"}`);
			return;
		}
		if (typeof ctx?.on === "function") {
			try { ctx.on("dispose", disposeListener); } catch {}
		}
		const seam = await loadSeams();
		let registered = typeof seam?.channelFace === "function" ? seam.channelFace(ctx, "mesh-panel", ENDPOINTS, handler) : null;
		let via = registered?.ok === true ? "channelFace" : "";
		if (!registered || registered.ok !== true) {
			registered = seam?.rpcHandle?.(ctx, CHANNEL, handler);
			if (registered) via = "rpcHandle";
		}
		if (!registered || registered.ok !== true) {
			lastCap = { ...cap, state: "DEGRADED", reason: registered?.reason || "rpc" };
			safeLog(ctx, "warn", `dsh-mesh-panel: DEGRADED rpc=${registered?.reason || "unknown"}`);
			return;
		}
		try { await resolveGuiPort(); } catch {}
		await startListener(ctx);
		startLocalRelay(ctx);
		safeLog(ctx, "info", `dsh-mesh-panel: OK ${CHANNEL} via=${via} endpoints=${ENDPOINTS.length} listen=${listener.protocol}://${listener.bind}:${listener.port} guiPort=${guiPort()}`);
	} catch (err) {
		safeLog(ctx, "warn", `dsh-mesh-panel: apply failed ${String(err?.message ?? err)}`);
	}
}
