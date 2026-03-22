# OpenCode CMS 分支：系統提示與 Hooks 完整架構

> **文件版本**：2026-02-16  
> **適用分支**：cms  
> **所有路徑均相對於** `packages/opencode/src/`，除非另行標註。

---

## 目錄

1. [系統提示組裝管道（7 步驟）](#系統提示組裝管道7-步驟)
2. [Plugin Hooks 完整盤點](#plugin-hooks-完整盤點)
3. [Plugin.trigger() 觸發點索引](#plugintrigger-觸發點索引)
4. [Config Hooks（opencode.json）](#config-hooksopencodejson)
5. [user-prompt-submit-hook 說明](#user-prompt-submit-hook-說明)
6. [Prompt 優先級鏈](#prompt-優先級鏈)
7. [XDG Prompt 管理全貌](#xdg-prompt-管理全貌)
8. [如何擴充新的 Agent Type](#如何擴充新的-agent-type)
9. [設定檔對照表](#設定檔對照表)

---

## 系統提示組裝管道（7 步驟）

System prompt 在每次 LLM 呼叫時於 `session/llm.ts:118-170` 組裝。共 7 個步驟，依序串接為 `systemParts` 陣列，最終合併為單一字串。

### 總覽

```
┌─────────────────────────────────────────────────────────────┐
│  llm.ts:118  const system = []                              │
│  llm.ts:119  const systemParts = [                          │
│    Step 1  BIOS Driver Layer          (llm.ts:120-122)      │
│    Step 2  Agent Custom Prompt        (llm.ts:124-125)      │
│    Step 3  Dynamic Session Prompts    (llm.ts:127-128)      │
│    Step 4  User Custom System Prompt  (llm.ts:130-131)      │
│    Step 5  CORE SYSTEM PROMPT         (llm.ts:133-137)      │
│    Step 6  Identity Reinforcement     (llm.ts:139-144)      │
│  ]                                                          │
│  llm.ts:147  system.push(systemParts.join("\n"))             │
│  Step 7    Gemini XML Optimization    (llm.ts:149-170)      │
│                                                             │
│  Post-processing:                                           │
│    experimental.chat.system.transform (llm.ts:174-178)      │
│    chat.params                        (llm.ts:209-226)      │
│    chat.headers                       (llm.ts:228-240)      │
└─────────────────────────────────────────────────────────────┘
```

---

### 第 1 步：BIOS Driver 層

**組裝位置**：`llm.ts:120-122`  
**實作函式**：`SystemPrompt.provider(input.model)` → `system.ts:150-175`  
**載入機制**：`loadPrompt("drivers/<name>.txt", internalContent)` → `system.ts:112-132`  
**XDG 管理**：✅

```typescript
// llm.ts:120-122
...(usesInstructions ? [] : await SystemPrompt.provider(input.model)),
```

根據 `model.api.id` 進行 pattern matching，選擇對應的 driver prompt 檔案：

| Model pattern              | Driver 名稱   | 內建檔案                           |
| -------------------------- | ------------- | ---------------------------------- |
| `*trinity*`                | `trinity`     | `session/prompt/trinity.txt`       |
| `*gpt-5*`                  | `gpt-5`       | `session/prompt/copilot-gpt-5.txt` |
| `*gpt-*` / `*o1*` / `*o3*` | `beast`       | `session/prompt/beast.txt`         |
| `*gemini-*`                | `gemini`      | `session/prompt/gemini.txt`        |
| `*claude*`                 | `claude-code` | `session/prompt/claude-code.txt`   |
| 其他 (default)             | `qwen`        | `session/prompt/qwen.txt`          |

**注意**：當 `usesInstructions === true`（OpenAI Codex 等使用 `options.instructions` 的 provider）時，Driver 層被跳過，改由 `SystemPrompt.instructions()` → `system.ts:134-136` 提供，內容為 `session/prompt/codex_header.txt`。

使用者覆蓋路徑：`~/.config/opencode/prompts/drivers/<name>.txt`

---

### 第 2 步：Agent 自訂 Prompt

**組裝位置**：`llm.ts:124-125`  
**實作函式**：`SystemPrompt.agentPrompt(name)` → `system.ts:144-148`  
**內建 Registry**：`AGENT_PROMPTS` → `system.ts:45-54`  
**載入機制**：`loadPrompt("agents/<name>.txt", internal)` → `system.ts:112-132`  
**Agent 定義**：`agent/agent.ts:70-225`（`getNativeAgents()` async）  
**XDG 管理**：✅（本分支遷移完成）

```typescript
// llm.ts:124-125
...(input.agent.prompt ? [input.agent.prompt] : []),
```

每個原生 agent 的 prompt 來自 `SystemPrompt.agentPrompt()`，在 `getNativeAgents()` 中以 `Promise.all()` 並行載入（`agent.ts:76-85`）。

| Agent      | 類型     | 有 Prompt | XDG 路徑                                           |
| ---------- | -------- | --------- | -------------------------------------------------- |
| build      | primary  | ❌        | —                                                  |
| plan       | primary  | ❌        | —                                                  |
| general    | subagent | ❌        | —                                                  |
| coding     | subagent | ✅        | `~/.config/opencode/prompts/agents/coding.txt`     |
| review     | subagent | ✅        | `~/.config/opencode/prompts/agents/review.txt`     |
| testing    | subagent | ✅        | `~/.config/opencode/prompts/agents/testing.txt`    |
| docs       | subagent | ✅        | `~/.config/opencode/prompts/agents/docs.txt`       |
| explore    | subagent | ✅        | `~/.config/opencode/prompts/agents/explore.txt`    |
| compaction | primary  | ✅        | `~/.config/opencode/prompts/agents/compaction.txt` |
| title      | primary  | ✅        | `~/.config/opencode/prompts/agents/title.txt`      |
| summary    | primary  | ✅        | `~/.config/opencode/prompts/agents/summary.txt`    |

首次啟動後，`seedAll()` (`system.ts:65-106`) 會自動將所有 agent prompt 複製到 XDG 目錄。之後編輯 XDG 檔案即可覆蓋預設行為，無需重新編譯。

---

### 第 3 步：動態 Session/Task Prompt

**組裝位置**：`llm.ts:127-128`  
**組裝來源**：`session/prompt.ts:586-592`  
**XDG 管理**：❌（執行期動態生成，正確行為）

```typescript
// llm.ts:127-128
...input.system,
```

`input.system` 在 `prompt.ts:586-592` 組裝，包含 3 個子部分：

#### 3a. Preloaded Context

**檔案**：`session/preloaded-context.ts:6-77`

內容：

- 工作目錄前 50 個檔案列表（`fs.readdir` → `.slice(0, 50)`）
- README.md 前 1000 字元
- Skill context（目前 `skillNames` 為空陣列 — core skills 已改為按需載入）

輸出格式：

```xml
<preloaded_context>
  <env_context>
    <cwd_listing>...</cwd_listing>
    <readme_summary>...</readme_summary>
  </env_context>
  <skill_context>...</skill_context>
</preloaded_context>
```

#### 3b. Environment

**函式**：`SystemPrompt.environment()` → `system.ts:211-237`

內容：model ID、session ID、parent session ID、工作目錄、git 狀態、平台、日期。

輸出格式：

```xml
<env>
  Session ID: ...
  Parent Session ID: ...
  Working directory: ...
  Is directory a git repo: yes/no
  Platform: linux/darwin/win32
  Today's date: ...
</env>
<directories>...</directories>
```

#### 3c. AGENTS.md（確定性兩源模型）

**檔案**：`session/instruction.ts`

載入邏輯（`InstructionPrompt.system()` → `instruction.ts:68-99`）：

1. **全域**：`~/.config/opencode/AGENTS.md`（單一固定路徑，無備援）
2. **專案**：`<project-root>/AGENTS.md`（固定路徑，無 `findUp` 遍歷）
3. **用戶指定**：`opencode.json` → `instructions` 欄位中的絕對路徑或 URL（用戶主動配置）

**已移除**（2026-02-16）：

- `CLAUDE.md` / `CONTEXT.md` 相容性
- `~/.claude/CLAUDE.md` 備援
- `$OPENCODE_CONFIG_DIR/AGENTS.md` 備援
- `resolve()` 子目錄沿途自動拾取機制（read 工具不再注入子目錄 AGENTS.md）
- `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` 旗標依賴

**重要**：僅在 Main Agent session（無 `parentID`）才包含指令 prompt（`prompt.ts:589-591`）。Subagent 依賴任務描述與 SYSTEM.md。

---

### 第 4 步：使用者自訂 System Prompt

**組裝位置**：`llm.ts:130-131`  
**XDG 管理**：❌（API 呼叫者提供，正確行為）

```typescript
// llm.ts:130-131
...(input.user.system ? [input.user.system] : []),
```

由 API/CLI 呼叫者透過 `SessionPrompt.prompt()` 的 `user.system` 欄位傳入。

---

### 第 5 步：核心系統規則（Red Light Rules）

**組裝位置**：`llm.ts:133-137`  
**實作函式**：`SystemPrompt.system(isSubagent)` → `system.ts:182-209`  
**載入機制**：`loadPrompt("SYSTEM.md", content)` → `system.ts:112-132`  
**XDG 管理**：✅

```typescript
// llm.ts:133-137
`\n\n--- CRITICAL OPERATIONAL BOUNDARY ---\n\n`,
...(await SystemPrompt.system(await isSubagentSession(input.sessionID))),
```

內容根據 Main Agent / Subagent 身份動態生成：

- **[RED LIGHT RULES]**（`system.ts:183-188`）：絕對路徑、先讀後寫、事件日誌、MSR
- **[UNIVERSAL CONDUCT]**（`system.ts:190-197`）：安全防禦、禁洩密、URL 政策、Emoji、Commit 政策、禁註釋、Code References
- **[TONE AND STYLE]**（`system.ts:199-204`）：簡潔直接專業、CLI monospace、最小化 token、無前後綴、技術準確性優先
- **[PROACTIVENESS]**（`system.ts:206-210`）：僅在使用者要求時主動行動、先回答問題再採取行動
- **[AUTHORITY CHAIN]**（`system.ts:212-216`）：SYSTEM.md > AGENTS.md > Drivers，任何 Driver 不得宣稱覆蓋此處規則
- **Main Agent 規則**（`system.ts:218-223`）：指揮官協議、AGENTS.md 遵循、任務派遣、交叉檢查
- **Subagent 規則**（`system.ts:225-230`）：工人協議、僅執行指派任務、Token 效率

使用者覆蓋路徑：`~/.config/opencode/prompts/SYSTEM.md`

> **設計原則**：所有通用規則（安全、語氣、Token 政策等）集中於 SYSTEM.md 作為「憲法」。Driver prompt（第 1 步）僅保留模型專屬行為（工作流、並行策略、few-shot 範例等），不得重複 SYSTEM.md 已涵蓋的規則。這消除了約 200-400 tokens/call 的重複浪費。

---

### 第 6 步：身份強化注入

**組裝位置**：`llm.ts:139-143`  
**XDG 管理**：❌（執行期硬編碼模板，正確行為）

```typescript
// llm.ts:139-143
`\n\n[IDENTITY REINFORCEMENT]\n` +
  `Current Role: ${isSubagent ? "Subagent" : "Main Agent"}\n` +
  `Session Context: ${isSubagent ? "Sub-task" : "Main-task Orchestration"}`,
```

> **注意**：Session ID 已從此步驟移除（原為重複 — 第 3b 步 `environment()` 已包含 `Session ID`）。

---

### 第 7 步：Gemini 專用 XML 優化

**組裝位置**：`llm.ts:149-170`  
**XDG 管理**：❌（程式碼邏輯，正確行為）  
**觸發條件**：僅在 `model.id` 包含 `"gemini"` 時執行

功能：擷取所有 `AGENTS.md` 區塊，包裹於 `<behavioral_guidelines>` XML 標籤中，並將 `IMPORTANT:` header 提前至最頂部。目的是利用 Gemini 對 XML 結構的較佳注意力分配。

```typescript
// llm.ts:152-153
const modelId = input.model?.id?.toLowerCase() || ""
if (modelId.includes("gemini") && system[0]) {
```

---

### 後處理

組裝完成後，依序觸發 3 個 Plugin hooks：

1. **`experimental.chat.system.transform`**（`llm.ts:174-178`）：可修改整個 `system[]` 陣列。目前無任何 plugin 註冊此 hook。若 plugin 清空 `system[]`，fallback 機制會還原原始內容（`llm.ts:179-181`）。
2. **`chat.params`**（`llm.ts:209-226`）：設定 temperature、topP、topK、options。
3. **`chat.headers`**（`llm.ts:228-240`）：設定自訂 HTTP headers。

---

## Plugin Hooks 完整盤點

以下為 7 個活躍 plugin 所註冊的所有 hooks。觸發點位於 `llm.ts`、`prompt.ts`、`tool-invoker.ts`、`permission/index.ts` 等檔案。

### 活躍 Plugin 清單

Plugin 在 `plugin/index.ts:25-35` 以 `INTERNAL_PLUGINS` 陣列註冊：

| #   | 變數名稱               | 註冊名稱     | 檔案                           |
| --- | ---------------------- | ------------ | ------------------------------ |
| 1   | `CodexAuthPlugin`      | `codex`      | `plugin/codex.ts`              |
| 2   | `CopilotAuthPlugin`    | `copilot`    | `plugin/copilot.ts`            |
| 3   | `GitlabAuthPlugin`     | `gitlab`     | `@gitlab/opencode-gitlab-auth` |
| 4   | `GeminiCLIOAuthPlugin` | `gemini-cli` | `plugin/gemini-cli/plugin.ts`  |
| 5   | `AnthropicAuthPlugin`  | `anthropic`  | `plugin/anthropic.ts`          |

### 活躍 Hooks 清單

| #   | Plugin               | Hook           | 檔案:行號                            | 功能描述                                                                                                                                               | 觸發頻率              | Token 影響                      | 條件                         |
| --- | -------------------- | -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------- | ---------------------------- |
| 1   | CodexAuthPlugin      | `auth`         | `plugin/codex.ts:352-630`            | OpenAI OAuth/API 認證，Codex token 刷新，重寫請求至 Codex endpoint，加 `mcp_` 前綴到工具名稱，過濾模型，成本歸零                                       | 每次 LLM 呼叫 (fetch) | ~10 tokens (instructions field) | 僅 OAuth + openai provider   |
| 2   | CodexAuthPlugin      | `chat.headers` | `plugin/codex.ts:631-636`            | 加 `originator`, `User-Agent`, `session_id` headers                                                                                                    | 每次 LLM 呼叫         | 0 (僅 HTTP header)              | 僅 `openai` provider         |
| 3   | CopilotAuthPlugin    | `auth`         | `plugin/copilot.ts:23-344`           | GitHub Copilot device-code OAuth，設定 Copilot 專用 headers，呼叫 `/user` API 取得 username，成本歸零                                                  | 每次 LLM 呼叫 (fetch) | 0                               | 僅 OAuth                     |
| 4   | CopilotAuthPlugin    | `chat.headers` | `plugin/copilot.ts:345-363`          | 加 `anthropic-beta` header (Claude via Copilot)，`x-initiator: agent` (subagent)                                                                       | 每次 LLM 呼叫         | 0 (僅 HTTP header)              | 僅 `github-copilot` provider |
| 5   | GitlabAuthPlugin     | `auth`         | `@gitlab/.../dist/index.js:209-467`  | GitLab OAuth/PAT 認證，token 刷新 (帶 mutex)                                                                                                           | 認證檢查時            | 0                               | 僅有 auth data 時            |
| 6   | GeminiCLIOAuthPlugin | `auth`         | `plugin/gemini-cli/plugin.ts:28-159` | Gemini CLI 認證，**封鎖 OAuth 帳號**僅允許 API key，重寫 API URL/headers，成本歸零                                                                     | 每次 LLM 呼叫 (fetch) | 0                               | 僅 API key auth              |
| 7   | AnthropicAuthPlugin  | `auth`         | `plugin/anthropic.ts:104-563`        | Claude CLI 訂閱 OAuth，token 刷新 (帶 mutex)，**注入 Claude Code 身份字串到 system prompt**，加 `mcp_` 前綴到所有工具名稱，加 `?beta=true` 到 endpoint | 每次 LLM 呼叫 (fetch) | **~15 tokens** (身份前綴)       | 僅 OAuth/subscription auth   |

### 未使用的 Hooks

以下 hooks 定義於框架（`packages/plugin/src/index.ts:162-241`）但目前沒有任何 plugin 註冊：

| Hook 名稱                              | 介面定義行號 | 說明                                                                        |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `config`                               | `:164`       | 設定檔修改                                                                  |
| `chat.message`                         | `:172-181`   | 使用者訊息接收                                                              |
| `chat.params`                          | `:185-188`   | LLM 參數修改（有觸發點但無註冊）                                            |
| `permission.ask`                       | `:193`       | 權限檢查攔截                                                                |
| `command.execute.before`               | `:194-197`   | 命令執行前                                                                  |
| `tool.execute.before`                  | `:198-201`   | 工具執行前                                                                  |
| `tool.execute.after`                   | `:202-209`   | 工具執行後                                                                  |
| `experimental.chat.messages.transform` | `:210-218`   | 歷史訊息轉換                                                                |
| `experimental.chat.system.transform`   | `:219-224`   | System prompt 轉換（僅保留框架層觸發點；舊版 provider-specific 實作已移除） |
| `experimental.session.compacting`      | `:232-235`   | Session 壓縮自訂                                                            |
| `experimental.text.complete`           | `:236-239`   | 文本完成後處理                                                              |
| `shell.env`                            | `:240`       | Shell 環境變數注入                                                          |

### 重點觀察

1. **Token 消耗最高**：AnthropicAuthPlugin `auth` — 每次請求注入 ~15 tokens Claude Code 身份字串 + `mcp_` 工具名前綴
2. **複雜度最高**：AntigravityOAuthPlugin `auth` — 約 1700 行的 fetch handler，包含帳號輪替、rate-limit backoff、空回應重試
3. **重複註冊**：Antigravity 有兩個變體（OAuth + Legacy）從同一 factory 產生，handler 重複
4. **主動封鎖**：GeminiCLIOAuthPlugin 硬性封鎖 OAuth，只允許 API key
5. **每次 LLM 呼叫必經 hooks**：`auth`（fetch handler）、`chat.headers` — 其餘為條件觸發或未註冊

---

## Plugin.trigger() 觸發點索引

所有呼叫 `Plugin.trigger()` 的位置（即 hook 實際被執行的地方）：

| 觸發點                   | Hook 名稱                              | 檔案:行號                            | 觸發時機                                          |
| ------------------------ | -------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| LLM system prompt 後處理 | `experimental.chat.system.transform`   | `session/llm.ts:174-178`             | 每次 LLM 呼叫，system prompt 組裝完成後           |
| LLM 參數組裝             | `chat.params`                          | `session/llm.ts:209-226`             | 每次 LLM 呼叫，設定 temperature/topP/topK/options |
| LLM HTTP headers         | `chat.headers`                         | `session/llm.ts:228-240`             | 每次 LLM 呼叫，設定自訂 HTTP headers              |
| 訊息歷史轉換             | `experimental.chat.messages.transform` | `session/prompt.ts:561`              | 每次 LLM 呼叫，處理歷史訊息前                     |
| 文本完成後處理           | `experimental.text.complete`           | `session/processor.ts:426`           | 每個 assistant text part 完成後                   |
| 使用者訊息持久化         | `chat.message`                         | `session/user-message-persist.ts:17` | 使用者送出訊息時                                  |
| 命令執行前               | `command.execute.before`               | `session/command-dispatcher.ts:15`   | 執行 slash command 前                             |
| 工具執行前               | `tool.execute.before`                  | `session/tool-invoker.ts:75`         | 每個工具呼叫前                                    |
| 工具執行後               | `tool.execute.after`                   | `session/tool-invoker.ts:115`        | 每個工具呼叫後                                    |
| 壓縮前自訂               | `experimental.session.compacting`      | `session/compaction.ts:154`          | Session 壓縮時                                    |
| Shell 環境變數 (PTY)     | `shell.env`                            | `pty/index.ts:144`                   | PTY shell 啟動時                                  |
| Shell 環境變數 (Bash)    | `shell.env`                            | `tool/bash.ts:176`                   | Bash 工具執行時                                   |
| 權限檢查                 | `permission.ask`                       | `permission/index.ts:134`            | 權限確認時                                        |
| Agent 描述生成           | `experimental.chat.system.transform`   | `agent/agent.ts:329`                 | Agent `generate()` 時（AI 自動生成 agent 描述）   |

---

## Config Hooks（opencode.json）

定義於 `config/config.ts:1189-1210`。Schema 支援兩種 hook：

### `experimental.hook.file_edited`

```typescript
// config.ts:1191-1200
file_edited: z.record(
  z.string(),                    // glob pattern
  z.object({
    command: z.string().array(), // shell command
    environment: z.record(z.string(), z.string()).optional(),
  }).array(),
).optional(),
```

### `experimental.hook.session_completed`

```typescript
// config.ts:1202-1208
session_completed: z.object({
  command: z.string().array(),
  environment: z.record(z.string(), z.string()).optional(),
}).array().optional(),
```

**⚠️ 重要：僅有 schema 定義，無任何 runtime 執行代碼。** 整個 codebase 搜尋 `file_edited` 和 `session_completed` 僅出現在 `config.ts` 的 schema 定義中。這兩個 hook 是 stub，目前完全不會觸發。

---

## user-prompt-submit-hook 說明

出現於 3 個 driver prompt 文字檔中：

- `session/prompt/claude.txt:80`
- `session/prompt/anthropic-20250930.txt:122`
- `session/prompt/claude-code.txt:56`

作為 system prompt 內的文字指令，告訴 AI「遇到 `<user-prompt-submit-hook>` 回饋時，視為來自使用者」。

**這不是已實作的 hook 機制**，僅為 prompt 中的概念性文字。系統中沒有任何 `user-prompt-submit-hook` 的程式碼實作。

---

## Prompt 優先級鏈

### Agent Prompt 優先級（由高到低）

```
1. opencode.json → agent.<name>.prompt     ← 最高（agent.ts:259）
2. ~/.config/opencode/prompts/agents/<name>.txt  ← XDG 覆蓋（system.ts:144-148）
3. packages/opencode/src/agent/prompt/<name>.txt ← 內建預設（system.ts:45-54）
```

**實作路徑**：

1. `agent.ts:76-85` — `getNativeAgents()` 呼叫 `SystemPrompt.agentPrompt()` 取得 prompt
2. `system.ts:144-148` — `agentPrompt()` 先查 XDG 覆蓋，fallback 到 `AGENT_PROMPTS[]` 內建
3. `agent.ts:259` — `state()` 中以 `value.prompt ?? item.prompt` 合併，`opencode.json` 設定優先

### Driver Prompt 優先級（由高到低）

```
1. ~/.config/opencode/prompts/drivers/<name>.txt  ← XDG 覆蓋（system.ts:112-132）
2. packages/opencode/src/session/prompt/<name>.txt ← 內建預設（system.ts:8-20）
```

### System Prompt 優先級

```
1. ~/.config/opencode/prompts/SYSTEM.md  ← XDG 覆蓋（system.ts:208）
2. 內建硬編碼內容                         ← system.ts:182-207
```

---

## XDG Prompt 管理全貌

### 目錄結構

```
~/.config/opencode/prompts/
├── SYSTEM.md                              ← 第 5 步：核心系統規則
├── drivers/                               ← 第 1 步：BIOS Driver
│   ├── claude-code.txt
│   ├── anthropic.txt
│   ├── anthropic-legacy.txt
│   ├── beast.txt
│   ├── gemini.txt
│   ├── qwen.txt
│   ├── trinity.txt
│   ├── codex.txt
│   └── gpt-5.txt
├── agents/                                ← 第 2 步：Agent Prompt
│   ├── coding.txt
│   ├── review.txt
│   ├── testing.txt
│   ├── docs.txt
│   ├── explore.txt
│   ├── compaction.txt
│   ├── title.txt
│   └── summary.txt
└── session/                               ← 其他 session prompt 資源
    ├── plan.txt
    ├── plan-reminder-anthropic.txt
    ├── max-steps.txt
    ├── build-switch.txt
    └── instructions.txt
```

### Seed 機制

**函式**：`SystemPrompt.seedAll()` → `system.ts:65-106`

- 首次呼叫時（透過 `provider()` → `system.ts:152`），fire-and-forget 將所有內建 prompt 寫入 XDG 目錄
- 僅在檔案不存在時寫入（不覆蓋使用者修改）
- 每個 process 生命週期僅執行一次（`seeded` flag）

### 快取機制

**函式**：`SystemPrompt.loadPrompt()` → `system.ts:112-132`

- 以 `mtime` 為 cache key，檔案修改後自動重新載入
- 記憶體內快取（`Map<string, { content, mtime }>`）

---

## 如何擴充新的 Agent Type

### 情境 A：純 prompt 自訂（不改程式碼）

1. **編輯 XDG 檔案**：直接修改 `~/.config/opencode/prompts/agents/<name>.txt`
2. **即時生效**：`loadPrompt()` 使用 `mtime` 快取策略，檔案修改後下次 LLM 呼叫自動載入新內容
3. **還原預設**：刪除 XDG 檔案，系統會自動 fallback 到內建 prompt

### 情境 B：新增原生 Agent Type（需改程式碼）

完整流程，共 3 個檔案、5 個步驟：

```
步驟 1  建立 prompt 檔案
        ↓
步驟 2  在 system.ts 註冊到 AGENT_PROMPTS
        ↓
步驟 3  在 agent.ts 的 getNativeAgents() 加入定義
        ↓
步驟 4  （可選）在 opencode.json agent config 做額外設定
        ↓
步驟 5  啟動 → seedAll() 自動 seed 到 XDG
```

#### 步驟 1：建立 prompt 檔案

```bash
cat > packages/opencode/src/agent/prompt/security.txt << 'EOF'
You are a security review subagent. Evaluate code for security vulnerabilities.

Focus on:
- Input validation and sanitization
- Authentication and authorization flaws
- Injection attacks (SQL, XSS, command injection)
- Sensitive data exposure

Do not run tools or modify code. Output a concise security findings report.
EOF
```

#### 步驟 2：在 `system.ts` 註冊

```typescript
// packages/opencode/src/session/system.ts

// 1. 加入 import
import PROMPT_AGENT_SECURITY from "../agent/prompt/security.txt"

// 2. 加入 AGENT_PROMPTS 登記
const AGENT_PROMPTS: Record<string, string> = {
  coding: PROMPT_AGENT_CODING,
  // ...existing entries...
  security: PROMPT_AGENT_SECURITY, // ← 新增
}
```

#### 步驟 3：在 `agent.ts` 的 `getNativeAgents()` 加入定義

```typescript
// packages/opencode/src/agent/agent.ts

async function getNativeAgents(...) {
  const [coding, ..., security] = await Promise.all([
    SystemPrompt.agentPrompt("coding"),
    // ...existing entries...
    SystemPrompt.agentPrompt("security"),  // ← 新增
  ])

  return {
    // ...existing agents...
    security: {
      name: "security",
      description: "Reviews code for security vulnerabilities.",
      permission: sub,
      options: {},
      prompt: security,
      mode: "subagent",
      native: true,
    },
  }
}
```

#### 步驟 4：（可選）`opencode.json` 設定覆蓋

```jsonc
{
  "agent": {
    "security": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "description": "Custom security reviewer",
      "prompt": "你是安全專家...", // 優先級高於 XDG 與內建
      "temperature": 0.2,
      "steps": 5,
    },
  },
}
```

#### 步驟 5：驗證

```bash
ls ~/.config/opencode/prompts/agents/
# 啟動後應包含 security.txt
```

### 情境 C：停用原生 Agent

```jsonc
{
  "agent": {
    "docs": { "disable": true },
  },
}
```

實作位置：`agent.ts:244-246` — `if (value.disable) { delete result[key] }`

---

## 設定檔對照表

### 核心原始碼檔案

| 檔案                           | 職責                                                          | 關鍵行號             |
| ------------------------------ | ------------------------------------------------------------- | -------------------- |
| `session/llm.ts`               | System prompt 7 步驟組裝主體                                  | `118-170`, `174-240` |
| `session/system.ts`            | `SystemPrompt` namespace：seed、load、provider、agent、system | `45-237`             |
| `session/prompt.ts`            | Session prompt 迴圈：`input.system` 組裝                      | `586-592`            |
| `session/preloaded-context.ts` | Preloaded context：CWD 列表、README、Skills                   | `6-77`               |
| `session/instruction.ts`       | AGENTS.md 確定性兩源載入（全域 + 專案 `.opencode/`）          | `16-99`              |
| `agent/agent.ts`               | Agent 定義：`getNativeAgents()`、config 合併                  | `70-290`             |
| `plugin/index.ts`              | Plugin 註冊表、`Plugin.trigger()`                             | `20-35`              |
| `config/config.ts`             | Config schema（含 `experimental.hook` stub）                  | `1189-1210`          |

### Plugin 檔案

| 檔案                           | Plugin               | 主要 Hook              |
| ------------------------------ | -------------------- | ---------------------- |
| `plugin/codex.ts`              | CodexAuthPlugin      | `auth`, `chat.headers` |
| `plugin/copilot.ts`            | CopilotAuthPlugin    | `auth`, `chat.headers` |
| `plugin/anthropic.ts`          | AnthropicAuthPlugin  | `auth`                 |
| `plugin/gemini-cli/plugin.ts`  | GeminiCLIOAuthPlugin | `auth`                 |
| `@gitlab/opencode-gitlab-auth` | GitlabAuthPlugin     | `auth`                 |

### 框架介面

| 檔案                           | 職責                                     | 關鍵行號  |
| ------------------------------ | ---------------------------------------- | --------- |
| `packages/plugin/src/index.ts` | `Hooks` 介面（全部 15 種 hook 型別定義） | `162-241` |

### Prompt 資源檔案

| 目錄              | 內容                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/prompt/` | Driver .txt 檔：claude-code, anthropic, beast, gemini, qwen, trinity, codex_header, copilot-gpt-5, plan, plan-reminder-anthropic, max-steps, build-switch |
| `agent/prompt/`   | Agent .txt 檔：coding, review, testing, docs, explore, compaction, summary, title                                                                         |

### 設定檔（執行期）

| 檔案                          | 位置                                            | 職責                                                  |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `opencode.json`               | 專案根目錄                                      | Agent 設定覆蓋、permission、experimental.hook（stub） |
| `accounts.json`               | `~/.config/opencode/`                           | 帳號儲存（OAuth token、API key）                      |
| `AGENTS.md`                   | `~/.config/opencode/` 或 `<project>/.opencode/` | 指揮官指令（Main Agent 專用，確定性兩源）             |
| `~/.config/opencode/prompts/` | XDG config                                      | 所有可覆蓋的 prompt 檔案                              |
