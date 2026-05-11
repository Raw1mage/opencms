# Design: provider_codex-prompt-realign

## Context

OpenCode 的 codex provider 在 May 9 commit `b59ccb96f` 把 system prompt 全塞 Responses API 的 `instructions` 欄位，並插一個自製 `## CONTEXT PREFACE` user-role 訊息。這個 wire 形態跟上游 codex-cli (`refs/codex/codex-rs/core/`) 嚴重偏離，導致 prefix cache 在 delta=true 模式下卡 4608 tokens 不動，無論帳號穩定與否。本 plan 把 wire 結構重排回上游樣貌：`instructions` 只放駕駛員人格、其他全進 `input[]` 走 developer-role + user-role 兩個 bundle、`prompt_cache_key` 改回純 sessionId。

### Related upstream-alignment spec

- [`../provider_codex-installation-id/`](../provider_codex-installation-id/) — closes the per-request `client_metadata["x-codex-installation-id"]` gap that the byte-diff investigation surfaced. **Not** the cache-4608 root cause (that is `openai/codex#20301`, a server-side GPT-5.5 regression, closed in this plan's event log `event_2026-05-11_closing-note-...`). Treated as upstream-alignment hygiene that shrinks the suspect set for future regression chases.

## Goals / Non-Goals

### Goals
- `cached_tokens` 在 healthy delta 模式下從第二 turn 開始 ≥ 90% input_tokens
- `instructions` byte 在同 session 同 driver 內 hash-stable
- input[] 結構逐項可對應到上游 `build_initial_context()` 的輸出
- OpenCode 自有資產（SYSTEM.md / AGENTS.md / skills / MCP / lazy catalog 等）每塊都有明確的 fragment 歸屬與標籤

### Non-Goals
- 不重寫 codex provider 的 transport 層（WebSocket / HTTP / continuation）
- 不動其他 provider（anthropic / google）的 system prompt 結構
- 不引入「OpenCode 風格」命名裝飾上游結構，標籤 / 角色 / 順序對齊就是對齊
- 不在本次補上 ContextualUserFragment trait 抽象的程式碼層整理（先把 wire 結構搬對）

## Architecture overview

兩階段重構：

**Stage A — 把上游架構複製過來**（user 第一順位指示）
1. 還原人格檔（`prompt/codex.txt` → 上游 default.md 整份）
2. 在 OpenCode 程式碼中建立對應上游 `codex-rs/core/src/context/` 結構的 fragment 系統
3. 改寫 `convert.ts` 讓 `instructions` 只放駕駛員人格 / `input[]` 開頭塞 developer-role + user-role bundle

**Stage B — 把 OpenCode 自有資產調和進來**
- SYSTEM.md（OpenCode constitution）→ 上游沒對應；歸到 developer-role bundle 的開頭，作為 "OpenCode-specific protocols" 一個獨立 fragment
- AGENTS.md（global + project）→ 對齊上游 `UserInstructions`，user-role
- skills (SKILL.md / capability registry) → 對齊上游 `AvailableSkillsInstructions` + `skill_instructions`，developer-role / user-role 視 fragment 類型
- MCP apps → 對齊上游 `AppsInstructions`，developer-role
- attachment 圖片 inline / lazy catalog / structured-output directive / quota-low 等 OpenCode 自有 → 各自評估，多數可歸到 developer-role 的 OpenCode-specific 區段

## Upstream reference: codex-cli wire layout

### `instructions` (top-level field)

**只一份內容**：`BaseInstructions.text`，由 `prompts/base_instructions/default.md` 或 model-specific `<model_slug>_prompt.md` 提供。

- `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` — 275 行 default
- `refs/codex/codex-rs/core/gpt_5_codex_prompt.md` — 68 行
- `refs/codex/codex-rs/core/gpt_5_1_prompt.md` — 331 行
- `refs/codex/codex-rs/core/gpt_5_2_prompt.md` — 298 行
- `refs/codex/codex-rs/core/gpt-5.1-codex-max_prompt.md` — 80 行
- `refs/codex/codex-rs/core/gpt-5.2-codex_prompt.md` — 80 行

模型路由由 `ModelInfo.base_instructions` 欄位（[refs/codex/codex-rs/protocol/src/openai_models.rs:275](refs/codex/codex-rs/protocol/src/openai_models.rs#L275)）決定。

### `input[]` 結構（從 [refs/codex/codex-rs/core/src/session/mod.rs:2553-2761](refs/codex/codex-rs/core/src/session/mod.rs#L2553-L2761) `build_initial_context()` 解出）

```
input = [
  // 1. ONE bundled developer-role item — order:
  developer_message[
    model_switch_instructions          // 切換 model 時的 update item
    permissions_instructions           // sandbox/approvals 規則
    developer_instructions             // per-turn 開發者指示
    memory_tool_developer_instructions // memory tool 用時注入
    collaboration_mode_instructions    // collaboration_mode 用時注入
    realtime_update                    // realtime 模式
    personality_spec_instructions      // personality override 時
    apps_instructions                  // MCP connectors
    skills_instructions                // available skills
    plugin_instructions                // plugins capability summary
    commit_message_instruction         // codex git commit feature
  ]

  // 2. OPTIONAL multi-agent usage hint, also developer-role
  developer_message[ multi_agent_v2_usage_hint_text ]

  // 3. ONE bundled user-role contextual item — order:
  user_message[
    UserInstructions       // AGENTS.md, "# AGENTS.md instructions for <dir>...</INSTRUCTIONS>"
    EnvironmentContext     // <environment_context>cwd/shell/current_date/timezone</environment_context>
  ]

  // 4. (guardian-only, separate) developer item with developer_instructions
  ...

  // 5. 對話流（user / assistant / function_call / function_call_output ...）
]
```

### Fragment ROLE 對照表

| Fragment | ROLE | START_MARKER |
|---|---|---|
| `EnvironmentContext` | user | `<environment_context>` |
| `UserInstructions` | user | `# AGENTS.md instructions for ` |
| `TurnAborted` | user | `<turn_aborted>` |
| `SubagentNotification` | user | `<subagent_notification>` |
| `SkillInstructions` | user | `<skill>` |
| `UserShellCommand` | user | (codex shell echo) |
| `ApprovedCommandPrefixSaved` | developer | (empty) |
| `AppsInstructions` | developer | APPS_INSTRUCTIONS_OPEN_TAG |
| `AvailablePluginsInstructions` | developer | PLUGINS_INSTRUCTIONS_OPEN_TAG |
| `AvailableSkillsInstructions` | developer | SKILLS_INSTRUCTIONS_OPEN_TAG |
| `CollaborationModeInstructions` | developer | COLLABORATION_MODE_OPEN_TAG |
| `GuardianFollowupReviewReminder` | developer | (empty) |
| `HookAdditionalContext` | developer | (empty) |
| `ImageGenerationInstructions` | developer | (empty) |
| `ModelSwitchInstructions` | developer | `<model_switch>` |
| `NetworkRuleSaved` | developer | (empty) |
| `PermissionsInstructions` | developer | `<permissions instructions>` |
| `PersonalitySpecInstructions` | developer | `<personality_spec>` |
| `PluginInstructions` | developer | (empty) |
| `RealtimeStartInstructions` / `RealtimeEnd` / `RealtimeStartWith` | developer | REALTIME_CONVERSATION_OPEN_TAG |

來源：`grep -rE "ROLE: &'static str|START_MARKER" refs/codex/codex-rs/core/src/context/*.rs`。

### `prompt_cache_key`

[refs/codex/codex-rs/core/src/client.rs:713](refs/codex/codex-rs/core/src/client.rs#L713)：

```rust
let prompt_cache_key = Some(self.state.thread_id.to_string());
```

純 `thread_id`。沒有 account 維度。

## Harmonization: OpenCode-specific assets → upstream slots

### SYSTEM.md（OpenCode constitution）

**性質**：跨 provider、跨 agent、跨 session 的 OpenCode 全域操作協議（Read-Before-Write、Absolute Paths、Working Cache、Code Review / Frontend Design 模式、Presentation defaults 等）。

**上游沒有直接對應**，因為 codex-cli 是 OpenAI 自家 CLI，所有規則都在 base_instructions 裡。

**歸屬決定**：在 developer-role bundle 開頭加一個自定義 fragment `OpencodeProtocolInstructions`：
- ROLE: `developer`
- START_MARKER: `<opencode_protocol>`
- END_MARKER: `</opencode_protocol>`
- body: SYSTEM.md 全文（`SystemPrompt.system()` 的回傳值）

理由：SYSTEM.md 跟 PermissionsInstructions / AppsInstructions 是同一個語義層次（都是「行為規則」而非「環境/身份/輸入」），所以放 developer。標籤格式仿 `<permissions instructions>` 風格。

### AGENTS.md（global `~/.config/opencode/AGENTS.md` + project `<root>/AGENTS.md`）

**性質**：使用者層級 + 專案層級的指令補注。

**對齊上游 `UserInstructions`**（[refs/codex/codex-rs/core/src/context/user_instructions.rs](refs/codex/codex-rs/core/src/context/user_instructions.rs)）：
- ROLE: `user`
- START_MARKER: `# AGENTS.md instructions for `（後接目錄路徑）
- END_MARKER: `</INSTRUCTIONS>`
- body: `format!("{}\n\n<INSTRUCTIONS>\n{}\n", directory, text)`

**OpenCode 變化點**：global + project 兩份。Strategy：
- 兩份各自包成獨立 `UserInstructions` fragment（一份 directory=`~/.config/opencode`、另一份 directory=project root）
- 都進 user-role bundle，順序：global 在前、project 在後

### Skills（SKILL.md + capability registry）

**性質**：OpenCode 的 skill 系統，兩種狀態：available（可用 skill metadata 摘要）、active（已載入 SKILL.md 全文）。

**對齊上游兩個 fragment**：
- `AvailableSkillsInstructions`（developer-role, `SKILLS_INSTRUCTIONS_OPEN_TAG`）— 對應 OpenCode 的「可用 skill metadata 摘要」（list + 1-line description）
- `SkillInstructions`（user-role, `<skill>`）— 對應 OpenCode 的「active SKILL.md 內容注入」

**OpenCode 變化點**：active skill 多份時，每份做一個 `SkillInstructions` fragment（按 pinned > active 排序）。對應上游 `AvailableSkillsInstructions::from(available_skills).render()` 的 single-blob 形式，OpenCode 不照搬而是每 skill 一個 fragment（差異點：因為 dedup / 替換語義是 per-skill）。

**summarized skills**（OpenCode 自有，上游無）：歸到 `AvailableSkillsInstructions` 的 metadata 區（不展開 body），加註 `state="summarized"`。

### MCP apps

**對齊上游 `AppsInstructions`**（[refs/codex/codex-rs/core/src/context/apps_instructions.rs](refs/codex/codex-rs/core/src/context/apps_instructions.rs)）：
- ROLE: `developer`
- START_MARKER: `APPS_INSTRUCTIONS_OPEN_TAG`
- 上游用 `connectors::list_accessible_and_enabled_connectors_from_manager` 列舉 MCP

**OpenCode 變化點**：MCP apps 包含 stdio + HTTP；body 結構照上游照抄，list 來源換成 OpenCode 的 `ManagedAppRegistry`。

### Attachment / Image inline

**性質**：OpenCode v4/v5/v6 的圖片 inline + active set FIFO。

**上游對應**：`ImageGenerationInstructions`（developer-role, empty marker）— 但這只是「指示模型如何產生圖」，不是「給模型看圖」。上游 codex-cli 的「給模型看圖」沒有 fragment，是直接走 `ResponseItem::Message` 的 multi-modal content。

**歸屬決定**：圖片 binary 仍走 user-role 對話訊息的 content 部分（`{type:"image_url", image_url:...}`），跟著最近的 user 訊息。**廢除 preface trailing 把圖片塞 system 那邊的設計**。`<attached_images>` inventory 文字說明做成獨立 user-role fragment `AttachedImagesInventory`（OpenCode 自有，前綴 `<attached_images>`）。

### Lazy catalog / Structured output / Quota-low / Subagent return notice / Enablement snapshot

| OpenCode 自有 | 對齊建議 |
|---|---|
| Lazy catalog（per-turn deferred tools 摘要） | developer-role fragment `LazyCatalogInstructions`，標籤 `<lazy_catalog>` |
| Structured output directive（JSON schema 模式） | developer-role fragment `StructuredOutputDirective`，標籤 `<structured_output>` |
| Quota-low addenda | developer-role fragment `QuotaLowNotice`，標籤 `<quota_status>` |
| Subagent return notice | user-role fragment `SubagentReturnNotice`，標籤 `<subagent_return>`（仿 `<subagent_notification>`） |
| Enablement snapshot | developer-role fragment `EnablementSnapshot`，標籤 `<enablement>` |

每個 fragment 有自己 ROLE + START_MARKER + END_MARKER + body()。

### Identity 區段

OpenCode 現有 `[IDENTITY REINFORCEMENT]\nCurrent Role: Main Agent / Subagent`。

**歸屬決定**：上游沒對應；最接近的是 `personality_spec_instructions`（developer-role, `<personality_spec>`）。OpenCode 的 identity 不是人格而是身份（main vs subagent），語義不同。

新增 fragment `RoleIdentity`：
- ROLE: `developer`
- START_MARKER: `<role_identity>`
- body: `Current Role: ${role}\nSession Context: ${ctx}`

放 developer-role bundle 開頭（在 SYSTEM.md / OpenCode protocol 之前），讓 main vs subagent 的差異最先被讀到。

## Decisions

(populated by spec_record_decision)
- **DD-1**: DD-1: Wire 結構**無條件對齊上游 codex-cli `refs/codex/codex-rs/core/`**。`instructions` 只放駕駛員人格，其他全進 `input[]` 走 developer-role 與 user-role bundle。理由：上游設計讓 prefix cache 在 input[] 形成連續長 prefix，這是 cache hit 能延續的前提；自製 SSOT (May 9 b59ccb96f) 把 system 全塞 instructions 的做法已實證導致 cached_tokens 卡 4608 不動。
- **DD-2**: DD-2: 還原人格檔到上游 `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`（275 行整份）作為 `prompt/codex.txt` 與 `templates/prompts/drivers/codex.txt`。模型專屬版（gpt_5_2_prompt.md / gpt_5_codex_prompt.md 等）下一步做 `model.api.id` 路由。理由：user 第一順位指示「人格檔要先還原」；上游 default 是不依賴 codex-cli 自有工具描述的最通用版本，OpenCode 的工具集差異交給後續 model-specific 路由處理。
- **DD-3**: DD-3: SYSTEM.md（OpenCode constitution）歸到 developer-role bundle 開頭，作為 OpenCode 自有 fragment `OpencodeProtocolInstructions`（START_MARKER `<opencode_protocol>`）。理由：SYSTEM.md 是「行為規則」語義層次，跟 PermissionsInstructions / AppsInstructions 同類，所以放 developer 而非 user。上游沒對應的 fragment 是因為 codex-cli 不需要再加自家 CLI 的全域協議；OpenCode 是跨 provider，SYSTEM.md 是必要存在。
- **DD-4**: DD-4: AGENTS.md（global + project）對齊上游 `UserInstructions`（user-role），各自獨立 fragment：global 來自 `~/.config/opencode/AGENTS.md` directory 標 `~/.config/opencode`、project 來自 `<root>/AGENTS.md` directory 標 project root。順序 global → project。標籤格式照搬上游 `# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>\n<text>\n</INSTRUCTIONS>`。
- **DD-5**: DD-5: Skills 系統拆兩層對齊上游：(a) available skill metadata 摘要 → developer-role `AvailableSkillsInstructions`（單一 blob）；(b) active SKILL.md 內容 → user-role `SkillInstructions` per-skill（每 skill 獨立 fragment 而非單一 blob，差異點是 OpenCode 需要 per-skill dedup/替換語義）。Summarized state（OpenCode 自有）歸到 (a) 的 metadata，加 state="summarized" 屬性，不展開 body。
- **DD-6**: DD-6: `prompt_cache_key` 從 `codex-${accountId}-${threadId}` 改回上游純 `threadId`（=sessionId）。理由：上游 [refs/codex/codex-rs/core/src/client.rs:713](refs/codex/codex-rs/core/src/client.rs#L713) 用純 thread_id；多帳號的 cache 隔離本來就由 OpenAI 端的 chain ownership + cache TTL 處理，不需在 cache_key 多加維度。連帶影響：transport-ws 的 per-account WS swap 路徑要驗證沒副作用（swap 是處理 chain id 不是 cache key）。
- **DD-7**: DD-7: 廢除 `## CONTEXT PREFACE — read but do not echo` user-role 自創訊息結構（OpenCode 獨家，無上游對應）。T1/T2/trailing 三層分別對應到上游 fragment：T1 (preload/cwd/pinned skills/date) → `EnvironmentContext` + `AvailableSkillsInstructions`；T2 (active/summarized skills) → `SkillInstructions` per-skill + `AvailableSkillsInstructions` summarized 區；trailing (lazy catalog / structured output / quota / subagent return / image inventory) → 各自獨立 OpenCode fragment（developer 或 user 視語義決定）。
- **DD-8**: DD-8: Identity 區段（OpenCode 自有 `[IDENTITY REINFORCEMENT]\nCurrent Role: Main Agent / Subagent`）改成獨立 fragment `RoleIdentity`（developer-role, START_MARKER `<role_identity>`），放 developer bundle 開頭（在 OpencodeProtocolInstructions 之前）。理由：identity 不是 personality 而是身份；放最開頭讓 main vs subagent 差異最先被讀到，影響後續所有規則的解讀。
- **DD-9**: DD-9: Stage A 切換期間提供 feature flag `OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1` 走舊路徑，預設 off。第一次 daemon 升級到新版時 broadcast 一次 `resetWsSession` 給每個 active codex session，避免 server-side `previous_response_id` chain 因 instructions byte 突變而 hard fail。

## Code anchors

(populated by spec_add_code_anchor)
- `packages/opencode/src/session/context-fragments/fragment.ts` — `ContextFragment` — Fragment shape definition; mirrors upstream codex-rs/core/src/context/fragment.rs ContextualUserFragment trait
- `packages/opencode/src/session/context-fragments/assemble.ts` — `assembleBundles` — Bundle assembler; mirrors upstream build_initial_context() output (one developer item + one user item)
- `packages/opencode/src/session/context-fragments/environment-context.ts` — `buildEnvironmentContextFragment` — Upstream-aligned EnvironmentContext (cwd/shell/current_date/timezone) wrapped in &lt;environment_context&gt;
- `packages/opencode/src/session/context-fragments/user-instructions.ts` — `buildUserInstructionsFragment` — Upstream-aligned UserInstructions for AGENTS.md (per scope: global / project)
- `packages/opencode/src/session/context-fragments/opencode-protocol-instructions.ts` — `buildOpencodeProtocolFragment` — OpenCode-only fragment carrying SYSTEM.md (constitution) at developer-role with &lt;opencode_protocol&gt; markers (DD-3)
- `packages/opencode/src/session/context-fragments/role-identity.ts` — `buildRoleIdentityFragment` — OpenCode-only fragment encoding Main Agent vs Subagent at developer-role with &lt;role_identity&gt; markers (DD-8)

## Critical Files

- `packages/opencode-codex-provider/src/convert.ts` — `instructions` 欄位拆解；`input[]` 開頭組 bundle 的入口
- `packages/opencode-codex-provider/src/provider.ts:163` — `prompt_cache_key` 計算
- `packages/opencode-codex-provider/src/transport-ws.ts:756` — per-account WS swap，DD-6 需驗證
- `packages/opencode/src/session/llm.ts:567-651` — system 組裝；新架構下大幅縮減
- `packages/opencode/src/session/system.ts:234` — `SystemPrompt.provider(model)`，model-specific persona 路由的入口
- `packages/opencode/src/session/static-system-builder.ts` — `buildStaticBlock` 將被縮減為 driver-only
- `packages/opencode/src/session/context-preface.ts` / `context-preface-types.ts` — Stage B 廢除
- `packages/opencode/src/session/prompt/codex.txt` — bundled persona（已替換為上游 default.md）
- `templates/prompts/drivers/codex.txt` — template persona（已替換為上游 default.md）
- `refs/codex/codex-rs/core/src/session/mod.rs:2553-2761` — 上游 `build_initial_context()` 對照源
- `refs/codex/codex-rs/core/src/client.rs:680-734` — 上游 `make_request()` 對照源
- `refs/codex/codex-rs/core/src/context/*.rs` — 上游所有 ContextualUserFragment 實作參考
- `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` — 上游 default base_instructions
- `refs/codex/codex-rs/core/gpt_5_*.md` — model-specific persona files（Stage B.4 路由用）

## Submodule pointers

- `refs/codex` — codex-cli upstream reference; pinned commit (TBD at design time, capture before stage A start)

## Diagrams

- `idef0.json` / `idef0.svg` — context-fragment 組裝的 ICOM 分解
- `grafcet.json` / `grafcet.svg` — runtime evolution（per-turn fragment list 組合 → instructions + input[] 組合 → outbound）

## Context layer map（slow→fast cache-stability ranking）

This section is the **single-page reference** for "where does each OpenCode asset land in the outbound request, and how stable is it under prefix cache".

### Wire-level slots（codex provider, upstream-aligned path）

| Slot | Body location | What rides here | Static / Dynamic | Cache invalidation trigger |
|---|---|---|---|---|
| **L0 driver** | `instructions` (top-level field) | `SystemPrompt.provider(model)` → persona file (`prompt/codex.txt` = upstream `default.md`) | **Static** per session | Persona file edit OR model switch (driver routed per-model) |
| **L1 RoleIdentity** | `input[0]` developer bundle, fragment #1 | Main vs Subagent label | **Static** per session | Subagent transition only (never flips mid-session) |
| **L2 SYSTEM.md** | `input[0]` developer bundle, fragment #2 (`opencode_protocol`) | `SystemPrompt.system()` → SYSTEM.md verbatim | **Static** per session | User edits SYSTEM.md (rare) |
| **L3 Agent overlay** | `input[0]` developer bundle, fragment #3 (`opencode_agent_instructions`) | `agent.prompt` + `user.system` | **Semi-dynamic** | `user.system` can carry per-turn extras (lazy catalog, structured-output, quota-low notice, subagent return note) — **THIS IS THE FASTEST-CHURNING FRAGMENT in the developer bundle** |
| **L4 AGENTS.md global** | `input[1]` user bundle, fragment #1 (`agents_md:global`) | `~/.config/opencode/AGENTS.md` | **Static** per session | User edits global AGENTS.md (rare); skipped for subagents |
| **L5 AGENTS.md project** | `input[1]` user bundle, fragment #2 (`agents_md:project`) | `<root>/AGENTS.md` | **Static** per session | User edits project AGENTS.md (rare); skipped for subagents |
| **L6 EnvironmentContext** | `input[1]` user bundle, fragment #3 (`environment_context`) | cwd + shell + currentDate + timezone | **Daily-dynamic** | `currentDate` flips at midnight → invalidates everything *after* the date marker (cwd/shell/timezone stable per session) |
| **L7 Conversation history** | `input[2..]` | prior user/assistant/tool messages | **Per-turn churn** | Every new turn appends; prefix of prior messages stays cached |
| **L8 Tools** | top-level `tools` field (parallel to `input[]`) | MCP tools + built-in tools (Bash/Read/Edit/...) + `skill` tool | **Semi-static** | Tool set changes when MCP server starts/stops, agent capabilities change, or skill registry rebuilds |
| **L9 client_metadata** | top-level `client_metadata` object | `x-codex-installation-id` (per-install UUID), `x-codex-window-id` (`conversationId:generation`) | **Static** per install (UUID) + per session (window) | Install file deletion (UUID); subagent spawn (window generation bump) |
| **L10 prompt_cache_key** | top-level field | `sessionId` (post Stage A.4 — no accountId mix-in) | **Static** per session | Session id rotates (new session) |

### Inside-bundle fragment ordering（slow-first invariant）

**Developer bundle** (`input[0]`):
```
[ RoleIdentity ]              ← L1, static
[ OpencodeProtocol / SYSTEM ] ← L2, static
[ AgentInstructions ]         ← L3, semi-dynamic ← LAST so churn truncates only the tail
```

**User bundle** (`input[1]`):
```
[ AGENTS.md global ]          ← L4, static
[ AGENTS.md project ]         ← L5, static
[ EnvironmentContext ]        ← L6, daily-dynamic ← LAST so currentDate flip truncates only tail bytes
```

→ Slow-first ordering is **respected within each bundle**. The fastest-churn fragment sits last in its bundle so cache hash matches the maximum byte prefix until the churn point.

### Cross-slot ordering（what the model actually sees）

```
instructions field    ── L0 driver (static)
─────────────────────
input[0]  developer   ── L1 → L2 → L3
input[1]  user        ── L4 → L5 → L6
input[2..] history    ── L7 (per-turn growth)
─────────────────────
tools field            ── L8 (parallel; separate cache dimension)
client_metadata        ── L9 (parallel; identity dimension)
prompt_cache_key       ── L10 (the cache namespace itself)
```

The Responses API hashes `input[]` as one prefix-cacheable stream. So bundle ordering matters: L1-L6 sit BEFORE every conversation turn, so their stability protects the whole prefix from invalidation as the conversation grows. L7 history is the only intentionally per-turn append; prefix cache survives up to and including the last assistant turn from the previous round.

### Known imperfections / future work

- **L3 placement is not optimal.** `user.system` carries per-turn extras (lazy catalog, quota-low, etc.) and currently lives inside the developer bundle as fragment #3. If `user.system` content changes between turns, the developer bundle hash breaks even though L1+L2 are byte-stable. **Future option**: split L3 out into a third bundle item between developer and user bundles, or move `user.system` extras into a trailing user-role message (after history) so they ride per-turn churn instead of polluting the static head.
- **Skills (SKILL.md catalog)** are not currently in the bundle at all on the upstream-wire codex path. The `skill` tool's description lists available skill names; loading a skill goes through tool invocation, not context injection. This is upstream-faithful (codex-cli also does not bundle skills) and is the correct slot for skills under this design.
- **MCP schemas** appear via the `tools` field, separate from `input[]`. The Responses API caches `tools` independently; tool schema changes only invalidate the tool dimension. If MCP servers register/unregister mid-session this dimension churns; mitigation lives in tool-registration discipline, not in this wire layout.
- **L6 EnvironmentContext could split** `currentDate` into a trailing micro-fragment so the daily flip invalidates fewer bytes (today the whole environment_context tail goes). Low priority — daily cache break is already the second-slowest churn after L0/L1/L2.

### Quick checklist for new context content

When adding a new piece of context, ask in order:
1. Is it really context, or is it a tool? → tools go to L8, not into bundles.
2. Does it change within a single session? → if no, it belongs in L1-L2 (developer) or L4-L5 (user) head, slow-first.
3. Does it change per-turn? → it must sit at the tail of its bundle, or ride L7 conversation history.
4. Is it identity (per-install / per-window)? → L9 `client_metadata`, not in `input[]`.
5. Is it a routing key? → L10 `prompt_cache_key`, not content.

Violating slow-first ordering inside a bundle is the most common regression — every byte placed before a churn point invalidates with it.

## Migration & rollout

1. **Stage A.1（最小衝擊）**：人格檔還原，rebuild + restart。預期 cache_read 不會立即恢復（因為 wire 結構還是舊的），但人格檔內容對齊上游可獨立驗證
2. **Stage A.2**：建 fragment 框架（`packages/opencode/src/session/context-fragments/`），先實作 EnvironmentContext / UserInstructions / OpencodeProtocolInstructions / RoleIdentity 四個必要的
3. **Stage A.3**：改 `convert.ts` 把 instructions 拆成 driver only；改 `llm.ts` 把 fragment list 組成 input[] 開頭兩個 bundle；保留舊路徑 feature flag（`OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1`）方便 rollback
4. **Stage A.4**：改 `prompt_cache_key`，連帶處理 transport-ws 的 per-account swap
5. **Stage B.1**：把剩下的 OpenCode-specific fragment 補上（apps / skills / lazy catalog / etc.）
6. **Stage B.2**：廢除 `context-preface.ts` 的 T1/T2/trailing 結構；移除 `## CONTEXT PREFACE` user-role 訊息
7. **Validation**：跑兩個 turn，驗證 `cached_tokens` 從第二 turn 開始 ≥ 90% input_tokens

每個 stage 一個 commit，可獨立 revert。

## Risks / Trade-offs

- **R1：模型行為改變**。上游 default.md 是給 OpenAI 自家用的；裡頭可能假設了一些 codex-cli 才有的工具名稱（`shell`, `apply_patch`, `update_plan`）。OpenCode 的 toolset 不完全相同。**Mitigation**：對照 OpenCode 工具列表，看 default.md 哪些工具描述需要本地化；保留上游措辭但補足 OpenCode 特有 tool reference
- **R2：existing session chain failure**。切換瞬間 server 端 `previous_response_id` chain 因為 instructions byte 改變而失效。**Mitigation**：rollout 同步 broadcast 一次 `resetWsSession` 給每個 active session
- **R3：subagent 行為差異**。subagent 模式的 SYSTEM.md 已經包含 subagent vs main 邏輯；新架構需 RoleIdentity fragment 顯式承擔。**Mitigation**：subagent regression test 必須涵蓋
- **R4：Plugin transform `experimental.chat.system.transform`**。現在 plugin 對整個 system[] 操作；新架構下 plugin 只能對 driver 操作。**Mitigation**：擴充 Plugin trigger，新增 `experimental.chat.context.fragment.transform` 讓 plugin 對 fragment list 操作

## Definition of done

1. `cached_tokens` 在第二 turn ≥ 90% input_tokens（healthy session 連續 turn 之間）
2. `instructions` byte 在同一 session 同一 driver 內穩定（hash 不變）
3. 上游 [refs/codex/codex-rs/core/src/session/mod.rs:2553-2761](refs/codex/codex-rs/core/src/session/mod.rs#L2553-L2761) `build_initial_context()` 的 input[] item 結構在我們的 wire 上能逐項對應
4. `prompt_cache_key` 為純 sessionId
5. e2e test：跑兩個 turn，第二 turn 的 cached_tokens 顯著大於 4608
6. `wiki_validate` 對本 plan 沒有未解的 broken_links / drift
