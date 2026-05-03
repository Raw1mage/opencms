# Proposal: attachment-lifecycle

## Why

User-uploaded attachments (images, PDFs, files) currently stay in conversation history forever. Every subsequent LLM call re-sends the full binary, even after the model has already processed and responded to the content. Real-world impact in production session `ses_211c853fcfferC149YUFem6mN4` (codex GPT-5.5, 2026-05-04):

- 10 PNG screenshots uploaded across 9 user turns
- ~188K estimated image tokens accumulated
- Every turn after upload sends ALL prior images again
- 99% Anthropic-style prompt cache hit only saves time + cost-per-byte; the **input token quota is still consumed** on every re-send (image tokens count against weekly `usage_limit_reached` even when cached)

The model rarely needs to re-look at an image once it has responded to it. A "post-read dehydration with retrieval fallback" pattern would dramatically cut token cost without sacrificing recall.

## Original Requirement Wording (Baseline)

- "問題是每張貼圖之後 AI 讀過圖了之後就不需要留在 context 了吧？" (2026-05-04)
- "我覺得是一個很小的 hotfix，每張圖上傳後 AI 讀了給它留一個解讀後的註解，圖就不用留了。但圖的原檔可以在 /incoming 中暫留一陣子，萬一同一 session 對話稍後 AI 覺得剛剛讀過的什麼圖還需要再看一眼，還能再叫回來讀一下。" (2026-05-04)

## Requirement Revision History

- 2026-05-04: initial draft (proposal-only at this stage)

## Effective Requirement Description

1. **Post-read dehydration**: After the assistant turn that consumed an attachment finishes (`finish="stop"`), replace the `attachment_ref` part in conversation history with a **dehydrated stub** containing:
   - Original filename
   - sha256 of the binary
   - A short annotation derived from the assistant's response (or a small dedicated annotation pass)
   - A pointer to the staged binary (e.g. `/incoming/<sessionID>/<filename>`)
   - Instruction that the model can re-read via a tool if needed

2. **`/incoming` staging**: The original binary is moved from the session's attachment storage to a staging area (`~/.local/state/opencode/incoming/<sessionID>/<filename>` or similar). Retained for the session lifetime + a TTL (default 24h after `session.deleted`, then GC'd).

3. **Re-read tool**: A new tool (working name `reread_attachment`) lets the model pull a staged binary back as a fresh attachment in the next turn:
   ```
   reread_attachment(filename: string) → { type: "image", url: ..., est_tokens: ... }
   ```
   Tool description tells the model when to use it.

4. **Cache-friendliness preserved**: The dehydrated stub is byte-stable. Replacing the binary is a one-time conversation history rewrite that invalidates BP4 once for that turn but yields massive savings on subsequent turns.

5. **Compatibility with Phase A/B compaction**: This sits orthogonal to compaction. Compaction still operates on the full conversation history; dehydrated stubs are smaller so compaction has less work. Phase A's skill auto-pin / sanitizer logic is unaffected.

## Scope

### IN

- Extend `attachment_ref` part schema (or new `attachment_dehydrated` type) with optional dehydration metadata
- Storage migration: move binary from per-session sqlite `attachments` table → filesystem `/incoming/<sessionID>/<filename>` on dehydration
- New `reread_attachment` tool registered in tool registry
- Dehydration trigger: post-assistant-completion hook in `processor.ts` or a dedicated background task
- Annotation generation strategy
- `/incoming` GC policy + cleanup hook on `session.deleted`
- Telemetry: `attachment.dehydrated`, `attachment.rereaded`, `attachment.gc'd`

### OUT

- Pre-emptive image compression (separate concern)
- Audio / video attachment handling (out of scope; image + PDF only for v1)
- Cross-session attachment sharing (no shared `/incoming`)
- UI changes beyond optional "compressed" badge

## Non-Goals

- Replacing prompt cache (Phase B handled cache-prefix architecture)
- Building a general-purpose file content-addressable store
- Forcing the model to call `reread_attachment` — opt-in based on model's judgment

## Constraints

- The session sqlite `attachments` table currently holds the binary; moving to filesystem must preserve referential integrity via `attachment_ref.payload_json.ref_id`
- Re-read tool result must produce a valid `MessageV2` part schema (likely tool-result with embedded image)
- Dehydration must be reversible during the staging window; after GC it's gone
- Cannot dehydrate attachments mid-turn (must wait for `finish="stop"`)
- Subagent path must work too (delegate may share parent attachments via prefix)

## What Changes

- `packages/opencode/src/session/message-v2.ts`: extend `attachment_ref` part with optional dehydration metadata
- `packages/opencode/src/session/storage/incoming-store.ts` (NEW): wraps `/incoming/<sessionID>/` filesystem operations
- `packages/opencode/src/session/processor.ts`: post-completion hook scans parent user message for `attachment_ref` parts → triggers dehydration
- `packages/opencode/src/tool/reread-attachment.ts` (NEW): the re-read tool implementation
- `packages/opencode/src/session/index.ts session.deleted Bus subscription`: add cleanup of `/incoming/<sessionID>/`
- `packages/opencode/src/session/attachment-annotator.ts` (NEW, maybe): generate annotation from response text or via small LLM call
- New tweaks.cfg entries: `attachment_dehydrate_enabled`, `attachment_incoming_ttl_seconds`, `attachment_annotation_strategy`

## Capabilities

### New Capabilities

- **Post-read dehydration**: attachments collapse to small text annotations after first use
- **`/incoming` staging**: binaries kept in filesystem retrieval store for in-session re-fetch
- **`reread_attachment` tool**: model self-service for re-reading

### Modified Capabilities

- **`attachment_ref` part**: optional dehydration fields; serialization roundtrip preserves them
- **`Session.messages`**: returns dehydrated form by default; reread injects fresh form
- **`session.deleted` Bus subscriber**: also cleans `/incoming/<sessionID>/`

## Impact

- **Token savings**: For sessions like `ses_211c853fcffer...` (10 images, 188K tokens), dehydration cuts ~150K+ recurring tokens per turn after the first. Weekly `usage_limit_reached` budget recovers proportionally.
- **Cache invalidation**: One-time BP4 invalidation per dehydrated turn; subsequent turns benefit from smaller, more cacheable conversation tail.
- **Disk usage**: `/incoming/<sessionID>/` accumulates binaries until GC. Typical sessions (10-20 images × 50KB avg = 500KB–1MB per session). 24h post-`session.deleted` TTL keeps disk pressure modest.
- **Model behavior**: needs prompt update telling model that dehydrated attachments can be re-read via tool. Could live in Phase B preface T1 (or static system block, depending on universality).
- **Compaction interaction**: smaller conversation history → compaction triggers later → fewer compaction events.
- **Plugin contract**: new optional Bus event `attachment.dehydrated` for plugins to observe.
- **Backward compat**: Old sessions with non-dehydrated attachments continue to work; dehydration is forward-only.

## Open Questions (resolve in `designed` phase)

1. **Annotation source**: response text? dedicated tiny LLM call? model-emitted inline marker?
2. **Storage location**: `~/.local/state/opencode/incoming/<sessionID>/` (state dir, GC'd on `session.deleted`) vs `Instance.directory/.incoming/` (project-relative, survives across sessions in same directory)?
3. **Trigger granularity**: dehydrate ALL attachments in a turn, or only those the response referenced? Latter requires response analysis.
4. **TTL default**: 24h after `session.deleted`? Until daemon restart? Configurable.
5. **Subagent attachments**: when subagent receives parent context with attachments, does its dehydration write back to parent's `/incoming` or its own?
6. **Multi-modal**: text/PDF attachments — same flow?
