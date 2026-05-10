---
date: 2026-05-10
summary: "persona restored to upstream default.md"
---

# persona restored to upstream default.md

## What

把 OpenCode 自製的 27 行 codex.txt（May 9 SSOT 之後的 "persona overlay"）替換為上游 `refs/codex/codex-rs/protocol/src/prompts/base_instructions/default.md` 的 275 行整份。

## Files

- `packages/opencode/src/session/prompt/codex.txt` (27 → 275 lines)
- `templates/prompts/drivers/codex.txt` (27 → 275 lines)

## Verification

```
md5: 7a62de0a7552d52b455f48d9a1e96016 (三份檔案一致 — bundled, template, upstream reference)
```

## Caveats

- 上游 default.md 內容假設 codex-cli 工具集（`shell`, `apply_patch`, `update_plan` 等）。OpenCode 的工具列表不完全相同。短期容忍此差異；後續若行為偏離過大，再做 model-specific routing 並補本地化。
- 本步驟單獨**不會**讓 cache_read 從 4608 跳脫，因為 wire 結構（`instructions` 欄位巨型化、`prompt_cache_key` 帶 accountId、`## CONTEXT PREFACE` 自創訊息、SYSTEM.md/AGENTS.md 都黏在 instructions）還沒改。

## Next

- Stage A.2: 建 fragment 框架 `packages/opencode/src/session/context-fragments/`，先實作 EnvironmentContext / UserInstructions / OpencodeProtocolInstructions / RoleIdentity 四個必要 fragment
- Stage A.3: 改 `convert.ts` 與 `llm.ts`，讓 `instructions` 只放 driver、`input[]` 開頭塞 developer-role + user-role bundle
- Stage A.4: `prompt_cache_key` 改回純 sessionId

