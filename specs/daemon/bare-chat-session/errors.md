# Errors: bare_chat_session

## Error Catalogue

bare session 的錯誤一律 fail-fast、明確回報，禁止 silent fallback（天條 #11）。

| Code | 觸發情境 | 回應 | Recovery | 責任層 |
|---|---|---|---|---|
| `BARE_ACCOUNT_NOT_FOUND` | `model.accountId` 指定的帳號不存在於 accounts.json | 4xx + 明確訊息，**不** fallback 到其他帳號 | 呼叫端修正 accountId（POC 用 `claude-cli-subscription-claude-cli-d5002de6`） | Account Resolver (A3) |
| `BARE_PROVIDER_MISMATCH` | bare session 帶 `format:json_schema`，但解析到的 provider 不支援強制 toolChoice（如 codex） | 明確報錯或標降級警告，不靜默吞掉 format | POC 固定 Claude；生產走 DD-7 邊界決策 | Bare Session Handler (A2) / Provider (A4) |
| `StructuredOutputError` | 帶 format 但模型未呼叫 StructuredOutput tool（純文字回應） | 回 StructuredOutputError（含 retries），**不**回自由文字假裝成功 | 呼叫端 retry；或檢查 system prompt 是否引導模型呼叫 tool | Capture Structured Output (A5)；既有 `prompt.ts:3907-3918` |
| `BARE_LAYER_INJECTION_VIOLATION` | bare 模式內部被要求注入非 userSystem 層（driver/AGENTS.md/SYSTEM.md/identity） | fail-fast 拋錯（開發期斷言），不靜默疊加 | 修正 bare 分支邏輯 | buildStaticBlock bare branch (A2) |
| `CHAT_UPSTREAM_ERROR` | Claude 後端回非 200（如 503 UNAVAILABLE、429） | 透傳上游狀態 + 明確訊息 | 暫時性（503/429）→ 呼叫端 retry；POC 固定帳號額度耗盡 → 等 reset 或換帳號 | Claude Provider (A4)（既有 provider 行為） |
| `CHAT_BAD_REQUEST` | bare message 缺必填欄位（agent/system/parts） | 4xx | 呼叫端補齊 request（見 data-schema.json BareMessageRequest required） | Receive Bare Session Request (A1) |
| `SOCKET_UNREACHABLE` | cecelearn 端連不到 daemon unix socket | 連線層錯誤（呼叫端側） | 確認 daemon 在跑、socket 路徑正確、權限可讀 | 呼叫端（cecelearn，另案） |

## Fail-Fast 原則（天條 #11）

- bare session **不得**因帳號不存在 / provider 不支援 / 模型未配合而 silent fallback。
- 每個錯誤保留證據（daemon log）、明確回報、要求呼叫端決策。
- 特別禁止：account switch 在 bare session 固定 pin 模式下偷偷 rotation 或 cross-family fallback（POC 固定帳號已規避；生產見 DD-7）。
