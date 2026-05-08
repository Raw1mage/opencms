# Spec: compaction-fix

## Purpose

Phase 1：升級 opencode 的 0-token compaction（`narrative` + `replay-tail`），把 anchor 之後完成的 assistant turn 從 raw verbose items 轉成精簡 trace marker + WorkingCache reference，避免 codex backend 對 input array 個數的隱藏敏感度（>~300 items 失敗率激增）並保留 fidelity（可透過 WorkingCache 尋回）。

Phase 2（後續）：AI-based compaction（`low-cost-server` + `llm-agent`）真正利用 codex 回傳的 `compactedItems` 取代 pre-anchor history。

## Requirements

### Requirement: Post-anchor transformation reduces inputItemCount

#### Scenario: 50-turn session post-compaction

- **GIVEN** session 有 anchor message + anchor 後 50 個完成的 assistant turn + 1 個 in-flight assistant turn
- **AND** `compaction.phase1Enabled = true`
- **WHEN** prompt 組裝層跑完 transformer
- **THEN** 送進 codex 的 input array 包含：anchor message、所有 user message、最近 N=2 輪完整 raw assistant、其餘 48 個轉成精簡 trace marker（每個 turn 折成 1 個 message）
- **AND** inputItemCount 從 ~350 降到 ~80 範圍

#### Scenario: WorkingCache reference is queryable post-transform

- **GIVEN** Phase 1 transformer 把第 5 輪 assistant message 的 read tool result 轉成 trace marker `[turn 5] read(packages/x.ts) → cache_id=WC042`
- **AND** WC042 已透過 WorkingCache write API 寫入
- **WHEN** Lazy retrieval runtime（L3，獨立於本 plan）以 cache_id=WC042 查詢
- **THEN** 能拿回原始 read tool result 內容

### Requirement: Recent N rounds preserved raw

#### Scenario: 最近 2 輪不被 transform

- **GIVEN** anchor 後完成的 assistant turn 有 30 個
- **AND** `compaction.recentRawRounds = 2`
- **WHEN** transformer 跑
- **THEN** 第 29 與第 30 輪（最近 2 輪）保留 raw items 不轉換
- **AND** 第 1-28 輪轉成精簡 trace marker

### Requirement: In-flight assistant preserved intact

#### Scenario: 當前未完成的 assistant turn 不動

- **GIVEN** prompt 組裝時有一個 in-flight assistant message（含 pending tool calls）
- **WHEN** transformer 跑
- **THEN** in-flight assistant message 完整保留（含 pending tool 部分）
- **AND** 不破壞 unsafe_boundary 護欄

### Requirement: Safety net fallback

#### Scenario: transform 後過於精簡

- **GIVEN** transformer 跑完後 messages 數 < 5
- **WHEN** prompt 即將送出
- **THEN** fallback 使用未 transform 的原始 messages
- **AND** log warn `phase1-transform: fallback to raw, transformed_count=N`

### Requirement: Feature flag respects gradual rollout

#### Scenario: flag 關閉時行為等同 Phase 1 落地前

- **GIVEN** `compaction.phase1Enabled = false`
- **WHEN** prompt 組裝跑
- **THEN** transformer 完全跳過，行為與 Phase 1 落地前完全相同（raw items 全送）

#### Scenario: flag 開啟時 transformer 啟用

- **GIVEN** `compaction.phase1Enabled = true`
- **WHEN** prompt 組裝跑
- **THEN** transformer 啟用、按 DD-1..DD-6 行為運作

### Requirement: Subagent path unaffected

#### Scenario: subagent prompt 組裝

- **GIVEN** subagent session 觸發 prompt 組裝（透過 parent stream-anchor 路徑）
- **WHEN** prompt 組裝跑
- **THEN** transformer **不**套用 — subagent path 在 Phase 1 完全 bypass
- **AND** subagent 仍看到完整 parent context（與 Phase 1 落地前一致）

### Requirement: Mode 1 inline compaction items preserved

#### Scenario: 含 codex 自送的 compaction part

- **GIVEN** anchor 之後某 assistant turn 含 `compaction` part type（codex Mode 1 inline 產物）
- **WHEN** transformer 跑
- **THEN** 該 `compaction` part 完整保留（exempt from transform）
- **AND** 同 turn 的其他 verbose part（text/reasoning/tool result）正常轉 trace marker

### Requirement: Layer purity invariant

#### Scenario: trace marker 不含連線狀態

- **GIVEN** 任何 transformed trace marker
- **WHEN** 檢查其 payload
- **THEN** 不出現：accountId、providerId、WS session ID、`previous_response_id`、`conversation_id`
- **AND** 任何 chain identity 資訊由 L4（transport-ws.ts + continuation.ts）獨立維護

## Acceptance Checks

- A1：在合成 session（30+ turns）下，`compaction.phase1Enabled = true` 後 inputItemCount 降至 ~80
- A2：所有 prompt.applyStreamAnchorRebind 既有單元測試 pass
- A3：新增單元測試覆蓋 G1-G6 對應行為
- A4：subagent path 整合測試（subagent 看到 parent 完整 context）
- A5：在 ses_204499eecffe2iUTzeXyiarlnq pattern 復現後，empty-turns.jsonl 24h 內失敗率不增加
- A6：feature flag 默認 false，啟用後可即時關閉回退
