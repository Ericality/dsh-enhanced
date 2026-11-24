# @ericality/dsh-reconcile

安装：`dsh plugin --profile web add @ericality/dsh-reconcile@0.1.1`


Idempotent session-log reconciliation for DSH plugins — 会话日志幂等对账库：把"回合结束"从一次性事件变成可重放的对账，供宿主插件在会话恢复时补做缺失回合的记账/费用提醒/完成通知。

## 安装

```sh
npm i @ericality/dsh-reconcile
```

> 需 dsh (DeepSeek Harness) 宿主环境；作为宿主插件的依赖库加载（纯库，无 apply/inject）。

## 功能

- `attachReconcile(ctx, { shouldReconcile, reconcile, bootScanMs?, name? })` — 挂载对账调度：
  `session/created`（新建/恢复，此时 `session.events` 已含修复后的完整日志）触发，加启动延迟扫描在线会话兜底；每会话每进程只对账一次，并发保护。
- `listTurnEnds(session)` / `lastTurnEnd(session)` / `turnEndReason(ev)` / `turnElapsedMs(session, end)` — 从会话日志提取 turn/end（含 interrupted）与回合耗时的只读工具。
- 背景：宿主重启会掐断进行中的 agent 回合；会话恢复时由持久化层合成缺失的闭合事件（含 `turn/end { reason: { kind: 'interrupted' } }`），但种子事件不派发事件观察者，依赖实时 turn/end 的插件因此收不到 → 由本库在恢复时幂等补做。
- 约定：`reconcile(session)` 必须与实时路径复用同一套处理函数且幂等（重复执行无副作用，出错留日志、下个进程自然重试）。

## 依赖

peer：无（纯库零依赖；`ctx` 由调用方传入）。

## 许可

MIT
