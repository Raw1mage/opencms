import { describe, expect, it } from "bun:test"
import { MCP } from "."

describe("MCP.toolID", () => {
  it("uses raw app-prefixed tool id for mcp-app tools", () => {
    expect(MCP.toolID("mcpapp-docxmcp", "docxmcp_odt_extract_all")).toBe("docxmcp_odt_extract_all")
  })

  it("keeps app namespace when tool name is already concise", () => {
    expect(MCP.toolID("mcpapp-docxmcp", "odt_assemble")).toBe("mcpapp-docxmcp_odt_assemble")
  })

  it("keeps non-app MCP server names fully namespaced", () => {
    expect(MCP.toolID("filesystem", "read_file")).toBe("filesystem_read_file")
  })

  it("sanitizes app id and tool name before duplicate detection", () => {
    expect(MCP.toolID("mcpapp-my-app", "my-app.list/tools")).toBe("my-app_list_tools")
  })
})
