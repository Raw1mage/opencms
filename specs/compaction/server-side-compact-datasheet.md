# Codex Server-Side Compaction — Wire Protocol Datasheet

> Extracted from `refs/codex/codex-rs/` (upstream codex-cli) as of 2026-05-16.
> Governs how opencode calls the codex `/responses/compact` endpoint and
> the inline `context_management` compaction mode.

## Two Compaction Modes

| Mode | Endpoint | Trigger | Input | Output |
|------|----------|---------|-------|--------|
| **Standalone** | `POST /responses/compact` | Manual or pre-turn auto | `CompactionInput` | `{ output: ResponseItem[] }` |
| **Inline** | Regular `POST /responses` with `context_management` | Server auto at threshold | Normal turn request + `compact_threshold` | ResponseItem[] (includes compaction items in response) |

### Mode 1: Inline (context_management)

Added to the normal Responses API request body:

```json
{
  "context_management": [{
    "type": "compaction",
    "compact_threshold": <token_count>
  }]
}
```

Server auto-compacts when cumulative token count crosses the threshold.
The compaction output appears as `ResponseItem::Compaction` /
`ResponseItem::ContextCompaction` items in the response. **These items
must be preserved** in the next turn's input — they are the canonical
replacement history.

### Mode 2: Standalone (`/responses/compact`)

#### Request

```
POST https://chatgpt.com/backend-api/codex/responses/compact
Authorization: Bearer <access_token>
Content-Type: application/json
OpenAI-Beta: responses=v1
chatgpt-account-id: <account_id>   (optional)
```

#### Request Body (`CompactionInput`)

```typescript
{
  model: string              // e.g. "gpt-5.5"
  input: ResponseItem[]      // ← CONVERSATION HISTORY, not prose text
  instructions: string       // system prompt / base instructions
  tools: ToolSpec[]           // tool definitions (can be empty [])
  parallel_tool_calls: boolean
  reasoning?: { effort: string; summary: string }   // optional
  service_tier?: string                              // optional
}
```

**Critical**: `input` must be `ResponseItem[]` — the actual conversation
items (user messages, assistant messages, function_call,
function_call_output). **NOT** a single user message wrapping prose text.
The server is trained to compress structured conversation history; a
single giant text blob returns `{ output: [] }` (silent rejection).

#### ResponseItem Types Accepted in `input`

| Type | Role | Fields |
|------|------|--------|
| `message` | `user` | `content: [{ type: "input_text", text }]` |
| `message` | `assistant` | `content: [{ type: "output_text", text }]` |
| `function_call` | — | `call_id, name, arguments` |
| `function_call_output` | — | `call_id, output` |
| `Compaction` | — | Opaque compaction item from prior Mode 1 output |
| `ContextCompaction` | — | Opaque context compaction marker |

#### Response Body

```typescript
{
  output: ResponseItem[]   // ← Opaque, must not be pruned
}
```

The output array is the canonical replacement conversation history.
Items may include:
- Compacted user/assistant messages (text summarised)
- Retained function_call / function_call_output pairs
- Opaque `Compaction` / `ContextCompaction` markers

**The caller must NOT prune the output** — it is the complete next
context window per the server's compaction policy.

#### Post-Processing (upstream codex-rs)

From `compact_remote.rs:255-275`:

1. **Drop `developer` messages** from output (may contain stale/duplicated
   instructions)
2. **Drop non-user-content `user` messages** (session prefix wrappers)
3. **Keep `assistant` messages** (future models may emit them)
4. **Keep `Compaction` / `ContextCompaction` items**
5. **Inject initial context** before the last real user message (mid-turn
   compaction only; standalone skips this)

#### Error Handling (upstream codex-rs)

From `compact_remote.rs:359-386`:

If `ContextWindowExceeded` error occurs during compaction:
- Remove the oldest history item (codex-generated items only)
- Retry with shorter input (preserves cache prefix)
- If only 1 item remains, fail permanently

Other errors: retry with exponential backoff up to provider's
`stream_max_retries`.

## opencode Mapping

### `buildConversationItemsForPlugin` (compaction.ts)

Converts `MessageV2.WithParts[]` → `ResponseItem[]` for the plugin:

| MessageV2 | ResponseItem |
|-----------|-------------|
| `role: "user"`, text parts | `{ type: "message", role: "user", content: [{ type: "input_text", text }] }` |
| `role: "assistant"`, text parts | `{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }` |
| `role: "assistant"`, tool part (completed) | `{ type: "function_call", call_id, name, arguments }` + `{ type: "function_call_output", call_id, output }` |

### Plugin Hook (`session.compact`)

```typescript
Plugin.trigger("session.compact", {
  sessionID,
  model: { providerId, modelID, accountId },
  conversationItems: ResponseItem[],   // ← from buildConversationItemsForPlugin
  instructions: string,                 // agent prompt, capped at 50K chars
}, { compactedItems: null, summary: null })
```

Returns:
- `compactedItems: ResponseItem[] | null` — opaque server output
- `summary: string | null` — human-readable text extracted from output

### Compaction Strategy Matrix (opencode)

| Strategy | KindName | Input Format | Zero Anchor? | Cost |
|----------|----------|-------------|-------------|------|
| Local narrative | `narrative` | Redacted dialog concat | No (chained) | 0 |
| Server-side | `ai_free` | `ResponseItem[]` via plugin | **Yes** | 0 (subscription) |
| LLM agent | `ai_paid` | Full conversation via SessionProcessor | **Yes** | Paid |

**Zero Anchor**: AI-generated anchors (ai_free / ai_paid) demote all
predecessor `summary:true` messages before writing. The new anchor
becomes the sole active anchor — context floor resets to just its
compressed size.

Narrative anchors continue to chain-concat (`anchor[n+1].body =
anchor[n].body + new_tail`). The cumulative floor is monitored; when
it exceeds `localToAiThresholdRatio` (default 0.60) of context_limit,
a background enrichment schedules server-side or LLM compaction to
reset the floor.

### Upstream Compaction Prompt (for ai_paid LLM path)

From `refs/codex/codex-rs/core/templates/compact/prompt.md`:

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff
summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.
```

### Upstream Summary Prefix (injected before compacted summary)

From `refs/codex/codex-rs/core/templates/compact/summary_prefix.md`:

```
Another language model started to solve this problem and produced a
summary of its thinking process. You also have access to the state
of the tools that were used by that language model. Use this to build
on the work that has already been done and avoid duplicating work.
Here is the summary produced by the other language model, use the
information in this summary to assist with your own analysis:
```

## Source Files

| File | Role |
|------|------|
| `refs/codex/codex-rs/codex-api/src/common.rs:25` | `CompactionInput` struct definition |
| `refs/codex/codex-rs/codex-api/src/endpoint/compact.rs` | `CompactClient` — HTTP call to `/responses/compact` |
| `refs/codex/codex-rs/core/src/compact.rs` | Inline (LLM-based) compaction — prompt + summary extraction |
| `refs/codex/codex-rs/core/src/compact_remote.rs` | Standalone `/responses/compact` compaction flow |
| `refs/codex/codex-rs/core/src/compact_remote_v2.rs` | V2 variant (same wire protocol) |
| `packages/opencode/src/provider/codex-compaction.ts` | opencode's HTTP call to `/responses/compact` |
| `packages/opencode/src/plugin/codex-auth.ts:214` | `session.compact` plugin hook |
| `packages/opencode/src/session/compaction.ts` | `buildConversationItemsForPlugin`, `tryLowCostServer`, `runCodexServerSideRecompress` |
