window.__ModuleLoader__.load({
	id: "@ericality/dsh-host-compat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		// =====================================================================
		// dsh-host-compat · 客户端（阶段 1 · B1 线）
		//
		// 落点（契约 §7 / RD-7）: 「设置 > 本地插件」列
		//   · body 槽   settings.localplugin.item     key = host-compat
		//   · 兄弟摘要槽 settings.localplugin.summary  key = host-compat（必须同 key）
		//   折叠胶囊卡契约（docs/UI改动流程.md §二）: 卡**只注册 body** +
		//   summary 兄弟槽（只画 图标/标题/「本地插件」徽标/实时摘要）——
		//   胶囊外壳 / 标题行 / 外层 padding / 箭头 / 折叠记忆（dsh-lp-open）**全部由容器
		//   （dsh-quick-insert）提供**，本卡一律不自绘、不自己实现记忆逻辑。
		//
		// 数据源（契约 §7）: RPC /host-compat/status —— **打开卡片时拉一次**；
		//   **不轮询、不定时器**（唯一二次入口 = 错误态的「重试」按钮）。
		//   打开判定 = 卡体外层 <details class="dsh-lp-card"> 的 open 态/toggle 事件；
		//   容器降级为 .dsh-lp-flat（无折叠）时挂载即拉一次。
		//
		// 渲染字段（严格 §7 字段表，**禁止发明字段**）:
		//   每插件一行 id / version / 状态徽标 / missing 摘要 / note；
		//   顶部 host.version + probedAt（**按浏览器本地时区格式化的「探测于 HH:MM」**，RD-13）。
		//   状态色: OK #22c55e · DEGRADED #f59e0b · BLOCKED #ef4444（用户 D1 裁定）。
		//   §5 的 blocked[] **不渲染**（用户 D8 裁定；RD-12 ⇒ blocked ⊆ missing，语义由
		//   徽标 + missing 摘要 + note 三处承载）。
		//
		// 空/异常（§7 空/异常行）: 无状态文件（plugins 空 + probedAt 空）⇒「尚未探测」；
		//   RPC 失败 ⇒ 错误态块（含错误码 +「重试」）；两条路径都**不崩、不空白**。
		//
		// dismiss（契约 §8 语义 / RD-14）: 「本版本不再提示」→ RPC /host-compat/dismiss
		//   payload { hostVersion, capabilitySignature }；签名取 status 响应的 **追加字段**
		//   capabilitySignature（A 线已实现，落盘文件仍严格 §5 六键）；**该字段缺失 ⇒ 传空串**
		//   （服务端用当前签名兜底），UI 不报错、不抛。
		//
		// CSS 变量作用域（docs/UI改动流程.md §三；2026-09-12 事故后强制）:
		//   凡**间接引用 --dsw-alias-\* 的自定义属性**一律声明在 **body 之内的元素**上，消费端带兜底。
		//   本文件注入的 CSS **只有一条自定义属性声明** =
		//     .dsh-lp-card[data-lp-key="host-compat"]{--lp-accent:#818cf8}
		//   它是**字面量**且落在 body 之内的卡元素上（卡主题色显式声明，用户 D2 裁定）；
		//   其余规则只**消费** dsw 变量并逐处带兜底。**本文件不写 :root**。
		// =====================================================================

		var CARD_KEY = "host-compat";
		var NS = "ui-host-compat";
		var CHANNEL = "/host-compat";

		/** §7 状态色（逐值取自契约；BLOCKED = 错误红，用户 D1 裁定） */
		var STATE_COLOR = { OK: "#22c55e", DEGRADED: "#f59e0b", BLOCKED: "#ef4444" };
		/** §5: 全域 state = 最坏者 */
		var STATE_RANK = { OK: 0, DEGRADED: 1, BLOCKED: 2 };

		// ---------- 样式（hc-* 家族 = 预览 public/preview-host-compat.html 区块 4 逐值同款;
		// 预览里的 --pv-bd/--pv-bg-soft 属预览页壳变量, 此处换成宿主 dsw 语义变量 + 兜底） ----------
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-hc-card-css")) return;
			try {
				var st = document.createElement("style");
				st.id = "dsh-hc-card-css";
				st.textContent = [
					// 卡根不自绘胶囊外壳/标题行（UI改动流程 §二.2）: border/background/圆角/外层 padding 一律不写
					".hc-card{display:flex;flex-direction:column;gap:11px;min-width:0}",
					// 卡主题色（用户 D2 裁定）: 显式声明靛蓝 —— 实测容器按 key 哈希给的是 #4176e6，
					// 与 notify/taskqueue 主题蓝同值（违反「相邻卡片不同色」）⇒ 显式声明最稳。
					// ⚠️ §三: 这是 body 之内元素上的**字面量**声明, 不引用 dsw 变量, 更不在 :root。
					".dsh-lp-card[data-lp-key=\"host-compat\"]{--lp-accent:#818cf8}",
					// 顶部元信息行（探测于 / 宿主版本 / 全域状态 / 计数）
					".hc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b2)}",
					".hc-meta .hc-k{color:var(--dsw-alias-label-tertiary,#9aa3b2)}",
					".hc-meta .hc-v{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#eceff4)}",
					// 状态徽标（§7 状态色）
					".hc-agg{font-size:11px;font-weight:700;border-radius:999px;padding:0 9px;line-height:17px;border:1px solid transparent}",
					".hc-agg[data-state=\"OK\"]{color:#22c55e;background:color-mix(in srgb,#22c55e 15%,transparent);border-color:color-mix(in srgb,#22c55e 42%,transparent)}",
					".hc-agg[data-state=\"DEGRADED\"]{color:#f59e0b;background:color-mix(in srgb,#f59e0b 15%,transparent);border-color:color-mix(in srgb,#f59e0b 42%,transparent)}",
					".hc-agg[data-state=\"BLOCKED\"]{color:#ef4444;background:color-mix(in srgb,#ef4444 15%,transparent);border-color:color-mix(in srgb,#ef4444 42%,transparent)}",
					// 插件行（每插件一行: id / version / 状态徽标 / missing 摘要 / note）
					".hc-rows{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:10px;overflow:hidden}",
					".hc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06))}",
					".hc-row+.hc-row{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}",
					".hc-st{font-size:10.5px;font-weight:700;letter-spacing:.3px;border-radius:999px;padding:0 8px;line-height:17px;flex:none;border:1px solid transparent;font-variant-numeric:tabular-nums}",
					".hc-st[data-state=\"OK\"]{color:#22c55e;background:color-mix(in srgb,#22c55e 16%,transparent);border-color:color-mix(in srgb,#22c55e 45%,transparent)}",
					".hc-st[data-state=\"DEGRADED\"]{color:#f59e0b;background:color-mix(in srgb,#f59e0b 16%,transparent);border-color:color-mix(in srgb,#f59e0b 45%,transparent)}",
					".hc-st[data-state=\"BLOCKED\"]{color:#ef4444;background:color-mix(in srgb,#ef4444 16%,transparent);border-color:color-mix(in srgb,#ef4444 45%,transparent)}",
					".hc-id{font-size:12px;font-weight:700;font-family:ui-monospace,\"SF Mono\",Consolas,monospace;color:var(--dsw-alias-label-primary,#eceff4)}",
					".hc-ver{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b2);font-variant-numeric:tabular-nums}",
					".hc-miss{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b2);min-width:0}",
					".hc-miss code,.hc-state code{font-family:ui-monospace,\"SF Mono\",Consolas,monospace;font-size:10.5px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:4px;padding:0 4px}",
					".hc-note{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa3b2);text-align:right;min-width:0}",
					// 浅色主题: 状态色**文字**压暗（用户 D9 裁定; 圆点/描边仍是契约原值）
					"body:not([data-ds-dark-theme]) .hc-st[data-state=\"OK\"],body:not([data-ds-dark-theme]) .hc-agg[data-state=\"OK\"]{color:#15803d}",
					"body:not([data-ds-dark-theme]) .hc-st[data-state=\"DEGRADED\"],body:not([data-ds-dark-theme]) .hc-agg[data-state=\"DEGRADED\"]{color:#b45309}",
					// 空态（轻量, 右下角一行）与错误态（整行块 + 重试）
					".hc-empty{align-self:flex-end;text-align:right;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#9aa3b2)}",
					".hc-empty b{color:var(--dsw-alias-label-primary,#eceff4);font-weight:600}",
					".hc-err{border:1px solid color-mix(in srgb,#ef4444 45%,transparent);background:color-mix(in srgb,#ef4444 8%,transparent);border-radius:10px;padding:8px 11px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#9aa3b2)}",
					".hc-err .hc-err-t{font-weight:700;font-size:12.5px;color:#ef4444;margin-bottom:2px}",
					".hc-err .hc-err-a{margin-top:6px}",
					".hc-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.22));padding-top:9px}",
					".hc-btn{box-sizing:border-box;height:26px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid color-mix(in srgb,var(--lp-accent,#818cf8) 45%,transparent);border-radius:13px;color:var(--lp-accent,#818cf8);background:transparent;padding:0 12px;flex:none}",
					".hc-btn:hover:not(:disabled){background:color-mix(in srgb,var(--lp-accent,#818cf8) 14%,transparent)}",
					".hc-btn:disabled{opacity:.5;cursor:default}",
					".hc-hint{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#9aa3b2);margin:0;min-width:0}",
					".hc-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:11px}",
					".hc-bad{color:var(--dsw-alias-state-danger-primary,#ef4444);font-size:11px}"
				].join("");
				(document.head || document.documentElement).appendChild(st);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 共享态（summary 槽与 body 槽是两个组件, 需要同一份数据; 模块级最小 store） ----------

		/** 唯一状态: phase = idle(未拉) | loading | ready | empty | error */
		var store = {
			phase: "idle",
			status: null,
			error: null,
			dismiss: "idle", // idle | busy | done | error（dismiss 动作态, 与数据态分离）
			dismissErr: null,
			started: false, // §7「打开卡片时拉一次」= 进程内只发一次（重试按钮显式 force）
			listeners: []
		};

		function emit() {
			var list = store.listeners.slice();
			for (var i = 0; i < list.length; i++) {
				try { list[i](); } catch (e) { /* 单个订阅者异常不影响其它 */ }
			}
		}
		function patch(next) {
			for (var k in next) if (Object.prototype.hasOwnProperty.call(next, k)) store[k] = next[k];
			emit();
		}
		function subscribe(fn) {
			store.listeners.push(fn);
			return function () {
				var i = store.listeners.indexOf(fn);
				if (i >= 0) store.listeners.splice(i, 1);
			};
		}

		/** React 侧订阅: 任一字段变化触发重渲染（无轮询/无定时器） */
		function useStore() {
			var s = React.useState(0);
			var bump = s[1];
			React.useEffect(function () {
				return subscribe(function () { bump(function (v) { return v + 1; }); });
			}, []);
			return store;
		}

		// ---------- RPC（浏览器端通用已认证通道; 失败一律归一为 { ok:false, error } —— 永不 throw） ----------

		/**
		 * 插件 ctx —— **真机唯一入口 = `apply(ctx)` 里的 `pluginCtx = ctx;`**（见文件末 apply()）。
		 * 组件内惰性取 `connection` 服务（与 notice-banner / cost-guard / taskqueue 同款写法）。
		 * ⚠️ 回归点（2026-09-13 E 线真浏览器真点击抓到）：曾漏掉 apply() 里的这行赋值 ⇒
		 * `hostCompatRpc()` 恒拿不到 connection ⇒ 卡片永远停在「读取失败 / connection 服务不可用」、
		 * dismiss 链路零请求（离线自测因走 `__test.setCtx` 旁路而全绿 ⇒ **旁路掩盖真入口**）。
		 * 处置：① apply() 首行补赋值；② **彻底删除 `__test.setCtx` 旁路** ⇒ 离线自测只能走 apply()，
		 * 结构上不可能再"只经旁路可达"。**新增状态一律不得绕过 apply()。**
		 */
		var pluginCtx = null;

		/* ★`#A55` 步2：0.2.2 起旧通道 `POST /host-compat/<ep>` 不再有路由（`connection.rpc.handle` 必失败），
		 * 官方面 = `/api/host-compat/<ep>`（宿主 `connection.fetch.register` 的精确 Fetch 路由，复用 /api cookie 门禁）。
		 * 策略：**先试新面、失败回落旧面**，结果缓存；诊断锚（只读、零副作用）：
		 *   `window.__DSH_HOSTCOMPAT_RPC_MODE__` = null|"api"|"legacy"；
		 *   `window.__DSH_HOSTCOMPAT_RPC_FAILS__` = 累计传输失败数；`__DSH_HOSTCOMPAT_RPC_LAST__` = 最近一次失败原因（禁静默）。 */
		var RPC_MODE = null;
		function setRpcMode(mode, note) {
			RPC_MODE = mode;
			try {
				window.__DSH_HOSTCOMPAT_RPC_MODE__ = mode;
				if (note) window.__DSH_HOSTCOMPAT_RPC_LAST__ = String(note);
			} catch (e) { /* 非浏览器环境：忽略 */ }
		}
		function noteRpcFailure(err) {
			try {
				window.__DSH_HOSTCOMPAT_RPC_FAILS__ = (window.__DSH_HOSTCOMPAT_RPC_FAILS__ || 0) + 1;
				window.__DSH_HOSTCOMPAT_RPC_LAST__ = String((err && err.message) || err);
			} catch (e) { /* 忽略 */ }
		}

		function hostCompatRpc(endpoint, payload) {
			var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
			var rpc = conn && conn.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				noteRpcFailure(new Error("connection 服务不可用"));
				return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
			}
			/* ★`#A56`：宿主 `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`（单段）⇒ `/api/host-compat` 不是合法 channel，
			 * `assertTarget` 会在**发请求前**抛 ⇒ 必须先 `rpc.call("/api", "host-compat/<endpoint>")`（endpoint 可多段）。 */
			var callApi = function () { return rpc.call("/api", CHANNEL.replace(/^\//, "") + "/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call(CHANNEL, endpoint, payload || {}); };
			var chosen;
			try {
				if (RPC_MODE === "api") chosen = callApi();
				else if (RPC_MODE === "legacy") chosen = callLegacy();
				else chosen = callApi().then(function (r) { setRpcMode("api", ""); return r; }, function (err) {
					setRpcMode("legacy", "api 面失败→回落旧通道: " + String((err && err.message) || err));
					return callLegacy();
				});
			} catch (err) {
				noteRpcFailure(err);
				return Promise.resolve({ ok: false, error: { code: "transport", message: String((err && err.message) || err) } });
			}
			return Promise.resolve(chosen).then(function (result) {
				return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
			}).catch(function (err) {
				noteRpcFailure(err);
				return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
			});
		}

		/** 拉一次状态（force=true 仅由「重试」触发; 普通路径受 store.started 幂等保护） */
		function loadStatus(force) {
			if (store.started && !force) return Promise.resolve(store);
			store.started = true;
			patch({ phase: "loading", error: null });
			return hostCompatRpc("status", {}).then(function (res) {
				if (res && res.ok === true && res.value && typeof res.value === "object") {
					var v = res.value;
					var plugins = Array.isArray(v.plugins) ? v.plugins : [];
					// §7 空态: 无状态文件（无任何分片 ⇒ plugins 空且无 probedAt）
					var empty = plugins.length === 0 && !v.probedAt;
					patch({ status: v, error: null, phase: empty ? "empty" : "ready" });
				} else {
					var err = (res && res.error) || {};
					patch({
						status: null,
						phase: "error",
						error: { code: err.code || "unknown", message: err.message || "未知错误" }
					});
				}
				return store;
			});
		}

		/** §8 dismiss: payload { hostVersion, capabilitySignature }（签名缺失 ⇒ 空串, 不抛） */
		function dismissCurrent(status) {
			var st = status || {};
			var hostVersion = st.host && st.host.version ? String(st.host.version) : "";
			var sig = typeof st.capabilitySignature === "string" ? st.capabilitySignature : ""; // RD-14 追加字段
			return hostCompatRpc("dismiss", { hostVersion: hostVersion, capabilitySignature: sig }).then(function (res) {
				if (res && res.ok === true) {
					patch({ dismiss: "done", dismissErr: null });
				} else {
					var err = (res && res.error) || {};
					patch({ dismiss: "error", dismissErr: { code: err.code || "unknown", message: err.message || "取消失败" } });
				}
				return res;
			});
		}

		// ---------- 展示工具 ----------

		function p2(n) { return (n < 10 ? "0" : "") + n; }

		/**
		 * probedAt 展示（RD-13）: 状态文件存 ISO UTC（§5）, 客户端**按浏览器本地时区**格式化，
		 * 否则用户看到的「探测于」会差时区小时数。解析失败 ⇒ 原样返回（不崩）。
		 */
		function fmtProbedAt(iso) {
			if (!iso) return "—";
			var d = new Date(String(iso));
			if (isNaN(d.getTime())) return String(iso);
			return p2(d.getHours()) + ":" + p2(d.getMinutes());
		}

		/** §5 全域汇总 = 最坏者（客户端只做展示汇总; 服务端 status.state 仍以服务端值为准） */
		function worstState(plugins) {
			var worst = "OK";
			for (var i = 0; i < (plugins || []).length; i++) {
				var s = plugins[i] && plugins[i].state;
				if ((STATE_RANK[s] || 0) > (STATE_RANK[worst] || 0)) worst = s;
			}
			return worst;
		}

		function notOkCount(plugins) {
			var n = 0;
			for (var i = 0; i < (plugins || []).length; i++) if (plugins[i] && plugins[i].state !== "OK") n++;
			return n;
		}

		/** 摘要槽文案（用户 D3 裁定）: {状态} · {n 项非 OK} · 探测于 HH:MM */
		function hintText() {
			if (store.phase === "idle" || store.phase === "loading") return "读取中…";
			if (store.phase === "empty") return "尚未探测";
			if (store.phase === "error") return "读取失败";
			var v = store.status || {};
			var plugins = v.plugins || [];
			return worstState(plugins) + " · " + notOkCount(plugins) + " 项非 OK · 探测于 " + fmtProbedAt(v.probedAt);
		}

		// ---------- 「设置 > 本地插件」卡 · body（契约 §7） ----------

		/**
		 * 打开卡片时拉一次（§7；不轮询、不定时器）:
		 * 卡体外层是容器的 <details class="dsh-lp-card">；折叠默认收起 ⇒ 挂载时若未展开则
		 * 监听首个 open（toggle）再拉。容器降级（.dsh-lp-flat, 无折叠）⇒ 挂载即拉一次。
		 */
		function useOpenFetch() {
			var ref = React.useRef(null);
			React.useEffect(function () {
				var el = ref.current;
				var det = el && el.closest ? el.closest("details.dsh-lp-card") : null;
				if (!det) { loadStatus(false); return undefined; }
				if (det.open) { loadStatus(false); return undefined; }
				var onToggle = function () {
					if (!det.open) return;
					det.removeEventListener("toggle", onToggle);
					loadStatus(false);
				};
				det.addEventListener("toggle", onToggle);
				return function () { det.removeEventListener("toggle", onToggle); };
			}, []);
			return ref;
		}

		function h() { return React.createElement.apply(React, arguments); }

		function stateBadge(state, cls) {
			var s = STATE_COLOR[state] ? state : "DEGRADED"; // 非法值 ⇒ 按降级展示（fail-safe, 与服务端 normalizeState 同向）
			return h("span", { className: cls, "data-state": s, key: "st" }, s);
		}

		function missingText(missing) {
			var arr = Array.isArray(missing) ? missing : [];
			if (arr.length === 0) return [h("span", { key: "m" }, "missing: —")];
			return [h("span", { key: "m" }, "缺 ")].concat(arr.map(function (k, i) {
				return h("code", { key: "c" + i }, String(k));
			}));
		}

		/** 每插件一行（§7 渲染字段: id / version / 状态徽标 / missing 摘要 / note；blocked[] 不渲染, D8） */
		function pluginRow(p, i) {
			return h("div", { className: "hc-row", "data-state": p.state, key: "r" + i },
				h("span", { className: "hc-id", key: "id" }, String(p.id || "(未命名)")),
				h("span", { className: "hc-ver", key: "v" }, "v" + String(p.version || "—")),
				stateBadge(p.state, "hc-st"),
				h("span", { className: "hc-miss", key: "m" }, missingText(p.missing)),
				h("span", { className: "hc-note", key: "n", title: "note" }, p.note ? String(p.note) : "—")
			);
		}

		/** ④ 版本对撞 ＋ 能力探测（**面板可见**）：宿主版本号 ＋ `data-conversation-scroll` 是否存在，**一起显示** */
		function hostScrollLine(v) {
			var pr = null;
			try { pr = hsProbe(); } catch (e) { pr = null; }
			if (!pr) return null;
			var hv = String((v && v.host && v.host.version) || pr.hostVersion || "—");
			return h("div", { className: "hc-meta", key: "hs", "data-hc-hostscroll": pr.ok ? "ok" : "missing" },
				h("span", { className: "hc-k" }, "滚动面 hostScroll"),
				h("span", { className: "hc-v" }, pr.ok ? "在位" : "缺失"),
				h("span", { className: "hc-k" }, "· 宿主"),
				h("span", { className: "hc-v" }, hv),
				h("span", { className: "hc-k" }, "·"),
				h("code", null, HOST_SCROLL_SEL),
				h("span", { className: "hc-k" }, "命中 " + (pr.ok ? "1" : "0")),
				h("span", { className: "hc-k" }, pr.ok ? "· 补滚可用" : "· **补滚已停用**（卡片照常渲染，无兜底路径）")
				,
				h("span", { className: "hc-k", "data-hc-hs-errors": String(pr.errors || 0) }, (pr.errors || 0) > 0 ? ("· **挂载错误 " + pr.errors + "**" + (pr.attachError ? ("（" + String(pr.attachError).slice(0, 40) + "）") : "")) : "")
			);
		}
		/** `ENV §一.7④`"端点注册表可见可查" ⇒ 面板列出；服务端未回 ⇒ 如实"未提供" */
		function endpointsLine(v) {
			var eps = (v && Array.isArray(v.endpoints)) ? v.endpoints : null;
			return h("div", { className: "hc-meta", key: "eps", "data-hc-endpoints": eps ? String(eps.length) : "none" },
				h("span", { className: "hc-k" }, "已注册端点"),
				h("span", { className: "hc-v" }, eps && eps.length ? eps.join(", ") : (eps ? "（无）" : "未提供（旧版服务端）"))
			);
		}
		/** 自检异常如实点名（`ENV §一.6②` 禁"报 OK 而功能坏"）：如事件类型注册失败 ⇒ 横幅不注入 */
		function issuesLine(v) {
			var iss = (v && Array.isArray(v.issues)) ? v.issues : [];
			if (!iss.length) return null;
			return h("div", { className: "hc-err", key: "selfissues", "data-hc-issues": String(iss.length) },
				h("div", { className: "hc-err-t" }, "⚠ 本插件自检异常 " + iss.length + " 项（功能已降级，非静默）"),
				h("div", null, iss.map(function (x, i) { return h("code", { key: "i" + i }, String(x && x.code) + (x && x.reason ? ":" + String(x.reason) : "")); }))
			);
		}

		function bodyContent() {
			// ① 错误态（§7 空/异常行）: 含错误码 +「重试」; 不崩、不空白
			if (store.phase === "error") {
				var e = store.error || {};
				return [
					h("div", { className: "hc-err", key: "err" },
						h("div", { className: "hc-err-t" }, "⚠ 读取失败"),
						h("div", null,
							"RPC ", h("code", null, CHANNEL + "/status"), " 返回 ",
							h("code", null, "{ ok:false, error:{ code:\"" + String(e.code) + "\", message:\"" + String(e.message) + "\" } }")
						),
						h("div", { className: "hc-err-a" },
							h("button", {
								className: "hc-btn", type: "button", key: "retry",
								onClick: function () { loadStatus(true); }
							}, "重试")
						)
					)
				];
			}
			// ② 空态（§7）: 无状态文件 ⇒「尚未探测」（轻量, 右下角一行）
			if (store.phase === "empty") {
				return [
					h("div", { className: "hc-empty", key: "empty" },
						h("b", null, "尚未探测"),
						h("div", null, "无 ", h("code", null, "compat-status.json"), "（各插件尚未上报）；打开本卡时已向 ", h("code", null, CHANNEL + "/status"), " 拉取一次")
					)
				];
			}
			// ③ 读取中（不空白: 给一行状态）
			if (store.phase === "idle" || store.phase === "loading" || !store.status) {
				return [h("div", { className: "hc-empty", key: "loading" }, "读取中…")];
			}
			// ④ 正常态: 顶部元信息 + 逐插件行
			var v = store.status;
			var plugins = Array.isArray(v.plugins) ? v.plugins : [];
			var agg = worstState(plugins);
			var rows = plugins.slice().sort(function (a, b) {
				return String(a && a.id).localeCompare(String(b && b.id));
			});
			return [
				h("div", { className: "hc-meta", key: "meta" },
					h("span", { className: "hc-k" }, "探测于"),
					h("span", { className: "hc-v" }, fmtProbedAt(v.probedAt)),
					h("span", { className: "hc-k" }, "·"),
					h("span", { className: "hc-k" }, "宿主"),
					h("span", { className: "hc-v" }, String((v.host && v.host.version) || "—")),
					h("span", { className: "hc-k" }, "·"),
					stateBadge(agg, "hc-agg"),
					h("span", { className: "hc-k" }, notOkCount(plugins) + " 项非 OK")
				),
				// ★notice-scroll（硬约束 ②④）＋ `ENV §一.7④`：面板可见的**自检面**
				hostScrollLine(v),
				endpointsLine(v),
				issuesLine(v),
				h("div", { className: "hc-rows", key: "rows" }, rows.map(pluginRow))
			];
		}

		/** dismiss 行（§8 语义）: 记录 hostVersion + capabilitySignature ⇒ 此后不再注入 */
		function dismissRow() {
			if (store.phase !== "ready") return null;
			var v = store.status || {};
			var sig = typeof v.capabilitySignature === "string" ? v.capabilitySignature : "";
			if (store.dismiss === "done") {
				return h("div", { className: "hc-act", key: "act" },
					h("span", { className: "hc-ok" }, "✓ 已记录 · 本版本不再提示"),
					h("span", { className: "hc-hint" },
						"hostVersion ", String((v.host && v.host.version) || "—"), " + capabilitySignature ",
						h("code", null, sig || "(空)")
					)
				);
			}
			return h("div", { className: "hc-act", key: "act" },
				h("button", {
					className: "hc-btn", type: "button", key: "btn",
					disabled: store.dismiss === "busy",
					onClick: function () {
						if (store.dismiss === "busy") return;
						patch({ dismiss: "busy", dismissErr: null });
						dismissCurrent(v);
					}
				}, store.dismiss === "busy" ? "记录中…" : "本版本不再提示"),
				store.dismiss === "error" && store.dismissErr
					? h("span", { className: "hc-bad", key: "de" },
						"✗ 记录失败（", String(store.dismissErr.code), "：", String(store.dismissErr.message), "）")
					: h("span", { className: "hc-hint", key: "h" },
						"记录 hostVersion + capabilitySignature ⇒ 本版本不再注入；两者任一变化会重新提示"
					)
			);
		}

		/** 卡 body（只画内容; 外壳/标题行/折叠由容器画） */
		function HostCompatCard(_props) {
			var ref = useOpenFetch();
			useStore();
			return h("div", { className: "hc-card", ref: ref }, bodyContent().concat([dismissRow()]));
		}

		/** 卡 summary（折叠标题行: 图标 + 标题 + 「本地插件」徽标 + 实时摘要; 用户 D10/D3 裁定） */
		/**
		 * 插件详情页的适配状态段：只在被打开的 bundle 有探测记录时渲染，
		 * 其它包返回 null（段自绘 chrome）。
		 */
		function HostCompatDetailSection(props) {
			useStore();
			var subject = props && props.subject;
			React.useEffect(function () { loadStatus(false); }, []);
			if (!subject || subject.kind !== "bundle") return null;
			var name = String((subject.pkg && subject.pkg.name) || "");
			var shortName = name.split("/").pop() || "";
			var row = (subject.pkg && subject.pkg.rows && subject.pkg.rows[0]) || null;
			var rowId = String((row && row.rowId) || shortName);
			var plugins = (store.status && Array.isArray(store.status.plugins)) ? store.status.plugins : [];
			// 探测 id 可能是短名（host-compat）也可能是包短名（dsh-host-compat）: 两者都认。
			var mine = plugins.filter(function (p) {
				if (!p) return false;
				var id = String(p.id || "");
				return id === rowId || id === shortName || id === name || id.endsWith("-" + rowId);
			});
			if (!mine.length) return null;
			var children = [h("div", { className: "hc-t", key: "t" }, "适配状态")];
			for (var i = 0; i < mine.length; i++) children.push(pluginRow(mine[i], i));
			var iss = issuesLine(store.status);
			if (iss) children.push(iss);
			return h("section", { className: "hc-card", "data-hc-detail": "1", key: "hc-detail" }, children);
		}

		function HostCompatSummary(_props) {
			useStore();
			return h(React.Fragment, null, [
				h("span", { className: "lp-ico", key: "ico" }, "🧩"),
				h("span", { className: "lp-title", key: "title" }, "适配状态"),
				h("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				h("span", { className: "lp-hint", key: "hint" }, hintText())
			]);
		}

		/* ═══════════════════════════════════════════════════════════════════════════
		   ★客户端面服务 `hostScroll`（契约 §4.11；`notice-scroll` 件；2026-10-11）
		   —— **宿主面（`[data-conversation-scroll]` 的读 ＋ 写 ＋ 输入监听）的【唯一落点】**
		      （`ENV §一.7①` 单接触面）：消费侧（`dsh-notice-banner/lib/client.js`）该属性 **0 行**。
		   能力键：`available()` ／ `read()` ／ `toBottom({source,intentGateMs})`；
		   错误码 `reason ∈ {no-scroll-host, service-missing, host-error, bad-argument}`。
		   **四条硬约束（用户 2026-10-11 签字「豁免（附四条硬约束）」）**：
		     ① 宿主面只在此一处；② 能力缺失 ⇒ **如实降级 ＋ 面板可见**（**只丢补滚、卡片照常渲染**、
		        禁 legacy 直连兜底）；③ **该面不得用作任何正确性判据**（只作"贴底位辅助"）；
		     ④ **版本对撞 ＋ 能力探测**：宿主版本号 ＋ 该属性是否存在，**一起写进面板**（`hsProbe()`）。
		   **加载期 inert**：本段只声明常量/函数/一个纯内存对象，**不在模块顶层碰宿主**；
		     监听在**首次读写时按需挂载**（`hsAttach`）。**中间件不持业务数据**：`source` 仅归因字符串。
		   ═══════════════════════════════════════════════════════════════════════════ */
		var HOST_SCROLL_SEL = "[data-conversation-scroll]";
		var HOST_SCROLL_GATE_MS = 800;   /* ★意图闸门常数（**非宿主既有值**；实测 300ms 误伤、800/1500ms 安全）⇒ 纳入回退阶梯＝状态复位口径 */
		var HS_REASON = { noHost: "no-scroll-host", attach: "attach-error", missing: "service-missing", err: "host-error", bad: "bad-argument" };
		/* ★滚动**突发合并**（惯性滚动处置；2026-10-11 VM 真输入批）：同一手势内的连续 `scroll`
		   （间隔 ≤ `HS_BURST_GAP_MS`）视为**一次突发** ⇒ 该突发的"是否用户驱动"只看**突发开始时刻**与最近输入的距离
		   （不再要求每个 scroll 都落在 `gateMs` 内）⇒ **"输入已停、滚动仍在继续"（惯性）不会穿透闸门**。 */
		var HS_BURST_GAP_MS = 150;
		/* ★监听面（2026-10-12 `#A575` ②：**能收窄就收窄**）——`localStorage["dsh-host-scroll-listen"]`：
		   缺省/`"both"` ＝ 容器 ＋ `document` capture；`"container"` ＝ **只挂容器**（用于收窄对比趟）。 */
		/* ★默认 ＝ **container（只挂容器）**（2026-10-13 `#A577` ② 收窄；该分支已在 VM 趟 `v-narrow-t1` 验证绿：
		   输入计数 `{"wheel":2}`／`gated="reader-active"`／`top` 逐字不变；`document` 命中 = 0）。
		   逃生门：`localStorage["dsh-host-scroll-listen"] = "both"` ⇒ 回到"容器 ＋ `document` capture"。 */
		var HS_LISTEN_MODE = (function () { try { return String(localStorage.getItem("dsh-host-scroll-listen") || "") === "both" ? "both" : "container"; } catch (e) { return "container"; } })();
		var hsState = { attached: false, docAttached: false, docScrollAttached: false, attachError: null, gateMs: HOST_SCROLL_GATE_MS, lastInputAt: 0, lastScrollAt: 0, burstUserDriven: false, intentBottom: true, inputs: 0, scrolls: 0, bursts: 0, containerScrolls: 0, documentScrolls: 0, userScrolls: 0, calls: 0, errors: 0, lastCall: null, submits: 0, submitAt: 0, selfSend: false, selfSendScrolls: 0, lastInputKind: null,
			/* ★诊断件（2026-10-12 `#A576`）：五环读数表 */ elRef: null, attachAt: 0, renders: 0, inputCounts: {}, lastInputAtBy: {}, scrollLog: [], callLog: [] };
		function hsScroller() {
			try {
				if (typeof document === "undefined" || !document.querySelector) return null;
				/* ★解析顺序＝**通用优先**（2026-10-12 仲裁 `#A575` ②）：**先从自有节点向上找"确实可滚"的祖先**；
				   `[data-conversation-scroll]` 降为**校验/兜底**（它是宿主自用属性，且实测当刻可能不可滚）。 */
				var n = document.querySelector("[data-notice-banner]");
				while (n && n.nodeType === 1) {
					var st = getComputedStyle(n);
					if (/(auto|scroll)/.test(String(st.overflowY)) && (n.scrollHeight - n.clientHeight) > 1) return n;
					n = n.parentElement;
				}
				return document.querySelector(HOST_SCROLL_SEL) || null;   /* 兜底（不可滚也返回，供 read() 如实报几何） */
			} catch (e) { hsState.errors += 1; return null; }
		}
		function hsSlack(el) { return el ? (el.scrollHeight - Math.round(el.scrollTop) - el.clientHeight) : null; }
		/** 输入面（5 名）——**只读**、`passive`、不 `preventDefault`；`document` 面**只挂一次** */
		var HS_INPUT_NAMES = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"];
		/** ★修件（2026-10-13）：**输入身份面** —— 旧实现**只记事件类型计数**（`inputCounts[ty]++`、
		 *  `lastInputAtBy[ty]`）⇒ 「**自身提交**」这一信号**在本层不可得**（段1 §B-3 只读定位）。
		 *  现**只增记账**（**零新增监听**、仍 `passive`、仍**不 `preventDefault`**）：把
		 *  「**提交类输入**」（`keydown` ＋ `Enter`/`NumpadEnter`，非 `shiftKey`、非输入法组合中）与
		 *  「**非提交类输入**」分开 ⇒ 派生「**自身发送窗口**」＝**最近一次提交之后、尚未出现非提交类输入**
		 *  （用户自己一滚／一点 ⇒ **窗口关闭**、闸门恢复保护 ⇒ 「外来源仍受闸门保护」逐字成立）。 */
		function hsSubmitLike(ev) {
			try {
				if (!ev || String(ev.type || "") !== "keydown") return false;
				var k = String(ev.key == null ? "" : ev.key);
				if (k !== "Enter" && k !== "NumpadEnter") return false;
				if (ev.shiftKey === true) return false;
				if (ev.isComposing === true) return false;
				return true;
			} catch (e) { return false; }
		}
		function hsOnInput(ev) {
			try {
				var ty = String((ev && ev.type) || "?");
				hsState.lastInputAt = Date.now(); hsState.inputs += 1;
				hsState.inputCounts[ty] = (hsState.inputCounts[ty] || 0) + 1;
				hsState.lastInputAtBy[ty] = hsState.lastInputAt;
				hsState.lastInputKind = ty;
				if (hsSubmitLike(ev)) { hsState.submitAt = hsState.lastInputAt; hsState.submits += 1; hsState.selfSend = true; }
				else { hsState.selfSend = false; }   /* 非提交类输入 ⇒ **自身发送窗口关闭** */
			} catch (e) { /* 记账失败不影响主流程 */ }
		}
		function hsOnScrollCore(ev, el) {
			var now = Date.now();
			hsState.scrolls += 1;
			if ((now - hsState.lastScrollAt) > HS_BURST_GAP_MS) {          /* 新突发 */
				hsState.bursts += 1;
				hsState.burstStartAt = now;
				hsState.burstUserDriven = ((now - hsState.lastInputAt) <= hsState.gateMs);
			}
			hsState.lastScrollAt = now;
			if (hsState.burstUserDriven) {
				hsState.userScrolls += 1;
				var t = (ev && ev.target && ev.target.nodeType === 1 && typeof ev.target.scrollHeight === "number") ? ev.target : el;
				hsState.intentBottom = !(hsSlack(t) > 25);
			}
			try {
				hsState.scrollLog.push({ t: now, gap: now - hsState.lastInputAt, burstStart: hsState.burstStartAt || 0, user: !!hsState.burstUserDriven,
					tgt: (ev && ev.target && ev.target.tagName) ? String(ev.target.tagName) : "?",
					slack: hsSlack((ev && ev.target && ev.target.nodeType === 1) ? ev.target : el), ib: hsState.intentBottom });
				if (hsState.scrollLog.length > 40) hsState.scrollLog.shift();
			} catch (eL) { /* 诊断记账失败不影响主流程 */ }
		}
		function hsOnScrollContainer(ev) { hsState.containerScrolls += 1; hsOnScrollCore(ev, hsState.elRef); }
		function hsOnScrollDocument(ev) { hsState.documentScrolls += 1; hsOnScrollCore(ev, hsState.elRef); }
		/** **摘旧监听**（`#A586` ①）：元素身份变化时**必须先摘再挂** —— **禁**依赖"旧节点离 DOM 即失效"
		   （旧节点可能**仍在 DOM**（"长会话 ⇒ 短会话 ⇒ 上溯外层"时内外两祖先并存）⇒ 不摘 ⇒ 同一次滚动**多次命中**
		   ＋ 旧元素仍能写 `intentBottom`（假写））。`document` 面**不摘**（只挂一次、语义全局）。 */
		function hsDetachOld(el) {
			if (!el) return;
			try {
				for (var i = 0; i < HS_INPUT_NAMES.length; i++) el.removeEventListener(HS_INPUT_NAMES[i], hsOnInput, { capture: true });
				el.removeEventListener("scroll", hsOnScrollContainer);
				el.removeEventListener("scroll", hsOnScrollDocument);
			} catch (e) { /* 摘除失败不阻断重挂 */ }
		}
		function hsAttach(el) {
			/* ★F10（`#A583`/`#A584`）＋★`#A586` ①：按**元素身份**幂等；元素变了 ⇒ **先摘旧监听**再挂新。 */
			if (!el) return el;
			if (hsState.attached && hsState.elRef === el) return el;
			try {
				hsDetachOld(hsState.elRef);
				var i;
				for (i = 0; i < HS_INPUT_NAMES.length; i++) el.addEventListener(HS_INPUT_NAMES[i], hsOnInput, { passive: true, capture: true });
				if (typeof document !== "undefined" && !hsState.docAttached) {
					for (i = 0; i < HS_INPUT_NAMES.length; i++) document.addEventListener(HS_INPUT_NAMES[i], hsOnInput, { passive: true, capture: true });
					hsState.docAttached = true;
				}
				el.addEventListener("scroll", hsOnScrollContainer, { passive: true });
				if (typeof document !== "undefined" && HS_LISTEN_MODE === "both" && !hsState.docScrollAttached) {
					document.addEventListener("scroll", hsOnScrollDocument, { passive: true, capture: true });
					hsState.docScrollAttached = true;
				}
				hsState.elRef = el; hsState.attachAt = Date.now(); hsState.attached = true; hsState.attachError = null;
			} catch (e) {
				/* ★`#A586` ④：**挂载失败不得吞** —— 记 `attachError`（`read()`/`available()` 如实反映 ⇒ 面板/分片可见） */
				hsState.errors += 1; hsState.attachError = String((e && e.message) || e);
			}
			return el;
		}
		function hsRec(r) { try { hsState.lastCall = { at: new Date().toISOString(), r: r };
			hsState.callLog.push({ t: Date.now(), r: r, ib: hsState.intentBottom, inputs: hsState.inputs, scrolls: hsState.scrolls });
			if (hsState.callLog.length > 20) hsState.callLog.shift();
		} catch (e) { /* 记账失败不影响返回 */ } return r; }
		/** 能力探测读数（**面板可见**；硬约束 ④：**宿主版本号 ＋ 属性是否存在一起读**） */
		function hsProbe() {
			var el = null;
			try { el = hsScroller(); } catch (e) { el = null; }
			return {
				ok: !!el, hostFound: !!el, selector: HOST_SCROLL_SEL,
				hostVersion: (store && store.status && store.status.host && store.status.host.version) || null,
				gateMs: hsState.gateMs, listenMode: HS_LISTEN_MODE, errors: hsState.errors, attachError: hsState.attachError, inputs: hsState.inputs, scrolls: hsState.scrolls, containerScrolls: hsState.containerScrolls, documentScrolls: hsState.documentScrolls, bursts: hsState.bursts, userScrolls: hsState.userScrolls,
				/* ★修2(b)：**输入身份面**（`selfSend` ＝ 自身发送窗口状态；`submits` ＝ 提交类输入计数） */
				submits: hsState.submits || 0, selfSend: hsState.selfSend === true, selfSendScrolls: hsState.selfSendScrolls || 0,
				calls: hsState.calls, errors: hsState.errors, intentBottom: hsState.intentBottom,
				reason: el ? null : HS_REASON.noHost, probedAt: new Date().toISOString()
			};
		}
		/** ★诊断件（`#A576`）：五环读数表 —— 只读、自持内存，不写宿主（探针经 `window.__hsState()` 取） */
		function hsDiag() {
			try {
				var el = hsState.elRef, ov = null;
				if (el) { try { ov = getComputedStyle(el).overflowY; } catch (e2) { ov = null; } }
				return {
					attached: hsState.attached, listenMode: HS_LISTEN_MODE, gateMs: hsState.gateMs, burstGapMs: HS_BURST_GAP_MS,
					attachAt: hsState.attachAt, renders: hsState.renders,
					el: el ? { tag: String(el.tagName || ""), cls: String(el.className || "").slice(0, 80), overflowY: ov, sh: el.scrollHeight, ch: el.clientHeight, shMinusCh: el.scrollHeight - el.clientHeight, scrollable: (el.scrollHeight - el.clientHeight) > 1 } : null,
					scrolls: { total: hsState.scrolls, container: hsState.containerScrolls, document: hsState.documentScrolls, bursts: hsState.bursts, user: hsState.userScrolls },
					inputs: hsState.inputCounts, lastInputAtBy: hsState.lastInputAtBy, lastInputAt: hsState.lastInputAt,
					/* ★修2(b)：**输入身份面**读数（`selfSend` 窗口是否开着 ＝ 可观测判据锚点） */
					submits: hsState.submits || 0, submitAt: hsState.submitAt || 0, selfSend: hsState.selfSend === true, selfSendScrolls: hsState.selfSendScrolls || 0, lastInputKind: hsState.lastInputKind || null,
					intentBottom: hsState.intentBottom, scrollLog: hsState.scrollLog.slice(-40), callLog: hsState.callLog.slice(-20)
				};
			} catch (e) { return null; }
		}
		try { if (typeof window !== "undefined" && (function () { try { return String(localStorage.getItem("dsh-host-scroll-debug") || "") === "1"; } catch (e) { return false; } })()) window.__hsState = hsDiag; } catch (e) { /* 忽略 */ }   /* ★调试面默认关闭（2026-10-13 #A577 ③）：仅 localStorage["dsh-host-scroll-debug"]==="1" 时暴露 */
		var hostScrollService = {
			available: function () {
				/* ★`#A586` ②：**宿主面在位**（有滚动容器）＋ **无挂载错误** —— 与卡行 `data-hc-hostscroll` **同一判据** */
				try {
					if (hsState.attachError) return { ok: false, reason: HS_REASON.attach, errors: hsState.errors };
					return hsScroller() ? { ok: true } : { ok: false, reason: HS_REASON.noHost };
				} catch (e) { return { ok: false, reason: HS_REASON.err }; }
			},
			read: function () {
				try {
					var el = hsAttach(hsScroller());
					if (!el) return { ok: false, reason: HS_REASON.noHost };
					/* ★`#A586` ④：挂载抛错 ⇒ **如实返回**（原实现只看 `el` ⇒ 挂载失败被吞成 ok） */
					if (hsState.attachError) return { ok: false, reason: HS_REASON.attach, errors: hsState.errors, hostFound: true };
					var s = hsSlack(el);
					return { ok: true, atBottom: s <= 25, slackPx: s, hostFound: true, sampledAt: new Date().toISOString() };
				} catch (e) { hsState.errors += 1; return { ok: false, reason: HS_REASON.err }; }
			},
			toBottom: function (opts) {
				hsState.calls += 1;
				try {
					var o;
					if (opts === undefined || opts === null) o = {};
					else if (typeof opts === "object") o = opts;
					else return hsRec({ ok: false, reason: HS_REASON.bad });
					if (o.source !== undefined && typeof o.source !== "string") return hsRec({ ok: false, reason: HS_REASON.bad });
					if (o.selfSend !== undefined && typeof o.selfSend !== "boolean") return hsRec({ ok: false, reason: HS_REASON.bad });   /* ★修2(b)：新键只吃布尔；非法 ⇒ 照旧 `bad` */
					if (o.intentGateMs !== undefined && (typeof o.intentGateMs !== "number" || !isFinite(o.intentGateMs) || o.intentGateMs < 0)) return hsRec({ ok: false, reason: HS_REASON.bad });
					if (typeof o.intentGateMs === "number") hsState.gateMs = o.intentGateMs;
					var el = hsAttach(hsScroller());
					if (!el) return hsRec({ ok: false, reason: HS_REASON.noHost });
					var before = hsSlack(el);
					/* ═══ ★修2(b)（2026-10-13；用户裁定「**自身发送 ⇒ 一律跟到底** vs **外来源 ⇒ 仍受闸门保护**」）═══
					   **本行是本批唯一的闸门分支改动** —— 旧实现只吃 `intentBottom` 一个布尔（原 `:640`），
					   **无法区分**"这次插入是不是用户自己发出去引起的"（`source` 只做类型校验、零分支）；
					   其后果＝用户刚发完消息、宿主自身跟随滚动把位写成 `false` 时，紧随其后的插卡被**误挡**。
					   现：消费方申报 `selfSend === true` ⇒ **不受闸门拦截**；**缺省／`false` ⇒ 逐字旧行为**
					   （**新键缺省值 ＝ 旧行为** ⇒ 旧 host／旧消费方都不炸）。 */
					var selfSend = (o.selfSend === true);
					if (selfSend) hsState.selfSendScrolls += 1;
					if (hsState.intentBottom === false && !selfSend) return hsRec({ ok: true, did: false, gated: "reader-active", selfSend: false, slackBefore: before, slackAfter: before });   /* 读者在翻历史 ⇒ 不补、不报错、不重试 */
					el.scrollTop = el.scrollHeight;
					return hsRec({ ok: true, did: true, gated: null, selfSend: selfSend, slackBefore: before, slackAfter: hsSlack(el) });
				} catch (e) { hsState.errors += 1; return hsRec({ ok: false, reason: HS_REASON.err }); }
			},
			/** ★修2(b)：**输入身份面**（只读、自持内存、绝不 throw）—— 消费方据此申报 `selfSend`
			 *  （契约 §4.11 载荷/返回键集）。**取不到本方法 ⇒ 消费方回落 `selfSend:false` ＝ 旧行为**。 */
			inputs: function () {
				try {
					return { ok: true, selfSend: hsState.selfSend === true, submitAt: hsState.submitAt || 0, submits: hsState.submits || 0, inputs: hsState.inputs || 0, lastKind: hsState.lastInputKind || null, selfSendScrolls: hsState.selfSendScrolls || 0 };
				} catch (e) { return { ok: false, reason: HS_REASON.err }; }
			},
			probe: hsProbe
		};

		// ---------- 注册 ----------

		/** 运行时服务注入（client 插件契约）: slots = 槽位注册; connection = 浏览器端通用已认证 RPC; locale = 卡文案命名空间 */
		var inject = ["slots", "connection", "locale"];

		function apply(ctx) {
			// ① **必须最先记录 ctx**：`hostCompatRpc()` 靠它惰性取 connection 服务
			//    （漏掉这行 ⇒ 卡片恒「读取失败」且 dismiss 零请求；2026-09-13 E 线真点击回归点）
			pluginCtx = ctx;
			// ★契约 §4.11：向宿主 ctx **提供**客户端面服务 `hostScroll`（消费方 `ctx.get("hostScroll", false)`；
			//   提供失败/不可用 ⇒ 消费方**如实降级**：只丢补滚、卡片照常渲染（禁 legacy 直连兜底）。
			try { ctx.provide && ctx.provide("hostScroll", hostScrollService); } catch (e) { /* 提供面不可用 ⇒ 消费方降级 */ }
			injectCss();
			try {
				ctx.effect(function () { return ctx.locale.register(NS, { zh: {}, en: {} }); }, "ui-host-compat: settings card dictionaries");
			} catch (e) { /* locale 不可用: 卡文案为中文硬编码, 不影响功能 */ }

			// 1) 诊断信息挂到插件详情页（plugins.detail.section，取代旧「设置 > 本地插件」卡）
			try {
				ctx.slots.inject("plugins.detail.section", function () {
					return ctx.slots.register({
						name: "plugins.detail.section",
						id: "host-compat",
						locale: NS
					}, HostCompatDetailSection);
				});
			} catch (e) { /* 槽不可用: 静默降级（不崩不空白, 其它入口不受影响） */ }
		}

		exports.inject = inject;
		exports.apply = apply;

		// 离线自测专用导出（仅 window.__DSH_SMOKE__ 置位时; 生产浏览器不置位不启用）
		if (typeof window !== "undefined" && window.__DSH_SMOKE__) {
			exports.__test = {
				HostCompatCard: HostCompatCard,
				HostCompatSummary: HostCompatSummary,
				fmtProbedAt: fmtProbedAt,
				hintText: hintText,
				hostScroll: function () { return hostScrollService; },
				hsProbe: hsProbe,
				worstState: worstState,
				stateOfStore: function () { return store; },
				/** 仅离线自测用: 复位共享态（生产路径不会调用） */
				resetStore: function () {
					patch({ phase: "idle", status: null, error: null, dismiss: "idle", dismissErr: null, started: false });
				},
				/** ⚠️ 已故意**不提供** `setCtx` 旁路：真机入口只有 `apply(ctx)`（2026-09-13 E 线回归点），
				 *  离线自测也必须先 `exports.apply(ctx)` ⇒ 不可能再出现"只经旁路可达"的断链。 */
				loadStatus: loadStatus,
				CARD_KEY: CARD_KEY,
				CHANNEL: CHANNEL
			};
		}
		return module.exports;
	}
});
