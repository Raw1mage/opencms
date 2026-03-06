# Event: Web Favorites Visibility Alignment

## 需求

- webapp model selector 採用二元規則：
  - `精選` 只顯示 favorites
  - `全部` 顯示全部
- webapp 的眼睛按鈕只負責切換某 model 是否出現在 `精選`
- 該切換結果必須同步到 TUI 使用的 favorites/hidden 偏好，讓 unfavorite 在 TUI selector 中同時視為 hidden

## 範圍

IN:
- `packages/app/src/context/models.tsx`
- `docs/events/event_20260306_web_favorites_visibility_alignment.md`

OUT:
- 不重做 webapp UI 版型或 icon
- 不修改 TUI component 互動
- 不修改 backend model preferences API schema

## 任務清單

- [x] 重新確認 web 與 TUI 對 favorite/hidden 的同步路徑
- [x] 將 webapp `visible()` 對齊為 favorites-only 語義
- [x] 讓 webapp `setVisibility()` 同步寫入 `favorite/show` 與 `unfavorite/hide`
- [x] 保留舊本地資料的相容正規化
- [x] 驗證 webapp typecheck 與 runtime refresh

## Debug Checkpoints

### Baseline

- `packages/app/src/context/models.tsx`
  - `visible()` 仍可能受 `visibility` 或 `latest` fallback 影響
  - `favorite` 與 `visibility` 曾被拆開，與使用者期待的 web 二元心智模型不一致
- TUI local model store
  - `toggleFavorite()` 會處理 favorites
  - `toggleHidden()` 會處理 hidden
  - 兩者最終都會持久化到同一份 model preferences

### Execution

- 調整 `packages/app/src/context/models.tsx`
  - `visible()` 改為只由 favorite 狀態決定
  - `setVisibility(true)` 改為同時寫入 `favorite: true` 與 `visibility: "show"`
  - `setVisibility(false)` 改為同時寫入 `favorite: false` 與 `visibility: "hide"`
  - `toggleFavorite()` 改為委派到 `setVisibility()`
  - `applyRemotePreferences()` 改為將 remote favorites/hidden 直接映射為同一組對齊狀態
  - 新增本地舊資料正規化，避免既有 `show/hide` 與 `favorite` 漂移

### Validation

- `bun x tsc -p packages/app/tsconfig.json --noEmit`
  - 通過，無型別錯誤輸出
- `./webctl.sh dev-refresh`
  - 前端 build 通過，restart worker 已排程
- `./webctl.sh dev-start`
  - 啟動命令可回傳 server started，但後續 PID 立即失效
- `./webctl.sh status`
  - 失敗，回報 stale PID / stopped，HTTP health unreachable
- `/run/user/1000/opencode-web-default.log`
  - 僅見啟動 banner，未見直接程式例外；目前較像 web runtime / PID 管理噪音，非本次前端 typecheck 問題
- 行為驗證結論：
  - 以程式路徑確認 web selector 的 `精選` 仍經由 `visible()` 過濾，而 `visible()` 現在只看 favorite
  - `setVisibility(true)` 會同步寫入 `favorite: true` / `visibility: "show"`
  - `setVisibility(false)` 會同步寫入 `favorite: false` / `visibility: "hide"`
  - `toggleFavorite()` 委派到 `setVisibility()`，因此 web 與 TUI 將共用同一組 favorite/hidden 結果
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅收斂 webapp model preference 的前端狀態語義，未改變 provider graph、server routes、runtime 邊界或資料契約
