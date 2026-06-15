import fs from "fs/promises"
import path from "path"
import { Log } from "@/util/log"
import { McpAppStore } from "./app-store"

/**
 * McpPrerequisite (mcp_connect-adaptation MVP-1, DD-1/DD-2)
 *
 * Connect-time prerequisite probe. Before dialing an MCP app, evaluate what its
 * own mcp.json *structurally* declares — transport reachability, declared command
 * binary on PATH, declared env present — and report a verdict. Unmet prerequisites
 * fail-fast with an actionable diagnostic (the caller logs + recordAppFailure +
 * skips that app); they are NEVER silently treated as satisfied (no silent
 * fallback, DD-2).
 *
 * Boundary (DD-2): structured fields only. It does NOT parse mcp.json
 * `instructions` prose, open the socket, or spawn the process.
 */
export namespace McpPrerequisite {
  const log = Log.create({ service: "mcp-prerequisite" })

  /**
   * Requirement — one unmet prerequisite.
   * - kind:
   *   - "manifest"  : mcp.json missing or unparseable.
   *   - "reachable" : transport endpoint not satisfiable structurally
   *                   (unix socket path absent / url unparseable / stdio
   *                    command[0] not on PATH).
   *   - "binary"    : a declared command[0] is not resolvable on PATH.
   *   - "env"       : a declared env var is absent from the environment.
   * - detail: human-readable description of what is missing.
   * - remediation: concrete action the user can take to satisfy it.
   * Not to be interpreted as: a transport-layer health result — reachability
   * here is a structural precondition, NOT an open-connection probe.
   */
  export interface Requirement {
    kind: "manifest" | "reachable" | "binary" | "env"
    detail: string
    remediation: string
  }

  /**
   * Verdict — the probe outcome for one MCP app.
   * - satisfied:true  => every structurally-declared prerequisite is met; the
   *   caller may proceed to dial.
   * - satisfied:false => `missing` lists the unmet requirements; the caller MUST
   *   NOT dial (fail-fast, DD-4). It is a scope/precondition gate, not a fallback.
   * Done when: a verdict object is returned.
   */
  export type Verdict = { satisfied: true } | { satisfied: false; missing: Requirement[] }

  /**
   * probe — evaluate the structurally-declared prerequisites for one MCP app.
   * - input:
   *   - id: the mcp-apps.json app id (for diagnostics).
   *   - entry: the mcp-apps.json AppEntry (path, command, transport, url, config).
   *   - env: the resolved environment to check declared env vars against
   *          (defaults to process.env).
   * - output: Verdict (satisfied | unmet{missing[]}).
   * - NOT: it does not open sockets, spawn processes, or parse instructions.
   * - done when: all applicable structured checks have run and a Verdict returns.
   */
  export async function probe(args: {
    id: string
    entry: McpAppStore.AppEntry
    env?: Record<string, string | undefined>
  }): Promise<Verdict> {
    const { id, entry } = args
    const env = args.env ?? process.env
    const missing: Requirement[] = []

    // ── manifest: mcp.json exists + parses ───────────────────────────────
    // Read RAW (own JSON.parse) — NOT McpAppManifest.load(), which has a
    // side effect of auto-inferring + writing mcp.json when absent. We only
    // want to observe what is declared, never to materialize a manifest.
    const manifestPath = path.join(entry.path, "mcp.json")
    let mcpJson: Record<string, unknown> | undefined
    try {
      const raw = await fs.readFile(manifestPath, "utf-8")
      mcpJson = JSON.parse(raw) as Record<string, unknown>
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === "ENOENT") {
        missing.push({
          kind: "manifest",
          detail: `mcp.json not found at ${manifestPath}`,
          remediation: `Create ${manifestPath} declaring the MCP app's transport/command, or remove the app entry from mcp-apps.json.`,
        })
      } else {
        missing.push({
          kind: "manifest",
          detail: `mcp.json at ${manifestPath} could not be read/parsed: ${err instanceof Error ? err.message : String(err)}`,
          remediation: `Fix the JSON syntax in ${manifestPath}.`,
        })
      }
      // Without a manifest there is nothing further to structurally check.
      return finalize(id, missing)
    }

    // Effective transport: prefer the entry's (mcp-apps.json may override),
    // else the manifest's, else the schema default "stdio".
    const transport =
      entry.transport ?? (typeof mcpJson["transport"] === "string" ? (mcpJson["transport"] as string) : "stdio")

    // Effective command: entry.command (resolved at registration) takes
    // precedence; otherwise the manifest's declared command.
    const manifestCommand = Array.isArray(mcpJson["command"]) ? (mcpJson["command"] as unknown[]) : undefined
    const command =
      entry.command ?? (manifestCommand?.every((c) => typeof c === "string") ? (manifestCommand as string[]) : undefined)

    // ── reachable: transport endpoint structural precondition ────────────
    if (transport === "streamable-http" || transport === "sse") {
      const url = entry.url ?? (typeof mcpJson["url"] === "string" ? (mcpJson["url"] as string) : undefined)
      if (!url) {
        missing.push({
          kind: "reachable",
          detail: `transport=${transport} but no url declared (entry.url and mcp.json url both absent)`,
          remediation: `Declare a url for ${id} (e.g. unix:///path/to.sock:/mcp/ or http://host:port/mcp/).`,
        })
      } else if (url.startsWith("unix://")) {
        const socketPath = parseUnixSocketPath(url)
        if (!socketPath) {
          missing.push({
            kind: "reachable",
            detail: `unix:// url is malformed: ${url}`,
            remediation: `Use the form unix:///abs/path/to.sock:/http-path for ${id}.`,
          })
        } else {
          const ok = await pathExists(socketPath)
          if (!ok) {
            missing.push({
              kind: "reachable",
              detail: `unix socket not present at ${socketPath}`,
              remediation: `Start the ${id} service so it binds ${socketPath} (e.g. bring up its container), then retry.`,
            })
          }
        }
      } else {
        // TCP/http(s): require it to parse to a valid URL with a host.
        try {
          const parsed = new URL(url)
          if (!parsed.hostname) throw new Error("missing host")
        } catch {
          missing.push({
            kind: "reachable",
            detail: `url is not a parseable http(s) URL: ${url}`,
            remediation: `Fix the url for ${id} to a valid http(s):// endpoint with a host.`,
          })
        }
      }
    } else {
      // stdio: command[0] must resolve on PATH.
      if (!command || command.length === 0) {
        missing.push({
          kind: "reachable",
          detail: `transport=stdio but no command declared`,
          remediation: `Declare a command in ${manifestPath} (e.g. ["node", "server.js"]) for ${id}.`,
        })
      } else if (!resolvesOnPath(command[0])) {
        missing.push({
          kind: "binary",
          detail: `command binary not found on PATH: ${command[0]}`,
          remediation: `Install ${command[0]} or ensure it is on PATH for the daemon, then retry ${id}.`,
        })
      }
    }

    // ── binary: any declared command[0] (for non-stdio too) on PATH ──────
    // For http/sse transports a command may still be declared (e.g. a sidecar
    // launcher). Only check when present AND not already checked in the stdio
    // branch above.
    if ((transport === "streamable-http" || transport === "sse") && command && command.length > 0) {
      if (!resolvesOnPath(command[0])) {
        missing.push({
          kind: "binary",
          detail: `declared command binary not found on PATH: ${command[0]}`,
          remediation: `Install ${command[0]} or ensure it is on PATH for the daemon, then retry ${id}.`,
        })
      }
    }

    // ── env: each key in the declared env block must be present ──────────
    const declaredEnv = isStringRecord(mcpJson["env"]) ? (mcpJson["env"] as Record<string, string>) : undefined
    if (declaredEnv) {
      for (const key of Object.keys(declaredEnv)) {
        const present = env[key] !== undefined && env[key] !== ""
        if (!present) {
          missing.push({
            kind: "env",
            detail: `declared environment variable is not set: ${key}`,
            remediation: `Export ${key} (or add it to ${id}'s mcp-apps.json config) before connecting.`,
          })
        }
      }
    }

    return finalize(id, missing)
  }

  function finalize(id: string, missing: Requirement[]): Verdict {
    if (missing.length === 0) return { satisfied: true }
    log.warn("mcp prerequisite unmet", {
      id,
      missing: missing.map((m) => `${m.kind}: ${m.detail}`),
    })
    return { satisfied: false, missing }
  }

  /**
   * parseUnixSocketPath — extract the filesystem socket path from a
   * unix:///abs/path.sock:/http-path URL (mirrors index.ts parseUnixSocketUrl).
   * - input: a unix:// url string.
   * - output: the socket path, or undefined if not a unix url.
   * - NOT: it does not validate the http-path portion.
   */
  function parseUnixSocketPath(raw: string): string | undefined {
    if (!raw.startsWith("unix://")) return undefined
    const rest = raw.slice("unix://".length)
    const idx = rest.indexOf(":/")
    if (idx < 0) return rest || undefined
    const socketPath = rest.slice(0, idx)
    return socketPath || undefined
  }

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }

  /** resolvesOnPath — true if `bin` is an absolute existing file or on PATH. */
  function resolvesOnPath(bin: string): boolean {
    if (bin.includes("/")) {
      // Absolute or relative path: Bun.which still resolves relative against PATH,
      // so check the literal path for path-like binaries.
      return Bun.which(bin) !== null
    }
    return Bun.which(bin) !== null
  }

  function isStringRecord(v: unknown): v is Record<string, string> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false
    return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  }
}
