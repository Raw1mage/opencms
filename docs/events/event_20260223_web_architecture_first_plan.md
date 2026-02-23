# Event: Web architecture-first stabilization plan

Date: 2026-02-23
Status: In Progress

## 1) Why this event exists

User direction changed from “continue patching Web issues ad-hoc” to **architecture-first** progression:

- Web must become usable online first.
- TUI/core behavior must stay stable and non-regressive.
- Web runtime operations should stay isolated (betaman runtime paths).

This event defines the stabilization order before deeper feature additions.

## 2) Current architecture findings (from code + runtime errors)

### A. Auth boundary is now dual-mode by design

- Browser Web path: cookie session + CSRF (`WebAuth` middleware).
- Compatibility path: Basic auth still accepted for TUI/CLI traffic.
- Risk: mixed client contexts (cookie vs basic) can produce inconsistent auth expectations in manual tests.

### B. Workspace boundary is strict by design

- `packages/opencode/src/file/index.ts` enforces root confinement and throws:
  - `Access denied: path escapes project directory`
- This is correct for security, but currently surfaces as runtime failure without enough user-facing guidance in Web.

### C. PTY boundary requires create→connect contract

- `packages/opencode/src/server/routes/pty.ts` requires existing PTY ID before websocket connect.
- Error signature:
  - `Session not found`
- Likely trigger: stale local PTY state / reconnect against removed PTY.

### D. Admin parity gap is structural, not cosmetic

- Web currently has “admin-lite” (status popover + settings accounts).
- TUI `/admin` includes richer model/provider/account workflows:
  - provider toggles and add flows,
  - account management depth,
  - model activity matrix,
  - quota/cooldown/rate-limit-driven switching logic.

Conclusion: full parity requires phased capability porting, not tab-level UI cloning.

## 3) TUI → Web parity matrix (architecture slices)

| Capability slice                               | TUI `/admin` | Web now                | Gap type             | Plan                                             |
| :--------------------------------------------- | :----------- | :--------------------- | :------------------- | :----------------------------------------------- |
| Account list + set active                      | ✅           | ✅                     | UX depth             | Keep, polish labels/status                       |
| Rotation recommendation visibility             | ✅           | ⚠️ partial (read-only) | missing context      | Add reason + cooldown linkage                    |
| Provider manage (enable/disable/add)           | ✅           | ⚠️ partial             | missing mutate flows | Add dedicated Web admin provider section         |
| Model activity matrix (provider/account/model) | ✅           | ❌                     | missing data surface | Port activity table contract first, then actions |
| Rate-limit/cooldown guided switching           | ✅           | ❌                     | missing decision UX  | Introduce guided fallback switch flow            |

## 4) Execution order (no big-bang rewrite)

### Phase 0 — Runtime stabilization guardrails (now)

1. Keep Web runtime under betaman paths only.
2. Keep TUI/runtime baseline untouched unless explicitly required.
3. Keep bug logging in `event_20260223_web_runtime_bug_backlog.md`.

### Phase 1 — Path + PTY reliability

1. Add explicit diagnostics for workspace-boundary denial in Web UX.
2. Harden PTY reconnect logic:
   - stale PTY ID detection,
   - recreate-on-miss recovery,
   - clearer session/terminal error messaging.

### Phase 2 — Provider/account control parity

1. Port provider manage actions to Web (enable/disable/add path).
2. Keep mutations in controlled settings/admin section (not popover).

### Phase 3 — Model activity + guided switching parity

1. Port model activity matrix (provider/account/model + cooldown/quota summary).
2. Add guided fallback switch UX aligned with rotation recommendations.

## 5) Non-goals for this round

- No direct merge of upstream `origin/dev` for Web parity.
- No one-shot frontend rewrite of TUI `/admin`.
- No broad security relaxation for workspace root constraints.

## 6) Validation baseline

- Continue using repo baseline policy for known antigravity typecheck noise when untouched.
- For each phase, record:
  - changed files,
  - reproducible symptom before/after,
  - command-level verification.

## 7) Next implementation target

Start with **Phase 1 (path + PTY reliability)** because it directly impacts “Web can operate online” before parity UX expansion.

## 8) Phase 1 progress update (this round)

- Implemented stale-PTY hydration pruning in:
  - `packages/app/src/context/terminal.tsx`
- Mechanism:
  - one-time post-hydration validation of persisted PTY IDs via `sdk.client.pty.get`.
  - missing PTY IDs are removed from local terminal state (`removeExited`) to avoid dead reconnect paths.
- Validation:
  - `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅

Remaining Phase 1 item:

- add explicit workspace-boundary denial diagnostics in Web UX for `path escapes project directory` responses.

Update (completed in follow-up):

- Added boundary-aware Web diagnostics helper:
  - `packages/app/src/utils/api-error.ts`
- Integrated helper into key user-facing paths:
  - `packages/app/src/context/file.tsx`
  - `packages/app/src/components/prompt-input/submit.ts`
  - `packages/app/src/pages/layout/helpers.ts`

Phase 1 status:

- PTY stale-session resilience: ✅
- workspace-boundary denial diagnostics: ✅
- terminal websocket binary payload rendering: ✅

## 9) Phase 2 progress update (provider/account control parity)

- Implemented provider enable/disable controls in Web Settings providers page.
- Added a dedicated Disabled providers section with one-click re-enable.
- Added auto re-enable on connect attempt for providers that were previously disabled.
- Kept mutating provider controls in settings scope (not status popover), matching the architecture plan boundary.

Changed files:

- `packages/app/src/components/settings-providers.tsx`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`
- `packages/app/src/i18n/zht.ts`

Validation:

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅

## 10) Phase 3 slice progress update (read-only recommendation surface)

- Added rotation recommendation panel in Web `Settings > Models`.
- This lands a read-only slice of model-routing visibility before deeper model-activity parity.

Changed files:

- `packages/app/src/components/settings-models.tsx`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`
- `packages/app/src/i18n/zht.ts`

Validation:

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` ✅
