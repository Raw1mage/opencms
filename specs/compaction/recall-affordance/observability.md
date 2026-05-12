# Observability — compaction_recall-affordance

## Events

### Bus events

All events publish on existing channels; new event types only.

| Event type | Channel | Schema | When |
|---|---|---|---|
| `compaction.tool_index.emitted` | `bus.session.compaction.telemetry` | `{sessionID, anchorId, entryCount, indexBytes}` | After narrative anchor write, on every successful index parse |
| `compaction.tool_index.missing` | `bus.session.compaction.telemetry` | `{sessionID, anchorId, anchorBytes}` | After narrative anchor write, when `## TOOL_INDEX` marker absent |
| `tool.recall.invoked` | `tool-telemetry` (Log.create) | `{sessionID, callID, found, redundant?, originalToolName?}` | Every RecallTool.execute call |
| `prompt.amnesia_notice.injected` | `bus.llm.prompt.telemetry` (extend blocks array) | adds `system_block_amnesia_notice` entry | Every prompt assembly where most-recent anchor is narrative |

### Log lines

```
[opencode] [<ts>] [compaction.tool_index] INFO {sessionID, anchorId, entryCount, indexBytes, outcome}
[opencode] [<ts>] [tool.recall] INFO {sessionID, callID, found, redundant, originalToolName}
[opencode] [<ts>] [prompt.amnesia_notice] DEBUG {sessionID, anchorId, anchorKind}
```

## Metrics

Aggregated counters/ratios derivable from the events above; primarily for ops dashboards.

### Dashboard wishlist (out of scope; future)

- Rate of `compaction.tool_index.missing` per provider/model — surfaces LLMs that ignore the TOOL_INDEX instruction.
- Average entryCount per narrative anchor — sanity-check that the index is non-trivial.
- Ratio of `tool.recall.invoked` to `compaction.tool_index.emitted` — measures how often the affordance is actually used.
- Distribution of `output_chars` per recalled tool — guides future caching decisions.

## Drift detection

- `wiki_validate` Phase B can compare anchor bodies against this spec's INV-2 (every narrative anchor must have TOOL_INDEX); out of scope for v1.
- Manual: grep `compaction.tool_index.missing` events; if rate > 5% of narrative compactions, investigate the prompt template.

## Manual verification commands

```bash
# After fix lands, check a session's recent compactions emit TOOL_INDEX
grep "ses_<id>" ~/.local/share/opencode/log/debug.log | grep "compaction.tool_index"

# Check recall invocations
grep "ses_<id>" ~/.local/share/opencode/log/debug.log | grep "tool.recall"

# Inspect a specific anchor body to verify TOOL_INDEX present
jq '.parts[]' ~/.local/share/opencode/storage/message/<msgId>.json | grep -A 200 "## TOOL_INDEX"
```
