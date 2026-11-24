# @ericality/dsh-sessions-cost

安装：`dsh plugin --profile web add @ericality/dsh-sessions-cost@0.2.2`


安装：`dsh plugin --profile web add @ericality/dsh-sessions-cost@0.2.2`


Multi-session cost report for DSH — 多会话费用统计: `/sessions-cost [小时数]` 在时间窗口内按会话日志逐事件统计 token 与费用 (分高峰/低谷计价), 结果以可折叠横幅展示, 支持子 agent 树分组。

## 安装

```sh
npm i @ericality/dsh-sessions-cost
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载 (server 插件, 无 client bundle)。

## 功能

- 命令 `/sessions-cost [小时数]` (默认 24, 支持小数, 上限 8760): 本地计算近 N 小时窗口内各会话费用。
- 匹配"窗口内有 token 消耗"的会话; 解码会话日志 (多 zstd 帧) 逐事件统计输入/缓存命中/输出+推理, 按事件时刻分高峰/低谷计价。
- 每会话明细每种类型一行 (`token × 单价 = 金额`), 高峰/低谷分档; 结果以 notice/banner 横幅 (kind=costs 天蓝家族, 默认折叠, 展开手风琴全量不省略可滚动) 展示, 零 token (非 surface 事件)。
- 树分组: 窗口内存在 subagent 委托结构时, 行级标注 `treeGroup {parentSid?, childCount}` + 每行窗口内树合计 (每行只算自己不双计), 客户端树形分组渲染; 库缺失/无结构 → 平铺 (兼容)。
- 定价链: 官方定价页解析 (12s 超时, 不调计费 API) → 30min 状态缓存 → 内置常量。

## 数据路径

数据源默认指向宿主数据目录 (DSH data dir), 可用环境变量覆盖:

| 用途 | 默认 | 覆盖环境变量 |
|---|---|---|
| 会话清单/标题/最后活动 (projcache) | `$DSH_HOME/storages/session_projcache.json` | `DSH_SESSIONS_COST_PROJCACHE_FILE` |
| 会话日志根目录 | `$DSH_HOME/sessions` | `DSH_SESSIONS_COST_SESSIONS_ROOT` |
| 定价缓存 | `$DSH_HOME/sessions-cost-state.json` | `DSH_SESSIONS_COST_STATE_FILE` |


## 配置

插件详情页有配置卡（Plugins 页 → 本插件 → 配置），保存后下一次命令或回合即按新配置执行，无需重启。
配置落 `$DSH_HOME/plugin-data/sessions-cost/settings.json`（`schemaVersion 1`），读写端点 `/api/sessions-cost/config/get`、`/set`、`/reset`；坏值（负数、超范围、非数字、类型错）由服务端拒绝且原值不变。

| 键 | 默认 | 说明 |
|---|---|---|
| `defaultHours` | `24` | /sessions-cost 不带参数时的统计窗口（1 到 720 小时） |
| `defaultCollapsed` | `true` | 多会话费用横幅的默认折叠（由 dsh-notice-banner 渲染） |
| `showBreakdown` | `true` | 关闭后横幅只保留合计与窗口统计，逐会话明细不显示 |

## 依赖

- peer (宿主提供): `@deepseek-ai/dsh-session`。
- optionalDependencies: `@ericality/dsh-cost-tree` (树分组标注; 缺失自动降级平铺)。
- 横幅渲染依赖同仓插件 `@ericality/dsh-notice-banner`。

## 许可

MIT
