# @ericality/dsh-notice-banner

安装：`dsh plugin --profile web add @ericality/dsh-notice-banner@0.11.7`


安装：`dsh plugin --profile web add @ericality/dsh-notice-banner@0.11.7`


Banner UI for DSH — 通知横幅（host + 浏览器 client 混合插件）：注册 `notice/banner` 会话事件类型，并把服务端注入的横幅事件渲染为带主题色的聊天卡（cost / queue / ledger / restart 等家族）。

## 安装

```sh
npm i @ericality/dsh-notice-banner
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载（服务端 `apply` + client bundle 注入）。

## 功能

- host half（`lib/index.js`）：把 `notice/banner` 与 `notice/banner-replace` 注册进宿主的 `KNOWN_SESSION_EVENT_TYPES`，使持久化读取路径接受这些自定义会话事件类型（`Set.add` 幂等）。
- client（`lib/client.js`，`exports["./client"]`）：把横幅事件渲染为会话中的横幅卡，按 kind 分家族配色（费用 / 任务完成 / 队列入队 / 余额 / 错误 / 会话账本 / 多会话费用 / 状态迷你行 / 优雅重启），含队列面板、账本委托树等交互组件。
- 事件由宿主内其他插件注入（dsh-cost-guard / dsh-notify / dsh-taskqueue / dsh-balance / dsh-sessions-cost / dsh-cost-ledger 等），本包只负责类型注册与渲染，无跨包 npm 依赖。

## 依赖

peer：`@deepseek-ai/dsh-session`（宿主，服务端）；`react`（浏览器端，由宿主 client 运行时提供）。
client 注入（`dsh.client.inject`，web 平台）：由宿主提供 `@deepseek-ai/dsh-client-locale` / `@deepseek-ai/dsh-client-ui-conversation`（bundle 本身仅 `require("react")`）。

## 许可

MIT
