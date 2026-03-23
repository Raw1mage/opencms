# Proposal

## Why

- Recent testing showed that stronger instructions inside builder/build-mode text do not reliably make the LLM behave correctly.
- The user proposed a stronger calibration model: before entering build-mode, ask the LLM a bounded quiz about the authoritative execution contract and reject build entry if any answer is wrong.
- This quiz guard provides materially higher confidence than passive prompt guidance because the system receives explicit, machine-checkable evidence of whether the LLM is calibrated.
- The user explicitly prefers to defer broad hard-guard rule engines for now because their implementation cost is high and their marginal value is low if quiz guard already solves the large majority of failures.

## Original Requirement Wording (Baseline)

- "針對builder guard rail，我的想法是，在plan exit時，插入一個問題考AI，他回答正確了就確認可進行，他答錯了就給rejection。這個問題包含：你現在的main repo為何？你的base branch為何？你將在哪個repo工作？你將開發哪個branch？等於是花一點token跑自我校準"
- "我覺得AI一定會回答問題，我們也一定能根據他的回答而獲得相當的信心。他答錯了就是給予硬阻止。這樣的機制我的信心度高很多"
- "我非常期待我的系統全面導入這套『quiz guard』來加強AI的行為一致性。"
- "hard guard可以先defer。因為它的程式價值偏低，必須為千萬種情境客製rule based gate，難度高。如果quiz guard能解決99%我覺得已經夠了"

## Requirement Revision History

- 2026-03-21: initial build-mode refactoring plan root created but left as template-only skeleton.
- 2026-03-23: beta-workflow skill wiring landed as an additive guidance layer for beta-enabled runs.
- 2026-03-23 (earlier revision): scope reframed toward negative interceptors and prompt/workflow de-redundancy.
- 2026-03-23 (later revision): quiz guard promoted to primary admission control with hard guards retained as a second line.
- 2026-03-23 (current revision): broad hard-guard expansion deferred; quiz guard becomes the primary near-term strategy.
- 2026-03-23 (web runtime bug follow-up): discovered that `plan_exit` / `plan_enter` are hidden in web runtime because tool registry only registers them for `app|cli|desktop`; fix this directly on the main `cms` branch because it blocks planner-to-build workflow on the actual product surface.

## Effective Requirement Description

1. Builder/build-mode must gate beta-sensitive execution behind a structured quiz guard.
2. The quiz must use deterministic answer checking against mission metadata.
3. Wrong answers must trigger a bounded reflection retry; repeated failure must stop build admission and ask the user.
4. Prompt/skill/MCP surfaces are supportive only and must not remain the primary enforcement layer.
5. Broad hard-guard rule systems are deferred unless later evidence proves quiz guard insufficient.

## Scope

### IN

- Define the quiz guard schema and admission lifecycle.
- Define answer validation and rejection behavior.
- Define how prompt text is reduced once quiz guard exists.
- Capture deferred hard-guard follow-up only as future work, not current scope.

### OUT

- Full repo-wide rollout in the same implementation slice unless explicitly approved.
- Heuristic judging of partially correct freeform answers.
- A broad matrix of downstream hard guards across many tool/action scenarios.

## Non-Goals

- Turning build-mode into a trust-only system with no admission control.
- Asking open-ended prose questions that cannot be machine-checked.
- Allowing unlimited retries until the model effectively guesses the answer key without meaningful calibration.
- Spending the current slice on a massive rule-based enforcement engine.

## Constraints

- No new fallback mechanisms.
- Quiz inputs must come from runtime SSOT, not reconstructed chat memory.
- Rejection must be explicit and evidence-backed.
- Plan/doc artifacts must remain synchronized with any admission-control changes.

## What Changes

- A structured builder admission quiz will be inserted at `plan_exit` / build entry and possibly first beta continuation.
- On initial failure, the model may reflect and retry once; if it still fails, admission stops and asks the user.
- Quiz answers will be compared against `mission.beta` and mainline authority metadata.
- Existing workflow wording will be downgraded to advisory/minimal narration after quiz guard coverage is established.
- Hard-guard expansion is intentionally deferred unless quiz validation exposes concrete residual failures.

## Capabilities

### New Capabilities

- Admission-time self-calibration with deterministic pass/fail behavior.
- Explicit rejection when the LLM cannot restate authoritative execution boundaries.
- Higher-confidence builder admission before beta-sensitive coding begins.

### Modified Capabilities

- Build-mode entry: now requires quiz guard success for beta-sensitive execution.
- Prompt/skill guidance: demoted from pseudo-enforcement to advisory support.
- Hard guards: treated as optional future follow-up, not the primary current investment.

## Impact

- Affected builder runtime: workflow-runner, trigger/continuation surfaces, mission consumption, plan_exit/build entry orchestration.
- Affected tests: build-mode continuation tests, bootstrap-policy tests, quiz guard regression coverage.
- Affected docs: active plan artifacts, event logs, and architecture authority notes.
