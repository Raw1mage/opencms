# Event: Remove Web Status Recommendation Block

Date: 2026-03-04
Status: Done

## 1) 需求

- 使用者要求移除 WebApp「狀態 > 帳號」中的 DIALOG/TASK/BACKGROUND 建議區塊。

## 2) 範圍 (IN/OUT)

### IN

- 移除 `status-popover` 中的「輪替建議」顯示與互動（重新整理/套用）。
- 保留帳號清單與「管理」入口。

### OUT

- 不調整 rotation3d 核心後端邏輯。
- 不調整 TUI `/admin` 行為。
- 不移除其他頁面（如 settings-models）的 recommendations 功能。

## 3) 任務清單

- [x] 更新 `packages/app/src/components/status-popover.tsx`，移除 recommendations 區塊與相依程式。
- [x] 執行 app typecheck 驗證。
- [x] 補上 Validation 結果並更新 Status。

## 4) Debug Checkpoints

### Baseline

- 症狀：Web 狀態面板帳號分頁存在 DIALOG/TASK/BACKGROUND 建議區塊與「套用」按鈕。
- 重現：開啟 Web UI 的狀態 popover，切到「帳號」分頁。
- 影響：UI 暗示有路由槽位設定，但實際僅是建議切換，與使用者期望不一致。

### Execution

- 移除 `StatusPopover` 內 recommendations 專用資料流與動作：
  - 移除 `rotation.status()` resource 讀取。
  - 移除 `rotationRecommended` / `recommendationCooldown` / `applyRecommendation` 與相關 state。
  - 移除帳號分頁中的「輪替建議」區塊（標題、空態、列表、套用按鈕）。
- 保留帳號清單與管理入口，並將「重新整理」行為改為僅 refresh 帳號資料。
- 清理已失效 i18n key（Web status accounts recommendations）：
  - `packages/app/src/i18n/en.ts`
  - `packages/app/src/i18n/zh.ts`
  - `packages/app/src/i18n/zht.ts`
  - 移除 keys: `status.popover.accounts.recommendations`, `status.popover.accounts.noRecommendations`

### Validation

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit`（i18n 清理後複驗）✅
