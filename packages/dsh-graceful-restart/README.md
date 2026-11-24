# @ericality/dsh-graceful-restart

安装：`dsh plugin --profile web add @ericality/dsh-graceful-restart@0.1.12`


安装：`dsh plugin --profile web add @ericality/dsh-graceful-restart@0.1.12`


Graceful host restart for DSH — 优雅重启排程：等所有会话/子 agent 空闲、用户确认后，静默观察一段无活动窗口再经宿主 `appExit` 自然退出，不掐断进行中的回合（重启后无 interrupted 合成、不浪费 token）。

## 安装

```sh
npm i @ericality/dsh-graceful-restart
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载（依赖宿主 `commands` / `agents` / `tools` / `connection` 注入）。

## 功能

- 命令 `/graceful-restart [原因]` — 排程重启；空闲后横幅出现 [确认重启] 按钮作二次确认，可 [取消]；15 分钟未确认自动取消。
- 命令 `/graceful-restart-cancel` — 取消进行中的排程。
- 模型工具 `graceful_restart` — agent 触发入口（调用前必须先询问用户确认）。
- 浏览器 RPC `/graceful-restart`（`status` / `confirm` / `cancel`）— 横幅按钮面板通道，零 token。
- 横幅经 `notice/banner` / `notice/banner-replace` 事件类型原地替换，状态机：`scheduled → ready → observing → exiting`（或 `cancelled / timedout`）；观察期任何活动重置静默窗口，绝不强制掐断。
- 启动后扫描各会话日志，把重启前遗留的未终结横幅标记为失效（`invalid`），避免僵尸横幅误导。

## 配置

插件详情页有配置卡（Plugins 页 → 本插件 → 配置），保存后下一次排程即按新配置执行，无需重启；已排程中的重启不因改配置取消。

| 键 | 默认 | 说明 |
|---|---|---|
| `quietWindowSec` | `10` | 所有会话空闲后连续静默多少秒才退出（3 到 120） |
| `timeoutMin` | `15` | 排程后多久未确认自动取消（1 到 120 分钟） |
| `allowAgentTrigger` | `true` | 关闭后模型工具不能发起重启，用户命令仍可用 |

配置落 `$DSH_HOME/plugin-data/graceful-restart/settings.json`（`schemaVersion 1`），读写端点 `/api/graceful-restart/config/get`、`/set`、`/reset`；坏值由服务端拒绝且原值不变。轮询间隔仍为 2s 代码常量；debug 日志默认关闭，设置环境变量 `DSH_DEBUG_LOG` 开启。

## 依赖

peer：`@deepseek-ai/dsh-session`（`KNOWN_SESSION_EVENT_TYPES`）、`@deepseek-ai/dsh-tools`（`defineTool`）。
横幅渲染需宿主客户端支持 `notice/banner`（如配合横幅类插件 `@ericality/dsh-notice-banner`）。

## 许可

MIT
