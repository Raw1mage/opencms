# Event: MCP Market UI Mobile Fix

## 需求
- 修正 App Market 在窄螢幕 / 手機上的卡片排版，避免 overflow 或卡片過大。
- 讓 App Market 的關閉入口在手機上更容易看見與使用。
- 保留現有 back/close 行為，不重做導覽模型。

## 範圍
### IN
- `packages/app/src/components/dialog-app-market.tsx`
- `packages/app/src/components/dialog-app-market.css`
- 事件 / 計畫紀錄同步

### OUT
- MCP registry / backend 行為
- 其他非 App Market dialog 的全面性重構

## 任務清單
- [x] 讀取 plan artifacts 與 App Market 相關元件
- [x] 委派並整合手機版 UI 修正 slice
- [x] 更新 plan tasks checklist
- [ ] 完成驗證與證據整理
- [ ] architecture sync / no-doc-change 註記

## 對話重點摘要
- 使用者要求：若有下一步就繼續，否則停下詢問；目前已有明確 next step，所以直接續跑。
- subagent 已完成 App Market mobile layout fix slice。

## Debug Checkpoints
### Baseline
- 問題聚焦在 App Market 卡片在窄螢幕上過寬、dialog 也不夠好關閉。

### Instrumentation Plan
- 檢視 `dialog-app-market.css` 與 `dialog-app-market.tsx` 的 min-width / grid / title bar 結構。
- 驗證手機 viewport 下是否仍能維持可讀、可關閉。

### Execution
- subagent 產出並套用以下變更：
  - `dialog-app-market.css`: mobile 斷點下取消 resize、降低 dialog 最小寬度限制、調整 grid minmax。
  - `dialog-app-market.tsx`: 標題列改成 mobile 友善堆疊版，搜尋框改為寬度自適應，卡片高度在 mobile 下縮短。
- 目前已發現 `bunx` 不可用，改以 `bun run eslint ...` 進行驗證。

### Root Cause
- 尚未進入最終根因定論；目前證據顯示主要是固定最小寬度與 grid minmax 在窄螢幕下不夠彈性。

### Validation
- 待完成：`bun run eslint packages/app/src/components/dialog-app-market.tsx`
- `Architecture Sync: Verified (No doc changes)`：本次僅涉及 UI 局部修正，未改動系統邊界、資料流或狀態機。

## Remaining
- 確認 ESLint 結果
- 視需要補充 mobile close affordance 的具體使用者可見性細節
- 如無其他問題，完成 tasks.md 其餘勾選