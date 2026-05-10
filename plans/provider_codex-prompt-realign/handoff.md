# Handoff: provider_codex-prompt-realign

## Execution Contract

對齊上游 codex-cli wire 結構 — `instructions` 只放 driver、其餘走 `input[]` 的 developer-role + user-role bundle、`prompt_cache_key` 純 sessionId。**不重寫 transport**（WS / HTTP / continuation 維持），**不動其他 provider**（anthropic / google），**不裝飾上游命名**（標籤 / 角色 / 順序對齊就是對齊）。

Stage A 必須照 A.1 → A.5 順序，每個 stage 一個 commit 可獨立 revert；Stage B 各 fragment 可平行展開。

## Required Reads

### Source artifacts (這個 plan)
- [proposal.md](proposal.md) — Why / Effective Requirement / Scope
- [design.md](design.md) — Architecture, Decisions DD-1..DD-9, Critical Files, Risks
- [spec.md](spec.md) — Requirements + Acceptance Checks (BDD scenario style)
- [tasks.md](tasks.md) — Stage A.1..A.5 + Stage B.1..B.5 工作清單
- [c4.json](c4.json) / [sequence.json](sequence.json) / [data-schema.json](data-schema.json) / [idef0.json](idef0.json) / [grafcet.json](grafcet.json)

### Upstream reference (對齊源)
- [refs/codex/codex-rs/core/src/session/mod.rs:2553-2761](refs/codex/codex-rs/core/src/session/mod.rs#L2553-L2761) — `build_initial_context()` 的 input[] 組裝
- [refs/codex/codex-rs/core/src/client.rs:680-734](refs/codex/codex-rs/core/src/client.rs#L680-L734) — `make_request()` instructions / input / prompt_cache_key
- [refs/codex/codex-rs/core/src/context/](refs/codex/codex-rs/core/src/context/) — 所有 ContextualUserFragment 範本
- [refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md](refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md) — 上游人格檔（已複製到本地）
- [refs/codex/codex-rs/protocol/src/openai_models.rs](refs/codex/codex-rs/protocol/src/openai_models.rs) — `ModelInfo.base_instructions` per-model 路由

### Local code (要動或要驗的)
- [packages/opencode-codex-provider/src/convert.ts](packages/opencode-codex-provider/src/convert.ts)
- [packages/opencode-codex-provider/src/provider.ts](packages/opencode-codex-provider/src/provider.ts)
- [packages/opencode-codex-provider/src/transport-ws.ts](packages/opencode-codex-provider/src/transport-ws.ts)
- [packages/opencode/src/session/llm.ts](packages/opencode/src/session/llm.ts)
- [packages/opencode/src/session/system.ts](packages/opencode/src/session/system.ts)
- [packages/opencode/src/session/static-system-builder.ts](packages/opencode/src/session/static-system-builder.ts)
- [packages/opencode/src/session/context-preface.ts](packages/opencode/src/session/context-preface.ts) (Stage B.3 廢除)
- [packages/opencode/src/session/prompt/codex.txt](packages/opencode/src/session/prompt/codex.txt) (Stage A.1 已替換)
- [templates/prompts/drivers/codex.txt](templates/prompts/drivers/codex.txt) (Stage A.1 已替換)

## Stop Gates In Force

- **不重寫 transport**：tryWsTransport / probeFirstFrame / WS reconnect 邏輯維持
- **不動 anthropic / google provider**：他們各自的 wire 形態不在本 plan 範圍
- **不裝飾上游結構命名**：fragment ROLE / START_MARKER / END_MARKER / 順序對齊就是對齊
- **不破壞 attachment v6 圖片 inline**：圖片 binary 仍走對話訊息 multi-modal content；`<attached_images>` inventory 文字才做 fragment
- **不直接 commit 跨範圍變動**：每個 stage 一個 commit，超出 stage 邊界拒絕
- **不在 graduation 之前 self-promote 到 living**：user gate；AI 只能報告 verified ready
- **不靜默 fallback**：載入失敗（如 model-specific prompt md 缺）必須明確報錯或走明確 default.md 路徑（DD-2）
- **submodule pointer bumps**：refs/codex 任何 commit 變動要 commit 起來（user feedback `feedback_submodule_always_commit`）

## Execution-Ready Checklist

### Stage A.1 — 人格檔還原（已完成）
- [x] `packages/opencode/src/session/prompt/codex.txt` md5 = `7a62de0a7552d52b455f48d9a1e96016`
- [x] `templates/prompts/drivers/codex.txt` md5 同上
- [x] 與 `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` byte 一致
- [x] 事件記入 `events/event_2026-05-11_persona-restored.md`
- [ ] **(待 Stage A.4 完才驗)** rebuild + restart 後 driver text 正確流到 outbound `instructions` 欄位

### Stage A.2 — Fragment 框架
- [ ] `packages/opencode/src/session/context-fragments/fragment.ts` 定義 ContextFragment interface
- [ ] `assemble.ts` 按 ROLE 分桶 + marker 包裹 + join → ResponseItem[]
- [ ] 四個必要 fragment 各自獨立檔案：environment-context / user-instructions / opencode-protocol-instructions / role-identity
- [ ] 單元測試覆蓋：empty body 跳過、marker wrapping、role 分桶順序、id dedup

### Stage A.3 — Wire 改寫
- [ ] `convert.ts` 的 `instructions` 只取第一個 system message
- [ ] `llm.ts` 移除 buildPreface / context-preface 路徑；prepend 兩個 bundled ResponseItem 到 `input.messages`
- [ ] `static-system-builder.ts` 縮減成 driver 包裝 only（或廢除）
- [ ] Feature flag `OPENCODE_CODEX_LEGACY_INSTRUCTIONS=1` 環境變數實作 + 預設 off

### Stage A.4 — `prompt_cache_key`
- [ ] `provider.ts:163` cacheKey = threadId
- [ ] `transport-ws.ts:756` per-account swap 行為驗證（per-account 是 chain 不是 cache key）
- [ ] 單元測試：同 sessionId 不同 accountId 兩個請求 prompt_cache_key 一致

### Stage A.5 — Rollout safety
- [ ] Daemon 啟動偵測 legacy continuation state → broadcast `resetWsSession`
- [ ] Smoke test：兩 turn 連送，cached_tokens 第二 turn 顯著大於 4608

### Stage B — OpenCode 自有資產調和
- [ ] B.1 對齊上游已有 fragment（apps / available-skills / skill / personality-spec）
- [ ] B.2 OpenCode-only fragment（lazy catalog / structured output / quota / subagent return / enablement / attached images inventory）
- [ ] B.3 廢除 context-preface.ts + context-preface-types.ts
- [ ] B.4 model-specific persona 路由（gpt_5_2 / gpt_5_codex / gpt_5_1 / gpt-5.1-codex-max / gpt-5.2-codex）
- [ ] B.5 e2e + subagent + hash stability + plugin regression + architecture.md 更新

## Validation summary

進入 verified 之前必須過：

1. 跑 [spec.md](spec.md) 七條 Acceptance Checks 全綠
2. `wiki_validate` 對本 plan 無未解 broken_links / drift_code_anchors
3. 至少一個 healthy session 的兩 turn 觀測 `cached_tokens >= 0.9 * input_tokens`
4. Hash stability test：同 session 同 driver 兩個 turn outbound `instructions` byte 完全一致

verified → living 是 user gate；AI 不可自己 graduate。
