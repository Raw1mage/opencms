import { describe, expect, it } from "bun:test"
import path from "path"
import { mkdir, symlink } from "fs/promises"
import { createHash } from "crypto"
import { tmpdir } from "../../test/fixture/fixture"
import { Instance } from "../project/instance"
import { consumeMissionArtifacts, deriveDelegatedExecutionRole } from "./mission-consumption"

function approvedMission() {
  return {
    source: "openspec_compiled_plan" as const,
    contract: "implementation_spec" as const,
    approvedAt: 1,
    planPath: "specs/20260315_test/implementation-spec.md",
    executionReady: true,
    artifactPaths: {
      root: "specs/20260315_test",
      implementationSpec: "specs/20260315_test/implementation-spec.md",
      proposal: "specs/20260315_test/proposal.md",
      spec: "specs/20260315_test/spec.md",
      design: "specs/20260315_test/design.md",
      tasks: "specs/20260315_test/tasks.md",
      handoff: "specs/20260315_test/handoff.md",
    },
    artifactIntegrity: {
      implementationSpec: "sig_impl",
      tasks: "sig_tasks",
      handoff: "sig_handoff",
    },
  }
}

function digest(text: string) {
  return createHash("sha1").update(text).digest("hex")
}

describe("mission consumption", () => {
  it("reads approved mission artifacts into compact execution input", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Ship mission consumption\n\n## Scope\n### IN\n- mission runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- artifacts exist\n\n## Stop Gates\n- stop on mismatch\n\n## Critical Files\n- packages/opencode/src/session/mission-consumption.ts\n\n## Structured Execution Phases\n- Read mission\n\n## Validation\n- Run mission-consumption tests\n\n## Handoff\n- Continue from approved mission\n",
        )
        await Bun.write(
          path.join(planRoot, "tasks.md"),
          "# Tasks\n\n- [ ] Read mission\n- [ ] Continue implementation\n",
        )
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- Read approved mission first\n\n## Required Reads\n- implementation-spec.md\n- tasks.md\n- handoff.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Mission approved\n",
        )

        const implementationSpecText = await Bun.file(path.join(planRoot, "implementation-spec.md")).text()
        const tasksText = await Bun.file(path.join(planRoot, "tasks.md")).text()
        const handoffText = await Bun.file(path.join(planRoot, "handoff.md")).text()
        const result = await consumeMissionArtifacts({
          ...approvedMission(),
          artifactIntegrity: {
            implementationSpec: digest(implementationSpecText),
            tasks: digest(tasksText),
            handoff: digest(handoffText),
          },
        })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error("expected successful mission consumption")
        expect(result.trace.goal).toContain("Ship mission consumption")
        expect(result.trace.executionChecklist).toEqual(["Read mission", "Continue implementation"])
        expect(result.trace.requiredReads).toContain("implementation-spec.md")
      },
    })
  })

  it("fails when required mission artifacts are missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await consumeMissionArtifacts(approvedMission())
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("expected failed mission consumption")
        expect(result.issues.some((issue) => issue.includes("implementationSpec missing"))).toBe(true)
      },
    })
  })

  it("fails when mission artifact paths escape the worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await consumeMissionArtifacts({
          ...approvedMission(),
          artifactPaths: {
            ...approvedMission().artifactPaths,
            implementationSpec: "../outside.md",
          },
        })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("expected failed mission consumption")
        expect(result.issues.some((issue) => issue.includes("outside worktree"))).toBe(true)
      },
    })
  })

  it("fails when mission artifact symlink resolves outside the worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await mkdir(planRoot, { recursive: true })
        const outsidePath = path.join(path.dirname(tmp.path), `outside-${Date.now().toString(36)}.md`)
        await Bun.write(outsidePath, "# outside\n")
        await symlink(outsidePath, path.join(planRoot, "implementation-spec.md"))
        await Bun.write(path.join(planRoot, "tasks.md"), "# Tasks\n\n- [ ] Read mission\n")
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Required Reads\n- implementation-spec.md\n\n## Stop Gates In Force\n- Preserve approval gates\n",
        )

        const result = await consumeMissionArtifacts(approvedMission())
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("expected failed mission consumption")
        expect(result.issues.some((issue) => issue.includes("outside worktree"))).toBe(true)
      },
    })
  })

  it("derives bounded execution roles from mission and todo evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Ship mission consumption\n\n## Scope\n### IN\n- mission runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- artifacts exist\n\n## Stop Gates\n- stop on mismatch\n\n## Critical Files\n- packages/opencode/src/session/mission-consumption.ts\n\n## Structured Execution Phases\n- Read mission\n\n## Validation\n- Run regression suite\n\n## Handoff\n- Continue from approved mission\n",
        )
        await Bun.write(path.join(planRoot, "tasks.md"), "# Tasks\n\n- [ ] Implement feature\n")
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- Read approved mission first\n\n## Required Reads\n- implementation-spec.md\n- tasks.md\n- handoff.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Mission approved\n",
        )

        const implementationSpecText = await Bun.file(path.join(planRoot, "implementation-spec.md")).text()
        const tasksText = await Bun.file(path.join(planRoot, "tasks.md")).text()
        const handoffText = await Bun.file(path.join(planRoot, "handoff.md")).text()
        const result = await consumeMissionArtifacts({
          ...approvedMission(),
          artifactIntegrity: {
            implementationSpec: digest(implementationSpecText),
            tasks: digest(tasksText),
            handoff: digest(handoffText),
          },
        })
        if (!result.ok) throw new Error("expected successful mission consumption")

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t1", content: "implement mission parser", action: { kind: "implement" } },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "coding" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t2", content: "write docs for mission flow" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "docs" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t3", content: "review mission trace output" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "review" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t4", content: "run validation tests for release readiness" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "testing" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t4a", content: "implement integration tests for release readiness" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "testing", source: "todo_content" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t4b", content: "check release readiness" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "testing", source: "mission_validation" })

        expect(
          deriveDelegatedExecutionRole({
            todo: { id: "t5", content: "continue next step" },
            mission: result.trace,
          }),
        ).toMatchObject({ role: "generic" })
      },
    })
  })

  it("reports spec_dirty when approved artifacts changed after approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Changed after approval\n\n## Scope\n### IN\n- runtime\n\n### OUT\n- rewrite\n\n## Assumptions\n- changed\n\n## Stop Gates\n- stop\n\n## Critical Files\n- file.ts\n\n## Structured Execution Phases\n- phase\n\n## Validation\n- validate\n\n## Handoff\n- handoff\n",
        )
        await Bun.write(path.join(planRoot, "tasks.md"), "# Tasks\n\n- [ ] Changed task\n")
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- contract\n\n## Required Reads\n- implementation-spec.md\n\n## Stop Gates In Force\n- stop\n\n## Execution-Ready Checklist\n- [ ] ready\n",
        )

        const result = await consumeMissionArtifacts(approvedMission())
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("expected failed mission consumption")
        expect(result.issues.some((issue) => issue.startsWith("spec_dirty:"))).toBe(true)
      },
    })
  })

  it("allows tasks.md changes without triggering spec_dirty (progress, not corruption)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        const implText =
          "# Implementation Spec\n\n## Goal\n- Ship feature\n\n## Scope\n### IN\n- runtime\n\n### OUT\n- rewrite\n\n## Assumptions\n- exist\n\n## Stop Gates\n- stop\n\n## Critical Files\n- file.ts\n\n## Structured Execution Phases\n- phase\n\n## Validation\n- validate\n\n## Handoff\n- handoff\n"
        const originalTasksText = "# Tasks\n\n- [ ] First task\n- [ ] Second task\n"
        const handoffText =
          "# Handoff\n\n## Execution Contract\n- contract\n\n## Required Reads\n- implementation-spec.md\n\n## Stop Gates In Force\n- stop\n\n## Execution-Ready Checklist\n- [ ] ready\n"

        await Bun.write(path.join(planRoot, "implementation-spec.md"), implText)
        await Bun.write(path.join(planRoot, "tasks.md"), originalTasksText)
        await Bun.write(path.join(planRoot, "handoff.md"), handoffText)

        // Now simulate execution: tasks.md gets updated (checkboxes checked off)
        const updatedTasksText = "# Tasks\n\n- [x] First task\n- [ ] Second task\n"
        await Bun.write(path.join(planRoot, "tasks.md"), updatedTasksText)

        const result = await consumeMissionArtifacts({
          ...approvedMission(),
          artifactIntegrity: {
            implementationSpec: digest(implText),
            tasks: digest(originalTasksText), // Original hash — tasks.md has changed
            handoff: digest(handoffText),
          },
        })
        // Should succeed: tasks.md changes are progress, not corruption
        expect(result.ok).toBe(true)
      },
    })
  })

  it("still detects spec_dirty for implementationSpec and handoff changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        const implText =
          "# Implementation Spec\n\n## Goal\n- Ship feature\n\n## Scope\n### IN\n- runtime\n\n### OUT\n- rewrite\n\n## Assumptions\n- exist\n\n## Stop Gates\n- stop\n\n## Critical Files\n- file.ts\n\n## Structured Execution Phases\n- phase\n\n## Validation\n- validate\n\n## Handoff\n- handoff\n"
        const tasksText = "# Tasks\n\n- [ ] First task\n"
        const handoffText =
          "# Handoff\n\n## Execution Contract\n- contract\n\n## Required Reads\n- implementation-spec.md\n\n## Stop Gates In Force\n- stop\n\n## Execution-Ready Checklist\n- [ ] ready\n"

        // Write modified implementationSpec (different from integrity hash)
        await Bun.write(path.join(planRoot, "implementation-spec.md"), implText + "\n## Extra Section\n")
        await Bun.write(path.join(planRoot, "tasks.md"), tasksText)
        await Bun.write(path.join(planRoot, "handoff.md"), handoffText)

        const result = await consumeMissionArtifacts({
          ...approvedMission(),
          artifactIntegrity: {
            implementationSpec: digest(implText), // Original — now mismatched
            tasks: digest(tasksText),
            handoff: digest(handoffText),
          },
        })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("expected spec_dirty for implementationSpec")
        expect(result.issues.some((issue) => issue.includes("implementationSpec changed"))).toBe(true)
      },
    })
  })
})
