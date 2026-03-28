# Implementation Spec

## Goal

- 建立 `dialog_trigger_framework` 的第一版規劃與落地路線，讓對話中的 plan/replan/tool-menu/beta/approval/docs 觸發改為 rule-first、next-round rebuild，並順手修正 `plan_enter` 會亂命名 active plan root 的問題。

## Scope

### IN

- 定義 `dialog_trigger_framework` 的目標、術語、trigger taxonomy、detector/policy/action 分層。
- 明確把 `plan_enter` root naming 修正納入同一份 implementation plan。
- 規劃如何重用既有 per-session tool surface 注入鏈：`resolve-tools.ts`、`prompt.ts`、`prompt-runtime.ts`、`processor.ts`、`mcp/index.ts`。
- 定義第一版以 rule-based detector、surface dirty flag、next-round rebuild 為核心，不做 in-flight hot reload。
- 定義 plan/beta/approval/tool-menu/docs sync 等 trigger 的 stop gates 與驗證方式。

### OUT

- 本 plan 不直接實作完整 `dialog_trigger_framework`。
- 本 plan 不直接重構全部 tool/runtime surfaces。
- 本 plan 不引入每回合背景 AI governor 或 hot reload mutation protocol。
- 本 plan 不處理 remote-terminal C agent implementation。

## Assumptions

- 目前現有 tool surface 已經具備可重用的 per-round resolve/inject 基座，只缺顯式的 dialog-trigger orchestration layer。
- `plan_enter` 亂命名問題是 planner root derivation / naming contract 缺口，而不是單一 UI 呈現問題。
- 第一版優先追求 deterministic 與 fail-fast，不新增 silent fallback。

## Stop Gates

- 若使用者要把 `dialog_trigger_framework` 擴成跨整個 session/runtime 的 architecture rewrite，必須停下來重新評估 scope。
- 若修正 `plan_enter` 命名需要變更 planner root lifecycle contract 或影響既有 `/plans` package 相容性，必須先 review 設計再進 build。
- 若第一版需求被改成需要 in-flight hot reload、background AI classifier、或跨輪隱式 fallback，必須先重新規劃。
- 若實際程式碼證據顯示 tool surface 並非 next-round rebuild 模型，必須回到 planning 重新校正。

## Critical Files

- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/resolve-tools.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/prompt-runtime.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/mcp/index.ts`
- `specs/architecture.md`
- `docs/events/event_20260328_remote_terminal_phase0.md`
- `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/*`

## Structured Execution Phases

- Phase 1: Rewrite planner contract so this active plan package becomes the authoritative `dialog_trigger_framework` planning surface, including the `plan_enter` naming-fix scope.
- Phase 2: Specify the framework architecture — trigger taxonomy, detector/policy/action boundaries, dirty-flag rebuild contract, and non-goals.
- Phase 3: Define implementation slices for build mode: fix `plan_enter` naming, add trigger registry/detectors, integrate next-round rebuild hooks, then validate and sync docs.

## Validation

- Planner artifacts must be internally aligned: proposal/spec/design/tasks/handoff all reference `dialog_trigger_framework` and `plan_enter` naming repair consistently.
- The plan must explicitly explain why first version uses rule-first + next-round rebuild instead of in-flight hot reload.
- The plan must identify concrete code entrypoints for future implementation slices.
- Diagram artifacts must stop using template placeholders and must trace framework functions → components → runtime interactions.

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from `tasks.md` and preserve planner task naming.
- Build agent must implement `plan_enter` naming repair as an explicit execution slice, not as an incidental side effect.
- Build agent must keep the first version deterministic: no background LLM classifier, no hidden fallback, no in-flight hot reload.
