# 系統提示與 Hooks

OpenCode 內部 LLM 呼叫的 system prompt 組裝流程與 plugin hook 清單。

---

## 理解組裝管道

System prompt 在每次 LLM 呼叫時於 `packages/opencode/src/session/llm.ts:119-170` 組裝。共 7 個步驟，依序串接。

---

### 第 1 步：BIOS Driver 層

`SystemPrompt.provider(input.model)` 在 `llm.ts:122` 被呼叫。定義於 `packages/opencode/src/session/system.ts:104-129`。

根據 `model.api.id` 載入對應的 `.txt` driver prompt：

| Model pattern            | Driver 檔案                        |
| ------------------------ | ---------------------------------- |
| `*trinity*`              | `session/prompt/trinity.txt`       |
| `*gpt-5*`                | `session/prompt/copilot-gpt-5.txt` |
| `*gpt-*`, `*o1*`, `*o3*` | `session/prompt/beast.txt`         |
| `*gemini-*`              | `session/prompt/gemini.txt`        |
| `*claude*`               | `session/prompt/claude-code.txt`   |
| default                  | `session/prompt/qwen.txt`          |

使用者可在 `~/.config/opencode/prompts/drivers/<name>.txt` 覆蓋預設 driver。

---

### 第 2 步：Agent 自訂 Prompt

`input.agent.prompt` 在 `llm.ts:125` 被讀取。定義於 `packages/opencode/src/agent/agent.ts:75-225`。

每個原生 agent 都有自己的 prompt 檔案。**已遷移至 XDG 管理**：

- 內建預設：`packages/opencode/src/agent/prompt/<name>.txt`
- 使用者覆蓋：`~/.config/opencode/prompts/agents/<name>.txt`
- 載入機制：`SystemPrompt.agentPrompt("<name>")` → `loadPrompt("agents/<name>.txt", builtin)`

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

首次啟動後，`seedAll()` 會自動將內建 prompt 複製到 XDG 目錄。之後編輯 XDG 檔案即可覆蓋預設行為，無需重新編譯。

---

### 第 3 步：動態 Session/Task Prompt

`input.system` 在 `llm.ts:128` 被讀取。組裝於 `packages/opencode/src/session/prompt.ts:586-592`。

包含 3 個子部分：

1. **Preloaded Context**（`session/preloaded-context.ts:6-77`）：工作目錄列表（前 50 個檔案）、README.md（前 1000 字元）、skill context
2. **Environment**（`system.ts:165-191`）：model ID、session ID、parent ID、工作目錄、git 狀態、平台、日期
3. **AGENTS.md / CLAUDE.md**（`session/instruction.ts:128-168`）：僅在 Main Agent session 載入。透過 `findUp()` 搜尋 `AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`，也載入全域 `~/.config/opencode/AGENTS.md` 和 `~/.claude/CLAUDE.md`

---

### 第 4 步：使用者自訂 System Prompt

`input.user.system` 在 `llm.ts:131` 被讀取。由 API/CLI 呼叫者透過 `SessionPrompt.prompt()` 傳入。

---

### 第 5 步：核心系統規則（Red Light Rules）

`SystemPrompt.system()` 在 `llm.ts:137` 被呼叫。定義於 `packages/opencode/src/session/system.ts:136-163`。

內容為內建規則：絕對路徑、先讀後寫、事件日誌、MSR、Main/Subagent 協議。使用者可在 `~/.config/opencode/prompts/SYSTEM.md` 覆蓋。

---

### 第 6 步：身份強化注入

直接內嵌於 `llm.ts:139-144`。硬編碼模板，包含 session ID、角色（Main Agent / Subagent）、session context。

---

### 第 7 步：Gemini 專用優化

內嵌於 `llm.ts:149-170`。僅針對 Gemini 模型：擷取 AGENTS.md 內容，包裹於 `<behavioral_guidelines>` XML 標籤中，重新排列 prompt 順序。

條件：僅在 `model.id` 包含 `"gemini"` 時執行。

---

### 注意後處理

組裝完成後觸發 `experimental.chat.system.transform` hook。目前沒有任何 plugin 註冊此 hook — 保留給未來擴充使用。

---

## 盤點 Plugin Hooks

以下為 7 個活躍 plugin 所註冊的所有 hooks。觸發點位於 `llm.ts`、`prompt.ts`、`tool-invoker.ts`、`permission/index.ts` 等檔案。

---

### 查看活躍 Hooks

| #   | Plugin                       | Hook                    | 檔案:行號                                  | 功能描述                                                                                                                                               | 觸發頻率                  | Token 影響                             | 條件                         |
| --- | ---------------------------- | ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------- | ---------------------------- |
| 1   | CodexAuthPlugin              | `auth`                  | `plugin/codex.ts:352-630`                  | OpenAI OAuth/API 認證，Codex token 刷新，重寫請求至 Codex endpoint，加 `mcp_` 前綴，過濾模型，成本歸零                                                 | 每次 LLM 呼叫 (via fetch) | ~10 tokens (instructions field)        | 僅 OAuth + openai provider   |
| 2   | CodexAuthPlugin              | `chat.headers`          | `plugin/codex.ts:631-636`                  | 加 `originator`, `User-Agent`, `session_id` headers                                                                                                    | 每次 LLM 呼叫             | 0 (僅 HTTP header)                     | 僅 `openai` provider         |
| 3   | CopilotAuthPlugin            | `auth`                  | `plugin/copilot.ts:23-344`                 | GitHub Copilot device-code OAuth，設定 Copilot 專用 headers，成本歸零                                                                                  | 每次 LLM 呼叫 (via fetch) | 0                                      | 僅 OAuth                     |
| 4   | CopilotAuthPlugin            | `chat.headers`          | `plugin/copilot.ts:345-363`                | 加 `anthropic-beta` header (Claude models via Copilot)，`x-initiator: agent` (subagent)                                                                | 每次 LLM 呼叫             | 0 (僅 HTTP header)                     | 僅 `github-copilot` provider |
| 5   | GitlabAuthPlugin             | `auth`                  | `@gitlab/.../dist/index.js:209-467`        | GitLab OAuth/PAT 認證，token 刷新 (帶 mutex)                                                                                                           | 認證檢查時                | 0                                      | 僅有 auth data 時            |
| 6   | AntigravityOAuthPlugin       | `auth`                  | `plugin/antigravity/index.ts:1489-3149`    | 多帳號 OAuth pool，token 刷新，rate-limit backoff，帳號輪替，endpoint fallback，RPM 節流，thinking warmup，空回應重試                                  | 每次 LLM 呼叫 (via fetch) | 0 (body 轉換但不加 prompt)             | 僅 OAuth                     |
| 7   | AntigravityOAuthPlugin       | `event`                 | `plugin/antigravity/index.ts:909-978,1482` | 追蹤 child/root session (toast scoping)，`session.error` 自動復原 (tool_result_missing, thinking corruption)                                           | 每個 Bus 事件             | 5-20 tokens (僅復原時注入 resume_text) | 僅可復原的 session.error     |
| 8   | AntigravityOAuthPlugin       | `tool`                  | `plugin/antigravity/index.ts:1486-1488`    | 註冊 `google_search` 工具，透過 Gemini API 搜尋                                                                                                        | LLM 呼叫工具時            | 500-5000 tokens (搜尋結果)             | 僅 LLM 主動呼叫時            |
| 9   | AntigravityLegacyOAuthPlugin | `auth`, `event`, `tool` | 同 #6-8                                    | 與 AntigravityOAuthPlugin 相同，但註冊為 `"antigravity"` provider ID                                                                                   | 同上                      | 同上                                   | 同上                         |
| 10  | GeminiCLIOAuthPlugin         | `auth`                  | `plugin/gemini-cli/plugin.ts:28-159`       | Gemini CLI 認證，**封鎖 OAuth 帳號**僅允許 API key，重寫 API URL/headers，成本歸零                                                                     | 每次 LLM 呼叫 (via fetch) | 0                                      | 僅 API key auth              |
| 11  | AnthropicAuthPlugin          | `auth`                  | `plugin/anthropic.ts:104-563`              | Claude CLI 訂閱 OAuth，token 刷新 (帶 mutex)，**注入 Claude Code 身份字串到 system prompt**，加 `mcp_` 前綴到所有工具名稱，加 `?beta=true` 到 endpoint | 每次 LLM 呼叫 (via fetch) | **~15 tokens** (身份前綴)              | 僅 OAuth/subscription auth   |

---

### 檢視未使用的 Hooks

以下 hooks 定義於框架（`packages/plugin/src/index.ts:162-241`）但目前沒有任何 plugin 註冊：

- `config`
- `chat.message`
- `chat.params`
- `permission.ask`
- `command.execute.before`
- `tool.execute.before`
- `tool.execute.after`
- `experimental.chat.messages.transform`
- `experimental.chat.system.transform`（antigravity 的實作已移除並內嵌到 llm.ts 第 7 步）
- `experimental.session.compacting`
- `experimental.text.complete`
- `shell.env`

---

### 留意重點觀察

1. **Token 消耗最高**：AnthropicAuthPlugin 的 `auth` — 每次請求注入 Claude Code 身份字串 + 所有工具名稱加 `mcp_` 前綴
2. **複雜度最高**：AntigravityOAuthPlugin 的 `auth` — 約 1700 行的 fetch handler
3. **重複註冊**：Antigravity 有兩個變體（OAuth + Legacy）都從同一個 factory 產生，event/tool/auth handler 重複
4. **主動封鎖**：GeminiCLIOAuthPlugin 硬性封鎖 OAuth，只允許 API key
5. **每次 LLM 呼叫都會經過的 hooks**：`auth`（fetch handler）、`chat.headers` — 其餘 hooks 為條件觸發或未註冊

---

## Plugin.trigger() 觸發點索引

以下為所有呼叫 `Plugin.trigger()` 的位置，也就是 hook 實際被執行的地方：

| 觸發點                   | Hook 名稱                              | 檔案:行號                              | 觸發時機                                          |
| ------------------------ | -------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| LLM system prompt 後處理 | `experimental.chat.system.transform`   | `session/llm.ts:174-178`               | 每次 LLM 呼叫，system prompt 組裝完成後           |
| LLM 參數組裝             | `chat.params`                          | `session/llm.ts:209-226`               | 每次 LLM 呼叫，設定 temperature/topP/topK/options |
| LLM HTTP headers         | `chat.headers`                         | `session/llm.ts:228-240`               | 每次 LLM 呼叫，設定自訂 HTTP headers              |
| 訊息歷史轉換             | `experimental.chat.messages.transform` | `session/prompt.ts:561`                | 每次 LLM 呼叫，處理歷史訊息前                     |
| 文本完成後處理           | `experimental.text.complete`           | `session/processor.ts:426`             | 每個 assistant text part 完成後                   |
| 使用者訊息持久化         | `chat.message`                         | `session/user-message-persist.ts:17`   | 使用者送出訊息時                                  |
| 命令執行前               | `command.execute.before`               | `session/command-dispatcher.ts:15`     | 執行 slash command 前                             |
| 工具執行前               | `tool.execute.before`                  | `session/tool-invoker.ts:75`           | 每個工具呼叫前                                    |
| 工具執行後               | `tool.execute.after`                   | `session/tool-invoker.ts:115`          | 每個工具呼叫後                                    |
| 壓縮前自訂               | `experimental.session.compacting`      | `session/compaction.ts:154`            | session 壓縮時                                    |
| Shell 環境變數           | `shell.env`                            | `pty/index.ts:144`, `tool/bash.ts:176` | 每次 shell/bash 執行時                            |
| 權限檢查                 | `permission.ask`                       | `permission/index.ts:134`              | 權限確認時                                        |
| Agent system transform   | `experimental.chat.system.transform`   | `agent/agent.ts:322`                   | Agent 描述載入時                                  |

所有路徑均相對於 `packages/opencode/src/`。

---

## Config Hooks（opencode.json 中的 experimental.hook）

定義於 `packages/opencode/src/config/config.ts:1189-1210`。Schema 支援兩種 hook：

- `file_edited`：按 glob pattern 觸發 shell command（`config.ts:1191-1200`）
- `session_completed`：session 結束時觸發 shell command（`config.ts:1202-1208`）

**重要：僅有 schema 定義，無任何 runtime 執行代碼。** 這兩個 hook 是 stub，目前完全不會觸發。

---

## user-prompt-submit-hook

出現於 3 個 driver prompt 文字檔中（`claude.txt:80`、`anthropic-20250930.txt:122`、`claude-code.txt:80`），作為 system prompt 內的文字指令告訴 AI「遇到此 hook 回饋時，視為來自使用者」。

**這不是已實作的 hook 機制**，僅為 prompt 中的概念性文字。系統中沒有任何 `user-prompt-submit-hook` 的程式碼實作。

---

## 如何擴充新的 Agent Type

### 情境 A：純 prompt 自訂（不改程式碼）

如果你只想新增或覆蓋 agent prompt 的文字內容：

1. **編輯 XDG 檔案**：直接修改 `~/.config/opencode/prompts/agents/<name>.txt`
2. **即時生效**：`loadPrompt()` 使用 `mtime` 快取策略，檔案修改後下次 LLM 呼叫自動載入新內容
3. **還原預設**：刪除 XDG 檔案，系統會自動 fallback 到內建 prompt

### 情境 B：新增原生 Agent Type（需改程式碼）

完整流程，共 4 個檔案、5 個步驟：

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
# 範例：新增一個 "security" agent
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
  review: PROMPT_AGENT_REVIEW,
  // ...existing entries...
  security: PROMPT_AGENT_SECURITY, // ← 新增
}
```

#### 步驟 3：在 `agent.ts` 的 `getNativeAgents()` 加入定義

```typescript
// packages/opencode/src/agent/agent.ts

async function getNativeAgents(...) {
  const [coding, review, ..., security] = await Promise.all([
    SystemPrompt.agentPrompt("coding"),
    SystemPrompt.agentPrompt("review"),
    // ...existing entries...
    SystemPrompt.agentPrompt("security"),  // ← 新增
  ])

  return {
    // ...existing agents...
    security: {
      name: "security",
      description: "Reviews code for security vulnerabilities and attack surfaces.",
      permission: sub,
      options: {},
      prompt: security,
      mode: "subagent",
      native: true,
    },
  }
}
```

#### 步驟 4：（可選）`opencode.json` 設定

使用者可在 `opencode.json` 覆蓋任何原生 agent 的設定：

```jsonc
{
  "agent": {
    "security": {
      "model": "anthropic/claude-sonnet-4-20250514", // 指定專用模型
      "description": "Custom security reviewer", // 覆蓋描述
      "prompt": "你是安全專家...", // 直接覆蓋 prompt（優先級高於 XDG 檔案）
      "temperature": 0.2,
      "steps": 5,
    },
  },
}
```

**Prompt 優先級**（由高到低）：

1. `opencode.json` 中 `agent.<name>.prompt` — 最高
2. `~/.config/opencode/prompts/agents/<name>.txt` — XDG 覆蓋
3. `packages/opencode/src/agent/prompt/<name>.txt` — 內建預設

#### 步驟 5：驗證

```bash
# 啟動後檢查 XDG 目錄
ls ~/.config/opencode/prompts/agents/
# 應包含 security.txt

# 在 TUI 中用 /agent 切換確認可見
```

### 情境 C：停用原生 Agent

在 `opencode.json` 中：

```jsonc
{
  "agent": {
    "docs": { "disable": true },
  },
}
```

### XDG Prompt 管理全貌

```
~/.config/opencode/prompts/
├── SYSTEM.md                        ← 第 5 步：核心系統規則
├── drivers/                         ← 第 1 步：BIOS Driver
│   ├── claude-code.txt
│   ├── anthropic.txt
│   ├── beast.txt
│   ├── gemini.txt
│   ├── qwen.txt
│   ├── trinity.txt
│   ├── codex.txt
│   └── gpt-5.txt
├── agents/                          ← 第 2 步：Agent Prompt（本次新增）
│   ├── coding.txt
│   ├── review.txt
│   ├── testing.txt
│   ├── docs.txt
│   ├── explore.txt
│   ├── compaction.txt
│   ├── title.txt
│   └── summary.txt
└── session/                         ← 其他 session prompt 資源
    ├── plan.txt
    ├── plan-reminder-anthropic.txt
    ├── max-steps.txt
    ├── build-switch.txt
    └── instructions.txt
```
