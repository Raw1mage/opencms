# Frontend Dialog Stream Flattening

## Goal

Flatten the frontend dialog/task stream display model into a single continuously growing canvas of cards.

## User Requirement

The dialog stream should be understood as one canvas. User inputs, assistant outputs, tool calls, tool results, errors, and status updates are cards appended to that canvas. Runtime/status tracking should use the existing turn status line, not separate footers, bubbles, or hidden frontend group containers.

At the whole-screen level, the current layout model is intentionally simple and must be preserved: one header, one sidebar, one central streaming window with its own title bar showing the session name, and one bottom text input box. Dialog stream flattening must reinforce this existing shell instead of introducing parallel regions such as hidden bubbles, extra footers, or nested stream universes.

## Motivation

The long-running bottom-follow / anchor-jump instability is treated as a frontend ownership problem, not a backend execution problem. Prior patch-style fixes around footer position, status display, or scroll padding did not produce a stable result because the stream currently mixes multiple layout wrappers, status surfaces, and scroll/spacer responsibilities.

This plan therefore aims to make the frontend stream model explicit: one canvas, one scroll owner, card-like visible content, and one turn status line. The expected benefit is not only simpler markup, but a clearer anchor/follow-bottom contract that can be verified and maintained.

## Scope

### In

- Define the product model as `DialogStreamCanvas` + stream cards.
- Preserve the existing whole-screen layout model: header, sidebar, stream window with session-name title bar, text input box.
- Keep frontend-only display behavior separate from backend/session execution semantics.
- Reduce wrapper/container concepts in embedded dialog/task session stream surfaces.
- Establish one clear scroll/anchor ownership model for the embedded dialog stream.
- Preserve existing session/event data reducers and message/part IDs.
- Consolidate compaction/thinking/running-tool display onto the turn status line.

### Out

- No backend runloop behavior change.
- No tool execution contract change.
- No change to session DB/message storage schema.
- No removal of Dialog/Kobalte accessibility primitives unless separately proven safe.

## Constraints

- Do not add fallback display paths.
- Do not introduce frontend runloop group state for debugging/retry.
- Scroll ownership must remain explicit and single per embedded stream surface.
- Implementation must be verifiable without requiring daemon/gateway restart unless explicitly approved.

## Revision History

- 2026-05-01: Created after user clarified the desired model: a flat canvas where everything is a card and all live state is represented by the turn status line.
