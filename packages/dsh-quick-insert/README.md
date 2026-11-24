# @ericality/dsh-quick-insert

安装：`dsh plugin --profile web add @ericality/dsh-quick-insert@0.1.3`


安装：`dsh plugin --profile web add @ericality/dsh-quick-insert@0.1.3`


Quick-insert pill buttons above the DSH composer input — 输入框上方一行可横向滑动的按钮，点击把按钮文本插入输入框光标处；按钮列表可在设置面板里增删改。

## 安装

```sh
npm i @ericality/dsh-quick-insert
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件加载（服务端 `apply` + web 客户端 bundle，见 `dsh.client.inject`）。

## 功能

- 输入框上方「快速插入」按钮行（`conversation.input.dock`，id `quick-insert`）：青柠绿玻璃胶囊、横向可滑动；命令类（label 以 `/` 开头）按钮用等宽字体。
- 点击把按钮文本插入输入框**光标处**（经会话作用域 conversation 服务 `insertText`，span CAS 防过期；失败回退追加到末尾）。
- 客户端同时注册一个宿主设置扩展槽（host settings extension slot，settings.section id `local-plugins`）：各插件的配置卡经 `settings.localplugin.item` 槽注册进该列；本包提供首卡「快速插入」——按钮列表 增删改 + 排序 + 实时预览 + 保存/取消/重置默认。
- 配置经服务端 RPC 通道 `/quick-insert`（`get` / `set {buttons}` / `reset`）读写并持久化，远程浏览器照常生效；文件缺失/损坏时回退内置默认按钮。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `buttons[]` | 内置示例按钮 | 每项 `{ label: 按钮显示名, text: 点击插入的文本 }`；label 以 `/` 开头按命令样式显示 |

状态文件默认落宿主数据目录 `$DSH_HOME/quick-insert.json`，可用环境变量 `DSH_QUICK_INSERT_STATE_FILE` 覆盖。

## 依赖

- peer（宿主提供）：\`react\`（浏览器端）；\`@deepseek-ai/dsh-client-store\`（client 运行时）。
- client 注入（\`dsh.client.inject\`，web 平台）：由宿主提供 \`@deepseek-ai/dsh-client-locale\` / \`dsh-client-store\` / \`dsh-client-connection\` / \`dsh-client-ui-conversation\` / \`dsh-client-ui-settings\`。
  （0.1.2-rc.1 起宿主已移除 `@deepseek-ai/dsh-client-runtime`，故 peer 改声明为实际注入的 `@deepseek-ai/dsh-client-store`；口径 = **声明合规、不再让 npm 用户多装一个宿主已移除的死包**，不是"装不上"——实测仍装得上。）

## 许可

MIT
