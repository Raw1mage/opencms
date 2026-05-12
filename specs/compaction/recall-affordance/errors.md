# Errors and failure modes — compaction_recall-affordance

## Error Catalogue

| Error code | Surface | Trigger | Handling | User impact |
|---|---|---|---|---|
| `unknown_call_id` | RecallTool output | `recallByCallId` returns null | Typed error in `output`; metadata.error set; instructs model to re-execute the original tool | Transparent; AI falls back |
| `tool_index_missing` | telemetry | Anchor written without `## TOOL_INDEX` marker | `compaction.tool_index.missing` event; anchor still persists; downstream L3 note adjusts wording to "TOOL_INDEX unavailable, infer ids from narrative" | Degraded but recoverable |
| `tool_index_truncated` | telemetry | Index would exceed INV-6 size ceiling | Synthetic placeholder row inserted; oldest entries dropped; `truncated_count` field in `compaction.tool_index.emitted` | Older tool calls unreachable but explicitly flagged |
| `recall_redundant` | RecallTool metadata | callID is in post-anchor journal (still live in prompt) | Returns content normally; `metadata.redundant=true` for telemetry | None |
| `recall_subagent_id` | RecallTool output | callID belongs to a subagent stream (not this session) | Returns `unknown_call_id`; out of scope for v1 per DD-6 | AI uses `read_subsession` instead |

## Non-errors (intentional silent paths)

- **Anchor kind != narrative**: L3 system note simply not injected. No telemetry. Server-side / hybrid_llm preserve content via other mechanisms.
- **No narrative anchor in session yet**: L3 not injected; recall tool still available but unlikely to be used.
- **Repeated recall of same id**: succeeds both times, no de-dup; cost is one O(n) scan.

## Recovery rules

- A `compaction.tool_index.missing` event MUST NOT block compaction completion. The anchor was successfully written; only the addressability promise is broken. INV-2 explicitly designs for graceful degradation.
- A `recall` call with an unknown id MUST NOT trigger a retry storm. The tool returns immediately; the model decides whether to re-execute. No internal retry, no fallback chain.
- If the prompt assembler cannot determine anchor kind (e.g. metadata corruption), default to NOT injecting the amnesia notice. False negative is better than misleading the model.
