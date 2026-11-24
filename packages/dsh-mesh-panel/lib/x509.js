// dsh-mesh-panel · 自签证书（件17）
// 目标是零第三方依赖：只用 node:crypto 生成 RSA 密钥，并用本文件内的最小 DER 编码器拼 X.509 v3。
// 证书用途：B 面监听启用 https；指纹（sha256 of DER）由 /health 暴露，对端配对时钉住。
// 设计取舍：
// - 自签 + basicConstraints CA:TRUE（自签根当叶用），这样 Node 侧可用 `ca: <对端证书 PEM>` 做链校验，握手阶段即拒绝，
//   不会把请求头先发出去再校验；同时浏览器直连仍会因不受信任而告警（这是自签的固有代价，面板改走同源中继）。
// - SAN 写回环、全部非内网卡地址与主机名；IP 变化后指纹不变、SAN 过期不影响钉住（钉住只比指纹，不做主机名校验）。
import crypto from "node:crypto";
import os from "node:os";

const OID = {
	commonName: "2.5.4.3",
	organization: "2.5.4.10",
	sha256WithRsa: "1.2.840.113549.1.1.11",
	basicConstraints: "2.5.29.19",
	keyUsage: "2.5.29.15",
	extKeyUsage: "2.5.29.37",
	subjectAltName: "2.5.29.17",
	serverAuth: "1.3.6.1.5.5.7.3.1",
};

function derLen(n) {
	if (n < 0x80) return Buffer.from([n]);
	const bytes = [];
	let v = n;
	while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, content) {
	return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
const seq = (...items) => der(0x30, Buffer.concat(items));
const setOf = (...items) => der(0x31, Buffer.concat(items));
const nullDer = Buffer.from([0x05, 0x00]);
const boolDer = (v) => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (buf) => der(0x04, buf);
const utf8 = (s) => der(0x0c, Buffer.from(String(s), "utf8"));
const ia5 = (s) => der(0x16, Buffer.from(String(s), "ascii"));
const bitString = (buf, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const ctxExplicit = (n, content) => der(0xa0 | n, content);
const ctxPrimitive = (n, content) => der(0x80 | n, content);

function derInt(buf) {
	let i = 0;
	while (i < buf.length - 1 && buf[i] === 0) i += 1;
	let out = buf.subarray(i);
	if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0]), out]);
	return der(0x02, out);
}
function derOid(str) {
	const parts = String(str).split(".").map(Number);
	const bytes = [parts[0] * 40 + parts[1]];
	for (let i = 2; i < parts.length; i += 1) {
		const stack = [parts[i] & 0x7f];
		let v = Math.floor(parts[i] / 128);
		while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
		bytes.push(...stack);
	}
	return der(0x06, Buffer.from(bytes));
}
function utcTime(date) {
	const s = date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
	return der(0x17, Buffer.from(s, "ascii"));
}
function name(cn, org) {
	return seq(
		setOf(seq(derOid(OID.commonName), utf8(cn))),
		setOf(seq(derOid(OID.organization), utf8(org))),
	);
}
function ipBytes(ip) {
	if (!ip) return null;
	if (ip.includes(":")) return ipv6Bytes(ip);
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
	return Buffer.from(parts);
}
function ipv6Bytes(ip) {
	const [head, tail = ""] = ip.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const gap = 8 - left.length - right.length;
	const groups = ip.includes("::") ? [...left, ...Array(Math.max(gap, 0)).fill("0"), ...right] : left;
	if (groups.length !== 8) return null;
	const buf = Buffer.alloc(16);
	groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || "0", 16) & 0xffff, i * 2));
	return buf;
}
function localIps() {
	const out = new Set(["127.0.0.1", "::1"]);
	try {
		for (const list of Object.values(os.networkInterfaces())) {
			for (const it of list || []) if (it && !it.internal && (it.family === "IPv4" || it.family === 4)) out.add(it.address);
		}
	} catch {}
	return [...out];
}
function sanExtension(ips) {
	const names = ["localhost", os.hostname()].filter(Boolean);
	const items = names.map((n) => ctxPrimitive(2, Buffer.from(n, "ascii")));
	for (const ip of ips) {
		const b = ipBytes(ip);
		if (b && b.length) items.push(ctxPrimitive(7, b));
	}
	return seq(derOid(OID.subjectAltName), octet(seq(...items)));
}
function extensions(ips) {
	return ctxExplicit(3, seq(
		seq(derOid(OID.basicConstraints), boolDer(true), octet(seq(boolDer(true)))),
		seq(derOid(OID.keyUsage), boolDer(true), octet(bitString(Buffer.from([0xa4]), 2))),
		seq(derOid(OID.extKeyUsage), octet(seq(derOid(OID.serverAuth)))),
		sanExtension(ips),
	));
}

export function certPem(derBuf) {
	const b64 = derBuf.toString("base64").match(/.{1,64}/g).join("\n");
	return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}
export function keyPem(key) {
	const pem = key.export({ type: "pkcs8", format: "pem" });
	return String(pem);
}

// 规范化指纹：统一成小写十六进制、无分隔符；输入允许带冒号/空格/大写。
export function normalizeFingerprint(fp) {
	return String(fp || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}
export function displayFingerprint(fp) {
	const hex = normalizeFingerprint(fp).toUpperCase();
	return hex.replace(/(.{2})(?=.)/g, "$1:");
}
export function fingerprintPrefix(fp, bytes = 6) {
	return displayFingerprint(normalizeFingerprint(fp).slice(0, bytes * 2));
}
export function fingerprintOf(certDer) {
	return normalizeFingerprint(crypto.createHash("sha256").update(certDer).digest("hex"));
}

/**
 * 生成自签密钥与证书。
 * @param {{commonName?: string, days?: number, ips?: string[]}} opts
 * @returns {{keyPem: string, certPem: string, fingerprint: string, notBefore: string, notAfter: string, subject: string}}
 */
export function createSelfSignedCertificate(opts = {}) {
	const cn = String(opts.commonName || "dsh-mesh-panel").slice(0, 64);
	const days = Number(opts.days) > 0 ? Number(opts.days) : 3650;
	const ips = Array.isArray(opts.ips) && opts.ips.length ? opts.ips : localIps();
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
	const spki = publicKey.export({ type: "spki", format: "der" });
	const notBefore = new Date(Date.now() - 3600 * 1000);
	const notAfter = new Date(Date.now() + days * 24 * 3600 * 1000);
	const serial = crypto.randomBytes(8);
	serial[0] &= 0x7f;
	const tbs = seq(
		ctxExplicit(0, derInt(Buffer.from([2]))),
		derInt(serial),
		seq(derOid(OID.sha256WithRsa), nullDer),
		name(cn, "dsh-mesh-panel self-signed"),
		seq(utcTime(notBefore), utcTime(notAfter)),
		name(cn, "dsh-mesh-panel self-signed"),
		spki,
		extensions(ips),
	);
	const signature = crypto.sign("sha256", tbs, privateKey);
	const certDer = seq(tbs, seq(derOid(OID.sha256WithRsa), nullDer), bitString(signature));
	const fingerprint = fingerprintOf(certDer);
	return {
		keyPem: keyPem(privateKey),
		certPem: certPem(certDer),
		fingerprint,
		notBefore: notBefore.toISOString(),
		notAfter: notAfter.toISOString(),
		subject: `CN=${cn}`,
	};
}

/** 解析 PEM 证书，返回指纹（规范化）与主题；失败返回 null。 */
export function inspectCertificate(pemText) {
	try {
		const cert = new crypto.X509Certificate(String(pemText));
		return { fingerprint: fingerprintOf(cert.raw), subject: cert.subject, validTo: cert.validTo };
	} catch {
		return null;
	}
}
