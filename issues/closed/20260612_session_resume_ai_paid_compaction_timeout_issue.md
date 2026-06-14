# Bug Report: Session resume 觸發 ai_paid compaction，enrichment 以 E_HYBRID_LLM_TIMEOUT 失敗（compaction 卻回報 success:true）

## 0. Handoff Summary

使用者重啟 daemon（為修復 specbase event_record 工具面缺席）後 resume 本 session，畫面出現「session resume compaction error」。從 daemon debug.log 的 `execution.recentEvents` 看到：resume 過程先跑了一次 `narrative` compaction（success），緊接著在 `2026-06-12T07:40:08` **升級成 `ai_paid` compaction**，該 compaction event 自身標記 `success:true`，但**同一毫秒**配對的 `enrichment` event 卻標記 `status:"failed"` + `detail:"ai_paid_failed:E_HYBRID_LLM_TIMEOUT"`。

這是一個**狀態自相矛盾 + 使用者可見錯誤**的問題：compaction 子系統認為自己成功，enrichment 子系統認為超時失敗，兩者對同一次 ai_paid 升級給出相反結論。session 最終仍進入 `waiting_user` 並可繼續對話（context_budget green、cache_hit 0.92），所以**沒有資料遺失**，但使用者端被彈出一個 compaction error，且 telemetry 留下矛盾紀錄。

狀態：**RESOLVED（2026-06-12）**。Root cause 已證實並修復，詳見文末 §14 Resolution。Plan package：`plans/compaction_ai-paid-event-consistency/`。

## 1. Bug Identity

| Field                         | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| Title                         | Session resume ai_paid compaction enrichment timeout，狀態自相矛盾 |
| Component                     | opencode compaction / enrichment（resume 路徑、double-phase 升級、hybrid LLM 呼叫）|
| Reporter                      | pkcs12（session ses_1491aa8feffeJQOpbvWKaFmfjk，主對話）|
| Date                          | 2026-06-12                                           |
| Severity                      | medium — 使用者可見 error + telemetry 狀態矛盾；但無資料遺失、session 可續 |
| Priority                      | P2 — 偶發、非阻塞，但傷害 resume 信任感與 compaction 可觀測性 |
| Status                        | RESOLVED — root cause 證實 + 修復落地（2026-06-12）  |
| Affected versions/tools/paths | opencode `0.0.0-main-202606102347`；`packages/opencode/src/session/compaction.ts`（推測）；model `claude-opus-4-8` / provider `claude-cli` |

## 2. Environment

- Runtime/issue repo：`/home/pkcs12/projects/opencode`
- 受影響 session 的工作目錄：`/home/pkcs12/projects/documents`
- Session ID：`ses_1491aa8feffeJQOpbvWKaFmfjk`（slug `happy-engine`）
- OS：Linux
- Provider/Model/Account：`claude-cli` / `claude-opus-4-8` / `claude-cli-subscription-claude-cli-d5002de6`
- Context window：1,000,000；reserved 20,000；usable 968,000
- 觸發背景：使用者剛**重啟 daemon**（修復 specbase `event_record` 工具面缺席），重啟後 resume 此長 session（累計 requests 640、cumulativeTokens ~5e7）
- 關鍵 log：`/home/pkcs12/.local/share/opencode/log/debug.log`
- 相關 config（`packages/opencode/src/config/config.ts`）：
  - L1542 註解描述 **double-phase 升級**：「If a local kind succeeds but its summary still exceeds this target, run() escalates to the next paid kind in the chain (double-phase). Default: 50000.」——這正是 narrative → ai_paid 升級的設計來源。

## 3. Expected Behavior

- Resume 一個長 session 時，compaction 若需升級到 `ai_paid`，該升級要嘛成功（summary 產出、enrichment success），要嘛失敗（**乾淨 fallback 回上一個成功的 local kind 的 summary**，不對使用者拋 error）。
- **不變式**：對同一次 compaction 升級，`compaction.success` 與配對 `enrichment.status` 必須一致——不可能 compaction 標 `success:true` 而 enrichment 標 `failed`。
- ai_paid LLM 呼叫超時（E_HYBRID_LLM_TIMEOUT）時應被視為**非致命**：既然 narrative compaction 已成功，resume 應靜默採用 narrative summary，不需讓使用者看到 compaction error。
- 絕不可發生：使用者 resume 後被彈一個看似失敗、但實際 session 狀態正常的 compaction error，造成「以為壞了」的誤判。

## 4. Actual Behavior

從 `debug.log` 的 `execution.recentEvents`（出現在多筆 `bus.session.updated`，最早於 seq 5748 @ `2026-06-12T07:40:56`）觀察到 resume 期間這串事件：

```
ts=1781221177504  kind=compaction  compaction={observed:"cache-aware", kind:"narrative", success:true}
ts=1781221208600  kind=compaction  compaction={observed:"cache-aware", kind:"ai_paid",   success:true}
ts=1781221208601  kind=enrichment  enrichment={status:"failed", detail:"ai_paid_failed:E_HYBRID_LLM_TIMEOUT"}
```

- `1781221208600` ≈ `2026-06-12T07:40:08`：ai_paid compaction event 標 **success:true**。
- `1781221208601`（**下一毫秒**）：對應 enrichment 標 **failed**，detail = `ai_paid_failed:E_HYBRID_LLM_TIMEOUT`。
- 之後 session 仍進入 `state:"waiting_user"`（seq 6914 @ 07:42:55），`supervisor.consecutiveResumeFailures:0`，`context_budget` green、`cacheHitRate` 0.92~0.93，`needsCompaction:false`，`pendingSubagentNotices:[]`。

亦即：**現象 = 使用者可見的 compaction error；底層 = ai_paid 升級的 enrichment 超時，但 compaction event 與 enrichment event 對同一升級給出相反成敗值。** 該矛盾在後續每筆 `bus.session.updated` 的 `recentEvents` 中被持續複製（因為 recentEvents 是滾動快照），但實際只發生一次（單一 ts 對）。

（註：narrative compaction 在 07:39:37 已成功；ai_paid 升級在 ~31 秒後才發生並超時。）

## 5. Steps To Reproduce

標記為 **Suggested reproduction**（尚未取得確定最小重現）：

1. 取一個**長 session**（高 message 數、narrative summary 體積接近或超過 `targetTokens` 預設 50000），確保 compaction 會走 double-phase 升級到 ai_paid。
   - 預期觀察：narrative compaction success，但 summary 仍 > target → 觸發 ai_paid。
2. 在該 session 需要 compaction 的時點**重啟 daemon 並 resume**（或以其他方式在 resume 路徑觸發 ai_paid 升級）。
   - 預期觀察：ai_paid 升級啟動，向 hybrid LLM 發出 paid summary 請求。
3. 讓 ai_paid 的 LLM 呼叫超時（網路慢 / provider 慢 / timeout budget 太小）。
   - 實際觀察：`enrichment.status=failed` + `E_HYBRID_LLM_TIMEOUT`，但 `compaction.kind=ai_paid` 仍 `success:true`；使用者端出現 compaction error。
4. 檢查 `debug.log` 的 `execution.recentEvents`，確認出現一對 ts 相鄰、成敗相反的 compaction/enrichment event。

## 6. Evidence

| Evidence | Type | Reference | What it shows |
| -------- | ---- | --------- | ------------- |
| E1 | log | `/home/pkcs12/.local/share/opencode/log/debug.log`（seq 5748 起多筆 `bus.session.updated` 的 `execution.recentEvents`）| ai_paid compaction `success:true` 與 enrichment `failed: ai_paid_failed:E_HYBRID_LLM_TIMEOUT` 同毫秒並存（ts 1781221208600/1781221208601）|
| E2 | log | 同上，ts `1781221177504` | 升級前的 narrative compaction `success:true`（證明 local kind 已成功，ai_paid 是升級而非首發）|
| E3 | log | `debug.log` seq 6914 @ 07:42:55 | session 仍進入 `waiting_user`、`consecutiveResumeFailures:0`、green budget → 無資料遺失、可續對話 |
| E4 | code/config | `packages/opencode/src/config/config.ts:1542` | double-phase 升級設計描述（local kind success 但 summary > target 則升級到 next paid kind），佐證 narrative→ai_paid 路徑 |
| E5 | tool output（redirected）| `/home/pkcs12/.local/share/opencode/storage/session/ses_1491aa8feffeJQOpbvWKaFmfjk/output/output_tool_eb911d30d001GhD94b4Hs4JkEv` | 完整 grep `E_HYBRID_LLM_TIMEOUT` 結果（截斷前段已含關鍵 recentEvents）|
| E6 | tool output（redirected）| `.../output/output_tool_eb911168c001arp51qjbY4Uo3H` | `grep compaction` 全量（1389 命中），含 compaction.ts/config.ts 相關行供定位 |

不確定項：使用者端「compaction error」的**確切 UI 字串/來源**未在本次擷取到（只擷到 telemetry 端的 failed event）；需確認 TUI/web 端如何把 `enrichment.failed` 投影成使用者可見 error。

## 7. Impact / Risk

- **使用者可見影響**：resume 後彈出 compaction error，造成「session 壞了」誤判，可能誘發不必要的再次重啟。
- **資料遺失風險**：低——narrative summary 已成功，session 狀態 green、可續，本次無遺失。
- **可靠性風險**：中——telemetry 自相矛盾（success vs failed）會讓任何依賴 `recentEvents` 判斷 compaction 健康度的監控/自動化做出錯誤決策。
- **可觀測性風險**：中——矛盾紀錄被滾動複製進每筆 session.updated，污染後續分析。
- **Blast radius**：所有會觸發 double-phase ai_paid 升級的長 session，在 ai_paid LLM 慢/超時時都可能命中；resume 路徑尤其。

## 8. Root-Cause Hypotheses

### H1: ai_paid 升級失敗未乾淨 fallback，仍把 compaction event 標 success
Confidence: high

Why plausible:
- E1 顯示 compaction `kind:ai_paid success:true` 與 enrichment `failed` 同時存在。最可能是：compaction 主流程在 narrative 成功後就先記了一筆 success，ai_paid 升級的 enrichment 是**事後非同步**進行，超時時只更新 enrichment event，沒回寫 compaction event 的成敗，導致兩者脫鉤。

How to confirm:
- 讀 compaction.ts 的 run()／double-phase 升級碼，找 compaction-event 與 enrichment-event 的寫入時機，確認是否分兩段、是否共享同一成敗來源。

How to refute:
- 若碼中 ai_paid 失敗時確實會把 compaction event 改標 false，則本假設不成立，需另找寫入競態。

### H2: E_HYBRID_LLM_TIMEOUT 的 timeout budget 在 resume 路徑被低估
Confidence: medium

Why plausible:
- 升級發生在 daemon 重啟後的 resume，當下可能 provider 連線/暖機未就緒，paid LLM 首呼較慢；若 timeout 沿用一般 round 的較短預算，resume 首次 ai_paid 容易超時。

How to confirm:
- 找 E_HYBRID_LLM_TIMEOUT 拋出點，看 timeout 數值來源、是否區分 resume/cold-start。

How to refute:
- 若 timeout 充裕（例如 >60s）且 log 顯示 LLM 端真的無回應，則屬上游 provider 問題而非 budget。

### H3: 使用者可見 error 是 enrichment.failed 被直接投影為 fatal，未判 narrative 已成功
Confidence: medium

Why plausible:
- 既然 session 實際 green/可續，使用者卻看到 error，代表 UI/通知層把 `enrichment.status=failed` 當致命，而沒參考「同次 compaction 的 narrative 已成功」這個事實。

How to confirm:
- 追 enrichment.failed → 使用者可見訊息的投影路徑（TUI/web notice 來源）。

How to refute:
- 若 error 文案其實是 warning 級、且 UI 已標示非阻塞，則此假設弱化。

## 9. Workarounds

- **使用者端**：忽略該 compaction error 即可——session 狀態正常、可直接續打字（本次已驗證 budget green、可續）。
- **避免重複重啟**：看到此 error 不要再次重啟 daemon（重啟反而可能再觸發一次 resume 升級超時）。
- 風險/downside：忽略 error 仰賴「使用者知道它無害」，不可長期當解法——telemetry 矛盾仍在。

## 10. Proposed Fix Direction

（root cause 未確認，僅方向）

1. **狀態一致性**：ai_paid 升級失敗時，把 compaction event 的成敗回寫為 ai_paid 段的真實結果，或明確分欄記錄「local kind 成功 / paid 升級失敗、已 fallback 到 local summary」，消除 success/failed 對同一升級的矛盾。
2. **乾淨 fallback**：double-phase 升級的 paid 段超時時，靜默採用已成功的 narrative summary，不向使用者拋 error；最多記 warning-級 telemetry。
3. **timeout 區分 resume/cold-start**：若 H2 成立，給 resume 首次 ai_paid 較寬的 timeout budget 或 warm-up 後再升級。
4. **UI 投影**：enrichment.failed 在「同次已有成功 local compaction」時，降級為非阻塞提示而非 error。
5. 測試：double-phase 升級 paid 段超時的單元/整合測試，斷言（a）compaction 整體不對使用者報 error（b）telemetry 不出現 success/failed 矛盾對（c）最終採用 narrative summary。

## 11. Acceptance Criteria

- 正向：長 session resume 觸發 ai_paid 升級且 paid LLM 正常時，compaction 與 enrichment 皆 success，無使用者可見 error。
- 負向：ai_paid 段超時（E_HYBRID_LLM_TIMEOUT）時，**不**對使用者拋 compaction error；session 採用 narrative summary 續行。
- 不變式：同一次 compaction 升級不再出現 `compaction.success=true` 與 `enrichment.status=failed` 並存。
- 回歸：double-phase 升級 paid 段失敗的測試覆蓋；resume 路徑 cold-start timeout 的測試覆蓋。
- 診斷：telemetry 明確區分「local 成功 / paid 升級失敗已 fallback」此一合法狀態，不再以矛盾對呈現。

## 12. Open Questions

- 使用者實際看到的 compaction error **確切字串與來源層**（TUI notice？web？）尚未擷取——需確認投影路徑。
- ai_paid 升級的 enrichment 是同步還是非同步於 compaction 主流程？（決定 H1 成立與否）
- E_HYBRID_LLM_TIMEOUT 的 timeout 數值與是否區分 resume/cold-start？
- 本現象是 resume 專屬，還是一般 round 中 ai_paid 升級也會命中？
- `recentEvents` 把矛盾對滾動複製是否會誤導任何既有監控/自動化決策？

## 13. Next Session Checklist

1. 先開 `packages/opencode/src/session/compaction.ts`，定位 double-phase 升級（narrative→ai_paid）的 run() 路徑與 compaction/enrichment event 寫入時機。
2. 搜 `E_HYBRID_LLM_TIMEOUT` 拋出點：`rg "E_HYBRID_LLM_TIMEOUT" packages/opencode/src`，確認 timeout budget 來源與是否區分 resume。
3. recall evidence：讀 redirected output `output_tool_eb911d30d001GhD94b4Hs4JkEv`（E_HYBRID_LLM_TIMEOUT 全量）與 `output_tool_eb911168c001arp51qjbY4Uo3H`（compaction grep 全量）。
4. 在 `debug.log` 搜 `ai_paid_failed` 與 `recentEvents` 確認 ts 對 `1781221208600/601` 的完整 context。
5. 追使用者可見 compaction error 的投影路徑（TUI/web notice ← enrichment.failed）。
6. 重現嘗試：構造 narrative summary > 50000（target）的長 session，在 resume 點讓 ai_paid LLM 超時。
7. 預期停點：確認 H1（event 脫鉤）或 H2（timeout 低估）何者為真後，再決定改 compaction.ts 狀態回寫 vs 改 timeout/UI 投影；不在 root cause 確認前動 fallback 邏輯。

## 14. Resolution（2026-06-12）

**Root cause（H1 證實為主因）**：

1. `runLlmCompact`（compaction.ts:4588-4601 修復前）的 `finally` block 無條件 `CompactionManager.requestPublish`，meta 只帶 `{observed, kind:"ai_paid"}`，**不帶 `success`**。
2. `publishCompactedAndResetChain`（compaction.ts:234-244）以 `success: eventMeta?.success !== false` 判定——undefined 預設 **true**，失敗的 ai_paid 因此被記成 `compaction {kind:"ai_paid", success:true}`。
3. `scheduleHybridEnrichment`（compaction.ts:2014-2022）正確發 `enrichment failed: ai_paid_failed:E_HYBRID_LLM_TIMEOUT` → 同毫秒矛盾對。

~~H2（timeout budget）確認為觸發條件而非根因：`llmTimeoutMs` 預設 30s（tweaks.ts:463），無 resume/cold-start 區分；本次不調整。~~ (v1, SUPERSEDED 2026-06-12 — 見下方 v2)

**H2 升級認定（v2, 2026-06-12）**：使用者追問「為什麼會超時」後重新檢視——30s 不是「偶發太緊」，而是**設計不相容**：`llmTimeoutMs=30s` 是 DD-13 之前 LLM_INPUT_TOKEN_CAP=30K 時代的預算；2026-06-12 enrichment 改版（DD-13 full-anchor input）後，輸入下限就是 128K tokens gate floor，prefill + 輸出在 30s 內物理上不可能完成（本次 incident latency ~31s 即撞牆證據）。也就是說 **改版後每一次 background ai_paid enrichment 都必定超時**，不是偶發。debug.log 無歷史 `ai_paid_failed` 樣本（log 已輪替）但因果鏈由常數對比直接成立。
H3（UI 投影）確認：Q card（session-telemetry-cards.tsx）把 enrichment.failed 一律渲染為 ✗，未參考 narrative 已成功。

**Fix（plan: `plans/compaction_ai-paid-event-consistency/`，scope 經使用者確認）**：

- **DD-1**：`runLlmCompact` 捕獲 `runLlmCompactInner` 結果，finally publish 的 meta 帶 `success: result?.ok === true`；throw 路徑視為 false 並照舊上拋。
- **DD-2**：`publishCompactedAndResetChain` 的 `success !== false` 預設**不改**——其他 local-kind caller（narrative 等）只在成功路徑 publish，語意正確。
- **DD-3**：Q card 在「同 ring 最近一筆成功 compaction 為 narrative」時，把 enrichment.failed 降級為 warning 措辭（`upgrade skipped — narrative summary retained`，無 ✗）。
- **DD-4**：enrichment failed telemetry 照常記錄（DD-11 顯式失敗證據），不抑制、不新增 fallback。

**Changed files**：
- `packages/opencode/src/session/compaction.ts`（runLlmCompact finally）
- `packages/app/src/pages/session/session-telemetry-cards.tsx`（isEnrichmentFailureDegraded + 降級渲染）
- `packages/opencode/src/session/compaction-recompress.test.ts`（+2 回歸測試）

**Verification**：
- `compaction-recompress.test.ts` 13 pass（含新增「failure → finally publish success:false」與「explicit success honored / local-kind default 保留」）
- compaction 全家 + amnesia-notice：68 pass / 0 fail
- typecheck：修改檔案 0 errors（僅 vendor/specbase 既有 3 個無關 TS 錯誤）
- `decideAmnesiaInjection` 迴歸確認：其掃描規則本就跳過 `success !== true` 的 compaction event（amnesia-notice.ts:72-75），ai_paid 改記 false 後反而**修正**了「失敗 ai_paid 誤遮蔽 narrative 注入」的潛在問題。

## 15. Resolution v2 — 差異化 timeout（2026-06-12，DD-5/DD-6）

§14 的 v1 修復只解決「失敗被誤標成功 + 假 error」；v2 解決「為什麼必然失敗」（使用者確認採差異化 timeout 方案）：

- **DD-5**：新增 `llmTimeoutBackgroundMs`（預設 180_000；tweaks key `compaction_llm_timeout_background_ms`，range 30s–600s）。`runLlmCompactInner` 依 `opts.busMode === "hybrid_llm_background"` 選用 background 預算；foreground（手動 /compact 等，有人在等）維持 30s 快速失敗。
- **DD-6**：不採依輸入量動態縮放——多一個公式要調參、過擬合風險；180s 固定上限已涵蓋 1M-window 模型的合理 prefill 時間。

**Changed files (v2)**：
- `packages/opencode/src/config/tweaks.ts`（CompactionConfig + default + cfg parser）
- `packages/opencode/src/session/compaction.ts`（runLlmCompactInner busMode-differentiated timeout）
- `templates/system/tweaks.cfg`（新 key 文件，template 同步門檻）

**Verification (v2)**：compaction 全家 + amnesia-notice 81 pass / 0 fail；tweaks 測試 37 pass；typecheck 修改檔 0 errors。
