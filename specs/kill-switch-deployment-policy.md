# Kill-switch Deployment Policy (Phase-1)

Status: Active  
Last Updated: 2026-03-16

## Purpose

Define production deployment requirements for kill-switch runtime control under `packages/opencode/src/server/**`, with explicit security gates and fail-fast behavior.

## Mandatory Security Baseline

1. **Auth-bound operator required**
   - When web auth is enabled, kill-switch operations require a valid request user.
   - Missing request user must return `401 auth_required`.

2. **Capability gate required**
   - Capability key: `kill_switch.trigger`
   - Policy: **deny-by-default**
   - Any non-allow decision (`ask`/`deny`) must return `403 capability_denied`.

3. **MFA required for trigger path**
   - Trigger without `mfaCode` must return challenge (`202`).
   - Invalid code must return `401 mfa_invalid`.

## Required Config Contract

Global permission config must explicitly allow kill-switch in authorized environments:

`permission.kill_switch.trigger = "allow"`

Equivalent JSONC form:

`"permission": { "kill_switch.trigger": "allow" }`

If this key is omitted, deployment is expected to deny kill-switch operations.

## API Surface Covered by This Policy

- `GET /api/v2/admin/kill-switch/status`
- `POST /api/v2/admin/kill-switch/trigger`
- `POST /api/v2/admin/kill-switch/cancel`
- `POST /api/v2/admin/kill-switch/tasks/:sessionID/control`

## Runtime Safety Requirements

1. Trigger must set active state (`soft_paused`) and block new scheduling.
2. Scheduling endpoints must return `409 KILL_SWITCH_ACTIVE` while active.
3. ACK rejected/error/timeout must execute fallback force-kill path.
4. Audit trail must include trigger/cancel/challenge/failure/fallback events with `request_id`.

## Rollout Checklist

- [ ] Global config includes `kill_switch.trigger=allow` in intended operator environment.
- [ ] Web auth/operator identity path is enabled and validated.
- [ ] Trigger challenge and verify paths tested in staging.
- [ ] Scheduling gate (`409`) verified in staging.
- [ ] ACK failure fallback verified in staging.
- [ ] Audit entries visible for trigger/cancel/fallback.

## Verification Commands

- `bun test packages/opencode/src/server/routes/killswitch.test.ts packages/opencode/src/server/routes/session.killswitch-gate.test.ts packages/opencode/src/server/killswitch/service.test.ts`
- `bun run typecheck` (workdir: `packages/opencode`)

## Prohibited Deploy Patterns

- Do not reintroduce header-based role gates (e.g., `x-user-role`) as authority source.
- Do not add silent fallback when capability/auth gate denies operation.
- Do not default capability to allow.
