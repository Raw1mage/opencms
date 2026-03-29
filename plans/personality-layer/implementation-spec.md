# Implementation Spec

## Goal

- 解耦 prompt 來源與 wire format，引入 personality 模板替換層，讓 codex driver prompt 正確載入且人格可動態切換

## Scope

### IN

- capabilities.ts flag 拆分
- llm.ts system message 組裝邏輯修正
- system.ts personality 載入 + 模板替換
- 新增 personalities/ 目錄和檔案
- 修改 codex driver prompt 加佔位符
- config personality 欄位

### OUT

- 非 codex provider driver 修改
- Admin Panel UI
- SYSTEM.md / AGENTS.md 機制變更

## Assumptions

- codex-rs 的 personality 檔案內容適合直接移植（可能需微調 opencode 用語）
- `{{ personality }}` 不會出現在正常的 driver prompt 文字中
- Config schema 修改不需要 migration（新增可選欄位）

## Stop Gates

- SG-1: 如果拆 `useInstructionsOption` 導致其他 provider（anthropic、copilot）的 prompt 組裝壞掉，停下來逐一排查
- SG-2: 如果 personality 替換後的 prompt 超過 model context window，需要加截斷機制

## Critical Files

- `packages/opencode/src/provider/capabilities.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/prompt/personalities/pragmatic.txt`
- `packages/opencode/src/session/prompt/personalities/friendly.txt`
- `packages/opencode/src/session/prompt/personalities/default.txt`
- `packages/opencode/src/session/prompt/drivers/codex/gpt-5.4.txt`
- `packages/opencode/src/config/config.ts`
- `refs/codex/codex-rs/core/templates/personalities/`

## Structured Execution Phases

### Phase 1: 解耦 capabilities flags + 修復 codex driver 載入（立即修 bug）

1. 拆 `useInstructionsOption` → `wireFormatInstructions` + 獨立的 provider prompt 載入控制
2. 修 `llm.ts` 讓 `provider_prompt` block 在 codex path 也正常載入 `SystemPrompt.provider()`
3. 驗證：codex request 的 prompt 包含 `gpt-5.4.txt` 內容

### Phase 2: Personality 基礎設施

1. 新增 `session/prompt/personalities/` 目錄
2. 移植 codex-rs 的 `pragmatic.txt` 和 `friendly.txt`
3. 建立 `default.txt`（空或極簡）
4. 在 `system.ts` 新增 `SystemPrompt.personality(name)` 載入函數
5. 在 `SystemPrompt.provider()` 中加入 `{{ personality }}` 替換邏輯
6. Config schema 加 `personality` 可選欄位

### Phase 3: Driver prompt 模板化

1. 修改 `drivers/codex/gpt-5.4.txt`：將寫死的人格段落抽出，改為 `{{ personality }}`
2. 同步修改其他 codex driver 檔案（需要的話）
3. 驗證：有佔位符的 driver 正確替換，無佔位符的 driver 不受影響

### Phase 4: 驗證 + 同步 templates/

1. 逐一驗證所有 provider 的 prompt output 無 regression
2. 同步 `templates/` 目錄
3. 記錄到 `docs/events/`

## Validation

- codex provider prompt output 包含 `gpt-5.4.txt` 內容（Phase 1）
- 非 codex provider 的 prompt output 與修改前完全一致（Phase 1）
- `{{ personality }}` 被替換為選定人格內容（Phase 2）
- 無佔位符的 driver 保持不變（Phase 3）
- personality config 變更後 prompt output 相應改變（Phase 2）
- typecheck 0 new errors（每個 Phase）

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- 重要：Phase 1 是 bug fix，可獨立交付。Phase 2-3 是 feature，可以後續再做。
