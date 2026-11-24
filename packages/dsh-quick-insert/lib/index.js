import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** 数据根：DSH_HOME（缺省 ~/.dsh）；本插件自有数据落 <root>/plugin-data/quick-insert/。 */
const DSH_HOME = process.env.DSH_HOME || joinPath(homedir(), ".dsh");
const PLUGIN_DATA = joinPath(DSH_HOME, "plugin-data", "quick-insert");

/**
 * @deepseek-ai/dsh-quick-insert (本地辅助插件, 非官方包)
 *
 * 快速插入按钮: 输入框上方一行可横向滑动的"悬浮"按钮, 点击把按钮文本插入
 * 到输入框光标处。按钮列表可在 设置 > 本地插件 > 快速插入 里增删改。
 *
 * 服务端职责:
 *   - 注册框架通用 RPC 通道 /quick-insert (get/set/reset), 供客户端
 *     (输入框按钮行 + 设置卡片) 读写按钮配置 —— 零 token, 不走模型回合;
 *     通道信任策略与 /api 一致 (options 传 {} → trustedHosts, 隧道/局域网可访问)。
 *   - 配置由宿主官方 Config 保存（volatile 字段），旧 quick-insert.json 首次启动自动迁移。
 *
 * 配置值走宿主官方 Config：远端浏览器保存由宿主校验并写入 profile，重启后仍在。
 * 卡片仍经 RPC 读写，便于逐项编辑与即时生效。
 */

export const name = "dsh-quick-insert";
export const inject = ["connection"];

import z from "@deepseek-ai/schemastery";
import { existsSync, renameSync } from "node:fs";

/** 配置状态文件（仅用于旧版迁移，迁移后改名 .bak）。 */
const STATE_FILE = process.env.DSH_QUICK_INSERT_STATE_FILE || joinPath(PLUGIN_DATA, "quick-insert.json");

/** 内置默认按钮（可被配置覆盖；重置回到这里）。 */
const DEFAULT_BUTTONS = [
	{ label: "/cost", text: "/cost" },
	{ label: "/balance", text: "/balance" },
	{ label: "/sessions-cost", text: "/sessions-cost" },
	{ label: "/finish", text: "/finish" },
	{ label: "/handoff", text: "/handoff" },
	{ label: "/queue", text: "/queue" },
	{ label: "落盘吧", text: "落盘吧" },
	{ label: "先计划后执行", text: "先给出简短计划并与我确认，再开始执行。" }
];

/** 官方 Config：按钮列表可在插件页直接编辑，保存即生效。 */
export const Config = z.object({
	buttons: z.array(z.object({ label: z.string(), text: z.string() })).default(DEFAULT_BUTTONS).volatile()
});

/** 设置服务（显式解析，避免 inject 守卫）。 */
const settingsOf = (ctx) => { try { return ctx.get?.("settings", false) || null; } catch { return null; } };

/** volatile 叶子在运行态是带 get() 的引用。 */
const val = (x, fallback) => {
	try { return x && typeof x.get === "function" ? x.get() : (x === undefined || x === null ? fallback : x); } catch { return fallback; }
};

/** 清理按钮数组（只保留合法字符串字段）。 */
function cleanButtons(buttons) {
	return Array.isArray(buttons)
		? buttons
			.filter((b) => b && typeof b.label === "string" && typeof b.text === "string")
			.map((b) => ({ label: b.label, text: b.text }))
		: [];
}

/** 当前按钮：配置优先级最高，缺省用内置默认。 */
export function readButtons(config) {
	const buttons = cleanButtons(val(config && config.buttons, []));
	return buttons.length ? buttons : DEFAULT_BUTTONS.map((b) => ({ label: b.label, text: b.text }));
}

/** 旧状态文件一次性迁移到官方 Config（只在用户层为空时执行）。 */
async function migrateLegacy(ctx) {
	try {
		if (!existsSync(STATE_FILE)) return false;
		let user = null;
		try { user = settingsOf(ctx)?.describe?.()?.find((row) => row.ns === "quick-insert")?.user; } catch { user = null; }
		if (user && Object.keys(user).length) return false;
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		const buttons = cleanButtons(parsed && parsed.buttons);
		if (buttons.length) {
			try { await settingsOf(ctx)?.update("quick-insert", { buttons }); }
			catch (err) { try { ctx.logger?.warn?.(`${name}: 旧按钮迁移失败（保留旧文件）: ${String(err?.message ?? err)}`); } catch { /* ignore */ } return false; }
		}
		try { renameSync(STATE_FILE, `${STATE_FILE}.bak`); } catch { /* ignore */ }
		return true;
	} catch (err) {
		try { ctx.logger?.warn?.(`${name}: 旧配置迁移异常（已忽略）: ${String(err?.message ?? err)}`); } catch { /* ignore */ }
		return false;
	}
}

/**
 * 插件主体。
 * @param ctx - cordis 上下文 (connection 服务经 inject 注入)。
 * @param config - 宿主官方 Config（volatile 字段现读）。
 */
export async function apply(ctx, config) {
	try {
		ctx.inject(["settings"], (child) => { Promise.resolve().then(() => migrateLegacy(child)).catch(() => {}); });
	} catch { Promise.resolve().then(() => migrateLegacy(ctx)).catch(() => {}); }
	// /quick-insert RPC 通道（卡片仍用该通道做逐项编辑；落盘走宿主 Config）:
	//   get → { ok, value:{ buttons } }；set → 保存；reset → 恢复内置默认。
	const handler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "get":
				return { ok: true, value: { buttons: readButtons(config) } };
			case "set": {
				const buttons = cleanButtons(payload?.buttons);
				if (!buttons.length) return { ok: false, error: { code: "bad-request", message: "按钮列表为空" } };
				await settingsOf(ctx)?.update("quick-insert", { buttons });
				return { ok: true, value: { buttons: readButtons(config) } };
			}
			case "reset":
				await settingsOf(ctx)?.update("quick-insert", { buttons: DEFAULT_BUTTONS });
				return { ok: true, value: { buttons: readButtons(config) } };
			default:
				return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-quick-insert: /quick-insert RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	};

	const _eps = ["get", "set", "reset"];
	const _qiLegacy = () => { try { ctx.get?.("connection")?.rpc?.handle?.("/quick-insert", handler); } catch (err) { ctx.logger?.warn?.(`dsh-quick-insert: 旧通道注册失败（预期，0.2.2）${String(err?.message ?? err)}`); } };
	import("@ericality/dsh-host-compat/seams").then((seams) => {
		if (typeof seams?.channelFace !== "function") { _qiLegacy(); return; }
		const face = seams.channelFace(ctx, "/quick-insert", _eps, handler);
		if (!face?.ok) { ctx.logger?.warn?.(`dsh-quick-insert: Fetch 通道注册失败 ${JSON.stringify(face?.results ?? [])}`); _qiLegacy(); }
	}).catch(() => _qiLegacy());
}
