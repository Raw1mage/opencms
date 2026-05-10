---
date: 2026-05-11
summary: "Stage A.2 fragment framework landed"
---

# Stage A.2 fragment framework landed

## What

建立 `packages/opencode/src/session/context-fragments/` 目錄與最小可用框架：

- `fragment.ts` — `ContextFragment` interface + `renderFragment()`，鏡像上游 `ContextualUserFragment` trait
- `assemble.ts` — `assembleBundles()` 按 role 分桶 + 用 START/END marker 包裹 + join；id 碰撞 throw、空 body 跳過
- `environment-context.ts` — 對齊上游 `<environment_context>cwd/shell/current_date/timezone</environment_context>`
- `user-instructions.ts` — 對齊上游 `# AGENTS.md instructions for <dir>...</INSTRUCTIONS>`，constructor 接 scope + directory + text
- `opencode-protocol-instructions.ts` — OpenCode 自有 `<opencode_protocol>`，body 由 caller 餵 SYSTEM.md text
- `role-identity.ts` — OpenCode 自有 `<role_identity>`，main vs subagent 切換
- `index.ts` — 匯出全部 public API

## Files

- `packages/opencode/src/session/context-fragments/fragment.ts` (75 lines)
- `packages/opencode/src/session/context-fragments/assemble.ts` (78 lines)
- `packages/opencode/src/session/context-fragments/environment-context.ts` (50 lines)
- `packages/opencode/src/session/context-fragments/user-instructions.ts` (50 lines)
- `packages/opencode/src/session/context-fragments/opencode-protocol-instructions.ts` (38 lines)
- `packages/opencode/src/session/context-fragments/role-identity.ts` (35 lines)
- `packages/opencode/src/session/context-fragments/index.ts` (40 lines)
- `packages/opencode/test/session/context-fragments.test.ts` (140 lines, 13 tests)

## Verification

```
bun test test/session/context-fragments.test.ts
13 pass / 0 fail / 37 expect() calls

bunx tsc --noEmit
clean
```

## Caveats

- 框架本身**不會**讓 cache_read 跳脫 4608；只是定義 fragment 形狀。Stage A.3 才會把它接進 wire（`convert.ts` + `llm.ts`）。
- Bundle 的「ResponseItem」表現形式還沒決定（AI SDK 的 `ModelMessage` 用什麼 role 承載 developer-role bundle、用什麼 metadata 標記）。Stage A.3 的關鍵設計選擇。

## Next

- Stage A.3 — Wire 結構改寫：
  - `convert.ts` 的 `instructions` 改成只取第一個 system message 內容
  - 設計 developer-role bundle 在 LMv2 prompt 裡的承載方式（option：用 user-role + `providerOptions.codex.kind = "developer"` marker）
  - `llm.ts` 移除 `## CONTEXT PREFACE` 路徑，改呼 `assembleBundles(...)` 並 prepend 結果到 input.messages
- Stage A.4 — `prompt_cache_key` 還原為純 sessionId
- Stage A.5 — Daemon 升級廣播 resetWsSession

