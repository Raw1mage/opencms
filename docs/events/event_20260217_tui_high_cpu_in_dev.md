# event_20260217_tui_high_cpu_in_dev

## Context

Running the OpenCode TUI via `bun run dev` was observed to keep CPU usage at ~100%+ (often >1 core) even when the user was not interacting with the TUI.

This made "self-hosting" development (using the TUI to work on this repo) expensive and noisy.

## Findings

- The default `dev` script enabled `OPENCODE_DEBUG_LOG=1`, which activates `debugCheckpoint()` logging.
- `debugCheckpoint()` currently writes using `fs.appendFileSync()` and also triggers normalization work, which adds constant overhead when many checkpoints fire.
- Independently, the TUI renderer can still be CPU-intensive depending on terminal/host environment. We added configuration hooks to help throttle render work for diagnosis.

## Decision

1. Make `bun run dev` _not_ enable debug logging by default.

- New scripts:
  - `dev` (default): no `OPENCODE_DEBUG_LOG`
  - `dev:debug`: preserves the previous behavior with `OPENCODE_DEBUG_LOG=1`

2. Add TUI-side configuration knobs for experimentation:

- `OPENCODE_TUI_FPS` to set `targetFps` (and align `maxFps`).
- Optional `OPENCODE_TUI_USE_THREAD` and `OPENCODE_TUI_GATHER_STATS` passthrough to the renderer config.

3. Improve default behavior in VS Code integrated terminal:

- Default lower FPS (`15`) and higher resize debounce (`250ms`) when `TERM_PROGRAM=vscode` (or related envs).
- Default mouse disabled in VS Code terminal to reduce idle event churn.
- Keep overrides available via:
  - `OPENCODE_TUI_MOUSE=1|0`
  - `OPENCODE_TUI_MOUSE_MOVE=1`
  - `OPENCODE_TUI_DEBOUNCE_MS=<ms>`

## Risks / Notes

- Developers relying on `debug.log` output during normal `dev` will need to use `bun run dev:debug`.
- The render throttling env vars are intended for diagnostics/perf tuning and should not be treated as stable API without further documentation.

## Additional investigation (2026-02-18)

- Reproduced with `bun run dev` under VS Code-like env (`TERM_PROGRAM=vscode`):
  - `bun --conditions=browser ./packages/opencode/src/index.ts` remained ~125-135% CPU after 60s idle.
  - Multiple MCP launcher processes (`npm exec ...`) also showed high transient/steady CPU.
- Bun CPU profile in this mode points to heavy activity in:
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` (quota-related resources/effects)
  - account display/lookup code (`account/index.ts:getDisplayName`, `getActive`)
  - parsing-heavy native work and MCP-related background activity.

### Mitigation added

- Prompt footer refresh interval throttled from 2s to 15s default (`OPENCODE_TUI_FOOTER_REFRESH_MS` override).
- Guarded quota refresh effect with a dedupe marker to avoid repeated refresh triggers from same completed message.

### Current status

- This mitigation alone did not materially reduce idle CPU in synthetic VS Code runs.
- Next likely bottleneck is MCP background process behavior/polling rather than pure render FPS.
