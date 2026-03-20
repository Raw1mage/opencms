# Tasks

## 1. Planning / Analysis Baseline

- [x] 1.1 Read the approved implementation spec
- [x] 1.2 Confirm scope and stop gates
- [x] 1.3 Confirm critical files and execution phases
- [x] 1.4 Create and align the session context-control spec package
- [x] 1.5 Create the event ledger for this workstream

## 2. Runtime Mapping

- [x] 2.1 Trace `prompt.ts` → `message-v2.ts` → `llm.ts` → `provider/transform.ts` request assembly path
- [x] 2.2 Trace `processor.ts` / `compaction.ts` overflow + compaction execution path
- [x] 2.3 Review compaction config schema and compaction tests

## 3. Optimization Analysis

- [x] 3.1 Identify low-risk token/context quick wins
- [x] 3.2 Identify medium/high-risk refactor candidates and trade-offs
- [x] 3.3 Produce a validation-oriented optimization roadmap
- [x] 3.4 Add documentation-governance optimization track
- [x] 3.5 Define session context throttling strategy for repeated prompt blocks

## 4. Implementation Slice Definition

- [x] 4.1 Define Slice A: Prompt Block Compaction / Throttling Design
- [x] 4.2 Define Slice B: Low-risk Context Optimization Candidates
- [x] 4.3 Define Slice C: Context Sidebar Evolution
- [x] 4.4 Choose first implementation slice entry criteria and validation gate

## 5. MIAT Diagram Package

- [x] 5.1 Define builder-first decomposition path for `A1 -> A11 -> A111`
- [x] 5.2 Upgrade IDEF0 to true three-level hierarchy
- [x] 5.3 Upgrade GRAFCET to true three-level hierarchy
- [x] 5.4 Verify traceability between diagram hierarchy and implementation slices

## 6. Validation Plan

- [x] 6.1 Define KPI groups for token/context optimization
- [x] 6.2 Define baseline vs after comparison methodology
- [x] 6.3 Define telemetry implementation plan and validation gates

## 7. Documentation / Retrospective

- [x] 7.1 Sync relevant architecture / event docs
- [x] 7.2 Compare outputs against the proposal's effective requirement description
- [x] 7.3 Produce a validation checklist covering requirement satisfaction, gaps, deferred items, and evidence

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
