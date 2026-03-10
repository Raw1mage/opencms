# Event: session completion text shift RCA

Date: 2026-03-10
Status: In Progress

## 需求

- 追查 webapp 對話回合完成瞬間，整段文字向左放大一小級的顯示異常。
- 找出完成前後 render/layout branch 切換造成的視覺位移來源。
- 以最小修改修正，避免完成瞬間整段內容重新排版。

## 範圍 (IN / OUT)

### IN

- `packages/ui/src/components/session-turn.tsx`
- `packages/ui/src/components/session-turn.css`
- 必要的 event / validation 記錄

### OUT

- 不處理 scroll ownership 主題本身
- 不重寫整個 session turn 視覺結構

## 任務清單

- [ ] 盤點完成前/後的 UI branch 切換
- [ ] 找出導致內容位移的 layout source
- [ ] 以最小修改修正
- [ ] 驗證修正結果
- [ ] Architecture Sync 檢查

## Debug Checkpoints

### Baseline

- 使用者觀察到：每一回合完成瞬間，整段文字會向左放大一小級，像是切換到不同渲染階層或版面配置。
- 初步推定與 `working -> completed` 的 session-turn branch 切換有關。

### Execution

- 已定位到完成瞬間的主要 branch 切換點在 `packages/ui/src/components/session-turn.tsx`：
  - working 期間，最終 text response 仍包含在 `AssistantParts` / `session-turn-collapsible-content-inner` 內。
  - 完成後，原邏輯會把 response part 自 steps 區隱藏（`hideResponsePart`），並改到獨立的 `session-turn-summary-section` 重新渲染。
  - 這造成相同內容在完成瞬間切換到不同容器層級與左邊界，視覺上就像整段文字向左跳一格。
- 曾嘗試的過渡修正（後續確認為不正確的產品邊界）：
  - 當 `props.stepsExpanded === true` 時，不於完成瞬間隱藏 response part，並同時隱藏 summary section。
  - 這雖然避免了移位，但會讓原本屬於外層「回覆」區塊的內容被吸進「顯示步驟」容器。
  - 使用者回饋確認這是不正確的呈現：展開 steps 不應改變回覆所屬層級。
- 現行修正方向：
  - 撤回上述 branch 合併做法。
  - `response` 在完成後一律回到外層 `session-turn-summary-section`。
  - text shift 問題改由 layout 對齊處理，不再透過改變步驟/回覆邊界來解。
- 本輪第二次最小修正（視覺對齊）：
  - 比對 `session-turn-collapsible-content-inner` 與 `session-turn-summary-section` 後，確認主要左移來源是 steps 展開路徑額外的 `margin-left: 12px` + `padding-left: 12px`。
  - 依使用者偏好採 Route 2：不把 summary 往內推，而是把展開/inline 路徑往 summary 左邊界對齊。
  - 實作上將 `session-turn-collapsible-content-inner` 調整為：
    - `margin-left: 0`
    - `padding-left: 8px`
  - 保留 `border-left` 與右側 padding，讓 steps 視覺層級仍存在，但大幅縮小完成前後的左邊界差。

### Validation

- 驗證指令：`bun turbo typecheck --filter @opencode-ai/ui`
- 結果：passed
- 補充：`@opencode-ai/app` 全量 typecheck 目前被既有無關錯誤阻塞（`src/pages/session/helpers.test.ts` 缺少 `pause` 欄位），非本次 `session-turn` 修正引入。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 session turn 完成前後的前端呈現分支，未改變架構邊界、資料流或模組責任。
