# Event: Workspace rewrite spec on latest cms

Date: 2026-03-08
Status: Done

## 需求

- 在 `/home/pkcs12/projects/opencode-beta` 以 **latest `cms`** 為唯一基底，重新定義 `new-workspace` 的實作方向。
- 明確把舊 `new-workspace` 分支降級為「參考素材」，而不是 merge/cherry-pick 來源。
- 產出一份可執行的 rewrite spec，聚焦 workspace 抽象層如何解決多重輸入/輸出問題。

## 範圍

### IN

- `docs/events/event_20260307_workspace_context_analysis.md`
- `docs/ARCHITECTURE.md`
- 目前 beta repo 中既有 workspace/worktree/sidebar 相關實作與命名
- 新 spec 文件：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-rewrite-spec.md`

### OUT

- 本輪不直接實作 runtime / API / schema / UI 變更
- 不直接移植 upstream workspace control-plane
- 不回頭把舊 `new-workspace` 分支內容硬 merge 回最新 `cms`

## 任務清單

- [x] 重新確認 beta current-state 與既有 workspace analysis
- [x] 盤點現有 workspace 名稱已被哪些 UI / app state 佔用
- [x] 釐清 rewrite 的問題定義、邊界與非目標
- [x] 產出 workspace rewrite spec
- [x] 記錄 Validation 與 Architecture Sync 結論

## Debug Checkpoints

### Baseline

- 先前分析已確認 upstream workspace wave 不是 tail-port 問題，而是獨立架構專題。
- beta 現況的 `workspace` 一詞主要出現在 app sidebar / local worktree / sandbox UX，尚未形成新的 runtime workspace domain contract。
- 舊 `new-workspace` 與最新 `origin/cms` 直接 merge 已證明會造成大面積 `AA/UU` 衝突，不適合作為延續路線。

### Execution

- 重新讀取 beta architecture 與既有 workspace analysis，確認本輪應先做 spec freeze。
- 盤點現況後確認：
  - app 端已有 workspace/worktree/sandbox UI 與 session grouping 概念；
  - core runtime 尚未建立 workspace registry / workspace-scoped API / workspace lifecycle contract；
  - 因此 rewrite 必須先定義 domain model，再談 persistence / sync / routing。
- 新 spec 定位為：
  - 以 latest cms 為底，
  - 把 workspace 定義成「執行作用域（execution scope）」而非單純 worktree alias，
  - 解決 session / PTY / preview / file context / cleanup / sync 的多重輸入輸出歸屬問題。

### Validation

- 已新增：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-rewrite-spec.md` ✅
- spec 已明確定義：問題、術語、domain model、phase plan、風險與驗收門檻 ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅新增 rewrite spec 與 event 記錄，尚未改動 beta runtime/current architecture truth，因此 `docs/ARCHITECTURE.md` 不需同步改寫。
