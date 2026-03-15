# Planner Spec Methodology

Date: 2026-03-13
Status: Draft
Branch: autorunner
Workspace: /home/pkcs12/projects/opencode-runner

## 1. Objective

Define the implementation plan for evolving the OpenCode planner from a single plan-file workflow into a repo-native spec production system rooted in `repo/specs/`.

The planner's purpose is not merely to produce a loose plan. Its purpose is to help the user turn evolving conversational intent into rigorous implementation specifications that can be handed off to AI for autonomous execution.

This methodology intentionally borrows OpenSpec's **artifact structure** while preserving OpenCode's distinctive strengths:

- MCP `question` guided planning
- planning-first runtime activation
- stop gates / approval / decision boundaries
- runtime handoff to todo graph / autonomous execution

---

## 2. Guiding Principle

We are borrowing **methods**, not copying code.

### From OpenSpec we borrow:

- artifact decomposition
- separation of spec / design / tasks
- change-as-unit thinking
- behavior-first structure
- execution handoff discipline

### From OpenCode we keep and strengthen:

- conversation-native planning
- question-driven clarification
- autonomous-ready todo/action metadata
- human-visible pause gates
- runtime integration with build/autorunner

In short:

> OpenSpec contributes artifact methodology.
> OpenCode contributes interactive planning runtime.

---

## 3. Why `repo/specs` Should Be the Planner Base

The planner should not depend on transient chat context as its long-term memory.

Using `repo/specs` as the planner base gives us:

1. **Persistent spec substrate**
   - the planning result lives in the repo, not only in session history
2. **Human + AI collaboration surface**
   - users can reason in conversation while AI continuously hardens artifacts
3. **Execution-ready source of truth**
   - executor agents can read specs instead of reconstructing intent from chat turns
4. **Future daemon compatibility**
   - long-running autorunner can treat specs as durable execution input

---

## 4. Planner Output Model

The planner output should no longer be thought of as one markdown plan.
It should be a small artifact set.

## 4.1 Recommended base structure

```text
specs/
  <date>_<plan-title>/
    implementation-spec.md
    proposal.md
    spec.md
    design.md
    tasks.md
    handoff.md
```

This mirrors OpenSpec's artifact layering, but is integrated into OpenCode's planner/runtime.

## 4.2 Role of each artifact

### proposal.md

Captures:

- why this work exists
- scope / non-goals
- user intent and constraints
- high-level success target
- the user's requirement wording as close to original phrasing as possible
- requirement revisions / reversals over time, with clear traceability
- effective requirement description synthesized from original wording + revision history

Recommended internal sections:

- `Original Requirement Wording` (near-verbatim baseline)
- `Requirement Revision History` (what changed, when, why)
- `Effective Requirement Description` (the final requirement set used for implementation and retrospective)

### spec.md

Captures:

- behavioral requirements
- scenarios / acceptance conditions
- externally visible contract
- what changes, not how it is implemented

### design.md

Captures:

- technical approach
- architecture boundaries
- data flow / state flow
- key decisions and trade-offs
- critical files/modules

### tasks.md

Captures:

- execution phases
- implementation checklist
- ordering / dependencies
- validation tasks
- todo graph seed for runtime materialization

Checklist contract:

- unchecked checklist items (`- [ ] ...` / `* [ ] ...`) are the planner handoff seed for runtime todo materialization
- checked items may still remain in the document for human progress readability, but they are not used as new todo seeds during planner handoff
- runtime policy defaults should be treated as explicit contract, not hidden implementation trivia
- once runtime todo is materialized, user-facing progress reporting and execution decisions must refer to that same planner-derived todo set rather than an assistant-invented parallel checklist

## 4.3 Todo model (planner -> runtime)

Todo in OpenCode planner is **not** a freeform scratchpad.
It is the runtime projection of the approved plan.

### Source of truth

1. planner artifacts define the work
2. `tasks.md` defines the execution ledger
3. runtime todo is materialized from `tasks.md`

Therefore:

- todo does not become a second planning surface
- assistant-internal thought organization does not override todo
- conversational turns alone must not mutate visible todo truth

### Stability rule

Runtime todo should be relatively stable.
It may change when:

- planner artifacts change
- a replan is explicitly adopted
- runtime status changes (`pending` -> `in_progress` -> `completed` / `cancelled`)

It should **not** change merely because:

- the assistant wants to reorganize its private working notes
- the user asks a clarifying question that has not yet been written back into the plan
- the assistant wants a shorter temporary checklist for itself

### Visibility rule

Once runtime todo is visible in sidebar/work monitor:

- status reporting must use that same task naming
- user decision prompts must reference that same visible todo naming
- if temporary internal tracking is needed, it must be reconciled back into planner-derived todo before asking the user for decisions

### handoff.md

Captures:

- how build/autorunner should consume the artifacts
- what must be done before autonomous execution continues
- any remaining approval / stop gate / unresolved risk items
- the exact naming that execution/status reporting must reuse when referring to remaining work

---

## 5. Separation of Concerns

This is the most important methodological rule.

## 5.1 Spec = what

Spec describes behavior and verifiable expectations.
It should avoid implementation details whenever possible.

Good content:

- user-visible behavior
- downstream/system-visible behavior
- failure conditions
- acceptance scenarios

## 5.2 Design = how

Design explains implementation approach.
It contains:

- architectural shape
- technical decisions
- trade-offs
- module boundaries
- migration / rollout thinking

## 5.3 Tasks = execution steps

Tasks are not behavioral truth and not architecture rationale.
They are the execution ledger.
They should be structured so runtime can materialize them into todos.

---

## 6. What Makes OpenCode Planner Different from OpenSpec

OpenSpec is strong in artifact structure.
OpenCode must be stronger in interactive refinement.

## 6.1 MCP `question` remains central

The planner must not become a static templating engine.
It should continuously use MCP `question` to refine missing details such as:

- scope boundaries
- first milestone focus
- autonomy level
- approval requirements
- validation criteria
- trade-off choices

This is a core differentiator and must remain first-class.

## 6.2 Conversation continuously improves artifacts

The user should not need to manually draft all artifacts from scratch.
Instead:

1. user states intent in conversation
2. planner records the user's requirement wording as faithfully as possible
3. planner explores and asks questions
4. planner updates artifacts under `specs/<date>_<plan-title>/`
5. user refines, adjusts, or overturns earlier ideas
6. planner records those requirement revisions explicitly rather than silently overwriting history
7. planner tightens artifacts again
8. eventually artifacts become execution-ready

This makes the planner an active collaborator, not just a document generator.

### Requirement history rule

Planner artifacts must preserve a reader-auditable requirement history:

- the original user request wording should be retained as close to verbatim as practical
- later requirement changes should be appended as revisions, not silently merged away
- the final effective requirement set should be explicit
- a future reviewer should be able to reconstruct how the request evolved without rereading the full chat transcript

## 6.3 Stop gates are explicit runtime constraints

Artifacts must preserve runtime control information:

- approval gates
- decision gates
- blocker conditions
- validation requirements

This is necessary for safe autonomous execution.

---

## 7. Recommended Artifact Production Order

OpenSpec's sequencing is worth borrowing conceptually, but not rigidly.

Recommended dependency order:

1. **proposal**
2. **spec**
3. **design**
4. **tasks**
5. **handoff**

But the process remains iterative, not waterfall.

### Interpretation

- proposal establishes intent and scope
- spec defines what should change
- design defines how we expect to change it
- tasks define the execution steps
- handoff packages it for build/autorunner

The planner may revisit any earlier artifact as understanding improves.

---

## 8. Suggested Minimum Template Rules

## proposal.md

Must include:

- intent
- scope
- non-goals
- constraints
- original user requirement wording (near-verbatim when practical)
- requirement revision history / change log

## spec.md

Must include:

- requirements
- scenarios
- acceptance checks

## design.md

Must include:

- context
- goals / non-goals
- decisions
- risks / trade-offs
- critical files

## tasks.md

Must include:

- ordered execution groups
- checkable tasks
- validation tasks
- dependency-aware steps

## handoff.md

Must include:

- what executor must read first
- expected runtime todo seed
- stop gates still in force
- definition of execution-ready
- post-implementation retrospective / validation checklist expectations

---

## 9. Runtime Integration Plan

## Phase A — planner base migration

Move the planner's artifact home from ad hoc plan paths toward repo-local `specs/<date>_<plan-title>/...`.

## Phase B — planner writes artifact set, not one file

Initially this may still be bootstrapped from one template, but it should evolve into a multi-artifact structure.

## Phase C — tasks artifact becomes runtime todo source

Build/autorunner should materialize `tasks.md` (or equivalent execution section) into runtime todo graph.

### Phase C1 — todo alignment rule

After todo materialization:

- sidebar/runtime todo becomes the visible execution ledger
- follow-up execution should update and report against those same items
- assistants should not replace the visible todo list with a private parallel checklist
- if internal work tracking is temporarily needed, it must be reconciled back into planner-derived runtime todo before asking the user for decisions

## Phase D — spec completeness gate

Before leaving plan mode, planner should validate required sections and ask follow-up questions when artifacts are incomplete.

## Phase E — verify and archive loop

Later, implementation should be checked against:

- proposal (including original user wording + revision history + effective requirement description)
- spec
- design
- tasks

and then synced into long-term project knowledge.

### Phase E1 — post-implementation retrospective

Completion should include a structured retrospective artifact section that answers:

- what the user originally asked for
- how the requirement changed over time
- what the final effective requirement description was
- what was ultimately implemented
- which requirements were fully satisfied
- which requirements were partially satisfied
- which requirements were deferred / not implemented
- whether a follow-up plan is actually needed

### Phase E2 — validation checklist generation

The assistant should generate a validation checklist from:

1. planner `tasks.md`
2. runtime todo / completion states
3. actual implementation results
4. executed validations / test outcomes

Important:

- this checklist should be derived and auditable
- it should not expose raw internal chain-of-thought
- it should present concise requirement coverage, gaps, evidence, and next actions

---

## 10. First Concrete Implementation Slice

The first practical migration should remain conservative:

1. keep the current planner runtime behavior
2. change the planner storage base to `repo/specs`
3. preserve implementation-spec prompts and completeness metadata
4. prepare for future split into proposal/spec/design/tasks/handoff files

This lets us migrate the substrate without breaking the planner experience.

---

## 11. Success Criteria

This methodology is successful when:

1. planner artifacts live under `repo/specs`
2. the user feels AI is continuously improving the spec during conversation
3. planner output is clearly separated into what/how/tasks layers
4. runtime can hand off from planning artifacts into execution without re-deriving intent from chat
5. humans can focus on functional thinking while AI maintains execution-grade rigor

---

## 12. Immediate Next Steps

1. migrate planner base path into `specs/<date>_<plan-title>/`
2. keep the current structured template while changing storage location
3. then split the current single implementation-spec into:
   - proposal.md
   - spec.md
   - design.md
   - tasks.md
   - handoff.md
4. finally add plan review/completeness gating before `plan_exit`
