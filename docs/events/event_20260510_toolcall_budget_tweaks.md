# 2026-05-10 — Tool-call budget tweaks

## 需求

- 使用者觀察到另一個 session 單輪併發 17 個 tool calls，行為過於積極。
- 新增可由 `/etc/opencode/tweaks.cfg` 控制的 tool-call 併發與數量上限。

## 範圍(IN)

- 在 LLM request 組包前，依 context budget / tweaks policy 限制 provider options 中的 tool-call 行為。
- 新增 tweaks.cfg key 與 defaults，避免 hardcode。
- 加入 debug checkpoint，保留 effective policy 證據。
- 驗證 OpenAI/Copilot Responses 相容參數 `parallelToolCalls` / `maxToolCalls` 的傳遞路徑。

## 範圍(OUT)

- 不改 tool 執行器的語義與 MCP tool schema。
- 不新增 fallback mechanism。
- 不重啟 daemon，除非使用者明確要求透過 controlled restart。

## 任務清單

- [x] 備份 XDG 關鍵設定白名單。
- [x] 定位 tweaks 與 LLM provider options 控制路徑。
- [x] 實作 tweak-controlled tool-call cap。
- [x] 補測試或最小驗證，並同步 event 記錄。

## Debug Checkpoints

### Baseline

- Symptom: 另一 session 單輪發出 17 個 tool calls。
- 初始判斷：目前 `<context_budget>` 是提示面，不是 runtime hard policy；缺少在送出前 clamp `parallelToolCalls` / `maxToolCalls` 的控制。

### Instrumentation Plan

- Boundary 1: `Tweaks` config loading/parsing/defaults。
- Boundary 2: `llm.ts` 組出 `params.options` 後、`ProviderTransform.providerOptions(...)` 前。
- Boundary 3: provider adapter 將 camelCase options 映射到 provider request body。

### Execution

- `packages/opencode/src/config/tweaks.ts` 新增 `tool_call_budget_*` keys、defaults、parser 與 sync/async accessors。
- `packages/opencode/src/session/prompt.ts` 將既有 context-budget source 轉成 policy metadata 傳入 LLM stream。
- `packages/opencode/src/session/llm.ts` 在 `Plugin.trigger("chat.params")` 後、`ProviderTransform.providerOptions(...)` 前 clamp `maxToolCalls`，且 `effectiveMax <= 1` 時設定 `parallelToolCalls=false`；既有較低 `maxToolCalls` 不會被提高。
- Review follow-up: `parallelToolCalls` 只會收緊；若原始設定明確為 `false`，即使 effective max > 1 也不會被 policy 放大成 `true`。
- 新增 `llm.tool_call_budget` debug checkpoint，記錄 status/ratio/source、original/effective max 與 parallel 設定、reason。

### Root Cause

- `<context_budget>` 原本只進入模型提示，不是 request-level hard policy；模型仍可能在單輪要求大量並行 tools。
- OpenAI-compatible provider option allowlist 已包含 `maxToolCalls` / `parallelToolCalls`，Copilot Responses adapter 既有 camelCase → snake_case 映射，因此修正點應在 LLM request options 成形後做 explicit clamp。

## Validation

- `bun test packages/opencode/test/config/tweaks.test.ts` passed (34 tests).
- `bun eslint packages/opencode/src/config/tweaks.ts packages/opencode/src/session/llm.ts packages/opencode/src/session/prompt.ts packages/opencode/test/config/tweaks.test.ts` passed.
- Orchestrator review patched conservative parallel semantics after worker completion; focused test + lint re-run passed with the same commands above.
- `bun run verify:typecheck` failed before checking changed files because local script could not find `turbo`.
- `bun x tsc --noEmit --pretty false` failed on pre-existing syntax errors in `templates/skills/plan-builder/scripts/plan-rollback-refactor.ts`.

## Architecture Sync

- Updated `specs/architecture.md` Tool Surface Runtime with the tweak-controlled tool-call budget policy and request-shaping boundary.
