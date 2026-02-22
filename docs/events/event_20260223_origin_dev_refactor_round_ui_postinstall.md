# Event: origin/dev refactor round (share button border + postinstall cache)

Date: 2026-02-23
Status: Done

## 1. Scope

- Source commits (origin/dev):
  - `f07e87720` fix(app): remove double-border in share button
  - `1d9f05e4f` cache platform binary in postinstall for faster startup
- Target: `HEAD` (cms working branch)

## 2. Refactor Decisions

1. Share button double-border fix:
   - In `session-header`, when share URL exists, keep rounded-right removal and also remove right border (`border-r-0`) to avoid visual double border with adjacent control.

2. Postinstall binary cache:
   - Wrapper `bin/opencode` now checks `bin/.opencode` first and executes it immediately if present.
   - `script/postinstall.mjs` now materializes `bin/.opencode` from platform binary via hardlink (fallback copy), then `chmod 755`.
   - Kept current repo layout (`script/` and `bin/` at root) while preserving upstream behavior.

## 3. Changed Files

- `packages/app/src/components/session/session-header.tsx`
- `bin/opencode`
- `script/postinstall.mjs`

## 4. Validation

- `node --check /home/pkcs12/projects/opencode/bin/opencode` ✅
- `node --check /home/pkcs12/projects/opencode/script/postinstall.mjs` ✅
- `bun run --cwd /home/pkcs12/projects/opencode/packages/app typecheck` ⚠️
  - Pre-existing unrelated failure:
    - `src/context/local.tsx(94,62): Property 'split' does not exist on type 'Model'`
