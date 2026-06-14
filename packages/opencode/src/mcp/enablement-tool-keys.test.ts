import { describe, expect, it } from "bun:test"
import { MCP } from "."
import runtimeEnablement from "../session/prompt/enablement.json"
import templateEnablement from "../../../../templates/prompts/enablement.json"

// Guard against the 2026-05-21 docxmcp namespace RCA tail (BR 2026-06-15):
// toolID() collapses the duplicated `mcpapp-<app>_<app>_` prefix to a single
// `<app>_` prefix, but the bundled enablement prompt kept advertising the old
// double-prefix keys. tool_loader then missed every documented docxmcp call.
// These tests tie the prompt's advertised keys to the real canonicalizer so the
// two can never drift apart again.

type Json = unknown

function walk(node: Json, visit: (key: string, value: Json, parent: any) => void) {
  if (node && typeof node === "object") {
    for (const key of Object.keys(node as any)) {
      const value = (node as any)[key]
      visit(key, value, node)
      walk(value, visit)
    }
  }
}

function collectStrings(node: Json): string[] {
  const out: string[] = []
  walk(node, (_key, value) => {
    if (typeof value === "string") out.push(value)
  })
  return out
}

function preferArrays(node: Json): string[][] {
  const out: string[][] = []
  walk(node, (key, value) => {
    if (key === "prefer" && Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out.push(value as string[])
    }
  })
  return out
}

function docxmcpServerTools(node: Json): string[] | undefined {
  let tools: string[] | undefined
  walk(node, (_key, value) => {
    const v = value as any
    if (v && typeof v === "object" && !Array.isArray(v) && v.name === "docxmcp" && Array.isArray(v.tools)) {
      tools = v.tools.map((t: any) => t.name)
    }
  })
  return tools
}

const COPIES: Array<{ label: string; doc: Json }> = [
  { label: "runtime (src/session/prompt)", doc: runtimeEnablement },
  { label: "template (templates/prompts)", doc: templateEnablement },
]

describe("enablement.json advertised tool keys vs MCP.toolID", () => {
  for (const { label, doc } of COPIES) {
    // Generalized drift guard: no advertised string may carry a duplicated
    // App Store prefix `mcpapp-<app>_<app>_` — exactly what toolID() collapses.
    it(`${label}: contains no duplicated mcpapp prefix anywhere`, () => {
      const offenders = collectStrings(doc).filter((s) => /mcpapp-([a-z0-9-]+)_\1_/i.test(s))
      expect(offenders).toEqual([])
    })

    // docxmcp-specific: every non-skill `prefer` key for docxmcp must be a fixed
    // point of toolID("mcpapp-docxmcp", key) AND a real server tool name. A
    // double-prefixed key fails both (toolID would re-wrap it).
    it(`${label}: docxmcp prefer keys are derived from toolID and exist in the catalog`, () => {
      const serverTools = docxmcpServerTools(doc)
      expect(serverTools).toBeDefined()

      const advertised = preferArrays(doc)
        .flat()
        .filter((key) => key.startsWith("docxmcp_"))
      expect(advertised.length).toBeGreaterThan(0)

      for (const key of advertised) {
        // canonical: the key opencode actually exposes for this server tool name
        expect(MCP.toolID("mcpapp-docxmcp", key)).toBe(key)
        // and it must be a tool the server actually registers
        expect(serverTools).toContain(key)
      }
    })
  }
})
