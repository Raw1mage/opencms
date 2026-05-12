# Handoff

## Execution Contract

This package documents a surface-only rebrand that has already merged to main as commit 6c66af0fd. There is no further implementation work. The handoff covers verification and graduation only.

## Required Reads

- proposal.md — scope and preservation allowlist
- spec.md — requirements and acceptance checks
- design.md — batching strategy, risks, critical files
- tasks.md — completed batch ledger

## Stop Gates In Force

- Do NOT touch any preservation-allowlist item (CLI binary name, `@opencode-ai/*` package names, `opencode.json` filename, `~/.config/opencode/` paths, `mainBinaryName`, shell-profile marker, "OpenCode Zen", upstream URLs).
- Do NOT introduce new typecheck regressions vs the pre-merge main baseline.
- Do NOT hand-edit packages/sdk/js/openapi.json or packages/sdk/openapi.json — they are regenerated artifacts.
- Do NOT amend or force-push 6c66af0fd; create new commits for any follow-up.

## Execution-Ready Checklist

- [x] All six batch commits land on main via 6c66af0fd.
- [x] `bun turbo typecheck` parity confirmed.
- [x] Preservation allowlist verified by grep.
- [x] Plan package graduated to /specs/branding/rebrand-opencms-userfacing/.
