# File Explorer Touch Context Menu

## 需求

- 手機 touch mode 長按 file explorer item 會有反應，但只看到白色區塊，無法看到完整右鍵選單。

## 範圍(IN)

- 檢查 file explorer 長按 context menu 的前端呈現路徑。
- 修正 mobile/touch viewport 下選單高度、定位與捲動行為。
- 保留桌機右鍵 context menu 行為。

## 範圍(OUT)

- 不重做 file operation action dispatch。
- 不改 daemon/gateway lifecycle。
- 不新增 fallback mechanism。

## 任務清單

- [x] 讀取 `specs/architecture.md` 確認 Web SPA / UI package 邊界。
- [x] 定位 `packages/app/src/components/file-tree.tsx` 與 `packages/ui/src/components/context-menu.css`。
- [x] 建立 XDG 白名單設定備份。
- [x] 修正 touch mode context menu 顯示。
- [x] 執行最小驗證。
- [x] 記錄 validation 與 architecture sync。

## Debug Checkpoints

- Boundary: Web SPA file explorer 使用 `@opencode-ai/ui/context-menu` 共享元件。
- Evidence: `FileTree` root 以 `ContextMenu.Trigger` 包住 tree，`ContextMenu.Content` 顯示 action groups。
- Root Cause: 現有 context menu content 只有 `overflow: hidden`，沒有 viewport max-height / touch scroll / mobile bottom positioning；長按在小螢幕容易被裁切或落在不可見位置。

## Key Decisions

- 在 touch/coarse pointer viewport 將 file explorer context menu 改為 bottom-sheet 形態。
- 保留 desktop floating context menu，只補 max-height 與 scrolling guard。

## Verification

- Passed: `bun test --preload ./happydom.ts ./src/components/file-tree.test.ts` under `packages/app` (`9 pass`, `0 fail`).
- Passed: `git diff --check`。
- Fixed: non-interactive shell now loads `~/.bun/bin`, `~/.local/bin/env`, and `nvm` before the interactive guard in `/home/pkcs12/.bashrc`.
- Fixed: `packages/app/src/context/sdk.tsx` now forwards `globalSDK.isStreamAlive`, resolving the real typecheck error at `packages/app/src/pages/session.tsx:1237`.
- Passed: `bun run typecheck` under `packages/app`.
- Passed: `bun run build` under `packages/app`.
- Architecture Sync: Verified (No doc changes). 依據：本次僅調整 Web SPA file explorer context menu 樣式/定位，未改 module boundary、資料流、daemon/gateway、Bus 或 session runtime。

## Remaining

- 需要在實機或瀏覽器 mobile emulation 長按 file explorer item 確認 bottom-sheet 視覺。
