# @ericality/dsh-cost-tree

安装：`dsh plugin --profile web add @ericality/dsh-cost-tree@0.1.1`


Read-only session-cost tree aggregation for DSH — 会话树用量聚合纯库（只读不写、零依赖）：血缘索引 + 子树闭包 + projcache 四类 token totals 按会话树求和。

## 安装

```sh
npm i @ericality/dsh-cost-tree
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件的读时聚合库加载（纯库，无 apply/inject/钩子/RPC）。

## 功能

- `readFirstHeaderLine(file)` — 只读会话日志 JSONL 首帧 header（64KB 有界前缀读，截断倍增重试 ≤4MB；缺失/坏文件 → null，不 throw）。
- `readTreeIndex(opts)` — 扫 `sessionsRoot` 下各 workspace 目录，按首帧 header 建 `parentSession` 血缘索引（TTL 15s 内存缓存，`force` 可重建）。
- `subtreeIds(sid, opts)` — 子树 id 闭包（含自身、防环；默认只跟随 `origin === "subagent"` 的委托边，`edgeMode: "all"` 可跟随任意边）。
- `subtreeTotalsFromProjcache(sid, opts)` — 子树四类用量聚合：自身 + 全部后代，返回 `{ totals, ids, children, ownTotals, missing }`；数据源不可读 → null（消费方降级）。
- `sessionMeta(sid, opts)` / `childLabel(row, sid)` / `projcacheTotalsOf(row)` / `readProjcacheSessions(file)` — 元信息与 projcache 读取辅助。
- 数据源默认路径（宿主数据目录）可用环境变量覆盖：`DSH_COST_TREE_SESSIONS_ROOT`、`DSH_COST_TREE_PROJCACHE_FILE`。

## 依赖

peer：无（仅 `node:fs` / `node:zlib`）。

## 许可

MIT
