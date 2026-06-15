import path from "path"
import { promises as fs } from "fs"
import { CapabilityManifest } from "./manifest"
import { CapabilityHash } from "./hash"
import { CapabilityScanner } from "./scanner"
import { CapabilityInstalled } from "./installed"
import { CapabilityResolver } from "./resolver"

/**
 * capability-sync sync executor (T13).
 *
 * Materialises a single capability's repo source into its XDG projection via
 * rsync (DD-5) at per-capability leaf granularity (DD-8), then writes the
 * installed-manifest sidecar so future preflights can detect drift. Fail-fast
 * (DD-2 / no-silent-fallback): any rsync/reload failure surfaces as a
 * sync-failed verdict; the caller must never use stale XDG content.
 */
export namespace CapabilitySyncExec {
  /**
   * RsyncOutcome
   * - what: result of a single per-capability rsync invocation.
   * - input: n/a (produced by applyProjection).
   * - output: { ok: true } on success, or { ok:false, reason } describing the failure.
   * - NOT: not a verdict — callers map a failure to CapabilityResolver.syncFailedVerdict.
   * - done when: rsync exited 0 (ok) or a non-zero/spawn error was captured (failure).
   */
  export type RsyncOutcome = { ok: true } | { ok: false; reason: string }

  /**
   * ProjectionResult
   * - what: end-to-end result of projecting one capability into XDG.
   * - input: n/a (produced by applyProjection).
   * - output: a CapabilityResolver.Verdict — state="current"/action="load" on
   *   success, or a sync-failed stop verdict on any failure.
   * - NOT: does not perform the registry reload — the caller fires the reload
   *   hook (e.g. Skill.reset) only after a non-stop verdict.
   * - done when: a verdict reflecting the projection outcome is returned.
   */
  export type ProjectionResult = CapabilityResolver.Verdict

  /** Excludes always applied to projection regardless of manifest (defense-in-depth, DD-5). */
  const BASE_EXCLUDES = [
    CapabilityInstalled.INSTALLED_FILENAME,
    ".git",
    "node_modules",
    "*.bak",
    ".run",
  ]

  let rsyncChecked: boolean | undefined

  /**
   * ensureRsyncAvailable
   * - what: verify the `rsync` binary exists on PATH (cached after first check).
   * - input: none.
   * - output: true when rsync is runnable; false when absent.
   * - NOT: must NOT silently skip projection when rsync is missing — caller turns
   *   false into an explicit sync-failed verdict (no silent fallback).
   * - done when: a boolean availability result is returned.
   */
  export async function ensureRsyncAvailable(): Promise<boolean> {
    if (rsyncChecked !== undefined) return rsyncChecked
    try {
      const proc = Bun.spawn(["rsync", "--version"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
      const code = await proc.exited
      rsyncChecked = code === 0
    } catch {
      rsyncChecked = false
    }
    return rsyncChecked
  }

  /**
   * runRsync
   * - what: invoke rsync to mirror a single source leaf into a target leaf.
   * - input: absolute source dir, absolute target leaf dir, manifest projection policy.
   * - output: RsyncOutcome (ok / failure-with-reason).
   * - NOT: the source/target MUST already be leaf paths (a single capability's
   *   <id> dir); --delete is therefore confined to that leaf and never the
   *   parent skills/ tree (DD-8). This function does not validate that scoping —
   *   the caller (applyProjection) derives leaf paths from the manifest.
   * - done when: rsync exits 0 (ok) or a non-zero/spawn failure is captured.
   */
  async function runRsync(
    sourceDir: string,
    targetLeaf: string,
    projection: CapabilityManifest.Projection,
  ): Promise<RsyncOutcome> {
    // Trailing slash on source = copy contents of sourceDir INTO targetLeaf
    // (not sourceDir itself as a child). Target leaf is the capability's own dir.
    const src = sourceDir.endsWith(path.sep) ? sourceDir : sourceDir + path.sep
    const dst = targetLeaf.endsWith(path.sep) ? targetLeaf : targetLeaf + path.sep

    const args = ["-a"]
    if (projection.delete) args.push("--delete")
    for (const inc of projection.rsyncIncludes ?? []) args.push("--include", inc)
    const excludes = [...BASE_EXCLUDES, ...(projection.rsyncExcludes ?? [])]
    for (const exc of excludes) args.push("--exclude", exc)
    args.push(src, dst)

    try {
      await fs.mkdir(targetLeaf, { recursive: true })
      const proc = Bun.spawn(["rsync", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })
      const code = await proc.exited
      if (code === 0) return { ok: true }
      const stderr = await new Response(proc.stderr).text()
      return { ok: false, reason: `rsync exited ${code}: ${stderr.trim().slice(0, 500)}` }
    } catch (err: any) {
      return { ok: false, reason: `rsync spawn failed: ${err?.message ?? String(err)}` }
    }
  }

  /**
   * applyProjection
   * - what: project a single scanned capability (repo manifest + computed source
   *   hash) into its XDG leaf via rsync, then persist the installed manifest.
   * - input: a CapabilityScanner.ScanResult whose manifest.hash is the freshly
   *   computed authoritative source hash (DD-1).
   * - output: a CapabilityResolver.Verdict — current/load on success; a
   *   sync-failed stop verdict on rsync absence/failure or manifest write failure.
   * - NOT: does not fire the reload hook; does not touch any path other than the
   *   manifest's projection.targetPath leaf (DD-8). On failure it never leaves a
   *   "current" installed manifest claiming success (no silent fallback, DD-2).
   * - done when: projection + sidecar are written and a current verdict returns,
   *   or a sync-failed verdict is returned without claiming success.
   */
  export async function applyProjection(args: {
    scan: CapabilityScanner.ScanResult
    opencodeRepoRoot: string
  }): Promise<ProjectionResult> {
    const repo = args.scan.manifest
    const base = { id: repo.id, kind: repo.kind }

    if (!(await ensureRsyncAvailable())) {
      return CapabilityResolver.syncFailedVerdict(
        repo.id,
        repo.kind,
        "rsync binary not found on PATH; cannot project capability (DD-5 requires rsync)",
      )
    }

    // Source leaf = the capability's source tree. For a single-dir sourcePaths
    // capability the leaf is that dir; we use the repo root + first sourcePath.
    const repoRoot =
      repo.ssotOrigin === "external-mcp-repo"
        ? (repo.sourceRepoPath as string)
        : (repo.sourceRepoPath ?? args.opencodeRepoRoot)
    const sourceLeaf = path.resolve(repoRoot, repo.sourcePaths[0])
    const targetLeaf = repo.projection.targetPath

    const outcome = await runRsync(sourceLeaf, targetLeaf, repo.projection)
    if (!outcome.ok) {
      return CapabilityResolver.syncFailedVerdict(repo.id, repo.kind, outcome.reason)
    }

    // Recompute projection hash over the materialised leaf so drift detection
    // has a ground-truth record (T6).
    let projectionHash: string
    try {
      projectionHash = await CapabilityInstalled.currentProjectionHash(targetLeaf, repo.hashPolicy)
    } catch (err: any) {
      return CapabilityResolver.syncFailedVerdict(
        repo.id,
        repo.kind,
        `projection hash recompute failed: ${err?.message ?? String(err)}`,
      )
    }

    const installed: CapabilityManifest.Installed = {
      id: repo.id,
      kind: repo.kind,
      version: repo.version,
      schemaVersion: repo.schemaVersion,
      sourceHash: repo.hash,
      projectionHash,
      sourceRepoPath: repo.sourceRepoPath,
      projectionPath: targetLeaf,
      installedAt: new Date().toISOString(),
      syncToolVersion: "1",
    }
    try {
      await CapabilityInstalled.writeInstalled(installed)
    } catch (err: any) {
      return CapabilityResolver.syncFailedVerdict(
        repo.id,
        repo.kind,
        `installed manifest write failed: ${err?.message ?? String(err)}`,
      )
    }

    return { ...base, state: "current", action: "load" }
  }

  /**
   * PreflightOutcome
   * - what: the gate decision for whether a skill load may proceed.
   * - input: n/a (produced by preflightSkill).
   * - output: { proceed:true } when loading is safe (no manifest, current, or a
   *   successful sync); { proceed:false, verdict } when the resolver said stop.
   * - NOT: not the act of loading the skill — only the gate verdict. A caller
   *   MUST NOT load on proceed:false (no silent fallback, DD-2).
   * - done when: a proceed decision is returned.
   */
  export type PreflightOutcome = { proceed: true } | { proceed: false; verdict: CapabilityResolver.Verdict }

  /**
   * preflightSkill
   * - what: capability-sync gate before a skill is loaded — if the repo source
   *   carries a capability.json manifest, evaluate repo-vs-XDG and project when
   *   the repo is authoritative; otherwise pass through untouched.
   * - input:
   *   - repoSourceDir: the skill's authoritative repo source dir (contains the
   *     capability.json manifest); when absent/no-manifest, the skill is not
   *     capability-sync-managed and load proceeds.
   *   - projectionPath: the skill's XDG projection leaf (skills/<id>).
   *   - opencodeRepoRoot: repo root used as the SSOT fallback for in-repo kinds.
   *   - reload: optional reload hook fired after a successful sync-then-reload.
   * - output: PreflightOutcome — proceed:true (no manifest / current / synced),
   *   or proceed:false with the stop verdict (drift/xdg-newer/invalid/sync-failed).
   * - NOT: a scope boundary, not a fallback — a skill WITHOUT a capability.json
   *   is simply outside capability-sync's remit and is never blocked or touched.
   *   It must NOT delete or rsync anything beyond projectionPath (DD-8).
   * - done when: a proceed decision is returned (and, on sync-then-reload, the
   *   projection + reload have run).
   */
  export async function preflightSkill(args: {
    repoSourceDir: string
    projectionPath: string
    opencodeRepoRoot: string
    reload?: () => void | Promise<void>
  }): Promise<PreflightOutcome> {
    // Scope boundary: no manifest => not capability-sync-managed => pass through.
    const manifestFile = path.join(args.repoSourceDir, CapabilityScanner.MANIFEST_FILENAME)
    try {
      await fs.access(manifestFile)
    } catch {
      return { proceed: true }
    }

    let scan: CapabilityScanner.ScanResult
    try {
      scan = await CapabilityScanner.scan({
        manifestDir: args.repoSourceDir,
        opencodeRepoRoot: args.opencodeRepoRoot,
      })
    } catch (err: any) {
      if (CapabilityManifest.InvalidError.isInstance(err)) {
        return {
          proceed: false,
          verdict: CapabilityResolver.invalidVerdict(
            err.data.id ?? "unknown",
            (err.data.kind ?? "skill") as CapabilityManifest.Kind,
            err.data.message,
          ),
        }
      }
      throw err
    }

    const repo = scan.manifest
    let installed: CapabilityManifest.Installed | undefined
    try {
      installed = await CapabilityInstalled.readInstalled(args.projectionPath)
    } catch (err: any) {
      if (CapabilityManifest.InvalidError.isInstance(err)) {
        return { proceed: false, verdict: CapabilityResolver.invalidVerdict(repo.id, repo.kind, err.data.message) }
      }
      throw err
    }

    let freshProjectionHash: string | undefined
    if (installed) {
      freshProjectionHash = await CapabilityInstalled.currentProjectionHash(args.projectionPath, repo.hashPolicy)
    }

    const verdict = CapabilityResolver.resolve({ repo, installed, freshProjectionHash })

    if (verdict.action === "load") return { proceed: true }
    if (verdict.action === "stop") return { proceed: false, verdict }

    // action === "sync-then-reload"
    const projected = await applyProjection({ scan, opencodeRepoRoot: args.opencodeRepoRoot })
    if (projected.action === "stop") return { proceed: false, verdict: projected }
    if (args.reload) await args.reload()
    return { proceed: true }
  }

  /** Default hash/projection policy for MCP-bundled skills (DD-9). Mirrors the
   *  excludes a typical skill tree needs; aligned with BASE_EXCLUDES so the
   *  source hash and the projected tree compare cleanly. */
  const MCP_SKILL_EXCLUDES = [".git", "node_modules", "*.bak", ".run", ".logs", ".venv", ".artifacts"]

  /**
   * synthesizeMcpSkillManifest
   * - what: build an in-memory RepoManifest for an MCP-bundled skill that has NO
   *   capability.json of its own (DD-9). The skill dir's mere existence is the
   *   enrollment signal; the normalized content hash is the authoritative version
   *   (DD-4 — SKILL.md has no version frontmatter).
   * - input:
   *   - skillName: the skill id (the <name> in <app.path>/skills/<name>/).
   *   - mcpAppPath: the external MCP repo root (mcp-apps.json apps.<id>.path) = SSOT.
   *   - projectionPath: the XDG projection leaf (Global.Path.data/skills/<name>).
   *   - computedHash: the freshly computed normalized source hash over the skill dir.
   *   - relSourcePath: the skill source dir relative to mcpAppPath (POSIX). Lets
   *     the skill convention resolver point at a non-default layout (DD-3);
   *     defaults to "skills/<skillName>" to preserve the original T14 behavior.
   * - output: a validated CapabilityManifest.Repo with ssotOrigin=external-mcp-repo,
   *   sourceRepoPath=mcpAppPath, sourcePaths=[relSourcePath], version derived from hash.
   * - NOT: it does NOT write any file to the external MCP repo (in-memory only);
   *   it is NOT used for in-repo skills (those carry a real capability.json).
   * - done when: a schema-valid Repo manifest is returned.
   */
  function synthesizeMcpSkillManifest(opts: {
    skillName: string
    mcpAppPath: string
    projectionPath: string
    computedHash: string
    relSourcePath?: string
  }): CapabilityManifest.Repo {
    const hashPolicy: CapabilityManifest.HashPolicy = {
      algorithm: "sha256",
      excludes: MCP_SKILL_EXCLUDES,
      normalize: { lineEndings: "lf", sortEntries: true },
    }
    return CapabilityManifest.parseRepo({
      id: opts.skillName,
      kind: "skill",
      ssotOrigin: "external-mcp-repo",
      sourceRepoPath: opts.mcpAppPath,
      // Hash IS the version (DD-9): SKILL.md has no version field, so content
      // identity is the only authoritative signal. A 12-char prefix keeps the
      // version readable while staying tied to the full source hash.
      version: `0.0.0+${opts.computedHash.slice(0, 12)}`,
      schemaVersion: 1,
      sourcePaths: [opts.relSourcePath ?? path.posix.join("skills", opts.skillName)],
      hash: opts.computedHash,
      hashPolicy,
      projection: {
        targetPath: opts.projectionPath,
        method: "rsync",
        delete: true,
        reloadTarget: "skill-index-rebuild",
      },
    })
  }

  /**
   * preflightMcpSkill
   * - what: capability-sync gate for an MCP-bundled skill at MCP connect time
   *   (DD-9/DD-10). The MCP's own external repo is the SSOT; the bundled skill
   *   dir's existence enrolls it (no capability.json needed). Compares the repo
   *   skill dir vs its XDG projection by content hash and rsyncs when the repo
   *   is authoritative; fail-fast on a stop verdict (never use stale XDG).
   * - input:
   *   - skillName: the bundled skill id (<name> in <app.path>/skills/<name>/).
   *   - mcpAppPath: the external MCP repo root (mcp-apps.json apps.<id>.path).
   *   - sourceDir: optional absolute skill source dir, supplied by the MCP skill
   *     convention resolver (DD-3) when the MCP declares a non-default skillPaths
   *     layout. When omitted, falls back to <mcpAppPath>/skills/<skillName> (the
   *     original T14 behavior) so existing callers are unchanged.
   *   - projectionPath: the XDG projection leaf (Global.Path.data/skills/<name>).
   *   - reload: optional reload hook fired after a successful sync-then-reload.
   *   - ttlMs: TTL for the cached probe verdict (DD-6); default 1h. When the
   *     installed sidecar's probeCachedUntil is still in the future, re-probing
   *     the external repo is skipped and the cached projection is trusted.
   *   - forceRefresh: bypass the TTL cache (explicit refresh override, DD-6).
   * - output: PreflightOutcome — proceed:true (no bundled skill dir / current /
   *   synced / within TTL), or proceed:false with the stop verdict.
   * - NOT: a scope boundary, not a fallback — an MCP app WITHOUT a skills/<name>/
   *   dir is simply not capability-sync-managed and is never blocked or touched.
   *   It MUST NOT touch any path beyond projectionPath (DD-8).
   * - done when: a proceed decision is returned (and, on sync-then-reload, the
   *   projection + reload have run; on a within-TTL hit, no re-probe occurred).
   */
  export async function preflightMcpSkill(args: {
    skillName: string
    mcpAppPath: string
    sourceDir?: string
    projectionPath: string
    reload?: () => void | Promise<void>
    ttlMs?: number
    forceRefresh?: boolean
  }): Promise<PreflightOutcome> {
    // Resolve the authoritative skill source dir. When the convention resolver
    // supplied an explicit sourceDir (DD-3), honor it; otherwise fall back to
    // the original T14 layout <mcpAppPath>/skills/<skillName>.
    const skillDir = args.sourceDir ?? path.join(args.mcpAppPath, "skills", args.skillName)
    // The hash + synthesized manifest address the source by a POSIX path
    // RELATIVE to mcpAppPath (sourceRepoPath). Derive it from skillDir so a
    // non-default layout still hashes the right tree.
    const relSourcePath = path.relative(args.mcpAppPath, skillDir).split(path.sep).join(path.posix.sep)

    // Scope boundary: no bundled skill dir => not capability-sync-managed.
    try {
      const stat = await fs.stat(skillDir)
      if (!stat.isDirectory()) return { proceed: true }
    } catch {
      return { proceed: true }
    }

    // TTL cache (DD-6): if a prior probe verdict is still valid, trust the
    // existing projection and skip re-probing the external repo. A stop verdict
    // is never cached (the sidecar is only written on a successful projection),
    // so this can only short-circuit a known-good projection.
    if (!args.forceRefresh) {
      let installed: CapabilityManifest.Installed | undefined
      try {
        installed = await CapabilityInstalled.readInstalled(args.projectionPath)
      } catch {
        installed = undefined
      }
      if (installed?.probeCachedUntil) {
        const until = Date.parse(installed.probeCachedUntil)
        if (Number.isFinite(until) && until > Date.now()) return { proceed: true }
      }
    }

    const hashPolicy: CapabilityManifest.HashPolicy = {
      algorithm: "sha256",
      excludes: MCP_SKILL_EXCLUDES,
      normalize: { lineEndings: "lf", sortEntries: true },
    }
    const computedHash = await CapabilityHash.computeSourceHash(
      args.mcpAppPath,
      [path.posix.join("skills", args.skillName)],
      hashPolicy,
    )

    const repo = synthesizeMcpSkillManifest({
      skillName: args.skillName,
      mcpAppPath: args.mcpAppPath,
      projectionPath: args.projectionPath,
      computedHash,
    })

    let installed: CapabilityManifest.Installed | undefined
    try {
      installed = await CapabilityInstalled.readInstalled(args.projectionPath)
    } catch (err: any) {
      if (CapabilityManifest.InvalidError.isInstance(err)) {
        return { proceed: false, verdict: CapabilityResolver.invalidVerdict(repo.id, repo.kind, err.data.message) }
      }
      throw err
    }

    let freshProjectionHash: string | undefined
    if (installed) {
      freshProjectionHash = await CapabilityInstalled.currentProjectionHash(args.projectionPath, repo.hashPolicy)
    }

    const verdict = CapabilityResolver.resolve({ repo, installed, freshProjectionHash })

    if (verdict.action === "load") {
      // Refresh the TTL window on a confirmed-current projection (DD-6).
      if (installed) await stampProbeTtl(installed, args.ttlMs)
      return { proceed: true }
    }
    if (verdict.action === "stop") return { proceed: false, verdict }

    // action === "sync-then-reload"
    const scan: CapabilityScanner.ScanResult = { manifest: repo, declaredHash: repo.hash, computedHash: repo.hash }
    const projected = await applyProjection({ scan, opencodeRepoRoot: args.mcpAppPath })
    if (projected.action === "stop") return { proceed: false, verdict: projected }
    // Stamp the TTL window on the freshly written sidecar (DD-6).
    const written = await CapabilityInstalled.readInstalled(args.projectionPath)
    if (written) await stampProbeTtl(written, args.ttlMs)
    if (args.reload) await args.reload()
    return { proceed: true }
  }

  /** Default probe TTL window (DD-6): 1 hour. */
  const DEFAULT_PROBE_TTL_MS = 60 * 60 * 1000

  /**
   * stampProbeTtl
   * - what: write probeCachedUntil onto an installed sidecar so connects within
   *   the window skip re-probing the external MCP repo (DD-6).
   * - input: a validated Installed manifest, optional ttlMs override.
   * - output: void; the sidecar is rewritten with an updated probeCachedUntil.
   * - NOT: does not change any hash/version fields — only the TTL stamp.
   * - done when: the sidecar JSON is flushed with the new probeCachedUntil.
   */
  async function stampProbeTtl(installed: CapabilityManifest.Installed, ttlMs?: number): Promise<void> {
    const until = new Date(Date.now() + (ttlMs ?? DEFAULT_PROBE_TTL_MS)).toISOString()
    await CapabilityInstalled.writeInstalled({ ...installed, probeCachedUntil: until })
  }
}
