# Event: origin/dev refactor round (terminal + session review)

Date: 2026-02-23
Status: Done

## 1. Scope

- Source commits (origin/dev):
  - `e70d2b27d` fix(app): terminal issues
  - `46361cf35` fix(app): session review re-rendering too aggressively
- Target: `HEAD` (cms working branch)

## 2. Refactor Decisions

1. PTY stream isolation imported as behavior-equivalent refactor:
   - Keep socket reuse guard + owner tracking + identity token checks.
   - Pass websocket wrapper identity from route layer into `Pty.connect`.
   - Add regression test for wrapper-only identity token scenario.

2. Session review re-render reduction imported with cms compatibility:
   - Iterate by stable `file` keys (`files` memo + `diffs` map memo).
   - Replace broad `props.diffs` access in inner loop with keyed access (`item()`).
   - Reset image/audio state only when keyed diff source changes.

## 3. Changed Files

- `packages/opencode/src/pty/index.ts`
- `packages/opencode/src/server/routes/pty.ts`
- `packages/opencode/test/pty/pty-output-isolation.test.ts`
- `packages/ui/src/components/session-review.tsx`

## 4. Validation

- `bun run --cwd /home/pkcs12/projects/opencode/packages/ui typecheck` ✅
- `bun test /home/pkcs12/projects/opencode/packages/opencode/test/pty/pty-output-isolation.test.ts` ✅

## 5. Baseline Rule

- Per project policy, antigravity auth plugin baseline noise remains excluded from blocking checks unless antigravity plugin paths are touched.
