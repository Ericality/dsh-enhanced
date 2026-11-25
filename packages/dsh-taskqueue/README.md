# @ericality/dsh-taskqueue

安装：`dsh plugin --profile web add @ericality/dsh-taskqueue@0.12.1`

Client-level task queue for DSH: park non-urgent prompts and let them be auto-dispatched during off-peak (cheap) windows, at a scheduled time, or right after a host restart.

## 安装

```sh
dsh plugin --profile web add @ericality/dsh-taskqueue@0.12.1
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载 (server 插件 + web 客户端 bundle, 见 `dsh.client.inject`)。

## 功能

- 三种触发时机：等**低谷时段** (官方低价窗口, 动态解析官方定价页, 解析失败回退内置窗口, 缓存 30 分钟) / `--at` 指定时间 (北京时区) / `--on restart` (`-r`, `when="restart"`) 容器重启后 (每次重启尝试一次, 失败保持排队等下次重启)。
- 斜杠命令与模型工具：`/queue add`、`list`、`cancel`、`edit`、`run-now`、`target`；`queue_add` 工具同 RPC 通道。
- 任务绑定入队时的会话：新会话自动"转正" (极简确认 turn)；入队即设确定性标题，并注册 `session_rename` 模型工具供 agent 润色标题。
- 错峰出行模式：设置中开启后高峰时段消息自动入队 (不直达 LLM)；支持单会话豁免 (本会话立即发送)。
- 高峰暂停闸门：运行中的回合在步骤边界暂停 (等待期零 token)，恢复原因如实显示。
- 队列横幅 (kind=queue, 非 surface 事件) 由 `@ericality/dsh-notice-banner` 渲染；浏览器内可直接查看/编辑/取消/立即派发 (经 `/queue` RPC, 不走模型回合)。
- 派发消息开头/结尾可配置（`{id}` / `{content}` 占位符，默认值与旧版逐字一致；设置卡两项可编辑）。

## 设置入口

设置 > 本地插件 > 「任务队列」卡 (开关 + 当前状态 + 豁免开关 + 派发文案)。

## 数据路径（由 DSH_HOME 派生，缺省 `~/.dsh`）

| 用途 | 路径 |
|---|---|
| 队列状态文件 | `$DSH_HOME/plugin-data/taskqueue/taskqueue.json` |
| 错峰模式状态文件 | `$DSH_HOME/plugin-data/taskqueue/offpeak-mode.json` |
| 派发文案配置 | `$DSH_HOME/plugin-data/taskqueue/taskqueue-settings.json` |
| 客户端诊断日志 (默认关闭) | `$DSH_HOME/logs/taskqueue/offpeak-debug.log` |

> `DSH_TASKQUEUE_STATE_FILE` / `DSH_TASKQUEUE_MODE_FILE` / `DSH_TASKQUEUE_SETTINGS_FILE` 仅用于测试与隔离场重定向；生产不设。

## 依赖

- peer (宿主提供): `@deepseek-ai/dsh`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`react`。
- 共享库: `@ericality/dsh-banner-kit`、`@ericality/dsh-cost-tier`、`@ericality/dsh-host-compat`。
- 队列横幅渲染依赖同仓插件 `@ericality/dsh-notice-banner`。

## 许可

MIT
