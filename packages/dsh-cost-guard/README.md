# @ericality/dsh-cost-guard

安装：`dsh plugin --profile web add @ericality/dsh-cost-guard@0.3.2`


安装：`dsh plugin --profile web add @ericality/dsh-cost-guard@0.3.2`


Turn-end cost guard for DSH sessions — 回合结束费用提醒: 保守/激进双阈值评估, 状态气泡 + 结构化费用横幅 (kind=cost) + 未来回合预测, 配置项在设置卡内编辑。

## 安装

```sh
npm i @ericality/dsh-cost-guard
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载 (server 插件 + web 客户端 bundle, 见 `dsh.client.inject`)。

## 功能

- `turn/end` 后计算本回合/累计费用并按两套并行规则评估 (任一条件超限 → 建议切换):
  - 保守 (省钱优先): 回合 >0.40元 | 累计 >3.00元 | 上下文 >180k | 回合 >15
  - 激进 (效率优先): 回合 >1.20元 | 累计 >7.00元 | 上下文 >400k | 回合 >30
- 三态合成: A 双切「建议切换」(每回合显示) / C「丰俭由人」(变 C 首次显示一次) / B 不显示; 附带灰气泡 (running→ok) 与未来 N 回合预测对比。
- 累计口径为树聚合 (cumTree = 自身 + 全部 subagent 后代; `dsh-cost-tree` 缺失 → 自动降级单会话口径)。
- 估算实测优先 (会话事件 request/header + `<system-reminder>`), 不依赖固定常量; 统计写入宿主数据目录状态文件。
- 命令: `/costguard-test` (验证计算, 不推送外部通知) / `/costguard-stats` (查看统计, 只读)。
- 配置唯一入口 = 设置 > 本地插件 > 费用提醒 卡 (经 `/costguard-cfg` RPC, 读取链 默认←patch←卡内覆盖, 即时生效)。

## 数据路径

状态文件默认落宿主数据目录 (DSH data dir), 均可用环境变量覆盖:

| 用途 | 默认 | 覆盖环境变量 |
|---|---|---|
| 定价缓存/展示节奏 | `$DSH_HOME/cost-guard-state.json` | `DSH_COST_GUARD_STATE_FILE` |
| 回合统计 | `$DSH_HOME/cost-guard-stats.json` | `DSH_COST_GUARD_STATS_FILE` |
| 会话 projcache | `$DSH_HOME/storages/session_projcache.json` | `DSH_COST_GUARD_PROJCACHE_FILE` |
| 设置卡 overrides | `$DSH_HOME/cost-guard-settings.json` | `COST_GUARD_SETTINGS_FILE` |
| 调试日志 | 关闭 | `DSH_DEBUG_LOG` (完整文件路径, 非空才写) |

## 依赖

- peer (宿主提供): \`@deepseek-ai/dsh-session\`, \`@deepseek-ai/dsh-client-store\`, \`@deepseek-ai/schemastery\`, \`react\`。
  （0.1.2-rc.1 起宿主已移除 `@deepseek-ai/dsh-client-runtime`，故 peer 改声明为实际注入的 `@deepseek-ai/dsh-client-store`；口径 = **声明合规、不再让 npm 用户多装一个宿主已移除的死包**，不是"装不上"——实测仍装得上。）
- dependencies: `@ericality/dsh-reconcile` (幂等对账)。
- optionalDependencies: `@ericality/dsh-cost-tree` (树聚合; 缺失自动降级)。
- 横幅渲染依赖同仓插件 `@ericality/dsh-notice-banner`。

## 许可

MIT
