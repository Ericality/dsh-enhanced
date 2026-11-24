window.__ModuleLoader__.load({
	id: "@ericality/dsh-quick-insert",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-quick-insert 客户端
		//
		// 1) 输入框上方"快速插入"按钮行 (conversation.input.dock, id quick-insert,
		//    order 15 = 待办条之后、任务队列条之前):
		//    - 青柠绿玻璃胶囊, 横向可滑动; 命令类 (label 以 / 开头) 等宽字体
		//    - 点击把按钮文本插入输入框**光标处** (经会话作用域 conversation 服务
		//      的 input shell 的 insertText, span CAS 防过期; 失败回退追加到末尾)
		//    - 队列/待办条的位置与附贴关系不动, 互不遮挡
		// 2) 设置菜单新列「本地插件」(settings.section id local-plugins, order 12,
		//    位于 模型 与 插件 之间) —— 以后所有自写插件配置卡都注册进这一列;
		//    首卡「快速插入」: 按钮列表 增删改 + 实时预览 + 保存/取消/重置默认
		// 3) 配置经服务端 /quick-insert RPC 通道读写 (get/set/reset),
		//    值由宿主官方 Config 保存 —— 远程浏览器保存同样生效
		//    (官方 settings.yaml 浏览器写入仅回环有效, 故不用)
		// ═══════════════════════════════════════════════════════════════════

		var NS = "ui-quick-insert";
		var CARD_KEY = "quick-insert";

		// ---------- 文案 ----------
		var zh = {
			nav: "本地插件",
			title: "本地插件",
			intro: "自写插件的配置集中地。每张卡 = 一个插件的配置入口。",
			empty: "暂无插件配置。",
			cardTitle: "快速插入按钮",
			cardHint: "显示在输入框上方的按钮列表 · 点击插入到光标处",
			labelField: "按钮显示名",
			textField: "点击插入的文本",
			delete: "删除",
			moveUp: "上移",
			moveDown: "下移",
			add: "＋ 添加按钮",
			save: "保存",
			saved: "✓ 已保存",
			cancel: "取消",
			reset: "重置默认",
			preview: "实时预览（输入框上方的按钮行效果）",
			pillTitle: "点击插入: {text}",
			ariaLabel: "快速插入按钮",
			noButtons: "暂无按钮，点「＋ 添加按钮」新建。"
		};
		var en = {
			nav: "Local Plugins",
			title: "Local Plugins",
			intro: "Config hub for self-written plugins. Each card is one plugin's entry.",
			empty: "No plugin config yet.",
			cardTitle: "Quick-insert buttons",
			cardHint: "The button row above the input · click to insert at cursor",
			labelField: "Button label",
			textField: "Text to insert",
			delete: "Delete",
			moveUp: "Move up",
			moveDown: "Move down",
			add: "＋ Add button",
			save: "Save",
			saved: "✓ Saved",
			cancel: "Cancel",
			reset: "Reset defaults",
			preview: "Live preview (the button row above the input)",
			pillTitle: "Click to insert: {text}",
			ariaLabel: "Quick-insert buttons",
			noButtons: "No buttons yet — add one with " + "\u201c＋ Add button\u201d."
		};

		// ---------- 样式 (青柠绿玻璃, 深浅主题都可读) ----------
		var INJECTED_CSS = [
			":root{",
			"--dsh-qi-pill-bg:rgba(132,204,22,.16);",
			"--dsh-qi-pill-hover:rgba(132,204,22,.26);",
			"--dsh-qi-pill-active:rgba(132,204,22,.32);",
			"--dsh-qi-pill-bd:rgba(163,230,53,.40);",
			"--dsh-qi-pill-tx:#d9f99d;",
			"--dsh-qi-cmd-tx:#e0f9b4;",
			"--dsh-qi-strip-bg:rgba(0,0,0,.16);",
			"}",
			"body:not([data-ds-dark-theme]){",
			"--dsh-qi-pill-bg:rgba(101,163,13,.11);",
			"--dsh-qi-pill-hover:rgba(101,163,13,.19);",
			"--dsh-qi-pill-active:rgba(101,163,13,.25);",
			"--dsh-qi-pill-bd:rgba(101,163,13,.36);",
			"--dsh-qi-pill-tx:#3f6212;",
			"--dsh-qi-cmd-tx:#41610f;",
			"--dsh-qi-strip-bg:rgba(255,255,255,.5);",
			"}",
			// dock 几何: 与 composer 卡片同宽对齐 (对照官方 QueueDock)
			".dsh-qi-dock{width:calc(100% - var(--dsh-composer-side-clearance,16px)*2);max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,0px)*2);margin:0 auto;box-sizing:border-box}",
			// 滑动条
			".dsh-qi-strip{display:flex;flex-flow:row nowrap;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;padding:6px 8px;border:1px solid var(--dsh-qi-pill-bd);border-radius:14px;background:var(--dsh-qi-strip-bg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 2px 10px rgba(0,0,0,.10);scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsh-qi-pill-tx) 30%,transparent) transparent;-webkit-overflow-scrolling:touch}",
			".dsh-qi-strip::-webkit-scrollbar{height:3px}",
			".dsh-qi-strip::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsh-qi-pill-tx) 26%,transparent);border-radius:2px}",
			".dsh-qi-strip::-webkit-scrollbar-track{background:transparent}",
			// 胶囊按钮
			".dsh-qi-pill{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;border-radius:999px;white-space:nowrap;border:1px solid var(--dsh-qi-pill-bd);background:var(--dsh-qi-pill-bg);color:var(--dsh-qi-pill-tx);font-size:12.5px;font-family:inherit;cursor:pointer;user-select:none;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:background .15s,transform .1s,box-shadow .15s}",
			".dsh-qi-pill:hover{background:var(--dsh-qi-pill-hover);box-shadow:0 2px 8px rgba(0,0,0,.14)}",
			".dsh-qi-pill:active{transform:scale(.96);background:var(--dsh-qi-pill-active)}",
			".dsh-qi-pill.dsh-qi-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsh-qi-cmd-tx)}",
			".dsh-qi-pill.dsh-qi-pill-static{cursor:default}",
			// 设置列 (本地插件)
			".dsh-qi-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
			".dsh-qi-h2{color:var(--dsw-alias-label-primary);margin:0;font-size:18px;font-weight:600}",
			".dsh-qi-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
			".dsh-qi-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
			".dsh-qi-cards{flex-direction:column;gap:10px;display:flex}",
			".dsh-qi-cardwrap{min-width:0}",
			// 配置卡
			// 卡本体: 外壳 (边框/背景/圆角/外层内距) 与标题行已交给容器折叠胶囊 (契约 §5), 此处只保留纵向布局
			".dsh-qi-card{flex-direction:column;gap:12px;display:flex}",
			".dsh-qi-qhead{align-items:baseline;gap:8px;display:flex}",
			".dsh-qi-qhead b{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}",
			".dsh-qi-qhead span{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsh-qi-qrow{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;align-items:end;gap:8px;display:grid}",
			".dsh-qi-rowacts{align-items:center;gap:4px;display:inline-flex}",
			".dsh-qi-mv{box-sizing:border-box;width:32px;height:32px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;justify-content:center;align-items:center;display:inline-flex;font-size:13px;line-height:1}",
			".dsh-qi-mv:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-qi-mv:disabled{opacity:.35;cursor:default}",
			".dsh-qi-field{flex-direction:column;gap:4px;display:flex;min-width:0}",
			".dsh-qi-flabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-qi-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;line-height:22px}",
			".dsh-qi-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".dsh-qi-del{box-sizing:border-box;width:32px;height:32px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;justify-content:center;align-items:center;display:inline-flex}",
			".dsh-qi-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".dsh-qi-add{box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;height:36px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:transparent;font-size:13px}",
			".dsh-qi-add:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-qi-actions{justify-content:flex-end;gap:8px;display:flex}",
			".dsh-qi-btn{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;font-size:13px}",
			".dsh-qi-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-qi-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
			".dsh-qi-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}",
			".dsh-qi-preview{border-top:1px dashed var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding-top:10px;display:flex}",
			".dsh-qi-preview-label{color:var(--dsw-alias-label-tertiary);font-size:11px}",
			".dsh-qi-preview-strip{width:100%;max-width:none;box-sizing:border-box}"
		].join("");


		function injectCss() {
			try {
				if (!document.getElementById("dsh-quick-insert-css")) {
					var st = document.createElement("style");
					st.id = "dsh-quick-insert-css";
					st.textContent = INJECTED_CSS;
					(document.head || document.documentElement).appendChild(st);
				}
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 控制器: /quick-insert RPC + store ----------
		/* ★`#A57`：通道面双路 —— 先打官方 Fetch 面 `/api/<channel>/<ep>`（0.2.2），
		   失败回落旧通道 `<channel>/<ep>`（0.1.2）；模式缓存 + 诊断锚（禁静默）。 */
		var _faceMode = null;
		function faceRpc(rpc, chName, endpoint, payload) {
			var callApi = function () { return rpc.call("/api", chName + "/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call("/" + chName, endpoint, payload || {}); };
			var p = _faceMode === "api" ? callApi()
				: _faceMode === "legacy" ? callLegacy()
				: callApi().then(function (r) { _faceMode = "api"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { [chName]: "api" }); } catch (e) {} return r; },
					function () { _faceMode = "legacy"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { [chName]: "legacy" }); } catch (e) {} return callLegacy(); });
			return Promise.resolve(p);
		}

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, buttons: [] });
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "quick-insert", endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(buttons) {
				store.set({
					status: "ready",
					loaded: true,
					buttons: Array.isArray(buttons) ? buttons.map(function (b) {
						return { label: String((b && b.label) || ""), text: String((b && b.text) || "") };
					}) : []
				});
			}
			function refresh() {
				call("get", {}).then(function (res) {
					if (res.ok) publish(res.value.buttons);
					else store.set({ status: "error", loaded: true, buttons: [] });
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				save: function (buttons) {
					return call("set", { buttons: buttons }).then(function (res) {
						if (res.ok) publish(res.value.buttons);
						return res;
					});
				},
				reset: function () {
					return call("reset", {}).then(function (res) {
						if (res.ok) publish(res.value.buttons);
						return res;
					});
				}
			};
		}

		// ---------- 工具 ----------
		function findComposerTextarea() {
			try {
				return document.querySelector('[data-composer-card] textarea');
			} catch (e) {
				return null;
			}
		}

		// ---------- 输入框 dock: 快速插入按钮行 ----------
		function QuickInsertDock(props) {
			var t = props.t;
			var state = props.useQuickInsert(function (s) { return s; });
			var buttons = state && state.loaded ? state.buttons : [];
			if (!buttons || buttons.length === 0) return null;
			return React.createElement("div", { className: "dsh-qi-dock", "data-quick-insert-dock": "" },
				React.createElement("div", { className: "dsh-qi-strip", role: "toolbar", "aria-label": t("ariaLabel") },
					buttons.map(function (b, i) {
						var label = String(b.label || "");
						var text = String(b.text || "");
						var cmd = label.charAt(0) === "/";
						return React.createElement("button", {
							key: i,
							type: "button",
							className: "dsh-qi-pill" + (cmd ? " dsh-qi-cmd" : ""),
							title: t("pillTitle", { text: text }),
							onClick: function () { props.insertText(text); }
						}, label);
					})
				)
			);
		}

		// ---------- 折叠胶囊卡: 配色 / 折叠记忆 / 撞色检测 (契约 §3/§4, 一律静默降级) ----------
		var LP_OPEN_KEY = "dsh-lp-open";
		// 非红调色板 (契约 §3.3: 排除红色系/大红, 8 色)
		var LP_PALETTE = ["#4176e6", "#14b8a6", "#22c55e", "#84cc16", "#f59e0b", "#a78bfa", "#0ea5e9", "#818cf8"];

		function lpHash(key) {
			// FNV-1a 32bit: 同一 key 永远得同一色 (刷新不变, 非每次随机)
			var h = 2166136261;
			var s = String(key === null || key === undefined ? "" : key);
			for (var i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return h >>> 0;
		}

		function lpAutoColor(key) {
			return LP_PALETTE[lpHash(key) % LP_PALETTE.length];
		}

		// 列内顺序分配自动色: 与上一张自动色相同 ⇒ 顺延下一个色 (契约 §3.3)
		function lpAccentMap(keys) {
			var map = {};
			var prev = null;
			var list = keys || [];
			for (var i = 0; i < list.length; i++) {
				var k = list[i];
				if (map[k] !== undefined) continue;
				var color = lpAutoColor(k);
				if (prev !== null && color === prev) {
					var idx = LP_PALETTE.indexOf(color);
					color = LP_PALETTE[(idx + 1) % LP_PALETTE.length];
					if (color === prev) color = LP_PALETTE[(idx + 2) % LP_PALETTE.length];
				}
				map[k] = color;
				prev = color;
			}
			return map;
		}

		function lpReadOpen() {
			try {
				var raw = window.localStorage.getItem(LP_OPEN_KEY);
				if (!raw) return {};
				var map = JSON.parse(raw);
				return map && typeof map === "object" ? map : {};
			} catch (e) { return {}; }
		}

		function lpWriteOpen(map) {
			try { window.localStorage.setItem(LP_OPEN_KEY, JSON.stringify(map)); } catch (e) { /* 写失败静默 */ }
		}

		// 挂载后 best-effort 撞色检测: --lp-accent 与 --lp-accent-auto 相同 ⇒ 该卡吃的是自动色;
		// 与上一张撞色 ⇒ 后一张让位 (内联 --lp-accent 顺延调色板)。任何异常静默降级 (契约 §3.4)
		function lpDedupeAccents(root) {
			try {
				if (!root || typeof window.getComputedStyle !== "function") return;
				var cards = root.querySelectorAll(".dsh-lp-card, .dsh-lp-flat");
				var prev = null;
				for (var i = 0; i < cards.length; i++) {
					var el = cards[i];
					var accent = String(window.getComputedStyle(el).getPropertyValue("--lp-accent") || "").trim();
					if (accent === "") continue;
					if (prev !== null && accent === prev) {
						var base = LP_PALETTE.indexOf(accent);
						if (base < 0) base = lpHash(el.getAttribute("data-lp-key")) % LP_PALETTE.length;
						for (var step = 1; step <= LP_PALETTE.length; step++) {
							var cand = LP_PALETTE[(base + step) % LP_PALETTE.length];
							if (cand !== prev) {
								el.style.setProperty("--lp-accent", cand);
								accent = cand;
								break;
							}
						}
					}
					prev = accent;
				}
			} catch (e) { /* 检测失败: 保持原色 */ }
		}


		// ---------- 快速插入配置卡 ----------
		function QuickInsertCard(props) {
			var t = props.t;
			var state = props.useQuickInsert(function (s) { return s; });
			var loaded = !!state.loaded;
			var [draft, setDraft] = React.useState(null); // null = 未编辑 (跟随 store)
			var [flash, setFlash] = React.useState(false);
			React.useEffect(function () {
				if (draft === null && loaded) {
					setDraft(state.buttons.map(function (b) { return { label: b.label, text: b.text }; }));
				}
			}, [loaded, state.buttons, draft]);
			var rows = draft === null ? [] : draft;
			function update(i, patch) {
				setDraft(function (cur) { return cur.map(function (b, j) { return j === i ? Object.assign({}, b, patch) : b; }); });
			}
			function remove(i) {
				setDraft(function (cur) { return cur.filter(function (b, j) { return j !== i; }); });
			}
			function move(i, dir) {
				setDraft(function (cur) {
					var j = i + dir;
					if (j < 0 || j >= cur.length) return cur;
					var next = cur.slice();
					var tmp = next[i];
					next[i] = next[j];
					next[j] = tmp;
					return next;
				});
			}
			function add() {
				setDraft(function (cur) { return cur.concat([{ label: "新按钮", text: "新按钮" }]); });
			}
			function flashSaved() {
				setFlash(true);
				setTimeout(function () { setFlash(false); }, 1200);
			}
			function save() {
				if (draft === null) return;
				props.saveButtons(draft).then(function (res) {
					if (res && res.ok) { setDraft(null); flashSaved(); }
				});
			}
			function cancel() {
				setDraft(loaded ? state.buttons.map(function (b) { return { label: b.label, text: b.text }; }) : null);
			}
			function reset() {
				props.resetButtons().then(function (res) {
					if (res && res.ok) { setDraft(null); flashSaved(); }
				});
			}
			return React.createElement("div", { className: "dsh-qi-card" }, [
				// 标题行/徽标已交给容器折叠胶囊的 summary 槽 (QuickInsertSummary), 卡内不再自绘 (契约 §5.2)
				loaded && rows.length === 0
					? React.createElement("p", { className: "dsh-qi-empty" }, t("noButtons"))
					: null,
				rows.map(function (b, i) {
					return React.createElement("div", { className: "dsh-qi-qrow", key: i }, [
						React.createElement("div", { className: "dsh-qi-field" }, [
							React.createElement("label", { className: "dsh-qi-flabel" }, t("labelField")),
							React.createElement("input", {
								className: "dsh-qi-input",
								value: b.label,
								onChange: function (e) { update(i, { label: e.target.value }); }
							})
						]),
						React.createElement("div", { className: "dsh-qi-field" }, [
							React.createElement("label", { className: "dsh-qi-flabel" }, t("textField")),
							React.createElement("input", {
								className: "dsh-qi-input",
								value: b.text,
								onChange: function (e) { update(i, { text: e.target.value }); }
							})
						]),
						React.createElement("div", { className: "dsh-qi-rowacts" }, [
							React.createElement("button", {
								type: "button",
								className: "dsh-qi-mv",
								title: t("moveUp"),
								disabled: i === 0,
								onClick: function () { move(i, -1); }
							}, "↑"),
							React.createElement("button", {
								type: "button",
								className: "dsh-qi-mv",
								title: t("moveDown"),
								disabled: i === rows.length - 1,
								onClick: function () { move(i, 1); }
							}, "↓"),
							React.createElement("button", {
								type: "button",
								className: "dsh-qi-del",
								title: t("delete"),
								onClick: function () { remove(i); }
							}, "✕")
						])
					]);
				}),
				React.createElement("button", { type: "button", className: "dsh-qi-add", onClick: add }, t("add")),
				React.createElement("div", { className: "dsh-qi-preview" }, [
					React.createElement("span", { className: "dsh-qi-preview-label" }, t("preview")),
					React.createElement("div", { className: "dsh-qi-strip dsh-qi-preview-strip" },
						rows.map(function (b, i) {
							var label = String(b.label || "");
							var cmd = label.charAt(0) === "/";
							return React.createElement("span", {
								key: i,
								className: "dsh-qi-pill dsh-qi-pill-static" + (cmd ? " dsh-qi-cmd" : "")
							}, label);
						})
					)
				]),
				React.createElement("div", { className: "dsh-qi-actions" }, [
					React.createElement("button", { type: "button", className: "dsh-qi-btn", onClick: reset }, t("reset")),
					React.createElement("button", { type: "button", className: "dsh-qi-btn", onClick: cancel }, t("cancel")),
					React.createElement("button", {
						type: "button",
						className: "dsh-qi-btn dsh-qi-btn-primary",
						onClick: save
					}, flash ? t("saved") : t("save"))
				])
			]);
		}

		// ---------- 快速插入卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5.1) ----------
		// 与 item 卡共用同一个 inject 返回值 ⇒ props 面一致 (hooks.quickInsert 实时订阅 ⇒ 摘要天然响应式)
		function QuickInsertSummary(props) {
			var state = props.useQuickInsert(function (s) { return s; });
			var loaded = !!(state && state.loaded);
			var n = loaded && Array.isArray(state.buttons) ? state.buttons.length : 0;
			return React.createElement(React.Fragment, null, [
				React.createElement("span", { className: "lp-ico", key: "ico" }, "⚡"),
				React.createElement("span", { className: "lp-title", key: "title" }, "快速插入按钮"),
				React.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				React.createElement("span", { className: "lp-hint", key: "hint" }, loaded ? n + " 个按钮" : "读取中…")
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection", "sessions"];

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "ui-quick-insert: dictionaries");
			var t = ctx.locale.bind(NS);
			var controller = createController(ctx.get("connection"));

			// 1) 输入框上方按钮行 (待办条后 / 队列条前, 不与现有 dock 冲突)
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register({
					name: "conversation.input.dock",
					id: "quick-insert",
					order: 15,
					locale: NS,
					inject: function (sessionId) {
						// 会话作用域服务暂不可用时安全降级 (不抛错, 避免拖垮整个 dock 列表)
						var actx = null;
						try { actx = ctx.sessions.scope(sessionId); } catch (e) { actx = null; }
						var conversation = null;
						if (actx !== null) {
							try { conversation = actx.get("conversation"); } catch (e) { conversation = null; }
						}
						var insertText = function (text) { /* 服务不可用: 静默忽略 */ };
						if (conversation !== null) {
							insertText = function (text) {
								try {
									var shell = conversation.input.for(actx);
									var snap = shell.snapshot;
									var ta = findComposerTextarea();
									var caret = ta !== null && typeof ta.selectionStart === "number"
										? ta.selectionStart
										: snap.draft.length;
									var ok = shell.insertText(text, { start: caret, end: caret, draftRev: snap.draftRev });
									if (!ok) {
										var snap2 = shell.snapshot;
										shell.insertText(text, { start: snap2.draft.length, end: snap2.draft.length, draftRev: snap2.draftRev });
									}
									if (ta !== null) {
										ta.focus();
										var pos = caret + text.length;
										requestAnimationFrame(function () {
											try { ta.setSelectionRange(pos, pos); } catch (e) { /* 忽略 */ }
										});
									}
								} catch (e) { /* 插入失败不打扰用户 */ }
							};
						}
						return {
							hooks: { quickInsert: controller.store },
							insertText: insertText
						};
					}
				}, QuickInsertDock);
			});

			// 2) 配置卡迁到插件详情页（plugins.bundle.config，key = 包名）；旧「设置 > 本地插件」列已退役
			var cardInjected = function () {
				return {
					hooks: { quickInsert: controller.store },
					saveButtons: controller.save,
					resetButtons: controller.reset
				};
			};
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: "@ericality/dsh-quick-insert",
					locale: NS,
					inject: cardInjected
				}, QuickInsertCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
