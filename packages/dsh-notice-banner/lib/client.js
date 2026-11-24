window.__ModuleLoader__.load({
	id: "@ericality/dsh-notice-banner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		// =====================================================================
		// DSH 通知横幅 (dsh-notice-banner)
		//
		// 渲染服务端注入的 notice/banner 会话事件 (由 dsh-notify / dsh-cost-guard
		// / dsh-taskqueue / dsh-balance append, 非 surface 事件 → 不进入模型历史):
		//   { kind, title, lines, stats, kv, metaText, advice, time, ... }
		// 家族色板 (同家族同色同款, v0.3.0 起):
		//   费用提醒(kind=cost)    → 琥珀 💰  dsh-cost-guard
		//   任务完成(kind=notify)  → 绿色 ✅  dsh-notify
		//   队列入队(kind=queue)   → 蓝色 📋  dsh-taskqueue
		//   余额费用(kind=balance) → 紫色 💳  dsh-balance (/balance /balance-detail /cost)
		//   错误提示(kind=error)   → 红色 ⚠️  各命令失败/无数据
		//   会话账本(kind=ledger)  → 青绿 🧾  dsh-cost-ledger (v0.6.0)
		//   多会话费用(kind=costs) → 天蓝 📊  dsh-sessions-cost (/sessions-cost, v0.6.2 起; v0.8.0 玫红→天蓝)
		//   适配状态(kind=compat)  → 琥珀 🧩 / 红 ⛔  @ericality/dsh-host-compat (v0.11.4, 阶段 1 · B1;
		//     两档 severity: degraded=复用 cost 琥珀 / blocked=复用 error 红; payload 见契约 §8)
		// balance 家族额外渲染 stats 统计格 + kv 键值行 (结构化运算结果)。
		//
		// v0.11.0 (期乙, 2026-09-06): 多 agent 树聚合 GUI —
		//   · ledger 卡展开态新增可折叠「委托树」区 (LedgerTree, 历史区上方, 仿 LedgerHistory 交互):
		//     经 /cost-ledger RPC history { sessionId, includeDescendants:true } 实时拉取 (零 token),
		//     行级明细 = 服务端 subtree.rows (label/短sid/¥/占子树%, 分支合计, 孙行二级 dim「计入父行」),
		//     客户端零计算; RPC 失败/无 subtree → 区块不渲染 (旧服务端兼容)
		//   · costs 卡树形分组渲染 (SessionTreeList): 父会话行展开 = 自身明细 + 缩进子树折叠块
		//     (子 agent 徽标 + 标题 + 短 sid + 金额, 子行可再展开自身明细, 递归孙行);
		//     数据 = /sessions-cost 服务端 sessions[] 附 treeGroup/windowTreeTotal; 无 → 平铺不变
		//   样式 = 家族变量体系 + 「子 agent」徽标青绿深浅两态 (--dsh-ct-*, 不新增家族色), 见预览 A2/costsTree
		//
		// v0.11.1 (⑭, 2026-09-06): ledger 折叠行 = 「含树合计」+ 差值 + 精简 (用户实测确认样式A) —
		//   · 折叠态去副题小字 (会话id/档位/命中率, 展开态恢复);
		//   · 主数字 = 第1格本会话合计 + 第4格「含子 agent」子树合计 (账本口径, 不双计), 有树套淡青绿
		//     胶囊底 (无文字标识, --dsh-lk-* 深浅两态), 无子会话 = 仅本会话合计 (无胶囊, 观感同旧);
		//   · 差值 = 第2格「本回合」较上次 (自身口径, 次级色弱化); 数据 = payload stats 已含, 服务端零改动,
		//     解析失败降级叶子形态。预览: public/banner-styles.html 区块 6d / 变更点⑭
		//
		// v0.6.0: ledger 会话账本家族 — 回合结束自动记账, 每回合一张新卡
		// (独立 context ledger-<seq>, 不替换), 默认折叠 (折叠行 = 合计+差值);
		// 展开时经 /cost-ledger RPC 实时拉取共享账本 (零 token), 任何旧卡片
		// 点开都与最新卡片一致; 历史区默认 3 条 + 展开全部。
		//
		// v0.4.0: kind=queue 横幅新增"队列"按钮 → 内嵌可编辑任务队列面板
		// (QueuePanel): 经 ctx.connection.rpc 调服务端 /queue RPC 通道 (dsh-taskqueue
		// v0.4.0, 零 token) 实时拉列表, 排队任务可 编辑(textarea)/保存/取消/立即派发,
		// 已派发/已取消只读 —— "派发前可编辑, 下发了一切方休"。
		//
		// v0.5.0: 面板改手风琴卡片式 —— 默认只露约 3 行 (92px), 点任务行展开该任务
		// 完整卡片 (完整内容+全部控件, 每次一条), 面板可整体放大滚动; 状态色
		// 排队中=蓝 / 已派发=绿 / 已取消=琥珀橙; 已派发/已取消弱化+划线只读。
		//
		// v0.5.2: 编辑锁 —— startEdit 经 RPC editstart 锁定任务 (防低谷自动派发把
		// 正在编辑的任务发出去), 保存(服务端释放)/取消编辑/组件卸载 editend 释放;
		// 锁定任务行显示"✎ 编辑中"标记; 服务端对同会话后续任务同样暂停派发。
		//
		// v0.6.1 (已回退): 曾尝试给横幅叠加主题底色 + 投影以适配浅色壁纸, 后因
		// 消息列加高斯模糊 liquid 图层 (dsh-bg-image v5.5) 从根上解决文字可读性,
		// 横幅恢复原版纯 liquid 渐变样式 (无底色层/无投影/边框原档)。
		//
		// v0.8.0 (液态玻璃 v2, 2026-08-27): 全家族配色按"液态玻璃 v2"方案定稿 —
		//   · costs 玫红 #ec4899 → 天蓝 #0ea5e9 (soft #38bdf8, 与 queue 蓝区分)
		//   · balance soft #c4b5fd→#8b5cf6, ledger soft #5eead4→#0d9488 (浅色主题对比度)
		//   · 边框家族色 50%→25% alpha (玻璃感), 圆角 10→12, 内边距 10px 14px→12px 16px
		//   · 玻璃拟态: backdrop-filter blur(12px) + 柔和投影 (hover 加深)
		//   · 浅色主题 (body:not([data-ds-dark-theme])): 横幅白色渐变 + data-family 家族顶部着色
		//   · 已取消状态标签改灰色系; 折叠关键值/面板金额/模式 strong 改家族色 (统计格 strong 仍主题蓝)
		//   · 按钮引入 primary(蓝)/success(绿)/danger(红) 变体
		//   · 实现: 内联样式保持深色液态渐变; 注入 INJECTED_CSS (style 元素) 承载
		//     主题翻转/CSS 变量/hover/浅色家族着色 (client bundle 磁盘直读, 强刷生效)
		// =====================================================================

		var PALETTE = {
			cost: {
				accent: "#f59e0b",
				accentSoft: "#f7ad31",
				bg: "linear-gradient(180deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))",
				border: "rgba(245,158,11,0.25)",
				badgeText: "#241a02",
				body: "var(--dsw-alias-label-primary, #e8d9b8)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			notify: {
				accent: "#22c55e",
				accentSoft: "#4ed17e",
				bg: "linear-gradient(180deg, rgba(34,197,94,0.14), rgba(34,197,94,0.05))",
				border: "rgba(34,197,94,0.25)",
				badgeText: "#0c1f14",
				body: "var(--dsw-alias-label-primary, #d9f0e2)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			queue: {
				accent: "#4176e6",
				accentSoft: "#5b8bf0",
				bg: "linear-gradient(180deg, rgba(65,118,230,0.16), rgba(65,118,230,0.05))",
				border: "rgba(65,118,230,0.25)",
				badgeText: "#0d1a33",
				body: "var(--dsw-alias-label-primary, #dbe6f7)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			balance: {
				accent: "#a78bfa",
				accentSoft: "#8b5cf6",
				bg: "linear-gradient(180deg, rgba(167,139,250,0.16), rgba(167,139,250,0.05))",
				border: "rgba(167,139,250,0.25)",
				badgeText: "#1b1033",
				body: "var(--dsw-alias-label-primary, #e9e0fb)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			error: {
				accent: "#ef4444",
				accentSoft: "#f87171",
				bg: "linear-gradient(180deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))",
				border: "rgba(239,68,68,0.25)",
				badgeText: "#2a0a0a",
				body: "var(--dsw-alias-label-primary, #f3d3d3)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			ledger: {
				accent: "#14b8a6",
				accentSoft: "#0d9488",
				bg: "linear-gradient(180deg, rgba(20,184,166,0.16), rgba(20,184,166,0.05))",
				border: "rgba(20,184,166,0.25)",
				badgeText: "#052e2b",
				body: "var(--dsw-alias-label-primary, #d6efe9)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			costs: {
				accent: "#0ea5e9",
				accentSoft: "#38bdf8",
				bg: "linear-gradient(180deg, rgba(14,165,233,0.16), rgba(14,165,233,0.05))",
				border: "rgba(14,165,233,0.25)",
				badgeText: "#082f49",
				body: "var(--dsw-alias-label-primary, #d9ecf7)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			// v0.8.1: 状态迷你行 (kind=status, cost-guard "费用计算中…" 气泡) — 仿 think/bash 灰色小字, 无卡片样式
			status: {
				accent: "#9aa3b2",
				accentSoft: "#aab3c0",
				bg: "transparent",
				border: "transparent",
				badgeText: "#ffffff",
				body: "var(--dsw-alias-label-tertiary, #9aa3b2)",
				meta: "var(--dsw-alias-label-tertiary, #9aa3b2)"
			},
			// v0.9.0: 优雅重启 (kind=restart, dsh-graceful-restart) — 靛蓝家族, 内嵌状态+确认/取消按钮面板 (经 /graceful-restart RPC, 零 token)
			restart: {
				accent: "#818cf8",
				accentSoft: "#6366f1",
				bg: "linear-gradient(180deg, rgba(129,140,248,0.16), rgba(129,140,248,0.05))",
				border: "rgba(129,140,248,0.25)",
				badgeText: "#14102e",
				body: "var(--dsw-alias-label-primary, #e4e2f7)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			// v0.11.4 (2026-09-13, 插件共享底座 阶段 1 · B1): 适配状态 (kind=compat, @ericality/dsh-host-compat)
			//   契约 §8 两档 severity 各一套家族色 —— **零新增色值**: degraded 直接复用 cost 家族琥珀
			//   (#f59e0b/#f7ad31), blocked 直接复用 error 家族红 (#ef4444/#f87171), 徽标文字同这两家。
			compatDegraded: {
				accent: "#f59e0b",
				accentSoft: "#f7ad31",
				bg: "linear-gradient(180deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))",
				border: "rgba(245,158,11,0.25)",
				badgeText: "#241a02",
				body: "var(--dsw-alias-label-primary, #e8d9b8)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			},
			compatBlocked: {
				accent: "#ef4444",
				accentSoft: "#f87171",
				bg: "linear-gradient(180deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))",
				border: "rgba(239,68,68,0.25)",
				badgeText: "#2a0a0a",
				body: "var(--dsw-alias-label-primary, #f3d3d3)",
				meta: "var(--dsw-alias-label-secondary, #9aa3b2)"
			}
		};

		/** 家族图标 (emoji, 与家族色板一一对应); compat 按 severity 细分 (degraded 🧩 / blocked ⛔, 用户 D5 裁定) */
		var ICONS = { cost: "💰", notify: "✅", queue: "📋", balance: "💳", error: "⚠️", ledger: "🧾", costs: "📊", restart: "🔄", compat: "🧩" };

		/** 家族徽章文字; balance 按 mode 细分 (overview=余额 / detail=余额明细 / session=会话费用 / stats=参数统计 / test=计算验证); status=状态 (迷你行不显示徽章); restart=优雅重启; compat=适配状态 (两档同徽标, 用户 D5 裁定) */
		var BADGES = { cost: "费用提醒", notify: "任务完成", queue: "任务队列", balance: "余额", error: "错误", ledger: "会话账本", costs: "多会话费用", status: "状态", restart: "优雅重启", compat: "适配状态" };

		/**
		 * v0.8.0 液态玻璃 v2: 注入的样式 (style 元素, 幂等)。
		 * 主题判定: 深色 = body[data-ds-dark-theme] 存在; 浅色 = body:not([data-ds-dark-theme])。
		 * 浅色横幅背景用 !important 压过内联家族渐变 (与预览方案一致); 小组件用 CSS 变量翻转
		 * (--dsh-*, 定义在 :root + body:not([data-ds-dark-theme]) 上, 内联样式 var() 引用自动随主题切换)。
		 */
		var INJECTED_CSS = [
			":root{",
			"--dsh-glass-bd:rgba(255,255,255,.08);",
			"--dsh-btn-bg:rgba(255,255,255,.06);--dsh-btn-hover:rgba(255,255,255,.12);",
			"--dsh-code-bg:rgba(0,0,0,.35);",
			"--dsh-stat-bg:rgba(0,0,0,.15);--dsh-mode-bg:rgba(0,0,0,.12);",
			"--dsh-qcard-bg:rgba(0,0,0,.18);--dsh-sc-bg:rgba(0,0,0,.18);",
			"--dsh-rp-bg:rgba(0,0,0,.18);",
			"--dsh-st-pending-tx:#5b8bf0;--dsh-st-pending-bd:rgba(65,118,230,.25);",
			"--dsh-st-dispatch-tx:#4ed17e;--dsh-st-dispatch-bd:rgba(34,197,94,.25);",
			"--dsh-st-qs-tx:#f7ad31;--dsh-st-qs-bd:rgba(245,158,11,.25);",
			"--dsh-st-cancel-tx:#9ca3af;--dsh-st-cancel-bg:rgba(156,163,175,.10);--dsh-st-cancel-bd:rgba(156,163,175,.20);",
			/* v0.11.5: 终态「已完成」(中性灰, 与已取消同族只差亮度) / 系统熔断「失败」(红) / 未适配 (灰虚线) */
			"--dsh-st-done-tx:#8b93a3;--dsh-st-done-bg:rgba(139,147,163,.10);--dsh-st-done-bd:rgba(139,147,163,.22);",
			"--dsh-st-fail-tx:#f87171;--dsh-st-fail-bg:rgba(239,68,68,.10);--dsh-st-fail-bd:rgba(239,68,68,.28);",
			"--dsh-st-unknown-tx:#9aa3b2;--dsh-st-unknown-bg:rgba(154,163,178,.06);--dsh-st-unknown-bd:rgba(154,163,178,.35);",
			"--dsh-st-warn-tx:#fbbf24;",
			/* v0.11.6: 「重启丢弃」(意外重启导致未执行) —— 红系但比熔断失败柔和, 与灰「已取消」明显不同 */
			"--dsh-st-restartdrop-tx:#fb923c;--dsh-st-restartdrop-bg:rgba(251,146,60,.10);--dsh-st-restartdrop-bd:rgba(251,146,60,.30);",
			"--dsh-st-edit-tx:#f7ad31;--dsh-st-edit-bd:rgba(245,158,11,.25);",
			"--dsh-btn-primary-bg:rgba(65,118,230,.15);--dsh-btn-primary-bd:rgba(65,118,230,.4);--dsh-btn-primary-tx:#5b8bf0;",
			"--dsh-btn-success-bg:rgba(34,197,94,.15);--dsh-btn-success-bd:rgba(34,197,94,.4);--dsh-btn-success-tx:#4ed17e;",
			"--dsh-btn-danger-bg:rgba(239,68,68,.15);--dsh-btn-danger-bd:rgba(239,68,68,.4);--dsh-btn-danger-tx:#f87171;",
			/* v0.11.0 (期乙): 「子 agent」徽标 / 树形线 — 青绿系深浅两态 (不新增家族色, 预览 §8b) */
			"--dsh-ct-ag-bg:rgba(20,184,166,.14);--dsh-ct-ag-bd:rgba(20,184,166,.42);--dsh-ct-ag-tx:#5eead4;",
			"--dsh-ct-line:rgba(20,184,166,.45);",
			/* v0.11.1 (⑭): ledger 折叠行「含树合计」胶囊底 (深色 = 家族 accent 字, 无文字标识) */
			"--dsh-lk-bg:rgba(20,184,166,.14);--dsh-lk-bd:rgba(20,184,166,.35);--dsh-lk-tx:#14b8a6;",
			"}",
			"body:not([data-ds-dark-theme]){",
			"--dsh-glass-bd:rgba(255,255,255,.35);",
			"--dsh-btn-bg:rgba(255,255,255,.35);--dsh-btn-hover:rgba(255,255,255,.55);",
			"--dsh-code-bg:rgba(0,0,0,.06);",
			"--dsh-stat-bg:rgba(255,255,255,.3);--dsh-mode-bg:rgba(255,255,255,.25);",
			"--dsh-qcard-bg:linear-gradient(180deg,rgba(255,255,255,.95) 0%,rgba(255,255,255,.08) 100%);",
			"--dsh-sc-bg:linear-gradient(180deg,rgba(255,255,255,.95) 0%,rgba(255,255,255,.08) 100%);",
			"--dsh-rp-bg:linear-gradient(180deg,rgba(255,255,255,.95) 0%,rgba(255,255,255,.08) 100%);",
			"--dsh-st-pending-tx:#2563eb;--dsh-st-pending-bd:rgba(65,118,230,.35);",
			"--dsh-st-dispatch-tx:#16a34a;--dsh-st-dispatch-bd:rgba(34,197,94,.35);",
			"--dsh-st-qs-tx:#b45309;--dsh-st-qs-bd:rgba(245,158,11,.35);",
			"--dsh-st-cancel-tx:#6b7280;--dsh-st-cancel-bg:rgba(107,114,128,.10);--dsh-st-cancel-bd:rgba(107,114,128,.30);",
			/* v0.11.5 浅色主题: 已完成 (灰) / 失败 (红) / 未适配 (灰虚线) */
			"--dsh-st-done-tx:#5b6472;--dsh-st-done-bg:rgba(107,114,128,.10);--dsh-st-done-bd:rgba(107,114,128,.28);",
			"--dsh-st-fail-tx:#dc2626;--dsh-st-fail-bg:rgba(220,38,38,.08);--dsh-st-fail-bd:rgba(220,38,38,.32);",
			"--dsh-st-unknown-tx:#6b7280;--dsh-st-unknown-bg:rgba(107,114,128,.06);--dsh-st-unknown-bd:rgba(107,114,128,.45);",
			"--dsh-st-warn-tx:#b45309;",
			"--dsh-st-restartdrop-tx:#c2410c;--dsh-st-restartdrop-bg:rgba(194,65,12,.08);--dsh-st-restartdrop-bd:rgba(194,65,12,.30);",
			"--dsh-st-edit-tx:#b45309;--dsh-st-edit-bd:rgba(245,158,11,.35);",
			"--dsh-btn-primary-bg:rgba(65,118,230,.20);--dsh-btn-primary-bd:rgba(65,118,230,.5);",
			"--dsh-btn-success-bg:rgba(34,197,94,.20);--dsh-btn-success-bd:rgba(34,197,94,.5);",
			"--dsh-btn-danger-bg:rgba(239,68,68,.20);--dsh-btn-danger-bd:rgba(239,68,68,.5);",
			/* v0.11.0 (期乙): 浅色主题徽标/树形线 (青绿加深) */
			"--dsh-ct-ag-bg:rgba(20,184,166,.10);--dsh-ct-ag-bd:rgba(13,148,136,.50);--dsh-ct-ag-tx:#0f766e;",
			"--dsh-ct-line:rgba(13,148,136,.60);",
			/* v0.11.1 (⑭): 浅色主题胶囊 (青绿加深, 深字) */
			"--dsh-lk-bg:rgba(13,148,136,.12);--dsh-lk-bd:rgba(13,148,136,.45);--dsh-lk-tx:#0d9488;",
			"}",
			/* 玻璃基座 + hover */
			".dsh-banner{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 2px 12px rgba(0,0,0,.08);transition:box-shadow .3s ease,border-color .3s ease}",
			".dsh-banner:hover{box-shadow:0 4px 20px rgba(0,0,0,.12);border-color:rgba(255,255,255,.15)}",
			/* 浅色主题: 白色渐变 + 家族顶部着色 (压内联深色渐变) */
			"body:not([data-ds-dark-theme]) .dsh-banner{background:linear-gradient(180deg,rgba(255,255,255,.95) 0%,rgba(255,255,255,.05) 100%) !important;box-shadow:0 8px 32px rgba(0,0,0,.12);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}",
			"body:not([data-ds-dark-theme]) .dsh-banner:hover{box-shadow:0 12px 40px rgba(0,0,0,.14)}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"cost\"]{background:linear-gradient(180deg,rgba(245,158,11,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"notify\"]{background:linear-gradient(180deg,rgba(34,197,94,.16) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"queue\"]{background:linear-gradient(180deg,rgba(65,118,230,.16) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"balance\"]{background:linear-gradient(180deg,rgba(167,139,250,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"error\"]{background:linear-gradient(180deg,rgba(239,68,68,.16) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"ledger\"]{background:linear-gradient(180deg,rgba(20,184,166,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"costs\"]{background:linear-gradient(180deg,rgba(14,165,233,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			// v0.9.6: 优雅重启家族补浅色主题顶部着色 (此前遗漏 → 浅色下与其他家族不一致)
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"restart\"]{background:linear-gradient(180deg,rgba(129,140,248,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			// v0.11.4 (2026-09-13, 阶段 1 · B1): 适配状态家族 (kind=compat) 浅色主题顶部着色 ——
			//   两档 severity 同 data-family="compat", 用已有 data-severity 区分; 色值 = 复用 cost(琥珀)/error(红) 家族同值
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"compat\"][data-severity=\"degraded\"]{background:linear-gradient(180deg,rgba(245,158,11,.18) 0%,rgba(255,255,255,.05) 100%) !important}",
			"body:not([data-ds-dark-theme]) .dsh-banner[data-family=\"compat\"][data-severity=\"blocked\"]{background:linear-gradient(180deg,rgba(239,68,68,.16) 0%,rgba(255,255,255,.05) 100%) !important}",
			/* 小组件 hover */
			".dsh-arr:hover,.dsh-qbtn:hover,.dsh-lbtn:hover{background:rgba(255,255,255,.12)}",
			".dsh-hbtn:hover,.dsh-sbtn:hover{transform:scale(1.02)}",
			".dsh-qrow:hover{background:rgba(255,255,255,.04)}",
			".dsh-sch:hover{background:rgba(255,255,255,.03)}",
			/* ★批4 `T29` 设置项卡体：一行开关（样式对齐预览页；仅外观，无位置轴语义） */
			".dsh-nb-fk-row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}",
			".dsh-nb-fk-tx{display:flex;flex-direction:column;gap:2px;font-size:13px;line-height:1.6}",
			".dsh-nb-fk-hint{color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:12px}",
			".dsh-nb-fk-sw{position:relative;flex:none;width:42px;height:22px;border-radius:999px;border:0;padding:0;background:rgba(255,255,255,.18);cursor:pointer;transition:background .15s}",
			".dsh-nb-fk-sw[data-on=\"true\"]{background:#22c55e}",
			".dsh-nb-fk-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}",
			".dsh-nb-fk-sw[data-on=\"true\"] .dsh-nb-fk-knob{left:22px}",
			/* v0.11.0 (期乙): 委托树/树分组小组件 — 「子 agent」徽标 + 树行文字基线 (细节内联样式) */
			".dsh-ct-ag{display:inline-flex;align-items:center;gap:2px;flex:none;font-size:10.5px;font-weight:700;line-height:16px;padding:0 7px;border-radius:8px;background:var(--dsh-ct-ag-bg);border:1px solid var(--dsh-ct-ag-bd);color:var(--dsh-ct-ag-tx);letter-spacing:.3px;white-space:nowrap}",
			".dsh-ct-g{flex:none;color:var(--dsh-ct-line);font-family:ui-monospace,\"SF Mono\",Consolas,monospace;font-size:11.5px;white-space:pre}",
			".dsh-ct-row{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-primary,#eceff4);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:0}",
			".dsh-ct-row .dsh-ct-lb{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
			".dsh-ct-row .dsh-ct-sid{flex:none;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:10.5px;font-family:ui-monospace,\"SF Mono\",Consolas,monospace;font-weight:400}",
			".dsh-ct-row .dsh-ct-tag{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa3b2);font-weight:400}",
			".dsh-ct-toggle:hover{background:var(--dsh-btn-hover)}",
			/* v0.8.1: 状态迷你行 — running 扫光动画 (仿工具行 sweep) + 图标旋转 */
			".dsh-status{overflow:hidden;position:relative;border-radius:6px}",
			".dsh-status[data-state=\"running\"]:after{content:\"\";position:absolute;inset-block:0;left:0;width:300px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent) 50%,transparent 100%);pointer-events:none;animation:2.6s ease-out infinite dsh-status-sweep}",
			"@keyframes dsh-status-sweep{0%{left:-300px}90%,to{left:100%}}",
			"@keyframes dsh-status-spin{to{transform:rotate(360deg)}}",
			/* v0.11.3 (2026-09-12) 折叠回合内保留关键家族横幅 —
			   背景: dsh 0.1.2-rc.1「对话 Compact 模式」在回合结束(turn/end)后自动折叠"过程组", 判定写死在核心
			   (@deepseek-ai/dsh-client-ui-chat: 节点 kind 不在 TURN_PROCESS_INDEPENDENT_KINDS[system-prompt/user/
			   steering/turn-process/turn-error/turn-max-tokens/turn-tail] 且 anchorSeq 落在本回合过程区间 ⇒ 折叠隐藏)。
			   本插件节点 kind="notice-banner" 落在该区间 ⇒ 包裹层被加 hidden="until-found" ⇒ 回合中发出的
			   📋 任务队列 / 🔄 优雅重启 / ⚠️ 错误 横幅随折叠一起消失 (用户实测, 2026-09-12)。
			   方案: **纯 CSS 把这三类家族"提出来"** — 覆盖 UA [hidden]{display:none} 的 display/content-visibility,
			   仅对 hidden 的 notice-banner 包裹层生效; 其余家族(ledger/cost/costs/balance/notify/status)与所有步骤行
			   **一律不动**(不加任何隐藏规则 ⇒ 维持现状, 零误伤; 它们本身多在回合收尾后发射, 不受折叠影响)。
			   间距: 保留的横幅包裹层仍带 hidden 属性 ⇒ 核心 .column>:not([hidden])~:not([hidden]) 规则不生效,
			   故自带 margin-top(非首个子元素时), 与 16px 列间距一致。
			   风险: 依赖核心 DOM 属性名 data-chat-flow-kind / data-turn-process-hidden 与卡片 data-family;
			   核心升级改名 ⇒ 选择器失配静默回退为"被折叠"(不报错不崩溃)。踩坑复盘见 docs/任务记录/2026-09-12-折叠回合横幅可见.md */
			/* ★批4 `T29`（2026-09-26 用户裁 `#A297`/`#A299`）：v0.11.3 的两条「折叠回合保留关键家族横幅」CSS
			   **已从本常量移出** ⇒ 改为**受开关门控、按开关条件注入**（见下方 `FOLDKEEP_CSS` / `syncFoldKeepCss()`）。
			   默认【关】⇒ **不注入** ⇒ 折叠时三类卡继承官方 `hidden="until-found"` ⇒ **不显示**（＝本批期望）；
			   开关【开】⇒ 注入 ⇒ 与 v0.11.3 行为**逐字一致**（旧行为回归）。 */
		].join("");

		/** 甲-0 受控面：**只在开关【开】时**注入的两条 CSS（白名单 `queue/restart/error`，不多放不漏放）。
		 *  ⚠️ 如实登记（不销项）：本路径仍**依赖官方 `hidden` / `content-visibility` 行为**（核心改名/改行为
		 *  ⇒ 选择器失配或重新可见 ＝ **静默回退**）—— 承自 2026-09-12 已知项，**本批未治**。 */
		var FOLDKEEP_STYLE_ID = "dsh-notice-banner-foldkeep";
		/** ★ 批4 `#37`（范围「乙」）：**「三家族」kind 白名单 —— 单一来源**（`ENV §一.6②` 禁静默 / 禁两处各写一份）。
		 *   · 消费方 ①：下方 `FOLDKEEP_CSS`（甲-0 折叠保留，`#A299`）—— 选择器**由本常量拼出**（结果串逐字等价）。
		 *   · 消费方 ②：`storeReportRender` 段的 `kindPanel`／`kindFolded`／`kindUnshown` 分桶（**只观测**）。
		 *   · ⇒ **撤/加本集合的任一项都会同时改变两个消费方** ⇒ 这正是判据 A1／A2「撤白名单新项 ⇒ 必红」的可达路径。 */
		var NOTICE_FAMILY_KINDS = ["queue", "restart", "error"];
		/** 由白名单拼出的 `data-family` 选择器串（**逐字结果** ＝ 改前硬编码串 `[data-family="queue"],[data-family="restart"],[data-family="error"]`；见判据 A7-F 对撞）。 */
		var NOTICE_FAMILY_SELECTOR = NOTICE_FAMILY_KINDS.map(function (k) { return "[data-family=\"" + k + "\"]"; }).join(",");
		var FOLDKEEP_CSS = [
			"[data-chat-flow-kind=\"notice-banner\"][data-turn-process-hidden]:has(" + NOTICE_FAMILY_SELECTOR + "){display:block !important;content-visibility:visible !important}",
			"[data-chat-flow-kind=\"notice-banner\"][data-turn-process-hidden]:not(:first-child):has(" + NOTICE_FAMILY_SELECTOR + "){margin-top:var(--dsh-chat-flow-gap,16px)}"
		].join("");

		/* ★批4 `T29` 开关（`#A299` 用户裁，文案逐字照小预览）：折叠回合仍显示队列 / 重启 / 错误卡。
		 *   · 持久化：`localStorage["dsh-notice-foldkeep"]`；`"1"` = 开；**缺键 / 非 `"1"` ⇒ 默认关**。
		 *   · **缺键与显式 `"0"` 行为等价**（都关），**原始值可区分**（`getItem()` ⇒ `null` vs `"0"`，
		 *     判据分别断言 ⇒ 防静默失效）。
		 *   · 门控面**只有** `FOLDKEEP_CSS` 的注入与否（甲-0）：不新增宿主接触点、不写宿主 DOM 属性、
		 *     不动位置轴/锚面（折叠时节点仍挂载、`anchorMounted`/`pendingNoNode` 记账一字不变）。 */
		var FOLDKEEP_KEY = "dsh-notice-foldkeep";
		/** 原始值（判据用：区分"缺键 `null`"与"显式 `"0"`"） */
		function foldKeepRaw() {
			try { return window.localStorage ? window.localStorage.getItem(FOLDKEEP_KEY) : null; } catch (e) { return null; }
		}
		/** 官方 Config 布尔字段（订阅宿主配置快照；表单不可用 ⇒ 回落本地值）。 */
		function useConfigBool(form, key, fallback) {
			var st = React.useState(function () { try { var sn = form ? form.getSnapshot() : null; return sn && sn.value && typeof sn.value[key] === "boolean" ? sn.value[key] : fallback; } catch (e) { return fallback; } });
			React.useEffect(function () {
				if (!form || typeof form.subscribe !== "function") return undefined;
				return form.subscribe(function () { try { var sn = form.getSnapshot(); if (sn && sn.value && typeof sn.value[key] === "boolean") st[1](sn.value[key]); } catch (e) { /* 忽略 */ } });
			}, []);
			return st[0];
		}

		/** 开关是否【开】（缺键 / 非 `"1"` ⇒ 关） */
		function foldKeepOn() { return foldKeepRaw() === "1"; }
		/** 写开关（`"1"` / `"0"`）＋ 立即同步 CSS 注入（无需刷新页面） */
		function setFoldKeep(on) {
			try { if (window.localStorage) window.localStorage.setItem(FOLDKEEP_KEY, on === true ? "1" : "0"); } catch (e) { /* 存储不可用 ⇒ 保持默认(关) */ }
			syncFoldKeepCss();
			return foldKeepOn();
		}
		/** 甲-0：按开关增/删 `<style id="dsh-notice-banner-foldkeep">`（幂等；失败不抛、不影响功能） */
		function syncFoldKeepCss() {
			try {
				var old = document.getElementById(FOLDKEEP_STYLE_ID);
				if (!foldKeepOn()) {
					if (old && old.parentNode) old.parentNode.removeChild(old);
					return false;
				}
				if (old) return true;
				var st = document.createElement("style");
				st.id = FOLDKEEP_STYLE_ID;
				st.textContent = FOLDKEEP_CSS;
				(document.head || document.documentElement).appendChild(st);
				return true;
			} catch (e) { return false; }
		}

		/** v0.8.0: 注入玻璃样式 (幂等, style 元素) */
		function injectGlassCss() {
			try {
				if (document.getElementById("dsh-notice-banner-glass")) return;
				var st = document.createElement("style");
				st.id = "dsh-notice-banner-glass";
				st.textContent = INJECTED_CSS;
				(document.head || document.documentElement).appendChild(st);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		function fmtElapsed(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return "";
			var s = Math.round(ms / 1000);
			return s < 60 ? s + " 秒" : Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
		}

		function metaOf(banner) {
			if (banner.kind === "cost") {
				var tier = banner.tier === "peak" ? "高峰价" : banner.tier === "offpeak" ? "低谷价" : "";
				var parts = [];
				if (tier) parts.push(tier);
				if (banner.sessionShort) parts.push("会话 " + banner.sessionShort);
				return {
					text: parts.join(" · "),
					// 生产者可给动态建议 (按结论: 切换/继续/差异不大); 缺省回退原固定文案 (兼容旧横幅)
					advice: typeof banner.advice === "string" ? banner.advice : "建议完成当前任务后新建会话继续, 可显著降低上下文缓存费用"
				};
			}
			// balance / error 家族: host 直接给 metaText / advice 纯文本
			if (typeof banner.metaText === "string") {
				return { text: banner.metaText, advice: typeof banner.advice === "string" ? banner.advice : "" };
			}
			var parts = [];
			if (typeof banner.turn === "number") parts.push("回合 #" + banner.turn);
			var elapsed = fmtElapsed(banner.elapsedMs);
			if (elapsed) parts.push("用时 " + elapsed);
			if (typeof banner.reason === "string" && banner.reason) parts.push("原因: " + banner.reason);
			if (banner.sessionShort) parts.push("会话 " + banner.sessionShort);
			return { text: parts.join(" · "), advice: "" };
		}

		/** 插件 ctx (apply 时记录), 组件内惰性取 connection 服务 (浏览器端通用 RPC) */
		var pluginCtx = null;
		/** 冒烟专用: /queue RPC 覆盖 (仅 __DSH_SMOKE__ 下由 __test 注入; 生产恒为 null) */
		var __smokeQueueRpc = null;

		/** ★`#A70`：**通道面双路**（本文件内的队列/重启面板此前直连旧通道 `/queue`、`/graceful-restart`，
		 *  而 0.2.2 起这两条已迁官方 Fetch 面（`/api/<ch>/<ep>`）⇒ 旧路 **HTTP 405**
		 *  （用户现场：`transport failure for /queue/list: HTTP 405`）。
		 *  这里按通道缓存"哪一面可用"（与各插件 `faceRpc` 的 `_faceMode` 同法）：先 `/api`，失败回落旧面并记住。 */
		var _chFace = {};
		function channelRpc(chName, endpoint, payload) {
			var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
			var rpc = conn && conn.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
			}
			var callApi = function () { return rpc.call("/api", chName + "/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call("/" + chName, endpoint, payload || {}); };
			var mode = _chFace[chName];
			var p = mode === "api" ? callApi()
				: mode === "legacy" ? callLegacy()
				: callApi().then(function (r) { _chFace[chName] = "api"; return r; },
					function () { _chFace[chName] = "legacy"; return callLegacy(); });
			return Promise.resolve(p).then(function (result) {
				return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
			}).catch(function (err) {
				return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
			});
		}

		/** 调用服务端 queue 通道（`/api/queue/<ep>`，旧 `/queue` 仅回落），失败归一为 { ok:false, error } */
		function queueRpc(endpoint, payload) {
			if (__smokeQueueRpc) return __smokeQueueRpc(endpoint, payload);
			return channelRpc("queue", endpoint, payload);
		}

		/** 调用服务端 /graceful-restart RPC 通道 (dsh-graceful-restart v0.1.0), 失败归一为 { ok:false, error } */
		function restartRpc(endpoint, payload) {
			var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
			var rpc = conn && conn.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
			}
			return channelRpc("graceful-restart", endpoint, payload || {}).then(function (result) {
				return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
			}).catch(function (err) {
				return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
			});
		}

		/** v0.11.4 (2026-09-13, 阶段 1 · B1): 调用 /host-compat RPC 通道 (dsh-host-compat 契约 §6),
		 *  失败归一为 { ok:false, error }（永不 throw）—— 用作适配状态横幅 (kind=compat) 的
		 *  「本版本不再提示」按钮: ① status 取当前 hostVersion + capabilitySignature（RD-14 追加字段,
		 *  缺失 ⇒ 空串, 服务端用当前签名兜底）② dismiss 写回 §5 的 dismiss 记录。 */
		/* ★`#A55` 步2：0.2.2 起旧通道 `POST /host-compat/<ep>` 无路由（`connection.rpc.handle` 必失败），
		 * 官方面 = `/api/host-compat/<ep>`（宿主 `connection.fetch.register` 精确 Fetch 路由；复用 /api cookie 门禁）。
		 * 策略：先试新面、失败回落旧面并缓存；失败**可见**（禁静默）——诊断锚：
		 *   `window.__DSH_HOSTCOMPAT_RPC_MODE__` / `__DSH_HOSTCOMPAT_RPC_FAILS__` / `__DSH_HOSTCOMPAT_RPC_LAST__`。 */
		var COMPAT_RPC_MODE = null;
		function compatRpcMode(mode, note) {
			COMPAT_RPC_MODE = mode;
			try {
				window.__DSH_HOSTCOMPAT_RPC_MODE__ = mode;
				if (note) window.__DSH_HOSTCOMPAT_RPC_LAST__ = String(note);
			} catch (e) { /* 非浏览器环境忽略 */ }
		}
		function compatRpcFailure(err) {
			try {
				window.__DSH_HOSTCOMPAT_RPC_FAILS__ = (window.__DSH_HOSTCOMPAT_RPC_FAILS__ || 0) + 1;
				window.__DSH_HOSTCOMPAT_RPC_LAST__ = String((err && err.message) || err);
			} catch (e) { /* 忽略 */ }
		}

		/* ★`#A59`：`/cost-ledger` 通道双路（先 `/api/cost-ledger/history`，失败回落旧路径；模式缓存） */
		var _ledgerFaceMode = null;
		function ledgerRpc(rpc, payload) {
			var callApi = function () { return rpc.call("/api", "cost-ledger/history", payload); };
			var callLegacy = function () { return rpc.call("/cost-ledger", "history", payload); };
			var p = _ledgerFaceMode === "api" ? callApi() : _ledgerFaceMode === "legacy" ? callLegacy()
				: callApi().then(function (r) { _ledgerFaceMode = "api"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { "cost-ledger": "api" }); } catch (e) {} return r; },
					function () { _ledgerFaceMode = "legacy"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { "cost-ledger": "legacy" }); } catch (e) {} return callLegacy(); });
			return Promise.resolve(p);
		}

		function compatRpc(endpoint, payload) {
			var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
			var rpc = conn && conn.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				compatRpcFailure(new Error("connection 服务不可用"));
				return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
			}
			/* ★`#A56`：宿主 CHANNEL_PATTERN 单段限制 ⇒ channel 只能是 "/api"，端点前缀走 endpoint 段。 */
			var callApi = function () { return rpc.call("/api", "host-compat/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call("/host-compat", endpoint, payload || {}); };
			var chosen;
			try {
				if (COMPAT_RPC_MODE === "api") chosen = callApi();
				else if (COMPAT_RPC_MODE === "legacy") chosen = callLegacy();
				else chosen = callApi().then(function (r) { compatRpcMode("api", ""); return r; }, function (err) {
					compatRpcMode("legacy", "api 面失败→回落旧通道: " + String((err && err.message) || err));
					return callLegacy();
				});
			} catch (err) {
				compatRpcFailure(err);
				return Promise.resolve({ ok: false, error: { code: "transport", message: String((err && err.message) || err) } });
			}
			return Promise.resolve(chosen).then(function (result) {
				return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
			}).catch(function (err) {
				compatRpcFailure(err);
				return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
			});
		}


		/* ==========================================================================================
		 * ★W7（2026-11-12）「历史条幅按轮展示」—— 归档事件当**插件自有数据**，经**既有** `/host-compat`
		 *   RPC 路由取 `notice/history`（服务端只读 `lib/history.js`），渲到宿主 `conversation.chat.turnTail` 槽。
		 *   §g 目的与背景（要解决或预防的问题）：0.2.2 的 v0→v1 迁移链把自定义事件 `notice/banner*` 从会话日志里
		 *   清洗掉（「改名冒充已收录类型」已被用户判死 —— `仲裁档案 A-018`）⇒ 用户「**历史记录不能丢**」的落地形态
		 *   只剩「**归档 ＋ 可显**」；没有本段，W2 归档就只是死文件，用户看不见任何历史横幅。
		 *   边界（写死）：**不新增宿主直连接触点**（只用既有 rpc 通道 ＋ 槽位注册，`ENV §一.7①`）、不改宿主 bundle、
		 *   不碰 projections、不写任何宿主数据（只显示）。
		 *   0.2.2 把该槽声明为 `kind:"list"`（强制 `options.id`、且 list 渲染**不调用** `options.select(owner)`）——
		 *   W1b 已证「只补 id 不够」⇒ 本组件**只用 owner props 里的 `turn`**，不依赖任何 select 选举结果。
		 * ========================================================================================== */
		var HIST_ENDPOINT = "notice/history";
		var HIST_TTL_MS = 30000;
		/* ★`#A60` 步4：**首开性能打点**（只写 `localStorage["dsh-perf-boot"]`，最近 20 条；
		   不碰宿主/官方件、不上报服务端、失败绝不影响渲染）。
		   字段：{at, navStart, dcl, rowsFirst, clickAt, firstCardAt, longTasks:[{d}], sessionId} */
		(function initPerfTap() {
			try {
				if (typeof window === "undefined" || typeof document === "undefined") return;
				var PERF_KEY = "dsh-perf-boot";
				var rec = null, lts = [], rowsAt = null;
				try {
					new PerformanceObserver(function (list) {
						try { var es = list.getEntries(); for (var i = 0; i < es.length; i++) lts.push({ d: Math.round(es[i].duration) }); } catch (e) {}
					}).observe({ entryTypes: ["longtask"] });
				} catch (e) { /* 无 longtask 支持 ⇒ 空数组 */ }
				var writeRecord = function () {
					if (!rec || rec.done) return;
					rec.done = true;
					try { rec.navStart = Math.round(performance.timeOrigin || 0); } catch (e) { rec.navStart = 0; }
					try { var nav = performance.getEntriesByType("navigation")[0]; rec.dcl = nav ? Math.round(nav.domContentLoadedEventEnd) : 0; } catch (e) { rec.dcl = 0; }
					rec.at = Date.now();
					rec.longTasks = lts.slice(0, 20);
					try {
						var arr = JSON.parse(localStorage.getItem(PERF_KEY) || "[]");
						if (!Array.isArray(arr)) arr = [];
						arr.push(rec);
						localStorage.setItem(PERF_KEY, JSON.stringify(arr.slice(-20)));
					} catch (e) { /* 配额/隐私模式 ⇒ 放弃本条 */ }
				};
				try {
					var ivRows = setInterval(function () {
						try {
							if (document.querySelectorAll("[data-row-key]").length > 0) { rowsAt = Math.round(performance.now()); clearInterval(ivRows); }
						} catch (e) { clearInterval(ivRows); }
					}, 30);
					setTimeout(function () { clearInterval(ivRows); }, 60000);
				} catch (e) {}
				document.addEventListener("click", function (ev) {
					try {
						var el = ev.target && ev.target.closest ? ev.target.closest("[data-row-key]") : null;
						if (!el) return;
						var k = String(el.getAttribute("data-row-key") || "");
						if (k.indexOf("session:") !== 0) return;
						rec = { sessionId: k.slice(8), rowsFirst: rowsAt, clickAt: Math.round(performance.now()), firstCardAt: null, done: false };
					} catch (e) {}
				}, true);
				var ivCard = setInterval(function () {
					try {
						if (!rec || rec.done) return;
						var el = document.querySelector('[data-notice-banner][data-notice-routed="turntail"]');
						if (!el) return;
						var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
						if (!(r.width > 0 && r.height > 0 && cs.display !== "none" && cs.opacity !== "0")) return;
						rec.firstCardAt = Math.round(performance.now());
						writeRecord();
					} catch (e) {}
				}, 200);
				setTimeout(function () { clearInterval(ivCard); }, 180000);
			} catch (e) { /* 打点失败绝不影响渲染 */ }
		})();
		var histCache = { sid: null, at: 0, data: null, promise: null, seq: 0, failures: 0, reason: "" };
		/** 会话级闩：`turn===null` 组与「无归档／归档不可用」提示只在**该会话第一个渲染到的**回合尾行出一次
		 *  （`turn===null` 的事件与任何回合无隶属 ⇒ 禁并入某回合；但也不能在每个尾行重复刷屏）。会话变即复位。 */
		var histLatch = { sid: null, done: false };

		/* ★`#A74`（2026-11-19）：**告警/状态块的常驻宿主登记** —— `conversation.chat.turnTail` 槽每个回合一个实例，
		   只让**当前最大回合**那个实例渲染常驻块（同 `histLatch` 的"每会话一次"思路，但按**已挂载回合**取最大）
		   ⇒ 回合进行中/刚完成/静置/切会话回来 **都在**。
		   为什么不挂锚点尾：`#A72` 证明尾锚点会随宿主换代、且可能无 banner 载体 ⇒ 块整块消失（用户现场主诉）。 */
		var residentTurns = {};
		function residentAdd(t) { try { if (t !== null && Number.isFinite(Number(t))) residentTurns[String(t)] = (residentTurns[String(t)] || 0) + 1; } catch (e) { /* 忽略 */ } }
		function residentDel(t) { try { if (t === null) return; var k = String(t); var n = (residentTurns[k] || 0) - 1; if (n > 0) residentTurns[k] = n; else delete residentTurns[k]; } catch (e) { /* 忽略 */ } }
		function residentMaxTurn() { try { var mx = null; for (var k in residentTurns) { if (!Object.prototype.hasOwnProperty.call(residentTurns, k)) continue; if (!(residentTurns[k] > 0)) continue; var v = Number(k); if (Number.isFinite(v) && (mx === null || v > mx)) mx = v; } return mx; } catch (e) { return null; } }
		function residentAny() { try { for (var k in residentTurns) { if (Object.prototype.hasOwnProperty.call(residentTurns, k) && residentTurns[k] > 0) return true; } return false; } catch (e) { return false; } }
		/* ★`#A31` 步3（**家族色唯一值源 = `PALETTE`**）：原 `HIST_KIND_COLOR`（九色硬编码，与 `PALETTE` 并存
		   ＝**两个值源**）**整表删除**；历史卡改取 `PALETTE`，`compat` 两档与横幅卡同式（degraded/blocked）。
		   `PALETTE` 无对应家族（`status` 已存在；未知 kind）⇒ 回落 `PALETTE.status`（**不新造家族色**）。
		   §g 目的与背景：两套色表将来必然漂移（历史卡与横幅卡同 kind 却不同色）⇒ 用户口径「和现在一致的」
		   （`#A31` 逐字）在色面无法保证；单值源才能机械对齐。 */
		function histPalOf(kind, sev) {
			try {
				var k = String(kind || "");
				if (k === "compat") return PALETTE[String(sev || "") === "blocked" ? "compatBlocked" : "compatDegraded"];
				return PALETTE[k] || PALETTE.status || PALETTE.notify;
			} catch (e) { return PALETTE.notify; }
		}

		/** RPC 信封拆包：0.2.2 的 `/host-compat` 通道**双层包裹**（现读原文
		 *  `{"ok":true,"value":{"ok":true,"value":{…本端点响应…}}}`）⇒ 不拆则 `hasArchive` 恒 undefined（实测：界面恒「无归档」）。
		 *  拆包判据只看**结构**（外层缺本端点的 `sid`/`hasArchive` 且 `value` 是对象）⇒ 单层、三层、零层都安全。 */
		function histUnwrap(res) {
			var r = res, guard = 0;
			while (r && typeof r === "object" && guard < 4) {
				if (typeof r.sid === "string" || typeof r.hasArchive !== "undefined") break;
				if (r.value && typeof r.value === "object") { r = r.value; guard += 1; continue; }
				break;
			}
			return r;
		}

		/** 取历史（TTL 内复用；失败/降级也缓存 → 提示可见；永不 throw） */
		function histFetch(sid, force) {
			var now = Date.now();
			if (!sid) return Promise.resolve(null);
			if (histCache.sid !== sid) {
				histCache.sid = sid; histCache.at = 0; histCache.data = null;
				// ★`#A35`：会话切换 ⇒ 档位统计**复位**（否则跨会话累加，"当前页真值"失真）
				histRungStat.exact = 0; histRungStat.turn = 0; histRungStat.tail = 0; histRungStat.cards = 0; histRungStat.merged = 0;
			}
			if (!force && histCache.data && (now - histCache.at) < HIST_TTL_MS) return Promise.resolve(histCache.data);
			// ★同一会话的多个回合尾行会**并发**调用本函数 ⇒ 必须共享同一个 promise；
			//   旧实现「在飞即返回缓存值（此刻还是 null）」会让后到者永远停在 loading（实测 4/5 个尾行白屏）。
			if (histCache.promise) return histCache.promise;
			var mine = ++histCache.seq;
			var settle = function (raw) {
				histCache.promise = null;
				var res = histUnwrap(raw);
				if (mine !== histCache.seq) return histCache.data; // 有更新的请求 ⇒ 丢弃旧结果
				if (!res || typeof res !== "object") {
					histCache.failures += 1;
					histCache.reason = "empty-response";
					return histCache.data;
				}
				histCache.data = res;
				histCache.at = Date.now();
				histCache.failures = res.ok === true ? 0 : histCache.failures + 1;
				histCache.reason = res.ok === true ? "" : String(res.reason || (res.error && res.error.message) || "rpc");
				return res;
			};
			NS_PERF.hist += 1;
			var __th = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
			histCache.promise = compatRpc(HIST_ENDPOINT, { sid: sid }).then(function (raw) {
				if (__th) { NS_PERF.histMs += performance.now() - __th; nsPerfFlush(); }
				return settle(raw);
			}, function (err) {
				histCache.promise = null;
				histCache.failures += 1;
				histCache.reason = String((err && err.message) || err);
				return histCache.data;
			});
			return histCache.promise;
		}

		function histClock(ms) {
			var n = Number(ms);
			if (!isFinite(n) || n <= 0) return "";
			try {
				var d = new Date(n);
				var p = function (x) { return (x < 10 ? "0" : "") + x; };
				return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
			} catch (e) { return ""; }
		}

		/* ═══ ★`#A31`（2026-11-14）历史卡「外壳复用 ＋ 折叠复用」═══════════════════════════════════════
		   用户逐字（`§h5`）：「和现在一致的 如果是我们的插件在新的上面渲染的不一致 那就去定位问题 除非给出
		   代码上的证据 他渲染出来就是不一致 此外他们本身也不应该堆在一起」＋「折叠是已有功能吧？」
		   ⇒ ① 历史卡**改用横幅卡壳**（`className:"dsh-banner"` ＋ 壳对象单值源 `histShellFace()`）
		      ② 同回合 ≥2 张**走既有 `NoticeMergedCard`**（`nsFoldPlan` 判定，**禁新造第三种观感**）。
		   ⚠️ 禁：改 `NoticeBannerView` 本体／新造家族色／重造折叠。
		   ═══════════════════════════════════════════════════════════════════════════════════════════ */

		/** ★步1：**横幅卡壳的唯一出处** —— 圆角／内边距／字号／行高／阴影／边框／毛玻璃**逐项抄自**
		 *  `NoticeBannerView` 的卡壳内联对象（现读 `client.js:4559` 起），历史卡与横幅卡因此**同一观感**。
		 *  **本常量不反向改横幅卡**（禁改 `NoticeBannerView` 本体）⇒ 二者一致性由**真点击 computed-style
		 *  逐项对撞**看住（判据③：圆角/内边距/字号/阴影/边框差集为空）。 */
		function histShellFace(p) {
			var c = p || {};
			return {
				border: "1px solid " + c.border,
				background: c.bg,
				borderRadius: 12,
				padding: "12px 16px",
				fontSize: 13,
				lineHeight: 1.6,
				maxWidth: "100%",
				wordBreak: "break-word",
				boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
				backdropFilter: "blur(12px)",
				WebkitBackdropFilter: "blur(12px)",
				transition: "box-shadow .3s ease, border-color .3s ease"
			};
		}
		/** ★步1：徽章胶囊（样式逐项抄自横幅卡 badge，现读 `client.js:4600` 邻域） */
		function histBadgeFace(p) {
			return { background: (p || {}).accent, color: (p || {}).badgeText, fontSize: 10.5, fontWeight: 700, padding: "0 10px", borderRadius: 10, letterSpacing: 0.4, flex: "none", lineHeight: "18px" };
		}
		/** ★步1：展开钮 —— 复用既有 `.dsh-arr` 类（CSS 见 `client.js:273`），内联样式与横幅卡 arr 逐项相同 */
		function histArrFace() {
			return { marginLeft: "auto", flex: "none", fontSize: 14, lineHeight: "22px", width: 22, height: 22, textAlign: "center", borderRadius: 11, background: "var(--dsh-btn-bg)", border: "1px solid var(--dsh-glass-bd)", color: "var(--dsw-alias-label-secondary, #9aa3b2)", transition: "all .25s ease" };
		}
		/** 历史卡的展开态（**模块级 Map ＋ 本地 tick**，与 `nsFoldExpandedMap` 同机制；**不落 localStorage**） */
		var histOpenMap = {};
		function histOpenGet(k) { try { return histOpenMap[String(k)] === true; } catch (e) { return false; } }
		function histOpenSet(k, v) { try { histOpenMap[String(k)] = !!v; } catch (e) { /* 忽略 */ } }

		/* ═══ ★`#A40`（2026-11-15）：**回合级卡迁 `conversation.chat.turnTail`（可见性门禁）** ════════════
		   依据 `#A39` K1-2 决定性读数：我方在 `conversation.chat.node` 注入的锚点行 **124/124 全部**落在宿主
		   `["process", …]` 折叠组内 ⇒ 活卡**一律不可见**（四会话基线 `visible 0`），而历史卡走 `turnTail` 槽
		   在同一页面 **15/15 可见** ⇒ 用户口径「回合尾部的卡不能折叠 该显示」只能靠**换渲染槽**满足。
		   **机械分级（只按锚点行族，不看 kind 语义）**：行族 ∈ {`turn-tail`, `turn-process`} ⇒ **回合级**（迁槽）；
		   `command` ⇒ 命令级（保留原锚点）；`tool-call` 等 ⇒ 过程级（跟随层级）；其余不变。
		   ═══════════════════════════════════════════════════════════════════════════════════════════ */
		/** 从 `slotId`（契约形态 `<len>:<kind><id>`）反解**行族**；形态非法 ⇒ `null`（不猜） */
		function slotKindLocal(slotId) {
			try {
				if (typeof slotId !== "string" || !slotId) return null;
				var m = /^(\d+):/.exec(slotId);
				if (!m) return null;
				var n = Number(m[1]);
				if (!isFinite(n) || n <= 0) return null;
				return slotId.slice(String(n).length + 1, String(n).length + 1 + n) || null;
			} catch (e) { return null; }
		}
		/** 从 `slotId` 反解行 id（用于 `turn-tail<turn>` 的 turn 兜底） */
		function slotIdTailLocal(slotId) {
			try {
				var k = slotKindLocal(slotId);
				if (!k) return null;
				return slotId.slice(String(k.length).length + 1 + k.length) || null;
			} catch (e) { return null; }
		}
		/** **回合级判定**（纯函数）：`{on, turn, rowKind}`。
		 *  · `on=true` ⇔ 行族 ∈ {`turn-tail`,`turn-process`}（＝该卡的宿主行在**回合尾行/回合容器行**）；
		 *  · `cost` 且有 `anchorSeq` 但**取不到行**（`anchorSeq` 未被 ② 解析）⇒ 亦归回合级（`#A39` K2：150 条该族）；
		 *  · turn 优先取条目 `turn`，缺失则从 `turn-tail<turn>` / `turn-process<turn>` 的行 id 解析。 */
		function storeTurnLevelOf(e) {
			try {
				var rowKind = slotKindLocal(e && e.slotId);
				var turn = (e && e.turn != null && isFinite(Number(e.turn))) ? Number(e.turn) : null;
				var resolvedViaSeq = false;
				/* ★`#A66` 步3 **消费侧兜底（旧卡）**：发射侧当年没写 `turn` 的卡（`restart`/`queue` 等只带
				 *  `anchorSeq`）⇒ 用已知的回合边界 `storeState.turnAnchor`（回合 → 锚点 seq）**反查所属回合**：
				 *  取「锚点 seq ≥ 该卡 anchorSeq」的**最小回合**（seq 单调，回合末锚点必 ≥ 其内任一 seq）；
				 *  若该卡比所有已知锚点都新 ⇒ 归**最后一个已知回合**。取到即当回合级卡渲染（回各自回合）。
				 *  仍取不到 ⇒ 保持 null（下面走 `?` 桶＝尾兜底，且带可诊断标记）。 */
				if (turn == null && e && isFinite(Number(e.anchorSeq))) {
					var _ck2 = String((e && e.cardId) || (e && e.ctxKey) || "");
					if (_ck2 && seqTurnCache[_ck2] != null) { turn = seqTurnCache[_ck2]; resolvedViaSeq = true; }
					else try {
						var ta = storeState.turnAnchor || {};
						var best = null;
						for (var tk in ta) {
							if (!Object.prototype.hasOwnProperty.call(ta, tk)) continue;
							var av = Number(ta[tk]); var tv = Number(tk);
							if (!isFinite(av) || !isFinite(tv)) continue;
							if (av >= Number(e.anchorSeq) && (best === null || tv < best)) best = tv;
						}
						if (best === null) {
							var mx = null;
							for (var tk2 in ta) { var tv2 = Number(tk2); if (isFinite(tv2) && (mx === null || tv2 > mx)) mx = tv2; }
							best = mx;
						}
						if (best !== null) { turn = best; resolvedViaSeq = true; if (_ck2) seqTurnCache[_ck2] = best; try { e.__anchorSource = "seq"; } catch (eAS) {} }
					} catch (eTA) { /* 取不到 ⇒ 走尾兜底 */ }
				}
				/* ★`#A66`：**反查成功即视为"回合级卡"**（`on=true`）⇒ 由该回合的尾行渲染
				 *  （＝回到它自己那一个回合，而不是堆在最后）；反查失败才落 `?` 桶（尾兜底，可诊断）。 */
				if (resolvedViaSeq && turn != null) return { on: true, turn: turn, rowKind: "turn-tail" };
				if (turn == null && (rowKind === "turn-tail" || rowKind === "turn-process")) {
					var tail = slotIdTailLocal(e.slotId);
					if (tail != null && /^\d+$/.test(tail)) turn = Number(tail);
				}
				var on = (rowKind === "turn-tail" || rowKind === "turn-process");
				if (!on && String((e && e.kind) || "") === "cost" && typeof (e && e.anchorSeq) === "number" && !e.slotId) on = true;
				return { on: on, turn: turn, rowKind: rowKind };
			} catch (err) { return { on: false, turn: null, rowKind: null }; }
		}
		/** ★`#A42`：**store 快照版本号**（每次 `applyStoreEntries` 落库 +1；切会话也 +1）——
		 *  回合级映射的缓存键**只吃它**，不再吃 `spatial.at`/`anchorList.length` 这类易变字段。 */
		var storeRev = 0;
		/* ★`#A43` 步2：**只读性能计数**（定位"切会话慢"的真实瓶颈；零行为影响） */
		var NS_PERF = { aligns: 0, alignMs: 0, tl: 0, tlMs: 0, hist: 0, histMs: 0, turns: 0 };
		function nsPerfFlush() { try { window.__DSH_NOTICE_PERF__ = { aligns: NS_PERF.aligns, alignMs: Math.round(NS_PERF.alignMs), tl: NS_PERF.tl, tlMs: Math.round(NS_PERF.tlMs), hist: NS_PERF.hist, histMs: Math.round(NS_PERF.histMs), turns: NS_PERF.turns }; } catch (e) { /* 忽略 */ } }
		/** ★`#A40` **代际门**：只有 0.2.2 的 `turnTail` **list 面**（`HistoryTurnTail` 收到字符串 `props.sessionId`）才启用
		 *  "回合级迁槽"。0.1.2 的 turnTail 是 select 面、list 渲染语义不同 ⇒ 迁过去会**丢卡**（实测 104/167/1949 → 103/98/1587）
		 *  ⇒ 该代际**保持原 node 注入路径**（逐项零变化）。 */
		var histTurnSlotMode = false;
		/** 回合级条目键（按 turn 分桶；供 `HistoryTurnTail` 取数）。
		 *  ★`#A42` **根因修复**：本映射**直接从 store 条目集合算**，**不再调用 `storeAlignAll()`** ——
		 *  后者在"锚点宇宙为空"时**提前返回空 res**，而切会话时 `storeRefreshCurrent()` 会**清空 `anchorList`**
		 *  ⇒ 旧实现会算出空 `turnLevel` 并**缓存住**；此后锚点由宿主回放补齐但**不会通知 store 订阅者**
		 *  ⇒ 回合级卡**永不出现**（只有刷新页面才恢复）。实测：切到 `a8d2cf3f` 时 `notice/list` 已按新 sid 取到数据
		 *  且 `data-nb-hist-phase` 正常，但 `data-nb-hist-tl` 缺失 ⇒ 可见卡 0。
		 *  缓存键＝`storeRev`（`applyStoreEntries` 每落库 +1）⇒ 数据一到即重算，与锚点时序无关。 */
		var storeTurnLevelCache = { rev: -1, map: null, lastTurn: null };
		/* ★`#A66`：**反查结果按卡缓存**（`cardId/键 → turn`）—— 反查依赖"回合边界 seq"，而边界随会话增长
		 *  会变化（实测同一张旧卡曾从回合 6 漂到 8）⇒ 一次定案、本会话内不再改判；切会话即清空。 */
		var seqTurnCache = {};
		function storeTurnLevelAll() {
			var __t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
			NS_PERF.tl += 1;
			try {
				if (storeTurnLevelCache.rev === storeRev && storeTurnLevelCache.map) return storeTurnLevelCache.map;
				var map = {}, lastTurn = null, n = 0;
				var keys = storeState.keys || [];
				for (var i = 0; i < keys.length; i++) {
					var e = storeState.byKey[keys[i]];
					if (!e) continue;
					if (typeof e.turn === "number" && isFinite(e.turn) && (lastTurn == null || e.turn > lastTurn)) lastTurn = e.turn;
					var tl = storeTurnLevelOf(e);
					var noTurnNoRow = (e.turn == null && !e.slotId);
					/* ★`#A65` 修（用户现场「重启卡折叠/展开都不显示」）：会话级命令卡（`queue`/`restart`/`error`/`compat`）
					 *   在 0.2.2 会带一个**非回合行**的 `slotId`（宿主 node 面）⇒ 旧判据 `!e.slotId` 为假
					 *   ⇒ `tl.on !== true` 时被 `continue` **整条丢掉**（既不进 `"?"` 桶、也不在可见槽渲染；
					 *   node 面那份又落在宿主折叠容器里 ⇒ 界面彻底看不到）。
					 *   现读实测（`#A65`）：`apply in18/out18` 但回合级桶只有 12 条，`restart`×3／`queue`×3 **一条都不在桶里**。
					 *   ⇒ 这类卡**一律归 `"?"` 桶**（＝会话尾、`turnTail` 可见槽，最后一个回合的尾行渲染）。 */
					/* ★`#A66` 撤销 `#A65` 的"会话级卡一律归 `?` 桶"兜底 —— 那正是「多回合重启卡全堆结尾」的真因。
					 *   正解＝**先给卡定回合**（发射侧由 host-compat 的 `appendNotice` 用 `turn/end` 边界补齐，
					 *   见 `seams.js resolveTurnForEvent`），再由下方 `storeTurnLevelOf` 按回合分桶；
					 *   只有"回合确实取不到"才允许进 `?`（＝尾兜底），且必须可诊断（渲染面标 `tail-fallback`）。 */
					if (tl.on !== true && !noTurnNoRow) continue;
					var tk = (tl.on === true) ? ((tl.turn == null) ? "?" : String(tl.turn)) : "?";
					if (!map[tk]) map[tk] = [];
					map[tk].push(keys[i]);
					n += 1;
				}
				storeTurnLevelCache = { rev: storeRev, map: map, lastTurn: lastTurn };
				try { window.__DSH_NOTICE_TL__ = { rev: storeRev, n: n, turns: Object.keys(map) }; } catch (eT) { /* 忽略 */ }
				try {
					/* ★`#A65` 诊断面：桶 → 条目摘要（只读）。用于定位「turn=null 的 restart/queue 是否进 "?" 桶」。 */
					var __tlsum = {};
					for (var __k in map) { if (!Object.prototype.hasOwnProperty.call(map, __k)) continue; __tlsum[__k] = (map[__k] || []).map(function (kk) { var ee = storeState.byKey[kk] || {}; return String(ee.kind || "?") + "@" + String(ee.at || 0) + "/t" + String(ee.turn) + "/s" + String(ee.slotId || "-"); }); }
					window.__DSH_NOTICE_TLMAP__ = { rev: storeRev, lastTurn: lastTurn, map: __tlsum };
				} catch (eT2) { /* 忽略 */ }
				return map;
			} catch (e) { return {}; } finally { if (__t1) { NS_PERF.tlMs += performance.now() - __t1; nsPerfFlush(); } }
		}

		function storeTurnLevelKeys(turn) {
			try {
				var map = storeTurnLevelAll();
				var k = (turn == null) ? "?" : String(turn);
				var out = Array.isArray(map[k]) ? map[k].slice() : [];
				// 三空族（桶 "?"）只在**最后一个已建回合**渲染一次（＝"回合末尾"语义；否则每个尾行都重复）
				var lt = storeTurnLevelCache.lastTurn;
				if (k !== "?" && turn != null && lt != null && Number(turn) === Number(lt) && Array.isArray(map["?"])) out = out.concat(map["?"]);
				if (k === "?" && Array.isArray(map["?"])) out = map["?"].slice();
				return out;
			} catch (e) { return []; }
		}

		/* ═══ ★`#A35` 批二（2026-11-14 `#A35`）：**替换归约（甲口径）＋ 位置反推三档** ═══════════════════
		   用户逐字：「选择甲 先做到一样的 优化什么的后面再说 这个又不是bug」／
		             「对于以前的历史数据 首先追求的是全显示 然后再反推显示位置看能不能还原」
		   ⇒ ① **只显示最终态**：同一替换链只留最后一条（替换史**不上屏**，属优化、用户已排除）；
		      ② **先保不丢卡**：`merged + kept == total`、每条链只留 1 条、链键互斥（禁跨链吞并）；
		      ③ **位置尽最大努力反推**，并把**实际档位**如实写在 `data-nb-hist-anchor`（`exact|turn|tail`）——
		         **禁把兜底当原位**。
		   ═══════════════════════════════════════════════════════════════════════════════════════════ */

		/** **替换链键**（甲口径；纯函数、无状态）。
		 *  · `restart`：以 `scheduleId` 为链（**`phase` 是变化字段**，不作链键 —— 否则「已排程/观察中/取消」各留一张 = 替换仍失效）；
		 *    无 `scheduleId` ⇒ 退 `(kind,title,turn)` 兜底。
		 *  · `cost`/`ledger`/`costs`/`queue`：链键 `(kind,turn)`；**`data.rev` 是修订号 ⇒ 只作排序**（取最大 rev ＝ 最终态）。
		 *  · `status`：链键 `(kind,turn)`。
		 *  · 其它 kind：**兜底 `(kind,title,turn)`**（具名列表见证据件 §1；`kind` 为空也走此支）。
		 *  ⚠️ 链键互斥：不同 `scheduleId` / 不同 `turn` / 不同 `title` **永不合并**（禁跨链吞并）。 */
		function histChainKey(ev) {
			try {
				var b = (ev && ev.data) || {};
				var kind = String(b.kind || "");
				var turn = (ev && ev.turn != null) ? String(ev.turn) : "null";
				if (kind === "restart") {
					var sch = String(b.scheduleId || "");
					return sch ? ("restart|" + sch) : ("restart|" + String(b.title || "") + "|" + turn);
				}
				if (kind === "cost" || kind === "ledger" || kind === "costs" || kind === "queue") return kind + "|" + turn;
				if (kind === "status") return "status|" + turn;
				return "other|" + kind + "|" + String(b.title || b.metaText || b.text || "") + "|" + turn;
			} catch (e) { return "err"; }
		}
		/** **甲口径归约**（纯函数）：同链只留**最后一条**（`seq` 最大；`rev` 大者天然在后）。
		 *  @returns `{kept:[{ev,key,merged}], merged, total, chains}`；**不丢卡自检**：`kept.length + merged === total`。 */
		function histReduce(list) {
			var arr = Array.isArray(list) ? list : [];
			var order = [], byKey = {}, i;
			for (i = 0; i < arr.length; i++) {
				var ev = arr[i]; if (!ev) continue;
				var k = histChainKey(ev);
				if (!byKey[k]) { byKey[k] = { key: k, ev: ev, merged: 0 }; order.push(k); }
				else {
					var cur = byKey[k];
					cur.merged += 1;
					var a = (typeof ev.seq === "number") ? ev.seq : 0;
					var bq = (typeof cur.ev.seq === "number") ? cur.ev.seq : 0;
					if (a >= bq) cur.ev = ev;   /* 最终态 */
				}
			}
			var kept = [];
			for (i = 0; i < order.length; i++) kept.push(byKey[order[i]]);
			var merged = 0;
			for (i = 0; i < kept.length; i++) merged += kept[i].merged;
			return { kept: kept, merged: merged, total: kept.length + merged, chains: kept.length };
		}
		/** **位置反推三档**（纯读：只读 `storeState.spatial.slots` 行事实，不猜）。
		 *  ① `exact` ＝ 存在 seq < 该归档事件的行，且该行 `turn` 与事件 `turn` **相同**（＝ 归档事件原本紧跟的那一行）；
		 *  ② `turn`  ＝ 该回合在本页行事实里有行（现架构即在回合尾行渲染）；
		 *  ③ `tail`  ＝ 无行事实可用（该会话没有 `slots/`）⇒ 回合末尾兜底。
		 *  ⚠️ 档位**如实返回**，调用方写进 `data-nb-hist-anchor`；**禁把 `tail` 标成 `exact`**。 */
		function histRungOf(ev) {
			try {
				var sp = storeState.spatial;
				var rows = (sp && sp.on === true && Array.isArray(sp.slots)) ? sp.slots : [];
				var evSeq = (ev && typeof ev.seq === "number") ? ev.seq : null;
				var turn = (ev && ev.turn != null) ? ev.turn : null;
				if (rows.length && evSeq != null) {
					var best = null, i;
					for (i = 0; i < rows.length; i++) {
						var r = rows[i]; if (!r || typeof r.seq !== "number") continue;
						if (r.seq >= evSeq) continue;
						if (best == null || r.seq > best.seq) best = r;
					}
					if (best && turn != null && best.turn === turn) return { rung: "exact", seq: best.seq };
				}
				if (rows.length && turn != null) {
					for (var j = 0; j < rows.length; j++) if (rows[j] && rows[j].turn === turn) return { rung: "turn", seq: null };
				}
				return { rung: "tail", seq: null };
			} catch (e) { return { rung: "tail", seq: null }; }
		}
		/** 档位计数（**面板点名用**；每次历史渲染重置 ⇒ 反映"当前页"真值） */
		var histRungStat = { exact: 0, turn: 0, tail: 0, cards: 0, merged: 0, at: 0 };

		/** 一张历史条幅卡 ＝ 一条归档事件（DOM 身份 = `data-nb-hist-card=<seq>`，判据按它计数）
		 *  ★`#A31` 步1：**壳**换成横幅卡壳（`dsh-banner` ＋ `histShellFace`），卡头四件（图标＋徽章＋标题＋金额）
		 *  照 `NoticeBannerView`，展开钮用既有 `.dsh-arr`；`data-nb-hist-*` 属性**一字未改**（判据锚点不动）。 */
		function HistoryCard(props) {
			var rung = (props && props.rung) || null;      /* ★`#A35`：`{rung:"exact|turn|tail", seq}` */
			var mergedN = (props && typeof props.mergedN === "number") ? props.mergedN : 0;
			var e = (props && props.event) || {};
			var b = e.data && typeof e.data === "object" ? e.data : {};
			var kind = String(b.kind || "");
			var fam = nsFamOf(b);
			var pal = histPalOf(fam, b.severity) || PALETTE.notify;
			var icon = kind === "compat" ? (String(b.severity || "") === "blocked" ? "⛔" : "🧩") : (ICONS[fam] || "");
			var badge = BADGES[fam] || "通知";
			var title = String(b.title || b.metaText || b.text || "");
			var subtitle = String(b.subtitle || "");
			// ★★ `#A34` 步1（G1；用户逐字「他不应该渲染成横幅 应该是气泡形式……类似于图二的风格」）：
			//   **`status` 归档事件走既有「气泡 vs 卡片」判定** —— 判据单一出处仍是 `nsFormOf:3844`
			//   （`kind==="status"` ⇒ `"bubble"`），本处**只消费、不另写判定**；
			//   迷你行样式与 `NoticeBannerView` 的气泡分支（现读 `:4640`–`:4660`）**逐项同源**（`dsh-status`／22px／无边框）。
			//   ⚠️ **三个判据锚点必须保留**：`data-nb-hist-card`／`-turn`／`-kind`（判据①按它们计数）。
			if (nsFormOf(b) === "bubble") {
				var bRunning = String(b.state || "") === "running";
				return React.createElement("div", {
					"data-nb-hist-card": String(e.seq),
					"data-nb-hist-turn": (e.turn === null || e.turn === undefined) ? "null" : String(e.turn),
					"data-nb-hist-kind": kind || "unknown",
					"data-nb-hist-type": String(e.type || ""),
					"data-nb-hist-seq": String(e.seq),
					"data-nb-hist-clock": histClock(e.time) || undefined,
					"data-family": "status",
					"data-nb-hist-bubble": "1",
					"data-nb-hist-anchor": rung ? rung.rung : "tail",
					"data-nb-hist-anchor-seq": (rung && typeof rung.seq === "number") ? String(rung.seq) : undefined,
					"data-nb-hist-merged": mergedN ? String(mergedN) : undefined,
					"data-state": bRunning ? "running" : "ok",
					className: "dsh-status",
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						fontSize: 12,
						lineHeight: "22px",
						color: "var(--dsw-alias-label-tertiary, #9aa3b2)",
						padding: "2px 0"
					}
				}, [
					React.createElement("span", { key: "ic", style: { flex: "none", fontSize: 12, lineHeight: 1 } }, bRunning ? "⟳" : "✓"),
					React.createElement("span", { key: "tx", style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(b.text || title || ""))
				]);
			}
			var stats = Array.isArray(b.stats) ? b.stats : [];
			var kv = Array.isArray(b.kv) ? b.kv : [];
			var lines = Array.isArray(b.lines) ? b.lines : [];
			// **金额（关键值）**：口径与横幅卡折叠摘要**同源**（首个带 `key` 的统计格 → 首个 `strong` → `costYuan`）
			var amount = "";
			for (var s1 = 0; s1 < stats.length; s1++) { if (stats[s1] && stats[s1].key && stats[s1].value != null) { amount = String(stats[s1].value); break; } }
			if (!amount) for (var s2 = 0; s2 < stats.length; s2++) { if (stats[s2] && stats[s2].strong && stats[s2].value != null) { amount = String(stats[s2].value); break; } }
			if (!amount && typeof b.costYuan === "number" && isFinite(b.costYuan)) amount = "¥" + b.costYuan.toFixed(2);
			var openKey = "hist#" + String(e.seq);
			var ring = React.useState(0);
			var open = histOpenGet(openKey);
			var toggle = function () { histOpenSet(openKey, !open); ring[1](function (v) { return v + 1; }); };
			// ★`#A43` 步1：**可见调试行已删** —— 原 `metaLine`（「归档 seq X · type · 时间 · 回合 N」）
			//   不再渲染（用户 2026-11-16 逐字：「这个卡的样式不对」）。同一信息**全部转为属性**：
			//   `data-nb-hist-seq`／`-type`／`-turn`／`-clock`（＋既有 `-card`＝seq、`-kind`、`-anchor` 等）。
			//   判据：卡片可见文本不含「归档 seq」；`data-nb-hist-*` 锚点只增不减。
			//   `title` 悬停串里也含「归档 seq」⇒ 同批去掉（否则 hover 仍能看到调试串）。
			var clock = histClock(e.time);
			var detailRows = [];
			for (var d1 = 0; d1 < kv.length; d1++) {
				var kvIt = kv[d1] || {};
				detailRows.push(React.createElement("div", { key: "kv" + d1, style: { fontSize: 12, color: pal.meta } }, String(kvIt.k || "") + "：" + String(kvIt.v == null ? "" : kvIt.v)));
			}
			for (var d2 = 0; d2 < lines.length; d2++) {
				detailRows.push(React.createElement("div", { key: "ln" + d2, style: { fontSize: 12, color: pal.body } }, String(lines[d2] == null ? "" : lines[d2])));
			}
			if (subtitle) detailRows.unshift(React.createElement("div", { key: "sub", style: { fontSize: 12, color: pal.meta } }, subtitle));
			return React.createElement("div", {
				"data-nb-hist-card": String(e.seq),
				"data-nb-hist-seq": String(e.seq),
				"data-nb-hist-turn": (e.turn === null || e.turn === undefined) ? "null" : String(e.turn),
				"data-nb-hist-kind": kind || "unknown",
				"data-nb-hist-type": String(e.type || ""),
				"data-nb-hist-clock": clock || undefined,
				"data-family": kind || "unknown",
				"data-nb-hist-anchor": rung ? rung.rung : "tail",
				"data-nb-hist-anchor-seq": (rung && typeof rung.seq === "number") ? String(rung.seq) : undefined,
				"data-nb-hist-merged": mergedN ? String(mergedN) : undefined,
				"data-collapsed": open ? undefined : "true",
				className: "dsh-banner",
				style: histShellFace(pal)
			}, [
				React.createElement("div", {
					// ★ `#A34` 步2（G4）：**点击互斥** —— 卡头点击只翻卡身，**不得冒泡**到合成卡容器
					//   （`NoticeMergedCard` 根 div 的 `onClick`，现读 `:4110`）⇒ 否则一次点击同时收起合成卡
					//   = 用户报的 bug（「点击后卡片会折叠 再次点开才能看到展开的横幅」）。
					key: "hd", role: "button", title: open ? "折叠" : "展开",
					onClick: function (ev) { try { ev.stopPropagation(); } catch (e0) { /* 忽略 */ } toggle(); },
					style: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 13.5, cursor: "pointer",
						userSelect: "none", minHeight: 30, marginBottom: open ? 6 : 0, color: "var(--dsw-alias-label-primary, #e6e8ec)" }
				}, [
					icon ? React.createElement("span", { key: "ico", style: { fontSize: 16, flex: "none", lineHeight: 1 } }, icon) : null,
					React.createElement("span", { key: "bd", style: histBadgeFace(pal) }, badge),
					React.createElement("span", { key: "tt", style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title || "（无标题）"),
					amount ? React.createElement("span", { key: "am", style: { color: pal.accent, fontWeight: 700, flex: "none", marginLeft: 4, fontSize: 13, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, amount) : null,
					React.createElement("span", { key: "ar", className: "dsh-arr", style: histArrFace() }, open ? "▾" : "▸")
				]),
				open && detailRows.length ? React.createElement("div", { key: "bd2", style: { display: "flex", flexDirection: "column", gap: 3 } }, detailRows) : null
			]);
		}

		/** 一个分组 ＝ 一个回合的历史条幅（`turn===null` ⇒ 「无回合落点」组，独立标识、禁并入任何回合）
		 *  ★`#A31` 步2：**折叠复用** —— 同组 ≥2 张且 `nsFoldPlan` 判可合成 ⇒ 走既有 `NoticeMergedCard`
		 *  （只写**翻译层**：归档事件 → 组件认的条目形状；`nsNoFold` 的命令·费用族与 `status` 气泡行**仍逐张完整卡**，
		 *  这是既有口径，**不改**）。单条组 ⇒ 完整卡（零折叠）。 */
		function HistoryGroup(props) {
			var turn = props && props.turn !== undefined ? props.turn : null;
			var evs = Array.isArray(props && props.events) ? props.events : [];
			var isOrphan = turn === null || turn === undefined;
			var key = isOrphan ? "null" : String(turn);
			var label = (isOrphan ? "无回合落点 · 历史条幅 " : "回合 " + key + " · 历史条幅 ") + evs.length + " 条";
			var sidV = String((props && props.sid) || "");
			// ★`#A35` 步1：**甲口径归约**（同替换链只留最终态；`merged+kept==total`、每链 1 条、链键互斥）
			var red = histReduce(evs);
			// —— 翻译层（不碰折叠判定）：归约后条目 → `nsFoldPlan` 认的条目形状，附档位与合并数 ——
			var ents = [], i;
			for (i = 0; i < red.kept.length; i++) {
				var cell = red.kept[i];
				var ev = cell.ev || {};
				var pb = ev.data && typeof ev.data === "object" ? ev.data : {};
				var rg = histRungOf(ev);
				ents.push({ kind: String(pb.kind || "unknown"), at: typeof ev.time === "number" ? ev.time : null,
					__histEvent: ev, __rung: rg, __mergedN: cell.merged });
				// 档位计数（面板点名 + 探针取数）
				if (rg.rung === "exact") histRungStat.exact += 1; else if (rg.rung === "turn") histRungStat.turn += 1; else histRungStat.tail += 1;
			}
			histRungStat.cards += red.kept.length;
			histRungStat.merged += red.merged;
			histRungStat.at = Date.now();
			try {
				// ★`#A35` 步2：**面板点名串**（与 `FoldKeepCard` 的 `useHintReadout()` **同一算式**）——
				//   面板未打开时也能机械取到"面板会渲染什么"（零 UI 元素；`data-notice-hint` 仍只在面板里）。
				var _pc = String(storeRenderState.hint || "");
				if (histRungStat.tail > 0) _pc = _pc ? (_pc + ",hist-anchor-tail") : "hist-anchor-tail";
				window.__DSH_NOTICE_HIST__ = { exact: histRungStat.exact, turn: histRungStat.turn, tail: histRungStat.tail,
					cards: histRungStat.cards, merged: histRungStat.merged, written: red.total, panelCode: _pc };
			} catch (eH) { /* 无 window ⇒ 只留模块态 */ }
			var plan = nsFoldPlan(ents);
			// ⚠️ **折叠族成员必须用"下标"标记**：`nsFoldPlan` 返回的是**同引用对象**，但把它当对象键会串成
			//   `"[object Object]"`（同一键）⇒ 除首个折叠成员外**全部被误判成折叠族**而漏渲染（实测 `cad7bc40`
			//   折叠态只出 37 张、应 48 张）⇒ 改用 `plan.fold.indexOf(ents[i])`（**引用相等**）。
			var isFold = [];
			if (plan.merged) for (i = 0; i < ents.length; i++) isFold[i] = (plan.fold.indexOf(ents[i]) >= 0);
			var mergedEl = plan.merged ? React.createElement(NoticeMergedCard, {
				key: "mg", ents: plan.fold, stateKey: "histgrp#" + sidV + "#" + key,
				nodeKey: "hist-" + sidV + "#" + key, nodeId: null, t: props && props.t,
				renderItem: function (ent, k2, cap) {
					var card = React.createElement(HistoryCard, { key: k2, event: (ent && ent.__histEvent) || {}, rung: ent && ent.__rung, mergedN: ent && ent.__mergedN });
					if (cap) return React.createElement("div", { key: k2, className: "dsh-merged-hi", "data-merged-hi": String((ent && ent.kind) || ""), style: { maxHeight: NS_FOLD_CAP, overflow: "hidden" } }, card);
					return React.createElement("div", { key: k2, className: "dsh-merged-item", "data-merged-item": k2, "data-merged-item-kind": String((ent && ent.kind) || ""), style: NS_ITEM_FACE }, card);
				}
			}) : null;
			// 顺序：按原条目序输出；折叠族在其**首个成员位置**渲染合成卡（其余成员由合成卡承载），命令·费用族逐张
			var body = [], placedMerged = false;
			for (i = 0; i < ents.length; i++) {
				var ent = ents[i];
				if (isFold[i] === true) {
					if (!placedMerged) { body.push(mergedEl); placedMerged = true; }
					continue;
				}
				body.push(React.createElement(HistoryCard, { key: String((ent.__histEvent && ent.__histEvent.seq) || i), event: ent.__histEvent || {}, rung: ent.__rung, mergedN: ent.__mergedN }));
			}
			return React.createElement("div", {
				"data-nb-hist-group": key,
				"data-nb-hist-count": String(evs.length),
				"data-nb-hist-sid": sidV,
				"data-nb-hist-fold": plan.merged ? String(plan.fold.length) : "0",
				"data-nb-hist-kept": String(red.kept.length),
				"data-nb-hist-merged-raw": String(red.merged),
				style: { margin: "6px 0", padding: "4px 6px", border: "1px dashed rgba(148,163,184,0.45)", borderRadius: "6px",
					background: "rgba(148,163,184,0.06)" }
			}, [
				React.createElement("div", { key: "h", "data-nb-hist-group-label": key,
					style: { fontSize: "11px", fontWeight: 600, color: isOrphan ? "#dc2626" : "var(--dsh-text-2, #64748b)", marginBottom: "2px" } }, label),
				React.createElement("div", { key: "b", style: { display: "flex", flexDirection: "column", gap: 6 } }, body)
			]);
		}

		function histHint(kind, text) {
			return React.createElement("div", {
				"data-nb-hist-hint": kind,
				style: { margin: "6px 0", padding: "4px 8px", border: "1px dashed rgba(148,163,184,0.6)", borderRadius: "6px",
					fontSize: "12px", color: "var(--dsh-text-2, #64748b)" }
			}, text);
		}

		/** 回合尾行槽的 list 贡献：owner props = `{turn: TurnLocation, seq, openFile}`（宿主清单见 `计划.md §4.3`） */
		function HistoryTurnTail(props) {
			// ★0.2.2 现读：会话身份由槽位 kit 直接给（`props.sessionId`），**不是** `currentSessionId()` ——
			//   后者走 `ctx.get("sessions").list.getSnapshot()`（0.1.2 面）在 0.2.2 上返回 `null`
			//   ⇒ 只用旧路径会让本槽恒返回 null（实测：组件被调用、`props.turn.turn` 正常、`cur:null`）。
			var sid = (props && typeof props.sessionId === "string" && props.sessionId) ? props.sessionId : currentSessionId();
			// ★`#A40` 代际门：`props.sessionId` 是 0.2.2 turnTail list 面独有 ⇒ 以此判定是否启用"回合级迁槽"
			if (props && typeof props.sessionId === "string" && props.sessionId) histTurnSlotMode = true;
			if (sid) noteSessionIdFromProps(sid);   // ★A24：把 0.2.2 的 props 会话身份回报给模块级缓存（store 取数用）
			var dataState = React.useState(null);
			var data = dataState[0];
			var setData = dataState[1];
						// ★`#A40`：**订阅 store** —— 回合级活卡由本槽渲染，store 快照后到时必须重渲染（否则永不出现）
			var storeRingTL = React.useState(0);
			React.useEffect(function () {
				var un = null;
				try { un = subscribeStore(function () { storeRingTL[1](function (v) { return (v + 1) % 1000000; }); }); } catch (eS) { /* 订阅层不可用 ⇒ 只按当次渲染 */ }
				return function () { try { if (un) un(); } catch (e0) { /* 忽略 */ } };
			}, []);
React.useEffect(function () {
				var alive = true;
				if (!sid) return function () {};
				histFetch(sid).then(function (res) { if (alive && res) setData({ sid: sid, res: res }); });
				return function () { alive = false; };
			}, [sid, storeRingTL[0]]);
			var turnNo = null;
			try { if (props && props.turn && typeof props.turn.turn === "number") turnNo = props.turn.turn; } catch (e) { turnNo = null; }
			if (!sid) return null;

			// ★`#A74`：**常驻宿主登记**（挂载即登记；最大回合变化时唤醒同侪 ⇒ 常驻块"搬家"到最新回合尾）
			React.useEffect(function () {
				if (turnNo === null) return function () { };
				var before = residentMaxTurn();
				residentAdd(turnNo);
				if (residentMaxTurn() !== before) { try { notifyStore(); } catch (eR) { /* 忽略 */ } }
				return function () {
					var b = residentMaxTurn();
					residentDel(turnNo);
					if (residentMaxTurn() !== b) { try { notifyStore(); } catch (eR2) { /* 忽略 */ } }
				};
			}, [turnNo]);
			// ★`#A74`：**常驻状态/告警块**（只在最大回合实例渲染；数据驱动，无"活动才显示"兜底）
			var residentBlock = null;
			try {
				var __owner = residentOwner();
				if (turnNo !== null && __owner.kind === "turn" && __owner.turn === turnNo) {
					var scAllR = storeStateCards();
					var scModeR = storeStateCardMode();
					var shownR = [];
					for (var rk = 0; rk < scAllR.length; rk++) {
						var sccR = scAllR[rk];
						if (!sccR || typeof sccR !== "object") continue;
						if (String(sccR.kind) === "alert" && String(sccR.scope) !== "session" && scModeR === "session") continue;
						shownR.push(sccR);
					}
					residentBlock = stateCardBlockEl(shownR, "resident", null);
				}
			} catch (eRB) { residentBlock = null; }
			// 诊断面（可判据取数）：phase ∈ loading / ok / no-archive / unavailable / stale
			//   `data-nb-hist-gt` = 归档 turn 组号清单（截断 200 字符），供「组号逐一相等」类判据在**渲染前后**都能取
			var phase = !data ? "loading" : (data.sid !== sid ? "stale" : (data.res && data.res.ok === true ? (data.res.hasArchive === true ? "ok" : "no-archive") : "unavailable"));
			var dbg = { "data-nb-hist-tail": turnNo === null ? "null" : String(turnNo), "data-nb-hist-phase": phase, "data-nb-hist-sid": sid };
			if (!data || data.sid !== sid) return React.createElement("div", dbg);
			var res = data.res || {};
			if (res.ok === true) {
				dbg["data-nb-hist-gt"] = (Array.isArray(res.groups) ? res.groups : []).map(function (g) { return g && g.turn === null ? "null" : String(g && g.turn); }).join(",").slice(0, 200);
				dbg["data-nb-hist-count"] = String(res.count === undefined ? -1 : res.count);
			} else {
				dbg["data-nb-hist-reason"] = String(res.reason || (res.error && res.error.message) || "").slice(0, 120);
			}
			var groups = Array.isArray(res.groups) ? res.groups : [];
			var out = [];
			// ★`#A40`：**回合级活卡**在本回合尾行渲染（`turnTail` 通道 ⇒ 首次加载即可见，不受 `["process",…]` 折叠影响）。
			//   **与历史卡同槽禁双显**：同一 `(kind,≈时间)` 或同 `anchorSeq` 已由历史卡渲染者跳过（`seen` 表）。
			try {
				var tlKeys = storeTurnLevelKeys(turnNo);
				/* ★`#A65` 诊断面（只读，零行为影响）：`window.__DSH_NOTICE_TLDBG__[turn]` 记
				 * 「本轮 turnTail 拿到的 key 数 / 实际渲染数 / 被跳过原因」——
				 * 用于定位「turn=null 的卡（restart/queue）为何只走 node 槽且落在隐藏容器里」。 */
				try {
					window.__DSH_NOTICE_TLDBG__ = window.__DSH_NOTICE_TLDBG__ || {};
					window.__DSH_NOTICE_TLDBG__[String(turnNo)] = { turn: turnNo, lastTurn: storeTurnLevelCache.lastTurn, keys: (tlKeys || []).length, rendered: 0, skipped: [] };
				} catch (e0) { /* 忽略 */ }
				if (tlKeys && tlKeys.length) {
					var seenSig = {}, seenSeq = {}, hi, hv;
					for (hi = 0; hi < groups.length; hi++) {
						if (!groups[hi] || groups[hi].turn !== turnNo) continue;
						var gev = Array.isArray(groups[hi].events) ? groups[hi].events : [];
						for (var gj = 0; gj < gev.length; gj++) {
							hv = gev[gj] || {};
							var hb = hv.data && typeof hv.data === "object" ? hv.data : {};
							seenSig["k|" + String(hb.kind || "") + "|" + String(Math.round((typeof hv.time === "number" ? hv.time : 0) / 2000))] = 1;
							if (typeof hv.seq === "number") seenSeq[hv.seq] = 1;
						}
					}
					for (var ti = 0; ti < tlKeys.length; ti++) {
						var te = storeState.byKey[tlKeys[ti]];
						if (!te) { try { window.__DSH_NOTICE_TLDBG__[String(turnNo)].skipped.push(tlKeys[ti] + ":missing"); } catch (e1) {} continue; }   /* 被丢弃 ⇒ 只少这一张（per-emitter 隔离） */
						var tsig = "k|" + String(te.kind || "") + "|" + String(Math.round((typeof te.at === "number" ? te.at : 0) / 2000));
						if (seenSig[tsig]) { try { window.__DSH_NOTICE_TLDBG__[String(turnNo)].skipped.push(String(te.kind) + ":hist-sig"); } catch (e2) {} continue; }                                     /* 与历史卡同卡 ⇒ 只渲一处 */
						if (typeof te.anchorSeq === "number" && seenSeq[te.anchorSeq]) { try { window.__DSH_NOTICE_TLDBG__[String(turnNo)].skipped.push(String(te.kind) + ":hist-seq"); } catch (e3) {} continue; }
						try { window.__DSH_NOTICE_TLDBG__[String(turnNo)].rendered += 1; window.__DSH_NOTICE_TLDBG__[String(turnNo)].skipped.push(String(te.kind) + ":rendered"); } catch (e4) {}
						out.push(React.createElement(NoticeBannerView, {
							key: "tl" + String(ti),
							node: { key: String(props && props.seq ? props.seq : "") + "#tl" + ti, id: (props && props.id) || null,
								kind: "notice-banner", data: Object.assign({}, te, { __routed: "turntail", __anchorSource: te.__anchorSource || "turn" }) },
							t: props && props.t
						}));
					}
					dbg["data-nb-hist-tl"] = String(tlKeys.length);
				}
			} catch (eTL) { /* 回合级渲染失败绝不影响历史卡 */ }
			if (res.ok === true) {
				for (var i = 0; i < groups.length; i++) {
					if (groups[i] && groups[i].turn === turnNo) out.push(React.createElement(HistoryGroup, { key: "g" + String(turnNo), turn: turnNo, events: groups[i].events, sid: sid }));
				}
			}
			if (histLatch.sid !== sid) { histLatch.sid = sid; histLatch.done = false; }
			if (!histLatch.done) {
				histLatch.done = true;
				if (res.ok !== true) {
					out.push(React.createElement("div", { key: "hint-unavail" }, histHint("archive-unavailable", "历史条幅：归档不可用（" + String(res.reason || "unknown") + "）")));
				} else {
					var orphan = null;
					for (var j = 0; j < groups.length; j++) if (groups[j] && groups[j].turn === null) orphan = groups[j];
					if (orphan) out.push(React.createElement(HistoryGroup, { key: "g-orphan", turn: null, events: orphan.events, sid: sid }));
					if (res.hasArchive !== true) out.push(React.createElement("div", { key: "hint-none" }, histHint("no-archive", "历史条幅：无归档（该会话未被归档器收录，迁移后没有历史条幅可显）")));
				}
			}
			if (residentBlock) out.push(React.createElement("div", { key: "resident" }, residentBlock));
			if (!out.length) return React.createElement("div", dbg);
			return React.createElement("div", dbg, out);
		}


		/* ==========================================================================================
		 * ★批15（`#77`；2026-10-17）：**未定位区「计数与渲染同源」** —— 单一判据 `nsCardDropped()`。
		 *   §g 目的与背景（要解决什么）：`storeAlignAll().unplacedKeys` 是**对齐侧**的未定位键集，
		 *   而渲染时每一张卡还会被它**自己的渲染判据再过滤一次**（`kind==="compat"` 且
		 *   已关闭(done)/当前全域 OK ⇒ `return null`，见本文件下方 compat 分支）。旧实现直接拿
		 *   `unplacedKeys.length` 当计数 ⇒ **头行写 N、展开却只有 N−1 张**（用户 `#77` 逐字：
		 *   「卡片展开只有8张 是不是那个不显示的卡也算进去了？」—— 答：**是**）。
		 *   ⇒ 现在先按**同一判据**过滤出"**实际可渲染**"的子集，头行 N 与 `data-notice-unplaced`
		 *   **都取该数组长度**，渲染也**直接用同一数组**（**禁再单独读 store 计数**：
		 *   `store.counters.unplaced` / `storeAlignAll().unplacedKeys.length` 均**不再**作本区计数）。
		 *   数据来源仍是既有 `/host-compat` `status`（**零新通道 / 零新键 / 零新请求**）：
		 *   compat 卡本体每次拿到新快照即 `nsCompatPublish()`，未定位区（尾锚点）订阅同一快照
		 *   ⇒ 两处**读同一份判据输入**，不再各算一次。
		 */
		var nsCompatPub = null;            /* compat 状态快照（未定位区按它判"可渲染"；null = 未取到） */
		var nsCompatPubSubs = [];
		var nsCompatReq = null;            /* 单次 status 请求（模块级去重：整页只发一次，零 token） */
		function nsCompatPublish(s) {
			nsCompatPub = s || null;
			for (var _pi = 0; _pi < nsCompatPubSubs.length; _pi++) { try { nsCompatPubSubs[_pi](nsCompatPub); } catch (e) { /* 订阅者异常绝不影响渲染 */ } }
		}
		/** **唯一取数口**：/host-compat `status`（既有端点；整页去重；失败不抛、保持 null ⇒ fail-open 照旧渲染）。 */
		function nsCompatEnsure() {
			if (nsCompatReq) return nsCompatReq;
			nsCompatReq = compatRpc("status", {}).then(function (res) {
				if (!res || res.ok !== true || !res.value || typeof res.value !== "object") { nsCompatReq = null; return null; }
				var v = res.value;
				var hv = v.host && v.host.version ? String(v.host.version) : "";
				var sig = typeof v.capabilitySignature === "string" ? v.capabilitySignature : "";
				var d = v.dismiss && typeof v.dismiss === "object" ? v.dismiss : null;
				var off = !!(d && String(d.hostVersion || "") === hv && String(d.capabilitySignature || "") === sig);
				var gs = (typeof v.state === "string") ? v.state : "";
				if (!nsCompatPub) nsCompatPublish({ phase: off ? "done" : "idle", hostVersion: hv, signature: sig, globalState: gs, error: null });
				return nsCompatPub;
			});
			return nsCompatReq;
		}
		/** 订阅**同一份**快照（未定位区 / 各 compat 卡皆走此口 ⇒ 判据输入单一出处） */
		function nsCompatPubUse() {
			var st = React.useState(nsCompatPub);
			React.useEffect(function () {
				var cb = function (v) { st[1](v); };
				nsCompatPubSubs.push(cb);
				nsCompatEnsure();   /* 首个订阅者即触发（去重） */
				return function () { var j = nsCompatPubSubs.indexOf(cb); if (j >= 0) nsCompatPubSubs.splice(j, 1); };
			}, []);
			return st[0];
		}
		/** **唯一判据**：该卡是否"被渲染判据挡掉" —— 既用于**计数过滤**，也用于卡本体 `return null`（同一处、同一式）。 */
		function nsCardDropped(kind, compat) {
			return kind === "compat" && !!compat && (compat.phase === "done" || compat.globalState === "OK");
		}
		/** 未定位条目 ⇒ **实际可渲染**子集（保持原顺序；计数与渲染**同源**于此数组） */
		function nsUnplacedRenderable(ents, compat) {
			var out = [];
			for (var _ui2 = 0; _ui2 < ents.length; _ui2++) {
				if (!nsCardDropped(ents[_ui2] && ents[_ui2].kind, compat)) out.push(ents[_ui2]);
			}
			return out;
		}

		/* ==========================================================================================
		 * P1-2 客户端换源（设计稿 §4 三段式 + §5 外观零变化 + R8 降级）
		 *   · 数据来源 = 自有 store（经既有 `/host-compat` 路由 → `notice/list`，**不新增通道**）；
		 *   · 三段式：① 活动驱动刷新（任何会话事件顺带刷新，含一次 700ms 尾随刷新，覆盖
		 *     "命令 handler 在 command/done 之前写条目"的场景）② 绝对时间戳 + 本地自绘
		 *     （`at`/`ttlMs` 由本地判定可见性，零请求）③ 空闲兜底轮询 `pollMs`（默认 10000，
		 *     `localStorage["dsh-notice-pollMs"]` 可配；`0` = 仅活动刷新；隐藏即停；
		 *     失败退避 5→15→60s；连续失败静默 —— 不打日志、不上屏）；
		 *   · **渲染接入**（关键取舍）：store 条目**不是**会话事件 ⇒ 宿主事件驱动引擎无法凭空建节点。
		 *     做法 = **锚定到"创建后的下一个真实事件"**（`entry.at <= event.time` 的最早事件）：
		 *     命令类条目由紧随其后的 `command/done` 锚定、回合类条目由后续 step/turn 事件锚定
		 *     ⇒ 卡片仍渲染在消息流内、仍用 `kind:"notice-banner"` 视图槽（**CSS/外观零变化**）；
		 *   · 未取到 service / 取数失败 / 条目全坏 ⇒ **渲染空气**（不 throw、不 pending、不重试风暴）。
		 * ========================================================================================== */

		/** 轮询间隔（可配；0 = 仅活动刷新）—— 默认 10000ms（设计稿 §4 ③） */
		var NOTICE_POLL_MS = (function () {
			try {
				var raw = window.localStorage ? window.localStorage.getItem("dsh-notice-pollMs") : null;
				var n = raw == null ? NaN : parseInt(raw, 10);
				return isFinite(n) && n >= 0 ? n : 10000;
			} catch (e) { return 10000; }
		})();
		/** 失败退避（ms；连续失败按序取，封顶 60s） */
		var NOTICE_BACKOFF = [5000, 15000, 60000];
		/** 活动驱动刷新的节流（ms）+ 尾随刷新延迟（覆盖命令类条目的写入时机） */
		var NOTICE_TOUCH_THROTTLE_MS = 400;
		var NOTICE_TOUCH_TRAIL_MS = 700;
		var NOTICE_SCHEMA_VERSION = 1;
		var NOTICE_ROLES = ["banner", "notice", "status"];
		var NOTICE_STATES = ["running", "ok", "warn", "error", "info"];
		var NOTICE_REQUIRED = ["schemaVersion", "sessionId", "source", "role", "kind", "state", "text", "at"];

		var storeState = {
			sessionId: null,
			// S3（obs#3）：**锚点表的会话维度** —— 锚点按 seq 登记（下表），但归属必须绑会话，
			//   否则切会话后旧会话的锚点/旧卡继续参与渲染（实测：切会话后面板数到两套叠加 16 张）。
			anchorSession: null,
			entries: [], byKey: {}, keys: [],
			dropped: null, localDropped: { missing: {}, badSchema: 0, oversized: 0 },
			degraded: false, reason: "", failures: 0, lastFetch: 0, inFlight: null,
			anchored: {}, anchorList: [], lastSeq: -1,
			// obs#3 修法①：**身份对齐表**（turn → 该回合锚点 seq，优先 turn/end 即回合末；无则 turn/start）
			turnAnchor: {},
			// obs#3 修法②（#A70 一 (b1)/(b2)）：**渲染节点头登记表**（seq → time）——由「宿主建节点」与
			//   「已挂载组件」两侧登记，**不随会话切换清空** ⇒ 清表后仍能按条目重挂（不依赖宿主回放）。
			anchorNodes: {},
			// obs#3 段R ②（D2 ①）：**已挂载渲染**的锚点 seq 集（由锚点组件 effect 登记；故障注入隐藏者不登记）
			//   ⇒ 用来机械判定「锚点在 universe 内、条目也承载其上、却无卡」（= 台账 #34 ①"加载了却看不到"）。
			anchorMounted: {},
			// ★`#A72` 步1：**当前仍挂载**的锚点 seq ⇒ 引用计数（`anchorMounted` 是 sticky、**不能**用来判"此刻谁在"）。
			//   用途：尾锚点兜底 ── 回合结束后宿主新锚点（`turn/end`）被 `storeAnchorUniverse()` 观测到，
			//   但**未必有 banner 载体**（`odAnomaly` 的 `pending-mismatch` 同源判定）⇒ 旧口径"宇宙尾 == 本节点 watch"
			//   **全为假** ⇒ 状态卡块（含全局落位异常卡）**整块不渲染**（用户实测：干活时有、回复完成即消失）。
			anchorLive: {},
			// obs3S7 段W-2a **T2-b 件D**（设计稿 §5.2/§5.3）：**② 索引面**（`notice/list` 的 `want` 追加字段）。
			//   A **只按 ② 给的落点渲染**：`unplaced[]` 的 `cardId` ⇒ **不进任何行**（渲染到"未定位区"）；
			//   `slots[].seq` ⇒ 权威落点集合（`anchorSeq` 命中它才算 placed）。`indexDegraded` 非 false ⇒
			//   **如实降级**（② 不可读 ⇒ 退回既有 ①②③④ 顺序，不假绿）。
			spatial: { on: false, slots: [], unplaced: [], counters: null, orderHash: null,
				indexDegraded: false, at: 0, reports: 0, lastReportSeq: null, lastReportAt: 0, reportSkipped: 0,
				// ★批16（`#78`）：**本次渲染实际算出的"可渲染未定位数"**（＝未定位区头行 `upN`，由
				//   `nsUnplacedRenderable()` 这一处算出）⇒ 回报 `RENDER.unplacedRenderable` 直接复用它
				//   （**绝不在第二处再算一遍**；`#77` 的成因就是"对齐侧算一次、渲染侧再滤一次"）。
				//   `null` = 尚未渲染 / 未取到 ⇒ 回报不带该键（老口径回退）。
				upNRenderable: null,
				// ★ 防串会话：记录"这个 `upN` 属于哪个会话" —— 只有 `=== 当前 sessionId` 才可上报
				//   （切会话/清快照时旧值不得被当成本会话读数；宁可 `null` 回退，也不跨会话串数）。
				upNRenderableSid: null,
				// obs3S7 段W-2b `(a)(b)`：**状态卡三 kind**（`alert`/`degrade`/`session`；F2 分区）＋ 观测七项读数
				//   —— **形状恒在、值可为空**（缺键 ⇒ 空数组 ⇒ 区块不渲染）
				stateCards: [] }
		};
		/** 段 2 修复③：渲染开关状态（autoOff = 异常自动关闭；overLimit/errors = 计数，供面板/测试读取） */
		var storeRenderState = { autoOff: false, reason: "", overLimit: 0, fetchErrors: 0,
			// obs#3 修法①（#A60 三 优先级：**不消失 ＞ 位置 ＞ 性能**）：**降级 ≠ 关闭**
			//   —— 锚点超限 / 取数连续失败只降"位置精度"，**卡片必须仍可见**（禁止以静默全黑作降级手段，ENV 准入三条②）。
			degraded: false, degradeReason: "", tailAssigned: 0,
			// ★ `#A29`：**面板点名**串（`""` = 健康 ＝ 面板不渲染该行）；取值只由 `storeAlignAll()` 一处写。
			hint: "" };
		var STORE_SUBSCRIBERS = 0;
		var storeWarnTierAt = { last: 0 };   // ★A24：session-id-unavailable 的 warn 节流（同一分钟一次）
		var storeDebounceTimer = null;
		var storeSubs = [];
		var storeTimer = null;
		var storeVisibilityBound = false;
		var storeTrailTimer = null;

		function notifyStore() {
			var subs = storeSubs.slice();
			for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) { /* 订阅者异常隔离 */ } }
		}
		/** 订阅 store 快照变化（组件用；返回退订函数）。**订阅数 = 取数的唯一驱动**（段 2 修复①） */
		function subscribeStore(fn) {
			storeSubs.push(fn);
			STORE_SUBSCRIBERS = storeSubs.length;
			try { storeSubscribersChanged(); } catch (e) { /* 订阅层异常不影响宿主 */ }
			return function () {
				var i = storeSubs.indexOf(fn);
				if (i >= 0) storeSubs.splice(i, 1);
				STORE_SUBSCRIBERS = storeSubs.length;
				try { storeSubscribersChanged(); } catch (e) { /* 忽略 */ }
			};
		}
		/** ★A24（2026-11-14）：0.2.2 的会话身份**主源** ＝ 槽/节点 props 给出的 `sessionId`
		 *  （`HistoryTurnTail` 的 `props.sessionId` 已现场证明可用，见 `:606` 邻域注释）。
		 *  §g 目的与背景（要解决或预防的问题）：本函数旧实现**只读 0.1.2 面**
		 *  `ctx.get("sessions").list.getSnapshot().current`；而 0.2.2 的 `sessions` 服务换成 session-controller
		 *  （`ISessions.list: ObservableSnapshot<SessionListState>`，且 `SessionListState` **无 `current`**）
		 *  ⇒ 本函数恒 `null` ⇒ `storeRefresh(null)` 在首行提前返回 ⇒ **store 取数链从未启动** ⇒
		 *  活卡 **0 张且无任何提示**（`#A22` 实测：34 条请求里 `notice/list` **0 次**、DOM `data-notice*` **0 个**）。
		 *  按用户口径「**老的逻辑最好还是保留，除非都转换成新的，不然防止出问题**」⇒ 实现为**三级取**：
		 *  ① props 缓存（0.2.2 主源）→ ② `sessions` 服务的 `scopeOf(ctx)` 面（防御式：缺失/抛错一律不计）
		 *  → ③ **旧面原样、逐字保留**（0.1.2 行为一字不变）。三级全取不到 ⇒ 由 `storeRefreshCurrent` 出**可见降级**
		 *  （`session-id-unavailable`，禁静默 0 卡：`ENV §一.6★`＋准入 B2）。
		 *  ⚠️ 诊断面：分支命中计数挂在 `window.__DSH_NOTICE_SESSION_TIER__`（**只读诊断，零行为影响**；供 0.1.2 回归证明"旧面真的被走到"）。
		 */
		var sessionPidFromProps = null;   /* ① 槽/节点 props 给出的会话 id（0.2.2 主源；props 值变化即自然覆盖） */
		var sessionTierHit = { p1: 0, p2: 0, p3: 0 };
		function noteSessionTier(k) {
			try {
				sessionTierHit[k] = (sessionTierHit[k] || 0) + 1;
				if (typeof window !== "undefined") window.__DSH_NOTICE_SESSION_TIER__ = sessionTierHit;
			} catch (e) { /* 忽略 */ }
		}
		function noteSessionIdFromProps(sid) {
			try {
				if (typeof sid === "string" && /^session-[0-9a-z-]{8,}$/i.test(sid) && sid !== sessionPidFromProps) sessionPidFromProps = sid;
			} catch (e) { /* 忽略 */ }
		}
		/** 当前会话 id（三级取；**旧 0.1.2 分支一字未删**） */
		function currentSessionId() {
			// ① 0.2.2 主源：槽/节点 props（`HistoryTurnTail` 每次渲染都回报）
			if (sessionPidFromProps) { noteSessionTier("p1"); return sessionPidFromProps; }
			// ② 0.2.2 次源：`sessions` 服务的 scope 面（`ISessions.scopeOf(ctx)`；缺失/抛错 ⇒ 落到 ③）
			try {
				var svc2 = pluginCtx && pluginCtx.get ? pluginCtx.get("sessions") : null;
				if (svc2 && typeof svc2.scopeOf === "function") {
					var sid2 = svc2.scopeOf(pluginCtx);
					if (typeof sid2 === "string" && sid2) { noteSessionTier("p2"); return sid2; }
				}
			} catch (e2) { /* 忽略：0.1.2 无此面 */ }
			// ③ 旧面（0.1.2；**逐字保留** —— 原三行原样移入 `legacyCurrentSessionId()`，一字未改）
			var l3 = legacyCurrentSessionId();
			if (l3) noteSessionTier("p3");
			return l3;
		}
		/** 旧面（0.1.2）—— **逐字原样**（A24 只把它抽成函数以保持三级取结构；三行内容一字未改） */
		function legacyCurrentSessionId() {
			try {
				var svc = pluginCtx && pluginCtx.get ? pluginCtx.get("sessions") : null;
				var snap = svc && svc.list && typeof svc.list.getSnapshot === "function" ? svc.list.getSnapshot() : null;
				var cur = snap && snap.current;
				return cur ? String(cur) : null;
			} catch (e) { return null; }
		}
		/** 条目身份键 —— **按 kind 分类**（obs#3 段M · 仲裁 #A85 二 定稿）：
		 *  · **回合类 = `{status, ledger}`** ⇒ 键 = `source|kind|turn`（**一字不改**：每回合一张；同回合取最新 = replace）。
		 *  · **其余（命令类：`cost` / `costs` / `balance` / `notify` / `error` / `restart` …）**
		 *    ⇒ 键 = `source|kind|<ctxKey || ("t"+turn) || "-">|rev` ⇒ **每次命令 / 每次发射各成一张**
		 *    （`rev` 参与 ⇒ **同回合两次命令不再被合并**；分片实测同回合两次 `cost` 的 `rev` 不同、`ctxKey` 相同）。
		 *  ⚠️ 旧的 `dsh-notice-fold-ctxkey` 开关（S3 试验；实测 inert）**已被本条取代**（见 docs/plugins/dsh-notice-banner.md）。 */
		function storeEntryKey(e) {
			var kindKey = String(e.kind);
			if (kindKey !== "status" && kindKey !== "ledger") {
				var ident = (typeof e.ctxKey === "string" && e.ctxKey) ? e.ctxKey : (e.turn == null ? "-" : ("t" + String(e.turn)));
				return String(e.source) + "|" + kindKey + "|" + ident + "|" + (e.rev == null ? "-" : String(e.rev));
			}
			return String(e.source) + "|" + kindKey + "|" + (e.turn == null ? "-" : String(e.turn));
		}
		/** **锚点会话维度开关**（S3 新增；默认**开**）：`localStorage["dsh-notice-anchor-session-scope"]="0"` ⇒ 关闭清空
		 *  ⇒ 用于**反向验证**（"去掉会话维度 ⇒ 切会话仍在"必须变红）。 */
		function anchorSessionScopeOn() {
			try { return window.localStorage ? window.localStorage.getItem("dsh-notice-anchor-session-scope") !== "0" : true; } catch (e) { return true; }
		}
		/** **② 渲染开关**（obs3S7 段W-2a T2-b 件D；设计稿 §6.3 **L-a 回滚位**）：
		 *  `localStorage["dsh-notice-legacy-render"]="1"` ⇒ **按旧规则渲染**（忽略 ② 的 `slots/unplaced`，
		 *  逐字走装前的 ①②③④ 顺序）—— 用户已同意的回退位，**稳定后删除**。
		 *  ⚠️ 判据（§6.3 L-a）：开关 ON ⇒ `cardsOrdered` 必须**逐字等于装前值**。 */
		function storeSpatialOn() {
			try { return window.localStorage ? window.localStorage.getItem("dsh-notice-legacy-render") !== "1" : true; } catch (e) { return true; }
		}
		/** ② 里被 B 判为**未定位**的 `cardId` 集（只认非空字符串键；`null` = 旧卡无身份 ⇒ 不参与，走回退链） */
		function storeUnplacedIds() {
			var s = storeState.spatial;
			if (!s || s.on !== true || s.indexDegraded !== false) return null;
			var set = {};
			var arr = Array.isArray(s.unplaced) ? s.unplaced : [];
			for (var i = 0; i < arr.length; i++) {
				var id = arr[i] && typeof arr[i].cardId === "string" ? arr[i].cardId : null;
				if (id) set[id] = String(arr[i].reason || "unplaced");
			}
			return set;
		}
		/** ② 里**行身份**的 seq 集（权威落点；`slotId` 的 seq 与宿主事件 seq 同源 ⇒ 用它判"行到底存不存在"） */
		function storeSlotSeqSet() {
			var s = storeState.spatial;
			if (!s || s.on !== true || s.indexDegraded !== false) return null;
			var set = {};
			var arr = Array.isArray(s.slots) ? s.slots : [];
			for (var i = 0; i < arr.length; i++) { var sq = arr[i] && arr[i].seq; if (typeof sq === "number" && isFinite(sq)) set[sq] = 1; }
			return set;
		}
		/** ★T-A/T-B（2026-09-21 obs3S7；用户已签）：**② 每卡 `slotId` ⇒ 承载行 `seq`** 映射（**B 是权威方**；
		 *  形状冻结 = `${kind.length}:${kind}${id}`（`T-D` 手册 §「`slotId` 语义冻结」）；② 不可读/降级 ⇒ `null`
		 *  ⇒ 调用方按"如实 `pending`"处理（**不猜、不落它处**）。 */
		function storeSlotIdSeq() {
			var s = storeState.spatial;
			if (!s || s.on !== true || s.indexDegraded !== false) return null;
			var map = {};
			var arr = Array.isArray(s.slots) ? s.slots : [];
			for (var i = 0; i < arr.length; i++) {
				var it = arr[i];
				if (!it || typeof it.slotId !== "string" || !it.slotId) continue;
				if (typeof it.seq === "number" && isFinite(it.seq)) map[it.slotId] = it.seq;
			}
			return map;
		}
		/** 自诊断快照（S3 排查用；默认关）：`localStorage["dsh-notice-debug"]="1"` ⇒ 把关键计数写回
		 *  `localStorage["dsh-notice-debug-state"]`（供 U2_EVAL 读取）——回答"旧节点有没有被重新渲染"。 */
		var noticeDbg = { viewCalls: 0, hidden: 0, hiddenSeq: [], lastSid: null };
		function noticeDebugOn() {
			try { return window.localStorage ? window.localStorage.getItem("dsh-notice-debug") === "1" : false; } catch (e) { return false; }
		}
		function noticeDebugFlush() {
			try {
				if (!noticeDebugOn() || !window.localStorage) return;
				window.localStorage.setItem("dsh-notice-debug-state", JSON.stringify({
					viewCalls: noticeDbg.viewCalls, hidden: noticeDbg.hidden, hiddenSeq: noticeDbg.hiddenSeq.slice(-8),
					anchorSession: storeState.anchorSession, storeSession: storeState.sessionId,
					anchorListLen: (storeState.anchorList || []).length, lastSid: noticeDbg.lastSid,
					odWantUnsound: odBk.wantUnsound, odAnchorMiss: odBk.anchorMiss, odCacheDrop: odBk.cacheDrop, odCold: odBk.cold, odExpandBuilt: odBk.expandBuilt   /* 段U4 U5a · 段U9 L1 */
				}));
			} catch (e) { /* 忽略 */ }
		}
		/** **节点会话归属校验开关**（S3 新增；默认**开**）：`localStorage["dsh-notice-node-session-guard"]="0"`
		 *  ⇒ 关闭 ⇒ 旧会话的节点继续渲染（用于**反向验证**："去掉归属校验 ⇒ 切会话仍在"必须变红）。 */
		function nodeSessionGuardOn() {
			try { return window.localStorage ? window.localStorage.getItem("dsh-notice-node-session-guard") !== "0" : true; } catch (e) { return true; }
		}
		/* 2026-10-21 (`#26`/`A5-8`): 删掉本处的折叠开关读取函数（localStorage 键 `dsh-notice-fold-ctxkey`）。
		   前因：该开关 2026-09-15 已被上方 `storeEntryKey` 的联合口径取代，函数成死代码 —— 删除前现读
		   `grep -c` 全文 **1**（仅自身定义、0 调用点），且此键无其它读方。删后真源与在役出现差、**未装机**
		   （派单"只改码不装机"）；差与读数已登记 `docs/plugins/dsh-notice-banner.md` 与事实台账。 */
		/** 客户端侧逐条校验（**per-emitter 隔离**：坏条只丢自己 + 计数，绝不影响其它条） */
		function validateStoreEntry(raw) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "badSchema" };
			for (var i = 0; i < NOTICE_REQUIRED.length; i++) {
				if (raw[NOTICE_REQUIRED[i]] === undefined) return { ok: false, reason: "missing", key: NOTICE_REQUIRED[i] };
			}
			if (raw.schemaVersion !== NOTICE_SCHEMA_VERSION) return { ok: false, reason: "badSchema" };
			if (raw.sessionId !== null && typeof raw.sessionId !== "string") return { ok: false, reason: "badSchema" };
			for (var j = 0; j < ["source", "role", "kind", "state", "text"].length; j++) {
				var k = ["source", "role", "kind", "state", "text"][j];
				if (typeof raw[k] !== "string") return { ok: false, reason: "badSchema" };
			}
			if (typeof raw.at !== "number" || !isFinite(raw.at)) return { ok: false, reason: "badSchema" };
			if (NOTICE_ROLES.indexOf(raw.role) < 0) return { ok: false, reason: "badSchema" };
			if (NOTICE_STATES.indexOf(raw.state) < 0) return { ok: false, reason: "badSchema" };
			return { ok: true, entry: raw };
		}
		/** 可见性（`ttlMs` 过期 ⇒ 不渲染；**不删档** —— 设计稿 §3 清理规则②） */
		function storeVisible(e, now) {
			if (typeof e.ttlMs !== "number" || !isFinite(e.ttlMs)) return true;
			return now < (typeof e.at === "number" ? e.at : 0) + e.ttlMs;
		}
		function countLocalDrop(reason, key) {
			if (reason === "missing" && key) {
				storeState.localDropped.missing[key] = (storeState.localDropped.missing[key] || 0) + 1;
			} else storeState.localDropped.badSchema += 1;
		}
		/** ★批9 `B1`（`#A394` 段2；依据段0b 四臂 **VM 真渲染实证**：只有"＋别名回落"能修好「混态拆两张」）。
		 *  **渲染层 `cardId` 优先 ＋ 旧键别名回落**（与 store 侧 `ADOPT_KINDS` 现行口径一致）：
		 *    · 该条目**自带 `cardId`** ⇒ 键 = `card|<cardId>`（身份由 `cardId` 承担）；
		 *    · 否则看 `source|kind|<ident>` 前缀内**恰有 1 个** `cardId` 候选 ⇒ 并到 `card|<该 cardId>`；
		 *    · **0 个** ⇒ 无孪生 ⇒ **保留旧键**；**>1 个** ⇒ **歧义不猜** ⇒ **保留旧键**（不猜 = 不放大）。 */
		function aliasKeyOf(e, legacyKey, entries) {
			if (typeof e.cardId === "string" && e.cardId) return "card|" + e.cardId;
			var parts = String(legacyKey).split("|");
			if (parts.length < 4) return legacyKey;
			var prefix = parts.slice(0, 3).join("|"), hits = [];
			for (var i = 0; i < entries.length; i++) {
				var f = entries[i];
				if (!f || typeof f.cardId !== "string" || !f.cardId) continue;
				if (storeEntryKey(f).split("|").slice(0, 3).join("|") === prefix) hits.push(f.cardId);
			}
			return hits.length === 1 ? ("card|" + hits[0]) : legacyKey;
		}
		/** 应用一次取数结果（纯本地、同步、永不 throw） */
		function applyStoreEntries(entries, sessionId) {
			var now = Date.now();
			/* ★`#A65` 修：**版本号必须在本函数末尾（数据真正落库之后）再 +1** ——
			 *   原来在函数顶部 +1，而本函数有**两次 `notifyStore()`**（第一次在落库前给"锚点重算"用）：
			 *   第一次通知里订阅者按**旧 storeState** 建了回合级缓存（key=新的 rev）⇒ 第二次通知（数据已落库）
			 *   命中同一 rev 的**陈旧缓存** ⇒ 本轮新增的 `turn=null` 卡（restart/queue）永远进不了 `"?"` 桶
			 *   ⇒ 只走 node 槽、落在宿主折叠容器里，界面「折叠/展开都不显示」（`#A65` 现读实测：in18/out18
			 *   但桶里只有 12 条、`"?"` 只剩 compat）。⇒ 版本号后移（见下 `storeRev += 1`）。 */
			odDeclaredRebuild(entries, sessionId);   // ★ (丙-lite) ②：卡声明面（`anchorSeq` 集）随条目集合重算
			var byKey = {};
			for (var i = 0; i < entries.length; i++) {
				var v = validateStoreEntry(entries[i]);
				if (!v.ok) { countLocalDrop(v.reason, v.key); continue; } // per-emitter 隔离: 坏条只丢自己
				var e = v.entry;
				if (!storeVisible(e, now)) continue;                     // ttlMs 过期 ⇒ 空气（不删档）
				var k = storeEntryKey(e);
				k = aliasKeyOf(e, k, entries);   // ★批9 `B1`：`cardId` 优先 ＋ 旧键别名回落（同前缀恰 1 候选才回落）
				var cur = byKey[k];
				if (!cur || (typeof e.at === "number" ? e.at : 0) >= (typeof cur.at === "number" ? cur.at : 0)) byKey[k] = e;
			}
			var keys = Object.keys(byKey).sort(function (a, b) {
				var ea = byKey[a], eb = byKey[b];
				var d = ((ea && ea.at) || 0) - ((eb && eb.at) || 0);
				if (d !== 0) return d;
				var sa = ((ea && ea.source) || "") + "|" + ((ea && ea.kind) || "");
				var sb = ((eb && eb.source) || "") + "|" + ((eb && eb.kind) || "");
				return sa < sb ? -1 : sa > sb ? 1 : 0;
			});
			try {
				/* ★`#A65` 诊断面（只读）：本趟落库的 kind 分布 ＋ 本地丢弃计数（定位 restart/queue 消失在哪一步）。 */
				var __kinds = {};
				for (var __i2 = 0; __i2 < keys.length; __i2++) { var __ee = byKey[keys[__i2]]; if (!__ee) continue; __kinds[String(__ee.kind || "?")] = (__kinds[String(__ee.kind || "?")] || 0) + 1; }
				window.__DSH_NOTICE_APPLY__ = { rev: storeRev, inN: (entries && entries.length) || 0, outN: keys.length, kinds: __kinds, localDropped: JSON.parse(JSON.stringify(storeState.localDropped || {})) };
			} catch (eA) { /* 忽略 */ }
			notifyStore(); // 条目集合变化 ⇒ 已挂载的锚点节点重算归属
			if (storeState.sessionId !== sessionId) seqTurnCache = {};   /* ★`#A66`：换会话 ⇒ 反查缓存作废 */
			storeState.sessionId = sessionId;
			storeState.entries = entries;
			storeState.byKey = byKey;
			storeState.keys = keys;
			storeState.degraded = false;
			storeState.reason = "";
			storeRev += 1;   /* ★`#A42`/`#A65`：**落库之后**再 +1 ⇒ 回合级映射缓存只在数据就绪时失效重算 */
			notifyStore();
			// obs#3 段R C1/C2：① 把本趟「**有卡锚点集合**」写缓存（供下次**热载**按需过滤）
			//   ② 保活订阅复评（锚点订阅数为 0 ⇒ 挂上，保证**取数不停摆**）
			odPersist();
			odKeepAliveEnsure();
		}
		/** 取数（经既有 `/host-compat` → `notice/list`；失败 ⇒ 计数 + 静默，旧快照保留） */
		function storeRefresh(sessionId) {
			if (!sessionId) { storeState.sessionId = null; storeState.byKey = {}; storeState.keys = []; return Promise.resolve(); }
			if (storeState.inFlight) return storeState.inFlight;
			// obs3S7 段W-2a T2-b 件D（设计稿 §5.2）：**只增字段** —— 带 `want` 时端点**追加** 5 键
			//   （`slots/unplaced/counters/orderHash/indexDegraded`）；**回退位 ON ⇒ 不带 `want`**
			//   ⇒ 端点逐字返回旧四键（= 装前请求形状，`L-a` 判据的另一半）。
			var spatialOn = storeSpatialOn();
			var req = { sessionId: sessionId };
			if (spatialOn) req.want = { slots: true, unplaced: true, counters: true, stateCards: true };
			storeState.inFlight = compatRpc("notice/list", req).then(function (raw) {
				storeState.inFlight = null;
				// ★A24-2（2026-11-14，**同件第二断点**）：**拆包** —— 0.2.2 的 `/host-compat` 返回**双层信封**
				//   `{ok:true,value:{ok:true,value:{entries…}}}`（与 `notice/history` 同形，那边早已用 `histUnwrap` 拆）。
				//   §g 目的与背景：不拆 ⇒ 旧判断 `res.ok === true && res.value` **通过**，但 `res.value.entries` 是
				//   **undefined** ⇒ `applyStoreEntries([])` ⇒ **数据已到客户端却从不落地** ⇒ 界面恒 0 卡
				//   （实测：`notice/list` 响应体含 `entries[0…]` 且 `placeState:"placed"`，DOM 仍 0 张）。
				//   拆包对**单层（0.1.2）** 与 **双层（0.2.2）** 归一为"载荷对象" ⇒ 旧分支语义不变（`ENV §一.6★`：禁静默）。
				var res = histUnwrap(raw);
				var shapeOk = !!(res && typeof res === "object" && res.ok !== false &&
					(res.entries !== undefined || res.dropped !== undefined || res.schemaVersion !== undefined || res.degraded !== undefined));
				if (!shapeOk) {
					storeState.failures += 1; storeState.reason = "rpc";
					storeRenderState.fetchErrors += 1;
					// obs#3 修法①（#A60 三）：连续失败 ⇒ **降级不关闭**（旧快照继续渲染 ⇒ 卡片不消失；位置可能过期）
					if (storeState.failures >= 3) { storeRenderState.degraded = true; storeRenderState.degradeReason = "fetch-failed"; }
					return;
				}
				var v = res;
				if (v.degraded === true) { storeState.failures += 1; storeState.degraded = true; storeState.reason = String(v.reason || "degraded"); return; }
				storeState.failures = 0;
				storeState.dropped = v.dropped || null;
				storeState.lastFetch = Date.now();
				applyStoreSpatial(v, spatialOn);
				applyStoreEntries(Array.isArray(v.entries) ? v.entries : [], sessionId);
			}).catch(function () { storeState.inFlight = null; storeState.failures += 1; });
			return storeState.inFlight;
		}
		/** ② 索引面落地（T2-b 件D）：**形状恒在、值可为空**；缺键/不可读 ⇒ **如实标降级**（不假绿）。
		 *  ⚠️ `want` 未被服务端识别（老服务端）⇒ 5 键**一个都没有** ⇒ 按"② 不可读"处理（`indexDegraded`）。 */
		function applyStoreSpatial(v, spatialOn) {
			var s = storeState.spatial;
			s.on = spatialOn === true;
			if (s.on !== true) { s.slots = []; s.unplaced = []; s.counters = null; s.orderHash = null; s.indexDegraded = false; odRegIngest(null, currentSessionId()); odRegDegraded = odRegReason(); return; }
			var hasAny = v && (Array.isArray(v.slots) || Array.isArray(v.unplaced) || v.counters != null || typeof v.indexDegraded === "string");
			s.slots = v && Array.isArray(v.slots) ? v.slots : [];
			// ★ (丙-lite) ①：**登记面**（只增不删）—— 每趟 `slots` 全量 `seq` 入登记表；降级原因如实记录（不静默）
			odRegIngest(s.slots, currentSessionId()); odRegDegraded = odRegReason();
			s.unplaced = v && Array.isArray(v.unplaced) ? v.unplaced : [];
			s.counters = v && v.counters && typeof v.counters === "object" ? v.counters : null;
			s.orderHash = v && typeof v.orderHash === "string" ? v.orderHash : null;
			s.indexDegraded = hasAny ? (typeof v.indexDegraded === "string" && v.indexDegraded ? v.indexDegraded : false) : "want-unsupported";
			// `(a)(b)`：状态卡（**形状恒在、值可为空**；老服务端不给该键 ⇒ 空 ⇒ 不渲染区块，逐字同现状）
			s.stateCards = v && Array.isArray(v.stateCards) ? v.stateCards : [];
			s.at = Date.now();
		}
		/** 状态卡集合（**只读**；`kind` 分区在渲染处做） */
		function storeStateCards() {
			var s = storeState.spatial;
			if (!s || s.on !== true || s.indexDegraded !== false) return [];
			return Array.isArray(s.stateCards) ? s.stateCards : [];
		}
		/** `(e)④`：② 判为**会话级卡**（(ii) 类）的 `cardId` 集 ⇒ **不进任何行、也不进未定位区**
		 *  （由状态卡区块承载；**不静默**：区块里如实列出）。 */
		function storeSessionCardIds() {
			var cards = storeStateCards();
			var set = {};
			for (var i = 0; i < cards.length; i++) {
				var c = cards[i];
				if (!c || String(c.kind) !== "session") continue;
				var ids = Array.isArray(c.cardIds) ? c.cardIds : [];
				for (var j = 0; j < ids.length; j++) if (typeof ids[j] === "string" && ids[j]) set[ids[j]] = 1;
			}
			return set;
		}
		/** §1.5 显示开关：`localStorage["dsh-notice-statecards"]` = `"global"`（**默认**）｜`"session"`。
		 *  **只过滤 `kind:"alert"`**；`"degrade"` 与 `"session"` **一律显示**（不受开关影响）。 */
		function storeStateCardMode() {
			try {
				var v = window.localStorage ? window.localStorage.getItem("dsh-notice-statecards") : null;
				return v === "session" ? "session" : "global";
			} catch (e) { return "global"; }
		}
		/* #37-KINDCOUNT-BEGIN */
		/** ★ 批4 `#37`（范围「乙」；**只增键、只观测、不进 `result`、不上屏、不降级**）——
		 *  **按卡类型（`data-family`）分桶**的读数量。
		 *  · **白名单单一来源** = 上方 `NOTICE_FAMILY_KINDS`（与甲-0 折叠保留 CSS **同一常量**）。
		 *  · **过滤谓词与 `cardsPanel` 完全相同**：`祖先链无 hidden 属性 ∧ el.getClientRects().length > 0`；
		 *    祖先走链由调用方算一次（`hid`）后传入 ⇒ 两者**不可能不同源**。
		 *  · `ids` ≤ `KIND_IDS_MAX`（超出 ⇒ 截断 ＋ `idsTruncated:true`，防 ① 记录膨胀）；
		 *    `noId` = 该 kind 中 `data-notice-card-id === ""` 的张数（**如实上报身份覆盖边界，不藏** `ENV §一.6②`）。
		 *  · ⚠️ **已知低报（如实登记、禁静默）**：折叠开关【开】时 `FOLDKEEP_CSS` 用
		 *    `display:block !important` 把带 `hidden` 的包裹层**重新显示**，而本谓词**遇 `hidden` 即判不可见**
		 *    ⇒ 此时 `kindPanel[kind].n` **系统性偏小**、这部分被计入 `kindFolded`。
		 *    开关态只在客户端 `localStorage`、B 侧**不可独立复核** ⇒ 由 VM 场 A4 臂专测（交接件 §6）。
		 *  · 语义三分（**不假红**）：可见 ⇒ `kindPanel`；**有折叠成因** ⇒ `kindFolded`（**不算缺陷**）；
		 *    **节点已挂载且无折叠成因却不可见** ⇒ `kindUnshown`（**真缺** ⇒ **会计红的告警信号**，
		 *    边界判据 `健康会话 ⇒ kindUnshown 全键 == 0`）。两键都落盘、都 `grep` 得到、都不许藏。 */
		function kindBucketsInit() {
			var kp = {}, kf = {}, ku = {};
			for (var ki = 0; ki < NOTICE_FAMILY_KINDS.length; ki++) {
				kp[NOTICE_FAMILY_KINDS[ki]] = { n: 0, ids: [], noId: 0 };
				kf[NOTICE_FAMILY_KINDS[ki]] = 0;
				ku[NOTICE_FAMILY_KINDS[ki]] = 0;
			}
			return { kp: kp, kf: kf, ku: ku };
		}
		/** `ids` 上限（超出截断并置 `idsTruncated:true`） */
		var KIND_IDS_MAX = 8;
		/** 把**一个**已匹配 `[data-notice-banner]` 的节点并入分桶。
		 *  @param acc `kindBucketsInit()` 的返回对象（**原地累加**）
		 *  @param el  节点
		 *  @param hid 祖先链上是否出现 `hidden`（**由调用方以与 `cardsPanel` 同一循环算出**，此处不重走） */
		function kindBucketOf(acc, el, hid) {
			var fam = null;
			try { fam = el && el.getAttribute ? el.getAttribute("data-family") : null; } catch (eF) { fam = null; }
			if (typeof fam !== "string" || !Object.prototype.hasOwnProperty.call(acc.kp, fam)) return;   /* 非白名单 kind ⇒ 不出键 */
			var bucket = acc.kp[fam];
			var drawn = false;
			try { drawn = el.getClientRects().length > 0; } catch (eR) { drawn = false; }
			if (!hid && drawn) {
				bucket.n += 1;
				var cid = "";
				try { cid = el.getAttribute("data-notice-card-id") || ""; } catch (eC) { cid = ""; }
				if (cid === "") bucket.noId += 1;
				else if (bucket.ids.length < KIND_IDS_MAX) bucket.ids.push(cid);
				else bucket.idsTruncated = true;
			} else if (hid) {
				acc.kf[fam] += 1;   /* 折叠成因：不算缺陷 */
			} else {
				acc.ku[fam] += 1;   /* 真缺：告警信号 */
			}
		}
		/* #37-KINDCOUNT-END */
		/** 渲染回报（T2-b 件D；设计稿 §5.2）：A **绝不写文件**（doctrine R1）⇒ 经**既有** `/host-compat` 路由回报；
		 *  端点只把它折成 ① 的一条 `RENDER` 记录（**不改分片、不改 ②**）。失败 ⇒ 只计数（不 throw、不影响渲染）。 */
		function storeReportRender(p, sidOverride) {
			try {
				var sid = sidOverride || storeState.sessionId;
				if (!sid) return;
				// ★ `#A248` 四：记下**最近一次载荷**（供"面板卸载补发 `visible:false`"复用 ⇒ 不用 `null` 造出会污染
				//   `expect/actual/unplaced` 恒等判读的 `RENDER`）。**只在本会话自身上报时记**（`sidOverride` 不覆盖）。
				// ★ 批4 `#37`（范围「乙」）：**同批把三个新键也存进 `lastPayload`** —— 否则"面板卸载补发 `visible:false`"
				//   那条 `RENDER`（`:3545`／`:3606` 复用 `lastPayload`）会**缺 `kindPanel`** ⇒ 读数**忽有忽无**（时序型假阴）。
				//   **缺省语义**：未传 ⇒ 存 `null` ⇒ 下游 `store.js` **不写键**（同 `cardsPanel`/`visible`/`counters` 的 T11 口径）。
				if (!sidOverride) storeState.spatial.lastPayload = { expect: p.expect, actual: p.actual, unplaced: p.unplaced, unplacedRenderable: p.unplacedRenderable === undefined ? null : p.unplacedRenderable, cards: p.cards, cardsPanel: p.cardsPanel === undefined ? null : p.cardsPanel, visible: p.visible === undefined ? null : p.visible, kindPanel: p.kindPanel === undefined ? null : p.kindPanel, kindFolded: p.kindFolded === undefined ? null : p.kindFolded, kindUnshown: p.kindUnshown === undefined ? null : p.kindUnshown };
				// ★ T11（段W-2b ③）：**只增两键** `cardsPanel`（DOM 口径：面板内**可见**卡节点数）/`visible`（判别位：
			//   **缺省 = 未知** ⇒ B 不判）；`cards` **不改名**；两键**不纳入 `result`**（`#C5` 只观测）。
			// ★ `T-E′` 前半（2026-09-21 obs3S7 `#A57`；**只增键、只观测**）：把 A 侧**四个定位计数**随 `RENDER` 一起回报
			//   ⇒ 落 B ① 的 `RENDER` 记录（B 原样保存）⇒ **只读可核**（健康会话应为 0）；**不新增 DOM 行、不改任何上屏文案/样式**
			//   （上屏落码须等用户在小预览点头 ⇒ 本件只交可读面）。
			// ★ `#A63` ①：**显式传入优先**（调用点已带 ⇒ 用它）；仅在未传时**兜底现算**（旧调用点/补发路径）。
			var _cntT = (p && p.counters && typeof p.counters === "object" && !Array.isArray(p.counters)) ? p.counters : (function () {
				try { var a = storeAlignAll(); return a ? { pending: a.pending, pendingNoNode: a.pendingNoNode, slotIdHit: a.slotIdHit, newRulesPending: a.newRulesPending } : null; } catch (e) { return null; }
			})();
			compatRpc("notice/render-report", { sessionId: sid, expect: p.expect, actual: p.actual, unplaced: p.unplaced, unplacedRenderable: p.unplacedRenderable === undefined ? null : p.unplacedRenderable, cards: p.cards, cardsPanel: p.cardsPanel === undefined ? null : p.cardsPanel, visible: p.visible === undefined ? null : p.visible, counters: _cntT, kindPanel: p.kindPanel === undefined ? null : p.kindPanel, kindFolded: p.kindFolded === undefined ? null : p.kindFolded, kindUnshown: p.kindUnshown === undefined ? null : p.kindUnshown }).then(function (r) {
					storeState.spatial.reports += 1;
					if (r && r.ok === true && r.value && typeof r.value.seq === "number") storeState.spatial.lastReportSeq = r.value.seq;
				}, function () { storeState.spatial.reports += 1; });
			} catch (e) { /* 回报绝不影响渲染 */ }
		}
		/** 兜底轮询：失败退避 5→15→60s；隐藏即停；`pollMs === 0` 且无失败 ⇒ 不排期 */
		function storeScheduleNext() {
			if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; }
			var hidden = false;
			try { hidden = !!(document && document.hidden); } catch (e) { hidden = false; }
			if (hidden) return;
			var delay = storeState.failures > 0
				? NOTICE_BACKOFF[Math.min(storeState.failures, NOTICE_BACKOFF.length) - 1]
				: NOTICE_POLL_MS;
			if (!(delay > 0)) return;
			storeTimer = setTimeout(function () { storeTimer = null; storeTick(); }, delay);
		}
		/** B①/B②（obs#3，2026-09-15）：**取数对象恒 = 正在查看的会话**；会话一变 ⇒ 先清旧快照再重取重绘。
		 *  现状缺陷（DOM 已复现）：刷新只由 TOUCH/订阅者驱动、**无会话切换监听** ⇒ 切会话后仍渲染旧会话的卡
		 *  （现象②「切会话不重判」/ ③「跨会话搬家」）。本函数为**唯一取数入口**，切换检测在此收口。 */
		var storeSessionBound = false;
		var storeSwitchDegraded = false;
		/** 降级上报（一次性、可见、不刷屏）：状态置 DEGRADED + reason，并让订阅者重渲染 */
		function storeDegraded(reason) {
			try {
				storeState.degraded = true;
				storeState.reason = String(reason || "degraded");
				notifyStore();
				if (typeof debug === "function") debug("store DEGRADED: " + storeState.reason + "（会话切换订阅不可用 ⇒ 退化为轮询）");
				try { if (typeof console !== "undefined" && console.warn) console.warn("[dsh-notice-banner] DEGRADED: " + storeState.reason); } catch (e2) { /* 忽略 */ }
			} catch (e) { /* 绝不上抛 */ }
		}
		function storeRefreshCurrent(force) {
			var cur = currentSessionId();
			// ★A24：三级全取不到 ⇒ **可见降级**（禁"静默 0 卡"：`ENV §一.6★禁静默化`＋准入 B2）。
			//   只在"确有订阅（＝本该取数）"时点名，避免空转刷屏；同一分钟最多 warn 一次。
			if (!cur && STORE_SUBSCRIBERS > 0) {
				storeRenderState.degraded = true;
				storeRenderState.degradeReason = "session-id-unavailable";
				storeState.reason = "session-id-unavailable";
				try {
					var _warnAt = storeWarnTierAt.last;
					var _now = Date.now();
					if (!_warnAt || _now - _warnAt > 60000) {
						storeWarnTierAt.last = _now;
						try {
							if (pluginCtx && pluginCtx.logger && typeof pluginCtx.logger.warn === "function") {
								pluginCtx.logger.warn("[dsh-notice-banner] session-id-unavailable：三级会话身份取值全失败 ⇒ store 取数未启动（活卡不显示，面板点名 session-id-unavailable）");
							}
						} catch (eW1) { /* 忽略 */ }
						try { if (typeof console !== "undefined" && console.warn) console.warn("[dsh-notice-banner] session-id-unavailable（降级可见：活卡暂不显示）"); } catch (eW2) { /* 忽略 */ }
					}
				} catch (eW3) { /* 忽略 */ }
			}
			if (force === true || cur !== storeState.sessionId) {
				if (storeRenderState.degradeReason === "session-id-unavailable") { storeRenderState.degraded = false; storeRenderState.degradeReason = ""; }
				storeState.sessionId = cur;
				storeState.entries = [];
				storeState.byKey = {};
				storeState.keys = [];
				storeRev += 1;   /* ★`#A42`：切会话 ⇒ 回合级映射立即失效（不沿用上一会话结果） */
				// S3（obs#3，根因位）：**清空锚点表** —— 锚点以 seq 登记（client.js storeAddAnchor），
				//   原先唯一重置条件是"seq 回退（窗口重放）"，与会话无关 ⇒ 切会话不重置 ⇒ 旧锚点+旧卡残留。
				//   此处随会话切换清空 + notifyStore()（已挂载节点会按新状态重渲染 ⇒ 旧卡消失）；
				//   ⚠️ 仍**不在 `match()` 里做**（守纯函数约束）。
				if (anchorSessionScopeOn()) {
					storeState.anchorList = [];
					storeState.anchored = {};
					// ⚠️ `anchorMounted` **刻意不清理**（sticky）—— 组件实例在窗口重放/切回时通常**不重新挂载**，
					//    清理会让"已渲染"的锚点被误判为"未渲染" ⇒ 假 `stale-unrendered`。代价 = 同 seq 复用时漏报（登记未覆盖）。
					storeState.anchorSession = cur;
				}
				odKept = 0; odFbUsed = false;   // 段R C1/C2：切会话 ⇒ 本趟按需/保底计数归零
				odPlanDone = false;             // 段R 路线A：**切会话 ⇒ 按需计划作废**（否则新会话锚点会被旧计划裁光）
				odLastAnchorSeq = -1;
				storeState.degraded = false;
				storeState.reason = "";
				notifyStore();
			}
			return storeRefresh(cur);
		}
		function storeTick() {
			try {
				storeRefreshCurrent().then(function () { storeScheduleNext(); }, function () { storeScheduleNext(); });
			} catch (e) { storeScheduleNext(); }
		}
		/* ── 段 2 修复①：取数改由**订阅层**驱动（`match()` 内不再取数、不再有副作用）──────────────
		 * 规则：**有组件订阅才取数**（订阅数 0 ⇒ 零定时器、零请求）；订阅出现时去抖刷新一次 + 700ms 尾随一次，
		 * 之后只靠空闲兜底轮询（`pollMs`，隐藏即停、失败退避）。⇒ 事件再多也不放大请求（事故根因之一）。 */
		function storeSubscribersChanged() {
			if (STORE_SUBSCRIBERS > 0) {
				bindSessionSwitch();              // B①/B②：订阅宿主列表（只读）⇒ 切会话立即重取重绘
				storeDebouncedRefresh();          // 订阅出现 ⇒ 去抖 + 尾随各一次（"尾随一次即可"）
				if (NOTICE_POLL_MS > 0) storeScheduleNext();
				bindStoreVisibility();
			} else {
				if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; }
				if (storeDebounceTimer) { clearTimeout(storeDebounceTimer); storeDebounceTimer = null; }
				if (storeTrailTimer) { clearTimeout(storeTrailTimer); storeTrailTimer = null; }
			}
		}
		/** 去抖刷新（订阅层专用；同一窗口内多次调用只发一次请求 + 一次尾随） */
		function storeDebouncedRefresh() {
			if (storeDebounceTimer) return;
			storeDebounceTimer = setTimeout(function () {
				storeDebounceTimer = null;
				storeRefreshCurrent();
			}, NOTICE_TOUCH_THROTTLE_MS);
			if (!storeTrailTimer) {
				storeTrailTimer = setTimeout(function () {
					storeTrailTimer = null;
					if (STORE_SUBSCRIBERS > 0) storeRefreshCurrent();
				}, NOTICE_TOUCH_TRAIL_MS);
			}
		}
		/** B①/B②（obs#3，2026-09-15）：**会话切换/重连 ⇒ 立即重取重绘**。
		 *  权威触发源 = 宿主 `sessions` 服务的 **`list.subscribe()`**（只读订阅；`list` 快照的 `current` 即"正在查看的会话"）。
		 *  为什么不用 `match()`：段 2 修复① 已把 `match()` 定为**纯函数**（无订阅/无取数/无副作用），不能复活那个副作用。
		 *  面缺失（无 `sessions` / 无 `subscribe`）⇒ **不报 OK，静默降级**到既有"可见性轮询 + 订阅层去抖"。 */
		function bindSessionSwitch() {
			if (storeSessionBound) return;
			try {
				var svc = pluginCtx && pluginCtx.get ? pluginCtx.get("sessions") : null;
				var list = svc && svc.list;
				if (!list || typeof list.subscribe !== "function") {
					// 红线 §一.6②：**降级必须可见**（禁"报 OK 而功能坏"、禁静默半开）⇒ 一次性上报，不刷屏：
					//   ① debug 日志 ② store 状态置 DEGRADED + 原因（组件订阅者可读到）③ 控制台一次性 warn
					if (!storeSwitchDegraded) {
						storeSwitchDegraded = true;
						storeDegraded("session-subscribe-missing");
					}
					return;   // 降级：交给既有轮询
				}
				storeSessionBound = true;
				list.subscribe(function () {
					try {
						var cur = currentSessionId();
						if (cur !== storeState.sessionId) storeRefreshCurrent();
					} catch (e) { /* 忽略：绝不打断宿主 */ }
				});
			} catch (e) { /* 忽略 */ }
		}

		/** 可见性绑定（只绑一次；隐藏即停轮询） */
		function bindStoreVisibility() {
			if (storeVisibilityBound) return;
			storeVisibilityBound = true;
			try {
				document.addEventListener("visibilitychange", function () {
					try {
						if (document.hidden) { if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; } }
						else if (STORE_SUBSCRIBERS > 0) storeTick();
					} catch (e) { /* 忽略 */ }
				});
			} catch (e) { /* 无 document（SSR/测试）⇒ 只靠订阅层 */ }
		}

		/* ---------- 路线 D：**宿主自有事件当锚点**（数据源 = 我们的 store，锚点 = 宿主事件，只读零自写） ----------
		 * 宿主对**每一个**会话事件都会调用所有已注册 def 的 `match`（消费点 `conversation/lib/client.js:847-856`
		 * `dispatchInput` 的 `for (const definition of this.eventDefinitions.entries()) definition.match(event)`），
		 * 无类型白名单 ⇒ 我们直接拿宿主自己的事件当锚点。
		 * **归属规则（确定性、单一所有者）**：条目 `E` 归到「**时间不晚于 `E.at` 的最后一个锚点**」；
		 * 早于全部锚点 ⇒ 归最早锚点；晚于全部锚点 ⇒ 归**最后一个锚点（开放尾）**。
		 * 于是：命令类条目归到紧随其后的 `command/done`、回合类条目归到本回合的 `turn/start`/`step/end`、
		 * 历史条目在窗口重放时各自归到**自己那一回合**的锚点（原位保留，C2 历史语义不动）。
		 * 锚点节点**常驻**（即使当前无条目）：宿主 CSS `.flowItem:empty{display:none}` + 兄弟 margin 规则
		 * 显式排除 `:empty`（`dsh-client-ui-chat` 的 `EvIC1a_column > … :not(.EvIC1a_flowItem:empty) ~ …`）
		 * ⇒ **空节点零布局、零间距**，因此"取数比事件晚到"不再丢卡（组件订阅 store 自行重渲染）。 */
		/* ⚠️ 段 2 修复②：锚点类型**按实测收敛**为低频稳定两类 —— `turn/start`（**每回合至多 1 个**）+ `command/done`（每次命令至多 1 个）。
		 * 依据（段 1 副本实测：9,901 行 / maxSeq 262,018）：`turn/start`=24、`command/done`≈个位数，
		 * 而 **`step/end`=137**（正是"节点/订阅爆炸"的主放大器，**已移除**）；`turn/end`=24 亦**移除**
		 * （其职责由"开放尾归属"承担：晚于最后一个锚点的条目归最后一个锚点，无需额外锚点）。 */
		// obs#3 修法①（2026-09-15 仲裁 #A60 一-3）：加入 **turn/end** —— 气泡/卡片的"身份锚点"（**回合末**）：
		//   宿主 turn/start 与 turn/end 均带 `data.turn`（生产实测），故"按 turn 对齐"有输入可用。
		var STORE_ANCHOR_TYPES = { "turn/start": 1, "turn/end": 1, "command/done": 1, "tool/call": 1 };
		/** 裁顶**优先保留集**（`#A131` §4③）：既有 3 类优先保留、`tool/call` **优先让位**
		 *  （让位者**不落 `pending`**，必须回退到已建锚点渲染 —— 见 `odPlanGet` 的 `yielded` 与 `storeAlignAll` 的 `yieldedFallback`）。 */
		var OD_CORE_TYPES = { "turn/start": 1, "turn/end": 1, "command/done": 1 };
		/** 锚点上限 —— **自 2026-09-17（仲裁 `#A132` §2①）起改为"很宽的保险值"**：
		 *  · 用户口径：**先不为省资源牺牲可见性**（卡顿再说）⇒ 正常会话**不再裁顶**（旧值 12 会把长会话的卡挤进 `pending`）；
		 *  · 仅在**异常兜底**时生效；一旦触发，被让位的卡**必须渲染在最近的已建锚点**（`storeAlignAll` 的重定向），**绝不落 `pending`**；
		 *  · 应急回滚阶梯（部署卡 §2④）：`dsh-notice-od-toolcall="0"`（不把 `tool/call` 入候选、秒级、无需部署）→ 调小本值 → 弹药回退 + 强刷。 */
		var NOTICE_ANCHOR_MAX = 200;
		/** obs#3 段O（#A102 四 ②）：**命令类**条目「`at` 之后最近锚点」的**时间距离上限 Δ**（ms）。
		 *  Δ 依据（生产实测 2026-09-17，会话 35a89553 的 4 条 balance）：命令发射 → **自身** `command/done`
		 *  锚点的 gap = **3 / 6 / 6 / 7 ms**；而「之后最近锚点」若**不相关**则 ≥ **5042 ms**；
		 *  另见「之前最近锚点」backGap = 5312 / 168429 / 11794 / 5042 ms —— **旧语义正是"跑到回合开头"的成因**。
		 *  ⇒ 取 **1000 ms**：对真实情形 **140×** 余量、对误配 **5×** 安全边界；**超限 ⇒ 回退旧语义**。 */
		var CMD_ANCHOR_MAX_GAP_MS = 1000;
		/** 渲染总开关（段 2 修复③）：默认 **开**；异常（超限/抛错/取数失败）⇒ **自动关闭并静默缺席**；
		 *  手动关闭：`localStorage["dsh-notice-store-render"] = "0"`（保留一个版本；免整包回滚）。 */
		var NOTICE_RENDER_DEFAULT = true;
		function storeRenderOn() {
			try {
				if (storeRenderState.autoOff) return false;
				var raw = window.localStorage ? window.localStorage.getItem("dsh-notice-store-render") : null;
				if (raw === "0") return false;
				if (raw === "1") return true;
			} catch (e) { /* 无 localStorage ⇒ 用默认值 */ }
			return NOTICE_RENDER_DEFAULT;
		}
		/** 自动关闭（静默：只记计数，不 throw、不上屏、不打断旧会话日志折叠路径） */
		function storeRenderAutoOff(reason) {
			if (storeRenderState.autoOff) return;
			storeRenderState.autoOff = true;
			storeRenderState.reason = String(reason || "unknown");
		}

		/* ══════════════════════════════════════════════════════════════════════════════════════
		 * obs#3 段R ①（C1–C3）：⑤ 步骤锚点「**两趟按需**」+ 保底（C2）+ 超限**如实计数**（C3）
		 *   依据：段R 设计与报价 §1（`8665219e…`，仲裁采信）＋ 格② VM 实测（`segP2b-vm-scale.md` `6c93ec0c…`）
		 *   **前提（格② 硬结论，不得绕过）**：`match()` 在**宿主派发当刻**跑、而条目取数**尚未发生**（取数由订阅驱动）
		 *     ⇒ **只能两趟**：冷载 **fail-open 全建** 并把「有卡锚点集合」写 `localStorage`；**热载只建该集合**。
		 *     ⇒ **首访仍全量**（如实登记为已知限制；「首访即按需」需改**契约面**（服务端给"有事件的 step 列表"）⇒ C4 不做）。
		 *   **开关（只读自有 `localStorage`；R1：不新增直连宿主、不写宿主数据、加载期 inert）**：
		 *     · `dsh-notice-od-mode`：`"any"`（默认＝按需）｜`"off"`（＝全量旧行为，**应急回滚位**）
		 *     · `dsh-notice-od-drop`：`"<seq,…>"` **故障注入**（强制不建这些锚点 ⇒ 其条目**如实落 pending**）
		 *     · `dsh-notice-od-hide`：`"<seq,…>"` **故障注入**（锚点仍建、节点不渲染 ⇒ 造 D2 ① 态正控）
		 *     · `dsh-notice-od-cache`：缓存本体 `{v,sid,at,want:[seq],anchors:[[seq,time,turn]]}`（本插件自写自有数据）
		 *   **两条硬保证**：**订阅数 ≥1 恒成立**（C2＝保底锚点 ∪ 保活订阅）｜**锚点/订阅 ≤ `NOTICE_ANCHOR_MAX`**。
		 * ══════════════════════════════════════════════════════════════════════════════════════ */
		var OD_CACHE_KEY = "dsh-notice-od-cache";
		var OD_MODE_KEY = "dsh-notice-od-mode";
		var OD_DROP_KEY = "dsh-notice-od-drop";
		var OD_HIDE_KEY = "dsh-notice-od-hide";
		/** 缓存新鲜度上限（超期 ⇒ 视为**冷载** fail-open 全建）；会话 id 不符亦同（防跨会话误裁） */
		var OD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
		/** 缓存锚点表上限（防 localStorage 膨胀；超限丢 seq 最小者） */
		var OD_CACHE_MAX_ANCHORS = 400;
		/** 缓存写入节流（取数频繁时不刷写） */
		var OD_PERSIST_MIN_MS = 5000;
		/** D2 ①（universe 内锚点承载条目却无卡）判定的**挂载宽限**：新建锚点节点到组件挂载之间的窗口不判异常 */
		var OD_GRACE_MS = 1500;
		var odSeen = {}, odSeenN = 0, odSeenMin = -1;
		/* ══ ★ obs3S7 位置轴「已载入行建锚」(丙-lite) ①：**登记面 = 全量行 `seq`**（独立集合） ══
		 *  口径（`ENV §三.18⑩`③ / 插件手册「位置轴与锚面口径」）：**登记面 ≠ 载体/订阅面** ——
		 *   · 登记面 = 每趟 `notice/list` 的 `slots[]` **全量 `seq`** ⇒ **只增不删**、会话变即清、
		 *     **独立于 `odSeen` / `OD_CACHE_MAX_ANCHORS`**（那两个属**缓存加速面**、可丢 seq ⇒ 不得成为登记面的丢 seq 通道）；
		 *   · 载体/订阅面 = 只为「卡声明 `anchorSeq` ∪ 本趟承载卡片的锚点 ∪ 核心边界行」建节点/订阅（`NOTICE_ANCHOR_MAX` 只约束本面）。
		 *  **硬不变量**：**"登记表永不丢 seq"** ⇒ 判据 = 人为删一个 seq ⇒ 该卡必落错 ⇒ 必红。
		 *  ⚠️ 本块**只改自有面**：不碰宿主、不写滚动容器、不新增设置项。 */
		var odRegSeq = {}, odRegN = 0, odRegSid = null, odRegTrips = 0, odRegDegraded = "";
		/** 登记一趟（**只增不删**；会话变 ⇒ 整表清空；`slots` 非数组 ⇒ 只记降级、不动表） */
		function odRegIngest(slots, sid) {
			try {
				if (odRegSid !== sid) { odRegSeq = {}; odRegN = 0; odRegSid = sid; }
				if (!Array.isArray(slots)) return;
				odRegTrips += 1;
				for (var i = 0; i < slots.length; i++) {
					var sq = slots[i] && slots[i].seq;
					if (typeof sq === "number" && isFinite(sq) && odRegSeq[sq] !== 1) { odRegSeq[sq] = 1; odRegN += 1; }
				}
			} catch (e) { /* 登记失败 ⇒ 退化为现状（不上抛、不影响渲染主链） */ }
		}
		/** 登记面命中（`odRegSeq` 的**唯一读点**） */
		function odRegHas(seq) { return typeof seq === "number" && isFinite(seq) && odRegSeq[seq] === 1; }
		/** ★ (丙-lite) ①：**`seqSet` = 「登记表 ∪ 已建锚」** 的**唯一合并点**
		 *  （离线 harness **抽取本函数原文**求值；旧件只认"已建锚" ⇒ 缺锚即回退。`builtSet` 不被改写） */
		function odRegMerge(builtSet) {
			var out = {};
			try {
				for (var k in builtSet) if (Object.prototype.hasOwnProperty.call(builtSet, k)) out[k] = 1;
				for (var s2 in odRegSeq) if (Object.prototype.hasOwnProperty.call(odRegSeq, s2)) out[s2] = 1;
			} catch (e) { return builtSet || {}; }
			return out;
		}
		/** ★ (丙-lite) ③：**如实降级**（登记面不可用的原因；`""` = 可用 ⇒ **不静默**） */
		function odRegReason() {
			try {
				if (!storeSpatialOn()) return "spatial-off";   /* 回退位 ON（`dsh-notice-legacy-render=1`）⇒ 不取行面 */
				var s3 = storeState.spatial;
				if (!s3 || s3.on !== true) return "spatial-off";
				if (s3.indexDegraded !== false) return String(s3.indexDegraded || "index-degraded");
				if (!odRegN) return "no-rows";
				return "";
			} catch (e) { return "error"; }
		}
		/** 卡声明面（**卡声明 `anchorSeq`** 的 seq 集）—— 载体面输入之一；随条目集合变化重算 */
		var odDeclaredSeq = {}, odDeclaredN = 0, odDeclaredSid = null;
		function odDeclaredRebuild(entries, sid) {
			try {
				if (odDeclaredSid !== sid) { odDeclaredSeq = {}; odDeclaredN = 0; odDeclaredSid = sid; }
				var next = {}, n = 0, arr = Array.isArray(entries) ? entries : [];
				for (var i = 0; i < arr.length; i++) {
					var sq = arr[i] && arr[i].anchorSeq;
					if (typeof sq === "number" && isFinite(sq) && next[sq] !== 1) { next[sq] = 1; n += 1; }
				}
				odDeclaredSeq = next; odDeclaredN = n;
			} catch (e) { /* 忽略（退化为现状） */ }
		}
		/** 卡声明命中 */
		function odDeclaredHas(seq) { return typeof seq === "number" && isFinite(seq) && odDeclaredSeq[seq] === 1; }
		/** ★ obs3S7 (丙-lite) ②：**建锚门槛**（**唯一判定点** ⇒ 离线 harness **抽取本函数原文**求值）
		 *  返回闭集：`"core"` 核心三类无条件建 ｜ `"want"` 在按需名单内 ｜ `"declared"` **卡声明了 `anchorSeq`**（本批新增输入）
		 *           ｜ `"yield"` 让位锚点（不建、只登记 turn 身份）｜ `"fallback"` 保底锚点（每趟至多 1 个）
		 *           ｜ `"reject"` 不建 ｜ `"decline"` 注入强制不建。
		 *  `plan == null`（冷载 fail-open / `od-mode=off`）⇒ `"core"`（= **旧行为"全建"**，逐字不变）。 */
		function odAdmitAnchor(type, seq, plan) {
			if (!plan) return "core";
			if (plan.declined && plan.declined[seq]) return "decline";
			if (OD_CORE_ANCHOR_TYPES[type]) return "core";
			if (plan.want && plan.want[seq]) return "want";
			if (odDeclaredHas(seq)) return "declared";   /* ← 本批新增：卡声明的行 ⇒ 必建载体（已载入 ⇒ gap=1） */
			if (odYieldedN && odYieldedMap[seq]) return "yield";
			if (odKept === 0 && !odFbUsed && plan.room && seq > odWantMax) return "fallback";
			return "reject";
		}
		/** ★ 段U6 v2-b：**缓存载荷里那份"跨窗口锚点集"**的 `回合 → turn/end seq` 映射（缺口判据的参照集）。 */
		var odCacheTurnEnd = {};
		/** ★ 段U6 v2-a：**既有 3 类核心锚点**（账本/费用/状态卡挂这三类）—— 写 `want` 时**永远保留**；`tool/call` 仍走按需。 */
		var OD_CORE_ANCHOR_TYPES = { "turn/start": 1, "turn/end": 1, "command/done": 1 };
		var odPlan = null, odPlanDone = false, odPlanSid = null, odPlanMark = -1;   // `odPlanSid`：计划所属会话（**会话变 ⇒ 计划作废重算**）；`odPlanMark`：算就时的 `odBk.backfills` 快照（扩窗回填 ⇒ 陈旧）
		var odDeclinedMap = {}, odDeclinedN = 0, odDeclinedList = [];
		/** 锚点 seq ⇒ 事件类型（`match()` 里登记；供"让位优先级"与缓存写入。未知 ⇒ 按**既有 3 类**对待） */
		var odAnchorType = {};
		/** **让位锚点**（`#A131` §4③④）：裁顶时被牺牲的按需锚点（`tool/call` 优先让位）。
		 *  ⇒ 它们**不进 `sel`、也不进 `declined`** ⇒ 受影响条目**回退到已建锚点渲染**（**不得落 `pending`** ⇒ 可见卡不减少）。 */
		var odYieldedMap = {}, odYieldedN = 0, odYieldedList = [];
		var odWantMax = -1, odKept = 0, odLastAnchorSeq = -1;
		/** **保底锚点 latch（每趟至多 1 个）** —— 段R VM 实测（`segR-vm-verify.md` §待裁-1）暴露：
		 *  故障态（按需集合**被整体裁掉**）下 `odWantMax === -1` ⇒ 若不加 latch，"已建 0 个"对**每个**未裁锚点都成立
		 *  ⇒ 保底分支会把**全部**未裁锚点建出来（实测 30 个 > `NOTICE_ANCHOR_MAX`）⇒ 与"锚点/订阅 ≤12"口径冲突。
		 *  latch 后：故障态恒 **恰 1 个** 保底锚点（订阅 ≥1、PEND 行有载体、计数如实），总数仍 ≤12。 */
		var odFbUsed = false;
		var odPlanRetry = false;      // 会话 id 迟到 ⇒ 允许**重算一次**计划（否则整页退化为冷载全量）
		var odAnchorSeenAt = {};
		var odLastPersistAt = 0, odLastPayload = "";
		var odKeepAliveOff = null;
		var odBk = { mode: "any", cold: true, wantSize: 0, declined: 0, kept: 0, fallback: 0,
			keepAlive: false, pendingDeclined: 0, staleHidden: 0, staleKeys: 0,
			backfills: 0, pendingStuck: 0, lastPending: -1, yielded: 0, yieldedFallback: 0, sigMiss: 0, declaredBuilt: 0,
			wantUnsound: 0, anchorMiss: 0, cacheDrop: 0, expandBuilt: 0, expandCapped: 0, coreBuilt: 0, coreOverflow: 0 };   /* 段U12 M1 */   /* U5b/U5a · 段U9 L1 · 段U10 L1′ */
		/** ★段U10 L1′：**单次扩窗趟的补建上限**；超限后本趟不再补建（回到现状）并计 `expandCapped`。 */
		var OD_EXPAND_CAP = 120;
		/** ★段U9 L1：**扩窗趟**边界 —— `odExpandUntil` = 进入扩窗趟时的**旧高水位**；补建只覆盖"比它更旧"的那一段。 */
		var odExpandUntil = -1, odExpandPass = false;
		function odMode() {
			try { return String((window.localStorage && window.localStorage.getItem(OD_MODE_KEY)) || "any"); } catch (e) { return "any"; }
		}
		/** ★ 应急开关（`#A132` §2④(i)）：`localStorage["dsh-notice-od-toolcall"]="0"` ⇒ **不把 `tool/call` 纳入锚点候选**
		 *  （秒级生效、无需部署 ⇒ 回到本批之前的定位精度；回滚阶梯第一级）。缺省 ⇒ 正常纳入。 */
		function odToolCallOff() {
			try { return window.localStorage ? window.localStorage.getItem("dsh-notice-od-toolcall") === "0" : false; } catch (e) { return false; }
		}
		/** ★ 应急开关（`#A132` §2④(ii)，本批新增）：`localStorage["dsh-notice-od-max"]="<正整数>"` ⇒ **临时把锚点上限调小**
		 *  （秒级生效、无需部署；缺省 ⇒ 用 `NOTICE_ANCHOR_MAX` = 200 的宽保险值）。用途：① 回滚阶梯第二级 ② 让"裁顶让位回退"
		 *  这条路径**可被机械验证**（把上限压到 12 即可在贴线夹具上触发 `yielded`）。 */
		function odMaxAnchors() {
			try {
				var raw = window.localStorage ? window.localStorage.getItem("dsh-notice-od-max") : null;
				var n = (raw == null ? NaN : parseInt(raw, 10));
				return (isFinite(n) && n >= 1) ? n : NOTICE_ANCHOR_MAX;
			} catch (e) { return NOTICE_ANCHOR_MAX; }
		}

		/** 字符串指纹（djb2 变体；确定、无依赖）—— 供"建锚点配置签名"压缩注入表 */
		function odStrHash(s) {
			var h = 5381;
			for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
			return h.toString(16);
		}
		/** ★ **建锚点配置签名**（仲裁 `#A142` 件2）：把「**改变"建哪些锚点"**」的全部开关纳入签名 ——
		 *  `od-mode`（按需/全量）／`od-toolcall`（是否纳入 `tool/call`）／`od-max`（上限）／`od-drop`・`od-hide`（注入，同样改变建锚点集合）。
		 *  **写**：`odPersist` 把它写进缓存载荷（`sig`）；**读**：`odCacheRead` 逐字对撞，**不一致 ⇒ 整份缓存作废 ⇒ 退化为冷载 fail-open 全建**。
		 *  **为什么**：换开关而不作废缓存 ⇒ 缓存 `want` 集合与"实际建得出的锚点"**错配** ⇒ 受影响条目被批量甩到少数已建锚点
		 *  = **堆叠 + 位置全错**（台账 #40 / `#A142` 二⑤ 已定因；阶梯已改为"换开关 + 同步状态复位"）。
		 *  ⚠️ **红线 6②**：作废后走的是**既有 fail-open 全建路径** ⇒ 不丢卡、不堆叠、不静默、可见卡数不减少。 */
		function odConfigSig() {
			try {
				var d = odSeqMap(OD_DROP_KEY), h = odSeqMap(OD_HIDE_KEY);
				var dk = Object.keys(d).sort().join(","), hk = Object.keys(h).sort().join(",");
				return odMode() + "|" + (odToolCallOff() ? "tc0" : "tc1") + "|" + odMaxAnchors() +
					"|d" + dk.length + ":" + odStrHash(dk) + "|h" + hk.length + ":" + odStrHash(hk);
			} catch (e) { return "err"; }
		}

		/** `"<seq,…>"` ⇒ `{seq:1}` 注入表（缺省 ⇒ 空集 ⇒ **inert**） */
		function odSeqMap(key) {
			var out = {};
			try {
				var raw = window.localStorage ? window.localStorage.getItem(key) : null;
				if (!raw) return out;
				var parts = String(raw).split(",");
				for (var i = 0; i < parts.length; i++) { var s = parts[i].trim(); if (s) out[s] = 1; }
			} catch (e) { /* 无 localStorage ⇒ 空集 */ }
			return out;
		}
		/** 缓存读取（**会话维度 + 新鲜度**双校验；任一不过 ⇒ `null` ＝ 冷载 fail-open 全建） */
		function odCacheRead() {
			try {
				if (!window.localStorage) return null;
				var raw = window.localStorage.getItem(OD_CACHE_KEY);
				if (!raw) return null;
				var c = JSON.parse(raw);
				// 缓存版本 2（2026-09-18 一次性迁移：v1 → v2，令现场所有旧缓存自动作废 ⇒ 走 fail-open 全建）
				if (!c || c.v !== 2) return null;
				var sid = currentSessionId();
				if (!sid || String(c.sid) !== String(sid)) return null;
				if (!(Date.now() - (typeof c.at === "number" ? c.at : 0) <= OD_CACHE_TTL_MS)) return null;
				// ★ #A142 件2：**建锚点配置签名**不一致（含旧缓存无 sig）⇒ **整份缓存作废** ⇒ 走既有 fail-open 全建（不丢卡/不堆叠/不静默）
				if (String(c.sig || "") !== odConfigSig()) { odBk.sigMiss += 1; return null; }
				if (!c.want || !c.want.length) return null;   // 空集合 ⇒ 不裁（C2 第一层：裁到 0 会静默）
				// ★ 段U4 U5b（自愈）：**同源一致性校验** —— `want` 的每个 seq 必须能在同一载荷的 `anchors`（本轮"见过的锚点"全集）
				//   记录中找到；越出该集合 = 异源/不自洽 ⇒ **整份作废** ⇒ 走既有 fail-open 全建（冷载路径，长期验证）。
				var _as = {}, _A = c.anchors || [];
				for (var _ai = 0; _ai < _A.length; _ai++) { if (_A[_ai]) _as[Number(_A[_ai][0])] = 1; }
				for (var _wi = 0; _wi < c.want.length; _wi++) {
					if (!_as[Number(c.want[_wi])]) { odBk.wantUnsound += 1; return null; }
				}
				// ★ 段U6 v2-b：**参照集 = 缓存载荷里的 `anchors`（跨窗口）**，而不是"本页 `odSeen`"（后者与 `want` 同窗口 ⇒ 缺口恒判不出）。
				odCacheTurnEnd = {};
				for (var _ci = 0; _ci < _A.length; _ci++) {
					var _c0 = _A[_ci];
					if (_c0 && _c0[3] === "turn/end" && _c0[2] != null) odCacheTurnEnd[Number(_c0[2])] = Number(_c0[0]);
				}
				return c;
			} catch (e) { return null; }
		}
		/** 按需计划（**每会话算一次**；会话 id 迟到或**会话变化**时重算）：`{want,declined,room}`；`null` ⇒ **fail-open 全建** */
		/** ★ obs3S7 (丙-lite) ②：**计划陈旧判定**（**唯一判定点** ⇒ 离线 harness **抽取本函数原文**求值）
		 *  会话变化 / 会话 id 迟到 / **扩窗·回填趟发生过**（`odBk.backfills` 前进）⇒ 重算。
		 *  ⇒ 令"扩窗后**新载入段的行**"进 `want`；`odExpandUntil` 的"扩窗趟有界"语义**不变**。 */
		function odPlanStaleNow() {
			if (!odPlanDone) return false;
			var sidNow = currentSessionId();
			if (odPlanSid !== null && odPlanSid !== sidNow) return true;
			if (odPlanRetry && sidNow) return true;
			if (odPlanMark !== odBk.backfills) return true;   /* ← 本批新增：扩窗/回填后重算 */
			return false;
		}
		function odPlanGet() {
			if (odPlanDone) {
				var sidNow = currentSessionId();
				// ★ 段R 路线A 修：**会话一变 ⇒ 计划立刻作废**（计划是按"上一趟该会话的有卡锚点"算的；沿用旧计划会把
				//   新会话的锚点几乎全裁掉 ⇒ 退化到"只剩保底锚点 1 个"。此类退化只在**页内切会话**时发生 ⇒ 必须重算）。
				var stale = odPlanStaleNow();   // ★ (丙-lite) ②：会话变化 / id 迟到 / **扩窗·回填过** ⇒ 重算
				if (!stale && !(odPlanRetry && sidNow)) return odPlan;
				odPlanDone = false; odPlanRetry = false;      // 会话变化 / 会话 id 迟到 ⇒ 重算
			}
			odPlanDone = true;
			odPlanMark = odBk.backfills;   /* ★ (丙-lite) ②：重算当刻记下回填计数 ⇒ "扩窗后重算"幂等一次 */
			odPlan = null;
			odPlanSid = currentSessionId();
			odDeclinedMap = {}; odDeclinedN = 0; odDeclinedList = [];
			odCacheTurnEnd = {};   /* 段U6 v2-b：计划重算 ⇒ 参照集一并重算（冷载时保持空 ⇒ 不产生缺口计数） */
			odYieldedMap = {}; odYieldedN = 0; odYieldedList = [];
			odWantMax = -1;
			odBk.mode = odMode();
			try {
				if (odBk.mode === "off") { odBk.cold = false; return null; }
				var c = odCacheRead();
				if (!c) { odBk.cold = true; if (!currentSessionId()) odPlanRetry = true; return null; }   // 冷载/缓存不可用 ⇒ 全量（C1 fail-open）
				odBk.cold = false;
				var drop = odSeqMap(OD_DROP_KEY);                       // 故障注入（VM 正控；缺省 inert）
				var want = {}, declined = {}, ks = [];
				for (var i = 0; i < c.want.length; i++) {
					var s = Number(c.want[i]);
					if (!isFinite(s)) continue;
					if (drop[String(s)]) { declined[s] = 1; continue; } // **注入专用**：强制不建 ⇒ 其条目**如实落 pending**（fail2 正控口径不变）
					if (!want[s]) { want[s] = 1; ks.push(s); }
				}
				// ★ 裁顶（`#A131` §4③④，**取代旧 C3 的"超出即落 pending"**）：按需集合 > `NOTICE_ANCHOR_MAX` 时 ——
				//   **既有 3 类锚点优先保留、`tool/call` 优先让位**；**让位者进 `yielded`**（不是 `declined`）
				//   ⇒ 受影响条目**回退到已建锚点渲染**（可见、位置精度降级），**绝不落 `pending`** ⇒ 贴线会话可见卡不减少。
				var typeOf = {};
				var atMap = {};
				for (var m0 = 0; m0 < c.anchors.length; m0++) {
					var a0 = c.anchors[m0];
					if (!a0) continue;
					atMap[Number(a0[0])] = (typeof a0[1] === "number" ? a0[1] : null);
					typeOf[Number(a0[0])] = (a0.length > 3 && typeof a0[3] === "string") ? a0[3] : null;
				}
				var yielded = {};
				if (ks.length > odMaxAnchors()) {
					var coreKs = [], tcKs = [];
					for (var k0 = 0; k0 < ks.length; k0++) {
						var tp = typeOf[ks[k0]];
						if (tp === "tool/call") tcKs.push(ks[k0]); else coreKs.push(ks[k0]);   // 未知类型 ⇒ 按既有 3 类对待（保守）
					}
					coreKs.sort(function (x, y) { return y - x; });   // 同向旧口径：**优先保留 recent**（seq 大者）
					tcKs.sort(function (x, y) { return y - x; });
					var keepKs = coreKs.slice(0, odMaxAnchors());
					for (var t0 = 0; t0 < tcKs.length && keepKs.length < odMaxAnchors(); t0++) keepKs.push(tcKs[t0]);
					var keepSet = {};
					for (var k1 = 0; k1 < keepKs.length; k1++) keepSet[keepKs[k1]] = 1;
					for (var k2 = 0; k2 < ks.length; k2++) {
						if (keepSet[ks[k2]]) continue;
						yielded[ks[k2]] = 1; delete want[ks[k2]];
					}
				}
				var keep = Object.keys(want), mx = -1;
				for (var q = 0; q < keep.length; q++) { var qv = Number(keep[q]); if (qv > mx) mx = qv; }
				for (var z in declined) {
					if (!declined.hasOwnProperty(z)) continue;
					odDeclinedList.push({ seq: Number(z), time: atMap[Number(z)] == null ? null : atMap[Number(z)] });
				}
				odYieldedMap = yielded; odYieldedN = 0; odYieldedList = [];
				for (var zy in yielded) {
					if (!yielded.hasOwnProperty(zy)) continue;
					var zyv = Number(zy);
					odYieldedList.push({ seq: zyv, time: atMap[zyv] == null ? null : atMap[zyv] });
				}
				odYieldedN = odYieldedList.length;
				odDeclinedMap = declined;
				odDeclinedN = odDeclinedList.length;
				odWantMax = mx;
				odBk.wantSize = keep.length;
				odBk.declined = odDeclinedN;
				odBk.yielded = odYieldedN;
				// **保底余量**：仅当按需集合未占满上限时才允许补 1 个保底锚点 ⇒ 锚点总数恒 ≤ `NOTICE_ANCHOR_MAX`
				odPlan = { want: want, declined: declined, room: keep.length <= odMaxAnchors() - 1 };
			} catch (e) { odPlan = null; }
			return odPlan;
		}
		/** 锚点事件记账（**含被裁掉的**）：供缓存写入；顺带登记被裁锚点的 **turn 身份**（C3 的 declined⇒pending 判定要用） */
		function odNoteSeen(ev) {
			try {
				if (!ev || typeof ev.seq !== "number") return;
				if (!odSeen[ev.seq]) {
					odSeenN += 1;
					if (odSeenMin < 0 || ev.seq < odSeenMin) odSeenMin = ev.seq;
				}

				// ★★ 缺陷修复（2026-09-21 `#A56` 复审定因；**真源缺失、在役件有**）：`odNoteSeen` 的
				//   **台账初始化行**被"件A 客户端半（①-b 配对臂）"的改动**误删**（真源 `grep -c 'odSeen[ev.seq] = {'` = 0，
				//   在役件 = 1）⇒ `odSeen` 恒空、`.cid`/`.sk` 赋值**每次抛 TypeError 并被 catch 吞掉**
				//   ⇒ ①-b 配对臂恒 miss、A 自持 `slotId→seq` 表恒空（VM 三臂 R2 实测 (乙) inert 的真因）。
				//   ⇒ **原地补回初始化**（字段与在役件逐字同：time/turn/type），`.cid`/`.sk` 仍在其后写入。
				odSeen[ev.seq] = { time: (typeof ev.time === "number" ? ev.time : null),
					turn: (ev.data && typeof ev.data.turn === "number" ? ev.data.turn : null),
					type: String(ev.type || "") };   // 段R 路线A：锚点**类型**入缓存 ⇒ 供"既有 3 类优先保留"的裁顶判定

				// ★(乙) T18 键1（2026-09-20 用户已签）：`command/done` 的 `data.commandId` 入缓存
				//   ⇒ 供 `odCmdSeq()` 建"命令↔行"确定性配对（**不猜时间、不推 seq**）。
				odSeen[ev.seq].cid = (ev.data && typeof ev.data.commandId === "string" && ev.data.commandId) ? ev.data.commandId : null;
				// ★(乙) `#A56`：同时记**本事件对应的宿主行身份 `slotId`**（⇒ A 侧"每卡 slotId → 我的锚点 seq"直配表）
				odSeen[ev.seq].sk = odRowSlotIdOf(ev);
				if (odSeenN > OD_CACHE_MAX_ANCHORS) {          // 超限：丢 seq 最小者（最旧）
					var ks = Object.keys(odSeen).map(Number).sort(function (x, y) { return x - y; });
					var dropN = ks.length - OD_CACHE_MAX_ANCHORS;
					for (var i = 0; i < dropN; i++) { delete odSeen[ks[i]]; odSeenN -= 1; }
					odSeenMin = ks.length ? ks[dropN] : -1;
				}
			} catch (e) { /* 忽略 */ }
		}
		/** 被裁锚点的 **turn 身份登记**（与 `storeAddAnchor` 内同源；只为"该锚点被裁掉时其回合条目如实落 pending"） */
		function odNoteTurnIdentity(ev) {
			try {
				var t = ev && ev.data && typeof ev.data.turn === "number" ? ev.data.turn : null;
				if (t == null) return;
				if (ev.type === "turn/end" || storeState.turnAnchor[t] == null) storeState.turnAnchor[t] = ev.seq;
			} catch (e) { /* 忽略 */ }
		}
		/** 热点查询：锚点 seq 是否属**被裁锚点**（正常空闲路径 declined 为空 ⇒ O(1) 早退，不改变原行为） */
		function odIsDeclined(seq) { return odDeclinedN > 0 && seq != null && !!odDeclinedMap[seq]; }
		/** `dsh-notice-od-hide` 注入表（**不缓存** ⇒ 注入/撤注入即时生效，供"同 boot 正控"；缺省空集 ⇒ **inert**） */
		function odHideMap() { return odSeqMap(OD_HIDE_KEY); }
		/** 写缓存（**C1**）：`want` = 「**有卡锚点集合**」= 本趟真实承载卡片的锚点（`storeAlignAll().byAnchor` 的键） */
		/** ★(乙) T18 键1：在"见过的锚点"（`odSeen`）里按 `commandId` 查其 `command/done` 的 seq；查不到 ⇒ `null`。
		 *  —— **确定性配对**（同源标识由宿主发放，一处铸造三处同用）⇒ 命中即**权威落点**，不参与"时间猜测"。 */
		function odCmdSeq(id) {
			if (typeof id !== "string" || !id) return null;
			var ks = Object.keys(odSeen);
			for (var i = 0; i < ks.length; i++) { var r = odSeen[ks[i]]; if (r && r.cid === id) return Number(ks[i]); }
			return null;
		}
		/** ★★(乙) T-B 复审（2026-09-21 `#A56`；用户已签契约面）：**A 侧"每卡 `slotId` → 我自己哪个锚点 seq"直配**
		 *  —— 目的 = **结构性拆掉"经 `want.slots` 的 seq 桥"**：B 的行事实面（其 `seq` 取自 `command/run`）与我方
		 *  实际挂载的锚点节点（其 `seq` 来自 `command/done`）可能**差 1** ⇒ 旧写法把卡指到"没有节点的 seq"⇒
		 *  `pendingNoNode` ⇒ 卡片**零可见**（2026-09-21 VM 两臂实测：3 张 `placed` 卡 0 张渲染）。
		 *  做法 = 在**见过的事件**上按**宿主行身份约定**（`${kind.length}:${kind}${id}`，与 B 的 `rowSlotId` 同形）
		 *  记下 `slotId` ⇒ `slotId → 我自己登记到的 seq`。**B 仍是位置权威**（`slotId` 由 B 下发）；
		 *  本表只回答"这张卡该挂我哪个节点"，**不发明落点**。镜像表**只覆盖已登记行族**（缺者 ⇒ 不用本表，退回 B 的 `slots`）。 */
		var OD_ROW_ID_MIRROR = { "command/done": ["command", "commandId"], "tool/call": ["tool-call", "callId"], "turn/end": ["turn-tail", "turn"], "turn/start": ["turn-process", "turn"] };
		function odRowSlotIdOf(ev) {
			try {
				var spec = OD_ROW_ID_MIRROR[String(ev && ev.type)];
				if (!spec) return null;
				var v = ev && ev.data ? ev.data[spec[1]] : null;
				if (v == null || v === "") return null;
				return spec[0].length + ":" + spec[0] + String(v);
			} catch (e) { return null; }
		}
		/** ★(乙)：由**我方登记表**（`odSeen`）推出 `slotId → seq`（同一 `slotId` 多 seq ⇒ **取最后见到者** =
		 *  与"宿主 DOM 承载行"一致，实例：`command/run`(634) → `command/done`(635) ⇒ 取 635）。 */
		function storeSlotIdSeqOwn() {
			try {
				var map = {}, ks = Object.keys(odSeen);
				for (var i = 0; i < ks.length; i++) {
					var rec = odSeen[ks[i]];
					if (rec && typeof rec.sk === "string" && rec.sk) map[rec.sk] = Number(ks[i]);
				}
				return map;
			} catch (e) { return null; }
		}
		/** ★ 段U4 U5b：在"见过的锚点"（`odSeen`）里查该回合的 `turn/end` seq；查不到 ⇒ `null`。 */
		function odTurnEndSeen(turn) {
			var ks = Object.keys(odSeen);
			for (var i = 0; i < ks.length; i++) { var r = odSeen[ks[i]]; if (r && r.type === "turn/end" && r.turn === turn) return Number(ks[i]); }
			return null;
		}
		function odPersist() {
			try {
				// 0) **异常标记的非渲染路径评估**（先于节流）⇒ `state().degradeReason` 始终如实，
				//    即使"0 锚点"这种**没有任何 DOM 载体**可挂提示行的形态也不静默（治 fail2 假绿）。
				//    ⚠️ 与 `od-mode` **无关**：D1–D3（提示只覆盖真异常）是用户 2026-09-17 口径，独立于 ⑤ 的按需策略；
				//        `od-mode=off` 只关"按需裁剪/保底/declined"（= 锚点策略回到现状），不关"如实上报"。
				odAnomaly();
				if (odBk.mode === "off" || !window.localStorage) return;
				var sid = currentSessionId();
				if (!sid) return;
				var now = Date.now();
				if (now - odLastPersistAt < OD_PERSIST_MIN_MS) return;
				odLastPersistAt = now;
				// ① 快照（D2 ② 的诊断口径）：`pending` 长期不降 = **预期**（窗口外条目永无载体）⇒ **只作诊断**、不作触发
				var snap = storeAlignAll();
				// ★ 段U4 U5b（自愈）：**坏名单 ⇒ 当场作废**（且**不写新名单**）⇒ 下次加载走 `odCacheRead` ⇒ null ⇒ fail-open 全建。
				//   目标 = "坏名单下次加载自我修复，用户无需手动刷新"；`cold` 轮不计数（见 P4）⇒ 不会形成"永久失效循环"。
				if (snap.anchorMiss > 0) {
					odBk.anchorMiss += snap.anchorMiss; odBk.cacheDrop += 1;
					try { noticeDebugFlush(); } catch (e8) { /* U5a：作废**当场**落进 `dsh-notice-debug-state`，不等下一帧 */ }
					try { window.localStorage.removeItem(OD_CACHE_KEY); } catch (e7) { /* 忽略 */ }
					odLastPayload = "";
					// 本轮内也让它有机会立刻回正：作废计划 ⇒ 下一次 `odPlanGet` 重算（无缓存 ⇒ fail-open 全建）
					odPlanDone = false; odPlan = null; odBk.cold = true;
					return;
				}
				if (snap.pending > 0 && snap.pending >= odBk.lastPending) odBk.pendingStuck += 1;
				else odBk.pendingStuck = 0;
				odBk.lastPending = snap.pending;
				var byAnchor = snap.byAnchor, kk = Object.keys(byAnchor), want = [], wset = {};
				for (var i = 0; i < kk.length; i++) { var n = Number(kk[i]); if (isFinite(n)) { want.push(n); wset[n] = 1; } }
				// ★ 段U6 v2-a（`#E13` 生产确诊的治本口径）：**永远并入既有 3 类核心锚点**（`turn/start`/`turn/end`/`command/done`）
				//   ⇒ 名单不再随"本页窗口"收缩、账本/费用卡不再失去载体；`tool/call` **仍走按需**；上限仍由 `odPlanGet()` 的
				//   `odMaxAnchors()` 统一裁（既有"核心三类优先保留"口径不变）。
				var _cks = Object.keys(odSeen);
				for (var _ci2 = 0; _ci2 < _cks.length; _ci2++) {
					var _rr = odSeen[_cks[_ci2]];
					if (!_rr || !OD_CORE_ANCHOR_TYPES[_rr.type]) continue;
					var _ss = Number(_cks[_ci2]);
					if (!isFinite(_ss) || wset[_ss]) continue;
					wset[_ss] = 1; want.push(_ss);
				}
				if (!want.length) return;                       // 本趟无卡 ⇒ 不覆盖旧缓存（下一趟仍按需）
				want.sort(function (x, y) { return x - y; });
				var A = [], ks = Object.keys(odSeen);
				for (var j = 0; j < ks.length; j++) {
					var r = odSeen[ks[j]];
					if (r && typeof r.time === "number") A.push([Number(ks[j]), r.time, (r.turn == null ? null : r.turn), (r.type || null)]);
				}
				A.sort(function (x, y) { return x[0] - y[0]; });
				var payload = JSON.stringify({ v: 2, sid: sid, at: now, want: want, anchors: A, sig: odConfigSig() });   /* obs3-fp-v2 */
				if (payload === odLastPayload) return;
				window.localStorage.setItem(OD_CACHE_KEY, payload);
				odLastPayload = payload;
			} catch (e) { /* 忽略（配额满/无 localStorage/序列化失败） */ }
		}
		/** C2 第二部分：**保活订阅**（**订阅下限 ≥1**）—— 与「对齐 universe」**解耦**：
		 *  · 它**不是锚点节点** ⇒ **不进 `storeAnchorUniverse()`** ⇒ 不参与对齐、不影响文档序（判据 ④ 逐字零回归）
		 *  · 规则：**有锚点组件订阅 ⇒ 立刻摘掉**；**锚点订阅数为 0 ⇒ 挂上** ⇒ 订阅数 = **`max(1, 锚点数)`**
		 *  · 作用：**取数永不停摆** ⇒ 条目表可用 ⇒ `pendingCount`/异常标记**如实**（治 fail2「锚点全无 ⇒ 静默 + 假 0」）
		 *  ⚠️ 只在按需模式下介入；`off`/冷载路径逐字不变。 */
		function odKeepAliveEnsure() {
			try {
				if (odMode() === "off") return;
				var anchorSubs = STORE_SUBSCRIBERS - (odKeepAliveOff ? 1 : 0);
				if (anchorSubs > 0) {
					if (odKeepAliveOff) { var off = odKeepAliveOff; odKeepAliveOff = null; odBk.keepAlive = false; off(); }
					return;
				}
				if (odKeepAliveOff) return;
				odKeepAliveOff = subscribeStore(function () { /* 保活：无副作用 */ });
				odBk.keepAlive = true;
			} catch (e) { /* 忽略 */ }
		}
		/** 锚点节点**已挂载渲染**登记（D2 ① 的判定依据；由锚点组件 effect 调用，**注入隐藏者不登记**） */
		function storeNoteAnchorMounted(seq) {
			try {
				if (typeof seq !== "number") return;
				storeState.anchorMounted[seq] = 1;
				odKeepAliveEnsure();
			} catch (e) { /* 忽略 */ }
		}
		/* ★`#A72` 步1：**当前挂载**（引用计数）—— 与 sticky 的 `anchorMounted` 分离，只服务"尾锚点兜底"判定。 */
		function storeAnchorLiveAdd(seq) {
			try { if (typeof seq === "number") storeState.anchorLive[seq] = (Number(storeState.anchorLive[seq]) || 0) + 1; } catch (e) { /* 忽略 */ }
		}
		function storeAnchorLiveDel(seq) {
			try {
				if (typeof seq !== "number") return;
				var n = (Number(storeState.anchorLive[seq]) || 0) - 1;
				if (n > 0) storeState.anchorLive[seq] = n; else delete storeState.anchorLive[seq];
			} catch (e) { /* 忽略 */ }
		}
		/**
		 * ★`#A72` 步1：**状态卡块（含全局落位异常卡）渲染在哪个锚点** —— 唯一判定口。
		 *
		 * 旧口径（本函数之前）：`isUniverseTail = (universe 最后一个 seq === banner.__storeWatch)`。
		 * **缺陷（用户实测）**：回合结束后宿主新增 `turn/end` 等锚点被观测进 universe，但**没有 banner 载体**
		 *   （宿主在该节点不渲染我们的卡片槽）⇒ 所有已挂载 banner 的 `__storeWatch` 都 ≠ 宇宙尾
		 *   ⇒ `isUniverseTail` **全假** ⇒ 状态卡块（全局落位异常卡 ＋ 未定位区 ＋ 降级行）**整块消失**；
		 *   下一轮有新锚点挂载时才恢复 ⇒ 表现为「干活时有、回复完成即消失」。
		 *
		 * 新口径（两臂，**单一产出**）：
		 *   ① `universe`：宇宙尾**确已挂载** ⇒ 用宇宙尾（与旧行为逐字一致）；
		 *   ② `fallback`：宇宙尾**未挂载** ⇒ 用**当前已挂载的最大 seq**（仍只有**一个**节点渲染，不重复）。
		 * 两臂都保证「只要有可读数据，告警块就在**最靠后**的已挂载 banner 上」，不随活动消失。
		 * @returns {{seq:number|null, arm:"universe"|"fallback"|"none"}}
		 */
		function nsTailRender() {
			try {
				var uni = storeAnchorUniverse();
				var uSeq = uni.length ? uni[uni.length - 1].seq : null;
				var live = storeState.anchorLive || {};
				if (uSeq !== null && Number(live[uSeq]) > 0) return { seq: uSeq, arm: "universe" };
				var max = null;
				for (var k in live) {
					if (!Object.prototype.hasOwnProperty.call(live, k)) continue;
					if (!(Number(live[k]) > 0)) continue;
					var s = Number(k);
					if (Number.isFinite(s) && (max === null || s > max)) max = s;
				}
				if (max !== null) return { seq: max, arm: "fallback" };
				return { seq: null, arm: "none" };
			} catch (e) { return { seq: null, arm: "none" }; }
		}

		/* ★`#A78` 步2（裁：乙）：**常驻块的真末尾归属** —— 回合进行中时，本回合的 node 槽卡会排在上一回合尾之后，
		   因此不能只让 turnTail 渲染。规则：比较"已挂载 node 的最大 seq"与"最大 turnTail 回合的锚点 seq"，
		   **谁的序号更大谁渲染**（两者都受现有引用计数约束 ⇒ 每会话仍只一个实例）。
		   数据源：`nsTailRender()`（已挂载 node 尾，`#A72`）＋ `residentMaxTurn()`（已挂载 turnTail 回合）
		   ＋ `storeState.turnAnchor[turn]`（该回合的锚点 seq，`turn/end` 时写入）。 */
		function residentOwner() {
			try {
				var tMax = residentMaxTurn();
				var tSeq = null;
				if (tMax !== null && storeState.turnAnchor) {
					var a = storeState.turnAnchor[tMax];
					if (typeof a === "number") tSeq = a;
				}
				var n = nsTailRender();
				var nSeq = n && typeof n.seq === "number" ? n.seq : null;
				if (nSeq !== null && (tSeq === null || nSeq > tSeq)) return { kind: "node", seq: nSeq };
				if (tMax !== null) return { kind: "turn", turn: tMax };
				return { kind: "none" };
			} catch (e) { return { kind: "none" }; }
		}
		/** D2：**只覆盖真异常两态**的**可机械判定**异常标记（返回 `""` ＝ 无异常）：
		 *  ① `stale-unrendered`：**有条目、锚点在 `storeAnchorUniverse()` 内、却无卡** = 台账 #34「加载了却看不到」；
		 *     判定 (a) universe 内承载条目的锚点**未被任何组件挂载渲染**（宽限 `OD_GRACE_MS`，防新建节点未挂载的假红）
		 *          (b) 对齐结果里的条目键在 `byKey` 中**缺失**（卡片无从渲染）
		 *  ② `pending-mismatch`：**有 `pending` 但 PEND 行缺失**（universe 为空 / universe 尾锚点未挂载）= 「该加载时不加载」
		 *  ⚠️ **`overLimit > 0` 不产生异常**（D1：超限只是位置精度降级，台账 #34 不算降级）；
		 *  ⚠️ 「`pending` 计数不递减」**只作诊断**（`state().onDemand.pendingStuck`），**不作触发** —— 生产常态
		 *      `pendingCount=15`（窗口外条目永无载体）恒不递减，作触发会**永久假异常**（#A124 §2 采信）。 */
		function odAnomaly(info) {
			try {
				var info2 = info || storeAlignAll();
				var byA = info2.byAnchor, ks = Object.keys(byA), now = Date.now();
				var stale = 0;
				for (var i = 0; i < ks.length; i++) {
					var seq2 = Number(ks[i]);
					if (!storeState.anchorMounted[seq2]) {
						var t0 = odAnchorSeenAt[seq2];
						if (typeof t0 === "number" && (now - t0) > OD_GRACE_MS) stale += 1;
					}
					var arr = byA[ks[i]];
					for (var j = 0; j < (arr ? arr.length : 0); j++) { if (!storeState.byKey[arr[j]]) { stale += 1; odBk.staleKeys += 1; } }
				}
				odBk.staleHidden = stale;
				var uni = storeAnchorUniverse(), reason = "";
				if (stale > 0) reason = "stale-unrendered";
				else if (info2.pending > 0) {
					// ②-1「PEND 行缺失」：universe 为空 ⇒ 没有任何节点能渲染该行；或尾锚点未挂载 ⇒ 同样渲染不出
					if (!uni.length) reason = "pending-mismatch";
					else if (!storeState.anchorMounted[uni[uni.length - 1].seq]) reason = "pending-mismatch";
				} else if (!uni.length && storeState.keys.length > 0) {
					// ②-2「条目已取到、却一个锚点都没有」⇒ 卡片无处落 = **格2 fail2 的静默签名**（旧代码此态 `pendingCount` 读 0、
					//   连提示行都没有）⇒ 必须**如实上报**（这是"该加载时不加载"的机械可判定形态）。
					reason = "pending-mismatch";
				}
				// **单一来源**：把标记写回 `storeRenderState.degradeReason` ⇒ `state()` 也能读到（0 锚点态没有节点可挂提示行，
				//   此时 DOM 面无载体，只有 `state()` 能如实上报）。`fetch-failed`（取数层置位）不覆盖。
				if (storeRenderState.degradeReason !== "fetch-failed") storeRenderState.degradeReason = reason;
				return reason;
			} catch (e) { /* 忽略 */ }
			return "";
		}
		/** 异常文案（D1/D3：**不含「降级」字样**；PEND 行与 DEG 行**语义去重** ⇒ 此处不再复述"窗口外历史卡…"） */
		var OD_ANOMALY_TEXT = {
			"stale-unrendered": "⚠ 卡片渲染异常（stale-unrendered）：有条目、锚点也在本页，但这些卡片没有渲染出来",
			"pending-mismatch": "⚠ 卡片渲染异常（pending-mismatch）：有卡片待载入，却没有对应提示行（计数与实际不符）",
			"fetch-failed": "⚠ 卡片渲染异常（fetch-failed）：条目连续取数失败，可见卡片可能不是最新"
		};

		/** 登记一个锚点（窗口重放 ⇒ `seq` 回退 ⇒ 重置锚点表重算；**有界**：超过 `NOTICE_ANCHOR_MAX` ⇒ 静默降级） */
		function storeAddAnchor(event) {
			var seq = typeof event.seq === "number" ? event.seq : null;
			if (seq == null || !storeRenderOn()) return null;
			// S3：锚点归属绑会话（**只动自有状态**，不订阅、不取数、不碰宿主 ⇒ 不违反 match() 纯函数）
			var curSid = currentSessionId();
			if (anchorSessionScopeOn() && curSid !== storeState.anchorSession) {
				storeState.anchorList = [];
				storeState.anchored = {};
				// ⚠️ `anchorMounted` **刻意不清理**（sticky）—— 组件实例在切会话/重放时通常**不重新挂载**，
				//    清理会把"已渲染"的锚点误判成"未渲染" ⇒ 假 `stale-unrendered`。代价 = 同 seq 复用时漏报（登记未覆盖）。
				storeState.anchorSession = curSid;
			}
			var t = typeof event.time === "number" ? event.time : 0;
			if (storeState.lastSeq >= 0 && seq <= storeState.lastSeq) {
				storeState.anchorList = [];
				storeState.anchored = {};
				// ⚠️ `anchorMounted` 同上**刻意不清理**（sticky，防重放假异常）
			}
			storeState.lastSeq = seq;
			// obs#3 修法①：**身份登记** —— 宿主事件自带回合号（turn/start 与 turn/end 的 data.turn，生产实测）
			//   ⇒ 记 `turn → 锚点 seq`（**turn/end 优先** = 回合末，与旧链落点基准一致）。
			try {
				var evTurn = event && event.data && typeof event.data.turn === "number" ? event.data.turn : null;
				if (evTurn != null && (event.type === "turn/end" || storeState.turnAnchor[evTurn] == null)) {
					storeState.turnAnchor[evTurn] = seq;
				}
			} catch (e0) { /* 身份登记失败 ⇒ 退化为时间对齐；不 throw */ }
			var list = storeState.anchorList;
			var last = list.length ? list[list.length - 1] : null;
			if (last && last.seq === seq) return seq;
			if (list.length >= odMaxAnchors()) {
				// obs#3 修法①（#A60 三：**不消失 ＞ 位置 ＞ 性能**）：**超限不再关闭渲染** —— 只丢**最旧**锚点腾位
				//   （位置精度降级）；被丢锚点上的条目不丢 —— **段I 起不再兜底到尾锚点**：无载体者按 `pending` 如实标注（口径 A，见 storeAlignAll）。
				// obs#3 段R ②（D1，用户 2026-09-17 口径 + 台账 #34）：**超限 ≠ 异常** —— 这里**不再**置
				//   `degraded/degradeReason="anchor-over-limit"`（旧文案"横幅位置已降级(anchor-over-limit)"无信息量、
				//   且与"窗口外历史卡不渲染 = 预期行为"冲突）。**仍如实计数** `overLimit`（`state()` 可查），
				//   提示只由 `odAnomaly()` 的两态（`stale-unrendered` / `pending-mismatch`）产生。
				storeRenderState.overLimit += 1;
				var _ev = -1;   /* 段U12 M1：核心三类槽**免于裁剪** ⇒ 优先淘汰非核心锚点；全是核心 ⇒ 不裁（宁多建） */
				for (var _q = 0; _q < list.length; _q++) { var _tq = odAnchorType[list[_q].seq] || (odSeen[list[_q].seq] ? odSeen[list[_q].seq].type : ""); if (!OD_CORE_ANCHOR_TYPES[_tq]) { _ev = _q; break; } }
				if (_ev >= 0) list.splice(_ev, 1); else odBk.coreOverflow += 1;
			}
			list.push({ seq: seq, time: t });
			notifyStore(); // 归属可能变化 ⇒ 通知已挂载的锚点节点重算（订阅数有界 ⇒ 通知有界）
			return seq;
		}
		/** obs#3 修法②（#A70 一 (b1)/(b2)）：登记一个**已存在的锚点节点**（宿主建的 or 已挂载组件自报的）。
		 *  与 `storeAddAnchor` 的区别：**这条不清、不设上限、不参与 `autoOff`** —— 它只回答"页面上到底有哪些锚点节点"，
		 *  从而让**渲染不再依赖 `anchorList`**（表被清/被回退重置清掉时，卡片仍能重挂 ⇒ 不消失优先）。 */
		function storeNoteAnchorNode(seq, time) {
			try {
				if (typeof seq !== "number") return;
				var cur = storeState.anchorNodes[seq];
				var t = typeof time === "number" ? time : (cur && typeof cur.time === "number" ? cur.time : null);
				// **按会话登记**：节点可能属于别的会话（其归属守卫会把它隐藏）⇒ 必须先记会话再进入"锚点宇宙"，
				//   否则尾锚点兜底会把条目挂到"被隐藏的他会话节点"上 ⇒ 卡片仍然看不见（修法② 的关键前提）。
				var sid = cur && cur.sid ? cur.sid : currentSessionId();
				storeState.anchorNodes[seq] = { time: t, sid: sid };
				if (odAnchorSeenAt[seq] == null) odAnchorSeenAt[seq] = Date.now();   // 段R D2 ①：挂载宽限的起算点
			} catch (e) { /* 绝不上抛 */ }
		}
		/** 当前页面上可用的锚点（seq 升序）：`anchorList`（宿主喂的，带时间）∪ `anchorNodes`（节点自报的） */
		function storeAnchorUniverse() {
			var out = [];
			var seen = {};
			try {
				for (var i = 0; i < storeState.anchorList.length; i++) {
					var a = storeState.anchorList[i];
					if (!a || typeof a.seq !== "number") continue;
					out.push({ seq: a.seq, time: typeof a.time === "number" ? a.time : null });
					seen[a.seq] = 1;
				}
				var ks = Object.keys(storeState.anchorNodes);
				var cur = currentSessionId();
				for (var k = 0; k < ks.length; k++) {
					var s = Number(ks[k]);
					if (seen[s]) continue;
					var rec = storeState.anchorNodes[ks[k]];
					if (rec && rec.sid && cur && rec.sid !== cur) continue;   // 他会话节点（会被归属守卫隐藏）⇒ 不参与
					out.push({ seq: s, time: rec ? rec.time : null });
				}
				out.sort(function (x, y) { return x.seq - y.seq; });
			} catch (e) { /* 降级为原表 */ }
			return out;
		}
		/** 单趟对齐（obs#3 段I · #A77 三/四：**落点策略 A「原位优先」**）——
		 *  一次遍历全部条目 ⇒ `{ byAnchor: {seq: [key…]}, pending: N, tailAssigned: M }`。
		 *  对齐顺序：① `turn` ⇒ 该回合锚点（`turn/end` 优先）② `ctxKey` 内的事件 seq ③ 时间（只认有 `time` 的锚点）。
		 *  ④ **窄例外尾锚点兜底**：**仅** `turn == null` 且 `at >= 最新锚点 time` 的"刚发生、身份未定"新卡仍落尾锚点。
		 *  ⇒ **无载体的窗口外条目不落任何锚点**（计入 `pending`）。位置**只能由宿主给定**（`match()` 只对宿主喂来的
		 *  事件返回 `store-anchor-<seq>`，位置取 `context.start.location`）⇒ **窗口外回合没有位置可用**（段H 定案）。
		 *  故"历史卡堆在底部"（主诉）不再发生；页面只在**已挂载回合**处显示其卡片，`pending` 由 UI 如实标注。 */
		function storeAlignAll() {
			var __t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
			NS_PERF.aligns += 1;
			var res = { byAnchor: {}, pending: 0, tailAssigned: 0, pendingDeclined: 0, yieldedFallback: 0, anchorMiss: 0, expandPending: 0, pendingNoNode: 0, anchorSeqHit: 0, commandIdHit: 0, commandIdMiss: 0, slotIdHit: 0, newRulesPending: 0,
				// ★ `#A29`：P2′（缺 ② 索引 ⇒ 按 `turn` 兜底）／P1′（三空条目 ⇒ 尾锚兜底）的**如实计数**
				//   —— 与 `res.tailAssigned` 同源累加，供面板点名与探针判据取数（禁静默）。
				indexTurnFallback: 0, noAnchorFallback: 0, indexDegraded: false,
				// ★`#A40`：**回合级条目**（行族 ∈ `turn-tail`/`turn-process`）不进任何锚点行，改由
				//   `conversation.chat.turnTail` 槽渲染（按 turn 分桶）⇒ 可见性由 turnTail 通道保证。
				turnLevel: {}, turnLevelN: 0,
				// obs3S7 段W-2a T2-b 件D：② 面计数（**未定位 = 一等公民**，不进任何行）
				unplacedKeys: [], unplacedReason: {}, authoritative: 0, spatialOn: false, spatialDegraded: false, sessionKeys: [] };   /* 段U12 M2 */
			try {
				var list = storeAnchorUniverse();
				// 段R C3：**被裁锚点非空时**即使页面无任何锚点节点也要继续算 —— 否则 `pending` 会读 0
				//   （= 格② fail2 的**假绿**：卡片静默消失而 `pendingCount` 读 0，UI 连"另有 N 张"都没有）。
				if (!list.length && !odDeclinedN) return res;    // 页面上确无锚点节点 ⇒ 无载体可挂（不标注）
				// ★ T2-b 件D：② 面（`unplaced[]` / `slots[].seq`）；**不可读 ⇒ 两者为 null ⇒ 逐字走旧顺序**
				var unplacedMap = storeUnplacedIds();
				var slotSeqSet = storeSlotSeqSet();
				// ★ obs3S7 段W-2b `(e)④`：② 判为**会话级卡**（(ii) 类）者 ⇒ **不进行、也不进未定位区**
				//   （由状态卡区块承载 ⇒ **不静默丢失**：区块里如实列出条数）。
				var sessionCardIds = storeSessionCardIds();
				// ★★★ T-A/T-B（2026-09-21 obs3S7；用户已签）：**位置判定搬回 B** —— 新框架（默认）只用**权威落点**：
				//   ① 每卡 `slotId`（T-A 读面新增）⇒ 直接采纳；② 显式 `anchorSeq`（登记面命中）⇒ 采纳；**其余 ⇒ 如实 `pending`**。
				//   **② 身份(ctxKey)／③ 时间对齐／④ 尾锚／`cardId` 落点开关／①-b `commandId` 配对臂 = 整体退场**，
				//   仅保留在**旧规则回退位**下（`localStorage["dsh-notice-legacy-render"]="1"`；= `计划 §14` 的"按旧规则渲染"开关）。
				var slotIdSeq = storeSlotIdSeq();          // B 下发（`want.slots`）⇒ 兜底
				var slotIdSeqOwn = storeSlotIdSeqOwn();    // ★(乙)：A 自持（我自己登记到的锚点）⇒ **优先**
				var tNewRules = storeSpatialOn();
				res.spatialOn = !!(unplacedMap || slotSeqSet);
				res.spatialDegraded = storeState.spatial.on === true && storeState.spatial.indexDegraded !== false;
				// ★ `#A29`（P2′）：② 不可读的**单一判定位**（本函数内只算一次）；P2′ 兜底**只在此为真时**生效。
				var idxDeg = storeState.spatial.on === true && storeState.spatial.indexDegraded !== false;
				res.indexDegraded = idxDeg;
				var seqSet = {}, builtSet = {}, tail = list.length ? list[list.length - 1].seq : null, tailTime = -1;
				for (var q = 0; q < list.length; q++) {
					builtSet[list[q].seq] = 1;
					if (typeof list[q].time === "number" && list[q].time > tailTime) tailTime = list[q].time;
				}
				// ★ obs3S7 (丙-lite) ①（用户口径 `#A269` / `ENV §三.18⑩`③）：**`seqSet` = 「登记表（全量行 seq）∪ 已建锚」**
				//   ⇒ 显式 `anchorSeq` 不再因"该行没入锚点表"而被丢弃；**本页无载体节点者 ⇒ 如实 `pendingNoNode`**（**绝不**改判到别的已建锚）。
				seqSet = odRegMerge(builtSet);
				// 段R C3：**目标选择**用的宇宙 = 已建锚点 ∪ **被裁锚点**（身份/时间口径与已建锚点同源）；
				//   被裁锚点**不承载渲染** ⇒ 命中它即"该锚点没建" ⇒ 该条目**如实落 `pending`**（不静默改落它处）。
				//   ⚠️ **`declined` 自 #A131 §4③④ 起只由 `dsh-notice-od-drop` 注入产生**；**裁顶让位走 `yielded`** ⇒
				//   `yielded` 也进 `sel`（供 ①②③ 命中），但命中后**重定向到最近的已建锚点**（`#A132` §2②：**绝不落 pending**）。
				//   ⚠️ 正常情况 `odDeclinedN === 0 && odYieldedN === 0` ⇒ `sel === list` ⇒ **逐字零变化**（判据 ④ 零回归的构造性保证）。
				var sel = list;
				if (odDeclinedN || odYieldedN) {
					sel = list.slice();
					for (var ds = 0; ds < odDeclinedList.length; ds++) sel.push(odDeclinedList[ds]);
					for (var ys2 = 0; ys2 < odYieldedList.length; ys2++) sel.push(odYieldedList[ys2]);
					sel.sort(function (x, y) { return x.seq - y.seq; });
				}
				/** 让位回退用：取**最近的已建锚点**（优先"`at` 之后"的，其次"之前"的，再否则最早的已建锚点） */
				var pickBuiltNearest = function (at) {
					var best = null, bestKey = null;
					for (var i2 = 0; i2 < list.length; i2++) {
						var t2 = list[i2].time;
						if (typeof t2 !== "number") continue;
						var d2 = t2 - at;
						var key2 = (d2 >= 0) ? d2 : (1e9 - d2);   // 之后的优先（d2 越大 ⇒ key 越大）；之前的退居其次
						if (bestKey === null || key2 < bestKey) { bestKey = key2; best = list[i2].seq; }
					}
					if (best !== null) return best;
					return list.length ? list[0].seq : null;
				};
				// obs#3 段P（#A108 二/三/四）：**身份级去重 + 按身份「首次发射时刻」对齐**。
				//   · 身份键：`restart` ⇒ `scheduleId`、`queue` ⇒ `taskId`；**其余 kind 逐条独立（= 旧行为，逐字不变）**。
				//   · 同身份只渲染 `rev` 最大者（= 最新相位 ⇒ 文本原地更新）；**不同身份各自成组**（每次排程各留一张）。
				//   · 对齐输入取**组内最小 `at`**（首次发射时刻）⇒ 后续相位与重启后的 `invalid` 卡**沿用同一锚点**，
				//     不再按各自 `at` 重算、也不再被 ④ 兜到尾锚点（"堆末尾"的直接来源）。
				var groups = [], gmap = {};
				for (var kg = 0; kg < storeState.keys.length; kg++) {
					var keyG = storeState.keys[kg];
					var eG = storeState.byKey[keyG];
					if (!eG || typeof eG.at !== "number") continue;
					var ident = null;
					if (String(eG.kind) === "restart" && eG.scheduleId) ident = "restart|" + eG.scheduleId;
					// 段Q（#A117 §3 口径表 v3）：queue 身份改由 **`ctxKey`** 承载 —— 命令面/入队/熔断/立即派发 ⇒ **唯一**（各成一组 = 独立卡）；
					//   工具面 编辑/取消 ⇒ **稳定**（同组 = 原地更新）。无 `ctxKey` 时回退 `taskId`（兼容旧条目）。
					else if (String(eG.kind) === "queue") {
						var ckQ = (typeof eG.ctxKey === "string" && eG.ctxKey) ? eG.ctxKey : (eG.taskId != null ? "task-" + eG.taskId : null);
						if (ckQ) ident = "queue|" + ckQ;
					}
					if (ident === null) { groups.push({ key: keyG, e: eG, at: eG.at }); continue; }
					var grp = gmap[ident];
					if (!grp) { grp = { key: keyG, e: eG, at: eG.at }; gmap[ident] = grp; groups.push(grp); continue; }
					if (eG.at < grp.at) grp.at = eG.at;
					// ★批9 `B1`（`#A394` 段2）：**组内选择规则 = 取最新写入（`at` 最大）**（原为 `revG > revC`）。
					//   依据 B1 前置只读统计：生产存量（60 组／多候选 25 组）里「`at` 序 ≠ `rev` 序」**0 例** ⇒ **零可见差异**。
					if (eG.at > grp.e.at) { grp.e = eG; grp.key = keyG; }
				}
				for (var k = 0; k < groups.length; k++) {
					var g = groups[k];
					var key = g.key, e = g.e, eAt = g.at;   // `eAt` = 该身份**首次发射**时刻
					// ★`#A40` 回合级分流（**最先判**，先于 P2′/P1′/unplaced 一切落点逻辑）：
					//   行族 ∈ {`turn-tail`,`turn-process`} ⇒ 该卡本属"回合尾行"，交 `turnTail` 槽渲染；
					//   `command`/`tool-call` 行族**不进本支**（命令级/过程级保持原锚点，`#A40` 禁动）。
					if (tNewRules) {
						var _tlv = storeTurnLevelOf(e);
						// `on` ⇒ 回合级（行族 turn-tail/turn-process）；**无 turn 且无行**的三空族 ⇒ 桶 "?"（回合末尾兜底，
						//   与 P1′ 同义，但改由 `turnTail` 槽渲染 ⇒ 可见）。
						var _noTurnNoRow = (e.turn == null && !e.slotId);
						if (histTurnSlotMode === true && (_tlv.on === true || _noTurnNoRow)) {
							var _tk = (_tlv.on === true) ? ((_tlv.turn == null) ? "?" : String(_tlv.turn)) : "?";
							if (!res.turnLevel[_tk]) res.turnLevel[_tk] = [];
							res.turnLevel[_tk].push(key);
							res.turnLevelN += 1;
							continue;
						}
					}
					// ★ T2-b 件D（设计稿 §5.3）：**② 判为未定位 ⇒ 不进任何行**（渲染到"未定位区"）。
					//   只认「有身份（`cardId`）且 ② 明确列入 `unplaced[]`」者；旧卡（无 `cardId`）**不参与**
					//   ⇒ 逐字走既有 ①②③④（= 设计稿「② 无 slotId ⇒ 退回既有顺序」的落地）。
					//   ⚠️ 与"就近落"**正相反**：判未定位后**绝不改判到别处**（计划 v5 §6 裁决 #7）。
					if (!tNewRules && unplacedMap && typeof e.cardId === "string" && e.cardId && unplacedMap[e.cardId]) {
						res.unplacedKeys.push(key);
						res.unplacedReason[e.cardId] = unplacedMap[e.cardId];
						continue;
					}
					// `(e)④`：会话级卡（(ii) 类）⇒ **不落任何行**（走状态卡区块）
					if (!tNewRules && typeof e.cardId === "string" && e.cardId && sessionCardIds[e.cardId]) { res.sessionKeys.push(key); continue; }   /* 旧规则才用 `cardId` 当落点开关 */
					var target = null;
					var authoritative = false;
					// ★★★ T-B 新框架（默认）：**只认 B 的权威落点**，其余如实 `pending`（**不渲染、不猜**）
					if (tNewRules) {
						var sidT = (typeof e.slotId === "string" && e.slotId) ? e.slotId : null;
						// ★(乙)：**先查 A 自持表**（不依赖 `want.slots`）⇒ 再退回 B 的 `slots`（兜底）——
						//   据 = 我方实际挂载的锚点 seq 才是"有节点可渲染"的那个（`want.slots` 的 seq 可能是 `command/run`）。
						var sseqT = null;
						if (sidT) {
							if (slotIdSeqOwn && slotIdSeqOwn[sidT] != null) sseqT = slotIdSeqOwn[sidT];
							else if (slotIdSeq && slotIdSeq[sidT] != null) sseqT = slotIdSeq[sidT];
						}
						if (sseqT != null && seqSet[sseqT]) { target = sseqT; authoritative = true; res.slotIdHit += 1; res.authoritative += 1; }
						else if (typeof e.anchorSeq === "number" && seqSet[e.anchorSeq]) { target = e.anchorSeq; res.anchorSeqHit += 1; }
						else {
							// 未定位（② 判）/ 会话级（② 判 `placeState:"session"`）**照实分流**；其余 ⇒ 如实 `pending`
							if (e.placeState === "session" || (typeof e.cardId === "string" && e.cardId && sessionCardIds && sessionCardIds[e.cardId])) { res.sessionKeys.push(key); continue; }
							var _pl = (typeof e.placeState === "string") ? e.placeState : null;
							var _cid = (typeof e.cardId === "string" && e.cardId) ? e.cardId : null;
							// ★★★ `#A29` 步1 · **P2′：缺 ② 索引不得整会话 0 卡**（2026-11-14；依据
							//   `log/0.2.2升级/证据-P1P2改码与0卡归因.md §3.1(b)`）。
							//   **要解决或预防的问题**：②（`index/<sid>.json`）缺失时 `notice/list` 回
							//   `indexDegraded` ＋ `slots:[]`/`unplaced:[]` ⇒ 上面两个权威臂必然全落空 ⇒ **整会话静默 0 卡**
							//   （实证：移走 ② ⇒ 24→0、无任何提示）。兜底 = **按条目 `turn` 归到该回合锚点**：
							//   `storeState.turnAnchor[turn]` 由**宿主 `turn/start`/`turn/end` 事件在客户端本地登记**，
							//   **与 ② 索引无关** ⇒ 索引缺失只降位置精度（回合级而非行级），不再整会话消失。
							//   **判据**：`indexDegraded === false`（健康）⇒ 本段不执行 ⇒ **逐字零变化**。
							if (idxDeg && e.turn != null) {
								var _tb = null;
								try { _tb = storeState.turnAnchor[e.turn] != null ? storeState.turnAnchor[e.turn] : null; } catch (e8) { _tb = null; }
								if (_tb != null && (builtSet[_tb] || seqSet[_tb])) { target = _tb; res.indexTurnFallback += 1; }
							}
							// ★★★ `#A29` 步2 · **P1′：`turn`/`ctxKey`/`anchorSeq` 三空条目保底落点**（2026-11-14）。
							//   三空 ⇒ 该条目在 ①/② 里**没有任何回合或行身份**（发射侧本就不带，实证 `fc0fab62` 4 条：
							//   `cost start` / `ledger start` / `cost replace rev1/2`）⇒ 旧行为进「未定位区」
							//   （`⚠ N 张卡找不到行落点`，默认收起 = 事实上看不见）。
							//   兜底 = 归**尾锚（`tail` = 最后一个已建锚 = 开放尾/回合末尾）**，与既有 ④ 尾锚口径同源；
							//   **仍走既有 `nsFoldPlan` 折叠合成**（**禁新造第三种观感**）。
							//   ⚠️ **只对三空条目生效**：带 `turn`/`ctxKey`/`anchorSeq` 的条目**一字不动**
							//   （`#A269`：禁把有身份的卡改判到别的锚点）。`placeState:"session"` 已在上面分流。
							if (target == null && _pl !== "session" && !(typeof e.anchorSeq === "number") && !(typeof e.ctxKey === "string" && e.ctxKey) && e.turn == null && tail != null) {
								target = tail; res.tailAssigned += 1; res.noAnchorFallback += 1;
							}
							if (target == null) {
								// ★批12 段A（2026-10-17；用户签：零新区域/零新样式）：**"无落点必可见"** ——
								//   读面 `notice/list` 已按位下发**逐条** `placeState`（`index.js` `T-A` 面，`place.aligned` 1:1 同序）
								//   ⇒ ② 判 `unplaced` 的条目**一律进既有「未定位区」**（`data-notice-unplaced-block`），
								//   **不再因 `cardId` 缺失被静默丢成 `pending`**；`cardId` 映射降为**旧服务端兜底**（读面无 `placeState` 时）。
								if (_pl === "unplaced" || (_pl === null && unplacedMap && _cid && unplacedMap[_cid])) {
									res.unplacedKeys.push(key);
									res.unplacedReason[_cid || ("k|" + key)] = (_cid && unplacedMap && unplacedMap[_cid]) || "no-anchor";
									continue;
								}
								res.pending += 1; res.newRulesPending += 1; continue;
							}
						}
					}
					// ★段U17 B1：**显式 `anchorSeq` 优先**（发射侧带上"自己那一行"的 seq）—— 仅当该 seq **在锚点宇宙内**生效；
					//   否则**逐字退回**既有 ①②③④（不落空、不挤堆）。未带 `anchorSeq` 的条目**语义逐字不变**。
					//   ★ T2-b 件D（设计稿 §5.3「② 有 `slotId` ⇒ **直接用它**」）：② 在且该 seq 属 ② 的 `slots[]`
					//   ⇒ **权威落点** ⇒ **不再被 ①身份对齐/③时间对齐/④尾兜底改写**（否则"② 的落点"永远只是候选）。
					//   ② 不在 / 该 seq 不在 `slots[]` ⇒ 逐字退回既有 ①②③④（`authoritative` 保持 false）。
					// ★ **T9-fix 乙（仲裁 `#A231` 三）= 本节为"规范"而非实现细节**：
					//   **A 仅在「条目自身声明了 `anchorSeq`」且「该 seq 命中 ② 的 `slots[]`」时才采纳 ② 的 `slotId`**；
					//   `anchorSeq` 缺席（如 `ledger`/`status` 族）的条目**一律**走下段既有 ①②③④（现状即如此，
					//   本句只是把"当前不采纳 ② slotId"这一行为**写成规范**，**零渲染变化**）。
					//   ⇒ 理由（机械）：`anchorSeq=null` 的条目在 ② 里落 `turn 臂`，而 turn 臂在修复前可能指向
					//   `turn-process<turn>` = **被 `hidden="until-found"` 隐藏的回合容器行** ⇒ 若 A 采纳它，卡会**真消失**
					//   （T9 实测：宿主确实隐藏该行；见 `log/obs3-s7/w2b-t9-verdicts.md`）。
					if (!tNewRules && typeof e.anchorSeq === "number" && seqSet[e.anchorSeq]) {   /* ★ seqSet = 登记表 ∪ 已建锚（丙-lite ①）；新框架已在上面处理 */
						target = e.anchorSeq; res.anchorSeqHit += 1;
						if (slotSeqSet && slotSeqSet[e.anchorSeq]) { res.authoritative += 1; authoritative = true; }
					}
					// ★①-b **(乙) T18 键1：`commandId` 配对**（2026-09-20 用户已签；`#A27` 选型结论）
					//   位置 = ①（显式 `anchorSeq`）**之后**、`if (!authoritative) {` **之前** ⇒ 与 ① 同层：
					//   **命中即 `target` 定为该命令自己的 `command/done` seq 且 `authoritative = true`**
					//   （⇒ ②③④ 一律不改写；该行未挂载 ⇒ 由既有 `pendingNoNode` 如实计数，绝不改落它处）。
					//   配对失败（命令失败/无 `command/done`/该 seq 未见过）⇒ **如实计数 `commandIdMiss` 后**继续走既有 ②③④
					//   （= 与装前逐字同行为，**不静默改落点、也不报 OK 而功能坏**；未命中率见 `RENDER`/`obs-json` 计数）。
					if (!tNewRules && target == null && typeof e.commandId === "string" && e.commandId) {   /* ①-b：新框架退场（B 判位置） */
						var cSeq = odCmdSeq(e.commandId);
						if (cSeq != null && seqSet[cSeq]) { target = cSeq; res.commandIdHit += 1; authoritative = true; res.authoritative += 1; }
						else res.commandIdMiss += 1;
					}
					// ⚠️ T2-b 件D：**② 权威时整段 ①②③④ 不再执行**（`authoritative === true`）——
					//   否则既有"①身份对齐/③时间对齐/让位重定向"会把 ② 的落点**改写掉**（实测：卡被改判到回合锚点）。
					if (!tNewRules && !authoritative) {   /* ②③ + 让位重定向：**仅旧规则回退位** */
					// ① 身份对齐：turn ⇒ 该回合锚点 seq（turn/end 优先）
					var byTurn = null;
					if (e.turn != null) {
						try { byTurn = storeState.turnAnchor[e.turn] != null ? storeState.turnAnchor[e.turn] : null; } catch (e1) { byTurn = null; }
					}
					if (byTurn != null && (seqSet[byTurn] || (odYieldedN && odYieldedMap[byTurn]))) target = byTurn;
					// ★ 段U4 U5b：**名单缺口探测**（**只计数、不改落点**）—— 该条目的回合在 `odSeen` 里**确有** `turn/end` 锚点，
					//   身份对齐却取不到它（既没建、也没进让位名单）⇒ "按需名单"缺了这一条 = 坏名单（`#E3` 臂 W 实证：锚点永不重建 ⇒ 挤堆）。
					if (byTurn == null && e.turn != null && !odBk.cold && odCacheTurnEnd[e.turn] != null) res.anchorMiss += 1;
					// ② 身份对齐：ctxKey 内的事件 seq（如 `cost-<seq>` / `ledger-<seq>`）
					if (target == null && typeof e.ctxKey === "string") {
						// 段Q（#A117 §4-1）：**前缀白名单** —— 路径② 只认"内嵌真实锚点 seq"的既有形态（`cost-<seq>` / `ledger-<seq>`）；
						//   否则 `queue-<taskId>`（任务号 ≥1000）或 `balance-<13 位毫秒>` 这类**可能撞上真实锚点 seq** ⇒ 误命中。
						/* ★`#A67`：把**会话级命令卡**的 `ctxKey` 也纳入「内嵌真实锚点 seq」的既有形态
						 *  （`restart-<seq>`／`queue-<seq>`／`error-<seq>`／`compat-<seq>`）—— 0.1.2 时代这些卡靠事件信封的
						 *  `turn/turnFrom` 定位（现读归档：`restart` 493 条**全部**无 `ctxKey`/无 `commandId`/无 `anchorSeq`），
						 *  0.2.2 的 banner-kit 写 store 时丢了 turn ⇒ 退化成回合/兜底。补 seq 形态后即可回到"自己那一行"。 */
						var mt = /^(?:cost|ledger|restart|queue|error|compat)-(\d{4,})$/.exec(e.ctxKey);
						if (mt && (seqSet[Number(mt[1])] || (odYieldedN && odYieldedMap[Number(mt[1])]))) target = Number(mt[1]);
					}
					// 段R C3（**仅注入面**）：①② 都没命中**已建**锚点，但该条目的「**身份首选锚点**」属**被裁锚点**
					//   ⇒ **不得静默改落它处**：如实落 `pending`（与 PEND 行同源同函数 ⇒ 计数如实）。
					// ★段U10 L1′：**本页发生过扩窗**时，**回合类条目若取不到自己的锚点 ⇒ 如实落 `pending`**
					//   （禁走 ③ 时间对齐 ⇒ 禁"重定向到最近已建锚点"⇒ **禁挤堆**）。**仅 `odExpandPass===true` 时生效**，非扩窗路径逐字不变。
					if (target == null && e.turn != null && odExpandPass && !odDeclinedN) { res.pending += 1; res.expandPending += 1; continue; }
					if (target == null && odDeclinedN) {
						var candD = (byTurn != null) ? byTurn : null;
						if (candD == null && typeof e.ctxKey === "string") {
							var mtd = /^(?:cost|ledger)-(\d{4,})$/.exec(e.ctxKey);
							if (mtd) candD = Number(mtd[1]);
						}
						if (candD != null && odDeclinedMap[candD]) { res.pending += 1; res.pendingDeclined += 1; continue; }
					}
					// ③ 时间对齐（只认有 time 的锚点；★ T14 起**只有白名单 kind 走此臂**、且**只朝 `at` 之后**取最近锚点）
					if (target == null) {
						// obs#3 段O（#A102 四 ②）+ 段P（#A108 三）：**命令/事件类白名单**先试「`at` 之后**最近**锚点」，
						//   但**仅当**其时间距离 ≤ `CMD_ANCHOR_MAX_GAP_MS`（Δ）才采用；否则**如实不落**（T14 前为"回退旧语义"）
						//   —— 严防「前进跳 / 位置漂移」（绝不放任落到下一个不相关锚点）。
						//   段P 扩入 `restart`/`queue`：Δ 沿用 1000 ms（实测正例后继 +8 ms ≪ Δ、反例后继 +23~27 s ≫ Δ ⇒ T14 起**自动如实不落**）。
						var kindS = String(e.kind);
						var pickAfter = (kindS === "balance" || kindS === "costs" || kindS === "cost" || kindS === "restart" || kindS === "queue");
						var bestT = null;
						for (var jx = 0; jx < sel.length; jx++) {
							var tj = sel[jx].time;
							if (typeof tj !== "number") continue;
							if (pickAfter) { if (tj < eAt) continue; if (bestT === null || tj < bestT) { bestT = tj; target = sel[jx].seq; } }
							// ★ T14（obs3S7 段 2b-G1-a 件1；仲裁 `#A15` 已批改动面）：**原 `else if (tj <= eAt) target = sel[jx].seq;` 已删** ——
							//   名单外 kind **不得**"恒取 `at` 之前最后一个锚点"（`ENV §三.18⑩②`：渲染到别的锚点 = 缺陷，`#A269`）⇒ **如实不落**（走 ④窄例外 / `pending`）。
						}
						// **Δ 保护**：之后最近锚点超出上限 ⇒ 丢弃它并**如实不落**（`pending` / ④窄例外；**不是**"回退旧语义"、也不是尾锚点兜底）。
						// ★ T14（同上）：**原超 Δ 后的二次猜测重扫已删** —— 原为 `target = null;` ＋ `for (…) if (tb <= eAt) target = sel[jb].seq;`
						//   ⇒ 超 Δ 一律如实不落，不再贴到"`at` 之前最后一个锚点"（`#A269`）。`CMD_ANCHOR_MAX_GAP_MS` 与本行 Δ 名单**未动**。
						if (pickAfter && (target === null || bestT === null || (bestT - eAt) > CMD_ANCHOR_MAX_GAP_MS)) target = null;
					}
					// 段R C3：③ 时间对齐若命中**被裁锚点**（仅注入）⇒ 如实落 `pending`（该锚点没建 ⇒ 没有载体可渲染）
					if (target != null && odDeclinedN && odDeclinedMap[target]) { res.pending += 1; res.pendingDeclined += 1; continue; }
					// ★ 段R 路线A（`#A131` §4④ + `#A132` §2②）：命中**让位锚点** ⇒ **重定向到"最近的已建锚点"**渲染，
					//   **绝不落 `pending`**（⇒ 保险值被触发时"可见卡不减少"，只降位置精度）。`yieldedFallback` 如实计数。
					if (target != null && odYieldedN && odYieldedMap[target]) {
						var nbY = pickBuiltNearest(eAt);
						if (nbY != null) { target = nbY; res.yieldedFallback += 1; }
					}
					}   // ← `if (!authoritative)` 结束（② 权威 ⇒ ①②③ 与让位重定向全部跳过）
					// ④ 窄例外（#A77 四；#A108 四：身份已定 ⇒ 判定用**组内最小** `at`，不再按单条 `at` 改判 tail）
					if (!tNewRules && target == null && tail != null && e.turn == null && tailTime >= 0 && eAt >= tailTime) {   /* ④ 尾锚：仅旧规则 */ target = tail; res.tailAssigned += 1; }
					// 无载体 ⇒ pending（**不落任何锚点**；窗口外旧回合条目走这条）
					if (target == null) { res.pending += 1; continue; }
					if (!storeState.anchorMounted[target]) res.pendingNoNode += 1;   /* 段U12 M2：指派到"本页从未挂载"的槽 ⇒ 如实计数（只计数、不改渲染） */
					if (!res.byAnchor[target]) res.byAnchor[target] = [];
					res.byAnchor[target].push(key);
				}
			} catch (e3) { /* 降级为空气，绝不上抛 */ }
			// ★ `#A29`（P2′/P1′）**面板点名**（唯一计算点）：
			//   `index-degraded` = ② 索引不可读（`indexDegraded` 非 false）；`anchor-degraded` = 本次对齐里
			//   有**三空条目**被兜底到尾锚（P1′ 生效）。两者**只进面板/诊断面**（`data-notice-hint` ＋
			//   `window.__DSH_NOTICE_HINT__` ＋ `__test.storeRender.state()`）—— **禁进会话界面**
			//   （用户 2026-11-14 明确：不做界面提示）。健康会话 ⇒ `codes === ""` ⇒ 面板**不渲染该行**。
			try {
				var _hintCodes = [];
				if (res.indexDegraded) _hintCodes.push("index-degraded");
				if (res.noAnchorFallback > 0) _hintCodes.push("anchor-degraded");
				res.hintCodes = _hintCodes;
				res.hint = _hintCodes.join(",");
				storeRenderState.hint = res.hint;
				try { window.__DSH_NOTICE_HINT__ = { index: res.indexDegraded ? "index-degraded" : "", anchor: res.noAnchorFallback > 0 ? "anchor-degraded" : "", codes: res.hint, sid: storeState.sessionId || null }; } catch (eH1) { /* 无 window ⇒ 只留状态位 */ }
			} catch (eH0) { /* 点名失败绝不影响对齐结果 */ }
			if (__t0) { NS_PERF.alignMs += performance.now() - __t0; if ((NS_PERF.aligns & 31) === 0) nsPerfFlush(); }
			return res;
		}
		/** 某个锚点节点应渲染的条目键（**身份优先 + 锚点宇宙 + 落点策略 A**）；空数组 ⇒ 渲染空气。 */
		function storeKeysForAnchor(seq) {
			var a = storeAlignAll();
			return a.byAnchor[seq] ? a.byAnchor[seq] : [];
		}
		/** 优雅重启面板 (kind=restart 横幅内嵌, v0.9.0): 显示排程状态, 提供 [确认重启]/[取消] 按钮
		 *  (经 /graceful-restart RPC, 零 token); 确认后服务端静默观察 10s 自然退出。
		 *  状态: scheduled(等待空闲) / ready(空闲待确认) / observing(静默观察中) / exiting(正在退出)
		 *        / cancelled / timedout / error / invalid(重启前未执行已失效, v0.9.6) / none。 */
		var RESTART_PHASE_TEXT = {
			scheduled: "等待所有会话/子agent空闲…",
			ready: "环境已空闲，等待确认",
			observing: "已确认，正在等待环境静默", // v0.9.2: 倒计时在面板内实时显示
			exiting: "正在优雅重启…", // v0.9.2: 最终定格文案 (GUI 将断开约 10-30s 后自动恢复)
			cancelled: "已取消",
			timedout: "已超时自动取消（15 分钟未确认）",
			error: "退出失败（appExit 不可用），请手动重启",
			invalid: "已失效（容器已重启，排程作废）", // v0.9.6: 重启前未执行的排程
			none: "无进行中的重启排程"
		};
		/** v0.9.2: 静默观察 10s 倒计时 — client 本地每秒递减 (banner.remainSec 是排程总剩余, 非观察剩余) */
		var QUIET_WINDOW_SEC = 10;
		var RestartPanel = React.memo(function RestartPanel(props) {
			var p = props.p;
			var banner = props.banner || {};
			var phase = banner.phase || "none";
			var reason = typeof banner.reason === "string" && banner.reason ? banner.reason : "";
			var remain = typeof banner.remainSec === "number" ? banner.remainSec : 0;
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var msgState = React.useState("");
			var msg = msgState[0];
			var setMsg = msgState[1];
			var errState = React.useState("");
			var err = errState[0];
			var setErr = errState[1];
			// v0.9.4: observing 倒计时 — 进入 observing 或收到新 observing replace (带 note 重置)
			// 时重置倒计时起点; 每 250ms 递减到 0。到 0 不本地切换文案 — 只有服务端真实
			// exiting 事件才显示"正在优雅重启…" (否则活动重置时 client 会误显示重启中)。
			var countdownState = React.useState(null); // { start: ts, sec: n }
			var countdown = countdownState[0];
			var setCountdown = countdownState[1];
			React.useEffect(function () {
				if (phase === "observing") {
					setCountdown({ start: Date.now(), sec: QUIET_WINDOW_SEC });
					var iv = setInterval(function () {
						setCountdown(function (prev) {
							if (!prev) return prev;
							var elapsed = Math.floor((Date.now() - prev.start) / 1000);
							var left = Math.max(0, QUIET_WINDOW_SEC - elapsed);
							if (left === prev.sec) return prev;
							return { start: prev.start, sec: left };
						});
					}, 250);
					return function () { clearInterval(iv); };
				}
				setCountdown(null);
				return undefined;
			}, [phase, banner.at]); // A106: at 为准（新卡无 time，老卡 at 与 time 同值）
			// v0.9.7: 僵尸横幅自愈 — 容器重启后服务端 intent 内存态已清空, 但重启前排程的横幅事件
			// 持久化在会话日志里, client 重放会显示"等待空闲/倒计时"的僵尸横幅 (点确认只会报 not-found)。
			// 服务端 v0.1.10 的启动扫描只能覆盖"启动时已 live"的会话 (后来才打开的旧会话扫不到),
			// 所以这里渲染 active 相位 (scheduled/ready/observing) 时向服务端核对一次 status:
			//   · 无排程 (phase=none) 或 scheduleId 不匹配 → 判为失效 (复用 invalid 文案/无按钮)
			//   · 查询失败 (ok:false / 传输错误) → 视为"不确定", 保持原样, 绝不误判
			var staleState = React.useState(false);
			var stale = staleState[0];
			var setStale = staleState[1];
			React.useEffect(function () {
				if (!(phase === "scheduled" || phase === "ready" || phase === "observing")) {
					setStale(false);
					return undefined;
				}
				var alive = true;
				restartRpc("status", {}).then(function (result) {
					if (!alive || !result || !result.ok) return;
					var v = result.value || {};
					// v0.9.7 判据 (兼容旧服务端 v0.1.9 及更早: 其 status 不回 scheduleId):
					//   服务端 phase=none                → 僵尸 (无排程)          → 失效
					//   服务端有排程 + 双方都有 scheduleId 且不等 → 旧排程遗留      → 失效
					//   服务端有排程 + 任一方无 scheduleId  → 无法区分, 视为有效   → 不动 (绝不误判)
					var hasPhase = !!v.phase && v.phase !== "none";
					var idMismatch = !!v.scheduleId && !!banner.scheduleId && v.scheduleId !== banner.scheduleId;
					setStale(!hasPhase || idMismatch);
				});
				return function () { alive = false; };
			}, [phase, banner.scheduleId]);
			function act(endpoint, okText) {
				if (busy) return;
				setBusy(true);
				setErr("");
				setMsg("");
				restartRpc(endpoint, {}).then(function (result) {
					setBusy(false);
					if (result.ok) setMsg(okText);
					else setErr((result.error && result.error.message) || "操作失败");
				});
			}
			var canConfirm = phase === "ready" && !busy && !stale; // v0.9.7: 僵尸横幅不给按钮
			var canCancel = (phase === "scheduled" || phase === "ready" || phase === "observing") && !busy && !stale;
			// v0.9.5: observing 显示倒计时剩余秒 (accent 色); 服务端活动重置会发带 note 的
			// replace (原因文案 + 重置倒计时)。倒计时到 0 不卡住 — 显示"正在检测环境…"
			// 过渡态, 等服务端结果事件 (exiting → 定格重启中 / note → 原因 + 重新倒计时)
			var statusText = RESTART_PHASE_TEXT[phase] || phase;
			var statusTail = null;
			var countdownDone = phase === "observing" && countdown && countdown.sec === 0;
			// v0.9.6: invalid (重启前未执行已失效) 用服务端 note 文案 (如有), 无按钮
			if (stale) {
				statusText = RESTART_PHASE_TEXT.invalid; // v0.9.7: 僵尸横幅 (服务端已无对应排程)
			} else if (phase === "invalid" && typeof (banner.statusNote || banner.note) === "string" && (banner.statusNote || banner.note)) {
				statusText = (banner.statusNote || banner.note);
			} else if (phase === "observing" && typeof (banner.statusNote || banner.note) === "string" && (banner.statusNote || banner.note)) {
				statusText = (banner.statusNote || banner.note); // 服务端通知的原因 (活动重置)
			} else if (countdownDone) {
				statusText = "正在检测环境…"; // v0.9.5: 倒计时结束, 等服务端判定结果
			}
			if (phase === "observing" && countdown && countdown.sec > 0) {
				statusTail = React.createElement(
					"span",
					{ style: { color: p.accent, fontWeight: 700, fontVariantNumeric: "tabular-nums", flex: "none", marginLeft: 6, fontSize: 12.5 } },
					countdown.sec + "s"
				);
			}
			return React.createElement(
				"div",
				// v0.9.6: 内嵌面板与其他家族内嵌卡片一致 — 圆角 8 (原 10), 背景走 --dsh-rp-bg
				// 变量随深浅主题翻转 (原硬编码 rgba(255,255,255,0.03) 浅色下几乎不可见)
				{ style: { marginTop: 8, padding: "8px 10px", border: "1px solid " + p.border, borderRadius: 8, background: "var(--dsh-rp-bg)" } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 } },
					React.createElement(
						"span",
						{ style: { flex: "none", fontSize: 13, lineHeight: 1, animation: phase === "observing" || phase === "scheduled" ? "1.2s linear infinite dsh-status-spin" : undefined, display: "inline-block" } },
						phase === "exiting" ? "✅" : phase === "cancelled" || phase === "timedout" || phase === "invalid" ? "🛑" : phase === "error" ? "⚠️" : "⟳"
					),
					React.createElement(
						"span",
						{ style: { color: p.body, flex: "1 1 auto", minWidth: 0 } },
						statusText
					),
					statusTail,
					remain > 0 && phase !== "exiting" && phase !== "observing"
						? React.createElement("span", { style: { color: p.meta, fontSize: 11, flex: "none" } }, Math.ceil(remain / 60) + " 分钟内有效")
						: null
				),
				reason
					? React.createElement(
							"div",
							{ style: { color: p.meta, fontSize: 12, marginTop: 4 } },
							"原因: " + reason
						)
					: null,
				React.createElement(
					"div",
					{ style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } },
					canConfirm
						? btn("确认重启", function () { act("confirm", "已确认，正在静默观察…"); }, false, "primary")
						: null,
					canCancel
						? btn("取消", function () { act("cancel", "已取消重启排程"); }, false, "default")
						: null,
					msg
						? React.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary, #22c55e)", fontSize: 12, alignSelf: "center" } }, msg)
						: null,
					err
						? React.createElement("span", { style: { color: "#ef4444", fontSize: 12, alignSelf: "center" } }, err)
						: null
				)
			);
		});

		/** 任务队列可编辑面板 (kind=queue 横幅内嵌, v0.4.0): 实时拉 /queue/list,
		 *  每个排队任务可 编辑(textarea)/保存/取消/立即派发, 操作后自动刷新并给行内反馈;
		 *  已派发/已取消只读展示 —— "派发前可编辑, 下发了一切方休"。零 token (不走模型回合)。
		 *  v0.8.0: variant=primary(蓝)/success(绿)/danger(红)/默认(玻璃底)。 */
		function btn(label, onClick, disabled, variant) {
			var v = variant === "primary"
				? { bg: "var(--dsh-btn-primary-bg)", bd: "var(--dsh-btn-primary-bd)", tx: "var(--dsh-btn-primary-tx)" }
				: variant === "success"
					? { bg: "var(--dsh-btn-success-bg)", bd: "var(--dsh-btn-success-bd)", tx: "var(--dsh-btn-success-tx)" }
					: variant === "danger"
						? { bg: "var(--dsh-btn-danger-bg)", bd: "var(--dsh-btn-danger-bd)", tx: "var(--dsh-btn-danger-tx)" }
						: { bg: "var(--dsh-btn-bg)", bd: "var(--dsh-glass-bd)", tx: "var(--dsw-alias-label-primary, #eceff4)" };
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dsh-gbtn",
					"data-variant": variant || "default",
					onClick: onClick,
					disabled: !!disabled,
					style: {
						fontSize: 11.5,
						padding: "0 12px",
						// v0.8.2: lineHeight 必须给字符串 "26px" —— React 把数字 lineHeight
						// 当无单位倍率渲染 (line-height: 26 → 26×11.5px=299px 行高, 按钮被撑成
						// 301px 高, 手机横幅上"展开/刷新"等按钮非常长)。同文件其他小数
						// lineHeight (1.5/1.6/1.75) 是刻意用倍率, 不受影响。
						lineHeight: "26px",
						borderRadius: 8,
						border: "1px solid " + v.bd,
						background: v.bg,
						color: v.tx,
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.5 : 1,
						flex: "none",
						backdropFilter: "blur(4px)",
						WebkitBackdropFilter: "blur(4px)",
						transition: "all .2s ease"
					}
				},
				label
			);
		}

				/** 任务状态标签样式 (v0.5.0 手风琴卡片; v0.8.0 液态玻璃: 排队中=蓝 / 已派发=绿 /
				 *  已取消=灰色系; 浅色主题颜色经 --dsh-st-* 变量自动翻转) */
		var QUEUE_STATUS_STYLE = {
			pending: { label: "排队中", color: "var(--dsh-st-pending-tx)", bg: "rgba(65,118,230,0.12)", border: "var(--dsh-st-pending-bd)" },
			// v0.8.3: 排队发送中 —— 已派发但目标会话正忙, 消息仍在收件箱排队未执行 (可撤回取消)
			queuedSending: { label: "排队发送中", color: "var(--dsh-st-qs-tx)", bg: "rgba(245,158,11,0.12)", border: "var(--dsh-st-qs-bd)" },
			dispatched: { label: "已派发", color: "var(--dsh-st-dispatch-tx)", bg: "rgba(34,197,94,0.10)", border: "var(--dsh-st-dispatch-bd)" },
			cancelled: { label: "已取消", color: "var(--dsh-st-cancel-tx)", bg: "var(--dsh-st-cancel-bg)", border: "var(--dsh-st-cancel-bd)" },
			// v0.11.5 (2026-09-14, 用户实测「已派发失踪」): 补齐服务端 STATUS_TEXT 的 5 态 ——
			//   此前只声明 4 态且 statusTag 的 `|| QUEUE_STATUS_STYLE.pending` 兜底, 把 152 个
			//   已完成任务全显示成蓝色「排队中」。终态必须与"还在排队"区分开 (见 statusKind)。
			done: { label: "已完成", color: "var(--dsh-st-done-tx)", bg: "var(--dsh-st-done-bg)", border: "var(--dsh-st-done-bd)" },
			// 失败 = 仅系统熔断 (派发异常 / 消息被丢 / 连续无 claim); 用户点取消得到的是 cancelled
			failed: { label: "失败", color: "var(--dsh-st-fail-tx)", bg: "var(--dsh-st-fail-bg)", border: "var(--dsh-st-fail-bd)" },
			// v0.11.6 (2026-09-14 用户拍板): 「重启丢弃」独立标识 —— 意外重启清空 inbox 导致消息未执行,
			//   既非用户主动取消、也不是任务失败 ⇒ 必须与「已取消」在标签与配色上都能区分 (红系 + 独立文案)。
			restartDrop: { label: "已取消 · 重启丢弃", color: "var(--dsh-st-restartdrop-tx)", bg: "var(--dsh-st-restartdrop-bg)", border: "var(--dsh-st-restartdrop-bd)" }
		};

		/** 任务显示族 (v0.11.5): 只有 active / dispatched 可操作, 其余只读弱化。
		 *  unknown = 服务端出现本面板未声明的状态 (版本不匹配) —— **绝不兜底成「排队中」**,
		 *  标签显示原值并加「未适配」前缀 + 面板顶部告警 (2026-09-14 用户拍板: 宁愿报错)。 */
		function statusKind(t) {
			if (!t) return "unknown";
			if (t.status === "pending") return "active";
			if (t.status === "dispatched") return t.queuedSending ? "active" : "dispatched";
			if (t.status === "done" || t.status === "cancelled") return "terminal";
			if (t.status === "failed") return "error";
			return "unknown";
		}

		/** ISO 时间 → 北京时区 "MM-DD HH:mm" */
		function beijingTime(iso) {
			if (!iso) return "";
			try {
				return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ");
			} catch { return ""; }
		}

		/** 压缩连续空白为单空格 (折叠行摘要用) */
		function oneLine(s) {
			return String(s ?? "").replace(/\s+/g, " ").trim();
		}

		// =====================================================================
		// v0.7 (cost v2 双模式): 填入输入框的 DOM 辅助 (官方 inputActions.setDraft
		// 优先, 见 NoticeBannerView; 此处为兜底 + 读当前草稿/聚焦)
		// =====================================================================
		function composerTextarea() {
			try {
				var byPhase = document.querySelectorAll("textarea[data-phase]");
				if (byPhase.length && byPhase[0]) return byPhase[0];
				var all = document.querySelectorAll("textarea");
				var best = null, max = 0;
				for (var i = 0; i < all.length; i++) {
					var r = all[i].getBoundingClientRect();
					var area = r.width * r.height;
					if (area > max) { max = area; best = all[i]; }
				}
				return best;
			} catch { return null; }
		}
		/** 当前输入框草稿 (点击瞬间读取, 避免过期闭包) */
		function composerDraftText() {
			var el = composerTextarea();
			return el ? (el.value || "") : "";
		}
		/** DOM 兜底写入: React 受控 textarea 用原生 value setter + input 事件 */
		function writeComposerDom(text) {
			var el = composerTextarea();
			if (!el) return;
			var proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
			var setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
			if (setter) setter.call(el, text); else el.value = text;
			try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch { /* ignore */ }
		}
		function focusComposer() {
			var el = composerTextarea();
			if (el) { try { el.focus(); } catch { /* ignore */ } }
		}

		/** 彩色状态标签 (v0.8.0: 尺寸/圆角按液态玻璃方案, 颜色走 --dsh-st-* 变量;
		 *  v0.8.3: dispatched + queuedSending → "排队发送中" 琥珀标签) */
		function statusTag(t) {
			// v0.11.6: 重启丢弃走独立变体 (标签/配色与「已取消」区分)
			var stKey = t.status === "dispatched" && t.queuedSending ? "queuedSending"
				: (t.status === "cancelled" && t.dropCause === "restart") ? "restartDrop"
					: t.status;
			var kind = statusKind(t);
			var st = QUEUE_STATUS_STYLE[stKey];
			var label = null;
			if (!st) {
				// 未声明状态: 原样显示 (v0.11.5) —— 不再兜底成「排队中」
				st = { color: "var(--dsh-st-unknown-tx)", bg: "var(--dsh-st-unknown-bg)", border: "var(--dsh-st-unknown-bd)" };
				var raw = (typeof t.statusText === "string" && t.statusText) ? t.statusText : String(t.status == null ? "?" : t.status);
				label = "未适配: " + raw;
			} else {
				// v0.11.5: 面板本地表优先 (文案经用户确认: 已完成/失败); 仅当本地缺 label 时才用服务端 statusText
				label = (st.label || ((typeof t.statusText === "string" && t.statusText) ? t.statusText : String(t.status == null ? "?" : t.status)));
			}
			return React.createElement(
				"span",
				{
					className: "dsh-st",
					"data-state": t.status,
					"data-kind": kind,
					style: {
						flex: "none", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
						padding: "0 8px", lineHeight: "18px", borderRadius: 7,
						background: st.bg, color: st.color,
						border: (kind === "unknown" ? "1px dashed " : "1px solid ") + st.border
					}
				},
				label || st.label
			);
		}

		/**
		 * 任务队列可编辑面板 (v0.5.0 手风琴卡片式): 默认只露出约 3 行任务 (maxHeight 92px),
		 * 点某任务行展开该任务完整卡片 (手风琴, 每次一条) —— 完整内容 + 全部控件, "打开一次
		 * 就能干完所有事"; 面板可整体放大 (maxHeight 380px) 滚动浏览全部任务。
		 * 状态色: 排队中=蓝 / 已派发=绿 / 已取消=琥珀橙; 已派发/已取消弱化+划线只读。
		 * 数据经 /queue RPC 实时拉取 (dsh-taskqueue v0.4.0, 零 token)。
		 */
		var QueuePanel = React.memo(function QueuePanel(props) {
			var p = props.p;
			var dataState = React.useState(null);
			var data = dataState[0];
			var setData = dataState[1];
			var loadingState = React.useState(false);
			var isLoading = loadingState[0];
			var setLoading = loadingState[1];
			var errState = React.useState("");
			var err = errState[0];
			var setErr = errState[1];
			var editState = React.useState(null);
			var editingId = editState[0];
			var setEditingId = editState[1];
			var draftState = React.useState("");
			var draftText = draftState[0];
			var setDraft = draftState[1];
			var busyState = React.useState(null);
			var busyOp = busyState[0];
			var setBusy = busyState[1];
			var msgState = React.useState("");
			var actionMsg = msgState[0];
			var setMsg = msgState[1];
			var openState = React.useState(null);
			var expandedId = openState[0];
			var setExpandedId = openState[1];
			var tallState = React.useState(false);
			var listTall = tallState[0];
			var setListTall = tallState[1];

			function load() {
				setLoading(true);
				setErr("");
				queueRpc("list", {}).then(function (result) {
					setLoading(false);
					if (result.ok) setData(result.value);
					else setErr((result.error && result.error.message) || "加载失败");
				});
			}

			React.useEffect(function () {
				load();
				// v0.5.2: 组件卸载时释放编辑锁 (防关页面/刷新导致永久锁; 服务端还有 TTL 兜底)
				return function () {
					if (editingRef.current !== null) queueRpc("editend", { id: editingRef.current });
				};
			}, []);

			var editingRef = React.useRef(null);

			/** 执行一个变更操作 (edit/cancel/runnow), 成功后刷新列表 */
			function act(op, payload, successText) {
				if (busyOp) return;
				setBusy(op);
				setErr("");
				setMsg("");
				queueRpc(op, payload).then(function (result) {
					setBusy(null);
					if (result.ok) {
						setMsg(successText);
						load();
					} else {
						setErr((result.error && result.error.message) || "操作失败");
					}
				});
			}

			/** 开始编辑: 锁定任务 (防 tick 自动派发把编辑中的任务发出去) */
			function startEdit(task) {
				if (editingRef.current !== null && editingRef.current !== task.id) {
					queueRpc("editend", { id: editingRef.current }); // 切换编辑目标, 先释放旧锁
				}
				editingRef.current = task.id;
				setEditingId(task.id);
				setDraft(task.content);
				queueRpc("editstart", { id: task.id });
			}

			/** 取消编辑: 释放编辑锁 */
			function cancelEdit() {
				if (editingRef.current !== null) queueRpc("editend", { id: editingRef.current });
				editingRef.current = null;
				setEditingId(null);
				setErr("");
			}

			function saveEdit() {
				var text = draftText.trim();
				if (!text) {
					setErr("内容不能为空");
					return;
				}
				// 保存成功后服务端 edit 端点已释放锁; 本地清引用 (卸载不再补发 editend)
				act("edit", { id: editingId, content: text }, "任务 #" + editingId + " 已保存");
				editingRef.current = null;
				setEditingId(null);
			}

			/** 手风琴: 点行展开该任务 (面板自动增高可滚动); 再点收起卡片 */
			function toggleTask(id) {
				if (expandedId === id) setExpandedId(null);
				else {
					setExpandedId(id);
					setListTall(true);
				}
			}

			/** 面板整体 展开/收起 (3 行 ↔ 380px 可滚动) */
			function toggleTall() {
				var next = !listTall;
				setListTall(next);
				if (!next) setExpandedId(null);
			}

			var tasks = (data && data.tasks) || [];
			// v0.8.3/v0.11.5: 排队族 (pending / 已派发未执行) 计入"排队中"; 终态归历史 (带分隔线)
			function qsOf(t) { return t.status === "dispatched" && t.queuedSending; }
			// v0.11.5: 排序/可操作性判据统一走 statusKind —— 只有排队族可展开操作 (终态/未适配只读)
			// v0.11.6: cancelled+dropCause=restart 属 terminal ⇒ 只读, 标签显示「已取消 · 重启丢弃」
			function isActive(t) { return statusKind(t) === "active"; }
			var pendingCount = 0;
			var unknownCount = 0;
			var historyCount = 0; // v0.11.5: 历史条数 (终态 + 未适配) —— 分隔线文案用
			var historyHeaderDrawn = false; // v0.11.5: 分隔线只插一次
			var ordered = tasks.slice().sort(function (a, b) {
				var pa = a.status === "pending" ? 0 : qsOf(a) ? 1 : 2;
				var pb = b.status === "pending" ? 0 : qsOf(b) ? 1 : 2;
				return pa - pb || a.id - b.id;
			});
			for (var i = 0; i < ordered.length; i++) {
				if (ordered[i].status === "pending" || qsOf(ordered[i])) pendingCount++;
				else historyCount++;
				if (statusKind(ordered[i]) === "unknown") unknownCount++; // v0.11.5: 版本不匹配可见化
			}

			return React.createElement(
				"div",
				{ style: { marginTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: "var(--dsw-alias-label-primary, #eceff4)", marginBottom: 6, flexWrap: "wrap" } },
					React.createElement("span", null, "📋 任务队列"),
					React.createElement(
						"span",
						{ style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontWeight: 500, fontSize: 11.5 } },
						"排队中 (" + (data ? pendingCount : "…") + ")" + (data ? " · " + (data.peak ? "高峰·等低谷" : "低谷中") + " · " + data.windowSource : "")
					),
					React.createElement(
						"span",
						{ style: { marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
						btn(listTall ? "收起" : "展开", toggleTall, false),
						btn(isLoading ? "…" : "刷新", load, isLoading),
						actionMsg
							? React.createElement(
									"span",
									{ style: { color: "#4ed17e", fontSize: 11.5 } },
									actionMsg
								)
							: null
					)
				),
				React.createElement(
					"div",
					{
						style: {
							maxHeight: listTall ? 380 : 92,
							overflowY: "auto",
							transition: "max-height .25s ease",
							scrollbarWidth: "thin"
						}
					},
					// v0.11.5 fail-loud: 出现未声明状态 (服务端版本高于本面板) ⇒ 顶部黄字告警,
					//   绝不静默把未知状态当"排队中"展示; 告警行不计入任何计数。
					unknownCount > 0
						? React.createElement(
								"div",
								{ style: { display: "flex", gap: 6, alignItems: "flex-start", margin: "4px 6px 6px", padding: "5px 8px", borderRadius: 8, fontSize: 11.5, lineHeight: 1.55, color: "var(--dsh-st-warn-tx, #fbbf24)", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)" } },
								"⚠",
								React.createElement("span", null, "有 " + unknownCount + " 个任务的状态本面板未适配（可能是服务端/面板版本不匹配）—— 它们不会被误派发，请核对版本后再操作。")
							)
						: null,
					isLoading && !data
						? React.createElement("div", { style: { color: p.meta, fontSize: 12, margin: "4px 6px" } }, "加载中…")
						: err
							? React.createElement("div", { style: { color: "#f87171", fontSize: 12, margin: "4px 6px" } }, "⚠ " + err)
							: ordered.length === 0
								? React.createElement("div", { style: { color: p.meta, fontSize: 12, margin: "4px 6px" } }, "(队列为空)")
								: ordered.map(function (t) {
									var isPending = t.status === "pending";
									var isQSend = qsOf(t); // v0.8.3: 已派发未执行, 可撤回取消
									var kind = statusKind(t); // v0.11.5: 族判定 (active=可操作, 其余只读)
									var operable = isActive(t) || kind === "dispatched";
									var isOpen = expandedId === t.id && operable;									// v0.11.5: 历史区首行前插分隔线 (只插一次, 用闭包 flag 保证)
									var divider = (!operable && !historyHeaderDrawn)
										? (historyHeaderDrawn = true, React.createElement(
												"div",
												{ key: "g" + t.id, style: { display: "flex", alignItems: "center", gap: 8, margin: "8px 6px 4px", color: p.meta, fontSize: 11, fontWeight: 600, letterSpacing: 0.4 } },
												React.createElement("span", { style: { flex: "1 1 auto", height: 1, background: "rgba(255,255,255,0.10)" } }),
												React.createElement("span", null, "历史 · 已结束 (" + historyCount + ")"),
												React.createElement("span", { style: { flex: "1 1 auto", height: 1, background: "rgba(255,255,255,0.10)" } })
											))
										: null;
									var row = React.createElement(
										"div",
										{
											key: "r" + t.id,
											className: "dsh-qrow",
											onClick: operable ? function () { toggleTask(t.id); } : undefined,
											style: {
												display: "flex", alignItems: "center", gap: 8,
												padding: "5px 8px", borderRadius: 8, cursor: operable ? "pointer" : "default",
												userSelect: "none", fontSize: 12.5, whiteSpace: "nowrap",
												overflow: "hidden",
												background: isOpen ? "rgba(255,255,255,0.06)" : undefined,
												transition: "background .2s ease"
											}
										},
										statusTag(t),
										t.locked && isPending
											? React.createElement(
													"span",
													{ style: { flex: "none", fontSize: 10, fontWeight: 600, color: "var(--dsh-st-edit-tx)", background: "rgba(245,158,11,0.10)", border: "1px solid var(--dsh-st-edit-bd)", padding: "0 6px", lineHeight: "16px", borderRadius: 6, letterSpacing: 0.3 } },
													"✎ 编辑中"
												)
											: null,
										React.createElement(
											"span",
											{ style: { flex: "none", fontWeight: 700, color: isPending || isQSend ? p.accent : "var(--dsw-alias-label-secondary, #9aa3b2)", fontVariantNumeric: "tabular-nums" } },
											"#" + t.id
										),
										React.createElement(
											"span",
											{ style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", color: isPending || isQSend ? p.body : p.meta, textDecoration: isPending || isQSend ? "none" : "line-through", opacity: isPending || isQSend ? 1 : (kind === "error" ? 0.85 : 0.6) } },
											oneLine(t.content)
										),
										React.createElement(
											"span",
											{ style: { flex: "none", color: p.meta, fontSize: 11 } },
											t.whenText
										),
										React.createElement(
											"span",
											{ style: { flex: "none", width: 18, height: 18, borderRadius: 9, textAlign: "center", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #9aa3b2)", background: "var(--dsh-btn-bg)", border: "1px solid var(--dsh-glass-bd)" } },
											isOpen ? "▴" : "▾"
										)
									);
									if (!isOpen) return divider ? [divider, row] : row;
									return [
										divider,
										row,
										React.createElement(
											"div",
											{
												key: "c" + t.id,
												className: "dsh-qcard",
												style: { border: "1px solid " + p.border, borderRadius: 8, background: "var(--dsh-qcard-bg)", padding: "8px 10px", margin: "4px 0 6px" }
											},
											editingId === t.id
												? [
													React.createElement("textarea", {
														key: "ta",
														value: draftText,
														onChange: function (e) { setDraft(e.target.value); },
														rows: 3,
														style: {
															width: "100%", minHeight: 60, fontSize: 12.5, fontFamily: "inherit", lineHeight: 1.5,
															color: "var(--dsw-alias-label-primary, #eceff4)", background: "var(--dsh-code-bg)",
															border: "1px solid " + p.border, borderRadius: 6, padding: "6px 8px", resize: "vertical"
														}
													}),
													React.createElement(
														"div",
														{ key: "ef", style: { display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" } },
														btn("保存", saveEdit, busyOp === "edit", "success"),
														btn("取消", cancelEdit, false)
													)
												]
												: React.createElement(
														"div",
														{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.65, fontSize: 13, color: isPending || isQSend ? p.body : p.meta } },
														t.content
													),
											React.createElement(
												"div",
												{ style: { color: p.meta, fontSize: 11.5, marginTop: 4 } },
												"入队 " + beijingTime(t.createdAt) + (t.scheduledAt ? " · " + t.whenText : "") + (t.sessionShort && t.sessionShort !== "未绑定" ? " · " + t.sessionShort : "") + (t.locked ? " · ✎ 编辑中 (保存/取消后释放, 期间不可派发)" : "") + (isQSend ? " · 排队发送中 (已派发, 等待会话空闲执行)" : "")
											),
											isPending || isQSend
												? React.createElement(
														"div",
														{ style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)" } },
														editingId === t.id
															? [
																btn("保存", saveEdit, busyOp === "edit", "success"),
																btn("取消编辑", cancelEdit, false)
															]
															: isPending
																? [
																	btn("编辑", function () { startEdit(t); }, busyOp !== null),
																	btn("取消", function () { act("cancel", { id: t.id }, "任务 #" + t.id + " 已取消"); }, busyOp !== null, "danger"),
																	btn("立即派发", function () { act("runnow", { id: t.id }, "任务 #" + t.id + " 已派发"); }, busyOp !== null, "primary")
																]
																: [
																	React.createElement(
																		"span",
																		{ key: "qsn", style: { color: p.meta, fontSize: 11.5, marginRight: "auto", alignSelf: "center" } },
																		"已派发, 排队等待会话空闲执行 — 可撤回取消"
																	),
																	btn("取消", function () { act("cancel", { id: t.id }, "任务 #" + t.id + " 已取消 (已撤回排队消息)"); }, busyOp !== null, "danger")
																]
													)
												: null
										)
									];
								})
				),
				React.createElement(
					"div",
					{ style: { marginTop: 6, color: p.meta, fontSize: 11.5 } },
					"兜底目标: " + (data && data.targetSessionShort && data.targetSessionShort !== "未绑定" ? data.targetSessionShort : "未设置")
				)
			);
		});

		/** 会话账本历史区默认显示条数 (超出折叠, 点「展开全部」显示全部) */
		var LEDGER_HISTORY_DEFAULT_SHOW = 3;

		/**
		 * 会话账本历史 (v0.6.0, kind=ledger 展开态渲染): 展开卡片时经 /cost-ledger RPC
		 * (dsh-cost-ledger, 零 token) 实时拉取共享账本 —— 任何一张旧卡片点开都与最新卡片
		 * 一致; RPC 不可用时回退横幅内嵌的静态快照 (标记"快照")。
		 * 每行: 回合 #t · MM-DD HH:mm · ¥合计 · +差值; 默认 3 条 + 展开全部 (超高滚动)。
		 */
		var LedgerHistory = React.memo(function LedgerHistory(props) {
			var p = props.p;
			var sessionId = props.sessionId;
			var initial = Array.isArray(props.history) ? props.history : [];
			var expandedState = React.useState(false);
			var expanded = expandedState[0];
			var setExpanded = expandedState[1];
			var dataState = React.useState(null);
			var liveData = dataState[0];
			var setLiveData = dataState[1];
			var liveState = React.useState(false);
			var isLive = liveState[0];
			var setLive = liveState[1];

			function load() {
				var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
				var rpc = conn && conn.rpc;
				if (!rpc || typeof rpc.call !== "function" || !sessionId) return;
				ledgerRpc(rpc, { sessionId: sessionId }).then(function (result) {
					if (result && result.ok && result.value && Array.isArray(result.value.entries)) {
						setLiveData(result.value.entries);
						setLive(true);
					}
				}).catch(function () { /* 保留快照 */ });
			}

			React.useEffect(function () { load(); }, [sessionId]);

			var entries = liveData || initial;
			var count = liveData && liveData.count != null ? liveData.count : initial.length;
			var shown = expanded ? entries : entries.slice(0, LEDGER_HISTORY_DEFAULT_SHOW);
			var rows = shown.map(function (e, i) {
				return React.createElement(
					"div",
					{ key: i, style: { display: "flex", gap: 8, fontSize: 12, lineHeight: 1.75, fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary, #eceff4)" } },
					React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontWeight: 600, width: 52 } }, "回合 #" + e.t),
					React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", width: 76 } }, (e.clock || e.at)),
					React.createElement("span", { style: { flex: 1, textAlign: "right", fontWeight: 600 } }, e.total),
					React.createElement("span", { style: { flex: "none", width: 64, textAlign: "right", color: "var(--dsw-alias-label-secondary, #9aa3b2)" } }, e.delta || "")
				);
			});
			return React.createElement(
				"div",
				{ style: { marginTop: 8, borderTop: "1px dashed rgba(20,184,166,0.25)", paddingTop: 6 } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, marginBottom: 3 } },
					React.createElement("span", null, "📒 历史纪录" + (isLive ? " · 实时" : "") + " · 共 " + count + " 次"),
					React.createElement(
						"button",
						{
							className: "dsh-lbtn",
							onClick: function (e) { e.stopPropagation(); setExpanded(!expanded); },
							style: {
								marginLeft: "auto", fontSize: 11, padding: "0 8px", lineHeight: "20px", borderRadius: 7,
								background: "var(--dsh-btn-bg)", border: "1px solid var(--dsh-glass-bd)",
								color: "var(--dsw-alias-label-primary, #eceff4)", cursor: "pointer", fontWeight: 600,
								fontFamily: "inherit", flex: "none", transition: "all .2s ease"
							}
						},
						expanded ? "收起" : "展开全部"
					)
				),
				React.createElement(
					"div",
					{ style: expanded && entries.length > 12 ? { maxHeight: 260, overflowY: "auto", scrollbarWidth: "thin" } : undefined },
					rows
				)
			);
		});

/** 主题色 (DeepSeek 蓝, 明/暗主题自适应) — 用于标识费用等关键数字 */
		var THEME_ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";

		// =====================================================================
		// v0.11.0 (期乙, 2026-09-06): 多 agent 树聚合 GUI — ledger「委托树」区 + costs 树形分组
		// 数据/口径: 设计 docs/任务记录/2026-09-05-cost多agent费用聚合-设计方案.md §3.3/§3.4/§4.1/§4.2
		//   - ledger 委托树: /cost-ledger RPC history { sessionId, includeDescendants:true } →
		//     subtree { count, ids, total, at, rows:[{sid,parentSid,depth,label,total}] } —
		//     **行级明细由服务端算好, 客户端零计算** (row.total=子桶最新 entry.total 账本口径);
		//     RPC 失败/无 subtree (旧服务端忽略 includeDescendants) → 区块不渲染 (优雅降级)。
		//   - costs 树分组: /sessions-cost 命令 payload sessions[] 每行附 treeGroup
		//     { parentSid?, childCount } + fullSid + windowTreeTotal (窗口内树合计, 服务端算);
		//     无 treeGroup → 平铺 (兼容旧服务端)。
		// 样式: 家族变量体系 (ledger 青绿 / costs 天蓝 / meta 附注), 「子 agent」徽标青绿深浅两态
		// (CSS 变量 --dsh-ct-*), 观感同 public/banner-styles.html 区块 6 A2 / 7 costsTree (已确认预览)。
		var ctMoney = function (n) {
			if (typeof n !== "number" || !isFinite(n)) n = 0;
			return "¥" + (Math.round(n * 100) / 100).toLocaleString("zh-CN");
		};
		/** 短 sid (与服务端同: session- 前缀取 [8,16), 否则取前 8 字符) */
		var ctShortSid = function (sid) {
			var s = String(sid || "");
			return s.indexOf("session-") === 0 ? s.slice(8, 16) : s.slice(0, 8);
		};
		/** 金额 × → 占整树百分比文本 (whole≤0 → "") */
		var ctPctText = function (part, whole) {
			if (!(whole > 0) || !(part > 0)) return "";
			return "占 " + Math.round((part / whole) * 100) + "%";
		};
		/** 树形行小按钮 (委托树/子树折叠标题右侧, 复用 .dsh-ct-toggle hover) */
		function ctPill(label, onClick) {
			return React.createElement(
				"span",
				{
					role: "button",
					title: label,
					onClick: onClick,
					className: "dsh-ct-toggle dsh-lbtn",
					style: {
						marginLeft: "auto", fontSize: 11, padding: "0 8px", lineHeight: "20px", borderRadius: 7, flex: "none",
						background: "var(--dsh-btn-bg)", border: "1px solid var(--dsh-glass-bd)",
						color: "var(--dsw-alias-label-primary, #eceff4)", cursor: "pointer", fontWeight: 600,
						fontFamily: "inherit", transition: "all .2s ease"
					}
				},
				label
			);
		}

		/**
		 * ledger 卡「委托树」区 (期乙 §4.1 + 预览 A2): 展开态内的可折叠委托树区 —
		 * 挂在历史区上方; 挂载即经 /cost-ledger RPC history { sessionId, includeDescendants:true }
		 * 实时拉取 (零 token), **有后代才渲染区块标题**, 点标题展开/收起; 行级明细 = 服务端
		 * subtree.rows (label/短sid/¥/占子树%/分支合计/孙行二级 dim「计入父行」), 客户端零计算。
		 * 降级: RPC 失败 / 无 subtree / rows 空 (旧服务端不识别 includeDescendants) → 返回 null 不渲染。
		 */
		/* ★`#A58`：对话内「降级」卡片 —— 结构化逐项（`#A58` 用户口径：堆在一起读不下去）
		   · 一行摘要：N 项降级 + 最高级别色（`data-compat-count`）
		   · 逐项一行：插件名 · 缺什么 · 一句话怎么办（等宽对齐，`data-compat-item="<id>"`）
		   · 超过 3 项默认折叠（首 3 项 + 「展开全部」）
		   判据（机械可读）：折叠态卡片高度 = 摘要 + 3 行；展开后每项独立一行；`data-compat-item` 计数 == 降级项数。 */
		var CompatItems = React.memo(function CompatItems(props) {
			var items = Array.isArray(props.items) ? props.items : [];
			var p = props.p || {};
			var openState = React.useState(false);
			var open = openState[0], setOpen = openState[1];
			if (items.length === 0) return null;
			var LIMIT = 3;
			var shown = open ? items : items.slice(0, LIMIT);
			var sevColor = items.some(function (i) { return (i.capState || i.state) === "BLOCKED"; }) ? "#f87171" : "#fbbf24";
			var mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
			var rowStyle = { display: "grid", gridTemplateColumns: "minmax(150px, 210px) 1fr auto", columnGap: 8, alignItems: "baseline", padding: "2px 0", fontFamily: mono, fontSize: 11.5, lineHeight: "17px" };
			return React.createElement(
				"div",
				{ "data-compat-items": String(items.length), style: { marginTop: 6 } },
				React.createElement(
					"div",
					{ "data-compat-count": String(items.length), style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 4 } },
					React.createElement("span", { style: { width: 6, height: 6, borderRadius: 3, background: sevColor, flex: "none" } }),
					React.createElement("span", { style: { color: p.body || "#9aa3b2" } }, items.length + " 项降级"),
					React.createElement("span", { style: { color: "#6b7280", fontSize: 11 } }, "（逐项见下 · 详情 设置 → 本地插件 → 适配状态）")
				),
				shown.map(function (it, i) {
					return React.createElement(
						"div",
						{ key: it.id || i, "data-compat-item": it.id || ("item-" + i), style: rowStyle },
						React.createElement("span", { style: { color: p.title || "#e5e7eb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: it.id }, it.id),
						React.createElement("span", { style: { color: p.body || "#9aa3b2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: it.why }, "缺：" + ((it.missing || []).length ? (it.missing || []).join("、") : (it.why || "—"))),
						React.createElement("span", { style: { color: "#6b7280", whiteSpace: "nowrap" }, title: it.advice || "" }, "→ " + (it.advice || "见设置"))
					);
				}),
				items.length > LIMIT
					? React.createElement(
							"span",
							{
								role: "button",
								"data-compat-toggle": open ? "collapse" : "expand",
								onClick: function (e) { e.stopPropagation(); setOpen(!open); },
								style: { display: "inline-block", marginTop: 4, fontSize: 11.5, color: "#93c5fd", cursor: "pointer" }
							},
							open ? "收起" : "展开全部 " + items.length + " 项"
						)
					: null
			);
		});

		var LedgerTree = React.memo(function LedgerTree(props) {
			var p = props.p;
			var sessionId = props.sessionId;
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var dataState = React.useState(null); // null=加载中; { empty:true }=无子树/失败; { subtree, ownTotal }
			var data = dataState[0];
			var setData = dataState[1];

			function load() {
				var conn = pluginCtx && pluginCtx.get ? pluginCtx.get("connection") : null;
				var rpc = conn && conn.rpc;
				if (!rpc || typeof rpc.call !== "function" || !sessionId) return;
				ledgerRpc(rpc, { sessionId: sessionId, includeDescendants: true }).then(function (result) {
					if (!result || !result.ok || !result.value) { setData({ empty: true }); return; }
					var subtree = result.value.subtree;
					if (!subtree || !Array.isArray(subtree.rows) || subtree.rows.length === 0) { setData({ empty: true }); return; }
					var ownTotal = 0;
					var entries = Array.isArray(result.value.entries) ? result.value.entries : [];
					if (entries.length > 0) {
						var n = parseFloat(String(entries[0].total || "").replace(/[^0-9.]/g, ""));
						if (isFinite(n)) ownTotal = n;
					}
					setData({ subtree: subtree, ownTotal: ownTotal });
				}).catch(function () { setData({ empty: true }); });
			}
			React.useEffect(function () { load(); }, [sessionId]);

			if (!data || data.empty) return null; // 失败/无子树 → 区块不显示 (旧服务端兼容)
			var rows = data.subtree.rows;
			var byId = new Map();
			for (var i = 0; i < rows.length; i++) byId.set(rows[i].sid, rows[i]);
			var kidsOf = new Map();
			var roots = [];
			for (var j = 0; j < rows.length; j++) {
				var rj = rows[j];
				var par = rj.parentSid && byId.has(rj.parentSid) ? rj.parentSid : null;
				if (par) {
					var arr = kidsOf.get(par) || [];
					arr.push(rj);
					kidsOf.set(par, arr);
				} else roots.push(rj);
			}
			/** 分支合计 = 自身子桶 + 全部后代子桶 (账本口径, 每桶只计一次) */
			function branchTotal(node) {
				var s = typeof node.total === "number" ? node.total : 0;
				var kids = kidsOf.get(node.sid);
				if (kids) for (var k = 0; k < kids.length; k++) s += branchTotal(kids[k]);
				return s;
			}
			/** 展平树 (携带祖先 last 标记) → 树形线前缀 */
			function ctFlatten(nodes, pre, out) {
				nodes.forEach(function (n, idx) {
					var last = idx === nodes.length - 1;
					out.push({ n: n, last: last, pre: pre || [] });
					var kids = kidsOf.get(n.sid);
					if (kids && kids.length) ctFlatten(kids, (pre || []).concat([last]), out);
				});
				return out;
			}
			function ctGlyph(f) {
				var s = "";
				f.pre.forEach(function (l) { s += l ? "   " : "│  "; });
				s += f.last ? "└ " : "├ ";
				return s;
			}
			// 服务端 subtree.total (账本口径汇总, 摘要行 ¥b 用); 「占子树 %」分母 = **客户端 rows 合计** (Σ row.total, 需求③)
			var treeTotal = data.subtree.total;
			var rowsSum = 0;
			for (var si2 = 0; si2 < rows.length; si2++) rowsSum += typeof rows[si2].total === "number" ? rows[si2].total : 0;
			var flat = ctFlatten(roots, null, []);
			var sumAmt = data.ownTotal + (typeof treeTotal === "number" ? treeTotal : 0);
			var rowEls = flat.map(function (f, idx) {
				var n = f.n;
				var own = typeof n.total === "number" ? n.total : 0;
				var branch = branchTotal(n);
				var nested = !!n.parentSid && byId.has(n.parentSid); // 挂在其他行下 (孙级 dim)
				var kids = kidsOf.get(n.sid);
				var hasKids = !!kids && kids.length > 0;
				var short = ctShortSid(n.sid);
				var label = typeof n.label === "string" && n.label && n.label !== short ? n.label : null;
				var kids2 = [
					React.createElement("span", { key: "g", className: "dsh-ct-g" }, ctGlyph(f)),
					React.createElement("span", { key: "ag", className: "dsh-ct-ag" }, "子 agent")
				];
				if (label) kids2.push(React.createElement("span", { key: "lb", className: "dsh-ct-lb" }, label));
				else kids2.push(React.createElement("span", { key: "lb", className: "dsh-ct-lb" }, ""));
				kids2.push(React.createElement("span", { key: "sid", className: "dsh-ct-sid" }, short));
				var tag = null;
				if (hasKids) tag = "分支合计";
				else if (nested) tag = "孙 agent · 计入父行";
				if (tag) kids2.push(React.createElement("span", { key: "tag", className: "dsh-ct-tag" }, tag));
				kids2.push(React.createElement(
					"span",
					{ key: "amt", className: "dsh-ct-amt", style: nested ? { flex: "none", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #9aa3b2)", opacity: 0.85 } : { flex: "none", fontWeight: 700, color: "var(--dsw-alias-label-primary, #eceff4)" } },
					nested ? ctMoney(own) : ctMoney(branch)
				));
				if (!nested) {
					var pct = ctPctText(branch, rowsSum); // 需求③: 分母 = 客户端 rows 合计 (服务端不算百分比)
					if (pct) kids2.push(React.createElement("span", { key: "pct", className: "dsh-ct-tag" }, "(" + pct + ")"));
				}
				return React.createElement("div", { key: idx, className: "dsh-ct-row" }, kids2);
			});
			var sumLine = React.createElement(
				"div",
				{ style: { fontSize: 12, lineHeight: 1.8, color: "var(--dsw-alias-label-primary, #eceff4)", fontVariantNumeric: "tabular-nums", marginBottom: 2 } },
				"本次委托树合计 ",
				React.createElement("span", { style: { color: p.accent, fontWeight: 700 } }, ctMoney(sumAmt)),
				"（自身 ",
				React.createElement("b", { style: { fontWeight: 600 } }, ctMoney(data.ownTotal)),
				" + " + roots.length + " 个子 agent ",
				React.createElement("b", { style: { fontWeight: 600 } }, ctMoney(treeTotal)),
				"）· 账本口径"
			);
			return React.createElement(
				"div",
				{ style: { marginTop: 8, borderTop: "1px dashed rgba(20,184,166,0.28)", paddingTop: 6 } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", cursor: "pointer", userSelect: "none", marginBottom: 4 }, onClick: function () { setOpen(!open); } },
					React.createElement("span", null, "🌳"),
					React.createElement("span", { style: { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, color: "var(--dsw-alias-label-primary, #eceff4)" } }, "委托树"),
					React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontWeight: 500 } }, "含 " + roots.length + " 个子 agent · 读时聚合（/cost-ledger history includeDescendants）"),
					ctPill(open ? "收起" : "展开", function (e) { if (e && e.stopPropagation) e.stopPropagation(); setOpen(!open); })
				),
				open ? React.createElement("div", null, sumLine, rowEls) : null
			);
		});

		/**
		 * costs 树形分组手风琴 (期乙 §4.2 + 预览 costsTree, v0.11.0): 数据 = 服务端 sessions[] 附
		 * treeGroup { parentSid?, childCount } + fullSid + windowTreeTotal (窗口内树合计, 服务端算,
		 * 每行只算自己不双计)。顶层行 = 窗口内无祖先的行; 行展开 = 自身高峰/低谷明细 + 自身合计 +
		 * 「子树」折叠块 (缩进子会话行: 子 agent 徽标 + 标题 + 短 sid + 金额, 子行可再展开自身明细,
		 * 递归支持孙行); 整卡手风琴语义保持 (同时只展开一条 openPath, 祖先行随子行保持展开)。
		 * 无窗口内嵌套的行集不会进入本组件 (SessionCostList 判定, 平铺兼容旧服务端)。
		 */
		var SessionTreeList = React.memo(function SessionTreeList(props) {
			var p = props.p;
			var sessions = Array.isArray(props.sessions) ? props.sessions : [];
			var openPathState = React.useState(null);
			var openPath = openPathState[0];
			var setOpenPath = openPathState[1];
			var subClosedState = React.useState(null);
			var subClosed = subClosedState[0];
			var setSubClosed = subClosedState[1];

			var byFull = new Map();
			for (var bi = 0; bi < sessions.length; bi++) if (sessions[bi].fullSid) byFull.set(sessions[bi].fullSid, bi);
			var kidsOf = new Map();
			var roots = [];
			for (var ci = 0; ci < sessions.length; ci++) {
				var sc = sessions[ci];
				var par = sc.treeGroup && sc.treeGroup.parentSid && byFull.has(sc.treeGroup.parentSid) ? sc.treeGroup.parentSid : null;
				if (par) {
					var arr = kidsOf.get(par) || [];
					arr.push(ci);
					kidsOf.set(par, arr);
				} else roots.push(ci);
			}
			var nodeTotal = function (c) { return typeof c.windowTreeTotal === "number" ? c.windowTreeTotal : NaN; };
			var tierBlock = function (t, keyPrefix) {
				if (!t || (!Array.isArray(t.rows) && !Array.isArray(t.lines))) return null;
				var _rows = t.rows || t.lines;
				if (_rows.length === 0) return null;
				return React.createElement(
					"div",
					{ key: keyPrefix + "tier", style: { marginTop: 4 } },
					React.createElement(
						"div",
						{ style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, marginBottom: 1 } },
						t.label + (t.costText ? " · " + t.costText : "")
					),
					_rows.map(function (ln, j) {
						return React.createElement(
							"div",
							{ key: j, style: { display: "flex", gap: 8, fontSize: 12, lineHeight: 1.7 } },
							React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", flex: "none", minWidth: 76 } }, ln.k),
							React.createElement("span", { style: { flex: 1, fontVariantNumeric: "tabular-nums" } }, ln.v)
						);
					})
				);
			};
			/** 递归渲染一行 (顶层/子会话行通用): isChild=挂父下行 (带 子 agent 徽标) */
			function renderNode(idx, path, isChild) {
				var c = sessions[idx];
				var kids = kidsOf.get(c.fullSid) || [];
				var ownOpen = openPath === path;
				var onChain = ownOpen || (openPath && openPath.indexOf(path + ":") === 0);
				var hdr = [];
				if (isChild) hdr.push(React.createElement("span", { key: "ag", className: "dsh-ct-ag" }, "子 agent"));
				else if (kids.length > 0) hdr.push(React.createElement("span", { key: "ag", className: "dsh-ct-ag" }, "含 " + kids.length + " 个子 agent"));
				hdr.push(React.createElement(
					"span",
					{ key: "tt", style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					c.title
				));
				if (typeof c.sid === "string" && c.sid) hdr.push(React.createElement("span", { key: "sid", style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 11.5 } }, "会话 " + c.sid));
				var amtNum = nodeTotal(c);
				var amtText = isFinite(amtNum) ? ctMoney(amtNum) : (c.costText || "¥—");
				hdr.push(React.createElement("span", { key: "amt", style: { flex: "none", color: p.accent, fontWeight: 700, fontVariantNumeric: "tabular-nums" } }, amtText));
				hdr.push(React.createElement("span", { key: "chev", style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 12 } }, onChain ? "▾" : "▸"));

				var bodyKids = [];
				if (onChain) {
					bodyKids.push(tierBlock(c.peak, path + ":p"));
					bodyKids.push(tierBlock(c.off, path + ":o"));
					bodyKids.push(React.createElement(
						"div",
						{ key: "own", style: { marginTop: 5, fontSize: 12, fontWeight: 700, color: p.accent, fontVariantNumeric: "tabular-nums" } },
						"本会话合计 " + (c.costText || "¥—")
					));
					if (kids.length > 0) {
						var childSum = 0;
						for (var kc = 0; kc < kids.length; kc++) {
							var kn = nodeTotal(sessions[kids[kc]]);
							if (isFinite(kn)) childSum += kn;
						}
						var subOpen = subClosed !== path;
						bodyKids.push(React.createElement(
							"div",
							{ key: "subtree", style: { marginTop: 5, paddingLeft: 10, borderLeft: "2px solid rgba(14,165,233,0.28)" } },
							React.createElement(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: "var(--dsw-alias-label-secondary, #9aa3b2)", cursor: "pointer", userSelect: "none", margin: "5px 0 2px" }, onClick: function () { setSubClosed(subOpen ? path : null); } },
								React.createElement("span", null, "🌱"),
								React.createElement("span", { style: { color: "var(--dsw-alias-label-primary, #eceff4)" } }, "子树 · 子会话（窗口内 " + kids.length + " 个 · 树合计 +" + ctMoney(childSum) + "）"),
								ctPill(subOpen ? "收起" : "展开", function (e) { if (e && e.stopPropagation) e.stopPropagation(); setSubClosed(subOpen ? path : null); })
							),
							subOpen
								? React.createElement(
										"div",
										{ style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 } },
										kids.map(function (kidx, k) { return renderNode(kidx, path + ":" + kidx, true); })
									)
								: null
						));
					}
				}
				return React.createElement(
					"div",
					{ key: path, className: "dsh-sc", style: { border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, background: "var(--dsh-sc-bg)", overflow: "hidden", flex: "none" } },
					React.createElement(
						"div",
						{
							className: "dsh-sch",
							role: "button",
							title: ownOpen ? "收起" : "展开",
							onClick: function () { setOpenPath(ownOpen ? null : path); },
							style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", userSelect: "none", fontSize: 12.5, fontWeight: 600, color: "var(--dsw-alias-label-primary, #eceff4)", transition: "background .2s ease" }
						},
						hdr
					),
					onChain
						? React.createElement(
								"div",
								{ style: { padding: "0 9px 7px", color: p.body, borderTop: "1px dashed rgba(255,255,255,0.1)" } },
								bodyKids
							)
						: null
				);
			}

			var rootEls = roots.map(function (idx) { return renderNode(idx, String(idx), false); });
			return React.createElement(
				"div",
				{ style: { marginTop: 6, maxHeight: 360, overflowY: "auto", scrollbarWidth: "thin", display: "flex", flexDirection: "column", gap: 4 } },
				rootEls
			);
		});

		/** 多会话费用明细 (kind=costs 展开态, v0.6.3): 手风琴卡片式 (状态机复用 QueuePanel
		 *  expandedId 模式: 同时只展开一个会话, 再点收起); 每会话展开显示高峰/低谷分组 +
		 *  每种类型一行 (输入/缓存命中/输出+推理, `token × 单价 = 金额`);
		 *  **不省略任何会话** (全量渲染), 列表超高时 maxHeight + overflowY auto 滚动
		 *  (同 LedgerHistory 滚动细节); 行标题 ellipsis 截断, 金额主题色。 */
		var SessionCostList = React.memo(function SessionCostList(props) {
			var p = props.p;
			var sessions = Array.isArray(props.sessions) ? props.sessions : [];
			var openState = React.useState(null);
			var expandedId = openState[0];
			var setExpandedId = openState[1];

			// v0.11.0 (期乙): 树形分组判定 — 存在 fullSid 且其 treeGroup.parentSid 指向窗口内另一行
			// → 走 SessionTreeList 树渲染; 否则平铺 (无分组字段/旧服务端 → 现行为不变)
			var treeMode = false;
			if (sessions.length > 0) {
				var fullMap = new Map();
				for (var fi = 0; fi < sessions.length; fi++) if (sessions[fi].fullSid) fullMap.set(sessions[fi].fullSid, true);
				for (var gj = 0; gj < sessions.length && !treeMode; gj++) {
					var gs = sessions[gj];
					if (gs.treeGroup && gs.treeGroup.parentSid && fullMap.has(gs.treeGroup.parentSid)) treeMode = true;
				}
			}
			if (treeMode) return React.createElement(SessionTreeList, { p: p, sessions: sessions });

			/** 手风琴: 点会话行展开该会话 (同时只展开一个); 再点收起 */
			function toggle(i) {
				setExpandedId(expandedId === i ? null : i);
			}

			var rows = sessions.map(function (s, i) {
				var open = expandedId === i;
				var tierBlock = function (t) {
					if (!t || (!Array.isArray(t.rows) && !Array.isArray(t.lines))) return null;
				var _rows = t.rows || t.lines;
				if (_rows.length === 0) return null;
					return React.createElement(
						"div",
						{ key: t.label, style: { marginTop: 4 } },
						React.createElement(
							"div",
							{ style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, marginBottom: 1 } },
							t.label + (t.costText ? " · " + t.costText : "")
						),
						_rows.map(function (ln, j) {
							return React.createElement(
								"div",
								{ key: j, style: { display: "flex", gap: 8, fontSize: 12, lineHeight: 1.7 } },
								React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", flex: "none", minWidth: 76 } }, ln.k),
								React.createElement("span", { style: { flex: 1, fontVariantNumeric: "tabular-nums" } }, ln.v)
							);
						})
					);
				};
				return React.createElement(
					"div",
					{ key: i, className: "dsh-sc", style: { border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, background: "var(--dsh-sc-bg)", overflow: "hidden", flex: "none" } },
					React.createElement(
						"div",
						{
							className: "dsh-sch",
							role: "button",
							title: open ? "收起" : "展开",
							onClick: function () { toggle(i); },
							style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", userSelect: "none", fontSize: 12.5, fontWeight: 600, color: "var(--dsw-alias-label-primary, #eceff4)", transition: "background .2s ease" }
						},
						React.createElement("span", { style: { minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, s.title),
						s.peakCostText && s.offCostText
							? React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 11.5 } }, "高峰 " + s.peakCostText + " + 低谷 " + s.offCostText)
							: null,
						React.createElement("span", { style: { flex: "none", color: p.accent, fontWeight: 700, fontVariantNumeric: "tabular-nums" } }, s.costText),
						React.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 12 } }, open ? "▾" : "▸")
					),
					open
						? React.createElement(
								"div",
								{ style: { padding: "0 9px 7px", color: p.body, borderTop: "1px dashed rgba(255,255,255,0.1)" } },
								tierBlock(s.peak),
								tierBlock(s.off),
								React.createElement(
									"div",
									{ style: { marginTop: 5, fontSize: 12, fontWeight: 700, color: p.accent, fontVariantNumeric: "tabular-nums" } },
									"合计 " + s.costText + (s.peakCostText && s.offCostText ? " = 高峰 " + s.peakCostText + " + 低谷 " + s.offCostText : "")
								)
							)
						: null
				);
			});

			return React.createElement(
				"div",
				{ style: { marginTop: 6, maxHeight: 360, overflowY: "auto", scrollbarWidth: "thin", display: "flex", flexDirection: "column", gap: 4 } },
				rows
			);
		});


		/** 折叠状态: 按横幅 context key 存模块级 Map (会话内跨重渲染保留, 不持久化到事件) */
		var collapseByKey = new Map();

		/** 横幅卡片 (家族同色同款: 图标 + 徽章 + 标题 + [统计格/键值行/明细] + 元信息 + 建议);
		 *  点击标题行折叠/展开 (折叠后只留一行: 图标+徽章+标题+关键值+箭头, 节约空间);
		 *  strong 统计格/折叠关键值用主题色标识 (费用等关键信息) */
		/* ---- obs3S7 段W-2b `(a)(b)`：**状态卡区块**（`kind` 分区渲染；`#A229` 五 F2） ---- */
		var SC_PART = { display: "flex", flexDirection: "column", gap: 2, padding: "2px 4px" };
		var SC_TITLE = { fontSize: 11, fontWeight: 600, opacity: 0.85 };
		var SC_LINE = { fontSize: 11, opacity: 0.7 };
		/** 值格式化：`null/undefined` ⇒ **如实 `n/a`**（不编造 0；`#C5` 只观测） */
		function scVal(v) { return v === null || v === undefined ? "n/a" : String(v); }
		function scJson(o) { try { return JSON.stringify(o); } catch (e) { return "{}"; } }
		/**
		 * ★ **`#A263` S4（判定式 = 用户已签）**：状态卡区块**"有没有问题"** ⇒ 决定是否可见。
		 *   有问题 = ① **会话级** `alert` 条数 > 0 ｜ ② `degrade`（`gate=DEGRADED`）｜ ③ 全局 `unplaced`（**窗口口径**，`#A263` S3）> 0
		 *   ｜ ④ 全局 `unknownRowTypes` > 0。
		 *   ★ **`kind:"session"`（会话级卡 / (ii) 类"无行"）不计入** —— 它是设计内的形态，不是"问题"。
		 *   本函数**纯判定**（与渲染分离 ⇒ 便于机械化判据）；可见性由调用方 `display` 控制（**DOM 一律保留**）。
		 */
		function scBlockProblem(list) {
			var alertN = 0, degraded = false, gUnplaced = 0, gUnknown = 0, gAnomN = 0, gProb = 0;
			for (var i = 0; i < list.length; i++) {
				var c = list[i];
				if (!c || typeof c !== "object") continue;
				var k = String(c.kind || "");
				if (k === "alert") {
					if (String(c.scope) === "global") {
						var gc = c.counts || {};
						if (Number(gc.unplaced) > 0) gUnplaced = Number(gc.unplaced);
						if (Number(gc.unknownRowTypes) > 0) gUnknown = Number(gc.unknownRowTypes);
						// ★ `T-E′` 后半（`#A60`）：**卡位异常 > 0 ⇒ 本块必须显示**（"存在异常才显示"的实现位）
						if (Number(gc.anomalyTotal) > 0) gAnomN = Number(gc.anomalyTotal);
						if (Number(gc.problemSessions) > 0) gProb = Number(gc.problemSessions);
					} else if (Array.isArray(c.items) && c.items.length > 0) alertN += 1;
				} else if (k === "degrade") degraded = true;
			}
			return (alertN > 0) || degraded || (gUnplaced > 0) || (gUnknown > 0) || (gAnomN > 0) || (gProb > 0);
		}
		/**
		 * ★ **`#A264` 全局行文案（用户已定，逐字）**：`⚠ 另有 N 个会话有问题：<短号8> 未定位X · <短号8> 未知Y`（最多 3 个 ＋ `…还有 N 个`）。
		 *   · `N` = **全局**"有问题会话"数（`gc.problemSessions`；`computeGlobalCounters` 为会话无关量 ⇒ 与"本会话"无关）；
		 *   · 逐条 = **短号 8** ＋ 非零项（`未定位X` ／ `未知Y`；两项都非零 ⇒ `未定位X/未知Y`）；
		 *   · `N > 3` ⇒ 尾缀 `…还有 (N-3) 个`；`N ≤ 0` ⇒ `✓ 无问题会话`（**不编造 0**：缺 `problemSessions` 键的老服务端同样落此分支）。
		 *   纯文本函数（不产生 DOM），锚点 `data-notice-obs-global-json` 由调用方保持原样。
		 */
		/**
		 * ★批16（`#78` 孤岛 `#6`「会话级卡张数」）：**会话级卡"张数"的唯一取数口**。
		 *   岛的两侧原本是 —— 服务端按 `index.sessionCards`（全史）逐条算，客户端调试面按
		 *   `placeState==="session"` 的**本窗口**键算 ⇒ **两个数**（全史 vs 窗口）。
		 *   统一口径（用户裁「以可渲染为准、服务端同批跟」）＝ **以服务端 `stateCards` 里 `kind:"session"`
		 *   那一条为准**（它由服务端 `buildIndex()` 用 `placeState==="session"` **同一判据**产出，
		 *   客户端**不再另算一遍**）：`张数 = Σ item.count`（＝ `index.sessionCards.length`）。
		 *   `list` 缺该条 ⇒ `0`（该组不渲染，`E35` 同口径）；返回 `-1` 表示"取不到"（调用方如实回退）。
		 */
		function scSessionCardCount(list) {
			try {
				if (!Array.isArray(list)) return -1;
				for (var i = 0; i < list.length; i++) {
					var c = list[i];
					if (!c || String(c.kind || "") !== "session") continue;
					// ① 首选 **分组行 `count` 之和**（＝ `index.sessionCards.length` 的确定性等价值；`cardId` 为
					//    `null` 的老条目不会被过滤掉）；② 分组行为空 ⇒ 退 `cardIds.length`。
					var its = Array.isArray(c.items) ? c.items : [];
					var n = 0;
					for (var j = 0; j < its.length; j++) n += (Number(its[j] && its[j].count) || 0);
					if (n > 0) return n;
					if (Array.isArray(c.cardIds)) return c.cardIds.length;
					return 0;
				}
				return 0;
			} catch (e) { return -1; }
		}
		function scGlobalText(gc) {
			var n = Number(gc && gc.problemSessions);
			var top = (gc && Array.isArray(gc.problemTop)) ? gc.problemTop : [];
			if (!Number.isFinite(n) || n <= 0) return "✓ 无问题会话";
			var parts = [];
			for (var i = 0; i < top.length && i < 3; i++) {
				var t = top[i] || {};
				var seg = [];
				if (Number(t.unplaced) > 0) seg.push("未定位" + Number(t.unplaced));
				if (Number(t.unknownRowTypes) > 0) seg.push("未知" + Number(t.unknownRowTypes));
				// A117：拒收原因点名（owner ×N: reason），每会话最多两条
				if (Array.isArray(t.rejected)) for (var ri = 0; ri < t.rejected.length && ri < 2; ri++) {
					var rr = t.rejected[ri] || {};
					if (rr.owner && Number(rr.count) > 0) seg.push(String(rr.owner) + " ×" + Number(rr.count) + ": " + String(rr.reason || "?"));
				}
				parts.push(String(t.sid || "") + (seg.length ? " " + seg.join("/") : ""));
			}
			// ★ `#A265` 件 B(b)：去「另有」（用户定稿）⇒ `⚠ N 个会话有问题：…`
			return "⚠ " + n + " 个会话有问题：" + parts.join(" · ") + (n > 3 ? "…还有 " + (n - 3) + " 个" : "");
		}
		/**
		 * **状态卡区块**（三类 kind **分区**：`alert` / `degrade` / `session`；**不得混装同一语义**）。
		 *   · 容器 = `data-notice-statecard-block`（与未定位区并列，**排在其后** ⇒ `#A229` 五 F4② 文档序）；
		 *   · 每类 `data-notice-statecard-kind` + `data-notice-statecard`（条数锚点）；
		 *   · `data-notice-obs-json` = 观测七项读数（**与写盘面同源** = ② counters ＋ ① rejected/RENDER）；
		 *   · `data-notice-statecard-global` = 全局聚合行（**开关 = `"global"`（默认）时进入 DOM**；★ `#A263` S4 起：
		 *     整块**只在"有问题"时可见**，清态 `display:none` 但**节点保留** ⇒ 锚点仍可被只读探针读到）。
		 *   **空 ⇒ 返回 null**（不占布局；老服务端 / 回退位 ⇒ 逐字同装前）。
		 */
		function stateCardBlockEl(list, tailArm, tailSeq) {
			try {
				var alertItems = [], degrade = null, sessionEl = null, globalEl = null;
				for (var i = 0; i < list.length; i++) {
					var c = list[i];
					if (!c || typeof c !== "object") continue;
					var k = String(c.kind || "");
					if (k === "alert") { if (String(c.scope) === "global") globalEl = c; else alertItems.push(c); }
					else if (k === "degrade") degrade = c;
					else if (k === "session") sessionEl = c;
				}
				var mk = React.createElement;
				var parts = [];
				var obs = degrade && degrade.counts ? degrade.counts : (alertItems.length && alertItems[0].counts ? alertItems[0].counts : null);
				// ★★ `T-E′` 后半（2026-09-21 obs3S7 `#A60`；**用户已裁 4 点**）：**卡位异常四类**上屏。
				//   用户裁定（逐字要点）：① **默认不显示、有异常才显示**｜② 文案**点名插件名**｜③ 保持在**每个会话的结尾、最显眼**、
				//   **全局只出一条**（别的会话有异常 ⇒ 当前会话也看得到 ⇒ 用 B 的**跨会话全局聚合**，**不按会话各出一条**）｜
				//   ④ 四类**分开展示**（`no-anchor`/`anchor-mismatch`/`rowless-unknown`/`pending-no-node`）。
				//   **不受 `dsh-notice-debug` 影响**（本块与 `noticeDebugOn()` 无关）；**不做处置入口**（档 b）；
				//   **预期类不计**（窗口外历史卡 ⇒ `pending`，PEND 行可隐藏，`台账 #34`）。
				// ★ `#A64` ⑤②（用户裁定口径）：**"用户可见那一行不得出现 `n/a`"** —— A 自己的 counters 在**渲染时可达**
				//   ⇒ **直接用本地值兜底**，不依赖服务端回读（端点/部署时点问题会让回读为 `null` ⇒ 旧写法渲染出 `n/a`）。
				var aView = (obs && obs.aCounters && typeof obs.aCounters === "object") ? obs.aCounters : null;
				if (!aView) {
					try { var _a2 = storeAlignAll(); aView = _a2 ? { pending: _a2.pending, pendingNoNode: _a2.pendingNoNode, slotIdHit: _a2.slotIdHit, newRulesPending: _a2.newRulesPending } : null; } catch (e2) { aView = null; }
				}
				var gAnom = globalEl && globalEl.counts ? globalEl.counts : null;
				if (gAnom && Number(gAnom.anomalyTotal) > 0) {
					// ★★ **`#A68` ②（批 2 件②，2026-09-21）**：**`pending-no-node` 已移出异常面**（预期类）⇒
					//   B 侧 `computeGlobalCounters().anomalies` 只出**三类** ⇒ 本表**同步删掉该项**（`qn > 0` 恒 false ⇒ 留着即死项）。
					//   **读数不丢**：`pendingNoNode` 仍走既有观测行（`A pendingNoNode=…`，见下方 `aView`）。
					var ANOM_LABEL = [["no-anchor", "找不到行落点"], ["anchor-mismatch", "声明的锚点查不到行"], ["rowless-unknown", "无行身份（B 判无行）"]];
					var anomLines = [];
					for (var qa = 0; qa < ANOM_LABEL.length; qa++) {
						var qn = Number(gAnom.anomalies ? gAnom.anomalies[ANOM_LABEL[qa][0]] : 0) || 0;
						if (qn > 0) anomLines.push(ANOM_LABEL[qa][1] + " " + qn + " 张 · " + ANOM_LABEL[qa][0]);
					}
					var anomSm = Array.isArray(gAnom.anomalySamples) ? gAnom.anomalySamples : [];
					parts.push(mk("div", {
						key: "anom", style: SC_PART, "data-notice-anomaly": "1",
						"data-notice-anomaly-resident": tailArm === "resident" ? "1" : "0",
						"data-notice-anomaly-json": scJson({ total: gAnom.anomalyTotal, anomalies: gAnom.anomalies, samples: anomSm })
					},
						mk("div", { style: SC_TITLE }, "⚠ 卡片落位异常 " + gAnom.anomalyTotal + " 项（跨会话聚合 · 全局一条）"),
						anomLines.map(function (x, xi) { return mk("div", { key: "an" + xi, style: SC_LINE }, x); }),
						anomSm.slice(0, 6).map(function (x2, xi2) {
							return mk("div", { key: "as" + xi2, style: SC_LINE }, "· " + scVal(x2.owner) + " · " + scVal(x2.family) + " · " + scVal(x2.cls));
						})
					));
				}
				// ★A95：**anchorLevel 四读数**（row/session/global/未声明）—— 永久可见（有数就出），不冒充告警；
				//   `未声明`恒 0（emit 已拦），保留读数以便回归时立刻看见。
				if (gAnom) {
					var lvRow = Number(gAnom.levelRow) || 0;
					var lvSess = Number(gAnom.levelSession) || 0;
					var lvGlob = Number(gAnom.levelGlobal) || 0;
					var lvUnde = Number(gAnom.levelUndeclared) || 0;
					if (lvSess + lvGlob + lvUnde > 0 || Number(gAnom.anomalyTotal) > 0) {
						parts.push(mk("div", {
							key: "anchorLevel", style: SC_PART, "data-notice-anchorlevel-readout": "1",
							"data-notice-anchorlevel-json": scJson({ row: lvRow, session: lvSess, global: lvGlob, undeclared: lvUnde })
						},
							mk("div", { style: SC_TITLE }, "卡锚定级别：行 " + lvRow + " · 会话 " + lvSess + " · 全局 " + lvGlob + " · 未声明 " + lvUnde),
							mk("div", { style: SC_LINE }, "未声明按行判定（无行即异常）；会话/全局级不计异常")
						));
					}
				}
				// ★`#A320` ①（用户裁「放到设置里面显示吧」）：**历史存量行已从会话面移除**（不再占会话版面）
				//   ⇒ 改在「设置 › 本地插件 › **历史存量**」**独立卡**内显示（★批4b ①：`#A330` 前在「通知横幅」折叠开关卡里，
				//   用户裁「放在卡片折叠那里感觉怪怪的」⇒ 已独立成项；见 `legacyReadout()` / `LegacyCard` / `LegacySummary`）。
				//   负向判据：**会话 DOM 里 `[data-notice-legacy-historic]` 与那段文案必须不存在**。
				// ① 告警卡（生产者侧 / 写入类拒绝；**去重不掩盖**：合一条 + `×N`，而 ① 仍 N 条）
				for (var a = 0; a < alertItems.length; a++) {
					var its = Array.isArray(alertItems[a].items) ? alertItems[a].items : [];
					parts.push(mk("div", {
						key: "alert" + a, style: SC_PART,
						"data-notice-statecard-kind": "alert", "data-notice-statecard-scope": "session",
						"data-notice-statecard": String(its.length)
					},
						mk("div", { style: SC_TITLE }, "⚠ 告警 " + its.length + " 项（① 中同因各记一条，此处仅视觉合并）"),
						its.map(function (x, xi) {
							return mk("div", { key: "al" + a + "_" + xi, style: SC_LINE },
								scVal(x.owner) + " · " + scVal(x.reason) + (x.code ? " [" + String(x.code) + "]" : "") + " ×" + scVal(x.count) + (x.lastAt ? " · 末次 " + String(x.lastAt) : ""));
						})
					));
				}
				// ② 错误卡（消费者侧；`gate`/`reason` **与闸门同源**）
				if (degrade) {
					var dc = degrade.counts || {};
					parts.push(mk("div", {
						key: "degrade", style: SC_PART,
						"data-notice-statecard-kind": "degrade", "data-notice-statecard-gate": String(degrade.gate || ""),
						"data-notice-statecard": "1"
					},
						// ★ `#A264` 文案定稿（用户已定，逐字）；`gate`/`reason` 仍由**锚点** `data-notice-statecard-gate` 与下行数值承载
						mk("div", { style: SC_TITLE }, "⛔ 卡片渲染异常 · 有卡找不到行落点（只观测 · 不自动回滚）"),
						// ★批16（`#78` 孤岛 `#7`「降级行 ⇄ 汇总行」）：**本行与汇总卡那行取同一个数** ——
						//   `unplacedRenderable`（可渲染口径，服务端随 `RENDER` 落盘）优先；老服务端/无该键 ⇒
						//   如实回退 `unplaced`（对齐口径，**不编造 0**）。两行从此不可能再出现"8 / 9"并存。
						mk("div", { style: SC_LINE }, "unplaced=" + scVal(Number.isFinite(dc.unplacedRenderable) ? dc.unplacedRenderable : dc.unplaced) + " · mismatch=" + scVal(dc.mismatch))
					));
				}
				// ③ 会话级卡（(ii) 类"无行"；**不进行、不进未定位区**）
				if (sessionEl) {
					var sits = Array.isArray(sessionEl.items) ? sessionEl.items : [];
					// ★批16（`#78` 孤岛 `#6`）：**N ＝ 张数**（服务端 `index.sessionCards` 条数，见 `scSessionCardCount()`）；
					//   逐行仍按 `owner|kind|ctxKey` 分组并标 `×count` ⇒ N == Σ×count（可机械对撞，不再"项/张两套"）。
					var _scn = scSessionCardCount([sessionEl]);
					if (!Number.isFinite(_scn) || _scn < 0) _scn = sits.length;
					parts.push(mk("div", {
						key: "session", style: SC_PART,
						"data-notice-statecard-kind": "session", "data-notice-statecard": String(_scn)
					},
						mk("div", { style: SC_TITLE }, "🗂 会话级卡 " + _scn + " 张（无对应行 · 不占未定位计数）"),
						sits.map(function (x, xi) {
							return mk("div", { key: "se" + xi, style: SC_LINE },
								scVal(x.owner) + " · " + scVal(x.kind) + (x.ctxKey ? " · " + String(x.ctxKey) : "") + " ×" + scVal(x.count));
						})
					));
				}
				// 观测七项读数（**单一来源**；与写盘面逐项对撞的"上屏面"）
				if (obs) {
					parts.push(mk("div", {
						key: "obs", style: SC_LINE, "data-notice-obs": "1", "data-notice-obs-json": scJson(obs)
					},
						"观测 unplaced=" + scVal(obs.unplaced) + " mismatch=" + scVal(obs.mismatch) + " unknownRowTypes=" + scVal(obs.unknownRowTypes) +
						" dupHits=" + scVal(obs.dupHits) + " orphans=" + scVal(obs.orphans) + " notFound=" + scVal(obs.notFound) +
						" ownerRejected=" + scVal(obs.ownerRejected) + " writerLock=" + scVal(obs.writerLock) +
						" ｜ T11 cardsPanel=" + scVal(obs.cardsPanelLast) + " visible=" + scVal(obs.visibleLast) + " renderStale=" + scVal(obs.renderStale) +
						// ★ `T-E′` 前半：A 侧四计数 ＋ `rejectedByReason`（**只扩这一行的文本/JSON，不新增上屏行**）
						" ｜ A pending=" + scVal(aView && aView.pending) + " pendingNoNode=" + scVal(aView && aView.pendingNoNode) +
						" slotIdHit=" + scVal(aView && aView.slotIdHit) + " newRulesPending=" + scVal(aView && aView.newRulesPending) +
						" ｜ rejected=" + scJson(obs.rejectedByReason || {})));
				}
				// 全局聚合（**默认开**；开关 = `"session"` ⇒ 本行不渲染 ⇒ 判据 3 正控可判红）
				if (globalEl) {
					var gc = globalEl.counts || {};
					parts.push(mk("div", {
						key: "global", style: SC_LINE, "data-notice-statecard-global": "1",
						"data-notice-obs-global-json": scJson(gc)
					},
						scGlobalText(gc)));
				}
				if (!parts.length) return null;
				// ★ `#A263` S4：**只在"有问题"时可见**；清态 ⇒ `display:none`（**DOM 一律保留** ⇒ 锚点
				//   `data-notice-obs-json` / `data-notice-statecard-global` 不删、可继续被只读探针读到）。
				//   **判据 3 反写**（`#A263` 四）：旧口径"默认 `"global"` ⇒ 非出事会话也看得见累计条数"**作废**。
				//   `data-notice-statecard-shown` = 机械可读的判别位（`"1"`/`"0"`；不参与 §1.5 开关语义）。
				var shown = scBlockProblem(list);
				return mk("div", { style: { display: shown ? "flex" : "none", flexDirection: "column", gap: 6 }, "data-notice-statecard-block": "1", "data-notice-statecard-shown": shown ? "1" : "0", "data-notice-tail": String(tailArm || "none"), "data-notice-resident": tailArm === "resident" ? "1" : "0", "data-notice-tail-seq": tailSeq === null || tailSeq === undefined ? "" : String(tailSeq) }, parts);
			} catch (e) { return null; }
		}
	/* ═══════════════════════════════════════════════════════════════════════════
	   notice-scroll 甲1（2026-10-11；用户逐字「可以按照推荐的来」；规格件 §2／§2.1）
	   —— **卡栈不占滚动高度**（锚节点 `height:0`）＋ **相对锚点向上浮出**
	      （`position:absolute; left:0; right:0; bottom:100%`）＋ **常驻留白带**
	      ＋ **折叠合成卡**（告警优先／层叠露边／点击展开／折叠态 ≤96px；命令·费用族豁免）
	   禁项（硬，违反即停）：不写宿主滚动容器／不写宿主 DOM 属性／**不新增任何监听**
	      （**尤其不监听宿主滚动** —— 展开态＝「融入内容流、不主动收起」，靠自身 state 与锚点文档序即可）。
	   开关（**自有** `localStorage`，须纳入回退阶梯＝状态复位）：`dsh-notice-reserve`
	      = 缺省/`"static"`（静态 116px）｜`"dynamic"`（**VM P6 实验档**：带值随卡数/档位变化，无卡 ⇒ 收窄为 0）
	   ═══════════════════════════════════════════════════════════════════════════ */
	var NS_FOLD_CAP = 96;          /* 折叠合成卡上限（用户 2026-10-11 裁定「统一压 ≤96px」） */
	var NS_LAYER_OFF = 5;          /* 层叠露边（每张 5px；用户「Windows 多窗口层叠」观感） */
	var NS_CMD_KINDS = { cost: 1, balance: 1, costs: 1 };    /* 命令·费用族（用户逐字「那个也折叠进去会比较怪异」）⇒ 不参与合成 */
	var NS_ALERT_KINDS = { error: 1, alert: 1, degrade: 1 };  /* 告警族（合成卡默认展示；真机告警 kind 全集见收口件「未核」） */
	function nsNoFold(ent) {
		try {
			if (!ent || typeof ent !== "object") return false;
			if (nsFormOf(ent) === "bubble") return true;   /* ★2026-10-14 口径：**迷你气泡行恒不折叠、始终显示** */
			if (typeof ent.commandId === "string" && ent.commandId) return true;   /* 老豁免（命令族）**逐字不动**（用户裁"保持 2026-10-11"） */
			return !!NS_CMD_KINDS[String(ent.kind || "")];
		} catch (e) { return false; }
	}
	function nsPriOf(x) {
		try {
			// ★A110：数据自声明优先；入参可为条目或旧 kind 字符串
			if (x && typeof x === "object") {
				var p = x.priority;
				if (typeof p === "number" && p >= 0 && p <= 3) return p;
				return nsPriOf(String(x.kind || ""));
			}
			var k = String(x || "");
			return NS_ALERT_KINDS[k] ? 0 : (k === "status" ? 1 : (k === "notify" || k === "compat" ? 2 : 3));
		} catch (e) { return 3; }
	}
	/** ★A110：能否进折叠族（true=可折叠）；缺字段回落旧 nsNoFold 规则（旧卡兼容）。 */
	function nsFoldable(ent) {
		try {
			if (ent && typeof ent.foldable === "boolean") return ent.foldable;
			if (!ent || typeof ent !== "object") return false;
			return !nsNoFold(ent);
		} catch (e) { return false; }
	}
	/** ★A110：家族（图标/徽章/色板/历史色）；缺字段回落 kind。 */
	function nsFamOf(ent) {
		try {
			var f = String((ent && ent.family) || "");
			if (f) return f;
			return String((ent && ent.kind) || "");
		} catch (e) { return "notify"; }
	}
	var NS_ITEM_FACE = { borderRadius: 8, border: "1px solid var(--dsh-glass-bd, rgba(255,255,255,.08))", background: "var(--dsh-glass-bg, rgba(255,255,255,.06))", padding: "2px 6px" };   /* ★修1后半：展开态"每条目一张可见卡"的卡面 */
	var NS_COUNT_SIGN = { alignSelf: "flex-start", fontSize: 11, lineHeight: "18px", padding: "0 6px", borderRadius: 8, color: "var(--dsw-alias-label-tertiary, #9aa3b2)", background: "var(--dsh-glass-bg, rgba(255,255,255,.06))", border: "1px solid var(--dsh-glass-bd, rgba(255,255,255,.08))" };   /* ★修1前半：计数签（折叠态） */
	/* ═══ ★修件（2026-10-13；用户逐字裁定见 `docs/协作任务/notice-scroll/确认卡.md` §一 修1／修3／修4）═══
	   下面几个**纯函数**是本批全部"判定类"改动的**唯一落点**：只吃入参、不读宿主、不写任何状态、绝不 throw
	   ⇒ 离线判据脚本按**真源同源字符**直取执行（`log/notice-scroll/2026-10-13-修件-判据.mjs`），
	   并与**改前件**（`log/notice-scroll/snapshots/修件-PRE/`）逐条做负控对撞。
	   ═══════════════════════════════════════════════════════════════════════════════════════════ */
	/** ★★**形式区分口径**（**用户 2026-10-14 逐字**：「**只有迷你气泡行才豁免折叠 始终显示 且计算的时候
	 *  不能算作卡片 我们所说的卡片都是横幅样式的 这两个口径在代码层面就要钉死**」）——
	 *  `nsFormOf(ent)` 是「**气泡 vs 卡片**」的**唯一出处**：返回 `"bubble"`（迷你气泡行，＝ `:3926` 那条
	 *  `dsh-status` 22px 无边框裸行）或 `"card"`（**横幅样式卡片**，即 `dsh-banner`）。
	 *  ⚠️ **严禁在别处再写一遍气泡判定**（如 `kind === "status"`）：将来新增迷你行 kind ⇒ **只改本函数这一处**
	 *  （`ENV §四` 读到即维护），**并同批补判据**。判据 ④ 机械看住：定义恰 **1** 处、被引用 **≥2** 处。 */
	function nsFormOf(ent) {
		try {
			// ★A97：**数据自声明优先**（`form` 来自 banner-kit 常量），老卡无该字段 ⇒ 回落既有 kind 规则（存量兼容，非写入侧默认值）
			var f = String((ent && ent.form) || "");
			if (f === "bubble" || f === "card") return f;
			return (String((ent && ent.kind) || "") === "status") ? "bubble" : "card";
		} catch (e) { return "card"; }
	}
	/** ★「**非条目**」三类**显式排除**（防将来被误当条目混进折叠族／卡片计数）：
	 *  ① **合成卡容器**（`NoticeMergedCard` 渲染的容器本体，锚点 `[data-notice-merged]`）＝**折叠表示本身**，非条目；
	 *  ② **状态卡区块**（锚点 `[data-notice-statecard-block]` / `data-notice-statecard-*`，`storeStateCards()` 产出）＝**汇总/观测区块、纯文本行、非卡面**；
	 *  ③ **辅助行**（PEND `[data-notice-pending]`／未定位 `[data-notice-unplaced]`／降级 `[data-notice-degrade]`）＝提示行。
	 *  ⇒ 三者**不进折叠族、不进卡片计数**；本谓词挡在 `nsFoldPlan` 最前（React 元素／非条目形状一律 `false`）。 */
	function nsIsCardEntry(ent) {
		try {
			if (!ent || typeof ent !== "object" || Array.isArray(ent)) return false;
			if (ent.$$typeof || ent.__nsNonEntry) return false;
			return typeof ent.kind === "string" && !!ent.kind;   /* 条目面必带 kind（store 条目形状） */
		} catch (e) { return false; }
	}
	/** ★修1前半：**折叠态"代表卡"选取**（纯函数）。规则：
	 *  ① 折叠族内含**告警族**（`NS_ALERT_KINDS`）⇒ 露**告警**（同族取最新，＝旧 `:3343` 的"优先级最小者"语义）；
	 *  ② 否则露**第一张"有真卡面"的条目**（按条目序，**跳过 `status` 迷你行**）；
	 *  ③ 全族皆气泡行（`nsFormOf === "bubble"` ⇒ 按口径**本就不进折叠族**，此支只作极端兜底）⇒ 回落"优先级最小者"（**不强造假卡面**）。
	 *  ⚠️ 旧实现（`hi` ＝ 全族优先级最小者）**正是"账本卡被藏、只露那条迷你行"**的成因
	 *  （`log/notice-scroll/2026-10-13-段1b-D3幽灵卡核查.md` §②）。 */
	function nsRepOf(ents) {
		try {
			var list = (ents && ents.length) ? ents : [], i, best = null;
			for (i = 0; i < list.length; i++) {
				if (nsPriOf(list[i]) !== 0) continue;
				if (!best || nsPriOf(list[i]) <= nsPriOf(best)) best = list[i];
			}
			if (best) return best;
			for (i = 0; i < list.length; i++) { if (nsFormOf(list[i]) === "card") return list[i]; }   /* ★2026-10-14：气泡判定统一走 `nsFormOf`（单一出处） */
			best = list.length ? list[0] : null;
			for (i = 1; i < list.length; i++) { if (nsPriOf(list[i]) <= nsPriOf(best)) best = list[i]; }
			return best;
		} catch (e) { return null; }
	}
	/** ★修3：**合并判定与"尾锚资格"解耦**（纯函数）—— 旧实现 `isUniverseTail && stack.length >= 2`
	 *  ⇒ **非尾栈永不合并**（与修2(a) 同根：补滚也只在尾锚触发）。现**只看条目集合**：
	 *  · `nsNoFold`（命令·费用族：`cost`/`balance`/`costs`/带 `commandId`）不参与合成 ⇒ 各自完整渲染；
	 *  · **可折叠族 ≥ 2 张**才合成（⇒ **单条目永不合成**，"单卡＝全展"裁定不变）。 */
	function nsFoldPlan(stack) {
		var fold = [], keep = [], i, ent;
		try {
			for (i = 0; i < (stack ? stack.length : 0); i++) {
				ent = stack[i];
				if (!nsIsCardEntry(ent)) continue;              /* ★非条目三类（容器/状态区块/辅助行）⇒ 既不进族也不计数 */
				(!nsFoldable(ent) ? keep : fold).push(ent);        /* ★气泡行（`nsNoFold` 恒 true）⇒ 进 `keep`：不进折叠族、不计卡片数 */
			}
		} catch (e) { return { fold: [], keep: (stack || []), merged: false }; }
		return { fold: fold, keep: keep, merged: fold.length >= 2 };
	}
	/** ★修4②：**内层子卡 key 不得随条目下标漂移** —— 用**条目稳定身份**
	 *  （`cardId` > `ctxKey` > `source|kind|turn|at` 组合）；**下标不再参与主身份**。
	 *  ⇒ 条目增删/换序后已有卡的 key 不变 ⇒ 内层 `collapseByKey`（`:3663` 读／`:3806` 写）态不漂移
	 *  （段1b §D4-3 登记的代码级事实）。 */
	function nsEntryKeyOf(ent) {
		try {
			if (!ent || typeof ent !== "object") return "";
			if (typeof ent.cardId === "string" && ent.cardId) return "c|" + ent.cardId;
			if (typeof ent.ctxKey === "string" && ent.ctxKey) return "k|" + String(ent.kind || "") + "|" + ent.ctxKey;
			return "s|" + String(ent.source || "") + "|" + String(ent.kind || "") + "|" + String(ent.turn == null ? "-" : ent.turn) + "|" + String(ent.at == null ? "-" : ent.at);
		} catch (e) { return ""; }
	}
	/** 同栈内 key 列表（**仅在"同身份重复"时**追加 `~n` 去重后缀；正常条目逐字原样）。 */
	function nsEntryKeysOf(ents) {
		var out = [], seen = {}, i, k, n;
		for (i = 0; i < (ents ? ents.length : 0); i++) {
			k = nsEntryKeyOf(ents[i]); if (!k) k = "i";
			n = (seen[k] === undefined) ? 0 : seen[k]; seen[k] = n + 1;
			out.push(n === 0 ? k : (k + "~" + n));
		}
		return out;
	}
	/** ★修4①：**折叠态 `expanded` 提到"不随载体卸载"的位置** —— 旧实现用组件内 `React.useState(false)`
	 *  （唯一改写点 `:3362`），而载体（`[data-notice-merged]`）在 `nsMerged=null`（族条目不足／锚点变动）
	 *  时**消失 ⇒ 组件卸载 ⇒ 状态丢失** ⇒ 观感"点开一段时间后折不起来"（段1b §D4）。现改为**模块级 Map**
	 *  （与内层卡 `collapseByKey` **同机制**：模块态 ＋ 本地 tick 触发重渲染）：
	 *  · key = `sessionId#锚点seq`（**跨会话不共享**）；· **不落 localStorage**（强刷即复位 ⇒ 回退阶梯
	 *  "状态复位"口径仍成立；本件**不新增** localStorage 键）。 */
	var nsFoldExpandedMap = {};
	function nsFoldStateKey(sessionId, seq) { try { return String(sessionId == null ? "" : sessionId) + "#" + String(seq == null ? "" : seq); } catch (e) { return ""; } }
	function nsFoldExpandedGet(k) { try { return nsFoldExpandedMap[String(k)] === true; } catch (e) { return false; } }
	function nsFoldExpandedSet(k, v) { try { nsFoldExpandedMap[String(k)] = !!v; } catch (e) { /* 忽略 */ } }
	/* ★notice-scroll 步 2（2026-10-11；用户签字）——**浮层/留白带已删**，贴底改由**中间件补滚**承担：
	   唯一调用点 = 尾锚**渲染完成后**（`rAF×2`）调一次 `hostScroll.toBottom({source,intentGateMs:800})`。
	   `hostScroll` 取不到 ⇒ **只丢补滚、卡片照常渲染**（`ENV §一.6②`：如实降级、禁 legacy 直连兜底）。
	   `NS_SEAM_GATE_MS = 800` 为**契约 §4.11 常数**（非宿主既有值）⇒ 变更须同批改契约本节；
	   并纳入**回退阶梯＝状态复位**口径（本件**不新增** localStorage 键）。 */
	var NS_SEAM_GATE_MS = 800;
	var nsSeamPrevN = {}, nsSeamLog = [], nsSeamReqPending = false;
	function nsSeamService() { try { var c = pluginCtx; return (c && c.get) ? (c.get("hostScroll", false) || null) : null; } catch (e) { return null; } }
	function nsSeamLogPush(o) { try { nsSeamLog.push(o); if (nsSeamLog.length > 200) nsSeamLog.shift(); } catch (e) { /* 忽略 */ } }
	/** 纯函数：**该不该补滚** ＝ 只看"该锚点条目数是否增长"（首见键 `prev=-1` ⇒ 不触发 ＝ 旧语义，不变）。 */
	function nsSeamShouldFire(prev, n) { try { return (prev >= 0 && n > prev); } catch (e) { return false; } }
	/** ★修2(b)（2026-10-13；用户裁定「**自身发送 ⇒ 一律跟到底** vs **外来源 ⇒ 仍受闸门保护**」）：
	 *  旧实现**不能区分**（`source` 只做类型校验、零分支 `hc client.js:634`；闸门只吃 `intentBottom` `:640`）。
	 *  本件的区分点：**消费方申报 `selfSend`**，取值来自中间件新增的**输入身份面** `inputs()`
	 *  （层1：输入面**记身份** —— 「提交类输入」＝ `keydown`＋`Enter`，非 `shiftKey`／非 `isComposing`；
	 *  其后一旦出现**非提交类输入**（`wheel`/`touchstart`/`touchmove`/`pointerdown`/非 Enter 的 `keydown`）
	 *  ⇒ **自身发送窗口关闭**）。**取不到／形状不合 ⇒ 恒 `false` ＝ 旧行为**（新键缺省值 = 旧行为）。 */
	function nsSeamSelfSend(svc) {
		try {
			if (!svc || typeof svc.inputs !== "function") return false;
			var r = svc.inputs();
			return !!(r && r.ok === true && r.selfSend === true);
		} catch (e) { return false; }
	}
	function nsCallScrollSeam(isTail, n, key) {
		try {
			/* ★修2(a)（2026-10-13）：**非尾栈也要补滚** —— 旧实现首行 `if (!isTail) return;` ⇒ 插卡落非尾栈
			   **一次都不补滚**（段1 §A-2 实测：8s 内 4 次卡渲染、前 3 次零补滚、`slack` 722→**1166px**）。
			   现**取消该早退**：`isTail` 只作**日志字段**（可观测），**不再作闸门**；"该不该滚"由
			   ① 意图闸门（中间件 `hc:640`，外来源仍受保护）＋ ② 本节"只看增长"共同决定。
			   ★同一帧内多次增长 ⇒ **合并为一次**（补滚是"到底"，重复无意义；调用面有界、可判据）。 */
			var svc = nsSeamService();
			if (!svc || typeof svc.toBottom !== "function") { nsSeamLogPush({ t: Date.now(), skipped: "service-missing", tail: !!isTail, n: n }); return; }
			try { if (typeof svc.read === "function") svc.read(); } catch (eR) { /* 只读失败不影响后续（read() 只为尽早挂监听） */ }
			var k = String(key == null ? "" : key);
			var prev = (nsSeamPrevN[k] === undefined) ? -1 : nsSeamPrevN[k];
			var grew = nsSeamShouldFire(prev, n);
			nsSeamPrevN[k] = n;
			/* ★修2(a)：**早退必写日志**（旧实现两条早退都不写日志 ⇒ `seamN=0` 无法唯一区分是 `!isTail` 还是
			   `!grew`，见段1 §E-2「未核」）—— 现两条早退各自留痕，`tail` 字段一并记录。 */
			if (!grew) { nsSeamLogPush({ t: Date.now(), skipped: "no-grow", tail: !!isTail, n: n, prev: prev }); return; }
			if (nsSeamReqPending) { nsSeamLogPush({ t: Date.now(), skipped: "coalesced", tail: !!isTail, n: n }); return; }
			nsSeamReqPending = true;
			requestAnimationFrame(function () { requestAnimationFrame(function () {
				nsSeamReqPending = false;
				try { var ss = nsSeamSelfSend(svc); nsSeamLogPush({ t: Date.now(), tail: !!isTail, n: n, selfSend: ss, r: svc.toBottom({ source: "notice-banner", intentGateMs: NS_SEAM_GATE_MS, selfSend: ss }) }); }
				catch (e2) { nsSeamLogPush({ t: Date.now(), err: String((e2 && e2.message) || e2) }); }
			}); });
		} catch (e) { /* 加载期 inert：绝不抛 */ }
	}
	/** 只读自证面（VM 场/J 判据用；**不写宿主、不写 localStorage**） */
	function nsSeamState() { try { var svc = nsSeamService(); return { hasService: !!svc, shapeOk: nsSeamShapeOk(svc), gateMs: NS_SEAM_GATE_MS, steadyMs: NS_SEAM_STEADY_MS, ticks: nsSeamRep.ticks, lastTickAt: nsSeamRep.lastTickAt, lastReported: nsSeamRep.last, log: nsSeamLog.slice(-40) }; } catch (e) { return { hasService: false, gateMs: NS_SEAM_GATE_MS, log: [] }; } }
	try { if (typeof window !== "undefined" && (function () { try { return String(localStorage.getItem("dsh-host-scroll-debug") || "") === "1"; } catch (e) { return false; } })()) window.__nsSeam = nsSeamState; } catch (e) { /* 忽略 */ }   /* ★调试面默认关闭（2026-10-13 #A577 ③） */
	/* ★`#A581` ①（路线 1 · **应用侧自报**；2026-10-13）：把**客户端面服务** `hostScroll` 的**取用结果**回传给本插件 host 半
	   ⇒ host 半写**自有分片**（§4.10）⇒ `buildStatus().plugins[notice-banner].state` 与面板**如实**反映"补滚停用"
	   （`ENV §一.6②` 禁"报 OK 而功能坏"）。**零新增直连宿主接触点**：走**既有** `/host-compat` 路由的**自有**端点
	   `notice/seam-state`（`compatBus` 通用端点注册；**中间件零改动**）。
	   ★加载顺序无保证（契约 RD-81：外壳对全部插件条目 `Promise.all` 并发 `create`）⇒ **不得"一见没有就报缺失"**
	   （会**假红**：host-compat 的 client 半可能尚未装配）⇒ 按 `[0,500,1500,3000]ms` 复探，**窗口耗尽仍无**才判缺失；
	   拿到过 ⇒ 立即报 `ok` 并停止复探；**值不变不重复上报**；发送失败（端点尚未注册）按 `[2000,4000]ms` 重发 2 次。
	   绝不 throw、绝不写宿主/localStorage。 */
	var NS_SEAM_PROBE_DELAYS = [0, 500, 1500, 3000];   /* 启动早期复探（覆盖 host-compat 半的装配窗口） */
	var NS_SEAM_STEADY_MS = 5000;                      /* ★F4：窗口后**常驻**复探（不粘滞；成本＝每 5s 几次属性读） */
	var NS_SEAM_SEND_RETRY_MS = [2000, 4000];
	var nsSeamRep = { last: null, step: 0, sendTries: 0, hostMiss: 0, ticks: 0, lastTickAt: 0 };   /* ★`#A584` ③：ticks/lastTickAt ＝ **复探成本读数**（只进调试面） */
	/** ★F4（2026-10-13 `#A583` ②）：**服务形状校验** —— 只有「`toBottom` 是函数」才算服务可用
	 *  ⇒ `{}` 之类**假服务不得被判 OK**（原实现 `if (svc)` 一名为真即报 ok ＝ 假绿）。 */
	function nsSeamShapeOk(svc) {
		/* ★`#A586` ③：**形状校验补 `read`** —— `read()` 是中间件**挂监听的唯一入口** ⇒ 只有 `toBottom` 的假服务
		   同样**不得**被判 ok（否则"补滚可调、监听没挂"＝ 假绿）。 */
		try { return !!(svc && typeof svc.toBottom === "function" && typeof svc.read === "function"); } catch (e) { return false; }
	}
	/** ★`#A586` ②：**两级语义** —— ① **服务在位**（本半真拿到 `provide` 且形状合）② **宿主面在位**
	 *  （中间件 `available()`：有滚动容器且**无挂载错误**）。两级**各自**给 `reason`；**任一不满足 ⇒ 判缺失**。
	 *  `host` 级沿用"连续两拍"去抖（**同毫秒边界**：同一毫秒内两拍**仍计两拍** —— 判定只看**拍数**不看时间差）。 */
	function nsSeamLevels(svc) {
		if (!nsSeamShapeOk(svc)) {
			var why = !svc ? "service-missing" : (!(svc && typeof svc.toBottom === "function") ? "bad-shape:toBottom" : "bad-shape:read");
			return { service: "missing", host: "unknown", reason: why, ok: false };
		}
		var host = { ok: true, reason: null };
		try {
			if (typeof svc.available === "function") {
				var r = svc.available();
				if (r && r.ok === true) nsSeamRep.hostMiss = 0;
				else if (nsSeamRep.hostMiss++ >= 2) host = { ok: false, reason: String((r && r.reason) || "unavailable") };
			}
		} catch (e) { /* 探测抛错 ⇒ 不据此判红（下一拍再试） */ }
		return { service: "ok", host: host.ok ? "ok" : "missing", reason: host.ok ? null : host.reason, ok: host.ok };
	}
	/** ★F1（2026-10-13 `#A583` ①）：**尾锚无内容也必须挂监听** —— `read()` 是中间件挂监听的**唯一**入口，
	 *  本函数**不依赖**"卡片有没有内容"（与 `nsCallScrollSeam` 的 `grew`／无内容早退**彻底解耦**）。 */
	function nsSeamAttach() {
		try {
			var svc = nsSeamService();
			if (!nsSeamShapeOk(svc)) return false;
			if (typeof svc.read === "function") svc.read();
			return true;
		} catch (e) { return false; }
	}
	function nsSeamSend(state, reason, levels) {
		try {
			compatRpc("notice/seam-state", { state: state, reason: reason || "", service: (levels && levels.service) || null, host: (levels && levels.host) || null }).then(function (r) {
				if (r && r.ok === true && r.value && r.value.seam === state) return;
				if (nsSeamRep.sendTries < NS_SEAM_SEND_RETRY_MS.length) {
					var d = NS_SEAM_SEND_RETRY_MS[nsSeamRep.sendTries++];
					setTimeout(function () { nsSeamSend(state, reason, levels); }, d);
				}
			}, function () { /* 传输失败：由下一拍复探再报 */ });
		} catch (e) { /* 上报绝不影响渲染 */ }
	}
	function nsSeamTick() {
		try { nsSeamRep.ticks += 1; nsSeamRep.lastTickAt = Date.now(); } catch (eT) { /* 计数失败不影响主流程 */ }
		try {
			var svc = nsSeamService();
			var lv = nsSeamLevels(svc);
			if (lv.ok) {
				var rr = null;
				try { rr = nsSeamAttach(); } catch (e0) { rr = null; }
				/* ★`#A586` ④：`read()` 如实反映挂载失败 ⇒ 消费方**照实降级**（禁"报 OK 而功能坏"） */
				if (rr === false) lv = { service: "ok", host: "missing", reason: "attach-error", ok: false };
				else if (typeof svc.read === "function") {
					try { var r2 = svc.read(); if (r2 && r2.ok === false) lv = { service: "ok", host: "missing", reason: String(r2.reason || "read-failed"), ok: false }; } catch (e3) { lv = { service: "ok", host: "missing", reason: "read-threw", ok: false }; }
				}
			}
			if (lv.ok) {
				if (nsSeamRep.last !== "ok") { nsSeamRep.last = "ok"; nsSeamSend("ok", "", lv); }
			} else if (nsSeamRep.step >= NS_SEAM_PROBE_DELAYS.length) {
				var why = (lv.service === "missing" && (lv.reason === "service-missing" || lv.reason === "bad-shape:toBottom" || lv.reason === "bad-shape:read"))
					? (lv.reason === "service-missing" ? "hostScroll 客户端面服务未提供（复探窗口耗尽）" : ("hostScroll 服务形状不符（" + lv.reason.replace("bad-shape:", "缺 ") + " 函数）"))
					: ("hostScroll 宿主面不可用（" + String(lv.reason || "unknown") + "）");
				if (nsSeamRep.last !== "missing") { nsSeamRep.last = "missing"; nsSeamSend("missing", why, lv); }
			}
		} catch (e) { /* 忽略 */ }
		/* 下一拍：早期窗口走 `NS_SEAM_PROBE_DELAYS`；窗口后**常驻** `NS_SEAM_STEADY_MS`
		   ⇒ ★F4：**服务迟到仍能转 `OK`**、服务消失也能转回 `missing`（**不粘滞**）。 */
		try {
			setTimeout(nsSeamTick, (nsSeamRep.step < NS_SEAM_PROBE_DELAYS.length) ? NS_SEAM_PROBE_DELAYS[nsSeamRep.step++] : NS_SEAM_STEADY_MS);
		} catch (e) { /* 忽略 */ }
	}
	try { setTimeout(nsSeamTick, 0); } catch (e) { /* 忽略 */ }
	/** 折叠合成卡：把可折叠族的 ≥2 张合成为 1 张（告警优先；N−1 条层叠露边；点击展开全部）。
	 *  ★展开态 ＝ **不主动收起**（用户逐字「遮挡后 如果我滚动的话 应该是融入 不是这种直接收回」）
	 *    ⇒ 只靠自身 `useState`；**不监听任何宿主事件**（`ENV §一.7①` 风险归零）。 */
	function NoticeMergedCard(props) {
		/* ★修4①：**状态化**（模块级 Map ＋ 本地 tick），不再用会随卸载丢失的组件内 `useState`。 */
		var st = React.useState(0), setTick = st[1];
		var stateKey = String((props && props.stateKey) || "");
		var expanded = nsFoldExpandedGet(stateKey);
		var ents = (props && props.ents) || [], i;
		var hi = nsRepOf(ents);   /* ★修1前半：代表卡 ＝ 告警优先，否则**第一张"有真卡面"的条目**（跳过 status 迷你行） */
		var ikeys = nsEntryKeysOf(ents);   /* ★修4②：内层子卡 key ＝ 条目**稳定身份**（不含下标） */
		var edges = [];
		if (!expanded) for (i = ents.length - 1; i >= 1; i--) {
			edges.push(React.createElement("div", {
				key: "edge" + i, className: "dsh-merged-edge", "data-merged-edge": String(i),
				style: { height: NS_LAYER_OFF, flex: "none", borderRadius: "6px 6px 0 0", background: "var(--dsh-glass-bg, rgba(255,255,255,.06))",
					border: "1px solid var(--dsh-glass-bd, rgba(255,255,255,.08))", borderBottom: "none", marginLeft: i * 3, marginRight: i * 3, opacity: 0.9 }
			}));
		}
		/* ★`#A31` 步2：**可插内层渲染器**（历史卡复用本组件，不再重造折叠）——
		   缺省 `renderItem`（缺省＝现状）⇒ 逐字走 `NoticeBannerView`；**传了才换内层**。
		   这样"折叠态 ≤96px／层叠露边／计数签／点击展开/收起／模块级折叠态"**一律复用同一实现**。 */
		var mkDefault = function (ent, key, cap) {
			var el = React.createElement(NoticeBannerView, { key: key, node: { key: String((props && props.nodeKey) || "") + "#" + key, id: props && props.nodeId, kind: "notice-banner", data: ent }, t: props && props.t });
			if (cap) return React.createElement("div", { className: "dsh-merged-hi", "data-merged-hi": String((ent && ent.kind) || ""), style: { maxHeight: NS_FOLD_CAP, overflow: "hidden" } }, el);
			/* ★修1后半：展开态**每条目一张可见卡** —— 迷你行（`kind:"status"`）也获得卡面容器
			   ⇒ 不再出现"多出一条不可识别（无边框裸行）"的观感；`data-merged-item` 提供一一对应的机械锚点。 */
			return React.createElement("div", { className: "dsh-merged-item", "data-merged-item": key, "data-merged-item-kind": String((ent && ent.kind) || ""), style: NS_ITEM_FACE }, el);
		};
		var mk = (props && typeof props.renderItem === "function") ? props.renderItem : mkDefault;
		var body = expanded
			? ents.map(function (ent, idx) { return mk(ent, ikeys[idx] || ("m" + idx), false); })
			: mk(hi, "hi", true);
		/* ★修1前半：折叠态**必须带计数签**（口径＝该锚点 store 侧**可折叠族条目数** `ents.length`；
		   `data-fold-count` 属性不变，计数签为其**可见面**）。 */
		var countSign = expanded ? null : React.createElement("span", {
			className: "dsh-merged-count", "data-merged-count-badge": "1", "data-merged-count": String(ents.length),
			style: NS_COUNT_SIGN
		}, "共 " + ents.length + " 张 · 点击展开");
		return React.createElement("div", {
			/* ★计数口径（2026-10-14 钉死）：`props.ents` **恒为折叠族**（`nsPlan.fold`）⇒ 气泡行与命令卡**均不计入**；
		   `data-fold-count`（本容器）与 `data-merged-count`（计数签）**同源于 `ents.length`**。 */
		"data-notice-merged": "1", "data-fold-count": String(ents.length), "data-fold-state": expanded ? "expand" : "fold",
			"data-fold-key": stateKey,
			title: expanded ? "点击收起" : (ents.length + " 张通知卡 · 点击展开"),
			onClick: function () { nsFoldExpandedSet(stateKey, !expanded); setTick(function (v) { return v + 1; }); },
			style: { display: "flex", flexDirection: "column", cursor: "pointer" }
		}, edges, body, countSign);
	}
		var NoticeBannerView = React.memo(function NoticeBannerView(props) {
			var node = props.node;
			var banner = node && node.data;
			// P1-2: store 锚点节点（`data.__storeKeys`）—— 单节点渲染该锚点上的 store 条目栈
			//   （每条复用同一卡片组件 ⇒ 单卡外观零变化）；订阅 store 快照 ⇒ 条目更新/到达即重渲染。
			var isStoreAnchor = !!(banner && banner.__storeWatch != null);
			var storeRing = React.useState(0);
			// ★批14（2026-10-17）：未定位区「整组收起/展开」的重渲染触发器（用户逐字
			//   「这些找不到的卡片本身也是一个特殊组 也要能折叠 不然太占地方了」＋
			//   「默认就是折叠展示的 不用展开 但是每张卡片不能丢失 展开后不能遮挡残缺」）。
			var upRing = React.useState(0);
			// ★批15（`#77`）：未定位区**计数与渲染同源** —— 订阅 compat 卡本体发布的同一份 status 快照
			//   （无 compat 卡在场上 ⇒ null ⇒ 判据不挡任何条目；机制与「同一处判据」见 `nsCardDropped()`）。
			var upCompatPub = nsCompatPubUse();
			React.useEffect(function () {
				if (!isStoreAnchor) return undefined;
				// obs#3 修法②（#A60 一 (b1)/(b2)）：**已挂载组件自报锚点** ⇒ 即使 `anchorList` 被清/被回退重置清掉，
				//   只要节点还挂在页面上，条目就能重挂到它上面 ⇒ **卡片不再需要"宿主回放"才出现**（不消失优先）。
				storeNoteAnchorNode(banner.__storeWatch, null);
				// obs#3 段R ②（D2 ①）：**已挂载渲染**登记（本组件确实把卡片渲染上了）—— 故障注入 `od-hide` 隐藏者**不登记**。
				if (!odHideMap()[String(banner.__storeWatch)]) storeNoteAnchorMounted(banner.__storeWatch);
				// ★`#A72` 步1：**当前挂载**登记 ＋ 尾锚点迁移时唤醒同侪（否则块换节点后旧节点仍画、新节点不画）
				var __wseq = banner.__storeWatch;
				var __tailBefore = nsTailRender().seq;
				if (!odHideMap()[String(__wseq)]) storeAnchorLiveAdd(__wseq);
				if (nsTailRender().seq !== __tailBefore) { try { notifyStore(); } catch (eL) { /* 忽略 */ } }
				var un = subscribeStore(function () { storeRing[1](function (n) { return (n + 1) % 1000000; }); });
				odKeepAliveEnsure();   // 段R C2：有锚点订阅了 ⇒ 立刻摘掉"保活订阅"（订阅数 = max(1, 锚点数)）
				return function () {
					try { un(); } catch (e0) { /* 忽略 */ }
					var __t0 = nsTailRender().seq;
					if (!odHideMap()[String(__wseq)]) storeAnchorLiveDel(__wseq);
					if (nsTailRender().seq !== __t0) { try { notifyStore(); } catch (eL2) { /* 忽略 */ } }
					odKeepAliveEnsure();
				};
			}, [isStoreAnchor, node && node.key]);
			// ★ obs3S7 段W-2a T2-b 件D：**渲染回报**（设计稿 §5.2/§11「每次渲染后追加一条」）。
			//   只在**尾锚点**报一次（与 PEND/未定位行的落点同源 ⇒ 每会话每趟恰一条），**≥5s 节流**（不刷屏、
			//   不放大请求）；回报内容 = 应渲染 `expect` / 实渲染 `actual` / 未定位 `unplaced` / 本节点卡数 `cards`。
			//   ⚠️ 回报失败**绝不影响渲染**（try/catch + 不 throw）。
			// ★ `#A250` 四（T11 判别位"修过头"的**修法 (a)**）：**只把"真实卸载 / 会话切走 / 整页离开"当成"正常缺席"**。
			//   旧实现把补发写在回报 effect 的 cleanup 里，而该 effect 的依赖含 `reportTick`（**每次 store 快照变化都变**）
			//   ⇒ cleanup 每 ~10s 跑一次 ⇒ 成对上报 `visible:false→true` ⇒ B 侧 `prev.visible === true` **恒假**
			//   （看门狗从"误报"退化成"永不报"；第 22 次部署 ⑨ 正向臂实测不可达即此）。
			//   修法：① 本 effect **只在锚点建立时挂一次**（deps = 锚点身份），其 cleanup 仅在**组件真卸载/切走**时跑
			//   （声明顺序上先于回报 effect 的 cleanup ⇒ 标记先置位）② `pagehide`（整页离开：重载/关闭）**直接补发**
			//   ③ 回报 effect 的 cleanup 仅当"标记已置位 **或** 会话已切换"时才补发 ⇒ **依赖变化的 re-run 不再补发**。
			//   ⚠️ **不变量（`#A251` 三 追加要求 (i)：本实现依赖 cleanup 的声明顺序）** ——
			//   **本 effect 必须声明在下面的「回报 effect」之前**：卸载时 React 按声明顺序跑 cleanup，
			//   先跑本 effect 的 cleanup（`storeGoneRef.current = true`）⇒ 回报 effect 的 cleanup 才能读到"真卸载"。
			//   **若两者顺序被调换 ⇒ 标记恒为 false ⇒ 看门狗"永不报"（不崩、只静默失效）**
			//   ⇒ 已由 harness `w2b-t11-verdicts.mjs` 的 **T11g 静态判据**机械看住（重排 ⇒ **必红**）。
			var storeGoneRef = React.useRef(false);
			React.useEffect(function () {
				storeGoneRef.current = false;   // 重新建立（cleanup 先跑、本行后跑 ⇒ 顺序正确）
				if (!isStoreAnchor) return undefined;
				var onHide = function () {
					try {
						var lp0 = storeState.spatial.lastPayload;
						if (lp0 && lp0.visible !== false && storeState.sessionId) {
							storeReportRender({ expect: lp0.expect, actual: lp0.actual, unplaced: lp0.unplaced, unplacedRenderable: lp0.unplacedRenderable, cards: lp0.cards, cardsPanel: lp0.cardsPanel, visible: false, kindPanel: lp0.kindPanel, kindFolded: lp0.kindFolded, kindUnshown: lp0.kindUnshown }, storeState.sessionId);
						}
					} catch (e0) { /* 整页离开补发绝不影响渲染 */ }
				};
				try { window.addEventListener("pagehide", onHide); } catch (e1) { /* 忽略 */ }
				return function () {
					storeGoneRef.current = true;
					try { window.removeEventListener("pagehide", onHide); } catch (e2) { /* 忽略 */ }
				};
			}, [isStoreAnchor, banner && banner.__storeWatch]);
			var reportTick = storeRing[0];
			React.useEffect(function () {
				if (!isStoreAnchor) return undefined;
				// ★ `#A248` 四：**卸载补发**用"效果建立时"的会话 id（卸载瞬间 `storeState.sessionId` 可能已被切到新会话）
				var sidAtEffect = storeState.sessionId;
				try {
					if (!storeSpatialOn() || storeState.spatial.on !== true) return undefined;
					var UL = storeAnchorUniverse();
					if (!UL.length || UL[UL.length - 1].seq !== banner.__storeWatch) return undefined;   // 非尾锚点 ⇒ 不报
					var ai = storeAlignAll();
					var sp = storeState.spatial;
					var now = Date.now();
					if (sp.lastReportAt && (now - sp.lastReportAt) < 5000) { sp.reportSkipped += 1; return undefined; }
					sp.lastReportAt = now;
					// ★ T3 / 仲裁 `#A214` 四(i)(ii)：**"应实不符 / 未定位"判定限定在当前窗口** ——
					//   窗口外历史卡（`ai.pending`；用户 2026-09-17 裁定为**预期行为**，台账 `#34`）**不计入** `expect`，
					//   否则 `expect` 含窗口外历史卡 ⇒ `result` 恒 `mismatch` ⇒ 降级信号恒亮（"狼来了"）＝信号作废。
					//   ⇒ `expect` = 本窗口**应渲染**数；`actual` = 实渲染到行的数（= expect − 未定位）。
					var inWindow = storeState.keys.length - ai.pending;
					var expect = inWindow < 0 ? 0 : inWindow;
					var unplacedN = ai.unplacedKeys.length;
					// ★批16（`#78`；用户裁「以可渲染为准、服务端同批跟」）：**上屏唯一口径 ＝ 可渲染数**。
					//   `unplacedN`（对齐侧）**保持原义且不改名**（供 B 侧对账；`只登记不判改`）；
					//   **新增** `unplacedRenderable` ＝ 本会话"实际可渲染的未定位张数" —— 取值**只来自**
					//   `storeState.spatial.upNRenderable`（＝本帧未定位区头行 `upN`，由 `nsUnplacedRenderable()`
					//   这一处过滤算出）⇒ **判据只写一遍**（`#77` 的成因正是"两处各算一次"）。
					//   取不到（面板未渲染/非尾锚点）⇒ `null` ⇒ 下游**回退老口径**（不编造 0）。
					var unplacedRenderableN = (Number.isFinite(storeState.spatial.upNRenderable) && storeState.spatial.upNRenderableSid === (storeState.sessionId || null)) ? storeState.spatial.upNRenderable : null;
					// ★批16（`#78`）：`actual` 也按**可渲染口径**派生 —— 否则"被渲染判据挡掉的卡"仍会让
					//   `expect ≠ actual` ⇒ `result:"mismatch"` ⇒ **降级门照样点亮**（只改计数不改门＝假绿）。
					//   有可渲染数 ⇒ 用它；没有（老服务端/未渲染）⇒ 退回对齐口径（与装前逐字一致）。
					var actual = expect - (unplacedRenderableN !== null ? unplacedRenderableN : unplacedN);
					// ★ T11：`cardsPanel` = **面板内可见卡节点数**（DOM 口径；与 `cards`（尾锚点单节点）**不同名不同义**）；
					//   `visible` = **判别位**（页面是否可见/mounted）——**取不到 ⇒ `null`**（B 侧**不判**，防把"用户切走"报成故障）。
					var cardsPanel = null, visible = null;
					// ★ 批4 `#37`（范围「乙」）：三个**只观测**新键（`kindPanel`／`kindFolded`／`kindUnshown`）。
					//   **缺省（此处抛错 / 取不到）⇒ 全 `null`** ⇒ 下游 `store.js` **不写键**（同 T11 口径）。
					var _kb = null, kindPanel = null, kindFolded = null, kindUnshown = null;
					try {
						_kb = kindBucketsInit();
						var els = document.querySelectorAll("[data-notice-banner]");
						var n = 0;
						for (var ci = 0; ci < els.length; ci++) {
							var el = els[ci], anc = el, hid = false;
							while (anc && anc.nodeType === 1) { if (anc.hasAttribute("hidden")) { hid = true; break; } anc = anc.parentElement; }
							kindBucketOf(_kb, el, hid);   /* ★ #37：同一 `el`、同一 `hid`；下一行的谓词与 `kindBucketOf` 内部逐字同式 */
							if (!hid && el.getClientRects().length > 0) n += 1;
						}
						cardsPanel = n;
						kindPanel = _kb.kp; kindFolded = _kb.kf; kindUnshown = _kb.ku;
					} catch (e0) { cardsPanel = null; kindPanel = null; kindFolded = null; kindUnshown = null; }
					try { visible = document.visibilityState === "visible"; } catch (e1) { visible = null; }
					// ★ `#A63` ①（前置修复；用户已裁）：**`counters` 由调用点传入**（此处 `ai` = 对齐结果，四个计数已在手）
					//   ⇒ 不再依赖 `storeReportRender()` 内部现算（内部现算仅作兜底）⇒ 保证"带 `counters` 的 `RENDER` 必被写出"。
					storeReportRender({ expect: expect, actual: actual < 0 ? 0 : actual, unplaced: unplacedN, unplacedRenderable: unplacedRenderableN, cards: ai.byAnchor[banner.__storeWatch] ? ai.byAnchor[banner.__storeWatch].length : 0, cardsPanel: cardsPanel, visible: visible, counters: { pending: ai.pending, pendingNoNode: ai.pendingNoNode, slotIdHit: ai.slotIdHit, newRulesPending: ai.newRulesPending }, kindPanel: kindPanel, kindFolded: kindFolded, kindUnshown: kindUnshown });				} catch (e) { /* 忽略 */ }
				// ★ `#A248` 四（T11 判别位收紧）：**面板卸载 ⇒ 补发一次 `visible:false`**。
				//   现状（`visible` 只取 `document.visibilityState`）无法区分"用户切走"与"面板挂载中却停止上报"
				//   ⇒ 实测两会话（仲裁 / 执行）各 3 条 `render-stale` **误报**。补发后 B 侧"上一次也是挂载且可见"
				//   条件不成立 ⇒ 不再把离开期间的空档读成静默。**sid 取效果建立时捕获值**（卸载瞬间 `storeState.sessionId`
				//   可能已被切到新会话 ⇒ 不能现取）。
				return function () {
					try {
						var lp = storeState.spatial.lastPayload;
						// ★ `#A250` 四 **修法 (a)**：只在"**真卸载 / 会话切走**"时补发 —— 依赖变化（`reportTick` 每趟快照都变）
						//   触发的 cleanup **不再补发**（否则成对 `false→true` ⇒ B 侧 `prev.visible === true` 恒假 ⇒ 看门狗永不报）。
						var sidNow = storeState.sessionId;
						if (sidAtEffect && lp && lp.visible !== false && (storeGoneRef.current === true || sidNow !== sidAtEffect)) {
							storeReportRender({ expect: lp.expect, actual: lp.actual, unplaced: lp.unplaced, unplacedRenderable: lp.unplacedRenderable, cards: lp.cards, cardsPanel: lp.cardsPanel, visible: false, kindPanel: lp.kindPanel, kindFolded: lp.kindFolded, kindUnshown: lp.kindUnshown }, sidAtEffect);
						}
					} catch (e) { /* 卸载回报绝不影响渲染 */ }
				};
			}, [isStoreAnchor, banner && banner.__storeWatch, reportTick]);
			if (isStoreAnchor) {
				// obs#3 段R ④ 注入：`dsh-notice-od-hide="<seq,…>"` ⇒ **节点仍建、但不渲染**（造 D2 ① 态正控；缺省空 ⇒ inert）
				if (odHideMap()[String(banner.__storeWatch)]) return null;
				var watchKeys = storeKeysForAnchor(banner.__storeWatch);
				var stack = [];
				for (var si = 0; si < watchKeys.length; si++) {
					var se = storeState.byKey[watchKeys[si]];
					if (se) stack.push(se); // 缺失/被丢弃 ⇒ 只少这一张（per-emitter 隔离）
				}
				// obs#3 段I（#A77 三/五）：**无载体**（回合未挂载在本页）的条目在**尾锚点**渲染一行如实标注
				//   （N 与 `state().pendingCount` 同源 = 同一 `storeAlignAll()` ⇒ 恒相等；不刷屏、不改卡片外观）
				var alignInfo = storeAlignAll();
				// ★`#A72` 步1：尾锚点判定改**两臂**（宇宙尾已挂载 ⇒ universe；未挂载 ⇒ 已挂载最大 seq 兜底）
				//   ⇒ 回合结束后"宿主新锚点无 banner 载体"不再让整块消失。旧实现见 git 历史/A72 证据。
				var tailInfo = nsTailRender();
				var isUniverseTail = tailInfo.seq !== null && tailInfo.seq === banner.__storeWatch;
				var tailArm = tailInfo.arm;
				// ★ `#A265` 件 B(a)：**PEND 提示行默认隐藏** —— 仅当 `localStorage["dsh-notice-debug"]==="1"`
				//   （复用既有 `noticeDebugOn()`）时渲染。理由（用户拍板）：该行属**诊断**信息、非用户需要；
				//   **零新增设置项**（复用既有 debug 开关）⇒ 不触发 UI 流程。锚点 `data-notice-pending` 与文本**一字未改**。
				var pendingHint = null;
				if (isUniverseTail && alignInfo.pending > 0 && noticeDebugOn()) {
					pendingHint = React.createElement("div", { style: { fontSize: 11, opacity: 0.65, padding: "0 4px" }, "data-notice-pending": String(alignInfo.pending) },
						"另有 " + alignInfo.pending + " 张历史卡 · 点「Load earlier」载入更早回合后原位显示");
				}
				// ★ obs3S7 段W-2a T2-b 件D：**未定位区**（设计稿 §5.3）—— ② 判为未定位的卡
				//   **不落到任何行**（废除"就近落"，计划 v5 §6 裁决 #7），统一在**尾锚点**下用带标题的区块
				//   如实渲染（**不静默消失**：未定位 > 0 必须能看见），理由码随标题标注。
				var unplacedStack = [];
				var unplacedHint = null;
				var upKey = "", upExpanded = false, upSign = null, upHead = null;   /* ★批14 未定位区整组折叠态 */
				/* ★批15（`#77`；用户逐字「卡片展开只有8张 是不是那个不显示的卡也算进去了？」）：**先过滤再计数** ——
				   ① 过滤用的判据 = `nsCardDropped()`（与卡本体 `return null` **同一函数**）；
				   ② 头行 N / `data-notice-unplaced` / `data-merged-count` / 折叠签文案 / 渲染映射 **全部取 `upList`**
				   （**同一数组 ＝ 单一出处**）；③ **禁再读** `alignInfo.unplacedKeys.length` 或 `store.counters.unplaced`
				   当本区计数（旧写法正是 `#77` 的成因：对齐侧算一次、渲染侧再滤一次 ⇒ 两处各算）。 */
				var upList = [];
				var upN = 0;
				if (isUniverseTail) {
					for (var ui = 0; ui < alignInfo.unplacedKeys.length; ui++) {
						var ue = storeState.byKey[alignInfo.unplacedKeys[ui]];
						if (ue) unplacedStack.push(ue);   // 缺失/被丢弃 ⇒ 只少这一张（per-emitter 隔离）
					}
					upList = nsUnplacedRenderable(unplacedStack, upCompatPub);   /* ★批15：同判据过滤（唯一出处） */
					upN = upList.length;
					// ★批16（`#78`）：**把这一个数交给上报口**（`RENDER.unplacedRenderable`）——
					//   本行是"可渲染未定位数"的**唯一计算点**；上报 effect 只搬运、不重算 ⇒ 头行／
					//   会话汇总卡那行／降级门／降级行四处**同源同值**。取不到 compat 快照时
					//   `nsUnplacedRenderable` 仍是 fail-open（不过滤）⇒ 与老口径一致，不静默归零。
					try { storeState.spatial.upNRenderable = upN; storeState.spatial.upNRenderableSid = storeState.sessionId || null; } catch (eUp) { /* 忽略 */ }
				}
				if (isUniverseTail && upN) {
					// ★ `#A264` 文案定稿（**用户已定，逐字**）：`⚠ N 张卡找不到行落点 · no-anchor`
					//   ⚠️ 锚点 `data-notice-unplaced`（= 键数）**不变**；本改动**只改文本**（不动属性、不加样式）。
					unplacedHint = React.createElement("div", { style: { fontSize: 11, opacity: 0.75, padding: "0 4px" }, "data-notice-unplaced": String(upN) },
						"⚠ " + upN + " 张卡找不到行落点 · no-anchor");
					// ★批14（2026-10-17；仲裁 `#A642` Q4/Q5 裁 ＋ 用户逐字「默认就是折叠展示的 不用展开 但是
					//   每张卡片不能丢失 展开后不能遮挡残缺」）：**未定位区整组默认收起** —— 收起只渲染一行头，
					//   展开后**平铺全部 N 张（每张完整、不被裁切）**。
					//   ★批15（`#77`）：N ＝ `upN`（**同源过滤后**数组长度；见 `nsUnplacedRenderable()`），**不再**读对齐侧键数。
					//   硬口径（逐条遵守）：① `data-notice-unplaced`（计数锚点，上一行）**属性与文案一字不动**；
					//   ② 容器锚点 `data-notice-unplaced-block` **一字不动**；③ **零新 CSS 类名 / 零新 i18n 键 / 零新
					//   `localStorage` 键**（展开态复用模块级 `nsFoldExpandedGet/Set` 的 Map，与合成卡同机制）；
					//   ④ `nsNoFold`／命令·费用族豁免**一行不动** —— 本改动只改"默认是否展开"，不改"谁可以折叠"；
					//   ⑤ 状态属性复用既有 `data-fold-state`（合成卡同款），供机械判据读"fold/expand"。
					upKey = "unplaced#" + String(storeState.sessionId || "") + "#" + String(banner.__storeWatch);
					upExpanded = nsFoldExpandedGet(upKey);
					upSign = React.createElement("span", {
						className: "dsh-merged-count", "data-merged-count-badge": "1", "data-merged-count": String(upN),
						style: NS_COUNT_SIGN
					}, "共 " + upN + " 张 · " + (upExpanded ? "点击收起" : "点击展开"));
					upHead = React.createElement("div", {
						"data-fold-state": upExpanded ? "expand" : "fold",
						"data-fold-key": upKey,
						title: upExpanded ? "点击收起" : (upN + " 张未定位卡 · 点击展开"),
						onClick: function () { nsFoldExpandedSet(upKey, !upExpanded); upRing[1](function (v) { return v + 1; }); },
						style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, cursor: "pointer" }
					}, unplacedHint, upSign);
				}
				// obs#3 段M（#A83 四）：**必须先算 hint 再判空气态** —— 原顺序在 `degradeHint` 赋值之前就用它
				//   （`var` 提升 ⇒ 该处恒 `undefined`）⇒ **无卡锚点会吞掉降级行**。
				// obs#3 段R ②（D1/D2/D3，用户 2026-09-17 口径 + 台账 #34）：**提示只覆盖真异常两态** ——
				//   `odAnomaly()` 给出 `stale-unrendered` / `pending-mismatch`（可机械判定）；**`overLimit>0` 不产生提示**；
				//   正常态**只留中性 PEND 行**（本行**不含「降级」字样**、且**不复述** PEND 行已有的"窗口外历史卡"内容 = 语义去重）。
				//   `fetch-failed`（连续取数失败）保留如实上报（属「该加载时不加载」家族；红线 6② 禁"报 OK 而功能坏"）。
				var degradeHint = null;
				try {
					var anomaly = odAnomaly(alignInfo);
					if (!anomaly && storeRenderState.degradeReason === "fetch-failed") anomaly = "fetch-failed";
					if (anomaly && isUniverseTail) {
						degradeHint = React.createElement("div", { style: { fontSize: 11, opacity: 0.65, padding: "0 4px" }, "data-notice-degrade": String(anomaly) },
							OD_ANOMALY_TEXT[anomaly] || ("⚠ 卡片渲染异常（" + anomaly + "）"));
					}
				} catch (e2) { degradeHint = null; }
				// ★ obs3S7 段W-2b `(a)(b)`：**状态卡区块** —— 文档序 = 卡片 → **未定位区** → **状态卡区块**
				//   （`#A229` 五 F4②：未定位区是"应实不符"的即时证据，优先级更高 ⇒ 在前）。
				//   §1.5 开关**只过滤 `kind:"alert"`**（`"degrade"` / `"session"` 一律显示）。
				var stateCardsShown = [];
				if (isUniverseTail) {
					var scAll = storeStateCards();
					var scMode = storeStateCardMode();
					for (var sck = 0; sck < scAll.length; sck++) {
						var scc = scAll[sck];
						if (!scc || typeof scc !== "object") continue;
						// §1.5 开关**落地口径（本行注释即口径，理由随附）**：`"session"` 模式 ⇒ **只隐藏「全局聚合」行**
						//   （`kind:"alert"` 且 `scope !== "session"`）；**本会话的告警条目照常显示**（= 面板标签"只看本会话"
						//   的字面语义）；`degrade` / `session` 两类**一律显示**（F2：不受开关影响）。
						//   ⇒ 判据 3（默认 `"global"` ⇒ 非出事会话也看得见计数；关开关后仍显示全局 ⇒ 必红）成立。
						if (String(scc.kind) === "alert" && String(scc.scope) !== "session" && scMode === "session") continue;
						stateCardsShown.push(scc);
					}
				}
				var __ownerN = residentOwner();
				var stateCardBlock = (__ownerN.kind === "node" && __ownerN.seq === banner.__storeWatch) ? stateCardBlockEl(stateCardsShown, "resident", null) : null;
				var nsHasBody = !!(stack.length || upN || pendingHint || degradeHint || unplacedHint || stateCardBlock);   /* ★批15：`#77` ⇒ `upN`（同源） */
				if (!nsHasBody) return null; // 渲染空气（R8；宿主对空 flowItem 不占布局）
				// T2-b 件D：**未定位区**（标题 + 卡片本体；`data-notice-unplaced` = 计数锚点、
				//   `data-notice-unplaced-block` = 区块容器锚点 ⇒ 两者都是**机器判据锚点**）—— 属性与文案**一字未改**
				var nsUnplacedBlock = (unplacedHint || upN) ? React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 8 }, "data-notice-unplaced-block": "1", "data-notice-tail": String(tailArm || "none") },
					upHead || unplacedHint,
					// ★批14：**默认收起 ⇒ 卡片一条都不渲染**（不丢失：展开即全量平铺；计数恒可见 ⇒ 不静默）
					upExpanded ? upList.map(function (ent, idx) {
						return React.createElement(NoticeBannerView, {
							key: String(banner.__storeWatch) + "#u" + idx + "#" + (ent.kind || ""),
							node: { key: (node && node.key ? String(node.key) : "") + "#u" + idx, id: node && node.id, kind: "notice-banner", data: ent },
							t: props.t
						});
					}) : null
				) : null;
				// ★甲1 §2.1：**折叠合成卡** —— "可折叠族 ≥2 张"时把多张合成 1 张；
				//   命令·费用族（`nsNoFold`）**不参与合成**，保持独立完整渲染（**不被带值裁**）。
				//   ★修3（2026-10-13）：**判定与"尾锚资格"解耦** —— 旧条件 `isUniverseTail && stack.length >= 2`
				//   使**非尾栈永不合并**（与修2(a) 同根）⇒ 同一批卡"有时折叠、有时全展"（段1 §C-1 对撞）。
				var nsMerged = null, nsCards = stack, nsFoldN = 0;
				var nsPlan = nsFoldPlan(stack);
				if (nsPlan.merged) {
					nsFoldN = nsPlan.fold.length;
					nsMerged = React.createElement(NoticeMergedCard, {
						key: String(banner.__storeWatch) + "#merged", ents: nsPlan.fold,
						stateKey: nsFoldStateKey(storeState.sessionId, banner.__storeWatch),   /* ★修4①：状态键＝会话#锚点（不随卸载丢） */
						nodeKey: (node && node.key ? String(node.key) : ""), nodeId: node && node.id, t: props.t
					});
					nsCards = nsPlan.keep;
				}
				// 文档序（obs#3 段M `#A83` 三）：**卡片（合成卡在首）→ 未定位区 → 状态卡区块 → PEND → DEG**
				var nsCardsKeys = nsEntryKeysOf(nsCards);   /* ★修4②：普通路径同用稳定身份 key（原为 `"#"+idx`） */
				var nsChildren = [nsMerged].concat(nsCards.map(function (ent, idx) {
					return React.createElement(NoticeBannerView, {
						key: String(banner.__storeWatch) + "#" + (nsCardsKeys[idx] || ("c" + idx)),
						node: { key: (node && node.key ? String(node.key) : "") + "#" + (nsCardsKeys[idx] || ("c" + idx)), id: node && node.id, kind: "notice-banner", data: ent },
						t: props.t
					});
				})).concat([nsUnplacedBlock, stateCardBlock, pendingHint, degradeHint]);
				/* ★notice-scroll **步 2**（2026-10-11 用户签字「豁免（附四条硬约束）」）：**浮层与留白带已删**
				   ⇒ 尾锚与非尾锚**同一 in-flow 结构**；贴底位改由**中间件补滚**在渲染完成后补一次。 */
				var nsTailGrew = false;
				try {
					var kk = String(banner.__storeWatch == null ? "" : banner.__storeWatch);
					var pv = (nsSeamPrevN[kk] === undefined) ? -1 : nsSeamPrevN[kk];
					nsTailGrew = isUniverseTail && pv >= 0 && nsCards.length + (nsMerged ? 1 : 0) > pv;
				} catch (eG) { nsTailGrew = false; }
				/* ★修2(a)（2026-10-13）：**非尾栈同样触发补滚** —— `isTail` 只作日志字段传入；
				   旧实现把"是否尾锚"当闸门 ⇒ 插卡落非尾栈时一次都不补滚（段1 §A-2）。 */
				nsCallScrollSeam(isUniverseTail, stack.length, banner.__storeWatch);   /* ★唯一调用点（契约 §4.11） */
				return React.createElement("div", { "data-notice-stack": "1", style: { display: "flex", flexDirection: "column", gap: 8 } }, nsChildren);
			}
			if (!banner || typeof banner !== "object") return null;
			var key = node && node.key != null ? String(node.key) : (node && node.id != null ? String(node.id) : "");
			var tick = React.useState(0);
			var setTick = tick[1];
			var kind = banner.kind === "cost" ? "cost" : banner.kind === "queue" ? "queue" : banner.kind === "balance" ? "balance" : banner.kind === "error" ? "error" : banner.kind === "ledger" ? "ledger" : banner.kind === "costs" ? "costs" : banner.kind === "status" ? "status" : banner.kind === "restart" ? "restart" : banner.kind === "compat" ? "compat" : "notify";
			// ★ obs3S7 段 2b-G1-a 件2②（T15；仲裁 `#A15` 已批）：**逐卡身份暴露到 DOM** —— **纯属性、零外观/位置改动**。
			//   值 = 发射侧给的 `banner.cardId`（`banner-kit` 已声明的可选契约键，32 hex / 小写；**不新增契约键**）；
			//   发射侧未给（现网仅 `dsh-cost-guard` 一家在写）⇒ **空串** —— 属性**仍在位**，故探针可机械判别
			//   "属性在位 vs 缺失"（正控：撤掉本属性 ⇒ 探针必红）；非空覆盖率由探针**如实申报**，不得当缺陷掩盖。
			var noticeCardIdAttr = (typeof banner.cardId === "string" && banner.cardId) ? banner.cardId : "";
			// v0.11.4 (阶段 1 · B1): 适配状态横幅 (kind=compat, 契约 §8) —— 两档 severity 走两套家族色
			//   (degraded = cost 琥珀 / blocked = error 红), 故 PALETTE 查表按 severity 选键;
			//   data-family 仍是 "compat" (家族标记), 浅色主题着色用 data-severity 区分 (见 INJECTED_CSS)。
			var compatSeverity = kind === "compat" && banner.severity === "blocked" ? "blocked" : "degraded";
			var compatState = React.useState({ phase: "idle", hostVersion: "", signature: "", globalState: "", error: null });
			var compat = compatState[0];
			var setCompat = compatState[1];
			// ★批15（`#77`）：**发布本卡 status 快照**给未定位区（尾锚点）⇒ 计数与渲染**读同一份判据输入**、
			//   不再"对齐侧算一次、渲染侧再滤一次"。发布是纯内存广播（零请求、零新键；订阅者异常被吞）。
			React.useEffect(function () {
				if (kind !== "compat") return undefined;
				if (compat.phase === "idle" && !compat.globalState) return undefined;   /* 初始空态不覆盖共享快照 */
				nsCompatPublish(compat);
				return undefined;
			}, [kind, compat]);
			// 挂载即向 /host-compat/status 拉**一次** (零 token, 无轮询/无定时器):
			//   ① 取当前 hostVersion + capabilitySignature (RD-14 追加字段) 供「本版本不再提示」回传;
			//   ② 若 §5 dismiss 记录与当前 (hostVersion + capabilitySignature) **一致** ⇒ 本横幅已是
			//      「用户已关闭」的那个版本 (页面刷新后会从会话事件里重放), 本地直接降级为「已关闭」占位。
			//   kind !== "compat" 的家族一律不受影响 (D11: 不动既有渲染路径)。
			React.useEffect(function () {
				if (kind !== "compat") return undefined;
				var alive = true;
				compatRpc("status", {}).then(function (res) {
					if (!alive) return;
					if (!res || res.ok !== true || !res.value || typeof res.value !== "object") return; // 失败: 保持原样, 不报错
					var v = res.value;
					var hv = v.host && v.host.version ? String(v.host.version) : "";
					var sig = typeof v.capabilitySignature === "string" ? v.capabilitySignature : "";
					var d = v.dismiss && typeof v.dismiss === "object" ? v.dismiss : null;
					var off = !!(d && String(d.hostVersion || "") === hv && String(d.capabilitySignature || "") === sig);
					// ★批14（2026-10-17；仲裁 `#A642` Q1 裁）：**同时记住全域 `state`** —— 用于"全 OK 不渲染"判据
					//   （`status.value.state` 是契约 §5 既有键，`:224` 现读在位 ⇒ **零新键、零新请求**）。
					var gs = (typeof v.state === "string") ? v.state : "";
					setCompat(function (prev) {
						return { phase: off ? "done" : prev.phase === "busy" ? "busy" : "idle", hostVersion: hv, signature: sig, globalState: gs, error: prev.error };
					});
				});
				return function () { alive = false; };
			}, [key, kind]);
			/** §8「本版本不再提示」: 先 status 取当前签名 (RD-14) → 再 dismiss 写回 §5 dismiss */
			var dismissCompat = function () {
				if (compat.phase === "busy" || compat.phase === "done") return;
				setCompat(function (prev) { return { phase: "busy", hostVersion: prev.hostVersion, signature: prev.signature, globalState: prev.globalState || "", error: null }; });
				compatRpc("status", {}).then(function (res) {
					if (!res || res.ok !== true || !res.value || typeof res.value !== "object") {
						var e1 = (res && res.error) || {};
						setCompat(function (prev) {
							return { phase: "error", hostVersion: prev.hostVersion, signature: prev.signature, globalState: prev.globalState || "", error: String(e1.code || "unknown") + "：" + String(e1.message || "读取适配状态失败") };
						});
						return;
					}
					var v = res.value;
					var hostVersion = v.host && v.host.version ? String(v.host.version) : "";
					// RD-14: 当前签名取 status 的追加字段; **缺失 ⇒ 空串**(服务端用当前签名兜底), 不抛不报错
					var sig = typeof v.capabilitySignature === "string" ? v.capabilitySignature : "";
					compatRpc("dismiss", { hostVersion: hostVersion, capabilitySignature: sig }).then(function (res2) {
						if (res2 && res2.ok === true) {
							setCompat({ phase: "done", hostVersion: hostVersion, signature: sig, globalState: (compat && compat.globalState) || "", error: null });
							return;
						}
						var e2 = (res2 && res2.error) || {};
						setCompat(function (prev) {
							return { phase: "error", hostVersion: hostVersion, signature: sig, globalState: prev.globalState || "", error: String(e2.code || "unknown") + "：" + String(e2.message || "记录失败") };
						});
					});
				});
			};
			// v0.6.0: ledger 会话账本默认折叠 (节省空间, 多张卡不刷屏);
			// v0.6.2: costs 多会话费用 (dsh-sessions-cost) 同样默认折叠 (明细行多, 一行只露窗口合计);
			// v0.6.3: costs 展开态 = SessionCostList 手风琴 (每会话一行可展开, 每类型一行明细, 不省略, 可滚动)
			// 用户手动展开 (map=false) 后保持展开, 再次点击折叠 (map=true)
			var defaultCollapse = kind === "ledger" || (kind === "costs");
			var collapsed = key !== "" && (defaultCollapse ? collapseByKey.get(key) !== false : collapseByKey.get(key) === true);
			// 队列横幅 (kind=queue) 的可编辑面板开关 (v0.4.0): 内嵌实时任务队列,
			// 排队任务可编辑/取消/立即派发, 已派发只读。
			// v0.5.1: banner.openPanel===true (queue_list 注入) → 横幅出现即展开手风琴面板
			var panelState = React.useState(banner && banner.openPanel === true);
			var panelOpen = panelState[0];
			var setPanelOpen = panelState[1];
			var fam = nsFamOf(banner);
			var p = PALETTE[kind === "compat" ? (compatSeverity === "blocked" ? "compatBlocked" : "compatDegraded") : fam];
			var badge = BADGES[fam] || "通知";
			if (kind === "balance") {
				var _vv = banner.variant || banner.mode; badge = _vv === "detail" ? "余额明细" : _vv === "session" ? "会话费用" : _vv === "stats" ? "参数统计" : _vv === "test" ? "计算验证" : "余额";
			}
			// compat 两档不同图标 (degraded 🧩 / blocked ⛔, 用户 D5 裁定); 其余家族照旧
			var icon = kind === "compat" ? (compatSeverity === "blocked" ? "⛔" : "🧩") : (ICONS[fam] || "");
			var meta = metaOf(banner);
			// v0.11.4: compat 的正文在 payload.body (契约 §8, 非 lines) ⇒ 归一为单行, 复用既有 lines 渲染路径
			var lines = kind === "compat"
				? (Array.isArray(banner.items) && banner.items.length > 0 ? [] : (typeof banner.body === "string" && banner.body ? [banner.body] : []))
				: (Array.isArray(banner.lines) ? banner.lines : []);
			var stats = Array.isArray(banner.stats) ? banner.stats : [];
			var kv = Array.isArray(banner.kv) ? banner.kv : [];
			var title = banner.title || "";
			var subtitle = typeof banner.subtitle === "string" && banner.subtitle ? banner.subtitle : "";
			// 折叠摘要关键值: 优先 key 标记 (结论), 否则首个 strong, 否则首个统计格值
			var keyValue = "";
			for (var si = 0; si < stats.length; si++) {
				if (stats[si].key) { keyValue = stats[si].value; break; }
			}
			if (!keyValue) {
				for (var sj = 0; sj < stats.length; sj++) {
					if (stats[sj].strong) { keyValue = stats[sj].value; break; }
				}
			}
			if (!keyValue && stats.length > 0) keyValue = stats[0].value;
			// v0.11.1 (⑭, 2026-09-06): ledger 折叠行 = 「含树合计」+ 差值 + 精简 (用户定稿样式A) —
			//   · 折叠态去副题小字 (会话id/档位/命中率 → 展开态才显示, 见下方标题行渲染);
			//   · 主数字 = 第1格「合计预估」(本会话) + 第4格「含子 agent」子树合计 (账本口径, 不双计),
			//     有树时主数字套淡青绿胶囊底 (无文字标识); 无子会话 = 仅本会话合计、无胶囊 (与旧观感一致);
			//   · 差值 = 第2格「本回合」较上次 (自身口径, 与展开第2格一致; 首次记账 "—" 不显示);
			//   数据源 = banner payload stats (服务端已含, 零 RPC); 解析失败 → 降级叶子形态。
			var ledMain = null; // { text, chip, title }
			var ledDelta = null;
			if (kind === "ledger" && stats.length > 0) {
				var treeStat2 = null;
				for (var tl = 0; tl < stats.length; tl++) { if (stats[tl].label === "含子 agent") { treeStat2 = stats[tl]; break; } }
				var ownNum2 = parseFloat(String(stats[0].value || "").replace(/[^0-9.]/g, ""));
				var chip2 = null;
				if (treeStat2 && isFinite(ownNum2)) {
					var tv2 = String(treeStat2.value || "");
					var mTree = tv2.match(/树合计\s*[+＋−-]?\s*¥?\s*([\d.]+)/);
					var mCnt = tv2.match(/(\d+)\s*个/);
					var treeNum2 = mTree ? parseFloat(mTree[1]) : NaN;
					if (isFinite(treeNum2)) {
						chip2 = {
							sumText: "¥" + (Math.round((ownNum2 + treeNum2) * 100) / 100).toFixed(2),
							count: mCnt ? mCnt[1] : "N",
							ownText: "¥" + ownNum2.toFixed(2),
							treeText: "¥" + treeNum2.toFixed(2)
						};
					}
				}
				if (chip2) {
					ledMain = { text: chip2.sumText, chip: true, title: "合计 " + chip2.sumText + " = 本会话 " + chip2.ownText + " + " + chip2.count + " 个子 agent " + chip2.treeText + "（账本口径 · 不双计）" };
				} else {
					ledMain = { text: stats[0].value || "", chip: false, title: "" };
				}
				for (var dl = 0; dl < stats.length; dl++) { if (stats[dl].label === "本回合") { ledDelta = stats[dl].value && stats[dl].value !== "—" ? stats[dl].value : null; break; } }
				if (ledDelta == null && stats.length > 1) ledDelta = stats[1].value && stats[1].value !== "—" ? stats[1].value : null;
				keyValue = ""; // ledger 折叠行走专用簇渲染 (下方 header 分支)
			}
			// ============ v0.7: cost v2 双模式 (banner.modes 存在即 v2 布局) ============
			var v2 = kind === "cost" && Array.isArray(banner.modes) && banner.modes.length >= 2;
			var v2TitleColor = v2 ? (banner.status === "A" ? "#ef4444" : banner.status === "B" ? "#22c55e" : "#b45309") : null;
			var turnsN = typeof banner.turns === "number" ? banner.turns : 5;
			var fmtMoney2 = function (n) { return typeof n === "number" ? "¥" + (Math.round(n * 100) / 100).toFixed(2) : "—"; };
			var fmtTokens2 = function (n) { return typeof n === "number" ? Math.round(n / 1000).toLocaleString("zh-CN") + "k" : "—"; };
			var modeChip = function (conclusion) {
				// v0.7.3: 淡色背景 + 深色文字 (浅色主题友好, 深色主题同样醒目)
				return conclusion === "switch"
					? { t: "切换", c: "#92400e", bg: "#fde68a", bd: "#d97706" }
					: { t: "继续", c: "#14532d", bg: "#bbf7d0", bd: "#16a34a" };
			};
			// 按钮: /handoff 仅在"建议切换"面板显示; /costguard-stats 常驻裸数据行右侧。
			// 填输入框: 官方 inputActions.setDraft 优先 (会话槽 props), DOM 兜底; 已有文字 → 开头插入 "text "。
			var inputActions = props && props.inputActions;
			var fillHandoff = function () {
				var cur = composerDraftText();
				var next = cur ? "/handoff " + cur : "/handoff";
				if (inputActions && typeof inputActions.setDraft === "function") inputActions.setDraft(next);
				else writeComposerDom(next);
				focusComposer();
			};
			// v0.8.1: 按钮改为 /costguard-test (计算验证, 与"是否切换"判断最相关); /costguard-stats 命令保留, 可手动调用
			var fillTest = function () {
				if (inputActions && typeof inputActions.setDraft === "function") inputActions.setDraft("/costguard-test");
				else writeComposerDom("/costguard-test");
				focusComposer();
			};
			var raw = banner.raw || {};
			var v2Body = v2 ? React.createElement("div", null,
				// 区域二: 双建议面板 (固定左右两列)
				React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "8px 0 6px" } },
					banner.modes.map(function (m, i) {
						var chip = modeChip(m.conclusion);
						var rows = [
							["继续 " + turnsN + " 回合", fmtMoney2(m.continue5), "strong"],
							["切换 " + turnsN + " 回合", fmtMoney2(m.switch5), ""],
							["切换可省", fmtMoney2(m.diff), "diff"]
						];
						return React.createElement("div", { key: i, className: "dsh-mode", style: { background: "var(--dsh-mode-bg)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "8px 10px", minWidth: 0, display: "flex", flexDirection: "column", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" } },
							React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: p.body, marginBottom: 4 } },
								React.createElement("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.name + (m.tag ? "（" + m.tag + "）" : "")),
								React.createElement("span", { style: { marginLeft: "auto", flex: "none", fontSize: 12, fontWeight: 700, padding: "0 10px", lineHeight: "20px", borderRadius: 10, letterSpacing: 0.3, color: chip.c, background: chip.bg, border: "1px solid " + chip.bd, boxShadow: "0 1px 6px rgba(0,0,0,0.2)", fontVariantNumeric: "tabular-nums" } }, chip.t)
							),
							rows.map(function (row, j) {
								return React.createElement("div", { key: j, style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, lineHeight: 1.75, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
									React.createElement("span", { style: { color: p.meta, flex: "none" } }, row[0]),
									React.createElement("span", { style: { fontWeight: 700, ...(row[2] === "strong" ? { color: p.accent } : row[2] === "diff" ? { color: "#b45309" } : { color: "var(--dsw-alias-label-primary, #eceff4)" }) } }, row[1])
								);
							}),
							m.conclusion === "switch"
								? React.createElement("div", { className: "dsh-hbtn", role: "button", title: "把 /handoff 填入输入框 (执行前可编辑)", onClick: fillHandoff, style: { marginTop: 5, alignSelf: "flex-end", fontSize: 11, padding: "0 10px", lineHeight: "22px", borderRadius: 8, background: "#fde68a", border: "1px solid #d97706", color: "#92400e", boxShadow: "0 1px 6px rgba(0,0,0,0.2)", cursor: "pointer", fontWeight: 700, userSelect: "none", transition: "all .2s ease" } }, "执行 /handoff")
								: null
						);
					})
				),
				// 区域三: 左下裸数据 + 右下 /costguard-stats 按钮
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 4 } },
					React.createElement("div", { style: { flex: 1, minWidth: 0, color: p.meta, fontSize: 11, lineHeight: 1.6 } },
						"当前回合 ", React.createElement("b", { style: { color: p.body, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, fmtMoney2(raw.turn)),
						" · 累计 ", React.createElement("b", { style: { color: p.body, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, fmtMoney2(raw.cum)),
						" · 上下文 ", React.createElement("b", { style: { color: p.body, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, fmtTokens2(raw.ctx)),
						" · 回合 ", React.createElement("b", { style: { color: p.body, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, raw.turns)
					),
					React.createElement("span", { className: "dsh-sbtn", role: "button", title: "查看 cost-guard 计算验证", onClick: fillTest, style: { flex: "none", fontSize: 11, padding: "0 10px", lineHeight: "22px", borderRadius: 8, background: "#fde68a", border: "1px solid #d97706", color: "#92400e", boxShadow: "0 1px 6px rgba(0,0,0,0.2)", cursor: "pointer", fontWeight: 700, userSelect: "none", transition: "all .2s ease" } }, "/costguard-test")
				),
				// 底部辅助说明 (仅状态 C)
				banner.helper
					? React.createElement("div", { style: { marginTop: 6, color: "#b45309", fontSize: 12, lineHeight: 1.6, borderTop: "1px dashed rgba(245,158,11,0.25)", paddingTop: 5 } }, banner.helper)
					: null
			) : null;
			var toggle = function () {
				if (key === "") return;
				collapseByKey.set(key, !(collapseByKey.get(key) === true));
				setTick(function (v) { return v + 1; });
			};
			// v0.8.1: 状态迷你行 (kind=status, cost-guard "费用计算中…" 气泡) — 仿 think/bash 灰色小字,
			// running 态 ⟳ 旋转 + 扫光; ok 态 ✓; 无卡片样式/不可折叠, 仅一行小字。
			/* ★2026-10-14：**渲染分派点也调 `nsFormOf`** —— 气泡/卡片判定**全文件只此一处定义**（严禁两处各写一遍）。 */
			if (nsFormOf(banner) === "bubble") {
				var stRunning = banner.state === "running";
				return React.createElement(
					"div",
					{
						"data-notice-banner": "status",
						"data-family": "status",
						"data-notice-routed": String((banner && banner.__routed) || "node"),
						"data-notice-card-id": noticeCardIdAttr,
						"data-state": stRunning ? "running" : "ok",
						className: "dsh-status",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							fontSize: 12,
							lineHeight: "22px",
							color: "var(--dsw-alias-label-tertiary, #9aa3b2)",
							padding: "2px 0"
						}
					},
					React.createElement("span", { style: { flex: "none", fontSize: 12, lineHeight: 1, ...(stRunning ? { animation: "1.2s linear infinite dsh-status-spin", display: "inline-block" } : {}) } }, stRunning ? "⟳" : "✓"),
					React.createElement("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, banner.text || "")
				);
			}
			// ★批13（2026-10-17；用户定案）：「已关闭 / 全 OK」⇒ **该卡彻底不渲染**（`return null`）。
			//   理由：契约 §8 的注入条件本就是"仅 DEGRADED/BLOCKED 才注入"（`dsh-host-compat/lib/index.js:393-436`），
			//   全 OK 时本不该有该卡；`phase === "done"` ＝ dismiss 记录与当前 `hostVersion + capabilitySignature` 逐字相等
			//   ⇒ 用户已关闭或本就无降级 ⇒ 渲染空（**不再渲染「🔕 已关闭 …」残行**；该内部记号随之消失）。
			// ★批14（2026-10-17；仲裁 `#A642` Q1 裁）：判据**再扩一条「当前全域 state === "OK" ⇒ 也不渲染」**。
			//   要解决的问题（`§g` 目的与背景）：签名改为含插件版本后（RD-16），**任一插件升版 ⇒ 签名失配 ⇒
			//   `off` 由 true 变 false ⇒ `phase` 由 done 回 idle** ⇒ store 里那条**历史 payload**（旧的"N 项降级"文案）
			//   会被重新渲染上屏，即使此刻早已全 OK —— 正面撞用户 `#74` 逐字判据
			//   「**如果功能正常了 就不应该显示这个卡片了**」。
			//   ⇒ 现判据 ＝ **已关闭（done）或 当前全 OK ⇒ 不渲染**；真降级（DEGRADED/BLOCKED）且未 dismiss ⇒ 照常完整显示。
			//   ⚠️ status 取失败 ⇒ `globalState` 空串 ⇒ **照旧渲染**（fail-open：宁可多显示，绝不静默吞掉真降级）。
			// ★批15（`#77`）：判据收敛到**唯一函数** `nsCardDropped()` —— 未定位区的计数过滤用的就是它。
			if (nsCardDropped(kind, compat)) return null;
			return React.createElement(
				"div",
				{
					"data-notice-banner": kind,
					"data-family": kind,
					// ★`#A40`：**路由面**（只读）：`turntail`＝由 `conversation.chat.turnTail` 槽渲染（首次加载即可见）；
					//   `node`＝由 `conversation.chat.node` 锚点行渲染（命令级/过程级，允许随步骤折叠）
					"data-notice-routed": String((banner && banner.__routed) || "node"),
					"data-notice-card-id": noticeCardIdAttr,
					// ★`#A67`：**落点退化标记**（可诊断，禁静默）——
					//   `seq`＝按自身锚点 seq（`commandId`/`anchorSeq`/`ctxKey` 内嵌 seq）落位；
					//   `turn`＝只解析到回合（回合尾行）；`tail`＝确实取不到回合（末回合兜底）。
					"data-notice-anchor": String((banner && banner.__anchorSource) || (String((banner && banner.__routed) || "") === "turntail" ? "turn" : "seq")),
					// v0.11.4: compat 两档 severity 共用 data-family="compat", 用 data-severity 区分家族色 (浅色主题着色)
					"data-severity": kind === "compat" ? compatSeverity : undefined,
					"data-collapsed": collapsed ? "true" : undefined,
					className: "dsh-banner",
					style: {
						border: "1px solid " + p.border,
						background: p.bg,
						borderRadius: 12,
						padding: "12px 16px",
						fontSize: 13,
						lineHeight: 1.6,
						maxWidth: "100%",
						wordBreak: "break-word",
						boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
						backdropFilter: "blur(12px)",
						WebkitBackdropFilter: "blur(12px)",
						transition: "box-shadow .3s ease, border-color .3s ease"
					}
				},
				React.createElement(
					"div",
					{
						role: "button",
						title: collapsed ? "展开" : "折叠",
						// ★ `#A34` 步2（G4，**活卡同病一并修**）：卡头点击只翻卡身，禁冒泡到合成卡容器（`:4110`）
						onClick: function (ev) { try { ev.stopPropagation(); } catch (e0) { /* 忽略 */ } toggle(); },
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							fontWeight: 600,
							fontSize: 13.5,
							cursor: "pointer",
							userSelect: "none",
							minHeight: 30,
							marginBottom: collapsed ? 0 : 6,
							color: "var(--dsw-alias-label-primary, #e6e8ec)",
							...(v2 ? { whiteSpace: "nowrap" } : {})
						}
					},
					icon
						? React.createElement("span", { style: { fontSize: 16, flex: "none", lineHeight: 1 } }, icon)
						: null,
					React.createElement(
						"span",
						{
							style: {
								background: p.accent,
								color: p.badgeText,
								fontSize: 10.5,
								fontWeight: 700,
								padding: "0 10px",
								borderRadius: 10,
								letterSpacing: 0.4,
								flex: "none",
								lineHeight: "18px"
							}
						},
						badge
					),
					React.createElement(
						"span",
						{ style: v2 ? { flex: "none", whiteSpace: "nowrap", color: v2TitleColor, fontWeight: 700 } : { minWidth: 0, flex: "1 1 auto" } },
						title,
						v2
							? banner.trigger
								? React.createElement(
										"span",
										{ style: { fontWeight: 500, color: p.meta, fontSize: 12, marginLeft: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "42%" } },
										banner.trigger
									)
								: null
							: subtitle && !(collapsed && kind === "ledger") // v0.11.1 (⑭): ledger 折叠态去副题小字
								? React.createElement(
										"small",
										{ style: { fontWeight: 500, color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontSize: 12, marginLeft: 4 } },
										subtitle
									)
								: null
					),
					collapsed && kind === "ledger" && ledMain && ledMain.text
						? [
								// v0.11.1 (⑭): 主数字 = 含树合计 (胶囊底, 无文字标识) / 叶子 = 本会话合计 (无胶囊)
								React.createElement(
									"span",
									{ key: "lm", title: ledMain.title || undefined, style: ledMain.chip
										? { color: "var(--dsh-lk-tx)", background: "var(--dsh-lk-bg)", border: "1px solid var(--dsh-lk-bd)", fontWeight: 700, fontSize: 13, flex: "none", padding: "0 8px", borderRadius: 8, lineHeight: "20px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", cursor: "help" }
										: { color: p.accent, fontWeight: 700, flex: "none", marginLeft: 4, fontSize: 13, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
									ledMain.text
								),
								// 差值 = 本回合较上次 (自身口径, 次级色弱化)
								ledDelta
									? React.createElement("span", { key: "ld", style: { color: "var(--dsw-alias-label-secondary, #9aa3b2)", fontWeight: 600, fontSize: 12, flex: "none", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, ledDelta)
									: null
							]
						: collapsed && keyValue
							? React.createElement(
									"span",
									{ style: { color: p.accent, fontWeight: 700, flex: "none", marginLeft: 4, fontSize: 13, fontVariantNumeric: "tabular-nums" } },
									keyValue
								)
							: null,
					kind === "queue"
						? React.createElement(
								"span",
								{
									className: "dsh-qbtn",
									role: "button",
									title: panelOpen ? "收起任务队列" : "查看/编辑任务队列",
									onClick: function (e) {
										e.stopPropagation();
										setPanelOpen(!panelOpen);
									},
									style: {
										flex: "none",
										fontSize: 11,
										padding: "0 10px",
										lineHeight: "22px",
										borderRadius: 8,
										background: "var(--dsh-btn-bg)",
										border: "1px solid var(--dsh-glass-bd)",
										color: "var(--dsw-alias-label-primary, #eceff4)",
										cursor: "pointer",
										fontWeight: 600,
										userSelect: "none",
										backdropFilter: "blur(4px)",
										WebkitBackdropFilter: "blur(4px)",
										transition: "all .2s ease"
									}
								},
								panelOpen ? "收起" : "队列"
							)
						: null,
					React.createElement(
						"span",
						{
							className: "dsh-arr",
							style: {
								marginLeft: "auto",
								flex: "none",
								fontSize: 14,
								lineHeight: "22px",
								width: 22,
								height: 22,
								textAlign: "center",
								borderRadius: 11,
								background: "var(--dsh-btn-bg)",
								border: "1px solid var(--dsh-glass-bd)",
								color: "var(--dsw-alias-label-secondary, #9aa3b2)",
								transition: "all .25s ease"
							}
						},
						collapsed ? "▸" : "▾"
					)
				),
				collapsed
					? null
					: v2Body,
				collapsed
					? null
					: !v2 && stats.length > 0
						? React.createElement(
								"div",
								{ style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 6, marginBottom: 4 } },
								stats.map(function (s, i) {
									return React.createElement(
										"div",
										{
											key: i,
											className: "dsh-stat",
											style: {
												background: s.bg || "var(--dsh-stat-bg)",
												border: s.border || "1px solid rgba(255,255,255,0.06)",
												borderRadius: 8,
												padding: "5px 10px",
												backdropFilter: "blur(4px)",
												WebkitBackdropFilter: "blur(4px)"
											}
										},
										React.createElement("div", { style: { color: p.meta, fontSize: 11 } }, s.label),
										React.createElement(
											"div",
											{
												style: {
													fontSize: s.size || 14,
													fontWeight: 700,
													marginTop: 1,
													fontVariantNumeric: "tabular-nums",
													...(s.color ? { color: s.color } : s.strong ? { color: THEME_ACCENT } : {})
												}
											},
											s.value,
											s.note
												? React.createElement(
														"small",
														{ style: { fontWeight: 500, color: p.meta, fontSize: 11, marginLeft: 3 } },
														s.note
													)
												: null
										)
									);
								})
							)
						: null,
				collapsed
					? null
					: !v2 && kv.length > 0
						? React.createElement(
								"div",
								{ style: { color: p.body, marginTop: 4 } },
								kv.map(function (row, i) {
									return React.createElement(
										"div",
										{ key: i, style: { display: "flex", gap: 8, fontSize: 12.5, marginTop: 3 } },
										React.createElement("span", { style: { color: p.meta, flex: "none", minWidth: 68 } }, row.k),
										React.createElement("span", { style: { flex: 1, fontVariantNumeric: "tabular-nums" } }, row.v)
									);
								})
							)
						: null,
				collapsed
					? null
					: kind === "ledger" && banner.sessionId
						? React.createElement(LedgerTree, { p: p, sessionId: banner.sessionId })
						: null,
				collapsed
					? null
					: kind === "ledger" && (Array.isArray(banner.history) || banner.sessionId)
						? React.createElement(LedgerHistory, { p: p, sessionId: banner.sessionId, history: banner.history })
						: null,
				collapsed
					? null
					: kind === "costs" && Array.isArray(banner.sessions) && banner.sessions.length > 0
						? React.createElement(SessionCostList, { p: p, sessions: banner.sessions })
						: null,
				collapsed
					? null
					: kind === "compat" && Array.isArray(banner.items) && banner.items.length > 0
						? React.createElement(CompatItems, { key: "citems", p: p, items: banner.items })
						: null,
				collapsed
					? null
					: !v2 && lines.length > 0
						? React.createElement(
								"div",
								{ style: { color: p.body, ...(stats.length > 0 || kv.length > 0 ? { marginTop: 4 } : {}) } },
								lines.map(function (line, i) {
									return React.createElement(
										"div",
										{ key: i, style: { whiteSpace: "pre-wrap" } },
										line
									);
								})
							)
						: null,
				// v0.11.4 (阶段 1 · B1): compat 的按钮行 (契约 §8 payload.buttons[{label,action}]) —
				//   只认 action:"dismiss"（不发明动作）; 样式沿用家族既有按钮写法 (dsh-qbtn/dsh-sbtn 同款:
				//   玻璃底 + 描边 + 圆角 8 + 11px), 不引入新字体/新边框风格。
				collapsed
					? null
					: kind === "compat" && Array.isArray(banner.buttons) && banner.buttons.length > 0
						? React.createElement(
								"div",
								{
									key: "cact",
									style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }
								},
								banner.buttons.map(function (b, i) {
									return React.createElement(
										"span",
										{
											key: i,
											className: "dsh-cbtn",
											role: "button",
											title: "记录 hostVersion + capabilitySignature ⇒ 本版本不再注入",
											onClick: function (e) {
												e.stopPropagation();
												if (b && b.action === "dismiss") dismissCompat();
											},
											style: {
												flex: "none",
												fontSize: 11,
												padding: "0 10px",
												lineHeight: "22px",
												borderRadius: 8,
												background: "var(--dsh-btn-bg)",
												border: "1px solid var(--dsh-glass-bd)",
												color: "var(--dsw-alias-label-primary, #eceff4)",
												cursor: compat.phase === "busy" ? "default" : "pointer",
												fontWeight: 600,
												userSelect: "none",
												opacity: compat.phase === "busy" ? 0.6 : 1,
												backdropFilter: "blur(4px)",
												WebkitBackdropFilter: "blur(4px)",
												transition: "all .2s ease"
											}
										},
										compat.phase === "busy" ? "记录中…" : (b && b.label ? b.label : "本版本不再提示")
									);
								}),
								// 失败反馈: 就地一行小字（不崩、不空白、不弹层）
								compat.phase === "error" && compat.error
									? React.createElement("span", { key: "cerr", style: { fontSize: 11, color: "var(--dsw-alias-state-danger-primary, #ef4444)" } }, "✗ 取消失败（" + compat.error + "）")
									: null
							)
						: null,
				// compat 无 meta/advice ⇒ 不渲染空 meta 块（其余家族一律照旧）
				collapsed || (kind === "compat" && !meta.text && !meta.advice)
					? null
					: React.createElement(
							"div",
							{ style: { color: p.meta, fontSize: 12, marginTop: 6 } },
							meta.text ? React.createElement("div", null, meta.text) : null,
							meta.advice
								? React.createElement(
										"div",
										{ style: { marginTop: 2, color: "#5b8bf0" } },
										meta.advice
									)
								: null
						),
				!collapsed && kind === "queue" && panelOpen
					? React.createElement(QueuePanel, { p: p })
					: null,
				!collapsed && kind === "restart"
					? React.createElement(RestartPanel, { p: p, banner: banner })
					: null
			);
		});

		/** conversation node 定义: 匹配 notice/banner 事件, 产出 kind="notice-banner" 的 chat 节点 */
		var noticeBannerDefinition = {
			kind: "notice-banner-context",
			target: "chat",
			// 费用横幅 (kind=cost) v0.10 起: **每事件独立 context** (id="cost-<seq>", role=start),
			// 含 banner-replace 也按 start 渲染 — 修复根因: 旧语义只有 rev=0 是 start (id="cost"),
			// 后续永远 banner-replace (update); 客户端会话窗口只加载末尾 50 条消息, start 在窗口外时
			// update 被 surface 静默丢弃 → 重启/换窗口后横幅永不渲染 (2026-08-29 生产实测)。
			// 展示节奏仍由服务端控制: A 每回合发 / C 首次发一次 / B 不发; 每次发射都可见一张卡。
			// 状态迷你行 (kind=status) v0.10 起按回合分组: 服务端每回合首条发 start (payload 带 turn),
			// id="costguard-status-<turn>", 同回合 ok 为 update 原地替换 → 每回合一条灰线;
			// 旧无 turn 的 replace 忽略 (无 start 可更新, 不堆叠历史行), 旧无 turn 的 start 用 seq 兜底。
			// notify/queue/balance/error 横幅: 每事件独立 context, 全部保留。
			// (notify/queue 沿用 "notify-<seq>" id 前缀以兼容已持久化历史; balance/error 用各自前缀)
			// v0.6.0: ledger 会话账本同样每事件独立 context (ledger-<seq>), 每回合一张不替换
			// v0.9.1: 优雅重启 (kind=restart) — context id 用排程实例 scheduleId,
			//   每次排程独立横幅 (start + 同 scheduleId 的 replace 原地更新), 不串历史排程 (v0.9.1 修复)
			// 段 2 修复①：`match()` = **纯函数式**（无订阅、无取数、无 DOM、无定时器）。
			//   它只做两件 O(1) 的判定：① 旧条目走日志折叠（回退路径）② 低频锚点事件产出锚点节点 id
			//   （有界登记，上限 `NOTICE_ANCHOR_MAX`；超限/自动关闭 ⇒ 一律返回 null = **静默缺席**）。
			//   ⚠️ 取数**不在**这里：改由**订阅层**驱动（见 `storeSubscribersChanged`）。
			match: function (event) {
				// （B② 的触发**不在此处**：`match()` 保持段 2 修复① 的**纯函数**约束；会话切换改用宿主
				//   `sessions.list.subscribe()` 权威订阅，见 `bindSessionSwitch()`。）
				var isBannerEvent = event.type === "notice/banner" || event.type === "notice/banner-replace";
				if (isBannerEvent) {
					// store 渲染开启时：带 `schemaVersion` 的条目由 **store 路径**渲染（跳过日志镜像，避免双卡）；
					// store 渲染关闭/降级时：**退回日志折叠**。
					// ⚠️ obs#3 修法①（#A60 一-2 / 八-1）**修正一条失效认知**：R1 已停写会话日志 ⇒ **新横幅不再有日志事件**
					//   ⇒ 该"退回日志折叠"**只对存量事件有效**，**不能**再当作"关渲染也不会全黑"的依据
					//   （旧写法正是靠它给"超限即 storeRenderAutoOff"兜底 ⇒ 实为**超限即全黑**）。
					//   现策略：超限/取数失败**只降级不关闭**（见 storeAddAnchor / storeRefresh），本分支仅服务**手动关闭**与存量事件。
					if (!storeRenderOn() || !(event.data && event.data.schemaVersion === 1)) {
						var legacy = noticeBannerLegacyMatch(event);
						if (legacy) return legacy;
					}
				}
				// 路线 D：宿主自有事件当锚点（只留低频三类；有界 + 超限/按需**只降位置、如实计数**）
				// ★ 段R 路线A 应急开关（`#A132` §2④(i)）：`od-toolcall="0"` ⇒ **不把 `tool/call` 纳入候选**（回到本批之前精度）
				if (STORE_ANCHOR_TYPES[event.type] && !(event.type === "tool/call" && odToolCallOff())) {
					// obs#3 段R ①（C1–C3）：**两趟按需** —— 冷载 **fail-open 全建**（`odPlanGet()` 返回 null）；
					//   热载只建「**有卡锚点集合**」（缓存给出）。以下全是**本地记账 + 本地判定**：不订阅、不取数、
					//   不碰 DOM、不起定时器 ⇒ 守住"段 2 修复①"的 `match()` 纯函数约束（那些副作用只在订阅层/取数层）。
					odNoteSeen(event);
					var odSq = (typeof event.seq === "number") ? event.seq : null;
					if (odSq != null) {
						odAnchorType[odSq] = String(event.type || "");   // 段R 路线A：登记**锚点类型**（供裁顶"既有 3 类优先"判定）
						if (odLastAnchorSeq >= 0 && odSq <= odLastAnchorSeq) { odKept = 0; odFbUsed = false; odBk.backfills += 1; odExpandUntil = odLastAnchorSeq; odExpandPass = true; }  // 窗口重放/扩窗 ⇒ 新一趟
						odLastAnchorSeq = odSq;
					}
					var odP = odPlanGet();
					if (odP && odSq != null) {
						var odDec = odAdmitAnchor(String(event.type || ""), odSq, odP);   // ★ (丙-lite) ②：门槛判定收敛为**唯一可测单元**
						if (odDec === "decline") {
							// **`declined` = 仅"`dsh-notice-od-drop` 注入"**（#A131 §4③④ 起，裁顶让位走 `yielded`、**不落 pending**）：
							//   注入 ⇒ 强制不建 + 其条目如实落 pending（fail2 正控口径**保持不变**）。
							//   仍登记其 turn 身份 ⇒ "身份首选锚点被裁 ⇒ pending"判定成立（不静默改落它处）。
							odNoteTurnIdentity(event);
							return null;
						}
						// ★段U9 L1：**扩窗趟**里，**核心三类锚点无条件补建**（旧回合的账本/费用卡需要位置槽）；
						//   `tool/call` 仍按需；`odSq <= odExpandUntil` ⇒ 只覆盖**新载入段**（有界，绝不"每次扩窗全建"）。
						if (odDec === "core") {   /* ★段U12 M1：**核心三类一律建、不查名单**（名单只用于按需订阅/取数） */
							odBk.coreBuilt += 1; if (odExpandPass && odSq <= odExpandUntil) odBk.expandBuilt += 1;
							/* 段U12 M1：核心槽**不设上限**（宁多建、不静默少建）⇒ 本分支不再截断 */
						}
						else if (odDec === "declared") {
							// ★ (丙-lite) ②：**卡声明 `anchorSeq`** 的行 ⇒ **必建载体**（本批新增输入面）⇒ 已载入到该位置必得节点 ⇒ **gap=1**
							odBk.declaredBuilt += 1;
						}
						else if (odDec !== "want") {
							// **让位锚点**（保险值触发时的裁顶）：不建节点，但**登记 turn 身份** ⇒ 其条目能在 ① 身份对齐里被认出、
							//   随后**重定向到最近的已建锚点**渲染（`#A132` §2②：**绝不落 pending**）。
							if (odDec === "yield") odNoteTurnIdentity(event);
							// **保底锚点（C2）**：只在「序列序上已**越过全部按需锚点**（`seq > 按需集合最大 seq`）却**一个都没建**」
							//   且**有余量**（总数恒 ≤ `NOTICE_ANCHOR_MAX`）时补 1 个 ⇒ **订阅下限 ≥1**（防"锚点全无 ⇒ 取数停摆"）。
							if (odDec !== "fallback") return null;   /* 保底锚点（C2）以外 ⇒ 不建（同旧行为） */
							odFbUsed = true;                     // **每趟至多 1 个**（latched）
							odBk.fallback += 1;
						}
					}
					var aseq = storeAddAnchor(event);
					if (aseq != null) {
						if (odP && odP.want[aseq]) { odKept += 1; odBk.kept = odKept; }
						return { id: "store-anchor-" + aseq, role: "start" };
					}
				}
				return null;
			},
			start: function (_context, match) {
				var ev = match && match.event;
				// 段 2 修复（事故根因②）：按**事件类型**识别锚点节点（不看 `match.id` 的拼接形状 —— 宿主那里
				// `conversationContextKey(kind,id)` 会把 id 拼进 key，前缀判定会漏 ⇒ 旧写法在这里**抛错**
				// ⇒ `[session-controller] event feed subscriber failed` ⇒ **整个历史不渲染**）。
				if (ev && STORE_ANCHOR_TYPES[ev.type]) {
					// S3（obs#3）：节点自带**会话归属**（`__sid`）—— 只有"确定属于别的会话"时才隐藏（见 buildViewNode）
					storeNoteAnchorNode(ev.seq, ev.time);   // 修法②：宿主建的锚点节点登记进"锚点宇宙"（不清、不设上限）
					return { seq: ev.seq, time: ev.time, __storeAnchor: ev.seq, __sid: currentSessionId() };
				}
				// v0.10.1: 允许 notice/banner(-replace) 作为 start (cost 横幅自渲染, 见 match)。
				// ⚠️ 段 2 起**永不 throw**：任何非预期形态一律返回"空气态"（`__noop`），
				//    由 `buildViewNode` 返回 null —— 插件节点绝不允许把宿主的装配/事件订阅链路打断。
				if (!ev || (ev.type !== "notice/banner" && ev.type !== "notice/banner-replace")) {
					return { seq: ev && typeof ev.seq === "number" ? ev.seq : 0, time: ev && ev.time, banner: null, __noop: true, __sid: currentSessionId() };
				}
				return { seq: ev.seq, time: ev.time, banner: ev.data, __sid: currentSessionId() };
			},
			update: function (_context, match) {
				// 新的费用提醒数据整体替换旧数据 (原地替换, anchor 移到最新事件位置)
				var event = match.event;
				return { seq: event.seq, time: event.time, banner: event.data, __sid: currentSessionId() };
			},
			buildViewNode: function (context) {
				if (context.state === void 0) return null;
				// S3（obs#3 根因收口）：**节点归属校验** —— 节点记录的是**创建它的那个会话**；切会话后
				//   旧会话的节点（含 legacy 日志折叠卡与 store 锚点卡）若仍挂在容器里，此处一律渲染空
				//   （`__sid == null` 表示创建时拿不到会话 id ⇒ **不隐藏**，避免早期误隐）。
				try {
					noticeDbg.viewCalls += 1;
					var __own = context.state && context.state.__sid;
					var __now = currentSessionId();
					noticeDbg.lastSid = __now;
					if (__own != null && __own !== __now && nodeSessionGuardOn()) {
						noticeDbg.hidden += 1;
						if (noticeDbg.hiddenSeq.length < 40) noticeDbg.hiddenSeq.push([__own, __now, context.state && context.state.seq]);
						noticeDebugFlush();
						return null;
					}
					noticeDebugFlush();
				} catch (e) { /* 忽略：绝不打断宿主装配 */ }
				var st = context.state;
				if (st.__noop === true) return null;            // 非预期形态 ⇒ 空气（不建节点）
				if (st.__storeAnchor == null && (!st.banner || typeof st.banner !== "object")) return null;
				// 锚点节点**常驻**（不因"当前无条目"返回 null）：宿主对 `:empty` 的 flowItem 不占布局，
				// 取数晚到时由组件订阅重渲染 ⇒ 不会丢卡（R8 的"渲染空气"由组件返回 null 实现）。
				var data = st.__storeAnchor != null ? { __storeWatch: st.__storeAnchor } : st.banner;
				return {
					key: context.key,
					kind: "notice-banner",
					id: context.id,
					target: "chat",
					anchorSeq: st.seq,
					location: context.start ? context.start.location : { kind: "unresolved" },
					visibility: "visible",
					data: data
				};
			}
		};
		/** 旧日志折叠匹配（原 `match` 主体；P1-2 抽成函数供 store 优先分流后调用） */
		function noticeBannerLegacyMatch(event) {
			if (event.type === "notice/banner") {
					var d = event.data;
					var kind = d && d.kind;
					// v0.10: 按回合分组 (新事件带 turn); 旧无 turn 事件 (会话首条) 用 seq 兜底
					if (kind === "status") return { id: "costguard-status-" + (d && d.turn != null ? d.turn : event.seq), role: "start" };
					if (kind === "restart") return { id: "restart-" + (d && d.scheduleId ? d.scheduleId : event.seq), role: "start" };
					if (kind === "ledger") return { id: "ledger-" + event.seq, role: "start" };
					if (kind === "cost") return { id: "cost-" + event.seq, role: "start" };
					// v0.11.4 (阶段 1 · B1): 适配状态横幅 (kind=compat) = **每会话一条**（契约 §8）⇒
					//   context id 固定 "compat"（非 seq 前缀）: 服务端幂等注入, 万一发 banner-replace
					//   也原地更新同一条, 不堆历史卡。
					if (kind === "compat") return { id: "compat", role: "start" };
					var prefix = kind === "balance" ? "balance" : kind === "error" ? "error" : kind === "costs" ? "costs" : "notify";
					return { id: prefix + "-" + event.seq, role: "start" };
				}
				if (event.type === "notice/banner-replace") {
					if (event.data && event.data.kind === "status") {
						var t = event.data.turn;
						return t != null ? { id: "costguard-status-" + t, role: "update" } : null;
					}
					if (event.data && event.data.kind === "restart") return { id: "restart-" + (event.data.scheduleId ? event.data.scheduleId : "legacy"), role: "update" };
					// v0.11.4: compat 原地更新（每会话一条; 同样固定 id "compat"）
					if (event.data && event.data.kind === "compat") return { id: "compat", role: "update" };
					// v0.10: cost replace 也按独立 context start 渲染 (见上)
					return { id: "cost-" + event.seq, role: "start" };
			}
			return null;
		}

		/** 运行时服务注入 (client 插件契约); connection = 浏览器端通用 RPC (队列面板用) */
		var inject = ["slots", "uiConversation", "connection", "sessions"]; // 2026-09-09 移植: uiConversation 取代旧 conversationEvents (0.1.2-rc.1); P1-2: sessions = 当前会话 id（store 取数入参）

		/** client 插件主体: 注册节点定义 + 横幅渲染槽位 */
		/** ★批4 `T29` 设置卡卡体（`#A299` 用户裁；文案逐字照小预览 `public/notice-banner-foldkeep-preview.html`）。
		 *  只注册**卡体**（外壳/折叠/标题行由容器提供 ⇒ 不自绘外壳，遵循折叠胶囊卡契约），与 `host-compat` 同形。
		 *  ★批4b ①（`#A330` 用户裁「摘要可以加 只是放在卡片折叠那里感觉怪怪的」）：**本卡只留折叠开关** ——
		 *  「历史存量」读数**已独立成项**（key `notice-banner-legacy`，见 `LegacyCard`/`LegacySummary`）。
		 *  负向判据：本卡内**不得再出现** `data-notice-legacy-*` 或「历史存量」字样。 */
		/** ★ `#A29`：**面板点名**读数（订阅 store 快照 ⇒ 随对齐结果更新）。
		 *  **只读 `storeRenderState.hint`**（由 `storeAlignAll()` 一处写）⇒ 健康会话取回 `""` ⇒ 面板**不渲染该行**
		 *  （`ENV §二` 信号纪律：健康会话该信号必须为 0）。订阅不可用 ⇒ 只按当次渲染现读，不编造、不抛。 */
		function useHintReadout() {
			var ring = React.useState(0);
			React.useEffect(function () {
				var un = null;
				try { un = subscribeStore(function () { ring[1](function (n) { return (n + 1) % 1000000; }); }); } catch (e) { /* 订阅层不可用 ⇒ 静默 */ }
				return function () { try { if (un) un(); } catch (e0) { /* 忽略 */ } };
			}, []);
			try {
				var base = String(storeRenderState.hint || "");
				// ★`#A35` 步2：**面板点名「档位退化」** —— 有 `tail` 档（无行事实、退回合末尾）⇒ 追加 `hist-anchor-tail`。
				//   复用同一 `data-notice-hint` 元素（零新增界面元素），健康（全 exact）⇒ 不出该码。
				var hs = null; try { hs = window.__DSH_NOTICE_HIST__ || null; } catch (e) { hs = null; }
				var tail = hs && typeof hs.tail === "number" ? hs.tail : 0;
				if (tail > 0) base = base ? (base + ",hist-anchor-tail") : "hist-anchor-tail";
				// 只读诊断锚（供探针机械取"面板实际会渲染的串"；**不是**界面元素）
				try { window.__DSH_NOTICE_HINT_PANEL__ = { codes: base, hist: hs }; } catch (eP) { /* 忽略 */ }
				return base;
			} catch (e1) { return ""; }
		}
		function FoldKeepCard(props) {
			var cfg = (props && props.configForm) || null;
			var cfgOn = useConfigBool(cfg, "foldKeep", foldKeepOn());
			var onState = React.useState(cfgOn);
			function toggle() {
				var next = (cfgOn === true) ? false : true;
				try { setFoldKeep(next); } catch (e) { /* 本地镜像失败不阻断 */ }
				try { if (cfg && typeof cfg.mutate === "function") cfg.mutate([{ op: "set", path: ["foldKeep"], value: next }]); } catch (e) { /* 保存失败保留本地镜像 */ }
			}
			var seam = null; try { seam = nsSeamState(); } catch (e) { seam = null; }
			// ★ `#A29`（P2′/P1′ 面板点名）：`data-notice-hint` **只进面板**（`settings.localplugin.item`），
			//   **禁进会话界面**（用户 2026-11-14 明确「不做界面提示」）。非空才渲染 ⇒ 健康会话零可见元素。
			var hintCode = useHintReadout();
			var hintLine = hintCode ? React.createElement("div", {
				key: "hint", className: "dsh-nb-fk-hint", "data-notice-hint": hintCode,
				style: { display: "block", marginTop: 6 }
			}, "卡片落点：" + hintCode + "（本会话 · 仅面板可见）") : null;
			var seamLine = React.createElement("div", {
				key: "seam", className: "dsh-nb-fk-hint", "data-notice-scrollseam": (seam && seam.hasService) ? "on" : "missing",
				style: { display: "block", marginTop: 6 }
			}, (seam && seam.hasService)
				? ("滚动补滚：在位（中间件 hostScroll · 闸门 " + ((seam && seam.gateMs) || 800) + "ms）")
				: "滚动补滚：**停用**（中间件 hostScroll 未提供 ⇒ 只丢补滚，卡片照常渲染）");
			var on = onState[0] === true;
			return React.createElement("div", { className: "dsh-nb-fk" }, [
				hintLine,
				seamLine,
				React.createElement("div", { className: "dsh-nb-fk-row", key: "row" }, [
					React.createElement("div", { className: "dsh-nb-fk-tx", key: "tx" }, [
						React.createElement("b", { key: "t" }, "折叠回合仍显示队列 / 重启 / 错误卡"),
						React.createElement("span", { className: "dsh-nb-fk-hint", key: "h" }, on
							? "开：与旧版一致 —— 回合折叠时这三类卡仍显示。"
							: "默认关 —— 回合折叠时这三类卡不显示（展开后照常显示）。")
					]),
					React.createElement("button", {
						key: "sw", type: "button", role: "switch", className: "dsh-nb-fk-sw",
						"data-nb": "foldkeep-switch", "data-on": on ? "true" : "false",
						"aria-checked": on, "aria-label": "折叠回合仍显示队列 / 重启 / 错误卡",
						onClick: toggle
					}, React.createElement("span", { className: "dsh-nb-fk-knob", key: "k" }))
				])
			]);
		}
		/** ★批4b ①：`LegacyCard`/`LegacySummary` 共用的读数 ＋ **store 订阅**（快照变化 ⇒ 重渲染）。
		 *  订阅语义沿用既有 `subscribeStore`（**订阅数 = 取数的唯一驱动**，段 2 修复①）—— 本页原本已有
		 *  保活订阅（`odKeepAliveEnsure`）⇒ 请求面不变，只是让**摘要行随读数更新**（否则首次渲染落在
		 *  `loading` 时不会自愈）。退订/订阅异常一律吞掉，绝不打断宿主。 */
		function useLegacyReadout() {
			var ring = React.useState(0);
			React.useEffect(function () {
				var un = null;
				try { un = subscribeStore(function () { ring[1](function (n) { return (n + 1) % 1000000; }); }); } catch (e) { /* 订阅层不可用 ⇒ 静默：读数仍按当次渲染现读 */ }
				return function () { try { if (un) un(); } catch (e0) { /* 忽略 */ } };
			}, []);
			return legacyReadout();
		}
		/** ★批4b ①（`#A330`）：**「历史存量」读数独立成项 —— 卡体**（展开后可见）。
		 *  机器锚点 `data-notice-legacy-readout` / `-historic` / `-list-total` **本卡独有**（`#A320` 沿用同名，
		 *  由折叠开关卡**搬来**此处）；数值由清单现读（`E49`：不硬编码）；三态 `ok`/`unsupported`/`loading` 保留。 */
		function LegacyCard() {
			var lr = useLegacyReadout();
			return React.createElement("div", { className: "dsh-nb-fk" }, [
				React.createElement("div", {
					className: "dsh-nb-fk-row", key: "legacy",
					"data-notice-legacy-historic": lr.state === "ok" ? String(lr.n) : void 0,
					"data-notice-legacy-list-total": lr.state === "ok" ? String(lr.total) : void 0,
					"data-notice-legacy-readout": lr.state
				}, lr.state === "ok" ? [
					React.createElement("b", { key: "t" }, "历史存量 " + lr.n + " 张（不告警 · 逐张可查）"),
					React.createElement("span", { className: "dsh-nb-fk-hint", key: "h" }, "清单容量 " + lr.total + " 张 · 只减不增 · 新增必告警")
				] : (lr.state === "unsupported" ? [
					React.createElement("b", { key: "t" }, "历史存量：未就绪（服务端未上报该读数）"),
					React.createElement("span", { className: "dsh-nb-fk-hint", key: "h" }, "不编造 0；升级服务端后自动显示（数值由清单现读取得）")
				] : [
					React.createElement("b", { key: "t" }, "历史存量：读取中…"),
					React.createElement("span", { className: "dsh-nb-fk-hint", key: "h" }, "数值由清单现读取得（不硬编码）")
				]))
			]);
		}
		/** ★批4b ①：**同 key 的 summary 兄弟槽 = 折叠标题行 —— 读数就在这里（列表里不展开即可见）**。
		 *  结构照折叠胶囊卡契约（`docs/任务记录/2026-09-12-本地插件折叠卡-契约.md` §5.4）：
		 *  `lp-ico` / `lp-title` / `lp-badge` / `lp-hint` 四件**并列**（**不加包裹元素** —— 否则宿主
		 *  `.dsh-lp-sum` 的 flex/gap 与 `.lp-hint{margin-left:auto}` 全失效；同 `host-compat` 的 Fragment 写法）。
		 *  机器锚点：`data-notice-legacy-summary`（三态）＋ `-summary-n`（ok 时的读数，供"同源对撞"用）。 */
		function LegacySummary() {
			var lr = useLegacyReadout();
			var title = lr.state === "ok"
				? "历史存量 " + lr.n + " 张（不告警 · 逐张可查）"
				: (lr.state === "unsupported" ? "历史存量：未就绪（服务端未上报该读数）" : "历史存量：读取中…");
			var hint = lr.state === "ok"
				? "清单容量 " + lr.total + " 张"
				: (lr.state === "unsupported" ? "不编造 0" : "读清单中…");
			return React.createElement(React.Fragment, null, [
				React.createElement("span", { className: "lp-ico", key: "ico" }, "🗂"),
				React.createElement("span", {
					className: "lp-title", key: "title",
					"data-notice-legacy-summary": lr.state,
					"data-notice-legacy-summary-n": lr.state === "ok" ? String(lr.n) : void 0
				}, title),
				React.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				React.createElement("span", { className: "lp-hint", key: "hint" }, hint)
			]);
		}
		/** ★`#A320` ①：**历史存量读数（设置面）** —— 数值由**清单现读**取得（全局卡 `counts.legacyHistoric` /
		 *  `legacyListTotal`，由 B 侧按清单现算）⇒ **不硬编码**（`E49`）；取不到 ⇒ 如实「读取中…」，**不编造 0**。 */
		function legacyReadout() {
			var cards = [];
			try { cards = storeStateCards(); } catch (e) { return { state: "loading", n: null, total: null }; }
			for (var i = 0; i < cards.length; i++) {
				var c = cards[i];
				if (!c || String(c.kind) !== "alert" || String(c.scope) !== "global" || !c.counts) continue;
				var hasN = typeof c.counts.legacyHistoric === "number";
				var hasT = typeof c.counts.legacyListTotal === "number";
				// ★**键缺 ≠ 0**（`#A320` 子线实测点名）：服务端未上报该读数（跨版本半部署）⇒ **如实报"未就绪"，绝不编造 0**
				//   （`ENV §一.6②`：禁"报 OK 而功能坏"、"不展示"≠"看不见"；`E49`：数值现读、不硬编码）。
				if (!hasN && !hasT) return { state: "unsupported", n: null, total: null };
				return { state: "ok", n: hasN ? c.counts.legacyHistoric : null, total: hasT ? c.counts.legacyListTotal : null };
			}
			return { state: "loading", n: null, total: null };
		}
		/** 同 key 的 summary 兄弟槽（折叠标题行）
		 *  ★批5 `T39`（`#A335` 用户逐字「1 2修」）：**补齐折叠胶囊卡契约 §5.4 的四件** ——
		 *  `lp-ico`／`lp-title`／`lp-badge`／`lp-hint`，四件**并列不加包裹元素**（同 `LegacySummary`／`host-compat`），
		 *  其中 `lp-hint` 为**开关动态文案**。此前只有一个裸 `<span class="dsh-nb-fk-sum">`（批4 `T29` 遗留；
		 *  `#A332` 件① 把本插件接入 `localplugin-fold-smoke.mjs` 时点名该偏差）。
		 *  图标取 📌（"保留/钉住"语义，与相邻卡 ⚡⛰💰🧩🖼🔔🛡🗂 均不撞）。 */
		function FoldKeepSummary() {
			return React.createElement(React.Fragment, null, [
				React.createElement("span", { className: "lp-ico", key: "ico" }, "📌"),
				React.createElement("span", { className: "lp-title", key: "title" }, "折叠回合卡片"),
				React.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				React.createElement("span", { className: "lp-hint", key: "hint" }, foldKeepOn() ? "保留显示（开）" : "折叠时不显示（默认）")
			]);
		}

		function apply(ctx) {
			pluginCtx = ctx; // 队列面板经 ctx.get("connection").rpc 调用服务端 /queue 通道
			injectGlassCss(); // v0.8.0 液态玻璃 v2 样式 (幂等)
			syncFoldKeepCss(); // ★批4 `T29`：按开关决定是否注入"折叠保留"两条 CSS（甲-0；默认关 ⇒ 不注入）
			ctx.uiConversation.events.register(noticeBannerDefinition); // 2026-09-09 移植: 0.1.2-rc.1 新引擎注册(原 conversationEvents.register)
			// 段 2 修复①：**不再**在 apply 期启动轮询 —— 取数由**订阅层**驱动（无组件订阅 ⇒ 零请求、零定时器）。
			// obs#3 段R C2（**订阅下限 ≥1**，仲裁 #A124 §1 首选路径）：本批**只加一条保守兜底** ——
			//   apply 后 **3 s** 一次性复查：**若当时"锚点组件订阅数 = 0"且正在查看某会话** ⇒ 挂一个**保活订阅**
			//   （它**不是锚点**、**不进 `storeAnchorUniverse()`** ⇒ 不影响对齐/文档序），只为让取数**不停摆**、
			//   使 `pendingCount`/异常标记**如实**（治 fail2「锚点全无 ⇒ 卡静默消失而 `pendingCount` 读 0」）。
			//   ⚠️ 正常情形（页面有锚点节点）⇒ 本兜底**不注册任何订阅** ⇒ "无订阅 ⇒ 零请求" 逐字不变。
			try {
				setTimeout(function () {
					try { if (currentSessionId()) odKeepAliveEnsure(); } catch (e1) { /* 忽略 */ }
				}, 3000);
			} catch (e0) { /* 无定时器环境（测试）⇒ 只靠组件订阅路径 */ }
			// ★W7（2026-11-12）「历史条幅按轮展示」：注册 `conversation.chat.turnTail` 的 list 贡献。
			//   为什么用 `ctx.slots.inject` 而不是直接 `register`：该槽是宿主 `conversation.chat.node` 的**子槽**，
			//   直接注册会与声明竞态（ui-slots 载入期校验会抛 "not declared"）；`inject` 等声明就位再注册，
			//   声明塌缩时自动注销（与 `@deepseek-ai/dsh-client-ui-deliverables` 同法）。
			//   为什么必须给 `id`：0.2.2 把该槽声明为 `kind:"list"` ⇒ 强制 `options.id`（W1b 现读：
			//   `list slot "conversation.chat.turnTail" requires options.id`）。
			//   槽不存在/更旧/契约不符 ⇒ try/catch 静默降级（不崩槽、不空白、不影响既有横幅渲染）。
			try {
				if (ctx.slots && typeof ctx.slots.inject === "function") {
					ctx.slots.inject("conversation.chat.turnTail", function () {
						try {
							var d = ctx.slots.register({
								name: "conversation.chat.turnTail",
								id: "dsh-notice-banner/history",
								// ★同时给 `select`：0.1.2 把该槽声明为 **chain**（校验要求 `options.select`），0.2.2 声明为
								//   **list**（校验要求 `options.id`、渲染时不读 `select`）。两者都给 ⇒ 跨代都能注册：
								//   0.1.2 上 `select` 恒返回 null ＝「本入口不参选」⇒ 渲染逐字走原有 fallback（行为不变、零 console 噪音）；
								//   0.2.2 上 `select` 被忽略 ⇒ 按 list 渲染（实测 V3c① 修前：只给 id 会在 0.1.2 抛
								//   `chain slot "conversation.chat.turnTail" requires options.select` 并污染 console）。
								select: function () { return null; },
								order: 100,
								registrant: "dsh-notice-banner"
							}, HistoryTurnTail);
							return d;
						} catch (e) {
							try { console.warn("[dsh-notice-banner] turnTail 注册跳过: " + String(e && e.message || e)); } catch (e1) { /* 忽略 */ }
							return function () {};
						}
					});
				} else {
					try { console.warn("[dsh-notice-banner] ctx.slots.inject 不可用 ⇒ 历史条幅停用"); } catch (e3) { /* 忽略 */ }
				}
			} catch (e) {
				try { console.warn("[dsh-notice-banner] turnTail inject 跳过: " + String(e && e.message || e)); } catch (e4) { /* 忽略 */ }
			}
			ctx.slots.inject("conversation.chat.node", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: "notice-banner"
				}, NoticeBannerView);
			});
			// 配置卡迁到插件详情页（plugins.bundle.config，key = 包名）；
			// 折叠开关读写宿主官方 Config，历史存量读数与诊断锚仍按原口径渲染。
			try {
				var cfgForm = null;
				try { var cfSvc = ctx.get ? ctx.get("configForms", false) : null; cfgForm = cfSvc && typeof cfSvc.get === "function" ? cfSvc.get("notice-banner") : null; } catch (e0) { cfgForm = null; }
				ctx.slots.inject("plugins.bundle.config", function () {
					return ctx.slots.register({
						name: "plugins.bundle.config",
						key: "@ericality/dsh-notice-banner",
						inject: function () { return { configForm: cfgForm }; }
					}, function NoticeBannerConfig(props) {
						return React.createElement("div", { className: "dsh-nb-cfg" }, [
							React.createElement(FoldKeepCard, { key: "fk", configForm: props.configForm }),
							React.createElement(LegacyCard, { key: "lg" })
						]);
					});
				});
			} catch (e) { /* 配置槽不可用 ⇒ 静默（本地开关与读数路径照常） */ }
		}

		exports.inject = inject;
		exports.apply = apply;
		// v0.11.0 (期乙): 冒烟测试专用导出 (仅 window.__DSH_SMOKE__ 置位时, 生产浏览器不置位不启用)
		if (typeof window !== "undefined" && window.__DSH_SMOKE__) {
			exports.__test = {
				NoticeBannerView: NoticeBannerView,
				RestartPanel: RestartPanel, // v0.9.7: 优雅重启面板 (僵尸横幅自愈逻辑专测 scripts/gr-banner-stale-test.mjs)
				PALETTE: PALETTE,
				LedgerTree: LedgerTree,
				SessionCostList: SessionCostList,
				SessionTreeList: SessionTreeList,
				ctMoney: ctMoney,
				ctShortSid: ctShortSid,
				ctPctText: ctPctText,
				// v0.11.5: 队列面板状态标签对撞 (scripts/tq-panel-status-harness.mjs 真渲染)
				QueuePanel: QueuePanel,
				statusTag: statusTag,
				statusKind: statusKind,
				QUEUE_STATUS_STYLE: QUEUE_STATUS_STYLE,
				beijingTime: beijingTime,
				oneLine: oneLine,
				// 冒烟专用: 覆盖 /queue RPC (仅 __DSH_SMOKE__ 下存在的测试注入口, 生产永不置位)
				setQueueRpcForTest: function (fn) { __smokeQueueRpc = fn; },
				// 段 2 修复③: 渲染开关与锚点策略的可观测面（只读 + 手动关闭）
				storeRender: {
					on: function () { return storeRenderOn(); },
					state: function () { return { autoOff: storeRenderState.autoOff, reason: storeRenderState.reason, overLimit: storeRenderState.overLimit, fetchErrors: storeRenderState.fetchErrors, anchors: storeState.anchorList.length, subscribers: STORE_SUBSCRIBERS,
						// obs#3 修法①（#A60 一-2）：降级态如实可查
						degraded: storeRenderState.degraded, degradeReason: storeRenderState.degradeReason, turnAnchors: Object.keys(storeState.turnAnchor).length,
						// ★ `#A29`：**面板点名串** ＋ 两条兜底的如实计数（`__DSH_SMOKE__` 下的只读诊断面；
						//   与 `window.__DSH_NOTICE_HINT__` 同源同值，均由 `storeAlignAll()` 单点写入）
						hint: storeRenderState.hint,
						indexTurnFallback: storeAlignAll().indexTurnFallback, noAnchorFallback: storeAlignAll().noAnchorFallback,
						// obs#3 修法②（#A70 一 (b1)/(b2)）：锚点宇宙与尾锚点兜底计数
						anchorNodes: Object.keys(storeState.anchorNodes).length,
						// obs#3 段I（#A77 四/五）：`tailAssigned` 改为**单趟真值**（旧口径按锚点调用次数累加 ⇒ 被放大）；
						//   新增 `pendingCount` = **无载体（回合未挂载）条目的如实计数** —— 与 UI 标注行**同源同函数** ⇒ 恒相等
						tailAssigned: storeAlignAll().tailAssigned, pendingCount: storeAlignAll().pending,
						// obs#3 段R ①②（C1–C3 / D1–D3）：**按需锚点 + 保底 + 异常标记**的如实可查面
						//   · `cold=true` = 本页为**冷载/无有效缓存** ⇒ **fail-open 全建**（"首访仍全量"= 已登记限制）
						//   · `kept/fallback/declined` = 按需集合内已建数 / 保底补建数 / 被裁数（被裁者条目落 `pending`）
						//   · `pendingDeclined` = 因"身份首选锚点被裁"而落 pending 的条目数（C3 的**如实计数**）
						//   · `keepAlive` = 保活订阅是否在用（订阅数恒 ≥1）；`pendingStuck` = **诊断计数**（不作触发，见 odAnomaly）
						onDemand: { mode: odMode(), cold: odBk.cold, wantSize: odBk.wantSize, declined: odDeclinedN,
							kept: odKept, fallback: odBk.fallback, keepAlive: odBk.keepAlive,
							pendingDeclined: storeAlignAll().pendingDeclined, staleHidden: odBk.staleHidden,
							yielded: odYieldedN, yieldedFallback: storeAlignAll().yieldedFallback,
							sig: odConfigSig(), sigMiss: odBk.sigMiss,
							staleKeys: odBk.staleKeys, backfills: odBk.backfills, pendingStuck: odBk.pendingStuck,
							wantUnsound: odBk.wantUnsound, anchorMiss: odBk.anchorMiss, cacheDrop: odBk.cacheDrop, expandBuilt: odBk.expandBuilt, expandCapped: odBk.expandCapped,
							expandPending: storeAlignAll().expandPending, pendingNoNode: storeAlignAll().pendingNoNode, anchorSeqHit: storeAlignAll().anchorSeqHit,
							// ★(乙) T18 键1（2026-09-20 用户已签）：**配对计数进观测**（`commandIdHit` 命中 / `commandIdMiss` 配对失败）
							//   —— 配对失败**不静默**：继续走既有 ②③④（与装前逐字等价），此处如实计数（禁"报 OK 而功能坏"）。
							commandIdHit: storeAlignAll().commandIdHit, commandIdMiss: storeAlignAll().commandIdMiss,
							coreBuilt: odBk.coreBuilt, coreOverflow: odBk.coreOverflow,   /* 段U4 U5a · U9 L1 · U10 L1′ · U12 M1/M2 */
							mountedAnchors: Object.keys(storeState.anchorMounted).length,
							// obs3S7 段W-2a T2-b 件D：**② 面 + 未定位区 + 渲染回报**的如实可查面
							//   （VM/生产探针据此断言；`spatialOn=false` = 回退位 ON 或 ② 不可读）
							spatialOn: storeAlignAll().spatialOn, spatialDegraded: storeAlignAll().spatialDegraded,
							indexDegraded: storeState.spatial.indexDegraded, slotCount: storeState.spatial.slots.length,
							// ★ `#A29`（P2′/P1′）：`indexTurnFallback` = 因 ② 不可读而按 `turn` 兜底落位的条目数；
							//   `noAnchorFallback` = 三空条目兜底到尾锚的条目数（两者 >0 即面板点名 `hint` 非空）
							indexTurnFallback: storeAlignAll().indexTurnFallback, noAnchorFallback: storeAlignAll().noAnchorFallback,
							slotSeqCount: storeSlotSeqSet() ? Object.keys(storeSlotSeqSet()).length : 0,
							unplacedCount: storeAlignAll().unplacedKeys.length,
							// obs3S7 段W-2b `(a)(b)`：状态卡与观测七项（**只读快照**，供探针/判据取数）
							stateCardKinds: storeStateCards().map(function (c) { return String(c && c.kind) + ":" + String(c && c.scope); }),
							stateCardMode: storeStateCardMode(),
							// ★批16（`#78` 孤岛 `#6`）：**会话级卡张数 = 与服务端状态卡那行同一来源同一值**
							//   （`index.sessionCards` 条数；旧写法 `storeAlignAll().sessionKeys.length` 是**本窗口**口径 ⇒
							//   与全史口径成两个数）。服务端状态卡还没到 ⇒ 如实回退旧口径（不编造 0）。
							sessionCardCount: (function () {
								var n6 = scSessionCardCount(storeStateCards());
								return (Number.isFinite(n6) && n6 >= 0) ? n6 : storeAlignAll().sessionKeys.length;
							})(),
							obsCounts: (function () { var l = storeStateCards(); for (var i = 0; i < l.length; i++) { if (String(l[i].kind) === "degrade" && l[i].counts) return l[i].counts; } for (var j = 0; j < l.length; j++) { if (String(l[j].kind) === "alert" && String(l[j].scope) === "session" && l[j].counts) return l[j].counts; } return null; })(),
							authoritative: storeAlignAll().authoritative,
							reports: storeState.spatial.reports, lastReportSeq: storeState.spatial.lastReportSeq,
							reportSkipped: storeState.spatial.reportSkipped,
							registry: { size: odRegN, trips: odRegTrips, declared: odDeclaredN, declaredBuilt: odBk.declaredBuilt,
								reason: odRegReason(), reasonAtIngest: odRegDegraded, sid: odRegSid ? String(odRegSid).slice(0, 12) : null },
							firstVisitFull: true } }; },
					off: function () { storeRenderState.autoOff = true; storeRenderState.reason = "manual-test"; },
					on2: function () { storeRenderState.autoOff = false; storeRenderState.reason = ""; },
					anchorTypes: STORE_ANCHOR_TYPES,
					anchorMax: odMaxAnchors()
				}
			};
		}
		return module.exports;
	}
});
