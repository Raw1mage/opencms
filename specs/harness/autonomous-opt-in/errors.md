# Errors

## Error Catalogue

All error codes introduced or surfaced by autonomous-opt-in. Every entry names the code, user-visible message, recovery strategy, and responsible layer. Errors MUST be logged with `log.warn` or `log.error` (never silent per AGENTS.md 第一條) and, where appropriate, emit a Bus event so the UI can surface them.

### AUTORUN_ARM_REFUSED_NO_BINDING

- **Layer**: arm-intent-detector (C3)
- **Trigger**: R3a verbal match or R3b question-yes fires but no `SessionActiveSpec` binding exists
- **User-visible message**: `Autorun not armed: this session is not bound to any plan. Run "bun plan-promote specs/<slug> --to planned --session $SESSION" first.`
- **Recovery**: user invokes plan-promote with --session flag; re-attempt trigger
- **Bus event**: `autorun.arm_refused` with `reason: "no_binding"`

### AUTORUN_ARM_REFUSED_WRONG_STATE

- **Layer**: arm-intent-detector (C3)
- **Trigger**: binding exists but bound spec's `.state.json.state` is outside `{planned, implementing}`
- **User-visible message**: `Autorun not armed: spec "<slug>" is in state "<state>", must be planned or implementing. Promote the plan first.`
- **Recovery**: user runs `plan-promote` to advance the spec state
- **Bus event**: `autorun.arm_refused` with `reason: "wrong_state:<state>"`

### AUTORUN_ARM_REFUSED_EMPTY_TODOS

- **Layer**: arm-intent-detector (C3)
- **Trigger**: R1+R2 checks — binding + state OK but `Todo.nextActionableTodo` returns null
- **User-visible message**: `Autorun not armed: todolist is empty. Materialize phase 1 tasks via "plan-promote --to implementing" or add tasks manually.`
- **Recovery**: promote to implementing (which triggers phase-1 materialization) or use TodoWrite directly
- **Bus event**: `autorun.arm_refused` with `reason: "empty_todos"`

### AUTORUN_BINDING_STALE

- **Layer**: autorun-gate (C2)
- **Trigger**: runtime reads binding → bound spec folder or `.state.json` missing on disk (spec deleted or renamed while bound)
- **User-visible message**: `Autorun paused: bound spec "<slug>" no longer exists. Rebind via plan-promote or archive the session binding.`
- **Recovery**: auto-disarm; user rebinds or clears binding
- **Bus event**: `autorun.disarmed` with `reason: "binding_stale"`

### AUTORUN_REFILL_PARSE_ERROR

- **Layer**: todolist-refill (C7)
- **Trigger**: refill attempts to parse bound spec's `tasks.md` but structure is malformed (no `## N.` headings, or file missing)
- **User-visible message**: `Autorun paused: cannot parse tasks.md for spec "<slug>". Run "plan-validate" to diagnose.`
- **Recovery**: auto-disarm; user fixes tasks.md or runs plan-validate
- **Bus event**: `autorun.disarmed` with `reason: "refill_parse_error"`
- **Note**: plan-validate on `planned` state should catch malformed tasks.md before promote, so this path is a safety net

### AUTORUN_QUESTION_TOOL_UNAVAILABLE

- **Layer**: plan-promote-script (C9)
- **Trigger**: plan-promote tries to invoke MCP question tool but it's not registered in the current skill layer
- **User-visible message**: `plan-promote: MCP question tool not available. State promoted; arm manually by typing a trigger phrase (see tweaks.cfg autorun.trigger_phrases).`
- **Recovery**: script completes state promotion and writes binding but skips arming question; user arms via R3a verbal trigger instead
- **Bus event**: none (script-level log only)

### AUTORUN_R6_DEMOTE_FAILED

- **Layer**: r6-demote-helper (C11)
- **Trigger**: write script attempts R6 pre-check but `.state.json` write fails (disk full, permissions, concurrent write)
- **User-visible message**: `R6 demote failed for spec "<slug>": <error>. Halting write script to avoid inconsistent state.`
- **Recovery**: script aborts; user inspects disk / permissions; manual state fix if needed
- **Bus event**: `autorun.demote_by_edit` with `reason: "failed:<error>"`
- **Note**: the write script MUST NOT proceed with its own mutation if R6 demote fails — inconsistent state is worse than a hard stop

### AUTORUN_TRIGGER_CONFIG_INVALID

- **Layer**: tweaks-cfg-reader (C6)
- **Trigger**: `autorun.trigger_phrases` value is not an array of strings (misconfigured)
- **User-visible message**: `tweaks.cfg: autorun.trigger_phrases must be an array of strings. Falling back to built-in defaults.`
- **Recovery**: loader uses DD-8 default seed list; logs the fallback
- **Bus event**: none
- **Note**: this is an explicit fallback with an explicit log — NOT a silent fallback, per AGENTS.md 第一條
