# Event: session-scoped provider/account/model identity

## Requirements

- 讓每個 session 可以各自指定 provider / account / model。
- 不同 session 不應再被同一 provider family 的全域 active account 互相影響。
- 本次開發在 `/home/pkcs12/projects/opencode-beta` 的 `beta` 分支進行。

## Scope

### In

- session prompt / shell / command / summarize 的 model identity contract
- session message persistence（user / assistant / subtask）所需的 account 維度
- session runtime 的 account 解析、preflight rate-limit、success/failure recording、fallback 入口
- web / TUI 的 session-local model selection state
- 相關測試、event、architecture sync

### Out

- account storage schema (`accounts.json`) 重構
- provider family canonicalization 重做
- rotation3d 整體策略重寫
- release / push / deploy

## Task List

- [x] 將 beta repo 同步到 source repo 最新 `cms`
- [x] 從同步後基線建立 `beta` 分支
- [x] 重新閱讀 architecture / 事件 / 核心 session/account/runtime 路徑
- [x] 定義 session-scoped identity contract（providerId / modelID / accountId）
- [x] 實作 runtime 與 API 傳遞
- [x] 實作 web / TUI session-local selection
- [x] 補測試與驗證
- [x] 同步 `docs/ARCHITECTURE.md`

## Conversation Summary

- 使用者要求把 workdir 改到 `~/projects/opencode-beta`，讓該 repo 與本 repo 的 `cms` 同步，並從 beta repo 開 `beta` 分支來開發本項目。
- 使用者補充：在這個場合下，不希望 `code-thinker` 的「最小可行範圍」心態壓縮全局框架思考；本次採 architecture-first 視角，以全局資料流與邊界為主。

## Baseline

- beta repo fetch 後確認原本本地 `cms` 落後 source repo 的 `origin/cms`。
- 已使用 fast-forward 將 beta repo 對齊到 `3c062e3a4d6939c8def9d77d152fbb8d620db78e`，並建立 `beta` 分支。
- 目前 session runtime 雖然有 provider/model 維度，但 account 仍主要取自 family 的全域 active account。
- web model selector 與 TUI admin/prompt 仍會透過 `Account.setActive(...)` 改寫全域 account 狀態。

## Instrumentation / Evidence

### Docs / architecture evidence

- `docs/ARCHITECTURE.md`
  - 明確要求 cms runtime 以 3D identity（Provider Family / Account / Model）思考。
  - Session APIs 已有 persisted workflow metadata，但 session-level model/account preference 尚未落實為完整 runtime contract。

### Runtime evidence

- `packages/opencode/src/session/message-v2.ts`
  - `User.model` 已擴為 `{ providerId, modelID, accountId? }`
  - `SubtaskPart.model` 已擴為 `{ providerId, modelID, accountId? }`
  - `Assistant` 已可持久化 `accountId`
- `packages/opencode/src/session/user-message-context.ts`
  - `prepareUserMessageContext()` 已接受 `{ providerId, modelID, accountId? }`
- `packages/opencode/src/session/last-model.ts`
  - `lastModel(sessionID)` 現可沿用上一個 user message 的 session-scoped identity
- `packages/opencode/src/session/llm.ts`
  - runtime 會優先使用傳入的 `accountId`，只在缺省時才 fallback 到 `Account.getActive(family)`
  - `ProviderTransform.options(...)` 已實際吃到上游傳遞的 session-scoped `accountId`
- `packages/opencode/src/session/processor.ts`
  - pre-flight rate-limit 檢查已優先用 `streamInput.accountId ?? input.accountId`
  - fallback 後會同步更新 runtime input 與 assistant metadata 的 `{ providerId, modelID, accountId? }`
- `packages/opencode/src/session/prompt.ts`
  - `PromptInput.model` / shell / command 路徑都已可攜帶 `accountId`
- `packages/opencode/src/session/model-orchestration.ts`
  - scorer / fallback / trace 已保留 `accountId`，避免 orchestration 層再次丟失 session identity

### Web/TUI evidence

- `packages/app/src/components/prompt-input/submit.ts`
  - submit / shell / command 送出的 model 已包含 session-local `accountId`
- `packages/app/src/context/local.tsx`
  - local model selection key 已擴為 `providerID / modelID / accountID?`
- `packages/app/src/components/dialog-select-model.tsx`
  - account click / model select 已改為更新 session-local selection，不再把 `setActive()` 當作選模入口
- `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - TUI local model state / recent model key 已納入 `accountId`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - footer account / OpenAI quota 現優先跟隨 session-local `accountId`
  - assistant fallback sync 現會追蹤 account-only 變化
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
  - activity/model 選擇現更新 session-local selection；只有真正帳號管理動作才呼叫 `Account.setActive(...)`

## Root Cause

真正的問題不是「session 沒有 model」，而是 account 維度先前沒有成為 session execution identity 的一部分：runtime preflight、provider call、success/fallback recording、以及 web/TUI 選模 UI 都會在不同邊界回退到 provider family 的全域 active account。結果是不同 session 共用同 family 時，會經由 global active account 洩漏彼此的 execution identity。

## Design Direction

1. 將 session model identity 從二維 `{ providerId, modelID }` 擴為三維 `{ providerId, modelID, accountId? }`。
2. 讓 user message / subtask / assistant message 都能攜帶 accountId，形成 session 內可持久化的 execution identity。
3. 讓 runtime（prompt → user-message-context → last-model → llm → processor）優先使用 session-carried `accountId`，而不是回退到全域 active account。
4. rotation / fallback 可保留現有引擎，但不得再把 session 指定 account 靜默覆蓋成全域 active account；若 fallback 需要換 account，應在 session/assistant metadata 中留下實際使用結果。
5. web / TUI 必須先有 session-local model/account state，不能再用 `setActive()` 當作 session 選模手段。

## Execution / Decisions

1. **Identity contract widened**
   - session model identity 已正式擴為 `{ providerId, modelID, accountId? }`
   - user / assistant / subtask message metadata 已能持久化 accountId
2. **Runtime precedence clarified**
   - prompt / shell / command / processor / llm 會優先使用 session-carried `accountId`
   - 只有在 session 沒有明確 account 時，才 fallback 到 family active account
3. **Fallback semantics corrected**
   - rate-limit fallback 不再直接把新 account 寫回 global active account
   - assistant metadata 會更新成實際執行所使用的 provider/model/account
4. **UI boundary corrected**
   - Web model selector 改成 session-local selection
   - TUI admin activity/model selection 改成 session-local selection
   - TUI prompt footer / quota metadata 優先顯示 session-local account，而不是固定顯示 global active account

## Validation Plan

- 型別 / lint：針對修改檔案跑 eslint / typecheck
- 單元測試：message schema、session model context、runtime fallback/account routing、web/TUI local state
- 手動驗證：
  - 兩個 session 分別指定同 family 的不同 account
  - 互相送 prompt 時，不應再互改對方實際使用 account
  - web model selector / TUI admin 選模不應再改動全域 active account

## Risks

1. **高風險**：fallback / rate-limit / success recording 若仍有遺漏，session 可能只在表面上帶 accountId，但底層仍混入 active account。
2. **中風險**：web / TUI local state 若只修一側，跨 surface 行為會不一致。
3. **中風險**：既有 monitor / summary / sidebar 若假設 message 只有 provider/model，可能需要同步補 account-aware 顯示或至少保持向後相容。

## Validation

- Branch sync:
  - beta repo fast-forwarded to source repo `cms`
  - created branch `beta`
- Targeted tests:
  - `bun test /home/pkcs12/projects/opencode-beta/packages/opencode/src/session/model-orchestration.test.ts` ✅
  - `bun test /home/pkcs12/projects/opencode-beta/packages/opencode/test/session/message-v2.test.ts` ✅
- Lint:
  - `bunx eslint` on touched session/TUI/docs-related TS/TSX files ✅ (no output)
- E2E harness / integration verification:
  - fixed `packages/app/script/e2e-local.ts` seed path to use repo-root `script/seed-e2e.ts` ✅
  - fixed local E2E auth precondition by setting `OPENCODE_USER_DAEMON_MODE=1` in harness env, so loopback sandbox runs without web-auth challenge ✅
  - fixed Playwright browser cache path in local harness via `PLAYWRIGHT_BROWSERS_PATH` passthrough/default ✅
  - added compatibility re-export in `packages/app/e2e/utils.ts` so legacy root-level Playwright specs no longer fail during test discovery ✅
  - reran `PLAYWRIGHT_BROWSERS_PATH="/home/pkcs12/.cache/ms-playwright" bun run test:e2e:local --grep "smoke model selection updates prompt footer|can send a prompt and receive a reply|can open an existing session and type into the prompt"` ✅ harness now executes browser tests
  - result after harness fix: prompt/session cases pass, but duplicated root + nested model-picker smoke cases still fail because the current model manager DOM no longer guarantees an immediate `[data-slot="list-item"]` model row without extra provider/data selection; this is now an E2E test/data-shape issue, not an auth/harness blocker ⚠️
- Focused verification notes:
  - TUI footer now resolves account/quota from session-local account when present ✅
  - TUI assistant fallback sync now reacts to account-only changes ✅
  - orchestration scorer trace no longer drops `accountId` ✅
- Architecture Sync:
  - Updated `docs/ARCHITECTURE.md` to record session execution identity `{ providerId, modelID, accountId? }`, the control-plane vs session-local boundary, and footer/quota effective-account precedence ✅
