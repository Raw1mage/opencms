# Event: web-dev branch realign and picker RCA fixes

Date: 2026-02-23
Status: In Progress

## Context

- Confirmed all web-related work must be done in `/home/betaman/projects/opencode-web` on `web-dev`.
- Previous round mistakenly inspected `/home/pkcs12/projects/opencode` (`cms` branch).
- Re-aligned execution context to `opencode-web:web-dev` before further edits.

## RCA checkpoints

1. **Directory browser request shape bug**
   - Symptom: navigation intermittently stuck or behaved like pseudo-chroot.
   - Cause: web dialog sent `file.list({ directory: "/", path: target })`; `directory` is a server instance override query key and can change request scope unexpectedly.
   - Fix: send only `file.list({ path: target })`.

2. **Path normalization bug**
   - Symptom: some paths were only partially normalized.
   - Cause: `replace(/\/+/, "/")` only replaces first slash run.
   - Fix: changed to global regex `replace(/\/+/g, "/")`.

3. **Model activity semantics drift**
   - Symptom: chooser mixed `visible`/`favorite`/`enabled` semantics.
   - Cause: curated mode and row state were not consistently using explicit user-enabled state.
   - Fix:
     - Row state switched to `enabled`.
     - Curated provider/model counts derive from enabled models.
     - Provider list now derives from normalized provider family universe + account families, with `google` legacy alias excluded.
     - Removed selection hard-block on disabled rows (selection can re-enable via existing set flow), while still blocking unavailable/cooldown cases.

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `bun x tsc --noEmit --project packages/opencode/tsconfig.json` ⚠️ baseline-known antigravity legacy errors only:
  - `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts`
  - (`vitest` type + implicit any), unrelated to this change set.

## Next

- User verify on target runtime (`crm.sob.com.tw`) that:
  - provider list reflects expected families in 精選/全部,
  - directory browser supports `/`, `..`, and arbitrary absolute navigation.
