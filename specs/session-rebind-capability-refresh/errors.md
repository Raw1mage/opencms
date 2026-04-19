# Errors: session-rebind-capability-refresh

Error codes introduced by this spec. Each entry: trigger / user-visible message / responsible layer / log level / recovery strategy.

## ERR_REBIND_RATE_LIMIT_EXCEEDED

- **Trigger**: `RebindEpoch.bumpEpoch` 的 sliding window 在 1 秒內已記錄 ≥ 5 次 bump，第 6 次被阻擋
- **User-visible message**: 視呼叫端不同
  - slash `/reload`：`"Reload rate limit hit — try again in <N>ms"`
  - tool call：tool output 含 `status: "rate_limited_session"` + message
  - HTTP `POST /session/:id/resume`：HTTP 200 with body `{status:"rate_limited"}`（非 4xx，因 signal 源可能無法處理重試）
- **Layer**: RebindEpoch core (`packages/opencode/src/session/rebind-epoch.ts`)
- **Log level**: `warn` + anomaly event `session.rebind_storm`
- **Recovery**: caller 等待至少 1 秒後重試；anomaly event 留存供 dashboard / 使用者觀察是否系統有 bug
- **Rationale**: rate-limit 之後的狀態保持一致（epoch 不動、cache 不動）；不會半 bump 半失敗

## ERR_REFRESH_TOOL_PER_TURN_LIMIT

- **Trigger**: AI 在單一 assistant turn 內呼叫 `refresh_capability_layer` ≥ 4 次
- **User-visible message**（tool output）: `"refresh limit exceeded (3 per turn) — the capability layer is already at the latest epoch"`
- **Layer**: Tool handler (`packages/opencode/src/tool/refresh-capability-layer.ts`)
- **Log level**: `warn` + anomaly event `tool.refresh_loop_suspected`
- **Recovery**: tool 不 bump epoch；AI 應解讀「已是最新」繼續任務；若 AI 仍重複呼叫，session 層級的 rebind-rate-limit 會後續阻擋
- **Rationale**: 防 AI 因 tool 回應不如預期而陷入 refresh → retry 迴圈

## ERR_RESUME_SIGNAL_FORBIDDEN_ORIGIN

- **Trigger**: `POST /session/:id/resume` 請求來源非 Unix socket（可能是 HTTP gateway 轉發、跨 uid、或 AI 從 tool 偽造的 HTTP）
- **User-visible message**（HTTP）: `403 {status: "forbidden_origin"}`
- **Layer**: Server route (`packages/opencode/src/server/routes/session.ts`)
- **Log level**: `warn` + anomaly event `session.resume_forbidden_origin`
- **Recovery**: 拒絕請求；不 bump；不改 cache；anomaly 留痕供 audit
- **Rationale**: DD-9 要求 origin 驗證；防 AI 透過 tool call 偽造 session resume

## ERR_RESUME_SIGNAL_SESSION_BUSY

- **Trigger**: 收到 `POST /session/:id/resume` 但該 session 目前 `SessionStatus.type === "busy"` 或 `"retry"`
- **User-visible message**（HTTP）: `200 {status: "ok", epoch: <current>}` — 不告訴呼叫者 busy（因為對 UI 而言這不是錯誤）
- **Layer**: Server route
- **Log level**: `info`（這是正常狀況，不是 anomaly）
- **Recovery**: 跳過 silent reinject；runLoop 會自己在下輪 cache miss 時重填
- **Rationale**: DD-5 簡化設計，busy 情境下不需搶 lock

## ERR_CAPABILITY_LAYER_REINJECT_FAILED

- **Trigger**: `CapabilityLayer.reinject` 執行中某個 layer 讀取失敗（AGENTS.md ENOENT / SKILL.md parse error / enablement.json 損壞 / driver prompt 不存在）
- **User-visible message**: 由 caller 判斷是否顯示
  - silent path：僅 log；anomaly event 供 dashboard
  - /reload：回傳訊息帶 `"Partial refresh — some layers failed. Check event log for details."`
  - tool call：tool output 含 `failures: [{layer, error}]`
- **Layer**: CapabilityLayer (`packages/opencode/src/session/capability-layer.ts`)
- **Log level**: `error` + anomaly event `capability_layer.refresh_failed`
- **Recovery**: 保留前一個成功 epoch 的 cache 不被覆寫（R3 mitigation）；runLoop 讀當前 epoch cache 發現空時 fallback 到前 epoch；AI 仍能對話，但能力層停留在前一版本
- **Rationale**: 絕不 half-write cache；失敗要明確可觀測；session 不崩潰

## ERR_CAPABILITY_LAYER_PARTIAL_MISSING_SKILL

- **Trigger**: `CapabilityLayer.reinject` 讀 skill 時某個 mandatory skill 的 `SKILL.md` 不存在
- **User-visible message**: dashboard 會顯示「N skills missing」
- **Layer**: CapabilityLayer + MandatorySkills integration
- **Log level**: `warn` + event `skill.mandatory_missing`（既有事件，continue use）
- **Recovery**: 該 skill 略過，其他 skill 照常 pin；reinject 整體視為成功（partial success）；cache 寫入；`refreshed` event 的 `missingSkills` 列出缺失清單
- **Rationale**: skill 缺失是使用者環境問題不是 runtime bug；不該讓 session 炸

## ERR_TOOL_REASON_REQUIRED

- **Trigger**: AI 呼叫 `refresh_capability_layer()` 未提供 `reason` 參數
- **User-visible message**（tool validation error）: `"reason is required and must be a non-empty string"`
- **Layer**: Tool parameter schema (Zod validation)
- **Log level**: `warn`（正常 schema 拒絕，非 anomaly）
- **Recovery**: tool 直接拒絕執行；AI 下一 tool call 需補 reason
- **Rationale**: 強制 AI 為主動 refresh 負責、供 audit；event payload 不會出現空 reason

## ERR_RELOAD_NO_ACTIVE_SESSION

- **Trigger**: 使用者在無 active session context 下（例如 CLI bootstrap 階段）執行 `/reload`
- **User-visible message**: `"no active session to reload"`
- **Layer**: Slash command handler (`packages/opencode/src/command/reload.ts`)
- **Log level**: `info`
- **Recovery**: 命令直接返回錯誤；無 side effect
- **Rationale**: /reload 必須綁定特定 session；無 session 時是使用者操作失誤

## Error Catalogue

| Code | Layer | Level | Anomaly? | Session crashes? |
|---|---|---|---|---|
| ERR_REBIND_RATE_LIMIT_EXCEEDED | RebindEpoch | warn | yes (`rebind_storm`) | no |
| ERR_REFRESH_TOOL_PER_TURN_LIMIT | Tool | warn | yes (`refresh_loop_suspected`) | no |
| ERR_RESUME_SIGNAL_FORBIDDEN_ORIGIN | Server route | warn | yes | no |
| ERR_RESUME_SIGNAL_SESSION_BUSY | Server route | info | no | no |
| ERR_CAPABILITY_LAYER_REINJECT_FAILED | CapabilityLayer | error | yes (`capability_layer_refresh_failed`) | no (fallback cache) |
| ERR_CAPABILITY_LAYER_PARTIAL_MISSING_SKILL | CapabilityLayer | warn | yes (existing `mandatory_skill_missing`) | no |
| ERR_TOOL_REASON_REQUIRED | Tool schema | warn | no | no |
| ERR_RELOAD_NO_ACTIVE_SESSION | Command | info | no | no |
