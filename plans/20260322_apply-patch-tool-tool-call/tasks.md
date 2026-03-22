# Tasks

## 1. Define apply_patch metadata contract

- [ ] 1.1 Confirm the shared tool runtime can publish running-state metadata updates
- [ ] 1.2 Define the phased `ApplyPatchMetadata` shape and backward-compatibility rules

## 2. Rewrite running-state TUI rendering

- [ ] 2.1 Replace the `files.length > 0` render gate in `ApplyPatch`
- [ ] 2.2 Render running-state block content for phase, progress, and placeholder states

## 3. Emit backend execution checkpoints

- [ ] 3.1 Emit metadata for `parsing`, `planning`, and `awaiting_approval`
- [ ] 3.2 Emit metadata for per-file `applying`, `diagnostics`, `completed`, and `failed`

## 4. Validate UX and regressions

- [ ] 4.1 Validate multi-file running expandability and phase visibility
- [ ] 4.2 Validate completed diff/diagnostics compatibility and failed-state behavior

## 5. Sync documentation

- [ ] 5.1 Update the event log with evidence, decisions, and validation
- [ ] 5.2 Record architecture sync conclusion
