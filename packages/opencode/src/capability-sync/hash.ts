import { createHash } from "crypto"
import path from "path"
import { promises as fs } from "fs"
import { CapabilityManifest } from "./manifest"

/**
 * The installed-manifest sidecar filename. Defined here (not imported from
 * ./installed) to avoid a circular import. MUST stay in sync with
 * CapabilityInstalled.INSTALLED_FILENAME.
 *
 * Why excluded from the projection hash: the sidecar is non-authoritative
 * evidence written AFTER rsync + hash computation. If it were hashed, the
 * recorded projectionHash (computed before the sidecar exists) would never
 * match a later re-hash (when the sidecar is present), producing a permanent
 * false xdg-drift verdict.
 */
const INSTALLED_SIDECAR_FILENAME = ".capability-installed.json"

/**
 * Normalized content hashing for capability sources and projections.
 *
 * DD-1: the normalized source hash is part of the authority. The same
 * algorithm computes both the repo source hash (over sourcePaths) and the
 * projection hash (over the materialised XDG tree) so drift can be detected
 * by re-reading the projection and comparing (T6).
 */
export namespace CapabilityHash {
  /**
   * normalizeContent
   * - what: normalize a single file's bytes to a deterministic string form.
   * - input: raw file Buffer.
   * - output: utf-8 string with CRLF/CR collapsed to LF.
   * - NOT: this does not strip, trim, or reformat whitespace — only line endings.
   * - done when: a string with LF-only line endings is returned.
   */
  function normalizeContent(buf: Buffer, normalize?: CapabilityManifest.HashNormalize): string {
    const text = buf.toString("utf-8")
    if (normalize && normalize.lineEndings !== "lf") return text
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  }

  function matchesAnyGlob(relPath: string, globs: string[]): boolean {
    if (globs.length === 0) return false
    for (const g of globs) {
      if (new Bun.Glob(g).match(relPath)) return true
      // also treat a bare dir name / prefix as an exclude (e.g. "snapshot/")
      const normalized = g.endsWith("/") ? g.slice(0, -1) : g
      if (relPath === normalized || relPath.startsWith(normalized + "/")) return true
    }
    return false
  }

  /**
   * collectFiles
   * - what: enumerate every regular file under a root, relative-pathed and excluded.
   * - input: absolute root dir, exclude globs.
   * - output: array of repo/tree-relative POSIX paths, NOT sorted yet.
   * - NOT: does not read file contents, does not follow excluded subtrees as hashed.
   * - done when: all non-excluded regular files are listed.
   */
  async function collectFiles(root: string, excludes: string[]): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string) => {
      let entries: import("fs").Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = path.relative(root, abs).split(path.sep).join("/")
        if (matchesAnyGlob(rel, excludes)) continue
        if (entry.isDirectory()) {
          await walk(abs)
        } else if (entry.isFile()) {
          out.push(rel)
        }
      }
    }
    await walk(root)
    return out
  }

  /**
   * hashEntries
   * - what: produce a stable sha256 over a sorted set of (relPath, content) pairs.
   * - input: base dir, list of relative file paths, normalize policy.
   * - output: sha256 hex string.
   * - NOT: order-sensitive — entries are sorted first so the hash is deterministic.
   * - done when: a hex digest is returned.
   */
  async function hashEntries(
    baseDir: string,
    relPaths: string[],
    normalize?: CapabilityManifest.HashNormalize,
  ): Promise<string> {
    const sorted = [...relPaths].sort()
    const hash = createHash("sha256")
    for (const rel of sorted) {
      const abs = path.join(baseDir, rel)
      let buf: Buffer
      try {
        buf = await fs.readFile(abs)
      } catch {
        continue
      }
      const content = normalizeContent(buf, normalize)
      // length-prefix path + content so concatenation is unambiguous
      hash.update(`${rel}\u0000${content.length}\u0000`)
      hash.update(content, "utf-8")
    }
    return hash.digest("hex")
  }

  /**
   * computeSourceHash
   * - what: normalized content hash over a repo manifest's sourcePaths (DD-1).
   * - input: authoritative repo root, the sourcePaths list, hashPolicy.
   * - output: sha256 hex over all included files under those paths.
   * - NOT: does not include excluded globs (logs/cache/runtime state per hashPolicy).
   * - done when: a deterministic hex digest is returned.
   */
  export async function computeSourceHash(
    repoRoot: string,
    sourcePaths: string[],
    hashPolicy?: CapabilityManifest.HashPolicy,
  ): Promise<string> {
    const excludes = hashPolicy?.excludes ?? []
    const normalize = hashPolicy?.normalize
    const all: string[] = []
    for (const sp of sourcePaths) {
      const abs = path.resolve(repoRoot, sp)
      let stat: import("fs").Stats
      try {
        stat = await fs.stat(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        const files = await collectFiles(abs, excludes)
        const prefix = path.relative(repoRoot, abs).split(path.sep).join("/")
        for (const f of files) all.push(prefix ? `${prefix}/${f}` : f)
      } else if (stat.isFile()) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join("/")
        if (!matchesAnyGlob(rel, excludes)) all.push(rel)
      }
    }
    return hashEntries(repoRoot, all, normalize)
  }

  /**
   * computeProjectionHash
   * - what: normalized content hash over the materialised XDG projection tree.
   * - input: absolute projection root, hashPolicy (same excludes as source).
   * - output: sha256 hex over the projected files; comparable to sourceHash.
   * - NOT: a separate algorithm — identical normalization so source vs projection
   *   are directly comparable for drift detection.
   * - done when: a deterministic hex digest is returned (empty tree => hash of nothing).
   */
  export async function computeProjectionHash(
    projectionRoot: string,
    hashPolicy?: CapabilityManifest.HashPolicy,
  ): Promise<string> {
    const excludes = hashPolicy?.excludes ?? []
    const normalize = hashPolicy?.normalize
    const files = await collectFiles(projectionRoot, excludes)
    return hashEntries(projectionRoot, files, normalize)
  }
}
