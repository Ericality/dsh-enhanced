# @ericality/dsh-notify v0.10.0

安装：`dsh plugin --profile web add @ericality/dsh-notify@0.10.0`


安装：`dsh plugin --profile web add @ericality/dsh-notify@0.10.0`


DSH 通知中枢：**Bark 多设备 + 群晖 Chat**，支持逐项路由、每渠道参数、`{{占位符}}` 完全自定义通知格式，并同时提供：

- **设置 › 本地插件 ›「通知（Bark / 群晖）」卡**（原有入口，保留）；
- **左侧栏「通知」页**（`sidebar.panellist` + `main` 成对注册，同一份数据）。

> 本包**未发布到 npm**（`private: true`）。本地 `.tgz` 已准备好，用官方组合包方式安装即可。

---

## 1. 官方方式安装（本地包，不经过 npm）

前置：profile 里**不能**再保留旧的 `cordis.patch.yml` 手工 insert（同一 id 会重复装载）。

```bash
# 1) 生成/取得本地包（本仓库已生成）
ls ericality-dsh-notify-0.9.2.tgz

# 2a) 在 DSH 会话里用 plugin_manager（推荐）
#     target = 该 tgz 的绝对路径
#     install_bundle(target="/abs/path/ericality-dsh-notify-0.9.2.tgz")

# 2b) 或 CLI
dsh plugin --profile web add file:/abs/path/ericality-dsh-notify-0.9.2.tgz
```

> **本容器（无 pnpm）的等价官方 bundle 路线**：`plugin_manager install_bundle` 需要 pnpm（或启动器提供的
> 包管理器）；当前容器 `which pnpm` 为空 ⇒ 改用手工 bundle 落位（与 `dsh-our-free-model` 同路线）：
> 把 tgz 解到 `profiles/web/node_modules/@ericality/dsh-notify/`，把 `"@ericality/dsh-notify"` 追加进
> `profiles/web/package.json` 的 `dsh.profile.bundles`，移除旧 insert，然后重启 dsh web。
> **这一步会写 `$DSH_HOME`（生产配置），需用户单独授权**。2026-11-22 本机已按此路线装 v0.9.2（未重启；运行中仍是 v0.9.0 内存实例，重启后生效）。

安装完成后**重启 dsh web**（bundle 层在启动时组合）。确认：

- 左栏出现「通知」图标（默认 DSH 大肥鱼图标；资源取不到时回落 🔔）；
- 设置 › 本地插件 › 通知卡可打开；
- `GET /api/notify-hub/get` 返回 `{ ok:true, value:{ devices, templates, tplMeta, defaults ... } }`。

### 从旧安装迁移

旧方式是 `cordis.patch.yml` 里 `insert id=notify name='@deepseek-ai/dsh-notify'` + 手工目录
`profiles/web/node_modules/@deepseek-ai/dsh-notify`。切到本 bundle 前：

1. 删除旧 insert 行；
2. 卸载旧目录/旧依赖（避免 loader 重复）；
3. 再按上面步骤安装本包；
4. 重启。

`$DSH_HOME/notify-hub.json` 的结构向后兼容（version 1/2 均可读），**无需迁移文件**。

---

## 2. 通知格式：模板库（`{{占位符}}`）

**模型：模板是独立配置对象，设备选模板。**

- 初始状态只有两条内置模板：
  - `bark-default`「Bark 默认」：标题 `{{titleFull}}`，正文 `{{body}}`（初始外观不变；想拆开 emoji 可改成 `{{emoji}} {{title}}`）；
  - `synology-default`「群晖 默认」：标题空，正文 `{{body}}`。
  `{{body}}` = 按当前分隔符/内容段组好的旧版正文 ⇒ **未配置时发送外观与 v0.8.x 逐字一致**。
- 内置两条**可编辑、不可删除**；「＋ 新增模板」可创建任意多条，编辑名称/标题/正文后保存。
- **每台设备选一个模板**；一个模板可被多台设备共用，**不限制 Bark/群晖**（设备类型不影响可选性）。
- 设备仍有「高级覆盖（可选）」：`tplTitle`/`tplBody` 优先于所选模板，空 = 用模板。
- 生效顺序：**设备高级覆盖 → 设备所选模板 → 该渠道内置默认 → legacy**。
  所选模板不存在（被删/手工改盘）⇒ 回落内置并置 `missing`（面板/日志可见，不静默）。
- 标题模板 **仅 Bark 生效**（群晖 Chat 没有独立标题字段，请在正文里用 `{{title}}`）。
- 正文渲染后仍受渠道上限约束：群晖 2000 字符/条（自动分页）、Bark 3800 字符（按页切分后用 `sepPageJoin` 拼回）。
- 未知占位符**原样保留**，并在预览/保存说明里点名；不会静默丢弃。
- 「预览」走服务端真实渲染（样句），**零网络、零写盘**；新增模板保存后可预览。

### 维度拆分与实时预览

- `{{title}}` = **纯标题**（去掉开头 emoji，如「任务完成 · 会话名」）；`{{titleFull}}` = 原样完整标题（兼容旧模板）；`{{emoji}}` = **独立维度**。
- 模板可单独设 `emoji` 字段：留空 ⇒ 按通知类型自动（✅/⁉️/❌…）；填了就强制用这个。
- 模板编辑器 / 设备高级覆盖：**输入即实时预览**（本地渲染，不等保存）。
- 占位符选择：**＋ 插入占位符** 面板（常用/标题与状态/内容/时间·设备/分隔符/全部 分组 + 搜索 + 说明常显 + 正文/标题目标选择），不再平铺 30 多个 chips；行高 44px，触屏可用。
- 预览是**标题 / 正文两个独立框**（群晖标题框标注「仅参考，不实际发送」）；空值显示「（空 — 真实发送时才有）」。
- 可读性：模板编辑区/选择器使用**半透明磨砂表面**（`backdrop-filter`）不遮住背景模糊；字号/行高/内边距加大，彩色胶囊改为更高对比的文字色。
- 预览只使用**真实可获取**字段：设备名、时间、类型、emoji、分组/级别、分隔符。
  标题/正文/问答/回合等发送前拿不到 ⇒ **按空串渲染**，并在预览下方点名（不编造示例）。

### 占位符

| 占位符 | 含义 |
|---|---|
| `{{title}}` | 纯标题（不含开头 emoji，如「任务完成 · 会话名」） |
| `{{titleFull}}` | 原样完整标题（含 ✅/⁉️ 前缀，兼容旧模板） |
| `{{status}}` / `{{emoji}}` | 状态文字 / emoji（独立维度；模板 emoji 字段优先） |
| `{{session}}` / `{{sid}}` | 会话标题 / 8 位会话短 id |
| `{{turn}}` / `{{elapsed}}` / `{{elapsedMs}}` / `{{reason}}` | 回合号 / 可读用时 / 毫秒 / 结束原因 |
| `{{question}}` / `{{answer}}` / `{{summary}}` / `{{footer}}` | 问题 / 回答 / 总结段落 / 页脚 |
| `{{body}}` | 按当前分隔符/内容段组好的旧版完整正文 |
| `{{time}}` / `{{date}}` / `{{iso}}` | 发送时刻 / 日期 / ISO 时间戳 |
| `{{type}}` / `{{typeLabel}}` | 通知类型（task.done…）/ 中文名 |
| `{{group}}` / `{{level}}` | 该设备实际生效的 Bark group / level |
| `{{device}}` / `{{deviceName}}` / `{{kind}}` | 设备 id / 名称 / 渠道类型 |
| `{{sepHead}}` `{{sepTail}}` `{{sepTitleQ}}` `{{sepQa}}` `{{sepReplyFooter}}` `{{sepBodyFooter}}` `{{sepPageJoin}}` | 该设备生效的分隔符文本 |

---

## 3. 渠道参数（默认值 = 现有内部配置）

### Bark（每台设备可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `barkGroup` | 按通知类型冻结表 | 留空 ⇒ DSH-任务 / DSH-安全 / DSH-费用 / DSH-队列 / DSH-测试 |
| `barkLevel` | 按通知类型冻结表 | `active` / `timeSensitive` / `passive` / `critical` |
| `barkSound` | 空 | Bark 提示音 |
| `barkIcon` | `https://example.com/dsh-icon-512.png` | **默认 DSH 大肥鱼图标**；可填自定义 URL；填 `none` / `-` ⇒ 不带图标 |
| `barkIsArchive` | `1` | 是否归档到 Bark 历史 |
| `barkTitlePrefix` | 开 | 标题是否加 `[DSH] ` 前缀 |

### 全局公共参数（同类型共享一份，面板可改，即时生效）

| 键 | 默认 |
|---|---|
| `barkTimeoutMs` / `barkRetries` / `barkConcurrency` | 20000 / 1 / 2 |
| `synologyTimeoutMs` / `synologyRetries` / `synologyConcurrency` | 10000 / 0 / 1 |
| `minTurnMs` | patch 初值 10000；运行期以面板为准 |
| `bannerSummary` / `reconcile` | false / true |

群晖单条 2000 字符硬上限、页间隔 1500ms 为内置传输约束，面板/预览会如实显示。

---

## 4. 安全与数据

- 配置：`$DSH_HOME/notify-hub.json`（0600；本插件写，auth-proxy 读）。
- URL / key **只上行**：列表、响应、日志只回尾号（`…末4位`），不落日志。
- 面板「默认配置（内部值）」只读区展示默认参数、当前设备结构与路由，**不含明文 URL**。
- 自有数据只有上述 hub 文件、`$DSH_HOME/notify-reconcile.json` 去重标记、`$DSH_HOME/log/notify/` 调试日志。

---

## 5. 声明偏差（如实）

- `@ericality/dsh-host-compat` / `@ericality/dsh-banner-kit` / `@deepseek-ai/dsh-reconcile` **未发布到 npm**，
  因此本包把它们声明为 **optional peerDependencies**（运行期动态 `import()` + 缺失即降级），
  **不写进 `dependencies`** —— 否则官方 `install_bundle` 会因 registry 404 失败。
  `plugin-release-audit.mjs --strict-decl` 会报 `DEP-MISSING-HOST-COMPAT`，属**有意偏差**（不是漏写）。
- `private: true`：**刻意阻止 `npm publish`**（用户要求「暂不发布 npm」）；本地 tgz 安装不受影响。
- `auth.*`（含 MFA 一次性码）由 **auth-proxy 直接读 hub 并自行发 Bark**，不经过本插件；
  因此模板/默认图标只作用于**经本插件发送**的通知（task / cost / queue / test 以及调用 `notifyHub` 的生产者）。
  要让 auth-proxy 也吃模板，需要单独改 auth-proxy（本包不做）。

## 6. 验证

```bash
node --check lib/index.js && node --check lib/client.js
node $DSH_HOME/scripts/notify-hub-test.mjs          # 既有 59 项语义回归（唯一红为改动前既存环境项）
node $DSH_HOME/scripts/notify-template-test.mjs     # 模板库/设备选模板/覆盖顺序/预览/发送链路（41/41，自动建 stage）
node $DSH_HOME/scripts/localplugin-fold-smoke.mjs   # 设置卡 + 左栏 + 模板库渲染（219/219）
```

发布/安装审计：

```bash
node $DSH_HOME/scripts/plugin-release-audit.mjs @ericality/dsh-notify
```
