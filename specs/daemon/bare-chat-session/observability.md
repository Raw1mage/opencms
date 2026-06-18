# Observability: bare_chat_session

## Events

bare session 的可觀測事件（daemon log，event 名稱建議；對應現有 a1.chat.* 慣例）。

| Event | 觸發點 | 欄位 | 用途 |
|---|---|---|---|
| `bare.session.request` | 收到 agent=bare 的 message（A1） | sessionID, hasSystem, hasFormat, hasModelPin, partCount | 確認 bare 路徑被觸發 |
| `bare.system.assembled` | buildStaticBlock bare 分支完成（A2） | sessionID, userSystemLen, zeroedLayers:[driver,agent,agentsMd,systemMd,identity] | **驗證人格清零**（核心，TV1） |
| `bare.account.resolved` | 帳號解析（A3） | sessionID, providerId, modelID, accountId, rotationSkipped:true | 確認固定 pin、無 rotation（TV5） |
| `bare.account.notfound` | 指定帳號不存在（A3 fail-fast） | sessionID, requestedAccountId | fail-fast 證據（TV6） |
| `bare.llm.turn` | Claude 對話完成（A4） | sessionID, accountId, latencyMs, finish, toolChoice | 對話執行 + toolChoice 確認 |
| `bare.structured.captured` | StructuredOutput tool 捕獲（A5） | sessionID, schemaValid | 結構化成功（TV3） |
| `bare.structured.error` | 模型未產出結構化（A5） | sessionID, retries | StructuredOutputError 證據（TV4） |
| `bare.continuation.skipped` | runLoop 識別 passthrough | sessionID | 確認不觸發 autorun（TV8） |

## Metrics

| Metric | 型別 | 用途 |
|---|---|---|
| `bare_session_requests_total` | counter | bare session 請求量 |
| `bare_structured_success_rate` | gauge/ratio | 結構化輸出成功率（Claude 上應接近 1.0；偏低 = provider 或 prompt 問題） |
| `bare_structured_error_total` | counter | StructuredOutputError 次數（監控降級） |
| `bare_account_notfound_total` | counter | 帳號不存在 fail-fast 次數 |
| `bare_llm_latency_ms` | histogram | 對話延遲（對比裸打 Gemini 的 overhead） |
| `bare_persona_pollution_violations` | counter | bare system block 含被清零層內容的次數（**應恆為 0**；非 0 = R1 回歸） |

## Logs

- bare session 的 system block 內容應可在 daemon log（debug level）dump，供 TV1/TV2 驗證人格清零與一般 session 不退化。
- 帳號選擇決策一行 log（AGENTS.md 第一條：operator 可追溯 pool filter）。

## Alerts

- `bare_persona_pollution_violations > 0` → 立即告警（核心契約破壞，R1）。
- `bare_structured_success_rate < 0.95`（Claude provider）→ 告警（可能誤走 codex 或 prompt 退化）。
- `bare_account_notfound_total` 突增 → 帳號設定問題（POC 固定帳號被登出或 key 變動）。
