# Event: origin/dev refactor round9 (ACP session title defaulting)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `86e545a23ecdb2c1840ab01e82eca292117c6bbc`
- Intent: ACP-created sessions should not be forced to random synthetic titles.

## Rewrite-only port in cms

- `packages/opencode/src/acp/session.ts`
  - Removed explicit random title assignment during ACP session create.
  - Session now relies on normal default-title pipeline to produce meaningful titles.

## Additional analysis decision

- `67c985ce82b3a0ef3b22bef435f58884a3aab990`: skipped for now.
  - Reason: upstream WAL checkpoint patch targets sqlite DB open path not present in current cms storage architecture.

## Validation

- `bun run packages/opencode/src/index.ts --help` ✅
- `bun run packages/opencode/src/index.ts acp --help` ✅
