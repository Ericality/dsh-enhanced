window.__ModuleLoader__.load({
	id: "@ericality/dsh-bg-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		//  常量
		// ═══════════════════════════════════════════════════════════════════
		/** 设置卡唯一 key (settings.localplugin.item, 本地插件列)。 */
		const ROW_ID = "bg-image";
		/** 多语言命名空间。 */
		const NS = "ui-bg-image";
		/**
		 * localStorage 缓存键 (v3.0.0 起仅作缓存 + 旧设置迁移源)。
		 * 设置的权威存储是服务端 $DSH_HOME/bg-image-settings.json (经 /bg-image RPC,
		 * 所有浏览器统一); 宿主 settings 平面白名单不可扩展, 故不走 settings.yaml。
		 */
		const STORE_KEY = "dsh.bg-image.v2";
		/** 右下角壁纸介绍本地缓存键 (每日模式): 避免每次页面加载强制服务端重抓外网 (~9s) */
		const CREDIT_STORE_KEY = "dsh.bg-image.credit.v1";
		/** 介绍缓存有效期: 与服务端缓存 TTL (12h) 对齐, 期间直接用本地缓存不请求 */
		const CREDIT_TTL = 12 * 3600 * 1000;
		/** 默认背景: 本地桥插件提供的 Bing 每日壁纸 (同源, 每日自动换图)。 */
		const DEFAULT_IMAGE = "api/wallpaper/daily";
		/** 内置示例图（深蓝渐变），仅兜底展示用。 */
		const SAMPLE_IMAGE = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221600%22%20height%3D%22900%22%20viewBox%3D%220%200%201600%20900%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22a%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%230b1026%22%2F%3E%3Cstop%20offset%3D%220.5%22%20stop-color%3D%22%231b2450%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%230e1633%22%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D%22b%22%20cx%3D%220.28%22%20cy%3D%220.22%22%20r%3D%220.75%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%233b5bdb%22%20stop-opacity%3D%220.55%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233b5bdb%22%20stop-opacity%3D%220%22%2F%3E%3C%2FradialGradient%3E%3CradialGradient%20id%3D%22c%22%20cx%3D%220.82%22%20cy%3D%220.85%22%20r%3D%220.8%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%237c3aed%22%20stop-opacity%3D%220.4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%237c3aed%22%20stop-opacity%3D%220%22%2F%3E%3C%2FradialGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%221600%22%20height%3D%22900%22%20fill%3D%22url%28%23a%29%22%2F%3E%3Crect%20width%3D%221600%22%20height%3D%22900%22%20fill%3D%22url%28%23b%29%22%2F%3E%3Crect%20width%3D%221600%22%20height%3D%22900%22%20fill%3D%22url%28%23c%29%22%2F%3E%3C%2Fsvg%3E";
		/** 预设参数（适合 Bing 每日壁纸: 面板 78% 半透明 + 14px 磨砂 + 暗色遮罩提对比）。 */
		const DEFAULT_OPACITY = 78;
		const DEFAULT_BLUR = 14;
		/** 登录页与聊天背景同步锁定默认时长 (秒): 登录页 mode=current 锁定该时长,
		 *  锁期内聊天页跟随同一张文件夹壁纸 (覆盖"打开登录页→登录进去"流程)。 */
		const DEFAULT_LOCK_SEC = 120;
		/** 刷新换图间隔默认 (秒): every 策略 N 秒内刷新不换图, 超过 N 秒刷新才换 (默认 1s = 每次刷新换) */
		const DEFAULT_REFRESH_SEC = 1;
		/**
		 * 页面底面兜底标记 (v6.0.0 预防性适配) —— 官方"页面级"容器 (插件列表等) 自身**没有底色**
		 * (设计上依赖 body 底色), 插件把壁纸铺到 body 上之后, 这类页面就直接压在壁纸上 ⇒
		 * 文字读不清。这里由 `findPageSurface()` **按几何 + 计算样式**自动识别并打标记
		 * (不写死类名/哈希: DSH 升级换哈希、新增页面都无需再手改), CSS 见 buildRestCss。
		 */
		const SURFACE_ATTR = "data-bgimg-surface";
		/** 页面底面最低浓度 (%): 保证任何壁纸下正文都可读; 用户"面板不透明度"更高时取更高值 */
		const SURFACE_TINT_FLOOR = 62;
		/** 兜底页的磨砂半径 (px): 与聊天消息列 (Md3f7G_column / EvIC1a_column::before) 同一参数 ⇒ 未适配页面与已适配区域观感一致 */
		const SURFACE_BLUR = 18;
		/** 界面磨砂默认半径 (px): 兜底页与左侧栏共用; 设置卡「界面磨砂」滑块可调 */
		const DEFAULT_SURFACE_BLUR = 18;
		/** 左侧栏不透明度默认值 (%): 不设置时跟随「面板不透明度」 */
		const DEFAULT_SIDEBAR_OPACITY = 0;
		/** 图片列表 (v7.0.0) 的内置键: 黑名单 / 收藏夹 (自定义列表 = list:<id>) */
		const LIST_ALL = "all";
		const LIST_BLACK = "black";
		const LIST_LIKES = "likes";
		const LIST_PREFIX = "list:";
		/** 图片列表分页 (v7.2.0): 每页条数可选, 选择存 localStorage (纯 UI 偏好, 不同步服务端) */
		const PAGE_SIZES = [12, 24, 48, 96, 192];
		const DEFAULT_PAGE_SIZE = 48;
		const PAGE_SIZE_KEY = "dsh.bg-image.pageSize";
		function loadPageSize() {
			try {
				const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
				return PAGE_SIZES.indexOf(n) >= 0 ? n : DEFAULT_PAGE_SIZE;
			} catch {
				return DEFAULT_PAGE_SIZE;
			}
		}
		function savePageSize(n) {
			try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* 存不了只影响下次默认 */ }
		}
		/** 页面加载级随机数 (cache busting): 每次刷新页面重新生成 → folder 随机 URL
		 *  每次都不同 → 浏览器内存缓存 (F5 普通刷新也会命中) 必不命中 → 每次刷新
		 *  都重新请求新随机图; 同一页面内固定 → 皮肤切换不触发新请求 (v5.4)。 */
		const PAGE_BUST = Math.random().toString(36).slice(2, 10);

		// ═══════════════════════════════════════════════════════════════════
		//  设置段 (v3.0.0: 服务端 RPC 为源, localStorage 仅作缓存 + 旧设置迁移源)
		// ═══════════════════════════════════════════════════════════════════
		/** 当前设置段 (内存态)。服务端 /bg-image RPC 持久化, 所有浏览器统一。 */
		let currentSection = loadLocalCache();
		/** 读 localStorage 缓存 (首屏快速渲染 + 旧设置迁移源; 损坏/缺失 → 空)。 */
		function loadLocalCache() {
			try {
				const raw = localStorage.getItem(STORE_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}
		/** 写 localStorage 缓存 (跨标签页同步 + 离线兜底)。 */
		function saveLocalCache(section) {
			try {
				localStorage.setItem(STORE_KEY, JSON.stringify(section));
			} catch {
				/* 存储满/不可用时静默失败，仅本次会话不持久 */
			}
		}
		/** 读取当前设置段；空 image 表示使用内置示例图。 */
		function loadSection() {
			return currentSection;
		}
		/** 深合并写回（更新内存 + localStorage 缓存；服务端持久化由 apply 内 write 同步）。 */
		function saveSection(patch) {
			currentSection = Object.assign({}, currentSection, patch);
			saveLocalCache(currentSection);
			return currentSection;
		}
		/** 清除设置，回到默认。 */
		function clearSection() {
			currentSection = {};
			try {
				localStorage.removeItem(STORE_KEY);
			} catch {}
		}

		// ═══════════════════════════════════════════════════════════════════
		//  CSS 生成
		// ═══════════════════════════════════════════════════════════════════
		/** 空 image 表示"使用默认 Bing 每日壁纸"。 */
		function effectiveMode(section) {
			if (section && section.mode) return section.mode;
			// 旧设置兼容: 有非默认 image → 自定义; 否则每日壁纸
			if (section && section.image && section.image !== DEFAULT_IMAGE) return "custom";
			return "daily";
		}
		/**
		 * 壁纸目标宽度 (v7.5.0):
		 *   桌面 + 内网  → 0 (不传 w ⇒ 服务端出原图, 画质优先)
		 *   移动端或外网 → 1920 (1080p, 原图 3.3MB → 约 0.57MB, 省 ~83% 流量)
		 * 为什么客户端决定: 服务端拿不到可靠的"设备/链路"判据 (UA 可伪造、Client Hints 未开、
		 * 隧道与内网在容器侧同源), 而浏览器这边有视口宽度和 location.hostname。
		 */
		const COMPRESS_WIDTH = 1920;
		function isPrivateHost(host) {
			return host === "localhost"
				|| host === "127.0.0.1"
				|| host === "::1"
				|| host === "[::1]"
				|| host === "0.0.0.0"
				|| /^10\./.test(host)
				|| /^192\.168\./.test(host)
				|| /^172\.(1[6-9]|2\d|3[01])\./.test(host)
				|| /\.local$/i.test(host)
				|| /\.lan$/i.test(host);
		}
		/** 是否小屏 (与 wallpaperWidth 的阈值一致, 预览图也按它取宽度) */
		function isSmallScreen() {
			try {
				return window.matchMedia ? window.matchMedia("(max-width: 768px)").matches : (window.innerWidth || 0) <= 768;
			} catch {
				return false;
			}
		}
		function wallpaperWidth() {
			try {
				const host = String((window.location && window.location.hostname) || "");
				const external = !!host && !isPrivateHost(host);
				const mobile = window.matchMedia
					? window.matchMedia("(max-width: 768px)").matches
					: (window.innerWidth || 0) <= 768;
				return external || mobile ? COMPRESS_WIDTH : 0;
			} catch {
				return 0;
			}
		}

		/** 按模式生成背景图 URL: daily=/bing-wallpaper, folder=随机端点, custom=用户填的 URL */
		function effectiveImage(section) {
			const mode = effectiveMode(section || {});
			if (mode === "folder") {
				const strategy = (section && section.strategy) || "every";
				const q = new URLSearchParams();
				if (section && section.folderPath) q.set("path", section.folderPath);
				q.set("mode", strategy);
				if (strategy === "interval") {
					const raw = section && section.intervalMin ? Number(section.intervalMin) : 60;
					const min = Number.isFinite(raw) && raw > 0 ? raw : 60;
					q.set("intervalMs", String(min * 60000));
				}
				// every 策略的换图间隔 (秒): N 秒内刷新不换图, 超过才换; 服务端按此控制随机缓存 TTL
				if (strategy === "every") {
					const raw = section && section.refreshSec ? Number(section.refreshSec) : DEFAULT_REFRESH_SEC;
					const sec = Number.isFinite(raw) && raw >= 1 && raw <= 3600 ? raw : DEFAULT_REFRESH_SEC;
					q.set("refreshSec", String(sec));
				}
				// 随机来源 (v7.0.0): all=全部减黑名单 / likes=收藏夹 / list:<id>=自定义列表
				// (后两者不受黑名单影响; 来源池为空时服务端回落全随机并在 debug 日志留痕)
				const source = (section && section.source) || LIST_ALL;
				if (source && source !== LIST_ALL) q.set("source", source);
				// 目标宽度 (v7.5.0): 移动端/外网才传, 桌面内网不传 (出原图)
				const wantW = wallpaperWidth();
				if (wantW) q.set("w", String(wantW));
				// 页面级 bust 参数: 绕过浏览器内存缓存, 保证每次刷新都重新请求随机图
				// (服务端缓存 key 不含此参数, 不影响 every/daily/interval 策略)
				q.set("_", PAGE_BUST);
				// 页面 token (v7.0.1): 服务端按它记住"发给这页的那张图", /wallpaper-current?c= 才精确
				q.set("c", PAGE_BUST);
				return "api/wallpaper/folder?" + q.toString();
			}
			if (mode === "custom") return (section && section.image) || SAMPLE_IMAGE;
			// 每日壁纸同样按设备/链路决定是否要 1080p (v7.5.0)
			const dailyW = wallpaperWidth();
			return dailyW ? `${DEFAULT_IMAGE}?w=${dailyW}` : DEFAULT_IMAGE;
		}
		/** 背景层 CSS: 只含 html/body 背景图 (皮肤/面板变化**不重写**此层,
		 *  保证背景图 URL 不变时浏览器不重复请求 → 一次刷新只有一张随机图)。
		 *  磨砂模糊副本用通用选择器 body::before (不依赖哈希类名, 页面初期与
		 *  html/body 同时加载, 服务端 1s TTL 内命中同一张)。 */
		function buildBgCss(image) {
			const url = `url("${image}")`;
			return `
/* ── 背景图插件 @deepseek-ai/dsh-bg-image: 背景层 (仅 URL 变化时重写) ──
   v7.3.0: 壁纸改画在**真实元素** .bgImg_layer 上 (不再画在 html/body 背景)。
   原因: 画在 html/body 上的话, z-index:-1 的模糊副本按绘制顺序被 body 背景盖住,
   "磨砂模糊"滑杆就成了摆设 (实测换绿色渐变都看不出)。独立元素所在的层能真被 filter 模糊,
   且只模糊背景、不影响内容。html 留主题底色兜底, body 透明 (否则会盖住 -1 层)。 */
html {
	background-color: var(--dsw-alias-bg-base) !important;
}
body {
	background-color: transparent !important;
	background-image: none !important;
}
.bgImg_layer {
	position: fixed;
	inset: -56px; /* 外扩, 避免高斯模糊在视口边缘渗出透明缝 */
	animation: bgImg-fade .26s ease-out both; /* 图片淡入: 先有底再出图, 不闪 */
	z-index: -1;
	pointer-events: none;
	background-image: ${url} !important;
	background-size: cover !important;
	background-position: center !important;
	background-repeat: no-repeat !important;
}
.pI_x6G_frame {
	background-color: transparent !important;
}
`;
		}
		/** 面板/磨砂/遮罩/右下角/设置UI 样式 (皮肤探测/滑块变化时重写; 不含 html/body 背景)。
		 *  skinMode: "classes" = 用当前版本哈希类名 (精准, 效果最好);
		 *            "vars"     = 降级: 只覆盖官方 CSS 变量 (--dsw-* 是三方主题
		 *                         稳定接口, dsh 升级后类名变了也能兜底生效)。 */
		function buildRestCss(image, opacity, blur, skinMode, surfaceBlur, sidebarOpacity) {
			// 只写"可变"的样式 (磨砂/面板/遮罩/右下角/设置UI); 背景图 URL 在 buildBgCss 里
			const blurFilter = blur > 0 ? `blur(${blur}px) saturate(1.25)` : "none";
			const panel = Math.max(50, Math.min(100, opacity));
			const details = Math.min(100, panel + 3);
			// 页面底面浓度: 跟随「面板不透明度」滑块, 但不低于可读下限 (SURFACE_TINT_FLOOR)
			const surfaceTint = Math.max(SURFACE_TINT_FLOOR, panel);
			// 界面磨砂半径 (0-40px): 兜底页与左侧栏共用一个值 ⇒ 全站同一套模糊
			const surfaceBlurPx = Math.max(0, Math.min(40, Number(surfaceBlur === void 0 ? DEFAULT_SURFACE_BLUR : surfaceBlur) || 0));
			const surfaceBlurCss = surfaceBlurPx > 0 ? `blur(${surfaceBlurPx}px) saturate(1.25)` : "none";
			// 左侧栏不透明度: 0 或缺省 ⇒ 跟随面板不透明度; 否则单独生效 (0-100)
			const sidebarRaw = Number(sidebarOpacity === void 0 ? 0 : sidebarOpacity);
			const sidebarPanel = (isFinite(sidebarRaw) && sidebarRaw > 0) ? Math.max(0, Math.min(100, sidebarRaw)) : panel;
			const panelCss = skinMode === "vars"
				? `/* ── 降级模式: CSS 变量覆盖 (跨版本稳定) ── */
body {
	--dsw-bgimg-sidebar: var(--dsw-specific-sidebar-fill);
	--dsw-bgimg-base: var(--dsw-alias-bg-base);
	--dsw-bgimg-platform: var(--dsw-alias-bg-module-platform);
	--dsw-bgimg-elevated: var(--dsw-alias-button-elevated-fill);
	--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-bgimg-sidebar) ${panel}%, transparent) !important;
	--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-bgimg-base) ${panel}%, transparent) !important;
	--dsw-alias-bg-module-platform: color-mix(in srgb, var(--dsw-bgimg-platform) ${Math.min(100, panel + 4)}%, transparent) !important;
	--dsw-alias-button-elevated-fill: color-mix(in srgb, var(--dsw-bgimg-elevated) ${panel}%, transparent) !important;
}`
				: `.pI_x6G_sidebarCol,
.hHd-Xa_root {
	background-color: color-mix(in srgb, var(--dsw-specific-sidebar-fill) ${sidebarPanel}%, transparent) !important;
	backdrop-filter: ${surfaceBlurCss};
	-webkit-backdrop-filter: ${surfaceBlurCss};
}
/* 新建会话按钮融入磨砂背景（消除侧边栏里的白色块） */
.hHd-Xa_newSession {
	background-color: color-mix(in srgb, var(--dsw-alias-button-elevated-fill) ${panel}%, transparent) !important;
	border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 65%, transparent) !important;
}
.hHd-Xa_newSession:hover {
	background-color: color-mix(in srgb, var(--dsw-alias-button-floating-hover) ${panel}%, transparent) !important;
}
.wSkVaW_root {
	background-color: color-mix(in srgb, var(--dsw-alias-bg-base) ${panel}%, transparent) !important;
}
/* v5.5: 消息列 (748px 居中, ChatView 的 column) 加高斯模糊 liquid 图层 —
   壁纸在列内被模糊成磨砂玻璃, 文字 (含灰色小字) 对比度足够;
   只作用于中间消息列, 两侧留白仍是清晰壁纸。
   v5.6: 模糊范围向左右各扩 16px (伪元素 inset 负值), 与下方输入框同宽
   (--dsh-composer-card-max-width = 748+32 = 780px), 不再紧贴文字边缘 */
/* 8.0.1：宿主 0.2.2-rc.1 起聊天列为 .EvIC1a_column（旧哈希 .Md3f7G_column 已不存在）⇒ 新旧双写，
   否则这一层「聊天列暗色磨砂遮罩」（38% 底 + blur 18px，参数硬编码、不随滑杆）永不渲染。 */
.Md3f7G_column,
.EvIC1a_column {
	position: relative;
	isolation: isolate;
}
.Md3f7G_column::before,
.EvIC1a_column::before {
	content: "";
	position: absolute;
	inset: 0 -16px;
	border-radius: 14px;
	backdrop-filter: blur(18px) saturate(1.3);
	-webkit-backdrop-filter: blur(18px) saturate(1.3);
	background-color: color-mix(in srgb, var(--dsw-alias-bg-base) 38%, transparent);
	z-index: -1;
	pointer-events: none;
}
.wSkVaW_root[data-phase="active"] .wSkVaW_composerSeat {
	background: linear-gradient(180deg,
		color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px,
		color-mix(in srgb, var(--dsw-alias-bg-base) ${panel}%, transparent) 36px) !important;
}
/* 8.0.1：宿主 0.2.2-rc.1 的聊天根为 .EvIC1a_root（旧 .ydkMvW_root 已不存在）⇒ 新旧双写。 */
.ydkMvW_root,
.EvIC1a_root {
	background-color: color-mix(in srgb, var(--dsw-alias-bg-base) ${details}%, transparent) !important;
}
@supports not (background: color-mix(in srgb, red 50%, blue)) {
	.pI_x6G_sidebarCol,
	.hHd-Xa_root {
		background-color: var(--dsw-specific-sidebar-fill) !important;
	}
	.wSkVaW_root,
	.ydkMvW_root,
	.EvIC1a_root {
		background-color: var(--dsw-alias-bg-base) !important;
	}
}`;
			return `
/* ── 背景图插件 @deepseek-ai/dsh-bg-image: 磨砂/遮罩/面板/右下角/设置UI (可重写) ── */
/* 磨砂模糊 (v7.3.0 起真正生效): 直接模糊背景层元素 —— 只模糊壁纸, 不碰内容。
   旧实现的 body::before 副本在 html/body 有背景时会被盖住 (等于没做), 已移除;
   .pI_x6G_frame::after 的暗色遮罩同理 (从来没渲染过), 一并去掉, 免得以为是亮度变了。 */
.bgImg_layer {
	filter: ${blurFilter} !important;
	-webkit-filter: ${blurFilter} !important;
}
${panelCss}
/* ── 页面底面兜底 (v6.0.0 预防性适配) ──
   官方"页面级"容器 (插件列表/后续新增页面) 自身没有底色 (设计上依赖 body 底色),
   壁纸铺到 body 上之后这些页面就整片透明、文字直接压在壁纸上 ⇒ 由 findPageSurface()
   按几何自动识别并打 data-bgimg-surface, 这里给一层主题色磨砂底。
   · 已自绘底色的页面 (聊天页) 与不透明弹层不会被标记 ⇒ 现有观感零变化;
   · 不认类名/哈希 ⇒ DSH 升级换哈希、官方新增页面都不必再手改 (这才是"预防性适配").
   · 浓度跟随「面板不透明度」但有可读下限 (SURFACE_TINT_FLOOR = 62%)。
   · v7.6.2: 兜底页补 backdrop-filter blur(18px) —— 与聊天列同一参数, 未适配页面不再"只有纯色、没有磨砂" */
@keyframes bgImg-fade { from { opacity: 0 } to { opacity: 1 } }
[data-bgimg-surface] {
	transition: background-color .18s ease;
	background-color: color-mix(in srgb, var(--dsw-alias-bg-base) ${surfaceTint}%, transparent) !important;
	backdrop-filter: ${surfaceBlurCss};
	-webkit-backdrop-filter: ${surfaceBlurCss};
}
@supports not (background: color-mix(in srgb, red 50%, blue)) {
	[data-bgimg-surface] { background-color: var(--dsw-alias-bg-base) !important; }
}
/* ── 右下角壁纸介绍 (手机隐藏; 可变宽度; 纯展示不拦截鼠标; 定位由 JS layoutCredit 三态控制:
   gutter=输入栏右侧空位(正文完整显示) / above=输入框上方+消息区预留空间 / corner=右下角) ── */
.bgImg_credit {
	position: fixed;
	right: 14px;
	bottom: var(--bgImgCreditBottom, 10px);
	z-index: 50;
	width: fit-content; /* 可变宽度: 盒子只占内容需要的宽度, 受 max-width 限制 */
	max-width: min(46vw, 460px);
	font-size: 14px;
	line-height: 22px;
	text-align: right;
	color: color-mix(in srgb, var(--dsw-alias-label-primary) 92%, transparent);
	text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
	pointer-events: none; /* 纯展示: 不拦截滚动条/点击 (无交互) */
	user-select: none;
}
/* 标题行 (copyright): 醒目标签条 */
.bgImg_creditTitle {
	display: inline-block;
	background: rgba(10, 14, 24, 0.55);
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 8px;
	padding: 3px 10px;
	font-size: 15px;
	font-weight: 700;
	line-height: 22px;
	color: #ffffff;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
	margin-bottom: 6px;
}
.bgImg_creditBody {
	text-align: left;
	opacity: 0.95;
	max-height: 38vh;
	overflow-y: auto;
}
.bgImg_credit:hover { opacity: 0.9; }
@media (max-width: 768px) {
	.bgImg_credit { display: none !important; }
}
/* ── 设置卡 UI (v3.0.0: 本地插件列「壁纸」卡; 由 设置>通用 迁入;
   2026-09-12 折叠胶囊卡契约 §5: 卡根不再自绘胶囊外壳/标题行 —— 外壳由容器 .dsh-lp-card 提供,
   标题/徽标/实时摘要由兄弟槽 settings.localplugin.summary 的 BgImageSummary 渲染) ── */
/* 折叠胶囊强调色: 卡侧显式声明 (契约 §3.1/§3.2 —— 撞色让位: 品牌蓝与相邻卡冲突 ⇒ teal), 不使用品牌蓝 */
.dsh-lp-card[data-lp-key="bg-image"] { --lp-accent: #14b8a6; }
.bgImg_card { display: flex; flex-direction: column; gap: 10px; }
.bgImg_row { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.bgImg_title { font-size: 16px; line-height: 24px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.bgImg_desc { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); margin: 0; }
.bgImg_field { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.bgImg_label { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.bgImg_inline { display: flex; align-items: center; gap: 8px; }
/* 服务端壁纸源段: 两列网格 (窄屏退化为单列) */
.bgImg_details { border-top: 1px dashed var(--dsw-alias-border-l2); padding-top: 8px; }
.bgImg_details summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 13px; font-weight: 500; user-select: none; }
.bgImg_details summary:hover { color: var(--dsw-alias-label-primary); }
.bgImg_srvgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
@media (max-width: 640px) {
	.bgImg_srvgrid { grid-template-columns: 1fr; }
}
.bgImg_srvgrid .bgImg_field { margin: 0; }
.bgImg_input {
	flex: 1; min-width: 0; height: 34px; padding: 0 10px; box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
	background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
	font: inherit; font-size: 13px;
}
.bgImg_button {
	flex: none; height: 34px; padding: 0 14px; border: none; border-radius: 10px;
	/* v7.4.1: 文字跟随主题底色 (brand 在深色主题是近白色, 硬写 #fff 会白底白字) */
	background: var(--dsw-alias-brand-primary, #3964fe); color: var(--dsw-alias-bg-base, #fff);
	font: inherit; font-size: 13px; cursor: pointer;
}
.bgImg_button:hover { filter: brightness(1.08); }
.bgImg_fileBtn, .bgImg_reset {
	align-self: flex-start; height: 32px; padding: 0 14px; border-radius: 10px;
	border: 1px solid var(--dsw-alias-border-l2); background: transparent;
	color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer;
}
.bgImg_fileBtn:hover, .bgImg_reset:hover { background: var(--dsw-alias-interactive-bg-hover); }
.bgImg_slider { flex: 1; min-width: 0; }
.bgImg_value {
	flex: none; min-width: 46px; text-align: right; font-size: 13px;
	color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
}
.bgImg_hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); margin: 0; }
.bgImg_radio {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); cursor: pointer;
}
.bgImg_radio input { accent-color: var(--dsw-alias-brand-primary, #3964fe); cursor: pointer; }
.bgImg_select {
	height: 34px; padding: 0 10px; box-sizing: border-box;
	border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
	background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
	font: inherit; font-size: 13px;
}
/* ── 图片列表 (v7.0.0): 页签 / 工具栏 / 缩略图网格 / 文字行 ── */
.bgImg_listWrap { display: flex; flex-direction: column; gap: 8px; }
.bgImg_tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.bgImg_tab {
	height: 26px; padding: 0 10px; border-radius: 999px; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l2); background: transparent;
	color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
}
.bgImg_tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.bgImg_tab[data-on="1"] {
	/* v7.4.1 主题适配: 原写法 background:brand + color:#fff —— brand 在深色主题里是近白色 ⇒ 白底白字不可读。
	   改成"色调式"选中态 (半透明 label 色 + label 文字), 浅色/深色主题都保证对比度。 */
	background: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 38%, transparent);
	color: var(--dsw-alias-label-primary);
}
.bgImg_toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bgImg_tbtn {
	height: 26px; padding: 0 10px; border-radius: 8px; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l2); background: transparent;
	color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.bgImg_tbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.bgImg_tbtn:disabled { opacity: .45; cursor: default; }
.bgImg_listsel {
	height: 26px; max-width: 180px; padding: 0 6px; border-radius: 8px;
	border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform);
	color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.bgImg_grid {
	display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px;
	max-height: 360px; overflow-y: auto; padding: 2px; box-sizing: border-box;
}
.bgImg_tile {
	position: relative; aspect-ratio: 16 / 10; overflow: hidden; cursor: pointer;
	border-radius: 10px; border: 2px solid transparent;
	background: var(--dsw-alias-bg-module-platform);
}
.bgImg_tile[data-sel="1"] { border-color: var(--dsw-alias-label-primary); }
.bgImg_tileImg { display: block; width: 100%; height: 100%; object-fit: cover; }
.bgImg_badges { position: absolute; left: 4px; top: 4px; display: flex; gap: 3px; pointer-events: none; }
.bgImg_badge {
	font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 4px;
	background: rgba(10, 14, 24, .62); color: #fff;
}
.bgImg_rows { max-height: 360px; overflow-y: auto; }
.bgImg_lrow {
	display: flex; align-items: center; gap: 8px; padding: 3px 2px; cursor: pointer;
	border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px;
}
.bgImg_lrow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.bgImg_lpath {
	flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-family: var(--ds-font-family-code, ui-monospace, monospace);
	color: var(--dsw-alias-label-primary);
}
.bgImg_lsize { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.bgImg_curRow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bgImg_curPath {
	flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px;
	color: var(--dsw-alias-label-secondary);
}
/* ── 左侧栏「壁纸」页 (v7.4.0): 页头 + 卡体 ── */
.bgImg_page { height: 100%; overflow: auto; box-sizing: border-box; padding: 18px 22px; }
.bgImg_pageHead {
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	max-width: 1100px; margin: 0 auto 12px; padding: 0 0 12px;
	border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.bgImg_pageIco { display: inline-flex; align-items: center; color: var(--dsw-alias-label-secondary); }
.bgImg_pageT { display: flex; flex-direction: column; min-width: 0; }
.bgImg_pageTitle { font-size: 16px; font-weight: 700; color: var(--dsw-alias-label-primary); }
.bgImg_pageSub { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.bgImg_pageBadge {
	font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px;
	background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
	color: var(--dsw-alias-label-secondary);
}
.bgImg_pageStat { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.bgImg_pageBody { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 9px; }
@media (max-width: 640px) { .bgImg_page { padding: 12px; } }
/* 调试角标: 右下角显示当前壁纸目录/文件名 (folder 模式 + 调试模式) */
.bgImg_credit[data-debug="1"] .bgImg_creditTitle { background: rgba(180, 30, 40, .72); }
`;
		}

		// ═══════════════════════════════════════════════════════════════════
		//  页面底面自动识别 (v6.0.0 预防性适配)
		//  官方"页面级"容器 (插件列表 / Automation tasks / 以后新增的页面) 自身没有底色,
		//  设计上依赖 body 底色; 插件把壁纸铺在 body 上之后, 这些页面整片透明 ⇒ 文字压在
		//  壁纸上读不清。这里**不写死类名/哈希** (DSH 升级换哈希即失效, 也不给每个新页面
		//  手工补 CSS), 而是按几何 + 计算样式判定:
		//    1) 从 body 起逐层向下, 只走"唯一主容器"的包装链; 左栏/抽屉/遮罩/覆盖层属
		//       应用外壳 (chrome), 不算内容;
		//    2) 某层自己画了底色 (bgColor alpha ≥ 0.06 或有 background-image) ⇒ 该页面自绘,
		//       **不标记** (聊天页就是这样, 所以现状零变化);
		//    3) 链断处若仍透明且覆盖 ≥ 30% 视口 ⇒ 它就是"没有底色的页面容器", 打标记,
		//       由 CSS 给主题色磨砂底 (浓度见 buildRestCss);
		//    4) 安全阀: 候选子树里含 chrome ⇒ 一律不标记, 杜绝把整个 app 外壳涂一层。
		//  性能: 稳态 < 1ms (只沿链读 rect/计算样式), 由 MutationObserver 防抖触发。
		// ═══════════════════════════════════════════════════════════════════
		/** 找"自身没有底色、覆盖大半视口"的页面容器; 页面自绘/找不到 ⇒ null。 */
		function findPageSurface() {
			if (typeof document === "undefined") return null;
			const vw = window.innerWidth || document.documentElement.clientWidth || 0;
			const vh = window.innerHeight || document.documentElement.clientHeight || 0;
			if (!vw || !vh) return null;
			const VP = vw * vh;
			const alphaOf = (c) => {
				if (!c) return 0;
				const m = c.match(/rgba?\(([^)]+)\)/);
				if (!m) return c === "transparent" ? 0 : 1;
				const p = m[1].split(/[,\s/]+/).filter(Boolean);
				return p.length >= 4 ? Number(p[3]) : 1;
			};
			const rectOf = (el) => el.getBoundingClientRect();
			/** 与视口相交面积 (离屏块算 0, 避免离屏大块冒充"占位/自绘")。 */
			const visArea = (el) => {
				const r = rectOf(el);
				const w = Math.min(r.right, vw) - Math.max(r.left, 0);
				const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
				return Math.max(0, w) * Math.max(0, h);
			};
			const paints = (el) => {
				const cs = getComputedStyle(el);
				return alphaOf(cs.backgroundColor) >= 0.06 || (cs.backgroundImage && cs.backgroundImage !== "none");
			};
			/** 子元素, 穿透 display:contents 包装层 (DSH 里有 0x0 的包装 div)。 */
			const flatKids = (el) => {
				const out = [];
				for (const k of el.children) {
					const tag = k.tagName;
					if (tag === "STYLE" || tag === "SCRIPT" || tag === "LINK" || tag === "TEMPLATE") continue;
					if (invisible(k)) continue; // 不可见层不参与"填满父容器"判定
					if (getComputedStyle(k).display === "contents") {
						out.push(...flatKids(k));
						continue;
					}
					out.push(k);
				}
				return out;
			};
			/** 不可见层 (display:none / visibility:hidden / opacity:0) 不参与"外壳"判定 ——
			 *  否则任何插件把抽屉/遮罩**常驻**在 DOM 里 (关闭态只是隐藏), 整页就会被判成应用外壳、拿不到兜底底。 */
			const invisible = (el) => {
				const cs = getComputedStyle(el);
				if (cs.display === "none") return true;
				if (cs.visibility === "hidden" || cs.visibility === "collapse") return true;
				if (Number(cs.opacity) === 0) return true;
				return false;
			};
			/** chrome: 左侧栏/抽屉/遮罩/覆盖层 —— 应用外壳, 不是页面内容。 */
			const isChrome = (el) => {
				if (invisible(el)) return false;
				const cs = getComputedStyle(el);
				const r = rectOf(el);
				if (r.width <= 0 || r.height <= 0) return true;
				const pos = cs.position;
				if (pos === "absolute" || pos === "fixed") {
					if (visArea(el) >= VP * 0.9 && Number(cs.zIndex) >= 10) return true; // 遮罩/覆盖层
					if (r.height >= vh * 0.8 && r.width <= vw * 0.4) return true; // 抽屉/左侧栏
				}
				if (r.left <= 12 && r.height >= vh * 0.8 && r.width <= vw * 0.4) return true; // 静态左栏
				return false;
			};
			/** 安全阀: 候选子树里若有 chrome ⇒ 它是应用外壳, 绝不涂。 */
			const hasChrome = (el, depth) => {
				if (depth > 2) return false;
				for (const k of el.children) {
					const tag = k.tagName;
					if (tag === "STYLE" || tag === "SCRIPT" || tag === "LINK") continue;
					if (invisible(k)) continue; // 关闭态的抽屉/遮罩不算外壳
					if (visArea(k) < VP * 0.02) continue; // 小块不值得判, 省开销
					if (isChrome(k)) return true;
					if (hasChrome(k, depth + 1)) return true;
				}
				return false;
			};
			/** 本插件自己的 UI (右下角介绍) 不参与判定。 */
			const isOwnUi = (el) => typeof el.className === "string" && el.className.indexOf("bgImg_") === 0;
			let cur = document.body;
			for (let i = 0; i < 16; i++) {
				// i=0 是 body: 壁纸本来就画在它身上 (插件背景层), 不算"页面自绘"
				if (i > 0 && paints(cur)) return null;
				const pa = visArea(cur) || VP;
				const kids = flatKids(cur).filter((k) => !isChrome(k) && !isOwnUi(k) && visArea(k) >= pa * 0.02);
				if (kids.length !== 1) break; // 分叉 ⇒ 这一层就是页面容器
				if (visArea(kids[0]) < pa * 0.6) break; // 子块没填满 ⇒ 也是页面容器
				cur = kids[0];
			}
			if (paints(cur)) return null;
			if (cur === document.body || cur === document.documentElement) return null;
			if (visArea(cur) < VP * 0.3) return null;
			if (hasChrome(cur)) return null;
			return cur;
		}

		/** 把标记同步到当前页面 (只标记一个元素, 其余旧标记清除)。
		 *  必须**先撤旧标记再判定**: 兜底底色会让 paints() 判成"页面自绘",
		 *  否则会出现"涂一层 → 下次判定以为页面自己有底色 → 撤掉"的反复闪烁。 */
		function syncPageSurface() {
			try {
				const prev = document.querySelectorAll("[" + SURFACE_ATTR + "]");
				for (const m of prev) m.removeAttribute(SURFACE_ATTR);
				const el = findPageSurface();
				if (el && !el.hasAttribute(SURFACE_ATTR)) el.setAttribute(SURFACE_ATTR, "1");
				return el;
			} catch {
				return null; // 判定失败只影响兜底, 绝不影响壁纸本身
			}
		}

		/** 防抖调度 (页面切换会连续触发多次 DOM 变动)。 */
		let surfaceTimer = null;
		function scheduleSurfaceSync(delay) {
			if (surfaceTimer) clearTimeout(surfaceTimer);
			surfaceTimer = setTimeout(() => {
				surfaceTimer = null;
				if (typeof document !== "undefined" && !document.hidden) syncPageSurface();
			}, delay || 350);
		}

		// ═══════════════════════════════════════════════════════════════════
		//  通道面双路 (2026-11-22): DSH 0.2.2 起插件自有 RPC 迁到 /api/<通道>/<端点>,
		//  旧通道 <通道>/<端点> 恒回 405 (见 docs/DSH内部机制速查.md "0.2.2 客户端 RPC 面")。
		//  这里先打官方新面, 失败回落旧通道, 并按通道缓存命中模式;
		//  同时写 window.__DSH_CHANNEL_FACE__ (与 quick-insert/taskqueue 同一诊断锚)。
		// ═══════════════════════════════════════════════════════════════════
		/** 通道 → 命中面 ("api" | "legacy") 的进程内缓存 */
		const FACE_MODE = {};
		function faceRpc(rpc, chName, endpoint, payload) {
			const callApi = () => rpc.call("/api", chName + "/" + endpoint, payload || {});
			const callLegacy = () => rpc.call("/" + chName, endpoint, payload || {});
			const mark = (mode) => {
				FACE_MODE[chName] = mode;
				try {
					window.__DSH_CHANNEL_FACE__ = Object.assign({}, window.__DSH_CHANNEL_FACE__ || {}, { [chName]: mode });
				} catch { /* 诊断锚失败不影响调用 */ }
			};
			const cached = FACE_MODE[chName];
			if (cached === "api") return Promise.resolve(callApi());
			if (cached === "legacy") return Promise.resolve(callLegacy());
			return Promise.resolve()
				.then(callApi)
				.then((r) => { mark("api"); return r; }, () => { mark("legacy"); return callLegacy(); });
		}

		// ═══════════════════════════════════════════════════════════════════
		//  壁纸源 (服务端) 配置控制器: dsh-bing-wallpaper /bing-wallpaper-cfg RPC
		// ═══════════════════════════════════════════════════════════════════
		/** 封装 /bing-wallpaper-cfg RPC (get/set/reset) + snapshot store。
		 *  cfg: 当前生效配置 (默认←patch配置←状态文件合并); overrides: 状态文件里的覆盖项。 */
		function createWallpaperCfg(connection) {
			const store = createSnapshotStore({ status: "loading", degradeReason: "", loaded: false, cfg: null, overrides: null, error: "" });
			/** 最近一次成功读到的配置/覆盖项: 降级写入时原样保留 (一次失败不清空已渲染的表单)。 */
			let lastCfg = null;
			let lastOverrides = null;
			function call(endpoint, payload) {
				const rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					// 显式降级写入 (状态面): degradeReason = 机器可读失败码; 面板折叠段直接渲染
					store.set({ status: "DEGRADED", degradeReason: "unavailable", loaded: true, cfg: lastCfg, overrides: lastOverrides, error: "connection 服务不可用" });
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "bing-wallpaper", endpoint, payload).then((result) => {
					if (result && typeof result === "object") return result;
					store.set({ status: "DEGRADED", degradeReason: "bad-response", loaded: true, cfg: lastCfg, overrides: lastOverrides, error: "响应格式异常" });
					return { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch((err) => {
					store.set({ status: "DEGRADED", degradeReason: "transport", loaded: true, cfg: lastCfg, overrides: lastOverrides, error: String((err && err.message) || err) });
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(res) {
				lastCfg = (res.value && res.value.current) || null;
				lastOverrides = (res.value && res.value.overrides) || null;
				store.set({
					status: "ready",
					degradeReason: "",
					loaded: true,
					cfg: lastCfg,
					overrides: lastOverrides,
					error: ""
				});
			}
			function refresh() {
				call("get", {}).then((res) => {
					if (res.ok) publish(res);
					// 保留 call() 写入的降级面 (status/degradeReason), 并带回机器可读码; cfg 沿用上次成功值
					else store.set({ status: "DEGRADED", degradeReason: (res.error && res.error.code) || "unknown", loaded: true, cfg: lastCfg, overrides: lastOverrides, error: (res.error && res.error.message) || "读取失败" });
				});
			}
			refresh();
			return {
				store,
				refresh,
				save: (patch) => call("set", { patch }).then((res) => { if (res.ok) publish(res); return res; }),
				reset: () => call("reset", {}).then((res) => { if (res.ok) publish(res); return res; })
			};
		}

		// ═══════════════════════════════════════════════════════════════════
		//  图片列表控制器 (v7.0.0): /api/wallpaper-lists RPC (get/set)
		//  · 真值在服务端 $DSH_HOME/wallpaper-lists.json (所有浏览器统一)
		//  · set 传整份列表 (服务端清洗 + 落盘 + 清随机缓存); 失败只上屏降级提示, 不改本地
		// ═══════════════════════════════════════════════════════════════════
		/** 空列表结构 (与服务端 sanitizeLists 对齐) */
		function emptyLists() {
			return { version: 1, blacklist: [], likes: [], lists: [] };
		}
		function createListsStore(connection) {
			const store = createSnapshotStore({ status: "loading", lists: emptyLists(), error: "" });
			let last = emptyLists();
			function publish(res) {
				const v = res && res.value && res.value.lists;
				last = v && typeof v === "object" ? v : last;
				store.set({ status: "ready", lists: last, error: "" });
			}
			function call(endpoint, payload) {
				const rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					store.set({ status: "DEGRADED", lists: last, error: "connection 服务不可用" });
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "wallpaper-lists", endpoint, payload || {})
					.then((r) => (r && typeof r === "object" ? r : { ok: false, error: { code: "bad-response", message: "响应格式异常" } }))
					.catch((e) => ({ ok: false, error: { code: "transport", message: String((e && e.message) || e) } }));
			}
			function refresh() {
				return call("get", {}).then((res) => {
					if (res.ok) publish(res);
					else store.set({ status: "DEGRADED", lists: last, error: (res.error && res.error.message) || "读取失败" });
					return res;
				});
			}
			refresh();
			return {
				store,
				refresh,
				/** 删除磁盘上的图片 (v7.6.0) + 服务端顺带从所有列表剔除 */
				remove: (p) => call("delete", { path: p }).then((res) => {
					if (res.ok) publish(res);
					else store.set({ status: "DEGRADED", lists: last, error: (res.error && res.error.message) || "删除失败" });
					return res;
				}),
				save: (lists) => call("set", { lists }).then((res) => {
					if (res.ok) publish(res);
					else store.set({ status: "DEGRADED", lists: last, error: (res.error && res.error.message) || "保存失败" });
					return res;
				})
			};
		}

		// ═══════════════════════════════════════════════════════════════════
		//  设置卡组件
		// ═══════════════════════════════════════════════════════════════════
		/**
		 * 「壁纸源（服务端）」折叠段: dsh-bing-wallpaper 配置 (lanBase/wanBase/
		 * baseDir/dailyRefreshTime/fetchTimeoutMs/allowedExts)。
		 * props：t、useWallpaperCfg（store）、saveWallpaperCfg/resetWallpaperCfg（操作）。
		 */
		function WallpaperServerSection(props) {
			const { t, useWallpaperCfg, saveWallpaperCfg, resetWallpaperCfg } = props;
			const cfgState = useWallpaperCfg((s) => s);
			const [draft, setDraft] = react.useState(null); // null = 未编辑 (跟随 store)
			const [flash, setFlash] = react.useState(false);
			const [err, setErr] = react.useState("");
			react.useEffect(() => {
				if (draft === null && cfgState.loaded && cfgState.cfg) {
					setDraft({
						lanBase: cfgState.cfg.lanBase ?? "",
						wanBase: cfgState.cfg.wanBase ?? "",
						baseDir: cfgState.cfg.baseDir ?? "",
						dailyRefreshTime: cfgState.cfg.dailyRefreshTime ?? "00:10",
						fetchTimeoutMs: cfgState.cfg.fetchTimeoutMs ?? 60000,
						allowedExts: Array.isArray(cfgState.cfg.allowedExts) ? cfgState.cfg.allowedExts.join(",") : ".jpg,.jpeg,.png,.webp,.gif",
						recursive: cfgState.cfg.recursive !== false
					});
				}
			}, [cfgState.loaded, cfgState.cfg, draft]);
			const set = (k, v) => setDraft((d) => (d ? Object.assign({}, d, { [k]: v }) : d));
			const done = (res) => {
				if (res && res.ok) { setDraft(null); setFlash(true); setErr(""); setTimeout(() => setFlash(false), 1500); }
				else setErr((res && res.error && res.error.message) || t("srv.saveFail"));
			};
			const save = () => {
				if (!draft) return;
				const patch = {
					lanBase: String(draft.lanBase || "").trim(),
					wanBase: String(draft.wanBase || "").trim(),
					baseDir: String(draft.baseDir || "").trim(),
					dailyRefreshTime: String(draft.dailyRefreshTime || "").trim(),
					fetchTimeoutMs: Number(draft.fetchTimeoutMs) || 60000,
					allowedExts: String(draft.allowedExts || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
					recursive: draft.recursive !== false
				};
				saveWallpaperCfg(patch).then(done);
			};
			const h = react.createElement;
			const field = (label, inner, key) => h("div", { className: "bgImg_field", key }, [
				h("label", { className: "bgImg_label" }, label),
				inner
			]);
			return h("details", { className: "bgImg_details" }, [
				h("summary", null, t("srv.summary")),
				cfgState.status === "loading"
					? h("p", { className: "bgImg_hint" }, t("srv.loading"))
					: (cfgState.status === "error" || cfgState.status === "DEGRADED") && !cfgState.cfg
						? h("p", { className: "bgImg_hint" }, t("srv.loadFail") + (cfgState.error ? `: ${cfgState.error}` : ""))
						: h("div", { className: "bgImg_srvgrid" }, [
							field(t("srv.lanBase"), h("input", { className: "bgImg_input", type: "text", value: draft ? draft.lanBase : "", placeholder: t("srv.emptyMeansDisabled"), onChange: (e) => set("lanBase", e.target.value) }), "lan"),
							field(t("srv.wanBase"), h("input", { className: "bgImg_input", type: "text", value: draft ? draft.wanBase : "", onChange: (e) => set("wanBase", e.target.value) }), "wan"),
							field(t("srv.baseDir"), h("input", { className: "bgImg_input", type: "text", value: draft ? draft.baseDir : "", onChange: (e) => set("baseDir", e.target.value) }), "dir"),
							field(t("srv.dailyRefreshTime"), h("input", { className: "bgImg_input", type: "text", value: draft ? draft.dailyRefreshTime : "", style: { maxWidth: 120 }, onChange: (e) => set("dailyRefreshTime", e.target.value) }), "daily"),
							field(t("srv.fetchTimeoutMs"), h("input", { className: "bgImg_input", type: "number", min: 1000, value: draft ? draft.fetchTimeoutMs : "", style: { maxWidth: 160 }, onChange: (e) => set("fetchTimeoutMs", e.target.value) }), "timeout"),
							field(t("srv.allowedExts"), h("input", { className: "bgImg_input", type: "text", value: draft ? draft.allowedExts : "", onChange: (e) => set("allowedExts", e.target.value) }), "exts")
						]),
				// 递归子目录 (v6.0.0): 壁纸库按 年/月 分目录时, 只读第一层等于漏掉绝大多数图
				h("label", { className: "bgImg_radio", style: { marginTop: 10 } }, [
					h("input", { type: "checkbox", checked: !!(draft && draft.recursive), onChange: (e) => set("recursive", e.target.checked) }),
					h("span", null, t("srv.recursive"))
				]),
				// 降级提示 (状态面上屏): degradeReason = 机器可读失败码, 后接人可读文案
				cfgState.degradeReason ? h("p", { className: "bgImg_hint" }, `${t("srv.degrade")} (${cfgState.degradeReason})` + (cfgState.error ? `: ${cfgState.error}` : "")) : null,
				err ? h("p", { className: "bgImg_hint" }, err) : null,
				h("div", { className: "bgImg_inline", style: { marginTop: 8 } }, [
					h("button", { className: "bgImg_button", type: "button", onClick: save }, flash ? t("srv.saved") : t("srv.save")),
					h("button", { className: "bgImg_reset", type: "button", onClick: () => resetWallpaperCfg().then(done) }, t("srv.reset"))
				])
			]);
		}

		/**
		 * 「图片列表」折叠段 (v7.0.0): 全部图片 / 黑名单 / 收藏夹 / 自定义列表。
		 * · 两种视图可切换: 缩略图网格 (grid) 与文字清单 (rows); 悬停均显示相对路径 (title);
		 * · 点击图片选中 (可多选), 工具栏按当前页签给动作: 全部=加黑/加收藏/加自定义列表,
		 *   黑名单/收藏夹/自定义列表=移出; 自定义列表可新建与删除;
		 * · 顶部"当前壁纸"一行: 把正在显示的那张一键加进指定列表 (快捷按钮)。
		 * props: t、useLists (store)、saveLists、refreshCurrent、listPath (当前文件夹路径, 决定「全部图片」清单)。
		 */
		function WallpaperListsSection(props) {
			const { t, useLists, saveLists, refreshCurrent, listPath, usePreview, setPreview, clearPreview } = props;
			const previewUrl = usePreview ? usePreview((x) => x.url) : null;
			const listsState = useLists((s) => s);
			const lists = listsState.lists || emptyLists();
			const custom = lists.lists || [];
			const lSet = new Set(lists.blacklist || []);
			const kSet = new Set(lists.likes || []);
			const [tab, setTab] = react.useState(LIST_ALL);
			const [view, setView] = react.useState("grid");
			const [sel, setSel] = react.useState([]);
			const [all, setAll] = react.useState(null);
			const [loadErr, setLoadErr] = react.useState("");
			const [err, setErr] = react.useState("");
			const [pageSize, setPageSize] = react.useState(loadPageSize);
			const [page, setPage] = react.useState(0);
			const [nameDraft, setNameDraft] = react.useState("");
			const [target, setTarget] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const selSet = new Set(sel);
			let sizeOf = new Map();
			for (const it of all || []) sizeOf.set(it.p, it.s);

			/**
			 * 拉图片清单: 只在折叠段展开时拉, 且跟随当前"文件夹路径" (总列表 = 当前默认随机的图)。
			 * 1487 张 ≈ 180 KB, 一次拉全量后本地筛选/分页。
			 */
			const [open, setOpen] = react.useState(false);
			react.useEffect(() => {
				if (!open) return;
				let alive = true;
				setLoadErr("");
				setAll(null); // 换目录先清空, 免得旧目录的图串台
				const q = "api/wallpaper/list?path=" + encodeURIComponent(listPath || "");
				fetch(q, { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((d) => {
						if (!alive) return;
						if (d && d.ok && Array.isArray(d.items)) setAll(d.items);
						else setLoadErr((d && d.error) || t("lists.loadFail"));
					})
					.catch((e) => { if (alive) setLoadErr(t("lists.loadFail") + " (" + String((e && e.message) || e) + ")"); });
				return () => { alive = false; };
			}, [open, listPath]);

			/** 统一保存: 写服务端整份列表 → 成功清空选择, 失败上屏 (不静默) */
			const commit = (next) => {
				setBusy(true);
				saveLists(next)
					.then((r) => {
						setBusy(false);
						if (r && r.ok) { setErr(""); setSel([]); }
						else setErr((r && r.error && r.error.message) || t("lists.saveFail"));
					})
					.catch(() => { setBusy(false); setErr(t("lists.saveFail")); });
			};
			const uniq = (arr) => Array.from(new Set(arr));
			const addPaths = (base, add) => uniq((base || []).concat(add));
			const dropSel = (base) => (base || []).filter((p) => !selSet.has(p));
			const withList = (id, items) => (custom).map((l) => (l.id === id ? Object.assign({}, l, { items }) : l));
			const activeList = tab.indexOf(LIST_PREFIX) === 0 ? custom.find((l) => l.id === tab.slice(LIST_PREFIX.length)) : null;

			/** 当前页签下要展示的图 (数组 [{p,s}]) */
			/** 去重 (v7.4.1): 老数据若混进重复路径, 渲染时也只出现一次; 写入侧另有 Set 去重 */
			const dedupe = (arr) => {
				const seen = new Set();
				return (Array.isArray(arr) ? arr : []).filter((p) => {
					if (seen.has(p)) return false;
					seen.add(p);
					return true;
				});
			};
			let items = [];
			if (all) {
				if (tab === LIST_ALL) items = all.filter((it) => !lSet.has(it.p));
				else if (tab === LIST_BLACK) items = dedupe(lists.blacklist).map((p) => ({ p, s: sizeOf.get(p) || 0 }));
				else if (tab === LIST_LIKES) items = dedupe(lists.likes).map((p) => ({ p, s: sizeOf.get(p) || 0 }));
				else if (activeList) items = dedupe(activeList.items).map((p) => ({ p, s: sizeOf.get(p) || 0 }));
			}
			const total = items.length;
			const totalPages = Math.max(1, Math.ceil(total / pageSize));
			const curPage = Math.max(0, Math.min(page, totalPages - 1));
			const shown = items.slice(curPage * pageSize, curPage * pageSize + pageSize);

			const toggle = (p) => setSel((prev) => (prev.indexOf(p) >= 0 ? prev.filter((x) => x !== p) : prev.concat([p])));
			const fmtSize = (s) => {
				if (!s) return "";
				if (s >= 1048576) return (s / 1048576).toFixed(1) + " MB";
				return Math.max(1, Math.round(s / 1024)) + " KB";
			};
			const badgesOf = (p) => {
				const out = [];
				if (lSet.has(p)) out.push(react.createElement("span", { className: "bgImg_badge", key: "b" }, t("lists.badgeBlack")));
				if (kSet.has(p)) out.push(react.createElement("span", { className: "bgImg_badge", key: "k" }, t("lists.badgeLike")));
				const n = custom.reduce((acc, l) => acc + ((l.items || []).indexOf(p) >= 0 ? 1 : 0), 0);
				if (n) out.push(react.createElement("span", { className: "bgImg_badge", key: "l" }, "L" + n));
				return out;
			};
			/** 删除选中图片 (v7.6.0): **从硬盘移除** + 从所有列表剔除, 二次确认后执行 */
			const removeFiles = () => {
				const targets = sel.slice();
				if (!targets.length) return;
				const ok = typeof window === "undefined" || !window.confirm
					? true
					: window.confirm(t("lists.deleteFilesConfirm").replace("{n}", String(targets.length)) + "\n\n" + targets.slice(0, 5).join("\n") + (targets.length > 5 ? "\n…" : ""));
				if (!ok) return;
				setBusy(true);
				setErr("");
				(async () => {
					const failed = [];
					for (const p of targets) {
						const r = await (saveLists && props.deleteImage ? props.deleteImage(p) : Promise.resolve({ ok: false }));
						if (!r || !r.ok) failed.push(p);
					}
					setBusy(false);
					if (failed.length) setErr(t("lists.deleteFilesFail").replace("{n}", String(failed.length)));
					// 本地剔除已删的 (不用整表重拉)
					const gone = new Set(targets.filter((p) => failed.indexOf(p) < 0));
					if (gone.size && typeof setAll === "function") {
						setAll((prev) => (prev ? prev.filter((it) => !gone.has(it.p)) : prev));
					}
					if (previewUrl && gone.size) { try { clearPreview && clearPreview(); } catch { /* ignore */ } }
					setSel((prev) => prev.filter((p) => !gone.has(p)));
				})();
			};
			const newList = () => {
				const nm = nameDraft.trim();
				if (!nm) return;
				const id = "l" + Date.now().toString(36);
				commit(Object.assign({}, lists, { lists: custom.concat([{ id, name: nm.slice(0, 40), items: [] }]) }));
				setNameDraft("");
				setTab(LIST_PREFIX + id);
			};

			const h = react.createElement;
			const btn = (key, label, onClick, disabled) => h("button", {
				key, className: "bgImg_tbtn", type: "button", onClick, disabled: !!disabled
			}, label);
			const tabs = [
				[LIST_ALL, t("lists.tabAll")],
				[LIST_BLACK, t("lists.tabBlack")],
				[LIST_LIKES, t("lists.tabLikes")]
			].concat(custom.map((l) => [LIST_PREFIX + l.id, l.name]));

			const actions = [];
			if (tab === LIST_ALL) {
				actions.push(btn("ab", t("lists.addBlack"), () => commit(Object.assign({}, lists, { blacklist: addPaths(lists.blacklist, sel) })), !sel.length || busy));
				actions.push(btn("al", t("lists.addLike"), () => commit(Object.assign({}, lists, { likes: addPaths(lists.likes, sel) })), !sel.length || busy));
				if (custom.length) {
					actions.push(h("select", {
						key: "ts", className: "bgImg_listsel", value: target,
						onChange: (e) => setTarget(e.target.value)
					}, [h("option", { value: "", key: "" }, t("lists.pickList"))].concat(custom.map((l) => h("option", { value: l.id, key: l.id }, l.name)))));
					actions.push(btn("at", t("lists.addToList"), () => {
						if (!target) return;
						const l = custom.find((x) => x.id === target);
						if (l) commit(Object.assign({}, lists, { lists: withList(target, addPaths(l.items, sel)) }));
					}, !sel.length || !target || busy));
				}
			} else if (tab === LIST_BLACK) {
				actions.push(btn("rb", t("lists.remove"), () => commit(Object.assign({}, lists, { blacklist: dropSel(lists.blacklist) })), !sel.length || busy));
			} else if (tab === LIST_LIKES) {
				actions.push(btn("rl", t("lists.remove"), () => commit(Object.assign({}, lists, { likes: dropSel(lists.likes) })), !sel.length || busy));
			} else if (activeList) {
				actions.push(btn("rl2", t("lists.remove"), () => commit(Object.assign({}, lists, { lists: withList(activeList.id, dropSel(activeList.items)) })), !sel.length || busy));
				actions.push(btn("dl", t("lists.deleteList"), () => {
					if (typeof window !== "undefined" && window.confirm && !window.confirm(t("lists.deleteConfirm"))) return;
					commit(Object.assign({}, lists, { lists: custom.filter((l) => l.id !== activeList.id) }));
					setTab(LIST_ALL);
				}, busy));
			}
			actions.push(btn("sa", t("lists.selectPage"), () => setSel(shown.map((it) => it.p)), !shown.length));
			actions.push(btn("cl", t("lists.clearSel"), () => setSel([]), !sel.length));
			// 预览选中 (v7.6.0): 立刻把第一张选中图设为背景, 方便看整屏效果 (只改内存, 不动设置)
			if (setPreview && sel.length) {
				actions.push(btn("pv", t("lists.preview"), () => {
					const p = sel[0];
					const w = isSmallScreen() ? 1280 : 1920;
					setPreview(`api/wallpaper/thumb?p=${encodeURIComponent(p)}&w=${w}`);
				}));
			}
			// 删除选中文件 (v7.6.0): 从硬盘移除, 二次确认
			if (props.deleteImage && sel.length) {
				actions.push(btn("dl", t("lists.deleteFiles"), removeFiles));
			}

			const renderItem = (it) => {
				const on = selSet.has(it.p);
				if (view === "text") {
					return h("div", {
						key: it.p, className: "bgImg_lrow", title: it.p, onClick: () => toggle(it.p)
					}, [
						h("input", { key: "c", type: "checkbox", checked: on, onChange: () => toggle(it.p) }),
						h("span", { key: "p", className: "bgImg_lpath" }, it.p),
						h("span", { key: "s", className: "bgImg_lsize" }, fmtSize(it.s))
					].concat(badgesOf(it.p)));
				}
				return h("div", {
					key: it.p, className: "bgImg_tile", "data-sel": on ? "1" : "",
					title: it.p, onClick: () => toggle(it.p),
					onDoubleClick: setPreview ? () => {
						const w = isSmallScreen() ? 1280 : 1920;
						setPreview(`api/wallpaper/thumb?p=${encodeURIComponent(it.p)}&w=${w}`);
					} : void 0
				}, [
					h("img", {
						key: "i", className: "bgImg_tileImg", alt: "", loading: "lazy", draggable: false,
						src: "api/wallpaper/thumb?p=" + encodeURIComponent(it.p) + "&w=160"
					}),
					h("div", { key: "b", className: "bgImg_badges" }, badgesOf(it.p))
				]);
			};
			const listBody = view === "text"
				? h("div", { className: "bgImg_rows" }, shown.map(renderItem))
				: h("div", { className: "bgImg_grid" }, shown.map(renderItem));

			return h("details", { className: "bgImg_details", onToggle: (e) => setOpen(!!(e.target && e.target.open)) }, [
				h("summary", { key: "s" }, t("lists.summary")),
				listsState.status === "DEGRADED" ? h("p", { className: "bgImg_hint", key: "d" }, t("lists.loadFail") + (listsState.error ? ": " + listsState.error : "")) : null,
				h("div", { className: "bgImg_tabs", key: "tabs", style: { marginTop: 8 } }, tabs.map(([k, label]) =>
					h("button", {
						key: k, className: "bgImg_tab", type: "button", "data-on": tab === k ? "1" : "",
						onClick: () => { setTab(k); setSel([]); setPage(0); }
					}, label)
				)),
				// 新建自定义列表
				h("div", { className: "bgImg_curRow", key: "new", style: { marginTop: 6 } }, [
					h("input", {
						key: "n", className: "bgImg_input", type: "text", value: nameDraft,
						placeholder: t("lists.namePlaceholder"), style: { maxWidth: 200 },
						onChange: (e) => setNameDraft(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") newList(); }
					}),
					h("button", { key: "c", className: "bgImg_tbtn", type: "button", onClick: newList, disabled: !nameDraft.trim() }, t("lists.create"))
				]),
				h("div", { className: "bgImg_toolbar", key: "bar", style: { marginTop: 8 } }, [
					h("span", { className: "bgImg_hint", key: "cnt" },
						(sel.length ? t("lists.selected").replace("{n}", sel.length) : t("lists.total").replace("{n}", items.length))
					)
				].concat(actions)),
				// 预览中提示 (v7.6.0): 当前背景是临时预览, 不动设置
				previewUrl && clearPreview ? h("div", { className: "bgImg_curRow", key: "pvbar", style: { marginTop: 6 } }, [
					h("span", { className: "bgImg_hint", key: "x" }, t("lists.previewing")),
					h("span", { className: "bgImg_curPath", key: "p", title: previewUrl }, previewUrl.replace(/^.*[?&]p=/, "").replace(/&.*$/, "").slice(0, 80)),
					h("button", { className: "bgImg_tbtn", type: "button", key: "c", onClick: () => clearPreview() }, t("lists.previewOff"))
				]) : null,
				// 视图切换 + 全选本页 (右对齐)
				h("div", { className: "bgImg_toolbar", key: "view", style: { justifyContent: "flex-end" } }, [
					h("button", {
						key: "g", className: "bgImg_tab", type: "button", "data-on": view === "grid" ? "1" : "",
						onClick: () => setView("grid")
					}, t("lists.viewGrid")),
					h("button", {
						key: "x", className: "bgImg_tab", type: "button", "data-on": view === "text" ? "1" : "",
						onClick: () => setView("text")
					}, t("lists.viewText"))
				]),
				err ? h("p", { className: "bgImg_hint", key: "e" }, err) : null,
				loadErr ? h("p", { className: "bgImg_hint", key: "le" }, loadErr) : null,
				!all && !loadErr ? h("p", { className: "bgImg_hint", key: "ld" }, t("lists.loading")) : null,
				all && items.length === 0 ? h("p", { className: "bgImg_hint", key: "em" }, t("lists.empty")) : null,
				all && items.length ? h("div", { className: "bgImg_listWrap", key: "body", style: { marginTop: 8 } }, [
					listBody,
					// 分页控件放在图片列表**下面** (v7.6.0, 用户要求)
					h("div", { className: "bgImg_toolbar", key: "pager" }, [
						h("button", { key: "p0", className: "bgImg_tbtn", type: "button", disabled: curPage <= 0, onClick: () => setPage(0) }, t("lists.first")),
						h("button", { key: "pp", className: "bgImg_tbtn", type: "button", disabled: curPage <= 0, onClick: () => setPage(curPage - 1) }, t("lists.prev")),
						h("span", { key: "pi", className: "bgImg_hint" }, t("lists.pageOf").replace("{p}", String(curPage + 1)).replace("{n}", String(totalPages))),
						h("button", { key: "pn", className: "bgImg_tbtn", type: "button", disabled: curPage >= totalPages - 1, onClick: () => setPage(curPage + 1) }, t("lists.next")),
						h("button", { key: "pl", className: "bgImg_tbtn", type: "button", disabled: curPage >= totalPages - 1, onClick: () => setPage(totalPages - 1) }, t("lists.last")),
						h("span", { key: "sp3", style: { flex: 1 } }),
						h("span", { key: "psl", className: "bgImg_hint" }, t("lists.pageSize")),
						h("select", {
							key: "ps", className: "bgImg_listsel", value: String(pageSize),
							onChange: (e) => {
								const n = Number(e.target.value) || DEFAULT_PAGE_SIZE;
								setPageSize(n);
								savePageSize(n);
								setPage(0);
							}
						}, PAGE_SIZES.map((n) => h("option", { value: String(n), key: n }, String(n)))),
						h("span", { key: "tot", className: "bgImg_hint" }, t("lists.total").replace("{n}", String(total)))
					])
				]) : null,
				h("p", { className: "bgImg_hint", key: "tip", style: { marginTop: 6 } }, t("lists.tip")),
				refreshCurrent ? h("button", { key: "rc", className: "bgImg_tbtn", type: "button", onClick: refreshCurrent, style: { marginTop: 6 } }, t("current.refresh")) : null
			]);
		}

		// ═══════════════════════════════════════════════════════════════════
		//  左侧栏入口 + 独立页面 (v7.4.0)
		//  宿主提供两个槽: `sidebar.panellist` (左下图标栏) 与 `main` (主区页面, key 与图标 id 一致)。
		//  与「设置 › 本地插件 › 壁纸」是**同一份数据同一个组件** (BgImageCard), 两个入口并存。
		//  槽不可用时静默降级 (只少一个入口, 不影响设置卡与壁纸)。
		// ═══════════════════════════════════════════════════════════════════
		/** 左侧栏 id / main 槽 key (必须一致, 宿主按它配对图标与页面) */
		const PANEL_ID = "bg-image";

		/** 侧栏图标: 内联 SVG (不依赖外部图片/字体, 取不到 size 时按 18)。 */
		function BgImageIcon(props) {
			const size = props && props.size ? props.size : 18;
			const h = react.createElement;
			return h("svg", {
				width: size, height: size, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true", style: { display: "block" }
			}, [
				h("rect", { key: "r", x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
				h("circle", { key: "c", cx: 8.5, cy: 9.5, r: 1.6 }),
				h("path", { key: "p", d: "M3.5 17.5l5-4.5 3.5 3 3-2.5 5 4" })
			]);
		}

		/** 左侧栏「壁纸」页: 页头 (标题/徽标/状态) + 复用「壁纸」卡。 */
		function BgImagePage(props) {
			const t = props.t;
			const state = props.useBgImage((s) => s);
			const section = (state && state.section) || {};
			const mode = effectiveMode(section);
			const modeName = mode === "folder" ? t("mode.folder") : mode === "custom" ? t("mode.custom") : t("mode.daily");
			const opacity = section.opacity !== void 0 ? section.opacity : DEFAULT_OPACITY;
			const h = react.createElement;
			return h("div", { className: "bgImg_page", "data-bgimg-page": "1" }, [
				h("div", { className: "bgImg_pageHead", key: "h" }, [
					h("span", { className: "bgImg_pageIco", key: "i" }, h(BgImageIcon, { size: 22 })),
					h("div", { className: "bgImg_pageT", key: "t" }, [
						h("div", { className: "bgImg_pageTitle", key: "tt" }, t("page.title")),
						h("div", { className: "bgImg_pageSub", key: "s" }, t("page.sub"))
					]),
					h("span", { className: "bgImg_pageBadge", key: "b" }, t("page.badge")),
					h("span", { className: "bgImg_pageStat", key: "st" }, `${modeName} · ${opacity}%`)
				]),
				h("div", { className: "bgImg_pageBody", key: "body" }, h(BgImageCard, props))
			]);
		}

		/**
		 * 设置 > 本地插件 里的「壁纸」卡 (v3.0.0 由 设置 > 通用 > 背景图 迁入)。
		 * props：t（翻译）、useBgImage（卡状态 store）、useWallpaperCfg（服务端壁纸源 store）、
		 *        setField/setImage/reset/preview（注入的操作）、saveWallpaperCfg/resetWallpaperCfg。
		 */
		function BgImageCard(props) {
			const { t, useBgImage, setField, setImage, reset, preview, useLists, saveLists, useCurrent, refreshCurrent,
				usePreview, setPreview, clearPreview, deleteImage } = props;
			const section = useBgImage((s) => s.section);
			const listsState = useLists((s) => s);
			const listsCustom = (listsState.lists && listsState.lists.lists) || [];
			const currentPath = useCurrent((s) => s.path);
			const degradeReason = useBgImage((s) => s.degradeReason);
			const degradeError = useBgImage((s) => s.error);
			const mode = effectiveMode(section);
			const [url, setUrl] = react.useState("");
			const [opacity, setOpacity] = react.useState(section && section.opacity !== void 0 ? section.opacity : DEFAULT_OPACITY);
			const [blur, setBlur] = react.useState(section && section.blur !== void 0 ? section.blur : DEFAULT_BLUR);
			const [surfaceBlur, setSurfaceBlur] = react.useState(section && section.surfaceBlur !== void 0 ? section.surfaceBlur : DEFAULT_SURFACE_BLUR);
			const [sidebarOpacity, setSidebarOpacity] = react.useState(section && section.sidebarOpacity !== void 0 ? section.sidebarOpacity : DEFAULT_SIDEBAR_OPACITY);
			const [folderPath, setFolderPath] = react.useState((section && section.folderPath) || "");
			const [strategy, setStrategy] = react.useState((section && section.strategy) || "every");
			const [intervalMin, setIntervalMin] = react.useState(section && section.intervalMin ? String(section.intervalMin) : "60");
			const [lockSec, setLockSec] = react.useState(section && section.lockSec ? String(section.lockSec) : String(DEFAULT_LOCK_SEC));
			const [refreshSec, setRefreshSec] = react.useState(section && section.refreshSec ? String(section.refreshSec) : String(DEFAULT_REFRESH_SEC));
			const [source, setSource] = react.useState((section && section.source) || LIST_ALL);
			const [debugPath, setDebugPath] = react.useState(!!(section && section.debugPath));
			// 「当前壁纸 → 加入列表」快捷操作 (v7.2.0 从"图片列表"折叠段提到卡面, 不用展开就能看到)
			const [quickTarget, setQuickTarget] = react.useState(LIST_LIKES);
			const [quickMsg, setQuickMsg] = react.useState("");
			const [hint, setHint] = react.useState("");
			const fileRef = react.useRef(null);
			const persistTimer = react.useRef(null);
			react.useEffect(() => {
				if (section !== void 0) {
					setOpacity(section.opacity !== void 0 ? section.opacity : DEFAULT_OPACITY);
					setBlur(section.blur !== void 0 ? section.blur : DEFAULT_BLUR);
					setSurfaceBlur(section.surfaceBlur !== void 0 ? section.surfaceBlur : DEFAULT_SURFACE_BLUR);
					setSidebarOpacity(section.sidebarOpacity !== void 0 ? section.sidebarOpacity : DEFAULT_SIDEBAR_OPACITY);
					setFolderPath((section.folderPath || ""));
					setStrategy((section.strategy || "every"));
					setIntervalMin(section.intervalMin ? String(section.intervalMin) : "60");
					setLockSec(section.lockSec ? String(section.lockSec) : String(DEFAULT_LOCK_SEC));
					setRefreshSec(section.refreshSec ? String(section.refreshSec) : String(DEFAULT_REFRESH_SEC));
					setSource((section && section.source) || LIST_ALL);
					setDebugPath(!!(section && section.debugPath));
				}
			}, [section]);
			/** 滑块：本地即时预览 + 400ms 防抖持久化。 */
			const onRange = (field, value) => {
				if (field === "opacity") setOpacity(value);
				else if (field === "surfaceBlur") setSurfaceBlur(value);
				else if (field === "sidebarOpacity") setSidebarOpacity(value);
				else setBlur(value);
				preview({ [field]: value });
				if (persistTimer.current) clearTimeout(persistTimer.current);
				persistTimer.current = setTimeout(() => {
					setField(field, value);
				}, 400);
			};
			/** 文件夹字段: 本地状态 + 即时预览 + 400ms 防抖持久化。 */
			const onFolderField = (field, value) => {
				if (field === "folderPath") setFolderPath(value);
				else if (field === "strategy") setStrategy(value);
				else if (field === "intervalMin") setIntervalMin(value);
				else if (field === "lockSec") setLockSec(value);
				else if (field === "source") setSource(value);
				else if (field === "debugPath") setDebugPath(!!value);
				else setRefreshSec(value);
				preview({ [field]: value });
				if (persistTimer.current) clearTimeout(persistTimer.current);
				persistTimer.current = setTimeout(() => {
					setField(field, value);
				}, 400);
			};
			/** 快捷操作: 把当前正在显示的壁纸加进指定列表 (黑名单/收藏夹/自定义)。 */
			const quickAdd = () => {
				if (!currentPath) return;
				const lists = (listsState.lists || emptyLists());
				const uniq = (arr) => Array.from(new Set(arr));
				/** 目标列表里已经有这张就不重复加 (去重, v7.4.1) */
				const alreadyIn = (arr) => Array.isArray(arr) && arr.indexOf(currentPath) >= 0;
				let next = null;
				if (quickTarget === LIST_BLACK) {
					if (alreadyIn(lists.blacklist)) { setQuickMsg(t("current.exists")); setTimeout(() => setQuickMsg(""), 2000); return; }
					next = Object.assign({}, lists, { blacklist: uniq((lists.blacklist || []).concat([currentPath])) });
				} else if (quickTarget === LIST_LIKES) {
					if (alreadyIn(lists.likes)) { setQuickMsg(t("current.exists")); setTimeout(() => setQuickMsg(""), 2000); return; }
					next = Object.assign({}, lists, { likes: uniq((lists.likes || []).concat([currentPath])) });
				}
				else if (quickTarget.indexOf(LIST_PREFIX) === 0) {
					const id = quickTarget.slice(LIST_PREFIX.length);
					const target = (lists.lists || []).find((l) => l.id === id);
					if (!target) return;
					next = Object.assign({}, lists, { lists: (lists.lists || []).map((l) => (l.id === id ? Object.assign({}, l, { items: uniq((l.items || []).concat([currentPath])) }) : l)) });
				}
				if (!next) return;
				setQuickMsg("");
				saveLists(next)
					.then((r) => {
						setQuickMsg(r && r.ok ? t("current.added") : t("lists.saveFail"));
						setTimeout(() => setQuickMsg(""), 2000);
					})
					.catch(() => { setQuickMsg(t("lists.saveFail")); setTimeout(() => setQuickMsg(""), 2000); });
			};
			/** 模式切换: 立即持久化生效。 */
			const onMode = (m) => {
				setField("mode", m);
				preview({ mode: m });
			};
			const onFile = (e) => {
				const file = e.target.files && e.target.files[0];
				e.target.value = "";
				if (!file) return;
				if (file.size > 3 * 1024 * 1024) {
					setHint(t("file.tooLarge"));
					return;
				}
				const reader = new FileReader();
				reader.onload = () => {
					setHint("");
					setImage(reader.result);
				};
				reader.readAsDataURL(file);
			};
			const applyUrl = () => {
				const value = url.trim();
				if (!value) return;
				setImage(value);
			};
			const h = react.createElement;
			const modeOptions = [
				["daily", t("mode.daily")],
				["folder", t("mode.folder")],
				["custom", t("mode.custom")]
			];
			return h("div", { className: "bgImg_card" }, [
				// 标题行/徽标行已交给容器折叠胶囊的 summary 槽 (BgImageSummary), 卡内不再自绘 (契约 §5.2)
				h("p", { className: "bgImg_desc" }, t("desc")),
				// 模式切换: 每日壁纸 / 文件夹随机 / 自定义
				h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("mode.label")),
					h("div", { className: "bgImg_inline", style: { gap: 14, flexWrap: "wrap" } }, modeOptions.map(([m, label]) =>
						h("label", { className: "bgImg_radio", key: m }, [
							h("input", {
								type: "radio", name: "bgImgMode", checked: mode === m,
								onChange: () => onMode(m)
							}),
							h("span", null, label)
						])
					))
				]),
				// 文件夹随机模式: 子目录 + 随机策略 + 间隔
				mode === "folder" ? h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("folder.path")),
					h("input", {
						className: "bgImg_input", type: "text", value: folderPath,
						placeholder: t("folder.path.placeholder"),
						onChange: (e) => onFolderField("folderPath", e.target.value)
					}),
					h("label", { className: "bgImg_label", style: { marginTop: 10 } }, t("folder.strategy")),
					h("select", {
						className: "bgImg_select", value: strategy,
						onChange: (e) => onFolderField("strategy", e.target.value)
					}, [
						h("option", { value: "every" }, t("folder.strategy.every")),
						h("option", { value: "daily" }, t("folder.strategy.daily")),
						h("option", { value: "interval" }, t("folder.strategy.interval"))
					]),
					strategy === "interval" ? h("div", { className: "bgImg_inline", style: { marginTop: 8 } }, [
						h("input", {
							className: "bgImg_input", type: "number", min: 1, value: intervalMin,
							style: { maxWidth: 110 },
							onChange: (e) => onFolderField("intervalMin", e.target.value)
						}),
						h("span", { className: "bgImg_hint" }, t("folder.interval.unit"))
					]) : null,
					// 登录页同步锁定 (秒): 登录页打开时锁定该时长, 登录页与聊天背景一致
					h("div", { className: "bgImg_field", style: { marginTop: 10 } }, [
						h("label", { className: "bgImg_label" }, t("folder.lockSec")),
						h("div", { className: "bgImg_inline" }, [
							h("input", {
								className: "bgImg_input", type: "number", min: 1, max: 3600, value: lockSec,
								style: { maxWidth: 90 },
								onChange: (e) => onFolderField("lockSec", e.target.value)
							}),
							h("span", { className: "bgImg_hint" }, t("folder.lockSec.unit"))
						]),
						h("p", { className: "bgImg_hint", style: { marginTop: 4 } }, t("folder.lockSec.desc"))
					]),
					// 刷新换图间隔 (秒): every 策略 N 秒内刷新不换图
					strategy === "every" ? h("div", { className: "bgImg_field", style: { marginTop: 10 } }, [
						h("label", { className: "bgImg_label" }, t("folder.refreshSec")),
						h("div", { className: "bgImg_inline" }, [
							h("input", {
								className: "bgImg_input", type: "number", min: 1, max: 3600, value: refreshSec,
								style: { maxWidth: 90 },
								onChange: (e) => onFolderField("refreshSec", e.target.value)
							}),
							h("span", { className: "bgImg_hint" }, t("folder.refreshSec.unit"))
						]),
						h("p", { className: "bgImg_hint", style: { marginTop: 4 } }, t("folder.refreshSec.desc"))
					]) : null,
					// 随机来源 (v7.0.0): 全部(应用黑名单) / 只从收藏夹 / 只从某个自定义列表
					h("div", { className: "bgImg_field", style: { marginTop: 10 } }, [
						h("label", { className: "bgImg_label" }, t("source.label")),
						h("select", {
							className: "bgImg_select", value: source,
							onChange: (e) => onFolderField("source", e.target.value)
						}, [
							h("option", { value: LIST_ALL, key: LIST_ALL }, t("source.all")),
							h("option", { value: LIST_LIKES, key: LIST_LIKES }, t("source.likes"))
						].concat(listsCustom.map((l) => h("option", { value: LIST_PREFIX + l.id, key: l.id }, l.name)))),
						h("p", { className: "bgImg_hint", style: { marginTop: 4 } }, t("source.hint"))
					]),
					// 调试模式: 右下角显示当前壁纸的目录与文件名 (定位不喜欢的壁纸用)
					h("label", { className: "bgImg_radio", style: { marginTop: 8 } }, [
						h("input", {
							type: "checkbox", checked: !!debugPath,
							onChange: (e) => onFolderField("debugPath", e.target.checked)
						}),
						h("span", null, t("debug.label"))
					]),
					// 快捷操作: 当前壁纸 → 指定列表 (卡面直接可见, 不用展开"图片列表")
					h("div", { className: "bgImg_curRow", style: { marginTop: 8 } }, [
						h("span", { className: "bgImg_label" }, t("current.label")),
						h("span", { className: "bgImg_curPath", title: currentPath || "" }, currentPath || t("current.unknown")),
						h("select", {
							className: "bgImg_listsel", value: quickTarget,
							onChange: (e) => setQuickTarget(e.target.value)
						}, [
							h("option", { value: LIST_BLACK, key: LIST_BLACK }, t("lists.tabBlack")),
							h("option", { value: LIST_LIKES, key: LIST_LIKES }, t("lists.tabLikes"))
						].concat(listsCustom.map((l) => h("option", { value: LIST_PREFIX + l.id, key: l.id }, l.name)))),
						h("button", { className: "bgImg_tbtn", type: "button", onClick: quickAdd, disabled: !currentPath }, t("current.add")),
						quickMsg ? h("span", { className: "bgImg_hint" }, quickMsg) : null
					]),
					h("p", { className: "bgImg_hint", style: { marginTop: 8 } }, t("folder.hint"))
				]) : null,
				// 自定义模式: 图片链接 + 本地图片
				mode === "custom" ? [
					h("div", { className: "bgImg_field", key: "url" }, [
						h("label", { className: "bgImg_label" }, t("url.label")),
						h("div", { className: "bgImg_inline" }, [
							h("input", {
								className: "bgImg_input", type: "text", value: url,
								placeholder: t("url.placeholder"),
								onChange: (e) => setUrl(e.target.value),
								onKeyDown: (e) => {
									if (e.key === "Enter") applyUrl();
								}
							}),
							h("button", { className: "bgImg_button", type: "button", onClick: applyUrl }, t("url.apply"))
						])
					]),
					h("div", { className: "bgImg_field", key: "file" }, [
						h("div", { className: "bgImg_inline" }, [
							h("button", { className: "bgImg_fileBtn", type: "button", onClick: () => fileRef.current && fileRef.current.click() }, t("file.pick")),
							h("span", { className: "bgImg_hint" }, t("file.hint"))
						]),
						h("input", { ref: fileRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: onFile })
					])
				] : null,
				// 面板不透明度
				h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("opacity")),
					h("div", { className: "bgImg_inline" }, [
						h("input", {
							className: "bgImg_slider", type: "range", min: 50, max: 100, value: opacity,
							onInput: (e) => onRange("opacity", Number(e.target.value))
						}),
						h("span", { className: "bgImg_value" }, `${opacity}%`)
					])
				]),
				// 左侧栏不透明度 (0 = 跟随面板不透明度)
				h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("sidebarOpacity")),
					h("div", { className: "bgImg_inline" }, [
						h("input", {
							className: "bgImg_slider", type: "range", min: 0, max: 100, value: sidebarOpacity,
							onInput: (e) => onRange("sidebarOpacity", Number(e.target.value))
						}),
						h("span", { className: "bgImg_value" }, sidebarOpacity > 0 ? `${sidebarOpacity}%` : t("sidebarOpacity.follow"))
					])
				]),
				// 界面磨砂 (兜底页 + 左侧栏)
				h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("surfaceBlur")),
					h("div", { className: "bgImg_inline" }, [
						h("input", {
							className: "bgImg_slider", type: "range", min: 0, max: 40, value: surfaceBlur,
							onInput: (e) => onRange("surfaceBlur", Number(e.target.value))
						}),
						h("span", { className: "bgImg_value" }, surfaceBlur > 0 ? `${surfaceBlur}px` : t("blur.off"))
					])
				]),
				// 磨砂模糊
				h("div", { className: "bgImg_field" }, [
					h("label", { className: "bgImg_label" }, t("blur")),
					h("div", { className: "bgImg_inline" }, [
						h("input", {
							className: "bgImg_slider", type: "range", min: 0, max: 40, value: blur,
							onInput: (e) => onRange("blur", Number(e.target.value))
						}),
						h("span", { className: "bgImg_value" }, blur > 0 ? `${blur}px` : t("blur.off"))
					])
				]),
				// 恢复默认
				h("div", { className: "bgImg_field" }, [
					h("button", { className: "bgImg_reset", type: "button", onClick: () => reset() }, t("reset"))
				]),
				hint ? h("p", { className: "bgImg_hint" }, hint) : null,
				// 降级提示 (状态面上屏): 形态沿用 bgImg_hint, 但文案必须指对通道 —— 本行的 degradeReason 来自
				// /bg-image 设壁纸主通道 (rpcCall 失败分支) 写入的 cardStore, 与「壁纸源(服务端)」段 (:463, srv.degrade) 是两条通道
				// ⇒ 用 card.degrade「壁纸加载降级」; 混用 srv.degrade 会让用户以为 Bing 壁纸源坏了 (指错方向)。
				// degradeReason = 机器可读失败码 (unavailable/bad-response/transport), 后接人可读文案。
				degradeReason ? h("p", { className: "bgImg_hint" }, `${t("card.degrade")} (${degradeReason})` + (degradeError ? `: ${degradeError}` : "")) : null,
				// 图片列表 (v7.0.0): 全部图片 / 黑名单 / 收藏夹 / 自定义列表
				h(WallpaperListsSection, {
					key: "lists",
					t,
					useLists,
					saveLists,
					refreshCurrent,
					listPath: folderPath,
					usePreview,
					setPreview,
					clearPreview,
					deleteImage
				}),
				// 壁纸源 (服务端): dsh-bing-wallpaper 配置 (折叠段)
				h(WallpaperServerSection, {
					key: "srv",
					t,
					useWallpaperCfg: props.useWallpaperCfg,
					saveWallpaperCfg: props.saveWallpaperCfg,
					resetWallpaperCfg: props.resetWallpaperCfg
				})
			]);
		}

		/**
		 * 折叠标题行 (契约 §5.2/§5.4): 图标/标题/徽标/实时摘要。
		 * 摘要 = 当前模式中文名 + 面板不透明度; 数据未加载 ⇒ 读取中…
		 * (读同一个 bgImage store ⇒ 天然响应式; summary 与 body 共用同一 inject 返回值)
		 */
		function BgImageSummary(props) {
			const state = props.useBgImage((s) => s);
			const h = react.createElement;
			const loaded = !!(state && state.loaded);
			const section = (state && state.section) || {};
			const mode = effectiveMode(section);
			const modeName = mode === "folder" ? "文件夹随机" : mode === "custom" ? "自定义图片" : "每日壁纸(Bing)";
			const opacity = section.opacity !== void 0 ? section.opacity : DEFAULT_OPACITY;
			return h(react.Fragment, null, [
				h("span", { className: "lp-ico", key: "ico" }, "🖼"),
				h("span", { className: "lp-title", key: "title" }, "壁纸"),
				h("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				h("span", { className: "lp-hint", key: "hint" }, loaded ? `${modeName} · 不透明度 ${opacity}%` : "读取中…")
			]);
		}

		// ═══════════════════════════════════════════════════════════════════
		//  多语言
		// ═══════════════════════════════════════════════════════════════════
		const zh = {
			"title": "背景图",
			"cardTitle": "壁纸",
			"cardHint": "背景壁纸与壁纸源设置 · 所有浏览器统一",
			"desc": "自定义整个页面的背景壁纸，侧边栏与聊天区呈半透明磨砂效果。三种模式：每日壁纸（Bing，默认）/ 文件夹随机 / 自定义。右下角显示壁纸介绍（手机端自动隐藏）。设置保存于服务端，所有浏览器统一。",
			"mode.label": "模式",
			"mode.daily": "每日壁纸",
			"mode.folder": "文件夹随机",
			"mode.custom": "自定义图片",
			"folder.path": "子目录路径（可选，相对壁纸库根目录）",
			"folder.path.placeholder": "留空 = 壁纸库根目录，如 风景/",
			"folder.strategy": "随机策略",
			"folder.strategy.every": "每次刷新随机",
			"folder.strategy.daily": "每天一张（当天固定）",
			"folder.strategy.interval": "每 N 分钟随机",
			"folder.interval.unit": "分钟",
			"folder.lockSec": "登录页同步锁定（秒）",
			"folder.lockSec.unit": "秒",
			"folder.lockSec.desc": "打开登录页时锁定该时长，登录页与聊天背景保持一致（锁定期内聊天页跟随同一张）。",
			"folder.refreshSec": "刷新换图间隔（秒）",
			"folder.refreshSec.unit": "秒",
			"folder.refreshSec.desc": "每次刷新随机模式下：间隔小于该秒数的刷新不换图，超过后才换新图。",
			"folder.hint": "图片来自服务端壁纸库目录（持久卷，手动挂载或上传的图片放这里）。",
			"page.title": "壁纸",
			"page.sub": "来源 · 图片列表 · 不透明度/磨砂 —— 与「设置 › 本地插件」同一份数据",
			"page.badge": "本地插件",
			"source.label": "随机来源",
			"source.all": "全部图片（应用黑名单）",
			"source.likes": "只从收藏夹",
			"source.hint": "黑名单只在“全部图片”里生效；收藏夹与自定义列表里的图不受黑名单影响。",
			"debug.label": "调试模式（右下角显示当前壁纸的目录与文件名）",
			"current.label": "当前壁纸",
			"current.unknown": "（当前页还没有随机到文件夹壁纸）",
			"current.add": "加入",
			"current.exists": "已在列表中（不重复添加）",
			"current.added": "✓ 已加入",
			"current.refresh": "重新读取当前壁纸",
			"lists.summary": "图片列表（黑名单 / 收藏夹 / 自定义）",
			"lists.loading": "读取图片清单…",
			"lists.loadFail": "图片清单读取失败",
			"lists.saveFail": "列表保存失败",
			"lists.tabAll": "全部图片",
			"lists.tabBlack": "黑名单",
			"lists.tabLikes": "收藏夹",
			"lists.namePlaceholder": "新列表名",
			"lists.create": "新建列表",
			"lists.deleteList": "删除该列表",
			"lists.deleteConfirm": "删除这个自定义列表？（列表里的图片回到“全部图片”，不会删文件）",
			"lists.pickList": "选择列表…",
			"lists.addBlack": "加入黑名单",
			"lists.addLike": "加入收藏夹",
			"lists.addToList": "加入该列表",
			"lists.remove": "移出",
			"lists.clearSel": "清空选择",
			"lists.total": "共 {n} 张",
			"lists.selected": "已选 {n} 张",
			"lists.more": "加载更多",
			"lists.empty": "（这个列表还是空的）",
			"lists.viewGrid": "缩略图",
			"lists.viewText": "文字",
			"lists.badgeBlack": "黑",
			"lists.badgeLike": "喜",
			"lists.preview": "预览这张",
			"lists.previewing": "预览中·",
			"lists.previewOff": "取消预览",
			"lists.deleteFiles": "删除文件",
			"lists.deleteFilesConfirm": "将把选中的 {n} 个图片文件从硬盘删除（不可恢复），并同时从所有列表里移除。确认？",
			"lists.deleteFilesFail": "有 {n} 个文件删除失败（可能已被移动/无权限），其余已删。",
			"lists.selectPage": "全选本页",
			"lists.first": "首页",
			"lists.prev": "‹ 上一页",
			"lists.next": "下一页 ›",
			"lists.last": "末页",
			"lists.pageOf": "第 {p} / {n} 页",
			"lists.pageSize": "每页",
			"lists.tip": "点击图片多选，再用上方按钮批量加入/移出；鼠标悬停可看到文件路径（缩略图按需压缩缓存）。",
			"url.label": "图片链接",
			"url.placeholder": "api/wallpaper/daily 或 https://… 或 data:image/…",
			"url.apply": "应用",
			"file.pick": "选择本地图片",
			"file.hint": "图片会内嵌进设置（建议 ≤ 3MB）",
			"file.tooLarge": "图片超过 3MB，请换一张或使用图片链接。",
			"opacity": "面板不透明度",
			"blur": "磨砂模糊",
			"surfaceBlur": "界面磨砂",
			"sidebarOpacity": "左侧栏不透明度",
			"sidebarOpacity.follow": "跟随面板",
			"blur.off": "关闭",
			"reset": "恢复默认 (Bing 每日壁纸)",
			"srv.summary": "壁纸源（服务端）",
			"srv.loading": "读取中…",
			"srv.loadFail": "读取壁纸源配置失败",
			"card.degrade": "壁纸加载降级",
			"srv.degrade": "壁纸源连接降级",
			"srv.lanBase": "每日壁纸 · 内网源 lanBase",
			"srv.wanBase": "每日壁纸 · 外网源 wanBase",
			"srv.baseDir": "壁纸库目录 baseDir",
			"srv.dailyRefreshTime": "每日刷新时间（北京时间 HH:mm）",
			"srv.fetchTimeoutMs": "抓取超时（毫秒）",
			"srv.allowedExts": "允许扩展名（逗号分隔）",
			"srv.recursive": "包含子目录（遍历文件夹内所有图片）",
			"srv.emptyMeansDisabled": "留空 = 禁用",
			"srv.save": "保存壁纸源",
			"srv.saved": "✓ 已保存",
			"srv.saveFail": "保存失败",
			"srv.reset": "恢复默认"
		};
		const en = {
			"title": "Background image",
			"cardTitle": "Wallpaper",
			"cardHint": "Background wallpaper & source settings · shared across browsers",
			"desc": "Customize the page wallpaper; the sidebar and chat area become translucent frosted glass. Three modes: daily (Bing, default) / random from folder / custom. Settings are stored on the server and shared by all browsers.",
			"mode.label": "Mode",
			"mode.daily": "Daily wallpaper",
			"mode.folder": "Random from folder",
			"mode.custom": "Custom image",
			"folder.path": "Subfolder path (optional, relative to wallpaper library root)",
			"folder.path.placeholder": "Empty = library root, e.g. landscapes/",
			"folder.strategy": "Random strategy",
			"folder.strategy.every": "Random on each refresh",
			"folder.strategy.daily": "One per day (fixed for the day)",
			"folder.strategy.interval": "Random every N minutes",
			"folder.interval.unit": "min",
			"folder.lockSec": "Login page sync lock (seconds)",
			"folder.lockSec.unit": "s",
			"folder.lockSec.desc": "When the login page opens, keep it locked for this duration so the login page and chat share the same wallpaper (chat follows the same image while locked).",
			"folder.refreshSec": "Refresh rotation interval (seconds)",
			"folder.refreshSec.unit": "s",
			"folder.refreshSec.desc": "In random-on-refresh mode: refreshes closer than this interval keep the same image; only refreshes after it rotate to a new one.",
			"folder.hint": "Images come from the server wallpaper library (persistent volume; mount or upload images there).",
			"page.title": "Wallpaper",
			"page.sub": "Source · image lists · opacity & blur — same data as Settings › Local plugins",
			"page.badge": "Local plugin",
			"source.label": "Random source",
			"source.all": "All images (blacklist applied)",
			"source.likes": "Liked only",
			"source.hint": "The blacklist only applies to “all images”; liked and custom lists are not affected by it.",
			"debug.label": "Debug mode (show the current wallpaper folder in the bottom-right corner)",
			"current.label": "Current wallpaper",
			"current.unknown": "(no folder wallpaper drawn on this page yet)",
			"current.add": "Add",
			"current.exists": "Already in this list (not added twice)",
			"current.added": "✓ Added",
			"current.refresh": "Reload current wallpaper",
			"lists.summary": "Image lists (blacklist / liked / custom)",
			"lists.loading": "Loading image list…",
			"lists.loadFail": "Failed to load the image list",
			"lists.saveFail": "Failed to save the lists",
			"lists.tabAll": "All images",
			"lists.tabBlack": "Blacklist",
			"lists.tabLikes": "Liked",
			"lists.namePlaceholder": "New list name",
			"lists.create": "Create list",
			"lists.deleteList": "Delete list",
			"lists.deleteConfirm": "Delete this custom list? (its images go back to “all images”; files are not deleted)",
			"lists.pickList": "Pick a list…",
			"lists.addBlack": "Add to blacklist",
			"lists.addLike": "Add to liked",
			"lists.addToList": "Add to list",
			"lists.remove": "Remove",
			"lists.clearSel": "Clear selection",
			"lists.total": "{n} images",
			"lists.selected": "{n} selected",
			"lists.more": "Load more",
			"lists.empty": "(this list is empty)",
			"lists.viewGrid": "Thumbnails",
			"lists.viewText": "Text",
			"lists.badgeBlack": "B",
			"lists.badgeLike": "♥",
			"lists.preview": "Preview",
			"lists.previewing": "Previewing ·",
			"lists.previewOff": "Stop preview",
			"lists.deleteFiles": "Delete files",
			"lists.deleteFilesConfirm": "Delete {n} selected image file(s) from disk (cannot be undone) and remove them from every list. Continue?",
			"lists.deleteFilesFail": "{n} file(s) could not be deleted (moved or permission denied); the rest were removed.",
			"lists.selectPage": "Select page",
			"lists.first": "First",
			"lists.prev": "‹ Prev",
			"lists.next": "Next ›",
			"lists.last": "Last",
			"lists.pageOf": "Page {p} / {n}",
			"lists.pageSize": "Per page",
			"lists.tip": "Click images to multi-select, then use the buttons above to add/remove in bulk; hover shows the file path (thumbnails are generated and cached on demand).",
			"url.label": "Image URL",
			"url.placeholder": "https://… or data:image/…",
			"url.apply": "Apply",
			"file.pick": "Choose local image",
			"file.hint": "Embedded into settings (≤ 3MB recommended)",
			"file.tooLarge": "Image exceeds 3MB — pick another or use a URL.",
			"opacity": "Panel opacity",
			"blur": "Frosted blur",
			"surfaceBlur": "Surface frost",
			"sidebarOpacity": "Sidebar opacity",
			"sidebarOpacity.follow": "Follow panel",
			"blur.off": "Off",
			"reset": "Restore defaults",
			"srv.summary": "Wallpaper source (server)",
			"srv.loading": "Loading…",
			"srv.loadFail": "Failed to load wallpaper source config",
			"card.degrade": "Wallpaper failed to load",
			"srv.degrade": "Wallpaper source connection degraded",
			"srv.lanBase": "Daily · LAN source lanBase",
			"srv.wanBase": "Daily · WAN source wanBase",
			"srv.baseDir": "Wallpaper library dir baseDir",
			"srv.dailyRefreshTime": "Daily refresh time (Beijing HH:mm)",
			"srv.fetchTimeoutMs": "Fetch timeout (ms)",
			"srv.allowedExts": "Allowed extensions (comma-separated)",
			"srv.recursive": "Include subfolders (all images in the folder)",
			"srv.emptyMeansDisabled": "Empty = disabled",
			"srv.save": "Save source",
			"srv.saved": "✓ Saved",
			"srv.saveFail": "Save failed",
			"srv.reset": "Restore defaults"
		};

		// ═══════════════════════════════════════════════════════════════════
		//  插件主体
		// ═══════════════════════════════════════════════════════════════════
		/** 客户端 cordis 服务注入清单（bundle 必须导出，否则 ctx 里拿不到这些服务）。 */
		const inject = ["slots", "locale", "connection"];

		function apply(ctx) {
			// 两个 style: 背景层 (html/body, 仅 URL 变化重写 → 背景图只请求一次) +
			// 面板/磨砂/遮罩/右下角/设置UI 层 (皮肤/滑块变化重写, 不含 html/body 背景)
			const bgStyleEl = document.createElement("style");
			bgStyleEl.setAttribute("data-plugin", "@deepseek-ai/dsh-bg-image-bg");
			(document.head || document.documentElement).appendChild(bgStyleEl);
			const restStyleEl = document.createElement("style");
			restStyleEl.setAttribute("data-plugin", "@deepseek-ai/dsh-bg-image");
			(document.head || document.documentElement).appendChild(restStyleEl);

			/** 卡状态 store (镜像当前设置段, 供「壁纸」卡渲染; 服务端持久化 v3.0.0)。 */
			const cardStore = createSnapshotStore({ status: "loading", degradeReason: "", error: "", loaded: false, section: void 0 });
			function syncCardStore() {
				// 成功路径显式清空降级面 (合并语义下才不会被上一次失败的残留面留残影)
				cardStore.set({ status: "ready", degradeReason: "", error: "", loaded: true, section: currentSection });
				reportSeamState("OK"); // 适配状态面同步清空 (见下 reportSeamState)
			}
			/** /bg-image RPC 封装 (fire-and-forget; 失败上屏降级提示, 下次 set 重试)。 */
			const connection = ctx.get("connection");
			/**
			 * 适配状态自报 (2026-10-17, 路线 A): 把「设壁纸主通道」的取用结果经 host-compat 的 /api 新面（失败回落旧通道）
			 * 回传本插件**自有**端点 `bg-image/seam-state` ⇒ Node 侧写自有分片 ⇒「适配状态」卡如实降级/恢复。
			 * · **不新增"直连宿主"接触点** (ENV §一.7①): 连接 accessor 复用上一行这一处 `connection`, 本处不取第二处;
			 * · 纯旁路: 失败静默 (永不 throw / 不留未处理拒绝), 卡内既有降级面渲染仍走 cardStore, 两条路径互不影响;
			 * · 可见面零变化: 不新增 i18n 键、不新增 CSS 类名 (note 文本由 Node 侧拼); 载荷只带 `state`/`reason` 两键 (Node 侧 handler 只读这两键; `currentSection.image` 可能是 MB 级 data URL ⇒ 降级瞬间绝不塞大载荷, 否则最需要自报时反而丢报)。
			 */
			const SEAM_STATE_ENDPOINT = "bg-image/seam-state";
			/** 回传留痕 (本插件自有 localStorage 键; 只供取证, 不上屏/不进契约/不新增 i18n 与 CSS):
			 *  记录「最后一次适配状态回传」的结果 —— 成功与失败都写, 便于事后判断"回传到底发没发出、结果是什么"。
			 *  与自报主路径完全解耦: 写失败静默 (绝不影响回传, 也绝不上屏)。 */
			const SEAM_TRACE_KEY = "dsh.bg-image.seam.v1";
			function recordSeamTrace(state, reason, reply) {
				try {
					const rec = { at: Date.now(), state: state === "OK" ? "OK" : "DEGRADED" };
					if (rec.state !== "OK" && reason) rec.reason = reason;
					rec.reply = reply && reply.ok === true
						? { ok: true }
						: { code: String((reply && reply.error && reply.error.code) || "unknown") };
					localStorage.setItem(SEAM_TRACE_KEY, JSON.stringify(rec));
				} catch (e) { /* 留痕失败不影响回传主路径 */ }
			}
			function reportSeamState(state, reason) {
				try {
					const rpc = connection && connection.rpc;
					if (!rpc || typeof rpc.call !== "function") return null;
					const payload = state === "OK"
						? { state: "OK" }
						: { state: "DEGRADED", reason: reason || "unknown" };
					// 0.2.2 新面优先（与同文件 faceRpc 同口径：先 /api/<channel>/<ep>，失败回落旧通道）。
					return Promise.resolve(faceRpc(rpc, "host-compat", SEAM_STATE_ENDPOINT, payload))
						.then((r) => (r && typeof r === "object" ? r : { ok: false, error: { code: "bad-response" } }))
						.catch(() => ({ ok: false, error: { code: "transport" } }))
						.then((reply) => {
							recordSeamTrace(state, reason, reply); // 成功/失败都留痕 (见上)
							return reply;
						});
				} catch (e) {
					return null;
				}
			}
			function rpcCall(endpoint, payload) {
				const rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					// 显式降级写入 (状态面): degradeReason = 机器可读失败码; 卡内降级提示行直接渲染
					cardStore.set({ status: "DEGRADED", degradeReason: "unavailable", error: "connection 服务不可用", loaded: true, section: currentSection });
					reportSeamState("DEGRADED", "unavailable"); // 适配状态自报: 同码回传 (`missing[]` 不收运行期码, Node 侧进 note)
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return faceRpc(rpc, "bg-image", endpoint, payload).then((result) => {
					if (result && typeof result === "object") return result;
					cardStore.set({ status: "DEGRADED", degradeReason: "bad-response", error: "响应格式异常", loaded: true, section: currentSection });
					reportSeamState("DEGRADED", "bad-response");
					return { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch((err) => {
					cardStore.set({ status: "DEGRADED", degradeReason: "transport", error: String((err && err.message) || err), loaded: true, section: currentSection });
					reportSeamState("DEGRADED", "transport");
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			/** 服务端拉取 (覆盖本地缓存); 服务端从未保存 (section=null) → 迁移 localStorage 旧设置。 */
			async function syncFromServer() {
				try {
					const res = await rpcCall("get", {});
					if (!res || !res.ok) return; // 失败: 保持本地缓存 (离线降级)
					const sv = res.value && res.value.section;
					if (sv && typeof sv === "object") {
						currentSection = sv;
						saveLocalCache(sv);
					} else {
						const local = loadLocalCache();
						if (local && Object.keys(local).length > 0) {
							// 服务端从未保存过 → 把本地旧设置一次性迁移过去 (所有浏览器统一)
							const r = await rpcCall("set", { section: local });
							currentSection = (r && r.ok && r.value && r.value.section) ? r.value.section : local;
							saveLocalCache(currentSection);
						} else {
							currentSection = {};
						}
					}
					publish();
				} catch { /* 保持本地缓存 */ }
			}
			/** 类名探测: 当前版本布局类名是否存在 → 决定精确模式 or 变量降级模式。
			 *  dsh 升级后哈希类名 (pI_x6G 前缀 / hHd-Xa 前缀 / wSkVaW 前缀 / ydkMvW 前缀) 可能变化,
			 *  此时降级到 CSS 变量覆盖 (--dsw-* 官方主题扩展点, 跨版本稳定),
			 *  保证背景图与半透明效果仍生效 (仅磨砂 blur 退化)。 */
			let skinMode = null;
			function detectSkinMode() {
				if (typeof document === "undefined") return "vars";
				try {
					const ok = document.querySelector(".pI_x6G_frame, .hHd-Xa_root, .wSkVaW_root, .ydkMvW_root, .EvIC1a_root, .EvIC1a_column") !== null;
					return ok ? "classes" : "vars";
				} catch {
					return "vars";
				}
			}
			/**
			 * 预览覆盖 (v7.6.0): 在图片列表里"选中后立刻看效果"。
			 * 只改内存里的背景 URL (publish 优先用它), **不动设置**; 刷新页面即回到原设置。
			 */
			let previewOverride = null;
			const previewStore = createSnapshotStore({ url: null });
			function setPreview(url) {
				previewOverride = url || null;
				previewStore.set({ url: previewOverride });
				publish();
			}
			function clearPreview() {
				if (!previewOverride) return;
				previewOverride = null;
				previewStore.set({ url: null });
				publish();
			}

			/** 用当前设置渲染样式 + 同步卡 store。背景层只在 URL 变化时重写 (不重复请求
			 *  背景图 → 一次刷新一张随机图); 面板层皮肤探测/滑块变化随时重写 (URL 不变
			 *  不触发新请求)。 */
			const publish = () => {
				const section = loadSection();
				const image = previewOverride || effectiveImage(section); // 预览优先 (v7.6.0)
				const bgCss = buildBgCss(image);
				if (bgStyleEl.textContent !== bgCss) bgStyleEl.textContent = bgCss;
				restStyleEl.textContent = buildRestCss(
					image,
					section.opacity !== void 0 ? section.opacity : DEFAULT_OPACITY,
					section.blur !== void 0 ? section.blur : DEFAULT_BLUR,
					skinMode || "classes",
					section.surfaceBlur !== void 0 ? section.surfaceBlur : DEFAULT_SURFACE_BLUR,
					section.sidebarOpacity !== void 0 ? section.sidebarOpacity : DEFAULT_SIDEBAR_OPACITY
				);
				syncCardStore();
				// 背景图请求是"样式生效后"才发出的 ⇒ 立即读 /wallpaper-current 会拿到上一张;
				// 延迟 1.2s 再读 (服务端按页面 token 记账, 读到的一定是这页这张)
				window.setTimeout(() => { if (!document.hidden) refreshCurrent(); }, 1200);
			};
			/** 写一个/多个字段并生效 (本地立即生效 + 服务端持久化)。 */
			const write = (patch) => {
				saveSection(patch);
				publish();
				rpcCall("set", { section: currentSection });
			};
			/** 恢复默认 (清本地 + 删服务端状态文件)。 */
			const resetAll = () => {
				clearSection();
				publish();
				rpcCall("reset", {});
			};
			/** 跨标签页同步 (另一标签页改过设置 → 重读本地缓存, 服务端值一致)。 */
			window.addEventListener("storage", (e) => {
				if (e.key !== STORE_KEY) return;
				currentSection = loadLocalCache();
				publish();
			});

			// ── 右下角壁纸介绍 (note.txt: 标题 + 正文) ──
			let creditEl = null;
			/** HTML 转义, 防止壁纸介绍文本注入 */
			function escapeHtml(s) {
				return String(s ?? "").replace(/[&<>"']/g, (c) => ({
					"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
				}[c]));
			}
			/**
			 * 当前壁纸 (v7.0.0): 读 /wallpaper-current (服务端最近一次随机结果)。
			 * 用途: ① 调试角标显示目录/文件名; ② 设置卡"当前壁纸 → 加入列表"快捷按钮。
			 * 只在 folder 模式拉取; 失败/无记录 ⇒ null (不报错, 不打扰)。
			 */
			const currentStore = createSnapshotStore({ path: null, dir: null, name: null, source: null });
			function refreshCurrent() {
				if (effectiveMode(loadSection()) !== "folder") {
					currentStore.set({ path: null, dir: null, name: null, source: null });
					return Promise.resolve(null);
				}
				return fetch("api/wallpaper/current?c=" + encodeURIComponent(PAGE_BUST), { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((d) => {
						const v = d && d.ok ? d : null;
						currentStore.set({ path: v ? v.path : null, dir: v ? v.dir : null, name: v ? v.name : null, source: v ? v.source : null });
						return v;
					})
					.catch(() => null);
			}
			function refreshCredit() {
				if (!creditEl) return;
				const section = loadSection();
				const mode = effectiveMode(section);
				// 调试模式 (v7.0.0): folder 模式下右下角显示当前壁纸的目录 + 文件名
				// (定位"不喜欢的那张图"用); 每日壁纸仍显示壁纸介绍; 其余隐藏
				const debug = mode === "folder" && !!section.debugPath;
				creditEl.style.display = mode === "daily" || debug ? "" : "none";
				creditEl.setAttribute("data-debug", debug ? "1" : "");
				if (debug) {
					refreshCurrent().then((v) => {
						if (!creditEl) return;
						if (!v) { if (creditEl.innerHTML !== "") creditEl.innerHTML = ""; return; }
						// 调试角标: 目录 (红标) + 文件名 —— 用来定位"不喜欢的那张图"
						renderCredit(v.dir, v.name);
					});
					return;
				}
				if (mode !== "daily") return;
				// 本地缓存 (localStorage): 先立即渲染上次的文字, 不阻塞
				const cached = loadCreditCache();
				if (cached && cached.title) renderCredit(cached.title, cached.body || "");
				// 距上次成功拉取 < TTL → 直接用本地缓存, 不再请求 (服务端每天 00:10 已定时强刷)
				if (cached && Date.now() - cached.at < CREDIT_TTL) return;
				fetch("api/wallpaper/daily-meta?refresh=1", { cache: "no-store" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((meta) => {
						if (!meta || meta.ok === false) return;
						if (!meta.title && !meta.body && !meta.note) return;
						// note.txt 结构: 首行 = 标题/版权行, 其余 = 正文段落
						const title = meta.title || meta.note?.split(/\n+/)[0] || "";
						const body = meta.body || (meta.note || "").split(/\n+/).slice(1).join("\n");
						saveCreditCache(title, body);
						renderCredit(title, body);
					})
					.catch(() => { /* 静默: 桥插件未装/暂不可用时右下角留空 */ });
			}
			/** 读本地介绍的缓存 (localStorage); 无/损坏返回 null。 */
			function loadCreditCache() {
				try {
					const raw = localStorage.getItem(CREDIT_STORE_KEY);
					if (!raw) return null;
					const p = JSON.parse(raw);
					return p && typeof p === "object" ? p : null;
				} catch {
					return null;
				}
			}
			/** 写本地介绍的缓存 (title/body + 时间戳)。 */
			function saveCreditCache(title, body) {
				try {
					localStorage.setItem(CREDIT_STORE_KEY, JSON.stringify({ title, body, at: Date.now() }));
				} catch { /* 存储不可用时静默 */ }
			}
			/** 渲染介绍 (title + body), escapeHtml 防注入。 */
			function renderCredit(title, body) {
				if (!creditEl) return;
				const titleHtml = title ? `<div class="bgImg_creditTitle">${escapeHtml(title)}</div>` : "";
				const bodyHtml = body ? `<div class="bgImg_creditBody">${escapeHtml(body)}</div>` : "";
				const html = titleHtml + bodyHtml;
				if (creditEl.innerHTML !== html) creditEl.innerHTML = html; // 5s 轮询下避免重复写 DOM
			}

			// 首次渲染: 等布局挂载后再探测类名 (immediately 时 React 可能未挂载)
			skinMode = detectSkinMode();
			publish();
			window.setTimeout(() => {
				const mode = detectSkinMode();
				if (mode !== skinMode) {
					skinMode = mode;
					publish();
				}
			}, 800);

			// 背景层元素 (v7.3.0): 壁纸画在它身上, 磨砂 blur 作用在它身上 (只糊背景不糊内容)。
			// 必须是真实元素: html/body 背景上的伪元素会被 body 背景盖住 (旧 body::before 就是这么失效的)。
			try {
				const layerEl = document.createElement("div");
				layerEl.className = "bgImg_layer";
				layerEl.setAttribute("aria-hidden", "true");
				document.body.insertBefore(layerEl, document.body.firstChild);
			} catch { /* 插入失败只影响背景层, 不抛 */ }

			// 右下角介绍元素 (CSS 在 buildCss 里, 手机 max-width:768px 隐藏)
			creditEl = document.createElement("div");
			creditEl.className = "bgImg_credit";
			document.body.appendChild(creditEl);

			// ── 右下角介绍定位: 不遮挡输入框, 也不遮挡对话内容 ──
			// 三种模式:
			//   gutter 宽屏: 输入框固定在底部且其右侧有空位 → 介绍放进输入栏右侧,
			//               与输入框同一水平 (高度限制在输入栏内, 正文内部滚动)
			//   above  中窄屏: 输入框固定在底部但右侧没空位 → 介绍放输入框上方,
			//               同时给消息列表底部预留空间, 最后一条消息不会被盖住
			//   corner 其他 (输入框不在底部/无输入框): 右下角 bottom:10px
			function layoutCredit() {
				if (!creditEl) return;
				const vh = window.innerHeight || document.documentElement.clientHeight;
				const vw = window.innerWidth || document.documentElement.clientWidth;
				let bottom = 10;
				let maxWidth = Math.min(46 * vw / 100, 460);
				let mode = "corner";
				let reserve = false;
				try {
					const seat = document.querySelector(".wSkVaW_composerSeat");
					if (seat) {
						const r = seat.getBoundingClientRect();
						// sticky bottom:0 → 输入框底边贴住视口底
						const pinned = r.top < vh && r.bottom >= vh - 2;
						if (pinned) {
							const seatH = vh - r.top;
							const cs = getComputedStyle(seat);
							const cardMax = parseFloat(cs.getPropertyValue("--dsh-composer-card-max-width")) || 780;
							const clearance = parseFloat(cs.getPropertyValue("--dsh-composer-side-clearance")) || 16;
							const cardW = Math.min(cardMax, Math.max(0, r.width - 2 * clearance));
							const cardRight = r.left + (r.width - cardW) / 2 + cardW;
							const gutter = vw - cardRight; // 输入框右侧可用空位
							if (gutter >= 240) {
								// 宽屏: 放进输入框右侧空位 (消息列 748px 居中, 右侧留白无消息),
								// 与输入框同一水平; 正文完整显示 (不截断, CSS max-height 38vh 兜底)
								mode = "gutter";
								bottom = Math.max(10, vh - r.bottom + 10);
								maxWidth = Math.min(maxWidth, gutter - 40);
							} else {
								// 输入框上方 + 给消息列表底部预留介绍高度
								mode = "above";
								bottom = Math.max(10, seatH + 10);
								reserve = true;
							}
						}
					}
				} catch { /* 类名失效回退 corner, 不抛错 */ }
				creditEl.style.setProperty("--bgImgCreditBottom", bottom + "px");
				creditEl.style.maxWidth = mode === "gutter" ? maxWidth + "px" : "";
				creditEl.setAttribute("data-credit-mode", mode);
				// above 模式: 消息列表底部预留介绍高度, 避免遮挡最后一条消息
				const view = document.querySelector(".wSkVaW_viewArea");
				if (view) {
					const visible = creditEl.style.display !== "none"
						&& getComputedStyle(creditEl).display !== "none"; // 兼容手机 CSS 隐藏
					const h = visible ? creditEl.getBoundingClientRect().height : 0;
					view.style.paddingBottom = reserve && visible && h > 0 ? h + 12 + "px" : "";
				}
			}
			let creditObserver = null;
			function attachCreditObserver() {
				if (typeof ResizeObserver === "undefined") return;
				const seat = document.querySelector(".wSkVaW_composerSeat");
				// 已绑定且节点仍在文档中 → 不用重绑
				if (!seat || (creditObserver && creditObserver._seat && creditObserver._seat.isConnected)) return;
				if (creditObserver) creditObserver.disconnect();
				creditObserver = new ResizeObserver(layoutCredit); // 输入框多行展开/收起时重算
				creditObserver.observe(seat);
				creditObserver._seat = seat;
				layoutCredit();
			}
			// 聊天视图切换 (React 重挂载) / 输入框高度变化时重算
			if (typeof MutationObserver !== "undefined") {
				new MutationObserver(() => attachCreditObserver())
					.observe(document.body, { childList: true, subtree: true });
			}
			// 介绍内容加载后 (标题/正文) 高度变化也要重算
			if (typeof ResizeObserver !== "undefined") {
				new ResizeObserver(layoutCredit).observe(creditEl);
			}
			window.addEventListener("resize", layoutCredit);
			layoutCredit();

			// ── 页面底面兜底 (v6.0.0): DOM/尺寸变化后重算"该页有没有底色" ──
			function installSurfaceGuard() {
				scheduleSurfaceSync(0); // 首屏第一帧就打标 (原来 600ms 才有底 ⇒ 会先看到清晰壁纸)
				scheduleSurfaceSync(150); // React 挂载完成后再补一次
				scheduleSurfaceSync(600); // 首屏: React 可能还没挂载完
				scheduleSurfaceSync(2200); // 二次探测: 皮肤/页面挂载完成后补一次
				try {
					if (typeof MutationObserver !== "undefined") {
						const mo = new MutationObserver(() => scheduleSurfaceSync(60));
						mo.observe(document.body, { childList: true, subtree: true });
						ctx.effect(() => () => mo.disconnect(), "ui-bg-image: surface guard observer");
					}
				} catch { /* 观察失败只影响兜底, 不影响壁纸 */ }
				try {
					const onResize = () => scheduleSurfaceSync(300);
					window.addEventListener("resize", onResize);
					ctx.effect(() => () => window.removeEventListener("resize", onResize), "ui-bg-image: surface guard resize");
				} catch { /* 同上 */ }
				// 排查入口 (只读): 控制台 __dsBgSurface() 立即重算并返回被标记的节点
				try { window.__dsBgSurface = () => syncPageSurface(); } catch { /* 同上 */ }
			}
			installSurfaceGuard();

			refreshCredit();
			// 不再轮询 /wallpaper-current: 它返回的是"服务端最近一次随机"(别的标签页也会改),
			// 轮询会让调试角标/快捷按钮指向别人那张图。背景只在"本页重新发布"时才换
			// (publish → refreshCurrent, 见上), 所以按需刷新即可。
			// 跨标签页/窗口焦点时刷新 (每日换图) + 重新避让; 用本地缓存时间戳判断, 不每次请求
			window.addEventListener("focus", () => {
				const cached = loadCreditCache();
				if (!cached || Date.now() - cached.at > CREDIT_TTL) refreshCredit();
				refreshCurrent(); // 回到窗口时补一次"当前壁纸"(仍只在 folder 模式取)
				layoutCredit();
			});

			// 服务端拉取 (异步, 不阻塞首屏; 首屏先用 localStorage 缓存渲染)
			syncFromServer();

			// ── 壁纸源 (服务端) 配置控制器: dsh-bing-wallpaper /wallpaper-lists RPC ──
			const wpCfg = createWallpaperCfg(connection);
			// ── 图片列表控制器 (v7.0.0): 黑名单/收藏夹/自定义列表 ──
			const listsStore = createListsStore(connection);

			/** 注入给「壁纸」卡的操作。 */
			const actions = {
				setField: (field, value) => {
					write({ [field]: value });
					// 模式/文件夹相关字段变更时, 背景图已换, 联动刷新右下角介绍 (文件名/标题)
					if (field === "mode" || field === "strategy" || field === "folderPath" || field === "intervalMin" || field === "source" || field === "debugPath") refreshCredit();
				},
				setImage: (value) => {
					write({ image: value });
				},
				reset: () => {
					resetAll();
				},
				preview: (patch) => {
					// 预览：只改样式，不持久化 (滑块只影响面板/磨砂, 背景层 URL 不变不重写)
					const current = loadSection();
					const merged = Object.assign({}, current, patch);
					const image = previewOverride || effectiveImage(merged);
					const bgCss = buildBgCss(image);
					if (bgStyleEl.textContent !== bgCss) bgStyleEl.textContent = bgCss;
					restStyleEl.textContent = buildRestCss(
						image,
						merged.opacity !== void 0 ? merged.opacity : DEFAULT_OPACITY,
						merged.blur !== void 0 ? merged.blur : DEFAULT_BLUR,
						skinMode || "classes",
						merged.surfaceBlur !== void 0 ? merged.surfaceBlur : DEFAULT_SURFACE_BLUR,
						merged.sidebarOpacity !== void 0 ? merged.sidebarOpacity : DEFAULT_SIDEBAR_OPACITY
					);
				}
			};

			// 设置菜单「本地插件」列: 「壁纸」卡 (v3.0.0 由 设置 > 通用 > 背景图 迁入;
			// 设置经 /bg-image RPC 服务端持久化, 所有浏览器统一)
			// 卡只提供 body; 折叠标题行由兄弟槽 settings.localplugin.summary 提供 (同一个 inject 返回值)
			const cardInjected = () => Object.assign({
				hooks: {
					bgImage: cardStore,
					wallpaperCfg: wpCfg.store,
					lists: listsStore.store,
					current: currentStore,
					preview: previewStore
				},
				setPreview,
				clearPreview,
				deleteImage: (p) => listsStore.remove(p),
				saveWallpaperCfg: wpCfg.save,
				resetWallpaperCfg: wpCfg.reset,
				saveLists: listsStore.save,
				refreshCurrent
			}, actions);
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "@ericality/dsh-bg-image",
				locale: NS,
				inject: cardInjected
			}, BgImageCard));

			// ── 左侧栏入口 + 独立页面 (v7.4.0) ──
			// 图标进 sidebar.panellist, 页面进 main (key 与图标 id 一致, 宿主按此配对)。
			// 与设置卡共用 cardInjected ⇒ 同一份 store/操作, 两个入口天然同步。
			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
					inject: cardInjected
				}, BgImagePage));
			} catch (e) { /* main 槽不可用: 只要设置卡 */ }
			try {
				let tNav = null;
				try { tNav = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : null; } catch { /* 老版本无 bind */ }
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 35,
					locale: NS,
					label: () => (tNav ? tNav("page.title") : zh["page.title"])
				}, BgImageIcon));
			} catch (e) { /* panellist 槽不可用: 静默降级 */ }
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-bg-image: settings card dictionaries");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
