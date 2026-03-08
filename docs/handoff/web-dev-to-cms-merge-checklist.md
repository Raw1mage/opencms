# Web-dev → cms Merge Checklist

Date: 2026-02-27
Owner: web unification stream
Status: Active

## 0) Scope Lock (before code freeze)

- [ ] Confirm merge scope is only web-dev feature/fix set (no unrelated refactors).
- [ ] Confirm runtime/local artifacts are excluded (`/tmp`, user XDG state, local pid/log outputs).
- [ ] Confirm target branch is `cms` and no direct merge from external refs.

## 1) Runtime Isolation Guard (during web debugging only)

- [ ] Run web debug with isolated identity:

```bash
HOME=/home/betaman \
XDG_CONFIG_HOME=/home/betaman/.config \
XDG_STATE_HOME=/home/betaman/.local/state \
XDG_DATA_HOME=/home/betaman/.local/share \
OPENCODE_PROFILE=betaman-web \
./webctl.sh restart
```

- [ ] Verify `webctl.sh status` prints expected HOME/XDG/profile.
- [ ] Ensure no pkcs12 runtime files are touched during debug session.

## 2) Functional Parity Validation (TUI as canonical)

- [ ] Model selector parity pass:
  - [ ] provider/account/model rendering
  - [ ] showall/favorites behavior
  - [ ] hide/favorite state invariants
- [ ] Slash commands parity pass:
  - [ ] source merge rule (builtin/custom)
  - [ ] visibility/exclusion parity
  - [ ] naming and dedupe parity
- [ ] `/session` parity pass:
  - [ ] list mode behavior
  - [ ] grouping/sorting rule parity

## 3) Build & Type Safety Gate

- [ ] `bun x tsc --noEmit --project packages/app/tsconfig.json`
- [ ] `./webctl.sh build-frontend`
- [ ] `./webctl.sh restart && ./webctl.sh status`

> Note: historical baseline exception has been removed; use normal blocking validation rules.

## 4) Git Hygiene (before PR)

- [ ] Remove accidental local/runtime files from commit.
- [ ] Confirm diff contains only intended web-dev changes.
- [ ] Confirm commit messages explain **why** (not only what).

## 5) Documentation & Event Ledger

- [ ] Update/append relevant docs in `docs/specs/` if behavior contract changed.
- [ ] Add event entry in `docs/events/` with:
  - [ ] decision
  - [ ] scope
  - [ ] risk
  - [ ] validation result

## 6) Merge Execution to cms

- [ ] Rebase/sync web-dev against latest `cms`.
- [ ] Resolve conflicts by preserving cms canonical architecture decisions.
- [ ] Open PR to `cms` with parity summary and validation evidence.
- [ ] After merge, run a smoke check in cms runtime.

## 7) Post-merge Regression Watch

- [ ] Validate model selector, slash dropdown, session list in cms UI.
- [ ] Watch for session-management regressions (`new/list/fork` behavior).
- [ ] Record any follow-up fixes as separate event + patch round.
