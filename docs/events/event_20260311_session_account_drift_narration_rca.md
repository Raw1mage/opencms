## Requirements

- 掃描 session 運作中仍會讓不同 session/account 默默收斂成同一帳號的 legacy 路徑。
- 釐清 subagent / task delegation / synthetic narration 是否會污染主 session 的 account selection。
- 新 policy：在單一 session 下，**subagent/subtask 若使用同一 providerId，必須強制使用同一 account**；僅在不同 providerId 時才允許使用自己的 account。

## Scope

### In

- session-local selection 與 global active account 邊界
- subagent/task narration assistant message
- TUI prompt 以 latest assistant sync local model 的路徑

### Out

- 全量 rotation3d 重寫
- release / push

## Task List

- [x] 建立 baseline 與 evidence
- [x] 比對最新 session persisted user/assistant identity
- [x] 掃描 narration / subagent handoff 路徑
- [x] 確認 account drift root cause
- [x] 實作最小修補
- [x] 補驗證與 architecture sync

## Baseline

- 使用者回報：在不同 session 使用不同 account 運作時，系統仍會在不注意時默默同步成同一帳號。
- 使用者特別懷疑 main agent 呼叫 subagent、以及 subagent subsession 的模型切換，可能在主/子 session 切換邊界造成混亂。
- 觀測到當前主 session `ses_328369bceffe0yylXxCNPIsVVS` 曾經從 `miatlab` 漂移回 `yeatsluo`。

## Instrumentation / Evidence

- `docs/ARCHITECTURE.md`
  - session execution identity contract 規定 runtime 應優先使用 session-carried `{ providerId, modelID, accountId? }`
  - global active account 只能作為 legacy/default fallback
- `/home/pkcs12/.local/share/opencode/storage/session/ses_328369bceffe0yylXxCNPIsVVS/messages/msg_cdc321e0e001N4XKeuchHKkl2v/info.json`
  - 最新 user message 已被持久化為 `openai / gpt-5.4 / openai-subscription-yeatsluo-g-ncu-edu-tw`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_328369bceffe0yylXxCNPIsVVS/messages/msg_cdc32630a001duyoheB79D7H7D/info.json`
  - 正常 assistant message 帶有 `accountId = openai-subscription-yeatsluo-g-ncu-edu-tw`
- `/home/pkcs12/.local/share/opencode/storage/session/ses_328369bceffe0yylXxCNPIsVVS/messages/msg_cdc32ac700010hSATEUkHzLCHb/info.json`
  - 後續 assistant message 僅有 `providerId/modelID`，**沒有 `accountId`**，且 `tokens=0`, `finish=stop`，高度符合 narration/synthetic assistant
- `packages/opencode/src/session/narration.ts`
  - `emitSessionNarration()` 原本建立 synthetic assistant message 時只寫入 `providerId/modelID`，未保留 `accountId`
- `packages/opencode/src/session/processor.ts`
  - `value.toolName === "task"` 的 start/complete/error narration 都呼叫 `emitSessionNarration(...)`
  - 原本傳入的 model payload 只有 `providerId/modelID`，沒有 `accountId`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `lastAssistantMessage` sync path 會把最新 assistant 的 `{ providerId, modelID, accountId }` 回寫到 `local.model.set(..., sessionID)`
  - 若最新 assistant 缺少 `accountId`，舊邏輯會把 session account 清成 `undefined`
- `packages/opencode/src/session/processor.ts` / `packages/opencode/src/session/llm.ts` / `packages/opencode/src/session/model-orchestration.ts`
  - 一旦 session account 被清掉，後續 execution path 仍可能 fallback 到 `Account.getActive(family)`
- `packages/opencode/src/session/image-router.ts`
  - image capability rotation 原本沒有 session account 通道，只能用 family active account 建 current vector
- `packages/opencode/src/agent/score.ts` + `packages/opencode/src/session/model-orchestration.ts`
  - scored/explicit models 若未顯式帶 account，原本仍可能被 active-account fallback 補值並導向別的帳號
- `packages/app/src/components/dialog-select-model.tsx`
  - quick ModelList 原本 `local.model.set({ providerID, modelID })` 未保留 session account
- `packages/app/src/components/dialog-select-model-unpaid.tsx`
  - unpaid/free model list 原本同樣未保留 session account
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`
  - TUI generic model dialog 原本選模時只寫 `{ providerId, modelID }`
- `packages/opencode/src/cli/cmd/tui/app.tsx`
  - `--model` 啟動參數原本會把 model 寫進 local state，但未顯式 pin `accountId`
- `packages/opencode/src/session/prompt.ts`
  - pending subtask routed-via-TaskTool 的 parent assistant message 原本未寫入 `accountId`
- `packages/opencode/src/session/compaction.ts`
  - compaction assistant summary message 原本未寫入 `accountId`
- `packages/opencode/src/session/command-prompt-prep.ts` / `packages/opencode/src/tool/task.ts`
  - subtask/task tool 先前只有 `model: provider/model` 字串，沒有 account 通道，subagent 可能默默退回 active account

## Root Cause

1. **subagent/task delegation 會產生 synthetic narration assistant message**
   - 這些訊息不是實際 LLM completion identity，但仍會出現在 session timeline 中。
2. **narration assistant message 原本沒有保留 `accountId`**
   - `emitSessionNarration()` 建立 assistant message 時遺漏 `accountId`
   - `processor.ts` 的 task start/complete/error narration 呼叫也沒有把 `input.assistantMessage.accountId` 傳進去
3. **TUI prompt 把 latest assistant message 當作 session selection 的同步來源**
   - 當 latest assistant 是 narration 且沒有 `accountId` 時，`local.model.set(...)` 會把現有 session account 清掉
4. **下一輪送出 prompt 時，就回退到 global active account**
   - submit/runtime 拿不到 explicit session account 後，legacy fallback (`Account.getActive(family)`) 重新介入
   - 最終表現為 session 默默漂移回目前 family active account（例如 `yeatsluo`）
5. **同類問題不只 narration，還有多個入口型寫入點會清掉 session account**
   - Web quick model list / unpaid model list
   - TUI generic model dialog / CLI `--model`
   - pending subtask parent assistant / compaction assistant
   - subtask task-tool 參數鏈原本沒有 `account_id`
6. **最後一層風險是 runtime 仍存在 silent global fallback**
   - `processor.ts` pre-flight 與 `llm.ts` stream startup 先前只要拿不到顯式 `accountId`，就直接回退 `Account.getActive(family)`
   - 若前面任何 UI/synthetic path 曾短暫丟失 account，runtime 會把這個 drift 擴大成真正執行身份漂移

## Execution / Decisions

- 將 `emitSessionNarration()` 的 model payload 型別擴成 `{ providerId, modelID, accountId? }`，並把 `accountId` 寫回 synthetic assistant message。
- 修正 `processor.ts` 的 task narration（三條路徑：start / complete / error），改傳 `input.assistantMessage.accountId`。
- 在 `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 增加保護：
  - 若 latest assistant 是 narration/synthetic assistant，直接跳過 local model sync。
  - 若 latest assistant 沒有 `accountId`，且 current session selection 已有同一 provider/model 的 account，則不允許用 `undefined` 清掉既有 account。
- 修正 Web quick model list / unpaid model list：
  - 改為優先保留當前 session 同 family 的 account；若沒有則在選模當下顯式釘住該 family active account。
- 修正 TUI generic model dialog / CLI `--model`：
  - 選模時優先保留同 family 的 session account；若沒有則顯式抓取 active account 並寫回 session-local selection。
- 修正 pending subtask routed-via-TaskTool parent assistant：
  - parent assistant message 現在會保留 `task.model?.accountId ?? lastUser.model.accountId`
- 修正 compaction assistant：
  - summary assistant message 與 processor create input 現在都保留 `accountId`
- 擴充 TaskTool account 通道：
  - schema 新增 `account_id`
  - `prompt.ts` 呼叫 TaskTool 時會把 `taskAccountId` 一起傳遞
  - `command-prompt-prep.ts` 建立 subtask part 時會保留 `taskModel.accountId`
  - `tool/task.ts` 在 model arbitration / child user message seed / fallback parent model 上都會保留 accountId
- 第三輪 runtime hardening：
  - `processor.ts` pre-flight 與 error fallback 現在優先解析：
    1. `streamInput.accountId`
    2. `input.accountId`
    3. `input.assistantMessage.accountId`
    4. `streamInput.user.model.accountId`
    5. 最後才是 `Account.getActive(family)`
  - `llm.ts` stream startup 現在優先使用 `input.accountId ?? input.user.model.accountId`
  - 只有 session/persisted account 全缺失時，才會回退到 `Account.getActive(family)`，且會打出 debug checkpoint 便於後續抓殘留 legacy 路徑
- 第四輪 strict session-aware hardening：
  - `model-orchestration.ts`
    - 規則收斂為 **同 providerId account pinning**：explicit/agent/scored model 只要與 `fallbackModel.providerId` 相同，就強制覆寫成 `fallbackModel.accountId`
    - 不再把 missing account 一律補成 `public` / active-account；若無法確定 account，`isOperationalModel` 直接視為不可驗證，不以此靜默切帳號
    - 不同 providerId 不會繼承 fallback account，避免跨 provider 誤套 account
  - `image-router.ts`
    - 新增 `accountId` 參數，image capability rotation 改用 session account 建 current vector
    - 若沒有明確 session account，不再為了找 image-capable model 而偷偷退回 family active account
  - `prompt.ts`
    - 呼叫 `resolveImageRequest()` 時明確傳入 `lastUser.model.accountId`
  - `prompt.ts` / `command-prompt-prep.ts`
    - pending subtask / command subtask 若與 parent/user 使用相同 `providerId`，一律強制使用 parent/user 的 accountId
    - 僅在不同 providerId 時才保留子任務自己的 accountId

## Validation

- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/narration.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/narration-emit.test.ts` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/narration.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx /home/pkcs12/projects/opencode/packages/opencode/src/session/narration.test.ts` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model-unpaid.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/app.tsx` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/compaction.ts /home/pkcs12/projects/opencode/packages/opencode/src/tool/task.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/command-prompt-prep.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (third-round runtime hardening)
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/narration.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/narration-emit.test.ts` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/image-router.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (fourth-round strict model hardening)
- `bun test /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅ (providerId-level account pinning policy)
- `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/command-prompt-prep.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
- `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (providerId-level policy hardening)
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪修的是 narration message metadata 與 TUI session sync guard，未改變既有 session execution identity / control-plane boundary，只是修補既有 contract 的漏實作。

## Follow-up: 18:58 OpenAI multi-account 429 investigation

- Live debug log located at: `/home/pkcs12/.local/share/opencode/log/debug.log`
- Around `2026-03-11T18:58` we confirmed mixed evidence:
  - `openai-subscription-ivon0829-gmail-com` received a real upstream `429 usage_limit_reached`
  - `openai-subscription-miatlab-api-gmail-com` also received a real upstream `429 usage_limit_reached`
  - therefore this incident is **not** purely a local mislabeling of rate-limit state
- However, we also confirmed a local amplifier:
  - `SameProviderRotationGuard` was previously keyed only by `providerId`
  - after `openai:ivon0829 -> openai:miatlab` same-provider rotation, it armed a global `openai` cooldown for 5 minutes
  - that guard could block further same-provider account rotations for the main agent and make the incident feel like "all OpenAI accounts are dead"
- Hardening applied:
  - `packages/opencode/src/account/rotation/same-provider-rotation-guard.ts`
    - guard key changed from `providerId` to `providerId:fromAccountId`
  - `packages/opencode/src/account/rotation3d.ts`
    - same-provider rotation guard lookup now uses current `(providerId, accountId)`
  - result: a subagent/main-agent rotation on account A no longer blocks same-provider fallback attempts starting from account B
- Additional hardening after live reproduction (`yeatsluo@g.ncu.edu.tw` selected, then silently rotated to `yeatsluo@gmail.com` on 429):
  - policy decision: for **rate-limit fallback**, do **not** rotate inside the same provider anymore
  - implementation:
    - `packages/opencode/src/account/rotation3d.ts`
      - added `allowSameProviderFallback` config flag
      - when disabled, both `same-model-diff-account` and `diff-model-same-account` candidates are filtered out before selection
    - `packages/opencode/src/session/llm.ts`
      - `handleRateLimitFallback()` now calls `findFallback(..., { allowSameProviderFallback: false })`
  - result: when a pinned provider/account hits rate limit, the system must go **directly to cross-provider fallback** or stop; it can no longer silently swap to another account under the same provider
- Validation:
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/model-orchestration.test.ts` ✅
  - `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts` ✅
  - `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d-guard.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation/same-provider-rotation-guard.test.ts` ✅
  - `bunx eslint /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts /home/pkcs12/projects/opencode/packages/opencode/src/account/rotation3d-guard.test.ts` ✅
  - `bunx tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit` ✅ (cross-provider-only rate-limit fallback)
