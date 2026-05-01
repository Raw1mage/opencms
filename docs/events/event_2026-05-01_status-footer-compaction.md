# Event: status-footer-compaction

## 需求

- Hotfix：compaction progress 改用 status footer 顯示，不再主要用 toast 顯示進度。

## 範圍(IN/OUT)

- IN: Web session page 的 compaction started / compacted UI 顯示路徑。
- IN: 重用現有 session prompt dock / status footer 區域顯示短暫狀態。
- OUT: 不改 compaction 核心流程、provider routing、anchor 寫入或 backend event contract。

## 任務清單

- 將 foreground compaction loading toast 改為 status footer 狀態。
- compaction 結束時清除 footer 狀態。
- 保留必要的錯誤/阻塞以 fail-fast；不新增 fallback。

## Debug Checkpoints

- Baseline: backend 已發 `session.compaction.started` / `session.compacted`；Web app 目前在 `packages/app/src/pages/session.tsx` 用 persistent toast 顯示 foreground compaction progress。
- Instrumentation Plan: 只改前端 event listener 與 `SessionPromptDock` 顯示，驗證 typecheck / focused test 可通過。

## Verification

- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260501-1458-status-footer-compaction`（白名單快照；僅供需要時手動還原）。
- Follow-up: status footer is rendered below the prompt input and anchored about three lines lower via `SessionPromptDock` (`-mb-12`).
- `bun --filter @opencode-ai/app typecheck` blocked by pre-existing `packages/ui/src/components/session-review.tsx` `FileDiff.before/after` type errors; no error was reported for the changed status footer file.
- Duplicate final diagnosis: backend log showed one stored assistant message for the duplicated final, while `part.updated` for the same part was forwarded on two SSE connections. `packages/app/src/context/global-sdk.tsx` now keeps a short 2s recently-seen full-event key cache after flush, so duplicate full `message.part.updated` replays from overlapping streams are ignored. Delta events remain unkeyed and are not deduped to avoid dropping streamed text.
- `bun --filter @opencode-ai/app typecheck` remains blocked by the same pre-existing `packages/ui/src/components/session-review.tsx` `FileDiff.before/after` type errors; no error was reported for `global-sdk.tsx`.
- Follow-up fix: manual `/compact` still used `showPromiseToast`; `packages/app/src/pages/session/use-session-commands.tsx` now drives the same `compactionStatus` footer state and only uses toast for failures.
- Typecheck blocker fixed: `packages/ui/src/components/session-review.tsx` no longer assumes metadata-only `FileDiff` has `before` / `after` bodies. It only reads legacy content through explicit compatibility helpers; current metadata-only diffs typecheck cleanly.
- Verification: `bun --filter @opencode-ai/app typecheck` passes.
- Architecture Sync: Verified (No doc changes beyond existing status-footer and metadata-only diff notes); this is a UI routing/type compatibility hotfix and does not change backend session DB or compaction event contracts.
- Correction: the intended target is the `SessionTurn` status line (`ui.sessionTurn.status.consideringNextSteps`, e.g. "正在考慮下一步"), not `SessionPromptDock`. `packages/ui/src/components/session-turn.tsx` now accepts `statusOverride`, and `packages/app/src/pages/session/message-timeline.tsx` passes compaction status to the last user turn.
- Position follow-up: attempted `session-turn-status-inline { transform: translateY(24px) }`; user reports position still unchanged after reload, so exact layout control remains unresolved and needs DOM measurement before further adjustment.
- Logout bug found during validation: in gateway mode, SPA logout cleared JWT but then stayed inside daemon SPA and navigated to `/`, causing daemon login flicker. `packages/app/src/context/web-auth.tsx` now hard redirects with `window.location.replace("/")` when `enabled() === false`, and `packages/app/src/pages/layout.tsx` skips the post-logout SPA navigation in gateway mode.
- Verification: `bun --filter @opencode-ai/app typecheck` passes after status-line routing and gateway logout fix.
- Logout follow-up: user confirmed the flicker persisted and clarified that the daemon `OpenCode Login` page has no role in gateway mode. `packages/app/src/components/auth-gate.tsx` no longer renders the `OpenCode Login` username/password form; unauthenticated state clears `oc_jwt` once and redirects to `/`, with only a temporary redirect message as fallback.
- Verification: `bun --filter @opencode-ai/app typecheck` passes; grep confirms no `OpenCode Login` / password form strings remain in `packages/app/src`.
- Gateway ownership correction: logout/session is gateway-owned, not daemon-owned. `packages/app/src/context/web-auth.tsx` now top-level navigates to `${server.url}/global/auth/logout` in gateway mode instead of fetch/refetch/navigate. `daemon/opencode-gateway.c` now handles `/global/auth/logout` as a gateway redirect endpoint: clear `oc_jwt` and return `303 Location: /`, so the browser leaves daemon SPA and lets gateway decide proxy status/login.
- Verification: `bun --filter @opencode-ai/app typecheck` passes. Gateway C change still requires controlled gateway/daemon reload before runtime validation.
- Status line positioning correction: read-only DOM/CSS investigation confirmed the visible `正在考慮下一步` line is `SessionTurn`'s `data-slot="session-turn-status-inline"`, but its distance from the prompt/viewport is dominated by `MessageTimeline`'s bottom spacer (`pb-[calc(var(--prompt-height)+64px)]`). The previous `transform: translateY(24px)` was removed because it only changes paint, not scroll-bottom layout. `MessageTimeline` now uses a smaller `+24px` bottom spacer only while `sessionBusy` or `statusOverride` is active, preserving the normal `+64px` spacer when idle. The earlier prompt dock padding experiment was reverted to `pb-4`.
- Verification: `bun --filter @opencode-ai/app typecheck` passes after the status-line spacer correction.
- Logout root cause correction: runtime test after restart still showed `/global/auth/logout` returning daemon-style `200 {"ok":true}`. Reading `daemon/opencode-gateway.c` showed gateway auth handlers were below the catch-all web-route proxy, so `/global/auth/logout` was matched by `/` and proxied into the daemon before the gateway handler could run. Gateway-owned `/global/auth/session`, `/global/auth/login`, and `/global/auth/logout` are now intercepted immediately after request parsing and before `match_web_route()`.
- Verification: `gcc -fsyntax-only -Wall -D_GNU_SOURCE daemon/opencode-gateway.c` passes; `bun --filter @opencode-ai/app typecheck` passes. Runtime validation still requires controlled gateway reload because this is a C gateway change.
