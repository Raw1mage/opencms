# Bug Report: `specbase_*` tools throw `result.content` TypeError

Status: Closed 2026-05-13

Resolution: Fixed in `packages/opencode/src/session/resolve-tools.ts` by normalizing MCP tool results before reading `content[]`. Regression coverage added in `packages/opencode/test/session/resolve-tools.test.ts`; event log: `docs/events/event_20260513_specbase_result_content_typeerror.md`.

## 0. Handoff Summary

During validation of the drawmiat plan package at:

`/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/`

multiple `specbase_*` tools failed with:

```text
TypeError: undefined is not an object (evaluating 'result.content')
```

The plan package itself appears structurally valid by direct filesystem checks: required files exist, JSON artifacts parse, `.state.json.state` is `planned`, and local semantic checks pass. The failure therefore appears to be in the tool/runtime response handling path, not in the plan package content.

## 1. Environment

- Repo: `/home/pkcs12/projects/opencode`
- Affected target package: `/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/`
- Date observed: 2026-05-13
- Tools observed:
  - `specbase_plan_check`
  - `specbase_spec_sync`

## 2. Symptoms

### Observed error

Both direct and multi-tool invocations produced the same JavaScript/TypeScript runtime-style error:

```text
TypeError: undefined is not an object (evaluating 'result.content')
```

### Affected calls

```json
{
  "tool": "specbase_plan_check",
  "args": {
    "package_path": "/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts"
  }
}
```

```json
{
  "tool": "specbase_spec_sync",
  "args": {
    "package_path": "/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts",
    "overwrite": true,
    "rebuild_index": false,
    "repo": "/home/pkcs12/projects/drawmiat"
  }
}
```

## 3. Expected Behavior

The tools should return one of the following structured outcomes:

1. Success result, for example:
   - `ready: true`
   - `state: planned`
   - file presence summary
   - README sync summary
2. Structured validation failure, for example:
   - `ready: false`
   - `reasons: [...]`
   - missing/invalid artifact details
3. Structured internal tool error, for example:
   - `error: "specbase_tool_failed"`
   - `detail.stderr`
   - `detail.stdout`
   - actionable recovery guidance

The user-facing tool layer should not throw an unclassified `result.content` TypeError.

## 4. Actual Behavior

The tool invocation returned only:

```text
TypeError: undefined is not an object (evaluating 'result.content')
```

This prevents the agent from distinguishing between:

- invalid plan package
- malformed specbase CLI output
- missing `result.content` wrapper
- tool adapter/runtime bug
- unexpected exception inside the tool implementation

## 5. Evidence Collected

Local validation of the target plan package succeeded with an independent Python check:

```text
missing []
json_ok
state_planned True
design_mermaid_architecture True
docker_http_uri True
docxmcp_files True
multi_format_outputs True
structured_output_solution True
readme_current True
```

The following files were present in the plan package:

- `proposal.md`
- `spec.md`
- `design.md`
- `tasks.md`
- `handoff.md`
- `README.md`
- `README.en.md`
- `.state.json`
- `data-schema.json`
- `test-vectors.json`
- `errors.md`
- `observability.md`
- `idef0.json`
- `grafcet.json`
- `sequence.json`

`.state.json` contained:

```json
{
  "state": "planned"
}
```

## 6. Impact

- Blocks reliable plan-builder validation handoff.
- Makes a valid package look like an infrastructure failure without classification.
- Forces agents to replace specbase validation with ad hoc local checks.
- Prevents automated workflows from deciding whether to fix plan content or report a tool/runtime bug.

## 7. Hypotheses

One or more of the following may be true:

1. The specbase tool implementation returns `undefined` on an internal exception path.
2. The tool adapter assumes every tool result has a `content` property, but specbase tools return plain JSON or throw differently.
3. `specbase_plan_check` / `specbase_spec_sync` returns a shape that changed after the tool rewrite and no longer matches the runtime wrapper expectation.
4. An exception is thrown before the tool response is normalized into the expected result envelope.

## 8. Reproduction Plan

From a new session with access to the same workspace:

1. Ensure the target package exists:

   ```text
   /home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/
   ```

2. Invoke:

   ```json
   specbase_plan_check({
     "package_path": "/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts"
   })
   ```

3. Invoke:

   ```json
   specbase_spec_sync({
     "package_path": "/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts",
     "overwrite": true,
     "rebuild_index": false,
     "repo": "/home/pkcs12/projects/drawmiat"
   })
   ```

4. Compare tool output against a direct local check that required files exist and JSON artifacts parse.

## 9. Acceptance Criteria

- `specbase_plan_check` never returns a raw `result.content` TypeError to the agent.
- Tool responses are normalized into a consistent envelope before reaching the model.
- If the package is invalid, the tool returns `ready: false` with actionable `reasons`.
- If the specbase CLI or adapter crashes, the tool returns a structured error object with stdout/stderr or stack summary.
- Tests cover:
  - valid planned package
  - missing package
  - invalid JSON artifact
  - specbase CLI exception
  - adapter receiving an unexpected return shape

## 10. Workaround Used

The agent performed manual validation:

- checked required file list
- parsed JSON artifacts with Python
- confirmed `.state.json.state == "planned"`
- checked semantic markers in `design.md`, `tasks.md`, and `README.md`

This is only a workaround; it does not replace specbase validation.

## 11. Next Session Checklist

- [ ] Reproduce the TypeError using `specbase_plan_check`.
- [ ] Inspect the specbase tool adapter return normalization.
- [ ] Inspect whether specbase CLI returns plain JSON, tool content array, or undefined on error.
- [ ] Add adapter guard for missing `result` / missing `result.content`.
- [ ] Add regression tests for successful and failing specbase tool calls.
- [ ] Re-run validation on `/home/pkcs12/projects/drawmiat/plans/mcp_output-solution-artifacts/`.
