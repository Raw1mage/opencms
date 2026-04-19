# Design: session-rebind-capability-refresh

## Context

- Mandatory-skills-preload spec (2026-04-19) 把能力層 skills 改成 runtime preload + pin，但實測發現：舊 session 接續對話時能力層不刷新，需 AI 手動呼叫 `skill()` 才恢復。
- 深入追查發現三個獨立的 cache / init 漏洞：
  1. `InstructionPrompt.systemCache` 10 秒 TTL（時間基、非 mtime-aware） → AGENTS.md 剛改 10 秒內開的 session 吃舊內容
  2. Provider switch 偵測（`prompt.ts:933+`）只重壓對話層，不重注入能力層
  3. UI 打開舊 session 不會觸發 daemon 跑一輪 runLoop，SkillLayerRegistry 維持 daemon 重啟後的空狀態
- 使用者總結出一條架構原則（本 spec 的核心）：
  > 對話層可以被 checkpoint 凍結；**能力層絕不可凍結**。能力層的刷新週期 = `per rebind event`，不是 `per LLM round`，也不是 `per N 秒`。
- 現有的 runtime 已有部分「rebind」概念散落各處：
  - `SessionCompaction.loadRebindCheckpoint` / `applyRebindCheckpoint` — 對話層壓縮機制
  - `prompt.ts:933+` pre-loop provider switch detection — 實際就是一種 rebind
  - daemon startup 自然重建 in-memory state — 隱含的 rebind
- 但這些「隱含 rebind」沒有**統一的事件名**也沒有**統一的 cache 失效 hook**。本 spec 把分散的概念集中成一個 `RebindEpoch` 模組 + 一組顯式 event trigger。

## Goals / Non-Goals

### Goals

- **G1**：定義 Capability Layer 與 Conversation Layer 的明確邊界，並在 architecture.md 記錄為長期契約。
- **G2**：建立 per-session rebind epoch 機制，所有能力層 cache 以 epoch 為唯一 key。
- **G3**：把現有散落的 rebind-like 事件（daemon start / provider switch）統一納入 rebind-event 事件源。
- **G4**：新增使用者 / AI 能主動觸發的入口（`/reload` slash command + `refresh_capability_layer` tool call）。
- **G5**：解決「UI 打開舊 session 面板空白」的體驗斷層（silent init round）。
- **G6**：所有 rebind event 可觀測（RuntimeEvent + dashboard update）。
- **G7**：保留對話層壓縮機制完整不動（SessionCompaction / SharedContext / rebind checkpoint messages 邏輯）。

### Non-Goals

- **NG1**：不改對話層 checkpoint / compaction 邏輯。
- **NG2**：不做檔案 mtime watcher 自動 bump epoch（Phase 2 可加 extend mode）。
- **NG3**：不引入第三方 cache library；用 in-memory Map + per-session epoch 即可。
- **NG4**：不嘗試全域 shared epoch（跨 session 共享），每 session 獨立計數。
- **NG5**：不處理 Bun module hot-reload 或 skill library submodule 熱重載；code / skill 改動仍需 `webctl.sh restart` 或 skill submodule bump + rebind。
- **NG6**：不改既有 UI dashboard layout，只新增 event 訂閱。

## Decisions

- **DD-1**（2026-04-20）rebind epoch **per-session**，不是 per-daemon 或 per-workspace。  
  *Alternatives*：per-daemon global epoch（所有 session 共用單一計數）；per-workspace epoch。  
  *Why*：per-session 隔離最清晰——A session 切 provider 不影響 B session 的 cache；`/reload` 只作用當前 session；不同 session 各自可 pin 不同 mandatory skills。Global epoch 會在任一事件炸掉所有 session cache，造成不必要的刷新風暴。

- **DD-2**（2026-04-20）rebind event 中心放在**新模組** `packages/opencode/src/session/rebind-epoch.ts`，不擴充既有 Bus。  
  *Alternatives*：只靠 Bus.publish + 各 cache 各自 subscribe；擴充 RuntimeEventService。  
  *Why*：rebind 是**狀態管理**，不是純事件流。新模組持有 `Map<sessionID, epoch>` 作為 single source of truth；Bus 只用來 fan-out 通知（RuntimeEvent）。把 state 與 event 分層避免「Bus subscriber 各自維護 epoch」的一致性 bug。

- **DD-3**（2026-04-20, **amended** 2026-04-20 in implementation to reconcile with R3）Cache key = `sessionID + epoch`，**保留最多 2 個 epoch entry**（current + previous）以支援 R3 fallback；超過則 prune 最舊的。  
  *Alternatives*：只保留當前 epoch（舊版 DD-3 原寫法 — 與 R3「reinject 失敗保留前 cache」衝突）；保留 N 個歷史 epoch（LRU）；用 WeakMap。  
  *Why*：原 DD-3 要「bump 即 clear」，但這讓 R3「新 epoch reinject 失敗時 fallback 到前 epoch」無 source。改成「最多 2 entry」：新 bump 不立刻 clear；新 epoch reinject 成功才 prune 舊的；失敗則前 epoch entry 保留供 fallback。記憶體成本 = 每 session 最多 2 份能力層副本 × ~200KB 估算 < 1MB/session，可接受。實作 = Phase 2.5 確認「wiring 是隱性的」：bumpEpoch 不直接清 cache；capability-layer 的 `get(sessionID, newEpoch)` 命中 cache miss 自然觸發 reinject；pruneSessionCache 在 reinject 成功後執行。

- **DD-4**（2026-04-20）刷新順序契約：**能力層在 checkpoint / SharedContext 之前**。  
  *Alternatives*：同時進行；checkpoint 先（既有順序）。  
  *Why*：符合使用者原始要求「讓新來的 model 重新注入 AGENTS.md，然後才去讀 checkpoint/shared context」。能力層代表「這個 model 當下該擁有的能力」，checkpoint 代表「上一個狀態壓縮」。先能力後狀態 = LLM 先知道自己是什麼，再看要接什麼。

- **DD-5**（2026-04-20）Silent init round **不打 LLM、不計費、不 autonomous-continue**；收到 resume signal 時先查 session-busy 狀態，busy 則直接忽略（不需 lock / preempt / queue）。  
  *Alternatives*：打一輪 LLM 讓 AI 自己 re-orient；跳過不做任何 runtime 動作；與 runLoop 共用 lock 排隊。  
  *Why*：UI session-open 是高頻動作，不能每次都觸發 LLM 計費。race 前提不成立：使用者切到 session 時它若正在跑 LLM，表示剛有人送過訊息、runLoop 會自己在 cache miss 時重填 — silent init 根本沒必要搶。所以簡化為「busy 則 no-op」。

- **DD-6**（2026-04-20）`refresh_capability_layer` tool call 有 **per-turn rate limit (3 次)**。  
  *Alternatives*：無限制；完全禁止 AI 呼叫；單次 session 只允許 1 次。  
  *Why*：AI 惡性循環呼叫（例如 refresh → 看不到預期結果 → 再 refresh）會造成 rebind storm。3 次給予合理 retry 空間但阻止無限迴圈。

- **DD-7**（2026-04-20）`/reload` slash command 不接受 scope 參數，**永遠刷所有能力層**。  
  *Alternatives*：`/reload agents-md`、`/reload skills` 等細粒度刷新。  
  *Why*：能力層成本低（<10ms 全刷），維護多個 scope 的 UX 與實作複雜度不成比例。永遠全刷，使用者一致預期。

- **DD-8**（2026-04-20）向後相容：既有 session 升級後 epoch 從 0 起算，第一次使用時自動 bump 到 1。  
  *Alternatives*：migration script 統一設成某 epoch；所有既有 session 保持 epoch 0。  
  *Why*：epoch 本身是 in-memory，daemon restart 後自然歸 0；第一次使用觸發 daemon_start trigger 的 bump 是自然流程，不需 explicit migration。

- **DD-9**（2026-04-20）UI `session.resume` signal 用 **本機 Unix socket origin 驗證**。  
  *Alternatives*：JWT / API key 驗證；無驗證；只檢查 URL 路徑。  
  *Why*：daemon socket 已是 `/run/user/<uid>/opencode/daemon.sock`，只有同 uid process 能連。外部 / AI tool call 的請求從不同路徑（HTTP to localhost:1080 gateway），可由 origin header 區分。既有 multi-user gateway 已處理 uid boundary，沿用即可。

- **DD-10**（2026-04-20）SSE event `capability_layer.refreshed` 的 payload 包含 **pinned skills 清單**，不是只有 epoch 數字。  
  *Alternatives*：只傳 `{sessionID, epoch}`；傳完整能力層 hash 指紋。  
  *Why*：dashboard 「已載技能」面板需要知道當前 pinned 是哪些 skill 才能畫 UI。從 runtime 端直接傳出避免前端再發一個 query。

- **DD-11**（2026-04-20）Rebind storm rate limit = **1 秒內最多 5 次**，超過 reject + anomaly event。  
  *Alternatives*：固定 cooldown（每次 bump 後 N 秒 block）；token bucket；完全不限制。  
  *Why*：正常情境不會 1 秒內 > 5 次 rebind（daemon_start + 幾次 provider switch 頂多 2-3 次）。超過 5 次 / 秒強烈暗示 bug（迴圈呼叫 / event spam）。rate-limit reject 而非完全阻擋，保留 log 可追。

- **DD-12**（2026-04-20）能力層清單在本 spec 固定為：`agents_md`, `driver`, `skill_content`, `enablement`。  
  *Alternatives*：可擴充的 plugin 系統；更少（只 agents_md + skill）；更多（包含 environment prompts）。  
  *Why*：這四項是目前確實有 cache + 需要隨 rebind 失效的。`environment` 是 per-model cache 不屬能力層重讀語意。擴充 plugin 系統是 over-engineering，新能力層加入時可 extend mode 補 list。

- **DD-13**（2026-04-20）Subagent session 與 parent session **完全獨立**的 rebind epoch 與 capability-layer cache；parent `/reload` 不連動 subagent。  
  *Alternatives*：parent 事件自動連鎖到所有 subagent；subagent 在 spawn 時繼承 parent 當前 cache。  
  *Why*：堅持 DD-1 per-session isolation 的一致性。subagent 生命週期短、通常只跑一小段 task，不需要接 parent 的 /reload 事件；反而 auto-propagate 會產生跨 session race 與 rebind storm 風險。subagent 若真的需要最新能力層，可自行呼 `refresh_capability_layer` tool。

- **DD-14**（2026-04-20）`skill-finder install` / `mcp-finder install` 完成後 runtime **不自動** bump 任何 session 的 epoch；使用者必須手動 `/reload` 才生效。  
  *Alternatives*：對所有 active session 自動 bump；只對「使用中的 session」自動 bump；對當前 foreground session 自動 bump。  
  *Why*：保持最少驚訝原則 — 安裝 skill 本身是使用者意圖性行為，他們會自己決定何時刷新。Auto-bump 會變成隱性 side effect；也需要 skill-finder 知道哪些 session 正在 active，耦合度上升。選擇簡單 = 安裝後跳一行提示「run `/reload` to activate」。

- **DD-15**（2026-04-20）既有 `mandatory-skills-preload` 的 runLoop hook **不全刪，改成轉呼叫 `CapabilityLayer.get`**（forwarder 模式）。  
  *Alternatives*：全刪、prompt.ts 直接呼 CapabilityLayer；新舊 hook 並存分工不同 cache。  
  *Why*：舊 hook 已在 prompt.ts:1649 以 try/catch 包好、log 介面齊全。改成內部呼 `CapabilityLayer.get(sessionID, epoch)`，cache 命中 = 瞬間 return（零 I/O），cache miss = trigger reinject。call site 完全不動，mandatory-skills.ts 與新 capability-layer.ts 在同一條 lookup 鍊上協作。避免大範圍重寫 runLoop 造成其他 regression。

## Risks / Trade-offs

- **R1**：per-session cache 在大量 session 並發時記憶體成長。  
  *Mitigation*：每 session 能力層 entry 總共 <1MB；如有 1000 active session 也只 ~1GB。實際活躍 session 遠低於此。若成為問題可加 LRU cap。

- **R2**：rebind storm 仍可能發生（例如 UI 抽風連發 session.resume）。  
  *Mitigation*：DD-11 rate limit + anomaly event 可觀測；UI 端也該加 debounce（Phase 2 優化）。

- **R3**：能力層刷新失敗（檔案讀錯、parser throw）導致 session 無能力層。  
  *Mitigation*：保留上一個 epoch 的 cache entry 直到新 epoch 成功讀完；若新 epoch 失敗 log + event，不取代 cache。符合 AGENTS.md 第一條 loud warn 原則。

- **R4**：UI signal 被 AI 偽造觸發無限 refresh。  
  *Mitigation*：DD-9 socket origin 驗證；DD-6 tool call rate limit；DD-11 rebind storm 偵測。

- **R5**：Slash command `/reload` 在長對話中被誤觸（例如使用者手滑）→ 計費影響零（不打 LLM），體驗影響輕微（dashboard 閃一下）。  
  *Mitigation*：實作成本低不 mitigate；若使用者抱怨再加 confirm。

- **R6**：Silent init round 邏輯跟 runLoop 部分重複（都要讀 AGENTS.md + pin skills）。  
  *Mitigation*：抽共用函式 `reinjectCapabilityLayer(sessionID)`，silent init 與 runLoop 都呼叫同一函式。

- **R7**：向後相容：既有跑到一半的 session 在 daemon 重啟後，checkpoint 還有對話層 snapshot，能力層從新讀。若新 AGENTS.md 改了 behavior（例如移除某個規則），AI 可能困惑。  
  *Mitigation*：這是預期行為（能力層更新當然影響 AI 行為）；不在 spec 範圍解決。若規範化需要 deprecation period，另案處理。

## Critical Files

### 新增

- `packages/opencode/src/session/rebind-epoch.ts` — 核心模組：epoch map、bumpEpoch API、RuntimeEvent emit、rate limit guard
- `packages/opencode/src/session/rebind-epoch.test.ts` — 單元測試
- `packages/opencode/src/session/capability-layer.ts` — 能力層 refresh 協調：讀 AGENTS.md + driver + skill + enablement、清 cache、推 event
- `packages/opencode/src/session/capability-layer.test.ts` — 單元測試
- `packages/opencode/src/tool/refresh-capability-layer.ts` — tool 定義 + handler
- `packages/opencode/src/command/reload.ts` — slash command handler
- `packages/opencode/src/server/routes/session.ts` — 新增 `POST /session/:id/resume` endpoint（或加到既有 file）
- `specs/session-rebind-capability-refresh/**` — 本 spec package
- `docs/events/event_<YYYYMMDD>_session_rebind_refresh.md`

### 修改

- `packages/opencode/src/session/instruction.ts` — `systemCache` 改 epoch-based（刪除 TTL 邏輯）
- `packages/opencode/src/session/prompt.ts` — runLoop 頂層加 epoch check；pre-loop provider switch detection 加 bumpEpoch 呼叫；能力層組裝順序調整（能力層 before checkpoint apply）
- `packages/opencode/src/session/mandatory-skills.ts` — preload 邏輯與 rebind-epoch 整合
- `packages/opencode/src/session/skill-layer-registry.ts` — 可能需要 epoch-aware invalidate（視實作走向）
- `packages/opencode/src/system/runtime-event-service.ts` — 新 event types 註冊（若有 type registry）
- `packages/opencode/src/command/index.ts` — 註冊 `/reload` slash command
- `packages/opencode/src/tool/index.ts` — 註冊 `refresh_capability_layer` tool
- `packages/app/src/**`（frontend）— session 切換發 resume signal；訂閱 `capability_layer.refreshed` 刷新面板
- `specs/architecture.md` — 新增「Capability Layer vs Conversation Layer」章節

### 刪除

- 無（本 spec 是 extend 性質，不退役任何模組）

## Data flow

```
使用者 / AI / UI 觸發 rebind event
  │
  ▼
RebindEpoch.bumpEpoch(sessionID, trigger, reason?)
  │
  ├─ rate limit check（DD-11）
  ├─ epoch map: sessionID → N+1
  ├─ 清 capability-layer cache for sessionID
  ├─ RuntimeEvent.append("session.rebind", {trigger, previousEpoch, currentEpoch, reason?})
  └─ 觸發後續 refresh（視呼叫脈絡）
      │
      ├─ Silent init round path（trigger ∈ {daemon_start, session_resume, slash_reload}）
      │   └─ CapabilityLayer.reinject(sessionID)
      │       ├─ 讀 AGENTS.md (global + project)
      │       ├─ 讀 driver prompt
      │       ├─ 讀 skill content via mandatory-skills.preload
      │       ├─ 讀 enablement.json
      │       ├─ 填入 capability-layer cache
      │       └─ RuntimeEvent.append("capability_layer.refreshed", {layers, pinnedSkills, epoch})
      │
      └─ Lazy refresh path（trigger ∈ {provider_switch, tool_call}）
          └─ 下一輪 runLoop 組裝 system prompt 時 cache miss → CapabilityLayer.reinject

runLoop（per LLM round）
  │
  ├─ epoch = RebindEpoch.current(sessionID)
  ├─ systemText = CapabilityLayer.get(sessionID, epoch) ← cache hit or miss-and-fill
  ├─ rebind checkpoint 套用（對話層壓縮）
  ├─ 組裝 system[]（systemText + skill-layer-seam）
  └─ processor.process(system[], messages)
```

## Invariants

- **I1**：同一 `sessionID` 的 capability-layer cache 只有一個 epoch 的 entry（舊 entry 在 bump 時清除）。
- **I2**：`session.rebind` 事件與 `bumpEpoch` 一對一（每次 bump 必發一個 event）。
- **I3**：刷新順序：epoch bump → cache clear → refresh（能力層）→ [如需] checkpoint apply（對話層）。
- **I4**：silent init round 絕不呼叫 LLM、不計費、不觸發 autonomous continuation。
- **I5**：`refresh_capability_layer` tool 單輪 rate limit ≤ 3 次；`bumpEpoch` 1 秒 rate limit ≤ 5 次。
- **I6**：既有 checkpoint / SharedContext 機制不讀 / 不寫能力層內容。

## Observability

- Logs（all 以 `service: "rebind-epoch"` 或 `"capability-layer"` prefix）：
  - `log.info("[rebind-epoch] bumped", { sessionID, trigger, previousEpoch, currentEpoch, reason? })`
  - `log.info("[capability-layer] refreshed", { sessionID, epoch, layers, pinnedSkills })`
  - `log.warn("[rebind-epoch] rate limit exceeded", { sessionID, trigger, windowMs, maxPerWindow })`
  - `log.error("[capability-layer] refresh failed", { sessionID, epoch, error, keptPreviousCache: true })`
- RuntimeEvents：
  - `session.rebind` （domain=workflow, level=info）
  - `capability_layer.refreshed` （domain=workflow, level=info）
  - `session.rebind_storm` （domain=anomaly, level=warn, anomalyFlags=["rebind_storm"]）
  - `capability_layer.refresh_failed` （domain=anomaly, level=error）

## Dependencies

- 既有 `RuntimeEventService` 必須能接收新 event types
- 既有 `SkillLayerRegistry` 的 pin/unpin API（無需改動）
- 既有 `MandatorySkills` 模組（本 spec 只補 wiring，不改其邏輯）
- 前端 SSE stream 需能接收新 event types（改前端訂閱 + 顯示）

## Migration Path

1. 階段 1：Core module + refactor
   - 建立 `rebind-epoch.ts` + `capability-layer.ts`
   - instruction.ts 改 epoch-based
   - runLoop 整合（能力層順序調整、pre-loop bumpEpoch）

2. 階段 2：Event sources
   - daemon startup 自動 bump
   - provider switch detection hook bumpEpoch

3. 階段 3：Explicit triggers
   - `/reload` slash command
   - `refresh_capability_layer` tool

4. 階段 4：UI silent refresh
   - server endpoint `POST /session/:id/resume`
   - 前端 session-switch 發 signal
   - 前端訂閱 `capability_layer.refreshed` 刷新面板

5. 階段 5：Architecture + event log sync

6. 階段 6：Acceptance + promotion

Phase 2 可選（未列入 Phase 1）：file mtime watcher 自動 bump。

## Open Questions（全部 resolved 2026-04-20）

- **Q1 resolved**：UI session-switch 每次都發 resume signal，由 rate limit（DD-11）+ session-busy check（DD-5）處理；debounce 列為 UI 側 Phase 2 優化。
- **Q2 resolved**：AI `refresh_capability_layer` tool call 預設允許，靠 DD-6 per-turn 3 次限制防濫用。
- **Q3 resolved**：`/reload` 列入 help panel / command palette（實作時加一行 help text，不需獨立設計）。
- **Q4 resolved**：Rebind event 借用既有 RuntimeEvent stream persist，不另開 storage（dashboard drawer 自然有歷史）。
- **Q5 resolved**（新答）：Subagent 完全獨立 — 見 DD-13。
- **Q6 resolved**（新答）：`skill-finder install` 不 auto-bump — 見 DD-14。
- **Q7 resolved**（新答）：舊 `mandatory-skills-preload` hook 改 forwarder — 見 DD-15。
- **Q8 resolved**（新答）：Silent init 與 runLoop 無 race — session-busy check 即可，見 DD-5。
