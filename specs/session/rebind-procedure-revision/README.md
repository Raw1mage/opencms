---
slug: rebind-procedure-revision
status: living
auto_generated: true
derived_from: ["proposal.md", "design.md", "tasks.md", ".state.json", "idef0.json", "grafcet.json", "events/"]
created: 2026-05-12
updated: 2026-05-12
lang: zh-hant
translated_from: en
source_mtime: 1778597265353
translated_at: 2026-05-12T14:51:34.811Z
---

# 提案：session/rebind-procedure-revision

_語言：**zh-Hant** · [en](./README.en.md)_

> 自動生成的 `rebind-procedure-revision` 主題索引。請編輯源檔，本 README 鏡像它們。請勿直接編輯本檔。

## 狀態

**Living** · 6 條 history 紀錄 · 最近一次推進 2026-05-12（mode `promote` 從 verified）

## 源檔

- [`proposal.md`](./proposal.md) — 為何存在 · 修改於 2026-05-12
- [`design.md`](./design.md) — 架構與決策 · 修改於 2026-05-12
- [`tasks.md`](./tasks.md) — 任務清單 · 49/49 完成（100%）· 修改於 2026-05-12
- [`idef0.json`](./idef0.json) + _尚無 SVG_ — 形式化功能拆解
- [`grafcet.json`](./grafcet.json) + _尚無 SVG_ — 形式化執行行為
- [`events/`](./events/) — 12 條事件紀錄
- `.state.json` — 生命週期狀態機

## 為什麼（摘錄）

「rebind procedure」原本是為了**跨 chain-identity-breaking 事件保持 session 連續**而引入的——切換帳號、rotation 觸發、daemon 重啟、capability layer 重載時，對話都要能繼續。但目前實作只做了一半：它切斷 chain（`invalidateContinuationFamily`）並且 bump session epoch，**卻不告訴 AI 剛剛發生了什麼、現在還能依賴什麼**。AI 收到的 prompt 結構上跟 mid-session continuation（round-N）一模一樣，但其中 (a) server-side reasoning trace 已經消失、(b) 它在斷裂前做過的任何 commitment 對它的新 reasoning chain 不可見、(c) 沒有任何 marker 把這個 turn 跟正常 continuation 區分開。

實證（session `ses_1e56ed3f9ffebv4AaWOlcPLz20`, 2026-05-12）：

- `session.rebind` 於 15:52 觸發
- Round 241（rebind 後）：cache 從 151k → 27k（chain 重建；基底 prompt cache 保留；對話 reasoning state 不可挽回）
- Rounds 241–277（接下來 23 分鐘）：對同一檔案連續 11 次 `read`，0 次寫入——但 rebind 前 `apply_patch` 已經成功了 3 次
- Layer C paralysis nudge 觸發 4 次；模型輸出合規文字（「我改成檢查...」）然後立刻又下同一個 `read`——口頭安撫劇場，因為新 chain 沒有「做完了」的記憶
- Round 279：`inputTokens=348215`（完整 transcript 內聯；超出 240k 可用預算）——緊急 fallback 本身又構成第二種失敗模式

[完整 →](./proposal.md)

## 架構總覽

```mermaid
flowchart TB
  subgraph EvSrc["Event source layer (existing, lightly extended)"]
    A1["rebind-epoch.ts"]
    A2["prompt.ts runloop"]
    A3["compaction.ts"]
    A4["transport-ws.ts (codex-provider)"]
    A5["server/routes/session.ts admin PATCH"]
  end
  EvSrc -->|ContinuationEvent { kind, providerId, … }| Run
  subgraph Run["Continuation.run (single dispatch executor)"]
    direction TB
    R0["dedup check<br/>(DispatchDedup, 1hr TTL)"]
    R1["classify(event)<br/>(SHAPE_BY_KIND × providerClass)"]
    R2["captureDigest<br/>(mutation-class, scrub, ≤1000 chars)"]
    R3["invalidateContinuationFamily<br/>(no-op for SL)"]
    R4["markPendingInjection<br/>(once_after_chain_break)"]
    R5["RebindEpoch.bumpEpoch<br/>(+ chainBreakClass payload)"]
    R6["emit chain.commitment.captured<br/>+ chain.init.injected/skipped"]
    R7["record dedup key"]
    R0 --> R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> R7
  end
  R4 -.->|PendingInjectionStore| Consume
  R5 -.->|session.rebind event| SSE["SSE / dashboard subscribers"]
  subgraph Consume["Prompt builder (llm.ts) consumer"]
    direction TB
    C1["PendingInjectionStore.consume"]
    C2["decideAmnesiaInjection<br/>(recentEvents scan)"]
    C3["decideChainInitInjection<br/>(pending marker check)"]
    C4["buildAmnesiaNoticeFragment<br/>(extended with digest)"]
    C5["buildChainInitNoticeFragment"]
    C6["assembleBundles → bundle_user"]
    C1 --> C3
    C1 --> C2
    C2 --> C4
    C3 --> C5
    C4 --> C6
    C5 --> C6
  end
  C6 -->|input.messages| Codex["codex provider outbound"]
  Codex -.->|response| Loop["runloop next iteration"]
```

[完整 design →](./design.md)

## 近期活動

- 2026-05-12：`promote` verified → living — 使用者確認 graduation。Phase A-E + hotfix + polish 全部上 main；端到端 live 驗證包含 300× token 效率改善；theory.md + 12 條 events + 17 條 DD + Failure-Mode Taxonomy + Glossary + Mermaid + Related Specs 都齊全。rev1（KIND_CHAIN 觀察）已記錄。
- 2026-05-12：`promote` implementing → verified — 跨 6 條 event note 完成 live 驗證；168 個 unit test 通過；tsgo clean。剩餘項目重新格式化為 F-series follow-up 顯式延後項，verified 狀態正確反映 in-cycle 達成範圍。
- 2026-05-12：`promote` planned → implementing — Phase A-E 全部 commit 上 main；ses_1e56ed3f9ffebv4AaWOlcPLz20 上 live verification 已捕獲；進入運作期。
- 2026-05-12：`promote` designed → planned — test-vectors.json（10 條 vector 涵蓋全 classifier cell + e2e replay）、errors.md（8 種 failure mode、3 條 error contract）、observability.md（3 條新 event + payload 擴充 + jq recipes）完成。
- 2026-05-12：`promote` proposed → designed — Acceptance Checks 章節（A1-A10）加入；8 個 designed-state artifact 齊全。
- 2026-05-12：[`events/event_2026-05-12_phase-b-m7-1-empty-response-recovery-rewire.md`](./events/event_2026-05-12_phase-b-m7-1-empty-response-recovery-rewire.md)
- 2026-05-12：[`events/event_2026-05-12_rev1-rebind-class-compaction-chain-excludes-server.md`](./events/event_2026-05-12_rev1-rebind-class-compaction-chain-excludes-server.md)
- 2026-05-12：[`events/event_2026-05-12_phase-d-chainbreakclass-payload-extension.md`](./events/event_2026-05-12_phase-d-chainbreakclass-payload-extension.md)
- 2026-05-12：[`events/event_2026-05-12_live-verification-on-ses-1e56ed3f9ffebv4aawolcplz2.md`](./events/event_2026-05-12_live-verification-on-ses-1e56ed3f9ffebv4aawolcplz2.md)
- 2026-05-12：[`events/event_2026-05-12_architecture-correction-transport-ws-sites-stay-di.md`](./events/event_2026-05-12_architecture-correction-transport-ws-sites-stay-di.md)

## 交叉連結

### Code anchors

- packages/opencode/src/provider/chain-semantics.ts:1 (NEW) — `ProviderChainClass = "SS" | "SL" | "Hybrid"`；`classifyProvider(providerId): ProviderChainClass`
- packages/opencode/src/session/continuation/continuation-event.ts:1 (NEW) — `ContinuationEvent` discriminated union；`classify(event): ContinuationDecision`
- packages/opencode/src/session/continuation/run.ts:1 (NEW) — `Continuation.run(event)` procedure executor
- packages/opencode/src/session/continuation/commitment-digest.ts:1 (NEW) — `captureDigest(sessionID)`、`renderDigest(entries)`
- packages/opencode/src/session/context-fragments/chain-init-notice.ts:1 (NEW) — `decideChainInitInjection`、`buildChainInitNoticeFragment`

_… 另有 24 條 · [完整清單 →](./design.md#code-anchors)_

### 事件紀錄

- 2026-05-12：[`event_2026-05-12_phase-b-m7-1-empty-response-recovery-rewire.md`](./events/event_2026-05-12_phase-b-m7-1-empty-response-recovery-rewire.md)
- 2026-05-12：[`event_2026-05-12_rev1-rebind-class-compaction-chain-excludes-server.md`](./events/event_2026-05-12_rev1-rebind-class-compaction-chain-excludes-server.md)
- 2026-05-12：[`event_2026-05-12_phase-d-chainbreakclass-payload-extension.md`](./events/event_2026-05-12_phase-d-chainbreakclass-payload-extension.md)
- 2026-05-12：[`event_2026-05-12_live-verification-on-ses-1e56ed3f9ffebv4aawolcplz2.md`](./events/event_2026-05-12_live-verification-on-ses-1e56ed3f9ffebv4aawolcplz2.md)
- 2026-05-12：[`event_2026-05-12_architecture-correction-transport-ws-sites-stay-di.md`](./events/event_2026-05-12_architecture-correction-transport-ws-sites-stay-di.md)
- 2026-05-12：[`event_2026-05-12_token-efficiency-outcome-300x-improvement.md`](./events/event_2026-05-12_token-efficiency-outcome-300x-improvement.md)
- 2026-05-12：[`event_2026-05-12_phase-a-foundations-landed.md`](./events/event_2026-05-12_phase-a-foundations-landed.md)
- 2026-05-12：[`event_2026-05-12_phase-c-account-switch-compaction-rewires.md`](./events/event_2026-05-12_phase-c-account-switch-compaction-rewires.md)
- 2026-05-12：[`event_2026-05-12_skipreason-polish-amnesia-supersedes-for-compactio.md`](./events/event_2026-05-12_skipreason-polish-amnesia-supersedes-for-compactio.md)
- 2026-05-12：[`event_2026-05-12_24x7-stability-evidence-multi-document-refactor-wi.md`](./events/event_2026-05-12_24x7-stability-evidence-multi-document-refactor-wi.md)
- 2026-05-12：[`event_2026-05-12_data-plane-gap-discovered-pendinginjectionstore-ha.md`](./events/event_2026-05-12_data-plane-gap-discovered-pendinginjectionstore-ha.md)
- 2026-05-12：[`event_2026-05-12_dedup-bug-discovered-chain-init-notice-re-injected.md`](./events/event_2026-05-12_dedup-bug-discovered-chain-init-notice-re-injected.md)

<!-- AUTO-GENERATED by plan-builder MCP plan_sync · 2026-05-12T14:47:45Z · 翻譯版本，請勿直接編輯本檔。 -->
