import path from "path"
import { promises as fs } from "fs"
import { CapabilityManifest } from "./manifest"
import { CapabilityHash } from "./hash"

/**
 * Installed (XDG) manifest read/write + projection drift detection.
 *
 * The installed manifest is non-authoritative evidence (DD-1): it records what
 * repo version/hash was projected and when. Drift = the manifest's recorded
 * projectionHash no longer matches a fresh hash of the materialised XDG tree.
 */
export namespace CapabilityInstalled {
  /** Sidecar manifest filename written alongside a projected capability tree. */
  export const INSTALLED_FILENAME = ".capability-installed.json"

  export function manifestPathFor(projectionPath: string): string {
    return path.join(projectionPath, INSTALLED_FILENAME)
  }

  /**
   * readInstalled
   * - what: read + validate the installed manifest sidecar for a projection.
   * - input: absolute projection root path.
   * - output: validated Installed manifest, or undefined when absent (=> state=missing).
   * - NOT: must NOT return an empty/partial object on read failure — absence is
   *   undefined, malformed is a thrown InvalidError.
   * - done when: a validated manifest or undefined is returned.
   */
  export async function readInstalled(projectionPath: string): Promise<CapabilityManifest.Installed | undefined> {
    const file = manifestPathFor(projectionPath)
    let text: string
    try {
      text = await fs.readFile(file, "utf-8")
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined
      throw err
    }
    return CapabilityManifest.parseInstalled(JSON.parse(text))
  }

  /**
   * writeInstalled
   * - what: persist an installed manifest sidecar after a successful projection.
   * - input: a validated Installed manifest object (projectionPath field used as dir).
   * - output: void; the sidecar file is written.
   * - NOT: does not perform the rsync projection itself (that is T11/T12 sync exec).
   * - done when: the manifest JSON is flushed to disk.
   */
  export async function writeInstalled(manifest: CapabilityManifest.Installed): Promise<void> {
    const file = manifestPathFor(manifest.projectionPath)
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8")
  }

  /**
   * currentProjectionHash
   * - what: recompute the hash of the materialised XDG projection tree right now.
   * - input: absolute projection root, optional hashPolicy (same excludes as source).
   * - output: sha256 hex of the on-disk projection.
   * - NOT: does not read the recorded projectionHash — this is the fresh ground truth.
   * - done when: a hex digest is returned.
   */
  export async function currentProjectionHash(
    projectionPath: string,
    hashPolicy?: CapabilityManifest.HashPolicy,
  ): Promise<string> {
    return CapabilityHash.computeProjectionHash(projectionPath, hashPolicy)
  }

  /**
   * detectDrift
   * - what: decide whether the on-disk projection diverged from its manifest record.
   * - input: the recorded projectionHash (from the installed manifest) and the
   *   freshly computed projection hash.
   * - output: true when they differ (drift), false when identical.
   * - NOT: does not auto-repair (DD-2: drift is a stop condition, not an overwrite).
   * - done when: a boolean comparison is returned.
   */
  export function detectDrift(recordedProjectionHash: string, freshProjectionHash: string): boolean {
    return recordedProjectionHash !== freshProjectionHash
  }
}