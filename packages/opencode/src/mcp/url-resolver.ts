import os from "os"
import { Log } from "@/util/log"

/**
 * MCP App URL template resolver.
 *
 * Per plans/mcp_per_user_socket_rca DD-2 / DD-3: persisted `url` values in
 * mcp-apps.json may contain template tokens; consumers MUST resolve at
 * dial time, never at persist time. The token catalogue is closed —
 * unknown `${...}` tokens are left intact for forward compatibility.
 *
 * Token catalogue:
 *   - `${UID}`              → numeric uid from `process.getuid()`
 *   - `${USER}`             → `os.userInfo().username` or `process.env.USER`
 *   - `${HOME}`             → `os.homedir()`
 *   - `${XDG_RUNTIME_DIR}`  → `process.env.XDG_RUNTIME_DIR` (fallback `/run/user/${UID}`)
 *
 * INV-5: uid context comes from `process.getuid()`, never from headers.
 */
export namespace McpAppUrlResolver {
  const log = Log.create({ service: "mcp-app-url-resolver" })

  export type Context = {
    uid: number
    user: string
    home: string
    xdgRuntimeDir: string
  }

  export type ResolveResult = {
    templatedUrl: string
    resolvedUrl: string
    expandedTokens: string[]
    unknownTokens: string[]
  }

  const KNOWN_TOKENS = ["UID", "USER", "HOME", "XDG_RUNTIME_DIR"] as const
  type KnownToken = (typeof KNOWN_TOKENS)[number]

  /**
   * Build a Context from the current per-user daemon process.
   * Uses `process.getuid()` as the authoritative uid source.
   */
  export function processContext(): Context {
    const uid = process.getuid?.() ?? 0
    const user = os.userInfo().username || process.env.USER || ""
    const home = os.homedir() || process.env.HOME || ""
    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`
    return { uid, user, home, xdgRuntimeDir }
  }

  /**
   * Expand template tokens in a URL string. Returns the resolved string
   * plus which tokens were expanded vs left intact.
   */
  export function resolveRuntimeUrl(url: string, ctx: Context): ResolveResult {
    const expandedTokens: string[] = []
    const unknownTokens: string[] = []

    const resolvedUrl = url.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (full, name: string) => {
      if ((KNOWN_TOKENS as readonly string[]).includes(name)) {
        expandedTokens.push(full)
        return tokenValue(name as KnownToken, ctx)
      }
      unknownTokens.push(full)
      return full
    })

    return { templatedUrl: url, resolvedUrl, expandedTokens, unknownTokens }
  }

  function tokenValue(token: KnownToken, ctx: Context): string {
    switch (token) {
      case "UID":
        return String(ctx.uid)
      case "USER":
        return ctx.user
      case "HOME":
        return ctx.home
      case "XDG_RUNTIME_DIR":
        return ctx.xdgRuntimeDir
    }
  }

  /**
   * Convenience: resolve using `processContext()` and emit one debug log
   * line per call. Used by `connectMcpApps()` and the dispatcher.
   */
  export function resolveForApp(appId: string, url: string, consumer: string): string {
    const ctx = processContext()
    const result = resolveRuntimeUrl(url, ctx)
    if (result.expandedTokens.length > 0 || result.unknownTokens.length > 0) {
      log.debug("mcp_app.url.resolved", {
        appId,
        consumer,
        templatedUrl: result.templatedUrl,
        resolvedUrl: result.resolvedUrl,
        expandedTokens: result.expandedTokens,
        unknownTokens: result.unknownTokens,
      })
    }
    return result.resolvedUrl
  }
}
