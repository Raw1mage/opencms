# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first.
- Build agent must read companion artifacts (`proposal.md` / `spec.md` / `design.md` / `tasks.md` / `idef0.json` / `grafcet.json` / `c4.json` / `sequence.json`) before coding.
- Build agent must materialize runtime todo from `tasks.md` before coding begins.
- Build agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same tasks.md-derived todo naming.
- **Migration safety gate**: Phase 5 (dog-fooding) must only run AFTER Phase 1–4 are complete, the new skill is deployed, and `plan-migrate.ts` has been tested against a throwaway fixture. Migrating this very plan prematurely would break the build surface.

## Required Reads

- `proposal.md`（含 Original Requirement Wording、Revision History、Effective Requirement Description）
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `idef0.json` / `grafcet.json` / `c4.json` / `sequence.json`

## Current State

- Plan 自身當前位置：`plans/plan-builder/`（legacy 格式，dog-fooding 目標）
- Plan 自身當前狀態：`planned`（所有 tasks 尚未勾選）
- 已完成：Phase 1（本 plan 的 proposal / spec / design / implementation-spec 完成）、Phase 2（本 plan 的 tasks / handoff 完成）、Phase 3（本 plan 的 IDEF0 / GRAFCET / C4 / Sequence 產出）
- 尚待：Phase 4（本 plan 的 validation）、Phase 5（本 plan 呈送使用者）
- 實作任務剩餘：Phase 1–7 全部（本 plan 的 tasks.md 列的 7 個階段即實作階段，完成後將 self-migrate 到 `specs/plan-builder/`）

## Stop Gates In Force

- **使用者未確認 SKILL.md draft**（Phase 1 Task 1.4）：必須 review approval 才可進入 Phase 2
- **使用者未確認 skill 部署位置**：`~/.claude/skills/plan-builder/`（全域）vs `.claude/skills/plan-builder/`（repo-local）
- **migration 邏輯若改變 git history**：`git mv` 失效時禁止靜默改 copy+delete
- **狀態推斷規則無法 deterministic 收斂**：任何無法推斷的組合必須 throw `StateInferenceError`
- **下游 skill 契約變動超出相容範圍**：beta-workflow 若需要 runtime behavior 改動，停下討論
- **Phase 5 dog-fooding 驗收**：實測失敗時停下回歸 Phase 2 修補
- **不可跳過 plan 直接 implementation**（AGENTS.md 第零條）
- **不可引入靜默 fallback**（AGENTS.md 第一條）

## Build Entry Recommendation

- 從 `## 1. Contract 定案` 入手（Task 1.1 draft SKILL.md）
- SKILL.md draft 完成後立即呼叫使用者 review（不連跑 Task 1.2 避免浪費工）
- Schema 與 SKILL.md 雙向校對完成前不進入 Phase 2 scripts 實作
- Phase 2 scripts 建議順序：先 `lib/state-inference.ts` + `lib/ensure-new-format.ts`（基礎 lib），再 `plan-init.ts` / `plan-state.ts`（read-only），再 `plan-promote.ts` / `plan-archive.ts` / `plan-migrate.ts`（write ops），最後 `plan-gaps.ts` / `plan-validate.ts`（分析）
- Phase 5 dog-fooding 在所有前面階段通過後才執行；先用人工佈置 fixture 試 migration 再動本 plan

## Execution-Ready Checklist

- [ ] Implementation spec (`implementation-spec.md`) is complete
- [ ] Companion artifacts (proposal / spec / design / tasks / IDEF0 / GRAFCET / C4 / Sequence) are aligned
- [ ] Validation plan is explicit（implementation-spec.md 的 ## Validation 段）
- [ ] Runtime todo seed is present in `tasks.md`（Phase 1–7 共 30+ tasks）
- [ ] User has approved this plan package
- [ ] Skill 部署位置已決定

## Completion / Retrospective Contract

- Review implementation against `proposal.md` 的 Effective Requirement Description 10 項
- Generate validation checklist derived from `tasks.md`, runtime todo outcomes, 與 Phase 5 dog-fooding 實測結果
- Report requirement coverage、partial fulfillment、deferred items（特別是 Phase 7 下游同步）、remaining gaps
- Do not expose raw internal chain-of-thought；只出 auditable conclusions 與 evidence
- 完成後由本 plan 觸發自身 archive（Task 6.4 promote 到 living；日後某天 archive 到 `specs/archive/plan-builder-YYYY-MM-DD/`，留作 skill 誕生的歷史紀錄）
