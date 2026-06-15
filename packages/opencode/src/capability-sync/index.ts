import { CapabilityManifest } from "./manifest"
import { CapabilityHash } from "./hash"
import { CapabilityScanner } from "./scanner"
import { CapabilityInstalled } from "./installed"
import { CapabilityResolver } from "./resolver"

/**
 * capability-sync — repo-as-SSOT capability synchronization core (DD-1..DD-6).
 *
 * This module is the shared layer spanning skill/ and mcp/: before a capability
 * is loaded, preflight reads the authoritative repo manifest, computes the
 * normalized source hash, inspects the XDG projection, and the resolver
 * classifies the state. Sync execution (rsync) + skill/mcp integration are
 * later tasks (T11–T14); this module provides the pure parser, scanner, hash,
 * installed-manifest, and resolver primitives.
 */
export namespace CapabilitySync {
  export import Manifest = CapabilityManifest
  export import Hash = CapabilityHash
  export import Scanner = CapabilityScanner
  export import Installed = CapabilityInstalled
  export import Resolver = CapabilityResolver

  export type Kind = CapabilityManifest.Kind
  export type RepoManifest = CapabilityManifest.Repo
  export type InstalledManifest = CapabilityManifest.Installed
  export type Verdict = CapabilityResolver.Verdict

  /**
   * evaluate
   * - what: end-to-end pure-read preflight — scan the repo manifest, read the
   *   installed evidence + fresh projection hash, and return a resolver verdict.
   * - input: manifest source (dir or object), opencode repo root, projectionPath.
   * - output: a CapabilityResolver.Verdict. Manifest validation failures are
   *   mapped to an `invalid` stop verdict (no throw escapes for that case).
   * - NOT: does not perform rsync projection or reload — that is the caller's job
   *   when action="sync-then-reload" (T11–T14).
   * - done when: a single verdict describing the next safe action is returned.
   */
  export async function evaluate(args: {
    manifestDir?: string
    manifest?: unknown
    opencodeRepoRoot: string
    projectionPath: string
  }): Promise<CapabilityResolver.Verdict> {
    let scan: CapabilityScanner.ScanResult
    try {
      scan = await CapabilityScanner.scan({
        manifestDir: args.manifestDir,
        manifest: args.manifest,
        opencodeRepoRoot: args.opencodeRepoRoot,
      })
    } catch (err: any) {
      if (CapabilityManifest.InvalidError.isInstance(err)) {
        const id = err.data.id ?? "unknown"
        const kind = (err.data.kind ?? "skill") as CapabilityManifest.Kind
        return CapabilityResolver.invalidVerdict(id, kind, err.data.message)
      }
      throw err
    }

    const repo = scan.manifest
    let installed: CapabilityManifest.Installed | undefined
    try {
      installed = await CapabilityInstalled.readInstalled(args.projectionPath)
    } catch (err: any) {
      if (CapabilityManifest.InvalidError.isInstance(err)) {
        return CapabilityResolver.invalidVerdict(repo.id, repo.kind, err.data.message)
      }
      throw err
    }

    let freshProjectionHash: string | undefined
    if (installed) {
      freshProjectionHash = await CapabilityInstalled.currentProjectionHash(
        args.projectionPath,
        repo.hashPolicy,
      )
    }

    return CapabilityResolver.resolve({ repo, installed, freshProjectionHash })
  }
}