# Bug: attachment reader 的 `getLanguage(model)` 漏帶 accountId → 命中 `_active_` 共用快取,可能借用他人帳號的 SDK closure

- **Date**: 2026-05-30
- **Severity**: Medium(限 attachment reader 路徑;多帳號主機上會讓 reader subagent 的 language model 借到非 pinned 帳號的 OAuth token,與同檔 header 注入意圖自相矛盾)
- **Component**: `packages/opencode/src/tool/attachment.ts`(call site)· `packages/opencode/src/provider/provider.ts`(`getLanguage` model cache key 設計)
- **Status**: CLOSED (2026-06-11, soak passed since 2026-06-05, no recurrence) — was OBSERVING — fix deployed/restarted 2026-06-05; attachment reader passes session-pinned `accountId` into `Provider.getLanguage`, with focused regression coverage.
- **Observing since**: 2026-06-05
- **Exit → closed/**: no recurrence after soak / attachment reader continues using pinned account identity.
- **Regress → open**: attachment reader again builds language model through `_active_` cache instead of session-pinned account id.

---

## 1. Baseline(症狀 / 影響範圍)

`attachment` 工具的 reader subagent runner(`defaultReaderRunner`)在建立 language model 時呼叫 `Provider.getLanguage(model)`,**未傳 accountId**——即使該 scope 已經從 session execution 解出正確的 `accountId`(並用它注入 HTTP header)。

後果:language model 實例命中 model cache 的 `_active_` 共用條目,可能拿到**用「當下 process active 帳號」建構的 SDK closure**,而非 session pin 的帳號。HTTP header 標了正確 accountId,但 language model 物件本身(及 closure 捕獲的 OAuth token / credentials)可能來自別的帳號。

## 2. Root Cause(causal chain,逐層程式碼證據)

### 2.1 model cache key 對 accountId 是「可選」的

`getLanguage(model, accountId?)`(`provider.ts:2579`)的 cache key:

```
provider.ts:2582
const cacheKey = `${family}/${accountId ?? "_active_"}/${model.id}`
```

- 帶 accountId → per-account key,正確隔離。
- 省略 accountId → 落在字面常數 `_active_`。**`_active_` 不編碼「現在 active 是誰」**,只是「沒指定」的佔位字串。寫入於 `provider.ts:2619` `s.models.set(cacheKey, language)`。

對照 SDK cache(`s.sdk`,`provider.ts:2245-2246`)的 key **必含 accountId**:`JSON.stringify({ family, accountId, npm, options, hasCustomFetch })`。所以 SDK 層無 stale;**只有 model cache 在省略 accountId 時共用 `_active_`**。

### 2.2 attachment reader 有 accountId 卻沒傳進 getLanguage

`tool/attachment.ts`:

- `loadSessionExecution`(`:179-180`)從 session.execution 解出 `exec.accountId` 並回傳。
- `defaultReaderRunner`(`:222`)解構出 `accountId`。
- `buildReaderHeaders`(`:196`)**用** accountId 注入 `x-opencode-account-id` header。同檔註解(`:183-187`)明寫此 binding 的必要性:
  > "Without this the codex / opencode providers fall back to whichever account is 'default' in the process — which on a multi-account host is usually NOT the one the user has pinned, and rate-limit failures from a stranger account leak in."
- **但 `:236` 的 `Provider.getLanguage(model)` 沒帶 accountId** → accountId 只進 header,沒進 cache key。

### 2.3 與 getLanguage 的設計意圖直接衝突

`getLanguage` 自身註解(`provider.ts:2614-2627`)記錄了一個已修的 cascade-429 false-positive:非 active 帳號若拿到 active 帳號 credentials,會讓 rotated 請求全打到 active 帳號 quota。修法就是「per-account credentials,不要共用 family-level(= active 帳號的)options」。attachment reader 省略 accountId 等於重新打開這個被堵過的洞(限於 model-cache 維度)。

## 3. 為何 blast radius 是 Medium 而非 High

caller 盤點(`getLanguage` 全 repo 6 個 live caller):

| Caller | 帳號敏感? | 帶 accountId? | 風險 |
|---|---|---|---|
| `session/llm.ts:716` | ✅ 推論熱路徑 | ✅ `currentAccountId ?? undefined` | 無(已收斂) |
| **`tool/attachment.ts:236`** | ✅ **reader 計費/配額/憑證** | ❌ | **本缺陷** |
| `server/routes/session.ts:2821` | ❌ audio 轉錄挑能用 model | ❌ | 無語意危害 |
| `agent/agent.ts:327` | ❌ 產生 agent title | ❌ | 無 |
| `provider/health.ts:236` | ❌ 健康檢查 | ❌ | 無 |
| `cli/cmd/tui/util/model-probe.ts:23` | ❌ TUI 探測 | ❌ | 無 |

主推論熱路徑(`llm.ts:716`)已正確帶 accountId,所以**日常 rotation 不踩此洞**。唯一帳號敏感卻漏帶的是 attachment reader。其餘 4 個 `_active_` caller 是探測/輔助類,「拿個能用的 model 即可」,不依賴 active 帳號正確性 → 無害。

## 4. 與既有 issue 的關係(歸因修正)

本缺陷源自 `bug_20260530_claude_invalid_grant_borrowed_credential.md` §3「相關次缺陷:setActive 不 invalidate model cache」。經本次 caller 盤點,該 §3 的歸因需修正:

- **原描述**:setActive 切帳號後 model cache stale → 沿用舊帳號 token。並建議「給 setActive 加 cache invalidation / 給 AccountActivated 加 subscriber」。
- **修正後**:帳號敏感的主路徑(`llm.ts`)已一律帶 accountId,根本不經 `_active_`。`setActive` 是否 invalidate `_active_` 對主路徑無影響。真正的洞是**唯一一個帳號敏感卻漏帶 accountId 的 caller(attachment.ts)**。
- **正解方向**:不是給 `setActive` 補 `Provider.reset()` / `AccountActivated` subscriber(那是遷就 `_active_` 的錯誤依賴、且等於新增 fallback 機制,違反 AGENTS.md 天條),而是**讓誤用的 caller 改用正確簽章**(帶 accountId)。
- `Bus.AccountActivated` 仍零 subscriber(define `bus/index.ts:53` + publish `account/index.ts:800`,grep 全 repo 無 consumer)——但這不是缺陷,是「事件預留但無需消費」,修掉 attachment.ts 後 `_active_` 只剩無害探測 caller,不需要 invalidation 機制。

## 5. Suggested Fix(單行,與證據一致)

`packages/opencode/src/tool/attachment.ts:236`:

```diff
- const language = await Provider.getLanguage(model)
+ const language = await Provider.getLanguage(model, accountId)
```

`accountId` 在該 scope 已存在(`:222` 解構)。改後命中 per-account cache key(`${family}/${accountId}/${model.id}`),與同檔 `buildReaderHeaders` 注入的帳號意圖對齊。

- **打擊半徑**:僅 attachment reader 路徑;其他 5 個 caller 簽章不變、行為不變。
- **不新增 fallback**:這是讓既有 caller 用正確既有簽章,非新增任何 fallback / silent fixup。符合「fail-fast、explicit、no silent fallback」天條。

## 6. Acceptance Criteria

- `attachment.ts` 的 reader runner 呼叫 `getLanguage` 時帶上 session pin 的 `accountId`。
- 回歸測試:模擬「process active 帳號 = A,session pin = B」,斷言 attachment reader 取得的 language model 命中 `${family}/B/${model.id}` cache key,而非 `_active_`(= A 建構的實例)。
- 其餘 4 個無害 `_active_` caller(session route / agent / health / model-probe)不需更動;若日後其中之一變成帳號敏感,需單獨評估。
- 不得以「給 setActive 加 invalidation」或「給 AccountActivated 加 subscriber」作為修法(會引入非必要 fallback 機制)。

## 7. Next-Session Checklist

- 施作 §5 單行修改。
- 補 §6 回歸測試(provider.ts model-cache key 維度)。
- 修完後到 `bug_20260530_claude_invalid_grant_borrowed_credential.md` §3 補一段:次缺陷已被本 issue 取代並正確歸因;主缺陷(invalid_grant)已於 commit `f0bedae57` / `066920ba1` 修復(測試 `error-classifier-token-refresh.test.ts` 7/7),該 issue 主體可移 `observing/` 或 `closed/`。
- 驗證後本 issue 移 `observing/`(部署 + reader 路徑即時驗證),soak 通過再 `closed/`。

## 8. 偵查方法論註記(供制度改善)

本 issue 偵查過程中,AI 多次違反 code-thinker「同 turn 收斂」與「先坐實再下結論」節奏:把單一已批准動作拆成多個 read-only 前置 turn、用 `question()` 過度 gating、且有同一 read/bash 被 runtime 重試 5-6 次的雜訊,讓使用者三度感知為「只說不做 / 被催才動」。實際 DB toolcall 紀錄顯示每個 turn 都有完成動作,但節奏與重複呼叫製造了假象。已知關聯 issue:`issues/closed/bug_20260530_question_tool_retracted_treated_as_answered.md`(question idle-watchdog)、`bug_20260530_narrate_then_stall_regression.md`(前端 tool-call 渲染)。後續偵查應:已批准小範圍動作儘量同 turn 收斂;避免重複等價 toolcall。
