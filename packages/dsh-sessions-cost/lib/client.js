window.__ModuleLoader__.load({
	id: "@ericality/dsh-sessions-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// 插件详情页配置卡：注册 plugins.bundle.config（view page）。
		// 页面负责标题、图标与面包屑；本组件只画表单主体 + 自带保存与恢复默认。
		// 读写走自有 RPC /api/sessions-cost/config/get|set|reset，配置由宿主侧落
		// plugin-data/sessions-cost/settings.json（schemaVersion 1），下一次命令/回合现读生效。

		var NS = "ui-sessions-cost";
		var CHANNEL = "sessions-cost/config";
		var PKG = "@ericality/dsh-sessions-cost";

		var FIELDS = [ { "key": "defaultHours", "type": "number", "label": "默认窗口（小时）", "hint": "/sessions-cost 不带参数时使用，范围 1 到 720；命令显式带小时数以参数优先。", "default": 24, "min": 1, "max": 720, "step": 1 }, { "key": "defaultCollapsed", "type": "boolean", "label": "横幅默认折叠", "hint": "多会话费用横幅的默认折叠状态（由 dsh-notice-banner 渲染，见 README）。", "default": true }, { "key": "showBreakdown", "type": "boolean", "label": "显示会话明细", "hint": "关闭后横幅只保留合计与窗口统计，逐会话明细行不显示。", "default": true } ];

		var dict = { "intro": "默认统计窗口、横幅默认折叠与明细开关。保存后下一次 /sessions-cost 即按新配置执行。", "save": "保存", "saving": "保存中…", "saved": "✓ 已保存", "reset": "恢复默认", "resetDone": "✓ 已恢复默认", "loadError": "读取失败，请刷新重试", "saveError": "保存失败", "loading": "读取中…", "ready": "改动后点保存生效；下一次命令或回合即按新配置执行。", "on": "开", "off": "关" };

		var INJECTED_CSS = [
			".cfg-card{flex-direction:column;gap:16px;display:flex;color:var(--dsw-alias-label-primary)}",
			".cfg-intro{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}",
			".cfg-fields{flex-direction:column;gap:14px;display:flex}",
			".cfg-field{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:6px;padding:12px 14px;display:flex}",
			".cfg-head{flex-wrap:wrap;align-items:center;gap:10px;display:flex}",
			".cfg-label{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-size:13px;font-weight:500;line-height:20px}",
			".cfg-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);width:120px;height:32px;font:inherit;padding:0 10px;font-size:13px}",
			".cfg-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".cfg-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}",
			".cfg-switch{position:relative;display:inline-flex;flex:none;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary)}",
			".cfg-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}",
			".cfg-actions{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:10px;padding-top:14px;display:flex}",
			".cfg-status{flex:1;min-width:0;font-size:12.5px;line-height:18px}",
			".cfg-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
			".cfg-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
			".cfg-status[data-tone=muted]{color:var(--dsw-alias-label-tertiary)}",
			".cfg-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;height:32px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;padding:0 16px;font-size:13px}",
			".cfg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".cfg-btn:disabled{opacity:.55;cursor:default}",
			".cfg-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
			".cfg-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}"
		].join("");

		function injectCss() {
			try {
				if (!document.getElementById("dsh-cfg-css")) {
					var st = document.createElement("style");
					st.id = "dsh-cfg-css";
					st.textContent = INJECTED_CSS;
					(document.head || document.documentElement).appendChild(st);
				}
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 控制器：get / set / reset ----------
		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, settings: null, defaults: null });
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return Promise.resolve(rpc.call("/api", CHANNEL + "/" + endpoint, payload || {}))
					.then(function (result) {
						if (result && typeof result === "object") return result;
						return { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
					}, function (err) {
						return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
					});
			}
			function publish(value) {
				var settings = value && value.settings ? value.settings : null;
				store.set({ status: "ready", loaded: true, settings: settings, defaults: (value && value.defaults) || null });
			}
			function refresh() {
				return call("get", {}).then(function (res) {
					if (res.ok && res.value) publish(res.value);
					else store.set({ status: "error", loaded: true, settings: null, defaults: null });
					return res;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				save: function (settings) {
					return call("set", { settings: settings }).then(function (res) {
						if (res.ok && res.value) publish(res.value);
						return res;
					});
				},
				reset: function () {
					return call("reset", {}).then(function (res) {
						if (res.ok && res.value) publish(res.value);
						return res;
					});
				}
			};
		}

		// ---------- 工具 ----------
		function normalize(settings) {
			var src = settings && typeof settings === "object" ? settings : {};
			var out = {};
			for (var i = 0; i < FIELDS.length; i++) {
				var f = FIELDS[i];
				if (f.type === "boolean") out[f.key] = typeof src[f.key] === "boolean" ? src[f.key] : f["default"];
				else out[f.key] = typeof src[f.key] === "number" ? src[f.key] : f["default"];
			}
			return out;
		}
		function toDraft(settings) {
			var n = normalize(settings);
			var out = {};
			for (var i = 0; i < FIELDS.length; i++) {
				var f = FIELDS[i];
				out[f.key] = f.type === "boolean" ? n[f.key] : String(n[f.key]);
			}
			return out;
		}
		function fromDraft(draft) {
			var out = {};
			for (var i = 0; i < FIELDS.length; i++) {
				var f = FIELDS[i];
				if (f.type === "boolean") out[f.key] = draft[f.key] === true;
				else out[f.key] = draft[f.key] === "" || draft[f.key] === undefined || draft[f.key] === null ? NaN : Number(draft[f.key]);
			}
			return out;
		}
		function sameDraft(a, b) {
			if (!a || !b) return a === b;
			for (var i = 0; i < FIELDS.length; i++) { if (a[FIELDS[i].key] !== b[FIELDS[i].key]) return false; }
			return true;
		}

		// ---------- 配置卡 ----------
		function ConfigCard(props) {
			var t = props.t;
			var state = props.usePluginCfg(function (s) { return s; });
			var loaded = !!(state && state.loaded && state.settings);
			var [draft, setDraft] = React.useState(null);
			var [flash, setFlash] = React.useState("");
			var [busy, setBusy] = React.useState(false);
			React.useEffect(function () {
				if (state && state.settings && draft === null) setDraft(toDraft(state.settings));
			}, [state && state.settings, draft]);

			if (props.view === "summary") return null;

			var view = draft || toDraft(state && state.settings);
			var dirty = !!(draft && state && state.settings && !sameDraft(draft, toDraft(state.settings)));

			function patch(key, value) {
				setDraft(function (cur) {
					var next = Object.assign({}, cur || toDraft(state && state.settings));
					next[key] = value;
					return next;
				});
				setFlash("");
			}
			function save() {
				if (busy) return;
				setBusy(true);
				props.savePluginCfg(fromDraft(view)).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						setDraft(null);
						setFlash(t("saved"));
						setTimeout(function () { setFlash(""); }, 2400);
					} else {
						setFlash(t("saveError") + (res && res.error && res.error.message ? "：" + res.error.message : ""));
					}
				});
			}
			function reset() {
				if (busy) return;
				setBusy(true);
				props.resetPluginCfg().then(function (res) {
					setBusy(false);
					if (res && res.ok) { setDraft(null); setFlash(t("resetDone")); setTimeout(function () { setFlash(""); }, 2400); }
					else setFlash(t("saveError") + (res && res.error && res.error.message ? "：" + res.error.message : ""));
				});
			}

			var rows = FIELDS.map(function (f) {
				var control = f.type === "boolean"
					? React.createElement("label", { className: "cfg-switch", key: "ctl" }, [
						React.createElement("input", {
							key: "in",
							type: "checkbox",
							"data-cfg-field": f.key,
							checked: view[f.key] === true,
							onChange: function (e) { patch(f.key, e.target.checked); }
						}),
						React.createElement("span", { key: "tx" }, view[f.key] === true ? t("on") : t("off"))
					])
					: React.createElement("input", {
						className: "cfg-input",
						type: "number",
						"data-cfg-field": f.key,
						value: view[f.key],
						min: f.min,
						max: f.max,
						step: f.step,
						onChange: function (e) { patch(f.key, e.target.value); }
					});
				return React.createElement("div", { className: "cfg-field", key: f.key }, [
					React.createElement("div", { className: "cfg-head", key: "h" }, [
						React.createElement("span", { className: "cfg-label", key: "l" }, f.label),
						control
					]),
					React.createElement("p", { className: "cfg-hint", key: "p" }, f.hint)
				]);
			});

			var status = null;
			if (state && state.status === "error") {
				status = React.createElement("span", { className: "cfg-status", "data-tone": "error", "data-cfg-status": "error" }, t("loadError"));
			} else if (flash) {
				status = React.createElement("span", { className: "cfg-status", "data-tone": flash === t("saved") || flash === t("resetDone") ? "ok" : "error", "data-cfg-status": "flash" }, flash);
			} else if (!loaded) {
				status = React.createElement("span", { className: "cfg-status", "data-tone": "muted", "data-cfg-status": "loading" }, t("loading"));
			} else {
				status = React.createElement("span", { className: "cfg-status", "data-tone": "muted", "data-cfg-status": "ready" }, t("ready"));
			}

			return React.createElement("div", { className: "cfg-card", "data-cfg-root": PKG }, [
				React.createElement("p", { className: "cfg-intro", key: "intro" }, t("intro")),
				React.createElement("div", { className: "cfg-fields", key: "fields" }, rows),
				React.createElement("div", { className: "cfg-actions", key: "actions" }, [
					status,
					React.createElement("button", {
						key: "reset",
						type: "button",
						className: "cfg-btn",
						"data-cfg-reset": "",
						disabled: !loaded || busy,
						onClick: reset
					}, t("reset")),
					React.createElement("button", {
						key: "save",
						type: "button",
						className: "cfg-btn cfg-btn-primary",
						"data-cfg-save": "",
						disabled: !loaded || busy || !dirty,
						onClick: save
					}, busy ? t("saving") : t("save"))
				])
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: dict, en: dict }); }, "ui-sessions-cost: config card dictionaries");
			var controller = createController(ctx.get("connection"));
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: PKG,
					locale: NS,
					inject: function () {
						return {
							hooks: { pluginCfg: controller.store },
							savePluginCfg: controller.save,
							resetPluginCfg: controller.reset
						};
					}
				}, ConfigCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
