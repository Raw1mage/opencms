# Event: mobile session autoscroll opt-out

Date: 2026-03-08
Status: In Progress

## 需求

- 在 mobile web session 閱讀 AI 文字輸出時，不要再強制貼底
- 使用者往上閱讀後，新訊息應保留位置，讓使用者自行決定何時回到底部
- desktop session 保持既有 auto-follow 行為

## 範圍

### IN

- `packages/app/src/pages/session/index.tsx`
- mobile web session auto-scroll 啟用條件

### OUT

- 不修改 desktop session auto-follow 行為
- 不修改 review/file panel 捲動邏輯
- 不引入新的 web runtime API

## 任務清單

- [x] 定位 web session auto-scroll 啟用點
- [ ] 將 mobile session 改為預設不自動跟隨新訊息
- [ ] 驗證並 commit

## Debug Checkpoints

### Baseline

- `packages/app/src/pages/session/index.tsx` 目前使用 `createAutoScroll({ working: () => true })`。
- 這代表 session timeline 在有新內容時預設一直處於 auto-follow 模式，mobile 使用者閱讀舊內容時會被持續拉回底部。

### Execution

- Changed session auto-scroll activation from unconditional (`working: () => true`) to desktop-only (`working: () => isDesktop()`).
- Resulting behavior:
  - desktop keeps existing follow-bottom behavior
  - mobile session no longer auto-follows new content by default
  - the existing "scroll to latest" floating button remains the explicit way to jump back down on mobile

### Validation

- `bun run typecheck` passed in `/home/pkcs12/projects/opencode` (`Tasks: 16 successful, 16 total`).
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅調整 mobile session auto-scroll 啟用條件，不改動 session persistence、runtime、或 API architecture 邊界。
