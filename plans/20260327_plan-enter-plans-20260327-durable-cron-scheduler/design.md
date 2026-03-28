# Design

## Context

- 現況已存在一條統一的 tool surface 注入鏈：`resolve-tools.ts` 在每輪 processing 前收斂 registry tools、MCP tools、managed app tools，`prompt.ts` 於 run loop 內呼叫 `resolveTools(...)` 後再交給 `processor.process(...)`。
- 這代表系統現在其實已是 **per-round resolve / inject** 模型，而不是可隨時在 in-flight round 中熱替換 tool surface。
- `mcp/index.ts` 雖然有 `ToolsChanged`、cache dirty 與 invalidation，但仍然是在下次 `MCP.tools()` / `resolveTools()` 時重建，不是同輪 swap。
- `plan.ts` 目前 planner artifact template 與 root derivation 仍可能造成錯誤命名，這是 planner contract 與 task topic 對齊不足的症狀。

## Goals / Non-Goals

**Goals:**

- 把目前分散在 prompt/runtime/planner 裡的 trigger 行為提升成一個可命名、可規劃、可驗證的 framework。
- 讓第一版 implementation 能重用既有 runtime surfaces，而不是引入更複雜的 hot reload substrate。
- 把 `plan_enter` root naming fix 切成明確可執行 slice。

**Non-Goals:**

- 不重新設計整個 LLM loop 或 tool execution substrate。
- 不在第一版處理所有自然語言語意分類 corner cases。
- 不用 fallback 掩蓋 planner root naming mismatch。

## Decisions

- DD1: `dialog_trigger_framework` 第一版採 **rule-first / deterministic detector**，不做背景 AI governor。
- DD2: tool/capability surface 變動採 **dirty flag + next-round rebuild**，不做 in-flight hot reload。
- DD3: framework 分三層：`detector`（判斷觸發）、`policy`（決定是否允許/需停下）、`action`（進 plan、要求 approval、露出 tool menu、標記 dirty surface）。
- DD4: `plan_enter` 亂命名不是獨立小 bug，而是 planner trigger / artifact naming contract 的第一個必修 slice；第一版只修 slug derivation，不同時處理 reuse/rename 流程。
- DD5: 第一版優先涵蓋 `plan_enter/replan/approval` 這三個 must-have trigger；tool-menu、beta、docs-sync 保留為後續擴充。
- DD6: 第一版 detector 採集中式 registry/policy surface，避免規則再次散落在 `prompt.ts`、`plan.ts`、`resolve-tools.ts` 多點漂移。

## Data / State / Control Flow

- 使用者訊息進入 `prompt.ts` 後，系統可先經 rule-based detector 判定是否需要切 plan mode、要求 question、或標記事後 dirty rebuild。
- 每輪 `resolveTools(...)` 依 session/agent/model/messages 決定當前 tool surface；若 policy 或 MCP 狀態改變，framework 只需標記 surface dirty，於下一輪重算。
- `processor.ts` 負責 round-level tool invocation 與 finish/stop 狀態；framework 不直接侵入 tool execution substrate，只在 round boundary 提供 trigger decisions。
- `plan.ts` 負責 planner root、artifact validation、plan_exit handoff，因此 `plan_enter` naming fix 屬 planner layer；framework 應將其視為 planning trigger contract，而非 UI cosmetic bug。

## Risks / Trade-offs

- 只做 rule-first 且先聚焦三個 must-have trigger，代表第一版覆蓋面有限 -> 後續以 tool menu 與 explicit user invocation 補足。
- next-round rebuild 比 hot reload 慢一輪 -> 但能保留 deterministic、易驗證、低風險的 runtime contract。
- 將 `plan_enter` naming fix 納入同一份 plan 會增加 scope -> 但可避免 framework 與 planner lifecycle 再次脫節。
- 集中式 registry 需要先抽出共用 trigger contract -> 但可降低後續 drift 與重複規則。

## Critical Files

- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/resolve-tools.ts`
- `packages/opencode/src/session/prompt-runtime.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/mcp/index.ts`
- `specs/architecture.md`
