import { describe, expect, test } from "bun:test"
import { resolveToolLoaderRequest } from "../../src/tool/tool-loader"

describe("tool-loader alias resolution", () => {
  const available = new Set([
    "bash",
    "system-manager_get_system_status",
    "system-manager_restart_self",
    "system-manager_set_log_level",
    "memory_create_entities",
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
