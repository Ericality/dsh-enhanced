window.__ModuleLoader__.load({
	id: "@ericality/dsh-mesh-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		// 构建时写入的客户端版本（服务端版本在 view.version 里；两者一起显示，升级没落地时一眼可见）。
		var CLIENT_VERSION = "0.5.6";
		var PANEL_ID = "mesh-panel";
		var EMPTY_FORM = { host: "", port: "", protocol: "auto", label: "", peerId: "", controlBase: "", viewUrl: "", advanced: false };
		var ERR_TEXT = { "fingerprint-mismatch": "证书指纹不符，已拒绝连接（不降级明文）", "no-pin": "未钉住对端证书指纹，请先点“生成配对码”并核对指纹", "pin-corrupt": "本机保存的指纹与证书不一致，请重新配对", "insecure-transport": "对端已钉住 https 指纹，拒绝明文连接", "rate-limited": "配对尝试过于频繁，请 1 分钟后再试", "code-locked": "该配对码错误次数过多，已作废，请重新生成", "unknown-code": "配对码不存在", "code-used": "配对码已使用", "code-expired": "配对码已过期", "busy": "请求过多，请稍后再试", "token-rejected": "对端不认旧 token（401），已拒绝强制信任；请重新配对", "no-old-pin": "本机没有旧指纹，强制信任不适用；请重新配对", "not-https": "明文 http 节点没有证书可信任", "authorization-invalid": "授权无效（401），需重新配对", "address-unavailable": "对端地址不可用，请补地址" };
		var DEFAULT_PORT = "8470";

		function MeshIcon(props) {
			var size = props && props.size ? props.size : 18;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": "true" },
				h("circle", { cx: 6, cy: 7, r: 2.2 }),
				h("circle", { cx: 18, cy: 17, r: 2.2 }),
				h("path", { d: "M8.1 8.2l7.8 7.5M8.2 17.5h7.4M17.9 4.5v5" }),
			);
		}

		function apply(ctx) {
			var connection = ctx.get("connection");

			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, status: 0, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				try {
					return Promise.resolve(rpc.call("/api", "mesh-panel/" + endpoint, payload || {})).then(function (res) {
						if (res && res.ok) return { ok: true, value: res.value || {} };
						var err = (res && res.error) || { code: "transport", message: "no response" };
						var status = (err.details && err.details.status) || 0;
						return { ok: false, status: status, error: err };
					}).catch(function (err) {
						return { ok: false, status: 0, error: { code: "transport", message: String((err && err.message) || err) } };
					});
				} catch (err) {
					return Promise.resolve({ ok: false, status: 0, error: { code: "transport", message: String((err && err.message) || err) } });
				}
			}

			function errText(res) {
				if (!res) return "no-response";
				if (res.error && res.error.code && ERR_TEXT[res.error.code]) {
					var extra = res.error.details && res.error.details.actual ? "（实际前缀 " + String(res.error.details.actual).slice(0, 11).toUpperCase() + "…）" : "";
					return ERR_TEXT[res.error.code] + extra;
				}
				if (res.error && (res.error.message || res.error.code)) return String(res.error.message || res.error.code);
				return "HTTP " + String(res.status || "?");
			}
			function copyObject(prev) {
				var next = {};
				for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
				return next;
			}

			function MeshPanel() {
				var viewS = React.useState(null);
				var view = viewS[0];
				var setView = viewS[1];
				var errS = React.useState("");
				var err = errS[0];
				var setErr = errS[1];
				var msgS = React.useState("");
				var msg = msgS[0];
				var setMsg = msgS[1];
				var busyS = React.useState(false);
				var busy = busyS[0];
				var setBusy = busyS[1];
				var addS = React.useState(false);
				var showAdd = addS[0];
				var setShowAdd = addS[1];
				var formS = React.useState(EMPTY_FORM);
				var form = formS[0];
				var setForm = formS[1];
				var codesS = React.useState({});
				var codes = codesS[0];
				var setCodes = codesS[1];
				var inputsS = React.useState({});
				var inputs = inputsS[0];
				var setInputs = inputsS[1];
				var searchS = React.useState("");
				var search = searchS[0];
				var setSearch = searchS[1];
				var sortS = React.useState("name");
				var sort = sortS[0];
				var setSort = sortS[1];
				var selS = React.useState({});
				var sel = selS[0];
				var setSel = selS[1];
				var renameS = React.useState("");
				var renameId = renameS[0];
				var setRenameId = renameS[1];
				var renameDraftS = React.useState("");
				var renameDraft = renameDraftS[0];
				var setRenameDraft = renameDraftS[1];
				var cfgS = React.useState({ port: "", bind: "127.0.0.1", protocol: "https", maxConcurrency: "32", autoApprove: false, guiPort: "0", publicBase: "" });
				var cfg = cfgS[0];
				var setCfg = cfgS[1];
				var dirtyRef = React.useRef(false);
				var trustS = React.useState({});
				var trust = trustS[0];
				var setTrust = trustS[1];
				var trustTried = React.useRef({});
				var addrS = React.useState({ id: "", host: "", port: "", protocol: "https", source: "manual" });
				var addrEdit = addrS[0];
				var setAddrEdit = addrS[1];
				var logsS = React.useState({});
				var logs = logsS[0];
				var setLogs = logsS[1];
				var logsBusyS = React.useState({});
				var logsBusy = logsBusyS[0];
				var setLogsBusy = logsBusyS[1];
				var fallbackS = React.useState(null);
				var fallbackState = fallbackS[0];
				var setFallbackState = fallbackS[1];
				var openStateS = React.useState("");
				var openState = openStateS[0];
				var setOpenState = openStateS[1];
				var embedS = React.useState(null);
				var embedState = embedS[0];
				var setEmbedState = embedS[1];

				var refresh = React.useCallback(function () {
					return call("get", {}).then(function (res) {
						if (res && res.ok) setView(res.value || {});
						else setErr("插件未就绪（" + errText(res) + "）");
					});
				}, []);

				React.useEffect(function () { refresh(); }, [refresh]);
				React.useEffect(function () {
					var timer = setInterval(function () { refresh(); }, 5000);
					return function () { clearInterval(timer); };
				}, [refresh]);
				var savedSig = view && view.settings && view.settings.saved ? JSON.stringify(view.settings.saved) : "";
				React.useEffect(function () {
					if (view && view.settings && view.settings.saved && !dirtyRef.current) {
						setCfg({ port: String(view.settings.saved.port), bind: view.settings.saved.bind, protocol: view.settings.saved.protocol, maxConcurrency: String(view.settings.saved.maxConcurrency || 32), autoApprove: Boolean(view.settings.saved.autoApprove), guiPort: String(view.settings.saved.guiPort || 0), publicBase: String(view.settings.saved.publicBase || "") });
					}
				}, [savedSig]);
				React.useEffect(function () {
					var id = "mesh-panel-responsive";
					if (document.getElementById(id)) return;
					var tag = document.createElement("style");
					tag.id = id;
					tag.textContent = "@media (max-width:480px){[data-mesh-panel]{padding:10px 12px!important}[data-mesh-node]{min-width:0!important;flex:1 1 100%!important}[data-mesh-card-grid]{display:block!important}[data-mesh-toolbar] input,[data-mesh-toolbar] select{flex:1 1 100%!important;min-width:0!important;width:100%!important;box-sizing:border-box}[data-mesh-toolbar] button{flex:1 1 auto}[data-mesh-settings] input,[data-mesh-settings] select{width:100%!important;box-sizing:border-box}[data-mesh-node] input,[data-mesh-node] button{max-width:100%}}";
					try { document.head.appendChild(tag); } catch (e) {}
				}, []);

				var nodes = (view && view.nodes) || [];
				var pending = (view && view.pending) || [];
				var selfInfo = view && view.self;
				var listener = view && view.listener;
				var compat = view && view.compat;

				var pollPending = React.useCallback(function () {
					var waiting = nodes.filter(function (n) { return n.pending; });
					if (!waiting.length) return;
					waiting.forEach(function (n) {
						call("pair-status", { nodeId: n.id }).then(function (res) {
							if (res && res.ok) {
								var st = res.value && res.value.status;
								if (st === "approved") { setMsg("对方已确认，配对成功"); refresh(); }
								else if (st === "rejected") { setErr("对方拒绝了配对请求"); refresh(); }
							}
						});
					});
				}, [nodes, refresh]);
				React.useEffect(function () {
					var t = setInterval(pollPending, 3000);
					return function () { clearInterval(t); };
				}, [pollPending]);
				// 件23：指纹不符时自动取一次新旧前缀（只读）；按钮是否可用取决于旧 token 是否仍被接受。
				React.useEffect(function () {
					nodes.forEach(function (n) {
						if (n.status !== "fingerprint-mismatch") return;
						var key = n.id + "|" + String(n.certFingerprint || "");
						if (trustTried.current[key]) return;
						trustTried.current[key] = true;
						call("trust-check", { nodeId: n.id }).then(function (res) {
							if (!res || !res.ok) return;
							var next = copyObject(trust); next[n.id] = res.value || {}; setTrust(next);
						});
					});
				}, [nodes]);

				function onForm(key, value) {
					var next = copyObject(form);
					next[key] = value;
					setForm(next);
				}
				function derived() {
					var host = String(form.host || "").trim();
					if (!host) return null;
					var port = String(form.port || "").trim() || DEFAULT_PORT;
					if (form.protocol === "auto") return { origin: "自动探测 https → http", viewUrl: "添加时探测", controlBase: "添加时探测" };
					var scheme = form.protocol === "https" ? "https" : "http";
					var origin = scheme + "://" + host + ":" + port;
					return { origin: origin, viewUrl: origin + "/", controlBase: origin + "/ctl" };
				}
				function onAdd() {
					if (busy) return;
					if (!derived()) { setErr("请填写主机"); return; }
					var payload = { host: form.host, port: String(form.port || "").trim(), protocol: form.protocol, label: form.label };
					if (form.advanced) {
						if (String(form.peerId || "").trim()) payload.peerId = form.peerId;
						if (String(form.controlBase || "").trim()) payload.controlBase = form.controlBase;
						if (String(form.viewUrl || "").trim()) payload.viewUrl = form.viewUrl;
					}
					setBusy(true); setErr(""); setMsg("");
					call("add", payload).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var v = res.value || {};
							var tip = "节点已添加，请配对";
							if (v.detection) tip = "探测结果：" + String(v.detection.protocol) + " 可达" + (v.detection.version ? "（对端 v" + String(v.detection.version) + "）" : "") + " · " + String(v.detection.latencyMs || 0) + "ms · 证书 " + String(v.detection.certFingerprintPrefix || "未取到") + "… · 已按 " + String(v.detection.protocol) + " 添加";
							else if (v.warning) tip = "节点已添加；" + String(v.warning);
							setMsg(tip);
							setShowAdd(false); setForm(EMPTY_FORM); refresh();
						}
						else setErr("添加失败（" + errText(res) + "）");
					});
				}
				function onCode(id) {
					setBusy(true); setErr(""); setMsg("");
					call("code", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var v = res.value || {};
							var nc = copyObject(codes); nc[id] = v; setCodes(nc);
							var ni = copyObject(inputs); ni[id] = v.code || ""; setInputs(ni);
							setMsg("配对码已生成（对端 " + String(v.host || "?") + ":" + String(v.port || "?") + "）");
						} else setErr("生成失败（" + errText(res) + "）");
					});
				}
				function onPair(id) {
					var code = String(inputs[id] || "").trim();
					if (!code) { setErr("请先输入配对码"); return; }
					setBusy(true); setErr(""); setMsg("");
					call("pair", { nodeId: id, code: code }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("配对成功（双向已建立）"); refresh(); }
						else setErr("配对失败（" + errText(res) + "）");
					});
				}
				function onRequest(id) {
					setBusy(true); setErr(""); setMsg("");
					call("request", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("已发送配对请求，等待对方在面板确认"); refresh(); }
						else setErr("请求失败（" + errText(res) + "）");
					});
				}
				function onApprove(requestId) {
					setBusy(true); setErr(""); setMsg("");
					call("approve", { requestId: requestId }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("已确认配对"); refresh(); }
						else setErr("确认失败（" + errText(res) + "）");
					});
				}
				function onReject(requestId) {
					setBusy(true); setErr(""); setMsg("");
					call("reject", { requestId: requestId }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("已拒绝配对请求"); refresh(); }
						else setErr("拒绝失败（" + errText(res) + "）");
					});
				}
				function isHttpOrigin() {
					try { return window.location.protocol === "http:" || window.location.protocol === "https:"; } catch (e) { return false; }
				}
				/** 同步预开：必须在点击事件里第一行调用，浏览器才认为这是用户手势。返回句柄，失败返回 null。 */
				function preOpenTab() {
					try {
						var w = window.open("about:blank", "_blank");
						return w || null;
					} catch (e) { return null; }
				}
				/** 把已经预开的句柄导航到目标地址；句柄不可用返回 false（不拿返回值判断“被拦截”）。 */
				function navigateTab(handle, url) {
					if (!handle || !url) return false;
					try { handle.location.replace(url); return true; } catch (e) {
						try { handle.location.href = url; return true; } catch (e2) { return false; }
					}
				}
				function showFallback(url, reason) {
					setFallbackState({ url: url || "", reason: reason || "打开失败" });
					setErr(reason || "打开失败");
					setMsg("");
				}
				function onCopyUrl() {
					var url = (fallbackState && fallbackState.url) || "";
					if (!url) return;
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(url).then(function () { setMsg("链接已复制"); }, function () { setMsg("复制失败，请手动选中链接复制"); });
					} else setMsg("当前环境不支持自动复制，请手动选中链接复制");
				}
				function onOpenHere() {
					var url = (fallbackState && fallbackState.url) || "";
					if (!url) return;
					try { window.location.assign(url); } catch (e) { setErr("本页跳转失败：" + url); }
				}
				function tryExternalOpen(url) {
					if (typeof window.open !== "function") return "unsupported";
					try { var w = window.open(url, "_blank"); return w ? "handle" : "called"; } catch (e) { return "unsupported"; }
				}
				function privateHintOf(node) {
					return node && node.privateAddress ? "；对端地址是内网 IP，仅内网可达：跨公网请改用公网地址重加，或在本机设置里填对外地址" : "";
				}
				function onOpenEmbed() {
					var url = (fallbackState && fallbackState.url) || "";
					if (!url) return;
					setEmbedState({ url: url });
				}
				function onOpen(id) {
					// 件26：① 外部打开优先（浏览器同步预开；桌面端把地址交给宿主/系统浏览器），② 外部失败/无窗口能力才内嵌 iframe。
					var httpOrigin0 = isHttpOrigin();
					var tab = httpOrigin0 ? preOpenTab() : null;
					setBusy(true); setErr(""); setMsg(""); setFallbackState(null); setOpenState(""); setEmbedState(null);
					var node = null;
					for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) node = nodes[i];
					var target = (node && node.viewUrl) || "";
					call("open", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (!res || !res.ok) {
							if (tab) { try { tab.close(); } catch (e) {} }
							var why = (res && res.error && res.error.code === "authorization-invalid") ? "授权无效，需重新配对" : ("打开被拒（" + String((res && res.status) || "?") + " " + errText(res) + "）");
							showFallback(target, why + (target ? "" : "；该节点没有可用地址") + privateHintOf(node));
							return;
						}
						var url = (res.value && res.value.url) || target;
						var protocol = (res.value && res.value.protocol) || (node && node.protocol) || "";
						var relayReady = Boolean(res.value && res.value.relayReady);
						var pub = String((selfInfo && selfInfo.publicBase) || (settings && settings.saved && settings.saved.publicBase) || "").replace(/\/$/, "");
						var localRelayPort = Number((view && view.relay && view.relay.localPort) || (res.value && res.value.relayLocalPort) || 0);
						var localRelayBase = localRelayPort > 0 ? ("http://127.0.0.1:" + localRelayPort) : "";
						var loopbackRelay = listener && Number(listener.guiPort) > 0 ? ("http://127.0.0.1:" + Number(listener.guiPort)) : "";
						var relayBase = pub || (httpOrigin0 ? window.location.origin : (localRelayBase || loopbackRelay));
						var useRelay = protocol === "https" && relayReady && Boolean(relayBase);
						var relayPath = (res.value && res.value.relayPath) || ("/mesh/" + encodeURIComponent(id) + "/");
						var finalUrl;
						if (useRelay) finalUrl = relayBase + relayPath;
						else finalUrl = url;
						if (httpOrigin0) {
							var navigated = tab ? navigateTab(tab, finalUrl) : false;
							if (!navigated) {
								if (tab) { try { tab.close(); } catch (e) {} }
								var ext = tryExternalOpen(finalUrl);
								if (ext === "handle") navigated = true;
							}
							if (!navigated) {
								showFallback(finalUrl, "外部窗口打不开（浏览器可能拦截）；已在面板内嵌打开" + privateHintOf(node));
								setEmbedState({ url: finalUrl });
								return;
							}
							if (useRelay) { setOpenState("relay"); setMsg("已用同源中继打开（" + finalUrl + "，服务端已校验证书指纹）"); }
							else if (protocol === "https" && relayReady && !relayBase) { setOpenState("direct"); setMsg("拿不到本机 GUI 端口，无法走本机代理，已直连 " + finalUrl + "；可在设置里填“GUI 端口（反代）”或对外地址"); }
							else if (protocol === "https" && !relayReady) { var rr = (res.value && res.value.relayReason) || ""; setOpenState("direct"); setMsg("中继不可用" + (rr ? "（" + rr + "）" : "（对方或本机缺凭据）") + "，已直连 " + finalUrl + "；自签证书可能需在浏览器点“继续”。"); }
							else { setOpenState("direct"); setMsg("已打开 " + finalUrl); }
							return;
						}
						// 桌面端：外部打开优先，把直连/中继地址交给宿主（返回值不可靠，不作为“被拦截”判据）。
						var ext2 = tryExternalOpen(finalUrl);
						if (ext2 === "unsupported") {
							setOpenState("embed");
							setMsg("桌面端外部打开不可用，已在面板内嵌打开" + (pub ? "" : "；可先在设置里填“本机对外地址”"));
							setFallbackState({ url: finalUrl, reason: "外部窗口不可用，已内嵌；也可复制链接或在当前页打开" + privateHintOf(node) });
							setEmbedState({ url: finalUrl });
							return;
						}
						setOpenState("desktop-direct");
						setMsg((useRelay ? (pub ? "已用对外地址代理打开 " : "已用本机回环代理打开 ") : "中继不可用，已直连 ") + finalUrl + "（代理优先；若没弹出，可用下面的复制链接、在当前页打开或在本页内嵌打开）");
						setFallbackState({ url: finalUrl, reason: "桌面端直连：已请求系统浏览器打开；若没弹出，可复制链接、在当前页打开或点“在本页内嵌打开”" + privateHintOf(node) });
					}, function (err) {
						setBusy(false);
						if (tab) { try { tab.close(); } catch (e) {} }
						showFallback(target, "打开失败：" + String((err && err.message) || err) + privateHintOf(node));
					}).catch(function (err) {
						setBusy(false);
						if (tab) { try { tab.close(); } catch (e) {} }
						showFallback(target, "打开异常：" + String((err && err.message) || err) + privateHintOf(node));
					});
				}
				function onRename(id, name) {
					setBusy(true); setErr("");
					call("rename", { nodeId: id, label: name }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("已改名"); setRenameId(""); refresh(); }
						else setErr("改名失败（" + errText(res) + "）");
					});
				}
				function onBatchDelete() {
					var ids = [];
					for (var k in sel) if (sel[k] && Object.prototype.hasOwnProperty.call(sel, k)) ids.push(k);
					if (!ids.length) { setErr("请先勾选要删除的节点"); return; }
					setBusy(true); setErr(""); setMsg("");
					var idx = 0; var unsynced = 0; var failed = 0;
					function next() {
						if (idx >= ids.length) {
							setBusy(false);
							setSel({});
							setMsg("已删除 " + ids.length + " 个" + (unsynced ? "（其中 " + unsynced + " 个远端未撤销）" : "") + (failed ? "，失败 " + failed + " 个" : ""));
							refresh();
							return;
						}
						call("delete", { nodeId: ids[idx++] }).then(function (res) {
							if (!res || !res.ok) failed++;
							else if (res.value && res.value.remote === "unreachable") unsynced++;
							next();
						});
					}
					next();
				}
				function onSaveSettings() {
					setBusy(true); setErr(""); setMsg("");
					call("set-settings", { port: cfg.port, bind: cfg.bind, protocol: cfg.protocol, maxConcurrency: cfg.maxConcurrency, autoApprove: cfg.autoApprove, guiPort: cfg.guiPort, publicBase: cfg.publicBase }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							dirtyRef.current = false;
							var l = res.value && res.value.listener;
							setMsg("设置已生效" + (l ? "（监听 " + String(l.protocol) + "://" + String(l.bind) + ":" + String(l.port) + "，无需重启）" : ""));
							refresh();
						} else {
							dirtyRef.current = false;
							setErr(errText(res));
							refresh();
						}
					});
				}
				function onProbe(id) {
					setBusy(true); setErr(""); setMsg("");
					call("probe", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var v = res.value || {};
							var auth = v.authorized === "authorized" ? "已连接 · 授权有效" : (v.authorized === "unauthorized" ? "已连接 · 未授权（需重新配对）" : (v.authorized === "error" ? "可达 · 授权检查异常" : "可达 · 未配对"));
							setMsg("连通性：" + auth + " · " + String(v.latencyMs || 0) + "ms · 对端 v" + String(v.version || "?") + " · " + String(v.protocol || ""));
							refresh();
						} else setErr("连通性测试失败：" + errText(res));
					});
				}
				function onDelete(id) {
					setBusy(true); setErr(""); setMsg("");
					call("delete", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var remote = res.value && res.value.remote;
							setMsg(remote === "unreachable" ? "已本地移除，远端未撤销（对端不可达）" : "节点已删除");
							refresh();
						} else setErr("删除失败（" + errText(res) + "）");
					});
				}
				function onReconnect(id) {
					setBusy(true); setErr("");
					call("reconnect", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("连接正常"); refresh(); }
						else if (res && res.error && res.error.code === "authorization-invalid") setErr("授权无效，需重新配对");
						else setErr("重连失败（" + String((res && res.status) || "?") + " " + errText(res) + "）");
					});
				}
				function hintOf(node) {
					var st = node.revoked ? "revoked" : node.status || "unpaired";
					if (st === "online") return "在线：可打开界面、测试连通、拉取对端只读日志；不再信任时点删除（会同时撤销对端授权）。";
					if (st === "invalid") return "授权无效：对端已撤销或 token 失效；请重新配对，或删除节点。";
					if (st === "needs-pin") return "待钉住指纹：点“生成配对码”记录指纹，并与对端本机证书前缀核对后再配对。";
					if (st === "fingerprint-mismatch") return "指纹不符：先看下方新旧指纹前缀；只有对端仍认旧 token 时才能“信任新证书并连接”，否则必须重新配对。";
					if (st === "pending") return "待对方确认：已提交，等对方面板同意后自动完成；拒绝则不建立。";
					if (st === "address-unavailable") return "地址不可用：对端自报的是容器/回环地址，不能当可达地址；请点“改地址”填对端 IP/域名（手动值不会被自动覆盖）。";
					if (st === "unpaired") return node.pending ? "已提交配对码：等待对方在本机面板确认；确认前双方都显示未配对。" : "未配对：生成配对码，或让对方发请求确认；可先点“测试连通”。";
					if (st === "revoked") return "已删除：只剩本地记录，可删除或重新添加。";
					return "不可达：检查对方是否开机、端口与防火墙；点“测试连通”重试；可改名或删除。";
				}
				function syncText(s) {
					if (!s) return "";
					var map = { manual: "手动地址，不改", throttled: "节流中", unchanged: "无变化", "token-rejected": "旧 token 被拒（401），未写回", "auth-failed": "token 校验失败，未写回", "health-failed": "取 /health 失败，未写回", "no-candidate": "无可信候选地址", transport: "传输不可用", downgrade: "拒绝降级明文", "manual-set": "手动改地址" };
					return map[s.skipped] || map[s.result] || String(s.skipped || s.result || "");
				}
				function fmtBytes(n) { var v = Number(n) || 0; if (v < 1024) return v + "B"; if (v < 1048576) return (v / 1024).toFixed(1) + "KB"; return (v / 1048576).toFixed(1) + "MB"; }
				function onRetryListen() {
					setBusy(true); setErr(""); setMsg("");
					call("retry-listen", {}).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("监听已恢复"); refresh(); }
						else { setErr("监听仍未恢复（" + errText(res) + "）；若为“上一实例占用”，请重启 DSH 完成切换"); refresh(); }
					});
				}
				function onTrustCheck(id) {
					setBusy(true); setErr("");
					call("trust-check", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var v = res.value || {};
							var next = copyObject(trust); next[id] = v; setTrust(next);
							if (!v.changed) setMsg("证书未变化");
						} else setErr("证书检查失败（" + errText(res) + "）");
					});
				}
				function onTrustCert(id) {
					setBusy(true); setErr(""); setMsg("");
					call("trust-cert", { nodeId: id }).then(function (res) {
						setBusy(false);
						if (res && res.ok) {
							var v = res.value || {};
							setMsg(v.changed ? ("已信任新证书并连接（" + String(v.oldPrefix || "") + "… → " + String(v.newPrefix || "") + "…）") : "证书未变化");
							var next = copyObject(trust); next[id] = { changed: false, canTrust: false, tokenAccepted: false }; setTrust(next);
							refresh();
						} else {
							setErr("强制信任被拒（" + errText(res) + "）");
							refresh();
						}
					});
				}
				function startAddrEdit(node) { setAddrEdit({ id: node.id, host: node.host || "", port: String(node.port || DEFAULT_PORT), protocol: node.protocol || "https", source: node.addressSource === "observed" ? "observed" : "manual" }); setErr(""); }
				function onAddrSave(id) {
					if (!String(addrEdit.host || "").trim()) { setErr("请填写主机"); return; }
					setBusy(true); setErr(""); setMsg("");
					call("set-address", { nodeId: id, host: addrEdit.host, port: String(addrEdit.port || ""), protocol: addrEdit.protocol, addressSource: addrEdit.source }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg(addrEdit.source === "observed" ? "地址已保存；来源=自动（旧 token 有效时会被对端 /health/连接来源更新）" : "地址已保存为手动（自动更新不会再覆盖）"); setAddrEdit({ id: "", host: "", port: "", protocol: "https", source: "manual" }); refresh(); }
						else setErr("改地址失败（" + errText(res) + "）");
					});
				}
				function onAutoAddress(id) {
					setBusy(true); setErr(""); setMsg("");
					call("set-address", { nodeId: id, addressSource: "observed" }).then(function (res) {
						setBusy(false);
						if (res && res.ok) { setMsg("已交给自动：旧 token 仍被对端接受时按 /health 更新地址"); refresh(); }
						else setErr("切换失败（" + errText(res) + "）");
					});
				}
				function onLogs(id, since) {
					var nb = copyObject(logsBusy); nb[id] = true; setLogsBusy(nb); setErr("");
					call("logs", { nodeId: id, since: since || "" }).then(function (res) {
						var nb2 = copyObject(logsBusy); nb2[id] = false; setLogsBusy(nb2);
						if (res && res.ok) { var next = copyObject(logs); next[id] = res.value || {}; setLogs(next); }
						else setErr("拉取对端日志失败（" + errText(res) + "）");
					});
				}
				function statusOf(node) {
					var st = node.revoked ? "revoked" : node.status || "unpaired";
					if (st === "online") return { text: "在线", color: "var(--dsw-alias-state-success-primary, #2e7d32)" };
					if (st === "invalid") return { text: "授权无效", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					if (st === "pending") return { text: "未配对", color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" };
					if (st === "unreachable") return { text: "不可达", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					if (st === "address-unavailable") return { text: "地址不可用", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					if (st === "revoked") return { text: "已删除", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					if (st === "unpaired") return { text: "未配对", color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" };
					if (st === "needs-pin") return { text: "待钉住指纹", color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" };
					if (st === "fingerprint-mismatch") return { text: "指纹不符", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					if (st === "insecure") return { text: "被拒（明文）", color: "var(--dsw-alias-state-error-primary, #b3261e)" };
					return { text: "离线", color: "var(--dsw-alias-label-tertiary, #8a8a8a)" };
				}
				function field(labelText, key, placeholder, extra) {
					return h("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 150, flex: "1 1 150px" } },
						h("span", { style: { fontSize: 12, opacity: 0.7 } }, labelText),
						h("input", Object.assign({ "data-mesh-field": key, value: form[key], placeholder: placeholder, onChange: function (e) { onForm(key, e.target.value); }, style: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 } }, extra || {})),
					);
				}
				function addForm() {
					var d = derived();
					var ro = { padding: "6px 8px", border: "1px solid var(--dsw-alias-border-l2, #e2e2e2)", borderRadius: 6, fontSize: 12, background: "var(--dsw-alias-bg-layer-2, #f6f6f6)", color: "var(--dsw-alias-label-secondary, #555)", wordBreak: "break-all" };
					return h("form", { "data-mesh-form": "add", onSubmit: function (e) { e.preventDefault(); onAdd(); }, style: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 10, padding: "14px 16px", marginTop: 14, background: "var(--dsw-alias-bg-layer-1)" } },
						h("div", { style: { fontWeight: 600, marginBottom: 10 } }, "添加对端节点"),
						h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
							field("主机", "host", "如 peer.example.com 或对端 IP", { "data-mesh-required": "1" }),
							field("端口", "port", DEFAULT_PORT, { inputMode: "numeric" }),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 110 } },
								h("span", { style: { fontSize: 12, opacity: 0.7 } }, "协议"),
								h("select", { "data-mesh-field": "protocol", value: form.protocol, onChange: function (e) { onForm("protocol", e.target.value); }, style: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13 } },
									h("option", { value: "auto" }, "自动（先 https 后 http）"),
									h("option", { value: "https" }, "https"),
									h("option", { value: "http" }, "http（明文）"),
								),
							),
							field("名称", "label", "留空自动"),
						),
						/^(127\.|localhost$|\[::1\])/i.test(String(form.host || "").trim())
							? h("div", { "data-mesh-loopback-hint": "1", style: { marginTop: 8, fontSize: 12, color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" } }, "仅本机有效：回环地址只在本机可达，其他浏览器打不开；对端请填对方主机名或 IP。")
							: null,
						h("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", marginTop: 10, alignItems: "center" } },
							h("span", { style: { fontSize: 12, opacity: 0.7 } }, "控制地址"),
							h("div", { "data-mesh-derived": "controlBase", style: ro }, d ? d.controlBase : "填写主机后自动生成"),
							h("span", { style: { fontSize: 12, opacity: 0.7 } }, "界面地址"),
							h("div", { "data-mesh-derived": "viewUrl", style: ro }, d ? d.viewUrl : "填写主机后自动生成"),
						),
						h("button", { type: "button", "data-mesh-act": "toggle-advanced", onClick: function () { onForm("advanced", !form.advanced); }, style: { marginTop: 10, fontSize: 12 } }, form.advanced ? "收起高级" : "高级选项"),
						form.advanced
							? h("div", { "data-mesh-advanced": "1", style: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 } },
								field("对端标识", "peerId", "留空自动生成"),
								field("自定义控制地址", "controlBase", "留空用推导值"),
								field("自定义界面地址", "viewUrl", "留空用推导值"),
							)
							: null,
						h("div", { style: { display: "flex", gap: 8, marginTop: 12 } },
							h("button", { type: "submit", "data-mesh-act": "add-submit", disabled: busy }, busy ? "提交中…" : "添加"),
							h("button", { type: "button", "data-mesh-act": "add-cancel", onClick: function () { setShowAdd(false); setErr(""); } }, "取消"),
						),
					);
				}
				function card(node) {
					var id = node.id;
					var status = statusOf(node);
					var codeInfo = codes[id];
					var invalid = node.status === "invalid";
					return h("div", { "data-mesh-node": id, style: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 10, padding: "12px 14px", minWidth: 320, flex: "1 1 320px", background: "var(--dsw-alias-bg-layer-1)" } },
						h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
							h("input", { type: "checkbox", "data-mesh-select": id, checked: Boolean(sel[id]), onChange: function (e) { var n = copyObject(sel); n[id] = e.target.checked; setSel(n); } }),
							h("span", { style: { width: 9, height: 9, borderRadius: "50%", background: status.color, display: "inline-block" } }),
							renameId === id
								? h("input", { "data-mesh-rename-input": id, value: renameDraft, onChange: function (e) { setRenameDraft(e.target.value); }, style: { padding: "4px 6px", border: "1px solid #ccc", borderRadius: 6, fontSize: 13, width: 130 } })
								: h("b", null, node.label),
							renameId === id
								? h("button", { type: "button", "data-mesh-act": "rename-save:" + id, disabled: busy || !renameDraft.trim(), onClick: function () { onRename(id, renameDraft); } }, "保存")
								: h("button", { type: "button", "data-mesh-act": "rename:" + id, disabled: busy, onClick: function () { setRenameId(id); setRenameDraft(node.label); } }, "改名"),
							h("span", { "data-mesh-status": id, style: { marginLeft: "auto", fontSize: 12, color: status.color } }, status.text),
						),
						h("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 6, wordBreak: "break-all" } }, node.viewUrl || ("地址不可用" + (node.reportedAddress ? "（对端自报 " + node.reportedAddress + "，仅供参考）" : "")),
							node.privateAddress ? h("span", { "data-mesh-private": "1", style: { marginLeft: 8, fontSize: 11, color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" } }, "仅内网可达") : null,
						),
						h("div", { style: { fontSize: 11, opacity: 0.45, marginTop: 2, wordBreak: "break-all" } }, "控制 " + node.controlBase + " · 标识 " + node.peerId),
						invalid ? h("div", { "data-mesh-invalid": "1", style: { marginTop: 6, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #b3261e)" } }, "授权无效，需重新配对") : null,
						h("div", { "data-mesh-hint": id, style: { marginTop: 6, fontSize: 11, opacity: 0.7 } }, hintOf(node)),
						node.lastProbe
							? h("div", { "data-mesh-probe": id, "data-mesh-probe-state": node.lastProbe.reachable ? String(node.lastProbe.authorized || "unpaired") : "unreachable", style: { marginTop: 6, fontSize: 11, color: node.lastProbe.reachable && node.lastProbe.authorized === "authorized" ? "#2e7d32" : "#8a6d1f" } }, "最近测试：" + (node.lastProbe.reachable ? (node.lastProbe.authorized === "authorized" ? "已连接 · 授权有效" : node.lastProbe.authorized === "unauthorized" ? "已连接 · 未授权" : "可达 · 未配对") + " · " + String(node.lastProbe.latencyMs || 0) + "ms" : "不可达 · " + String(node.lastProbe.error || "")) + " · " + String(node.lastProbe.at || "").slice(11, 19) + "Z")
							: null,
						node.certFingerprint
							? h("div", { "data-mesh-pin": id, "data-mesh-pin-state": node.pinned ? "pinned" : "unpinned", style: { marginTop: 6, fontSize: 11, opacity: 0.7, wordBreak: "break-all" } }, "证书指纹 " + String(node.certFingerprintPrefix || "") + " …" + (node.pinned ? "（已钉住）" : "（未钉住，请重新生成配对码）"))
							: h("div", { "data-mesh-pin": id, "data-mesh-pin-state": "none", style: { marginTop: 6, fontSize: 11, opacity: 0.55 } }, String(node.protocol) === "https" ? "未记录证书指纹：点“生成配对码”时记录并与对端核对" : "明文 http：建议改用 https"),
						h("div", { "data-mesh-address-source": node.addressSource || "legacy", style: { marginTop: 6, fontSize: 11, opacity: 0.72, wordBreak: "break-all" } },
							(node.addressSource === "manual" ? "地址来源：手动（自动更新不会覆盖）" : node.addressSource === "observed" ? "地址来源：自动（对端 /health + 连接来源；旧 token 有效才写回）" : "地址来源：旧记录（按手动对待）")
								+ (node.addressUpdatedAt ? " · 更新于 " + String(node.addressUpdatedAt).slice(0, 19).replace("T", " ") : "")
								+ (node.lastAddressSync && (node.lastAddressSync.skipped || node.lastAddressSync.result) ? " · 最近同步：" + syncText(node.lastAddressSync) : ""),
						),
						addrEdit.id === id
							? h("div", { "data-mesh-addr-edit": id, style: { marginTop: 8, border: "1px dashed var(--dsw-alias-border-l2, #ccc)", borderRadius: 8, padding: "8px 10px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" } },
								h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } }, "主机", h("input", { "data-mesh-addr-field": "host", value: addrEdit.host, onChange: function (e) { var n = copyObject(addrEdit); n.host = e.target.value; setAddrEdit(n); }, style: { padding: "4px 6px", border: "1px solid #ccc", borderRadius: 6, width: 150 } })),
								h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } }, "端口", h("input", { "data-mesh-addr-field": "port", value: addrEdit.port, inputMode: "numeric", onChange: function (e) { var n = copyObject(addrEdit); n.port = e.target.value; setAddrEdit(n); }, style: { padding: "4px 6px", border: "1px solid #ccc", borderRadius: 6, width: 80 } })),
								h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } }, "协议", h("select", { "data-mesh-addr-field": "protocol", value: addrEdit.protocol, onChange: function (e) { var n = copyObject(addrEdit); n.protocol = e.target.value; setAddrEdit(n); }, style: { padding: "4px 6px", border: "1px solid #ccc", borderRadius: 6 } }, h("option", { value: "https" }, "https"), h("option", { value: "http" }, "http（明文）"))),
								h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } }, "来源", h("select", { "data-mesh-addr-field": "source", value: addrEdit.source, onChange: function (e) { var n = copyObject(addrEdit); n.source = e.target.value; setAddrEdit(n); }, style: { padding: "4px 6px", border: "1px solid #ccc", borderRadius: 6 } }, h("option", { value: "manual" }, "手动（不被覆盖）"), h("option", { value: "observed" }, "自动（可被更新）"))),
								h("button", { type: "button", "data-mesh-act": "addr-save:" + id, disabled: busy, onClick: function () { onAddrSave(id); } }, "保存地址"),
								h("button", { type: "button", "data-mesh-act": "addr-cancel:" + id, onClick: function () { setAddrEdit({ id: "", host: "", port: "", protocol: "https", source: "manual" }); } }, "取消"),
							)
							: null,
						trust[id] && (trust[id].changed || node.status === "fingerprint-mismatch")
							? h("div", { "data-mesh-trust": id, "data-mesh-trust-state": trust[id].changed ? (trust[id].tokenAccepted ? "can-trust" : "token-rejected") : "unchanged", "data-mesh-trust-old": String(trust[id].oldPrefix || ""), "data-mesh-trust-new": String(trust[id].newPrefix || ""), style: { marginTop: 8, border: "1px solid var(--dsw-alias-state-warn-primary, #f0e0a8)", background: "var(--dsw-alias-bg-layer-2, #fff8e1)", borderRadius: 8, padding: "8px 10px", fontSize: 11 } },
								h("div", { style: { fontWeight: 600 } }, trust[id].changed ? "对端证书已变化（旧 → 新）" : "证书未变化"),
								h("div", { "data-mesh-trust-fp": "1", style: { marginTop: 3, wordBreak: "break-all", fontFamily: "monospace" } }, "旧 " + String(trust[id].oldPrefix || "-") + "…　新 " + String(trust[id].newPrefix || "-") + "…"),
								h("div", { style: { marginTop: 3, opacity: 0.8 } }, trust[id].changed
									? (trust[id].tokenAccepted ? "旧 token 仍被对端接受（200）：可显式信任新证书。" : "对端不认旧 token（" + String(trust[id].check || "401") + "）：强制信任被禁止，必须重新配对。")
									: ""),
								h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
									h("button", { type: "button", "data-mesh-act": "trust-check:" + id, disabled: busy, onClick: function () { onTrustCheck(id); } }, "重新检查"),
									h("button", { type: "button", "data-mesh-act": "trust-cert:" + id, disabled: busy || !(trust[id].changed && trust[id].tokenAccepted), onClick: function () { onTrustCert(id); } }, "信任新证书并连接"),
								),
							)
							: null,
						logs[id]
							? h("div", { "data-mesh-logs": id, "data-mesh-logs-path": logs[id].path || "", "data-mesh-logs-size": String(logs[id].sizeBytes || 0), style: { marginTop: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 8, padding: "8px 10px", background: "var(--dsw-alias-bg-layer-2, #f6f6f6)", fontSize: 11 } },
								h("div", { style: { opacity: 0.78, wordBreak: "break-all" } }, "对端日志 " + String(logs[id].path || "?") + " · " + fmtBytes(logs[id].sizeBytes) + " · 返回 " + String(logs[id].returned || 0) + " 行 · 只读 / 已脱敏 / 无命令面"),
								h("div", { "data-mesh-logs-body": "1", style: { marginTop: 4, maxHeight: 200, overflow: "auto" } },
									(logs[id].lines || []).slice(-60).map(function (l, i) { return h("div", { key: String(l.at || "") + i, style: { fontFamily: "monospace", fontSize: 10, lineHeight: 1.5, wordBreak: "break-all" } }, String(l.at || "").slice(11, 19) + " " + String(l.level || "") + " " + String(l.message || "")); }),
									(logs[id].lines || []).length ? null : h("div", { style: { opacity: 0.6 } }, "（对端日志为空）"),
								),
								h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
									h("button", { type: "button", "data-mesh-act": "logs-refresh:" + id, disabled: busy || logsBusy[id], onClick: function () { onLogs(id, logs[id].nextSince || ""); } }, "只拉新行"),
									h("button", { type: "button", "data-mesh-act": "logs-close:" + id, onClick: function () { var n = copyObject(logs); delete n[id]; setLogs(n); } }, "关闭"),
								),
							)
							: null,
						h("div", { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" } },
							h("button", { type: "button", "data-mesh-act": "open:" + id, disabled: busy, onClick: function () { onOpen(id); } }, "打开"),
							h("button", { type: "button", "data-mesh-act": "probe:" + id, disabled: busy, onClick: function () { onProbe(id); } }, "测试连通"),
							h("button", { type: "button", "data-mesh-act": "addr:" + id, disabled: busy, onClick: function () { startAddrEdit(node); } }, "改地址"),
							node.addressSource === "manual" && node.peerId
								? h("button", { type: "button", "data-mesh-act": "auto-addr:" + id, disabled: busy, onClick: function () { onAutoAddress(id); } }, "交给自动")
								: null,
							h("button", { type: "button", "data-mesh-act": "logs:" + id, disabled: busy || logsBusy[id], onClick: function () { onLogs(id, ""); } }, logsBusy[id] ? "拉取中…" : "对端日志"),
							h("button", { type: "button", "data-mesh-act": "code:" + id, disabled: busy, onClick: function () { onCode(id); } }, "生成配对码"),
							h("button", { type: "button", "data-mesh-act": "request:" + id, disabled: busy, onClick: function () { onRequest(id); } }, "请求对方确认"),
							h("button", { type: "button", "data-mesh-act": "reconnect:" + id, disabled: busy, onClick: function () { onReconnect(id); } }, "重连"),
							h("button", { type: "button", "data-mesh-act": "delete:" + id, disabled: busy, style: { marginLeft: "auto", color: "var(--dsw-alias-state-error-primary, #b3261e)" }, onClick: function () { onDelete(id); } }, "删除"),
						),
						codeInfo ? h("div", { "data-mesh-code-box": id, style: { marginTop: 8, fontSize: 13 } },
							"配对码 ", h("code", { "data-mesh-code": id, style: { fontSize: 15, letterSpacing: 1 } }, codeInfo.code),
							h("span", { style: { marginLeft: 8, fontSize: 11, opacity: 0.6 } }, String(codeInfo.displayAddress || ((codeInfo.host || "?") + ":" + (codeInfo.port || "?"))) + " · " + String(codeInfo.protocol || "")),
							h("div", { "data-mesh-code-fp": id, style: { marginTop: 4, fontSize: 11, opacity: 0.75, wordBreak: "break-all" } }, "对端证书指纹 " + String(codeInfo.certFingerprintPrefix || "（无）") + " …（与对端“本机证书”前缀核对一致再提交）"),
						) : null,
						h("div", { style: { display: "flex", gap: 8, marginTop: 10 } },
							h("input", { "data-mesh-input": id, value: inputs[id] || "", placeholder: "输入配对码", onChange: function (e) { var next = copyObject(inputs); next[id] = e.target.value; setInputs(next); }, style: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, width: 160 } }),
							h("button", { type: "button", "data-mesh-act": "pair:" + id, disabled: busy || !String(inputs[id] || "").trim(), onClick: function () { onPair(id); } }, "提交配对"),
						),
					);
				}
				function pendingCard(p) {
					return h("div", { "data-mesh-pending": p.id, style: { border: "1px solid var(--dsw-alias-state-warn-primary, #f0e0a8)", background: "var(--dsw-alias-bg-layer-2, #fff8e1)", borderRadius: 10, padding: "10px 14px", marginBottom: 8 } },
						h("div", { style: { fontWeight: 600 } }, "配对请求（等待你确认）：" + String(p.label || "?")),
						h("div", { style: { fontSize: 11, opacity: 0.7, marginTop: 4, wordBreak: "break-all" } }, "证书指纹 " + String(p.certFingerprintPrefix || "（未提供）") + " …"),
						h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 2, wordBreak: "break-all" } }, "地址 " + (p.addressUnreliable ? "不可用（对端自报 " + String(p.reportedAddress || "-") + "，仅供参考）" : String(p.address || "-")) + " · 实例 " + String(p.fingerprint || "-")),
						h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, "确认前双方都显示未配对；拒绝则不会建立。同意前请核对上面的证书指纹前缀与对方本机证书一致。"),
						h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
							h("button", { type: "button", "data-mesh-act": "approve:" + p.id, disabled: busy, onClick: function () { onApprove(p.id); } }, "同意并建立"),
							h("button", { type: "button", "data-mesh-act": "reject:" + p.id, disabled: busy, onClick: function () { onReject(p.id); } }, "拒绝"),
						),
					);
				}

				var q = String(search || "").trim().toLowerCase();
				var visible = nodes.filter(function (n) {
					if (!q) return true;
					return (String(n.label || "") + " " + String(n.viewUrl || "") + " " + String(n.controlBase || "")).toLowerCase().indexOf(q) >= 0;
				});
				visible = visible.slice().sort(function (a, b) {
					if (sort === "status") {
						var order = { invalid: 0, unreachable: 0, offline: 1, pending: 2, unpaired: 3, online: 4 };
						return (order[a.status] || 9) - (order[b.status] || 9);
					}
					return String(a.label || "").localeCompare(String(b.label || ""));
				});
				var selCount = Object.keys(sel).filter(function (k) { return sel[k]; }).length;
				var settings = view && view.settings;
				var empty = view !== null && nodes.length === 0;
				return h("div", { "data-mesh-panel": "1", style: { padding: "18px 22px", height: "100%", overflow: "auto", boxSizing: "border-box", background: "transparent" } },
					h("div", { style: { display: "flex", alignItems: "baseline", gap: 12 } },
						h("div", { style: { fontSize: 20, fontWeight: 600 } }, "多端互联"),
						h("button", { type: "button", "data-mesh-act": "add", disabled: busy, onClick: function () { setShowAdd(!showAdd); setErr(""); }, style: { marginLeft: "auto" } }, showAdd ? "收起" : "添加节点"),
					),
					h("div", { style: { fontSize: 12, opacity: 0.65, margin: "4px 0 10px" } }, "双向配对 · 双方各显对方 · 打开为新标签页" + (selfInfo ? " · 本机 " + String(selfInfo.label || "") + "（" + String(selfInfo.instanceId || "") + "）" : "")),
					listener
						? h("div", { "data-mesh-listener": listener.ok ? "ok" : "error", "data-mesh-listener-code": listener.errorCode || "", style: { fontSize: 12, marginBottom: 6, color: listener.ok ? "#2e7d32" : "#b3261e" } },
							listener.ok
								? "本机监听 " + String(listener.protocol || "") + "://" + String(listener.bind) + ":" + String(listener.port) + " · 就绪" + (listener.certFingerprintPrefix ? " · 本机证书 " + String(listener.certFingerprintPrefix) + " …" : "") + (listener.hasLaunchToken ? "" : "（无 launch token，使用 .credentials.yaml 签名 cookie 反代）")
								: h("span", null,
									"本机监听 " + String(listener.protocol || "") + "://" + String(listener.bind) + ":" + String(listener.port) + " 失败：" + String(listener.error || "未知错误"),
									h("button", { type: "button", "data-mesh-act": "retry-listen", disabled: busy, onClick: onRetryListen, style: { marginLeft: 8 } }, "重试监听"),
								))
						: null,
					listener && listener.certFingerprint && String(listener.protocol) === "https"
						? h("div", { "data-mesh-cert": listener.certFingerprintPrefix, style: { fontSize: 11, opacity: 0.6, marginBottom: 8, wordBreak: "break-all" } }, "本机证书指纹 " + String(listener.certFingerprintPrefix) + " …（自签，对端配对时按此钉住）"
							+ (listener.certNotAfter ? " · 有效期至 " + String(listener.certNotAfter) : ""))
						: null,
					listener && String(listener.bind) === "0.0.0.0"
						? h("div", { "data-mesh-risk": "1", style: { fontSize: 12, color: "#8a6d1f", background: "#fff8e1", border: "1px solid #f0e0a8", borderRadius: 8, padding: "6px 10px", marginBottom: 8 } }, "风险提示：监听 0.0.0.0 表示对局域网/所有网卡开放；请确认防火墙边界，并用 https + 指纹钉住，不要改回明文。")
						: null,
					listener && String(listener.protocol) === "http"
						? h("div", { "data-mesh-insecure": "1", style: { fontSize: 12, color: "#b3261e", background: "#fdecea", border: "1px solid #f3c2bd", borderRadius: 8, padding: "6px 10px", marginBottom: 8 } }, "明文 http 已显式开启：配对码与 token 会以明文过网；默认应为 https（自签 + 指纹钉住）。")
						: null,
					view && view.limits
						? h("div", { "data-mesh-limits": "1", style: { fontSize: 11, opacity: 0.65, marginBottom: 10 } }, "配对限流：同 IP 每分钟最多 " + String(view.limits.ipLimit) + " 次 · 同一配对码错 " + String(view.limits.codeMaxFails) + " 次作废 · 本分钟最高 " + String((view.limits.ipAttempts && view.limits.ipAttempts[0] && view.limits.ipAttempts[0].attempts) || 0) + " 次 · 已作废码 " + String(view.limits.lockedCodes) + " 个")
						: null,
					pending.length ? h("div", { "data-mesh-pending-list": "1", style: { marginBottom: 12 } }, pending.map(pendingCard)) : null,
					h("div", { "data-mesh-settings": "1", style: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, background: "var(--dsw-alias-bg-layer-1)" } },
						h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "本机设置", settings && settings.pending ? h("span", { "data-mesh-settings-pending": "1", style: { marginLeft: 8, fontSize: 11, color: "var(--dsw-alias-state-warn-primary, #8a6d1f)" } }, "未生效（当前 " + String(settings.active.protocol) + "://" + String(settings.active.bind) + ":" + String(settings.active.port) + "，见下方状态文件）") : null),
						view && view.listener && !view.listener.canProxyGui
							? h("div", { "data-mesh-token-missing": "1", style: { fontSize: 11, color: "#8a6d1f", marginBottom: 8, wordBreak: "break-all" } }, "既无 launch token 也无 browser-session 密钥：打开对端将直连（中继不可用）。已查 token 路径：" + ((view.listener.launchTokenSearched || []).join("；") || "无候选路径"))
							: view && view.listener && !view.listener.hasLaunchToken
								? h("div", { "data-mesh-token-missing": "0", style: { fontSize: 11, opacity: 0.6, marginBottom: 8 } }, "无 launch token：反代使用 .credentials.yaml 的签名 cookie（自动，不落盘、不入日志）")
								: null,
						view && view.state
							? h("div", { "data-mesh-state-file": view.state.file || "", "data-mesh-state-writable": view.state.writable ? "1" : "0", style: { fontSize: 11, opacity: 0.7, marginBottom: 8, wordBreak: "break-all", color: view.state.writable ? "inherit" : "var(--dsw-alias-state-error-primary, #b3261e)" } },
								"状态文件 " + String(view.state.file || "（无路径）") + " · " + (view.state.writable ? "可写" : "不可写：" + String(view.state.writeError || "未知")) + (view.state.homeSource === "homedir-fallback" ? "（未设 DSH_HOME，已用家目录兜底）" : "") + (view.state.lastSaveError ? " · 上次保存失败：" + String(view.state.lastSaveError) : ""))
							: null,
						h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" } },
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } }, "监听端口", h("input", { "data-mesh-set": "port", value: cfg.port, inputMode: "numeric", onChange: function (e) { var n = copyObject(cfg); n.port = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { width: 90, padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } })),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } }, "bind", h("select", { "data-mesh-set": "bind", value: cfg.bind, onChange: function (e) { var n = copyObject(cfg); n.bind = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } }, h("option", { value: "0.0.0.0" }, "0.0.0.0（对外）"), h("option", { value: "127.0.0.1" }, "127.0.0.1（仅本机）"))),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } }, "默认协议", h("select", { "data-mesh-set": "protocol", value: cfg.protocol, onChange: function (e) { var n = copyObject(cfg); n.protocol = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } }, h("option", { value: "https" }, "https（自签，推荐）"), h("option", { value: "http" }, "http（明文，不推荐）"))),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } }, "并发上限", h("input", { "data-mesh-set": "maxConcurrency", value: cfg.maxConcurrency, inputMode: "numeric", onChange: function (e) { var n = copyObject(cfg); n.maxConcurrency = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { width: 80, padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } })),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } }, "GUI 端口（反代）", h("input", { "data-mesh-set": "guiPort", value: cfg.guiPort, inputMode: "numeric", placeholder: "0=自动", onChange: function (e) { var n = copyObject(cfg); n.guiPort = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { width: 80, padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } })),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 220px" } }, "本机对外地址（publicBase）", h("input", { "data-mesh-set": "publicBase", value: cfg.publicBase || "", placeholder: "https://mesh.example.com（留空=不配置）", onChange: function (e) { var n = copyObject(cfg); n.publicBase = e.target.value; dirtyRef.current = true; setCfg(n); }, style: { padding: "5px 6px", border: "1px solid #ccc", borderRadius: 6 } })),
							h("label", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 100%" } },
								h("span", null, "配对确认"),
								h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontWeight: 400 } },
									h("input", { type: "checkbox", "data-mesh-set": "autoApprove", checked: Boolean(cfg.autoApprove), onChange: function (e) { var n = copyObject(cfg); n.autoApprove = e.target.checked; dirtyRef.current = true; setCfg(n); } }),
									"配对码直接通过（跳过对方确认，默认关）",
								),
							),
							h("button", { type: "button", "data-mesh-act": "save-settings", disabled: busy, onClick: onSaveSettings }, "保存设置"),
						),
						String(cfg.bind) === "0.0.0.0"
							? h("div", { "data-mesh-bind-warn": "1", style: { marginTop: 8, fontSize: 12, color: "#8a6d1f" } }, "将监听所有网卡：确认只在可信网络暴露，并保持 https。")
							: null,
						String(cfg.protocol) === "http"
							? h("div", { "data-mesh-proto-warn": "1", style: { marginTop: 6, fontSize: 12, color: "#b3261e" } }, "将关闭 TLS：配对码与 token 明文传输，仅用于排障并尽快改回 https。")
							: null,
					),
					h("div", { "data-mesh-toolbar": "1", style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 } },
						h("input", { "data-mesh-search": "1", value: search, placeholder: "搜索名称或地址", onChange: function (e) { setSearch(e.target.value); }, style: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, width: 180 } }),
						h("select", { "data-mesh-sort": "1", value: sort, onChange: function (e) { setSort(e.target.value); }, style: { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6 } }, h("option", { value: "name" }, "按名称"), h("option", { value: "status" }, "按状态")),
						h("button", { type: "button", "data-mesh-act": "refresh", disabled: busy, onClick: function () { refresh(); } }, "刷新"),
						selCount ? h("button", { type: "button", "data-mesh-act": "delete-selected", disabled: busy, style: { color: "var(--dsw-alias-state-error-primary, #b3261e)" }, onClick: onBatchDelete }, "删除所选（" + selCount + "）") : null,
					),
					err ? h("div", { "data-mesh-error": "1", style: { background: "var(--dsw-alias-bg-layer-2, #fdecea)", color: "var(--dsw-alias-state-error-primary, #b3261e)", border: "1px solid var(--dsw-alias-state-error-primary, #f3c2bd)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 13 } }, err) : null,
					msg ? h("div", { "data-mesh-msg": "1", "data-mesh-open-state": openState || "", style: { background: "var(--dsw-alias-bg-layer-2, #e8f5e9)", color: "var(--dsw-alias-state-success-primary, #2e7d32)", border: "1px solid var(--dsw-alias-state-success-primary, #c8e6c9)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 13 } }, msg) : null,
					fallbackState
						? h("div", { "data-mesh-fallback": "1", "data-mesh-fallback-url": fallbackState.url || "", "data-mesh-fallback-reason": fallbackState.reason || "", style: { background: "var(--dsw-alias-bg-layer-2, #fff8e1)", border: "1px solid var(--dsw-alias-state-warn-primary, #f0e0a8)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 12 } },
							h("div", { style: { fontWeight: 600 } }, "目标地址"),
							h("div", { "data-mesh-fallback-link": "1", style: { marginTop: 3, wordBreak: "break-all", fontFamily: "monospace", fontSize: 11 } }, fallbackState.url || "（无可用地址）"),
							h("div", { style: { marginTop: 3, opacity: 0.8 } }, fallbackState.reason || ""),
							h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
								h("button", { type: "button", "data-mesh-act": "copy-url", disabled: !fallbackState.url, onClick: onCopyUrl }, "复制链接"),
								h("button", { type: "button", "data-mesh-act": "open-here", disabled: !fallbackState.url, onClick: onOpenHere }, "在当前页打开"),
								h("button", { type: "button", "data-mesh-act": "open-embed", disabled: !fallbackState.url, onClick: onOpenEmbed }, "在本页内嵌打开"),
							),
						)
						: null,
					view === null
						? h("div", { style: { opacity: 0.6, fontSize: 13 } }, "加载中…")
						: empty
							? h("div", { "data-mesh-empty": "1", style: { display: "flex", alignItems: "center", gap: 12, border: "1px dashed var(--dsw-alias-border-l2, #ccc)", borderRadius: 10, padding: "18px 20px", background: "var(--dsw-alias-bg-layer-1)" } },
								h("div", { style: { fontSize: 13, opacity: 0.8 } }, "尚未添加对端节点。"),
								h("button", { type: "button", "data-mesh-act": "add-empty", onClick: function () { setShowAdd(true); setErr(""); } }, "添加节点"),
							)
							: h("div", { "data-mesh-card-grid": "1", style: { display: "flex", gap: 12, flexWrap: "wrap" } }, visible.length ? visible.map(card) : h("div", { "data-mesh-nomatch": "1", style: { fontSize: 13, opacity: 0.7 } }, "没有匹配的节点")),
					showAdd ? addForm() : null,
					embedState
						? h("div", { "data-mesh-embed": "1", "data-mesh-embed-url": embedState.url || "", style: { marginTop: 12, border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 10, padding: 10, background: "var(--dsw-alias-bg-layer-1)" } },
							h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 12 } },
								h("span", null, "内嵌打开（外部窗口不可用）：" + String(embedState.url || "")),
								h("button", { type: "button", "data-mesh-act": "embed-close", onClick: function () { setEmbedState(null); }, style: { marginLeft: "auto" } }, "关闭内嵌"),
							),
							h("iframe", { "data-mesh-embed-frame": "1", src: embedState.url || "about:blank", title: "mesh-embed", style: { width: "100%", height: "72vh", border: "0", borderRadius: 8, background: "#fff" } }),
						)
						: null,
					h("details", { "data-mesh-diag": "1", style: { marginTop: 10, fontSize: 11, opacity: 0.8 } },
						h("summary", { style: { cursor: "pointer" } }, "诊断（中继/凭据）"),
						h("div", { style: { marginTop: 6, wordBreak: "break-all", fontFamily: "monospace", fontSize: 10, lineHeight: 1.5 } },
							"client=" + CLIENT_VERSION + " guiPort=" + String(listener && listener.guiPort || "?") + " canProxy=" + String(listener && listener.canProxyGui) + " hasToken=" + String(listener && listener.hasLaunchToken) + " hasSecret=" + String(listener && listener.hasBrowserSecret) + " relay=" + String(view && view.relay && view.relay.ok) + "/" + String(view && view.relay && view.relay.localPort ? ("local:" + view.relay.localPort) : (view && view.relay && view.relay.reason || "-")) + (view && view.relay && view.relay.stale ? "（旧实例路由，需停用/启用或重启）" : ""),
							h("div", { "data-mesh-diag-log": "1", style: { maxHeight: 160, overflowY: "auto", marginTop: 4, paddingRight: 4 } },
								(view && view.relay && view.relay.log ? view.relay.log.slice(-20).map(function (l) { return h("div", { key: l.at + l.message }, String(l.at).slice(11, 19) + " " + String(l.level) + " " + String(l.message)); }) : h("div", null, "（暂无中继日志）")),
							),
						),
					),
					h("div", { "data-mesh-version": "1", "data-mesh-server-version": String((view && view.version) || ""), "data-mesh-client-version": CLIENT_VERSION, style: { marginTop: 14, fontSize: 11, opacity: 0.55 } }, "服务端 v" + String((view && view.version) || "?") + " / 客户端 v" + CLIENT_VERSION + " · compat=" + String((compat && compat.state) || "-")),
				);
			}

			ctx.slots.inject("main", function () { return ctx.slots.register({ name: "main", key: PANEL_ID }, MeshPanel); });
			ctx.slots.inject("sidebar.panellist", function () { return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 25, label: function () { return "多端互联"; } }, MeshIcon); });
		}

		exports.inject = ["slots", "connection"];
		exports.apply = apply;
		return module.exports;
	},
});
