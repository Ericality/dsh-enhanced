# @ericality/dsh-balance

安装：`dsh plugin --profile web add @ericality/dsh-balance@0.1.2`


安装：`dsh plugin --profile web add @ericality/dsh-balance@0.1.2`


Balance and cost dashboards for DSH — 斜杠命令 /balance /balance-detail /cost: 实时 DeepSeek 余额、间隔差值预估、累计用量与当前会话费用, 以结构化横幅展示 (零 token)。

## 安装

```sh
npm i @ericality/dsh-balance
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载 (server 插件, 无 client bundle)。

## 功能

- `/balance` — 简洁版: 实时余额 / 间隔 (时间范围+时段) / 本次差值预估 / 官方扣费 (kind=balance 横幅, mode=overview)。
- `/balance-detail` — 详细版: token 差值明细 + 运算过程 + 定价来源 + 累计 (mode=detail)。
- `/cost` — 当前会话费用预估 (纯本地, 不打官方 API; mode=session); 树口径: 有 subagent 后代时聚合自身 + 全部后代 (`dsh-cost-tree` 缺失自动降级单会话)。
- 横幅为非 surface 会话事件: 不进模型历史、不消耗模型 token。
- 定价: 官方定价页解析 → 缓存 (<30min) → 内置常量; 时段按北京高峰/低谷分类。
- 快照状态文件用于计算与上次运行之间的差值。

## 密钥与数据路径

API 密钥解析顺序: `DEEPSEEK_API_KEY` 环境变量 → 凭证 YAML 文件。凭证文件默认指向宿主数据目录下的 `.credentials.yaml`, 可用环境变量覆盖:

| 用途 | 默认 | 覆盖环境变量 |
|---|---|---|
| 凭证 YAML (含 `DEEPSEEK_API_KEY:` 字段) | `$DSH_HOME/.credentials.yaml` | `DSH_BALANCE_CREDENTIALS_FILE` |
| 会话 projcache | `$DSH_HOME/storages/session_projcache.json` | `DSH_BALANCE_PROJCACHE_FILE` |
| 快照/定价缓存 | `$DSH_HOME/balance-state.json` | `DSH_BALANCE_STATE_FILE` |

> 建议优先用 `DEEPSEEK_API_KEY` 环境变量注入密钥; 凭证文件路径亦可用 `DSH_BALANCE_CREDENTIALS_FILE` 指向自定义位置。


## 配置

插件详情页有配置卡（Plugins 页 → 本插件 → 配置），保存后下一次命令或回合即按新配置执行，无需重启。
配置落 `$DSH_HOME/plugin-data/balance/settings.json`（`schemaVersion 1`），读写端点 `/api/balance/config/get`、`/set`、`/reset`；坏值（负数、超范围、非数字、类型错）由服务端拒绝且原值不变。

| 键 | 默认 | 说明 |
|---|---|---|
| `alertThresholdYuan` | `0` | 余额低于该值时 /balance 与 /balance-detail 多输出一行提醒；0 表示不提醒 |
| `pricingCacheMinutes` | `30` | 价格缓存有效期（分钟），配得更短时强制刷新官方价目 |
| `includeSubagents` | `true` | 关闭后 /cost 只统计当前会话，不含委托子会话 |

## 依赖

- peer (宿主提供): `@deepseek-ai/dsh-session`。
- optionalDependencies: `@ericality/dsh-cost-tree` (/cost 树口径; 缺失自动降级)。
- 横幅渲染依赖同仓插件 `@ericality/dsh-notice-banner`。

## 许可

MIT
