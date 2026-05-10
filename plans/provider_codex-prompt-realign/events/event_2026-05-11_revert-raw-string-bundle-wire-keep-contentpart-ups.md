---
date: 2026-05-11
summary: "Revert raw-string bundle wire — keep ContentPart[] (upstream-aligned)"
---

# Revert raw-string bundle wire — keep ContentPart[] (upstream-aligned)

## What

Revert `convert.ts` bundle marker handling: developer-bundle / user-bundle ResponseItems go back to `content: ContentPart[]` (`[{type:"input_text", text:"..."}]`) form. The 2026-05-11 raw-string experiment is dropped.

## Why

Empirically falsified. Fresh post-hotfix session `ses_1eca32cc1ffelyxaN1FlERPqRS` from turn 1 still saw `cached_tokens=4608` stuck across all subsequent delta=true turns. Wire shape was confirmed in WS REQ tail (`developer:<role_identity>\n...` raw string, no `[{type:"input_text",...}]` wrapping), but cache behavior identical to ContentPart[] form. Wire-shape was NOT the cache lever.

Decision: prefer **upstream alignment**. Upstream codex-cli's `ResponseItem::Message` carries `content: Vec<ContentItem>` (array form), so ContentPart[] is the more upstream-faithful shape. With cache behavior insensitive to either choice, the upstream-matching default wins.

## Files

- `packages/opencode-codex-provider/src/convert.ts` — restored ContentPart[] code path
- `packages/opencode-codex-provider/src/convert.test.ts` — assertions back to role-based; added explicit content shape check for all three (all ContentPart[])

## Verification

```
bun test src/convert.test.ts   18 pass / 1 pre-existing fail
```

## Closing

This was the last lever I had. The 4608 cache floor is server-side. The architectural realign work stands on its own merit — chain stable, no false-empty resets, prompt structure aligned with upstream — and we accept whatever cache OpenAI provides going forward.

