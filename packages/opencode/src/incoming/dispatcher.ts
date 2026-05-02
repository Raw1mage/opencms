/**
 * mcp tool dispatcher for /specs/repo-incoming-attachments.
 *
 * Phase 3 implementation. Wraps every mcp tool call to:
 *
 *   1. before(): scan args for incoming/** paths → stage each into
 *      ~/.local/share/opencode/log/...mcp-staging/<appId>/staging/<sha>.<ext>
 *      and rewrite args so the mcp container sees /state/staging/<sha>.<ext>.
 *      If a sha-keyed bundle is already cached for this (appId, sha) AND
 *      manifest.json integrity is valid, short-circuit — return a synthetic
 *      result without calling the mcp tool (DD-16, DD-17 cache-hit).
 *
 *   2. after(): walk the mcp tool's result, replace every staging-path
 *      reference back to the repo-relative path the LLM should see
 *      (DD-14), and publish bundles/<sha>/ → <repo>/incoming/<stem>/ via
 *      hard-link (DD-11) with EXDEV → cp -r fallback (DD-15). Append a
 *      `bundle-published` history entry for traceability.
 *
 * The container's mount boundary stays narrow (only /state). The host
 * never asks the container to reach into the user's repo (DD-3).
 *
 * All decisions and risks: /specs/repo-incoming-attachments/design.md
 * (DD-3, DD-5, DD-11, DD-14, DD-15, DD-16, DD-17).
 *
 * Logs live in ~/.local/share/opencode/log/debug.log under
 * `service: "incoming.dispatcher"`. Tail with:
 *   tail -F ~/.local/share/opencode/log/debug.log | grep '"service":"incoming'
 */
import path from "node:path"
import fs from "node:fs/promises"
import fssync from "node:fs"
import { createHash } from "node:crypto"
import { Log } from "../util/log"
import { Bus } from "@/bus"
import { BusEvent } from "../bus/bus-event"
import { Global } from "@/global"
import { IncomingPaths } from "./paths"
import { IncomingHistory } from "./history"
import z from "zod"

export namespace IncomingDispatcher {
  const log = Log.create({ service: "incoming.dispatcher" })

  // /specs/repo-incoming-attachments DD-5
  const STAGING_BASE = path.join(Global.Path.state, "mcp-staging")

  function appStagingDir(appId: string): string {
    return path.join(STAGING_BASE, appId, "staging")
  }
  function appBundlesDir(appId: string): string {
    return path.join(STAGING_BASE, appId, "bundles")
  }
  function bundleDirFor(appId: string, sha: string): string {
    return path.join(appBundlesDir(appId), sha)
  }
  function manifestPathFor(appId: string, sha: string): string {
    return path.join(bundleDirFor(appId, sha), "manifest.json")
  }
  function inContainerStagingPath(sha: string, ext: string): string {
    return `/state/staging/${sha}${ext}`
  }
  function inContainerBundlesPath(sha: string): string {
    return `/state/bundles/${sha}`
  }

  // ── Bus events ─────────────────────────────────────────────────────────

  export const CacheHit = BusEvent.define(
    "mcp.dispatcher.cache-hit",
    z.object({
      appId: z.string(),
      toolName: z.string(),
      sha256: z.string(),
      repoPath: z.string(),
      publishedAt: z.string(),
    }),
  )
  export const CacheMiss = BusEvent.define(
    "mcp.dispatcher.cache-miss",
    z.object({ appId: z.string(), toolName: z.string(), sha256: z.string() }),
  )
  export const CacheCorrupted = BusEvent.define(
    "mcp.dispatcher.cache-corrupted",
    z.object({
      appId: z.string(),
      sha256: z.string(),
      expectedSha: z.string(),
      actualSha: z.string(),
      bundlePath: z.string(),
    }),
  )
  export const CrossFsFallback = BusEvent.define(
    "mcp.dispatcher.cross-fs-fallback",
    z.object({
      appId: z.string(),
      sha256: z.string(),
      reason: z.enum(["diff-st_dev", "EXDEV"]),
    }),
  )
  export const PublishFailed = BusEvent.define(
    "incoming.dispatcher.publish-failed",
    z.object({ sha256: z.string(), repoPath: z.string(), errno: z.string() }),
  )

  // ── helpers ────────────────────────────────────────────────────────────

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
  }

  async function shaOfFile(filepath: string): Promise<string> {
    const stream = fssync.createReadStream(filepath)
    const hasher = createHash("sha256")
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => hasher.update(chunk))
      stream.on("end", () => resolve(hasher.digest("hex")))
      stream.on("error", reject)
    })
  }

  /**
   * Heuristic: is `value` a candidate path string we should attempt to
   * resolve against the project root and stage for the mcp container?
   *
   * v1 (incoming/ only) was too narrow — AI could not ask docxmcp to read
   * a pre-existing repo file like `docx/foo.docx`. v2 accepts any string
   * that *looks like* a relative path (no protocol, no leading `/`,
   * contains `/` or has a likely-document extension). The actual
   * existence check happens in the rewriter; non-resolving strings fall
   * through unchanged.
   */
  function looksLikeRepoPath(value: string): boolean {
    if (typeof value !== "string" || value.length === 0) return false
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false // protocol e.g. http:, file:, data:
    if (value.startsWith("/")) return false // absolute path — not a project relative
    if (value.startsWith("./")) return true
    if (value.includes("/")) return true
    // bare filename with a known doc extension
    if (/\.(docx?|xlsx?|pptx?|pdf|md|txt|csv|json|xml|yml|yaml)$/i.test(value)) return true
    return false
  }

  // Walk an arbitrary args tree, collecting candidate path strings and
  // running them through `rewriter`. Returning a string from `rewriter`
  // replaces the value; returning null leaves it unchanged.
  function rewriteIncomingPathsInArgs(
    args: Record<string, unknown>,
    rewriter: (candidate: string) => string | null,
  ): { rewritten: Record<string, unknown>; mappings: Array<{ from: string; to: string }> } {
    const mappings: Array<{ from: string; to: string }> = []
    function walk(node: unknown): unknown {
      if (typeof node === "string") {
        if (looksLikeRepoPath(node)) {
          // Strip leading ./ for normalization
          const norm = node.startsWith("./") ? node.slice(2) : node
          const replacement = rewriter(norm)
          if (replacement) {
            mappings.push({ from: node, to: replacement })
            return replacement
          }
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
    const rewritten = walk(args) as Record<string, unknown>
    return { rewritten, mappings }
  }

  // Same shape, walking a result and replacing staging→repo prefixes.
  function rewriteResultPaths(
    result: unknown,
    replacements: Array<{ from: string; to: string }>,
  ): unknown {
    if (replacements.length === 0) return result
    function applyToString(s: string): string {
      let out = s
      for (const r of replacements) {
        if (out.includes(r.from)) out = out.split(r.from).join(r.to)
      }
      return out
    }
    function walk(node: unknown): unknown {
      if (typeof node === "string") return applyToString(node)
      if (Array.isArray(node)) return node.map(walk)
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node)) out[k] = walk(v)
        return out
      }
      return node
    }
    return walk(result)
  }

  // ── DD-16 manifest integrity ──────────────────────────────────────────

  type ManifestStatus = "valid" | "missing" | "corrupted"

  async function verifyManifest(appId: string, sha: string): Promise<ManifestStatus> {
    const mfPath = manifestPathFor(appId, sha)
    if (!fssync.existsSync(mfPath)) return "missing"
    try {
      const buf = await fs.readFile(mfPath, "utf8")
      const parsed = JSON.parse(buf) as { sha256?: string }
      const claimed = parsed?.sha256
      if (typeof claimed === "string" && claimed === sha) return "valid"
      log.warn("dispatcher: bundle manifest sha mismatch", {
        appId,
        sha,
        claimed: claimed ?? "(missing)",
      })
      await Bus.publish(CacheCorrupted, {
        appId,
        sha256: sha,
        expectedSha: sha,
        actualSha: claimed ?? "(missing)",
        bundlePath: bundleDirFor(appId, sha),
      }).catch(() => {})
      return "corrupted"
    } catch (err) {
      log.warn("dispatcher: manifest unreadable", {
        appId,
        sha,
        error: err instanceof Error ? err.message : String(err),
      })
      return "corrupted"
    }
  }

  // ── DD-15 hard-link / cp -r fallback ──────────────────────────────────

  async function copyTreeWithFallback(
    src: string,
    dst: string,
    appId: string,
    sha: string,
  ): Promise<{ method: "link" | "cp"; reason?: string }> {
    await ensureDir(path.dirname(dst))
    let srcStat: fssync.Stats
    let dstParentStat: fssync.Stats
    try {
      srcStat = await fs.stat(src)
      dstParentStat = await fs.stat(path.dirname(dst))
    } catch {
      // bail to cp
      await fs.cp(src, dst, { recursive: true, force: true })
      return { method: "cp" }
    }
    const sameFs = srcStat.dev === dstParentStat.dev
    if (!sameFs) {
      log.info("dispatcher: cross-fs publish, using cp -r", { sha, src, dst })
      await Bus.publish(CrossFsFallback, { appId, sha256: sha, reason: "diff-st_dev" }).catch(() => {})
      await fs.cp(src, dst, { recursive: true, force: true })
      return { method: "cp", reason: "diff-st_dev" }
    }
    try {
      await linkTreeRecursive(src, dst)
      return { method: "link" }
    } catch (err: any) {
      if (err?.code === "EXDEV") {
        log.info("dispatcher: link EXDEV, falling back to cp -r", { sha, src, dst })
        await Bus.publish(CrossFsFallback, { appId, sha256: sha, reason: "EXDEV" }).catch(() => {})
        await fs.cp(src, dst, { recursive: true, force: true })
        return { method: "cp", reason: "EXDEV" }
      }
      throw err
    }
  }

  async function linkTreeRecursive(src: string, dst: string): Promise<void> {
    const srcStat = await fs.stat(src)
    if (srcStat.isFile()) {
      try {
        await fs.link(src, dst)
      } catch (err: any) {
        if (err?.code === "EEXIST") {
          // Replace destination — break-on-write semantics: we do NOT
          // unlink src, only clobber dst.
          await fs.unlink(dst)
          await fs.link(src, dst)
        } else throw err
      }
      return
    }
    if (srcStat.isDirectory()) {
      await ensureDir(dst)
      const entries = await fs.readdir(src)
      for (const e of entries) {
        await linkTreeRecursive(path.join(src, e), path.join(dst, e))
      }
      return
    }
    // symlinks / sockets / etc — fall back to cp for that one entry
    await fs.cp(src, dst, { recursive: true, force: true })
  }

  // ── DD-11 break-on-write (exposed for tool-write hook in phase 4) ────

  /**
   * If `targetPath` is hard-linked to one or more other inodes (st_nlink > 1),
   * detach it: copy the file to a temp sibling, atomic-rename onto target.
   * After this, writing to targetPath cannot affect any cache file.
   */
  export async function breakHardLinkBeforeWrite(targetPath: string): Promise<void> {
    let stat: fssync.Stats
    try {
      stat = await fs.stat(targetPath)
    } catch (err: any) {
      if (err?.code === "ENOENT") return
      throw err
    }
    if (!stat.isFile() || stat.nlink <= 1) return
    const tmp = `${targetPath}.tmp-detach-${Date.now()}`
    await fs.copyFile(targetPath, tmp)
    await fs.rename(tmp, targetPath)
    log.info("dispatcher: broke hard-link before write", { path: targetPath })
  }

  // ── stage-in ──────────────────────────────────────────────────────────

  async function stageFile(input: {
    repoPath: string
    appId: string
    projectRoot: string
  }): Promise<{ sha: string; ext: string; stagedPath: string }> {
    const absoluteSrc = path.resolve(input.projectRoot, input.repoPath)
    if (!fssync.existsSync(absoluteSrc)) {
      throw new Error(
        `incoming.dispatcher: stage source missing: ${input.repoPath} (resolved ${absoluteSrc})`,
      )
    }
    const sha = await shaOfFile(absoluteSrc)
    const ext = path.extname(absoluteSrc)
    const stagingDir = appStagingDir(input.appId)
    await ensureDir(stagingDir)
    const stagedPath = path.join(stagingDir, `${sha}${ext}`)
    if (!fssync.existsSync(stagedPath)) {
      // hard-link first; fall back to cp on EXDEV
      try {
        await fs.link(absoluteSrc, stagedPath)
      } catch (err: any) {
        if (err?.code === "EXDEV" || err?.code === "EPERM") {
          await fs.copyFile(absoluteSrc, stagedPath)
        } else if (err?.code !== "EEXIST") throw err
      }
    }
    return { sha, ext, stagedPath }
  }

  // ── publish-out ───────────────────────────────────────────────────────

  async function publishBundle(input: {
    appId: string
    sha: string
    stem: string
    /**
     * Repo-relative path where the bundle should publish. For an upload at
     * incoming/合約.docx → "incoming/合約". For a pre-existing repo file
     * docx/foo.docx → "docx/foo". Always sibling to the source file.
     */
    bundleRepoPath: string
    projectRoot: string
    sessionID: string
  }): Promise<{ repoBundlePath: string; method: "link" | "cp" }> {
    const src = bundleDirFor(input.appId, input.sha)
    const dst = path.join(input.projectRoot, input.bundleRepoPath)
    if (!fssync.existsSync(src)) {
      throw new Error(`incoming.dispatcher: bundle missing in cache after mcp call: ${src}`)
    }
    let copyResult: { method: "link" | "cp" }
    try {
      copyResult = await copyTreeWithFallback(src, dst, input.appId, input.sha)
    } catch (err: any) {
      await Bus.publish(PublishFailed, {
        sha256: input.sha,
        repoPath: input.bundleRepoPath,
        errno: err?.code ?? "unknown",
      }).catch(() => {})
      throw err
    }
    // Append history on the original-stem slot for traceability. Only
    // record under incoming/.history if the bundle target is itself
    // inside incoming/; for ad-hoc repo paths (e.g. docx/foo.docx) skip
    // the history append to keep the journal scoped to upload lifecycle.
    if (input.bundleRepoPath.startsWith(IncomingPaths.INCOMING_DIR + "/") ||
        input.bundleRepoPath === IncomingPaths.INCOMING_DIR) {
      await IncomingHistory.appendEntry(
        `${input.stem}.bundle`,
        IncomingHistory.makeEntry({
          source: "bundle-published",
          sha256: input.sha,
          sessionId: input.sessionID,
          annotation: `app=${input.appId} method=${copyResult.method}`,
        }),
        { root: input.projectRoot, emitBus: true },
      ).catch((err) => {
        log.warn("dispatcher: bundle-published history append failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    log.info("dispatcher: bundle published", {
      appId: input.appId,
      sha: input.sha,
      stem: input.stem,
      bundleRepoPath: input.bundleRepoPath,
      method: copyResult.method,
    })
    return {
      repoBundlePath: input.bundleRepoPath,
      method: copyResult.method,
    }
  }

  // ── Top-level before / after ───────────────────────────────────────────

  export interface DispatchContext {
    appId: string
    toolName: string
    projectRoot: string | null
    sessionID: string | null
    stagedFiles: Array<{ repoPath: string; sha: string; ext: string; stagedPath: string }>
    pathReplacements: Array<{ from: string; to: string }>
    cacheHit?: { sha: string; repoBundlePath: string }
    skipMcpCall: boolean
  }

  /**
   * Decide context for a single tool call. Caller should check
   * ctx.skipMcpCall — if true, ctx.cacheHit holds a pre-published bundle
   * path and the caller should construct a synthetic result instead of
   * forwarding to the mcp client.
   */
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
      stagedFiles: [],
      pathReplacements: [],
      skipMcpCall: false,
    }

    if (!projectRoot) {
      // No project context — pass args through untouched. Tools that need
      // incoming/ paths will fail naturally; that's the spec'd behaviour.
      return { rewrittenArgs: input.args, ctx }
    }

    let cacheHitSha: string | null = null
    let cacheHitStem: string | null = null
    let cacheHitBundleParent: string | null = null

    const { rewritten, mappings } = rewriteIncomingPathsInArgs(input.args, (norm) => {
      const repoRel = norm
      const abs = path.resolve(projectRoot!, repoRel)
      // Project-root containment guard (also defends against ../ traversal).
      if (!abs.startsWith(projectRoot! + path.sep) && abs !== projectRoot!) return null
      if (!fssync.existsSync(abs)) return null
      const stat = fssync.statSync(abs)
      if (!stat.isFile()) return null
      // We have a project-relative path that resolves to a real file —
      // stage it for the mcp container. Sync IO because the rewriter is sync.
      const buf = fssync.readFileSync(abs)
      const hasher = createHash("sha256").update(buf)
      const sha = hasher.digest("hex")
      const ext = path.extname(abs)
      const stagingDir = appStagingDir(input.appId)
      fssync.mkdirSync(stagingDir, { recursive: true })
      const stagedPath = path.join(stagingDir, `${sha}${ext}`)
      if (!fssync.existsSync(stagedPath)) {
        try {
          fssync.linkSync(abs, stagedPath)
        } catch (err: any) {
          if (err?.code === "EXDEV" || err?.code === "EPERM") {
            fssync.copyFileSync(abs, stagedPath)
          } else if (err?.code !== "EEXIST") throw err
        }
      }
      ctx.stagedFiles.push({ repoPath: repoRel, sha, ext, stagedPath })

      // Bundle co-resides with the source: e.g.
      //   incoming/合約.docx  →  incoming/合約/
      //   docx/foo.docx       →  docx/foo/
      //   foo.docx (root)     →  foo/
      const stem = IncomingPaths.stem(path.basename(repoRel))
      const bundleParent = path.dirname(repoRel)
      const bundleRepoPath = bundleParent === "." || bundleParent === ""
        ? stem
        : path.join(bundleParent, stem)
      cacheHitSha = sha
      cacheHitStem = stem
      cacheHitBundleParent = bundleRepoPath
      ctx.pathReplacements.push({ from: inContainerStagingPath(sha, ext), to: repoRel })
      ctx.pathReplacements.push({
        from: inContainerBundlesPath(sha) + "/",
        to: bundleRepoPath + "/",
      })
      ctx.pathReplacements.push({
        from: inContainerBundlesPath(sha),
        to: bundleRepoPath,
      })
      // Also rewrite host-side staging paths in case the mcp tool returns
      // absolute host paths (rare, but defensive).
      ctx.pathReplacements.push({
        from: stagedPath,
        to: repoRel,
      })
      ctx.pathReplacements.push({
        from: bundleDirFor(input.appId, sha) + "/",
        to: bundleRepoPath + "/",
      })
      ctx.pathReplacements.push({
        from: bundleDirFor(input.appId, sha),
        to: bundleRepoPath,
      })
      return inContainerStagingPath(sha, ext)
    })

    // DD-16 cache hit fast-path: if we staged exactly one input AND a
    // valid bundle exists for that sha, short-circuit the mcp call.
    if (cacheHitSha && cacheHitStem && cacheHitBundleParent && ctx.stagedFiles.length === 1) {
      const status = await verifyManifest(input.appId, cacheHitSha)
      if (status === "valid") {
        try {
          const pub = await publishBundle({
            appId: input.appId,
            sha: cacheHitSha,
            stem: cacheHitStem,
            bundleRepoPath: cacheHitBundleParent,
            projectRoot,
            sessionID: input.sessionID ?? "(no-session)",
          })
          ctx.cacheHit = { sha: cacheHitSha, repoBundlePath: pub.repoBundlePath }
          ctx.skipMcpCall = true
          await Bus.publish(CacheHit, {
            appId: input.appId,
            toolName: input.toolName,
            sha256: cacheHitSha,
            repoPath: ctx.stagedFiles[0]!.repoPath,
            publishedAt: pub.repoBundlePath,
          }).catch(() => {})
          log.info("dispatcher: cache hit", {
            appId: input.appId,
            tool: input.toolName,
            sha: cacheHitSha,
            publishedAt: pub.repoBundlePath,
          })
        } catch (err) {
          log.warn("dispatcher: cache-hit publish failed, falling through to mcp", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else if (status === "corrupted") {
        log.info("dispatcher: cache corrupted, falling through to mcp", {
          appId: input.appId,
          sha: cacheHitSha,
        })
      } // missing → silent fall-through to mcp call (cache miss)
    }
    if (!ctx.skipMcpCall && cacheHitSha) {
      await Bus.publish(CacheMiss, {
        appId: input.appId,
        toolName: input.toolName,
        sha256: cacheHitSha,
      }).catch(() => {})
      log.info("dispatcher: cache miss", {
        appId: input.appId,
        tool: input.toolName,
        sha: cacheHitSha,
      })
    }

    ctx.pathReplacements.push(...mappings.map((m) => ({ from: m.to, to: m.from })))
    return { rewrittenArgs: rewritten, ctx }
  }

  /**
   * After the mcp tool returns, rewrite staging-path strings back to repo
   * paths and (if the tool wrote a bundle) publish bundles/<sha>/ →
   * incoming/<stem>/. Returns the rewritten result for return to the LLM.
   */
  export async function after(input: {
    result: unknown
    ctx: DispatchContext
  }): Promise<unknown> {
    const { ctx } = input
    if (!ctx.projectRoot) return input.result

    // For each staged file, if a bundle was produced (bundles/<sha>/
    // exists), publish it. Skip if cache-hit (already published).
    if (!ctx.cacheHit) {
      for (const stagedEntry of ctx.stagedFiles) {
        const cacheDir = bundleDirFor(ctx.appId, stagedEntry.sha)
        if (!fssync.existsSync(cacheDir)) continue
        const stem = IncomingPaths.stem(path.basename(stagedEntry.repoPath))
        const parent = path.dirname(stagedEntry.repoPath)
        const bundleRepoPath = parent === "." || parent === "" ? stem : path.join(parent, stem)
        try {
          await publishBundle({
            appId: ctx.appId,
            sha: stagedEntry.sha,
            stem,
            bundleRepoPath,
            projectRoot: ctx.projectRoot,
            sessionID: ctx.sessionID ?? "(no-session)",
          })
        } catch (err) {
          log.warn("dispatcher: post-call publish failed", {
            sha: stagedEntry.sha,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return rewriteResultPaths(input.result, ctx.pathReplacements)
  }

  // Test seam — exposed for unit tests in phase 3.
  export const __forTesting = {
    rewriteIncomingPathsInArgs,
    rewriteResultPaths,
    verifyManifest,
    copyTreeWithFallback,
    appStagingDir,
    appBundlesDir,
    bundleDirFor,
    manifestPathFor,
    stageFile,
    publishBundle,
    STAGING_BASE,
  }
}
