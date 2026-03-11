## Requirements

- 調整 rotation3d 規則：當 rate limit 觸發 rotate 時，若 fallback 仍落在同一個 provider，下次 5 分鐘內不得再次進行同 provider rotate。
- 需要新增相關計時器、檢查點與驗證，避免同 provider 快速切換不同身份觸發上游 server 的懲罰性封鎖。

## Scope

### In

- `rotation3d` fallback selection / guardrail
- 與 rate-limit fallback 相關的 cross-process timer state
- checkpoint / logs / tests

### Out

- provider-wide cooldown promotion 規則重寫
- Web/TUI 額外 UX redesign
- release / push

## Task List

- [ ] 建立 baseline 與系統邊界
- [ ] 找出同 provider rotate 的執行點與 state 落點
- [ ] 新增 5 分鐘同 provider rotate guard timer
- [ ] 新增 selection / skip checkpoints
- [ ] 補上 targeted tests
- [ ] 更新 validation 與 architecture sync 結論

## Baseline

- 使用者指出：rotation3d 在 rate limit 後會切換帳號；若在同一 provider 下快速切換不同身份，會被 server 視為可疑行為並施加懲罰性封鎖。
- 需要一條額外 guardrail：同 provider rotate 一旦發生，5 分鐘內不能再做第二次同 provider rotate。

## Instrumentation / Evidence

- `docs/ARCHITECTURE.md`
  - 既有文件已定義 rotation/fallback 與 session-local execution identity 分層，但尚未描述「同 provider rotate guard」這條 provider-level 行為約束。
- `packages/opencode/src/session/llm.ts`
  - 真正的 runtime rotate 入口在 `handleRateLimitFallback()`。
  - 這裡已能判斷 fallback 是否為 same-provider / same-account / same-model，適合在「實際發生同 provider rotate」後 arm timer。
- `packages/opencode/src/account/rotation3d.ts`
  - `selectBestFallback()` 是所有 fallback candidate 進入最終選擇前的集中過濾點。
  - 若要避免 5 分鐘內再次同 provider rotate，應在這裡以 provider-level guard 過濾同 provider 候選，而不是散落在各呼叫端各自判斷。
- `packages/opencode/src/account/rotation/state.ts` / `types.ts`
  - unified rotation state 目前只保存 `accountHealth`、`rateLimits`、`dailyRateLimitCounts`。
  - 若 guard 要跨 process 生效，必須擴充 unified state，而不能只留在單一 process memory。
- `packages/opencode/src/account/rotation/rate-limit-tracker.test.ts`
  - 現有 tracker 測試風格是 mock `./state`，驗證 cross-process state contract；新 guard 也沿用同一測試手法。

## Root Cause

1. **現有 rotation3d 只有 rate-limit / health 維度，沒有「短時間內已做過同 provider rotate」這個風險訊號**
   - `selectBestFallback()` 只會過濾 `isRateLimited`、health score、tried vectors。
   - 因此當某 provider 下有多個帳號/模型時，只要它們沒有被標為 rate-limited，就可能在短時間內被連續挑中。
2. **真正的封鎖風險是 provider-scoped，而不是單一 vector-scoped**
   - 使用者描述的上游懲罰來自同 provider 下快速切換不同身份。
   - 這不是單一 `(provider, account, model)` vector 的健康問題，而是整個 provider 在短時間內不應再次做內部 rotate。
3. **如果只在 runtime memory 記錄，無法覆蓋 cross-process / daemon / UI 路徑**
   - rotation state 本來就透過 unified `rotation-state.json` 提供 cross-process 一致性。
   - 同 provider rotate guard 也必須走同一個 persistent state contract，否則不同 process 對是否允許再次 rotate 會出現所見非所得。

## Execution / Decisions

1. 在 `packages/opencode/src/account/rotation/types.ts` 擴充 `UnifiedRotationState.sameProviderRotationCooldowns`，新增 provider-level guard state 型別。
2. 在 `packages/opencode/src/account/rotation/state.ts` 補上 unified state 讀取預設值，確保舊 state 檔缺少新欄位時也能安全回填。
3. 新增 `packages/opencode/src/account/rotation/same-provider-rotation-guard.ts`
   - 提供 cross-process 的 provider-level 5 分鐘 timer。
   - API：`mark()` / `getWaitTime()` / `isCoolingDown()` / `clear()` / `clearAll()` / `getSnapshot()`。
4. 在 `packages/opencode/src/account/rotation/index.ts` 匯出 guard 與 global singleton，讓 rotation selector / llm runtime 共用同一 guard。
5. 在 `packages/opencode/src/account/rotation3d.ts`
   - `selectBestFallback()` 讀取 `getSameProviderRotationGuard().getWaitTime(current.providerId)`。
   - guard active 時，過濾所有「同 provider 但非當前 vector」的 rotate 候選。
   - 新增 checkpoint：`Same-provider rotate quota consumed; forcing cross-provider fallback`，輸出 waitMs / blockedCandidates / triedCount。
6. 在 `packages/opencode/src/session/llm.ts`
   - 當 `handleRateLimitFallback()` 實際選到 same-provider fallback（provider 相同，但 account 或 model 改變）時，arm 5 分鐘 guard。
   - 新增 checkpoint：`Same-provider rotate guard armed`。
7. 測試策略
   - 新增 `same-provider-rotation-guard.test.ts` 驗證 provider-level timer 真的被寫入 shared state。
   - 新增 `rotation3d-guard.test.ts` 驗證 guard active 時會跳過 same-provider 候選，但仍允許 diff-provider rescue。

## Validation

- Tests
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/rate-limit-tracker.test.ts` ✅
- Lint
  - `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/types.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/state.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/index.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts` ✅
- Typecheck
  - `bun run typecheck` in `/home/pkcs12/projects/opencode/packages/opencode` ✅
- Architecture Sync: Updated
  - 新增 provider-level same-provider rotate cooldown contract、shared state 欄位、與 observability checkpoints 到 `docs/ARCHITECTURE.md`。
  - 補充 observability 文案：當 same-provider quota 已消耗時，checkpoint 會明確標示強制跨 provider；若無可用 cross-provider 候選則明確標示 rotation stopped。
