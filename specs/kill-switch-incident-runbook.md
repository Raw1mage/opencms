# Kill-switch Incident Runbook (Phase-1)

Status: Active  
Last Updated: 2026-03-16

## Scope

Operational response for incidents requiring kill-switch actions via runtime API (`/api/v2/admin/kill-switch/*`).

## Preconditions

1. Operator has authenticated session (when web auth enabled).
2. Global permission allows capability `kill_switch.trigger`.
3. MFA flow is available to operator.

## Standard Response Flow

1. **Assess severity**
   - Confirm runaway behavior / unsafe automation / cross-session blast radius.

2. **Trigger kill-switch**
   - Call trigger endpoint with clear reason.
   - If challenge returned (`202`), complete MFA with returned `request_id`.

3. **Validate activation**
   - Query status endpoint.
   - Confirm `active=true` and `state=soft_paused`.

4. **Verify scheduling block**
   - Confirm new session message/prompt_async requests return `409 KILL_SWITCH_ACTIVE`.

5. **Monitor fallback path**
   - Check for ACK rejected/timeout cases.
   - Confirm force-kill fallback and audit evidence for affected sessions.

6. **Recovery / cancel**
   - After incident stabilization and operator approval, call cancel endpoint.
   - Re-validate status inactive and scheduling restored.

## Triage Matrix

- `401 auth_required`: missing operator auth context.
- `403 operator_mismatch`: request user does not match configured operator.
- `403 capability_denied`: `kill_switch.trigger` not explicitly allowed.
- `401 mfa_invalid`: invalid/expired MFA code.
- `429 cooldown_active`: repeated operator action inside cooldown window.
- `502 worker_ack_rejected` / `504 worker_ack_timeout`: worker control failure; fallback force-kill should execute.

## Evidence Collection Checklist

- [ ] `request_id`
- [ ] trigger/cancel timestamps
- [ ] affected session IDs
- [ ] ACK failure records (if any)
- [ ] force-kill fallback records (if any)
- [ ] snapshot URL or snapshot failure audit

## Post-incident Validation

- [ ] status endpoint reports inactive after recovery
- [ ] new scheduling endpoints no longer blocked
- [ ] audits complete for trigger/challenge/verify/fallback/cancel
- [ ] open follow-up tasks for root-cause and preventive controls

---

## Postmortem Template

### 1. Incident Summary

- Incident ID:
- Date/Time:
- Reporter:
- Severity:
- Trigger reason:

### 2. Timeline (UTC)

- T0:
- T1:
- T2:
- T3:

### 3. Kill-switch Execution Details

- request_id:
- initiator:
- mode/scope:
- MFA result:
- state transition:

### 4. Impact

- Sessions impacted:
- User-facing impact:
- Duration:

### 5. Control/Fallback Outcomes

- ACK accepted count:
- ACK rejected count:
- ACK timeout count:
- force-kill count:

### 6. Snapshot & Audit

- snapshot_url (or failure reason):
- audit completeness check:

### 7. Root Cause

- Primary cause:
- Contributing factors:

### 8. Corrective Actions

- Immediate fixes:
- Long-term actions:
- Owner + due dates:

### 9. Verification

- Tests/commands executed:
- Validation results:
