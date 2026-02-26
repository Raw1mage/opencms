# Event: origin/dev refactor round81 (app cleanup batch)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Classify app-layer cleanup and minor UX-fix batch outside current core runtime parity scope.

## 2) Candidate(s)

- `46739ca7cd970cf84f88c3f0cf5ca8b756b64f7d`
- `3f60a6c2a46dab1622ee4f4c99e4dfad876f3a3c`
- `ef14f64f9ee10ee7945a547bde4b13d6dcf2f0bd`
- `8408e4702e0d0eebd3a459577be3d50082c3f603`
- `72c12d59afca7092dc98842b094305d385cf7863`
- `42aa28d512d4ea77bef6159530b8bac9c7c872a0`
- `1133d87be043ab999be5002380584b21653e09c4`

## 3) Decision + rationale

- Decision: **Skipped** (all)
- Rationale:
  - App/global-sync cleanup and UI-level polish outside current runtime/session/provider parity target.
  - Deferred to dedicated app parity track.

## 4) File scope reviewed

- `packages/app/src/**`
- `packages/ui/src/i18n/**`

## 5) Validation plan / result

- Validation method: package-boundary triage.
- Result: skipped.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
