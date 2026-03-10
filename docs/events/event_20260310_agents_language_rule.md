# Event: AGENTS language response rule

Date: 2026-03-10
Status: Completed

## 需求

- 在 repo 的 AGENTS 規範中新增一條明確規則：對使用者應以繁體中文應答。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_agents_language_rule.md`

### OUT

- 不修改 runtime 程式碼
- 不修改 `docs/ARCHITECTURE.md`

## 任務清單

- [x] 在 project `AGENTS.md` 新增繁體中文回應規範
- [x] 同步更新 `templates/AGENTS.md`
- [x] 記錄本次規範變更 event

## Debug Checkpoints

### Baseline

- 目前 AGENTS 文件尚未明確要求預設以繁體中文對使用者回應。
- 專案規範要求此類流程/規範變更需同步 template 並記錄於 `docs/events/`。

### Instrumentation Plan

- 僅修改 AGENTS 文件，不碰 runtime。
- 以 project/template 雙點同步避免 release 漂移。

### Execution

- 已在 project `AGENTS.md` 新增「語言回應規範」章節。
- 已在 `templates/AGENTS.md` 同步新增相同規則。

### Root Cause

- 回應語言偏好先前只存在於對話脈絡，未沉澱為 repo 級 AGENTS 規範，因此需要補成明文規則。

### Validation

- 變更檔案：
  - `/home/pkcs12/projects/opencode/AGENTS.md`
  - `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- 結果：project/template 已同步新增「預設以繁體中文回應，除非使用者另行指定」規則。
- Architecture Sync: Verified (No doc changes)
  - 比對依據：本次僅調整 AGENTS 規範文字，未改系統架構、模組邊界、資料流或 runtime contract。
