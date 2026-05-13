# Observability: provider_apply-patch-metadata-strip

## Summary

This change has **no new runtime telemetry**. It is a tool-return shape narrowing that affects on-disk size only. The success signal is measurable via existing SQLite probes and existing UI render paths; no new event types, counters, or metrics are introduced.

## Events

No new runtime event types are introduced by this plan. Existing events (`session.round.telemetry`, `tool.applied`, etc.) continue to fire unchanged. The change is invisible at the event-stream layer — only on-disk inspection differentiates pre- vs. post-change apply_patch payloads.

## Metrics

No new metric counters or histograms are introduced. The relevant signal — per-session `apply_patch` payload size — is queried on demand via SQLite probes (see "Disk-size signal" below). If a future plan wants a periodic counter, it would be defined there, not here.

## Existing signals that confirm success

### Disk-size signal (primary)

Query the SQLite session storage directly:

```bash
# Pre-change baseline (any old session containing apply_patch calls):
sqlite3 ~/.local/share/opencode/storage/session/ses_<id>.db <<'SQL'
SELECT
  COUNT(*) AS apply_patch_parts,
  AVG(LENGTH(payload_json)) AS avg_bytes,
  MAX(LENGTH(payload_json)) AS max_bytes,
  SUM(LENGTH(payload_json)) AS total_bytes
FROM parts
WHERE type='tool' AND json_extract(payload_json,'$.tool')='apply_patch';
SQL
```

After the change, on a new session that performs comparable apply_patch volume:
- `avg_bytes` MUST drop by ~50× or more for sessions touching large files.
- `max_bytes` MUST be < 20 KB regardless of file size (since diff hunks are size-bounded, not file-size-bounded).
- `total_bytes` saving = roughly `(file_size_avg * 2) * N` per session.

### LLM prompt invariant (negative signal)

```bash
# Confirm metadata fields never appear in serialized model messages.
# Spot-check after the change:
node -e '
  const fs = require("fs");
  const m = require("./packages/opencode/src/session/message-v2");
  const stream = /* construct test stream containing new-shape part */;
  const out = m.toModelMessages(stream);
  console.assert(!JSON.stringify(out).includes("\"before\""),  "leak: before");
  console.assert(!JSON.stringify(out).includes("\"after\""),   "leak: after");
'
```

(In practice this is asserted by TV-4.)

### UI render signal

Manual: open the web UI on a new session containing apply_patch parts. The diff display must be visible (hunks, +/- markers, additions/deletions counters). The browser console MUST be free of errors and React/Solid warnings.

## What is NOT observable

- There is no event emitted when an apply_patch call uses the new shape vs. legacy shape. This is intentional — the change is invisible to runtime behavior; only on-disk inspection differentiates them.
- There is no counter for "bytes saved per session." If a future plan wants to measure cumulative savings, it can run the SQLite query above as a periodic job; this plan does not add the job.

## Drift detection

Once landed and graduated to `living`, `wiki_validate` should NOT report drift for this spec unless someone re-introduces `before`/`after` to `ApplyPatchFileMetadata`. The plan's code anchors in `design.md` Critical Files section serve as the canary — if `apply_patch.ts` grows back the dropped fields, anchor-based queries will surface a mismatch with the design's stated narrowed shape.

A simple repo-side check that can be added to CI in the future (not in scope for this plan):

```bash
git grep -nE "^\s*(before|after)\s*:\s*string" packages/opencode/src/tool/apply_patch.ts
# Expected: zero matches.
```

## Future telemetry (out of scope)

- Per-session cumulative `apply_patch` payload size could become a panel in the admin/telemetry surface. Worth considering if the user later wants visibility into session-DB growth. Not part of this plan.
- A periodic vacuum job that re-writes legacy session DBs into the narrowed shape — would emit a `session.dream_compact` event with bytes-reclaimed counter. Belongs to a separate vacuum-CLI plan.
