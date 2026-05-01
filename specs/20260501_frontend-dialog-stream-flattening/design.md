# Design

## Product Model

The dialog stream is a single canvas that grows downward. Each visible item is a card. Engineering terms such as `turn`, `part`, `embedded variant`, or `output shell` are implementation details and should not leak into product-level structure.

## Target Conceptual Structure

```txt
CurrentScreenShell (preserved)
  Header
  Sidebar
  StreamWindow
    StreamTitleBar(session name)
    DialogStreamCanvas
      UserInputCard
      AssistantTextCard
      ToolCallCard
      ToolResultCard
      ErrorCard
      TurnStatusLine
  TextInputBox
```

The shell above describes current UI structure that must be preserved. The target change is limited to flattening the contents of `DialogStreamCanvas`; `Header`, `Sidebar`, `StreamWindow`, `StreamTitleBar`, and `TextInputBox` are not redesign targets.

## Current-to-target mapping

| Current implementation concept     | Product-level target           | Merge direction                                                                            |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `SessionStreamPanel` shell         | `DialogStreamCanvas`           | Keep one stream shell; do not expose output-card/scroll/header as separate product layers. |
| `TaskSessionOutput` data adapter   | `DialogStreamCanvas` internals | Merge behind the stream canvas public API.                                                 |
| `SessionTurn` + part renderers     | Stream card renderer internals | Keep as implementation detail; user-facing model is card types.                            |
| prompt-dock/status-footer attempts | `TurnStatusLine`               | Remove competing status surfaces for dialog stream progress.                               |
| Dialog/Kobalte layers              | Dialog frame                   | Keep separate for accessibility and focus handling.                                        |

## Merge candidates

- Merge `SessionStreamPanel` and `TaskSessionOutput` into one public stream component.
- Keep `SessionTurn`/part rendering internally reusable, but expose card-oriented naming at the dialog stream boundary.
- Collapse compaction/thinking/tool-running UI status into the turn status line.
- Do not merge Dialog/Kobalte accessibility primitives in this plan.

## Decisions

- **DD-1** The UI should not model a visible runloop bubble/container. Frontend cards may consume backend message/part data, but DOM layout should remain flat from the user's perspective.
- **DD-2** All live status display goes through the turn status line: thinking, compacting, running tool, waiting, failed, completed.
- **DD-3** Assistant text remains the primary streaming card. Tool calls/results/errors append as stream cards in event order.
- **DD-4** Backend traceability, debug, retry, and runloop semantics stay in session/event data, not frontend DOM grouping.
- **DD-5** Dialog/Kobalte accessibility boundaries remain until a dedicated accessibility-safe simplification is planned.
- **DD-6** Tool call cards are card boundaries only in this plan. They are not required to expose a unified expandable content model; each tool call card may own its own internal world and can be specified separately later.
- **DD-7** Implementation scope is TaskDetail embedded dialog stream only. The full session page is out of scope for this first slice.
- **DD-8** Keep the Output title row and Clear action in TaskDetail; flatten only the stream area inside that shell.
- **DD-9** Do not add tool call expand/collapse behavior in this plan. Preserve existing tool card display.
- **DD-10** Status convergence applies only to TaskDetail embedded stream live status in this slice; broader session-page compaction/toast convergence is deferred.
- **DD-11** The bottom-follow / anchor-jump issue is a first-class frontend layout motivation. Flattening must establish a single scroll owner and a predictable anchor contract for the embedded dialog stream.
- **DD-12** Whole-screen layout preserves existing product regions: header, sidebar, central stream window with session-name title bar, and bottom text input box. Dialog stream work must not create additional product-level regions.
- **DD-13** TaskDetail's outer page scroll (`packages/app/src/pages/task-list/task-detail.tsx:343` — `<div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">`) is the canonical single scroll owner per DD-11. The dialog stream's current inner `overflow-y-auto resize-y` (line 701, inside `SessionStreamPanel`) is the wrapper to remove. ExecLog's inner scroll (line 458) is OUT OF SCOPE for this plan — it is a separate card with bounded scroll by design and not part of the dialog stream. Removing one inner scroll, leaving the other, is intentional and consistent with DD-7's TaskDetail-only narrow slice.
- **DD-14** TaskDetail does not render the SessionPromptDock and therefore does not use the dock-anchored status-line path that the full session page now uses. SessionTurn embedded variant's existing inline status line (rendered at the end of the last user message turn, inside `[data-component="session-turn"]` CSS scope) is the single status surface for TaskDetail per R2. No `inlineStatus={false}` / `onStatusLineChange` wiring is added to TaskDetail in this plan.

## Critical Files

- `packages/app/src/pages/task-list/task-detail.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/ui/src/components/session-turn.tsx`
- `packages/ui/src/components/session-turn.css`

## Risks

- Accidentally altering message reducer/id behavior while only intending layout simplification.
- Moving status display to a new competing UI path instead of reusing the turn status line.
- Creating nested scroll owners while flattening visual containers.
- Leaving hidden spacer/anchor ownership in removed wrappers, causing bottom-follow to keep jumping even after visual flattening.
- Creating a parallel visible region such as a footer/status strip outside the stream window, violating the four-region screen model.

## Layout deformation risk assessment

The flattening target is not a visual redesign. All output content remains cards on the canvas. The plan only removes redundant large bubble/container wrappers and must preserve the basic composition of existing cards.

| Risk                                                    | Why it can happen after container removal                                          | Guardrail                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Card width changes                                      | Removed wrapper may currently constrain max width or horizontal padding            | Preserve canvas/card width rules before deleting wrapper classes                                       |
| Card spacing collapses                                  | Wrapper may provide `gap`, `space-y`, margin, or border separation                 | Move spacing responsibility to `DialogStreamCanvas`, not individual card internals                     |
| Card internal padding changes                           | Refactor may accidentally move padding from card to wrapper or vice versa          | Treat card padding as part of the card's basic composition; do not change it in this plan              |
| Scroll behavior changes                                 | Wrapper may be the current scroll owner or height limiter                          | Keep exactly one explicit scroll owner at canvas level                                                 |
| Bottom-follow / anchor jumps persist                    | Hidden spacer or nested wrapper may still control the effective bottom anchor      | Define the canvas bottom anchor and follow-bottom behavior as owned by `DialogStreamCanvas`            |
| Status line shifts                                      | Status line may currently depend on wrapper bottom padding or spacer               | Preserve turn status line placement while removing competing footer/status paths                       |
| Tool/result visual grouping changes                     | Tool cards may rely on parent indentation or border context                        | Preserve existing tool card content and local grouping; only remove outer bubble wrapper               |
| Tool card over-standardization                          | Flattening may accidentally force all tool calls into one expandable content model | Treat tool call cards as independent card boundaries; do not define their internal worlds in this plan |
| Empty/loading/error states become visually inconsistent | Shell wrappers often own these states                                              | Keep empty/loading/error as canvas-level cards or states with equivalent spacing                       |

### Non-goals for this plan

- Do not redesign card visuals.
- Do not redesign the whole app shell beyond preserving the current header/sidebar/stream-window-with-title-bar/text-input model.
- Do not change card internal composition.
- Do not require tool call cards to support unified expansion or shared internal content structure.
- Do not flatten by deleting CSS blindly.
- Do not change message/part rendering semantics.

### Safe implementation rule

Remove one wrapper at a time and reassign only the layout responsibility that wrapper actually owned: width, spacing, scroll, or status placement. If a wrapper owns card content structure rather than only outer bubble layout, it is not removable in this plan.

## Wrapper inventory (TaskDetail dialog stream — code-grounded, 2026-05-01)

Read of `packages/app/src/pages/task-list/task-detail.tsx`, `packages/ui/src/components/session-turn.tsx`. Line numbers may drift; treat them as anchors not promises.

| Layer | File:line | Class / role | Owns | Action |
|---|---|---|---|---|
| Outer page scroll | task-detail.tsx:343 | `flex-1 overflow-y-auto px-4 py-3 space-y-3` | Single scroll owner for the whole TaskDetail body; `space-y-3` provides inter-card gap | **Keep** (canonical owner per DD-13) |
| Prompt card | task-detail.tsx:345 | `rounded-lg border border-border-base bg-background-base` | Bordered bubble for name + prompt fields | Keep — not part of dialog stream |
| Output card outer | task-detail.tsx:689 (inside SessionStreamPanel) | `rounded-lg border border-border-base bg-background-base overflow-hidden` | Output title row + Clear button + dialog stream container | **Keep** (DD-8) |
| Output title row | task-detail.tsx:690 | `flex items-center justify-between px-3 py-2 border-b border-border-weak-base` | "Output" label + Clear button | Keep (DD-8) |
| **Output stream inner scroll** | **task-detail.tsx:701** | **`overflow-y-auto resize-y` + `min-height/height/max-height` inline style** | **Bounded inner scroll viewport for the dialog stream** | **Remove (this plan's target wrapper, per DD-13)** |
| TaskSessionOutput | task-detail.tsx:636-677 | `<For userMessages>` over `<SessionTurn variant="embedded">` | Per-turn renderer for the dialog stream | Keep contents; consider folding component-API-wise into SessionStreamPanel (task 2.C) |
| ExecLog card | task-detail.tsx:432, 458 | `rounded-lg ... overflow-hidden` + inner `overflow-y-auto resize-y` height 160px | Bounded scrollable execution log card | **Out of scope** (separate card; DD-13 explicitly excludes) |
| SessionTurn root | session-turn.tsx:976-981 | `data-component="session-turn"` `data-variant="embedded"` `min-w-0 w-full` | Per-turn root; carries the CSS scope for `[data-slot="session-turn-status-inline"]` rules | Keep unchanged |
| SessionTurn content | session-turn.tsx:983-984 | `data-slot="session-turn-content"` `flex flex-col` | Per-turn vertical layout of message-container, retry, assistant parts, status line | Keep unchanged |
| SessionTurn message-container | session-turn.tsx:991-993 | `data-slot="session-turn-message-container"` `w-full px-3` + (CSS) `flex flex-col gap: 18px` | Vertical gap between attachments / user msg / retry / assistant content / status line | Keep unchanged |

### Single-owner consequence

After removing the inner scroll at task-detail.tsx:701, the dialog stream becomes a content-driven section inside the bordered Output card. Total page height grows with stream length; the outer (line 343) scrollbar is the only one for the whole detail panel. The `resize-y` user affordance for manually resizing the dialog viewport is removed deliberately — bounded sub-scroll is what produced the multi-owner anchor confusion (DD-11).

### What this plan does NOT touch in TaskDetail

- ExecLog inner scroll (line 458) — separate card, separate concern.
- The outer page scroll (line 343) — canonical owner.
- `<SessionTurn variant="embedded">` internals.
- Backend session/event/reducer code.
- `MessageTimeline` and `session.tsx` (full session page) — DD-7.

## Validation Strategy

- Focused app typecheck.
- Focused browser builds for touched UI entry files.
- `git diff --check`.
- Follow-bottom/anchor manual check: while new cards/streaming text append, the embedded dialog stream should stay pinned to the bottom only when the user is already at bottom, and should not jump when the user has scrolled away.
- Manual UI verification after approved reload: dialog stream remains readable, streaming text updates, tool cards render, status line handles compaction/thinking.
