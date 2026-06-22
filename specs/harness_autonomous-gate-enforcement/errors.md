# Errors: harness_autonomous-gate-enforcement

## Error Catalogue

| Condition | Old behavior (defect) | New behavior |
|---|---|---|
| Actionable todo in `requireApprovalFor` | Advisory flag only; model resumed and dithered | Deterministic suspend → `waiting_user` + `stopReason=approval_required:<kind>` |
| Model wants to pause for sign-off | No primitive; only barge-through or voluntary stop | Sets todo `status=awaiting_approval` → same suspend path |
| Doc todo text contains "architecture"/"refactor" | Falsely stamped `architecture_change`/`needsApproval` | No action kind inferred; not gated |
| Gate-induced non-progress | Counted as paralysis → nudge → `ParalysisDetectedError` halt | Exempted from the paralysis ladder; clean suspend stands |
| Genuine no-gate identical-call spin | Detected and halted (correct) | Unchanged — still halts (backstop preserved) |
| Step already blocked by tool-permission gate | n/a | Idempotent — policy gate does not double-suspend |

## Notes

- `approval_required:<kind>` joins `NON_RESUMABLE_WAITING_REASONS` — the loop must
  not auto-resume a gate-suspended session; only a user approval clears it.
- `ParalysisDetectedError` remains the terminal signal for true no-progress spin;
  this change narrows WHEN it fires, it does not remove it.
- No new error transport is introduced — the approval prompt reuses the existing
  question/permission surface.
