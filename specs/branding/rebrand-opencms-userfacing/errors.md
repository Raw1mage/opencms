# Errors

## Error Catalogue

This change is presentation-only text substitution; it does not introduce, remove, or alter any error path. The catalogue below documents the failure modes that *gated* the rebrand (i.e. would have blocked the merge) and how each was guarded.

| Code | Trigger | Detection | Mitigation |
|------|---------|-----------|------------|
| RBR-PRESERVE-VIOLATION | A preservation-allowlist token (`@opencode-ai/`, `opencode.json`, `~/.config/opencode/`, `mainBinaryName`, "OpenCode Zen", shell-profile marker, upstream URL) is replaced. | post-batch grep | Revert the offending hunk; re-run grep before recommitting. |
| RBR-TYPECHECK-REGRESSION | `bun turbo typecheck` reports a new failure vs main baseline. | bun turbo typecheck | Fix or revert; do not merge until parity. |
| RBR-SDK-DRIFT | packages/sdk/js/openapi.json or sdk.gen.ts edited by hand instead of regen. | code review | Discard hand edit; regenerate from updated route descriptions. |
| RBR-I18N-TRANSLATION-DRIFT | A locale gets a translated rewrite instead of a literal token swap. | diff inspection per locale | Restrict edits to token substitution only. |

No runtime error paths are introduced by this change.
