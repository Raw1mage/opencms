# Event: Mobile status loaded-skills card parity

Date: 2026-04-21
Status: Done

## 需求

- 讓手機版 webapp `/tool/status` 顯示與桌面 status sidebar 對齊的「已載技能」卡片。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/tool-page.tsx`
- `/home/pkcs12/projects/opencode/docs/events/event_20260421_mobile_status_skills_card.md`

### OUT

- backend skill-layer API contract
- 桌面 sidebar 行為重構
- skill 管理權限/動作語義變更

## 任務清單

- [x] 確認桌面與 mobile status render path 差異
- [x] 在 mobile status tool page 補上 skillsContent
- [x] 驗證前端型別與記錄 architecture sync

## Debug Checkpoints

### Baseline

- 桌面 `SessionSidePanel` 在 status mode 會傳入 `skillsContent`，因此 `SessionStatusSections` 會顯示「已載技能」卡。
- 手機 `/tool/status` 走 `SessionToolPageRoute`，目前只傳 `todoContent` / `monitorContent`，沒有 `skillsContent`，所以卡片不會出現。
- `SessionStatusSections` 只有在 `props.skillsContent` 存在時才 push `skills` card。

### Execution

- `packages/app/src/pages/session/tool-page.tsx` 新增 `SkillLayerState` / `SkillLayerActionResponse` 型別，對齊桌面 side panel 使用的 skill-layer payload 形狀。
- mobile `/tool/status` 現在也會傳入 `skillsContent` 給 `SessionStatusSections`，因此可顯示「已載技能」卡。
- skills 卡內沿用桌面既有 skill-layer API：
  - `GET /api/v2/session/:sessionID/skill-layer`
  - `POST /api/v2/session/:sessionID/skill-layer/:name/action`
- 卡片互動維持桌面語意：`Pin` / `Unpin`、`Full`、`Sum`、`Drop`，不改 backend contract。

### Validation

- `bun --filter @opencode-ai/app typecheck`
  - 先前失敗點位於既有檔案 `packages/app/src/context/sync.tsx:322`：`Property 'info' does not exist on type 'Message'`。
  - 已修正 incremental message reload 取值，將 `msg.info.time.created` 改為 `msg.time.created`，因為 `existing` 是 `Message[]` 而非 `{ info: Message }` 包裝層。
  - 修正後重新執行，結果通過。
- Cleanup: 誤建測試檔 `/$HOME/test` 已清理。
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅補齊 mobile status page 與 desktop sidebar 的前端呈現 parity，並修正 `sync.tsx` 的前端型別/欄位取值錯誤，未變更模組邊界、資料流 authority、API contract 或 runtime state ownership。
