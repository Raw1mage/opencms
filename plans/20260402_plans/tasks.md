# Tasks

## 1. Continuation Reset Contract

- [x] 1.1 定義 A-trigger-only flush policy（移除 B 保留條件）
- [x] 1.2 定義 A-trigger matrix（A1~A5）與對應 evidence 欄位
- [x] 1.3 定義 execution identity 邊界（`providerId`, `modelID`, `accountId`）
- [x] 1.4 定義 flush scope：僅清 provider remote refs/sticky continuity state

## 2. Checkpoint + Tail Replay Contract

- [x] 2.1 明確定義 checkpoint 僅替代被壓縮前綴
- [x] 2.2 明確定義 replay 組裝：`checkpointPrefix + rawTailSteps`
- [x] 2.3 定義 tail 範圍選取規則（checkpoint 邊界後到當前的原始 steps）
- [x] 2.4 定義 flush 後仍保留 checkpoint/tail semantic assets 的要求

## 3. Debug Log Contract (Full Snapshot)

- [x] 3.1 定義 continuation invalidation 的 error classification（含 `text part msg_* not found`）
- [x] 3.2 定義 structured log schema：identity + trigger matrix + checkpoint/tail 邊界 + replay 摘要
- [x] 3.3 定義 structured log schema：provider invalidation 摘要 + serializer input 摘要 + sticky state 摘要
- [x] 3.4 定義 flush result 欄位：cleared keys summary + post-flush summary
- [x] 3.5 定義 redaction 規則：不得輸出 secret/key/raw headers/full payload
- [x] 3.6 定義輸出位置：使用現有 runtime logger（本 slice 不新增 event channel）

## 4. Codex / Responses First Slice

- [x] 4.1 審計並對齊 account-aware replay metadata gate
- [x] 4.2 對齊 Codex HTTP sticky turn state 的 identity 隔離/flush
- [x] 4.3 確認 websocket continuation state 是否已 account-aware，否則列 follow-up

## 5. Provider Hook Framework

- [x] 5.1 定義 provider-specific cleanup hook contract
- [x] 5.2 落地第一個 provider（Codex/OpenAI Responses）cleanup mapping
- [x] 5.3 文件化非 Codex provider 的接入方式（禁止 `msg_*` universal 假設）

## 6. Validation (Unit-test-first)

- [x] 6.1 `flush_on_identity_change_provider_model_account`
- [x] 6.2 `flush_on_provider_invalidation_previous_response_not_found`
- [x] 6.3 `flush_on_provider_invalidation_msg_not_found`
- [x] 6.4 `flush_on_restart_resume_mismatch`
- [x] 6.5 `flush_on_checkpoint_rebuild_untrusted`
- [x] 6.6 `flush_on_explicit_reset`
- [x] 6.7 `no_flush_when_no_trigger_matched`
- [x] 6.8 `replay_builds_checkpoint_plus_tail_steps`
- [x] 6.9 `flush_clears_only_remote_refs_not_checkpoint_or_tail`
- [x] 6.10 `invalidation_log_contains_full_state_snapshot`
- [x] 6.11 `invalidation_log_redacts_sensitive_fields`

## 7. Docs Sync

- [x] 7.1 更新 event log 記錄本次 debug log 需求
- [x] 7.2 執行 architecture sync check 並記錄結果

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->