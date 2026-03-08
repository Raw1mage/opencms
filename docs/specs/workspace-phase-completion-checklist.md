# Workspace Phase Completion Checklist

Date: 2026-03-09
Status: Active Review

## Phase 1 — Kernel / Identity / Runtime Contract

- [x] Workspace aggregate schema/types established
- [x] Directory → workspace resolution established
- [x] Shared identity helper established across app/runtime
- [x] In-memory workspace registry established
- [x] Workspace service façade established
- [x] Lifecycle states established
- [x] Session / PTY / worker attachments established
- [x] Workspace API boundary established
- [x] Workspace aggregate bus events established

### Phase 1 Exit Assessment

**Status:** Complete

Reason:

- workspace kernel is no longer speculative
- app/runtime share the same identity rules
- runtime has authoritative workspace aggregate + lifecycle + event surface

---

## Phase 2 — App Consumption / Sync

- [x] App bootstrap consumes runtime workspace aggregate
- [x] App child store preserves runtime workspace lifecycle state
- [x] Layout busy gating consumes runtime lifecycle state
- [x] App reducer consumes live `workspace.*` events
- [x] Initial app consumer ownership migration completed for terminal/prompt/comments/file-view

### Phase 2 Exit Assessment

**Status:** Complete

Reason:

- app is no longer relying only on local directory inference
- runtime workspace aggregate is now the primary source for live workspace state

---

## Phase 3 — Runtime-Owned Operations / App Orchestration Reduction

- [x] Reset operation moved behind runtime contract
- [x] Delete operation moved behind runtime contract
- [x] Layout retains only UI/local side effects (toast/navigation/local terminal cleanup)
- [x] Dead lifecycle transition helper removed from layout
- [x] Unused app `workspace_status` child-store field removed

### Phase 3 Exit Assessment

**Status:** Substantially Complete

Remaining notes:

- some project/workspace-order UI mutations still remain app-local by design
- rename/order UX is still app-owned and not part of runtime workspace domain

---

## Deferred Track — Preview Runtime Domain

- [x] Gap documented
- [x] Reserved-field policy documented (`previewIds`)
- [ ] Real preview runtime SSOT exists
- [ ] Preview registry/events exist
- [ ] Preview attachment integration exists

### Deferred Track Assessment

**Status:** Intentionally Deferred

Reason:

- no real preview runtime domain exists yet
- implementing preview attachment now would be guesswork

---

## Recommended Next Planning Decision

Choose one:

1. **Stop Phase 1–3 workspace rewrite stream here** and declare current runtime/app integration milestone complete.
2. **Open a new preview-domain stream** only after defining a real preview runtime/process/event model.
3. **Do a focused consumer audit** for remaining app-owned state that should stay UI-local vs move into runtime long-term.
