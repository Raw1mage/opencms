# Observability: codex-fingerprint-alignment

## Events

本 spec 不新增 Bus event；以既有 daemon log + 新增幾行診斷輸出作為觀察介面。

| Event 名 | 發送時機 | Payload | 用途 |
|---|---|---|---|
| `log [CODEX-WS] UPGRADE` | WS 升級建立連線時（Phase 1 起；既有 log line 擴充） | `{ accountId, userAgent, hasWindow, turnStatePresent }` | 確認 WS 升級帶齊必要 header |
| `log [CODEX-HTTP] REQ` | HTTP fallback 發出前（既有 line） | `{ accountId, userAgent, conversationId }`（Phase 4 新增 conversationId 欄位） | 確認 HTTP 路徑有 x-client-request-id |
| `log [CODEX-PROVIDER] buildHeaders` | `buildHeaders()` 被呼叫時（Phase 2 重構後新增 trace 行） | `{ isWebSocket, keys: string[] }` | 覆蓋率驗證 WS + HTTP 皆走此函式 |
| `log [CODEX-PROVIDER] submodule-version` | daemon 啟動時印一次 | `{ codexCliVersion, refsCodexSha }` | 在 event log 綁定 submodule 與常數對齊狀態 |

> Phase 1/3 結束前，以上除 `submodule-version` 外應已存在；本 spec 僅確認這些 line 有輸出足夠判斷 header 正確性的欄位。若原本沒記 `userAgent` 欄位，Phase 1 順手加一行。

## Metrics

本 spec 的主指標靠 OpenAI 官網後台**人工查看**，不經自家 metric pipeline。以下列出可輔助的可觀察量：

| Metric | 來源 | 預期值 / 方向 | 用途 |
|---|---|---|---|
| `codex.thirdPartyClassificationRatePct` | OpenAI 官網後台（外部 / 人工） | Phase 1+3 後 < 1%；Phase 4 後 ≈ 0% | 主驗收指標；無自動採集 |
| `codex.ws.successRatePct` | daemon log `[CODEX-WS] REQ` 與 `[CODEX-WS-FAIL]` 比例 | 不回歸（≥ Phase 0 baseline） | Regression guard；Phase 2 重構風險監測 |
| `codex.http.successRatePct` | daemon log `[CODEX-HTTP] REQ` 與錯誤事件比例 | 不回歸 | 同上 |
| `codex.ws.upgradeLatencyMs` | WS 升級前後 timestamp diff（既有 log，若無則 Phase 1 順手加） | 不明顯退化 | Phase 1 inline 補 UA 不應讓升級變慢 |
| `codex.ratelimits.reset` | response header `x-codex-*` / `retry-after` | 觀察用；本 spec 不改 rate limit 行為 | 驗收期間附帶觀察，確認無 fingerprint 觸發 quota 誤判 |

### Log 欄位檢查清單

驗收 beta soak 時，operator 應在 daemon log（`/run/user/<uid>/opencode-per-user-daemon.log`）確認每筆 `[CODEX-WS] UPGRADE` 與 `[CODEX-HTTP] REQ` 都出現：

- `originator=codex_cli_rs`
- `User-Agent=codex_cli_rs/0.125.0-alpha.1 (...)`（Phase 3 後）
- `ChatGPT-Account-Id=...`（TitleCase，Phase 1 後）
- `x-client-request-id=...`（Phase 4 後）
- `Accept=text/event-stream`（HTTP only，Phase 4 後）

### Alerts

本 spec 不設自動 alert。Beta 驗收失敗（§3.5 stop gate）屬人工判定 → 回報使用者走 `revise` flow。
