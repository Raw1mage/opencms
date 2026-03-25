# Tasks

## 1. Planner Contract Rewrite
- [x] 1.1 Read the approved implementation spec and companion artifacts
- [x] 1.2 Rewrite planner/runtime contract files

## 2. Delegated Execution Slices
- [x] 2.1 Implement gateway binding lookup contract
- [x] 2.2 Define login rejection semantics for unbound Google identities
- [x] 2.3 Define global registry placement under `/etc/opencode/`
- [x] 2.4 Integrate follow-up slices using the same planner task naming

## 3. Validation
- [x] 3.1 Run targeted validation
- [x] 3.2 Confirm no fallback path is introduced
- [x] 3.3 Record validation evidence
- [x] 3.4 Verify planner artifacts contain no placeholder tokens

## 4. Documentation / Retrospective
- [x] 4.1 Sync relevant event / architecture docs
- [x] 4.2 Compare implementation against the proposal's effective requirement description
- [x] 4.3 Decide whether `gauth.json` needs a separate binding registry or stays token-only

---

## 5. Implementation: Binding Service Module (Phase 1)
- [x] 5.1 Create `packages/opencode/src/google-binding/index.ts` — binding registry CRUD with mtime cache, mutex, atomic write
- [x] 5.2 Implement `bind()` with 1:1 cardinality enforcement (email↔username bidirectional uniqueness)
- [x] 5.3 Implement `unbind()`, `lookup()`, `getByUsername()`, `list()`

## 6. Implementation: Binding API Routes (Phase 2)
- [x] 6.1 Create `packages/opencode/src/server/routes/google-binding.ts` — status/connect/callback/unbind routes
- [x] 6.2 Mount route in `packages/opencode/src/server/app.ts`
- [x] 6.3 Add `/google-binding` to `API_PREFIXES` in `packages/opencode/src/server/web-auth.ts`

## 7. Implementation: C Gateway OAuth (Phase 3)
- [x] 7.1 Add libcurl dependency and OAuth state management to `daemon/opencode-gateway.c`
- [x] 7.2 Implement `GET /auth/login/google` → Google OAuth redirect
- [x] 7.3 Implement `GET /auth/google/callback` → token exchange → userinfo → binding check → JWT or 403
- [x] 7.4 Update `daemon/login.html` with "Sign in with Google" button

## 8. Implementation: Deployment (Phase 4)
- [x] 8.1 Update `webctl.sh` compile_gateway() with `-lcurl` flag
- [x] 8.2 Add binding file initialization to install/setup flow

## 9. Validation & Docs
- [x] 9.1 Build check (bun + gcc)
- [x] 9.2 Create/update docs/events/ for this implementation session
- [x] 9.3 Sync specs/architecture.md if needed

## 10. Unification: MCP OAuth Binding Piggyback
- [x] 10.1 Add `openid email profile` to MCP OAuth scope merge (always included)
- [x] 10.2 Piggyback `GoogleBinding.bind()` in MCP OAuth callback (best-effort, non-blocking)
- [x] 10.3 Update event doc + architecture sync
