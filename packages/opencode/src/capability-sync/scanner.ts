import path from "path"
import { promises as fs } from "fs"
import { CapabilityManifest } from "./manifest"
import { CapabilityHash } from "./hash"

/**
 * Repo scanner: read a capability's authoritative manifest from its SSOT repo
 * and (re)compute the normalized source hash (DD-1). The manifest's declared
 * `hash` is treated as a claim; the scanner recomputes the real hash over
 * sourcePaths so the resolver compares against ground truth, not the claim.
 */
export namespace CapabilityScanner {
  /** Default manifest filename inside a capability source tree. */
  export const MANIFEST_FILENAME = "capability.json"

  export type ScanResult = {
    /** The validated repo manifest with `hash` set to the freshly computed value. */
    manifest: CapabilityManifest.Repo
    /** The hash value declared in the on-disk manifest (claim), for divergence diagnostics. */
    declaredHash: string
    /** The freshly computed normalized source hash (authoritative, DD-1). */
    computedHash: string
  }

  /**
   * readManifestFile
   * - what: read + JSON-parse a manifest file from disk.
   * - input: absolute manifest file path.
   * - output: parsed unknown JSON, or undefined if the file is absent.
   * - NOT: does not validate schema (parseRepo does that), does not compute hash.
   * - done when: parsed object (or undefined for ENOENT) is returned.
   */
  async function readManifestFile(file: string): Promise<unknown | undefined> {
    let text: string
    try {
      text = await fs.readFile(file, "utf-8")
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined
      throw err
    }
    return JSON.parse(text)
  }

  /**
   * resolveRepoRoot
   * - what: pick the authoritative repo root for a manifest (DD-6 per-kind SSOT).
   * - input: a parsed repo manifest, the opencode repo root fallback.
   * - output: absolute path of the SSOT repo.
   * - NOT: does not read files; pure path selection.
   * - done when: an absolute root path is returned.
   */
  function resolveRepoRoot(manifest: CapabilityManifest.Repo, opencodeRepoRoot: string): string {
    if (manifest.ssotOrigin === "external-mcp-repo") {
      // parseRepo guarantees sourceRepoPath is present for external-mcp-repo.
      return manifest.sourceRepoPath as string
    }
    return manifest.sourceRepoPath ?? opencodeRepoRoot
  }

  /**
   * scan
   * - what: load + validate a capability manifest and recompute its source hash.
   * - input: directory containing the manifest file (or an explicit manifest object),
   *   plus the opencode repo root used as the SSOT fallback for in-repo kinds.
   * - output: ScanResult with the validated manifest (hash = computed) + declared/computed hashes.
   * - NOT: does not project, does not touch XDG, does not classify resolver state.
   * - done when: a ScanResult with a recomputed authoritative hash is returned;
   *   throws CapabilityManifest.InvalidError when the manifest is missing/malformed.
   */
  export async function scan(args: {
    manifestDir?: string
    manifest?: unknown
    opencodeRepoRoot: string
  }): Promise<ScanResult> {
    let raw = args.manifest
    if (raw === undefined) {
      if (!args.manifestDir) {
        throw new CapabilityManifest.InvalidError({
          message: "scan requires either a manifest object or a manifestDir",
        })
      }
      raw = await readManifestFile(path.join(args.manifestDir, MANIFEST_FILENAME))
      if (raw === undefined) {
        throw new CapabilityManifest.InvalidError({
          message: `capability manifest not found at ${path.join(args.manifestDir, MANIFEST_FILENAME)}`,
        })
      }
    }

    const manifest = CapabilityManifest.parseRepo(raw)
    const declaredHash = manifest.hash
    const repoRoot = resolveRepoRoot(manifest, args.opencodeRepoRoot)
    const computedHash = await CapabilityHash.computeSourceHash(
      repoRoot,
      manifest.sourcePaths,
      manifest.hashPolicy,
    )

    return {
      manifest: { ...manifest, hash: computedHash },
      declaredHash,
      computedHash,
    }
  }
}