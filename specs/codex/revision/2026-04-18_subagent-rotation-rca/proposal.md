# Proposal: subagent-rotation-rca

## Why

- 使用者回報：subagent session 打 `codex/gpt-5.4 (raw@sob.com.tw)` 命中 429 / QUOTA_EXHAUSTED 時，rotation3d 似乎沒能在第一時間接手，LLM 狀態面板先顯示兩次「Codex WS: An error occurred while processing your request. Please include the request ID 8b3a246c-...」才看到 rotation 切到 `yeatsluo@thesmart.cc`。
- 初步分析（由 explore subagent 於 2026-04-18 完成）顯示：
  - Parent agent：`llm.ts:onError` → `handleRateLimitFallback` → rotation3d，正常運作
  - **Subagent 刻意被 pin 在 parent 的 (provider, account, model) execution identity**（[tool/task.ts:1757-1764](packages/opencode/src/tool/task.ts#L1757-L1764) `Session.pinExecutionIdentity`）
  - 當 subagent 收到 429 時：不能自己 rotate，必須 publish `RateLimitEscalationEvent` 給 parent（[processor.ts:1289](packages/opencode/src/session/processor.ts#L1289)），然後在 [processor.ts:1301](packages/opencode/src/session/processor.ts#L1301) 的 `ModelUpdateSignal.wait()` 阻塞最多 30 秒
  - Parent 收到 event → 跑 rotation3d → 透過 stdin `model_update` command 回覆 worker → worker `resolve()` 繼續
- **懷疑的真正問題**（待驗證）：
  1. Parent 的 escalation handler 反應慢或 event 傳遞延遲 → subagent 耗完 30s timeout
  2. Parent 本身也被 429 塞住 → 來不及回應
  3. WS 層的錯誤事件反覆發射導致 subagent 連發多個 escalation event，parent 處理順序錯亂
  4. `ModelUpdateSignal` 本身的通道（stdin command）在某些情況不可靠
- 用戶觀察的「同 request ID 兩次」推測為 UI 雙渲染單一 error event，不是真的雙發請求（OpenAI 每 request 給新 x-request-id；相同 ID = 單 request 雙次顯示）。但仍需確認。

## Original Requirement Wording (Baseline)

- 「問題出在subagent似乎沒有辦法觸發rotation」（2026-04-18 21:09）
- 「不知道是不是硬retry搞到server阻擋了。」（2026-04-18 21:10）
- 「清除死碼，重新抓RCA病灶寫revision plan」

## Requirement Revision History

- 2026-04-18: initial draft — pivot after transport.c dead-code 誤判

## Effective Requirement Description

1. **重現 bug**：構造 subagent + 被 quota-exhausted 帳號的情境，驗證 rotation 延遲與 error 雙渲染是否為穩定複製。
2. **拆解 escalation chain**：逐點確認 Bus event 發送時序、parent handler latency、stdin command 傳送、worker resolve 時機。
3. **量測 timeout 實際命中率**：log 觀察 `ModelUpdateSignal.wait()` 實際等多久才收到 resolve；如果幾乎都 <1s，timeout 不是主因；如果常 >5s 或 hit 30s，timeout 需降低或改架構。
4. **修復**：視 RCA 結論而定，可能涉及
   - escalation event 的 priority / fast-path
   - parent handler 的併發模型
   - 取消 pinning 讓 subagent 能 self-rotate（需評估 execution identity 一致性保證）
   - UI 層錯誤事件去重（若確認雙渲染）
5. **可觀測性補強**：在 escalation chain 各點 log `[rotation-escalation] phase=<X> elapsed=<ms>`，讓下次出事能直接從 log 找到瓶頸。

## Scope

### IN
- `packages/opencode/src/session/processor.ts` escalation trigger 與 wait loop
- `packages/opencode/src/tool/task.ts` parent-side `handleRateLimitEscalation`
- `packages/opencode/src/session/model-update-signal.ts`
- `packages/opencode/src/cli/cmd/session.ts` stdin `model_update` handler
- `packages/opencode/src/session/llm.ts` `onError` 與 `handleRateLimitFallback` 的 event-firing 路徑
- TUI 層錯誤事件渲染（若確認是雙渲染）：`packages/app/src/context/global-sync/` 相關檔案

### OUT
- rotation3d 選帳號邏輯本身
- C library（已於 `2026-04-18_codex-c-library-removal` 處理）
- 非 codex provider 的 rotation 問題
- subagent 產生 / 回收生命週期的整體重構

## Non-Goals

- 不改 Bus 核心（`src/bus/`），僅利用既有 Bus primitive
- 不做跨-provider rotation 改動
- 不改 `Session.pinExecutionIdentity` 語意（若有需要，另立 extend revision）

## Constraints

- AGENTS.md「善用系統既有 Infrastructure」：禁止新造計時器 / polling loop 替代 Bus event chain
- AGENTS.md 第一條：若 RCA 過程中需要 fallback 行為，必須明確 log，不可靜默
- AGENTS.md「Race Condition 審查義務」：escalation 是跨 worker / parent 的跨行程訊號，修改前要列出 race window
- **本 revision 以 RCA 為主，修復範圍由 RCA 結論決定**。若結論指向需要架構級變更，切換 parent spec（`provider_runtime`）為 `revise` 或 `refactor` mode

## What Changes

- Phase A (Investigate)：把 escalation chain 每個節點加量測 log（臨時 debug log，修完 revert 或保留精簡版）
- Phase B (Reproduce)：能在本機穩定重現 rotation 延遲
- Phase C (Fix)：依 RCA 改（具體改動此時未定）
- Phase D (Regression guard)：加整合測試覆蓋 subagent rotation 場景

## Capabilities

### New Capabilities
- escalation chain 各節點的 latency log（可觀測性）
- 整合測試：subagent 收到 429 → rotation 在 <1s 完成

### Modified Capabilities
- 視 RCA 結論而定，待 design.md 確定

## Impact

- **Code**：opencode core session / tool 層，非 provider 層
- **User experience**：rotation 延遲從「感受到數秒卡頓 + 錯誤訊息」降為「最多 1 秒的 transparent switch」
- **Risk**：動 escalation chain 風險中等；若誤改可能造成 subagent 卡死或 rotation 失效。緩解：Phase A 先量測、Phase B 重現、Phase C 小步修改、每步有 regression test
- **Dependencies**：需要 `2026-04-18_codex-c-library-removal` 先合進來嗎？不需要，兩個 revision 獨立
