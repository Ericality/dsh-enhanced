# @ericality/dsh-host-compat

安装：`dsh plugin --profile web add @ericality/dsh-host-compat@0.1.2`


**插件共享底座 · 宿主适配层（host-compat v1）** — 本地辅助插件，非官方包。

> 唯一契约来源：`docs/待办/2026-09-13-契约-host-compat-v1.md`（v1 冻结，禁止发明字段）
> 落点与裁决：`docs/待办/2026-09-13-阶段1-契约落点与决策.md`（§2 落点表 / §3 RD-1…RD-8 / §5 文件分区）
> 本 README 只描述**已实现面**与**使用方式**；契约字段以契约文件为准。

---

## 1. 这个包解决什么

宿主升级（0.1.x → 0.1.2-rc.1）会让插件**静默失效**：`session.events` 消失、投影缓存改分片、
RPC 注册形状变化……每个插件各写一套兼容判断 = N 份会漂移的代码。
本包把"**宿主能力探测 + 访问适配 + 降级上报**"收成一处：

| 面 | 做法 |
|---|---|
| 探测 | §3 十个能力 key，boot 时算一次（方法存在性 / 路径形状 / 服务存在性；**不调有副作用 API**） |
| 三态 | `OK` / `DEGRADED` / `BLOCKED`（`agents` 缺失 = BLOCKED，D1） |
| seam | §4 的访问面**纯函数**，永不 throw，失败返回 `{ok:false,reason}` |
| 状态 | §5 `${DSH_COMPAT_DIR:-$DSH_HOME}/compat-status.json`（0600）+ 分片目录，**单写者** |
| 面板 | §7 由 `lib/client.js`（**B 线**）渲染；服务端只出 `RPC /host-compat/status` |
| 横幅 | §8 仅 DEGRADED/BLOCKED 注入，每会话一条，可 dismiss |

**本包不放业务逻辑、不做数据缓存、不做业务单例状态**（§10.6）；唯一模块级缓存 = 能力探测结果（§1）。

---

## 2. 包结构（§1）

```
dsh-host-compat/
├── package.json        # exports: "." / "./seams" / "./client" / "./package.json"；零第三方依赖
├── lib/
│   ├── index.js        # 插件面：apply / 状态聚合 / RPC / 横幅（+ probe/hostInfo 转出）
│   ├── seams.js        # 纯函数面：§4.1–§4.9（无 ctx；rpcHandle 除外，按契约签名收 ctx）
│   └── client.js       # ⚠️ 阶段 1 由 **B 线**写；本包先声明 exports["./client"] 与 dsh.client
└── README.md
```

三层版本声明（§9.1，各管一段）：

| 层 | 字段 | 值 |
|---|---|---|
| npm 静态声明 | `peerDependencies` | `{"@deepseek-ai/dsh": "^0.1.2-rc.1"}`（§9.2 实测范围；**不用** 09-05 旧模板） |
| npm 静态声明 | `engines.node` | `">=20.19.0"`（同步懒加载宿主 ESM 需 require(esm) ≥20.19/≥22.12） |
| 自描述字段 | 顶层 `dshCompat` | `{"host":"^0.1.2-rc.1","seams":[...]}`（**绝不塞进 `dsh` 命名空间**，§9.1 警告） |
| 运行期探测 | `hostInfo()` / `probe()` | 宿主版本或能力不匹配 ⇒ 全域 DEGRADED + 面板报红（不阻断加载，D1） |

---

## 3. 用法（消费方：4 个试点及其后所有自家插件）

**一律动态 `import()` + try/catch**（§1/§2.3/§10.1：静态 import 缺包 = 模块加载失败 = 容器崩溃循环）。

```js
// ① seam（访问宿主）
let seams = null;
try {
  seams = await import("@ericality/dsh-host-compat/seams");
} catch (err) {
  // 缺包 ⇒ 直接停用相关功能 + 不写 legacy 直连兜底（D12/§10.2）
  ctx.logger.warn(`dsh-xxx: host-compat 不可用，相关功能停用: ${String(err?.message ?? err)}`);
}

// ② 探测 + 上报（在 apply 内）
const compat = await import("@ericality/dsh-host-compat");
const result = compat.probe(["sessionEvents", "sessionAppend"], "dsh-cost-ledger", "0.3.2", ctx); // 第 4 参 ctx 可选但对服务类能力是必需的
compat.report({ ...result, id: "dsh-cost-ledger", version: "0.3.2", note: "回合统计停摆" });

// ③ 用 seam（永不 throw）
const events = seams.readSessionEvents(session);          // Event[] | null
const ends = seams.turnEndsOf(session);                   // [{turn,seq,time,reason}] | []
const r = seams.appendNotice(session, { kind: "ledger", title, body }); // {ok,mode,rev} | {ok:false,reason}
```

### package.json 声明（RD-1 / §2.2）

```jsonc
{
  "dependencies": { "@ericality/dsh-host-compat": "0.1.0" },   // 不是 peer、不是 optional（§2.2）
  "dshCompat": { "host": "^0.1.2-rc.1", "seams": ["sessionEvents", "sessionAppend"] }
}
```

`dshCompat.seams` 必须与运行期 `probe(requires)` 的 keys **集合相等**（RD-1，对撞脚本按此判据：
缺声明=红 / 多声明=黄，RD-2）。

---

## 4. §4 已实现的面（v1）

| # | 面 | 返回 |
|---|---|---|
| 4.1 | `readSessionEvents(session)` | `Event[]` 或 `null`（三路径：`session.events` → `snapshotEvents()` → `ownEvents()`） |
| 4.2 | `turnEndsOf(session)` | `Array<{turn,seq,time,reason}>`；不可用 `[]`（**不附 event 字段**，要原始事件用 §4.1） |
| 4.4 | `appendNotice(session, payload)` | `{ok,mode:"start"\|"replace",rev}` / `{ok:false,reason}` |
| 4.5 | `ensureEventTypes(types)` | `{ok,registered:string[]}` |
| 4.6 | `rpcHandle(ctx,channel,handler)` | `{ok}` / `{ok:false,reason}`（经此注册**自动带 GUI cookie 门禁**） |
| 4.8 | `hostInfo(ctx?)` | `{version,capabilities,detectedAt}` |
| 4.9 | `probe(requires,pluginId,pluginVersion,ctx?,blocking?)` | `{state,missing,blocked,notes?}` |
| 4.10 | `report(result)` | `void`（写分片 + 触发汇总；**不依赖另一个 host-compat 实例**） |

**阶段 3 才做（本包故意不做）**：§4.3 `sessionText`、§4.7 `readProjcache`、客户端面 `clientSeams()`。

### 4.1 关键边界语义（验收会逐条查，§10）

- **永不 throw**：全部面在任何输入下都不抛（含 `null`/畸形入参/宿主包缺失/磁盘不可写）。
- **`{ok:false,reason}`**：§4.4/§4.5/§4.6 失败一律此形状；`reason` 取 §3 能力 key
  （`sessionAppend` / `eventTypeRegistry` / `rpcHandle`）或语义串（`bad-argument` /
  `append-failed:…` / `rpc-handle-failed:…`）。§4.1/§4.2 的"不可用值"由契约行本身固定（`null` / `[]`）。
- **`mode` 的决策权在调用方（RD-19，2026-09-13 冻结）**：`appendNotice` **不读会话日志、不扫历史推断**
  （既是业务语义 §10.3，也有 O(n) 与口径风险）：
  - 缺省 / `rev === 0` → 追加 `notice/banner`，`rev` 用调用方给的值（缺省 `0`）⇒ `mode:"start"`
    ⇒ "每事件一张新卡"，与裸 `session.append("notice/banner", payload)` **逐字节一致**（RD-9 等价替换）；
  - 显式 `rev > 0` → 追加 `notice/banner-replace`，**沿用调用方的 `rev`** ⇒ `mode:"replace"`（原地替换语义）；
  - ⇒ **§4.1 能力缺失不影响追加**（改前各插件追加时也不需要读事件）；`rev` 非数值/负数 ⇒ `bad-argument`。
- **`payload.kind` 必填**（§8 形状）；缺失 → `{ok:false,reason:"bad-argument"}`。

### 4.2 能力探测口径（§3）

| key | 探测方式（无副作用） |
|---|---|
| `sessionEvents` / `sessionAppend` | 懒加载 `@deepseek-ai/dsh-session`，查 `Session.prototype.snapshotEvents/ownEvents/append` 方法存在性 |
| `eventTypeRegistry` | 同包 `KNOWN_SESSION_EVENT_TYPES.add` 是否为函数 |
| `projcache` | `${DSH_HOME:-$DSH_HOME}/storages/session_projcache/sessions`（0.1.2 分片）或 `…/session_projcache.json` 是否存在 |
| `rpcHandle` | `ctx.get("connection").rpc.handle` 是否函数 |
| `commands` / `tools` / `agents` / `webServerRoute` | `ctx.get("<服务名>")` 是否存在（**只查存在性，不调用方法**——不用 `resume` 类，§10.8） |
| `hostVersion` | 解析 `@deepseek-ai/dsh/package.json` 的 `version`（§3：package.json 或运行时） |

**ctx 与缓存**：`hostInfo(ctx)` 会现场全量探测并写入 §1 允许的 boot 缓存；`lib/index.js` 的 `apply`
调用一次，此后插件 `probe()` 不传 ctx 也能拿到完整结果。若无 ctx 且缓存冷：6 个无 ctx 可判的 key
照测，4 个服务类 key 按**缺失**处置并在 `notes` 明说（fail-safe：宁停勿发，D1）。⇒ **插件应传第 4 参 ctx**。

**阻断清单（RD-20，可选第 5 参 `blocking`）**：`probe(requires, pluginId, pluginVersion, ctx, blocking)`
—— `blocking: string[]`，缺省 `[]`。
- §3 默认只有 `agents` 缺失是 BLOCKED；若某插件认为**别的 key** 缺失也必须阻断（例：4 个试点认定
  `eventTypeRegistry` 缺失即阻断），就把它写进 `blocking` **由插件自己声明**（host-compat 里不硬编码插件 id，§10.6）。
- 语义：`missing` 中命中 `blocking` 的 key **同时进入 `blocked[]`**（**不移出 `missing`**），`state` 置 `BLOCKED`；
  命中时 `notes` 会写"依据插件声明的阻断清单判定 BLOCKED: …"便于溯源（**不新增返回字段**）。
- **RD-12（冻结）：`missing` 永远保留全部缺失 key，`blocked` 是其子集 ⇒ `blocked ⊆ missing` 恒成立。**
  面板只渲染 `missing` 摘要（D8/RD-12）⇒ 被阻断的 key **必须留在 `missing`**，否则会出现
  "红色 BLOCKED、但缺能力摘要为空"的静默行；§3 默认阻断项与声明命中的 key **处理完全一致**。
- `blocking` 里有、但实际不缺失（或不在 `requires` 里）的 key ⇒ 忽略。
- 非法 `blocking`（不是干净的字符串数组）⇒ 视同缺省，永不 throw。
- **缺省/空 `blocking` = 旧行为逐字相同**（`agents` 缺失时 `missing` 与 `blocked` 均为 `["agents"]`）。

---

## 5. 状态文件（§5，单写者）

```
${DSH_COMPAT_DIR:-$DSH_HOME:-$DSH_HOME}/
├── compat-status.json          # 0600 · 汇总（**只由本包写**）
└── compat-status.d/
    └── <pluginId>.json         # 0600 · 分片（**每个插件只写自己的**，§5/§10.7）
```

- 汇总（`compat-status.json`）字段**严格 §5 六键**：`schema` / `host` / `probedAt` / `state` / `plugins[]` / `dismiss`。
- **分片形状（RD-15 冻结，8 键）**：`{schema,id,version,state,missing,blocked,note,probedAt}`
  = §5 `plugins[]` 的一条（6 键）+ `probedAt`（汇总 `probedAt` 的来源，= 各分片最大值）
  + `schema`（与汇总同版本号）；C 线"缺 host-compat 时自写分片"按此逐字段复刻。
  `schema`/`probedAt` **不会**泄漏进 `compat-status.json`（汇总只映射 §5 六键）。
- `state` = 全域**最坏者**（`BLOCKED` > `DEGRADED` > `OK`；无分片 = `OK` 且 `probedAt:null` ⇒ 面板显示"尚未探测"）。
- `capabilitySignature` = 全域 `missing`/`blocked` **去重 + 字典序 + 逗号连接**后 sha256 的**前 16 位**，
  形如 `sha256:1a2b3c4d5e6f7a8b`（§5/D2）。
- **写失败 ⇒ 静默降级为只用内存态**（本进程内存里的分片仍可被 `RPC status` 读到；绝不 throw）。
- 落盘为**原子写**（tmp + rename）且 0600。

---

## 6. RPC 通道 `/host-compat`（§6）

经 §4.6 `rpcHandle` 注册 ⇒ 自动带 GUI cookie 门禁。零 token（纯本地读写，不触发模型）。

| 端点 | 请求 | 响应 `value` |
|---|---|---|
| `status` | `{}` | §5 完整对象 + **追加字段 `capabilitySignature`（当前签名，见 §9 变更申请 A-1）** |
| `dismiss` | `{hostVersion, capabilitySignature}` | `{ok:true, dismiss:{hostVersion,capabilitySignature,at}}` |

响应形状 `{ok:true,value}` / `{ok:false,error:{code,message}}`；错误码只用 `bad-request` / `not-found` / `io-error`。

- `dismiss` 的 `capabilitySignature` 允许传**空字符串** ⇒ 服务端用**当前**签名（客户端拿不到当前签名时的兼容路径）。
- 服务端记录的是**客户端回传的那一对**（= 用户当时看到的状态版本），这样状态变化后 `dismiss` 自然失效（§8 重新提示）。

---

## 7. 横幅（§8，`kind:"compat"`）

- 触发：全域 `state` ∈ {`DEGRADED`,`BLOCKED`}；全 `OK` **不注入**。
- 频率：**每会话一条** —— 判定依据是"该会话日志里已有 `kind:"compat"` 横幅"（持久幂等，跨重启同样成立）。
- 挂点：`session/created`（新会话/恢复会话）+ `session/turn/start`（用到的会话）；
  **不扫描、不改写历史/不活跃会话**（D11/§10.4）。
- payload 严格 §8：`{kind:"compat", rev, severity:"degraded"|"blocked", title, body, buttons:[{label,action:"dismiss"}]}`，
  经本包自己的 §4.4 `appendNotice` 注入。`title` = `插件适配状态：N 项降级/阻断`；
  `body` = 每个非 OK 插件的 `id + note`（`note` 来自插件的 `report()`，即§3 的"后果文案"）+ 固定指引尾巴。
- 重新提示：`dismiss` 记的是 `hostVersion + capabilitySignature`；**任一变化 ⇒ 视为新事件**（新会话/未提示过的会话会重新收到）。
- **不放业务语义**（§10.3/§10.6）：只报适配状态，不报费用/队列/通知等业务内容。

---

## 8. 自测（离线、零 token、不碰生产）

```bash
node $DSH_HOME/scripts/host-compat-selftest.mjs     # 退出码 0 = 全绿
```

桩宿主 + **逐例副本模块**（模块实例/缓存隔离），覆盖：包结构与 exports 解析、三态、`report()` 分片+汇总、
`dismiss` 往返、横幅（注入/每会话一条/全 OK 不注入/signature 变化重新提示）、seam 五面的失败形状与零 throw、
写盘失败降级内存态、RPC 错误码。全程只写 `/tmp`（`DSH_COMPAT_DIR` / `DSH_HOME` 覆盖），不重启、不碰 `$DSH_HOME`。

---

## 9. 部署注意（⚠️ 必读）

1. **`dsh.client` 与 `lib/client.js` 必须同批落地**：宿主 `dsh-client-modules` 在**装配扫描期**读
   `exports["./client"]`，文件缺失 ⇒ `MissingClientBundleError` ⇒ 构造器 `throw
   ClientPackageCompositionError`（`dsh-client-modules/lib/index.js:476-479`、`:636`、`:729-743`）⇒
   client-modules 服务起不来（GUI 无 `__DSH_BOOT__`/无 bundle 路由）。
   ⇒ 在 B 线写出 `lib/client.js` **之前**，不要给本包加 `cordis.patch.yml` 条目；只拷包体不加条目是安全的。
2. 部署目标：`$DSH_HOME/profiles/web/node_modules/@ericality/dsh-host-compat/`（`@ericality/` scope 需新建）。
3. 装配：`$DSH_HOME/profiles/web/cordis.patch.yml` 的 `insert:` 加一条（**协调人唯一写者**），
   且应排在试点插件之前（让 boot 探测缓存先就位）。
4. `DSH_COMPAT_DIR` 生产**不设**（默认 `$DSH_HOME`）；只为测试/隔离而设。

## 10. 未实现 / 已知边界

- §4.3 `sessionText`、§4.7 `readProjcache`、`clientSeams()` ⇒ 阶段 3。
- `lib/client.js`（§7 面板卡 + dsh-notice-banner 的 `compat` 横幅分支）⇒ **B 线**。
- `projcache` 探测是**路径存在性**：全新环境尚无投影缓存时会判 DEGRADED（合同 §3 要求的就是形状探测）。
- 若宿主改用非 ESM-require-able 的加载方式（Node <20.19），`sessionEvents/sessionAppend/eventTypeRegistry`
  三个 key 会判缺失 ⇒ 全域 DEGRADED（fail-safe，不静默）。
