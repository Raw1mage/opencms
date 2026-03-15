# Proposal: openspec-like planner

## Why

- The planner workflow had drifted into creating fragmented plan roots from discussion slices, timestamp slugs, and follow-up artifacts.
- The user clarified the intended model: a repo may contain multiple plans, but the same workstream must extend its existing plan instead of spawning a new sibling root for every new idea, bug, or follow-up slice.
- Without reconverging adjacent planner slices back into the correct workstream root, `proposal/spec/design/tasks/handoff` multiply, references drift, and runtime todo lineage becomes harder to govern.

## Original Requirement Wording (Baseline)

- 「/specs 允許有多個 plan，命名格式是 `<date>_<plan_title>`。」
- 「同一個 workstream 的新想法/意見/bug 要在同一 plan 擴充，不要無限發散新 plan。」
- 「新 plan 只能由使用者主動提起，或 AI 建議後經使用者明確同意。」
- 「`openspec-like-planner` 與 `autorunner-spec-execution-runner` 目前是已完成歷史 plan，主要價值是 architecture 回灌與未來重構再喚醒。」
- 「復盤基礎應由需求原話 + 需求修訂歷程分析產生，validation checklist 是復盤結果報告。」
- 「復盤基礎應是基於1和2分析產生的description文件。validation checklist是我期待看到的復盤結果報告」

## Requirement Revision History

- 初始要求：移除 `specs/changes/` 噪音層，收斂命名為 `<date>_<plan_title>`。
- 中段澄清：不是全 repo 只能有一個 plan，而是同 workstream 不要無限分岔。
- 分岔治理澄清：AI 不可自行新開 plan，必須使用者請求或明確同意。
- 後續定位澄清：兩個既有 plan 視為歷史文件，不作為持續執行 backlog。
- 復盤澄清：復盤基礎放在 proposal（原話+修訂+有效需求描述），checklist 是輸出報告。

## Effective Requirement Description

本 workstream 的有效需求為：

1. `/specs/` 可同時存在多個 plan roots。
2. 同一 workstream 的擴充必須回到既有 plan，不得每次對話分支就開新 plan。
3. 新 plan 建立必須有明確人類決策（使用者主動提出，或使用者明確批准 AI 提案）。
4. 已完成 plan 應保留為歷史知識資產，用於 `docs/ARCHITECTURE.md` 回灌與未來重構再喚醒。
5. 完工復盤時，應以 proposal 中的需求基線與修訂歷程為對照來源，輸出 requirement coverage/gap 的 validation checklist。

## What Changes

- Converge the planner-first / restart / runner-lineage workstream into its canonical root: `specs/20260315_openspec-like-planner/`.
- Use one primary artifact set (`proposal/spec/design/implementation-spec/tasks/handoff`) as the living planner surface for this workstream.
- Preserve deeper analysis artifacts for this same workstream as supporting docs in the same root.
- Keep unrelated-but-valid workstreams as separate plans instead of forcing the entire repo into one root.

## Capabilities

### New Capabilities

- `stable-workstream-plan-root`
  - one canonical plan root can accumulate additional design slices for the same workstream without opening a new sibling plan for every thread turn.
- `supporting-doc-expansion`
  - advanced design artifacts for the same workstream (runner contract, target model, compatibility analysis, roadmap) can live beside the main six files as supporting docs.

### Modified Capabilities

- `planner-execution-contract`
  - planner artifacts remain the execution substrate, but now within a stable expandable root for this workstream instead of multiple scattered sibling folders.
- `todo-lineage-contract`
  - runtime todo still derives from `tasks.md`, but `tasks.md` is now the backlog inside the canonical workstream package.
- `planner-to-runtime-handoff`
  - build/runner continuation now reads from one stable workstream plan location rather than chasing whichever sibling plan root was created most recently.
- `adjacent-workstream-separation`
  - separate workstreams may remain separate plans when their scope is meaningfully distinct.

## Impact

- Affects the canonical planning surface under `specs/20260315_openspec-like-planner/`.
- Replaces fragmented sibling plan roots for this workstream with one durable package plus supporting docs.
- Establishes the rule that repos may host multiple plans, but the same workstream should expand its existing plan instead of branching endlessly.
