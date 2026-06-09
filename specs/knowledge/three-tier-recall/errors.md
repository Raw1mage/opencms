# Errors

Error conditions and required handling. Per project rule 1: no silent fallback — surface loudly.

## Error Catalogue

| Code | Condition | Handling |
|---|---|---|
| E-IDX-1 | Event source glob matches zero files | Log loudly; abort rebuild (likely wrong cwd / glob), do not write an empty events.sqlite over a good one. |
| E-IDX-2 | Filename has no parseable date | Set `created=null`, continue indexing the file (full-text only). NOT a failure (AC5). |
| E-IDX-3 | A single event file fails to parse | Record `{slug, error}` in the result's errors[], skip that file, continue the batch. Report count at end. |
| E-IDX-4 | Write to events.sqlite fails mid-transaction | Roll back the whole transaction (atomic); leave prior DB intact; surface the error. |
| E-IDX-5 | events.sqlite path collides with spec index path | Hard error before writing — separation is load-bearing (DD-2). |
| E-QRY-1 | event_search called before events.sqlite exists | Return a clear "index not built — run rebuild" error, not an empty result. |
| E-QRY-2 | Malformed event_query date token | Reject with the offending token named; do not silently ignore the filter. |
| E-MIG-1 | A MEMORY.md entry cannot be classified by the taxonomy | Stop; surface the entry for human decision (do not drop silently). |
| E-MIG-2 | A migrated item is not findable via its tool at P5-4 | Block P6-2 (empty MEMORY.md); list the unverified items. |
| E-MIG-3 | Attempt to empty MEMORY.md while E-MIG-2 outstanding | Refuse the destructive action (G5). |
