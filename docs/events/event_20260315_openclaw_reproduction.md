# Event: openclaw_reproduction

Date: 2026-03-15
Status: Completed
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 使用者要求將兩個 `openclaw*` 計畫合併，收斂成單一主計畫 `openclaw_reproduction`。
- 原則：同一 workstream 盡量維持單一主 authority，避免 benchmark 與 implementation plan 長期分裂。

## 範圍 (IN / OUT)

### IN

- 整合 `openclaw_runner_benchmark` 與 `openclaw_scheduler_substrate`
- 建立單一 active plan package `specs/20260315_openclaw_reproduction/*`
- 更新舊 event / spec 的 follow-up 指向

### OUT

- 本輪不直接變更 runner 實作
- 本輪不直接進 build
- push / PR

## 任務清單

- [x] 讀取兩個 openclaw plan 與對應 event，確認可合併內容與主 authority
- [x] 建立單一主 plan `openclaw_reproduction`，整合 benchmark 與 scheduler substrate 內容
- [x] 更新舊 plan/event 的 follow-up 指向，避免多重 authority
- [x] 檢查是否需要同步相關文件並回報合併結果

## Debug Checkpoints

### Baseline

- 目前同一條 OpenClaw workstream 存在兩個 `openclaw*` plan，分別承擔 benchmark 與 build-facing planning。
- 使用者明確指出這違反「盡量單一計畫」原則。

### Instrumentation Plan

- 保留既有 benchmark 與 build-plan 內容，但將其收斂為一個新主 plan。
- 舊 plan 在 consolidation 完成後可刪除，只保留新主 plan 與本 event 作為 authority。

### Execution

- 已建立 `specs/20260315_openclaw_reproduction/*`
- 已建立 `docs/events/event_20260315_openclaw_reproduction.md`
- 已清理舊 `openclaw*` 計畫資料，避免同一 workstream 存在多重 authority。

### Root Cause

- 原先將 benchmark authority 與 build authority 分開，短期有助於收斂，但長期造成同一 workstream 的 authority 分裂。

### Validation

- consolidation 已完成：同一條 OpenClaw workstream 現在只保留單一 active planning authority。
- `docs/ARCHITECTURE.md` 未發現直接引用兩份舊 openclaw plan 的長期文字，因此本輪不需改 architecture 正文。

## Architecture Sync

- Architecture Sync: Verified (No doc changes)
- 依據：`docs/ARCHITECTURE.md` 未直接依賴舊 `openclaw_runner_benchmark` / `openclaw_scheduler_substrate` 名稱作為長期框架知識，因此 consolidation 只需更新 event/spec authority，不需改 architecture 本體。
