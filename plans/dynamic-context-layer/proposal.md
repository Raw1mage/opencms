# Proposal

## Why
- Skill prompt 載入後無法卸載，佔 context token 直到 compaction
- Lazy tool catalog 有自己一套 active/inactive 邏輯，跟 skill 管理完全脫鉤
- Instruction prompts、environment prompts 永遠在，即使當回合不需要
- 四套機制各自為政，沒有統一的生命週期管理

## Original Requirement Wording (Baseline)
- "重構組裝機制 + 決定 unload policy"

## Effective Requirement Description
1. 統一 system prompt 中所有可選內容為同一套 dynamic context layer 機制
2. 每回合組裝 system prompt 時，根據各 layer 的 active/inactive 狀態決定是否注入
3. 設計 unload policy——誰決定、什麼時候、unload 後留什麼

## Scope
### IN
- System prompt 動態組裝管線重構
- Skill prompt 生命週期（load / unload）
- Lazy tool catalog 納入統一管理
- Unload policy 設計

### OUT
- Message history 的 compaction 機制（已有，不碰）
- 新 skill 開發
- Provider 層的 API 呼叫方式

## Constraints
- 必須向後相容現有 skill 載入行為
- 不能影響 prompt caching 效率（stable prefix 原則）
- Unload 後 AI 不應失憶——需保留摘要或 metadata

## What Changes
- `prompt.ts` 中的 system 陣列組裝邏輯
- Skill 載入機制（從 message 注入改為 system layer 注入）
- Lazy tool catalog 整合進同一套 layer API

## Capabilities
### New Capabilities
- Skill unload：用完的 skill 可以從下一輪 system prompt 中移除
- Unified layer API：activate / deactivate / promote / demote
- Unload policy：程式化或使用者觸發的卸載決策

### Modified Capabilities
- Skill 載入：從 append-only message 改為 dynamic system layer
- Lazy tool catalog：從獨立邏輯改為 layer 管理的一個 instance

## Impact
- `src/session/prompt.ts` — system prompt 組裝管線
- `src/session/resolve-tools.ts` — lazy tool catalog 邏輯
- Skill loading 機制（目前在 tool-loader 或 prompt prep 裡）
- 所有依賴 system prompt 結構的測試
