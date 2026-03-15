# Design: autorunner planner retarget

## Context

- 現有 autorunner 已有 mission-driven continuation、planner artifacts、runtime todo、health/queue/anomaly surfaces，但主觀使用感仍接近 turn-based assistant。
- 先前文件與測試已說明：真正缺口在於 planner/runner/boundary contract 尚未形成穩定 execution loop，而 bootstrap 常駐 skills 又把系統推回顧問化分析模式。
- `plan.ts` 目前仍使用偏通用的 artifact fallback templates；`runner.txt` 與 `agent-workflow` skill 也尚未把 delegation-first 與 non-blocking narration 一起明文化。

## Goals / Non-Goals

**Goals:**

- 讓 planner artifact、runner prompt、bootstrap policy 對齊同一個 autorunner-centered contract。
- 移除低實效常駐 skill，降低 prompt 噪音與過時策略依賴。
- 將 architecture-thinking 內建到 planner templates 與 handoff，而非依賴 `software-architect` 常駐。
- 讓 delegation / integration / validation 成為 planner-to-runner 的預設 execution path。

**Non-Goals:**

- 不在本輪建立 session daemon / worker supervisor 新 substrate。
- 不在本輪重新設計 model/account policy 或 rotation3d 運行機制。
- 不在本輪移除 skill distribution 資產或 capability registry 中的 optional entries。

## Decisions

- 保留 `agent-workflow` 作為唯一 workflow-default skill，但重寫其內容與引用方式，使其更貼近 autorunner delegation-first contract。
- 移除 `model-selector`、`software-architect`、`mcp-finder`、`skill-finder` 的 bootstrap default posture；這些能力只保留為 on-demand。
- 把 `software-architect` 的實用要素移植進 planner hardcode：constraints、boundaries、trade-offs、critical files、risk、validation、delegation strategy。
- 以 planner package 為 authority，讓 `tasks.md` 顯式列出 rewrite slices，避免 runtime todo materialization 再退化成 generic implementation 項目。
- 同步修改 runtime prompt surfaces 與 template surfaces，避免 repo/runtime/template 三者對 bootstrap contract 的敘述漂移。

## Data / State / Control Flow

- User decision → plan mode artifact refinement (`implementation-spec.md`, `proposal.md`, `spec.md`, `design.md`, `tasks.md`, `handoff.md`).
- `plan.ts` template/handoff rewrite → future `plan_enter` artifact bootstrap 與 `plan_exit` todo materialization 生成新的 delegation-aware execution seed。
- Build-mode runner reads approved mission + planner tasks → `runner.txt` / prompt contracts describe continue/pause semantics → runtime todo/workflow-runner continues under the same gate logic.
- Bootstrap docs (`AGENTS.md`, templates, enablement, system prompt) act as upstream control contract for future main-agent sessions, preventing removed skills from being silently reintroduced as default loads.

## Risks / Trade-offs

- 移除預設 skills 可能讓少數 architecture-heavy 對話少一層顯式提示 -> 以 planner hardcode 與 on-demand routing 補回，而非保留常駐噪音。
- 同步面廣（runtime prompt + templates + docs + tests） -> 必須一次性一起更新，否則 repo/runtime/template 會互相打架。
- 若只改 docs 不改 planner templates，實際 `plan_enter` 仍會產出舊 contract -> 因此 `plan.ts` 是主優先改點之一。
- 若只改 planner 不改 runner wording，autorunner 仍可能在行為描述上保守停頓 -> 需同步改 `runner.txt` 與 build/plan prompt surfaces。
- 若只改 AGENTS / prompts 不改 `agent-workflow` skill，本機實際 workflow 仍會保留舊語義 -> 需同步更新 template/runtime skill mirror。

## Critical Files

- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/prompt/runner.txt`
- `packages/opencode/src/session/prompt/plan.txt`
- `packages/opencode/src/session/prompt/claude.txt`
- `packages/opencode/src/session/prompt/anthropic-20250930.txt`
- `packages/opencode/src/session/system.ts`
- `templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `AGENTS.md`
- `templates/AGENTS.md`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `templates/system_prompt.md`
- `templates/global_constitution.md`

## Supporting Docs (Optional)

- `docs/ARCHITECTURE.md`
- `docs/events/event_20260313_autorunner_autonomous_agent_completion.md`
- `docs/events/event_20260313_autorunner_system_stability_plan.md`
- `docs/events/event_20260313_planner_sync_from_autorunner.md`
