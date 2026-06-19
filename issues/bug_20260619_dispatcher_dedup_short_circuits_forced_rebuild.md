# BUG: dispatcher dedup short-circuits semantically-forced-rebuild tool calls (e.g. pptx_bootstrap overwrite=true) → silent stale reuse

- **Date**: 2026-06-19
- **Reporter**: TheSmartAI (orchestrator)
- **Component**: opencode tool dispatcher — duplicate-tool-call dedup / short-circuit (`[already executed — reusing result]`)
- **Severity**: medium — no corrupt output, but a *silent* stale-result reuse misleads the caller into debugging the wrong layer; wasted a full debug round in a live downstream task.
- **Status**: OPEN
- **Origin**: re-scoped out of docxmcp BR `docxmcp/issues/issue_20260619_pptx_addshape_native_shape_friction.md` (F3/R3). docxmcp side proven correct; defect is in the harness dispatcher.

## Symptom (observed downstream)

While building a pptx from scratch with docxmcp:

1. Caller ran `docxmcp_pptx_bootstrap(out_dir=X, overwrite=true)`.
2. Caller later ran the **same** `docxmcp_pptx_bootstrap(out_dir=X, overwrite=true)` again, intending a forced clean reset of the slide package.
3. The dispatcher returned `[already executed — reusing result]` — the second call **never reached docxmcp**, so the package was NOT reset.
4. New ops were applied on top of the stale package (90 → 180 shapes); `layout_lint` then reported "out-of-bounds shapes" from the *previous* batch, and the caller mis-diagnosed their new ops.
5. Workaround: switch to a brand-new `out_dir` each time to dodge the dedup.

## Root cause (hypothesis)

SYSTEM.md §6 documents the intended behaviour: identical `(tool_name, args)` calls within one turn are short-circuited at the dispatcher to keep the trace clean. That is correct for **pure read/query** tools, but wrong for tools whose contract is **"force a side effect / rebuild"** — `overwrite=true` semantically means "do it again, destructively", yet the dedup treats it as a reusable pure query.

The dispatcher cannot tell "idempotent read" from "forced-rebuild mutation" by `(tool_name, args)` alone; the args are byte-identical in both cases.

## Verification that docxmcp is NOT at fault

`docxmcp/bin/pptx_bootstrap.py:137-153`: with `overwrite=true`, docxmcp correctly `rmtree`s `package/`, `slides/`, `media/`, `objects/`, `layouts/` and unlinks `manifest.json` / `deck.md` before re-unzipping the template. The reset logic is sound — it simply never gets invoked because the second call is short-circuited upstream.

## Expected behaviour (options)

1. **Preferred**: dedup must NOT short-circuit calls to mutating / destructive tools (those whose annotations carry `destructiveHint:true` or `readOnlyHint:false`, or that the registry marks as side-effecting). Only `readOnlyHint:true` tools are safe to dedup.
2. **At minimum**: when a call IS short-circuited, surface an explicit `reused:true` flag in the result envelope so the caller knows the side effect did NOT re-run (instead of an opaque `[already executed — reusing result]` that looks like success).

## Related

- Same class as the docxmcp BACKLOG "out of docxmcp scope" items (harness/prompt-layer, not docxmcp).
- docxmcp-side fixes for the same parent BR (R1/R2/R4/R5) landed 2026-06-19; only F3/R3 (this issue) belongs here.
