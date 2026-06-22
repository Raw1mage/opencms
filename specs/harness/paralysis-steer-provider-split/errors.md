# Errors: harness_paralysis-steer-provider-split

## Error Catalogue

| Code | 條件 | 處置 |
| --- | --- | --- |
| `STEER_CLASS_UNRESOLVED` | `resolvePolicy(providerId)` 取不到 kind(provider 未註冊) | fail-safe 視為 SS(持久化路徑),不可因判定失敗而靜默丟棄 steering;log warn |
| `STEER_CLONE_TAIL_MISSING` | SL 路徑找不到可掛載的 sessionMessages tail(無 user 訊息) | 比照 CLAUDE_PROACTIVE_REMINDER:跳過注入並 log,不可改寫真實訊息或落地 |
| `STEER_SS_PERSIST_FAILED` | SS 路徑 `Session.updateMessage`/`updatePart` 拋錯 | 維持現有行為(現狀如何即如何),不可因新 helper 包裝而改變既有錯誤語意(INV-0) |
| `LADDER_DOUBLE_HALT` | recoveryCount 因 ephemeral 不落地被誤判而無法遞增 | 視為 R1 回歸 → 硬停;`getParalysisState` 為 session Map,計數不得綁定歷史落地 |

## Invariants

- INV-0:SS 路徑錯誤行為與分流前 byte-identical。
- claude 路徑任何錯誤都不得 fallback 成「持久化 role:user 中文責備」(那正是要消除的毒)。
