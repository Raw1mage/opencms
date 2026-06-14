# Bug Report: Redirected tool output does not clearly instruct AI to inspect stored output

## Summary

When a tool result is too large, opencode redirects the full output to a storage file and prints a message such as:

```text
This output is redirected to /home/pkcs12/.local/share/opencode/storage/session/.../output/output_tool_...
Consider a more specific pattern or path to narrow results.
```

The redirect path is useful, but the current message does not explicitly tell the AI that the correct next action is to read that file with the file read tool. As a result, an agent may ignore the redirected output and rerun, narrow, or replace the validation step instead of inspecting the canonical stored result.

## Observed Behavior

During a document-editing session, `grep` output exceeded the inline display limit and was redirected to a file under:

```text
/home/pkcs12/.local/share/opencode/storage/session/<session>/output/output_tool_<id>
```

The AI treated the redirected output as too large/noisy and switched to a separate short verification script instead of reading the redirected file. The user correctly pointed out that the purpose of the redirect is for the AI to inspect the stored result directly.

## Expected Behavior

When tool output is redirected, the AI should treat the redirect file as the authoritative continuation of that tool call.

Recommended agent behavior:

1. Do not rerun the same search just because output was redirected.
2. Read the redirected output file with `read(filePath=..., offset=..., limit=...)`.
3. Use targeted offsets or smaller reads if the redirected output is large.
4. Only rerun the original tool if the redirect file is unavailable or a different query is needed.

## Why This Matters

The current hint emphasizes narrowing future searches but does not explicitly instruct the agent to inspect the already captured full output. This can cause:

- wasted tool calls,
- loss of evidence traceability,
- unnecessary alternate validation logic,
- user confusion when the output file was already available,
- less reliable behavior in large grep/glob/bash outputs.

In the observed session, context was not constrained:

```text
context_budget:
  window: 272000
  used: 4740
  ratio: 0.02
  status: green
  cache_read: 168960
  cache_hit_rate: 0.97
  as_of: end_of_turn_N-1
```

So the issue was not context pressure. The missing behavior was tool-output handling discipline.

## Proposed Fix

Update the redirected-output message to be more prescriptive. For example:

```text
Full output was written to <path>.
Use the read tool with offset/limit to inspect this stored output.
Do not rerun the same search unless you need a different query or the file is unavailable.
```

Additionally, document this rule in the tool guidance for tools that redirect output, especially `grep`, `glob`, and `bash`.

## Acceptance Criteria

- Redirected-output messages explicitly instruct agents to read the stored file.
- Agent-facing docs explain that redirected output is authoritative and should be inspected before rerunning or replacing the operation.
- The instruction mentions using `offset`/`limit` for large redirected outputs.
- The instruction discourages duplicate reruns of the same tool call.

---

## Resolution (2026-05-24)

Closed. See [docs/events/event_20260524_grep_redirect_threshold_and_hint.md](../../docs/events/event_20260524_grep_redirect_threshold_and_hint.md).

Summary of fix:

- Raised inline threshold for grep and bash-search from `2000 chars` → `65536 chars` (64 KB). Most ordinary grep results no longer redirect at all.
- When the threshold is exceeded, the redirect path now also returns a `maxLines: 50` head preview instead of `maxLines: 0`, so the agent has actual content to reason about.
- Rewrote the redirect hint to be prescriptive: "Read this file with the read tool using offset/limit to inspect the rest; do not rerun the same query."
- Adjusted [packages/opencode/test/tool/grep.test.ts:36](../../packages/opencode/test/tool/grep.test.ts#L36) to match the new hint shape.

Acceptance criteria mapping:

- Done — redirected-output messages explicitly instruct agents to read the stored file ([grep.ts:184-190](../../packages/opencode/src/tool/grep.ts#L184-L190), [bash.ts:347-355](../../packages/opencode/src/tool/bash.ts#L347-L355)).
- Partial — agent-facing prompt-template docs not updated; tool hint considered sufficient. Re-open if recurrence observed.
- Done — mentions `offset/limit` for large redirected outputs.
- Done — discourages duplicate reruns of the same tool call.
