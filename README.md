# dsh-enhanced

让 DeepSeek Harness 更省心的插件集：费用可见、重启不慌、通知到位、配置集中。

安装一个包即可用，没有必装的服务端。所有包都是 MIT 或 BSD-3-Clause，配置在插件页保存，重启后仍在。

## 安装

```sh
dsh plugin --profile web add @ericality/dsh-cost-guard@0.3.2
```

装完跑一回合，回合结束会收到一张费用横幅卡。其余包按需安装，互不依赖。

## 包清单

| 包 | 干什么 | 版本 |
|---|---|---|
| `@ericality/dsh-cost-guard` | 回合结束费用提醒：双阈值 + 预测 + 子 agent 树累计 | 0.3.2 |
| `@ericality/dsh-cost-ledger` | 会话账本：每回合自动记账，可折叠明细卡 | 0.3.5 |
| `@ericality/dsh-sessions-cost` | 按时间窗口统计各会话费用，高峰与低谷分别计价 | 0.2.2 |
| `@ericality/dsh-balance` | 余额与费用看板（/balance、/balance-detail、/cost） | 0.1.2 |
| `@ericality/dsh-notice-banner` | 把费用、队列、通知等事件渲染成会话横幅卡 | 0.11.7 |
| `@ericality/dsh-notify` | 回合完成、提问、中断推送到手机，带独立通知页 | 0.9.7 |
| `@ericality/dsh-graceful-restart` | 等所有会话空闲后优雅重启，不打断回合 | 0.1.12 |
| `@ericality/dsh-quick-insert` | 输入框上方的快捷插入按钮行 | 0.1.3 |
| `@ericality/dsh-bg-image` | 背景壁纸：Bing 每日、文件夹随机、自定义 | 8.0.0 |
| `@ericality/dsh-pwa` | 移动端主屏安装（图标、独立窗口、PWA 清单） | 0.1.2 |
| `@ericality/dsh-mesh-panel` | 多端互联面板：配对后只读查看对端会话 | 0.5.7 |
| `@ericality/dsh-host-compat` | 插件共享底座：能力探测、三态降级、共享 seam | 0.1.1 |

共享库（被上面的插件自动装上，不需要单独安装）：

| 包 | 干什么 | 版本 |
|---|---|---|
| `@ericality/dsh-banner-kit` | 横幅事件注册、去重与发送助手 | 0.1.0 |
| `@ericality/dsh-reconcile` | 把回合结束变成可重放的对账记录 | 0.1.1 |
| `@ericality/dsh-cost-pricing` | 官方定价解析、价格缓存与费用计算 | 0.1.0 |
| `@ericality/dsh-cost-tree` | 按会话血缘汇总子 agent 用量与费用 | 0.1.1 |
| `@ericality/dsh-cost-tier` | 高峰与低谷判定、节假日表 | 0.1.0 |

## 插件市场索引（Discover）

本仓公开发布一个插件市场索引，格式为 format 1，共 12 个可安装 bundle（5 个纯库不列）：

    https://ericality.github.io/dsh-enhanced/market/index.json

添加步骤（可照抄）：

1. 打开侧栏的「插件」页。
2. 在「实验性插件」下启用「自定义插件索引」（对应 `@deepseek-ai/dsh-experimental-plugin-market-bundle`）；未启用时插件页没有「发现」标签。
3. 切到「发现」标签，点「添加索引源」，把上面的索引 URL 粘进去并保存。
4. 之后即可在「发现」里浏览并安装；每个插件当前只列一条版本，安装规格就是包名加版本，例如：

```sh
dsh plugin --profile web add @ericality/dsh-cost-guard@0.3.2
```

维护者：索引由脚本生成，改了包版本或图标后重跑一次即可（无第三方依赖，需能访问 registry.npmjs.org）：

```sh
node scripts/gen-market-index.mjs
```

脚本读 `packages/*/package.json`、`locale/en.json` 与 `locale/zh.json`，以及 npm registry 的 `time` 字段；图标内联为 data URI，位图超 32 KiB 会按整数倍降采样重编码，脚本不含生成时间、重复运行字节一致。

## 未发布

- `dsh-bing-wallpaper` 已并入 `dsh-bg-image` 8.0.0，源码留档在 `archive/dsh-bing-wallpaper-7.6.1/`。
- `dsh-taskqueue` 暂缓（有 bug 待修）。
- `dsh-model-console`、`dsh-fileserve`、`dsh-auth-mfa`、`dsh-remote-settings`、`dsh-cf-archive` 私有。
- `dsh-handoff`、`dsh-finish` 废弃。

## 许可

MIT 或 BSD-3-Clause，见各包 LICENSE。
