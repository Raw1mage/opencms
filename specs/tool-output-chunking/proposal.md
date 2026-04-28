# Proposal: tool-output-chunking (type-2 overflow)

## Why

Phase 13（compaction-redesign single-source-of-truth）解決了**累積式 history overflow（type-1）**——history 隨輪數增長，靠 narrative kind 寫 anchor 整批塌縮。但實際 production 仍會遇到第二類 overflow：**單一 tool output 比 model context 還大**。

具體症狀：
- `system-manager_read_subsession` 倒整個對話 → 一回就 200K-500K tokens
- 大檔 `read` 一次抓整檔 → 上百 K
- `grep` 全 repo 命中海量 → 結果集過大
- `webfetch` 抓整個 HTML / API JSON → 內容無上限
- `bash` 執行的 process 輸出無界 → 超大 stdout
- subagent 的 final output 過長 → TaskTool 把它原封塞回 parent

Compaction 救不了這種：compaction 壓的是「歷史」，不是「即將注入的最新 tool result」。即使 compaction 立刻把 history 全壓掉，剩下的單一 tool output 仍然比 model context 大，無解。

2026-04-28 production 觀察的爆掉案例：`read_subsession` 倒 ~170K tool output 進訊息流，gpt-5.5（272K context）的下一輪 prompt 變成 297K → server reject。Phase 13 hotfix（state-driven 用 msgs estimate）能**偵測**到這種 overflow 並提前觸發 compaction，但**救不了**：因為瓶頸不在 history。

## Original Requirement Wording (Baseline)

跟 user 討論濃縮：
- 「context overflow 有兩種。如果是 history 過長，可以靠我們實作的 double phase compaction 來解。如果是當輪的 toolcall 產出過多，就只能靠分塊慢送機制」
- 「tool call 中段不能切，所以切點要在每個 tool call round 之間。然後打 prompt 給 AI 讓他知道這是拆包，他要先消化吸收產生縮減版的記憶，然後把空間空出來等下一包」
- 「toolcall 要有能力自己知道 output pack size 的 upper limit；自動分塊成幾個 AI 可執行的 output blocks」
- 「同意」（接受 lazy 分頁與 chunked-digest 兩段架構）

## Requirement Revision History

- 2026-04-28: initial draft（從 compaction-redesign 完成後 user 主動要求準備 handover）

## Effective Requirement Description

兩層機制協同解決 type-2 overflow：

1. **Layer 2 — Tool 自分塊契約（必要前置）**
   - Tool framework 提供 `ctx.outputBudget`，預設 `min(model.context * 0.3, 50_000)` tokens；可被 `/etc/opencode/tweaks.cfg` 全域覆寫，或 per-tool 細調（譬如 `read_subsession` 上限可以更嚴）
   - Variable-size tools 改寫成自己切塊：`read`、`glob`、`grep`、`webfetch`、`bash`（stdout）、`apply_patch`（diff size）、`TaskTool` subagent output、`system-manager_read_subsession`、其他外部 MCP variable-size tools（per-tool audit）
   - 短輸出 tool（echo / calc / cron_create / question）不動
   - **切點落在 tool 語意邊界**：per-message / per-file / per-paragraph / per-line block / per-grep-hit。不是亂截字元
   - **模式：lazy 分頁**——tool 第一次只回 block 1 + cursor。AI 看完決定要不要 call 同 tool 帶 `cursor=X` 拿 block 2。AI 是搭檔，不是被動接收者
   - Tool 結構回應（兼容舊 caller — 短輸出仍可直接回 string）：
     ```json
     {
       "block": { "index": 1, "total": 3, "content": "...", "boundary": "..." },
       "cursor": "<opaque-token-or-null>",
       "hasMore": true
     }
     ```

2. **Chunked-digest 新 compaction kind（後盾）**
   - 即使每個 tool output 都被分塊到 ≤ outputBudget，整段 history 加總仍可能爆 model context（譬如多輪累積）。這時 narrative kind 還壓不下時，runtime 啟動 chunked-digest
   - **切點：round boundary**（一個 user msg + 該 user 對應的 assistant-with-tools-resolved 為一個閉合單位）。round 內部不能切（會破壞 tool_call/tool_result 配對）
   - Runtime 把 history 切成 N 個 round-aligned chunks
   - 每個 chunk 上送 prefix 三段：
     ```
     [digest_so_far]    ← 前面 chunks 累積的記憶
     [chunk_payload]    ← 這次的 round 們
     [framing_prompt]   ← 「這是分包送達的歷史，第 k/N 包。你的任務是消化並輸出
                         縮減版記憶，不是執行任務。輸出格式：…」
     ```
   - AI 回 `digest_chunk_k` → `digest_so_far := merge(digest_so_far, digest_chunk_k)`
   - 最後一包消化完，runtime 把 `digest_so_far` 當 anchor 寫進訊息流，原始 user 請求接在後面，正常進 LLM
   - 新 kind 名稱建議：`chunked-digest`，插在現有 `KIND_CHAIN` 的 `llm-agent` 之後（最強最貴的後備），或當 `llm-agent` 一次吃不下時的 escalation

3. **順手收：compaction → next-LLM-call race condition**
   2026-04-28 19:35:01 觀察到的 case：`compaction.completed kind=narrative` 跑完 3 秒後下一個 LLM call 仍然 reject `Codex WS: Your input exceeds the context window`。系統有 self-heal 但中間那輪損失。建議在這個 plan 內加 `verify-after-compact` requirement：compaction 完成後 runtime 再 estimate 一次 msgs token，確認真的縮下來；沒縮就強制再 compact 一次或 escalate。跟 chunked-digest 的「每個 digest chunk 都該縮 prompt」是同類驗證。

## Scope

### IN
- Tool framework `ctx.outputBudget` 規格 + cursor 協定設計
- ~10-15 個 variable-size tool 改寫支援自分塊
- `chunked-digest` 新 compaction kind + framing prompt 設計
- `KIND_CHAIN` 加入 `chunked-digest` 為 paid kind 後備
- Verify-after-compact 機制（compaction 後重新估算 msgs token，確認真的縮下來）
- 測試 + 觀測 + 遷移文件

### OUT
- Type-1 overflow 機制（已 Phase 13 完成、living）
- Cooldown / cache 行為（已 Phase 13 完成）
- 改 model context limit 本身（model 端決定）
- 重新設計 anchor 訊息格式（已 DD-8 收）
- 換 prefix cache 策略
- 短輸出 tool 的改寫（沒必要）
- 改 prune（已 749e7c548 退役、不會回來）

## Non-Goals

- 全自動 chunked-digest 取代 narrative。Narrative 仍是首選，chunked-digest 是當 narrative 也不夠強時的後援
- 跨 tool 的 cursor 統一格式。各 tool 自己決定 cursor encoding（譬如 read 用 `line=N`、grep 用 `match=M`、subsession 用 `msgIdx=K`），AI 透過 framing prompt 知道怎麼用
- 強制 user 設定 outputBudget。預設值要直覺夠用，覆寫只是 power user 選項
- 解決 model 本身的 context 限制（model 端決定）

## Constraints

- **不能破壞現有 tool 用法**：existing `bash`、`read`、`grep` 等的呼叫方仍能拿到 string output。新 cursor 協定是 opt-in 擴充，舊 caller 不知道分塊存在仍能正確運作（拿到 block 1，預期就是「可能截短」）
- **AI 必須收到 hint 知道有 cursor**：tool result text 要明示「This is block 1 of 3. Call again with cursor=X for next block」這類話術
- **Round boundary 偵測必須 robust**：runtime 切 chunked-digest 邊界時要正確識別 user → assistant（tool_calls all resolved）這個閉合單位。tool_call 開了還沒 resolve 的不能切
- **Framing prompt 要設計細緻**：AI 對「現在你是消化員，不是執行員」這個角色切換要強烈感知，不能因為看到歷史 user 訊息又開始執行任務
- **Test coverage 必須涵蓋邊界**：單一 round 內 tool output 巨大、跨 round 累積巨大、AI 的 digest 自己又超大、cursor 中途失效等
- **Verify-after-compact 不可造成無限迴圈**：compact 完還是大 → 再 compact 一次 → 還是大 → ... 必須有 max retry + escalation 路徑

## What Changes

- `packages/opencode/src/tool/types.ts`（或對應 framework）：tool ctx 加 `outputBudget`、tool result schema 加 `cursor`、`hasMore`、`block` 欄位
- 各 variable-size tool source（`packages/opencode/src/tool/{read,glob,grep,bash,webfetch,apply_patch,task}.ts` + system-manager / external MCP shims）：實作自分塊邏輯
- `packages/opencode/src/session/compaction.ts`：新增 `tryChunkedDigest` 函式 + `KIND_CHAIN` 各 observed 加入 `chunked-digest`（paid kind 位置）
- `packages/opencode/src/session/prompt.ts`：state-driven 路徑 verify-after-compact 邏輯
- Framing prompt 文字：可能放在 `packages/opencode/src/session/prompt/` 新檔，或 inline
- `/etc/opencode/tweaks.cfg`：新增 `tool_output_budget_default` + per-tool override schema
- 對應測試 + 觀測 log

## Capabilities

### New Capabilities
- **Tool 自分塊**：variable-size tool 知道自己 output 上限，自主切塊；AI 透過 cursor 自主翻頁。不再有「一個 tool 灌爆 context」的物理可能
- **Chunked-digest compaction**：history 累積太大時，AI 自己消化分批 history 並產出縮減記憶。最強最貴的 fallback，但永遠能成功收斂
- **Verify-after-compact**：每次 compaction 完成後 runtime 確認真的縮下來；沒縮就 escalate

### Modified Capabilities
- `KIND_CHAIN`：overflow / cache-aware / manual 鏈條末端加 `chunked-digest`
- Tool result schema：加 cursor / hasMore / block 欄位（向下相容）
- `Bash`、`Read`、`Grep` 等：output 自帶結構，cursor protocol 啟用
- `tweaks.cfg`：tool 預算可調

## Impact

- **代碼**：估 +800 ~ 1200 行（tool framework + 10-15 個 tool 改寫 + chunked-digest kind + framing prompt + verify-after-compact + 測試）
- **測試**：~30 個新 spec
- **行為**：對使用者透明——tool 還是回有用結果、AI 還是能執行任務。差別在「不會再因為 single tool output 把 context 灌爆」
- **效能**：tool output 現在分塊回；要拿完整內容 AI 需多 call 幾次（累積 LLM call 次數增加，但每次 prompt size 縮小）。Net 對 codex prefix cache 友善
- **Production 風險**：Tool framework 改動範圍大，回退要設計好（feature flag 或 tweaks.cfg 開關）。Chunked-digest framing prompt 寫不好 AI 可能不配合（會用 prompt design + test vector 多輪迭代）

## Phase 1 (MVP) 範圍建議（給下一個 session 參考）

下一個 session 進來先看這份 proposal，然後 promote 到 `designed`。在 design 階段：
1. 先選 1-2 個最痛的 tool（建議 `read` + `system-manager_read_subsession`）做 self-chunking PoC，驗證 cursor 協定
2. 同步設計 chunked-digest framing prompt，先用 test vector 模擬幾個 chunk 流程，確認 AI 能正確切換成「消化員角色」
3. PoC 通過後再擴大到所有 variable-size tools

## Handover Notes（給接手 session）

- 本 plan state = `proposed`，下一步走 `plan-promote --to designed`，需要產 spec.md / design.md / c4.json / sequence.json / data-schema.json / idef0.json / grafcet.json
- 設計階段要先用 `miatdiagram` skill 產 idef0/grafcet
- 完整背景看 `docs/events/event_20260428_compaction_phase13_single_source.md`（Phase 13 收尾）+ `specs/architecture.md` 的 Compaction Subsystem + Two-type overflow taxonomy 段
- 跟 type-1（compaction-redesign）的關係：互補不互換。Type-1 已 living，type-2 是新的獨立 plan
- Production 已驗證 Phase 13，可以放心並行設計 type-2 不會干擾現有運作
- Compaction → next LLM call race condition（2026-04-28 19:35:01 觀察）已併入本 plan 作為 `verify-after-compact` requirement
- Tool 自分塊跟 chunked-digest 兩層**有依賴**：Layer 2（tool）必須先做才能讓 chunked-digest 真正成立（因為 chunked-digest 切點是 round 之間，round 內部不能切，所以單一 tool output 太大時 chunked-digest 救不了）。建議實作 phase 順序：tool framework → 1-2 PoC tools → chunked-digest kind → 擴展剩餘 tools → verify-after-compact → 測試完整化
