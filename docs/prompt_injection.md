# System Prompt 注入結構

本文件說明 OpenCode 如何在每次 LLM 請求中組裝 prompt 內容，包含 system role 與 user-role context preface 兩個物理載體。

> **權威來源**：`specs/prompt-cache-and-compaction-hardening/`（Phase B 落地後）
> **組裝核心**：`packages/opencode/src/session/llm.ts`、`packages/opencode/src/session/static-system-builder.ts`、`packages/opencode/src/session/context-preface.ts`
> **延伸閱讀**：[prompt_dynamic_context.md](./prompt_dynamic_context.md)（dynamic 內容承載架構）

---

## 1. 總覽：雙軌架構（Phase B 後）

Phase B（specs/prompt-cache-and-compaction-hardening）之後，prompt 內容由**兩個物理載體**承載，各自走不同的 cache 命中策略：

```
┌──────────────────────────────────────────────────────────────────┐
│  ┌─ system role (1 message, byte-static within session) ──────┐  │
│  │  Layer 1   Provider Driver Prompt         (always_on)      │  │
│  │  Layer 2   Agent Custom Prompt            (conditional)    │  │
│  │  Layer 3c  AGENTS.md（僅 Main Agent）      (conditional)    │  │
│  │  Layer 5   User Custom System Prompt      (conditional)    │  │
│  │  Layer 6   ─── CRITICAL OPERATIONAL BOUNDARY ───           │  │
│  │  Layer 7   Core System Prompt (SYSTEM.md) (always_on)      │  │
│  │  Layer 8   Identity Reinforcement         (always_on)      │  │
│  └────────────────────────────────────────────────── BP1 ─────┘  │
│                                                                   │
│  ┌─ user role (1 message, kind="context-preface") ─────────────┐ │
│  │  T1 (session-stable)                                        │ │
│  │   - PREFACE_DIRECTIVE_HEADER (R1 mitigation, 永遠首行)       │ │
│  │   - L3a Preload (cwd listing + README summary)              │ │
│  │   - L9 pinned skills                                        │ │
│  │   - L3b Today's date  ────────────────────────── BP2 ─────  │ │
│  │  T2 (decay-tier)                                            │ │
│  │   - L9 active skills                                        │ │
│  │   - L9 summarized skills  ─────────────────────── BP3 ─────  │ │
│  │  trailing (per-turn)                                        │ │
│  │   - L4 enablement matched routing                           │ │
│  │   - lazy tool catalog hint                                  │ │
│  │   - structured-output directive                             │ │
│  │   - subagent return notices                                 │ │
│  │   - quota-low addenda (added by processor.ts)               │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  conversation history ...                                         │
│  user message (typed text)  ──────────────────────── BP4 ─────   │
└───────────────────────────────────────────────────────────────────┘

        Plugin hooks:
          • experimental.chat.system.transform   (static block only)
          • experimental.chat.context.transform  (preface fields)
          • experimental.chat.messages.transform (conversation list)
          • experimental.session.compacting      (compaction agent prompt)
          • chat.params / chat.headers           (HTTP layer)

        Wire Format 決策：
          • system role（標準 API）
          • user role（某些 OAuth proxy）
          • developer role（Codex Responses API）
```

**4 個 cache breakpoint 的分工**（per design.md DD-3）：

| BP | 涵蓋區段 | 失效時機 |
|----|---------|---------|
| **BP1** | 整段 static system | 換 model / 換 agent / 換 account / SYSTEM.md 改 / AGENTS.md 改 |
| **BP2** | static + T1 | T1 內任一變動（cwd 檔案增刪、midnight、pin/unpin） |
| **BP3** | static + T1 + T2 | skill idle decay tick（10 / 30 min 邊界） |
| **BP4** | 全部 | 每 turn 自然推進 |

T3（trailing tier）內容（matched routing、lazy catalog、notices）落在 BP3 與 BP4 之間，**不獨佔 cache breakpoint** — per-turn 變動下無 cache 收益，留給 BP4 對齊 conversation 推進。

---

## 1.1 Phase B 之前的 9 層架構（歷史）

Phase B 之前（pre-2026-05-04），所有內容（含 dynamic）擠在 system role 一個 message 裡，按 1-9 層順序串接：

```
[L1 Driver][L2 Agent] [L3a Preload][L3b Env][L3c AGENTS] [L4 Enablement]
[L5 User-system] [L6 BOUNDARY] [L7 SYSTEM.md][L8 Identity] [L9 Skill]
```

問題：**dynamic 內容（L3a/L3b/L4/L9）散在中間和末尾，任一處變動讓整段 system prefix cache 失效**。

Phase B 把 dynamic 物理下放到 user role，內部按變動頻率（slow → fast）排序，下 4 個 cache breakpoint 在 tier 邊界。權威鏈（SYSTEM > AGENTS > Driver > Skills）不變，僅承載位置從 system role 切到 user role；R1 mitigation 用 `## CONTEXT PREFACE — read but do not echo` directive 替代事後 A/B 驗證。

---

## 2. 各層詳解

### Layer 1：Provider Driver Prompt（BIOS 層）

| 項目 | 內容 |
|------|------|
| **實作** | `SystemPrompt.provider(model)` → `session/system.ts` |
| **注入政策** | `always_on`（`useInstructionsOption` 為 true 時改走 instructions 路徑） |
| **XDG 覆蓋** | `~/.config/opencode/prompts/drivers/<name>.txt` |

根據 `model.api.id` 做 pattern matching 選擇對應的 driver：

| Model Pattern | Driver | 內建檔案 |
|---------------|--------|----------|
| `*claude*` | `claude-code` | `session/prompt/claude-code.txt` |
| `*gpt-5*` | `gpt-5` | `session/prompt/copilot-gpt-5.txt` |
| `*gpt-*` / `*o1*` / `*o3*` | `beast` | `session/prompt/beast.txt` |
| `*gemini-*` | `gemini` | `session/prompt/gemini.txt` |
| `*trinity*` | `trinity` | `session/prompt/trinity.txt` |
| 其他（default） | `qwen` | `session/prompt/qwen.txt` |

**職責**：為特定模型調校工作流、並行策略、few-shot 範例等模型專屬行為。**不重複** SYSTEM.md 已涵蓋的通用規則（安全、語氣、Token 政策），節省約 200-400 tokens/call。

每個 driver 都引用 `prompts/enablement.json` 作為能力發現的 canonical source。

---

### Layer 2：Agent Custom Prompt（任務層）

| 項目 | 內容 |
|------|------|
| **實作** | `SystemPrompt.agentPrompt(name)` → `session/system.ts` |
| **注入政策** | `conditional`（agent 有 prompt 時才注入） |
| **XDG 覆蓋** | `~/.config/opencode/prompts/agents/<name>.txt` |

內建 agent 及其 prompt 狀態：

| Agent | 類型 | 有 Prompt | 用途 |
|-------|------|-----------|------|
| build | primary | - | 建構執行 |
| plan | primary | - | 規劃模式 |
| general | subagent | - | 通用子任務 |
| coding | subagent | `coding.txt` | 程式碼生成/修改 |
| review | subagent | `review.txt` | 程式碼審查 |
| testing | subagent | `testing.txt` | 測試撰寫 |
| docs | subagent | `docs.txt` | 文件撰寫 |
| explore | subagent | `explore.txt` | Codebase 探索 |
| compaction | primary | `compaction.txt` | Context 壓縮 |
| title | primary | `title.txt` | Session 標題生成 |
| summary | primary | `summary.txt` | 對話摘要 |

首次啟動時，`seedAll()` 自動將所有 prompt 複製到 XDG 目錄，之後編輯 XDG 檔案即可覆蓋預設。

---

### Layer 3：Dynamic Session Prompts（情境層）

由 `session/prompt.ts` 組裝，包含三個子部分：

#### 3a. Preloaded Context

| 項目 | 內容 |
|------|------|
| **實作** | `session/preloaded-context.ts` |
| **內容** | 工作目錄前 50 個檔案、README.md 前 1000 字元、Skill context |

```xml
<preloaded_context>
  <env_context>
    <cwd_listing>...</cwd_listing>
    <readme_summary>...</readme_summary>
  </env_context>
  <skill_context>...</skill_context>
</preloaded_context>
```

#### 3b. Environment Metadata

| 項目 | 內容 |
|------|------|
| **實作** | `SystemPrompt.environment()` → `session/system.ts` |
| **內容** | Model ID、Session ID、Parent Session ID、工作目錄、Git 狀態、平台、日期 |

```xml
<env>
  Session ID: ...
  Parent Session ID: ...
  Working directory: ...
  Is directory a git repo: yes/no
  Platform: linux/darwin/win32
  Today's date: ...
</env>
```

#### 3c. AGENTS.md（Orchestrator 策略）

| 項目 | 內容 |
|------|------|
| **實作** | `session/instruction.ts` → `InstructionPrompt.system()` |
| **條件** | **僅 Main Agent**（無 `parentID` 的 session）。Subagent 不載入。 |

載入來源（確定性兩源模型）：

1. **全域**：`~/.config/opencode/AGENTS.md`
2. **專案**：`<project-root>/AGENTS.md`

內容包含：Skill 載入策略、戰術 Skill Map、Core File 責任、Enablement Registry 位置、Subagent 派遣規範。

---

### Layer 4：Enablement Snapshot（能力路由層）

| 項目 | 內容 |
|------|------|
| **實作** | `buildEnablementSnapshot()` → `session/llm.ts` |
| **注入政策** | `conditional`（訊息涉及 tool/skill/MCP 時注入，已存在時跳過） |
| **資料來源** | `session/prompt/enablement.json`（單一真相來源） |

```
[ENABLEMENT SNAPSHOT]
- source: prompts/enablement.json
- core tools: [bash, read, grep, glob, edit, write, task, ...]
- skills available: [agent-workflow, beta-workflow, planner, ...]
- configured mcp: [system-manager (enabled), fetch (enabled), ...]
- policy: prefer registry-guided tool/skill/mcp routing
- matched routing: [匹配的 intent→capability 路由]
```

`enablement.json` 結構：

| 區塊 | 內容 |
|------|------|
| `tools.core` | 12 個核心工具（bash, read, grep, glob, edit, write, task...） |
| `tools.system_manager_mcp` | 系統管理 MCP 工具 |
| `tools.fetch_mcp` | Fetch MCP 工具 |
| `skills.bundled_templates` | 20+ 可按需載入的 skill |
| `mcp_servers.runtime_observed` | MCP server 清單及啟用狀態 |
| `routing.intent_to_capability` | Intent→keyword→tool 路由表 |
| `routing.mcp_policy` | On-demand 啟停策略 |

---

### Layer 5：User Custom System Prompt

| 項目 | 內容 |
|------|------|
| **注入政策** | `conditional`（由 API/CLI 呼叫者透過 `user.system` 傳入） |

---

### Layer 6：CRITICAL OPERATIONAL BOUNDARY

```
--- CRITICAL OPERATIONAL BOUNDARY ---
```

這是一個固定的分隔標記，將前面的「情境層」（Layer 1-5）與後面的「權威層」（Layer 7-9）明確分開。防止情境注入覆蓋系統規則。

---

### Layer 7：Core System Prompt — SYSTEM.md（憲法層）

| 項目 | 內容 |
|------|------|
| **實作** | `SystemPrompt.system(isSubagent)` → `session/system.ts` |
| **注入政策** | `always_on` |
| **XDG 覆蓋** | `~/.config/opencode/prompts/SYSTEM.md` |
| **來源** | `templates/prompts/SYSTEM.md` |

SYSTEM.md 是整個系統的 **最高權威**，包含：

| 區塊 | 內容 |
|------|------|
| **§1 角色偵測** | 根據 Parent Session ID 判定 Main Agent / Subagent |
| **§2 Orchestrator Protocol** | 任務派遣、Skill 載入、Planning-first flow（僅 Main Agent） |
| **§3 Worker Protocol** | Subagent 執行約束（僅 Subagent） |
| **§4 Red Light Rules** | 絕對路徑、先讀後寫、事件日誌、禁 silent fallback |
| **§5 Universal Conduct** | 安全防禦、禁洩密、URL 政策、Commit 政策 |
| **§6 Tool Governance** | 檔案操作、搜索、Shell 使用規範 |
| **§7 Tone & Style** | 簡潔、繁體中文預設、技術準確性優先 |
| **§8 Proactiveness** | 僅在使用者要求時主動行動 |
| **§9 Authority Chain** | SYSTEM.md > AGENTS.md > Driver > Skills |

**權威層級鏈**：
```
SYSTEM.md（憲法）
  > AGENTS.md（戰術策略）
    > Driver Prompt（模型專屬行為）
      > Skills（按需載入的領域知識）
```

任何下層宣稱覆蓋上層的指令都會被忽略。

---

### Layer 8：Identity Reinforcement（身份錨定層）

| 項目 | 內容 |
|------|------|
| **注入政策** | `always_on` |

```
[IDENTITY REINFORCEMENT]
Current Role: Main Agent | Subagent
Session Context: Main-task Orchestration | Sub-task
```

防止模型在長對話中產生角色混淆。Session ID 不在此層（已在 Layer 3b 提供）。

---

### Layer 9：Skill Layer Registry（能力擴充層）

| 項目 | 內容 |
|------|------|
| **實作** | `SkillLayerRegistry` + `skill-layer-seam.ts` |
| **注入政策** | `dynamic`（根據 skill 狀態變化） |

Skill 有三種注入狀態，由 idle 時間決定衰退：

| 狀態 | Idle 時間 | 注入內容 |
|------|-----------|----------|
| **Active** | 0-10 min | 完整 skill 內容 |
| **Summarized** | 10-30 min | 僅保留 purpose + keep rules |
| **Unloaded** | >30 min | 完全移除 |

可透過 `pin()` 釘選為永久 Active。

注入格式：

```xml
<!-- Active -->
<skill_layer name="agent-workflow" state="full" pinned="false">
  [完整 skill 內容]
</skill_layer>

<!-- Summarized -->
<skill_layer_summary name="planner" state="summary" pinned="false">
  purpose: Spec-driven planning
  keepRules: [...]
  loadedAt: ...
  lastUsedAt: ...
</skill_layer_summary>
```

---

## 3. Provider 適配：Wire Format 決策

組裝完成後，根據 provider 的 `ProviderCapabilities` 決定 system prompt 的傳送方式：

| Provider 類型 | `systemMessageRole` | `useInstructionsOption` | Wire Format |
|--------------|---------------------|-------------------------|-------------|
| Anthropic (API key) | `"system"` | `false` | 標準 `{ role: "system" }` 訊息 |
| OpenAI (API key) | `"system"` | `false` | 標準 `{ role: "system" }` 訊息 |
| Gemini (API key) | `"system"` | `false` | 標準 `{ role: "system" }` 訊息 |
| Codex (subscription) | `"developer"` | `true` | Responses API `instructions` + `developer` role |
| Anthropic (OAuth) | `"user"` | `true` | 合併為單一 `{ role: "user" }` 訊息 |
| Gemini CLI (OAuth) | `"user"` | `true` | 合併為單一 `{ role: "user" }` 訊息 |
| GitHub Copilot | `"system"` | `false` | 標準 `{ role: "system" }` 訊息 |

**空區塊過濾**：Anthropic API 不接受空的 system content block，因此所有空字串在傳送前被過濾掉。

---

## 4. 工具注入：平行於 System Prompt 的另一條管線

工具定義不在 system prompt 中，而是透過 `resolveTools()` 獨立組裝後放入請求的 `tools` 參數：

```
resolveTools(input)
  ├─ Core Tool Registry          ← ToolRegistry.tools()
  ├─ MCP Tool Integration        ← MCP.tools()（On-Demand 啟停）
  ├─ Permission Filtering        ← PermissionNext.evaluate()
  └─ Lazy Tool Catalog（可選）   ← 非必要工具延遲載入
```

**On-Demand MCP 政策**：

1. 提取使用者訊息中的關鍵字
2. 比對 `enablement.json` 的 `routing.intent_to_capability` 規則
3. 關鍵字匹配 → 自動啟用對應 MCP server
4. Idle 後自動停用

**Lazy Tool Loading**：

非必要工具不直接暴露給 LLM，而是放入一個 lazy catalog。LLM 需要時透過 `tool_loader` MCP 按需取得工具 schema。減少每次請求的 token 消耗。

---

## 5. SharedContext：跨 Turn 知識累積

`SharedContext` 不直接注入 system prompt，而是作為壓縮和子任務派遣的資料來源：

| 用途 | 注入方式 |
|------|----------|
| **Compaction** | 提供 snapshot 作為壓縮後的工作狀態摘要 |
| **Subagent Context** | 以 `<parent_session_context>` XML 注入子任務的訊息中 |
| **Rebind Checkpoint** | Token 超過閾值時存檔，重啟後從 checkpoint 恢復 |

資料模型：

```typescript
interface SharedContext.Space {
  goal: string              // 當前目標
  files: FileEntry[]        // 讀寫過的檔案
  discoveries: string[]     // 發現的洞察
  actions: ActionEntry[]    // 執行過的工具呼叫
  currentState: string      // 最新進度摘要
}
```

---

## 6. Plugin Hooks：攔截與擴充

系統提供三個後處理 hook 點，允許 plugin 修改最終請求：

| Hook | 位置 | 功能 |
|------|------|------|
| `experimental.chat.system.transform` | 組裝後、傳送前 | 修改整個 `system[]` 陣列 |
| `chat.params` | 參數設定 | 修改 temperature、topP、topK |
| `chat.headers` | HTTP 層 | 注入自訂 headers |

目前活躍的 auth plugin 及其 token 影響：

| Plugin | Token 影響 | 行為 |
|--------|-----------|------|
| `AnthropicAuthPlugin` | ~15 tokens/call | 注入 Claude Code 身份字串 + `mcp_` 工具名前綴 |
| `CodexAuthPlugin` | ~10 tokens/call | Instructions 欄位 + `mcp_` 工具名前綴 |
| `GeminiCLIOAuthPlugin` | 0 | 封鎖 OAuth，僅允許 API key |
| `CopilotAuthPlugin` | 0 | Anthropic-beta header（僅 HTTP 層） |

---

## 7. 設計哲學

### 7.1 權威分層，職責不重疊

- **SYSTEM.md** 管通用規則（安全、語氣、Token 效率）
- **Driver** 管模型專屬行為（工作流、並行策略）
- **Agent Prompt** 管任務專屬指令（review 風格、explore 策略）
- **AGENTS.md** 管專案戰術（Skill 載入時機、Core File 責任）
- **Skills** 管領域知識（按需載入、idle 衰退）

任何一層都不重複其上層已定義的規則。

### 7.2 條件注入，最小化 Token 消耗

- Enablement snapshot 僅在訊息涉及 tool/skill/MCP 時注入
- Skill 按 idle 時間衰退（full → summary → unloaded）
- Tool 支援 lazy loading，按需暴露 schema
- MCP server 支援 on-demand 啟停
- 每次組裝都產出 telemetry（key, chars, tokens, injected），可觀測 token 分佈

### 7.3 XDG 可覆蓋，不需重新編譯

Driver、Agent Prompt、SYSTEM.md 都支援 XDG 路徑覆蓋：

```
~/.config/opencode/prompts/
├── drivers/
│   ├── claude-code.txt
│   ├── gemini.txt
│   └── ...
├── agents/
│   ├── coding.txt
│   ├── review.txt
│   └── ...
└── SYSTEM.md
```

首次啟動自動 seed，之後編輯即生效。

### 7.4 CRITICAL BOUNDARY 防止 Prompt Injection

Layer 6 的固定分隔線確保：
- 情境層（Layer 1-5）的內容來自外部輸入（使用者、專案、環境）
- 權威層（Layer 7-9）的內容來自系統定義（SYSTEM.md、Identity）
- 即使情境層被注入惡意指令，權威層的規則仍然在後方覆蓋

### 7.5 角色感知注入

同一條管線對 Main Agent 和 Subagent 產出不同內容：

| 差異點 | Main Agent | Subagent |
|--------|-----------|----------|
| AGENTS.md | 注入 | 不注入 |
| SYSTEM.md §2 | Orchestrator Protocol | 跳過 |
| SYSTEM.md §3 | 跳過 | Worker Protocol |
| Identity | `Main-task Orchestration` | `Sub-task` |
| Skill Registry | 完整載入 | 不載入 |
