## Requirements

- 將「本 repo 已獨立，不需要預設建立 PR」寫入 project-level prompt，避免之後每次都再次詢問。

## Scope

### In

- `AGENTS.md` project-level 規範
- 本次 prompt 變更的 event 記錄

### Out

- runtime / template prompt 全量同步
- release / push

## Task List

- [ ] 建立本次 event 記錄
- [ ] 更新 project-level `AGENTS.md`
- [ ] 檢查是否需要同步 `templates/AGENTS.md`

## Baseline

- 使用者確認：本 repo 已經是獨立產品線，不再需要 PR 作為預設工作流。
- 目標是讓 Main Agent 在本 repo 內預設不要再主動提議建立 PR，除非使用者明確要求。

## Execution / Decisions

- 在 `/home/pkcs12/projects/opencode/AGENTS.md` 的「整合規範」區段下新增 `Pull Request 預設策略`。
- 規則內容：
  - 本 repo 作為獨立產品線維護，預設不建立 PR。
  - 除非使用者明確要求，否則完成後預設停在 local commit / branch push（若需要）。
  - 只有回提交上游、外部 fork、或團隊審查流程明確要求時，才進入 PR workflow。
- 本次只修改 project-level prompt；不改 `templates/AGENTS.md`，因為使用者要求的是 repo 內 project-level 預設，不是 release 給外部使用者的 template 行為。

## Validation

- 已更新：`/home/pkcs12/projects/opencode/AGENTS.md` ✅
- 同步範圍檢查：`templates/AGENTS.md` 已讀取並比對，本次判定 **不需同步** ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 project-level 協作流程提示，不影響模組邊界、資料流、狀態機或 runtime observability。
