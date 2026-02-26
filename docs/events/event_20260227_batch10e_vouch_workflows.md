# Batch10E Vouch workflow restrictions and labeling (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`e48c1ccf0`)
Target: `cms`

## Scope

- Port low-risk workflow governance updates for vouched/denounced users.

## Changes

1. `.github/workflows/vouch-check-issue.yml`
   - Parse both vouched and denounced entries from `.github/VOUCHED.td`.
   - Keep auto-close behavior for denounced users.
   - Add `Vouched` label for positively vouched issue authors.
2. `.github/workflows/vouch-check-pr.yml`
   - Added `issues: write` permission (needed for labels/comment APIs).
   - Parse both vouched and denounced entries.
   - Keep auto-close behavior for denounced PR authors.
   - Add `Vouched` label for positively vouched PR authors.
3. `.github/workflows/vouch-manage-by-issue.yml`
   - Restrict command manager roles to `admin,maintain`.

## Validation

- Workflow YAML and script logic reviewed via diff.
- No runtime application code touched.

## Safety

- CI/workflow-only change; no impact to cms runtime features.
