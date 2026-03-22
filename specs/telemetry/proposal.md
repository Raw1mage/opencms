# Proposal

## Why

- 目前 telemetry 可觀測，但 steady-state authority 仍分散在 runtime event persistence、`session.top` snapshot、page-level refresh、app hydration、monitor-derived helper、與 local fallback。
- 這種 hydration-first / monitor-first / page-hook-first steady-state 與 repo 的 bus-messaging / DDS / reducer-owned state pattern 衝突，會讓 builder 在實作時繼續補強錯誤 ownership。
- 本規劃包的目的不是修補現況，而是把 telemetry 改寫成 bus-first rewrite contract，讓後續 builder 能直接按正確 authority 邊界重建。
- 同一語義 spec root 也需要承接 context-sidebar / telemetry card optimization，避免 telemetry workstream 再次分裂成平行 dated packages。

## Rewrite Contract

- **Current state 只作 migration baseline，不作 target truth。**
- **Target state 必須是 bus-first / DDS-aligned。**
- **Migration path 必須先建立 authority，再做 cutover，再降級/移除舊路徑。**
- **若現況 shortcut 與 target 衝突，builder 應重寫，不應優化或保留。**
- **A111/A112 的產品 evidence 目的不得在架構重寫過程中遺失。**
- **Context-sidebar optimization 僅能作為 presentation-layer companion slice，不能反向主導 telemetry authority。**

## Original Product Purpose

- 這份 telemetry 計畫最早的目的，是為 context control / prompt budget / compaction decision 提供 evidence，而不是單純擴充 UI 或做架構潔癖式重寫。
- A111 的原始產品目的：讓系統能回答 prompt composition 問題，例如哪些 blocks 被注入、被略過、各自成本多高、哪個 block 最該被裁切或保留。
- A112 的原始產品目的：讓系統能回答 round/session/compaction 問題，例如哪一輪開始膨脹、request identity 為何、compaction 何時觸發、草稿大小與結果如何、整個 session 成本如何累積。
- 本次 rewrite 不是放棄這些產品目的，而是把它們放回正確的 DDS/bus authority chain。

## Current State

- Runtime 已發出 telemetry 相關事件，且部分事件透過 runtime subscriber 持久化。
- `SessionMonitor` / `session.top` 目前會合成並輸出 telemetry snapshot。
- App 目前透過 `use-status-monitor.ts` 反覆抓取 `session.top`，再經 `sync.tsx` / `monitor-helper.ts` 將 snapshot/hydration 投影進 `session_telemetry`。
- UI 雖多半是 consumer，但 steady-state 更新仍受 monitor-first、hydration-first、page-hook-first 路徑影響。
- context sidebar 的 telemetry/card optimization 需求已存在，但它是 presentation slice，不是 authority rewrite 的替代方案。
- 上述現況是 migration inventory，不是應被保留的 architecture target。

## Target State

Telemetry target state is defined as:

1. runtime emits telemetry events
2. server-side projector owns the authoritative telemetry read model
3. app global-sync reducer owns the canonical telemetry slice
4. UI is a pure consumer
5. `session.top` is bootstrap / catch-up / degraded snapshot transport only
6. context-sidebar telemetry cards remain downstream consumers of reducer-owned telemetry and persisted layout state only

### Explicit Demotions

下列 steady-state 模式在架構上是錯的，必須移除或降級：

- hydration-first steady-state
- monitor-first telemetry authority
- page-hook-first telemetry authority
- snapshot refresh as primary telemetry channel
- UI/local helper synthesis as long-term truth source

## Consolidated Companion Slice

- `specs/telemetry/context-sidebar-optimization/` 收納原 dated context-sidebar optimization planning 內容。
- 其目標是把 context sidebar 舊資訊整理為 card-based surface、支援排序/持久化，並保持對 canonical `session_telemetry` 的純消費邊界。
- 若 UI optimization 與 bus-first authority contract 衝突，以本 root 的 rewrite contract 為準。

## Migration Path

1. **Baseline freeze**：凍結 current-state inventory，標出所有 authority 混線點。
2. **Event contract**：先定義 runtime telemetry event contract，拒絕任何需要 UI 補 authority 的事件設計。
3. **Projector**：建立 server projector 作為唯一 telemetry read-model authority，monitor / snapshot 只能讀 projector。
4. **Reducer cutover**：把 app canonical telemetry slice 收斂到 `global-sync` reducer，切斷 page/hydration 寫入 authority。
5. **Snapshot demotion**：把 `session.top` 降級成 bootstrap / catch-up / degraded only。
6. **Cleanup + validation**：移除舊 glue，證明沒有 duplicate authority、fallback promotion、partial migration。

## Event-Contract Expectations

- Builder 在進入 projector/reducer 實作前，必須先把 event contract 定義清楚。
- 最小 event-contract 規格必須至少回答：
  - 哪些 telemetry facts 是 runtime source-of-truth
  - 事件名稱與 producer boundary 是什麼
  - 事件 payload 至少分成哪些類別（prompt / round / compaction / summary）
  - session identity、request identity、round identity 如何關聯
  - ordering / replay / idempotency 如何處理
  - 哪些資料屬於 projector aggregate，哪些只能在 downstream adapter 才產生
- 若 builder 無法先把 event-contract 寫清楚，則不得直接跳到 projector 或 reducer phase。

## Scope

### IN

- 重寫 telemetry planning package 成 builder-first rewrite contract。
- 補強 stop gates、cutover order、handoff language、event traceability。
- 將 context-sidebar / telemetry-card optimization 規劃納入同一語義 telemetry spec root，作為 companion slice 管理。

### OUT

- 不實作 runtime/server/app 產品程式碼。
- 不把 quota/account/billing telemetry 一起納入本次 cutover。
- 不讓 context-sidebar optimization 取代 telemetry authority rewrite。
- 不為 current code shortcut 背書。

## Non-Goals

- 維持 `session.top` 為 steady-state telemetry 主通道。
- 維持 monitor-derived telemetry authority。
- 維持 page-level hydration/fallback 對 canonical telemetry slice 的寫入權。
- 允許 partial migration 長期存在。

## Builder Rules

- 以 target architecture 為唯一優化目標。
- 遇到與 target 衝突的現有 glue，優先重寫或刪除。
- 若 builder 無法證明 authority 已單一化，視為未完成，不得收尾。
- Builder 不得只證明資料「能顯示」；還必須證明 A111/A112 的 evidence path 可回答原始產品問題。
- Context-sidebar / telemetry-card UI work 必須從屬於這條 authority chain，不得重新引入 UI-side truth synthesis。

## Success Criteria

- Builder 可以直接從文件理解：current state、target state、migration path、stop gates、與 build order。
- Event contract 具備足夠精度，讓 builder 不需要自行猜測基本 ownership、identity、或 replay 規則。
- Projector / reducer / snapshot 的權責切線明確，且不再容許雙重 authority。
- 完成後的 telemetry 不只架構正確，也能實際支撐 prompt composition 與 round/session/compaction evidence。
- 同一 telemetry 語義 root 內可同時找到 authority rewrite 與 context-sidebar optimization companion artifacts。
