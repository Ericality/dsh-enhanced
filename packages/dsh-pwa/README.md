# @ericality/dsh-pwa

安装：`dsh plugin --profile web add @ericality/dsh-pwa@0.1.2`

让 iOS Safari 与移动浏览器可以把 dsh 网页「添加到主屏幕」当独立 App 使用。三套图标、清单与主题色都按当前配置实时生成，配置页改完刷新即生效，不需要重启。

## 功能

- **三套图标**：`sky`（默认）、`lav`、`mint`，各带 180×180 与 512×512 两档，随包发布在 `assets/`。
- **实时清单** `/manifest.webmanifest`：`name`、`short_name`、`theme_color`、`background_color`、`display` 与图标列表全部按当前配置生成，模块加载期不缓存任何清单常量。
- **实时图标**：`/apple-touch-icon.png`（180）与 `/dsh-icon-512.png`（512）按当前图标主题出图，响应带 `no-store`，切换后刷新即变。
- **页头注入**：`apple-mobile-web-app-capable`、`mobile-web-app-capable`、`theme-color`（取配置）与指向实时图标的 `apple-touch-icon` 链接。
- **配置页**：插件详情页的 `plugins.bundle.config` 卡（`view=page`），三套图标预览网格 + 五个字段 + 保存；读写走自有 RPC。
- **RPC**：`/api/pwa/config/get` 与 `/api/pwa/config/set` 经 `@ericality/dsh-host-compat` 的通道面注册，返回 `{ok:true,value}` / `{ok:false,error}`，与配置页共用同一份数据。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `icon` | `sky` | 图标主题，可选 `sky` / `lav` / `mint` |
| `name` | `DeepSeek Harness` | 清单 `name`，主屏图标下方与启动页显示 |
| `shortName` | `DSH` | 清单 `short_name`，空间不足时使用 |
| `themeColor` | `#4D6BFE` | 清单 `theme_color` 与页面 `theme-color` |
| `backgroundColor` | `#101320` | 清单 `background_color`，独立窗口启动底色 |
| `display` | `standalone` | 清单 `display`，可选 `standalone` / `fullscreen` / `minimal-ui` / `browser` |

配置值走宿主官方 Config（volatile 字段），由宿主校验并写入 profile；页面保存后下一次请求即取新值，无需重启。

## 端点

| 路径 | 说明 |
|---|---|
| `GET /manifest.webmanifest` | 按当前配置生成的 PWA 清单 |
| `GET /apple-touch-icon.png` | 当前主题的 180×180 图标 |
| `GET /dsh-icon-512.png` | 当前主题的 512×512 图标 |
| `GET /pwa-icon-<theme>-<size>.png` | 配置页预览用：三套 × 两档，共 6 张 |
| `POST /api/pwa/config/get` | 读当前配置 |
| `POST /api/pwa/config/set` | 保存配置（返回保存后的完整配置） |

## 安装与生效

```sh
npm i @ericality/dsh-pwa
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载（`inject=["webServer"]`），配置页为客户端 bundle（`dsh.client.platform=web`）。

生效后：Safari 分享菜单 → 添加到主屏幕 → 图标独立全屏打开。改图标或主题色后刷新一次页面即可看到新值，已添加到主屏的图标会随清单 `v` 参数更新。

## 依赖

- `@ericality/dsh-host-compat`：RPC 通道面（`/api/pwa/config/*`）。
- peer：`@deepseek-ai/dsh`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react`。

## 许可

BSD-3-Clause
