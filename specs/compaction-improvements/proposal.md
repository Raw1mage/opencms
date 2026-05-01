# Proposal: compaction-improvements

Single coherent proposal covering all 2026-04-30 audit findings on the
compaction subsystem. Sits on top of [`compaction-redesign`](specs/compaction-redesign/)'s
seven-to-four refactor (currently `implementing`) and extends the trigger
layer + kind-routing layer per two load-bearing principles.

## Why

The 2026-04-30 audit produced a long list of holes in the current
compaction logic, traceable to two design gaps:

- **Trigger layer**: `deriveObservedCondition` ([`prompt.ts:239`](packages/opencode/src/session/prompt.ts#L239))
  is event-driven and post-hoc. It cannot predict cache loss, ignores
  account-switch at high ctx, has no stall-recovery path, and ignores
  quota-window pressure.
- **Kind-routing layer**: `KIND_CHAIN` ([`compaction.ts:711-719`](packages/opencode/src/session/compaction.ts#L711-L719))
  is a static cost-monotonic table that ignores provider economics.
  Codex subscription users get narrative-first ordering despite kind 4
  being effectively free for them. Codex Mode 1 inline `context_management`
  is wholly unwired.

The user collapsed the discussion to two durable principles
([`feedback_compaction_two_principles.md`](file:///home/pkcs12/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_compaction_two_principles.md)):

1. **Codex 善用 server-side compaction** (Mode 1 inline + Mode 2 chain
   priority for subscribers)
2. **預測 cache lost 且 ctx > 50% → 立即 compaction** (state-based
   predicate, fixpoint-stable via ctx gate)

Plus a list of edge bugs that should be cleaned up alongside:

- Compaction child runloop crashes on `No user message found in stream`
  ([`prompt.ts:1455`](packages/opencode/src/session/prompt.ts#L1455))
- `Cooldown` is in-memory `Map`; daemon restart can re-fire compaction
  within seconds; also queried in two places that can drift
- `emptyRoundCount` is in-memory; restart loses stall-recovery accounting
- `narrative` reports `ok` regardless of TurnSummary coverage; paid kinds
  skipped when narrative is silently lossy
- `provider-switched` chain has only one kind (no fallback if narrative
  fails)
- After rebind doesn't apply, `lastFinished.tokens.input` is stale and
  feeds `isOverflow` / `shouldCacheAwareCompact` with wrong numbers

Triggering observable: session `ses_221cdc5a4ffe9` round 761 — codex
gpt-5.5, 279 messages, two consecutive zero-token responses, self-heal
fires once and gives up. Combined with the screenshot showing
`Compaction failed: No user message found in stream`. Both symptoms have
their root cause inside this proposal's scope.

## Original Requirement Wording (Baseline)

User over the course of 2026-04-30 conversation:

> "我認為是 context size 問題。對單一 account 而言，正常對話累積到 95% 並不
> 是什麼問題，因為有 cache。但是一旦發生 daemon restart, account switch 等
> rebind 事件，失去了 cache，高達 90% 以上的 context 瞬間變成一個炸彈。"

> "用『只要失去 cache』來介定 compaction 時機太過武斷。因為 compaction 本身
> 也會失去 cache，不能自我循環。"

> "沒辦法預查，就只能自己精準管理了。"

> "我好像很久沒看到 server side compaction 了。我現在恒常使用 codex，應該
> 要以 server side compaction 為主才划算"

> "至少 server-side compaction 在 context 很滿的時候可以優先用（如果 provider 是 codex）"

Final consolidation:

> "1. codex 善用 server-side compaction
> 2. cache 發生 lost 的時候且 context 大於 50% 要馬上 compaction"

> "你用一個 compaction spec 來處理這一切吧？為什麼要切那麼多 spec"

## Requirement Revision History

- 2026-04-30 v1: 初始 5 spec 切割版（cache-loss-aware-compaction +
  codex-server-compaction-priority + mode1-inline + narrative-quality-gate
  + state-persistence）
- 2026-04-30 v2: **整併**——使用者指示用單一 spec 處理一切；五份合併為本
  份 `compaction-improvements`；舊 5 份目錄已刪。內容無遺失，本檔涵蓋全部。
- 2026-04-30 v3: 加入 **Part 4 — Runloop in-turn 工具輸出消化**（原 Part 4
  Telemetry 順延為 Part 5）。源自使用者指出 runloop「爬一大包 raw data 累積
  進對話、事後才 compact」的設計，方向是讓 LLM 在每一 turn 結束前主動消化掉
  自己拿到的 tool output。
- 2026-05-01 v5: 加入 **Part 6 — Big content boundary handling**。涵蓋兩
  條對稱路徑：(1) user upload（截圖 / 大檔貼進 user message）；(2) Task
  tool subagent return（subagent 結束、整大段報告當 tool_result 倒回 main）。
  兩條都用同一機制——boundary-time 攔截 + KV 存放 + ref-and-query tool；
  raw 內容從不進 main context。Worker 透過 6.0 helper 走既有但休眠的
  small-model 框架（預設指向 session SSOT model 啟用之）。新工具
  `vision_query` / `file_digest` / `task_result_query` 沿用 background
  worker pattern——無 subsession、無 UI、不計入 coding agent 上限。
- 2026-05-01 v4: **撤回 digest 機制，Part 4 縮編為純 budget surfacing**。理
  由：使用者明確界定 runtime 責任邊界——「runtime 的責任就是設一個安全邊界，
  context 真的要爆的時候還是得處理」。digest 是 runtime 為 LLM 預設工作流
  （何時消化、何時 drop raw、何時 expand），違反「LLM 自治、harness 不規範
  實作細節」的一貫立場（同 `feedback_orchestrator_verbosity` /
  `feedback_silent_stop_continuation` / `feedback_autonomous_methodology`）。
  砍掉 Part 4.1-4.8（digest meta-tool / 三層接力定位 / 漸進啟用 Phase A-D
  等），只保留 4.0 (budget surfacing)——這是讓 LLM 自治的**前置資訊**，不是
  規範。LLM 自己決定怎麼用 context、要不要在 assistant 訊息裡寫總結；當它
  真的做得不夠好導致 ctx 要爆時，Part 1-3 的 daemon-side compaction 兜底。
  砍掉的 Open Questions Q14-Q19 同步移除。

## Effective Requirement Description

Six parts，全部都是 **runtime 的安全邊界職責**——不規範 LLM 工作流、只給
資訊與兜底：

- **Part 1 觸發層**（principle 2: 何時 compact）
- **Part 2 執行層**（principle 1: 用哪個 kind / 接通 Mode 1）
- **Part 3 邊角清理**（既有 bug 集合）
- **Part 4 Context budget surfacing**（把 daemon 已知的 server 真值傳達給 LLM；純資訊管道）
- **Part 5 telemetry**（共用觀測）
- **Part 6 Big content boundary handling**（user upload + subagent return 兩條對稱路徑，boundary-time 路由 + KV + background worker tool；raw 從不進 main context）

設計原則（v4 立下）：

> Runtime 的職責是**設一個安全邊界**——把已知的數字告訴 LLM、context 真的
> 要爆的時候用 compaction 兜底。**不替 LLM 設計工作流**（何時消化資訊、何
> 時批次 toolcall、何時 drop 哪些東西）——這些是 LLM 自己的判斷。

---

### Part 1 — 觸發層（principle 2: cache lost + ctx>50% → compact）

**1.1 CacheStateTracker (new module)**

Per-session state mirroring provider cache behaviour locally:

```
CacheState {
  lastPrefixHash: sha256       # hash of last successfully-cached prefix bytes
  lastSentAt: number           # wall-clock ms
  lastResponseId: string?      # codex previous_response_id
  ttlSeconds: number           # default 270 (under 300s provider TTL)
}
```

API:
- `record(sessionID, prefixHash, sentAt, responseId, cacheReadTokens)` — call
  on every round; only commits hash when `cacheReadTokens > 0`
- `predictMiss(sessionID, intendedPrefixHash, now) → "miss" | "hit" | "unknown"`
- `invalidate(sessionID, reason)` — explicit hooks for chain rejects

Hash boundary aligns with the provider's cache breakpoint (Anthropic: up
to last `cache_control` marker; codex Responses: full prefix). Pinned in
`designed`.

**1.2 Trigger inventory (replaces the 9-cell ad-hoc matrix)**

Walk in precedence order; first match fires:

```
A1 overflow              (existing isOverflow)
A2 provider-switched     (existing)
A3 continuation-invalidated (existing)
C1 manual /compact       (existing)
A4 stall-recovery        ← NEW — K consecutive zero-token rounds at high ctx
C2 auto compaction-request (existing)
B1 predicted cache miss  ← NEW — CacheStateTracker.predictMiss == "miss" + ctx > 0.50
B3 quota-window pressure ← NEW — rate_limits remaining_ratio < 0.10 + ctx > 0.50
B2 observed cache miss   (existing shouldCacheAwareCompact, demoted to fallback)
```

Boundary guards (apply to all triggers, not just new ones):
- `lastUser` exists in stream → closes [`prompt.ts:1455`](packages/opencode/src/session/prompt.ts#L1455)
- `lastFinished.id` is the most recent assistant message (no fire mid-turn)
- `Cooldown.shouldThrottle == false`
- Not inside a compaction child runloop
- For subagents: C1 manual suppressed (DD-12 existing)

Disqualified (stay non-triggers): daemon restart, account switch alone,
periodic, tool-output prune.

**1.3 Account-switch fix**

[`prompt.ts:303-313`](packages/opencode/src/session/prompt.ts#L303-L313)
unconditional `return null` is removed. Account drift continues to invalidate
the continuation chain (existing fire-and-forget call), then proceeds to
predicate evaluation. At low ctx B1 returns false → no compaction (parity
with current intent). At high ctx B1 fires → compaction (the bug-fix).

**1.4 Firing rules**

- B1: `predictMiss == "miss" AND ctx_ratio > tweaks.compaction.cache_loss_floor (0.50) AND predicted_uncached_tokens > tweaks.compaction.min_uncached_tokens (40_000)`
- A4: `consecutive_empty_rounds >= tweaks.compaction.stall_recovery_consecutive_empty (2) AND ctx_ratio > tweaks.compaction.stall_recovery_floor (0.50)`
- B3: `rate_limits.window.remaining_ratio < tweaks.compaction.quota_pressure_threshold (0.10) AND ctx_ratio > tweaks.compaction.cache_loss_floor`

`predictMiss == "unknown"` → conservative direction; do not fire B1, fall
through to B2.

A4 must NOT trigger on legitimate autonomous-loop silence (memory:
`feedback_silent_stop_continuation`) — discrimination via `lastUser` source
classification, refined in `designed`.

---

### Part 2 — 執行層（principle 1: codex 善用 server-side compaction）

**2.1 Mode 1 inline `context_management` 接通**

Every outbound codex `/responses` request gains
`context_management: [{type: "compaction", compact_threshold: N}]` when the
auth is OAuth subscription. Default `N = tweaks.compaction.codex_inline_threshold_tokens (100_000)`.

Compaction items in response output are preserved in the conversation
stream — they ARE the canonical compacted context per
[`codex-compaction.ts:16-18`](packages/opencode/src/provider/codex-compaction.ts#L16-L18)
(MUST NOT prune). New `MessageV2.CompactionItemPart` type or repurposed
shape, decided in `designed`.

A Mode 1 fire updates the same anchor-time field consumed by `Cooldown`,
so client-side triggers don't fire on top of server-side work.

API-key codex users default OFF (kind 4 is real money for them); opt-in
via tweaks.cfg flag.

**2.2 Mode 2 (kind 4) chain priority for codex subscription**

`KIND_CHAIN` static record becomes `resolveKindChain(observed, providerId,
isSubscription, ctxRatio)`. Default identical to current. Codex+OAuth+ctx>
`tweaks.compaction.codex_server_priority_ratio (0.70)` reorders:

```
overflow / cache-aware:  low-cost-server → narrative → replay-tail → llm-agent
manual:                  low-cost-server → narrative → llm-agent
```

Single move (not duplicate insertion); local kinds remain as fallback when
kind 4 fails.

API-key codex users keep current ordering.

**2.3 Narrative quality gate**

`narrative` currently reports `ok: true` regardless of TurnSummary coverage.
Add a `coverage` metric: `(turns with TurnSummary captured) / (total
non-narration turns since last anchor)`. Below
`tweaks.compaction.narrative_min_coverage (0.6)`, narrative reports
`{ok: false, reason: "low coverage"}` and chain falls through to next kind.

Truncation flag accuracy: narrative must set `truncated: true` whenever
content is dropped to fit budget — current behaviour silently drops without
flagging, defeating
[`compaction.ts:1515`](packages/opencode/src/session/compaction.ts#L1515)
escalation. Fixed alongside coverage gate.

---

### Part 3 — Edge cleanups annex

**3.1 Cooldown persistence + single source of truth (C2 + C4)**

`Cooldown` in-memory `Map` becomes anchor-time-derived (already partial
under `compaction-redesign` phase 13 DD-13). Remove the second query site
in [`prompt.ts:261`](packages/opencode/src/session/prompt.ts#L261); rely
on the single `Cooldown.shouldThrottle()` invoked once per `run()` entry.

Persistence: anchor message in stream IS the durable cooldown source —
already persisted via Session storage. No new disk file needed.

**3.2 emptyRoundCount persistence (A7)**

[`prompt.ts:1481-1482`](packages/opencode/src/session/prompt.ts#L1481-L1482)
`emptyRoundCount` runloop-local variable becomes persisted via session
runtime state (or derived from stream — count consecutive trailing
zero-token assistant messages). Daemon restart no longer resets the
stall-recovery counter.

**3.3 provider-switched chain fallback (B5)**

[`compaction.ts:717`](packages/opencode/src/session/compaction.ts#L717)
single-element chain `["narrative"]` extends to `["narrative", "replay-tail"]`.
If narrative fails (e.g. no TurnSummary captured pre-switch), tail-keep is
better than silent failure.

**3.4 Stale `lastFinished.tokens.input` after no-rebind-applied (C5)**

[`prompt.ts:1822-1830`](packages/opencode/src/session/prompt.ts#L1822-L1830)
only refreshes tokens when `result.applied`. Extend the refresh to also
fire for `result.reason === "no_anchor"` and `"unsafe_boundary"` — recompute
`tokens.input` from `estimateMsgsTokenCount(msgs)` whenever rebind is
considered, regardless of outcome.

**3.5 Continue × stall-recovery race (C6)**

A4 firing AND `INJECT_CONTINUE: true` for the resulting `cache-aware` /
`overflow` follow-up could spawn a fresh empty round on top of stall
recovery. Resolution: when A4 fires, resulting compaction has
`INJECT_CONTINUE: false` regardless of normal observed-condition mapping.
Refines existing
[`INJECT_CONTINUE` table](packages/opencode/src/session/compaction.ts).

---

### Part 4 — Context budget surfacing

當前架構下 LLM 完全看不到自己的 ctx 用量（system prompt 八個 block 全無
budget 資訊；歷史 message 的 `tokens.*` 是 DB metadata，不會序列化進 wire
format）。過去四個月 compaction 能 work 是 **daemon-decided**（system 在
旁邊量數字、超過閾值就替 LLM 收一收），LLM 完全被動。

Daemon 兜底（Part 1-3）會持續存在，但讓 LLM 自己看得到自己的 ctx 狀態仍有
價值——它可以據此調整自己的工作節奏（少打幾個工具、提早收斂、在 assistant
訊息裡寫總結讓後續 narrative kind 捕捉等）。Runtime **不替 LLM 設計工作流**，
只把已知數字傳達給它。

注意：本 Part 純粹是**資訊管道**，不引入 digest meta-tool、不約束 LLM 行
為、不教它「該怎麼做」。LLM 看了數字之後自己決定。

**4.1 數字來源：純 server-confirmed，不本地估算**

Surface 給 LLM 的數字**只用 provider response 帶回來的 `usage` 真值**——
即 `lastFinished.tokens.input` / `cache.read` 等已存在 DB 的欄位。**不
做本地 token estimation 來補齊「現在」**。

理由：本地估算（字元/4 之類）跟 server tokenizer 偏差 5-15%，每個
provider 偏差方向不同，餵給 LLM 反而誤導判斷。LLM 對 budget 的反應顆粒度
本來就是分檔（4 檔、25% 間距），server 真值的「上一輪結束時快照」精度遠
超這個顆粒度需求。

代價：LLM 看到的數字永遠標 `as_of: end_of_turn_N-1`，不是當下這一輪要送
出去前的瞬時值。一輪內塞進來的新 user message / 新 tool outputs 不反映
在數字上。可接受，理由：
- 一輪內 LLM 自己累積的 tool output 它本來就感覺得到（自己讀了什麼檔、
  grep 了什麼結果），不需要數字
- 真正會打到 LLM 的「累積失控」是跨多輪的，server 數字一輪後就跟上
- 萬一單輪暴漲（讀 50K 行檔案）導致下一輪 status 跳兩檔，LLM 看到 red
  就會收手——遲到一輪沒爆就好

**4.2 注入位置（cache-safe）**

不可以塞進 system prompt：system prompt 必須穩定才能命中 prefix cache，
每輪變動的 budget 資料會把整個 cache 從那一格炸到底。注入點選在 **最後一
則 user message 的 envelope**——這個位置本來就是每輪變動處（cache 必然在
此前已經斷開），多塞一段不額外破任何 cache：

```
<user message wire format>
  <content>...使用者實際輸入...</content>
  <context_budget>            ← 新增 envelope sub-block
    window: 272000
    used: 187432              ← server 真值，從 lastFinished.tokens.input 抄
    ratio: 0.69
    status: yellow
    cache_read: 162000        ← server 真值
    cache_hit_rate: 0.87
    as_of: end_of_turn_N-1    ← 明確標時間點，不假裝是「現在」
  </context_budget>
</user message>
```

所有欄位都是上一輪 response.usage 的直接抄寫；無 delta、無估算。

對 codex Responses API：作為 user message 的尾部段落附加。
對 Anthropic：作為同一 message 內 `cache_control: {type: "ephemeral"}`
*之後* 的內容（如果使用 explicit breakpoint）；不使用 explicit breakpoint
時直接附加。

**4.3 自動 runtime-self-heal nudge 也要帶上**

當前 [`prompt.ts` runtime-self-heal nudge](packages/opencode/src/session/prompt.ts)
（自動補刀的 user message）不帶 budget——這正是 ses_221cdc5a4ffe9 round 761
連續空回應後 LLM 沒有判斷依據的部分原因之一。runtime-self-heal 注入時
budget block 同步注入。

**4.4 Status 分檔**

LLM 對純數字反應慢，分檔 label 比裸數字易讀。**只給狀態 label，不附行動建議**
——runtime 不規範 LLM 工作流，行為由 LLM 自己決定。

| Status | ctx_ratio | 含義 |
|---|---|---|
| `green` | < 0.50 | ample budget |
| `yellow` | 0.50-0.75 | half consumed |
| `orange` | 0.75-0.90 | context tight |
| `red` | > 0.90 | near limit; system compaction likely on next round |

閾值放 [tweaks.cfg](etc/opencode/tweaks.cfg) `compaction.budget_status_thresholds`，
ratio 列表，預設 [0.50, 0.75, 0.90]。

**4.5 Subagent 同樣注入**

subagent 跑自己的 sessionID 自己的 budget。同一 envelope 機制；status 與
parent 無關，subagent 用 subagent 自己的 ctx_ratio。Part 1 觸發層的 A4
stall recovery 在 subagent 內若觸發，nudge 同樣帶 budget。

**4.6 Telemetry**

新事件 `context.budget.surfaced` per turn，記錄注入時的快照（status、ratio、
as_of）。整合進 Part 5 telemetry 清單。事後分析觀察 LLM 在不同 status 下的
行為改變，但**不依此調整提示詞或介入 LLM 工作流**——觀察是觀察，不變成施壓。

**4.7 不需要的東西**

- 不做新 LLM API tool（如 `get_context_status()`）—— budget 是被動可見
  資訊，沒必要做成主動查詢；多一條 tool call round-trip 反而貴
- 不做 streaming 中段更新——一輪內 budget 變化不大，turn 邊界更新足夠
- 不暴露 raw token counts 給使用者 UI——這是 LLM 看的
- **不附行動建議 / 不教 LLM 該怎麼做 / 不引入 digest 或類似 meta-tool**——
  這是 runtime 跟 LLM 的職責邊界（v4 立下的設計原則）

---

### Part 5 — Telemetry additions

- `compaction.predicate.evaluation` — every predicate eval, fire or no-fire,
  with all inputs
- `compaction.mode1.fired` — Mode 1 server-side compaction observed in
  response output
- `compaction.chain.reordered` — once per compaction event, whether the
  chain was reordered for codex subscription
- `compaction.narrative.coverage` — coverage % at narrative attempt time
- `compaction.cooldown.blocked` — cooldown prevented a would-be fire (for
  cooldown-effectiveness tuning)

Per-round `predicate.evaluation` may be sampled (10% of non-fires) if
volume becomes a concern — decided in `designed`.

---

### Part 6 — Big content boundary handling（input + subagent return）

兩個對稱情境都會把大量 raw 內容塞進 main agent ctx：

1. **User upload 路徑**：截圖 / 大檔直接貼進 user message
2. **Subagent return 路徑**：Task tool spawn 的 subagent 結束、把整大段
   工作報告當 tool_result 回給 parent

兩者都會把 raw 內容一次倒進 main agent 歷史，過去都靠 reactive
`ContextOverflowError` catch 兜底
（[`processor.ts:1793`](packages/opencode/src/session/processor.ts#L1793)）
——一次無謂 round-trip + 後補 compaction。

本 Part 用 **boundary-time 路由** + **background worker tool** 把這兩條同
時根治，因為機制對稱：

- 大檔在 upload 時就被 runtime 攔下，存 session-scoped KV，user message
  只放輕量 reference part（~50 tokens）
- main agent 看到 ref 後**自主決定**何時、用什麼問題透過 worker tool 取
  digest；圖檔 / raw 內容**從不進 main agent context**
- worker tool 走既有 small-model 框架（v6 透過預設指向 session SSOT
  model 啟用之），無 subsession、無 UI、不計入 coding agent 上限

**6.0 Implementation alignment — 啟用休眠的 small-model infra**

opencode 既有「small-model + 後台呼叫」三件套：
- [`Provider.getSmallModel`](packages/opencode/src/provider/provider.ts#L2506)
- [`LLM.stream({small: true})`](packages/opencode/src/session/llm.ts#L346)
- [`config.small_model`](packages/opencode/src/config/config.ts#L1390)

結構完整但**目前無任何 production 呼叫點**——`LLM.stream` 唯一 caller
（[`processor.ts:706`](packages/opencode/src/session/processor.ts#L706)）永遠
走主模型；`title-manager` 純字串切割；TurnSummary capture 已 phase 13.1
移除。三件套處於休眠狀態。

**啟用方法：把預設指向 session SSOT model**

```
config.small_model 未設定  → 預設 = session.execution.{providerId, modelID}
config.small_model 明確指定 → 走指定的（advanced opt-in；保留現有語意）
```

新增單一 helper：

```typescript
async function getWorkerModel(sessionID: string): Promise<Provider.Model> {
  const cfg = await Config.get()
  if (cfg.small_model) {
    const parsed = parseModel(cfg.small_model)
    return Provider.getModel(parsed.providerId, parsed.modelID)
  }
  // Default: session's pinned execution model (SSOT)
  const session = await Session.get(sessionID)
  const exec = session.execution
  return Provider.getModel(exec.providerId, exec.modelID)
}
```

對 codex 訂閱用戶：worker = `gpt-5.5`（vision-capable），邊際成本 ~0
對 API-key 用戶：worker = 主模型（接受成本，可手動分流）

**附加價值**：休眠 infra 一旦接活，未來所有「需要小模型」的場景（例如自動
commit message、user input 拼字校正、其他類型的 background worker）都有現
成框架，不必每次重發明平行管道。

**6.1 Upload-time runtime preprocessing**

新增 module `packages/opencode/src/session/input-preprocessor.ts`，hook 在
[`user-message-parts.ts`](packages/opencode/src/session/user-message-parts.ts)
組 user message parts 的階段：

```
for each part in user message:
  if part is image AND est_image_tokens(part) > tweaks.input_routing.image_threshold (default 5_000):
      ref = SessionKV.storeImage(sessionID, part)
      replace part with image_ref part
  elif part is text/code file AND est_tokens(part.content) > tweaks.input_routing.text_threshold (default 20_000):
      ref = SessionKV.storeText(sessionID, part)
      replace part with file_ref part
  elif part is unsupported binary AND size > tweaks.input_routing.binary_threshold:
      reject upload with explicit error (don't store, don't mutate message)
  else:
      pass through unchanged
```

KV 是新建 session-scoped storage layer（用既有 storage primitive，不新發
明）。儲存內容：原始 bytes / base64、metadata（mime、dimensions、original
size、original filename）。生命週期跟 session 一致。

**6.2 Reference part format**

新 part type `MessageV2.AttachmentRefPart`：

```
{
  type: "attachment_ref",
  ref_id: "ref_abc123",            // KV 主鍵
  mime: "image/png",
  filename: "screenshot.png",      // 原檔名（可選）
  est_tokens: 18000,               // 用 KV 取出時可估的 token 成本
  dimensions?: { w: 1920, h: 1080 },  // 圖片用
  byte_size: 524288,
  preview?: string,                // 文字檔可選的前 N 字 preview
}
```

main agent 看到此 part 時知道：
1. 有東西可查
2. ref_id 是查詢的 key
3. 從 metadata 知道大小，可決定要不要查

User message text 完全保留，不被 runtime 改寫——使用者意圖原樣傳達。

**6.3 Vision query tool**

新 tool `vision_query`：

```
input:
  ref_id: string          // 來自 user message 中的 attachment_ref
  question: string        // main agent 自主構造的問題（必填）
  detail?: "auto" | "high" | "low"   // 影響 vision model 解析度，default "auto"

execute(input, ctx):
  image = SessionKV.get(ctx.sessionID, input.ref_id)
  model = await getWorkerModel(ctx.sessionID)    // 6.0 helper
  result = await LLM.stream({
    small: true,                                  // 啟用休眠 flag
    sessionID: ctx.sessionID,
    model,
    messages: [{
      role: "user",
      content: [
        { type: "image", data: image, mime: image.mime },
        { type: "text", text: input.question }
      ]
    }],
    system: VISION_WORKER_SYSTEM_PROMPT,
  })
  return result.text   // digest 文字，typically 200-1000 tokens

system prompt (VISION_WORKER_SYSTEM_PROMPT):
  你是 vision worker。看圖回答指定問題。
  輸出純文字 digest，無 markdown chrome、無自我介紹。
  若問題泛問（如「看這個」）給結構化描述（layout / text / objects /
  notable_facts）。若問題具體則針對性答。盡可能簡潔，<1500 tokens。
```

main agent 端的呼叫範例：

```
user message text: "這個 error 是什麼意思"
attachment_ref: { ref_id: "ref_x", mime: "image/png", est_tokens: 18000 }

main agent 自主決定：
  vision_query(
    ref_id: "ref_x",
    question: "使用者貼了 error 截圖問這是什麼意思。請描述截圖中的 error 訊息、stack trace、相關 UI 狀態。"
  )

→ 回傳 ~500 tokens digest
→ main agent 整合 digest + 自身知識 → 回答 user
```

整輪 main context 增量：50 (ref) + 30 (tool_call) + 500 (digest) ≈ 600
tokens；image 18K 完全沒進 main。

**6.4 File digest tool**

新 tool `file_digest`，text/code 大檔的對應版：

```
input:
  ref_id: string
  question: string                  // main agent 給的查詢意圖
  range?: { start: int, end: int }  // 可選，指定看哪段

execute(input, ctx):
  text = SessionKV.get(...)
  if text 整段 > worker context window 的 50%:
      worker 自主分段（用 LLM.stream 的 multi-turn）讀整段，產 running summary
  else:
      一次性讀完產 digest
  return digest text
```

worker 內部如何分段是 worker LLM 的決策（runtime 不規範）——它有獨立 ctx
window 跟自己的 budget 可玩，不影響 main。

**6.4b Task return preprocessing（對稱於 6.1，subagent → main 流）**

對稱情境：Task tool spawn 的 subagent 結束、要把 result 回 parent 之前，
同樣攔下大段內容、同樣存 KV、同樣替換成 ref + preview。

```
on Task tool subagent finished, BEFORE returning to parent:
  result_text = subagent.final_assistant_message.text
  
  if est_tokens(result_text) > tweaks.subagent_return_threshold (default 5_000):
      ref_id = SessionKV.storeText(parent_sessionID, result_text, {
        source: "subagent_return",
        subagent_sessionID: subagent.id,
        subagent_type: subagent.type,
      })
      preview = extractPreview(result_text)
      
      return as tool_result text:
        preview + "\n\n[Full subagent report archived. Use task_result_query(ref_id, question) to drill in.]"
      return as tool_result metadata:
        { ref_id, est_tokens, full_size, subagent_sessionID }
  else:
      return result_text as-is
```

**Preview 抽取兩段策略**：

1. **TLDR 約定（cheap）**：build-mode / 已知 subagent type 的 system
   prompt 結尾要求寫 `## TLDR\n...` section。Task tool 偵測到就直接抽用。
   成本 0；品質依 subagent 配合度。

2. **Worker fallback（沒 TLDR 時）**：動用 6.0 的 `getWorkerModel` 即時
   生成 preview：
   ```
   worker = await getWorkerModel(parent_sessionID)
   preview = await LLM.stream({
     small: true, model: worker,
     messages: [{ role: "user", content: [
       { type: "text", text: "Summarize this subagent report in 200 tokens or less, focus on conclusions and changes:\n\n" + result_text }
     ]}]
   })
   ```

KV 存的是 **parent sessionID** 的 namespace（subagent 已結束、它的 KV 會
跟著 subagent session 死亡；要讓 parent 後續可 query 必須存到 parent 那
邊）。

**對應的 worker tool** — `task_result_query`（沿用 6.3 vision_query 同
模式）：

```
input:
  ref_id: string
  question: string

execute:
  text = SessionKV.get(parent_sessionID, ref_id)
  worker = await getWorkerModel(parent_sessionID)
  return await LLM.stream({
    small: true, model: worker,
    system: "你是 task report reader。回答關於這份 subagent 報告的問題。",
    messages: [{ role: "user", content: [
      { type: "text", text: "Subagent report:\n\n" + text },
      { type: "text", text: "Question: " + question }
    ]}]
  })
```

main agent 端整輪 ctx 增量：50 (ref preview) + 30 (tool_call) + ~500
(query result) ≈ 600 tokens，而非原本的 80K subagent report。

**5K threshold 的選擇**：subagent 一般完成報告 < 5K（純結論 + 簡要說明），
僅在「大規模 build / 跨檔重構 / 詳細 debug log」這類少見情境才超。低
threshold 確保**極少漏網**，誤殺成本低（小 report 也存 KV 不會炸）。

**6.5 Reject path**

下列情境 upload 時直接 reject（不存 KV、不替換 part）：

- 二進位非圖片非已知文字格式（zip、binary blob、影片等）超過 binary_threshold
- 圖片解析度超過任何 vision worker 能處理的上限（極罕見）
- KV 寫入失敗（disk full / permission）

Reject 訊息明確：

```
"Cannot process this attachment:
   <filename> (<mime>, <size> bytes)
 Reason: <specific reason>
 Suggestions: <if applicable>"
```

絕不靜默截斷、絕不假裝處理成功。遵守 AGENTS.md 規則 1（no silent fallback）。

**6.6 Subagent 同樣享受**

subagent（既有 Task tool spawn 的）也可能收到 attachment（parent agent 透
過 Task 傳下去）。Subagent 的 user message 也走同樣的 input preprocessor
路徑——大檔被替換成 ref，subagent 也用 vision_query / file_digest 自己查。

KV namespace 跟 parent 共用同 sessionID 嗎？**否**——subagent 有自己的
sessionID，KV 也以 sessionID 為 namespace 隔離。parent 傳 ref 給 subagent
時要做一次 KV 複製（cheap，只是 reference duplication）。

**6.7 Telemetry**

新事件：
- `input.preprocessing.routed` — 偵測到大檔並替換為 ref，記 mime / size /
  threshold
- `input.preprocessing.rejected` — upload reject 事件
- `worker.vision_query.invoked` — main agent 呼叫 vision worker
- `worker.file_digest.invoked` — main agent 呼叫 text digest worker
- `worker.task_result_query.invoked` — main agent 對 subagent 報告做 query
- `subagent_return.routed` — Task tool 結果被替換成 ref + preview
- `subagent_return.preview_source` — 標記 preview 來源（"tldr" / "worker_summary"）
- `worker.invocation.failed` — worker 失敗（model 錯誤、KV miss 等）

整合進 Part 5 telemetry 清單。

**6.8 不需要的東西**

- 不引入 a2a / inter-agent message bus（worker 是 tool，不是 agent）
- 不開 subsession（worker 一次性、ephemeral）
- 不算進 coding agent 上限（worker 不是 agent）
- 不教 main agent 何時該查（main agent 自治）
- 不改既有 Read tool 的 file:// 路徑（既有路徑大檔自動截斷的行為保留，不
  跟本 Part 衝突；只是現在使用者更可能直接貼進 chat 而非用 file:// 附）

## Scope

### IN

- All of Parts 1-5 above
- **Part 4 specifics**: server-confirmed `usage` 抄寫至 user-message
  envelope 的 `<context_budget>` 區塊；status 4-檔分類；同步注入
  runtime-self-heal nudge；subagent 同等對待。**無 digest meta-tool、無
  行動建議、無 LLM 工作流規範**。
- New module `cache-state-tracker.ts`
- New module / inline helper `compaction-trigger-inventory.ts`
- `compaction.ts` `KIND_CHAIN` → `resolveKindChain` refactor
- Codex provider request/response path adds Mode 1 wiring
- Narrative kind gains coverage + truncation flag accuracy
- `Cooldown` single-source unification; anchor-time-only
- `emptyRoundCount` persistence
- `provider-switched` chain extension
- Rebind no-apply token refresh
- `INJECT_CONTINUE` adjustment for A4
- `tweaks.cfg` schema additions (full list in §What Changes)
- Five new telemetry events
- Tests covering all new triggers, gate matrix, chain reorder, edge cleanups

### OUT

- Replacing the local kinds (narrative / replay-tail) — they remain as
  fallbacks
- Anthropic-side caching specifics — Mode 1 / chain reorder is codex-only
- Predictive accuracy beyond hash + TTL + chain — no client-side ML / model
- UI surfacing of "cache about to miss, suggest compact?" — fully automatic
- Compaction kind selection algorithms beyond chain reorder — chain stays
  the chain
- Adaptive thresholds — static defaults + tweaks.cfg overrides only

## Non-Goals

- Predicting cache state perfectly; predictMiss is heuristic, mistakes cost
  one extra compaction or one extra uncached round (neither correctness)
- Replacing `compaction-redesign` — this proposal extends it, does not
  supersede; particularly Part 3 cleanups dovetail with phase 13 work
- Eliminating the cost-monotonic principle for non-codex providers
- Changing kind 4 / `low-cost-server` plugin contract
- Generalising provider-specific behaviour into core dialog code per
  `feedback_provider_boundary.md`

## Constraints

- AGENTS.md rule 1: no silent fallback on malformed config (ALL new tweaks
  keys must error loudly when unparseable)
- [`feedback_provider_boundary.md`](file:///home/pkcs12/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_provider_boundary.md):
  codex-specific logic stays in `compaction.ts` chain resolver + codex
  plugin / provider; do not leak into `prompt.ts` core dialog
- [`feedback_tweaks_cfg.md`](file:///home/pkcs12/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_tweaks_cfg.md):
  all thresholds in tweaks.cfg, ratio syntax, safe defaults
- [`feedback_compaction_two_principles.md`](file:///home/pkcs12/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_compaction_two_principles.md):
  principle 1 + principle 2 are load-bearing — design choices that violate
  either must surface explicitly
- Compaction items from Mode 1 are opaque — MUST NOT prune
  ([`codex-compaction.ts:16-18`](packages/opencode/src/provider/codex-compaction.ts#L16-L18))
- Predicate fire is fixpoint-stable by construction (post-compaction ctx
  drops to ~5-10%, gates close)
- Subscription detection reuses existing OAuth signal in
  [`codex-auth.ts:246-248`](packages/opencode/src/plugin/codex-auth.ts#L246-L248)
  — no extra round-trip

## What Changes

**New modules / files:**
- `packages/opencode/src/session/cache-state-tracker.ts` —
  CacheStateTracker contract, per-session in-memory map + optional disk
  hint for warm-restart
- `packages/opencode/src/session/compaction-trigger-inventory.ts` (or
  inlined into `prompt.ts`) — precedence walk replacing
  `deriveObservedCondition`'s ad-hoc branches

**Modified existing files:**
- `packages/opencode/src/session/prompt.ts` — `deriveObservedCondition`
  refactor; account-switch early-return removal; `emptyRoundCount`
  persistence; rebind no-apply token refresh extension
- `packages/opencode/src/session/compaction.ts` — `KIND_CHAIN` →
  `resolveKindChain`; narrative coverage + truncation flag; Cooldown
  single-source; provider-switched chain extension; `INJECT_CONTINUE` A4
  override
- `packages/opencode/src/provider/codex-compaction.ts` — Mode 1
  request-build wiring (already has `buildContextManagement`; needs
  call-site)
- Codex provider request path (TBD by `designed`; coordinates with AI SDK
  fetch interceptor refactor per `project_aisdk_codex_direction`)
- Codex provider response handler — compaction-item detection +
  preservation
- `packages/opencode/src/plugin/codex-auth.ts` — expose
  `isCodexSubscriptionAuth()` if not already callable from compaction
  module

**`tweaks.cfg` schema additions:**
- `compaction.cache_loss_floor` (ratio, default 0.50) — B1 + B3 ctx gate
- `compaction.min_uncached_tokens` (count, default 40_000) — B1 size gate
- `compaction.stall_recovery_floor` (ratio, default 0.50) — A4 ctx gate
- `compaction.stall_recovery_consecutive_empty` (count, default 2) — A4
  threshold
- `compaction.quota_pressure_threshold` (ratio, default 0.10) — B3 quota
- `compaction.cache_ttl_seconds` (seconds, default 270) — TTL safety margin
- `compaction.codex_server_priority_ratio` (ratio, default 0.70) — chain
  reorder threshold
- `compaction.codex_inline_threshold_tokens` (count, default 100_000) —
  Mode 1 server threshold
- `compaction.narrative_min_coverage` (ratio, default 0.6) — narrative
  quality gate
- `compaction.enable_<trigger_id>` (bool flags, default ON) — per-trigger
  feature flags for safe rollout

**Tests:**
- `cache-state-tracker.test.ts` — tracker contract
- `compaction-trigger-inventory.test.ts` — precedence + boundary guards
- Extend `prompt.observed-condition.test.ts` — A4 / B1 / B3 vectors
- Extend `compaction.test.ts` (or new `compaction-kind-chain.test.ts`) —
  resolveKindChain matrix; narrative coverage + truncation; Cooldown
  unification
- Mode 1 wiring tests — request shape; compaction-item preservation;
  cooldown coordination
- Edge cleanup tests — provider-switched fallback; rebind no-apply
  refresh; Continue × A4 race

## Capabilities

### New Capabilities

- **Context budget surfacing to LLM** — daemon-known server-confirmed
  `usage` numbers are passed through to LLM via the user-message envelope.
  Information channel only; no workflow prescription. LLM uses or ignores
  at its own judgement.
- **Client-side cache oracle** — CacheStateTracker mirrors provider cache
  behavior; predictMiss authoritative pre-flight signal
- **Stall-recovery escalation** — consecutive empty rounds at high ctx
  escalate to compaction
- **Quota-pressure compaction** — rate_limits-driven preemptive compaction
- **Mode 1 inline compaction** — continuous server-side compaction via
  `context_management`
- **Subscription-aware kind routing** — codex OAuth users get kind 4
  priority at high ctx
- **Trigger inventory as the contract** — every legitimate trigger
  enumerated, classified, ordered
- **Narrative quality gate** — coverage + truncation accurate, chain
  escalates intelligently

### Modified Capabilities

- **`deriveObservedCondition`** — walks inventory in precedence order
- **`KIND_CHAIN` resolution** — context-aware; codex subscription gets
  reorder
- **Account-switch behavior** — chain-invalidates (existing) then
  predicate-evaluates (new), removing the high-ctx blind spot
- **Cooldown** — single source of truth (anchor time); persistence-free
- **Self-heal nudge** — gains hard ceiling; escalates to A4 after K
  consecutive empties

## Impact

- **Code**: prompt.ts, compaction.ts, codex provider request/response,
  codex-compaction.ts, codex-auth.ts, tweaks.cfg schema, ~5 new test files
- **Configuration**: 10 new tweaks.cfg keys with safe defaults; operators
  may tune; defaults work without intervention
- **Operators**: visible behaviour changes:
  - Compactions fire predictively at high ctx after cache-loss events
    (where they previously didn't)
  - Codex subscription users see Mode 1 server-side compaction running
    silently per turn
  - Codex subscription users see kind 4 winning over narrative at high
    ctx
  - Stall-recovery escalates instead of looping on self-heal
  - Daemon restart no longer loses cooldown / emptyRoundCount accounting
- **Docs**: `specs/architecture.md` Cache & Compaction section —
  rewrite covering trigger inventory + provider-aware chain;
  `specs/compaction-redesign/` — forward-reference note
- **External**: none. No API surface change.

## Cross-references

- [`feedback_compaction_two_principles.md`](file:///home/pkcs12/.claude/projects/-home-pkcs12-projects-opencode/memory/feedback_compaction_two_principles.md)
  — load-bearing principles 1 + 2
- [`compaction-redesign`](specs/compaction-redesign/) — base framework
  (seven-to-four refactor, anchor mechanics); this proposal extends rather
  than supersedes; phase 13 work coordinates particularly with Part 3
  cleanups
- Memory: `project_account_switch_compaction_inloop.md` — the 2026-04-29
  fix this proposal partially supersedes (Part 1.3)
- Memory: `project_codex_feature_priorities.md` — codex feature priorities
- Memory: `feedback_silent_stop_continuation.md` — A4 must not trigger on
  legitimate autonomous silence
- Memory: `feedback_provider_boundary.md` — codex specifics stay in
  compaction module
- Memory: `feedback_tweaks_cfg.md` — threshold externalization
- Memory: `feedback_no_silent_fallback.md` — error loudly on bad config
- Triggering session: `ses_221cdc5a4ffe9S0RoYSwCsJ8gN` round 761 (codex
  gpt-5.5, 279 messages, two consecutive zero-token responses)
- Screenshot: `Compaction failed: No user message found in stream` —
  closed by Part 1.2 boundary guards

## Open Questions (resolve before promoting to designed)

1. **Cache breakpoint alignment**: where exactly does Anthropic / codex
   cache the prefix? Anthropic uses explicit `cache_control` markers (last
   marker is the boundary); codex Responses API caches the implicit full
   prefix. Does AI SDK expose Anthropic's cache_control positions stably
   so the hash boundary matches? If not, hash full prefix conservatively.
2. **`predictMiss == "unknown"` policy**: conservative (don't fire B1,
   fall through to B2) vs alternative (fire B1 anyway when ctx > 0.80)?
3. **TTL value**: 270s safety margin vs per-provider TTL table (Anthropic
   ephemeral 5min vs paid 1h tier; codex undocumented)?
4. **B3 quota field model**: codex `rate_limits` structure observed
   inconsistently (memory: `project_codex_cascade_fix_and_delta`); need a
   pinned schema before B3 can ship.
5. **A4 stall-recovery vs autonomous-loop silence**: discrimination via
   `lastUser` source classification — refine the exact rule.
6. **Manual `/compact` vs threshold gates**: unaffected (force fire) is
   the current intuition, but confirm.
7. **Subscription detection helper location**: `isCodexSubscriptionAuth()`
   in codex-auth or facade in compaction.ts?
8. **`openai` provider gate**: shares codex `session.compact` hook; does
   `openai` ever have OAuth subscription, or always API-key?
9. **Compaction-item part type**: new `MessageV2.CompactionItemPart` vs
   repurpose existing assistant-message part shape.
10. **Mode 1 inject point in AI SDK pipeline**: coordinates with the
    `project_aisdk_codex_direction` interceptor refactor.
11. **Telemetry retention**: per-round predicate evaluation event volume;
    sample non-fires at 10%?
12. **Boundary guard wording**: precise message-stream condition for "no
    fire mid-assistant-turn" — `lastFinished.id === lastAssistantInStream.id`?
13. **Phase ordering against `compaction-redesign` phase 13**: parts of
    Part 3 (Cooldown unification, anchor-time source) overlap. Do we
    block on phase 13 verifying first, or interleave?

### Part 6 Open Questions

14. **(Part 6) KV 儲存 namespace 與生命週期**: ref 留多久才 GC？session
    結束時清還是延長保留？跨 session 不該洩漏；同 session 跨 turn 必須
    durable。需要明確的 retention policy + cleanup trigger。
15. **(Part 6) Subagent return 的 ref 寫入時序**: subagent 結束、parent
    sessionID 的 KV 由誰寫入？subagent 自己（已死）還是 Task tool 從 parent
    sessionID context 寫入？目前 spec 寫存到 parent，但寫入主體與 race
    防護需要釐清。
16. **(Part 6) Preview 抽取 fallback chain**: TLDR section 沒抽到 → worker
    fallback → worker 也失敗時要怎麼辦？三段降級的最後一段（worker fail）
    需要明確 policy——是 reject 整個 Task 結果、還是 first-N-chars 兜底、
    還是 surface error 給 main agent 自己處理？
17. **(Part 6) 5K subagent_return threshold 缺資料佐證**: 拍腦袋值，可能
    太低（誤殺正常結論）或太高（漏網大報告）。需要先做觀察期 telemetry，
    記錄實際 subagent return text 大小分布，再校準。
18. **(Part 6) image_threshold (5K) / text_threshold (20K) 同樣拍腦袋**:
    圖檔的 5K 對截圖太敏感（一張 1080p 截圖約 18K，但縮圖到 800x600 後
    <5K）。閾值跟縮圖策略要協同設計：是先嘗試縮圖、縮完再判 threshold，
    還是直接 threshold 判定 raw 大小？
19. **(Part 6) Vision worker 模型解析**: 當 main session model 為非
    vision-capable（如 Anthropic Sonnet 4.6 文字版本）時，`getWorkerModel`
    傳回的 model 無 vision。要 graceful fallback 到 priority list（喚醒
    休眠的 small-model 真正路徑）還是 reject 整個 vision_query？
20. **(Part 6) AI SDK 對 Mode 1 `context_management` 的支援**: AI SDK npm
    套件是否暴露 codex Responses API 的 context_management 參數？若無，
    要走 [`provider/codex-compaction.ts`](packages/opencode/src/provider/codex-compaction.ts)
    的直接 fetch interceptor 路徑而非 streamText——影響 Mode 1 落地形狀。

### Part 4 Open Questions

21. **(Part 4) Budget block UI 可見性**: budget block 是給 LLM 看的，
    前端顯示對話歷史時是否過濾？預設應隱藏（user 不需要看 token 計數），
    但 debug 模式可顯示——確認預設行為。
22. **(Part 4) Subagent budget 計算對象**: subagent 跑在自己 sessionID、
    自己 ctx 累積，但 quota window（rate_limits）是 parent account 共用的。
    Status 分檔應該以 subagent 自己 ctx_ratio 為準（隔離）還是看 parent
    quota（共享）？影響 subagent LLM 收到的 status 顏色語意。

### Implementation 跨 Part 議題

23. **實作 phase 順序與依賴矩陣**: 六個 Part 的相依關係未明文。建議排序：
    - Phase A: Part 3 邊角清理（小、低風險、跟 phase 13 整合）
    - Phase B: Part 4 budget surfacing（純資訊、無 LLM 行為依賴、易驗證）
    - Phase C: Part 1 trigger inventory（建在 Part 4 之上）+ Part 2 執行層
    - Phase D: Part 6 KV layer + worker tools（最大新基建）
    - Phase E: Part 5 telemetry 全部 wire up（其他 Part 都串完才有意義）
    需要在 designed 階段固化，並標記哪些 phase 可平行。
24. **既有 sessions migration 路徑**: 已存 sessions 沒有 CacheStateTracker
    state、沒有 KV refs。新機制接入時舊 session 行為應 graceful：新機制
    只對未來輪生效、舊歷史維持原樣。確認沒踩雷（特別是 anchor-from-stream
    + Part 3 Cooldown 改用 anchor.createdAt 對舊 session 的相容性）。
25. **跟 `compaction-redesign` phase 13 的硬依賴矩陣**: Q13 已談順序，
    但需要明確列出：phase 13 哪些部分若 verifying 失敗回滾，本 spec 哪些
    章節跟著回滾？至少 Part 3.1（Cooldown 用 anchor.createdAt）跟 phase 13
    的 anchor-from-stream 是強耦合；其他鬆耦合的應該能獨立 land。
26. **Test 策略**: Part 1-2 各有具體 test 檔指明，Part 3 部分依賴 phase 13
    既有測試，**Part 4 / Part 6 沒明列測試文件**。建議在 designed 階段補：
    - Part 4: `prompt.context-budget-surfacing.test.ts`
    - Part 6: `input-preprocessor.test.ts` + `worker-tools.test.ts` +
      `kv-storage.test.ts`
