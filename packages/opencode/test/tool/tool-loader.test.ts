import { describe, expect, test } from "bun:test"
import {
  ALWAYS_PRESENT_TOOLS,
  buildCatalog,
  formatLoaderOutput,
  resolveToolLoaderRequest,
} from "../../src/tool/tool-loader"

describe("tool-loader alias resolution", () => {
  const available = new Set([
    "bash",
    "system-manager_get_system_status",
    "system-manager_restart_self",
    "system-manager_set_log_level",
    "fetch_get_raw_text",
  ])

  test("resolves colon and dot MCP namespace aliases", () => {
    expect(resolveToolLoaderRequest(available, ["system-manager:restart_self"]).found).toEqual([
      "system-manager_restart_self",
    ])
    expect(resolveToolLoaderRequest(available, ["system-manager.restart_self"]).found).toEqual([
      "system-manager_restart_self",
    ])
  })

  test("expands MCP app alias to its registered tool ids", () => {
    const result = resolveToolLoaderRequest(available, ["system-manager"])

    expect(result.notFound).toEqual([])
    expect(result.found).toEqual([
      "system-manager_get_system_status",
      "system-manager_restart_self",
      "system-manager_set_log_level",
    ])
  })

  test("resolves unique short tool suffix and rejects ambiguous suffixes", () => {
    expect(resolveToolLoaderRequest(available, ["restart_self"]).found).toEqual(["system-manager_restart_self"])

    const ambiguous = resolveToolLoaderRequest(available, ["set_log_level"])
    expect(ambiguous.notFound).toEqual([])
    expect(ambiguous.found).toEqual(["system-manager_set_log_level"])

    const withConflict = new Set([...available, "other_restart_self"])
    const conflict = resolveToolLoaderRequest(withConflict, ["restart_self"])
    expect(conflict.found).toEqual([])
    expect(conflict.notFound).toEqual(["restart_self"])
    expect(conflict.ambiguous).toEqual([
      { requested: "restart_self", candidates: ["other_restart_self", "system-manager_restart_self"] },
    ])
  })
})

describe("tool-loader honest output (issue_20260617)", () => {
  test("direct-tool load reports callable-now AND terminal (do not call tool_loader again)", () => {
    const resolution = resolveToolLoaderRequest(new Set(["system-manager_rename_session", "bash"]), [
      "system-manager_rename_session",
    ])
    const { output, title } = formatLoaderOutput(resolution)

    expect(resolution.found).toEqual(["system-manager_rename_session"])
    // The old lie that caused issue_20260617 must be gone.
    expect(output).not.toContain("available on your next action")
    expect(output).not.toContain("Loaded tools")
    // The honest contract: deferred tools are directly callable now.
    expect(output).toContain("already directly callable")
    expect(output).toContain("system-manager_rename_session")
    // The terminal contract (DD-1, bug_20260618): stop calling the no-op shim.
    expect(output).toContain("do NOT call tool_loader again")
    expect(output).toContain("NO-OP")
    expect(title).toBe("1 tool(s) ready")
  })

  test("alias load resolves and still reports callable-now without next-action wording", () => {
    const available = new Set([
      "system-manager_get_system_status",
      "system-manager_restart_self",
      "system-manager_set_log_level",
    ])
    const resolution = resolveToolLoaderRequest(available, ["system-manager"])
    const { output } = formatLoaderOutput(resolution)

    expect(output).toContain("already directly callable")
    expect(output).toContain("Resolved alias system-manager →")
    expect(output).not.toContain("available on your next action")
  })

  test("all-not-found yields a failure title and the error guidance", () => {
    const resolution = resolveToolLoaderRequest(new Set(["bash"]), ["does_not_exist"])
    const { output, title } = formatLoaderOutput(resolution)

    expect(title).toBe("Failed to load 1 tool(s)")
    expect(output).toContain("ERROR — tools not found: does_not_exist")
    expect(output).not.toContain("already directly callable")
  })
})

describe("tool-loader catalog priority", () => {
  test("keeps skill discoverable without making it always-present", () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({
      id: `aaa_tool_${String(index).padStart(2, "0")}`,
      description: "Filler tool used to exceed the lazy catalog cap.",
    }))
    tools.push({
      id: "skill",
      description: "Load domain-specific operational skills.",
    })

    const catalog = buildCatalog(tools)

    expect(ALWAYS_PRESENT_TOOLS.has("skill")).toBe(false)
    expect(catalog).toHaveLength(50)
    expect(catalog[0].id).toBe("skill")
  })
})
