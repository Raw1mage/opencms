# Event: Workspace preview runtime gap

Date: 2026-03-09
Status: Done

## 需求

- 釐清 workspace attachment model 中 `preview` 的真實 runtime 邊界。
- 在沒有實際 preview domain / event source 前，避免猜測式實作。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/docs/specs/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不新增 preview attachment registration 程式碼
- 不建立假的 preview process / lifecycle / cleanup hooks

## 任務清單

- [x] 掃描現有 preview 相關程式/文件
- [x] 確認哪些 preview 名詞不是 workspace runtime preview
- [x] 產出 preview runtime gap spec
- [x] 補 architecture sync 註記

## Debug Checkpoints

### Baseline

- workspace aggregate schema 已保留 `previewIds`。
- 但 repo 內找不到對應的 preview runtime manager、preview process registry、preview bus events、或 preview API boundary。

### Execution

- 檢查到的 `preview` 大多屬於：
  - theme/color preview
  - SVG/image/file content preview
  - sidebar/project hover preview
  - web-search-preview / model preview 等非 workspace domain 名詞
- 未發現可作為 workspace preview SSOT 的 runtime object。
- 因此本輪只定義 gap 與未來 contract，明確維持 `previewIds` 為 reserved field。

### Validation

- Architecture Sync: Updated
  - 已在 architecture 註記 preview attachment 仍屬 reserved / 未接線狀態，避免誤解為已實作。
