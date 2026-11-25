window.__ModuleLoader__.load({
	id: "@ericality/dsh-taskqueue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-taskqueue 客户端 (v0.7.0 新增 / v0.8.0 提示换位 + 单会话豁免 / v0.8.2 折叠图标+弹层 /
		//                        v0.8.3 0.1.2 槽契约修复 + 诊断上报)
		//
		// 1) 错峰出行模式 (offpeak mode):
		//    - 设置菜单「本地插件」列新增「任务队列」卡: 开关 + 当前状态显示
		//    - 开启后高峰期间: 所有消息 (已有/新会话) 默认入队 —— 包装会话对象的
		//      prompt(content, mode, signal, requestId) (0.1.2 真实发送入口), 当
		//      开关开 + 当前高峰 + 纯文本时 不发给 LLM, 改调 /queue RPC add 入队
		//      (绑当前会话, 服务端注入蓝色队列横幅), 并向 composer 返回模拟成功
		//      (accepted: true) 清空输入框。
		//      平峰期间或关闭状态: 原样放行 (正常发送)。
		//    - 斜杠命令不走 session.prompt (走 commands.execute), 天然不受拦截。
		//    - v0.8.0 单会话豁免: 服务端持久化 exempt map (offpeak-mode.json),
		//      豁免会话高峰照常发送; 拦截器命中条件加 !exempt[sessionId]。
		//    - v0.8.5 (2026-09-12): 拦截点**前移**到 conversation.sendSession —— 只在 prompt 层拦截时,
		//      composer 的本地乐观 echo 已经建好且永不 retire, 表现为"会话里出现一条消息, 刷新后消失"
		//      (幽灵消息)。前移后命中即返回 {kind:"success"}, 根本不进 beginSubmission:
		//      会话里只剩「给 agent 的固定提示(转正确认)」+「任务 #N 已入队」横幅。
		//    - v0.8.3 修复 (2026-09-12): 0.1.2 的会话作用域槽 (conversation.input.left)
		//      只给 props.sessionId + useSession hook (旧代码读 props.session → 药丸 return null,
		//      且拦截器唯一兜底捕获一起失效 → 拦截器其实从未安装)。改为「sessions.list 订阅 +
		//      useSession/槽参捕获 + 短时重试」三路捕获, 并加诊断上报 (window.__dshTaskqueueDebug
		//      + /queue RPC diag → 服务端 log/taskqueue/offpeak-debug.log)。
		//      强制时段 (调试): 服务端 debug=peak|offpeak 时状态文案标注 [强制 …·debug]。
		// 2) 提示位置 (v0.8.0→v0.8.2): conversation.input.left 槽 (Full access 选择器右侧):
		//    - v0.8.2 触发器: 宽屏=完整文案药丸(button); 窄屏(≤640px)=26×26 小图标
		//      (同左边 access 收缩, 解决手机端药丸/状态词仍与左右元素重叠的问题);
		//      点击药丸/图标 → 弹层 (fixed + JS 摆位): 状态圆点+完整文案+说明 +
		//      高峰「本会话立即发送」豁免开关 (开关自 v0.8.2 起统一收进弹层);
		//    - 输入框边框随状态着色 (:has() 纯 CSS, 高峰琥珀 / 豁免绿; 平峰不着色);
		//      模式关闭不渲染任何触发器。
		// ═══════════════════════════════════════════════════════════════════

		var NS = "ui-taskqueue";
		var CARD_KEY = "taskqueue";

		// ---------- 文案 ----------
		var zh = {
			cardTitle: "任务队列",
			modeOn: "错峰出行模式",
			modeOnShort: "开: 高峰消息自动入队",
			on: "已开启",
			off: "已关闭",
			statusPeak: "当前高峰时段 · 消息将自动入队",
			statusOffpeak: "当前平峰时段 · 消息正常发送",
			statusLoading: "状态读取中…",
			statusError: "状态读取失败, 请刷新重试",
			// v0.8.6: 拦截器未安装 (宿主升级导致挂点变更等) —— "宁愿报错也不静默直发"；v0.12.0 文案精简
			statusMissing: "未安装 · 消息将直发",
			descErr: "拦截器未安装：高峰消息会直发（按高峰价），请强刷页面。",
			saved: "✓ 已保存",
			// ★v0.12.0 胶囊「七段文字」(用户 #A273 定案；配色见 --dsh-tq-c-* 与 [data-tq-text] 分支)
			//   · 「暂停中」逐字沿用 pillPaused「⏸ 暂停中」(用户令保留)；`data-tq-text` 键 = 不带符号的七段文字
			//   · 「未启用」附说明句 offHint；时段信息(高峰/平峰)不进胶囊(用户裁: 文字照预览稿)
			pillOff: "未启用",
			pillQueue: "会入队",
			pillPause: "会暂停",
			pillBoth: "入队+暂停",
			pillSend: "立即发送",
			pillErr: "拦截器未安装",
			pillPaused: "⏸ 正在停",
			offHint: "全局未开错峰与暂停（点击查看说明与开启方式）",
			// ★批二 c.1（用户 2026-11-24 最终口径）：颜色=「此刻这条消息会怎样」；不加第 8 色；
			//   时段未知时文字后加「?」；debug 强制在弹层/title 加额外文字；全关可点开只读引导。
			unknownSuffix: "?",
			descOff: "全局未开启错峰与暂停。到 设置 → 本地插件 → 任务队列 开启。",
			descUnknown: "时段未知，暂按高峰处理。",
			debugForced: "当前为 debug 强制 %s",
			whyLabel: "为什么这样显示：",
			// v0.8.2 弹层 (点击药丸/图标弹出的小菜单)；v0.12.0 文案精简: 每态只留一句
			descQueue: "高峰消息会先入队，到低谷价时段再执行。",
			descPause: "回合会在步骤边界停住，到低谷价时段继续。",
			descBoth: "高峰消息会入队，且回合会在步骤边界停住。",
			// ★批6 件A（`#A339` 用户令「把胶囊说明改正确，要能分清非高峰与已豁免」）：**说明按真实状态三分支**
			//   (i) 非高峰·未豁免 ⇒ `descSendOffpeak`（**严禁**再说"本会话已豁免错峰" —— 旧实现两种真实状态共用 `descSend` ⇒ 误述配置态）
			//   (ii) 高峰·已豁免 ⇒ `descSend`　(iii) 高峰·未豁免 ⇒ `descQueue`/`descPause`/`descBoth`（现状不动）
			//   ★**主文字（`pillSend`「立即发送」）与圆点一字不动** —— 本件只修"配置态被如实表述"（状态层），
			//     不动 `#A273` 的主文字口径（依据层）⇒ 两层不冲突（`#A339` 开头更正）。
			descSend: "此刻不会拦你：消息直接发送、不入队、不暂停。",
			descSendOffpeak: "此刻不会拦你：消息直接发送、不入队、不暂停。",
			descHold: "回合已停在步骤边界；到低谷或你操作后继续。",
			popRowLabel: "本会话立即发送",
			// v0.9.0: 高峰暂停 (全局子开关 + 本会话暂停态)
			pauseLabel: "自动暂停",
			pauseShort: "在步骤边界停住回合, 高峰停到低谷",
			autoPeakOn: "开（高峰默认）", autoOffpeakOff: "关（平峰默认）", autoManualOn: "开（手动）", autoManualOff: "关（手动）",
			pauseExemptRowLabel: "本会话暂停豁免",
			globalOffHint: "全局未开启，本豁免暂不生效",
			pausedWaiting: "⏸ 已暂停 · 等待你确认",
			pauseRowLabel: "高峰暂停 (全局)",
			pauseAria: "高峰暂停开关 (全局): 高峰期把正在跑的 agent 回合停在步骤边界",
			pauseBroken: "暂停闸门未安装（本版本宿主不兼容）",
			// ★批四（2026-11-24 用户要求）：派发消息开头/结尾可配置
			tplTitle: "派发消息文案",
			tplPrefixLabel: "开头",
			tplSuffixLabel: "结尾",
			tplPlaceholderHint: "可用占位符：{id} 任务编号、{content} 任务内容；未知占位符原样保留。开头不能为空，且 {content} 必须出现在开头或结尾至少一处；结尾留空 = 不追加。",
			tplSave: "保存文案",
			tplReset: "恢复默认",
			tplSaved: "✓ 文案已保存（下次派发生效）",
			tplLoadFailed: "文案读取失败",
			tplSaveFailed: "文案保存失败",
			// ★批4 ②（`#A294` 用户裁「可以常显 放到设置里面」）：时段口径行**常显** —— 健康时也显示，
			//   受限/未知时点名受限项 ＋「当前保守按高峰处理」（禁静默、禁"报 OK 而功能坏"）。
			tierOk: "时段口径：正常 · %s",
			tierDegraded: "时段未知，暂按高峰处理（受限：%s）",
			tierMissing: "时段未知，暂按高峰处理（时段判定库未接入：%s）",
			tierUnknown: "时段未知，暂按高峰处理（服务端未上报时段口径）",
			tierDetailPeak: "高峰 %s ⇒ 按当前配置拦截",
			tierDetailOffpeak: "平峰 ⇒ 此刻不会拦你",
			tierTableCovered: "%s 表已覆盖",
			// v0.12.0: 旧键 statusPaused 已删；同一句短文案按定案预览稿保留为 holdEta（见 docs/plugins/dsh-taskqueue.md）
			holdEta: "已暂停 · 预计 %s 继续",
			triggerAria: "错峰状态：%s（点击查看/操作）",
			ariaLabel: "错峰出行模式开关",
			switchAria: "本会话立即发送 (豁免错峰, 高峰照常发送)",
			switchAriaOn: "本会话已豁免错峰, 高峰照常发送 (点击恢复自动入队)"
		};
		var en = {
			cardTitle: "Task Queue",
			modeOn: "Off-peak travel mode",
			modeOnShort: "On: peak-hour messages auto-queue",
			on: "On",
			off: "Off",
			statusPeak: "Peak hours now · messages will be queued",
			statusOffpeak: "Off-peak now · messages send normally",
			statusLoading: "Loading status…",
			statusError: "Failed to load status, please refresh",
			// v0.8.6: interceptor not installed → fail loud instead of silently sending at peak price
			statusMissing: "Not installed · messages send directly",
			descErr: "Interceptor missing: peak-hour messages are sent directly (at peak price). Hard-reload the page.",
			saved: "✓ Saved",
			pillOff: "Disabled",
			pillQueue: "Will queue",
			pillPause: "Will pause",
			pillBoth: "Queue + pause",
			pillSend: "Send now",
			pillErr: "Interceptor missing",
			offHint: "Off-peak & auto-pause are both off (click for help)",
			unknownSuffix: "?",
			descOff: "Both global switches are off. Enable them in Settings → Local plugins → Task Queue.",
			descUnknown: "Hours unknown; treated as peak for now.",
			debugForced: "debug forced %s",
			whyLabel: "Why shown: ",
			descQueue: "Peak-hour messages are queued and run in the next off-peak window.",
			descPause: "The turn parks at the step boundary until the off-peak window.",
			descBoth: "Peak-hour messages are queued and the turn parks at the step boundary.",
			descSend: "Nothing will block you now: messages send directly (no queue, no pause).",
			descSendOffpeak: "Nothing will block you now: messages send directly (no queue, no pause).",
			descHold: "The turn is holding at the step boundary; it resumes at off-peak or on your action.",
			popRowLabel: "Send now in this session",
			// v0.9.0: peak-pause (global sub-switch + per-session paused state)
			pauseLabel: "Auto-pause",
			pauseShort: "Parks the turn at the step boundary during peak",
			autoPeakOn: "on (peak default)", autoOffpeakOff: "off (off-peak default)", autoManualOn: "on (manual)", autoManualOff: "off (manual)",
			pauseExemptRowLabel: "Skip pausing in this session",
			globalOffHint: "Global switch is off — this exemption has no effect yet",
			pausedWaiting: "⏸ Paused · waiting for you",
			pauseRowLabel: "Peak pause (global)",
			pauseAria: "Peak pause switch (global): park running agent turns at the step boundary during peak hours",
			pauseBroken: "Pause gate NOT installed (host incompatible)",
			tplTitle: "Dispatch message text",
			tplPrefixLabel: "Prefix",
			tplSuffixLabel: "Suffix",
			tplPlaceholderHint: "Placeholders: {id} task id, {content} task content; unknown placeholders are kept as-is. Prefix cannot be empty; {content} must appear in prefix or suffix; empty suffix = append nothing.",
			tplSave: "Save text",
			tplReset: "Restore defaults",
			tplSaved: "✓ Saved (applies on next dispatch)",
			tplLoadFailed: "Failed to load text",
			tplSaveFailed: "Failed to save text",
			tierOk: "Hours: normal · %s",
			tierDegraded: "Hours unknown; treated as peak for now (limited: %s)",
			tierMissing: "Hours unknown; treated as peak for now (cost-tier not loaded: %s)",
			tierUnknown: "Hours unknown; treated as peak for now (server reported nothing)",
			tierDetailPeak: "peak %s ⇒ blocked per current config",
			tierDetailOffpeak: "off-peak ⇒ nothing will block you now",
			tierTableCovered: "%s holiday table covers this year",
			pillPaused: "⏸ Holding",
			holdEta: "Paused · resumes ~%s",
			triggerAria: "Off-peak status: %s (click to view / act)",
			ariaLabel: "Off-peak travel mode toggle",
			switchAria: "Send immediately in this session (bypass peak queue)",
			switchAriaOn: "This session bypasses peak queue (click to restore auto-queue)"
		};

		// ---------- 样式 (沿用主题变量, 深浅主题均可读) ----------
		var INJECTED_CSS = [
			// 卡根不再自绘胶囊外壳 (契约 §5.1: border/background/border-radius/外层 padding 全部去掉;
			// 外壳与折叠由容器 quick-insert 的 .dsh-lp-card 提供, 卡内元素样式自主)
			".dsh-tq-card{flex-direction:column;gap:12px;display:flex;min-width:0}",
			// 本卡主题色 (business 蓝); 契约 §3.1/§5.4: 卡侧显式声明, 不依赖容器按 key 哈希分配
			".dsh-lp-card[data-lp-key=\"taskqueue\"]{--lp-accent:#4176e6}",
			".dsh-tq-mode{flex-direction:column;gap:6px;display:flex}",
			".dsh-tq-mode-row{align-items:center;gap:10px;display:flex}",
			".dsh-tq-mode-row b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;flex:1}",
			".dsh-tq-switch{box-sizing:border-box;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:2px;transition:background .15s,border-color .15s}",
			".dsh-tq-switch[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
			".dsh-tq-switch::after{content:\"\";display:block;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s}",
			".dsh-tq-switch[data-on=\"true\"]::after{transform:translateX(20px)}",
			".dsh-tq-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-status[data-state=\"peak\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".dsh-tq-status[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			// v0.8.6: 拦截器未安装 = 红字告警 (不再伪装成"平峰正常发送")
			".dsh-tq-status[data-state=\"broken\"]{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:600}",
			".dsh-tq-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}",
			// ★批四：派发文案编辑区（沿用卡内风格：无自绘外壳、只用主题 token）
			".dsh-tq-tpl{display:flex;flex-direction:column;gap:6px;min-width:0}",
			".dsh-tq-tpl-row{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dsh-tq-tpl-row>span{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-tpl textarea{box-sizing:border-box;width:100%;min-height:54px;resize:vertical;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.5}",
			".dsh-tq-tpl-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsh-tq-tpl-btn{box-sizing:border-box;height:26px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;cursor:pointer}",
			".dsh-tq-tpl-btn[disabled]{opacity:.6;cursor:not-allowed}",
			".dsh-tq-tpl-msg{font-size:12px;margin:0}",
			".dsh-tq-tpl-msg[data-state=\"ok\"]{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			".dsh-tq-tpl-msg[data-state=\"err\"]{color:var(--dsw-alias-state-error-primary,#ef4444)}",
			".dsh-tq-tpl-msg[data-state=\"warn\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			// v0.8.2 触发器 (Full access 行右侧, conversation.input.left):
			// 宽屏=完整文案药丸(.dsh-tq-pill, button) / 窄屏(≤640px)=26×26 图标(.dsh-tq-icon, 同 access 收缩);
			// 点击任一 → 弹层 .dsh-tq-pop (fixed, JS 摆位): 状态点+完整文案+说明 + 高峰豁免开关
			".dsh-tq-wrap{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0;line-height:1}",
			".dsh-tq-pill{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:26px;margin:0;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;flex:none;min-width:0;max-width:100%;overflow:hidden}",
			".dsh-tq-pill .dsh-tq-dot,.dsh-tq-icon .dsh-tq-dot,.dsh-tq-pop .dsh-tq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".dsh-tq-pill .dsh-tq-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			// ★v0.12.0 七色变量 (用户 #A273 定案; 每处 color-mix 前都有纯 hex(含 alpha) 兜底 ⇒ 改色时两处同步)
			":root{--dsh-tq-c-off:#8b9199;--dsh-tq-c-queue:#f59e0b;--dsh-tq-c-pause:#06b6d4;--dsh-tq-c-both:#ec4899;--dsh-tq-c-send:#22c55e;--dsh-tq-c-hold:#eab308;--dsh-tq-c-err:#ef4444}",
			// ★v0.12.0 胶囊/图标: 按「**七段文字**」(`data-tq-text`) 着色 —— 七段文字 ↔ 七色**一一对应** (与预览稿 §0 表逐字一致)
			".dsh-tq-pill[data-tq-text=\"未启用\"],.dsh-tq-icon[data-tq-text=\"未启用\"]{color:#8b9199;border-color:#8b919973;background:#8b91991f;color:var(--dsh-tq-c-off);border-color:color-mix(in srgb,var(--dsh-tq-c-off) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-off) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"会入队\"],.dsh-tq-icon[data-tq-text=\"会入队\"]{color:#f59e0b;border-color:#f59e0b73;background:#f59e0b1f;color:var(--dsh-tq-c-queue);border-color:color-mix(in srgb,var(--dsh-tq-c-queue) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-queue) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"会暂停\"],.dsh-tq-icon[data-tq-text=\"会暂停\"]{color:#06b6d4;border-color:#06b6d473;background:#06b6d41f;color:var(--dsh-tq-c-pause);border-color:color-mix(in srgb,var(--dsh-tq-c-pause) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-pause) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"入队+暂停\"],.dsh-tq-icon[data-tq-text=\"入队+暂停\"]{color:#ec4899;border-color:#ec489973;background:#ec48991f;color:var(--dsh-tq-c-both);border-color:color-mix(in srgb,var(--dsh-tq-c-both) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-both) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"立即发送\"],.dsh-tq-icon[data-tq-text=\"立即发送\"]{color:#22c55e;border-color:#22c55e73;background:#22c55e1f;color:var(--dsh-tq-c-send);border-color:color-mix(in srgb,var(--dsh-tq-c-send) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-send) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"正在停\"],.dsh-tq-icon[data-tq-text=\"正在停\"]{color:#eab308;border-color:#eab30873;background:#eab3081f;color:var(--dsh-tq-c-hold);border-color:color-mix(in srgb,var(--dsh-tq-c-hold) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-hold) 12%,transparent)}",
			".dsh-tq-pill[data-tq-text=\"拦截器未安装\"],.dsh-tq-icon[data-tq-text=\"拦截器未安装\"]{color:#ef4444;border-color:#ef444473;background:#ef44441f;color:var(--dsh-tq-c-err);border-color:color-mix(in srgb,var(--dsh-tq-c-err) 45%,transparent);background:color-mix(in srgb,var(--dsh-tq-c-err) 12%,transparent)}",
			// 「未启用」不可点 (也不弹层) —— 光标/透明度不给"可点"暗示
			".dsh-tq-pill[aria-disabled=\"true\"],.dsh-tq-icon[aria-disabled=\"true\"]{cursor:not-allowed;opacity:.9}",
			".dsh-tq-icon{display:none;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;margin:0;padding:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;flex:none}",
			"@media (max-width:640px){.dsh-tq-pill{display:none}.dsh-tq-icon{display:inline-flex}}",
			// 弹层内开关 (v0.8.2 起豁免开关统一收进弹层; 28×16 同 v0.8.0 药丸内小开关)
			".dsh-tq-sw{position:relative;flex:none;width:28px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:0;transition:background .15s,border-color .15s}",
			".dsh-tq-sw::after{content:\"\";position:absolute;top:1.5px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
			".dsh-tq-sw[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
			".dsh-tq-sw[data-on=\"true\"]::after{transform:translateX(12px)}",
			// 弹层 (fixed + JS 摆位; 点外/Esc 关闭)
			".dsh-tq-pop{display:none;box-sizing:border-box;position:fixed;z-index:9999;width:240px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);box-shadow:0 8px 32px rgba(0,0,0,.35);text-align:left}",
			".dsh-tq-pop.dsh-tq-pop-open{display:block}",
			".dsh-tq-pop-title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			// ★v0.12.0 弹层标题同色 (按七段文字)
			".dsh-tq-pop[data-tq-text=\"未启用\"] .dsh-tq-pop-title{color:#8b9199;color:var(--dsh-tq-c-off)}",
			".dsh-tq-pop[data-tq-text=\"会入队\"] .dsh-tq-pop-title{color:#f59e0b;color:var(--dsh-tq-c-queue)}",
			".dsh-tq-pop[data-tq-text=\"会暂停\"] .dsh-tq-pop-title{color:#06b6d4;color:var(--dsh-tq-c-pause)}",
			".dsh-tq-pop[data-tq-text=\"入队+暂停\"] .dsh-tq-pop-title{color:#ec4899;color:var(--dsh-tq-c-both)}",
			".dsh-tq-pop[data-tq-text=\"立即发送\"] .dsh-tq-pop-title{color:#22c55e;color:var(--dsh-tq-c-send)}",
			".dsh-tq-pop[data-tq-text=\"正在停\"] .dsh-tq-pop-title{color:#eab308;color:var(--dsh-tq-c-hold)}",
			".dsh-tq-pop[data-tq-text=\"拦截器未安装\"] .dsh-tq-pop-title{color:#ef4444;color:var(--dsh-tq-c-err)}",
			".dsh-tq-pop-desc{margin-top:6px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-pop-why{margin-top:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#6b7280);word-break:break-word}",
			".dsh-tq-pop-dbg{margin-top:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".dsh-tq-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-primary)}",
			// ★v0.12.0 输入框边框: **6 条分支**(按新键 `data-tq-text`) —— 橙/绿/红原样搬现役 55%/50%/55%(含 !important),
			//   新增 自动暂停/自动入队+暂停/暂停中 一律 55%; 「未启用」**不写分支 ⇒ 不染色**(用户 #A269/#A273 定案)。
			//   每条 color-mix 前都有纯 hex(含 alpha) 兜底。
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"会入队\"],.dsh-tq-icon[data-tq-text=\"会入队\"]){border-color:#f59e0b8c !important;border-color:color-mix(in srgb,var(--dsh-tq-c-queue) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"会暂停\"],.dsh-tq-icon[data-tq-text=\"会暂停\"]){border-color:#06b6d48c !important;border-color:color-mix(in srgb,var(--dsh-tq-c-pause) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"入队+暂停\"],.dsh-tq-icon[data-tq-text=\"入队+暂停\"]){border-color:#ec48998c !important;border-color:color-mix(in srgb,var(--dsh-tq-c-both) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"立即发送\"],.dsh-tq-icon[data-tq-text=\"立即发送\"]){border-color:#22c55e80 !important;border-color:color-mix(in srgb,var(--dsh-tq-c-send) 50%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"正在停\"],.dsh-tq-icon[data-tq-text=\"正在停\"]){border-color:#eab3088c !important;border-color:color-mix(in srgb,var(--dsh-tq-c-hold) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-tq-text=\"拦截器未安装\"],.dsh-tq-icon[data-tq-text=\"拦截器未安装\"]){border-color:#ef44448c !important;border-color:color-mix(in srgb,var(--dsh-tq-c-err) 55%,transparent) !important}",
			// ★`#A277`：**不写** `data-tq-prop` 兜底（不接受往宿主自有元素写属性）；已知降级 = Firefox <121 边框不上色
		].join("");

		function injectCss() {
			try {
				if (document.getElementById("dsh-taskqueue-css")) return;
				var st = document.createElement("style");
				st.id = "dsh-taskqueue-css";
				st.textContent = INJECTED_CSS;
				(document.head || document.documentElement).appendChild(st);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 控制器: /queue RPC (mode.get/mode.set/mode.exempt/mode.debug/diag) + store ----------
		// 状态缓存: 高峰判定服务端 30min 缓存窗口, 客户端 UI 侧缓存 60s 足够 (时段边界最多延迟 1 分钟)。
		// v0.8.3: 拦截判定单独用更短的 TTL (PROMPT_TTL_MS) —— 强制时段/豁免开关切换后要在几秒内生效,
		//   否则"刚 /queue debug peak 就发消息"会按旧的平峰状态直发 (用户以为没生效)。
		//   UI 侧 15s 轮询刷新, 让药丸/设置卡也能较快跟随强制状态。
		var STATUS_TTL_MS = 60 * 1000;
		var PROMPT_TTL_MS = 5 * 1000;
		var UI_POLL_MS = 15 * 1000;

		/* ★`#A59`：通道双路 —— 先 `/api/queue/<ep>`（0.2.2），失败回落 `/queue/<ep>`；模式缓存＋诊断锚。 */
		var _queueFaceMode = null;
		function faceRpc(rpc, chName, endpoint, payload) {
			var callApi = function () { return rpc.call("/api", chName + "/" + endpoint, payload || {}); };
			var callLegacy = function () { return rpc.call("/" + chName, endpoint, payload || {}); };
			var p = _queueFaceMode === "api" ? callApi() : _queueFaceMode === "legacy" ? callLegacy()
				: callApi().then(function (r) { _queueFaceMode = "api"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { queue: "api" }); } catch (e) {} return r; },
					function () { _queueFaceMode = "legacy"; try { window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { queue: "legacy" }); } catch (e) {} return callLegacy(); });
			return Promise.resolve(p);
		}

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, enabled: false, peak: false, windowSource: "", peakSource: "", debug: "auto", exempt: {}, pause: true, pauseManual: null, pauseExempt: {}, paused: { count: 0, sessions: [] }, pauseInstalled: true });
			var cached = null; // { at, value }
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "queue", endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			/** v0.8.3 诊断上报: 拦截器/药丸在浏览器里, 静默失效时只能靠它远程取证 (服务端落 log/taskqueue/) */
			function report(event, detail) {
				try {
					return void call("diag", { event: event, detail: detail || {} });
				} catch (e) { /* 诊断失败绝不影响功能 */ }
			}
			/** v0.9.0: paused 摘要归一 (服务端 mode.get 新增字段; 老服务端没有 ⇒ 空摘要) */
			function pausedOf(value) {
				var p = value && value.paused;
				if (!p || typeof p !== "object" || !Array.isArray(p.sessions)) return { count: 0, sessions: [] };
				return { count: typeof p.count === "number" ? p.count : p.sessions.length, sessions: p.sessions };
			}
			function publish(value) {
				store.set({
					status: "ready",
					loaded: true,
					enabled: value.enabled === true,
					peak: value.peak === true,
					windowSource: String(value.windowSource || ""),
					peakSource: String(value.peakSource || value.windowSource || ""),
					debug: String(value.debug || "auto"),
					exempt: (value.exempt && typeof value.exempt === "object") ? value.exempt : {},
					pause: value.pause !== false,
					pauseManual: (value.pauseManual === true || value.pauseManual === false) ? value.pauseManual : null,
					pauseExempt: (value.pauseExempt && typeof value.pauseExempt === "object") ? value.pauseExempt : {},
					pauseInstalled: value.pauseInstalled !== false, // v0.9.0: 闸门自检失败 ⇒ 设置卡加一句可见提示
					paused: pausedOf(value),
					// ★批4 T33: 读 `costTier`（服务端 `modeValue()` 自 v0.11.0 已给）⇒ 设置卡如实显示降级
					costTier: (value.costTier && typeof value.costTier === "object") ? value.costTier : null
				});
			}
			function refresh(force, ttlMs) {
				var ttl = typeof ttlMs === "number" ? ttlMs : STATUS_TTL_MS;
				if (!force && cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
				return call("mode.get", {}).then(function (res) {
					if (res.ok) {
						cached = { at: Date.now(), value: res.value };
						publish(res.value);
						return res.value;
					}
					store.set({ status: "error", loaded: true, enabled: false, peak: false, windowSource: "", peakSource: "", debug: "auto", exempt: {}, pause: true, pauseManual: null, pauseExempt: {}, paused: { count: 0, sessions: [] }, pauseInstalled: true, costTier: null });
					return null;
				});
			}
			refresh(true);
			// 周期性兜底刷新 (开关状态变化/时段切换/强制时段切换), 不阻塞任何操作
			// ★批6 件B（`#A339` 用户令「开关滞后可以修」）：**轮询的缓存 TTL 必须 ≤ 间隔的一半**
			//   病根（批5 VM 实测）：原传 `UI_POLL_MS`（**与间隔同值 15s**）⇒ tick 到达时缓存"还差几十 ms 才算过期"
			//   ⇒ 该次**直接吃缓存、不发请求** ⇒ 实际约每 2 tick 才真取数 ⇒ **静置显示滞后 ≈30s**。
			//   现改为 `UI_POLL_MS / 2` ⇒ 每 tick 必过期必取数 ⇒ **静置滞后上界 = 1 个 tick（15s）**。
			//   （如实登记代价：RPC 频次由"实际约 30s 一次"回到**设计值 15s 一次**；单次 `mode.get` 载荷极小。）
			setInterval(function () { void refresh(false, UI_POLL_MS / 2); }, UI_POLL_MS);
			/** v0.9.0 降级: RPC 失败 ⇒ 回退 UI 到服务端真实状态 (不以乐观值骗用户) */
			function resync() {
				return refresh(true).then(function () { return null; }, function () { return null; });
			}
			function setter(endpoint, payload, res) {
				if (res && res.ok) {
					cached = { at: Date.now(), value: res.value };
					publish(res.value);
					return res;
				}
				return resync().then(function () { return res; }); // 失败 ⇒ 回退到服务端真实状态
			}
			return {
				store: store,
				report: report,
				refresh: refresh,
				// 拦截判定用短 TTL (v0.8.3): 强制时段/豁免切换 ≤5s 生效, 避免"以为没生效"
				getStatus: function () { return refresh(false, PROMPT_TTL_MS); },
				setEnabled: function (enabled) {
					return call("mode.set", { enabled: enabled === true }).then(function (res) { return setter("mode.set", null, res); });
				},
				// v0.9.0 高峰暂停子开关 (全局): mode.set 只带 pause ⇒ 服务端不动其它字段
				setPause: function (pause) {
					return call("mode.set", { pause: pause === true }).then(function (res) { return setter("mode.set", null, res); });
				},
				// v0.10.0 S2: 本会话暂停豁免 (同端点 mode.exempt 的 pauseExempt 载荷)
				setPauseExempt: function (sessionId, pauseExempt) {
					return call("mode.exempt", { sessionId: sessionId, pauseExempt: pauseExempt === true }).then(function (res) { return setter("mode.exempt", null, res); });
				},
				setExempt: function (sessionId, exempt) {
					return call("mode.exempt", { sessionId: sessionId, exempt: exempt === true }).then(function (res) { return setter("mode.exempt", null, res); });
				},
				addTask: function (content, sessionId) {
					return call("add", { content: content, sessionId: sessionId });
				},
				// ★批四：派发消息文案配置（服务端 /queue config.get|config.set；走既有 fetch 面，无需重启）
				getDispatchConfig: function () { return call("config.get", {}); },
				setDispatchConfig: function (patch) { return call("config.set", patch || {}); }
			};
		}

		// ---------- 拦截: 0.1.2 Session.prompt (2026-09-11 P3 适配 / 2026-09-12 修复) ----------
		// 0.1.2 起 connection 服务只剩 { isLoopback, generation, state, rpc, reconnect,
		// registerGenerationSource } —— **`connection.api` 已不存在**，旧代码
		// `connection.api.sessions.prompt` 包装恒不执行 (guard 直接 return) → 错峰拦截静默失效。
		// 真实发送链路: composer → 会话对象 `prompt(content, mode, signal, requestId)`
		//   (content = [{type:"text",text}]|[{type:"image",...}]; 返回 { ok, value:{accepted} } 或 { ok:false, error })。
		// 类本身未导出 ⇒ 用「已捕获实例的 prototype」包装 (WeakSet 去重, 一次包装覆盖所有会话)。
		//
		// ⚠️ 2026-09-12 修复: P3 的两条捕获路径在 0.1.2 下**都拿不到会话**, 拦截器从未安装且完全静默:
		//   ① apply 发生在页面启动早期, `sessions.list` 快照的 current 仍是 undefined (seed 落空);
		//   ② 唯一兜底 = 药丸槽 props.session —— 但 0.1.2 的 session 作用域槽只给
		//      `props.sessionId` + `useSession` hook (源码: renderSlot("conversation.input.left", {})),
		//      老代码读 props.session 恒 undefined → 药丸 return null → 兜底也没了。
		//   现在三条并行捕获路径 (任一成功即完成原型包装), 且每一步都上报诊断:
		//     a) 订阅 `sessions.list` (列表就绪/切换会话时补挂, 解决页面早期 current 为空);
		//     b) 药丸渲染时用 useSession hook / 槽 inject 工厂第一参(会话 id) 捕获实例;
		//     c) `window.__dshTaskqueueDebug` + /queue RPC diag (无浏览器控制台也能远程确认是否装上)。
		var patchedPromptProtos = new WeakSet();
		// controller 绑定键: 放在被包装原型的标记属性上 (每次 apply 重新指向当前 controller,
		// 避免插件热重载/重复 apply 后旧 controller 的 60s 状态缓存残留)
		var CTL_KEY = "__dshTaskqueueOffpeakCtl";
		var captureSessionFn = null; // 由 installPromptInterceptor 赋值; 药丸/槽位渲染时把会话实例喂进来
		var lastPillDiagKey = "";
		// 诊断状态 (供 CDP/E2E 与用户自查: window.__dshTaskqueueDebug)
		// ★批二 c.2：**会话级** installed 如实上报（页面级 installed 不再掩盖单会话失败）：
		//   `sessions[sid] === true` = 该会话的 prompt 层拦截已挂上；`=== false` = 拿到 live Session 但没有 prompt（宿主不兼容）；
		//   缺失 = 未知（尚未拿到该会话实例），UI 不得据此报"未安装"。
		var debugState = { version: "0.12.0", installed: false, sendPatched: false, sessionId: null, lastEvent: null, lastAt: 0, sessions: Object.create(null) };
		try { window.__dshTaskqueueDebug = debugState; } catch (e) { /* 非浏览器环境忽略 */ }
		/** v0.8.6: 错峰拦截是否"确定未安装" —— 渲染期读取 (不缓存: 拦截器是异步补挂的)。
		 *  fail-loud 语义: 未安装 = 高峰消息会直发 (按高峰价), UI 必须显示红字告警,
		 *  绝不伪装成"平峰 · 正常发送" (历史三次静默失效: 坑 14/16/22)。 */
		function interceptorMissing() {
			try { return debugState.installed !== true; } catch (e) { return false; }
		}
		/** 页面级主拦截是否可用（sendSession 是 composer 主路径；prompt 层是其兜底） */
		function pageInterceptorOk() {
			try { return debugState.sendPatched === true || debugState.installed === true; } catch (e) { return false; }
		}
		/** 会话级 installed：true/false=已定案；null=未知（尚未捕获到该会话 live 实例，如实标未知，不冒充失败） */
		function sessionInterceptorState(sessionId) {
			try {
				if (!sessionId) return null;
				var k = String(sessionId);
				return Object.prototype.hasOwnProperty.call(debugState.sessions, k) ? debugState.sessions[k] === true : null;
			} catch (e) { return null; }
		}
		/** c.4 诊断去噪：patch.no-prompt 同一原型只记首条 + 每 200 条记一次计数汇总；session.captured 每会话 60s 限流 */
		var PATCH_FAIL = { protos: new WeakMap() };
		function noteNoPrompt(controller, why, proto) {
			var pname = proto ? String((proto.constructor && proto.constructor.name) || "?") : "null";
			var n = 0;
			try { n = (proto && PATCH_FAIL.protos.get(proto)) || 0; } catch (e) { n = 0; }
			n += 1;
			try { if (proto) PATCH_FAIL.protos.set(proto, n); } catch (e) { /* ignore */ }
			if (n === 1) diag(controller, "patch.no-prompt", { why: why, proto: pname, first: true });
			else if (n % 200 === 0) diag(controller, "patch.no-prompt.suppressed", { why: why, proto: pname, count: n });
		}
		var CAPTURE_DIAG = { at: Object.create(null), last: Object.create(null) };
		var CAPTURE_DIAG_TTL_MS = 60 * 1000;
		function noteSessionCaptured(controller, sessionId, installed) {
			try {
				var sid = String(sessionId || "");
				if (!sid) return;
				var now = Date.now();
				var changed = CAPTURE_DIAG.last[sid] !== installed;
				var stale = now - (CAPTURE_DIAG.at[sid] || 0) >= CAPTURE_DIAG_TTL_MS;
				if (!changed && !stale) return;
				CAPTURE_DIAG.at[sid] = now;
				CAPTURE_DIAG.last[sid] = installed;
				diag(controller, "session.captured", { sessionId: sid, installed: installed === true });
			} catch (e) { /* ignore */ }
		}
		function diag(controller, event, detail) {
			debugState.lastEvent = event;
			debugState.lastAt = Date.now();
			debugState.detail = detail || {};
			try {
				if (typeof controller === "function") controller(event, detail || {});
				else if (controller && typeof controller.report === "function") controller.report(event, detail || {});
			} catch (e) { /* 诊断不影响功能 */ }
		}
		/** 取会话实例: sessions 服务优先 (不依赖是否已渲染), 兜底用槽位捕获到的实例 */
		function acquireSession(ctx, sessionId, fallback) {
			var sessions = ctx.get("sessions");
			if (sessions && typeof sessions.binding === "function" && sessionId) {
				try {
					var binding = sessions.binding(sessionId);
					if (binding && binding.session) return binding.session;
				} catch (e) { /* 未 scoped/未列出 → 走兜底 */ }
			}
			return fallback || null;
		}
		/** ★批二 c.2: 是否 live Session 对象（自身或原型带 prompt 方法；快照对象不算） */
		function isLiveSessionObject(obj) {
			try {
				if (!obj || typeof obj !== "object") return false;
				if (typeof obj.prompt === "function") return true;
				var proto = Object.getPrototypeOf(obj);
				return !!(proto && typeof proto.prompt === "function");
			} catch (e) { return false; }
		}
		/**
		 * 包装会话实例原型上的 prompt。返回 true 表示本次成功包装 (或已包装)。
		 * 原方法签名 (0.1.2): (content, mode, signal, requestId)，用 variadic 转发保证不过期。
		 */
		function patchSessionPrompt(controller, session, why) {
			if (!session) return false;
			var proto = Object.getPrototypeOf(session);
			// ★批二 c.2：**只接受 live Session 实例**（原型上有 prompt）；快照/合成对象（useSession 返回值、
			//   seed 的 `{id}` 兜底）一律不包装、不冒充失败。
			if (!proto || typeof proto.prompt !== "function") {
				// c.4: 同原型只记首条（meta: 快照对象 proto=Object.prototype；宿主缺陷实例另计）
				noteNoPrompt(controller, why, proto);
				// c.2: 只有"看起来确为会话对象"（有 sessionId/id 且原型不是 Object.prototype）才判定为会话级失败；
				//   快照对象无法判定 ⇒ 保持未知，不冒充失败。
				var sidLike = (session && (session.sessionId || session.id)) || null;
				if (sidLike && proto && proto !== Object.prototype) {
					debugState.sessions[String(sidLike)] = false;
					noteSessionCaptured(controller, sidLike, false);
				}
				return false;
			}
			// 同一原型只包装一次; controller 绑定放在原型标记属性上, 每次 apply 重新指向
			// (插件热重载/重复 apply 时旧 controller 的 60s 状态缓存不会残留)
			if (!patchedPromptProtos.has(proto)) {
				var origPrompt = proto.prompt;
				proto.prompt = async function (content, mode, signal, requestId) {
					var ctl = this[CTL_KEY];
					try {
						// 只拦截: 开关开 + 高峰 + 纯文本 (无图片) + 非空 + 本会话未豁免
						var status = ctl ? await ctl.getStatus() : null;
						if (status && status.enabled === true && status.peak === true) {
							var parts = Array.isArray(content) ? content : [];
							var hasImage = parts.some(function (p) { return p && p.type === "image"; });
							var text = parts.filter(function (p) { return p && p.type === "text" && typeof p.text === "string"; })
								.map(function (p) { return p.text; }).join("").trim();
							var sessionId = this && (this.sessionId || this.id);
							if (!hasImage && text !== "" && sessionId) {
								// v0.8.0: 豁免会话 (服务端持久化 exempt map) 高峰照常发送
								var exempt = !!(status.exempt && status.exempt[sessionId] === true);
								if (!exempt) {
									var res = await ctl.addTask(text, sessionId);
									if (res && res.ok) {
										// engaged = 服务端把该 blank 会话转正了 (发了确认 turn, 防 GUI 复用新会话导致串台)
										diag(ctl, "hit.queued", { sessionId: sessionId, chars: text.length, debug: status.debug, taskId: res.value && res.value.id, engaged: !!(res.value && res.value.engaged) });
										// 模拟 prompt 成功 (composer 清空输入框; 队列横幅由服务端注入, 消息不进 LLM)
										return { ok: true, value: { accepted: true } };
									}
									diag(ctl, "hit.add-failed", { sessionId: sessionId, error: (res && res.error) || null });
									// 入队失败 → 不静默吞消息, 回退正常发送
								}
							}
						}
					} catch (e) { diag(ctl, "hit.error", { error: String((e && e.message) || e) }); }
					return origPrompt.call(this, content, mode, signal, requestId);
				};
				patchedPromptProtos.add(proto);
				diag(controller, "interceptor.installed", { why: why });
			}
			try { proto[CTL_KEY] = controller; } catch (e) { return false; }
			var sid = (session && (session.sessionId || session.id)) || null;
			if (sid) debugState.sessions[String(sid)] = true;
			return true;
		}
		/**
		 * v0.8.5: 在 **conversation.sendSession** 上再加一层拦截, 目的是"根本别建本地乐观 echo"。
		 * 背景: composer 提交 = sink → `conversation.sendSession(session, text, imageIds, mode, signal)`
		 *   → `session.beginSubmission(...)`(同步插入一条**本地 submitted echo**, 即 GUI 里"发出去了"的
		 *   那条消息) → `session.prompt(...)`。只在 prompt 层拦截时, echo 已经建好了: 我们返回模拟成功,
		 *   而这条消息永远不会被宿主回执 → echo **永不 retire**, 表现为"聊天里出现一条消息, 刷新后消失"
		 *   (用户实测反馈)。
		 * 这里前移到 sendSession: 命中错峰 → 调 RPC 入队 + 直接返回 `{kind:"success"}`(composer 清空
		 *   输入框、草稿/图片按成功处理), **完全不进入 beginSubmission** ⇒ 不产生任何幽灵消息;
		 *   会话里只剩「给 agent 的固定提示(转正确认 turn)」+「任务 #N 已入队」横幅。
		 * 兼容性: 只在"开关开 + 高峰 + 无图片 + 文本非空 + 本会话未豁免"时短路, 其余情况**原样转发**
		 *   给官方实现 (含图片序列化/回执 retirement 逻辑一行未动); session.prompt 那层包装保留作兜底
		 *   (programmatic `conversation.send()`、子会话等路径仍走 prompt)。
		 */
		var patchedSendProtos = new WeakSet();
		function patchConversationSendSession(controller, conversation) {
			if (!conversation) return false;
			var proto = Object.getPrototypeOf(conversation);
			if (!proto) return false;
			if (!patchedSendProtos.has(proto)) {
				var origSend = proto.sendSession;
				if (typeof origSend !== "function") {
					diag(controller, "patch.no-sendSession", { proto: String((proto.constructor && proto.constructor.name) || "?") });
					return false;
				}
				// ★批二 c.3：第六参 `accept` 属宿主 composer 合同的一部分 —— 包装后必须**逐参透传**，
				//   否则宿主升级依赖第 6 参的路径（如附件/回执）会静默丢参。
				proto.sendSession = async function (session, text, imageIds, mode, signal, accept) {
					var ctl = this[CTL_KEY] || controller;
					try {
						var ids = Array.isArray(imageIds) ? imageIds : [];
						var body = typeof text === "string" ? text.trim() : "";
						if (ids.length === 0 && body !== "") {
							var status = ctl ? await ctl.getStatus() : null;
							if (status && status.enabled === true && status.peak === true) {
								var sessionId = session && (session.sessionId || session.id);
								var exempt = !!(status.exempt && sessionId && status.exempt[sessionId] === true);
								if (sessionId && !exempt) {
									var res = await ctl.addTask(body, sessionId);
									if (res && res.ok) {
										diag(ctl, "hit.queued", {
											sessionId: sessionId, chars: body.length, debug: status.debug,
											taskId: res.value && res.value.id, engaged: !!(res.value && res.value.engaged),
											via: "sendSession" // v0.8.5: 未建本地 echo (无幽灵消息)
										});
										return { kind: "success" }; // 官方 composer 只判 kind
									}
									diag(ctl, "hit.add-failed", { sessionId: sessionId, via: "sendSession", error: (res && res.error) || null });
								}
							}
						}
					} catch (e) { diag(ctl, "hit.error", { via: "sendSession", error: String((e && e.message) || e) }); }
					return origSend.call(this, session, text, imageIds, mode, signal, accept);
				};
				patchedSendProtos.add(proto);
				try { debugState.conversationRef = conversation; } catch (e) { /* 调试引用失败忽略 */ }
				diag(controller, "interceptor.sendSession", { why: "patched" });
			}
			try { proto[CTL_KEY] = controller; } catch (e) { return false; }
			return true;
		}

		function installPromptInterceptor(ctx, controller) {
			// v0.8.5: 第一优先 —— 包装 conversation.sendSession (composer 的真实入口, 在建本地 echo 之前)
			try {
				var conversation = ctx.get("conversation");
				// 调试/E2E 引用: 无论包装成败都暴露 (便于真浏览器测试直接走官方 composer 入口)
				try { if (conversation) debugState.conversationRef = conversation; } catch (e) { /* ignore */ }
				var okSend = patchConversationSendSession(controller, conversation);
				debugState.sendPatched = okSend === true;
				diag(controller, "apply.conversation", { hasConversation: !!conversation, sendSessionPatched: debugState.sendPatched });
			} catch (e) { diag(controller, "patch.sendSession-error", { error: String((e && e.message) || e) }); }
			// 供药丸/槽位在渲染时把会话实例喂进来 (渲染必然早于发送)
			captureSessionFn = function (s) {
				if (!s) return false;
				var sid = s.sessionId || s.id || null;
				// ★批二 c.2：优先 sessions.binding 反查 live 实例；反查不到时**只有对象本身确为 live Session**
				//   （自身/原型带 prompt）才接受；快照对象直接丢弃（不再当兜底包装）。
				var inst = acquireSession(ctx, sid, null);
				if (!inst && isLiveSessionObject(s)) inst = s;
				if (!inst) {
					// 未知 ≠ 失败：不写 sessions[sid]=false；但按 c.4 对"非 live 对象"记首条+计数（不再每次刷屏）
					var snapProto = null;
					try { snapProto = s && typeof s === "object" ? Object.getPrototypeOf(s) : null; } catch (e) { snapProto = null; }
					noteNoPrompt(controller, "capture-non-live", snapProto);
					if (sid && debugState.sessionId !== sid) debugState.sessionId = sid;
					return false;
				}
				var ok = patchSessionPrompt(controller, inst, "capture");
				if (ok) { debugState.installed = true; debugState.sessionRef = inst; }
				if (sid) {
					debugState.sessionId = sid;
					noteSessionCaptured(controller, sid, ok);
				}
				return ok;
			};
			var sessions = null;
			try { sessions = ctx.get("sessions"); } catch (e) { sessions = null; }
			diag(controller, "apply", {
				hasSessions: !!sessions,
				hasList: !!(sessions && sessions.list),
				hasBinding: !!(sessions && typeof sessions.binding === "function")
			});
			// a) 立即尝试 seed + 订阅会话列表 (current 出现/切换会话时补挂)
			function seed() {
				try {
					var snap = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
					var id = snap && (snap.current || (snap.ids && snap.ids[0]));
					if (!id) return;
					// ★批二 c.2：seed 只用 live 实例（sessions.binding 反查），不再喂 `{id}` 合成对象
					var live = acquireSession(ctx, id, null);
					if (live) captureSessionFn(live);
				} catch (e) { diag(controller, "seed.error", { error: String((e && e.message) || e) }); }
			}
			seed();
			if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
				try {
					var unsub = sessions.list.subscribe(seed);
					ctx.effect(function () {
						return function () { try { unsub(); } catch (e) { /* 卸载失败忽略 */ } };
					}, "ui-taskqueue: 错峰拦截器补挂 (sessions.list 订阅)");
				} catch (e) { diag(controller, "subscribe.error", { error: String((e && e.message) || e) }); }
			}
			// c) 兜底: 订阅也没拿到时, 短时重试 (会话列表/作用域就绪有延迟)
			//    v0.8.5: 同时重试 conversation.sendSession 包装 (该服务若在本插件 apply 时尚未就绪)
			//    整段 try/catch: 定时器不可用/异常绝不能让 apply 中断 (否则药丸与设置卡都不注册)
			try {
				// ⚠️ 实测: `conversation` 服务在 apply 时**通常还没就绪** (cordis 只按 exports.inject
				//    ["slots","locale","connection","sessions"] 门控 apply), sendSession 包装实际是靠这里
				//    的补挂完成的 —— 因此窗口给足 2 分钟 (60 次), 只在两者都完成时提前退出。
				var tries = 0;
				var timer = setInterval(function () {
					tries += 1;
					if (debugState.installed && debugState.sendPatched) { clearInterval(timer); return; }
					if (tries > 60) {
						clearInterval(timer);
						if (!debugState.sendPatched) diag(controller, "sendSession.give-up", { tries: tries - 1 });
						return;
					}
					seed();
					try {
						var convNow = ctx.get("conversation");
						if (convNow) {
							try { debugState.conversationRef = convNow; } catch (e) { /* ignore */ }
							if (!debugState.sendPatched) debugState.sendPatched = patchConversationSendSession(controller, convNow);
						}
					} catch (e) { /* 下轮再试 */ }
				}, 2000);
				ctx.effect(function () { return function () { clearInterval(timer); }; }, "ui-taskqueue: 错峰拦截器安装重试");
			} catch (e) { diag(controller, "retry.unavailable", { error: String((e && e.message) || e) }); }
		}

		// ---------- ★批二 c.1 胶囊状态机（纯函数；用户 2026-11-24 最终口径） ----------
		// 颜色语义 = 「此刻这条消息会怎样」：会入队=橙 / 会暂停=青 / 两者=玫红 / 不会拦=绿 / 正在停=黄 / 拦截器未安装=红 / 未启用=灰。
		// 不加第 8 色：时段未知（costTier 未就绪/降级）时**沿用保守高峰的行为色**，文字后加「?」，弹层写「时段未知，暂按高峰处理」。
		// 全关（未启用）可点开只读弹层（引导去设置）；debug 强制时段在弹层与 title 加额外文字。
		// 优先级：未安装 > 正在停 > 全关(未启用) > 行为色（会入队/会暂停/两者/立即发送），未知只作行为文字后缀。
		var PILL_DATA_TEXT = { off: "未启用", queue: "会入队", pause: "会暂停", both: "入队+暂停", send: "立即发送", hold: "正在停", err: "拦截器未安装" };
		var PILL_LABEL_KEY = { off: "pillOff", queue: "pillQueue", pause: "pillPause", both: "pillBoth", send: "pillSend", hold: "pillPaused", err: "pillErr" };
		var PILL_DESC_KEY = { off: "descOff", queue: "descQueue", pause: "descPause", both: "descBoth", send: "descSend", hold: "descHold", err: "descErr" };
		var PILL_DATA_STATE = { err: "broken", hold: "paused", send: "exempt", queue: "peak", pause: "peak", both: "peak", off: "offpeak" };
		/**
		 * @param {{state:object, sessionId:string|null, sessionInstalled:boolean|null, pageInstalled:boolean}} input
		 * @param {function(string):string} t 词典
		 * @returns 视图模型（组件/判据共用；render=false ⇒ 胶囊不渲染）
		 */
		function computePillView(input, t) {
			var state = (input && input.state) || {};
			var sessionId = (input && input.sessionId) || null;
			var ready = !!(state.loaded && state.status === "ready");
			var g1 = state.enabled === true;
			var g2 = state.pause !== false;
			var peak = state.peak === true;
			var debug = String(state.debug || "auto");
			var debugForced = debug !== "auto";
			var tierOk = !!(state.costTier && state.costTier.loaded === true && state.costTier.degraded !== true);
			var unknown = !tierOk; // 时段未知 ⇒ 服务端已按保守高峰给 peak=true；文字加 ?，不新增颜色
			var s1 = !!(sessionId && state.exempt && state.exempt[sessionId] === true);
			var s2 = !!(sessionId && state.pauseExempt && state.pauseExempt[sessionId] === true);
			var pausedRec = null;
			if (ready && sessionId && state.paused && Array.isArray(state.paused.sessions)) {
				for (var i = 0; i < state.paused.sessions.length; i++) { var rec = state.paused.sessions[i]; if (rec && rec.sessionId === sessionId) { pausedRec = rec; break; } }
			}
			var paused = !!pausedRec;
			var sessionInstalled = (input && input.sessionInstalled);
			var pageInstalled = !(input && input.pageInstalled === false);
			// 拦截器缺失：页面级主路径不可用，或**本会话** prompt 层已定案为失败；未知不冒充失败（c.2）
			var interceptorBad = g1 && (sessionInstalled === false || (sessionInstalled === null && !pageInstalled));
			var willQueue = g1 && peak && !s1;   // 与批一服务端/客户端拦截器同口径（enabled && peak && !exempt）
			var willPause = g2 && !s1 && !s2;    // 与批一 pauseGate 同口径（S1/S2 均 skip）
			var view = {
				render: false, key: "off", dataText: PILL_DATA_TEXT.off, dataState: "offpeak",
				text: "", suffix: "", textKey: "pillOff", descKey: "descOff", descText: "",
				clickable: true, readOnly: false, debugText: null, whyText: "",
				pausedText: null, pausedRec: pausedRec,
				s1: { on: s1, disabled: !g1, hint: g1 ? null : "globalOffHint" },
				s2: { on: s2, disabled: !g2, hint: g2 ? null : "globalOffHint" },
				titleText: "", ariaText: ""
			};
			if (!ready || !sessionId) return view;
			view.render = true;
			var behaviorKey = (willQueue && willPause) ? "both" : willQueue ? "queue" : willPause ? "pause" : "send";
			if (interceptorBad) view.key = "err";
			else if (paused) view.key = "hold";
			else if (!g1 && !g2) view.key = "off";
			else view.key = behaviorKey;
			view.dataText = PILL_DATA_TEXT[view.key];
			view.dataState = PILL_DATA_STATE[view.key];
			view.textKey = PILL_LABEL_KEY[view.key];
			view.descKey = PILL_DESC_KEY[view.key];
			view.readOnly = view.key === "off";
			if (view.key !== "off" && view.key !== "hold" && view.key !== "err" && unknown) view.suffix = t("unknownSuffix");
			var baseText = t(view.textKey);
			view.text = baseText + view.suffix;
			view.labelText = view.key === "hold" ? t("pillPaused") : view.text;
			view.descText = t(view.descKey) + (view.key !== "off" && view.key !== "hold" && view.key !== "err" && unknown ? " " + t("descUnknown") : "");
			if (debugForced) view.debugText = t("debugForced").replace("%s", debug === "peak" ? "peak" : debug === "offpeak" ? "offpeak" : debug);
			if (pausedRec) {
				var hm = "";
				try { if (pausedRec.nextOffpeakAt) { var d = new Date(pausedRec.nextOffpeakAt); if (!isNaN(d.getTime())) hm = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16); } } catch (e) { hm = ""; }
				view.pausedText = pausedRec.mode === "offpeak" ? t("pausedWaiting") : (hm ? t("holdEta").replace("%s", hm) : t("pausedWaiting"));
			}
			var why = t("whyLabel") + "G1 " + (g1 ? "开" : "关") + " · G2 " + (g2 ? "开" : "关")
				+ " ｜ 时段 " + (peak ? "高峰" : "非高峰") + (debugForced ? "（debug 强制 " + debug + "）" : "")
				+ (unknown ? "（时段未知，暂按高峰处理）" : "")
				+ " ｜ 本会话 S1 " + (s1 ? "开" : "关") + " · S2 " + (s2 ? "开" : "关");
			view.whyText = why;
			view.titleText = view.labelText + (debugForced ? " · " + view.debugText : "") + " · " + why;
			view.ariaText = view.readOnly ? view.labelText + " · " + t("offHint") : t("triggerAria").replace("%s", view.labelText);
			return view;
		}

		// ---------- 设置卡: 错峰出行模式开关 + 状态 ----------
		function TaskQueueCard(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			var loaded = !!state.loaded;
			var busy = React.useRef(false);
			var [flash, setFlash] = React.useState(false);
			// v0.9.0: 高峰暂停子开关 (全局, 与胶囊弹层同一个 RPC mode.set {pause})
			var pauseBusy = React.useRef(false);
			var [pauseFlash, setPauseFlash] = React.useState(false);
			// ★批四: 派发文案（开头/结尾）本地编辑态；进入卡时从服务端 config.get 回填
			var [tpl, setTpl] = React.useState({ loaded: false, busy: false, prefix: "", suffix: "", defaults: null, limits: null, error: "", warnings: [], flash: false });
			var tplMounted = React.useRef(true);
			React.useEffect(function () {
				tplMounted.current = true;
				var alive = true;
				if (typeof props.getDispatchConfig !== "function") { setTpl(function (prev) { return Object.assign({}, prev, { loaded: true }); }); return function () { alive = false; }; }
				props.getDispatchConfig().then(function (res) {
					if (!alive) return;
					if (res && res.ok && res.value) {
						var s = res.value.settings || {};
						setTpl(function (prev) {
							return Object.assign({}, prev, {
								loaded: true,
								prefix: typeof s.prefix === "string" ? s.prefix : "",
								suffix: typeof s.suffix === "string" ? s.suffix : "",
								defaults: res.value.defaults || null,
								limits: res.value.limits || null,
								warnings: Array.isArray(res.value.warnings) ? res.value.warnings : [],
								error: res.value.invalid ? t("tplLoadFailed") + ": " + String(res.value.invalid) : ""
							});
						});
					} else {
						setTpl(function (prev) { return Object.assign({}, prev, { loaded: true, error: t("tplLoadFailed") + ": " + String((res && res.error && res.error.message) || "unknown") }); });
					}
				}, function (err) { if (alive && tplMounted.current) setTpl(function (prev) { return Object.assign({}, prev, { loaded: true, error: t("tplLoadFailed") + ": " + String((err && err.message) || err) }); }); });
				return function () { alive = false; };
			}, []);
			function onTplChange(field, value) {
				setTpl(function (prev) { var n = Object.assign({}, prev); n[field] = String(value == null ? "" : value); n.flash = false; return n; });
			}
			function saveTpl() {
				if (tpl.busy || typeof props.setDispatchConfig !== "function") return;
				setTpl(function (prev) { return Object.assign({}, prev, { busy: true, error: "", flash: false }); });
				props.setDispatchConfig({ prefix: tpl.prefix, suffix: tpl.suffix }).then(function (res) {
					if (res && res.ok && res.value) {
						var s = (res.value && res.value.settings) || {};
						setTpl(function (prev) { return Object.assign({}, prev, { busy: false, flash: true, prefix: typeof s.prefix === "string" ? s.prefix : prev.prefix, suffix: typeof s.suffix === "string" ? s.suffix : prev.suffix, warnings: Array.isArray(res.value.warnings) ? res.value.warnings : [], error: "" }); });
					} else {
						setTpl(function (prev) { return Object.assign({}, prev, { busy: false, error: t("tplSaveFailed") + ": " + String((res && res.error && res.error.message) || "unknown") }); });
					}
				}, function (err) { setTpl(function (prev) { return Object.assign({}, prev, { busy: false, error: t("tplSaveFailed") + ": " + String((err && err.message) || err) }); }); });
			}
			function resetTpl() {
				var d = tpl.defaults || {};
				setTpl(function (prev) {
					var n = Object.assign({}, prev);
					if (typeof d.prefix === "string") n.prefix = d.prefix;
					if (typeof d.suffix === "string") n.suffix = d.suffix;
					n.flash = false; n.error = ""; n.warnings = [];
					return n;
				});
			}
			function toggle() {
				if (busy.current) return;
				busy.current = true;
				props.setEnabled(!state.enabled).then(function () {
					busy.current = false;
					setFlash(true);
					setTimeout(function () { setFlash(false); }, 1200);
				}, function () { busy.current = false; });
			}
			function togglePause() {
				if (pauseBusy.current || typeof props.setPause !== "function") return;
				pauseBusy.current = true;
				// ★批5 `T38`（`#A335` 用户批「1 2修」）：**先现读服务端真值，再按"真值取反"定目标** —— 治「首点空转」。
				//   病根（`#A332` 件② 已定因）：`/queue pause off` 是 **out-of-band 写**、**不通知 store**
				//   （store 无推送通道、只有 `UI_POLL_MS=15s` 轮询）⇒ 开关显示旧值；旧实现目标值取自**陈旧 store**
				//   （`state.pause === false`）恰等于文件现值 ⇒ 服务端 `patchModeLocked` 判「无变化」**整条跳过写入**
				//   ⇒ 首点空转、文件不变（探针两条断言据此变红）。
				//   现读失败（`refresh(true)` ⇒ null）⇒ **不猜目标、不写、不闪「已切换」**（如实失败；`ENV §一.6②`）。
				var fresh = typeof props.refreshStatus === "function" ? props.refreshStatus() : Promise.resolve(null);
				fresh.then(function (v) {
					var cur = v && typeof v.pause === "boolean" ? v.pause : null;
					if (cur === null) { pauseBusy.current = false; return null; }
					return props.setPause(cur !== true).then(function () {
						pauseBusy.current = false;
						setPauseFlash(true);
						setTimeout(function () { setPauseFlash(false); }, 1200);
					}, function () { pauseBusy.current = false; });
				}, function () { pauseBusy.current = false; });
			}
			var statusState = !loaded ? "loading" : state.status === "error" ? "error" : (state.enabled ? (state.peak ? "peak" : "offpeak") : "off");
			// v0.8.6: 模式开着但拦截器没装上 ⇒ 红字告警 (否则会显示"平峰·正常发送"误导用户)
			var broken = state.enabled === true && loaded && state.status !== "error" && interceptorMissing();
			if (broken) statusState = "broken";
			// v0.8.3 debug: 强制时段时在状态文案后明确标注 (只读显示; 防"忘记关")
			var forced = state.debug && state.debug !== "auto" ? " [强制 " + state.debug + " · debug]" : "";
			// v0.9.0: 闸门自检失败 ⇒ 状态文案追加一句 (可见性; 服务端仍照常工作, 只是不暂停)
			var statusText = statusState === "loading" ? t("statusLoading")
				: statusState === "error" ? t("statusError")
					: statusState === "broken" ? t("statusMissing")
						: statusState === "peak" ? t("statusPeak") + forced
							: statusState === "offpeak" ? t("statusOffpeak") + forced
								: "";
			if (loaded && state.pauseInstalled === false) {
				statusText = (statusText ? statusText + " · " : "") + t("pauseBroken");
			}
			// ★批4 ② **T33 常显**（2026-09-26 用户裁「可以常显 放到设置里面」＋`#A294`）：时段口径行**常显**；
			//   健康 ⇒ 「时段口径：正常 · …」；受限/未接入/未知 ⇒ **点名受限项** ＋「当前保守按高峰处理」。
			//   「为什么算高峰」的文字说明**只在这里**（胶囊只改颜色/状态，不加字）。
			var ct = (loaded && state.costTier && typeof state.costTier === "object") ? state.costTier : null;
			var tierState = !ct ? "unknown" : (ct.loaded !== true ? "missing" : (ct.degraded === true ? "degraded" : "ok"));
			var tierYears = (ct && Array.isArray(ct.years) && ct.years.length) ? ct.years.join("/") : "";
			var tierReason = ct ? String((Array.isArray(ct.reasons) && ct.reasons.length ? ct.reasons[0] : ct.reason) || "unknown") : "";
			var tierText = "";
			if (tierState === "ok") {
				var tierDetail = state.peak === true
					? t("tierDetailPeak").replace("%s", String(state.peakSource || state.windowSource || ""))
					: t("tierDetailOffpeak");
				if (tierYears) tierDetail += " · " + t("tierTableCovered").replace("%s", tierYears);
				tierText = t("tierOk").replace("%s", tierDetail);
			} else if (tierState === "degraded") tierText = t("tierDegraded").replace("%s", tierReason);
			else if (tierState === "missing") tierText = t("tierMissing").replace("%s", tierReason);
			else tierText = t("tierUnknown");
			var ctDegraded = tierState !== "ok"; // 机读位：非"正常" ⇒ true（受限/未接入/未知一律如实标）
			// 标题行/徽标行已交给容器折叠胶囊的 summary 槽 (TaskQueueSummary), 卡内不再自绘 (契约 §5.2)
			return React.createElement("div", { className: "dsh-tq-card" }, [
				React.createElement("div", { className: "dsh-tq-mode" }, [
					React.createElement("div", { className: "dsh-tq-mode-row" }, [
						React.createElement("b", null, t("modeOn")),
						React.createElement("button", {
							type: "button",
							className: "dsh-tq-switch",
							role: "switch",
							"aria-checked": state.enabled === true,
							"aria-label": t("ariaLabel"),
							"data-on": state.enabled === true ? "true" : "false",
							onClick: toggle
						})
					]),
					React.createElement("span", { className: "dsh-tq-status", "data-state": statusState }, statusText),
					React.createElement("p", { className: "dsh-tq-hint" }, t("modeOnShort")),
					// v0.9.0/v0.10.0: 全局「自动暂停」开关 (G2) —— 与错峰出行模式 (G1) 真并列, 各自独立
					React.createElement("div", { className: "dsh-tq-mode-row" }, [
						React.createElement("b", null, t("pauseLabel") + "：" + (state.pauseManual === true ? t("autoManualOn") : state.pauseManual === false ? t("autoManualOff") : (state.pause !== false ? t("autoPeakOn") : t("autoOffpeakOff")))),
						React.createElement("button", {
							type: "button",
							className: "dsh-tq-switch",
							"data-tq": "pause-switch",
							role: "switch",
							"aria-checked": state.pause !== false,
							"aria-label": t("pauseAria"),
							"data-on": state.pause !== false ? "true" : "false",
							onClick: togglePause
						})
					]),
					React.createElement("p", { className: "dsh-tq-hint" }, t("pauseShort")),
					// ★批4 ② T33 常显行：健康 ⇒ 「时段口径：正常 · …」；受限/未知 ⇒ 点名 + 「当前保守按高峰处理」
					React.createElement("p", {
						className: "dsh-tq-hint dsh-tq-tier",
						"data-tq": "tier-mode",
						"data-state": tierState,
						"data-on": ctDegraded ? "true" : "false",
						"data-reason": tierReason || void 0
					}, tierText),
					React.createElement("p", { className: "dsh-tq-hint" }, flash ? t("saved") : ""),
					React.createElement("p", { className: "dsh-tq-hint" }, pauseFlash ? t("saved") : ""),
					// ★批四：派发消息文案（开头/结尾）——两项可编辑 + 占位符说明 + 默认值回填/恢复默认 + 保存反馈
					React.createElement("div", { className: "dsh-tq-tpl", "data-tq": "dispatch-template" }, [
						React.createElement("b", { key: "tpl-title", style: { fontSize: "13px", fontWeight: 500 } }, t("tplTitle")),
						React.createElement("div", { className: "dsh-tq-tpl-row", key: "tpl-prefix" }, [
							React.createElement("span", null, t("tplPrefixLabel")),
							React.createElement("textarea", {
								"data-tq": "tpl-prefix", rows: 2, spellCheck: false,
								value: tpl.loaded ? tpl.prefix : "",
								placeholder: (tpl.defaults && tpl.defaults.prefix) || "",
								onChange: function (ev) { onTplChange("prefix", ev && ev.target ? ev.target.value : ""); }
							})
						]),
						React.createElement("div", { className: "dsh-tq-tpl-row", key: "tpl-suffix" }, [
							React.createElement("span", null, t("tplSuffixLabel")),
							React.createElement("textarea", {
								"data-tq": "tpl-suffix", rows: 3, spellCheck: false,
								value: tpl.loaded ? tpl.suffix : "",
								placeholder: (tpl.defaults && tpl.defaults.suffix) || "",
								onChange: function (ev) { onTplChange("suffix", ev && ev.target ? ev.target.value : ""); }
							})
						]),
						React.createElement("p", { className: "dsh-tq-hint", key: "tpl-hint" }, t("tplPlaceholderHint") + (tpl.limits ? ("（上限：开头 " + tpl.limits.prefix + " / 结尾 " + tpl.limits.suffix + " 字符）") : "")),
						React.createElement("div", { className: "dsh-tq-tpl-actions", key: "tpl-actions" }, [
							React.createElement("button", { type: "button", className: "dsh-tq-tpl-btn", "data-tq": "tpl-save", disabled: tpl.busy || !tpl.loaded, onClick: saveTpl, key: "save" }, t("tplSave")),
							React.createElement("button", { type: "button", className: "dsh-tq-tpl-btn", "data-tq": "tpl-reset", disabled: tpl.busy || !tpl.loaded, onClick: resetTpl, key: "reset" }, t("tplReset")),
							tpl.flash ? React.createElement("span", { className: "dsh-tq-tpl-msg", "data-tq": "tpl-flash", "data-state": "ok", key: "flash" }, t("tplSaved")) : null,
							tpl.error ? React.createElement("span", { className: "dsh-tq-tpl-msg", "data-tq": "tpl-error", "data-state": "err", key: "err" }, tpl.error) : null
						]),
						(tpl.warnings && tpl.warnings.length) ? React.createElement("p", { className: "dsh-tq-tpl-msg", "data-tq": "tpl-warnings", "data-state": "warn", key: "warn" }, tpl.warnings.join("；")) : null
					])
				])
			]);
		}

		// ---------- 任务队列卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5.1) ----------
		// 与 item 卡共用同一个 inject 返回值 (hooks.taskQueue 实时订阅 ⇒ 摘要随 store 变化自动重渲染)
		function TaskQueueSummary(props) {
			var state = props.useTaskQueue(function (s) { return s; });
			// 未加载 / 读取失败 ⇒ 摘要给 "读取中…" (契约 §5.1: 摘要不得为空)
			var ready = !!(state && state.loaded && state.status === "ready");
			var hint = ready
				? (state.enabled === true ? "开关开" : "开关关") + " · "
					+ (state.enabled === true && state.peak === true ? "高峰自动入队" : "平峰正常发送")
				: "读取中…";
			return React.createElement(React.Fragment, null, [
				React.createElement("span", { className: "lp-ico", key: "ico" }, "⛰"),
				React.createElement("span", { className: "lp-title", key: "title" }, "任务队列"),
				React.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				React.createElement("span", { className: "lp-hint", key: "hint" }, hint)
			]);
		}

		// ---------- 输入框触发器 (v0.8.2, conversation.input.left: Full access 行右侧) ----------
		// 宽屏: 完整文案药丸 (.dsh-tq-pill, button); 窄屏(≤640px): 26×26 图标 (.dsh-tq-icon,
		// 同左边 access 收缩, 不挤占工具行 → 不再与左右元素重叠);
		// 点击药丸/图标 → 弹层 .dsh-tq-pop (fixed + JS 摆位): 状态圆点+完整文案+说明 +
		// 高峰时「本会话立即发送」豁免开关 (v0.8.2 起豁免开关统一收进弹层, 药丸内不再内嵌开关);
		// 点外/Esc 关闭; 模式关闭/未加载: 不渲染。豁免切换仍走服务端 mode.exempt 持久化。
		var POP_W = 240;
		// task-19 (2026-11-24): 弹层 pre-portal 挂载目标。react-dom 是宿主 web shell 的平台 seed 模块
		//   (dsh-web-frontend dist 现读 seed 表含 react-dom / react-dom/client ⇒ 客户端 factory 的 require 可直接取),
		//   官方 client 包亦用 require("react-dom").createPortal; 取不到 ⇒ 退回原地挂载 (既有行为, 降级不崩)。
		var ReactDOMLite = null;
		try { ReactDOMLite = require("react-dom"); } catch (e) { ReactDOMLite = null; }
		function TaskQueuePill(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			// hooks 必须无条件调用 (Rules of Hooks): 全部置于 early return 之前
			var busy = React.useRef(false);
			var triggerRef = React.useRef(null);
			var popRef = React.useRef(null);
			// task-19: 同一物理点击的 pointerdown/click 双通道去重时间戳 (防双翻 = 开了又被合成 click 关上)
			var lastPointerToggle = React.useRef(0);
			var [open, setOpen] = React.useState(false);
			// 0.1.2 会话作用域槽契约: 只提供 props.sessionId + useSession hook（hook > props.session > props.sessionId）
			var sessionFromHook = null;
			if (typeof props.useSession === "function") {
				try { sessionFromHook = props.useSession(function (s) { return s; }); } catch (e) { sessionFromHook = null; }
			}
			var session = sessionFromHook || props.session || null;
			var sessionId = props.sessionId || (session && (session.id || session.sessionId)) || null;
			// ★批二 c.1: 视图全部由纯函数 computePillView 派生（颜色=此刻行为；文字+颜色并存；窄屏圆点）
			var view = computePillView({
				state: state,
				sessionId: sessionId,
				sessionInstalled: sessionInterceptorState(sessionId),
				pageInstalled: pageInterceptorOk()
			}, t);
			function toggleExempt() {
				if (busy.current || !props.setExempt || !sessionId) return;
				busy.current = true;
				props.setExempt(sessionId, !view.s1.on).then(function () { busy.current = false; }, function () { busy.current = false; });
			}
			function togglePauseExempt() {
				if (busy.current || typeof props.setPauseExempt !== "function" || !sessionId) return;
				busy.current = true;
				props.setPauseExempt(sessionId, !view.s2.on).then(function () { busy.current = false; }, function () { busy.current = false; });
			}
			// ★批二 c.1: 所有状态（含全关「未启用」）都可点开弹层（只读说明＋引导去设置）
			function toggleOpen() {
				if (!view.render) return;
				setOpen(function (v) { return !v; });
			}
			// task-19 (2026-11-24, 用户 console 实测): 程序化 .click() 可开、真实鼠标点无反应
			//   ⇒ 本次点击被宿主 composer 侧消费 (捕获/拦截导致 click 未到按钮)。修法 = 双通道:
			//   ① pointerdown 先 stopPropagation/preventDefault 再 toggle (真实鼠标路径, 不受 click 被吞影响);
			//   ② click 保留 (键盘 Enter/Space、程序化 .click()、指针事件不可用时的兜底),
			//      若同一击 pointerdown 已 toggle 过 (600ms 内) ⇒ 只吞不翻, 防双翻成"开了又关"。
			function onTriggerPointerDown(ev) {
				if (!view.render) return;
				try { if (ev && typeof ev.button === "number" && ev.button !== 0) return; } catch (e) { /* 非标准事件继续 */ }
				try { ev.stopPropagation(); } catch (e) { /* 忽略 */ }
				try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
				lastPointerToggle.current = Date.now();
				toggleOpen();
			}
			function onTriggerClick(ev) {
				try { ev.stopPropagation(); } catch (e) { /* 忽略 */ }
				if (lastPointerToggle.current && Date.now() - lastPointerToggle.current < 600) {
					lastPointerToggle.current = 0; // 同一物理点击的合成 click ⇒ 不重复翻转
					return;
				}
				try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
				toggleOpen();
			}
			// 0.1.2 适配: 渲染即把会话喂给拦截器；captureSessionFn 内部只接受 live Session（c.2），快照会被丢弃
			React.useEffect(function () {
				if (captureSessionFn && session) { try { captureSessionFn(session); } catch (e) { /* 捕获失败不影响渲染 */ } }
				if (sessionId && lastPillDiagKey !== sessionId) {
					lastPillDiagKey = sessionId;
					diag(props.report, "pill.session", {
						sessionId: sessionId,
						from: sessionFromHook ? "useSession" : (props.session ? "props.session" : "props.sessionId"),
						hasInstance: !!session
					});
				}
			}, [session, sessionId]);
			// 点外/Esc 关闭（capture 确保弹层内开关先于关闭判定）
			React.useEffect(function () {
				if (!open) return;
				function onDocDown(ev) {
					var trig = triggerRef.current;
					var pop = popRef.current;
					var node = ev && ev.target;
					if ((trig && node && trig.contains(node)) || (pop && node && pop.contains(node))) return;
					setOpen(false);
				}
				function onKey(ev) { if (ev && ev.key === "Escape") setOpen(false); }
				document.addEventListener("pointerdown", onDocDown, true);
				document.addEventListener("keydown", onKey, true);
				return function () {
					document.removeEventListener("pointerdown", onDocDown, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
			// 摆位: fixed, 触发器上方水平居中（越界收敛；顶部放不下改下方；滚动/缩放重摆）
			React.useLayoutEffect(function () {
				if (!open) return;
				function place() {
					var pop = popRef.current;
					var trig = triggerRef.current;
					if (!pop || !trig) return;
					var r = trig.getBoundingClientRect();
					var ph = pop.getBoundingClientRect().height || 120;
					var vw = window.innerWidth || document.documentElement.clientWidth || 320;
					var left = Math.max(8, Math.min(r.left + r.width / 2 - POP_W / 2, vw - POP_W - 8));
					var top = r.top - ph - 8;
					if (top < 8) top = r.bottom + 8;
					pop.style.left = Math.round(left) + "px";
					pop.style.top = Math.round(top) + "px";
					pop.style.width = POP_W + "px";
				}
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return function () {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open, view.key, view.s1.on, view.s2.on, view.suffix]);
			if (!view.render) return null;
			var popEl = null;
			if (open) {
				var rows = [];
				if (!view.readOnly) {
					rows.push(React.createElement("div", { className: "dsh-tq-pop-row", key: "sw-s1" }, [
						React.createElement("span", null, t("popRowLabel") + (view.s1.hint ? " · " + t(view.s1.hint) : "")),
						React.createElement("button", {
							type: "button", className: "dsh-tq-sw", "data-tq": "exempt-switch", role: "switch",
							"aria-checked": view.s1.on, "aria-label": view.s1.on ? t("switchAriaOn") : t("switchAria"),
							"data-on": view.s1.on ? "true" : "false", disabled: view.s1.disabled, onClick: toggleExempt
						})
					]));
					rows.push(React.createElement("div", { className: "dsh-tq-pop-row", key: "sw-s2" }, [
						React.createElement("span", null, t("pauseExemptRowLabel") + (view.s2.hint ? " · " + t(view.s2.hint) : "")),
						React.createElement("button", {
							type: "button", className: "dsh-tq-sw", "data-tq": "pause-exempt-switch", role: "switch",
							"aria-checked": view.s2.on, "aria-label": t("pauseExemptRowLabel"),
							"data-on": view.s2.on ? "true" : "false", disabled: view.s2.disabled, onClick: togglePauseExempt
						})
					]));
				} else {
					// 全关：只读说明 + 去设置引导（不加按钮/管理入口，与批一 b.2 纪律一致）
					rows.push(React.createElement("div", { className: "dsh-tq-pop-row", key: "ro-off" }, React.createElement("span", { "data-tq": "off-guide" }, t("descOff"))));
				}
				popEl = React.createElement("div", {
					ref: popRef,
					className: "dsh-tq-pop dsh-tq-pop-open",
					"data-state": view.dataState,
					"data-tq-text": view.dataText,
					role: "dialog",
					"aria-label": view.labelText
				}, [
					React.createElement("div", { className: "dsh-tq-pop-title" }, [
						React.createElement("span", { className: "dsh-tq-dot" }),
						React.createElement("span", null, view.labelText)
					]),
					React.createElement("div", { className: "dsh-tq-pop-desc", "data-tq": "desc" }, view.descText),
					view.debugText ? React.createElement("div", { className: "dsh-tq-pop-dbg", "data-tq": "debug-note" }, view.debugText) : null,
					view.pausedText ? React.createElement("div", { className: "dsh-tq-pop-desc", "data-tq": "paused-line" }, view.pausedText) : null,
					React.createElement("div", { className: "dsh-tq-pop-why", "data-tq": "why-line" }, view.whyText),
					rows
				]);
			}
			// task-19: 弹层挂 document.body (React portal) —— 宿主 composer 祖先若有 transform/filter/perspective/
			//   contain/will-change/backdrop-filter, position:fixed 会被当作相对该祖先定位且可能被 overflow 裁剪,
			//   "点击有反应但看不到弹层"即此形态。portal 后 containing block = 视口, 既有 JS 摆位 (视口坐标) 直接可用;
			//   取不到 react-dom / 无 document.body ⇒ 退回原地挂载 (既有行为, 不崩)。
			var popNode = popEl;
			if (popEl && ReactDOMLite && typeof ReactDOMLite.createPortal === "function" && typeof document !== "undefined" && document.body) {
				try { popNode = ReactDOMLite.createPortal(popEl, document.body); } catch (e) { popNode = popEl; }
			}
			return React.createElement("span", { className: "dsh-tq-wrap", ref: triggerRef }, [
				React.createElement("button", {
					key: "pill", type: "button", className: "dsh-tq-pill",
					"data-state": view.dataState, "data-tq-text": view.dataText,
					"aria-label": view.ariaText, "aria-disabled": "false",
					"aria-expanded": open ? "true" : "false", title: view.titleText,
					onPointerDown: onTriggerPointerDown, onClick: onTriggerClick
				}, [
					React.createElement("span", { className: "dsh-tq-dot" }),
					React.createElement("span", { className: "dsh-tq-txt" }, view.labelText)
				]),
				// 窄屏（界面空间不够）⇒ 只显示颜色圆点、不显示文字；点击圆点打开弹层，悬浮 title 给完整说明
				React.createElement("button", {
					key: "icon", type: "button", className: "dsh-tq-icon",
					"data-state": view.dataState, "data-tq-text": view.dataText,
					"aria-label": view.ariaText, "aria-disabled": "false",
					"aria-expanded": open ? "true" : "false", title: view.titleText,
					onPointerDown: onTriggerPointerDown, onClick: onTriggerClick
				}, React.createElement("span", { className: "dsh-tq-dot" })),
				popNode
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection", "sessions"];

		function apply(ctx) {
			// (D, 2026-09-10) 2026-09-09 的临时停用 return 已移除: 服务端已根治重放(E 熔断+终态+claim 驱动),
			// 客户端恢复"错峰拦截 + 队列面板 + 输入框状态条"。拦截器本身完全防御式(任何异常回退原发送)。
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "ui-taskqueue: dictionaries");
			var t = ctx.locale.bind(NS);
			var controller = createController(ctx.get("connection"));

			// 0) 错峰出行模式拦截 (session.prompt)
			//    整段防御: 拦截器安装异常绝不能让下面的药丸/设置卡注册中断 (否则整个客户端半边失效)
			try { installPromptInterceptor(ctx, controller); } catch (e) { diag(controller, "install.failed", { error: String((e && e.message) || e) }); }

			// 1) 触发器 (v0.8.2): conversation.input.left —— 渲染在输入框底部工具行
			//    Full access 选择器右侧 (原 v0.7.0 conversation.input.dock 悬浮状态条已移除)
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register({
					name: "conversation.input.left",
					id: "taskqueue-offpeak-pill",
					order: 10,
					locale: NS,
					inject: function () {
						return {
							hooks: { taskQueue: controller.store },
							setExempt: controller.setExempt,
							setPauseExempt: controller.setPauseExempt, // v0.10.0: 本会话暂停豁免 (S2)
							report: controller.report
						};
					}
				}, TaskQueuePill);
			});

			// 2) 设置菜单「本地插件」列配置卡 body (keyed 槽 settings.localplugin.item)
			//    卡只注册 body: 胶囊外壳 + 折叠 + 箭头由容器 (quick-insert) 提供 (契约 §1/§5.1)
			var cardInjected = function () {
				return {
					hooks: { taskQueue: controller.store },
					setEnabled: controller.setEnabled,
					setPause: controller.setPause, // v0.9.0: 设置卡里的高峰暂停开关 (同一 RPC)
					// ★批四：派发文案读写（设置卡两项可编辑）
					getDispatchConfig: controller.getDispatchConfig,
					setDispatchConfig: controller.setDispatchConfig,
					// ★批5 `T38`（`#A335`）：点击前**现读服务端真值**用（`refresh(true)` 强制不吃 TTL 缓存；幂等、只读）
					refreshStatus: function () { return controller.refresh(true); }
				};
			};
			ctx.slots.inject("settings.localplugin.item", function () {
				return ctx.slots.register({
					name: "settings.localplugin.item",
					key: CARD_KEY,
					locale: NS,
					inject: cardInjected
				}, TaskQueueCard);
			});

			// 2b) 同一张卡的 summary 兄弟槽 (key 必须与 item 相同): 只提供折叠标题行
			//     (图标 / 标题 / 「本地插件」徽标 / 实时摘要 —— 容器不再画任何文案, 契约 §1/§5.4)
			//     槽不可用或注册失败 ⇒ 静默: 容器检测不到该 key 的 summary 时走 .dsh-lp-flat 降级 (零破坏, 契约 §6)
			try {
				ctx.slots.inject("settings.localplugin.summary", function () {
					try {
						return ctx.slots.register({
							name: "settings.localplugin.summary",
							key: CARD_KEY,
							locale: NS,
							inject: cardInjected
						}, TaskQueueSummary);
					} catch (e) { return function () {}; }
				});
			} catch (e) { /* summary 槽不可用: 静默 (容器侧自动降级) */ }
		}

		exports.inject = inject;
		exports.apply = apply;
		// v0.8.6: 冒烟/对撞测试专用导出 (仅 window.__DSH_SMOKE__ 置位时; 生产浏览器不置位不启用)
		if (typeof window !== "undefined" && window.__DSH_SMOKE__) {
			exports.__test = {
				TaskQueuePill: TaskQueuePill,
				TaskQueueCard: TaskQueueCard,
				dictZh: zh,
				dictEn: en,
				computePillView: computePillView,
				interceptorMissing: interceptorMissing,
				pageInterceptorOk: pageInterceptorOk,
				sessionInterceptorState: sessionInterceptorState,
				debugState: debugState
			};
		}
		return module.exports;
	}
});
