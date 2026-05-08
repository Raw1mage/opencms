# Design: compaction-fix Phase 1

## Context

Phase 1 範圍：升級 0-token compaction（`narrative` + `replay-tail` kinds）。

問題（已於 [proposal.md](./proposal.md) 詳述）：
- 4 種 compaction kind 跑完都只產 summaryText 寫進 anchor，post-anchor tail 沒處理
- 50 輪 tail 累積 ~300-400 input items，撞 codex backend 對 input array 個數的隱藏敏感度
- AI-based 退化成「0-token + AI 文字」，浪費 server 算力

Phase 1 解 0-token 那條：把完成的 assistant turn 從 raw verbose items 轉成精簡 trace marker + WorkingCache reference。AI-based（Phase 2）後做。

## Goals / Non-Goals

### Goals

- inputItemCount 從 ~300 降到 ~80
- fidelity 由 WorkingCache reference 補位（L3 retrieval runtime 取回，獨立於本 plan）
- Phase 1 落地不阻塞 Phase 2 — compactedItems 上來時應視為 anchor 延伸，預留例外路徑

### Non-Goals (also see ## Non-Goals below)

- 不解決 codex backend 的 input array 敏感度（上游 bug）
- 不暴露 model-facing recall tool（L3 retrieval runtime 的事）
- 不改 storage schema 結構
- 不動 AI-based kinds（`low-cost-server` / `llm-agent`）的行為

## Decisions

### DD-1：Trace marker shape — one line per turn

**Decision**：每個被省略的完成 assistant turn 折成 1 個 user-role message（synthetic），格式：

```
[turn N] tool_a(brief_args) → WC042; tool_b(brief_args) → WC043; <reasoning summary 50 chars>
```

- 多 tool 同 turn 折成一條（item 數從 7-10 降到 1）
- args 取首 80 字元
- reasoning 取首 50 字元（如有）
- 每個 tool result 對應一個 `WC<id>` reference（已透過 WorkingCache write API 寫入）

**Why**：用 user-role 而非 assistant-role 避免 codex 把 trace 當作「自己的歷史輸出」而 echo 回去。trace 是為了讓 model 知道「我之前做過 X，原文在 WC042」，語意上更接近系統 commentary。

**How to apply**：transformer helper 在 prompt.ts 加，作用於已 slice 的 messages 陣列。

### DD-2：Recent rounds raw — N=2 by default, tweaks-tunable

**Decision**：anchor 後最近 N 輪完成 assistant turn 保留 raw 不轉換，N=2 默認，由 `tweaks.cfg` `compaction.recentRawRounds` 調整。

**Why**：避免短期失憶 — model 對「我剛剛做了什麼」需要直接看到 raw（trace 太精簡）。N=2 折衷：item 數仍降到 ~80，model 短期記憶完整。

**How to apply**：transformer 跳過最後 N 個完成的 assistant message。

### DD-3：WorkingCache write timing — at tool completion, lazy at transform

**Decision**：
- 主路徑：tool 執行完成時，由既有的 tool 完成 hook 寫入 WorkingCache（已存在的機制）
- Fallback：transformer 跑時若發現某 tool result 尚無對應 WC reference，當場 lazy write
- transformer 不阻塞 prompt 組裝 — write 失敗時 trace marker 只記錄 tool name，不附 WC reference

**Why**：tool 完成寫入是 happy path（一次寫永久可查）；lazy fallback 救舊 session（transform 時才開始 write）。完全失敗時不阻斷 prompt — fidelity 損失但可用性不受影響。

**How to apply**：tool-invoker 既有 path 已具備（[tool-invoker.ts:124](../../packages/opencode/src/session/tool-invoker.ts#L124)），transformer 端確認讀到 reference 再產 marker；讀不到則 lazy write or 產退化版 marker。

### DD-4：Safety net — fallback when transformed messages < 5

**Decision**：transformer 跑完後若結果 messages < 5，fallback 用未 transform 的原始 messages，並 log warn `phase1-transform: fallback to raw, threshold=5, got=N`。

**Why**：極端情況（session 太短、anchor 異常、transform 過度激進）不能讓 model 看到太空的 prompt 直接崩。5 是經驗值（anchor + 2-3 user msg + in-flight）。

**How to apply**：transformer 結尾的 length check。

### DD-5：Subagent path bypass — Phase 1 不動 subagent

**Decision**：subagent prompt 組裝（[prompt.ts:989](../../packages/opencode/src/session/prompt.ts#L989) 路徑）**不**套用 transformer。subagent 仍看到 parent 完整 context（行為與 Phase 1 落地前一致）。

**Why**：subagent 與 main session 的記憶模型本來就不同（DD-12: parent owns context management）。Phase 1 transformer 設計針對 main session 的長期累積問題；subagent 通常短命，bloat 還沒成形。如果 subagent 後來也出問題另開 spec。

**How to apply**：transformer 入口檢查 `session.parentID` — 有 parentID 跳過。

### DD-6：Feature flag — `tweaks.cfg compaction.phase1Enabled`，預設 false

**Decision**：
- 加 `compaction.phase1Enabled` flag，預設 `false`
- 加 `compaction.recentRawRounds` 默認 `2`
- 加 `compaction.fallbackThreshold` 默認 `5`
- 灰度啟用：先在 ses_204499eecffe2iUTzeXyiarlnq 復現 session 開 flag → 觀察 inputItemCount 下降 → 24h 失敗率穩定 → 翻 default 為 true

**Why**：Phase 1 影響每次 prompt 組裝，預設 off 確保 main 合併後零行為改變。灰度開啟可以即時 verify 在實際 session 上的效果。失敗時關 flag 立即回退，不需要 hotfix。

**How to apply**：tweaks 載入 + transformer 入口讀 flag。

### DD-7：Layer purity — trace marker 不含連線狀態（架構不變式）

**Decision**：trace marker 與任何 transformer 產出的 message 都**不**內嵌：accountId、providerId、WS session ID、`previous_response_id`、`conversation_id`、connection-scoped credentials。

**Why**：compaction payload 是 L2 工作記憶。L4 連線狀態由 [transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) + [continuation.ts](../../packages/opencode-codex-provider/src/continuation.ts) 獨立維護。混在一起會讓 rotation / rebind / new chain 的時候，舊的 trace marker 帶著失效 chain ID 變毒物。

**How to apply**：trace marker formatter 只接受 tool name + args + result reference + reasoning text — 不開放任何連線屬性的 input。

## Risks / Trade-offs

- **R1（fidelity）**：Phase 1 之後 model 看到的是精簡 trace，可能在某些任務（特別是長期 debug 流程）下因看不到 raw 內容而重做工作 → mitigation：DD-2 留最近 N 輪 raw + WorkingCache reference 可被 L3 retrieval runtime 取回（後續會補）
- **R2（WorkingCache 覆蓋率）**：如果某 tool result 沒被 WC index，trace marker 變成「失憶 marker」（model 知道有事發生但找不回原文）→ mitigation：DD-3 lazy write fallback；長期：審視 WorkingCache 的 indexing policy
- **R3（cache_read 比例變化）**：prompt 內容變了，codex 端 prompt cache 可能失效，cache_read tokens 大幅下降 → mitigation：Phase 1 不調 promptCacheKey 策略，先觀察；如真的下降太多再開後續 spec
- **R4（subagent 暫不處理留下不一致）**：main session 走 transformer 但 subagent 不走 → 行為差異需文件化 → mitigation：DD-5 明確記錄；如果 subagent 也出 bloat 問題再單獨處理
- **R5（Phase 2 互動）**：Phase 2 拿到 compactedItems 上來，必須當作 anchor 延伸（exempt from Phase 1 transformer）→ mitigation：本 plan 預留 OUT scope 提到此互動，Phase 2 設計階段把 compactedItems 加入 transformer 的「跳過範圍」白名單

## Critical Files

- [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) — 主修改點（transformer + applyStreamAnchorRebind 整合）
- [packages/opencode/src/session/working-cache.ts](../../packages/opencode/src/session/working-cache.ts) — 既有 WorkingCache write API（沿用，不修改）
- [packages/opencode/src/session/post-compaction.ts](../../packages/opencode/src/session/post-compaction.ts) — 既有 manifest 渲染（沿用）
- [packages/opencode/src/session/tool-invoker.ts](../../packages/opencode/src/session/tool-invoker.ts) — tool 完成時的 WorkingCache write hook
- [packages/opencode/src/util/tweaks.ts](../../packages/opencode/src/util/tweaks.ts) — 加新 config 鍵
- [packages/opencode/test/session/](../../packages/opencode/test/session/) — 新增測試
