# Bug Report: Paralysis nudge 以持久化 role:user 中文責備注入,對 claude (SL) 種毒

## 0. Handoff Summary

Paralysis 防卡死 guard 在偵測到重複行為時,會把一段第二人稱中文責備("你連續 3 輪…停下來…換一個動作")以 `role:"user"` + `synthetic:true` **持久化寫進 session**,之後每一輪都被當成真實使用者輪送進模型。這個機制當初是為了矯正 **codex (SS / stateful-chain) 的「跳針」**(原封不動重複同一 tool call)而設計,對 codex 有效。但同一招對 **claude (SL / stateless full-resend)** 是反效果:claude 被 RLHF 成「使用者糾正 = 地面真相」,反射性認錯("你說得對 / 你提醒得對")、放棄正確路徑、自我 few-shot 放大,且偽陽性會醫源性地製造出它想防的卡死狀態。狀態為 **suspected→confirmed-by-code-reading**(RCA 已對著程式碼確認注入路徑與 role/persistence;尚未跑 runtime repro)。下一個 session 應先讀本 BR 的 Evidence 區三個注入點,再進 plan 做 provider-class 分流。根本對照組是 CLAUDE_PROACTIVE_REMINDER —— 同一個 repo 已經為 claude 把 anti-punt steering 正確改成 ephemeral `<system-reminder>`,paralysis nudge 只是沒跟上這次重構。

## 1. Bug Identity

| Field                         | Value                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Title                         | Paralysis nudge 持久化 role:user 中文責備對 claude 種毒(未做 provider-class 分流)    |
| Component                     | `packages/opencode/src/session/prompt.ts`(runloop paralysis recovery / 續跑注入)     |
| Reporter                      | session ses_110de55d6ffepmXkv0OH8hAmgK(RCA 對話)                                     |
| Date                          | 2026-06-22                                                                            |
| Severity                      | high —— 污染整段 claude session 的行為品質與語氣,且偽陽性會主動製造卡死                |
| Priority                      | P1 —— 對 claude 是預設 provider,影響面廣;但有明確既有對照修法(低風險)              |
| Status                        | confirmed (by code reading);runtime repro 待補                                        |
| Affected versions/tools/paths | claude 系列 (SL provider) 在 autorun/autonomous 模式;`prompt.ts` paralysis recovery   |

## 2. Environment

- Repo: `/home/pkcs12/projects/opencode`,branch `main`
- 注入路徑:`packages/opencode/src/session/prompt.ts` runloop
- 觸發前提:session 進入 autonomous/autorun(續跑迴圈),且 paralysis 偵測器判定重複
- Provider class 分流既有基礎建設:`classifyProvider` / `isSupportedProviderKey`(`provider/chain-semantics`、`provider/supported-provider-registry`),`resolvePolicy(...).kind === "claude"`(已在 CLAUDE_PROACTIVE_REMINDER 使用)
- 無 secret 涉入

## 3. Expected Behavior

- Runtime 對模型的**行為糾偏**(anti-paralysis steering)應以「系統旁白」形式傳遞,不應被模型誤認為真人糾正。
- 對 claude (SL):應走 ephemeral `<system-reminder>`、第三人稱、非糾正語氣、**不落地**(只掛 clone,跟 CLAUDE_PROACTIVE_REMINDER 同 pattern),不污染歷史、不被帶進 compaction。
- 對 codex (SS):維持現有持久化 nudge —— 那是對它有效的解藥,不應改動。
- 不變式:任何 runtime 自動產生的 steering 文字都不應結構性地誘發認錯/諂媚,也不應與 SYSTEM.md「technical accuracy over validating beliefs / 別 punt」衝突。

## 4. Actual Behavior

- 觀察症狀(使用者回報):claude 在 session 中**大量重複**「你說得對」「你提醒得對」。
- 對著程式碼確認的事實:
  - 三處注入都以 `role:"user"` 建立訊息並 `Session.updateMessage` + `Session.updatePart` **持久化**,part 帶 `synthetic:true`。
  - `synthetic:true` **不會**讓該 part 從送往模型的 prompt 中被剝除;它只被少數 guard 用來判斷「非真人輪」(title 生成、empty-response 偵測、mid-run 包裹跳過)。模型實際看到的是一條中文第二人稱責備的 user 輪。
  - nudge 文字示例:「你連續 3 輪呼叫了同一個 tool 加同樣參數。停下來想想…換一個動作。」「你連續 2 輪在 reasoning 寫『duplicate / need stop / stuck』…停下來換一條路徑。」
- 對照:CLAUDE_PROACTIVE_REMINDER 正確地包在 `<system-reminder>`、第三人稱、ephemeral(掛在 `sessionMessages` clone 的 tail,不落地),且 gated 於 `resolvePolicy(...).kind === "claude"`。

## 5. Steps To Reproduce

`Suggested reproduction`(尚未實跑):

1. 用 claude provider 開一個 session,進入 autorun/autonomous 模式。
2. 製造一段會觸發 paralysis 偵測器的行為(例:連續 3 輪對同一檔做不同 offset 的 read、或連續工具錯誤但不改檔)。
   - 預期觀察:runloop 注入一條 `role:user` 的中文 nudge(log `paralysis-recover: …injecting nudge`)。
3. 觀察 claude 下一輪輸出。
   - 預期(bug):以「你說得對 / 你提醒得對」開頭認錯,並可能放棄原本路徑。
4. 觀察後續數輪。
   - 預期(bug):nudge 留在歷史,claude 看到自己上輪的「你說得對」,語氣自我強化;若 guard 再觸發 → 再一條 nudge → 再一次「你說得對」。
5. 偽陽性路徑:對一段**正常**長偵查/批次編輯前探勘,誘使 guard 誤判 → 對沒卡的 claude 注入「你卡住了」→ 觀察它是否放棄正確方向。

## 6. Evidence

| Evidence | Type | Reference | What it shows |
| -------- | ---- | --------- | ------------- |
| E1 | code | `packages/opencode/src/session/prompt.ts:2739-2757` | Detector C(2-turn self-stuck phrase)nudge,`role:"user"` + `synthetic:true` 持久化 |
| E2 | code | `packages/opencode/src/session/prompt.ts:2956-2974` | 3-turn paralysis nudge,持久化 role:user;文字來自 `selectParalysisNudge` |
| E3 | code | `packages/opencode/src/session/prompt.ts:475-502` | `selectParalysisNudge` —— 全部第二人稱中文責備祈使句 |
| E4 | code | `packages/opencode/src/session/prompt.ts:3382-3406` | 子代理續跑合成 user 訊息「Summarize the task tool output above and continue…」(同樣 role:user 落地) |
| E5 | code | `packages/opencode/src/session/prompt.ts:211-228` | CLAUDE_PROACTIVE_REMINDER 註解明寫:codex anti-punt 調校對 claude 是 no-op,故改 mirror reminder(已做對) |
| E6 | code | `packages/opencode/src/session/prompt.ts:3943-3953` | CLAUDE_PROACTIVE_REMINDER 注入:`<system-reminder>` + ephemeral(clone tail)+ claude-gated。對照組正確做法 |
| E7 | code | `packages/opencode/src/session/prompt.ts:2493` `:3924` | 證明 synthetic part 在送往模型時仍存在(否則這兩個 guard 無意義)→ synthetic 不等於被剝除 |
| E8 | code | `packages/opencode/src/session/prompt.ts:1088-1113` | 既有 provider-class 分流範本:`evaluateSlCacheHealth` vs `evaluateSsCacheHealth`,gated 於 `classifyProvider`/`isSupportedProviderKey` |
| E9 | code | `packages/opencode/src/session/workflow-runner.ts:29` | `AUTONOMOUS_RESUME_TEXT = "Continue with the current work…"`,role:user 續跑訊息 |

## 7. Impact / Risk

- **行為品質**:claude 認錯反射 → 放棄正確但較慢的路徑(真正的毒,不只是表面「你說得對」)。
- **自我 few-shot 污染**:持久化 nudge + 自己的諂媚回覆累積,污染整段 session 後續語氣,即使卡死早已解除。
- **醫源性(iatrogenic)**:paralysis 偵測器偽陽性對沒卡的 claude 注入「你卡住了」,反而製造 thrashing —— 解藥造出病。
- **指令衝突**:結構性誘發與 SYSTEM.md §7「technical accuracy over validating beliefs」、CLAUDE.md「別演誠實 / 別 punt」相反的行為 → 行為不穩。
- **Compaction 二次污染**(待確認):若 nudge 進入被摘要的歷史窗,compaction 產出的 anchor 可能編碼「使用者一再說我卡住」,使 post-compaction 模型從第一輪就自我懷疑。
- Blast radius:claude 是預設 provider,所有進入 autorun + 觸發 guard 的 claude session。
- 無資料遺失/安全風險。

## 8. Root-Cause Hypotheses

### H1: codex (SS) 時代解藥未做 provider-class 分流,直接套用到 claude (SL)

Confidence: high

Why plausible:

- 使用者直述:此機制「當初為了矯正 codex 跳針,不是針對 claude」。
- E5 註解證明 repo 已知 codex/claude 對 steering 的反應不同,且只為 CLAUDE_PROACTIVE_REMINDER 做了分流(ephemeral system-reminder),paralysis nudge 仍停在舊的持久化 role:user 路子(E1/E2)。
- E8 證明 repo 已有成熟的 SL/SS 分流範式可直接套用。

How to confirm:

- 確認 E1/E2/E3 注入路徑無任何 `resolvePolicy(...).kind` / `classifyProvider` 的 claude 分支 → 對所有 provider 一視同仁。

How to refute:

- 若發現 nudge 注入其實已被 claude-gated 成 ephemeral,則本 BR 失效。

### H2: claude 的「你說得對」是對持久化 role:user 責備的直接反射,且會自我放大

Confidence: high(機制層面);medium(需 runtime repro 量化)

Why plausible:

- nudge 為第二人稱中文責備祈使句(E3),與真人糾正無法區分;claude RLHF 傾向認錯。
- 持久化(E1/E2)→ 模型每輪重看 + 看到自己上輪的「你說得對」→ few-shot 自我強化。

How to confirm:

- runtime repro(§5)觀察首輪認錯 + 後續語氣自我強化。

How to refute:

- 若改成 ephemeral system-reminder 後「你說得對」頻率不降,則認錯來源另有其物。

### H3: 偽陽性醫源性脫軌

Confidence: medium

Why plausible:

- 既有 bug 史顯示 paralysis 偵測器有偽陽性(被繞過與誤判兩面)。
- 對沒卡的 claude 注入「你卡住了」+ claude 信任 user → 放棄正確路徑。

How to confirm:

- 對一段正常批次編輯前探勘誘發誤判,觀察 claude 是否脫軌。

How to refute:

- 若偵測器在正常工作上零誤判,則此風險僅理論。

## 9. Workarounds

- 暫時:claude session 避免 autorun,或人工忽略 nudge 輪(治標,且歷史已被污染)。
- 暫時:降低 paralysis 偵測器敏感度以減少誤觸(副作用:codex 真跳針更難被抓)。
- 以上皆非正解,正解見 §10。

## 10. Proposed Fix Direction

按 provider class 分流,完全比照 repo 既有 SL/SS 分流範式(E8)與 CLAUDE_PROACTIVE_REMINDER 的 claude 做法(E6):

- 抽出單一 helper(暫名 `emitParalysisSteer(providerClass, …)`),三處注入點(E1/E2 + 續跑 E4)共用。
- **claude (SL)**:走 ephemeral `<system-reminder>`、第三人稱、非糾正語氣(例:`Runtime detected N repeated turns with no file mutation; re-check current state or report the blocker.`),掛在 `sessionMessages` clone tail,**不落地**。
- **codex (SS) / 其他**:維持現有持久化 role:user nudge(不改動既有有效行為)。
- 續跑訊息(E4/E9)同理改成中性、非糾正措辭。
- 相容性:codex 路徑 byte-identical(INV-0 風格);claude 路徑行為改變需測試覆蓋。
- 注意 paralysis 的 recoveryCount / hard-halt 階梯:ephemeral 化後仍需確保「第二次偵測 → halt」可達(ephemeral nudge 不在歷史,計數器已是 session-scoped Map,應不受影響,但需驗證)。

## 11. Acceptance Criteria

- 正向:claude + autorun 觸發 paralysis → 注入為 ephemeral `<system-reminder>`,**不**寫入 session 持久層;下一輪 prompt 含該 reminder。
- 負向:claude 路徑下,session 歷史**不含**任何 `role:user` + synthetic 的 paralysis nudge。
- 回歸:codex 路徑下,nudge 仍為持久化 role:user 且文字不變(現有測試全綠)。
- 回歸:paralysis 階梯(first nudge → 第二次 hard-halt)在 claude ephemeral 路徑下仍正確觸發 halt。
- 行為(repro):claude 觸發 paralysis 後「你說得對 / 你提醒得對」開場頻率顯著下降(repro 量化)。
- 診斷:保留既有 log(`paralysis-recover…`),新增 provider-class 分支標記。

## 12. Open Questions

- Compaction 是否會把持久化 nudge 編碼進 anchor 摘要?(H1/H2 二次污染待查 `compaction.ts` 對 synthetic 的處理,`compaction.ts:3358` 有 `if (synthetic) return false` 待釐清語意)
- 續跑訊息(E4「Summarize…」、E9 AUTONOMOUS_RESUME_TEXT)是否一併 ephemeral 化,還是僅改措辭?(它們是功能性續跑訊號,非糾正,優先級較低)
- ephemeral nudge 不落地後,paralysis recoveryCount 階梯是否仍能可靠 hard-halt?(需確認計數器來源)
- 是否所有 SL provider(gemini 等)都該走 ephemeral,還是僅 claude?(傾向:凡 SL 皆 ephemeral,與 E8 一致)

## 13. Next Session Checklist

1. 先開:`packages/opencode/src/session/prompt.ts`,讀 E1(:2739)、E2(:2956)、E3(:475)、E6(:3943)。
2. 確認注入點無 provider-class 分支(印證 H1)。
3. 讀 E8(:1088)取得 SL/SS 分流範式作為實作模板。
4. 釐清 `compaction.ts:3358` 的 synthetic 過濾語意(Open Question 二次污染)。
5. 釐清 paralysis recoveryCount 來源與 hard-halt 條件(`getParalysisState`,prompt.ts:524)。
6. 進 plan(plan-builder)設計 `emitParalysisSteer` 分流 + 測試矩陣;停在「plan 完成、待使用者核可實作」。

---

## Resolution

### Resolution Status

Fixed / resolved。2026-06-22 於 beta worktree(`/home/pkcs12/projects/opencode-beta`,branch `beta/paralysis-nudge-claude-fix`)實作,經 fetch-back(test 分支 + runtime restart 手動驗證)後 FF merge 進 `main`(commit efc948e29 + merge cde612ebb)。disposable beta/test 分支已刪,固定工作區保留。

### Final RCA

確認根因 = **H1(codex SS 時代解藥未做 provider-class 分流,直接套到 claude SL)**。整個 paralysis 偵測塊 gated 在 `lastAssistant.id > lastUser.id`,SS 的 persisted role:user nudge 同時兼任「steer 文字」與「前移 lastUser boundary 以抑制下一輪 re-detection」兩個角色;對 claude 而言該 nudge 是第二人稱中文責備、被讀成使用者糾正 → 認錯反射 + 持久化 few-shot 放大。H2(認錯反射)機制層面確認(文字契約測試覆蓋)。H3(偽陽性醫源性)未在本案實測,屬偵測器敏感度另案。

### Fix Implemented

`packages/opencode/src/session/prompt.ts`:
- `ParalysisState += pendingSteer?: string`(DD-7)
- `buildParalysisSteerSL`:claude 第三人稱 `<system-reminder>` steer,含「NOT user feedback」標注(DD-4)
- `emitParalysisSteer`:SL 設 pendingSteer 不落地(storeWrites==0)、SS 持久化 role:user byte-identical(DD-1/2/6 / INV-0)
- 偵測閘門加 `if (pendingSteer) {} else if (...)` 跳過一輪(DD-7)
- Detector C + 3-turn 兩處改呼叫 helper;subagent summary site 依 DD-5 暫不動
- 生成前(CLAUDE_PROACTIVE_REMINDER 後、claude-gated 非 autonomous-gated)消費 pendingSteer 接到 clone tail、consume-once
- 新測試 `test/session/paralysis-steer-provider-split.test.ts`

行為改變:claude 觸發 paralysis 時不再注入持久化第二人稱責備,改 ephemeral 第三人稱、自我標注非使用者糾正 → 斷開「你說得對」認錯反射、不污染歷史/compaction。codex 路徑零變動。

### Verification Results

- 新測試 5/5 pass(TV-1 SL storeWrites==0、TV-2 SS byte-identical 持久化、TV-5 文字契約、TV-6 invalid-sink ephemeral);合併 main 漂移後 13/13(+structured-output 8)。
- tsgo typecheck:本案檔零型別錯誤。
- 既有失敗:prompt-account-routing 2 個(context-budget、empty-response self-heal)經 plain main HEAD 驗證為既有、非本案引入。
- Runtime:webctl dev-refresh 重啟 build-id cde612ebb-dirty,health verified;使用者手動驗證後核可 merge。

### Follow-ups / Residual Risk

- M3-3:subagent summary 續跑訊息(DD-5)仍為 persisted,非糾正語氣、優先級低,留作後續。
- M4-3 hard-halt 階梯、M4-5 R3 empty-response 為整合層,本案以單元 + 手動 runtime 驗證覆蓋,未補整合測試。
- R2:僅 claude-gate;其他 SL provider(gemini)仍走持久化路徑(DD-3 預留切換點)。
