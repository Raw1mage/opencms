# Event: Fix CLI Unauthorized Session Creation

Date: 2026-02-09
Status: Done
Topic: CLI, Authentication, Session

## 1. 需求分析

- 在執行 `bun run dev run` 指令時，若環境中設置了 `OPENCODE_SERVER_PASSWORD`，CLI 內部請求會因為缺乏 Authorization Header 而導致 `Unauthorized` 錯誤。
- CLI 需要自動識別伺服器授權狀態並提供對應的憑證。

## 2. 執行計畫

- [x] 分析 `src/server/app.ts` 的 `basicAuth` 邏輯。
- [x] 修改 `src/cli/cmd/run.ts`，在初始化 SDK 時加入 Basic Auth Header。
- [x] 驗證修復。

## 3. 關鍵決策與發現

- **發現**: `src/cli/cmd/run.ts` 使用自定義的 `fetchFn` 調用 `Server.App().fetch()`，這會觸發 `app.ts` 中配置的所有 Hono 中間件。
- **決策**: 使用 `Flag.OPENCODE_SERVER_PASSWORD` 判斷是否需要授權，並使用 `btoa` 生成 Basic Auth Header。

## 4. 驗證結果

- 通過 `OPENCODE_SERVER_PASSWORD=testpass bun run dev run "test"` 驗證，Session 建立成功且 Agent 正常運作。
- 通過 `--continue --fork` 測試，驗證端對端 Session 分叉邏輯正常。
