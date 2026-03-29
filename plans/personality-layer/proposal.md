# Proposal

## Why

opencode 的 system prompt 管線與 codex-rs（官方 Codex CLI）之間存在架構性不匹配：

1. **codex driver prompt 從未被載入** — `useInstructionsOption=true` 同時砍掉了「讀哪些檔案」和「怎麼送出」，導致 `drivers/codex/gpt-5.4.txt` 等原廠 per-model prompt 被跳過
2. **缺少 personality 層** — codex-rs 支援動態人格切換（pragmatic/friendly/none），opencode 的 per-model driver 把人格寫死在檔案裡，無法切換
3. **兩個 flag 耦合在一起** — `useInstructionsOption` 控制了 wire format（用 `instructions` 欄位）和 source（跳過 provider prompt），這兩個決策應該獨立

## Original Requirement Wording (Baseline)

- "codex 有自己的完整 system prompt 階層，要跟 opencode 調和"
- "codex 多了可變人格的設定，我覺得很有趣，應該全面引入重構我們的 opencode"
- "把 codex 的一坨拆成 codex 版的 system.md, driver, agent.md，然後全面導入人格設定層"

## Effective Requirement Description

1. 解耦 `useInstructionsOption`：wire format 決策（`instructions` 欄位 vs system messages）與 prompt 來源決策（讀哪些 driver 檔案）獨立
2. 修復 codex provider prompt 載入路徑：per-model driver prompt 必須被讀取和注入
3. 引入 personality 層：支援 `{{ personality }}` 模板替換，使用者可透過 config 選擇人格
4. 移植 codex-rs 的人格變體（pragmatic、friendly）
5. 確保非 codex provider 無 regression

## Scope

### IN

- `capabilities.ts` — 拆 `useInstructionsOption` 為 `wireFormatInstructions` + `loadProviderPrompt`
- `llm.ts` — 修正 prompt 組裝邏輯，分離 wire format 和 source 決策
- `system.ts` — 新增 personality 載入和模板替換
- `session/prompt/personalities/` — 新目錄，存放人格檔案
- `drivers/codex/*.txt` — 加入 `{{ personality }}` 佔位符
- Config schema — 新增 `personality` 設定欄位

### OUT

- 非 codex provider 的 driver prompt 重構（保持現狀）
- SYSTEM.md 內容修改
- Admin Panel UI 的 personality 選擇器（後續 task）
- codex-rs 的 AGENTS.md 遍歷規則移植（opencode 已有自己的實作）

## Non-Goals

- 不改變 prompt 的最終 wire format（仍然用 `instructions` 欄位）
- 不改變 SYSTEM.md / AGENTS.md 的載入機制
- 不改變 agent prompt 的載入機制

## Constraints

- Personality 模板替換必須安全（`{{ personality }}` 不能被使用者文字誤觸發）
- 現有 driver 檔不含佔位符時不替換（backward compatible）
- Config 裡不設 personality 時使用 model 預設值

## What Changes

- `capabilities.ts` 的 capability flags 拆分
- `llm.ts` 的 system message 組裝邏輯
- `system.ts` 新增 `SystemPrompt.personality()` 和模板替換
- 新增 `session/prompt/personalities/` 目錄和檔案
- 修改 `drivers/codex/*.txt` 加入佔位符
- Config schema 加 `personality` 欄位

## Capabilities

### New Capabilities

- **Personality selection**: 使用者可在 config 中選擇 pragmatic / friendly / default 人格
- **Template substitution**: driver prompt 支援 `{{ personality }}` 動態替換

### Modified Capabilities

- **Provider prompt loading**: codex provider 不再被 `useInstructionsOption` 跳過 driver prompt

## Impact

- `packages/opencode/src/provider/capabilities.ts` — flag 拆分
- `packages/opencode/src/session/llm.ts` — 組裝邏輯修改
- `packages/opencode/src/session/system.ts` — 新增 personality 載入
- `packages/opencode/src/session/prompt/personalities/` — 新目錄
- `packages/opencode/src/session/prompt/drivers/codex/*.txt` — 加佔位符
- `packages/opencode/src/config/config.ts` — 新增 personality 欄位
- `templates/` — 同步更新
