/**
 * mcp tool dispatcher for /specs/repo-incoming-attachments
 * + /specs/docxmcp-http-transport (phase 6 rewrite).
 *
 * The previous (bind-mount) staging implementation was REMOVED in
 * docxmcp-http-transport phase 6. The container-side bind mount has
 * been retired in favour of HTTP-over-Unix-socket transport. The
 * dispatcher's role narrows to:
 *
 *   1. before(): scan tool args for paths under <projectRoot>; for each
 *      such path, multipart-POST the file to the mcp app's /files
 *      endpoint, receive a token, rewrite the path → token in the args.
 *
 *   2. after(): pass through. Produced files are surfaced by the mcp
 *      server as MCP `EmbeddedResource` entries in the tool result's
 *      `content[]` (DD-10 rev 3 / 2026-05-12). The host LLM consumes
 *      them via standard `resources/read` — no client-specific
 *      post-processing happens here. We do NOT delete tokens after
 *      the call: the resource URIs remain valid until the token TTL
 *      (default 1h) expires, so the AI can read them at its own pace.
 *
 *      Historical client-specific paths (now retired):
 *        DD-10 rev 1: tar + base64 bundle in a custom
 *          `structuredContent.bundle_tar_b64` field. Required a custom
 *          client decoder; not portable.
 *        DD-10 rev 2: list of `produced[]` + custom `fetch_via` marker
 *          + custom `GET /files/{token}/blob/{rel}` endpoint. Still
 *          required a custom client.
 *      Both are gone. The current path is vanilla MCP and works with
 *      any compliant client (Claude Desktop, Cursor, Continue, Cline,
 *      opencode, ...).
 *
 * What this file no longer does (deleted in phase 6 cutover):
 *   - bind-mount staging (mcp-staging/<app>/staging/<sha>.<ext>)
 *   - hard-link tree publishing
 *   - break-on-write + nlink detection
 *   - EXDEV cross-fs fallback
 *   - host-side manifest.json sha integrity
 *
 * Logs: ~/.local/share/opencode/log/debug.log under
 *   service: "incoming.dispatcher.http"
 *
 * Decisions: /specs/docxmcp-http-transport DD-1, DD-2, DD-9, DD-10,
 * DD-12, DD-14, DD-17.
 */
import path from "node:path"
import fs from "node:fs/promises"
import fssync from "node:fs"
import { Log } from "../util/log"
import { Bus } from "@/bus"
import { BusEvent } from "../bus/bus-event"
import { IncomingPaths } from "./paths"
import { McpAppStore } from "../mcp/app-store"
import { McpAppUrlResolver } from "../mcp/url-resolver"
import { MCP } from "../mcp"
import z from "zod"

export namespace IncomingDispatcher {
  const log = Log.create({ service: "incoming.dispatcher.http" })

  // ── Bus events ─────────────────────────────────────────────────────────

  export const HttpUploadStarted = BusEvent.define(
    "incoming.dispatcher.http-upload-started",
    z.object({
      appId: z.string(),
      toolName: z.string(),
      repoPath: z.string(),
      sizeBytes: z.number(),
    }),
  )
  export const HttpUploadSucceeded = BusEvent.define(
    "incoming.dispatcher.http-upload-succeeded",
    z.object({
      appId: z.string(),
      toolName: z.string(),
      repoPath: z.string(),
      token: z.string(),
      sha256: z.string(),
      sizeBytes: z.number(),
      durationMs: z.number(),
    }),
  )
  export const HttpUploadFailed = BusEvent.define(
    "incoming.dispatcher.http-upload-failed",
    z.object({
      appId: z.string(),
      toolName: z.string(),
      repoPath: z.string(),
      errorCode: z.string(),
      message: z.string(),
    }),
  )
  export const BundlePublished = BusEvent.define(
    "incoming.dispatcher.bundle-published",
    z.object({
      appId: z.string(),
      bundleRepoPath: z.string(),
      sizeBytes: z.number(),
      fromCache: z.boolean(),
    }),
  )

  // ── helpers ────────────────────────────────────────────────────────────

  function looksLikeRepoPath(value: string): boolean {
    if (typeof value !== "string" || value.length === 0) return false
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
    if (value.startsWith("/")) return false
    if (value.startsWith("./")) return true
    if (value.includes("/")) return true
    if (/\.(docx?|xlsx?|pptx?|pdf|md|txt|csv|json|xml|yml|yaml)$/i.test(value)) return true
    return false
  }

  /**
   * Walk an args tree, calling `rewriter` on every string that looks
   * like a project-relative path. Returning a string from `rewriter`
   * substitutes the value; returning null leaves it unchanged.
   *
   * The rewriter is async because uploading a file to docxmcp is async.
   * To avoid `await` inside a sync walk we collect candidates first,
   * then perform the async transformations and rebuild.
   */
  async function rewriteCandidates(
    args: Record<string, unknown>,
    rewriter: (candidate: string) => Promise<string | null>,
  ): Promise<Record<string, unknown>> {
    const tasks: Array<Promise<unknown>> = []
    function walk(node: unknown): unknown {
      if (typeof node === "string") {
        if (looksLikeRepoPath(node)) {
          const norm = node.startsWith("./") ? node.slice(2) : node
          // We pre-launch the async rewrite and await later. But we
          // also need to substitute synchronously, which means we have
          // to walk twice: first collect, then walk again with results.
          // Simpler: do it in two passes.
          return node // leave unchanged in this initial walk
        }
        return node
      }
      if (Array.isArray(node)) return node.map(walk)
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node)) out[k] = walk(v)
        return out
      }
      return node
    }
    void walk(args)
    void tasks
    // Two-pass: collect candidates (paths), upload them in parallel,
    // then walk again substituting the resolved replacements.
    const candidateSet = new Map<string, string | null>()
    function collect(node: unknown): void {
      if (typeof node === "string") {
        if (looksLikeRepoPath(node)) {
          const norm = node.startsWith("./") ? node.slice(2) : node
          if (!candidateSet.has(norm)) candidateSet.set(norm, null)
        }
        return
      }
      if (Array.isArray(node)) {
        for (const v of node) collect(v)
        return
      }
      if (node && typeof node === "object") {
        for (const v of Object.values(node)) collect(v)
      }
    }
    collect(args)

    await Promise.all(
      Array.from(candidateSet.keys()).map(async (cand) => {
        const replacement = await rewriter(cand)
        candidateSet.set(cand, replacement)
      }),
    )

    function walk2(node: unknown): unknown {
      if (typeof node === "string") {
        if (looksLikeRepoPath(node)) {
          const norm = node.startsWith("./") ? node.slice(2) : node
          const repl = candidateSet.get(norm)
          if (repl) return repl
        }
        return node
      }
      if (Array.isArray(node)) return node.map(walk2)
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node)) out[k] = walk2(v)
        return out
      }
      return node
    }
    return walk2(args) as Record<string, unknown>
  }

  // ── Resolve mcp app's HTTP base URL and unix-socket path ─────────────

  type AppHttpEndpoint = {
    httpBase: string // e.g. "http://docxmcp.local"
    socketPath: string | null // unix socket path for fetch { unix: ... }
  }

  async function resolveAppHttpEndpoint(appId: string): Promise<AppHttpEndpoint | null> {
    const config = await McpAppStore.loadConfig().catch(() => null)
    if (!config) return null
    const entry = config.apps[appId]
    if (!entry || entry.transport !== "streamable-http" || !entry.url) return null

    // plans/mcp_per_user_socket_rca DD-2 / DD-3: expand template tokens
    // (${UID}, ${USER}, ${HOME}, ${XDG_RUNTIME_DIR}) before extracting
    // the socket path or parsing as a plain URL.
    const url = McpAppUrlResolver.resolveForApp(appId, entry.url, "dispatcher")
    if (url.startsWith("unix://")) {
      const rest = url.slice("unix://".length)
      const idx = rest.indexOf(":/")
      const socketPath = idx < 0 ? rest : rest.slice(0, idx)
      return { httpBase: "http://docxmcp.local", socketPath }
    }
    // Plain HTTP — strip path (we'll append /files etc).
    try {
      const parsed = new URL(url)
      return { httpBase: `${parsed.protocol}//${parsed.host}`, socketPath: null }
    } catch {
      return null
    }
  }

  async function fetchWithUds(
    url: string,
    init: RequestInit,
    socketPath: string | null,
  ): Promise<Response> {
    const opts: RequestInit & { unix?: string } = { ...init }
    if (socketPath) opts.unix = socketPath
    return fetch(url, opts as any)
  }

  // ── Upload + delete ────────────────────────────────────────────────

  async function uploadFile(input: {
    appId: string
    repoPath: string
    projectRoot: string
    toolName: string
  }): Promise<{ token: string; sha256: string; sizeBytes: number } | null> {
    const ep = await resolveAppHttpEndpoint(input.appId)
    if (!ep) return null

    const absolute = path.resolve(input.projectRoot, input.repoPath)
    if (!fssync.existsSync(absolute)) return null
    const stat = fssync.statSync(absolute)
    if (!stat.isFile()) return null

    await Bus.publish(HttpUploadStarted, {
      appId: input.appId,
      toolName: input.toolName,
      repoPath: input.repoPath,
      sizeBytes: stat.size,
    }).catch(() => {})

    const startedAt = Date.now()
    const filename = path.basename(input.repoPath)
    let buf: Buffer
    try {
      buf = await fs.readFile(absolute)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await Bus.publish(HttpUploadFailed, {
        appId: input.appId,
        toolName: input.toolName,
        repoPath: input.repoPath,
        errorCode: "DSP-3000",
        message: `read failed: ${msg}`,
      }).catch(() => {})
      return null
    }
    const formData = new FormData()
    formData.append("file", new Blob([new Uint8Array(buf)]), filename)

    let resp: Response
    try {
      resp = await fetchWithUds(`${ep.httpBase}/files`, {
        method: "POST",
        body: formData,
      }, ep.socketPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn("http upload failed (transport)", {
        appId: input.appId,
        repoPath: input.repoPath,
        error: msg,
      })
      await Bus.publish(HttpUploadFailed, {
        appId: input.appId,
        toolName: input.toolName,
        repoPath: input.repoPath,
        errorCode: "DSP-3001",
        message: msg,
      }).catch(() => {})
      return null
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      log.warn("http upload failed (status)", {
        appId: input.appId,
        repoPath: input.repoPath,
        status: resp.status,
        body: text.slice(0, 200),
      })
      await Bus.publish(HttpUploadFailed, {
        appId: input.appId,
        toolName: input.toolName,
        repoPath: input.repoPath,
        errorCode: "DSP-3002",
        message: `status ${resp.status}: ${text.slice(0, 200)}`,
      }).catch(() => {})
      return null
    }

    const body = (await resp.json()) as { token: string; sha256: string; size: number }
    const durationMs = Date.now() - startedAt
    await Bus.publish(HttpUploadSucceeded, {
      appId: input.appId,
      toolName: input.toolName,
      repoPath: input.repoPath,
      token: body.token,
      sha256: body.sha256,
      sizeBytes: body.size,
      durationMs,
    }).catch(() => {})
    log.info("http upload succeeded", {
      appId: input.appId,
      repoPath: input.repoPath,
      token: body.token,
      sha256: body.sha256,
      durationMs,
    })
    return { token: body.token, sha256: body.sha256, sizeBytes: body.size }
  }

  async function deleteToken(appId: string, token: string): Promise<void> {
    const ep = await resolveAppHttpEndpoint(appId)
    if (!ep) return
    try {
      await fetchWithUds(`${ep.httpBase}/files/${encodeURIComponent(token)}`, {
        method: "DELETE",
      }, ep.socketPath)
    } catch (err) {
      // Best effort.
      log.info("token cleanup failed (non-fatal)", {
        appId,
        token,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Server-initiated helpers (used by the upload-time decompose hook,
  //    not by AI tool calls) ─────────────────────────────────────────────

  /**
   * Upload an Office file to its mcp app's /files endpoint and receive
   * a token. Public wrapper around the private uploadFile so the
   * upload-time decompose hook (specs/docx-upload-autodecompose) can
   * reuse the same transport without re-implementing it.
   */
  export async function uploadFileForApp(input: {
    appId: string
    repoPath: string
    projectRoot: string
    toolName: string
  }): Promise<{ token: string; sha256: string; sizeBytes: number } | null> {
    return uploadFile(input)
  }

  /**
   * Resource-link entry shape extracted from an MCP tool result's
   * `content[]`. Matches the wire schema of
   * https://modelcontextprotocol.io/specification → ResourceLink.
   */
  export interface ProducedResourceLink {
    uri: string
    name?: string
    mimeType?: string
    size?: number
  }

  /**
   * Walk an MCP tool result's `content[]` and collect every entry
   * whose `type === "resource_link"`. Internal flows (decompose-hook,
   * poll-loop) use this to discover what the server produced WITHOUT
   * relying on any custom payload field — the protocol-standard list.
   */
  export function extractResourceLinks(result: unknown): ProducedResourceLink[] {
    if (!result || typeof result !== "object") return []
    const content = (result as { content?: unknown[] }).content
    if (!Array.isArray(content)) return []
    const links: ProducedResourceLink[] = []
    for (const item of content) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>
      if (obj.type !== "resource_link") continue
      const uri = typeof obj.uri === "string" ? obj.uri : undefined
      if (!uri) continue
      links.push({
        uri,
        name: typeof obj.name === "string" ? obj.name : undefined,
        mimeType: typeof obj.mimeType === "string" ? obj.mimeType : undefined,
        size: typeof obj.size === "number" ? obj.size : undefined,
      })
    }
    return links
  }

  /**
   * Background materialization helper. Used by opencode-internal flows
   * that need produced files landed on host disk WITHOUT the LLM in
   * the loop (decompose-hook on upload, poll-loop for the background
   * extract phase). The on-disk position is the same as historically:
   * `<projectRoot>/<sourceDir>/<stem>/<rel>`.
   *
   * Implementation: for each resource_link in the tool result we call
   * the standard MCP `resources/read` RPC on the same client used for
   * the original tool call. There is no docxmcp-specific protocol
   * here — any compliant server that returns resource_links will work.
   *
   * For LLM-driven tool calls (AI calls a docxmcp tool, sees the
   * resource_links in the result, and uses `resources/read` itself),
   * this helper is NOT invoked. The LLM consumes resources at its own
   * pace via its host MCP client.
   */
  export async function materializeResourceLinks(input: {
    appId: string
    links: ProducedResourceLink[]
    repoPath: string
    projectRoot: string
    fromCache: boolean
  }): Promise<void> {
    if (input.links.length === 0) return

    const clients = await MCP.clients()
    const client = clients[`mcpapp-${input.appId}`] ?? clients[input.appId]
    if (!client) {
      log.warn("materializeResourceLinks: mcp client not connected", { appId: input.appId })
      return
    }

    const stem = IncomingPaths.stem(path.basename(input.repoPath))
    const sourceDir = path.dirname(input.repoPath)
    const bundleRepoRel = sourceDir === "." || sourceDir === ""
      ? stem
      : path.join(sourceDir, stem)
    const targetDir = path.join(input.projectRoot, bundleRepoRel)
    await fs.mkdir(targetDir, { recursive: true })

    let totalBytes = 0
    const errors: Array<{ uri: string; error: string }> = []

    async function readOne(link: ProducedResourceLink): Promise<void> {
      // Derive on-disk rel from the uri's path tail.
      // Canonical docxmcp form: docxmcp://files/{token}/{rel...}
      // For any other server emitting resource_link we fall back to
      // the URI's path component as best-effort.
      let rel: string | null = null
      try {
        const u = new URL(link.uri)
        const pathPart = u.pathname.replace(/^\/+/, "")
        if (u.protocol === "docxmcp:" && pathPart.startsWith("files/")) {
          // strip "files/{token}/" — keep just the trailing rel
          const after = pathPart.slice("files/".length)
          const slash = after.indexOf("/")
          rel = slash >= 0 ? after.slice(slash + 1) : null
        } else {
          // generic fallback: use the URI's last segment
          rel = pathPart || link.name || null
        }
      } catch {
        rel = link.name ?? null
      }
      if (!rel) {
        errors.push({ uri: link.uri, error: "could not derive on-disk rel" })
        return
      }

      const resp = await client.readResource({ uri: link.uri })
      const contents = (resp as { contents?: unknown[] }).contents
      if (!Array.isArray(contents) || contents.length === 0) {
        errors.push({ uri: link.uri, error: "empty contents" })
        return
      }

      const dest = path.join(targetDir, rel)
      // Guard against path traversal via crafted URIs.
      const destAbs = path.resolve(dest)
      const targetAbs = path.resolve(targetDir)
      if (!destAbs.startsWith(targetAbs + path.sep) && destAbs !== targetAbs) {
        errors.push({ uri: link.uri, error: `path escapes bundle dir: ${rel}` })
        return
      }
      await fs.mkdir(path.dirname(dest), { recursive: true })

      // Each content entry is either {text} or {blob: base64}. Write
      // the first entry only — servers should return one entry per
      // resources/read call (multi-entry responses are for templates).
      const first = contents[0] as { text?: string; blob?: string }
      if (typeof first.text === "string") {
        const buf = Buffer.from(first.text, "utf-8")
        await fs.writeFile(dest, buf)
        totalBytes += buf.byteLength
      } else if (typeof first.blob === "string") {
        const buf = Buffer.from(first.blob, "base64")
        await fs.writeFile(dest, buf)
        totalBytes += buf.byteLength
      } else {
        errors.push({ uri: link.uri, error: "neither text nor blob" })
      }
    }

    // Bounded parallel reads — MCP transport may serialise but we
    // amortise the per-call overhead.
    const queue = [...input.links]
    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const link = queue.shift()
        if (!link) return
        try {
          await readOne(link)
        } catch (err) {
          errors.push({
            uri: link.uri,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    const FETCH_PARALLELISM = 6
    await Promise.all(
      Array.from(
        { length: Math.min(FETCH_PARALLELISM, input.links.length) },
        () => worker(),
      ),
    )

    if (errors.length > 0) {
      log.warn("materializeResourceLinks partial failure", {
        appId: input.appId,
        succeeded: input.links.length - errors.length,
        failed: errors.length,
        firstError: errors[0],
      })
    }

    await Bus.publish(BundlePublished, {
      appId: input.appId,
      bundleRepoPath: bundleRepoRel,
      sizeBytes: totalBytes,
      fromCache: input.fromCache,
    }).catch(() => {})
    log.info("resource links materialized", {
      appId: input.appId,
      bundleRepoPath: bundleRepoRel,
      fileCount: input.links.length - errors.length,
      sizeBytes: totalBytes,
      fromCache: input.fromCache,
    })
  }

  /**
   * Best-effort token cleanup. Used by the polling loop after the
   * background phase finishes (or after the safety cap fires) so the
   * docxmcp container doesn't accumulate dead tokens.
   */
  export async function deleteTokenForApp(appId: string, token: string): Promise<void> {
    return deleteToken(appId, token)
  }

  // ── Top-level before / after ───────────────────────────────────────────

  export interface DispatchContext {
    appId: string
    toolName: string
    projectRoot: string | null
    sessionID: string | null
    uploadedTokens: Array<{ repoPath: string; token: string; sha256: string }>
    skipMcpCall: boolean
    cacheHit?: { repoBundlePath: string; sha: string }
  }

  export async function before(input: {
    toolName: string
    args: Record<string, unknown>
    appId: string
    sessionID: string | null
  }): Promise<{ rewrittenArgs: Record<string, unknown>; ctx: DispatchContext }> {
    let projectRoot: string | null
    try {
      projectRoot = IncomingPaths.projectRoot()
    } catch {
      projectRoot = null
    }

    const ctx: DispatchContext = {
      appId: input.appId,
      toolName: input.toolName,
      projectRoot,
      sessionID: input.sessionID,
      uploadedTokens: [],
      skipMcpCall: false,
    }

    if (!projectRoot) {
      // No project context — pass args through. Tools that need a path
      // will fail inside the mcp server with a clear error.
      return { rewrittenArgs: input.args, ctx }
    }

    const rewrittenArgs = await rewriteCandidates(input.args, async (candidate) => {
      const result = await uploadFile({
        appId: input.appId,
        repoPath: candidate,
        projectRoot,
        toolName: input.toolName,
      })
      if (!result) return null
      ctx.uploadedTokens.push({
        repoPath: candidate,
        token: result.token,
        sha256: result.sha256,
      })
      return result.token
    })

    return { rewrittenArgs, ctx }
  }

  /**
   * Pass-through. Produced files are surfaced by the mcp server as
   * MCP `EmbeddedResource` entries (DD-10 rev 3); the host LLM
   * retrieves them via standard `resources/read`. Tokens are NOT
   * deleted here so the resource URIs stay valid for the rest of the
   * turn; the docxmcp-side reaper evicts on TTL idle (default 1h).
   */
  export async function after(input: {
    result: unknown
    ctx: DispatchContext
  }): Promise<unknown> {
    return input.result
  }


  // /specs/docxmcp-http-transport phase 6: the following are no-ops
  // retained for compatibility with the old import surface. They were
  // previously responsible for the bind-mount break-on-write hard-link
  // detach; since bind mounts are gone, no detach is possible or needed.
  export async function breakHardLinkBeforeWrite(_path: string): Promise<void> {
    // no-op (DD-9 retired the hard-link cache)
  }

  // Test seam.
  export const __forTesting = {
    looksLikeRepoPath,
    parseUnixSocketUrl: (raw: string) => {
      if (!raw.startsWith("unix://")) return null
      const rest = raw.slice("unix://".length)
      const idx = rest.indexOf(":/")
      return idx < 0
        ? { socketPath: rest, httpPath: "/" }
        : { socketPath: rest.slice(0, idx), httpPath: rest.slice(idx + 1) }
    },
  }
}
