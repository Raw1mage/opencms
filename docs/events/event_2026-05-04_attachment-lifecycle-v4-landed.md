# 2026-05-04 — attachment-lifecycle v4 (image inline via preface trailing tier)

Spec: [specs/attachment-lifecycle/](../../specs/attachment-lifecycle/)
Branch: `beta/attachment-lifecycle`
Spec amendment commit (main): `02483e13d`
Builds on: `prompt-cache-and-compaction-hardening` Phase B (preface trailing tier + 4-breakpoint cache plan)

## Why v4

User insight: "大變動應該要組在context最後面，來減少static portion的變動。這件事就是我們另一個branch試圖優化的事不是嗎."

v3's design routed image binary INTO conversation history (user message inline + dehydrate-by-mutation). That violated Phase B's "static-front, dynamic-back" cache locality discipline — every image upload mutated historical bytes and broke the BP1-BP3 cache prefix.

v4 routes image binary into the **preface trailing tier (BP4 zone)** instead. Conversation history bytes stay byte-stable forever. No dehydration flag, no annotation field on attachment_ref. Per-turn image churn rides the same per-turn cache invalidation that already accepts churn (lazy catalog hints, structured-output directives).

## Architecture

```
User uploads image →
  [prompt.ts] persistUserMessage →
  addOnUpload(prior, msg.parts) →
  Session.setActiveImageRefs(sessionID, next)

Next assistant turn →
  [llm.ts] read session.execution.activeImageRefs →
  scan messages for matching attachment_refs (filename + repo_path + image/*) →
  buildActiveImageContentBlocks(refs, refsByFilename, projectRoot) →
    read bytes via IncomingPaths.projectRoot() + repo_path →
    emit data: URIs as {type:"file", tier:"trailing"} blocks →
  buildPreface({...prefaceInput, activeImageBlocks}) →
    file blocks become the LAST contentBlocks entries →
    NEVER carry Phase B breakpoint marker (no cache pin) →
  llm.ts wire mapper:
    if b.type === "file" → emit AI SDK {type:"file", data, mediaType, filename}
    else → existing text/breakpoint logic →
  Outbound user-role message has [t1 text + BP2, t2 text + BP3, trailing text, image1, image2, …]

Assistant finish (any reason, R9 mitigation) →
  [processor.ts] Session.setActiveImageRefs(sessionID, [])

Model needs the image again later →
  reread_attachment(filename) →
    findInlineableAttachment(messages, filename) →
    addOnReread(prior, filename) →
    Session.setActiveImageRefs(sessionID, next) →
    return text voucher: "Image '<filename>' queued for inline viewing on your next turn."
  → next turn, the buildPreface flow above re-emits the image
```

Key invariant: **conversation history bytes never mutate**. The active set is per-turn ephemeral state on `session.execution`. The same image inlining path is used both for fresh uploads (auto-queued) and for explicit rereads (voucher tool).

## Done

### T.1 — foundation (commit `4ca21e8f4`)

- [packages/opencode/src/session/index.ts:251-258](../../packages/opencode/src/session/index.ts#L251-L258) — `Session.ExecutionIdentity` schema gains optional `activeImageRefs: z.array(z.string()).optional()` (DD-20). Backwards compatible — old sessions parse to `undefined`.
- [packages/opencode/src/session/active-image-refs.ts](../../packages/opencode/src/session/active-image-refs.ts) — pure helper module with three operations: `addOnUpload(prior, parts, {max})`, `addOnReread(prior, filename, {max})`, `drainAfterAssistant(prior)`. Schema-agnostic (structural part shape) so unit-testable without Session boot. FIFO cap defaults to 3.
- [packages/opencode/src/config/tweaks.ts](../../packages/opencode/src/config/tweaks.ts) — adds `AttachmentInlineConfig` ({enabled, activeSetMax}); cfg keys `attachment_inline_enabled` (default true) and `attachment_active_set_max` (default 3, range 1-20). `attachmentInlineSync()` accessor for hot-path consumers.
- 24 new unit tests (5 schema roundtrip / 14 pure-helper / 5 tweaks).

### T.2 — preface emitter + lifecycle wiring (commits `6c2199b26`, `cea60aeb0`)

- [packages/opencode/src/session/context-preface-types.ts:59-66](../../packages/opencode/src/session/context-preface-types.ts#L59-L66) — `PrefaceContentBlock` becomes a discriminated union; trailing tier may now carry `{type:"file", url, mediaType, filename}` blocks (DD-19).
- [packages/opencode/src/session/context-preface.ts](../../packages/opencode/src/session/context-preface.ts) — `buildPreface` accepts `activeImageBlocks` and appends them as the LAST `contentBlocks` entries. New `buildActiveImageContentBlocks(refs, refsByFilename, projectRoot)` reads bytes via fs and emits data URIs. Skips silently with telemetry on missing-ref / missing-file / non-image-mime.
- [packages/opencode/src/session/llm.ts](../../packages/opencode/src/session/llm.ts) — three previously text-only consumers (preface telemetry log, `prefaceContent` wire mapper, `promptTelemetryBlocks`) now branch on `b.type` to handle file blocks. File blocks pass through to AI SDK as `{type:"file", data, mediaType, filename}`. They never carry the Phase B breakpoint marker — they ride BP4 with the following user message.
- [packages/opencode/src/session/index.ts:714-727](../../packages/opencode/src/session/index.ts#L714-L727) — `Session.setActiveImageRefs(sessionID, refs)` setter; no-op when no execution identity yet, otherwise replaces and persists via `Session.update`.
- [packages/opencode/src/session/prompt.ts:2419-2438](../../packages/opencode/src/session/prompt.ts#L2419-L2438) — upload hook after `persistUserMessage`. Reads tweak gate, scans freshly-committed parts for image attachment_refs, computes next set via `addOnUpload`, only writes when changed. All failures swallowed.
- [packages/opencode/src/session/processor.ts:1152-1166](../../packages/opencode/src/session/processor.ts#L1152-L1166) — drain hook after `Session.updateMessage(input.assistantMessage)`. Unconditionally clears `activeImageRefs` regardless of `finishReason` (R9 mitigation — stuck/erroring turn must not leave images queued).
- 28 new unit tests (9 inline emitter + 2 placement + 11 preface regression + 6 lifecycle scenarios).

### T.3 — voucher reread tool (commit `a8e56e534`)

- [packages/opencode/src/tool/reread-attachment.ts](../../packages/opencode/src/tool/reread-attachment.ts) — new `reread_attachment` tool. Input `{filename}`. Returns a TEXT voucher (no binary): "Image '<filename>' queued for inline viewing on your next turn." The actual pixels appear via the standard preface-trailing-tier path on the next turn. Tweaks gate returns an early text pointing the model at `attachment(mode=read, agent=vision)` instead.
- [packages/opencode/src/tool/registry.ts](../../packages/opencode/src/tool/registry.ts) — registered (lazy-loaded; not in `ALWAYS_PRESENT_TOOLS`; tool_loader catalog surfaces it on demand).
- 6 unit tests for `findInlineableAttachment` pure helper (empty / no-match / match / no-repo_path / non-image-mime / newest-first across messages).

## Tests

Total v4 + Phase B regression suite (selective): **111 / 111 pass**.

Full session/+tool/+config/ sweep: 445 pass / 14 fail. The 14 failures are pre-existing test-isolation issues that existed on baseline before T.1; running the affected test files individually they all pass. Failure cluster (Session.X = undefined when many session/* tests share the test runner process) was present on baseline `main` as well — not introduced by v4. Storage-hardening test failures are pre-existing per spec tasks.md T.5.2 ("excluding pre-existing share-next.ts noise").

Typecheck: clean for all v4-touched files (`packages/opencode/src/session/{llm,context-preface,context-preface-types,active-image-refs,index,prompt,processor}.ts`, `packages/opencode/src/config/tweaks.ts`, `packages/opencode/src/tool/{reread-attachment,registry}.ts`).

## Stop gates

- T.5.3 / T.5.4 manual smoke (upload → observe inline → next turn shows image; ask model to reread → confirm voucher fires) — pending daemon restart consent per `feedback_restart_daemon_consent`.
- T.5.7 STOP for user finalize approval before merging beta into main and cleaning up.

## Cache structure preserved

Before v4 (v3's flawed approach):
```
[BP1: static system]                    ← stable
[BP2: preface T1]                       ← stable
[BP3: preface T2]                       ← stable
[BP4: user message + image bytes inline] ← per-turn churn (OK)
[OLDER user message + image bytes]       ← MUTATED by v3 dehydration → broke BP1-BP3 prefix
```

After v4:
```
[BP1: static system]                                      ← stable
[BP2: preface T1]                                         ← stable
[BP3: preface T2]                                         ← stable
[trailing: lazy catalog + active image1, image2, …]       ← per-turn churn (OK, BP4 zone)
[BP4: user message]                                       ← per-turn churn (OK)
[OLDER user message — attachment_ref UNCHANGED]            ← stable bytes preserved forever
```

Token-saving guarantee maintained: a 3-image session that previously incurred ~570KB of historical attachment bytes per turn now incurs that cost ONCE per active set lifetime (one turn) and falls back to attachment_ref text after drain. Reread voucher gives the model a path back to the pixels without ever re-mutating history.
