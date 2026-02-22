# Event: origin/dev refactor item - preserve root workspace URL slashes

Date: 2026-02-23
Status: Integrated (no code delta)

## Source

- `1de12604c` fix(ui): preserve url slashes for root workspace

## Analysis

- Upstream intent: avoid stripping path separators when project directory is root (`/` or `\\`) during relativization.
- cms current state already contains equivalent safeguards in:
  - `packages/ui/src/components/message-part.tsx`
  - `relativizeProjectPaths(...)` includes:
    - `if (directory === "/") return text`
    - `if (directory === "\\") return text`

## Decision

- Marked as already integrated.
- No additional code changes required for this item.
