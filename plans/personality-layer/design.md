# Design

## Context

opencode 的 system prompt 管線有 8 個 conditional block 組成，最後合併送出。codex-rs 則是 all-in-one 的 `base_instructions` 字串加上 `{{ personality }}` 模板替換。

目前 codex provider 走 `useInstructionsOption=true` 時，`provider_prompt` block 被設為空字串，導致 `drivers/codex/gpt-5.4.txt` 等原廠 prompt 從未被注入。

## Goals / Non-Goals

**Goals:**

- 解耦 wire format 決策與 prompt source 決策
- 正確載入 codex per-model driver prompt
- 引入 personality 模板替換機制
- 移植 codex-rs 的 pragmatic / friendly 人格

**Non-Goals:**

- 不改變非 codex provider 行為
- 不改變 SYSTEM.md / AGENTS.md 載入機制
- 不做 Admin Panel personality 選擇 UI

## Decisions

### DD-1: 拆 useInstructionsOption 為兩個獨立 flag

**Decision**: 在 `capabilities.ts` 中，將 `useInstructionsOption` 拆為：
- `wireFormatInstructions: boolean` — 最終送出時用 `instructions` 欄位（true）還是 system messages（false）
- `skipProviderPrompt: boolean` — 是否跳過 `SystemPrompt.provider()` 載入

**Rationale**: 這兩個決策的語義不同。codex 要用 `instructions` 欄位送出（wire format），但不應該因此跳過讀取 per-model driver prompt（source）。

### DD-2: Personality 作為獨立 prompt 層，用模板替換注入

**Decision**:
1. 新增 `session/prompt/personalities/` 目錄，存放人格檔案
2. Driver prompt 中加入 `{{ personality }}` 佔位符
3. `SystemPrompt.provider()` 載入 driver 後，執行模板替換
4. 沒有佔位符的 driver 不受影響（backward compatible）

**Rationale**: 跟 codex-rs 的做法一致，且不影響現有無佔位符的 driver 檔案。模板替換發生在載入階段，不影響後續組裝和送出邏輯。

### DD-3: Personality 選擇放在 config 層

**Decision**: `opencode.json` 新增 `personality` 欄位，值為 `"pragmatic"` | `"friendly"` | `"default"` | `undefined`。

**Rationale**: 跟 codex-rs 的 `config.personality` 對齊。放在 config 而非 per-session 是因為人格偏好通常是使用者級別的，不是每次對話都要選。

### DD-4: 佔位符用 `{{ personality }}`，與 codex-rs 一致

**Decision**: 使用 `{{ personality }}` 作為佔位符，替換時只匹配完整 token（含前後空白或行首），不匹配出現在普通文字中的子字串。

**Rationale**: 跟 codex-rs 用同一個 placeholder，方便對照和移植。codex-rs 的 `PERSONALITY_PLACEHOLDER` 就是 `{{ personality }}`。

## Data / State / Control Flow

### 修改前（codex path）

```
llm.ts
  │ usesInstructions = true
  │
  ├─ provider_prompt = ""                 ← 來源被砍
  ├─ ... 其他 block 正常組裝 ...
  │
  └─ options.instructions = SystemPrompt.instructions()  ← 只有 codex_header.txt
```

### 修改後（codex path）

```
llm.ts
  │ wireFormatInstructions = true
  │ skipProviderPrompt = false
  │
  ├─ provider_prompt = SystemPrompt.provider(model)       ← driver 正常載入
  │                      └─ drivers/codex/gpt-5.4.txt
  │                      └─ {{ personality }} 被替換
  ├─ ... 其他 block 正常組裝 ...
  │
  └─ options.instructions = [全部組好的 system prompt]    ← wire format 決策
```

### Personality 載入流程

```
Config.personality = "pragmatic"
  │
  ▼ SystemPrompt.personality("pragmatic")
  │ 讀取 personalities/pragmatic.txt
  │
  ▼ SystemPrompt.provider(model)
  │ 讀取 drivers/codex/gpt-5.4.txt
  │ 找到 {{ personality }} 佔位符
  │ 替換為 pragmatic.txt 內容
  │
  ▼ 回傳完整 driver prompt（含人格）
```

## Risks / Trade-offs

- **R1: Prompt regression** — 拆解重組可能改變 prompt 的相對位置和權重。Mitigation: 比對修改前後的完整 prompt output，確認語義等價
- **R2: 模板替換 edge case** — `{{ personality }}` 如果出現在使用者文字中會誤替換。Mitigation: 只在 driver 檔案載入時替換，不在 runtime 動態內容上替換
- **R3: Config migration** — 新增 `personality` 欄位。Mitigation: 可選欄位，undefined 時用 model 預設值，無 breaking change

## Critical Files

- `packages/opencode/src/provider/capabilities.ts` — flag 拆分
- `packages/opencode/src/session/llm.ts` — 組裝邏輯（line 315-430）
- `packages/opencode/src/session/system.ts` — provider prompt 載入 + personality
- `packages/opencode/src/session/prompt/personalities/` — 新目錄
- `packages/opencode/src/session/prompt/drivers/codex/gpt-5.4.txt` — 加佔位符
- `packages/opencode/src/config/config.ts` — personality 欄位
- `refs/codex/codex-rs/core/templates/personalities/` — 移植來源
