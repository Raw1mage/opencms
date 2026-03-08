# Event: web model selector account reorder regression

Date: 2026-03-08
Status: Completed

## 需求

- 修正 webapp model selector 在切換 account 時，account list 會因 active account 變更而重新排序的回歸問題。
- 保持 account list 顯示順序穩定，避免使用者點擊後列表跳動。

## 範圍 (IN / OUT)

### IN

- `packages/app/src/components/model-selector-state.ts`
- `packages/app/src/components/dialog-select-model.tsx`
- `packages/app/src/components/model-selector-state.test.ts`

### OUT

- TUI `/admin` account ordering
- Provider list ordering
- 其他與 model selector 無關的 quota / layout / scroll 行為

## 任務清單

- [x] 檢查目前 web model selector account list 排序路徑與近期回歸 commit
- [x] 建立最小修正，避免 active account 切換觸發 list reordering
- [x] 補上/更新測試覆蓋排序行為
- [x] 執行驗證並確認 `docs/ARCHITECTURE.md` 是否需要同步

## Debug Checkpoints

### Baseline

- 症狀：在 web model selector 點擊切換 account 後，active account 會被移到第一位，造成 account list 跳動。
- 重現路徑：開啟 web model selector → 選擇某 provider family → 點擊另一個 account 進行切換。
- 影響範圍：web model selector account column；主要懷疑點為 `buildAccountRows()` 的排序規則。
- 既有歷史：`docs/events/event_20260228_model_selector_rca_account_order_icon_color_unavailable_tag.md` 已記錄過相同 RCA，指出應維持 label-only 排序。

### Execution

- 確認回歸來源位於 `packages/app/src/components/model-selector-state.ts` 的 `buildAccountRows()`：目前排序邏輯會把 `active` account 強制排到第一位。
- 比對近期 commit 與歷史 event 後，確認這與 `event_20260228_model_selector_rca_account_order_icon_color_unavailable_tag.md` 記錄的既有 RCA 相反，屬於回歸。
- 進一步追溯 `git log -S 'if (a.active && !b.active) return -1' -- packages/app/src/components/model-selector-state.ts`，確認回歸由 `12c19b9ee8 refactor: remove antigravity runtime and stabilize model manager scroll` 再次引入。
- 以最小修改移除 active-first 排序，恢復為 label-only 排序，讓切換 active account 時不再改變 account list 顯示順序。
- 更新 `packages/app/src/components/model-selector-state.test.ts`，除原本排序驗證外，再補一個 activeAccount 前後切換仍維持相同顯示順序的 regression test，降低再次回歸風險。
- 進一步補強 `pickSelectedAccount()` 測試，確認 account list refetch 後即使 active account 已變更，當前使用者選中的 account 仍會被保留；只有當選中 account 已不存在時才退回 active account。

### Validation

- 驗證指令：`bun test /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts`
- 結果：7 tests passed。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 web model selector account row 的前端排序規則，未改變任何架構邊界、資料流、API contract 或 runtime module responsibility。

## Post-fix Audit

- 已再檢查 `dialog-select-model.tsx` 中 account 相關狀態流：UI account column 現在唯一排序來源是 `buildAccountRows()`，沒有第二條 active-first 排序路徑。
- `switchActiveAccount()` 仍會先更新本地 `selectedAccountId`、再呼叫 `account.setActive()`；失敗時會 rollback 到 previous selection，屬可接受行為，未發現額外 reorder 問題。
- `pickSelectedAccount()` 在 provider/account 資料刷新後，會優先保留當前選中 account；若該 account 不存在才退回 active account / 第一筆，未發現因 refetch 造成的隱性跳序。
- 本輪 audit 未發現第二個同類回歸點；目前風險主要集中在未來若再次修改 `buildAccountRows()` 排序規則時，需保留既有 regression tests 作為 gate。
- 另外已為 `pickSelectedAccount()` 補上相鄰狀態測試，避免未來 refetch / activeAccount 切換時出現 selection 被意外覆寫的回歸。
