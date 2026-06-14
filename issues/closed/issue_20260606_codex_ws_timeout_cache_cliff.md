# Bug: Codex WS timeout causes permanent lock into HTTP fallback and cache cliff

## Status

- Closed (Fixed)
- Priority: High
- Type: Bug / RCA / Cache

### Resolution
- 已放寬首幀逾時參數 `WS_FIRST_FRAME_TIMEOUT_MS` 至 30,000ms。
- 已實作 Bounded Self-Healing 有界自癒機制，當經過冷卻期（timeout 為 60s，其餘為 300s）且發起新一輪 User Turn 時，重置 WS 失效標記以重新連線自癒。
- 所有單元測試皆順利通過，代碼已 merge 回 main 分支。

## Background

使用者在使用 Codex (`gpt-5.5` 推理模型) 進行開發時，頻繁且看似隨機地遇到 **Cache Cliff（快取斷崖式下跌）** 的症狀，使得 prefix-cache 無法被有效維持，每次發言都需要全額重新傳送對話歷史（Full Resend），大幅拖慢了回應速度。

## Symptom

- 在單一對話會話（Session）中，前幾輪對話原本運作良好且有高快取命中率。
- 經過某次停頓或長思考後，對話突然發生超時斷線（或是短暫網路不穩）。
- 自該次斷線起，後續的每一次對話都出現嚴重的 Cache Cliff，系統回報發送了全額的 `input_tokens` 且沒有快取命中（`cache.read` 極低或只剩系統提示詞底線），對話完全失去了快取延續性。即使重新執行/重新載入對話客戶端（Client reload）也無法恢復，只有透過 daemon 重啟（daemon restart）才能重置 state。

## Expected Behavior

- 在短暫網路波動或模型思考延遲（TTFT）較長時，連線不應輕易被判定失效而作廢整條增量連線鏈。
- 即使因超時暫時降級到 HTTP，在發起下一輪對話（New Turn）時，系統應該重新嘗試建立 WebSocket 以恢復增量 Delta 傳輸模式與 Prefix-Cache 狀態，不應將 session 永久鎖死在 HTTP 降級狀態。

## Root Cause Analysis (RCA)

經程式碼深度檢索與歷史事故分析，發現此問題源於以下三個機制的連鎖缺陷：

### 1. 苛刻的首幀超時限制
在 [transport-ws.ts (Line 789)](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L789-L799) 的 [probeFirstFrame](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L779-L810) 函式中，系統讀取來自 [protocol.ts](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/protocol.ts#L43) 的常數設定：
`WS_FIRST_FRAME_TIMEOUT_MS = 10_000`（10 秒）。
對於具有推理思維（Reasoning）的 `gpt-5.5` 模型來說，高負載下首字時間（TTFT）大於 10 秒是家常便飯。這極易觸發超時判定。

### 2. WebSocket 狀態在記憶體中被永久鎖死
一旦 `probeFirstFrame` 觸發 10 秒超時，系統除了清空 `lastResponseId` 外，還會將 WsSessionState 的 `disableWebsockets` 欄位設為 `true`：
```typescript
  if (result.timeout) {
    reader.cancel()
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuation(sessionId)
    state.disableWebsockets = true  // <--- 永久標記禁用
    ...
```
在整個 WsSessionState 生命週期中，`state.disableWebsockets` 唯有在「帳號切換」時才會被設回 `false`。於單一帳號的對話情境中，該禁用標記一旦被設為 `true` 後就**在 daemon 進程生命週期內鎖死，無復原機制**。

> **校正（見下方 RCA Verification §2）**：此宣稱僅在**單一 daemon 進程內**成立。`sessions` 是 module-level 的 in-memory `Map`、`disableWebsockets` 從不寫進 disk/continuation，故 **daemon 重啟會重置該 flag 回 `false`**。體感上「重新執行前台客戶端沒用」實際成因是後台 daemon 並未重載，若 daemon restart 後但慢-TTFT 條件仍在，第一輪 WS 也會在 10s 內重新鎖死。

### 3. HTTP 降級導致無法使用增量傳輸與快取
由於 `disableWebsockets === true`，該 session 後續每一輪進入 [tryWsTransport](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L857) 時，都會被此條件直接攔截並跳過：
```typescript
  if (state.disableWebsockets) return null // <--- 直接不嘗試 WS，降級至 HTTP
```
降級走 HTTP 後，因為 HTTP 傳輸無法像 WebSocket 般利用 `previous_response_id` 指針與 `planDeltaTrim` 進行增量對話（Delta Mode），導致每一次對話都會發送全額歷史（Full Resend），這就是造成永久性 Cache Cliff 的核心根源。

## Related Issues / History

- `specs/codex/cli-reversed-spec/chapters/11-cache-prefix-model.md` (WS reconnect kills delta mode → cache death spiral)
- `packages/provider-codex/src/transport-ws.ts`

## RCA Verification (2026-06-06，逐條對照原始碼)

針對上述 RCA 對 `transport-ws.ts` / `provider.ts` 逐行核實，結論：**三段因果鏈主體成立、值得修，但需精確化，且漏掉一個關鍵設計脈絡，會直接影響下方建議修法。**

### §1 「10s 首幀超時太苛」 — ✅ 成立（且比原描述更嚴重）
- `WS_FIRST_FRAME_TIMEOUT_MS = 10_000` 屬實（[protocol.ts:43](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/protocol.ts#L43)）。
- **行號校正**：真正的 timeout race 在 `transport-ws.ts:786-804`（`Promise.race([reader.read(), setTimeout(...)])`），非原描述標的 789-799。
- **加重**：`probeFirstFrame` 不只在 reconnect 跑，而是**每一輪** WS request 都跑——reuse 路徑 `transport-ws.ts:925`、fresh 路徑 `:979`。因此推理模型只要某輪 TTFT > 10s 即觸發，風險面比原描述更廣。

### §2 「disableWebsockets 鎖死」 — ✅ 成立（daemon 重啟會重置）
- 設 `true` 共**三處**：`:798`(timeout)、`:808`(stream done)、`:1008`(all paths failed)。
- 設 `false` 只有裝備初始化為 `:100`(預設) 與 `:901`(帳號切換)。**daemon 進程生命週期內確實無 per-turn 自癒**，這部分成立。
- **機制釐清**：`sessions` 為 module-level in-memory `Map`（`transport-ws.ts:56`），`disableWebsockets` 從不持久化。**daemon 重啟 → Map 清空 → `getSession` 建新 state（`disableWebsockets:false`）**。故體感「重新執行客戶端沒用」實際成因是後台 daemon 並未重載，若 daemon restart 後慢-TTFT 條件仍在，第一輪 WS 也會在 10s 內重新鎖死。

### §3 「HTTP 降級無法 delta/快取」 — ✅ 大致成立
- delta 注入（`reqBody.previous_response_id = state.lastResponseId`）僅存在於 WS 路徑內（`transport-ws.ts:919-920` 與 `:973-974`）。
- HTTP fallback（[provider.ts:381+](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/provider.ts#L381)）直接送原始 `body`、**無**此 state 注入，故降級後失去 WS 的 delta mode、退回 full resend。方向正確。
- 補充：原描述提到的 `planDeltaTrim` 為更上游機制，cache cliff 的直接成因是 HTTP 路徑缺少 `previous_response_id` 指針延續，而非 `planDeltaTrim` 本身。

### ⛔ 漏掉的關鍵脈絡（直接否定建議修法 #2）
- `transport-ws.ts:1007` 註解明寫 **`// All failed → sticky HTTP fallback`**——**此鎖是刻意設計**，非單純 bug。
- `transport-ws.ts:866-884` 留有事故記錄（`ses_1c875cc15ffe...`，一夜兩次）：codex server 會**靜默 evict session 卻不回報** `previous_response_not_found`，client 續送 delta → 模型在近空 context（~3K 而非 200K+）上跑出 10+ 分鐘垃圾。團隊據此**刻意選擇「正確性 > delta 速度」**（reload 時主動丟棄 disk continuation 做 full cold send）。
- 因此**原建議修法 #2「每輪主動重置 `disableWebsockets=false`」是危險的**：WS 真正壞掉時會變成每輪都重試、每輪都卡滿 10s stall，正好打回 sticky-fallback 設計想避免的退化，且重新引入上述 stale-context 事故風險。

---

## Proposed Fix Plan (確定的修改計畫)

### 1. 調整超時參數以防禦推理模型 (Reasoning) 延遲
在 [protocol.ts](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/protocol.ts#L43) 中，放寬首幀超時限制：
```diff
-export const WS_FIRST_FRAME_TIMEOUT_MS = 10_000
+export const WS_FIRST_FRAME_TIMEOUT_MS = 30_000
```
這允許模型在思考思考塊（thinking process）時，能有最多 30 秒的緩衝時間而不會被客戶端斷線。

### 2. 擴充 `WsSessionState` 追蹤失效細節
在 [transport-ws.ts:30-54](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L30-L54) 的 `WsSessionState` 介面中加入自癒所需欄位：
```typescript
  disabledAt?: number
  disableReason?: "timeout" | "done" | "hard_failure"
```

### 3. 記錄鎖定原因與時間點
修改 `transport-ws.ts` 中設定 `state.disableWebsockets = true` 的三個位置，記錄鎖定細節：
* **位置一 (First Frame Timeout)**（[Line 798](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L798)）：
  ```typescript
  state.disableWebsockets = true
  state.disableReason = "timeout"
  state.disabledAt = Date.now()
  ```
* **位置二 (First Frame Empty Done)**（[Line 808](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L808)）：
  ```typescript
  state.disableWebsockets = true
  state.disableReason = "done"
  state.disabledAt = Date.now()
  ```
* **位置三 (All Connection Paths Failed)**（[Line 1008](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L1008)）：
  ```typescript
  state.disableWebsockets = true
  state.disableReason = "hard_failure"
  state.disabledAt = Date.now()
  ```

### 4. 實作「有界自癒 (Bounded Self-Healing)」判定
在 [tryWsTransport](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L857) 的頂端攔截點（[Line 908](file:///home/pkcs12/projects/opencode/packages/provider-codex/src/transport-ws.ts#L908)），修改為：
```typescript
  if (state.disableWebsockets) {
    // 1. 偵測是否為新的 User Turn（藉由 input 陣列的最後一筆是否為 user 判斷）
    const lastItem = Array.isArray(body.input) ? body.input.at(-1) : undefined
    const isUserTurn = lastItem && (lastItem.role === "user" || (lastItem as any).type === "user")

    // 2. 計算自上次鎖定已流逝的時間
    const elapsed = Date.now() - (state.disabledAt ?? 0)

    // 3. 定義退避冷卻時間 (Transient timeout 退避 60s; Hard failure 退避 300s)
    const cooldown = state.disableReason === "timeout" ? 60_000 : 300_000

    if (isUserTurn && elapsed > cooldown) {
      console.error(
        `[CODEX-WS] self-healing connection retry session=${sessionId} elapsed=${Math.round(elapsed / 1000)}s reason=${state.disableReason}`
      )
      // 重置 flag 以進行 WS 重新嘗試
      state.disableWebsockets = false
      state.disableReason = undefined
      state.disabledAt = undefined
    } else {
      // 未滿足自癒條件，維持 HTTP 降級 fallback
      return null
    }
  }
```

---

## Acceptance Criteria

- 確保 `gpt-5.5` 在高負載思考超過 10 秒時，不會輕易被客戶端主動斷線與作廢連線鏈。
- 當發生暫時性網路中斷或超時導致降級至 HTTP 後，下一輪對話重新發起時，應能成功重新啟用 WebSocket 傳輸並接回 Delta 狀態，恢復快取機制。
