# Refactor Plan: Sync from Latest Claude Code (2026-02-11)

## 0. 狀態 (Status)

🟡 **WAITING_APPROVAL**

## 1. 目標 (Objective)

將 `claude-cli` 協議層與 **latest claude-code (v2.1.39)** 對齊，優先修正「版本漂移、OAuth scope 漂移、過時測試假設」，在不破壞既有 TUI 可用性的前提下完成 refactor。

## 2. 目前差異摘要 (Current Delta)

1. `packages/opencode/src/plugin/anthropic.ts`
   - `VERSION` 仍為 `2.1.37`，與上游 `2.1.39` 不一致。
   - OAuth authorize/refresh scope 仍是 `org:create_api_key user:profile user:inference`。
2. `packages/opencode/src/plugin/anthropic.test.ts`
   - 測試仍驗證 `/v1/sessions` 與 `session_id` 注入，與現行 `?beta=true` 策略衝突。
3. `packages/opencode/src/session/system.ts`
   - Claude prompt route 僅部分型號使用 `claude-code.txt`，其餘仍落到 `anthropic.txt`。
4. `packages/opencode/src/session/prompt/anthropic.txt`
   - 開頭保留 `You are OpenCode, the best coding agent on the planet.`（歷史 RCA 指出此片段可能觸發驗證風險）。

## 3. 執行範圍 (Execution Scope)

### A. Protocol constants & auth scope 對齊
- 檔案：`/home/pkcs12/opencode/packages/opencode/src/plugin/anthropic.ts`
- 變更：
  - `VERSION` 升級到 `2.1.39`。
  - authorize/refresh scope 升級為：
    - `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers`

### B. 測試更新（移除過時 Sessions API 假設）
- 檔案：`/home/pkcs12/opencode/packages/opencode/src/plugin/anthropic.test.ts`
- 變更：
  - 移除 `/v1/sessions` 相關斷言。
  - 改驗證 `messages` 請求是否具備：
    - `?beta=true`
    - `session_id` header 被移除
    - `mcp_` 前綴與必要 header 保留

### C. Claude prompt route 收斂（避免身份指紋漂移）
- 檔案：`/home/pkcs12/opencode/packages/opencode/src/session/system.ts`
- 變更：
  - 讓 `claude-cli`/Claude 系列統一優先走 `claude-code.txt`（除非有明確例外需求）。

### D. 風險控管與最小化改動
- 不改 DB schema。
- 不改 public API 介面。
- 不引入新的 provider。

## 4. 驗證計畫 (Verification)

1. `bun test /home/pkcs12/opencode/packages/opencode/src/plugin/anthropic.test.ts`
2. `bun run typecheck`
3. （可選）`bun run test` 做全域回歸檢查

## 5. 風險評估 (Risk)

- **中風險**：scope 調整可能影響既有 token refresh 行為（需以測試 + 實測確認）。
- **中風險**：prompt route 收斂可能改變少數 Claude 型號輸出風格。
- **低風險**：版本常數更新與 header/beta 路徑已存在，不涉及架構重寫。

## 6. 完成定義 (Definition of Done)

- `anthropic.ts` 與 latest 版本/必要 scope 對齊。
- `anthropic.test.ts` 不再依賴已棄用 Sessions API 假設。
- Claude 請求路徑維持 `?beta=true` + `mcp_` 策略且測試通過。
- Typecheck 通過。
