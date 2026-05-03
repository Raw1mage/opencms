# Tasks: prompt-cache-and-compaction-hardening

> Execution surface: `/home/pkcs12/projects/opencode-worktrees/prompt-cache-hardening` on branch `beta/prompt-cache-hardening`.
> Spec writes (this file, design.md, etc.): mainRepo at `/home/pkcs12/projects/opencode`.
> Always `source .beta-env/activate.sh` before any `bun test` / `bun run` in beta worktree.

Phase A 與 Phase B 拆分依據 [design.md "Migration / Rollout"](./design.md#migration--rollout)。Phase A 全部完成 + 合 main 之後，再徵詢使用者啟動 Phase B。

## 1. Phase A.1 — Anchor sanitizer (DD-6, R4)

- [x] 1.1 新檔 `packages/opencode/src/session/anchor-sanitizer.ts`：實作 `sanitizeAnchor(text, kind)` 回傳 `<prior_context source="{kind}">` 包裝 + 祈使句改寫。匯出 `SanitizedAnchorBody` 型別與 schema 對齊。
- [x] 1.2 對抗性單元測試 `anchor-sanitizer.test.ts`：覆蓋 imperative leading（10 種 pattern）、false-positive 候選、4 個 kind、byte-determinism、edge cases — 23 tests pass。
- [x] 1.3 接線到 `compaction.ts`：`defaultWriteAnchor` 統一 sanitize 走 narrative/replay-tail/low-cost-server；`tryLlmAgent` 在 streaming 完成後對每個 text part 呼叫 `Session.updatePart` 改寫為 sanitized。`log.info("compaction.anchor.sanitized")` telemetry 已加。
- [x] 1.4 docs/events 待第 6 phase 完成時隨 phase summary 一起寫（per [handoff.md Phase Boundary Ritual](./handoff.md#phase-boundary-ritual-per-plan-builder-164)）。commit: `0859abcc6` on `beta/prompt-cache-hardening`。

## 2. Phase A.2 — Idle compaction clean-tail gate (DD-7, R5)

- [x] 2.1 新增 `idleCompaction` precondition（commit `3ea194ab8`）。注意：opencode 用單一 ToolPart with state machine（pending/running/completed/error），非 Anthropic 風格 tool_use+tool_result；改為偵測 `state.status in {pending, running}`。
- [x] 2.2 抽出 `checkCleanTail(messages, windowSize)` 至新檔 `idle-compaction-gate.ts`；9 unit tests 覆蓋 clean / single dangling / multiple dangling / window size / user message skip / error 視為 clean。
- [x] 2.3 unclean 時 emit `compaction.idle.deferred` 並 return early（已實作）。
- [x] 2.4 (deferred) 整合測試延到 Phase A validation gate 的 manual smoke check（per observability.md）。理由：checkCleanTail 單元覆蓋完整，wire-up 是 7-line 條件 early return；不需要 Storage/Session 重型整合測試。

## 3. Phase A.3 — CapabilityLayer cross-account hard-fail (DD-8, R6)

- [x] 3.1 `CapabilityLayer.get` 加 `requestedAccountId` 參數；entry 加 `accountId` 欄位；fallback 比對。架構偏 `findFallbackEntry` 不變（filtering 留在 caller 層），對齊既有設計。
- [x] 3.2 cross-account 拋 `CrossAccountRebindError`；same-account 維持 WARN + degraded fallback。
- [x] 3.3 `CrossAccountRebindError` class 定義在 `capability-layer.ts`（colocated，與用法緊耦合）。
- [x] 3.4 5 unit tests in `capability-layer.cross-account.test.ts`，含 error payload 檢查（from / to / failures / code）。
- [x] 3.5 `prompt.ts` 既有 try/catch 改為先檢 `instanceof CrossAccountRebindError` 並 re-throw 出 runloop；其他 errors 維持 WARN 不阻擋（透過 caller passing accountId opt-in 行為）。
- [x] 3.6 (deferred) 整合測試延到 Phase A validation gate manual smoke。理由同 §2.4：5 unit tests + prompt.ts 整合是 8-line 變更，不需重型整合。
commit: `4fcc76f8f`.

## 4. Phase A.4 — Skill auto-pin + anchor metadata (DD-9, R7-skill-coherence)

- [x] 4.1 `pinForAnchor(sessionID, name, anchorId, reason)` + `unpinByAnchor(sessionID, anchorId)` + `pinnedByAnchors: Set<string>` 在 entry 上（多 anchor 並存安全）。
- [x] 4.2 `scanReferences(text, knownNames)` 用 word-boundary regex（轉譯 metachar，case-insensitive，無 substring 洩漏）。
- [x] 4.3 `compaction.ts defaultWriteAnchor` 增 `annotateAnchorWithSkillState`：找新 anchor id → scan → pinForAnchor 命中者 → unpinByAnchor 上一個 anchor → log `compaction.anchor.skill_snapshot` telemetry。`tryLlmAgent` 同步加，用 `processor.message.id` 為 explicit id。
- [x] 4.4 prev anchor 偵測：在 write 之前讀 `readMostRecentAnchorId`，write 之後再讀新 id；若不同則 unpin 舊 id。
- [x] 4.5 11 unit tests in `skill-anchor-binder.test.ts`（pin/unpin 生命週期 + scanReferences edge cases）。skillSnapshot 結構符 telemetry 格式（disk persistence on CompactionPart 延到 Phase B，schema 改動較大）。
commit: `caa6ef135`.

## 5. Phase A.5 — Cache miss diagnostic (DD-10, R7-diagnostic)

- [x] 5.1 in-memory rolling Map<sessionID, string[3]> in 新檔 `cache-miss-diagnostic.ts`（不動 schema；session.deleted Bus subscription 清理）。`llm.ts` 在 system 組裝完成 + Gemini 優化 + plugin transform 之後呼叫 `recordSystemBlockHash(sessionID, system.join("\n"))`。
- [x] 5.2 `shouldCacheAwareCompact` 在原條件全部通過後加 `diagnoseCacheMiss()`；non-compact 分流 return false。
- [x] 5.3 emit `compaction.cache_miss_diagnosis` telemetry（hashes 截 first-8-hex 入 log）。
- [x] 5.4 9 unit tests: insufficient evidence / churn (all-different & partial) / growth / threshold edge / session isolation / determinism.
commit: `5360a0716`. Phase A 對 `system.join` 視為單塊（對齊現況）；Phase B 拆 static 後改 hash 純 static 部分，churn 偵測精度會提高。

## 6. Phase A — Validation gate

- [x] 6.1 全部 unit tests 在 beta worktree 跑綠（57/57 pass，108 expect calls；記得 `source .beta-env/activate.sh`）。Integration tests 延到 6.3 手動煙霧測試。
- [x] 6.2 跑 `bun run typecheck` 無新錯誤。touched files 在 main 與 branch 上的錯誤計數均為 0；其餘 share-next.ts / codex-provider / console-function 的 pre-existing 錯誤與本分支無關。
- [ ] 6.3 手動煙霧測試（**deferred 至 dogfood 階段**）：
  - 開一個 session 跑 5 turns，觀察 telemetry log 有 `compaction.cache_miss_diagnosis` 事件
  - 故意 trigger compaction（context overflow 或 manual /compact），grep anchor body 確認以 `<prior_context` 開頭
- [x] 6.4 phase summary: [docs/events/event_20260503_prompt-cache-hardening-phase-a-landed.md](../../docs/events/event_20260503_prompt-cache-hardening-phase-a-landed.md)
- [x] 6.5 rebase 到最新 main（兩次：onto `c27a127e8` 再 onto `09b0faa72`），無衝突。
- [N/A] 6.6 fetch-back via `test/prompt-cache-hardening-phase-a`：由於 rebase 零衝突且 main 在期間動的檔案（`incoming/*`）與 branch 觸碰的 `session/*` 完全不重疊，中介 test branch 提供零額外訊號，跳過直接 §7.1。
- [x] 6.7 STOP — 使用者於 2026-05-03 批准直接 merge 到 main。

## 7. Phase A — Finalize + cleanup

- [x] 7.1 `git merge --no-ff beta/prompt-cache-hardening` 進 main（在 mainRepo），含 5 個 implementation commits + 1 spec package commit。
- [N/A] 7.2 刪除中介 test branch — 未建立。
- [x] 7.3 main 為 authoritative；`beta/prompt-cache-hardening` 分支保留以承接 Phase B。

## 8. Phase B (gated — 不要在 Phase A 落地前開動)

預期內容（細項在 Phase A 收尾後展開）：

- B.1 ContextPrefaceBuilder 新檔 + 結構化 ContextPrefaceParts
- B.2 PreloadProvider 改回 structured，不再 emit string
- B.3 SystemPrompt.environment 拆 date 出來
- B.4 StaticSystemBuilder 重構 llm.ts L483-L604 路徑（縮成 7 層 static）
- B.5 transform.ts applyCaching 升級為 4-breakpoint allocator
- B.6 plugin hook `experimental.chat.context.transform` 註冊
- B.7 SkillLayerRegistry 接 ContextPrefaceBuilder
- B.8 docs/prompt_injection.md 改寫 + 新檔 docs/prompt_dynamic_context.md
- B.9 Feature flag `OPENCODE_PROMPT_PREFACE` 包裹整段
- B.10 一週 dogfood + 量測 BP1/BP2/BP3 命中率
- B.11 預設開 flag

## Dependencies between phases

Phase A 各 task 互相獨立（可任意順序，但建議依編號）。Phase B 內部依賴：
- B.1 ← B.2, B.3, B.7
- B.4 ← B.1, B.5
- B.5 與 B.4 可並行開始但需在驗證前匯流
- B.6 ← B.4
- B.10 是 gate，B.11 在 B.10 結果良好後才動

## Stop gates

- 6.7（Phase A 完成等批准 finalize）
- Phase B 啟動需獨立批准
- B.11（預設開 flag）需獨立批准
- 任何 6.5 / 6.6 出現衝突或測試紅 — 立即停手回報
