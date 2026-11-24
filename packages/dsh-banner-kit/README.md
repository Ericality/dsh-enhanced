# `@ericality/dsh-banner-kit` v0.1.0

安装：`dsh plugin --profile web add @ericality/dsh-banner-kit@0.1.0`


横幅共享库（本地辅助库，**非官方包**）。收敛各自家插件的 `notice/banner` 注入样板：
**事件类型幂等注册** + **唯一 rev 语义实现**（阶段 0 的 B2 修复在此收编）。

- 契约：`docs/待办/2026-09-13-契约-host-compat-v1.md` §1/§2/§9/§10
- 冻结接口（**签名即契约**）：`docs/任务记录/2026-09-13-阶段2-共享派单模板.md` §2.2 + RD-26
- 真源：`projects/dsh-plugins/dsh-banner-kit/`（RD-25：先改真源，publish 仓库阶段 3 统一回写）

## 1. 形态（与 `host-compat` 同级纪律）

| 项 | 约定 |
|---|---|
| 导出面 | **严格 3 个**：`TYPES` · `ensureRegistered` · `emit`（不得多一个、不得少一个） |
| 依赖 | `dependencies: { "@ericality/dsh-host-compat": "0.1.0" }`（§2.2：**不是 peer、不是 optional**）；**零第三方依赖** |
| 宿主声明 | `peerDependencies["@deepseek-ai/dsh"] = "^0.1.2-rc.1"`（§9.2 结论 1）+ 顶层独立字段 `dshCompat` |
| 无 | **无 `apply`**、**无 ctx**、**无 `dsh.client`**（纯库，**不进 Loader entries**，不被客户端扫描） |
| 加载 | 内部动态 `await import("@ericality/dsh-host-compat/seams")` + try/catch + 模块级缓存（§1/§2.3/§10.1） |
| 失败面 | **顶层永不 throw**；一律 `{ ok:false, reason }`（§4 统一约定）；缺失即停用，**不写直连兜底双路径**（§10.2 / D12） |
| 不做 | 不决定 kind、不做文案、不做节流、不加 `time`、不缓存业务状态（只允许「已注册」标志） |

## 2. API

### `TYPES`

```js
["notice/banner", "notice/banner-replace"]
```

### `ensureRegistered(session?) → Promise<{ok:true, registered:string[]} | {ok:false, reason}>`

经 §4.5 `ensureEventTypes(TYPES)` 注册两个自定义会话事件类型。
**幂等**：成功过一次后续调用直接返回缓存结果，**不再调 seam**。
seam 缺失/不可用 ⇒ `{ ok:false, reason:"eventTypeRegistry" }`。

> 未注册的事件类型一旦落盘，会话读取会被 `assertEventsSupported` 拒绝 ⇒ **整个会话加载失败**，
> 因此**注入横幅前必须先注册**（`dsh-notice-banner` / `dsh-cost-ledger` 同法）。

### `emit(session, payload, opts={}) → Promise<{ok:true, mode:"start"|"replace", rev} | {ok:false, reason}>`

| 分支 | 事件类型 | `rev` | `mode` |
|---|---|---|---|
| 默认（`opts.replace !== true`） | `notice/banner` | `payload.rev ?? 0` | `"start"` |
| `opts.replace === true`，**无**同 `kind` 且 `rev===0` 的事件 | `notice/banner` | `0` | `"start"` |
| `opts.replace === true`，**有**同 `kind` 且 `rev===0` 的事件 | `notice/banner-replace` | 同 `kind` 的 `notice/banner` + `notice/banner-replace` **事件总数** | `"replace"` |

- 写入一律经 §4.4 `appendNotice(session, {...payload, rev})`；`mode` 由 seam 依 `rev>0` 判定并回传。
- 失败原因：session 无 / 无 `id` ⇒ `reason:"session"`；host-compat 不可用 ⇒ `reason:"host-compat"`；
  seam 的业务失败（`sessionAppend` / `bad-argument` 等）**原样透传**。
- 历史扫描**只允许**出现在 `replace:true` 分支，且**只读** `type` / `data.kind` / `data.rev`
  三个字段用于 rev 计数（**RD-19 / 教训 L-4**：禁止由历史推断其它 mode）。

**等价参照**（收编对象，逐值等价）：
`dsh-cost-guard/lib/index.js` 的 `appendBanner`（费用横幅 = `replace:true`）
与 `appendStatsBanner`、`dsh-balance` / `dsh-sessions-cost` / `dsh-cost-ledger` / `dsh-notify` / `dsh-taskqueue`
的 `session.append("notice/banner", {time, ...payload})`（统计类横幅 = 默认分支，恒 `start` / `rev=0`）。

## 3. 消费方接入手册（**逐字照抄，勿自创**）

契约 §10.1：**禁用静态 `import`**（缺包 ⇒ 模块加载失败 ⇒ 容器崩溃循环，reconcile 的教训）。
消费方一律**动态 `import()` + try/catch + 缓存 + 降级上报**：

```js
// ---- 动态加载 banner-kit（契约 §10.1 禁静态 import 共享包）----
let bannerKit;            // undefined = 尚未尝试
let bannerKitDead = false; // true = 已判定不可用（不重试）
async function loadBannerKit() {
	if (bannerKit !== undefined) return bannerKit;
	if (bannerKitDead) return null;
	try {
		bannerKit = await import("@ericality/dsh-banner-kit");
	} catch (err) {
		bannerKitDead = true; bannerKit = null;
		LOG(`banner-kit 不可用 → 横幅注入停用: ${String(err?.message ?? err)}`);
		reportDegraded?.("banner-kit");   // 有 host-compat 的插件必须上报（缺则停用，不回落旧直连路径）
	}
	return bannerKit;
}

// apply() 内：先注册事件类型，再注入
const bk = await loadBannerKit();
if (bk) {
	const reg = await bk.ensureRegistered();         // 幂等；失败 ⇒ 不注入（写未注册类型 = 会话无法加载）
	if (reg.ok) { /* 之后每回合: */ }
}
// 注入点：
const r = await bk.emit(session, { time: Date.now(), kind: "ledger", /* …payload */ });
// 原地替换（仅费用类横幅，等价 cost-guard appendBanner）：
const r2 = await bk.emit(session, payload, { replace: true });
if (!r.ok) LOG(`banner-kit 注入跳过: ${r.reason}`);   // 永不 throw，调用方无需 try/catch
```

## 4. 边界（**不做**什么）

- 不管横幅**文案 / 配色 / 徽章 / kind 取值**（属各插件业务，见 `docs/UI改动流程.md` 家族色板）；
- 不做**节流 / 去重 / 触发条件**（属调用方策略）；
- 不做 `time` 注入（默认分支的 `{time, ...payload}` 由调用方给出，保证与改前逐字节一致）；
- 不落盘任何状态（**无** state 文件、**无** 写权限面）；
- 不注册 RPC / 不发通知（那是 hub 与 host-compat 的职责）。

## 5. 已知边界语义（写死，避免每轮返工；编号 = 回报 §② 决策登记，2026-09-13 协调人**全部接受**）

| 裁决 | 情形 | 行为 | 理由 |
|---|---|---|---|
| **D-A2-1** | `readSessionEvents` 返回 `null`（§4.1 能力不可用）或该函数缺失 | 视为"读不到事件" ⇒ `[]` ⇒ `start` / `rev=0` | 契约 §4.4/RD-26 写死 `?? []`；宁可多发一张起点卡（下次自愈为 replace），也不误判 replace |
| **D-A2-2** | host-compat 模块可加载但缺 `appendNotice` | `{ok:false, reason:"host-compat"}` | 面缺失 = host-compat 不可用；不发明新 reason |
| **D-A2-3** | `ensureRegistered(session?)` 的 `session` 参数 | **不校验、不消费**（传 `null`/省略都合法） | 冻结签名标 `session?`；§4.5 seam 只收 `types`；校验会发明未在返回表里的 `reason:"session"` |
| **D-A2-4** | `ensureRegistered` 的 seam 返回 `{ok:false}` | 原样透传其 `reason`；**不**缓存失败（只缓存成功） | 「幂等」= 成功过就不再调；失败缓存会让插件永久静默（违反 §2.3） |
| **D-A2-5** | **默认分支**（`opts.replace !== true`）调用方显式传 `payload.rev > 0` | 透传给 seam ⇒ 实际写入 `notice/banner-replace`，**返回 seam 的 `mode:"replace"`**（即 `mode/rev` = **与实际写入事实一致**，不撒谎） | 契约 §2.2 默认分支写 `rev = payload.rev ?? 0`，而 `rev>0 ⇒ seam 写 replace`；现网**无**调用方传 `rev>0`（默认分支里 cost-ledger L635 显式 `rev:0`、其余不带 rev；`rev>0` 目前只由 cost-guard `appendBanner` 内部算出，将由 C1 迁到本库 `{replace:true}`） |
| — | 同一 `kind` 全为 replace 事件（无 `rev===0` 起点） | `start` / `rev=0` | 逐值等价 cost-guard `appendBanner`（`hasStart` 判据） |
| — | 本库无 `apply` | 不参与 `probe(requires)`（RD-1 运行期对撞不适用） | `dshCompat.seams` 只有静态声明位作用；探测在消费方 apply 内 |

## 6. 部署

- 目标解析链：`$DSH_HOME/profiles/web/node_modules/@ericality/dsh-banner-kit/`（与 `@ericality/dsh-host-compat` 同级）。
- `package.json` 的 `dependencies` 会被部署前 preflight 递归校验（§2.5）⇒ **host-compat 必须先落地**。
- 本包 `files: ["lib"]`，`selftest.mjs` 属开发件，**不随包分发**。
