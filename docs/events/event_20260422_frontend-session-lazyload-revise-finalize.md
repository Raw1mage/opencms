# Event: frontend-session-lazyload revise — finalize + UX baseline

**Date**: 2026-04-22
**Spec**: `specs/frontend-session-lazyload/` (state=living)
**Final main commit**: `8da3bbf2e`
**Merge commit**: `8a4e2df4b` (test → main, --no-ff)

## Lifecycle closure

- `beta/frontend-session-lazyload-revise` → deleted (disposable per beta-workflow §8)
- `test/frontend-session-lazyload-revise` → deleted (disposable)
- `~/projects/opencode-beta` worktree path → preserved (permanent workspace, detached HEAD)
- Spec promoted verified → living; history records five transitions spanning the full revise cycle (new → designed → planned → implementing → verified → living)

## Verification evidence

### Automated

- `bun test` on merged test branch: 53/53 pass (R1 unit + invariant + R2 route + existing meta/tweaks/delete)
- `[SSE-REPLAY]` telemetry confirmed active (three `returned=0 boundary=none` handshakes on daemon restart)
- `[MESSAGES-CURSOR]` telemetry confirmed active — ~20 session-open events captured during smoke test, including one scroll-up cursor append (`before=msg_db46ffd26001shyx9dayHkCeOU limit=400 returned=64`)
- POST delivery 1:1 confirmed on both PC wired and mobile wireless paths (gateway `POST /prompt_async` matched by daemon `prompt_async inbound` 1-for-1)

### UX baseline (operator observation, 2026-04-22 mobile wireless, post-merge)

> 「不管切到哪一個 session，都是秒開到位。就好像早就等在那邊。完全不需要看到『加載中』的黑畫面。」

Mechanism:

- `GET /:id/message` defaults to tail (`session_messages_default_tail=30`; when client sends explicit `limit`, that wins but still tail-first)
- Response payload dropped from MB-class (full hydrate of long session) to KB-class (30–400 newest entries)
- Single mobile round-trip completes before the "loading" spinner can materialise
- SessionCache `messages:{id}:tail:{N}` key serves 304 on re-open → even faster on second visit

This replaces the previous Phase-2-skipped behaviour where cold open pulled the entire session history regardless of size.

## Regression baseline

Future regression in session-open latency should reproduce against this observation: **切換任意 session 應秒開，無 loading 黑畫面**. Drop from this baseline → run:

```sh
grep MESSAGES-CURSOR /run/user/<uid>/opencode-per-user-daemon.log | tail -20
```

If cold-open entries show `returned` approaching the full session's message count (instead of `≤ session_messages_default_tail` or the client's explicit `limit`), INV-9 has been broken.

## Residual items (not blocking living state)

- `specs/architecture.md` sync (Phase 5 of original plan — can land as `amend` mode later)
- Phases 1–4 of original plan (render-side part cap, escape hatch UI, scroll-spy) still `planned`; operator decides when to pick up
- Daemon observability full stack (log retention, event-loop lag sampler, HTTP latency histogram) — separate spec if needed
