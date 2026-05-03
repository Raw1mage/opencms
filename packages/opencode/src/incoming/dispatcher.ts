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
 *   2. after(): inspect the mcp tool's structured result for a
 *      `bundle_tar_b64` payload; if present, decode + extract into the
 *      bundle's repo path (sibling of the source file). Best-effort
 *      DELETE the tokens we created during before().
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

    const url = entry.url
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
    formData.append("file", new Blob([buf]), filename)

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
   * Extract a base64 tar bundle into the bundle dir co-located with
   * the source file. Public wrapper around the private publishBundle.
   * The upload-time decompose hook uses this to land the fast-phase
   * bundle returned by docxmcp's extract_all.
   */
  export async function publishBundleForApp(input: {
    appId: string
    repoPath: string
    projectRoot: string
    tarB64: string
    fromCache: boolean
  }): Promise<void> {
    return publishBundle(input)
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
   * Decode a base64-encoded tar bundle written into the mcp tool result
   * (DD-10) and unpack into <repo>/<sourceDir>/<stem>/. Best-effort
   * cleanup of all tokens we issued in before().
   */
  export async function after(input: {
    result: unknown
    ctx: DispatchContext
  }): Promise<unknown> {
    const { ctx } = input

    // Inspect result for a structured bundle payload.
    if (ctx.projectRoot && input.result && typeof input.result === "object") {
      const r = input.result as { structuredContent?: { bundle_tar_b64?: string; from_cache?: boolean } }
      const sc = r.structuredContent
      if (sc?.bundle_tar_b64) {
        for (const upload of ctx.uploadedTokens) {
          try {
            await publishBundle({
              tarB64: sc.bundle_tar_b64,
              repoPath: upload.repoPath,
              projectRoot: ctx.projectRoot,
              fromCache: !!sc.from_cache,
              appId: ctx.appId,
            })
            // Once we publish, only do it once even if multiple uploads.
            break
          } catch (err) {
            log.warn("bundle publish failed", {
              repoPath: upload.repoPath,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    }

    // Best-effort cleanup of tokens.
    for (const t of ctx.uploadedTokens) {
      void deleteToken(ctx.appId, t.token)
    }

    return input.result
  }

  async function publishBundle(input: {
    tarB64: string
    repoPath: string
    projectRoot: string
    fromCache: boolean
    appId: string
  }): Promise<void> {
    const stem = IncomingPaths.stem(path.basename(input.repoPath))
    const sourceDir = path.dirname(input.repoPath)
    const bundleRepoRel = sourceDir === "." || sourceDir === ""
      ? stem
      : path.join(sourceDir, stem)
    const targetDir = path.join(input.projectRoot, bundleRepoRel)
    await fs.mkdir(targetDir, { recursive: true })

    const tarBuffer = Buffer.from(input.tarB64, "base64")
    // Bun has a built-in tar parser via `Bun.spawn(["tar", "-xf", "-"])`
    // but the simplest portable approach: shell out to tar.
    await new Promise<void>((resolve, reject) => {
      const proc = Bun.spawn(["tar", "-xf", "-", "-C", targetDir], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      })
      const w = proc.stdin as unknown as { write: (b: Uint8Array) => unknown; end: () => Promise<void> | void }
      w.write(tarBuffer)
      Promise.resolve(w.end()).then(async () => {
        const code = await proc.exited
        if (code !== 0) {
          const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
          reject(new Error(`tar -xf failed: ${err.trim()}`))
        } else {
          resolve()
        }
      })
    })

    await Bus.publish(BundlePublished, {
      appId: input.appId,
      bundleRepoPath: bundleRepoRel,
      sizeBytes: tarBuffer.byteLength,
      fromCache: input.fromCache,
    }).catch(() => {})
    log.info("bundle published", {
      appId: input.appId,
      bundleRepoPath: bundleRepoRel,
      sizeBytes: tarBuffer.byteLength,
      fromCache: input.fromCache,
    })
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
