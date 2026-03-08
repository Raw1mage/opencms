# Event: model selector scroll preservation

Date: 2026-03-08
Status: Done

## 需求

- webapp model selector 在切換到「全部顯示」模式時，點擊 provider enable/disable 不可把列表捲回頂部。
- 同樣原則適用於 model list；點擊 model enable/disable 不可觸發列表 refresh 或 scroll reset。
- 保留既有 enable/disable 功能與 optimistic UI。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx`
- 必要時包含列表 scroll state preservation / config update path 最小修正
- targeted validation 與 event 記錄

### OUT

- 不修改 provider/account/model backend API contract
- 不重做 model manager UI 結構

## 任務清單

- [x] 重現並定位 provider/model list scroll reset 成因
- [x] 實作最小修正以保留列表 scroll position
- [x] 驗證 web refresh / typecheck / targeted behavior

## Debug Checkpoints

### Baseline

- 使用者回報：在 model selector 的「全部顯示」模式下，provider list 很長時，點任一 enable/disable 會自動捲到頂部。
- 使用者回報：相同問題也出現在 model list。

### Execution

- `packages/app/src/components/dialog-select-model.tsx` 新增 `preserveScrollPosition(...)`，在 toggle 前抓取目前 scrollTop/scrollLeft，並在同步更新、microtask、以及後續 animation frames 內重套位置，避免 reactive repaint 後回到頂部。
- provider list 修正：
  - 將 provider column scroll container 綁定 ref。
  - provider enable/disable 改為在該 scroll container 上保留位置。
  - 不再走 `globalSync.updateConfig()` 的 bootstrap/reload 路徑；改成 optimistic local store + `sdk.client.global.config.update(..., { throwOnError: true })`，避免不必要的全域 refresh 打掉列表 viewport。
- model list 修正：
  - 將 model panel 綁定 ref，toggle model visibility 時直接鎖住內部 `[data-slot="list-scroll"]` 的 scroll position。
  - 保留既有 `local.model.setVisibility(...)` 邏輯，只補 scroll ownership 保護，不改 model preference semantics。
- RCA 結論（本輪修正依據）：
  - provider list 的 scroll reset 主因是 toggle 使用了會觸發 global bootstrap 的 config 更新流程，導致列表區塊被重算/重繪。
  - model list 雖未走同樣的 global refresh，但 toggle 時仍缺少 scroll preservation，導致列表在局部重繪後失去原 viewport。

### Validation

- `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx` ✅
- `./webctl.sh dev-refresh` ✅
- `./webctl.sh status` ✅（development web runtime healthy）
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅調整 web model selector 的前端互動與 scroll ownership，未更動 runtime boundary、API contract、provider/account architecture。
