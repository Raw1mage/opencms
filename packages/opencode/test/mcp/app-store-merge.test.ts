import { test, expect, describe } from "bun:test"
import { McpAppStore } from "../../src/mcp/app-store"

/**
 * Tests for the layered-merge replacing the previous `system-wins` collision
 * rule. See plans/mcp_per_user_socket_rca/design.md DD-1 and
 * test-vectors.json TV-1..TV-4.
 *
 * Regression baseline: prior behaviour was
 *   { ...user.apps, ...system.apps }
 * — system tier wholly replaced any user entry with the same id. That made
 * per-user socket overrides impossible. These tests document and pin the
 * new layered semantics.
 */

function makeSystemEntry(overrides: Partial<McpAppStore.AppEntry> = {}): McpAppStore.AppEntry {
  return {
    path: "/opt/docxmcp",
    command: ["/opt/docxmcp/bin/server"],
    enabled: true,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "local" },
    tools: [{ name: "doc.read" }, { name: "doc.write" }],
    transport: "streamable-http",
    url: "unix:///stale/path:/mcp/",
    ...overrides,
  }
}

describe("McpAppStore.mergeAppsConfigs — layered merge", () => {
  test("TV-1: system-only app passes through unchanged", () => {
    const sys: McpAppStore.AppsConfig = { version: 1, apps: { foo: makeSystemEntry() } }
    const usr: McpAppStore.AppsConfig = { version: 1, apps: {} }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    expect(merged.apps.foo).toEqual(sys.apps.foo)
    expect(Object.keys(merged.apps)).toEqual(["foo"])
  })

  test("TV-2: user-only app passes through unchanged", () => {
    const sys: McpAppStore.AppsConfig = { version: 1, apps: {} }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        bar: {
          path: "/home/me/.bar",
          enabled: true,
          installedAt: "2026-05-01T00:00:00.000Z",
          source: { type: "local" },
          transport: "streamable-http",
          url: "unix:///home/me/.bar.sock:/mcp/",
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    expect(merged.apps.bar).toEqual(usr.apps.bar)
    expect(Object.keys(merged.apps)).toEqual(["bar"])
  })

  test("TV-3: collision — user runtime fields (url/enabled/config) override system", () => {
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: makeSystemEntry({
          url: "unix:///stale/path:/mcp/",
          enabled: false,
          config: { timeout: 1000 },
        }),
      },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "/will/be/ignored",
          enabled: true,
          installedAt: "irrelevant",
          source: { type: "local" },
          url: "unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/",
          config: { timeout: 30000 },
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)

    // System identity preserved
    expect(merged.apps.docxmcp.path).toBe("/opt/docxmcp")
    expect(merged.apps.docxmcp.command).toEqual(["/opt/docxmcp/bin/server"])
    expect(merged.apps.docxmcp.tools).toEqual([{ name: "doc.read" }, { name: "doc.write" }])
    expect(merged.apps.docxmcp.installedAt).toBe("2026-01-01T00:00:00.000Z")

    // User runtime override applied
    expect(merged.apps.docxmcp.url).toBe(
      "unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/",
    )
    expect(merged.apps.docxmcp.enabled).toBe(true)
    expect(merged.apps.docxmcp.config).toEqual({ timeout: 30000 })
  })

  test("TV-4: collision — user override of immutable field is dropped, system wins", () => {
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: makeSystemEntry({
          path: "/opt/docxmcp",
          tools: [{ name: "doc.read" }],
        }),
      },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "/tmp/evil",
          enabled: true,
          installedAt: "irrelevant",
          source: { type: "local" },
          tools: [{ name: "pwn" }],
          url: "unix:///home/me/.sock:/mcp/",
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)

    // Immutable system fields preserved
    expect(merged.apps.docxmcp.path).toBe("/opt/docxmcp")
    expect(merged.apps.docxmcp.tools).toEqual([{ name: "doc.read" }])
    expect(merged.apps.docxmcp.source).toEqual({ type: "local" })

    // Runtime override applied
    expect(merged.apps.docxmcp.url).toBe("unix:///home/me/.sock:/mcp/")
    expect(merged.apps.docxmcp.enabled).toBe(true)
  })

  test("regression: prior `system-wins` behaviour would have shadowed user url — now reversed", () => {
    // Under the old { ...user, ...system } rule, the user-tier url override
    // here would have been clobbered by the system-tier url. After the
    // layered merge, the user-tier url MUST win for runtime fields.
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: makeSystemEntry({ url: "unix:///would/have/won/before:/mcp/" }),
      },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "ignored",
          enabled: true,
          installedAt: "ignored",
          source: { type: "local" },
          url: "unix:///user-tier-wins-now:/mcp/",
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    expect(merged.apps.docxmcp.url).toBe("unix:///user-tier-wins-now:/mcp/")
    expect(merged.apps.docxmcp.url).not.toBe("unix:///would/have/won/before:/mcp/")
  })

  test("transport stays system-owned (DD-4 / OQ-1 resolved)", () => {
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: { docxmcp: makeSystemEntry({ transport: "streamable-http" }) },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "ignored",
          enabled: true,
          installedAt: "ignored",
          source: { type: "local" },
          transport: "stdio",
          url: "unix:///user/path:/mcp/",
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    expect(merged.apps.docxmcp.transport).toBe("streamable-http")
    expect(merged.apps.docxmcp.url).toBe("unix:///user/path:/mcp/")
  })

  test("multiple apps: mix of system-only, user-only, and collision", () => {
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: makeSystemEntry({ url: "unix:///stale:/mcp/" }),
        "google-calendar": makeSystemEntry({
          path: "/opt/google-calendar",
          url: undefined,
        }),
      },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "ignored",
          enabled: true,
          installedAt: "ignored",
          source: { type: "local" },
          url: "unix:///user/docxmcp:/mcp/",
        },
        "user-only-app": {
          path: "/home/me/.app",
          enabled: false,
          installedAt: "2026-05-28T00:00:00.000Z",
          source: { type: "local" },
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    expect(Object.keys(merged.apps).sort()).toEqual(["docxmcp", "google-calendar", "user-only-app"])
    expect(merged.apps.docxmcp.url).toBe("unix:///user/docxmcp:/mcp/")
    expect(merged.apps.docxmcp.path).toBe("/opt/docxmcp")
    expect(merged.apps["google-calendar"].path).toBe("/opt/google-calendar")
    expect(merged.apps["user-only-app"].path).toBe("/home/me/.app")
  })

  test("collision — user entry with only immutable-field override leaves system entry untouched", () => {
    const sys: McpAppStore.AppsConfig = {
      version: 1,
      apps: { docxmcp: makeSystemEntry() },
    }
    const usr: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "/tmp/evil",
          enabled: true,
          installedAt: "ignored",
          source: { type: "local" },
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(sys, usr)
    // `enabled` from user is a runtime field — it DOES override.
    expect(merged.apps.docxmcp.enabled).toBe(true)
    // But path / source / installedAt come from system.
    expect(merged.apps.docxmcp.path).toBe("/opt/docxmcp")
    expect(merged.apps.docxmcp.installedAt).toBe("2026-01-01T00:00:00.000Z")
  })
})
