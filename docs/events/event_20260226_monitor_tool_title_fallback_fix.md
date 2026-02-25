# Event: monitor tool/subagent title fallback fix

Date: 2026-02-26
Status: In Progress

## Round goal

Fix sidebar monitor rows so active tool/subagent entries prefer task/tool-specific labels instead of repeatedly falling back to the main session title.

## Decision & rationale

- Decision: **Port (rewrite-only local fix)**
- Rationale:
  - High UX value: users should see actionable activity context in `[T]` / `[SA]` rows.
  - Low architecture risk: confined to monitor title derivation logic in session monitor aggregation.

## File scope

- `packages/opencode/src/session/monitor.ts`
  - Added `resolveToolTitle(part)` helper.
  - Prefer running tool title, then inferred input fields (`description`, `title`, `command`).
  - For inferred non-task labels (`title` / `command`), prefix with tool name (`<tool>: ...`) for consistent monitor readability.
  - Use inferred titles for tool rows and agent/session active tool context.
  - Improved fallback from session title to tool name for tool-level rows.

## Validation

- `bun run packages/opencode/src/index.ts admin --help` ✅
- `bun run typecheck` (in `packages/opencode`) ⚠️ known baseline noise only:
  - `src/plugin/antigravity/plugin/storage.legacy.ts` (`vitest` module / implicit any)
  - Not touched in this round; treated as non-blocking per current project baseline rule.

## Architecture gate

- No architecture boundary/semantic change introduced.
- `docs/ARCHITECTURE.md` update not required for this code-only monitor derivation fix.
