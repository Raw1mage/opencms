---
date: 2026-05-11
summary: "Bundle wire shape — emit raw string content (pre-breaker pattern) instead of ContentPart[]"
---

# Bundle wire shape — emit raw string content (pre-breaker pattern) instead of ContentPart[]

## Hypothesis

Cache stuck at 4608 floor (≈ instructions+tools size only) despite byte-stable bundle content. Pre-breaker `convert.ts` emitted developer items with `content: "raw string"`; post-realign emits `content: [{type:"input_text", text:"..."}]`. Both API-valid, but wire bytes differ.

OpenAI prefix cache hash uses "first 256 tokens of the prompt" plus optional `prompt_cache_key`. For delta=true with previous_response_id, server reconstructs the prompt from chain. If the canonical reconstruction serializes ContentPart[] differently from how it was originally cached when first sent, the prefix match drops to whichever boundary the bytes diverge. `instructions` and `tools` come directly from the request and are byte-stable both ways → cache hits through them (≈ 4608). Beyond that, chain content goes through reconstruction → potentially different byte order/whitespace → cache miss.

ses_xu00cIPVXLRZ (cached 35k+ historically) used pre-breaker wire with raw-string content for developer items. Today's post-realign sessions stuck at 4608. The wire-shape difference is the cleanest hypothesis on the table.

## Fix

`packages/opencode-codex-provider/src/convert.ts` — when an LMv2 user-role message carries `providerOptions.codex.kind` of `"developer-bundle"` or `"user-bundle"`, emit the ResponseItem with **raw string content** instead of ContentPart array:

```ts
if (kind === "developer-bundle" || kind === "user-bundle") {
  const textOnly = parts
    .filter((p): p is { type: "input_text"; text: string } => p.type === "input_text")
    .map((p) => p.text)
    .join("")
  input.push({
    role: kind === "developer-bundle" ? "developer" : "user",
    content: textOnly,  // raw string, not ContentPart[]
  } as ResponseItem)
}
```

Regular user messages (no marker) keep ContentPart[] for multi-modal support (input_image etc.).

## Files

- `packages/opencode-codex-provider/src/convert.ts` (+~25 lines marker handling)
- `packages/opencode-codex-provider/src/convert.test.ts` (assertion update + new content-shape check)

## Verification

```
bun test src/convert.test.ts   18 pass / 1 pre-existing fail
```

Server-side validation requires a fresh codex session post-restart and observation that `cached_tokens` rises above 4608.

## Risks

- ResponseItem with `content: "string"` for `role: "user"` is API-valid (codex-rs `ResponseItem::Message { content: string | ContentPart[] }`) but might be uncommon. If server has stricter validation in some path, requests could 4xx.
- Multi-modal content (images) cannot ride this path; only the bundle items (which are text-only by construction) use raw string.

## Caveats

- This is empirical: if cache still stuck at 4608 after this, the wire-shape hypothesis is wrong, and the residual issue is server-side beyond our control (per user hypothesis: OpenAI silently throttled cache to fix their own empty-response bug). At that point the architectural realign work stands on its own merits — chain stays stable, no false-positive empty-response chain resets, prompt structure aligned with upstream — and we accept whatever cache behavior the server provides.

