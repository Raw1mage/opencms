# Tasks

## 0. Planner Refinement
- [x] 0.1 Lock the current JWT issuance reality versus the target claim contract (current evidence: `sub` + `exp`; target still needs explicit uid strategy)
- [x] 0.2 Decide and document the single `--attach` behavior contract across plan/spec/architecture/event (explicit auto-spawn)
- [x] 0.3 Rewrite artifacts to distinguish prototype-landed behavior from verified hardening targets
- [x] 0.4 Freeze the runtime verification matrix before code work begins

## 1. Gateway Identity Hardening
- [ ] 1.1 Implement explicit JWT decode and claim validation in `daemon/opencode-gateway.c`
- [ ] 1.2 Replace demo first-daemon routing with verified-identity daemon lookup
- [ ] 1.3 Make unauthorized / malformed / expired token paths fail fast without fallback

## 2. Gateway Lifecycle Hardening
- [ ] 2.1 Harden adopt-from-discovery failure handling and stale state cleanup
- [ ] 2.2 Make spawn / readiness timeout / child-exit paths explicit and observable
- [ ] 2.3 Verify registry/discovery behavior remains bounded under repeated requests

## 3. Verification Matrix
- [ ] 3.1 Compile the gateway with the documented gcc command
- [ ] 3.2 Run single-user authenticated forwarding verification
- [ ] 3.3 Run SSE and WebSocket forwarding verification or record explicit deferred evidence
- [ ] 3.4 Run multi-user isolation verification or record explicit deferred evidence

## 4. Documentation Sync
- [ ] 4.1 Update `docs/events/event_20260319_daemonization.md` with hardening decisions and evidence
- [ ] 4.2 Update `specs/architecture.md` to reflect the final daemon hardening contract
- [ ] 4.3 Mark completed checklist items immediately during build execution
