import { test, expect, describe } from "bun:test"
import fs from "fs/promises"
import { McpAppStore } from "../../src/mcp/app-store"
import { McpAppUrlResolver } from "../../src/mcp/url-resolver"

/**
 * End-to-end integration test for the registry contract hardening plan.
 * See plans/mcp_per_user_socket_rca/events/event_2026-05-29_validation.md.
 *
 * `bun test` auto-pins OPENCODE_DATA_HOME to a per-pid tmpdir (see
 * packages/opencode/src/global/index.ts:30), so `McpAppStore.loadConfig()`
 * inside this test would read from the sandbox, not the real XDG config.
 * We therefore read the real tier files via fs.readFile and feed them
 * through the **pure** `McpAppStore.mergeAppsConfigs()` directly — that
 * is the same merge code path the running daemon executes; only the
 * file-system shim around it is different.
 *
 * The dial path (resolver + Unix-socket fetch) is unaffected and is
 * exercised exactly as the daemon would.
 *
 * Skipped automatically if docxmcp is not present or its socket is down.
 */

const SYSTEM_FILE = "/etc/opencode/mcp-apps.json"
const USER_FILE = `${process.env.HOME}/.config/opencode/mcp-apps.json`

async function readTier(filePath: string): Promise<McpAppStore.AppsConfig> {
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    return JSON.parse(raw) as McpAppStore.AppsConfig
  } catch {
    return { version: 1, apps: {} }
  }
}

async function userFileHasDocxmcp(): Promise<boolean> {
  const cfg = await readTier(USER_FILE)
  return !!cfg.apps?.docxmcp
}

function parseUnixSocketUrl(raw: string): { socketPath: string; httpPath: string } | null {
  if (!raw.startsWith("unix://")) return null
  const rest = raw.slice("unix://".length)
  const idx = rest.indexOf(":/")
  if (idx < 0) return { socketPath: rest, httpPath: "/" }
  return { socketPath: rest.slice(0, idx), httpPath: rest.slice(idx + 1) }
}

describe("docxmcp e2e — full daemon dial path", () => {
  test("end-to-end: read tiers → merge → resolve → MCP initialize", async () => {
    if (!(await userFileHasDocxmcp())) {
      console.warn("docxmcp not present in user-tier mcp-apps.json; skipping e2e")
      return
    }

    // (1) Read both real tier files from disk.
    const [systemCfg, userCfg] = await Promise.all([readTier(SYSTEM_FILE), readTier(USER_FILE)])

    // (2) Run the pure layered merge (same code path the daemon runs).
    const merged = McpAppStore.mergeAppsConfigs(systemCfg, userCfg)
    expect(merged.apps.docxmcp).toBeDefined()

    const entry = merged.apps.docxmcp
    expect(entry.transport).toBe("streamable-http")
    expect(entry.url).toBeDefined()

    // (2) Verify the entry came through the layered merge intact.
    //     (If system-tier had a colliding entry, runtime fields should
    //     come from user-tier; on this host system-tier has no docxmcp,
    //     so the entry comes from user-tier whole.)
    expect(entry.url).toMatch(/\.run\/docxmcp\.sock/)

    // (3) Resolver passthrough for literal URL.
    const resolved = McpAppUrlResolver.resolveForApp("docxmcp", entry.url!, "e2e-test")
    expect(resolved).toBe(entry.url!)

    // (4) Parse and validate the socket path exists.
    const parsed = parseUnixSocketUrl(resolved)
    expect(parsed).not.toBeNull()
    expect(parsed!.socketPath).toMatch(/\.sock$/)

    let sockExists = false
    try {
      const stat = await fs.stat(parsed!.socketPath)
      sockExists = stat.isSocket()
    } catch {
      // socket file may not exist if docxmcp container is down
    }
    if (!sockExists) {
      console.warn(`docxmcp socket ${parsed!.socketPath} not present; skipping live dial`)
      return
    }

    // (5) MCP initialize over the resolved socket (using bun's unix fetch).
    const initRequest = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0" },
      },
    }

    const httpBase = "http://docxmcp.local"
    const url = `${httpBase}${parsed!.httpPath}`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initRequest),
      // Bun-specific: route this fetch over the Unix socket.
      unix: parsed!.socketPath,
    } as RequestInit & { unix: string })

    expect(res.status).toBe(200)

    const bodyText = await res.text()
    // Streamable HTTP responds with SSE-framed JSON; extract the data line.
    const dataMatch = bodyText.match(/^data:\s*(\{.*\})$/m)
    expect(dataMatch).not.toBeNull()
    const payload = JSON.parse(dataMatch![1]) as {
      result?: { serverInfo?: { name?: string; version?: string } }
    }
    expect(payload.result?.serverInfo?.name).toBe("docxmcp")
    expect(payload.result?.serverInfo?.version).toBeDefined()
  })

  test("layered merge classifies docxmcp as user-tier on this host", async () => {
    if (!(await userFileHasDocxmcp())) return
    const [systemCfg, userCfg] = await Promise.all([readTier(SYSTEM_FILE), readTier(USER_FILE)])

    // On this host, system tier has no docxmcp entry (only google-calendar),
    // so the merged docxmcp identity origin is "user". This mirrors what
    // `McpAppStore.listApps()` would compute given the same inputs.
    const merged = McpAppStore.mergeAppsConfigs(systemCfg, userCfg)
    const tier: "system" | "user" = "docxmcp" in systemCfg.apps ? "system" : "user"
    expect(tier).toBe("user")
    expect(merged.apps.docxmcp.url).toMatch(/\.run\/docxmcp\.sock/)
  })

  test("simulated collision: user-tier url wins under layered merge", async () => {
    if (!(await userFileHasDocxmcp())) return
    const userCfg = await readTier(USER_FILE)
    // Synthetic system-tier entry with a stale url and immutable identity
    // claims — simulating what a future /etc/opencode/mcp-apps.json
    // could look like. The merge MUST keep user-tier url + enabled.
    const syntheticSystem: McpAppStore.AppsConfig = {
      version: 1,
      apps: {
        docxmcp: {
          path: "/opt/docxmcp-from-system",
          command: ["/opt/docxmcp/bin/server"],
          enabled: false,
          installedAt: "2026-01-01T00:00:00.000Z",
          source: { type: "local" },
          tools: [{ name: "doc.from_system" }],
          transport: "streamable-http",
          url: "unix:///stale/system/path.sock:/mcp/",
        },
      },
    }
    const merged = McpAppStore.mergeAppsConfigs(syntheticSystem, userCfg)
    // User-tier runtime fields win.
    expect(merged.apps.docxmcp.url).toBe(userCfg.apps.docxmcp.url)
    expect(merged.apps.docxmcp.enabled).toBe(userCfg.apps.docxmcp.enabled)
    // System-tier identity wins.
    expect(merged.apps.docxmcp.path).toBe("/opt/docxmcp-from-system")
    expect(merged.apps.docxmcp.tools).toEqual([{ name: "doc.from_system" }])
  })
})
