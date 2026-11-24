# @ericality/dsh-pwa

安装：`dsh plugin --profile web add @ericality/dsh-pwa@0.1.1`


安装：`dsh plugin --profile web add @ericality/dsh-pwa@0.1.1`


iOS Safari PWA support for DSH — 让手机 Safari 可把 dsh 网页「添加到主屏幕」当独立 App 使用。

## 安装

```sh
npm i @ericality/dsh-pwa
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载（服务端插件，`inject=["webServer"]`）。

## 功能

- 提供 180×180 `apple-touch-icon.png`：优先读部署方 assets 目录里的图标文件，缺失时回退为程序生成的纯色占位图标（纯 Node PNG 编码，无依赖）。
- 注入 iOS 专用 meta/link 标签（`apple-mobile-web-app-capable` / `theme-color` / `apple-touch-icon`）。
- 覆盖 `/manifest.webmanifest`：`display=standalone` + 图标列表（assets 存在 512 图标时一并注册 `/dsh-icon-512.png`）。

生效后：Safari 分享菜单 → 添加到主屏幕 → 图标独立全屏打开。

## 配置

无 Config schema。图标来源目录默认 `$DSH_HOME/assets`，可用环境变量 `DSH_PWA_ASSETS_DIR` 覆盖（缺文件时自动回退程序生成图标）。

## 依赖

peer：无（仅用宿主 `webServer` 服务与核心事件钩子）。

## 许可

MIT
