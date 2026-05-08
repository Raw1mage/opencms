# Proposal: compaction-fix

## ERRATUM 2026-05-08 (d) — Phase 1 misframing, disabled

The original Phase 1 problem statement assumed our pre-existing per-turn
behavior diverged from upstream codex-rs and needed a transformer to
correct. **Re-read of upstream proves this is wrong.** Upstream's
per-turn flow ([refs/codex/codex-rs/core/src/context_manager/history.rs:119](../../refs/codex/codex-rs/core/src/context_manager/history.rs#L119)
`for_prompt`) returns the FULL history with only orphan-pair repair
and image modality stripping. The aggressive
`build_compacted_history` runs ONLY inside an explicit compaction
event ([compact.rs:466](../../refs/codex/codex-rs/core/src/compact.rs#L466)),
not every turn.

Phase 1 v1–v6 pursued a per-turn transformer that drops verbose tail
items. Each iteration was a different drop policy, all sharing the
same false premise. Live observation under v5 showed a hard amnesia
loop (input collapsed to ~332 tokens across 6 consecutive turns; model
re-derived the same tool-call sequence each iteration). v6 narrowed
the scope but is still a per-turn drop where upstream has none.

**Decision (commit `c1feb48a1`)**: `compaction_phase1_enabled` is
default-off in tweaks.cfg; Phase 1 transformer code retained but not
invoked. Per-turn shaping is now upstream-aligned full pass-through.

**Phase 2 stays valid and now decoupled** from Phase 1 (commit
`c1feb48a1` removes the `phase1Enabled` gate from Phase 2 invocation).
Anchor-prefix expansion of codex `/responses/compact` compactedItems
is the production alignment with upstream's compaction-event behavior.

**Compaction priority simplified** (commit `39bc97786`): codex
provider tries `low-cost-server` (server-side `/responses/compact`)
first regardless of context ratio or subscription flag. Other
providers retain local-first base order.

The architectural framing in this document (L1–L4 layer separation,
L2-payload purity, working-cache as L3 retrieval) is correct and
unaffected. What changed is the conclusion that Phase 1 needed to
exist at all — the asymmetry it tried to fix didn't exist.

Sections below retain the original wording with inline ~~strikethrough~~
on the misframed claims, plus added (v6, SUPERSEDED) tags. The
post-mortem detail is preserved deliberately so the misadventure is
auditable.

---

## Why

opencode 的 compaction 機制比 upstream codex-cli 豐富，~~但**我們既有的 4 種 kind 跑完都只產出一段 summaryText 寫進 anchor，post-anchor tail 沒有任何處理**~~（**2026-05-08 (d) 校正**：post-anchor tail 不做處理 = 對齊 upstream `for_prompt()` 行為，這原本就是正確的設計。下方「導致」三條中只有第三條（AI-based compactedItems 被丟）成立；前兩條的「每輪 tail 累積成長」是 upstream 也有的常態現象，被 compaction 觸發時的 `build_compacted_history` 處理）：

- ~~Tail 累積完整 raw items（assistant text/reasoning/每個 FunctionCall/每個 FunctionCallOutput），item count 線性成長~~（這是 upstream 也有的設計，等 compaction 觸發處理；不是每輪要修的問題）
- ~~50 輪 tail 可達 300-400 items，撞 codex backend 對 input array 個數的隱藏敏感度~~（codex backend bug 是真的，但解法是讓 compaction 在達到閾值時觸發，不是每輪 transform）
- AI-based compaction 跟 0-token compaction 退化成「同一條路」（都只用 summaryText），AI-based 該有的優勢（codex 回的 `compactedItems`）被丟掉 ✓ 仍成立 — Phase 2 修這條

### 修正方向（user 2026-05-08 reframe）

**我們不是該複製 codex-cli，而是利用我們比 codex-cli 多的東西做得更好。**

兩條互補的修法：

1. **LLM-called compaction（AI-based）→ 對齊 codex-cli 做法** — 用 codex 回傳的 `compactedItems` 取代 pre-anchor history，這是 codex-cli 的成熟模式
2. **0-token compaction → 引入 WorkingCache 的 index 機制** — 主文大量省略（drop verbose raw bytes），但每個被省略的內容留下索引（WorkingCache reference）讓**另一層 runtime** 可按需尋回

第 2 條是 opencode 比 upstream 高的地方：
- upstream 0-token 等於「砍掉重練」，model 失憶後只能靠 summary 文字
- 我們的 0-token 變成「壓縮檔 + 索引」，model 看到精簡 trace，要原文時透過獨立的 lazy retrieval runtime 取回
- 不是「對齊」codex-cli 的窮版本，是「擴展」我們本來就比較強的設計

### 四層職責邊界（user clarification 2026-05-08）

| 層 | 職責 | 此 plan 範圍 |
|---|---|---|
| **L1 Static prompt injection** | 系統控制：role / identity / tools / AGENTS.md / driver / agent | ❌ 既有設計，不動 |
| **L2 Conversation compaction**（this plan） | 工作記憶：對話脈絡的精簡 + 可定址的 reference | ✅ **唯一範圍** |
| **L3 Lazy retrieval runtime** | 拉取機制：根據 reference 從 storage / cache 取回原文 | ❌ 獨立 runtime，與 compaction payload 解耦 |
| **L4 Session maintenance runtime** | 連線狀態管理：chain ID（previous_response_id）、WS session ID、帳號輪換、rebind/rotation 期間的 chain 重建 | ❌ 獨立 runtime，與 compaction payload 解耦 |

**所以 compaction payload 的職責限縮為：**
1. 把過去的對話脈絡寫成精簡形式（trace markers + summary）
2. 在精簡內容裡放可定址的 reference（WorkingCache ID 或同等識別符）
3. 不負責「讀回來」— 那是 L3 retrieval runtime 的事
4. 不負責「連線狀態 / 帳號 / chain ID」— 那是 L4 session maintenance 的事

**意涵：**
- Phase 1 只設計「寫」這一側
- compaction payload **天然就應該** 不帶 account / provider / chain ID — 不是強制執行的約束，是正確分層的副產品。如果發現我們的 payload 摻了 chain ID，那是 L2 漏進 L4 領域，要回頭把那段抽到 L4
- model-facing recall tool（如果未來要做）→ L3 範圍
- chain reset / rotation invalidation 機制 → L4 範圍（已在 transport-ws.ts + continuation.ts 實作）
- WorkingCache 的 manifest / ledger / selectValid API 已存在，本 plan 沿用其 write API 即可，不需新增

### 故障 RCA（fix-empty-response-rca Phase 1 JSONL）

ses_204499eecffe2iUTzeXyiarlnq（62 小時 / 7189 requests / 0.71% 失敗率）51 events：

- inputItemCount avg=397 → server_failed @ frames=1（pre-execution rejection）
- inputItemCount avg=320 → ws_truncation @ frames=3（開頭截斷）
- 對照組 frames=61/83 各 1 次 → codex backend 不是壞，只是 input shape 觸發失敗機率高

跨 8 個帳號連環失敗 → 排除 chain ID 與 account 層假設。chain reset 路徑稽核全部正確。

### Compaction 分類框架

| 大類 | 子類 | KindName | 對齊對象 | 目標 |
|---|---|---|---|---|
| **AI-based** | server-side（plan 福利） | `low-cost-server` | codex-cli inline + RPC | Phase 2：用 `compactedItems` 取代 history |
| AI-based | LLM-requested | `llm-agent` | codex-cli LLM compaction | Phase 2：同上（如果該 kind 也回結構化 items） |
| **0-token** | 啟發式抽取 | `narrative` | （我們獨有） | Phase 1：升級為「精簡 trace + WorkingCache index」 |
| 0-token | text 拼接 | `replay-tail` | （我們獨有） | Phase 1：同上 |

## Original Requirement Wording (Baseline)

- "好。請對齊upsteam。至於被丟掉的部份，我們已經實做了working cache了。有tools可以叫回來用。"
- "AI based compaction：再分兩類：server-side compaction (codex/claude的優惠)、LLM requested compaction (主動要求AI做的，高成本)。0 token compaction：本地端自己刪減對話中的冗餘物件，重組對話精華、tool call summary而得。"
- "我們具備的compaction方案比codex-cli多。其中的LLM called compaction是對齊codex-cli的做法。但我們自己的0 token做法要設法再smart一點，減少浪費，也減少損失。我覺得這個時候就應該把working cache的機制帶進來了，變成主文大量省略，但提供index去尋回記憶"

## Requirement Revision History

- 2026-05-08: initial draft created via plan-init.ts
- 2026-05-08 (a): RCA + upstream 比對 + WorkingCache 補位機制
- 2026-05-08 (b): 採用 user 提出的 AI-based vs 0-token 分類框架，phased structure
- 2026-05-08 (c): 重新定位 — Phase 1 不是「對齊 upstream」是「升級 0-token」（用 WorkingCache index 做主文省略+尋回）。LLM-called compaction 才是 Phase 2 的對齊 upstream
- **2026-05-08 (d)**: **Phase 1 disabled.** Re-read of `for_prompt()` proves upstream's per-turn flow is full pass-through. Phase 1 v1–v6 (trace-marker collapse → drop-with-recentRawRounds → text-bearing preserve → unconditional-drop → current-task-scope) all introduced a per-turn drop where upstream has none. v5 caused live amnesia loops (input collapsed to 332 tokens, model re-derived each turn). Disabled via tweaks.cfg (`compaction_phase1_enabled=0`) in commit `c1feb48a1`. Phase 2 decoupled from Phase 1 in the same commit. Compaction priority simplified in commit `39bc97786` (codex always tries server-side first). Phase 1 transformer code retained as default-off experiment for future redesign if a sound use case emerges; current architecture relies on Phase 2 + KIND_CHAIN compaction + working-cache for the actual compaction work.

## Effective Requirement Description

### Phase 1（0-token compaction 升級：主文省略 + WorkingCache index）

1. anchor 之後完成的 assistant turn，raw verbose 內容從 prompt 中省略
2. 每個被省略的 turn 留下精簡 trace marker（含 tool 名稱、簡短描述、WorkingCache reference ID）
3. WorkingCache 自動把被省略內容（tool result、長 text）以可尋回方式 index 起來
4. model 看到的 prompt 變成「精簡 trace 列表 + 必要 user 訊息 + anchor summary」，要拉原文時透過已存在的 WorkingCache 機制
5. 結果：item count 從 ~300-400 降到 ~50-100，bytes 降更多，且 fidelity 不像 upstream 砍光那麼極端

### Phase 2（LLM-called compaction 對齊 codex-cli）

1. `tryLowCostServer` 不再丟棄 `hookResult.compactedItems` — 寫入 storage 並當成新的 history prefix（取代 pre-anchor 全部歷史）
2. `llm-agent` 同理（如果該 kind 也支援結構化回傳）
3. AI-based kind 真正比 0-token 高貴：付費取得 codex 自己壓縮過的結構化 items
4. compactedItems 與 chain identity 綁定（account/model/chain）— 失效時 invalidate

### ~~Phase 3~~ → moved out of plan scope

原本的 Phase 3「暴露 `working_cache_recall(refId)` 給 model」屬於 **Lazy retrieval runtime layer**，與 compaction payload 職責解耦。應作為獨立 spec / 另一個 plan 處理，不在此 compaction-fix 範圍。

## Scope

### Phase 1 IN
- prompt 組裝層（`packages/opencode/src/session/prompt.ts`）：在 `applyStreamAnchorRebind` 之後加 transformer
- transformer 邏輯：對每個 anchor 後完成的 assistant message，產生精簡 trace marker，replace 原本的 verbose parts
- WorkingCache integration：trace 中提及的 tool result / long text 確保已被 WorkingCache index（可能需要在 tool 完成時 write，或於 transform 時 lazy-write）
- 例外白名單：`compaction` part type（Mode 1 inline server compaction 產物，必須回送）
- 保留 in-flight assistant 最後一條完整不動（pending tool calls 不能斷）
- 安全閥：trace transform 後 messages < N 時 fallback 不 transform
- 單元測試：transform shape 驗證
- 整合驗證：在 ses_204499eecffe2iUTzeXyiarlnq pattern 復現後觀察 inputItemCount 下降

### Phase 2 IN
- `tryLowCostServer` 不再丟棄 `compactedItems`
- 設計 storage 模型：compactedItems 怎麼存、與 chain identity 綁定
- prompt 組裝層 read path：偵測 compactedItems 存在時優先採用，落入 fallback 才回 Phase 1 transformer 結果
- 失效處理：account/model 切換時 invalidate compactedItems
- 對應的 `llm-agent` 路徑評估
- 單元 + 整合測試

### ~~Phase 3 IN~~ — REMOVED, 屬 retrieval runtime layer
（model-facing recall tool / system prompt 引導 / 觀察使用率，全部移出此 plan）

### OUT（三個 phase 都不做）
- 不改 storage schema 結構（parts/messages 表沿用，僅可能新增 part type 或 metadata 欄位）
- 不改 codex provider `convertPrompt`（拆塊規則跟 upstream 一致）
- 不改 WorkingCache 自身核心 API（既有 deriveLedger/selectValid/buildManifest 已夠用）
- 不解決 image base64 重送（正交議題，獨立 spec）
- 不解決 reasoning encrypted_content lifecycle（正交議題）
- 不重新衡量 KIND_CHAIN 優先順序（正交議題）

## Non-Goals

- 不追求位元對齊 upstream — 我們的 0-token 比 upstream 更積極（保留 index）
- 不解決 codex backend 自身對 input array 個數的敏感度（上游 bug，繞過）
- 不解決 fix-empty-response-rca Phase 2 的 predictedCacheMiss 推導（獨立議題）

## Constraints

- 必須通過所有 prompt.applyStreamAnchorRebind 既有單元測試
- 不能破壞 unsafe_boundary 護欄
- 必須相容 subagent prompt path
- 必須相容 in-flight assistant turn（最後一條尚未完成的不動）
- 必須保留 Mode 1 inline server compaction 的 `compaction` part type
- WorkingCache write 不能阻塞 prompt 組裝（必要時 async）

### Layer Purity Invariant（架構級，2026-05-08 user reframe）

> Compaction payload 是 **L2 工作記憶**，**不**是 L4 連線狀態。

這不是「compaction 要主動防止某些東西」，是「正確分層的自然結果」：

**規則（自然應成立、若違反代表分層錯）：**
1. Trace markers 與 compactedItems 不應內嵌：account ID、provider ID、WS session ID、`previous_response_id`、`conversation_id`、connection-scoped credentials
2. WorkingCache reference IDs 應以 sessionID（local lifecycle）為 scope，不綁 account/provider
3. Phase 2 從 codex 收到的 `compactedItems` 若帶 chain-specific 識別符 → 那是 codex 把 L4 資訊塞進 L2 payload，opencode 在 L2/L4 邊界要 strip（這是 L4 維護工作，不是 L2 設計負擔）
4. 存進 storage 後，任何讀取路徑（rotation 後、rebind 後、新 WS 連線後）都應產生語意相同的 prompt

**為什麼會自然成立：**
- L2 寫的是「過去說了什麼、做了什麼、看到什麼」— 純內容，沒有理由帶連線資訊
- L4（[transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts) + [continuation.ts](../../packages/opencode-codex-provider/src/continuation.ts)）負責 chain ID 生死、rotation invalidation
- L2 跟 L4 之間有清楚的邊界 — codex 回的 compactedItems 跨越這個邊界時，是 L4 的 boundary 處理

**驗證方式（feature parity test，不是 enforcement）：**
- 模擬 rotation：account A → B 後，prompt 內容應等價
- 模擬 rebind：daemon restart 後，prompt 內容應等價
- 若不等價 → 代表 payload 漏進了 L4 資訊，回去稽核哪一條 path 跨了層

## Open Questions / Gaps（design 階段要解的）

### Critical（design 前必須答清楚）
1. **G-trace-form** — trace marker 形式：一個 turn 變一個 user role marker、還是改寫 assistant role 為 abbreviated parts？前者單純但語意奇怪，後者保留結構但實作複雜
2. **G-index-timing** — WorkingCache 索引時機：tool 完成時即時 write，還是 prompt 組裝時 lazy-write？影響 latency 與 storage churn
3. **G-coverage** — WorkingCache 覆蓋率：哪些 tool 結果該 index、哪些可直接丟（如 < 100 bytes 的小結果）
4. **G-subagent** — Subagent 繼承行為：Phase 1 transformer 在 subagent context extraction 之前還是之後跑？parent 看到的精簡 vs subagent 需要的完整可能衝突
5. **G-init-context** — ~~Initial context preservation~~ **DISMISSED 2026-05-08（user clarification）**
   - 原本擔心：strip assistants 後 model 失去角色/任務/可用 tools 的記憶
   - 實情：opencode prompt 是兩層正交組裝（[llm.ts:1064](../../packages/opencode/src/session/llm.ts#L1064) `streamMessages = [...systemMessages, ...input.messages]`），static block（driver/agent/AGENTS.md/userSystem/systemMd/identity/preload/skills/inventory）每次都重組注入，**不在 conversation layer，不受 compaction 影響**
   - compaction payload 只負責對話脈絡（用戶問了什麼、過去做過什麼），**不負責角色記憶**
   - Phase 1 transformer 不需要為這個 gap 設計補償機制
6. **G-layer-purity** — L2/L4 分層稽核（Phase 1 自然成立、Phase 2 在邊界處理）：
   - Phase 1 trace marker 的 WorkingCache refID 應已是 session-scoped 純 L2 資訊，需稽核 [working-cache.ts](../../packages/opencode/src/session/working-cache.ts) 的 ID 生成路徑確認沒摻 account/provider
   - Phase 2 codex 回傳的 compactedItems 跨 L2/L4 邊界 — codex 是 L4 的 server side，回來的 items 可能帶 chain-specific 識別符；**這是 L4 的 boundary handling 責任**（在 storage 前 strip 或重定位），不是 compaction 設計負擔
   - 若 codex schema 把 chain ID 深度嵌進 items 不可單純剝離 → Phase 2 路徑改為「L4 解析 codex items 為純 L2 表徵」，這是 L4 該做的工作
   - feature parity test：rotation / rebind / WS reconnect 後 prompt 等價（這是分層正確的驗證，不是 compaction 要防的事）
7. **G-manifest-staleness** — anchor summary 裡的 WorkingCache manifest 是 anchor 寫入當下的 snapshot；anchor 後新發生的 tool call/result 進入 trace marker 後，manifest 是否要連同 trace 動態更新？或讓 trace marker 自身就是「鮮的 manifest 增量」？
8. **G-phase-interaction** — Phase 2 落地後，compactedItems 是 anchor 的延伸還是取代 anchor？Phase 1 transformer 必須認得 compactedItems 並 exempt（不能誤把它當完成 turn 處理掉）

### Important（design 階段要鎖）
9. **G-token-count** — Token-count vs transform 時序：compaction 觸發吃 token estimate，transform 後實際送出去的遠少於 estimate；可能 compaction 該 fire 沒 fire 或反過來 fire 過頻
10. **G-cache-key** — Cache key 與 transform 的互動：promptCacheKey 穩定但內容變動，可能引發 codex 端 cache hit 但 content 不一致
11. **G-classifier-retune** — fix-empty-response-rca 分類器閾值重校：Phase 1 後 inputItemCount 從 ~300 落到 ~50-80，原本對 ~300 設計的 cause-family/recovery 對應可能要重新校
12. **G-compaction-request** — `compaction-request` part type 語意：DB 有 26 個，需確認 lifecycle 與是否要在白名單內
13. **G-recent-raw** — 「最近 N 輪 raw 不 transform」中間路徑：完全 transform 過於極端，最近 2-3 輪保持 raw 可大幅降低 fidelity 損失（換少量 itemCount 成本）

### Operational（planned 階段補）
14. **G-observability** — Observability 指標：transformer drop count、recall 實際使用率（Phase 3）、Phase 2 compactedItems hit rate；JSONL 加 `postAnchorTransformApplied: boolean`
15. **G-rollback** — Rollback strategy：Phase 1 用 tweaks.cfg 開關 + 預設 fallback；Phase 2 storage 加欄位採 additive（舊 reader 看不到也能跑）
16. **G-docs** — 架構文件更新：architecture.md、runbook、WorkingCache coverage policy
17. **G-test-matrix** — Test 覆蓋面：(a) transformer 單元；(b) 整合用 ses_204499 真實 session data 重播；(c) 多 model 切換 invalidation；(d) 50-turn 合成 itemCount 持平；(e) subagent extraction 一致性；(f) Phase 1 + Phase 2 互動
18. **G-perf** — Performance 預算：transformer 每次 prompt 組裝跑 O(n)，1000-msg session 量測；Phase 2 compactedItems read I/O cache layer需求

## Phase Sequencing

- **Phase 1 先做** — 範圍中（含 WorkingCache integration），低風險（fallback 安全閥），解眼前 codex backend bug
- **Phase 2 後做** — 等 Phase 1 soak 穩定。設計依賴 Phase 1 觀察數據
- **Phase 3 視 model 行為決定** — Phase 1 落地後觀察 model 是否真的需要 recall（如果 trace 已經夠用就不必加 tool）

## What Changes

### Phase 1
- 新增 transformer：對 anchor 後完成的 assistant message（非最近 N=2 輪）轉成精簡 trace marker（含 tool 名稱 + WorkingCache reference ID），原 verbose 內容透過 WorkingCache write 保留可尋回
- `applyStreamAnchorRebind` 之後串接此 transformer
- `tweaks.cfg` 加 `compaction.phase1Enabled` flag（預設 false，灰度啟用）
- 新增測試覆蓋 transformer shape

### Phase 2
- `tryLowCostServer` 不再丟棄 `compactedItems`，寫入 storage 並當成新的 history prefix（取代 pre-anchor 全部歷史）
- compactedItems 與 chain identity 綁定（accountId/modelId/chainAt）— 失效時 invalidate

## Capabilities

### New Capabilities
- Phase 1：0-token compaction 升級為「主文省略 + WorkingCache index」混合形態
- Phase 2：AI-based compaction 真正用上 server 回傳的結構化 compactedItems

### Modified Capabilities
- Phase 1：`applyStreamAnchorRebind` 從「只 slice」變成「slice + transform」
- Phase 2：`tryLowCostServer` 從「只用 summaryText」變成「用 compactedItems 為 prefix + summaryText 為輔」

## Impact

### Phase 1
- 直接影響：codex provider 看到的 input array 大幅縮小（item count 從 ~300 降到 ~50-100）
- 連帶影響：cache_read 比例可能變化（觀察是否需調整 prompt cache key 策略）
- 不影響：UI history view（讀 storage，不受 prompt 端 transform 影響）
- 不影響：WorkingCache 既有功能；本 plan 沿用其 write API

### Phase 2
- 直接影響：AI-based compaction 真正比 0-token 高貴 — pre-anchor history 換成 codex 壓縮過的結構化 items
- 連帶影響：storage schema 可能新增欄位記 compactedItems 與其 chain binding metadata
- 與 Phase 1 互動：compactedItems 應視為 anchor 的延伸（exempt from Phase 1 transformer）

## RCA References

- 失敗 signature 三件組（fix-empty-response-rca/empty-turns.jsonl 51 events）：
  - frames=3 ws_truncation 16/24（早期截斷）
  - frames=1 server_failed 10/10（pre-execution rejection）
  - inputItemCount × cause 強相關：server_failed avg=397，ws_truncation avg=320，unclassified avg=266
- 跨 8 個帳號連環失敗 → 排除 chain ID / account 層假設
- chain reset 路徑稽核 → 排除 stale chain 假設
- upstream 比對：refs/codex/codex-rs/core/src/compact.rs:389-530 的 `collect_user_messages` + `build_compacted_history` 是 Phase 2（AI-based 對齊）的 reference，但**不是 Phase 1（我們的 0-token 升級）的 reference**
- compactedItems 廢棄證據：[compaction.ts:1042-1044](../../packages/opencode/src/session/compaction.ts#L1042-L1044) 只 check null，不使用
