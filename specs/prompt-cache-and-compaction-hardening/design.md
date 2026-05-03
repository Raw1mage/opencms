# Design: prompt-cache-and-compaction-hardening

## Context

Current assembly path ([llm.ts:483-604](../../packages/opencode/src/session/llm.ts#L483-L604)) joins all 9 conceptual layers into a single string pushed as `system[0]`. Cache breakpoints fall on `system.slice(0, 2)` end + last 2 non-system messages ([transform.ts:225-261](../../packages/opencode/src/provider/transform.ts#L225-L261)). Result: a single-block monolithic system prompt where any dynamic part (preload / date / matched routing / skills) invalidates the whole prefix every time.

This spec relocates dynamic content out of the system role into a user-role context preface, ranks it slow-first, and places 4 cache breakpoints at deliberate stratification boundaries. Authority chain (SYSTEM > AGENTS > Driver > Skills) is preserved by structural sanitization rather than physical placement.

## Goals / Non-Goals

- Static system block achieves byte-equality across consecutive turns when (model, agent, account, AGENTS.md, SYSTEM.md, user-system) unchanged → BP1 cache hit ≥ 95%
- Preface T1 segment cache hit ≥ 80% across stable session
- Anchor message can never be misread as system authority
- Idle compaction never produces invalid Anthropic message sequences
- Capability layer rebind failure surfaces immediately, not silently degrades

### Non-Goals

- See [spec.md Out-of-scope](./spec.md#out-of-scope-explicit)

## Decisions

- **DD-1** Context preface 是獨立的 user-role 訊息，物理上放在使用者第一條真實 user message 之前，不混入使用者文字。
  - Reason: 使用者已選定（2026-05-02）。獨立 envelope 讓 telemetry / replay / sanitize 都乾淨；不污染使用者輸入歷史。
  - Consequence: 對話歷史每段以「context preface message + user text message」配對開頭；conversation 序列化、UI 顯示、subagent context 抽取都需識別這個 sentinel role 並可選擇隱藏。
  - Alternative considered: 併進首訊息 — 拒絕，會讓使用者第一句永遠帶背景文字，UI 與 history rewind 都變複雜。

- **DD-2** `Today's date` 放在 T1 段最末（緊鄰 T2 起點），不在 T1 起點。
  - Reason: 使用者已選定（2026-05-02）。跨日時 BP2 整段失效在所難免，但前面的 README / cwd / pinned-skills 仍由 BP2 涵蓋；把 date 放最末可讓「跨日 → 失效」的影響範圍縮小到 date 之後的內容。
  - Consequence: BP2 物理位置 = `Today's date` 行末。

- **DD-3** Cache breakpoint 4 個位置依 [proposal.md Breakpoint Allocation Strategy](./proposal.md#breakpoint-allocation-strategy) 配置：
  - BP1 = static system message 末尾
  - BP2 = preface 中 T1 段末尾（即 date 行末）
  - BP3 = preface 中 T2 段末尾（最後一個 active/summary skill 末尾）
  - BP4 = conversation 末段（既有行為）
  - Reason: Anthropic 上限 4 個；T3 per-turn 內容獨佔 BP 無收益。
  - Consequence: T2 為空時 BP3 省略不重新分配；保留語意位置一致性，避免 BP 含義漂移。

- **DD-4** 物理切分採「每個 tier 各成獨立 message content block」於同一 user-role message 內，而非拆成多個 message。
  - Reason: Anthropic API 接受同一 message 內多個 content block，breakpoint 可下在任一 block 末；用同一 message 可讓「context preface 本身」在歷史中是單一 entity，方便回收與 rewind。
  - Consequence: `transform.ts applyCaching` 必須能在同一 message 的非末尾 content block 上下 cache_control（目前只下在末尾，需擴充）。
  - Alternative considered: 拆成 3 個 user message — 拒絕，會稀釋「使用者第一句」的語意位置；compaction 也更難判斷哪些算 preface、哪些是 user。

- **DD-5** 使用獨立 marker role/sentinel 讓下游系統識別 context preface message：在 message metadata 加 `kind: "context-preface"`，不引入新的 protocol role。
  - Reason: 維持 OpenAI/Anthropic 標準 role 集合；用 metadata 旗標讓 compaction / replay / UI 能 opt-in 處理。
  - Consequence: `MessageV2.User` schema 需加可選 `kind` 欄位；序列化往返保留。
  - **Amended 2026-05-03 (recalibration after provider-account-decoupling 1-8 merged)**: schema field MUST be `z.optional()`；舊 session 記錄無此欄位仍能載入。`MessageV2` 在 provider-account-decoupling 期間未動，無 schema 衝突。

- **DD-6** Anchor sanitizer 採白名單 + 包裝雙重防線：
  1. 強制把整段壓縮文字塞進 `<prior_context source="{narrative|llm-agent|low-cost-server|replay-tail}">…</prior_context>` 包裝。
  2. 對開頭 token 做祈使句改寫：`/^(You must|You should|Always|Never|Do not|Rules?:|Important:|System:)/im` → 加前綴 `Note from prior context: `（保留語意但去權威感）。
  - Reason: 包裝給人類與 telemetry 一個明確邊界；改寫讓 LLM 的 attention 仍能讀內容但不會誤判為系統指令。
  - Consequence: anchor body byte 數略增（~30 字元）；少量 false positive（合法的 "You should consider X" 也會被加前綴），可接受。
  - Alternative considered: 整段拒收 + 重新請求 — 拒絕，成本高且打斷 compaction kindChain。

- **DD-7** Idle compaction 的 clean-tail precondition 用「最後 N 則 messages 中所有 tool_use 都有對應 tool_result」判斷，N = 2（最後一則 user 與最後一則 assistant 即可）。
  - Reason: 大多數 dangling 情況發生在最後一則 assistant；N=2 已涵蓋；過大 N 增加掃描成本而少有收益。
  - Consequence: 邊緣案例（subagent 多輪嵌套未 settle）若 dangling 出現在更早位置不會被偵測 — 由 idleCompaction 之外的 watchdog 處理（[liveness invariant](../../docs/feedback_liveness_invariant.md)）。

- **DD-8** CapabilityLayer cross-account fallback 改為 hard-fail；same-account 退化（cache eviction、暫時 IO 失敗）保留 fallback。
  - 判斷依據：`fallback.entry.accountId !== currentRequestedAccountId` 即 throw `CrossAccountRebindError`。
  - Reason: 跨 account 用舊 BIOS 是正確性問題（auth header / quota / model 限制都錯）；同 account 退化是可接受的暫態。
  - Consequence: 新增 error type；上層需有 retry 或 user-visible 錯誤路徑（建議：runloop 顯示「provider 切換失敗 — 請重試或檢查 account」訊息）。

- **DD-9** L9 Skill ↔ anchor 同步用「snapshot in metadata + auto-pin referenced active/summary skills」雙策略：
  - **Snapshot**：anchor.metadata.skillSnapshot = `{active: [name…], summarized: [name…], pinned: [name…]}`，純資訊用於審計與 replay。
  - **Auto-pin**：scan 壓縮 span 內所有 tool 呼叫與文字，匹配 `SkillLayerRegistry` 已知 skill name；命中且狀態為 active/summary 者，呼叫 `pin(name, reason="referenced-by-anchor-{anchorId}")`。
  - Reason: snapshot 解決 audit；auto-pin 解決 「decay 後 conversation 引用空 skill」的 runtime correctness 問題。
  - Consequence: pinned skill 不再被 idle decay 收掉，可能讓 L9 體積膨脹；以「unpin on archive」緩解 — anchor 被新 anchor supersede 時 unpin 舊 anchor 的 referenced skills。
  - **Amended 2026-05-03 (Phase A landed, Phase B recalibration)**: Phase A 已實作 auto-pin + telemetry-only snapshot（commit `caa6ef135` + 整合 wiring `abcd06ffc`）。Phase B 補 disk persistence — `MessageV2.CompactionPart` 加 `metadata: { skillSnapshot? }` optional 欄位，舊 anchor 沒有 metadata 欄位仍能解析。

- **DD-10** `shouldCacheAwareCompact` 加 cache miss diagnostic：用 `lastSystemBlockHash` session-state 比較最近 3 turn 的 hash；若 hash 變動則歸類 `system-prefix-churn`、return false；若 hash 穩定但 cache miss 持續高且 conversation tail tokens > 閾值則歸類 `conversation-growth`、return true。
  - Reason: 直接根因驅動的決策比間接訊號（cache hit rate）更穩。
  - Consequence: session 需多儲一個 `lastSystemBlockHash` 欄位（lightweight）；新 telemetry 維度 `compaction.cache_miss_diagnosis.kind`。
  - **Amended 2026-05-03**: Phase A 實作以 `system.join("\n")` 整段為 hash 對象（in-memory `cache-miss-diagnostic.ts`，commit `5360a0716`）。Phase B 改為僅 hash 純 static 區段（StaticSystemBuilder 的 hash output）— dynamic 抖動不再污染診斷訊號，churn 偵測精度提升。`recordSystemBlockHash` 接口不變，僅改餵入內容。

- **DD-11** Plugin hook 契約：保留 `experimental.chat.system.transform`（只接收 static block），新增 `experimental.chat.context.transform`（接收 ContextPrefaceParts）。一個 release 後若無 plugin 仍依賴舊 hook 注入動態內容，移除舊 hook 的 dynamic-content warn 兼容路徑。
  - Reason: 漸進遷移，避免 break 既有 plugin 生態。
  - Consequence: 一個 release 內，舊 hook 注入動態內容會 WARN log 但仍生效；之後改為 silent drop（並在 docs 標 breaking change）。

- **DD-12** Static system block 順序鎖定為 `L1 Driver → L2 Agent → L3c AGENTS → L5 user-system → L6 BOUNDARY → L7 SYSTEM.md → L8 Identity`。L9 Skill 不再進 system，移至 preface T2。
  - Reason: 與 [docs/prompt_injection.md](../../docs/prompt_injection.md) 既有層級號順序一致；BOUNDARY 仍切「情境（前 5 層）/ 權威（後 3 層）」，只是物理位置縮為純權威區。
  - Consequence: docs 必須改寫澄清「L9 Skill 在物理上位於 preface T2，不再屬於 system role」；權威鏈聲明維持原樣。
  - **Amended 2026-05-03**: 順序不變，但 driver 文字現在 per-(family, accountId) — 由 provider-account-decoupling 已 land 的 `Provider.getLanguage(model, accountId)` 與 `Auth.get(family, accountId)` 提供（[llm.ts:444-456](../../packages/opencode/src/session/llm.ts#L444-L456)）。tuple identity 必須包含 family 與 accountId，見 DD-15。

- **DD-13** Telemetry 新增 4 個事件類別：
  - `prompt.cache.system.{hit,miss}` — BP1 命中
  - `prompt.cache.preface.t1.{hit,miss}` — BP2 命中
  - `prompt.cache.preface.t2.{hit,miss}` — BP3 命中
  - `compaction.cache_miss_diagnosis` — `kind: "system-prefix-churn" | "conversation-growth" | "neither"`
  - 既有 `compaction.observed` 不變。

- **DD-14** Lite provider（`isLiteProvider` 路徑，[llm.ts:484-498](../../packages/opencode/src/session/llm.ts#L484-L498)）保持原行為（單一 lite_system_prompt），不引入 preface 機制。
  - Reason: lite 模式刻意精簡 token，加 preface 反而違背意圖。
  - Consequence: lite 模式不享有 BP2/BP3 增益；可接受，因為 lite 也不載入 skill / preload。

- **DD-15 (NEW 2026-05-03 — provider-account-decoupling 對齊)** `StaticSystemTuple` 必須將 `family` 列為第一級欄位，與 `accountId` 並列。byte-equality 比較鍵：`(family, accountId, modelId, agentName, agentsMdHash, systemMdHash, userSystemHash, role)`。
  - Reason: provider-account-decoupling 1-8 已 land，`providerId` 不再等於 family — 同一 family 下可有多 account，driver / auth header / quota 都 per-account。tuple 漏掉 family 或 accountId 會讓兩個不同 account 的 system block 誤判為相等而 cache 互污染。
  - Consequence: tuple resolver 從 (model, agent, account, role, AGENTS.md, SYSTEM.md, user-system) 派生時需呼叫 `Account.resolveFamilyFromKnown(model.providerId, await Account.knownFamilies())`；fail loud on miss。
  - Source of truth：[packages/opencode/src/account/index.ts `Account.knownFamilies` / `resolveFamilyFromKnown`](../../packages/opencode/src/account/index.ts#L250-L268)。

- **DD-16 (NEW 2026-05-03 — provider-account-decoupling 邊界守則)** Phase B 新增的 `StaticSystemBuilder` 與 `ContextPrefaceBuilder` 不得直接以 `model.providerId` 當作 `providers[X]` 的 key — 必須先轉成 family slug（per `Account.resolveFamilyFromKnown`）才存取 provider registry。
  - Reason: `provider/registry-shape.ts:assertFamilyKey` 在每個 write site 守門；繞過會在 boot guard 抛 `RegistryShapeError`。
  - Consequence: 所有 `Provider.getProvider` / `Provider.getLanguage` / `Auth.get` 呼叫必須帶 family 與（必要時）accountId 兩參。Phase A 修的 [llm.ts:444-456](../../packages/opencode/src/session/llm.ts#L444-L456) 已示範正確用法 — Phase B 新建構件比照。
  - Validation hook: `provider/registry-shape.ts` 已是 boot guard，新建構件若違反會自然 trip wire；不需要額外 lint。

## Risks / Trade-offs

- **R1 LLM 對 user-role context 的權威感受不足**：preface 雖然在 user role，但模型可能更容易忽略其指引（e.g. preload 中的「DO NOT run ls」）。Mitigation：加 STDIO-style 標註 `## CONTEXT PREFACE — read but do not echo`；在發布前用 fixed 任務跑 A/B 評估指令遵從度。如果差異 > 5%，回退或加重複申明。
- **R2 plugin 生態 break**：若有 plugin 依賴 `experimental.chat.system.transform` 注入 skill 內容，遷移期會 WARN。Mitigation：DD-11 的兼容期 + docs migration guide。
- **R3 Anthropic 4-breakpoint 上限被未來其他需求佔用**：若有第 5 個 breakpoint 需求（如 conversation 中段 anchor 加 BP），DD-3 的配置會擠壓。Mitigation：BP4 位置可彈性下放至 anchor 後而非最末訊息；保留決策空間。
- **R4 Skill auto-pin 導致 L9 膨脹**：長 session 連續 compaction 會持續 pin skill。Mitigation：DD-9 的 unpin-on-anchor-supersede；額外加 telemetry `skill.pin.count` 觀測。
- **R5 Sanitizer 誤改**：合法的「You should consider X」被加前綴。Mitigation：先做 inline + telemetry，看實際 false-positive rate 後決定是否加白名單動詞表。
- **R6 Cross-account hard-fail 在熱路徑造成 user-visible error**：DD-8 觸發後使用者會看到「provider 切換失敗」。Mitigation：runloop 加 retry；error message 給明確復原指引。
- **R7 (NEW 2026-05-03) MessageV2 schema 加 optional 欄位導致舊 session 載入錯誤**：DD-5 加 `kind` / DD-9 加 `metadata.skillSnapshot`。Mitigation：兩個欄位皆 `z.optional()`；舊 session 沒這欄位 zod 仍能解析；序列化往返測試在 B.1 phase。
- **R8 (NEW 2026-05-03) Phase 9 cutover 與 Phase B daemon restart 競爭 migration marker**：provider-account-decoupling 的 `migration-boot-guard.ts` 在 daemon 啟動時檢查 `~/.local/share/opencode/storage/.migration-state.json`；Phase B 落地後 daemon 重啟若 marker 不存在會啟動失敗。Mitigation：B.0.1 強制等 Phase 9 cutover 完成後才開動 Phase B；Phase B 自身不引入新 migration marker，僅用 feature flag。
- **R9 (NEW 2026-05-03) family 解析在新 StaticSystemBuilder 漏邊界檢查 → `RegistryShapeError`**：DD-16 要求繞 `Account.resolveFamilyFromKnown`。Mitigation：reuse [llm.ts:444-456](../../packages/opencode/src/session/llm.ts#L444-L456) 既有的（family, accountId）拉取邏輯；新建構件不重寫，組合而非平行實作。

## Critical Files

- [packages/opencode/src/session/llm.ts](../../packages/opencode/src/session/llm.ts) L483-L604 — system 組裝主流程；改為產出 static block + 新呼叫 ContextBuilder
- [packages/opencode/src/provider/transform.ts](../../packages/opencode/src/provider/transform.ts) L226-L274 — `applyCaching` 改為支援 4-breakpoint 階層配置
- [packages/opencode/src/session/preloaded-context.ts](../../packages/opencode/src/session/preloaded-context.ts) — 改為產出結構化 `PreloadParts` 而非 string
- [packages/opencode/src/session/system.ts](../../packages/opencode/src/session/system.ts) — `environment()` 拆 date 出來
- [packages/opencode/src/session/skill-layer-registry.ts](../../packages/opencode/src/session/skill-layer-registry.ts) — 暴露 `pinForAnchor(name, anchorId, reason)`、`unpinByAnchor(anchorId)`
- [packages/opencode/src/session/compaction.ts](../../packages/opencode/src/session/compaction.ts) — `_writeAnchor` 加 sanitizer；`idleCompaction` 加 clean-tail gate；`shouldCacheAwareCompact` 加 diagnostic
- [packages/opencode/src/session/capability-layer.ts](../../packages/opencode/src/session/capability-layer.ts) L155-L196 — `findFallbackEntry` + `get` 加 cross-account 檢查
- 新檔 [packages/opencode/src/session/context-preface.ts](../../packages/opencode/src/session/context-preface.ts) — 組裝 `ContextPrefaceParts`，包含 T1/T2 ranking 邏輯
- 新檔 [packages/opencode/src/session/anchor-sanitizer.ts](../../packages/opencode/src/session/anchor-sanitizer.ts) — DD-6 兩段邏輯
- [packages/opencode/src/plugin/index.ts](../../packages/opencode/src/plugin/index.ts) — 註冊 `experimental.chat.context.transform`
- [docs/prompt_injection.md](../../docs/prompt_injection.md) — 主圖改寫
- 新檔 [docs/prompt_dynamic_context.md](../../docs/prompt_dynamic_context.md) — preface 架構說明

## Validation Strategy

- **Unit**: anchor sanitizer 對抗性輸入；clean-tail detector；cache miss diagnostic；breakpoint allocator；context preface assembly determinism。
- **Integration**: 10-turn 模擬 session 量測 BP1/BP2/BP3 命中率；rebind 跨 account loader 失敗路徑；idle compaction 在 dangling tool_use 場景 defer。
- **A/B（手動）**: 在開發環境用同一任務測試「preface 在 user role」vs 「dynamic 留 system」對指令遵從度的差異；觀察 R1。
- **Telemetry sanity**: 上線後第一週監測 `compaction.idle.deferred` 觸發率（預期 < 5% 的 idle 評估）、`prompt.cache.system.miss` 比例（預期 < 5%）、`compaction.cache_miss_diagnosis` 分布。

## Migration / Rollout

- **Phase A** — 純機制硬化（DD-6 / DD-7 / DD-8 / DD-9 / DD-10）：**已 land 2026-05-03**（merge `002e77b26` + DD-9 wiring `abcd06ffc`）；與 9 層架構正交，可獨立合併、獨立回退。
- **Phase B** — 物理重排（DD-1 ~ DD-5 / DD-11 / DD-12 / DD-13 / DD-14 / DD-15 / DD-16）：先 feature-flag 包裹 (`OPENCODE_PROMPT_PREFACE=1`)，內部 dogfood 一週後預設開啟。tasks.md §8 持有完整 task 樹 B.0 → B.11。
- **Phase B 啟動前置條件**（per R8）：
  1. provider-account-decoupling Phase 9 cutover 完成（migration marker 存在、daemon 已啟用新 binary、smoke test 通過、push 完成）。否則 Phase B 後續 daemon restart 會被 boot guard 拒收。
  2. Phase A telemetry 至少累積 1 週數據；判斷 Phase B 預期收益是否值得投入（若 `compaction.cache_miss_diagnosis.kind=system-prefix-churn` 比例本來就低，Phase B 收益縮水）。
- **Rollback**: Phase B 可單獨關 `OPENCODE_PROMPT_PREFACE` flag 回到舊 join 行為；Phase A 各 DD 獨立 revert（已 land，僅作為紀錄）。

## Open Questions

無 — preface envelope（DD-1）與 date 位置（DD-2）使用者已選定。

## Cross-References

- [proposal.md](./proposal.md) — Why / Scope / Breakpoint Allocation Strategy
- [spec.md](./spec.md) — GIVEN/WHEN/THEN
- [compaction-redesign/design.md](../compaction-redesign/design.md) — kindChain 與 anchor write 既有契約
- [session-rebind-capability-refresh/design.md](../session-rebind-capability-refresh/design.md) — RebindEpoch + CapabilityLayer 既有契約
