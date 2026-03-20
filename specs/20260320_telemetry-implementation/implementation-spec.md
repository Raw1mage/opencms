# Implementation Spec

## Goal

- 將 Builder sidebar / context tab telemetry卡片的 P2 需求具體化，提供清晰的欄位、狀態、互動與數據契約，讓後續實作可以直接依此繪製畫面與綁定 `session/monitor.ts` 的 projection。

## Scope

### IN

- 定義 Runner / Health overview、Prompt Telemetry (A111)、Round / Session Telemetry (A112)、Account / Quota reuse卡片的欄位、狀態、互動、放置位置與整體順序。
- 指定共用狀態模型與資料來源限制，明確說明這些卡片是 read-only consumer，只從 `session/monitor.ts` 對應的 sync slice 讀取狀態片段。
- 確認 P2a / P2b / P2c 的優先順序及相依性，並且備註需要在未違背 read-only 規則下選定同步鍵（key name TBD）。

### OUT

- 不包括任何 runtime code，純粹為設計文件。
- 不指定實作任務細節（留給 implementation agent 實作）。

## Assumptions

- `session/monitor.ts` 已提供 telemetry 投影（例如 runner 線程狀態、prompt block metadata、round/session summary、quota 消耗）並對外 expose sync slice 供 UI read-only 訂閱。
- 所有 spec 內提到的欄位都有信賴來源（request log、telemetry aggregator），但 exact sync key 名稱尚未敲定，需要在實作階段與 backend 協調且不得新增 write path。
- P2 卡片會與 status sidebar + context tab 共存，builder 會以相同 state model 控制多個 subtree 的顯示。

## Shared State Model

- 所有 P2 卡片遵循統一 state 四態：
  1. `empty`：尚無 telemetry 值時的 placeholder。
  2. `loading`：資料尚在從 `session/monitor.ts` 投影同步中。
  3. `error`：最終讀取失敗或 projection 異常。
  4. `disabled`：在該 session/runner 模式下此卡片不可用（例如 quota 功能未開）。
- 每個卡片都應該依狀態呈現對應的 headline、icon、提示文字，且 UI 層只負責呈現，不試圖 mutation 後端資料。

## Data Contract Notes

- 四張卡片都只讀取 `session/monitor.ts` 的 projection/sync slice；UI 不得直接訂閱 lower-level runtime event 或 inject 新的寫入通道。
- 具體的 sync key 命名（例如 `runnerTelemetry`, `promptBlocks`, `roundTelemetry`, `quotaSignals`）尚待 engine/monitor owner 與 builder 協調，在正式實作前必須確認，但這不影響 read-only consumer 的角色。
- 卡片更新頻率應與 telemetry refresh rate 一致，不可在 UI 端自行 trigger schedule（避免造成 state mismatch）。

## P2 Telemetry Cards

### 顆粒化順序與定位

- **P2a Runner/Prompt → P2b Round/Session → P2c Account/Quota**。依照 priority 先展示 runner 相關概覽，再提供 round/session 使用量，最後補 quota/帳號視角。Sidebar 主要區塊呈現 P2a + P2b，context tab 與 compact callout 承接 P2c。每張卡片都按這個實作序列交付。

### 1. Runner / Health overview reuse

- **欄位**：current runner status（running/idle/pending）、health summary（last heartbeat、failure rate）、telemetry callouts（last prompt injection outcome、round durations、last error stack）。
- **狀態**：empty/loading/error/disabled。
- **互動**：
  - expand diagnostics（展開 runner 詳細 telemetry log）。
  - drill-down（導向 context tab 或 telemetry detail pane）。
  - copy runner/session IDs（提供複製按鈕）。
  - severity filter（若 severity tag 存在，可切換展示 warning/error/ok）。
- **放置位置**：status sidebar primary zone，必要時可在 sidebar 上方帶 condensed context preview，提供快速的 telemetry highlight。
  - 可與 P2a prompt telemetry combine preview，避免 duplicated layout。
- **Data source**：`session/monitor.ts` 的 runner telemetry slice（read-only），需明確 flag 這張卡片不觸發任何 state mutations。

### 2. Prompt Telemetry card (A111)

- **欄位**：block ID/name、source file、block kind、injection policy、injected/skipped + skip reason、estimated tokens、correlation IDs、builder tag。
- **狀態**：empty/loading/error/disabled，同步 runner card 状態。
- **互動**：
  - expand token breakdown（reveals prompt layers & estimated cost）。
  - copy block/trace IDs。
  - sort by token count or outcome（injected/skipped）。
  - filter injected vs skipped。
  - drill into context tab full log（context tab 顯示詳細 prompt log）。
- **放置位置**：status sidebar primary 區域，緊鄰 runner overview；也可在 hybrid context detail pane 展示詳細 token 分解資料。
- **補充**：builder 應確認 `injected/skipped` 與 `skip reason` 由 monitor 端附帶，UI 只負責呈現及過濾。

### 3. Round / Session Telemetry card (A112)

- **欄位**：sessionId、roundIndex、requestId、provider/account/model、prompt/input/response token estimates、compaction flags & results、compaction draft tokens、sessionDurationMs、cumulative tokens。
- **狀態**：empty/loading/error/disabled。
- **互動**：
  - sort/filter（例如依 round index、token 總量、compaction trigger）。
  - expand compaction history（顯示過去 round 的 compaction decisions）。
  - drill-down to request details（導向 request detail tab）。
  - copy session/round/request IDs。
- **放置位置**：status sidebar summary block，context tab history/detail 也應同步顯示以便 review。

### 4. Account / Quota reuse card

- **欄位**：quota consumption（current & rolling window）、remaining tokens、aggregate health（跨 providers）、alert thresholds tied to A112 demand spikes。
- **狀態**：empty/loading/error/disabled。
- **互動**：
  - drill into account details（context tab 顯示各 account quota timeline）。
  - filter by quota type（daily/monthly/feature-tier）。
  - copy account ID。
- **放置位置**：context tab primary card，sidebar 內則以 compact callout 呈現（only when quota pressure is high, e.g., remaining tokens < threshold from A112 demand spikes）。

### 通用條件

- 所有卡片都受到同一個 read-only telemetry sync slice 控制，避免 builder 副作用。
- UI Implementation note：exact sync key names（例如 `telemetry.runnerState`, `telemetry.promptBlocks`, `telemetry.roundSummary`, `telemetry.quotaOverview`）仍需與 runtime owner 共同確定，該決議於 implementation 階段補足，不得在 spec 裡強制定死。
- 確保 P2 cards 的 refresh 只由 `session/monitor.ts` 的 subscription 驅動，UI 不能自行 poll 或寫入。
