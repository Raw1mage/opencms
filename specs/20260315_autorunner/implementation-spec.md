# Implementation Spec

## Goal

- 將 autorunner 的規劃與執行環境重構為以 planner / mission / delegation 為核心的最小 bootstrap，移除低實效常駐 skills，並讓 runner contract 與 planner handoff 預設走向 gate-driven auto-continue。

## Scope

### IN

- `packages/opencode/src/tool/plan.ts` 的 planner artifact template / materialization / handoff contract
- `packages/opencode/src/session/prompt/runner.txt` 的 autonomous build-mode continuation contract
- `packages/opencode/src/session/prompt/plan.txt` 的 planner-first delegation contract
- `packages/opencode/src/session/prompt/claude.txt`
- `packages/opencode/src/session/prompt/anthropic-20250930.txt`
- `packages/opencode/src/session/system.ts` 內的 planning-first / todo / delegation 指令
- `templates/skills/agent-workflow/SKILL.md` 與 runtime `agent-workflow` skill mirror
- `AGENTS.md` 與 `templates/AGENTS.md` 的 bootstrap / workflow policy
- `packages/opencode/src/session/prompt/enablement.json` 與 `templates/prompts/enablement.json` 的 skill routing / default posture
- `templates/system_prompt.md` 與 `templates/global_constitution.md` 中與 bootstrap、model-selector、delegation policy 直接衝突的描述
- 對應 planner / prompt / workflow tests 與必要的新 regression tests

### OUT

- 本輪不做 daemon architecture 重寫
- 本輪不新增新的 fallback mechanism
- 本輪不做大規模 session queue / worker supervisor substrate 重構
- 本輪不擴張 autorunner 到未經批准的 scope 或新 mission source

## Assumptions

- `agent-workflow` 仍保留為唯一預設常駐 workflow skill，但內容需改寫為 autorunner-centered / delegation-first。
- `mcp-finder`、`skill-finder`、`software-architect`、`model-selector` 仍可保留為可選 skill 資產，但不再屬於 bootstrap 預設加載集合。
- architecture thinking 不再依賴 `software-architect` 常駐，而要沉澱進 planner schema、artifact template 與 handoff contract。
- model/account switching 在現行政策下屬低頻、顯式、session-scoped 操作，不應再由 bootstrap skill 主動驅動。
- runtime todo 仍以 planner `tasks.md` 為 seed；本輪要讓 seed 更明確支援 delegation / integrate / validation phases。

## Stop Gates

- 若任何修改需要新增 fallback、隱式 model/account switch、或弱化 fail-fast contract，必須停下回到 plan mode。
- 若發現 `agent-workflow` 改寫會破壞既有 debug/syslog contract，必須先補 artifact 與 test 設計再進 build。
- 若需要移除 skill 檔案本體、變更 skill distribution policy、或調整非本輪指定的 bundled skill 清單，必須先取得使用者決策。
- 若 planner artifact 與實際 runtime entrypoints（`plan.ts` / `runner.txt` / `AGENTS.md` / `enablement.json`）無法對齊，build agent 必須先回 planner 修正 spec，不得自行即興擴 scope。

## Critical Files

- `AGENTS.md`
- `templates/AGENTS.md`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/prompt/plan.txt`
- `packages/opencode/src/session/prompt/runner.txt`
- `packages/opencode/src/session/prompt/claude.txt`
- `packages/opencode/src/session/prompt/anthropic-20250930.txt`
- `packages/opencode/src/session/system.ts`
- `templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `templates/system_prompt.md`
- `templates/global_constitution.md`
- `packages/opencode/test/session/planner-reactivation.test.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `docs/events/event_20260315_autorunner_planner_retarget.md`

## Structured Execution Phases

- Phase 1 — Rewrite planner contract: update `plan.ts` templates and plan-mode wording so planner artifacts encode delegation-first execution slices, architecture fields migrated from `software-architect`, and explicit bootstrap policy.
- Phase 2 — Rewrite runtime prompt and workflow contract: update `runner.txt`, `plan.txt`, `claude.txt`, `anthropic-20250930.txt`, `session/system.ts`, and `agent-workflow` skill content so autorunner treats narration as non-blocking, delegation as default, and stop gates as the only pause boundary.
- Phase 3 — Rewrite bootstrap and capability policy: update `AGENTS.md`, `templates/AGENTS.md`, `enablement.json`, `templates/system_prompt.md`, and `templates/global_constitution.md` to remove default loading of `model-selector`, `mcp-finder`, `skill-finder`, and `software-architect`, while preserving on-demand availability.
- Phase 4 — Validation and doc sync: add or update targeted tests covering planner artifact generation, runner continuation wording, and bootstrap prompt policy; then sync event + architecture documentation.

## Validation

- Planner regression: verify `plan_enter` / `plan_exit` artifact completeness gates still pass and new templates materialize execution-ready tasks without placeholders.
- Workflow regression: verify autonomous continuation tests still enforce mission approval, stop gates, and delegated continuation wording.
- Prompt policy regression: verify no prompt/bootstrap surface still mandates default loading of `model-selector`, `mcp-finder`, `skill-finder`, or `software-architect`.
- Documentation sync: update event ledger and confirm whether `docs/ARCHITECTURE.md` requires wording changes for bootstrap/runtime contract.

## Handoff

- Build agent must treat this spec as the authority for the autorunner optimization slice and must read `proposal.md`, `spec.md`, `design.md`, `tasks.md`, and `handoff.md` before coding.
- Build agent must keep planner/runtime naming aligned with `tasks.md`; runtime todo should use the same task names visible in planner artifacts.
- Build agent must implement bootstrap removal and planner/runner rewrites together as one coherent contract update; do not land only the skill-removal half without the planner/runner contract half.
- Build agent must preserve fail-fast, no-silent-fallback policy across all prompt and runtime contract changes.
