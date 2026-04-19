# Proposal: session-rebind-capability-refresh

## Why

- 前一個 spec `mandatory-skills-preload` 把「能力層 skills」改成 runtime preload + pin，但使用者實測發現：**舊 session 接續對話時，AGENTS.md 與 skill 都沒有被重新初始化**。dashboard「已載技能」面板空白，需要口頭要求 AI 手動呼叫 `skill()` 才能恢復。
- 追查後發現這是一個**架構層面**的問題，不是單一 bug：
  - `InstructionPrompt.system()` 用 10 秒時間基 TTL cache（非 mtime-aware），AGENTS.md 剛改完 10 秒內開的 session 會吃到舊內容
  - Model / account / provider 切換時只重壓對話訊息，不重新注入能力層
  - UI 打開舊 session 不會主動觸發 daemon 跑一輪「能力層重注入」，所以 dashboard 維持上次 daemon 結束時的 registry 快照（通常是空的）
- 使用者觀察總結出一條乾淨的架構原則：
  > 對話層（messages / tool results / 任務進度）應該被 checkpoint / shared-context 壓縮保存；
  > **能力層（system prompt / driver / skill content / AGENTS.md / enablement）絕不被凍結**，應該在 session rebind event 發生時從磁碟重讀一次，然後在 session 活動期間記憶體重用。
- 本 spec 的目標：把這條原則落實成 runtime 契約，讓「rebind event → 能力層刷新」變成 iron-clad invariant，不是一堆分散的 cache hack。

## Original Requirement Wording (Baseline)

- 「我發現我回去先前的 session 接續對話，完全不會重新執行 AGENTS.md 和加載 mandatory skills」
- 「我需要確定以後任何 rebind session, daemon restart, model/account changing，都一定會重新 init session？也就是讓新來的 model 重新注入 AGENTS.md，然後才去讀 checkpoint/shared context」
- 「prompts 有那麼多層，有些東西不應該被 checkpoint/shared context 記起來，而是每次都要重新加載的。那就是 system prompt, driver, skill 這些核心關鍵能力。」
- 「每次發生 session rebind 的時候要重讀，不是每次對話都要每回重讀」
- 「system prompts 的 reload 也是需要的功能。可以寫成 slash command 加 toolcall 支援。」

## Requirement Revision History

- 2026-04-20: initial draft created via plan-init.ts
- 2026-04-20: 原則收斂完成 —「能力層 per-rebind 刷新，對話層繼續走 checkpoint/shared-context」；使用者指定 slash command + tool call 並列入 scope

## Effective Requirement Description

1. **定義「能力層」與「對話層」的邊界**：
   - 能力層 = 執行當下 AI 該擁有的能力表述 → system prompt / driver prompt / AGENTS.md / coding.txt sentinel / skill content / enablement.json
   - 對話層 = 使用者 × AI 的互動歷史 → messages / tool results / task progress / SharedContext snapshot
   - checkpoint / shared-context 的職責**只限於對話層**；能力層不得進 checkpoint。

2. **Rebind event 列舉**（觸發能力層重讀的唯一時機）：
   - Daemon 啟動（新 process，所有 in-memory 自然重建）
   - Session resume（UI 打開舊 session → daemon 收到新 signal）
   - Provider / model / account 切換
   - 顯式 `/reload`（slash command）或 `refresh_capability_layer`（tool call）
   - **可選**：AGENTS.md / SKILL.md 檔案改動（mtime watcher，視實作成本決定 phase）

3. **能力層 cache 契約**：
   - 能力層內容在記憶體中以 per-session rebind epoch 為 key 快取
   - 每次 rebind event 發生 → bump epoch → 所有能力層 cache 失效
   - 平時（非 rebind round）直接用 in-memory copy，不做磁碟 I/O 也不做 mtime 檢查
   - cache 命中失效**不得**以「經過 N 秒」做依據（推翻現行 `InstructionPrompt.systemCache` 10 秒 TTL）

4. **能力層刷新順序契約**（per rebind event）：
   - 先清空能力層 cache
   - 下一輪 prompt 組裝時：從磁碟重讀 AGENTS.md、driver、skill content、enablement.json
   - 重注入後才讀 checkpoint / SharedContext snapshot 壓縮對話層
   - 最後把 system[] 組起來送進 LLM
   - **不允許**出現「先套 checkpoint，再補能力層」的順序反轉

5. **Slash command `/reload`**：
   - 使用者手動觸發 rebind event
   - 不打 LLM，只 bump epoch + 推 event 通知 UI 更新 dashboard
   - UI 顯示「capability layer refreshed」類似 toast

6. **Tool call `refresh_capability_layer`**：
   - AI 可在對話中主動觸發（例如偵測自己能力不足時）
   - 參數可選：`reason` 供 log / event 記錄
   - 效果等同 `/reload`，但 AI 在同一回合內可繼續使用新能力

7. **UI Session-open silent refresh**（漏洞 1 的根治）：
   - UI 切到某個 session 時主動發 `session.resume` 訊號給 daemon
   - Daemon 收到後跑一輪「零 LLM init round」：清 cache、重讀能力層、pin mandatory skills、推 SSE event
   - 使用者視覺上看到 dashboard 載入 skills，但不計費也不跑 LLM

8. **Observability**：
   - 每次 rebind event 發事件（`session.rebind` with `trigger: daemon_start | session_resume | provider_switch | slash_reload | tool_call | file_mtime`）
   - 每次能力層刷新發事件（`capability_layer.refreshed` with 清單 + 新 epoch）
   - log 可追溯哪個 event 觸發了哪個刷新

## Scope

### IN

- **Runtime 層**：
  - `packages/opencode/src/session/prompt.ts` runLoop 的能力層組裝流程重構
  - `packages/opencode/src/session/instruction.ts` `systemCache` 改成 epoch-based
  - 新增能力層 cache 管理模組（per-session rebind epoch 中心）
  - Pre-loop provider switch detection 區塊加 rebind event bump
- **Rebind event 源**：
  - Daemon startup：runtime init 時自動 bump
  - Session resume signal：server 端新 API endpoint + daemon hook
  - Provider switch：既有 detection 區塊加 bump 呼叫
  - Slash command：`packages/opencode/src/command/` 新增 `/reload` handler
  - Tool call：`packages/opencode/src/tool/` 新增 `refresh_capability_layer` tool
- **UI 層**：
  - 前端在切到某 session 時發 `session.resume` signal（HTTP 或 SSE）
  - 收到 `capability_layer.refreshed` event 時刷新 dashboard「已載技能」面板
  - `/reload` slash command UI 入口（若 TUI 已支援 slash，自然可用）
- **Observability**：
  - 新 event types 納入 `RuntimeEventService`
  - dashboard 新增 rebind 歷史區塊（可選）
- **Documentation**：
  - `specs/architecture.md` 新增「Capability Layer vs Conversation Layer」邊界章節
  - `docs/events/event_<YYYYMMDD>_session_rebind_refresh.md`

### OUT

- **對話層壓縮邏輯改動**：不動 `SessionCompaction` / `SharedContext` 的 checkpoint 機制；本 spec 只動能力層。
- **File watcher 自動偵測檔案改動**：列為**可選 Phase 2**，Phase 1 靠 rebind event 驅動即可；若需要 mtime 自動觸發，之後 extend mode 加。
- **重新定義 driver prompt 的組成**：driver prompt 仍以 provider 為 key cache，不在本 spec 改結構，只改「cache 失效時機」。
- **Bun module hot-reload**：Bun 本身不支援 hot-reload，daemon 啟動時載的 module graph 是固定的。本 spec 不處理 code change 即時生效；要改 code 仍需 `webctl.sh restart`。
- **跨 session 能力層共享**：每個 session 各自維護 rebind epoch；不嘗試全域 shared epoch（複雜度不成比例）。

## Non-Goals

- 不引入第三方 cache 系統（Redis、LRU library 等）；用現有 in-memory Map 即可。
- 不做 cross-daemon sync（multi-daemon 部署場景超出範圍）。
- 不嘗試解決「使用者改了 skill `SKILL.md` 但 skill library 指標未動」的問題——skill library 是獨立 git repo（submodule），其本身的熱重載不在本 spec 處理。
- 不重新設計 UI dashboard layout；只新增 event 接收與顯示，不動既有元件結構。

## Constraints

- **AGENTS.md 第一條**（禁止靜默 fallback）：所有 rebind event 必須 log + 發事件；能力層刷新失敗不得靜默跳過。
- **AGENTS.md 第二條**（XDG 備份）：本 spec 進 implementing 前必須備份 `~/.config/opencode/`。
- **AGENTS.md 第三條**（自主 Continuation 契約）：本 spec 在 implementing 階段 tasks.md 殘留時，runloop 靠 todolist 續跑。
- **向後相容**：現有已跑中的 session 不可在升級後崩潰；rebind epoch 初始值對已存在的 session 可從 0 開始。
- **效能**：rebind event 頻率不高（每 session 幾次），刷新成本可承受。平時（非 rebind round）不得增加額外 I/O。
- **UI signal 不可被 AI 偽造**：`session.resume` signal 的 auth / origin 檢查必須明確，避免 AI 透過 tool call 偽造導致無限 refresh 迴圈。
- **SSE reliability**：若 UI 沒收到 `capability_layer.refreshed` event（網路不穩），下次 rebind event 仍會重新推送；不依賴 event delivery 保證 dashboard 正確。

## What Changes

### 使用者感受的變化

- 舊 session 打開 → dashboard 立刻顯示 pinned skills（不再需要送訊息）
- 改完 AGENTS.md → 下一個 rebind event 立刻生效（不需等 10 秒）
- 切換模型 → 新模型自動看到最新 AGENTS.md + skills
- 新增 `/reload` slash command，任何時候可手動強制能力層刷新
- AI 發現自己缺能力時，可呼叫 `refresh_capability_layer` 主動刷新

### 開發者感受的變化

- `InstructionPrompt.systemCache` 從時間基改成 epoch 基
- prompt.ts runLoop 加「per-rebind refresh」concept
- 新 tool / slash command 入口註冊到既有系統
- 新 event types 出現在 RuntimeEventService

## Capabilities

### New Capabilities

- **Rebind event 中心模組**：管理 per-session rebind epoch，提供 `bumpEpoch(sessionID, trigger)` API。
- **Capability layer cache with epoch**：AGENTS.md / driver / skill content 的 cache 以 (sessionID, epoch) 為 key。
- **Slash command `/reload`**：使用者手動觸發 rebind event。
- **Tool call `refresh_capability_layer`**：AI 主動觸發 rebind event。
- **UI session-resume signal**：前端新 signal，daemon 新 endpoint / bus subscriber。
- **Silent init round**：daemon 收 resume signal 後跑「零 LLM」refresh 流程，只 bump epoch + 推 SSE。

### Modified Capabilities

- `InstructionPrompt.system()`：cache 改 epoch-based，不再 10 秒 TTL。
- `SkillLayerRegistry`（可能需要）：pinned 條目在 rebind event 時重 pin（verify 檔案內容未過期）。
- `prompt.ts runLoop`：加 rebind epoch check；能力層組裝前先確認 cache 對齊當前 epoch。
- `provider-switch detection`（prompt.ts:933+）：偵測到切換時呼叫 `bumpEpoch(sessionID, "provider_switch")`。

## Impact

### 受影響程式碼（runtime）

- `packages/opencode/src/session/rebind-epoch.ts`（新模組）— epoch 中心 + event 發佈
- `packages/opencode/src/session/instruction.ts` — systemCache 改 epoch-based
- `packages/opencode/src/session/prompt.ts` — runLoop 加 rebind check；能力層組裝前先對齊 epoch
- `packages/opencode/src/session/mandatory-skills.ts` —（可能）與 rebind event 整合
- `packages/opencode/src/session/skill-layer-registry.ts` —（可能）加 epoch-aware invalidate
- `packages/opencode/src/tool/refresh-capability-layer.ts`（新 tool）
- `packages/opencode/src/command/reload.ts`（新 slash command handler）
- `packages/opencode/src/server/routes/session.ts` — 加 `session.resume` endpoint

### 受影響前端 / UI

- TUI / web frontend：session 切換時發 resume signal
- Dashboard 「已載技能」面板：訂閱 `capability_layer.refreshed` event
- 可選：rebind 歷史時間軸在 session detail drawer

### 受影響文件 / 配置

- `specs/architecture.md` — 新增 Capability Layer 邊界章節
- `docs/events/event_<YYYYMMDD>_session_rebind_refresh.md` — 本 feature 留痕
- （可能）AGENTS.md — 加入「Capability vs Conversation Layer」概念描述（或留在 architecture.md）

### 受影響的執行中 session

- 升級後第一次被使用的 session 會跑一次 rebind（epoch 0 → 1），能力層重注入
- 後續使用若無 rebind event，行為與升級前一致
- 切模型時額外走 rebind，比升級前多一次 AGENTS.md 重讀

### Runtime 效能

- Rebind event 發生頻率：每 session 幾次（login、切 model、/reload）
- 能力層重讀成本：<10ms per event（讀 AGENTS.md 兩個檔 + 幾個 SKILL.md）
- 平時（非 rebind round）零額外 I/O（in-memory cache hit）
- UI SSE event payload：~1KB per rebind，頻率低

### 受影響的 operator / 使用者

- 使用者須學會 `/reload` 行為（但 UI 會加說明）
- 使用者若編輯 `~/.config/opencode/AGENTS.md` 後想立刻生效，現在可以 `/reload`，之前只能等 10 秒或重啟 daemon
