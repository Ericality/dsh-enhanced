window.__ModuleLoader__.load({
	id: "@ericality/dsh-cost-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		// 宿主 0.1.2-rc.1 已移除 client-runtime 模块表 (照源文件部署会整页装载失败) ⇒ 走 client-store 包
		let { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		//  「费用提醒」设置卡 (设计方案 §11, 2026-09-06 预览区块 13 确认落地)
		//  设置 > 本地插件 > 费用提醒 (settings.localplugin.item key=cost-guard)。
		//  卡 = 唯一配置入口: 配置经 /costguard-cfg RPC 读写服务端
		//  值由宿主官方 Config 保存（volatile），所有浏览器统一。
		//  读取链 内置默认 ← patch config ← 卡内覆盖, 改后即时生效无需重启。
		// ═══════════════════════════════════════════════════════════════════
		const ROW_ID = "cost-guard";
		const NS = "ui-cost-guard";

		/** 键分组与展示元数据 (与服务端 /costguard-cfg 白名单键一一对应, 字段名即契约)。 */
		// A/B/C 键: 覆盖写入后覆盖 patch 默认; D 键 (原 /costguard-stats set 语义, 会话级→全局):
		//   留空 = 不覆盖 (空值即无此键, 用实测均值/config 兜底)。
		const CONS_FIELDS = [
			{ key: "consTurnYuan", zh: "当前回合费用", unit: "元" },
			{ key: "consCumYuan", zh: "累计费用", unit: "元" },
			{ key: "consCtxTokens", zh: "上下文阈值", unit: "tokens" },
			{ key: "consTurns", zh: "回合数阈值", unit: "回合" }
		];
		const AGG_FIELDS = [
			{ key: "aggTurnYuan", zh: "当前回合费用", unit: "元" },
			{ key: "aggCumYuan", zh: "累计费用", unit: "元" },
			{ key: "aggCtxTokens", zh: "上下文阈值", unit: "tokens" },
			{ key: "aggTurns", zh: "回合数阈值", unit: "回合" }
		];
		const PRED_FIELDS = [
			{ key: "continueFactor", zh: "继续本会话乘数", unit: "×" },
			{ key: "switchFactor", zh: "切换新会话乘数", unit: "×" },
			{ key: "predictTurns", zh: "预测未来回合数", unit: "回合" }
		];
		const OVR_FIELDS = [
			{ key: "inputPerTurn", zh: "预测输入（/回合）", unit: "tokens", ph: "留空 = 不覆盖（用实测均值）", note: "实测统计均值 → config → 内置兜底" },
			{ key: "outputPerTurn", zh: "预测输出+推理（/回合）", unit: "tokens", ph: "留空 = 不覆盖（用实测均值）", note: "均值缺失时兜底 config outputTokensPerTurn" },
			{ key: "firstTurnOutput", zh: "首回合输出", unit: "tokens", ph: "留空 = 不覆盖", note: "默认与每回合输出同源" },
			{ key: "taskFileTokens", zh: "任务文件大小估算", unit: "tokens", ph: "留空 = 用 config 值", note: "config 默认 taskFileTokens" }
		];
		const GROUPS = [
			{ id: "cons", title: "保守阈值（省钱优先）", tag: "触发「建议切换」", open: true, fields: CONS_FIELDS, ovrLike: false },
			{ id: "agg", title: "激进阈值（效率优先）", tag: "触发「建议切换」/「丰俭由人」", open: true, fields: AGG_FIELDS, ovrLike: false },
			{ id: "pred", title: "预测参数（v5 未来回合）", tag: "继续×1.2 · 切换×0.6 · N=5", open: false, fields: PRED_FIELDS, ovrLike: false },
			{ id: "ovr", title: "全局覆盖（原 /costguard-stats set 语义 · 会话级 → 全局）", tag: "空 = 不覆盖", open: false, fields: OVR_FIELDS, ovrLike: true }
		];
		const OVR_KEY_SET = Object.fromEntries(OVR_FIELDS.map((f) => [f.key, true]));
		/** summary 摘要用「档位」判定 (契约 §5.1): 覆盖命中保守组 ⇒ 保守; 否则命中激进组 ⇒ 激进; 均无覆盖 ⇒ 默认。
		 *  (卡内覆盖 = 服务端 cfg.overrides 白名单键; 两组都覆盖时取"省钱优先"的保守档, 与卡内分组顺序一致) */
		function tierOf(ovr) {
			const has = (f) => Object.prototype.hasOwnProperty.call(ovr, f.key);
			if (CONS_FIELDS.some(has)) return "保守";
			return AGG_FIELDS.some(has) ? "激进" : "默认";
		}
		/** 遗留只读键 (只读展示, 不再参与触发; 仅 /costguard-test 参考口径)。 */
		const RO_ITEMS = [
			{ key: "thresholdYuan", tag: "废弃", note: "v5 起不再参与触发" },
			{ key: "estimateTurns", tag: "废弃", note: "v2 对比回合数" },
			{ key: "diffThresholdYuan", tag: "仅展示", note: "差异阈值 · 仅 /costguard-test 参考" },
			{ key: "firstTurnOutputTokens", tag: "废弃兜底", note: "首回合输出已与每回合输出同源" }
		];

		// ---------- 样式 (cg-* 家族 = 预览 banner-styles.html 区块 13; 用宿主主题变量,
		// 琥珀系 var(--dsw-alias-state-warn-primary,#f59e0b) 自适应深浅主题, 色值兜底同预览) ----------
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-cg-card-css")) return;
			var st = document.createElement("style");
			st.id = "dsh-cg-card-css";
			st.textContent = [
				// 卡根不再自绘胶囊外壳 (契约 §5.1: border/background/border-radius/外层 padding 全部去掉;
				// 外壳与折叠由容器 quick-insert 的 .dsh-lp-card 提供, 卡内元素样式自主) —— 同时删掉卡自带的
				// 标题行 .cg-head / 徽标 .cg-badge (改由 summary 槽的 CostGuardSummary 渲染, 契约 §5.2)
				".cg-card{flex-direction:column;gap:11px;display:flex;box-sizing:border-box;min-width:0}",
				// 本卡主题色 (warn 琥珀); 契约 §3.1/§5.4: 卡侧显式声明, 不依赖容器按 key 哈希分配
				".dsh-lp-card[data-lp-key=\"cost-guard\"]{--lp-accent:#f59e0b}",
				".cg-note{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 6%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,transparent);border-radius:8px;padding:6px 10px;font-size:11.5px;line-height:1.75;color:var(--dsw-alias-label-secondary)}",
				".cg-note b{color:var(--dsw-alias-state-warn-primary,#fbbf24);font-weight:600}",
				".cg-note code,.cg-hint code,.cg-flabel code{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:10.5px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}",
				".cg-details{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px}",
				".cg-details[open]{padding-bottom:2px}",
				".cg-details summary{cursor:pointer;display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;user-select:none;padding:2px 0;list-style:none}",
				".cg-details summary::-webkit-details-marker{display:none}",
				".cg-details summary:hover{color:var(--dsw-alias-label-primary)}",
				".cg-arr{font-size:9px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;flex:none}",
				".cg-details[open] summary .cg-arr{transform:rotate(90deg)}",
				".cg-tag{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 15%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 40%,transparent);color:var(--dsw-alias-state-warn-primary,#fbbf24);font-size:9.5px;font-weight:600;padding:0 7px;border-radius:8px;line-height:15px;flex:none;white-space:nowrap}",
				".cg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;align-items:end;margin-top:8px}",
				".cg-field{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".cg-flabel{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;flex-wrap:wrap}",
				".cg-key{color:var(--dsw-alias-label-tertiary);font-size:10px;font-family:ui-monospace,'SF Mono',Consolas,monospace}",
				".cg-fdef{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px}",
				".cg-ctrl{display:flex;gap:6px;align-items:center;min-width:0}",
				".cg-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);flex:1;min-width:0;height:30px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 9px;font-size:12.5px;line-height:22px}",
				".cg-input:focus{border-color:var(--dsw-alias-state-warn-primary,#f59e0b);outline:none}",
				".cg-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
				".cg-unit{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:0}",
				".cg-reset{flex:none;width:22px;height:22px;border-radius:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,transparent);background:transparent;color:var(--dsw-alias-state-warn-primary,#fbbf24);cursor:pointer;font-size:12px;line-height:1;padding:0}",
				".cg-reset:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent)}",
				".cg-reset:disabled{opacity:.35;cursor:default}",
				".cg-err{color:var(--dsw-alias-state-danger-primary,#ef4444);font-size:10.5px;line-height:14px}",
				".cg-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".cg-btn{box-sizing:border-box;height:30px;font:inherit;cursor:pointer;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);border-radius:15px;color:var(--dsw-alias-state-warn-primary,#fbbf24);background:transparent;padding:0 14px;font-size:12.5px;flex:none}",
				".cg-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent)}",
				".cg-btn:disabled{opacity:.5;cursor:default}",
				".cg-btn-solid{background:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:transparent;color:#241a02;font-weight:600}",
				".cg-btn-solid:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 88%,transparent)}",
				".cg-hint{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary);margin:0}",
				".cg-saved{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:11px}",
				".cg-ro{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px 14px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-top:8px}",
				".cg-ro-item{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".cg-rk{font-size:11px;font-family:ui-monospace,'SF Mono',Consolas,monospace;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
				".cg-rv{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
				".cg-rbadge{font-size:9px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:0 5px;line-height:13px;font-weight:500;flex:none}",
				"@media (max-width:560px){.cg-grid{grid-template-columns:1fr}}"
			].join("\n");
			(document.head || document.documentElement).appendChild(st);
		}

		// ---------- 控制器: /costguard-cfg RPC + snapshot store ----------
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
			var store = createSnapshotStore({ status: "loading", loaded: false, cfg: null, error: "" });
			var lastValue = null;
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "costguard-cfg", endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(value) {
				lastValue = value;
				store.set({ status: "ready", loaded: true, cfg: value, error: "" });
			}
			function fail(message) {
				store.set({ status: "error", loaded: lastValue !== null, cfg: lastValue, error: message || "读取失败" });
			}
			/** get: 卡加载即拉取 (服务端为权威源)。 */
			function refresh() {
				return call("get", {}).then(function (res) {
					if (res && res.ok) { publish(res.value); return res.value; }
					fail(res && res.error && res.error.message);
					return null;
				});
			}
			/** 写端点通用: set/reset/resetAll → 服务端返回最新全量 (defaults/patch/overrides/effective) */
			function mutate(endpoint, payload) {
				return call(endpoint, payload).then(function (res) {
					if (res && res.ok) publish(res.value);
					else fail(res && res.error && res.error.message);
					return res;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				setKey: function (key, value) { return mutate("set", { key: key, value: value }); },
				resetKey: function (key) { return mutate("reset", { key: key }); },
				resetAll: function () { return mutate("resetAll", {}); }
			};
		}

		// ---------- 「费用提醒」设置卡 ----------
		function CostGuardCard(props) {
			var state = props.useCostGuardCfg(function (s) { return s; });
			var h = react.createElement;
			var cfg = state && state.cfg;
			var patch = cfg && cfg.patch ? cfg.patch : {};
			var ovr = cfg && cfg.overrides ? cfg.overrides : {};
			var legacy = cfg && cfg.legacy ? cfg.legacy : {};
			var loaded = !!(state && state.loaded);
			// 编辑草稿: 输入中未提交的值 (提交/恢复后清除)
			var [drafts, setDrafts] = react.useState({});
			var [errors, setErrors] = react.useState({});
			var [savedAt, setSavedAt] = react.useState(null);
			var [busy, setBusy] = react.useState(false);
			var flashTimer = react.useRef(null);
			react.useEffect(function () {
				return function () { if (flashTimer.current) clearTimeout(flashTimer.current); };
			}, []);

			/** 字段当前显示值 (草稿优先; 未覆盖 → patch 层, D 键空 = 不覆盖) */
			function displayOf(key, f) {
				if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key];
				if (ovr[key] !== undefined) return String(ovr[key]);
				if (OVR_KEY_SET[key]) return "";
				return patch[key] !== undefined ? String(patch[key]) : "";
			}
			function commit(key) {
				if (!Object.prototype.hasOwnProperty.call(drafts, key)) return;
				var raw = (drafts[key] || "").trim();
				var next = Object.assign({}, drafts);
				delete next[key];
				setDrafts(next);
				if (raw === "") {
					// D 键留空 = 恢复"不覆盖"; A/B/C 空值非法
					if (OVR_KEY_SET[key]) { resetOne(key); return; }
					setErrors(Object.assign({}, errors, { [key]: "值不能为空" }));
					return;
				}
				var n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) {
					setErrors(Object.assign({}, errors, { [key]: "需为正数" }));
					return;
				}
				setBusy(true);
				props.setKey(key, n).then(function (res) {
					setBusy(false);
					if (res && res.ok) flashSaved();
					else setErrors(Object.assign({}, errors, { [key]: (res && res.error && res.error.message) || "保存失败" }));
				}, function () { setBusy(false); });
			}
			function resetOne(key) {
				setErrors(Object.assign({}, errors, { [key]: "" }));
				setBusy(true);
				props.resetKey(key).then(function (res) {
					setBusy(false);
					if (res && res.ok) flashSaved();
					else setErrors(Object.assign({}, errors, { [key]: (res && res.error && res.error.message) || "重置失败" }));
				}, function () { setBusy(false); });
			}
			function resetAll() {
				setBusy(true);
				props.resetAll().then(function (res) {
					setBusy(false);
					if (res && res.ok) { setDrafts({}); setErrors({}); flashSaved(); }
				}, function () { setBusy(false); });
			}
			function flashSaved() {
				setSavedAt(Date.now());
				if (flashTimer.current) clearTimeout(flashTimer.current);
				flashTimer.current = setTimeout(function () { setSavedAt(null); }, 1800);
			}
			function fmtTime(iso) {
				if (!iso) return "";
				try {
					return new Date(iso).toLocaleString("zh-CN", { hour12: false });
				} catch (e) { return iso; }
			}

			var note = h("div", { className: "cg-note" }, [
				h("b", null, "唯一配置入口"),
				"：本卡取代 patch config / 命令配置 —— 修改经 ",
				h("code", null, "/costguard-cfg"),
				" RPC 写服务端 ",
				h("code", null, "插件配置（插件页保存）"),
				" · 读取链 ",
				h("b", null, "默认 ← patch ← 卡内覆盖"),
				" · 改后",
				h("b", null, "即时生效无需重启"),
				"（仿壁纸卡持久化先例）"
			]);

			if (!loaded) {
				return h("div", { className: "cg-card" }, [
					note,
					h("div", { className: "cg-hint" }, state && state.status === "error"
						? "配置读取失败：" + (state.error || "") + "（RPC 未注册？需容器重启后生效）"
						: "加载中…")
				]);
			}

			var groupEls = GROUPS.map(function (g) {
				var fieldEls = g.fields.map(function (f) {
					var val = displayOf(f.key, f);
					var noteLine = g.ovrLike
						? (f.note || "")
						: (patch[f.key] !== undefined ? "patch 默认 " + patch[f.key] + (f.unit === "元" ? " 元" : f.unit === "回合" ? " 回合" : f.unit === "×" ? "" : " " + f.unit) : "");
					var overridden = ovr[f.key] !== undefined;
					var err = errors[f.key];
					return h("div", { className: "cg-field", key: f.key }, [
						h("label", { className: "cg-flabel" }, [
							h("span", null, f.zh),
							h("code", { className: "cg-key" }, f.key),
							overridden ? h("span", { className: "cg-tag" }, "已覆盖") : null
						]),
						noteLine ? h("div", { className: "cg-fdef" }, noteLine) : null,
						h("div", { className: "cg-ctrl" }, [
							h("input", {
								className: "cg-input",
								type: "text",
								inputMode: "decimal",
								value: val,
								placeholder: f.ph || (patch[f.key] !== undefined ? String(patch[f.key]) : ""),
								disabled: busy,
								onChange: function (e) {
									setDrafts(Object.assign({}, drafts, { [f.key]: e.target.value }));
									if (errors[f.key]) setErrors(Object.assign({}, errors, { [f.key]: "" }));
								},
								onBlur: function () { commit(f.key); },
								onKeyDown: function (e) {
									if (e.key === "Enter") { commit(f.key); e.currentTarget.blur(); }
								}
							}),
							h("span", { className: "cg-unit" }, f.unit),
							h("button", {
								type: "button",
								className: "cg-reset",
								title: overridden ? "恢复默认（清除该覆盖，回到 patch 值）" : (g.ovrLike ? "该键未覆盖（留空即为不覆盖）" : "当前已是默认（patch 值）"),
								disabled: busy || (!overridden && !Object.prototype.hasOwnProperty.call(drafts, f.key)),
								onClick: function () {
									// 有草稿 → 仅丢弃草稿; 有覆盖 → 服务端 reset
									if (Object.prototype.hasOwnProperty.call(drafts, f.key)) {
										var next = Object.assign({}, drafts);
										delete next[f.key];
										setDrafts(next);
										return;
									}
									if (overridden) resetOne(f.key);
								}
							}, "↺")
						]),
						err ? h("div", { className: "cg-err" }, err) : null
					]);
				});
				return h("details", { className: "cg-details", key: g.id, open: g.open }, [
					h("summary", null, [
						h("span", { className: "cg-arr" }, "▶"),
						g.title,
						h("span", { className: "cg-tag" }, g.tag)
					]),
					h("div", { className: "cg-grid" }, fieldEls)
				]);
			});

			var roEl = h("details", { className: "cg-details" }, [
				h("summary", null, [
					h("span", { className: "cg-arr" }, "▶"),
					"遗留仅展示（只读 · 不再参与触发）",
					h("span", { className: "cg-tag" }, "废弃 / 仅 /costguard-test 参考")
				]),
				h("div", { className: "cg-ro" }, RO_ITEMS.map(function (r) {
					var v = legacy[r.key];
					return h("div", { className: "cg-ro-item", key: r.key }, [
						h("div", { className: "cg-rk" }, [r.key, h("span", { className: "cg-rbadge" }, r.tag)]),
						h("div", { className: "cg-rv" }, "默认 " + (v !== undefined ? v : "—") + " · " + r.note)
					]);
				}))
			]);

			var actions = h("div", { className: "cg-actions" }, [
				h("button", {
					type: "button",
					className: "cg-btn cg-btn-solid",
					disabled: busy,
					onClick: resetAll
				}, "整卡重置默认（patch 默认）"),
				savedAt !== null
					? h("span", { className: "cg-saved", key: "saved" }, "✓ 已保存")
					: h("span", { className: "cg-hint" }, "单项 ↺ 恢复默认 · 修改即时生效"),
				cfg && cfg.updatedAt
					? h("span", { className: "cg-hint" }, "服务端同步于 " + fmtTime(cfg.updatedAt))
					: null
			]);

			var footer = h("div", { className: "cg-hint" }, [
				"命令调整：",
				h("code", null, "/costguard-stats"),
				" 查看 与 ",
				h("code", null, "/costguard-test"),
				" 验证保留 · ",
				h("code", null, "set / clear"),
				" 已移除；原 set 另支持的 ",
				h("code", null, "cacheReadPerTurn / stepsPerTurn"),
				" 两覆盖字段随 set/clear 一并移除（不入卡，回落实测均值链）。数值以实际保存为准。"
			]);

			// 标题行/徽标行已交给容器折叠胶囊的 summary 槽 (CostGuardSummary), 卡内不再自绘 (契约 §5.2);
			// 卡内分组级折叠 (.cg-details 保守/激进/预测/覆盖 ×4) 全部保留
			return h("div", { className: "cg-card" }, [note].concat(groupEls, [actions, roEl, footer]));
		}

		// ---------- 费用提醒卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5.1) ----------
		// 与 item 卡共用同一个 inject 返回值 (hooks.costGuardCfg 实时订阅 ⇒ 改卡后摘要立即跟随)
		function CostGuardSummary(props) {
			var h = react.createElement;
			var state = props.useCostGuardCfg(function (s) { return s; });
			var loaded = !!(state && state.loaded);
			var hint = "读取中…"; // 未加载 ⇒ 契约 §5.1: 摘要不得为空
			if (loaded) {
				var cfg = (state && state.cfg) || {};
				var ovr = cfg.overrides && typeof cfg.overrides === "object" ? cfg.overrides : {};
				var n = Object.keys(ovr).length;
				hint = "档位 " + tierOf(ovr) + " · " + (n > 0 ? n + " 项覆盖" : "无覆盖");
			}
			return h(react.Fragment, null, [
				h("span", { className: "lp-ico", key: "ico" }, "💰"),
				h("span", { className: "lp-title", key: "title" }, "费用提醒"),
				h("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				h("span", { className: "lp-hint", key: "hint" }, hint)
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];
		// 中文卡 (zh 即 en, 免英文回退缺失)
		var dict = {};

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: dict, en: dict }); }, "ui-cost-guard: settings card dictionaries");
			var controller = createController(ctx.get("connection"));

			// 设置菜单「本地插件」列: 「费用提醒」卡 body (仿 bg-image/quick-insert 卡先例)
			// 卡只注册 body: 胶囊外壳 + 折叠 + 箭头由容器 (quick-insert) 提供 (契约 §1/§5.1)
			var cardInjected = function () {
				return {
					hooks: { costGuardCfg: controller.store },
					setKey: controller.setKey,
					resetKey: controller.resetKey,
					resetAll: controller.resetAll,
					refresh: controller.refresh
				};
			};
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: "@ericality/dsh-cost-guard",
					locale: NS,
					inject: cardInjected
				}, CostGuardCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
