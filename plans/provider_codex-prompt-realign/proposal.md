# Proposal: provider_codex-prompt-realign

## Why

OpenCode 的 codex provider 在 May 9 commit `b59ccb96f` 之後，把整個 system prompt 全部塞進 Responses API 的 `instructions` 欄位（driver + agent + AGENTS.md + userSystem + SYSTEM.md + identity，~11k tokens / 45,820 chars），並把自製的 `## CONTEXT PREFACE` user-role 訊息插在最後一個 user 之前。

這個結構與 codex-cli 上游（`refs/codex/codex-rs/core/`）的設計嚴重偏離。上游的 `instructions` 只放駕駛員人格（`BaseInstructions`，275 行 default 或 model-specific prompt md），其餘 AGENTS.md / EnvironmentContext / Skills / Apps / Plugins / Permissions 一律走 `input[]` 內的 developer-role 與 user-role 結構化 fragments。

實證：
- 2026-05-11 incident `ses_1ee7b8bccffeG73CQxXDDSw3og`，連續 turn 的 `cached_tokens` 卡在 4608 不動，無論 delta=true/false、無論是否 hasPrevResp、無論帳號穩定與否
- 同 daemon 同時間段另一 session `ses_1ee114c2cffez1xu00cIPVXLRZ` 用同一份 codex provider 卻能拿到 137k+ cache_read（後驗：那條 session 在 `/home/pkcs12/projects/opencode` 工作，剛好 cwdListing 的 directory 也很穩定，但這不是主因；主因是上游結構讓 prefix cache 在 `input[]` 內聚成連續長 prefix）
- 連帶損壞：`prompt_cache_key` 改成 `codex-${accountId}-${threadId}` 多了 accountId 前綴，每次 rotation cache namespace 重新冷啟，這一條也偏離了上游的純 `thread_id`

User 要求：**無條件對齊上游**。先把上游架構複製過來，再重新設計 OpenCode 自己的 SYSTEM.md / AGENTS.md / skills / MCP 怎麼接進去。

## Original Requirement Wording (Baseline)

- 2026-05-11: "開一個plan, fix_codex_deviation。緊急優先處理。你先把codex-cli原架構複製過來，然後再思考我們的SYSTEM.md和AGENT.md，skills，mcp等怎麼調和在裏面。"
- 2026-05-11: "我覺得要小心如果system prompt裏有用到@include語法就有可能帶進動態的東西"
- 2026-05-11: "昨天我們動過system prompt stack，做了一些去重、去衝突、改階層的事。都是system prompt層級的改動"
- 2026-05-11: "我們必須無條件對齊官版。人格檔要先還原。其他的部份你再重新設計怎麼重排"

## Requirement Revision History

- 2026-05-11: initial draft created via plan_create
- 2026-05-11: confirmed scope = full alignment with upstream codex-cli wire structure; persona file restoration prioritized

## Effective Requirement Description

1. **人格檔還原優先**：替換 `packages/opencode/src/session/prompt/codex.txt` 與 `templates/prompts/drivers/codex.txt` 為上游 `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`（275 行）。後續引入 model-specific 版（gpt_5_2_prompt.md 等）按 `model.api.id` 路由
2. **Wire 結構對齊**：`convert.ts` 的 `instructions` 欄位**只**放 driver / persona text，不再串接 agent / AGENTS.md / SYSTEM.md / userSystem / identity 等
3. **Developer-role bundle**：在 `input[]` 開頭組一個 developer-role item，內含 permissions / personality_spec / apps / skills / plugins instructions（按需）。對齊 `build_initial_context()` 的輸出順序
4. **User-role contextual bundle**：緊跟在 developer-role 後組一個 user-role item，內含 `UserInstructions`（AGENTS.md w/ `# AGENTS.md instructions for <dir>` 標頭和 `</INSTRUCTIONS>` 結尾）+ `EnvironmentContext`（`<environment_context>` w/ cwd / shell / current_date / timezone）
5. **廢除 `## CONTEXT PREFACE` 自創結構**：T1/T2/trailing 三層概念解構到上游對應 fragments；剩下沒有上游對應的（lazy catalog / structured-output directive / subagent return notices / skill registry summarized）需要明確判斷該歸到 developer-role 還是 user-role
6. **`prompt_cache_key` 對齊**：拿掉 `codex-${accountId}-${threadId}` 的 accountId 前綴，回到純 `threadId`（=sessionId）；多帳號 cache 隔離問題改由 OpenAI 那邊本來就有的 cache TTL 與 chain ownership 處理
7. **OpenCode 自有資產的歸屬**：明確界定 SYSTEM.md（OpenCode constitution）、AGENTS.md（global + project）、skills（MCP）、MCP apps（permissions/apps_instructions 等）各自落到上游哪個 fragment；不能找到對應的，必須在 design.md 寫清楚為什麼新增以及它的標籤格式

## Scope

### IN
- `packages/opencode-codex-provider/src/convert.ts` — `instructions` 拆出 driver、其餘搬進 input[]
- `packages/opencode-codex-provider/src/provider.ts` — `prompt_cache_key` 拿掉 accountId 前綴
- `packages/opencode/src/session/llm.ts` — system 組裝重構：拆掉 staticBlock 的 monolithic 串接，改成 fragment 列表
- `packages/opencode/src/session/system.ts` / `static-system-builder.ts` — driver 角色重新定位（只回傳駕駛員人格），其餘層級下放到 fragment producers
- `packages/opencode/src/session/context-preface.ts` / `context-preface-types.ts` — 廢除自創 T1/T2/trailing 結構或重新映射到上游 fragment 系統
- `packages/opencode/src/session/prompt/codex.txt` 與 `templates/prompts/drivers/codex.txt` — 替換為上游 default.md
- 引入新檔（建議）：`packages/opencode/src/session/context-fragments/` 對應 upstream `codex-rs/core/src/context/` 結構，每個 fragment 一個檔
- `prompt_cache_key` rotation behaviour 改動連帶影響 `transport-ws.ts` 的 per-account swap 邏輯（要驗證沒副作用）

### OUT
- 不在這個 plan 處理：anthropic/google/其他 provider 的 system prompt 結構（他們是各自的 wire 形態，本次只動 codex provider）
- 不在這個 plan 處理：tools 序列化格式（`convertTools` 維持現狀）
- 不在這個 plan 處理：reasoning encrypted_content 的快取行為（屬於上游 OpenAI 的事）
- 不在這個 plan 處理：multi-agent / subagent label 的 wire 表現（上游 `format_environment_context_subagents` 的等價物，先不做）

## Non-Goals

- 不重寫 codex provider 的 transport 層（WebSocket / HTTP / continuation）
- 不引入「OpenCode 風格」的命名慣例去裝飾上游結構 — 對齊就是對齊，標籤名稱 / 角色 / 順序都跟著上游
- 不在這個 plan 內處理 cache 監測 / telemetry 的改進（可以後續做）
- 不在這個 plan 內處理「補上 ContextualUserFragment trait 抽象」的程式碼層整理 — 先把 wire 結構搬對；trait 化是後續優化

## Constraints

- **Backwards compat with stored sessions**：現有的對話歷史（持久化在 SQLite）已經包含舊結構下的 user-role 訊息（含舊版 `## CONTEXT PREFACE` 文字）；新版 wire 結構必須能讀舊歷史而不報錯。Strategy：對話歷史照原樣餵給模型，新結構只影響「組裝下一個 turn 的 prefix」
- **Migration story for live `instructions`**：rotation 期間從舊結構切到新結構，server 端的 `previous_response_id` 鏈會因為 instructions byte 改變而失效。需要強制一次 chain reset（已經有 `resetWsSession` API 可用）
- **不破壞 deferred tools / lazy catalog 機制**：那些是 OpenCode 自有功能，沒有上游對應；要在 design.md 明確安頓
- **不破壞 attachment-lifecycle v6 的 per-turn image inline**：圖片 inline 是 OpenCode 自有；現在掛在 trailing tier，新架構要找新家
- **必須能用 codex-cli 上游的 prompt md 直接 drop-in**（先對 default.md，後續對 model-specific 版）

## What Changes

- 替換 `prompt/codex.txt`（27 行 → 275 行上游 default）
- `convert.ts` 拆 instructions
- 新增一層 fragment 組裝（推薦目錄 `context-fragments/`）
- llm.ts 移除自創 preface 組裝；改呼叫 fragment 組裝層
- prompt_cache_key 改回純 threadId
- 新增 events log: `events/event_2026-05-11_persona-restored.md`、`events/event_2026-05-11_wire-realigned.md`

## Capabilities

### New Capabilities
- **Fragment-based context assembly**：context 內容以 fragment 列表組裝，每塊 fragment 自己決定 ROLE / START_MARKER / END_MARKER / body()，可獨立 dedup / 替換 / 補注
- **Model-specific persona routing**：`SystemPrompt.provider(model)` 根據 model.api.id 選擇對應的上游 prompt md（gpt_5_2_prompt.md 等），找不到則 fallback 到 default.md

### Modified Capabilities
- **`SystemPrompt.provider(...)`**：行為變窄，只回駕駛員人格 text，不再混入 SYSTEM.md / AGENTS.md
- **`buildStaticBlock(...)`** 等價物：可能廢除，由 fragment list 取代；如保留只裝駕駛員 + identity（identity 也可能下放成獨立 fragment）
- **`buildPreface(...)` / `context-preface.ts`**：T1/T2/trailing 解構，每個原本的 tier 內容找到上游對應 fragment，或建立新 fragment（須在 design.md 證成）

## Impact

### 程式碼
- `packages/opencode-codex-provider/src/{convert.ts,provider.ts,transport-ws.ts}`
- `packages/opencode/src/session/{llm.ts,system.ts,static-system-builder.ts,context-preface.ts,context-preface-types.ts,prompt/codex.txt}`
- `templates/prompts/drivers/codex.txt`

### 測試
- `packages/opencode/test/session/cache-miss-diagnostic.test.ts` — 可能仍可用，hash 比對對象變成 driver-only
- `packages/opencode-codex-provider/test/convert.test.ts` — 需更新預期 instructions 內容、新增 input[] developer/user bundle 預期
- 新增 e2e test：拋兩個 turn 確認 `cached_tokens` 在 prefix-cache TTL 內成長

### Operators
- Cache cost 預期降低（prefix cache 重新生效）
- 既有 codex sessions 第一次切到新版 daemon 會經歷一次 chain reset（一次性成本）

### Docs
- `specs/architecture.md` 的 codex provider 段落要改寫
- `docs/events/event_<date>_codex-realign.md` 記事件（commit 之後寫）
