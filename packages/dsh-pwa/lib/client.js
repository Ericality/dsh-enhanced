window.__ModuleLoader__.load({
	id: "@ericality/dsh-pwa",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-pwa 客户端：插件详情页的 PWA 配置卡
		//
		// 1) 注册槽位 plugins.bundle.config（key = 包名），view = page：页面负责
		//    标题、图标与面包屑，本组件只画表单主体 + 自带保存按钮。
		// 2) 三套图标（sky/lav/mint）预览网格 + 五个字段（name、shortName、
		//    themeColor、backgroundColor、display）+ 保存。
		// 3) 读写走自有 RPC /api/pwa/config/get|set（宿主官方 Config 落盘），
		//    保存后下一次请求即生效：刷新页面即可看到清单与图标变化。
		// ═══════════════════════════════════════════════════════════════════

		var NS = "ui-pwa";
		var CHANNEL = "pwa/config";

		var THEMES = [
			{ id: "sky", label: "天空蓝", swatch: "#4D6BFE" },
			{ id: "lav", label: "淡紫", swatch: "#7C6CF0" },
			{ id: "mint", label: "薄荷绿", swatch: "#12B886" }
		];
		var DISPLAYS = [
			{ id: "standalone", label: "独立窗口（standalone）" },
			{ id: "fullscreen", label: "全屏（fullscreen）" },
			{ id: "minimal-ui", label: "精简界面（minimal-ui）" },
			{ id: "browser", label: "浏览器标签（browser）" }
		];

		var zh = {
			title: "主屏安装",
			intro: "图标、名称与主题色在保存后即时生效：刷新一次页面即可看到新的清单、图标与主题色。",
			iconLabel: "图标",
			iconHint: "三套图标各两档（180 / 512），选中项同时用于 apple-touch-icon 与清单。",
			nameLabel: "应用名称",
			nameHint: "清单 name 字段，添加到主屏幕后显示在图标下方与启动页。",
			shortNameLabel: "短名称",
			shortNameHint: "清单 short_name 字段，主屏图标下空间不足时使用。",
			themeColorLabel: "主题色",
			themeColorHint: "清单 theme_color 与页面 theme-color，影响状态栏与浏览器地址栏。",
			bgColorLabel: "背景色",
			bgColorHint: "清单 background_color，独立窗口启动时的底色。",
			displayLabel: "显示模式",
			displayHint: "清单 display 字段，控制从主屏幕打开时的窗口形态。",
			save: "保存",
			saved: "✓ 已保存",
			saving: "保存中…",
			cancel: "撤销",
			loading: "读取中…",
			error: "读取失败，请刷新重试",
			saveError: "保存失败",
			preview: "当前选中",
			colorPlaceholder: "#4D6BFE"
		};
		var en = {
			title: "Home screen",
			intro: "Icon, name and colours apply as soon as they are saved: refresh the page to see the new manifest, icons and theme colour.",
			iconLabel: "Icon",
			iconHint: "Three sets, two sizes each (180 / 512); the selection feeds apple-touch-icon and the manifest.",
			nameLabel: "App name",
			nameHint: "Manifest name, shown under the icon and on the launch screen.",
			shortNameLabel: "Short name",
			shortNameHint: "Manifest short_name, used when space under the icon is tight.",
			themeColorLabel: "Theme colour",
			themeColorHint: "Manifest theme_color and the page theme-color meta.",
			bgColorLabel: "Background colour",
			bgColorHint: "Manifest background_color, the splash backdrop of a standalone window.",
			displayLabel: "Display mode",
			displayHint: "Manifest display, how the home-screen shortcut opens.",
			save: "Save",
			saved: "✓ Saved",
			saving: "Saving…",
			cancel: "Revert",
			loading: "Loading…",
			error: "Failed to load, refresh to retry",
			saveError: "Save failed",
			preview: "Selected",
			colorPlaceholder: "#4D6BFE"
		};

		var INJECTED_CSS = [
			".dsh-pwa-card{flex-direction:column;gap:16px;display:flex;color:var(--dsw-alias-label-primary)}",
			".dsh-pwa-intro{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}",
			".dsh-pwa-section{flex-direction:column;gap:8px;display:flex}",
			".dsh-pwa-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".dsh-pwa-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}",
			".dsh-pwa-icons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}",
			".dsh-pwa-icon{border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;display:flex;font:inherit;color:inherit}",
			".dsh-pwa-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-pwa-icon[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}",
			".dsh-pwa-icon img{width:72px;height:72px;border-radius:16px;display:block}",
			".dsh-pwa-icon-name{font-size:13px;font-weight:500;line-height:18px}",
			".dsh-pwa-icon-state{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-pwa-icon[data-on=\"1\"] .dsh-pwa-icon-state{color:var(--dsw-alias-state-business-primary)}",
			".dsh-pwa-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
			".dsh-pwa-field{flex-direction:column;gap:5px;min-width:0;display:flex}",
			".dsh-pwa-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);height:34px;font:inherit;width:100%;padding:0 10px;font-size:13px}",
			".dsh-pwa-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".dsh-pwa-color{display:flex;align-items:center;gap:8px}",
			".dsh-pwa-color input[type=\"color\"]{width:34px;height:34px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;padding:2px;cursor:pointer}",
			".dsh-pwa-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);height:34px;font:inherit;width:100%;padding:0 8px;font-size:13px}",
			".dsh-pwa-actions{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:10px;padding-top:14px;display:flex}",
			".dsh-pwa-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;height:32px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;padding:0 16px;font-size:13px}",
			".dsh-pwa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-pwa-btn:disabled{opacity:.55;cursor:default}",
			".dsh-pwa-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
			".dsh-pwa-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
			".dsh-pwa-flash{color:var(--dsw-alias-state-success-primary);font-size:12.5px;line-height:18px}",
			".dsh-pwa-error{color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:18px}"
		].join("");

		function injectCss() {
			try {
				if (!document.getElementById("dsh-pwa-css")) {
					var st = document.createElement("style");
					st.id = "dsh-pwa-css";
					st.textContent = INJECTED_CSS;
					(document.head || document.documentElement).appendChild(st);
				}
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 控制器：/api/pwa/config/get|set ----------
		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, cfg: null, error: "" });
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
			function publish(cfg) {
				store.set({ status: "ready", loaded: true, cfg: cfg || null, error: "" });
			}
			function refresh() {
				return call("get", {}).then(function (res) {
					if (res.ok && res.value && res.value.config) publish(res.value.config);
					else store.set({ status: "error", loaded: true, cfg: null, error: (res.error && res.error.message) || "get failed" });
					return res;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				save: function (cfg) {
					return call("set", cfg).then(function (res) {
						if (res.ok && res.value && res.value.config) publish(res.value.config);
						return res;
					});
				}
			};
		}

		// ---------- 工具 ----------
		function normalize(cfg) {
			var c = cfg && typeof cfg === "object" ? cfg : {};
			return {
				icon: typeof c.icon === "string" ? c.icon : "sky",
				name: String(c.name === undefined || c.name === null ? "" : c.name),
				shortName: String(c.shortName === undefined || c.shortName === null ? "" : c.shortName),
				themeColor: String(c.themeColor === undefined || c.themeColor === null ? "" : c.themeColor),
				backgroundColor: String(c.backgroundColor === undefined || c.backgroundColor === null ? "" : c.backgroundColor),
				display: typeof c.display === "string" ? c.display : "standalone"
			};
		}

		function sameDraft(a, b) {
			if (!a || !b) return a === b;
			return a.icon === b.icon && a.name === b.name && a.shortName === b.shortName
				&& a.themeColor === b.themeColor && a.backgroundColor === b.backgroundColor && a.display === b.display;
		}

		function colorOrSwatch(value, fallback) {
			return /^#[0-9a-fA-F]{6}$/.test(value) ? value : /^#[0-9a-fA-F]{3}$/.test(value) ? value : fallback;
		}

		// ---------- 配置卡 ----------
		function PwaConfigCard(props) {
			var t = props.t;
			var state = props.usePwaCfg(function (s) { return s; });
			var loaded = !!(state && state.loaded && state.cfg);
			var [draft, setDraft] = React.useState(null);
			var [flash, setFlash] = React.useState("");
			var [busy, setBusy] = React.useState(false);
			React.useEffect(function () {
				if (state && state.cfg && draft === null) setDraft(normalize(state.cfg));
			}, [state && state.cfg, draft]);

			if (props.view === "summary") return null;

			var view = draft || normalize(state && state.cfg);
			var dirty = !!(draft && state && state.cfg && !sameDraft(draft, normalize(state.cfg)));

			function patch(field, value) {
				setDraft(function (cur) {
					var next = Object.assign({}, cur || normalize(state && state.cfg), {});
					next[field] = value;
					return next;
				});
				setFlash("");
			}
			function save() {
				if (busy) return;
				setBusy(true);
				props.savePwaCfg(Object.assign({}, view)).then(function (res) {
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
			function revert() {
				setDraft(loaded ? normalize(state.cfg) : null);
				setFlash("");
			}

			var head = React.createElement("div", { className: "dsh-pwa-section" }, [
				React.createElement("p", { className: "dsh-pwa-intro" }, t("intro"))
			]);

			var icons = React.createElement("div", { className: "dsh-pwa-section", "data-pwa-icons": "" }, [
				React.createElement("span", { className: "dsh-pwa-label" }, t("iconLabel")),
				React.createElement("div", { className: "dsh-pwa-icons" },
					THEMES.map(function (theme) {
						var on = view.icon === theme.id;
						return React.createElement("button", {
							key: theme.id,
							type: "button",
							className: "dsh-pwa-icon",
							"data-pwa-icon": theme.id,
							"data-on": on ? "1" : "0",
							"aria-pressed": on ? "true" : "false",
							onClick: function () { patch("icon", theme.id); }
						}, [
							React.createElement("img", { key: "img", src: "/pwa-icon-" + theme.id + "-180.png", alt: theme.label, width: 72, height: 72 }),
							React.createElement("span", { key: "name", className: "dsh-pwa-icon-name" }, theme.label),
							React.createElement("span", { key: "state", className: "dsh-pwa-icon-state" }, on ? t("preview") : theme.id)
						]);
					})
				),
				React.createElement("p", { className: "dsh-pwa-hint" }, t("iconHint"))
			]);

			function textField(key, label, hint, placeholder) {
				return React.createElement("div", { className: "dsh-pwa-field", key: key }, [
					React.createElement("label", { className: "dsh-pwa-label", htmlFor: "dsh-pwa-" + key }, label),
					React.createElement("input", {
						id: "dsh-pwa-" + key,
						className: "dsh-pwa-input",
						type: "text",
						"data-pwa-field": key,
						value: view[key],
						placeholder: placeholder || "",
						onChange: function (e) { patch(key, e.target.value); }
					}),
					React.createElement("span", { className: "dsh-pwa-hint" }, hint)
				]);
			}

			function colorField(key, label, hint, fallback) {
				var swatch = colorOrSwatch(view[key], fallback);
				return React.createElement("div", { className: "dsh-pwa-field", key: key }, [
					React.createElement("label", { className: "dsh-pwa-label", htmlFor: "dsh-pwa-" + key }, label),
					React.createElement("div", { className: "dsh-pwa-color" }, [
						React.createElement("input", {
							key: "picker",
							type: "color",
							value: swatch,
							"aria-label": label,
							onChange: function (e) { patch(key, e.target.value.toUpperCase()); }
						}),
						React.createElement("input", {
							key: "text",
							id: "dsh-pwa-" + key,
							className: "dsh-pwa-input",
							type: "text",
							"data-pwa-field": key,
							value: view[key],
							placeholder: t("colorPlaceholder"),
							onChange: function (e) { patch(key, e.target.value); }
						})
					]),
					React.createElement("span", { className: "dsh-pwa-hint" }, hint)
				]);
			}

			var fields = React.createElement("div", { className: "dsh-pwa-grid" }, [
				textField("name", t("nameLabel"), t("nameHint"), "DeepSeek Harness"),
				textField("shortName", t("shortNameLabel"), t("shortNameHint"), "DSH"),
				colorField("themeColor", t("themeColorLabel"), t("themeColorHint"), "#4D6BFE"),
				colorField("backgroundColor", t("bgColorLabel"), t("bgColorHint"), "#101320"),
				React.createElement("div", { className: "dsh-pwa-field", key: "display" }, [
					React.createElement("label", { className: "dsh-pwa-label", htmlFor: "dsh-pwa-display" }, t("displayLabel")),
					React.createElement("select", {
						id: "dsh-pwa-display",
						className: "dsh-pwa-select",
						"data-pwa-field": "display",
						value: view.display,
						onChange: function (e) { patch("display", e.target.value); }
					}, DISPLAYS.map(function (d) {
						return React.createElement("option", { key: d.id, value: d.id }, d.label);
					})),
					React.createElement("span", { className: "dsh-pwa-hint" }, t("displayHint"))
				])
			]);

			var status = null;
			if (state && state.status === "error") {
				status = React.createElement("span", { className: "dsh-pwa-error", "data-pwa-status": "error" }, t("error"));
			} else if (flash) {
				status = React.createElement("span", { className: "dsh-pwa-flash", "data-pwa-status": "flash" }, flash);
			} else if (!loaded) {
				status = React.createElement("span", { className: "dsh-pwa-hint", "data-pwa-status": "loading" }, t("loading"));
			}

			var actions = React.createElement("div", { className: "dsh-pwa-actions" }, [
				status,
				React.createElement("button", {
					key: "revert",
					type: "button",
					className: "dsh-pwa-btn",
					"data-pwa-revert": "",
					disabled: !loaded || !dirty,
					onClick: revert
				}, t("cancel")),
				React.createElement("button", {
					key: "save",
					type: "button",
					className: "dsh-pwa-btn dsh-pwa-btn-primary",
					"data-pwa-save": "",
					disabled: !loaded || busy,
					onClick: save
				}, busy ? t("saving") : t("save"))
			]);

			return React.createElement("div", { className: "dsh-pwa-card", "data-pwa-config": "" }, [head, icons, fields, actions]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "ui-pwa: dictionaries");
			var controller = createController(ctx.get("connection"));

			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: "@ericality/dsh-pwa",
					locale: NS,
					inject: function () {
						return {
							hooks: { pwaCfg: controller.store },
							savePwaCfg: controller.save
						};
					}
				}, PwaConfigCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
