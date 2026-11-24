# dsh-mesh-panel

安装：`dsh plugin --profile web add @ericality/dsh-mesh-panel@0.5.7`


多端互联面板：把多台设备配对成只读互联面板，在一台设备的界面里查看对端会话与运行状态。

安装：`dsh plugin --profile web add @ericality/dsh-mesh-panel@0.5.7`

## 能力

- 双向配对与指纹钉住，配对关系写在插件自有数据目录。
- 代理优先：桌面端使用自带回环中继，浏览器端走 `/mesh` 中继。
- 对端只读：面板只展示对端会话摘要与日志，不写入对端数据。
- 地址自动校正：配对后对端地址变化会在下一次心跳时更新。
- 自监听端口可配置，默认值见配置页。

## 配置

插件页的配置项包括对端主机、监听端口与心跳间隔。对端主机按 `peer.example.com` 或 IP 填写，不要把生产域名写进默认值。

## 数据

运行状态写在 `$DSH_HOME/plugin-data/mesh-panel/`，删除该目录等价于清空配对与缓存。

## 依赖

宿主提供 `@deepseek-ai/dsh` 与 cordis；`@ericality/dsh-host-compat` 作为依赖自动安装，缺失时面板降级为单机模式。

## 许可

MIT
