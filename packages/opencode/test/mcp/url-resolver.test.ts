import { test, expect, describe } from "bun:test"
import { McpAppUrlResolver } from "../../src/mcp/url-resolver"

/**
 * Tests for the MCP App URL template resolver.
 * See plans/mcp_per_user_socket_rca/test-vectors.json TV-5..TV-8, TV-14
 * and design.md DD-2 / DD-3 / INV-5.
 */

const ctx: McpAppUrlResolver.Context = {
  uid: 1000,
  user: "pkcs12",
  home: "/home/pkcs12",
  xdgRuntimeDir: "/run/user/1000",
}

describe("resolveRuntimeUrl — token expansion", () => {
  test("TV-5: expands all four tokens in one string", () => {
    const result = McpAppUrlResolver.resolveRuntimeUrl(
      "unix://${HOME}/${USER}-${UID}/${XDG_RUNTIME_DIR}/sock:/mcp/",
      ctx,
    )
    expect(result.resolvedUrl).toBe(
      "unix:///home/pkcs12/pkcs12-1000//run/user/1000/sock:/mcp/",
    )
    expect(result.expandedTokens.sort()).toEqual(
      ["${HOME}", "${USER}", "${UID}", "${XDG_RUNTIME_DIR}"].sort(),
    )
    expect(result.unknownTokens).toEqual([])
  })

  test("expands ${UID} only", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl("/run/user/${UID}/sock", ctx)
    expect(r.resolvedUrl).toBe("/run/user/1000/sock")
    expect(r.expandedTokens).toEqual(["${UID}"])
  })

  test("expands ${USER} only", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl("/home/${USER}/.sock", ctx)
    expect(r.resolvedUrl).toBe("/home/pkcs12/.sock")
    expect(r.expandedTokens).toEqual(["${USER}"])
  })

  test("expands ${HOME} only", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl("${HOME}/.foo", ctx)
    expect(r.resolvedUrl).toBe("/home/pkcs12/.foo")
    expect(r.expandedTokens).toEqual(["${HOME}"])
  })

  test("expands ${XDG_RUNTIME_DIR} only", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl(
      "unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/",
      ctx,
    )
    expect(r.resolvedUrl).toBe(
      "unix:///run/user/1000/opencode/sockets/docxmcp/docxmcp.sock:/mcp/",
    )
    expect(r.expandedTokens).toEqual(["${XDG_RUNTIME_DIR}"])
  })

  test("TV-7: unknown tokens are preserved (forward compatibility)", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl(
      "unix://${HOME}/foo/${UNKNOWN_FUTURE_VAR}/sock:/mcp/",
      ctx,
    )
    expect(r.resolvedUrl).toBe(
      "unix:///home/pkcs12/foo/${UNKNOWN_FUTURE_VAR}/sock:/mcp/",
    )
    expect(r.unknownTokens).toEqual(["${UNKNOWN_FUTURE_VAR}"])
    expect(r.expandedTokens).toEqual(["${HOME}"])
  })

  test("literal URL without tokens passes through", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl("unix:///etc/docxmcp.sock:/mcp/", ctx)
    expect(r.resolvedUrl).toBe("unix:///etc/docxmcp.sock:/mcp/")
    expect(r.expandedTokens).toEqual([])
    expect(r.unknownTokens).toEqual([])
  })

  test("same token used twice expands both occurrences", () => {
    const r = McpAppUrlResolver.resolveRuntimeUrl("${UID}-${UID}", ctx)
    expect(r.resolvedUrl).toBe("1000-1000")
    expect(r.expandedTokens).toEqual(["${UID}", "${UID}"])
  })
})

describe("processContext — uid source", () => {
  test("TV-14: uid comes from process.getuid(), not env", () => {
    const oldUid = process.env.UID
    process.env.UID = "9999"
    try {
      const ctx = McpAppUrlResolver.processContext()
      expect(ctx.uid).toBe(process.getuid?.() ?? 0)
      expect(ctx.uid).not.toBe(9999)
    } finally {
      if (oldUid === undefined) delete process.env.UID
      else process.env.UID = oldUid
    }
  })

  test("TV-6: ${XDG_RUNTIME_DIR} falls back to /run/user/${UID} when env unset", () => {
    const oldXdg = process.env.XDG_RUNTIME_DIR
    delete process.env.XDG_RUNTIME_DIR
    try {
      const ctx = McpAppUrlResolver.processContext()
      expect(ctx.xdgRuntimeDir).toBe(`/run/user/${ctx.uid}`)
      const r = McpAppUrlResolver.resolveRuntimeUrl(
        "unix://${XDG_RUNTIME_DIR}/sock",
        ctx,
      )
      expect(r.resolvedUrl).toBe(`unix:///run/user/${ctx.uid}/sock`)
    } finally {
      if (oldXdg !== undefined) process.env.XDG_RUNTIME_DIR = oldXdg
    }
  })

  test("populates user and home from os module", () => {
    const ctx = McpAppUrlResolver.processContext()
    expect(typeof ctx.user).toBe("string")
    expect(ctx.user.length).toBeGreaterThan(0)
    expect(ctx.home.length).toBeGreaterThan(0)
    expect(ctx.home).toMatch(/^\//)
  })
})

describe("resolveForApp — convenience consumer entry point", () => {
  test("resolves and returns string directly", () => {
    const resolved = McpAppUrlResolver.resolveForApp(
      "docxmcp",
      "unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/",
      "test",
    )
    const ctx = McpAppUrlResolver.processContext()
    expect(resolved).toBe(
      `unix://${ctx.xdgRuntimeDir}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/`,
    )
  })

  test("literal URL passes through resolveForApp untouched", () => {
    const resolved = McpAppUrlResolver.resolveForApp(
      "docxmcp",
      "unix:///literal/path.sock:/mcp/",
      "test",
    )
    expect(resolved).toBe("unix:///literal/path.sock:/mcp/")
  })
})
