# @ericality/dsh-cost-ledger

安装：`dsh plugin --profile web add @ericality/dsh-cost-ledger@0.3.4`


安装：`dsh plugin --profile web add @ericality/dsh-cost-ledger@0.3.4`


Per-session cost ledger for DSH — 会话账本: 回合结束自动记账, 每回合注入一张可折叠的 ledger 横幅卡片 (合计/差值/计算细则), 历史按会话独立保存并经 RPC 实时拉取。

## 安装

```sh
npm i @ericality/dsh-cost-ledger
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载 (server 插件, 无 client bundle)。

## 功能

- `turn/end` 后自动记账 (projcache tokenUsage × 定价, 含推理 tokens), 按会话 id 分桶保存 (每会话最多 50 条, 不全局共享)。
- 每回合注入一张 ledger 青绿横幅卡 (独立 context, 不替换): 合计/本回合差值/计算细则 + 历史快照; 默认折叠不刷屏。
- 客户端展开卡片经 `/cost-ledger` RPC 实时拉取共享账本 (零 token), RPC 失败回退卡内静态快照。
- 有 subagent 后代时卡片附"含子 agent"统计行 (树口径, 各后代账本最新合计; `dsh-cost-tree` 缺失自动降级)。
- 幂等对账 (`attachReconcile`): 宿主重启被掐断的回合在会话恢复时只补"被中断的尾回合"。
- 定价链: 30min 状态缓存 → 官方定价页 → 内置常量。

## 数据路径

状态文件默认落宿主数据目录 (DSH data dir), 均可用环境变量覆盖:

| 用途 | 默认 | 覆盖环境变量 |
|---|---|---|
| 会话账本 | `$DSH_HOME/cost-ledger.json` | `DSH_COST_LEDGER_FILE` |
| 定价缓存 | `$DSH_HOME/cost-ledger-state.json` | `DSH_COST_LEDGER_STATE_FILE` |
| 会话 projcache | `$DSH_HOME/storages/session_projcache.json` | `DSH_COST_LEDGER_PROJCACHE_FILE` |
| 调试日志 | 关闭 | `DSH_DEBUG_LOG` (完整文件路径, 非空才写) |

## 依赖

- peer (宿主提供): `@deepseek-ai/dsh-session`。
- dependencies: `@ericality/dsh-reconcile` (幂等对账)。
- optionalDependencies: `@ericality/dsh-cost-tree` (树口径附注; 缺失自动降级)。
- 横幅渲染依赖同仓插件 `@ericality/dsh-notice-banner`。

## 许可

MIT
