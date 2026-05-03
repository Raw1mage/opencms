# Proposal: prompt-cache-and-compaction-hardening

## Why

當前 9 層 system prompt 把 static 與 dynamic 內容混雜在同一個 system role 中，被 join 成單一字串送入 `system[0]`，cache breakpoint 只下在末尾（[transform.ts:225-228](../../packages/opencode/src/provider/transform.ts#L225-L228)）。**dynamic 內容並不需要 system role 的兩個核心特權**（前綴 cache + 高權威），但被鎖在 system 裡，反而讓兩個特權都失效：

| 層 | 為什麼是 dynamic | 真的需要 system 權威嗎 |
|---|---|---|
| **L3a Preload** | cwd / README / skill_context 每 turn 可能變 | 否，是 ambient context |
| **L3b 的 date** | 日級變動 | 否，純資訊 |
| **L4 matched routing** | 每 turn 關鍵字變 | 否，本質是 routing hint |
| **L9 Skill content** | active/summary/unloaded 跳變 | 半否，是按需領域知識 |

**任何一處 dynamic 變動就讓整段 system prefix cache 失效**。這直接污染 `shouldCacheAwareCompact`（[compaction.ts:324-357](../../packages/opencode/src/session/compaction.ts#L324-L357)）的判斷依據 — 真正元兇是 system prompt 抖動，但 compaction 卻去壓縮 conversation，治錯病。

同時，分析 12 種 compaction 機制時發現四個會破壞 conversation 中應保留之固定資訊的 bug 類別：

1. **Anchor message 在 conversation 層 shadow L7** — `tryNarrative` / `tryLlmAgent` 把壓縮文字直接寫入 history，無 format gate。
2. **CapabilityLayer reinject 失敗 silent fallback 至上一個 epoch** — [capability-layer.ts:185-196](../../packages/opencode/src/session/capability-layer.ts#L185-L196) 違反 AGENTS.md「no silent fallback」。
3. **Idle compaction 未檢查 dangling tool_use** — [compaction.ts:432-451](../../packages/opencode/src/session/compaction.ts#L432-L451) 可能切壞 tool_use/tool_result 配對。
4. **L9 Skill 與 anchor desync** — Skill decay 獨立於 compaction，narrative 折疊後 skill 可能 unload，conversation 引用空 skill。

## Original Requirement Wording (Baseline)

- "建立 prompt compaction optimization plan。目標：(1) 重排 prompt layer 使 static 集中；(2) 修改 compaction 機制使固定資訊不被破壞"
- 後續澄清："prompt 真的有需要這麼多層嗎？如果是動態資訊就不一定要固定留一層給它了。" → 選定路線 B（精簡 system + dynamic 下放）。

## Requirement Revision History

- 2026-05-02: initial draft created via plan-init.ts
- 2026-05-02 v1: 「分段 + breakpoint 維持 9 層」（路線 A）
- 2026-05-02 v2: 改採路線 B — system 縮為純 static prelude，dynamic 內容下放到 user message / tool description / 獨立 context message
- 2026-05-02 v3 (現行): dynamic context 內部再依變動頻率分層（session-stable / decay-tier / per-turn），延長 cacheable prefix 至 dynamic 區段內部

## Effective Requirement Description

1. **system role 僅承載 static 內容**：只剩 L1 Driver / L2 Agent / L3c AGENTS / L5 User-system / L6 Boundary / L7 SYSTEM / L8 Identity 七個 always-static-within-session 層。
2. **dynamic 內容下放到 user role 或工具層，並依變動頻率分層排序**（slowest-first 以延長 cacheable prefix）：

   | 階層 | 內容 | 典型變動頻率 | 物理位置建議 |
   |---|---|---|---|
   | **T1 session-stable** | README 摘要、cwd 列表、pinned skills、`Today's date` | 一次 session 內幾乎不變 | 首 user message preface 前段 |
   | **T2 decay-tier** | active / summarized skills（10 / 30 min idle 邊界） | 每 10–30 min 跳變 | 首 user message preface 後段 |
   | **T3 per-turn** | matched routing、當前 turn 觸發的 ad-hoc context | 每 turn 變 | 當前 user turn 內聯，或工具 description prefix |

   原則：T1/T2 集中在「首 user message preface」單一物理載體，內部 slow-first 排序；T3 隨對應 user turn 自然移動。
3. **保留 L6 BOUNDARY 安全語意**：權威鏈（SYSTEM > AGENTS > Driver > Skills）不變，僅物理載體從 system 切換為 user-role context message。
4. **修補四個 compaction bug**：
   - anchor sanitizer：壓縮輸出進入 conversation 前包裝 `<prior_context>` XML、過濾祈使句
   - idle precondition：最後一則 assistant 必須是 clean turn（無未配對 tool_use）
   - CapabilityLayer cross-account fallback 改為 hard-fail
   - L9 Skill ↔ anchor 同步：narrative 寫入時 pin 涉及的 skill，或將 L9 snapshot 嵌入 anchor metadata
5. **`shouldCacheAwareCompact` 加診斷分流**：cache miss 先區分 system prefix churn vs conversation growth，前者不觸發 compaction。
6. **plugin hook 契約調整**：`experimental.chat.system.transform` 的呼叫者重新清點，必要時提供新 hook（例如 `experimental.chat.context.transform`）給 dynamic 內容使用。

## Scope

### IN

- `llm.ts` system 組裝邏輯重構：`systemPartEntries` 縮減為 7 個 static 層
- 新增 dynamic context message 組裝路徑：preload / date / matched routing / skill 各有承載位置
- `transform.ts applyCaching`：實作 4-breakpoint 階層分配（見下方 Breakpoint Allocation Strategy）
- Compaction anchor sanitizer
- Idle compaction precondition gate
- CapabilityLayer cross-account fallback hard-fail
- L9 Skill ↔ anchor 同步機制
- `shouldCacheAwareCompact` 診斷分流
- 新 telemetry：`prompt.cache.system.hit/miss`、`prompt.cache.preface.hit/miss`
- Plugin hook 契約清點 + 必要時新增 `experimental.chat.context.transform`
- [docs/prompt_injection.md](../../docs/prompt_injection.md) 9 層圖示改寫為「7 static system + N dynamic context」雙軌架構

### OUT

- L6 BOUNDARY 移除或改變語意 — 安全屏障保留（僅承載位置可能變化）
- L7 SYSTEM.md 內容改寫 — 憲法不動
- Compaction kindChain 結構調整 — 已由 `compaction-redesign` 處理
- 跨 provider compaction 文字 sanitize（Bug-6，LOW 暫緩）
- Hybrid LLM 背景任務 race（Bug-5，LOW 暫緩）
- Conversation history 壓縮算法本身的精度提升

## Non-Goals

- 不重新設計權威鏈（SYSTEM > AGENTS > Driver > Skills 不變）
- 不取代 `compaction-redesign` / `compaction-improvements` 既有設計，僅補強
- 不改變 cache provider 的選用邏輯（Anthropic ephemeral / Bedrock cachePoint / OpenRouter）
- 不引入新的 prompt 概念層（只是把現有 9 層的物理載體重排）

## Constraints

- Anthropic 單 request 最多 4 個 cache breakpoint
- L6 BOUNDARY 必須維持「情境內容不可 override 權威規則」的語意分隔，即使物理位置改變
- 不可破壞 `useInstructionsOption` 路徑（Codex Responses API 走 `instructions` 欄位、Anthropic OAuth 走單一 user role）
- Plugin hook 呼叫者契約變更需向後相容或顯式 deprecation 公告
- 不可破壞 `compaction-redesign` 的 DD 鎖定決議
- AGENTS.md 第一條：禁止靜默 fallback
- LLM 對 user-role 內容的權威感受需經實測驗證（dynamic context 下放後不能讓模型忽略 skill/preload 指引）

## What Changes

- **`llm.ts`**: `systemPartEntries` 縮減為 7 個 static 層；新增 `contextPartEntries` 組裝 dynamic 內容
- **`transform.ts applyCaching`**: 同時在 system 末尾與首 user (含 preface) 末尾下 breakpoint
- **`session/preloaded-context.ts`**: 改為產生 user-role message 而非 system 字串
- **`session/system.ts`**: `environment()` 拆 date 出來
- **新檔 `session/dynamic-context.ts`** (建議): 統一組裝 preload / date / matched routing / skill 為單一 user-role context message
- **`compaction.ts`**: anchor write 前加 sanitizer；`idleCompaction` 加 precondition；`shouldCacheAwareCompact` 診斷分流
- **`capability-layer.ts`**: `findFallbackEntry` 加 cross-account 檢查
- **`skill-layer-registry.ts`**: 與 anchor 同步機制
- **新 telemetry 事件**：`prompt.cache.system.{hit,miss}`、`prompt.cache.preface.{hit,miss}`、`compaction.cache_miss_diagnosis`
- **Plugin hook**: 視清點結果決定是否新增 `experimental.chat.context.transform`
- **Docs**: [docs/prompt_injection.md](../../docs/prompt_injection.md) 改寫；新增 `docs/prompt_dynamic_context.md` 說明 user-role 承載架構

## Breakpoint Allocation Strategy

Anthropic 單 request 最多 4 個 ephemeral cache breakpoint。配置如下：

| BP | 位置 | 涵蓋區段 | 失效時機 |
|---|---|---|---|
| **BP1** | static system 末尾 | L1 + L2 + L3c + L5 + L6 + L7 + L8 | 換 model / 換 agent / 換 account / SYSTEM.md 改 / AGENTS.md 改 |
| **BP2** | T1 session-stable 末尾 | BP1 + README 摘要 + cwd 列表 + pinned skills + date | T1 內任一項變動（cwd 檔案增刪、midnight、pin/unpin） |
| **BP3** | T2 decay-tier 末尾 | BP2 + active / summarized skills 內容 | skill idle decay tick（10 / 30 min 邊界） |
| **BP4** | conversation 末段（最末非-system message） | 全部 | 既有行為，每 turn 自然推進 |

T3 per-turn 內容（matched routing 等）落在 BP3 與 BP4 之間，無專屬 breakpoint — 這是設計取捨：T3 本就 per-turn 變動，獨佔 BP 也無 cache 收益，留給 BP4 對齊 conversation 推進反而較有效。

## Capabilities

### New Capabilities

- **純 static system prefix**：session 內 system block 接近 100% cache hit
- **dynamic context message**：dynamic 內容隨 user turn 自然移動，不污染 system cache
- **anchor sanitizer**：壓縮輸出強制 XML 包裝 + 祈使句過濾
- **idle precondition gate**：tool_use/tool_result 配對檢查
- **cache miss diagnostic**：區分 system prefix churn 與 conversation growth
- **L9 ↔ anchor 同步機制**：narrative 寫入時 freeze 涉及的 skill

### Modified Capabilities

- **L1-L8 (除 L4)**：物理上仍在 system role，但組裝路徑改為單一 static prelude
- **舊 L3a / L3b date / L4 / L9**：物理上下放到 user role 或 tool description；概念上仍存在於 [docs/prompt_injection.md](../../docs/prompt_injection.md) 的層級定義
- **CapabilityLayer.get**：cross-account fallback 改為 throw
- **compaction.run**：寫入 anchor 前必經 sanitizer
- **shouldCacheAwareCompact**：cache miss 分類後決定觸發
- **Plugin `experimental.chat.system.transform`**：仍可修改 system 陣列，但內容不再包含 dynamic 部分；可能新增 `experimental.chat.context.transform` 對應 dynamic 部分

## Impact

- **影響檔案**：`packages/opencode/src/session/llm.ts`、`packages/opencode/src/provider/transform.ts`、`packages/opencode/src/session/compaction.ts`、`packages/opencode/src/session/capability-layer.ts`、`packages/opencode/src/session/skill-layer-registry.ts`、`packages/opencode/src/session/preloaded-context.ts`、`packages/opencode/src/session/system.ts`，新檔 `packages/opencode/src/session/dynamic-context.ts`
- **影響行為**：
  - cache hit rate 預期顯著提升（system block 接近 100%）
  - compaction 觸發頻率預期下降（cache miss 分流後排除 system churn 假性訊號）
  - rebind 失敗從 silent degraded 改為顯性錯誤
  - LLM 對 dynamic 指引的遵從度需驗證（user-role 是否仍有足夠權威）
- **影響 telemetry**：新增分區段 cache 命中事件；既有 `compaction.observed` 增加 diagnostic 維度
- **影響 docs**：[docs/prompt_injection.md](../../docs/prompt_injection.md) 主圖改寫；新增 dynamic context 文檔
- **影響 plugin 生態**：呼叫 `experimental.chat.system.transform` 的 plugin 需重新評估；若依賴 dynamic 內容在 system 中，需遷移到新 hook
- **上游相依**：[compaction-redesign](../compaction-redesign/) (verified)、[compaction-improvements](../compaction-improvements/) (verified)、[session-rebind-capability-refresh](../session-rebind-capability-refresh/) (living)
- **下游相依**：未來新增 prompt 內容必須先回答「static or dynamic？」決定承載 role；新增 plugin 必須選擇正確的 hook
