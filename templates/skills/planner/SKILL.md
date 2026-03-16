---
name: planner
description: Produce and maintain a /specs/ plan folder with structured specification documents (proposal, spec, design, tasks, handoff, implementation-spec) that guide AI implementation. Supports iterative growth — specs evolve alongside the codebase. Use when users need requirement analysis, project planning, phased execution contracts, or spec-driven development workflows.
---

# Skill: planner (Spec-Driven Development Planner)

中文常稱：**規格規劃器 / planner skill**；口語：**plan skill / 開 plan**。

## 1. Overview

Transform user requirements into a structured `/specs/` folder containing formatted specification documents that serve as an executable contract for AI-driven implementation.

The planner produces artifacts that:
- **Guide implementation**: each document answers a specific question the implementer needs
- **Support iteration**: specs grow and evolve alongside the codebase across multiple sessions
- **Enable handoff**: any AI agent (or human) can pick up and execute from the spec folder alone
- **Maintain traceability**: from user intent → requirements → design → tasks → validation

This skill is **project-agnostic** — it works with any codebase, any language, any framework.

## 2. Use this skill when

- User asks to plan, design, or spec out work before implementing
- User mentions "plan mode", "let's plan this", "write a spec", "開 plan"
- Task is complex enough to benefit from structured planning (multi-file, architectural, phased)
- User wants to break down a large request into executable phases
- An existing `/specs/` folder needs updating after scope changes
- User wants to resume or extend a previous plan

Do NOT use this skill for:
- Simple, single-file changes that need no planning
- Pure code review or debugging (unless it reveals planning needs)
- Questions that can be answered directly

## 3. Folder Structure

All plan artifacts live under a date-prefixed directory:

```
specs/
└── YYYYMMDD_<slug>/
    ├── implementation-spec.md   ← primary execution contract
    ├── proposal.md              ← why / scope / constraints
    ├── spec.md                  ← behavioral requirements (GIVEN/WHEN/THEN)
    ├── design.md                ← architecture decisions, risks, critical files
    ├── tasks.md                 ← execution checklist (canonical task source)
    ├── handoff.md               ← executor instructions, stop gates, readiness
    ├── idef0.json               ← functional decomposition (via miatdiagram skill)
    ├── grafcet.json             ← state machine model (via miatdiagram skill)
    └── diagrams/                ← optional: deeper IDEF0/GRAFCET decompositions
        ├── <repo>_a1_idef0.json
        ├── <repo>_a1_grafcet.json
        └── ...
```

**Naming convention**: `YYYYMMDD` is the creation date, `<slug>` is a kebab-case summary derived from the session title or user description. Example: `specs/20260317_user-auth-rewrite/`.

**Location**: In a git repo, specs live at `<worktree>/specs/`. Outside git, use a local working directory.

## 4. Artifact Definitions

### 4.1 implementation-spec.md (Primary)

The execution contract. Another AI must be able to implement from this file alone.

**Required sections in this exact order:**

```markdown
# Implementation Spec

## Goal
- <one-sentence execution objective>

## Scope
### IN
- <what is being built/changed>

### OUT
- <what is explicitly excluded>

## Assumptions
- <assumption that could change the plan if wrong>

## Stop Gates
- <condition that requires stopping and re-planning>
- <approval / decision / blocker conditions>

## Critical Files
- <absolute or repo-relative file paths likely to be touched>

## Structured Execution Phases
- <phase 1: description>
- <phase 2: description>
- <phase 3: description>

## Validation
- <tests / commands / end-to-end checks>
- <how to verify each phase is complete>

## Handoff
- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
```

**Rules:**
- Every section must be non-empty (no placeholder tokens like `<...>`)
- `## Scope` must contain both `### IN` and `### OUT`
- `## Structured Execution Phases` must have at least one bullet
- `## Critical Files` must list at least one path
- `## Validation` must have at least one verifiable check

### 4.2 proposal.md

Captures **why** this work exists and **what changes**.

**Required headings:** `Why`, `What Changes`, `Capabilities`, `Impact`

**Recommended headings:** `Original Requirement Wording`, `Requirement Revision History`, `Effective Requirement Description`, `Scope`, `Non-Goals`, `Constraints`

```markdown
# Proposal

## Why
- <problem / opportunity / pressure>

## Original Requirement Wording (Baseline)
- "<user's original words, recorded faithfully>"

## Requirement Revision History
- <date>: <what changed and why>

## Effective Requirement Description
1. <current effective requirement>

## Scope
### IN
- <in scope>
### OUT
- <out of scope>

## Non-Goals
- <explicitly not being solved>

## Constraints
- <technical / product / policy constraint>

## What Changes
- <what will change>

## Capabilities
### New Capabilities
- <capability>: <brief description>
### Modified Capabilities
- <existing capability>: <behavior delta>

## Impact
- <affected code, APIs, systems, operators, or docs>
```

### 4.3 spec.md

Behavioral requirements using structured GIVEN/WHEN/THEN scenarios.

**Required headings:** `Purpose`, `Requirements`, `Acceptance Checks`

```markdown
# Spec

## Purpose
- <behavioral intent of this change>

## Requirements

### Requirement: <name>
The system SHALL <behavior>.

#### Scenario: <name>
- **GIVEN** <context>
- **WHEN** <action>
- **THEN** <outcome>

## Acceptance Checks
- <observable verification point>
```

**Rules:**
- At least one `### Requirement:` section
- At least one `#### Scenario:` with GIVEN/WHEN/THEN
- At least one acceptance check

### 4.4 design.md

Architecture decisions, trade-offs, and risk analysis.

**Required headings:** `Context`, `Goals / Non-Goals`, `Decisions`, `Risks / Trade-offs`, `Critical Files`

```markdown
# Design

## Context
- <current state / background>

## Goals / Non-Goals
**Goals:**
- <goal>

**Non-Goals:**
- <non-goal>

## Decisions
- <decision and rationale>

## Data / State / Control Flow
- <request / state / config flow>

## Risks / Trade-offs
- <risk> -> <mitigation>

## Critical Files
- <file path>
```

**Rules:**
- At least one decision recorded
- At least one risk or trade-off
- At least one critical file listed

### 4.5 tasks.md

The canonical execution checklist. Build-side agents materialize runtime todos from this file.

**Required heading:** `Tasks`

```markdown
# Tasks

## 1. <Phase Name>
- [ ] 1.1 <task description>
- [ ] 1.2 <task description>

## 2. <Phase Name>
- [ ] 2.1 <task description>
```

**Rules:**
- At least one unchecked `- [ ]` checklist item
- Task names should be delegation-aware slices (e.g., `rewrite`, `delegate`, `integrate`, `validate`) not vague bullets like `implement feature`
- Task naming must align with `## Structured Execution Phases` in implementation-spec.md
- As implementation progresses, tasks are checked off: `- [x]`

### 4.6 handoff.md

Executor instructions — what the build agent needs to know before coding.

**Required headings:** `Execution Contract`, `Required Reads`, `Stop Gates In Force`, `Execution-Ready Checklist`

```markdown
# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads
- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State
- <what has been completed so far>
- <what remains>

## Stop Gates In Force
- <active stop gates from implementation-spec.md>

## Build Entry Recommendation
- <recommended starting point>

## Execution-Ready Checklist
- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
```

**Rules:**
- Must list required reads
- Must preserve active stop gates
- Must include an execution-ready checklist with `- [ ]` items

### 4.7 idef0.json + grafcet.json

Formal modeling artifacts for functional decomposition and state machine behavior.

**These are produced by the `miatdiagram` skill.** When this skill is available, invoke it to generate IDEF0 and GRAFCET JSON files. When not available, these files may be omitted — they are recommended but not strictly required for the plan to be valid.

See `miatdiagram` skill documentation for:
- IDEF0 structure, naming conventions, hierarchy rules, ICOM arrows
- GRAFCET structure, evolution rules, traceability to IDEF0
- File naming conventions for deeper decompositions (`diagrams/` subdirectory)

## 5. Workflow

### Phase 1: Understand

1. Read the user's request carefully
2. Explore the codebase to understand current state (use Explore agents for broad search)
3. Ask clarifying questions when scope, priority, or trade-offs are ambiguous
4. Identify existing specs under `/specs/` — determine if this is a new plan or an extension

### Phase 2: Plan

1. Create the spec directory: `specs/YYYYMMDD_<slug>/`
2. Draft `proposal.md` first — capture why, what, constraints
3. Draft `implementation-spec.md` — the execution contract
4. Draft `spec.md` — behavioral requirements with scenarios
5. Draft `design.md` — decisions, risks, critical files

### Phase 3: Detail

1. Write `tasks.md` — break execution phases into checklist items
2. Write `handoff.md` — executor instructions and readiness checklist
3. If `miatdiagram` skill is available, generate `idef0.json` + `grafcet.json`
4. Cross-check: tasks align with execution phases, handoff reflects stop gates

### Phase 4: Validate

Before declaring the plan ready, verify:

1. **Structural completeness**: all required headings present in each artifact
2. **No placeholders**: no `<...>` template tokens remain
3. **Cross-referential consistency**:
   - Scope in proposal.md ↔ implementation-spec.md ↔ tasks.md
   - Stop gates in implementation-spec.md ↔ handoff.md
   - Validation checks in implementation-spec.md ↔ spec.md acceptance checks
   - Critical files in implementation-spec.md ↔ design.md
   - Task names in tasks.md ↔ execution phases in implementation-spec.md
4. **IDEF0/GRAFCET** (if present): structural validity and traceability (per miatdiagram rules)

### Phase 5: Handoff

Present the completed plan to the user for approval. Once approved, the plan is execution-ready — any AI agent can read the spec folder and begin implementing.

## 6. Iterative Growth

Plans are living documents. As implementation progresses:

- **Tasks get checked off** in `tasks.md` as work completes
- **Handoff.md is updated** with current state, resolved stop gates, new entry recommendations
- **Design decisions accumulate** in `design.md` as implementation reveals new trade-offs
- **Scope may expand** — new phases and tasks are added to implementation-spec.md and tasks.md
- **Validation evidence grows** — test counts, passing checks, delivered features
- **Requirement revisions** are logged in `proposal.md` revision history

When scope changes are significant:
1. Update `proposal.md` revision history
2. Add new phases to `implementation-spec.md`
3. Add new tasks to `tasks.md`
4. Update `handoff.md` current state and build entry recommendation
5. If IDEF0/GRAFCET exist, update or extend them

## 7. Validation Checklist

Use this as a gate before declaring a plan complete:

- [ ] `implementation-spec.md` has all 8 required sections, non-empty, no placeholders
- [ ] `proposal.md` has Why, What Changes, Capabilities, Impact — all non-empty
- [ ] `spec.md` has at least one Requirement with a Scenario and at least one Acceptance Check
- [ ] `design.md` has at least one Decision, one Risk, one Critical File
- [ ] `tasks.md` has at least one unchecked task item aligned with execution phases
- [ ] `handoff.md` has Execution Contract, Required Reads, Stop Gates, Readiness Checklist
- [ ] No `<placeholder>` tokens remain in any artifact
- [ ] Cross-references are consistent (scope, stop gates, tasks, validation)
- [ ] IDEF0/GRAFCET files pass structural validation (if present)

## 8. Working Style

- **Discussion-first, not execution-first.** Plan mode is for thinking, reading, searching, and writing specs. Small bounded edits to support planning are acceptable; broad implementation is not.
- **Ask, don't assume.** Use structured questions with options for bounded decisions (scope, priority, approval posture). Use freeform questions only for open-ended domain context.
- **MVP-first layering.** Prefer phased plans where Phase 1 delivers a minimal viable slice, with later phases extending.
- **Delegation-aware task naming.** Write tasks as action-oriented slices a build agent can pick up: `rewrite X`, `integrate Y`, `validate Z` — not `implement feature`.
- **Respect user wording.** Record the user's original requirement faithfully in proposal.md. Track revisions explicitly.
- **Keep artifacts aligned.** When one artifact changes, propagate the change to related artifacts. A scope change in proposal.md must reflect in implementation-spec.md, tasks.md, and handoff.md.

## 9. Companion Skills

- **miatdiagram**: Produces `idef0.json` and `grafcet.json` for functional decomposition and state machine modeling. Reference this skill for IDEF0/GRAFCET normative rules. When both skills are active, planner defers all IDEF0/GRAFCET production and validation to miatdiagram.
