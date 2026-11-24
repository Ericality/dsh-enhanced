# dsh-bg-image

页面背景壁纸：整页铺图 + 磨砂 + 右下角介绍，服务端保存，所有浏览器统一。

安装：`dsh plugin --profile web add @ericality/dsh-bg-image@8.0.0`

## 三种模式

- 每日：默认 Bing 直连（`HPImageArchive` 取当日图），可在配置里把 `daily.source` 换成自建源或图片直链。
- 文件夹随机：从壁纸库目录随机取图，策略 `every`（每次请求）/ `daily`（当天固定）/ `interval`（固定间隔）。
- 自定义：填图片直链或 `data:`。

## 端点

服务端提供七个同源端点，客户端一律用相对基址，挂在反向代理前缀下也不会 404：

| 端点 | 用途 |
|---|---|
| `/api/wallpaper/daily` | 当日壁纸图片，`?w=` 按宽度出图 |
| `/api/wallpaper/daily-meta` | 当日壁纸介绍 JSON |
| `/api/wallpaper/folder` | 文件夹随机壁纸 |
| `/api/wallpaper/folder-meta` | 当前文件夹壁纸介绍 |
| `/api/wallpaper/list` | 图片清单 |
| `/api/wallpaper/thumb` | 缩略图 |
| `/api/wallpaper/current` | 本页当前壁纸 |

## 配置

配置走宿主官方 Config，在插件页保存即生效：`mode`、`strategy`、`intervalMin`、`image`、`debugPath`、
`look.*`（透明度与磨砂）、`folder.*`（根目录、子目录、递归、扩展名、锁定毫秒）、
`daily.*`（源、刷新时间、缓存与超时）。敏感项留空即用默认，不需要填写任何部署地址。

## 数据与迁移

运行数据在 `$DSH_HOME/plugin-data/bg-image/`：`wallpaper-lists.json`（黑名单/收藏/自定义列表）、
`wallpaper-thumbs/`（缩略图缓存）、`wallpapers/`（默认壁纸库）。

从旧版升级时，首次启动会读 `bg-image-settings.json` 与 `bing-wallpaper-config.json`，
合并写入新配置并把旧文件改名 `.bak` 留档；旧版图片列表文件同时搬到新数据目录。

## 可选依赖

缩略图优先用 ImageMagick 的 `convert`；没有该命令时自动回落原图并记一条 warn。

## 许可

MIT
