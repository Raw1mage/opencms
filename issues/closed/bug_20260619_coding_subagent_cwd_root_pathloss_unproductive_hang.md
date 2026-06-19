# BUG: coding subagent worker spawned with cwd=`/` (no cwd + no repo-root in driver prompt) → 21-min path-guessing hang; alive-but-unproductive escapes both watchdog and paralysis guard

- **Date**: 2026-06-19
- **Reporter**: TheSmartAI (orchestrator)
- **Component**: opencode task subagent — worker spawn (`packages/opencode/src/tool/task.ts`), coding driver prompt (`packages/opencode/src/agent/prompt/coding.txt`), proc-watchdog (task.ts), paralysis Detector D (`packages/opencode/src/session/prompt.ts`)
- **Severity**: HIGH — a dispatched coding subagent can burn 20+ minutes (and the user's wall-clock) doing nothing, never self-terminating; every coding delegation in a daemon whose cwd≠repo is affected.
- **Status**: OPEN
- **Origin**: observed live in session ses_1211838a7ffeLfvsbXWYqYVsXJ while delegating the dispatcher-dedup fix to a `coding` subagent (child ses_120baa3f2ffef0kquDsbJ7ZRhS). Subagent ran 21 min, `status=running`, `lastActivityAt` flat, never read a single target file.

## Symptom (observed)

1. Orchestrator dispatched a `coding` subagent with absolute-ish target paths like `packages/opencode/src/tool/tool.ts`.
2. Worker's first `read` calls failed: `File not found: /Docker/opencode/packages/opencode/src/tool/tool.ts` — it had assumed a repo root that does not exist.
3. Worker then spent ~21 minutes guessing paths: `glob` with `path:/Docker/opencode` (error), `find /` (120s timeout scanning `/proc` + network mounts), `find /root /home /Docker ...`, `pwd` → **`/`**, repeated `grep` calls that hung at `status=running`.
4. It never located the repo, never read a target file, and self-narrated「偵查方向修正 / 偵查超時 / 重新定位」each turn — a 跳針 (perseveration) loop.
5. The proc-watchdog never killed it; the paralysis guard never fired. The orchestrator only noticed when the human asked "subagent卡了快一小時了".

## Root cause (three independent defects, stacked)

### RC-1 — worker process spawned WITHOUT cwd (primary)

`spawnWorker()` at `packages/opencode/src/tool/task.ts:842`:

```ts
const capturedDirectory = Instance.directory // line 840 — captured…
const proc = Bun.spawn(buildWorkerCmd(), {
  env: { ...process.env, OPENCODE_NON_INTERACTIVE: "1", OPENCODE_TASK_EVENT_BRIDGE: "1" },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  // ← NO `cwd:` option
})
```

`capturedDirectory` is used only for `Instance.provide({ directory })` around Bus event handlers (so Bus.publish resolves correct storage) — it is **never passed as the spawned process's working directory**. The worker therefore inherits the daemon's cwd, which is `/` (systemd/daemon launch dir). Every relative path the worker resolves becomes `/<path>` → not found. The `read` tool's workspace-relative resolution and `glob`'s `path` arg both anchor on cwd, so all of them miss.

### RC-2 — coding driver prompt never states the working directory / repo root

`packages/opencode/src/agent/prompt/coding.txt` says "Always use absolute paths for all file operations" (line 31) but **never tells the worker WHERE the repo is** — no cwd, no project root, no `<env>` block analogous to the main agent's environment context. Combined with RC-1 (cwd=`/`), the worker has zero anchor and resorts to guessing `/Docker/opencode`. This is the part of the user's question "難道是 system prompt 寫得不好" that is _true_: the coding driver omits the single most load-bearing fact a file-editing worker needs.

### RC-3 — "alive but unproductive" escapes BOTH safety nets

- **proc-watchdog** (`task.ts:2171`, `SILENCE_THRESHOLD_MS=60_000`): only judges the worker dead when `/proc/<pid>` CPU time, IO bytes, AND child processes stay flat for 60s. The hung worker fired a glob/grep every few seconds, so CPU/IO kept ticking → watchdog saw "alive" forever. A worker that is _busy doing useless work_ is never reaped.
- **paralysis Detector D** (`prompt.ts:detectPrefaceParalysis`, threshold 0.6): keys on the leading ~140-char preface bigram-jaccard AND requires "no file-mutating tool in the window". The worker's prefaces differed each turn (「偵查方向修正」vs「偵查超時」vs「重新定位」) → similarity < 0.6 → no trip. Same blind spot already noted for the orchestrator in event `dispatcher-dedup` scope: "diverging preface + real tool activity but zero progress" is detected by neither path.

## Why the 跳針 is the SAME class, not "a bad model"

The coding subagent runs the same runloop (`session/prompt.ts`) with the same Detector A/B/C/D. The perseveration is a detector blind spot, not a model fault: Detector D fires only on _short-prefix strong-repeat with no tool activity_. A worker (or orchestrator) that keeps tool-calling but makes no real progress, while varying its narration, slips through. The fix is in the guard's progress definition, not in scolding the model via prompt.

## Expected behaviour / fix options

### Fix A (RC-1, REQUIRED) — pass cwd to the worker spawn

`Bun.spawn(buildWorkerCmd(), { cwd: capturedDirectory ?? process.cwd(), env: {...}, ... })`. Confirm `Instance.directory` is the project root at spawn time; if it can be undefined, fail loud rather than silently inherit `/` (AGENTS.md rule 11 — no silent fallback). Worker `session worker` subcommand may also need to `Instance.provide({ directory })` on its own side so its tool calls resolve against the project, not its OS cwd — verify the worker entry path.

### Fix B (RC-2, REQUIRED) — put the working directory in the coding driver prompt

Inject an `<env>`-style block (working directory + "this is the repo root; all relative paths resolve here") into `coding.txt` (and the other subagent drivers: explore/review/testing), mirroring the main agent's environment context. Source it from the same `Instance.directory` so prompt and process cwd agree.

### Fix C (RC-3, RECOMMENDED) — close the "busy-but-no-progress" gap

Two sub-options (pick or combine):

1. **Watchdog**: add a "no NEW tool-result content / no file mutation / repeated identical errors in N consecutive rounds" signal to the proc-watchdog, independent of CPU/IO liveness. e.g. M (≥5) consecutive tool calls that all error or all return identical-signature output → reap with `finish=no_progress_timeout`.
2. **Paralysis Detector**: add a detector for "≥N consecutive rounds with tool activity but zero file mutation AND repeated tool-error or identical-result signature", regardless of preface similarity. This is the generalization the orchestrator-side blind spot also needs.

## Related

- Same paralysis blind spot recorded for the orchestrator side in specbase event scope `dispatcher-dedup` (2026-06-19, "preface perseveration — diverging preface, real progress, correctly not halted"). Here it is the _harmful_ variant: diverging preface, NO progress, NOT halted.
- `issues/bug_20260615_paralysis_guard_evaded_by_preface_perseveration.md` — prior preface-perseveration work; this BR extends the gap to "tool-active but unproductive".
- `issues/bug_20260618_post_compaction_tool_loader_perseveration_noop_shim.md` — escalation-ladder discipline.

## Repro

Run the daemon from a cwd that is NOT the repo root (e.g. `/`), dispatch any `coding` subagent with relative target paths. Worker fails to resolve paths and (without Fix C) hangs indefinitely.
