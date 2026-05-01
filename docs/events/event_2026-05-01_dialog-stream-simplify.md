# 2026-05-01 Dialog Stream Simplification

## 需求

- 盤點並降低 dialog / task detail 內嵌 session stream 的容器層級與心智負擔。
- 第一階段採低風險減層：不改全域 Dialog focus/overlay 結構，只收斂 task detail 的 output stream shell 與 `SessionTurn` 嵌入式使用方式。

## 範圍(IN/OUT)

- IN: `packages/app/src/pages/task-list/task-detail.tsx` 的 output stream 區塊。
- IN: `packages/ui/src/components/session-turn.tsx` 增加嵌入式 variant，減少呼叫端 class override。
- OUT: 不刪 Kobalte Dialog / Portal / Overlay / Content 層。
- OUT: 不重寫 SessionTurn 訊息渲染器。

## 任務清單

- [x] 建立 dialog stream 減層 event 與 XDG 白名單備份
- [x] 抽出 SessionStreamPanel 並收斂 TaskDetail output 容器
- [x] 為 SessionTurn 增加 embedded variant，降低嵌入式 class override 依賴
- [x] 跑 focused typecheck/build 並更新事件紀錄

## Debug Checkpoints

- Baseline: task detail output stream 目前由 card、header、scroll box、`TaskSessionOutput`、每個 `SessionTurn` class override 組成；層數可理解但維護時容易混淆 scroll owner 與 renderer 責任。
- Instrumentation Plan: 保留單一 scroll owner 與 `SessionTurn` renderer，抽出 stream shell 元件並用 variant 宣告 embedded usage。

## Verification

- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260501-1734-dialog-stream-simplify`（白名單快照；僅供需要時手動還原）。
- Implemented: `packages/app/src/pages/task-list/task-detail.tsx` now uses `SessionStreamPanel` to own the output card header, clear action, scroll owner, empty/loading/error states, and embedded session stream rendering.
- Implemented: `packages/ui/src/components/session-turn.tsx` now accepts `variant="embedded"`; embedded callers no longer need to pass the root/content/container class override bundle.
- Kept: global Dialog / Kobalte Portal / Overlay / Content structure remains unchanged because it owns focus trap, overlay, close semantics, and aria behavior.
- Validation: `bun --filter @opencode-ai/app typecheck` passes.
- Validation: `bun build packages/app/src/pages/task-list/task-detail.tsx --target browser --outdir /tmp/opencode-task-detail-check` passes.
- Validation: `bun build packages/ui/src/components/session-turn.tsx --target browser --outdir /tmp/opencode-session-turn-check` passes.
- Validation: `git diff --check` passes.
- Architecture Sync: `specs/architecture.md` updated with the embedded session stream boundary.
