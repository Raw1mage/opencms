## Requirements

- 釐清 `codex-cli dev` session (`ses_3254eeeffffe8bIuv4FLFJj2sK`) 為何近期 execution 會落到 global active account，看起來像和其他 session 串台。
- 找出 `accountId` 是在哪一層遺失：persisted message、session-local resolver、或 runtime preflight/LLM fallback。
- 若確認為 bug，實作最小修補與回歸測試，避免 session 無 pinned account 時靜默漂到 global active account。

## Scope

### In

- `codex-cli dev` session persisted message identity
- Web/TUI session-local resolver
- assistant/tool-call message account propagation
- runtime fallback path to global active account
- per-turn execution-identity audit logging in debug log

### Out

- 全量 rotation3d 重寫
- release / push

## Task List

- [x] 讀取 architecture 與前一輪 events，建立本輪 baseline
- [x] 比對 `ses_3254eeeffffe8bIuv4FLFJj2sK` 最近 persisted message / debug log
- [x] 確認 `accountId` 遺失的實際寫入點
- [x] 實作最小修補 + regression tests
- [x] 補上 session-level pinned execution identity，避免 synthetic/autonomous 只靠 latest message 漂移
- [x] 阻止 session 內 cross-provider / cross-account fallback
- [x] 修正 base provider 會偷繼承第一個 account fetch/auth 的 request-level root cause
- [x] 驗證、更新 event、完成 architecture sync 記錄

## Baseline

- `docs/ARCHITECTURE.md` 明確規定 session execution identity 的權威座標為 `{ providerId, modelID, accountId? }`；global active account 僅能作為 legacy/default fallback。
- 前一輪已修掉 narration / task subagent / deleted-account resolver 等多條 session account drift 路徑，但使用者回報仍看到新的「串台」現象。
- 目前鎖定的 session 為 `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/info.json`，title=`codex-cli dev`。

## Instrumentation / Evidence

- `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/info.json`
  - session title=`codex-cli dev`
  - latest updated around `1773245023209`
- `/home/pkcs12/.local/share/opencode/log/debug.log`
  - repeated `Provider and auth loaded` for this session show runtime executing on `openai-subscription-miatlab-api-gmail-com`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/messages/msg_cdd984171001qIVr7ysTwi7sAU/info.json`
  - assistant message still contains `accountId = openai-subscription-miatlab-api-gmail-com`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/messages/msg_cdd9f6b53001lAbsxz4FB7zUrz/info.json`
  - newer parent user message already lost `model.accountId`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/messages/msg_cdd9fefc8001E1S2nkSx900t5F/info.json`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_3254eeeffffe8bIuv4FLFJj2sK/messages/msg_cdda014eb001EEnrfdzJXWm6c1/info.json`
  - newer assistant messages retain `providerId/modelID` but no longer persist `accountId`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
  - normal assistant creation path already sets `accountId: lastUser.model.accountId`; therefore missing assistant account implies the parent user message / stream input was already missing it
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
  - `LLM.stream()` resolves `currentAccountId` from active account when session pin is absent, but pre-fix did not write that resolved account back onto stream input
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
  - pre-fix processor only persisted `assistantMessage.accountId` on explicit fallback-switch paths; if `LLM.stream()` silently used active account before first token, persisted assistant metadata could stay empty even though runtime actually used a concrete account
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/index.ts`
  - session schema pre-fix 沒有 persisted execution identity；session execution 主要仍依賴 latest user/assistant message metadata hydrate
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/last-model.ts`
  - pre-fix 只掃 latest user message，不看 session-level execution pin
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.ts`
  - pre-fix autonomous synthetic continue 直接沿用 `input.user.model`，若 local/manual selection 或 runtime write-back 沒同步到 latest user snapshot，後續 synthetic turn 可能沿用舊 identity
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
  - pre-fix cancel 只 abort runtime，不會 clear pending continuation / reset workflow stop reason
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.ts`
  - pre-fix 雖已有同 provider account pinning，但仍可能接受 cross-provider / cross-account candidate 作為 scored / rescue selection
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts`
  - pre-fix base provider (`openai`) 在沒有自身 fetch 時，會從 `Object.keys(familyData.accounts)` 的第一個帳號繼承 fetch/apiKey
  - 這讓「帳號加入順序」意外變成 runtime request policy
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
  - pre-fix 即使 session 已解析出 pinned `accountId`，真正 `Provider.getLanguage(input.model)` 仍可能繼續用 base provider model 建 SDK，而不是該 account provider
- `/home/pkcs12/projects/opencode/packages/app/src/context/local.tsx`
  - Web `availableAccountIds()` / `replacementAccountID()` currently used `providerID` as family directly; this mis-resolves non-family provider ids
- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - TUI equivalent already canonicalizes family via `Account.parseProvider(providerId) ?? providerId`

## Hypotheses

1. `codex-cli dev` 的 newer user message 已經先失去 `model.accountId`，assistant 缺值只是後續症狀，不是最早寫壞點。
2. `LLM.stream()` 在 session account 缺失時會解析出 global active account 並實際用它送 request，但 pre-fix 不會把這個 resolved account 回寫給 processor / persisted assistant metadata。
3. 因此會出現「runtime 實際用 miatlab、debug log 也看到 miatlab，但 persisted assistant/user message 仍缺 accountId」的 split-brain；下一輪 session 再從空值出發，就看起來像跨 session 串台。
4. Web resolver family mis-resolution 是額外風險，會讓某些非 canonical providerId 的 account validity fallback 失真，雖不是這次 OpenAI case 的唯一根因，但應一併修掉。
5. 即使補上 assistant metadata write-back，若 session 本體沒有 SSOT，autonomous/synthetic path 仍可能沿用舊 user snapshot；因此需要 session-level persisted execution identity 才能把 provider/account pin 下來。
6. 若 fallback 仍允許切到其他 provider/account，session pin 最終仍會被 runtime 內部 override；因此需要把 cross-provider / cross-account fallback 明確阻止。

## Execution

- 2026-03-12: reopened investigation with docs-first flow, read `ARCHITECTURE.md` and 2026-03-11 RCA events.
- Confirmed target session and recent persisted assistant messages.
- Confirmed newer parent user message (`msg_cdd9f6b53001lAbsxz4FB7zUrz`) already lost `model.accountId`, so later assistant-message account loss was downstream, not the first break.
- Read `packages/opencode/src/session/prompt.ts`; normal assistant creation already copies `lastUser.model.accountId`, which narrowed the issue to upstream user-message/session-selection loss plus runtime silent fallback.
- Read `packages/opencode/src/session/llm.ts`; confirmed `currentAccountId` is resolved from active account when session pin is absent, but pre-fix this value stayed local to `LLM.stream()`.
- Implemented hardening:
  - `packages/opencode/src/session/llm.ts`
    - when `LLM.stream()` resolves a concrete `currentAccountId`, it now backfills `input.accountId`
  - `packages/opencode/src/session/processor.ts`
    - after `LLM.stream()` returns, processor now persists that resolved `streamInput.accountId` back onto `assistantMessage.accountId`
  - `packages/app/src/context/local.tsx`
    - Web account-family lookup now canonicalizes provider family before deleted-account/session fallback checks
- Implemented per-turn execution-identity audit logging:
  - `packages/opencode/src/session/account-audit.ts`
    - added shared audit schema/helper for request identity logs
  - `packages/opencode/src/session/llm.ts`
    - emits `audit.identity` at `requestPhase=llm-start`
  - `packages/opencode/src/session/processor.ts`
    - emits `audit.identity` at `requestPhase=preflight`, `fallback-switch`, and `assistant-persist`
  - `packages/opencode/src/util/debug.ts`
    - added `userMessageID`, `assistantMessageID`, `requestPhase`, and `source` to structured flow keys
- Implemented session-level pinned execution identity:
  - `packages/opencode/src/session/index.ts`
    - added persisted `session.execution = { providerId, modelID, accountId?, revision, updatedAt }`
    - added `Session.pinExecutionIdentity(...)`
  - `packages/opencode/src/session/user-message-persist.ts`
    - real user-message persistence now pins `session.execution`
  - `packages/opencode/src/session/last-model.ts`
    - `lastModel()` now prefers `session.execution`
  - `packages/opencode/src/session/workflow-runner.ts`
    - autonomous synthetic continue now prefers `session.execution` over stale `input.user.model`
  - `packages/opencode/src/session/prompt.ts`
    - Smart Runner ask-user synthetic user turn now prefers `session.execution`
    - `SessionPrompt.cancel()` now clears pending continuation and marks workflow `waiting_user/manual_interrupt`
  - `packages/opencode/src/session/processor.ts`
    - assistant identity write-back and fallback-applied assistant metadata now also sync into `session.execution`
- Implemented stricter no-drift fallback policy:
  - `packages/opencode/src/session/llm.ts`
    - `handleRateLimitFallback()` now blocks any fallback candidate that changes provider/account away from the current session vector
  - `packages/opencode/src/session/model-orchestration.ts`
    - explicit / agent / scored / rescue candidates are now constrained to the pinned session provider/account when `fallbackModel.accountId` exists
- Implemented immediate manual-selection persistence:
  - `packages/opencode/src/server/routes/session.ts`
    - `session.update` now accepts `execution` payload and bumps persisted `session.execution` revision when provider/model/account actually changes
  - `packages/app/src/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
    - local model setters now support `syncSessionExecution`
  - Web/TUI manual selection surfaces now use that flag so session-local UI change also PATCHes server-side `session.execution` immediately
- Implemented request-level account-provider routing hardening:
  - `packages/opencode/src/provider/provider.ts`
    - base provider fetch inheritance now only uses the **active account**, never insertion-order first account
    - added `Provider.resolveExecutionModel({ model, accountId })` so request-layer execution can switch from base provider to account provider before SDK creation
  - `packages/opencode/src/session/llm.ts`
    - runtime now resolves `executionModel` from `{ input.model, currentAccountId }` before `Provider.getLanguage(...)`
    - debug checkpoint now records both requested `providerId` and actual `executionProviderId`
- Implemented provider-first migration (compatibility phase):
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`
  - `packages/opencode/src/server/routes/account.ts`
    - account lookup / selection paths now prefer canonical provider-key resolution instead of treating `family` as the primary routing concept
    - response payloads now expose provider-oriented compatibility fields (`providerKey`, `providers`) while keeping legacy fields for compatibility
  - `packages/opencode/src/account/index.ts`
  - `packages/opencode/src/provider/canonical-family-source.ts`
  - `packages/opencode/src/account/rotation3d.ts`
    - added provider-first aliases and internal provider-key helpers while preserving storage compatibility
  - `packages/opencode/src/auth/index.ts`
  - `packages/opencode/src/provider/provider.ts`
  - `packages/opencode/src/session/llm.ts`
  - `packages/opencode/src/session/model-orchestration.ts`
    - high-frequency runtime call sites now prefer provider-first account helpers, with compatibility fallback to legacy family helpers where tests/mocks still depend on them

## Root Cause

1. `codex-cli dev` 後半段的 persisted user message 已先失去 `model.accountId`，導致下一輪 `SessionPrompt` 建立 assistant message 時自然也拿不到 session-pinned account。
2. 當 `LLM.stream()` 收到沒有 `accountId` 的 input 時，runtime 仍會以 `Account.getActive(family)` 解析出真實執行帳號（本案為 `openai-subscription-miatlab-api-gmail-com`），所以 debug log 與實際 request header 都有正確 account。
3. 但 pre-fix 這個 resolved account 只存在於 `LLM.stream()` 區域變數，沒有回寫到 `streamInput.accountId` / `assistantMessage.accountId`。
4. 結果是：
   - 實際執行用了 `miatlab`
   - persisted assistant message 仍可能沒有 `accountId`
   - Web/TUI session hydrate 之後又從空 account state 繼續，造成『看起來像別的 session/global active 串進來』的錯覺與持續漂移。
5. 補強後，凡 runtime 已經解析出具體 account，這個 account 會被回寫並持久化到 assistant metadata，讓後續 session-local sync 至少能收斂到真實 execution identity，而不是讓空值繼續傳染。
6. 再往下追後確認：只有 assistant/user message metadata 還不夠，因為 autonomous/synthetic flow 可能在沒有新 real user turn 的情況下繼續沿用舊 snapshot。
7. 因此新增 `session.execution` 作為 session-level SSOT，並讓 user persist / assistant write-back / autonomous synthetic turns 全部收斂到這個 pin。
8. 最後再把 runtime fallback 鎖緊：一旦 session 已有 pinned provider/account，就不允許 fallback 切到別的 provider/account；否則 session pin 仍會被 silent fallback 破壞。
9. 光靠下一個 real user turn 才 persist 還不夠；若使用者在 UI 手動切完模型/帳號後，background/autonomous path 先繼續跑，就可能仍看到舊 pin。因此 manual selection 也必須立即 PATCH `session.execution`。
10. 再往 request layer 追後確認：base provider `openai` 會把第一個 account 的 fetch/auth 繼承成自身 runtime fetch，造成即使 session pin 顯示別的 account，raw request 仍可能走列表第一個帳號。
11. 因此真正的 request-level修正必須同時做到兩件事：

- base provider 不再把「第一個帳號」當成預設 fetch
- session 已有 pinned `accountId` 時，SDK 建立前就把 execution model 切到對應 account provider

## Follow-up Audit: provider vs family terminology inventory

### High-risk logic mixing

- `packages/opencode/src/server/routes/account.ts`
  - API contract, response schema, and route params still use `family` (`/:family/active`, `/auth/:family/login`, response `{ families }`).
  - Logic also resolves quota/account selection through `Account.parseFamily(providerId) ?? providerId`.
  - Risk: API consumers keep reasoning in family terms for account-binding operations that are actually provider-scoped.
- `packages/opencode/src/account/index.ts`
  - storage key is still `families`; core APIs still expose `resolveFamily`, `knownFamilies`, `FamilyData`, `parseFamily` alias.
  - Comments already say this is conceptually providers, but runtime surface area still teaches the old model.
  - Risk: new code keeps layering provider/account behavior behind family semantics, extending ambiguity.
- `packages/opencode/src/provider/canonical-family-source.ts`
  - canonical provider inventory builder is still family-centric in names/types: `CanonicalProviderFamilyRow`, `buildCanonicalProviderFamilyRows`, `resolveCanonicalRuntimeProviderId({ family })`.
  - Risk: provider inventory code itself advertises the wrong abstraction, so downstream UI/server code inherits the terminology drift.
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`
  - model picker groups provider IDs by `family(...)`, normalizes rotation target via family, and special-cases weird family strings.
  - Risk: provider grouping and account carry-over may collapse distinct provider boundaries if future providers expose overlapping model families.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `currentQuotaFamily`, `variantFamily`, and footer account/quota resolution all convert provider → family before OpenAI/account checks.
  - Risk: quota/variant gating remains conceptually tied to family; harmless for today’s providers, but fragile if one provider exposes another family’s models.
- `packages/app/src/components/dialog-select-model.tsx`
  - Web model manager still centers data structures and account records around `family`, `familyOf()`, `selectedProviderFamily`, `getActiveAccountForFamily()`.
  - Risk: UI may continue choosing accounts by family bucket even where provider identity should remain primary.
- `packages/opencode/src/account/rotation3d.ts`
  - header comments and same-provider-account search still describe accounts as “within a provider family”.
  - Risk: future rotation policy changes may accidentally optimize around family grouping instead of actual provider boundary.

### Medium-risk / mostly naming debt with some semantic pressure

- `packages/opencode/src/server/routes/provider.ts`
  - provider list route internally builds `canonicalFamilies`, returns provider rows keyed by family, and comments refer to families with accounts.
- `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - mixed use of `parseProvider`, `parseFamily`, `familyId`, and `hiddenProviders(family)` in one local state layer.
- `packages/app/src/context/local.tsx`
  - still uses helper name `resolveFamily()` against `account_families`, though logic now canonicalizes correctly.
- `packages/sdk/js/openapi.json`
  - public API descriptions still say “provider family” and paths remain `/api/v2/account/{family}/...`.

### Low-risk / compatibility debt

- deprecated aliases in `Account` namespace:
  - `FAMILIES`
  - `Family`
  - `FamilyData`
  - `parseFamily`
- docs/tests/event filenames still contain `family` wording from previous architecture phases.

### Audit conclusion

- This is not only wording debt; there are still several control-plane, UI, and API surfaces where provider-scoped account behavior is modeled as family-scoped behavior.
- Current runtime often behaves correctly because canonical providers and provider families happen to coincide for common cases like `openai` and `google-api`.
- The abstraction becomes dangerous when one provider can expose many model families (example: `github-copilot`) or when account-bearing boundary differs from model-family grouping.
- Recommended next cleanup order:
  1. Rename account API / OpenAPI contracts from `family` → provider-scoped terminology (with compatibility aliases if needed)
  2. Rename `canonical-family-source.ts` and related row/type helpers to provider terminology
  3. Refactor Web/TUI model selectors so grouping-for-display and account-binding are separate concepts
  4. Deprecate `parseFamily` call sites in favor of provider-resolution naming

## Follow-up Fix: selection change interrupts stale runtime

- Root symptom:
  - same session later persisted successful `github-copilot` turns, but OpenAI rate-limit / quota noise could still continue in background
  - this indicates old execution chains were not fully superseded when the operator manually switched the session model/account/provider
- Minimal mitigation implemented:
  - manual model/account/provider selection in Web/TUI now issues `session.abort` before replacing the session-local selection
- Updated files:
  - `packages/app/src/context/local.tsx`
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/app/src/components/dialog-select-model-unpaid.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`
  - `packages/opencode/src/cli/cmd/tui/app.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Intent:
  - when the operator explicitly changes execution identity, stale OpenAI/background chains should be aborted instead of continuing to emit rate-limit noise under the same session

## Follow-up Audit: per-turn execution identity logging

- New checkpoint scope: `audit.identity`
- New canonical message: `session.request.identity.selected`
- Required fields:
  - `sessionID`
  - `userMessageID`
  - `assistantMessageID?`
  - `providerId`
  - `modelID`
  - `accountId`
  - `requestPhase`
  - `source`
- Implemented phases:
  - `preflight`
  - `llm-start`
  - `fallback-switch`
  - `assistant-persist`
- Implemented sources:
  - `session-pinned`
  - `user-message`
  - `active-account-fallback`
  - `rate-limit-fallback`
  - `temporary-error-fallback`
  - `permanent-error-fallback`
  - `assistant-persist`
- Operational value:
  - operators can grep one assistant turn in `debug.log` and answer which provider/account/model actually executed, plus whether that identity came from pinned session state or a fallback path.

## Follow-up Audit: display path vs actual request path

### Confirmed mostly aligned

- Main dialog request path
  - `packages/opencode/src/session/llm.ts`
  - `packages/opencode/src/provider/provider.ts`
  - request-layer now resolves `executionModel` from `{ model, accountId }` before SDK creation
- Session identity persistence path
  - `session.execution`
  - manual selection write-back
  - assistant persist write-back
  - autonomous/synthetic continue

### Still separate / previously drift-prone display paths

- Web footer
  - `packages/app/src/components/prompt-input.tsx`
  - derives account/quota request from local session selection, not raw request trace
- TUI footer
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - pre-fix would show/query active account when session account missing
- TUI admin
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - intentionally mixes selected account / current session account / global active account for control-plane display
- quota hint route
  - `packages/opencode/src/server/routes/account.ts`
  - pre-fix would silently fall back to family active account when request `accountId` was absent or invalid

### Hardening applied

- `packages/opencode/src/server/routes/account.ts`
  - `/account/quota` no longer falls back to active account when request `accountId` is absent/invalid; it now fail-soft returns no account/hint
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - TUI footer account label/quota no longer falls back to `Account.getActive(...)` when the session has no selected account
- intent: display paths should prefer explicit session account and fail soft when identity is missing, instead of silently showing another account's quota

## Validation

- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/llm-rate-limit-routing.test.ts` ✅
  - 新增 regression：當 session account 缺失時，`LLM.stream()` 退回 active account 後會回寫 `input.accountId`，且 request header 帶出該 account
  - 新增 regression：當 session pin 是 `providerId=openai + accountId=pincyluo` 時，request 會真正走 account-scoped provider config，而不是 base provider / 第一個帳號
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/account-audit.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts /home/pkcs12/projects/opencode/packages/opencode/src/util/debug.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/context/local.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model-unpaid.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/app.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts` ✅
  - 新增 regression：autonomous synthetic continue 會優先使用 persisted `session.execution`
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
  - 新增 regression：pinned session account 會拒絕 cross-provider scored candidate
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/index.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/last-model.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/user-message-persist.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (session execution identity pinning + strict no-drift fallback)
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
  - 新增 regression：`session.execution` revision 只在真正 identity 變化時遞增
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts /home/pkcs12/projects/opencode/packages/opencode/test/session/llm-rate-limit-routing.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- Project rule sync:
  - updated `/home/pkcs12/projects/opencode/AGENTS.md`
  - updated `/home/pkcs12/projects/opencode/templates/AGENTS.md`
  - added hard rule: do not add fallback mechanism without explicit user approval
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/account/quota/hint.test.ts` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/server/routes/account.ts /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx /home/pkcs12/projects/opencode/packages/opencode/src/account/quota/hint.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (quota/footer fail-fast hardening)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/server/routes/account.ts /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-first selection key migration)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/account/index.ts /home/pkcs12/projects/opencode/packages/opencode/src/provider/canonical-family-source.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-first core alias migration)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/auth/index.ts /home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/session/llm-rate-limit-routing.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-first runtime helper migration)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/server/routes/account.ts /home/pkcs12/projects/opencode/packages/app/src/components/settings-accounts.tsx /home/pkcs12/projects/opencode/packages/app/src/components/status-popover.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-key response compatibility)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/account/index.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-key storage helper migration)
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx /home/pkcs12/projects/opencode/packages/app/src/components/prompt-input.tsx /home/pkcs12/projects/opencode/packages/app/src/context/global-sync/bootstrap.ts /home/pkcs12/projects/opencode/packages/app/src/context/global-sync.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅ (web provider-first compatibility read cleanup)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (TUI admin compile-safe provider-key rename batch)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (TUI admin root/account providerKey naming cleanup)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (TUI admin model/activity provider-key naming cleanup)
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-provider.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model-unpaid.tsx /home/pkcs12/projects/opencode/packages/app/src/context/local.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (continuous web+tui provider-key terminology cleanup)
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/status-popover.tsx /home/pkcs12/projects/opencode/packages/app/src/components/settings-accounts.tsx /home/pkcs12/projects/opencode/packages/app/src/components/settings-providers.tsx /home/pkcs12/projects/opencode/packages/app/src/components/prompt-input.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (continuous provider-key terminology cleanup batch 2)
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.ts /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (provider-row type cleanup + dialog-account provider-key rename)
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.ts /home/pkcs12/projects/opencode/packages/app/src/components/settings-accounts.tsx /home/pkcs12/projects/opencode/packages/app/src/i18n/en.ts /home/pkcs12/projects/opencode/packages/app/src/i18n/zht.ts /home/pkcs12/projects/opencode/packages/app/src/i18n/zh.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅ (app selector helper + provider locale payload cleanup)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/util/model-variant.ts /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/app.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (TUI prompt/variant/app/local provider-key cleanup)

## Follow-up Fix: web provider-first compatibility reads

- Goal:
  - finish the previously interrupted Web cleanup batch so account payload consumption prefers provider-key compatibility fields (`providers`) while still tolerating legacy `families`
  - remove half-migrated `family` wording in the current model manager/account dialogs where the operational key is already provider-scoped
- Updated files:
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/app/src/components/prompt-input.tsx`
  - `packages/app/src/context/global-sync/bootstrap.ts`
- Applied changes:
  - `dialog-select-model.tsx`
    - completed `AccountRecord.family -> providerKey`
    - account detail / rename / delete dialogs now consistently address account routes and labels with provider key wording
    - account payload reads now prefer `accountInfo.latest.providers ?? accountInfo.latest.families`
    - provider cooldown/status map now keys by provider key compatibility payloads instead of directly assuming legacy `families`
    - session account-switch success toast now reports provider key, not family wording
  - `prompt-input.tsx`
    - local identity matching loop now uses provider-oriented variable names and returns canonical provider key terminology when inferring effective provider family from account payloads
  - `global-sync/bootstrap.ts`
    - global bootstrap now hydrates `account_families` from `providers ?? families`, aligning first-load behavior with the newer compatibility contract
- Architecture Sync: Verified (No doc changes)
  - existing `docs/ARCHITECTURE.md` provider-first compatibility section already states that account APIs may expose both `providers` and legacy `families`, and that Web account-selection paths bind/rout via provider keys

## Follow-up Fix: TUI admin compile-safe provider-key rename batch

- Goal:
  - start shrinking the largest remaining `dialog-admin.tsx` provider/family naming debt without destabilizing the current control-plane behavior
  - keep this batch compile-safe and intentionally small before broader behavioral cleanup
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Applied changes:
  - switched canonical helper imports to provider-key aliases:
    - `buildCanonicalProviderKeyRows`
    - `resolveCanonicalRuntimeProviderKey`
  - `ProviderSelectionValue` now accepts provider-oriented `providerKey` and still tolerates legacy `family` payload shape for compatibility parsing
  - `DialogAdminOption.coreFamily` renamed to `coreProviderKey`
  - provider enable/disable toggle path now reads provider selection via `providerKey`
  - local `canonicalFamilies` memo renamed to `canonicalProviders`
- Non-goals in this batch:
  - no state-machine rewrite
  - no route contract changes
  - no control-plane behavior change beyond naming/compatibility cleanup
- Architecture Sync: Verified (No doc changes)
  - current architecture doc already describes TUI `/admin` as a control-plane surface that is mid-migration toward provider-first semantics while preserving compatibility names

## Follow-up Fix: TUI admin root/account providerKey naming cleanup

- Goal:
  - continue shrinking `dialog-admin.tsx` family-heavy naming inside the root provider list and account list generation, without changing current admin behavior
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Applied changes:
  - root list local variables now use `providerRow` / `providerKey` / `providerData` naming instead of `familyRow` / `fam` / `familyData`
  - root provider option payload now emits `{ providerKey }`
  - root selection checkpoint text updated from `select family` to `select provider key`
  - account list builder now uses `accountsWithProvider` / `coreProviderKey` / `providerKey` naming consistently
  - account list category and selection paths now carry provider-key terminology while preserving the same behavior and state transitions
- Architecture Sync: Verified (No doc changes)
  - no architecture contract changed; this batch only reduced terminology debt inside an existing control-plane implementation

## Follow-up Fix: TUI admin model/activity provider-key naming cleanup

- Goal:
  - continue terminology cleanup inside `dialog-admin.tsx` model/activity rendering paths without changing selection behavior
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Applied changes:
  - `shouldShowFree()` local provider grouping variables now use `providerKey` / `providerData`
  - `formatQuotaFooter()` local provider grouping variable renamed from `providerFamily` to `providerKey`
  - activity table account bucket lookup renamed from `accountFamily` to `providerBucket`
  - activity model selection toast/account lookup now uses `providerKey` wording for account fetch path
  - `owner()` helper local naming now uses provider-key terminology
- Architecture Sync: Verified (No doc changes)
  - this batch only renames local semantics inside an already documented compatibility-phase control-plane surface

## Follow-up Fix: continuous web+tui provider-key terminology cleanup

- Goal:
  - continue autonomous provider-first cleanup across small Web/TUI hotspots without stopping after each micro-batch
- Updated files:
  - `packages/app/src/components/dialog-select-provider.tsx`
  - `packages/app/src/components/dialog-select-model-unpaid.tsx`
  - `packages/app/src/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Applied changes:
  - Web `dialog-select-provider.tsx`
    - local account sync row naming changed from generic `sync` to `providerRow`
  - Web `dialog-select-model-unpaid.tsx`
    - selection account resolution now uses `providerKey` / `providerRow` naming instead of `targetFamily` / `familyRow`
  - Web `context/local.tsx`
    - local helper `resolveFamily()` renamed to `resolveProviderKey()`
    - account replacement helpers now use `providerKey` / `providerData` / `providers` naming
  - TUI `dialog-admin.tsx`
    - model-select internals now use `providerKey` / `runtimeProviderId` naming instead of `baseProviderID` / `modelProviderID`
    - provider add keybind flows now use provider-key terminology in local variables and debug payloads
- Architecture Sync: Verified (No doc changes)
  - no long-lived boundary or runtime-flow contract changed; this was terminology debt reduction only

## Follow-up Fix: continuous provider-key terminology cleanup batch 2

- Goal:
  - continue autonomous cleanup across remaining display/state hotspots while preserving existing compatibility contracts
- Updated files:
  - `packages/app/src/components/status-popover.tsx`
  - `packages/app/src/components/settings-accounts.tsx`
  - `packages/app/src/components/settings-providers.tsx`
  - `packages/app/src/components/prompt-input.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- Applied changes:
  - status/account UI rows now use `providerKey` naming instead of `family` in local row structures
  - provider settings account-count helper now uses `providerRow` naming
  - prompt footer/provider label helpers now use `providerKey` terminology for display/variant formatting paths
  - TUI local account label/account replacement helpers now use `providerKey` / `providerData` naming
  - TUI prompt footer account lookup now prefers `Account.parseProvider(...)` before legacy `parseFamily(...)`
- Architecture Sync: Verified (No doc changes)
  - these changes only reduce terminology debt in state/display helpers; runtime architecture remains unchanged

## Follow-up Fix: provider-row type cleanup + dialog-account provider-key rename

- Goal:
  - continue provider-first terminology cleanup in reusable selector helpers and TUI account-management UI
- Updated files:
  - `packages/app/src/components/model-selector-state.ts`
  - `packages/app/src/components/model-selector-state.test.ts`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx`
- Applied changes:
  - `ProviderRow.family` renamed to `ProviderRow.providerKey`
  - internal provider-universe/provider-group naming in `model-selector-state.ts` now uses provider-oriented terminology
  - associated tests updated to assert `providerKey`
  - TUI `dialog-account.tsx` local account option/value/state naming now uses `providerKey` / `providerAccounts` / `knownProviders`
- Architecture Sync: Verified (No doc changes)
  - no behavior contract changed; helper/type naming only

## Follow-up Fix: app selector helper + provider locale payload cleanup

- Goal:
  - continue removing `family` wording from reusable app-side helpers and user-facing account-switch payloads where the operational meaning is provider key
- Updated files:
  - `packages/app/src/components/model-selector-state.ts`
  - `packages/app/src/components/settings-accounts.tsx`
  - `packages/app/src/i18n/en.ts`
  - `packages/app/src/i18n/zht.ts`
  - `packages/app/src/i18n/zh.ts`
- Applied changes:
  - `buildAccountRows()` and `getModelUnavailableReason()` local naming now uses `providerKey` / `providerRow`
  - `getActiveAccountForFamily()` argument/local naming updated toward provider-key semantics (function name kept for compatibility)
  - account switch success toast now passes `{ provider, account }` instead of `{ family, account }`
  - localized strings updated to `{{provider}} → {{account}}`
- Architecture Sync: Verified (No doc changes)
  - no runtime/data-flow contract changed; display/helper terminology only

## Follow-up Fix: TUI prompt/variant/app/local provider-key cleanup

- Goal:
  - continue TUI-side terminology cleanup in footer variant controls, local hidden-provider helpers, and app bootstrap account resolution
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/tui/util/model-variant.ts`
  - `packages/opencode/src/cli/cmd/tui/app.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx`
- Applied changes:
  - prompt footer variant helpers now use `variantProviderKey`
  - variant utility inputs renamed from `family` to `providerKey`
  - app startup active-account lookup now prefers `Account.parseProvider(...)` before legacy `parseFamily(...)`
  - local hidden-provider helpers now use `providerKey` naming
  - dialog-account local action naming now uses `providerKey`
- Architecture Sync: Verified (No doc changes)
  - terminology cleanup only; no lifecycle or runtime contract changes

## Remaining issues / next-round backlog

### 1. TUI admin is still not a pure execution-truth surface

- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- It still intentionally mixes:
  - selected account
  - current session account
  - global active account
- This is acceptable as a control-plane/admin UI, but it means admin display is still not guaranteed to equal actual request account.

### 2. Web footer still reflects session/local UI state, not raw request trace

- `packages/app/src/components/prompt-input.tsx`
- It now behaves better because session/local selection is more stable, but footer identity/quota still derives from UI/session selection state rather than raw request-trace evidence.

### 3. TUI footer still prefers local session selection over persisted session record

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- Active-account fallback has been removed, but footer still reads local selection instead of reading persisted `session.execution` directly.

### 4. SDK/Web generated types have not been fully updated for `session.execution`

- Web page code currently uses a local type extension/cast to read `session.execution`.
- Proper follow-up should update the SDK schema / generated client types so `Session.execution` is first-class everywhere.

### 5. provider vs family naming debt remains a systemic risk

- Multiple APIs, routes, and UI helpers still use `family` language for behaviors that are actually provider/account-bound.
- This remains a standing risk for future routing bugs and silent mis-design.
- Compatibility-phase progress has reduced the highest-risk behavior paths, but the following still remain:
  - legacy route paths such as `/:family/...`
  - generated SDK/OpenAPI naming
  - UI labels / i18n copy / test names using `family` as if it were the execution boundary

### 6. Full request-trace ↔ UI-display traceability is still incomplete

- Main request path now has much better request-level identity evidence.
- But not every UI display field can yet be mapped directly to a raw outbound request trace ID.

### Practical status after this round

- Main dialog request path: mostly aligned with session execution identity
- Delegated/subagent path: aligned enough for current session-account invariant
- Quota route: now fail-fast instead of silently consulting active account
- Web session-page model sync: now prefers persisted `session.execution`
- Remaining work is now mostly display/control-plane consistency and type/terminology debt, not the original first-account token-burn root cause
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/server/routes/session.ts /home/pkcs12/projects/opencode/packages/app/src/context/local.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model-unpaid.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/app.tsx /home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit && bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md`
    - clarified provider > account > model/model-family hierarchy
    - documented that provider is the operational/account-binding boundary, while model family is catalog metadata
    - noted that some legacy route/helper names still say `family`, but future reasoning should treat them as provider-scoped compatibility names
    - documented new `audit.identity` observability contract for turn-level provider/account execution tracing
    - documented persisted `session.execution` SSOT, autonomous synthetic identity reuse, manual interrupt queue clearing, and blocked cross-provider/account fallback once session pin exists
    - documented that manual Web/TUI selection now immediately PATCHes `session.execution` instead of waiting for the next prompt

## Follow-up Fix: provider-key terminology cleanup batch 3

- Goal:
  - continue small compile-safe provider-first cleanup in remaining TUI/app helper and display hotspots
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `packages/app/src/components/model-selector-state.ts`
- Applied changes:
  - `dialog-admin.tsx`
    - renamed local selection state from `selectedFamily` to `selectedProviderKey`
    - renamed helper/account-selection locals to `effectiveAccountIdForProviderKey` and `syncProvidersForProviderKey`
    - updated debug payload wording in the touched paths to prefer `providerKey`
  - `dialog-model.tsx`
    - renamed local grouping helpers from family-oriented names to provider-key/group wording
    - clarified legacy email comment to refer to provider-key normalization
  - `context/local.tsx`
    - renamed parsed display locals from `familyId` / `familyProvider` to `providerKey` / `providerKeyInfo`
  - `prompt/index.tsx`
    - renamed footer quota selector helper from `currentQuotaFamily` to `currentQuotaProviderKey`
  - `model-selector-state.ts`
    - introduced provider-first helper name `providerKeyOf()`
    - kept `familyOf` as a compatibility alias to avoid broader churn in this batch
    - renamed internal filtered-model locals to provider-scoped wording
- Architecture Sync: Verified (No doc changes)
  - rename-only/local-helper cleanup; no runtime behavior or fallback policy changed

## Follow-up Fix: provider-key terminology cleanup batch 4

- Goal:
  - continue shrinking remaining local/debug `family` wording in TUI admin and switch safe app-side helper imports to provider-first naming
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/app/src/components/dialog-select-model-unpaid.tsx`
- Applied changes:
  - `dialog-admin.tsx`
    - renamed local account lookup vars from `lookupFamily` to `lookupProviderKey`
    - updated touched debug payloads for account edit/view/delete paths to use `providerKey` wording
    - kept compatibility child-component props like `family={...}` unchanged where required by existing interfaces
  - `dialog-select-model.tsx`
    - switched safe local helper import/usage from `familyOf` to `providerKeyOf`
    - renamed `targetFamily` / `familyRow` locals to provider-key wording
  - `dialog-select-model-unpaid.tsx`
    - switched safe local helper import/usage from `familyOf` to `providerKeyOf`
- Architecture Sync: Verified (No doc changes)
  - rename-only/local-helper cleanup; no behavior or routing contract changed

## Follow-up Fix: provider-key terminology cleanup batch 5

- Goal:
  - continue low-risk local/helper wording cleanup in TUI admin and Web model selector state without touching compatibility contracts
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - `packages/app/src/components/dialog-select-model.tsx`
- Applied changes:
  - `dialog-admin.tsx`
    - renamed local provider-toggle parameters from `familyId` to `providerKey`
    - updated related provider-toggle error copy to use provider-key naming internally
  - `dialog-select-model.tsx`
    - renamed selected-account locals from `familyRow` to `providerRow`
    - renamed model-selection candidate list from `familyCandidates` to `providerCandidates`
- Architecture Sync: Verified (No doc changes)
  - rename-only/local-helper cleanup; no behavior or routing contract changed

## Follow-up Fix: provider-key terminology cleanup batch 6

- Goal:
  - continue low-risk local helper/comment cleanup in TUI admin and align remaining test wording with provider-key terminology
- Updated files:
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - `packages/app/src/components/model-selector-state.test.ts`
- Applied changes:
  - `dialog-admin.tsx`
    - renamed local helper `family(...)` to `providerKeyFromId(...)`
    - updated related local call sites and comments to provider-key wording
    - kept legacy payload compatibility for `value.family` while documenting it as a compatibility path
  - `model-selector-state.test.ts`
    - updated test names from `provider family` wording to `provider key`
- Architecture Sync: Verified (No doc changes)
  - rename-only/local-helper cleanup; no behavior or routing contract changed

## Follow-up Fix: provider-key terminology cleanup batch 7

- Goal:
  - continue low-risk helper input-shape cleanup in model selector utilities while preserving compatibility at call sites
- Updated files:
  - `packages/app/src/components/model-selector-state.ts`
- Applied changes:
  - renamed helper input properties from `selectedProviderFamily` / `providerFamily` to `selectedProviderKey` / `providerKey`
  - kept behavior unchanged by preserving the same normalization and filtering logic behind the renamed local/helper-facing inputs
- Architecture Sync: Verified (No doc changes)
  - helper/input-shape cleanup only; no behavior or API contract changes beyond local call sites

## Follow-up Fix: provider-key terminology cleanup batch 8

- Goal:
  - finish a low-risk helper-input rename slice by updating local app call sites/tests to match provider-key terminology
- Updated files:
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/app/src/components/prompt-input.tsx`
  - `packages/app/src/components/model-selector-state.test.ts`
- Applied changes:
  - updated local helper call sites from `selectedProviderFamily` to `selectedProviderKey`
  - updated local helper call sites from `providerFamily` to `providerKey`
  - updated selector-state tests to match the renamed helper inputs
- Architecture Sync: Verified (No doc changes)
  - local helper-call cleanup only; no runtime behavior or compatibility API contract changed

## Follow-up Fix: provider-key terminology cleanup batch 9

- Goal:
  - add provider-key-friendly helper aliases and continue trimming low-risk local comment wording without changing compatibility contracts
- Updated files:
  - `packages/app/src/components/model-selector-state.ts`
  - `packages/app/src/components/dialog-select-model.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Applied changes:
  - `model-selector-state.ts`
    - added `getActiveAccountForProviderKey` as a provider-first alias of the existing compatibility helper export
  - `dialog-select-model.tsx`
    - switched local usage to the new provider-key alias while preserving behavior
  - `dialog-admin.tsx`
    - updated remaining local comments from `family` wording to `provider key` where they only described local grouping semantics
- Architecture Sync: Verified (No doc changes)
  - alias/comment cleanup only; no runtime behavior or compatibility API contract changed

## Follow-up Fix: provider-key terminology cleanup batch 10

- Goal:
  - keep compatibility aliases explicit while reducing future ambiguity for local helper consumers
- Updated files:
  - `packages/app/src/components/model-selector-state.ts`
- Applied changes:
  - documented `familyOf` as a compatibility alias for provider-key normalization
  - documented `getActiveAccountForProviderKey` as the preferred provider-first alias while keeping the legacy export intact
- Architecture Sync: Verified (No doc changes)
  - documentation/comment-only cleanup; no runtime behavior or API contract changed
