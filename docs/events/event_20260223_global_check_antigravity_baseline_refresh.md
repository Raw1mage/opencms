# Event: 全域檢查常式翻新（排除 antigravity auth plugin）

Date: 2026-02-23
Status: Done

## 1. 目的

- 使用者要求：全域檢查不再被 antigravity auth plugin 相關診斷阻擋。
- 原則：若本次變更未觸及 antigravity plugin 路徑，則視為 baseline non-blocking。

## 2. 變更

- 更新 `scripts/typecheck-with-baseline.ts`：
  - 從「單檔 (`storage.legacy.ts`) + 固定錯誤碼」改為「整個 antigravity plugin 路徑」判定。
  - 忽略條件升級為路徑前綴比對：`src/plugin/antigravity/**`。
  - 安全閘門保留：若本次 diff 觸及 `packages/opencode/src/plugin/antigravity/**`，則取消忽略並回到 blocking。

- 新增 `scripts/test-with-baseline.ts`：
  - 自動掃描 monorepo 測試檔，預設排除 `packages/opencode/src/plugin/antigravity/**` 與 `packages/opencode/test/plugin/antigravity/**`。
  - 執行 `bun test --timeout 30000 <filtered files...>`。
  - 保留 `packages/app` 的 `test:unit` 執行。

- 更新 root `package.json`：
  - `test` 指令改為 `bun scripts/test-with-baseline.ts`。

- 更新 `docs/ARCHITECTURE.md`：
  - 明確記錄 `check/test` 皆採 baseline 路由。
  - 將描述從單檔忽略升級為整個 antigravity plugin 路徑與測試範圍策略。

## 3. 驗證

- 執行：`bun run verify:typecheck`
- 結果：
  - turbo typecheck 仍回報 antigravity plugin 內既有診斷。
  - baseline 驗證器判定為 non-blocking，且未觸及該路徑，最終通過。

- 執行：`bun run test`
- 結果：
  - 以 baseline 測試腳本執行（已排除 antigravity auth plugin 測試）。
  - 測試通過（0 fail）。
