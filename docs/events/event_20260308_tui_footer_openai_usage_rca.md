# Event: TUI Footer OpenAI Usage RCA

Date: 2026-03-08
Status: Done

## 1. 需求

- 釐清為什麼 TUI prompt footer 的 OpenAI 用量數值不再穩定顯示。
- 只做 RCA，不在本輪直接修改 runtime 程式碼。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/account/quota/openai.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/account/quota/display.ts`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_model_selector_account_usage_suffix.md`

### OUT

- 不修改 quota API 或 TUI prompt footer 行為
- 不調整 account storage / auth migration

## 3. 任務清單

- [x] 讀取 architecture 與既有 quota / footer 事件紀錄
- [x] 追查 TUI prompt footer 的 OpenAI quota 資料流
- [x] 比對 2026-03-08 quota refactor 前後差異
- [x] 以本機 runtime 驗證 OpenAI quota core function 是否仍可取值
- [x] 紀錄 RCA 與 validation

## 4. Debug Checkpoints

### Baseline

- 使用者回報：TUI prompt footer 的 OpenAI 用量數值不再顯示。
- `docs/ARCHITECTURE.md` 宣告 TUI footer 應由兩個低成本訊號維持更新：assistant turn completion + 低頻 timer。
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 現況中，`footerTick()` 只影響 account label 與 elapsed time，`codexQuota` resource 的 key 仍只有 `quotaRefresh`。

### Execution

- 追查 `git show f112e356cb4`：2026-03-08 的 quota refactor 把 TUI footer OpenAI quota 改成 `Account.getActive("openai") + getOpenAIQuotaForDisplay(activeId)`。
- 目前 `codexQuota` resource：
  - 會在初次 mount 時跑一次
  - 之後只會在 `lastCompletedAssistant` 改變時因 `setQuotaRefresh()` 重新執行
  - **不會**因 `footerTick` 定時器重新執行
- 因此一旦初次 fetch 得到 `null` / `--`（例如啟動時短暫失敗、cache 為空且 fetch miss、或當次 footer 尚未完成一次成功 quota hydrate），footer 沒有自我恢復機制；必須等下一次 assistant 完成回合才會再觸發 refresh。
- 這與 architecture/event 中描述的「timer 也會驅動 quota refresh」不一致，形成實作漂移。

### Validation

- `bun -e 'import { Account } from "./packages/opencode/src/account/index.ts"; import { getOpenAIQuotaForDisplay } from "./packages/opencode/src/account/quota/openai.ts"; const id = await Account.getActive("openai"); console.log(JSON.stringify({activeId:id, quota: id ? await getOpenAIQuotaForDisplay(id) : null}, null, 2));'`
  - 通過
  - 本機實際回傳：active OpenAI account 存在，quota 可成功取到數值（代表 core quota fetcher 本身未壞）
- `git blame -L 198,207 packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - 顯示 `Account.getActive("openai")` + `getOpenAIQuotaForDisplay()` 為 `f112e356cb4` 引入
- `git show f112e356cb4^:packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx | rg -n "setQuotaRefresh\(|footerTick|codexQuota"`
  - 確認 refactor 前後 `codexQuota` 依然只綁 `quotaRefresh`，沒有把 timer 接進 quota resource key
- 結論：
  - **根因不是 OpenAI quota API 壞掉**
  - **根因是 TUI footer quota refresh 觸發條件過窄，與文件宣告不一致；當初次讀取未拿到值時，footer 不會靠 timer 自動補回數字**
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪只做 RCA，未變更架構邊界或 runtime contract；但已確認目前實作與文件描述存在漂移，待後續修補時再同步文檔或程式
