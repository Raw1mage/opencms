# Kill-Switch Security Audit Checklist

Task 4.1 要求安全團隊 review 並 sign-off 後方可啟用 production API。
本文件列出所有需審查的安全面向，供 security reviewer 逐項確認。

---

## 1. Authentication & Authorization

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Trigger/Cancel/Control endpoints require authenticated user when WebAuth enabled | [ ] | `assertKillSwitchOperator()` in `routes/killswitch.ts:38-73` |
| 1.2 | Unauthenticated requests return 401 | [ ] | Test: "returns 401 when operator auth is enabled but request user missing" |
| 1.3 | Operator mismatch returns 403 | [ ] | Test: "returns 403 when request user does not match configured operator" |
| 1.4 | RBAC capability `kill_switch.trigger` evaluated via `PermissionNext.evaluate()` | [ ] | `routes/killswitch.ts:58` |
| 1.5 | Capability denial returns 403 with audit-friendly payload | [ ] | Test: "returns 403 when capability kill_switch.trigger is not allowed" |
| 1.6 | `/status` endpoint is read-only, no auth required (intentional for monitoring) | [ ] | Review: acceptable for status polling? |

## 2. MFA Challenge

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 2.1 | Trigger without `mfaCode` returns 202 + MFA challenge (not 200) | [ ] | Test: "requires MFA challenge on trigger without mfaCode" |
| 2.2 | MFA code is 6-digit, stored with TTL (default 5 min) | [ ] | `service.ts:generateMfa()` |
| 2.3 | MFA verification is one-time-use (token deleted after success) | [ ] | `service.ts:verifyMfa()` — `Storage.remove()` after match |
| 2.4 | MFA initiator binding: code only valid for same initiator | [ ] | `service.ts:verifyMfa()` — `token.initiator !== initiator` check |
| 2.5 | MFA expiry enforced: expired tokens rejected | [ ] | `service.ts:verifyMfa()` — `Date.now() > token.expiresAt` check |
| 2.6 | `dev_code` only returned when `NODE_ENV !== "production"` or `OPENCODE_DEV_MFA=true` | [ ] | `routes/killswitch.ts:182-183` |
| 2.7 | Failed MFA attempt audited with `kill_switch.mfa_failed` | [ ] | `routes/killswitch.ts:197-204` |

## 3. Rate Limiting

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 3.1 | Cooldown enforced per-initiator (default 5s window) | [ ] | `service.ts:checkCooldown()`, `routes/killswitch.ts:enforceCooldown()` |
| 3.2 | Cooldown violation returns 429 with `remainingMs` | [ ] | `routes/killswitch.ts:78` |
| 3.3 | Idempotent request ID prevents duplicate triggers within window (10s) | [ ] | `service.ts:idempotentRequestID()` |

## 4. Input Validation

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 4.1 | All POST bodies validated via Zod schema + `hono-openapi` validator | [ ] | `TriggerInput`, `ControlInput` schemas |
| 4.2 | `reason` field requires non-empty string (`z.string().min(1)`) | [ ] | `TriggerInput` definition |
| 4.3 | `action` field constrained to enum: pause/resume/cancel/snapshot/set_priority | [ ] | `ControlAction` schema |
| 4.4 | `sessionID` param validated against `Session.get.schema` | [ ] | `routes/killswitch.ts:334` |

## 5. State Integrity

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 5.1 | State transitions: only `soft_paused` and `inactive` allowed | [ ] | `State.state` enum in `service.ts:18` |
| 5.2 | Control message seq monotonically increasing; stale seq rejected | [ ] | `handleControl()` — `input.seq <= last` check |
| 5.3 | Force-kill fallback on ACK timeout/rejection (no silent hang) | [ ] | `routes/killswitch.ts:252-259` |
| 5.4 | Scheduling gate blocks new sessions when kill-switch active | [ ] | `assertSchedulingAllowed()` + session route integration |

## 6. Audit Trail

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 6.1 | All trigger/cancel/control/MFA events produce audit entries | [ ] | `writeAudit()` calls throughout routes |
| 6.2 | Audit entries contain: requestID, initiator, action, permission, result, timestamp | [ ] | `writeAudit()` signature |
| 6.3 | Partial trigger (some sessions force-killed) audited with failure details | [ ] | `routes/killswitch.ts:262-271` |
| 6.4 | Snapshot failure audited but does not block kill path | [ ] | `createSnapshotPlaceholder()` catch block |

## 7. Transport & Snapshot Security

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 7.1 | Redis transport: env-gated, fails fast without `OPENCODE_REDIS_URL` | [ ] | `createRedisControlTransport()` |
| 7.2 | MinIO/S3 snapshot: env-gated, fails fast without required creds | [ ] | `createMinioSnapshotBackend()` |
| 7.3 | aws4fetch signs requests (no plaintext credential in URL) | [ ] | `AwsClient` usage pattern |
| 7.4 | Redis channels scoped to request/session (no wildcard subscribe) | [ ] | Channel format: `ks:control:{sessionID}`, `ks:ack:{requestID}:{seq}` |
| 7.5 | Snapshot content is JSON (no executable code) | [ ] | `JSON.stringify(snapshot)` only |

## 8. Error Handling

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 8.1 | Config errors (unknown transport/backend mode) throw immediately | [ ] | `resolveControlTransport()`, `resolveSnapshotBackend()` |
| 8.2 | Runtime errors do not leak stack traces to API response | [ ] | HTTP responses use structured error objects |
| 8.3 | ACK timeout returns 504 (not 500) | [ ] | `routes/killswitch.ts:370-380` |
| 8.4 | Worker ACK rejection returns 502 (not 500) | [ ] | `routes/killswitch.ts:362-365` |

---

## Sign-off

| Reviewer | Date | Decision |
|----------|------|----------|
| | | APPROVED / REJECTED / CONDITIONAL |

**Notes:**
- All `[ ]` items must be `[x]` before production API enablement
- Any REJECTED item must have a remediation plan with ETA
- CONDITIONAL approval requires explicit scope limits documented here
