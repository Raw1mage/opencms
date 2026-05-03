# Observability: docx-upload-autodecompose

How we know the upload-time decompose pipeline is working in
production. Three layers: events (one per upload), metrics (time
series aggregates), structured logs (per-step trace), alerts.

## Events

### `incoming.decompose`

Emitted exactly once per Office upload, after the dispatcher
finishes processing (success, failure, or unsupported).

| field | type | example | notes |
|---|---|---|---|
| `mime` | string | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Detected mime |
| `format` | enum | `docx` | One of `docx \| doc \| xls \| ppt \| xlsx \| pptx` |
| `byte_size` | integer | `134912` | Original upload size |
| `duration_ms` | integer | `312` | Wall time from dispatcher start to manifest write complete |
| `cache` | enum | `miss` | `hit \| miss` |
| `cache_outcome` | enum | `fresh` | `hit \| fresh \| regen` (only when `cache=miss`, `regen` means a prior dir was renamed aside) |
| `status` | enum | `ok` | `ok \| failed \| unsupported` |
| `reason` | string | `docxmcp 服務暫時無回應 (timeout 30s)` | Required when `status != ok`; matches manifest reason verbatim |
| `decomposer` | enum | `docxmcp.extract_all` | Matches manifest's `decompose.decomposer` |
| `stem` | string | `foo` | For correlating with on-disk artifacts |
| `prior_sibling` | string | `foo-20260503-081422` | Only when `cache_outcome=regen`, identifies the renamed sibling |

Consumed by the existing telemetry pipeline. Schema added to
the shared event registry.

## Metrics

Aggregated by the existing telemetry sink at 1-minute resolution
unless noted otherwise.

| metric | type | dimensions | purpose |
|---|---|---|---|
| `incoming.decompose.count` | counter | `format`, `status` | Volume by format and outcome |
| `incoming.decompose.duration_ms` | histogram (p50 / p95 / p99) | `format` | Latency per format; AC-1 / AC-2 verification |
| `incoming.decompose.cache_hit_ratio` | gauge | `format` | Fraction of `cache=hit` over total |
| `incoming.decompose.byte_size` | histogram | `format` | Distribution of upload sizes; informs future timeout tuning |
| `incoming.decompose.failure_rate` | gauge | `format`, `reason` | Per-reason failure share |
| `incoming.decompose.regen_count` | counter | `format` | Stem-clash frequency; informs whether sibling eviction needs to be a future spec |

## Structured logs

Per-step trace lives in the existing dispatcher logger. Add log
points at:

- Upload received: `dispatcher.upload.received {ref_id, mime, byte_size}`
- Mime detected: `dispatcher.upload.mime_detected {ref_id, format}`
- Cache key computed: `dispatcher.cache.key_computed {ref_id, sha256, filename}`
- Cache verdict: `dispatcher.cache.verdict {ref_id, verdict, prior_uploaded_at?}`
- Stem dir renamed: `dispatcher.stem_dir.renamed {ref_id, from, to}`
- Decompose dispatched: `dispatcher.decompose.dispatched {ref_id, decomposer}`
- Decompose returned: `dispatcher.decompose.returned {ref_id, status, duration_ms, reason?}`
- Manifest written: `dispatcher.manifest.written {ref_id, path, status}`
- Hint composed: `composer.hint.rendered {ref_id, fold_applied, line_count}`
- Telemetry emitted: `dispatcher.telemetry.emitted {ref_id, event}`

All log messages plain English (logs are operator-facing). Reason
strings in logs may quote the user-facing manifest reason verbatim
to keep diagnostic alignment.

## Alerts

| alert | condition | severity | runbook |
|---|---|---|---|
| Sustained decompose timeout | `incoming.decompose.failure_rate{reason=docxmcp 服務暫時無回應} > 5%` over 5 min | warning | Check docxmcp service health; check submodule pointer matches deployed binary |
| docxmcp entry missing | `incoming.decompose.failure_rate{reason=~"docx 處理工具暫不可用"} > 0` over 1 min | page | Submodule pointer drift between opencode and docxmcp; ops bumps |
| Decompose latency regression | `incoming.decompose.duration_ms.p95{format=docx} > 5000` for 10 min | warning | Investigate: slow disk, large doc trend, docxmcp regression |
| Cache hit ratio collapse | `incoming.decompose.cache_hit_ratio{format=docx} < 0.05` for 1 hour | info | Possibly normal (cold cache); investigate if persistent |
| Manifest write failures | `incoming.decompose.failure_rate{reason=~"磁碟寫入錯誤"} > 0` for 5 min | page | Disk space / permissions issue on host |

## Manual probes

| probe | purpose | how |
|---|---|---|
| End-to-end upload smoke | Verify the pipeline from upload to AI hint | Upload a known-good fixture .docx via the chat UI; confirm `incoming/<stem>/manifest.json` written and AI's first reply references decomposed file paths |
| Cache hit smoke | Verify identical re-upload short-circuits | Upload the same fixture twice; confirm telemetry shows `cache=hit` on the second |
| Stem clash smoke | Verify rename-on-regen works | Upload one fixture, then upload a different file with the same name; confirm prior dir renamed to timestamped sibling, new tree at canonical path |

## Out of scope (future observability work)

- Distributed tracing across opencode → docxmcp boundary (today
  the trace stops at the MCP call; would need OpenTelemetry
  propagation through the MCP transport)
- User-facing latency budget (separate spec; upload latency feeds
  into chat-message-turn-latency)
- Sibling dir count metrics (would inform eviction policy, not
  needed until eviction is in scope)
