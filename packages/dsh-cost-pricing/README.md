# `@ericality/dsh-cost-pricing` v0.1.0

安装：`dsh plugin --profile web add @ericality/dsh-cost-pricing@0.1.0`


共享**取价 / 计费**纯库（本地辅助库，非官方包）。把原先 `dsh-balance` / `dsh-cost-ledger` / `dsh-cost-guard` / `dsh-sessions-cost` 里 4 份逐字相同的取价实现收敛成 1 份，并修正「取到 Pro 列」的 bug。

- 真源：`$DSH_HOME/projects/dsh-plugins/dsh-cost-pricing/`
- 契约：`docs/任务记录/2026-09-13-阶段2-共享派单模板.md` §2.1（签名即契约）
- 消费方（B/C 线）：`dsh-balance` / `dsh-cost-ledger` / `dsh-cost-guard` / `dsh-sessions-cost`

## 形态（硬约束）

| 项 | 约定 |
|---|---|
| 第三方依赖 | **零**（只用 `node:fs` / `node:fs/promises`） |
| `apply` / `ctx` / 钩子 | **无**（纯函数 + 一个 fetch） |
| 顶层 throw | **永不**（模块加载不受环境缺失影响） |
| `exports` | 只有 `"."` 与 `"./package.json"` |
| 写文件 | 只写 `${DSH_PRICING_CACHE_DIR:-$DSH_HOME}/cost-pricing-cache.json` 一个文件 |
| 加载方式 | 消费方 **动态** `await import("@ericality/dsh-cost-pricing")` + try/catch（契约 §10.1 禁静态 import 共享包） |

## 导出面（**严格 9 个，多一个少一个都算违约**）

| 导出 | 语义 |
|---|---|
| `FALLBACK_PRICES` | `{peak:{inputMiss:2,inputHit:0.04,output:8}, offpeak:{inputMiss:1,inputHit:0.02,output:4}}`（¥/百万 tokens，RD-29，契约 §2.6「纯数据常量」允许内联） |
| `PRICING_PAGE_URL` | `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`（裸请求 302，需跟随重定向） |
| `tierOf(ms)` | `"peak" \| "offpeak"`；北京时区；周六/周日全天空闲，否则 `9≤h<12 \|\| 14≤h<18` ⇒ peak（逐字复刻 `dsh-cost-ledger.currentTier()`） |
| `parseOfficialPrices(htmlText?)` | `{peak,offpeak} \| null`；不传 `htmlText` 时自己 fetch（UA `Mozilla/5.0`、`AbortSignal.timeout(12000)`） |
| `loadPrices({force}={})` | `{prices, source}`；**永不 null / 永不 throw**；单飞 + 内存单例 |
| `costOf(totals, price, opts={})` | 元；`opts.reasoning`（token 数）按 **输出价** 计入（RD-30） |
| `costOfBuckets(totals, price, opts={})` | `{inputMiss,inputHit,output,reasoning,total}`；`total` 与 `costOf` **逐值相等** |
| `readProjcacheAll()` | `Record<sid, record>`；分片优先 + 单体补历史（逐字复刻 `dsh-balance.readProjcacheAll`） |
| `readProjcacheOne(sid)` | `record \| null`；分片优先，单体回退 |

## 取价解析（本库修掉的核心 bug）

官方定价页切分后形如：

```
（缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元 百万tokens输入
（缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元 百万tokens输出
空闲时段 4元 13.5元 高峰时段 8元 27.0元
```

每段的**第 1 个数字 = Flash 列**、第 2 个 = Pro 列。旧实现从整段取 `nums[3]`（= 高峰 **Pro**）与 `nums[0]` ⇒ 工作日高峰账面虚高 **4.5×**。

本库做法：以 `（缓存命中）` / `（缓存未命中）` / `百万tokens输出` 为锚点取**锚点片段**，片段内**按「空闲时段 / 高峰时段」再切分**，每段取**第一个数字**：

```
peak   = 高峰段首个数字   → 2 / 0.04 / 8
offpeak= 空闲段首个数字   → 1 / 0.02 / 4
```

**锚点片段的边界（RD-41，2026-09-13 协调人批准）**：从锚点起，到「**紧邻的下一个锚点** / 260 字符 / 文本末尾」三者**先到者**为止。必须按锚点截断——否则某行缺自己的标签时，窗口会溢到下一行并**静默借到下一行的数字**（真实页面 `（缓存命中）` 与 `（缓存未命中）` 仅相距 52 字符），与「解析异常 ⇒ null」冲突。`百万tokens输出` 之后无同类锚点 ⇒ 退回 260 字符窗口。

**解析异常（任一锚点缺失 / 时段标签缺失 / 段内无数字）⇒ 返回 `null`，绝不套兜底**——由 `loadPrices` 决定「保留旧缓存」还是「用内置常量」。

## `loadPrices` 降级链（永不 null / 永不 throw）

```
① 状态缓存 (pricesFetchedAt 30 分钟内 且 force!==true)   → source: 缓存(30分钟内) HH:mm
② parseOfficialPrices()                                  → source: 官方页解析 HH:mm   (写回缓存文件)
③ 上次缓存 (状态文件里的旧价 / 进程内上次成功取到的价)     → source: 上次缓存
④ FALLBACK_PRICES                                        → source: 内置常量
```

- **自有缓存文件**：`${DSH_PRICING_CACHE_DIR:-$DSH_HOME}/cost-pricing-cache.json`，形状 `{prices, pricesFetchedAt}`。
- **迁移期兼容读取（⚠️ 30 分钟窗口边界）**：自有文件不存在时，按序读 `${DSH_PRICING_CACHE_DIR:-$DSH_HOME}/` 下的 `cost-ledger-state.json` → `cost-guard-state.json` → `balance-state.json` → `sessions-cost-state.json` 的 `prices`/`pricesFetchedAt`，**原样当作初始缓存**（不校验、不改写那些文件）。
  - 命中条件是**同一套 30 分钟 TTL**：旧 state 的 `pricesFetchedAt` 在 30 分钟内 ⇒ 直接以 `缓存(30分钟内) HH:mm` 返回**旧 state 里的价**；超过 30 分钟 ⇒ 正常走抓页。
  - **边界含义**：生产旧 state 的 live 价是 bug 期的 **Pro 列**（`peak 9/0.3/27`）⇒ 部署后最长 30 分钟内可能仍以「缓存」名义供 Pro 列价；若期间抓页持续失败，则 `上次缓存` 会继续供该旧价（**无上界**）。⇒ **部署时必须把旧 state 的 `pricesFetchedAt` 置 0（或删旧 state）强制重解析**（协调人部署清单已含此步），这是本库**不做**契约外启发式（不猜「这个价是不是 Pro 列」）的直接后果。
- **本库不写**任何插件的 `*-state.json`（状态文件归属写死）；落地后全局抓页从「最坏 5 次/30min」降为 **1 次/30min**。
- **单飞**：并发 `loadPrices()` 共享同一个 in-flight Promise ⇒ 只触发一次抓页；`force:true` 绕过 TTL，但仍走单飞。
- **内存单例**：上次成功取到的价在进程内保留，**仅在状态文件读不到时**作为 TTL 新鲜值 / 最后回退（有状态文件时一律以文件为准，避免内存态遮蔽过期文件）。

## 环境变量（仅供测试/本地校验）

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_PRICING_CACHE_DIR` | 价格缓存文件所在目录（含旧 state 迁移读取目录） | `$DSH_HOME` |
| `DSH_PROJCACHE_DIR` | projcache **分片**目录 | `$DSH_HOME/storages/session_projcache/sessions` |
| `DSH_PROJCACHE_FILE` | projcache **单体**表文件 | `$DSH_HOME/storages/session_projcache.json` |

## 自测

> `selftest.mjs` 与 `revcheck.mjs` 是**开发件（反向验证用），不随包分发**：`package.json#files` 只含 `lib/index.js` 与 `README.md`。

```bash
cd $DSH_HOME/projects/dsh-plugins/dsh-cost-pricing
node selftest.mjs                    # 全绿 exit 0；离线，不联网（fetch 被 stub 计数）
```

反向验证（把高峰取数改回「每段第 4 个数字」⇒ 断言 1 必须变红；真源不改，副本落 `/tmp`）：

```bash
node $DSH_HOME/projects/dsh-plugins/dsh-cost-pricing/revcheck.mjs   # 期望 exit 0 = 如预期变红(T1 + 6 条, exit 1)
```

## 计费口径

```
cost = ((uncachedInputTokens + (cacheWriteTokens ?? 0)) * inputMiss
      + (cacheReadTokens ?? 0) * inputHit
      + outputTokens * output) / 1e6
      + (opts.reasoning ?? 0) * output / 1e6            # 元；RD-30 reasoning 按输出价
```

`totals` 缺字段按 0，非有限数一律 0 ⇒ **永不 throw / 不返回 NaN**。

- `costOf` **逐字复刻**既有实现（balance / cost-ledger / cost-guard 同源算式）⇒ 与旧 `costOf` **逐位一致**（`reasoning` 缺省为 0 时加 0 不改变取值），golden 对撞不会出现浮点末位差。
- `costOfBuckets.total` 取 `costOf` 的值 ⇒ **`total === costOf` 逐值相等**。
- ⚠️ 浮点结合律：`total` 与「四项字面相加」在末位（相对 ≲1e-9）可能不同 —— 契约模板 §2.1 同时要求「total = 各项和」与「total 与 costOf 逐值一致」，同一浮点体系下不可兼得；本库以「与 costOf 逐值一致 + 与旧实现逐位一致」为先。对撞时请用 1e-9 容差比对四项之和，或直接对撞 `costOf`。
