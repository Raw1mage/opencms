import { CapabilityManifest } from "./manifest"

/**
 * Resolver state machine: compare an authoritative repo manifest against the
 * installed XDG evidence and classify into one of seven states with a
 * fail-fast action (DD-1, DD-4). Pure comparison — no I/O, no projection.
 *
 * Drift / xdg-newer / invalid / sync-failed all map to action="stop" with a
 * diagnostic; the caller must never silently fall back to stale XDG content.
 */
export namespace CapabilityResolver {
  export const State = CapabilityManifest_StateEnum()
  function CapabilityManifest_StateEnum() {
    return [
      "missing",
      "current",
      "repo-newer",
      "xdg-drift",
      "xdg-newer",
      "invalid",
      "sync-failed",
    ] as const
  }
  export type State = (typeof State)[number]
  export type Action = "load" | "sync-then-reload" | "stop"

  export type Diagnostic = {
    reason: string
    repoVersion?: string
    xdgVersion?: string
    repoHash?: string
    xdgHash?: string
    remediation?: string
  }

  export type Verdict = {
    id: string
    kind: CapabilityManifest.Kind
    state: State
    action: Action
    diagnostic?: Diagnostic
  }

  /**
   * compareVersions
   * - what: ordering of two version strings (semver-ish, dot-separated numeric
   *   with a lexical fallback for non-numeric tails).
   * - input: two version strings a, b.
   * - output: -1 (a<b), 0 (a==b), 1 (a>b).
   * - NOT: a full semver range resolver — only ordering of concrete versions.
   * - done when: a sign is returned.
   */
  function compareVersions(a: string, b: string): number {
    if (a === b) return 0
    const pa = a.split(".")
    const pb = b.split(".")
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
      const sa = pa[i] ?? "0"
      const sb = pb[i] ?? "0"
      const na = Number(sa)
      const nb = Number(sb)
      const bothNumeric = Number.isFinite(na) && Number.isFinite(nb) && /^\d+$/.test(sa) && /^\d+$/.test(sb)
      if (bothNumeric) {
        if (na !== nb) return na < nb ? -1 : 1
      } else if (sa !== sb) {
        return sa < sb ? -1 : 1
      }
    }
    return 0
  }

  /**
   * resolve
   * - what: classify a capability's sync state from repo manifest + installed evidence.
   * - input:
   *   - repo: validated repo manifest whose `hash` is the freshly COMPUTED source hash (DD-1).
   *   - installed: validated installed manifest, or undefined when no projection exists.
   *   - freshProjectionHash: hash recomputed over the on-disk XDG tree right now,
   *     or undefined when there is no projection to re-read.
   * - output: a Verdict {state, action, diagnostic?}.
   * - NOT: does not handle `invalid` (manifest parse throws upstream) or
   *   `sync-failed` (raised by the sync executor in T11/T12) — those are mapped
   *   to verdicts by the caller via invalidVerdict()/syncFailedVerdict().
   * - done when: exactly one of missing/current/repo-newer/xdg-drift/xdg-newer
   *   is returned with the matching action.
   */
  export function resolve(args: {
    repo: CapabilityManifest.Repo
    installed: CapabilityManifest.Installed | undefined
    freshProjectionHash?: string
  }): Verdict {
    const { repo, installed, freshProjectionHash } = args
    const base = { id: repo.id, kind: repo.kind }

    // 1. No projection / no installed manifest => missing.
    if (!installed) {
      return {
        ...base,
        state: "missing",
        action: "sync-then-reload",
        diagnostic: {
          reason: "no XDG projection or installed manifest present",
          repoVersion: repo.version,
          repoHash: repo.hash,
        },
      }
    }

    // 2. Drift: on-disk projection diverged from the recorded projectionHash.
    //    DD-2: stop, do not auto-overwrite.
    if (freshProjectionHash !== undefined && installed.projectionHash !== freshProjectionHash) {
      return {
        ...base,
        state: "xdg-drift",
        action: "stop",
        diagnostic: {
          reason: "XDG projection content hash differs from installed manifest record",
          repoVersion: repo.version,
          xdgVersion: installed.version,
          repoHash: repo.hash,
          xdgHash: freshProjectionHash,
          remediation: "investigate manual XDG edits; re-sync only via explicit repair",
        },
      }
    }

    // 3. xdg-newer: installed claims a newer version than the repo => SSOT violation.
    //    SKIPPED for hash-versioned capabilities (ssotOrigin="external-mcp-repo", e.g.
    //    MCP-bundled skills): their version IS the content hash (`0.0.0+<hash>`), which
    //    has no recency ordering, so a lexical "installed > repo" is a FALSE POSITIVE.
    //    A plain repo edit whose new hash sorts below the old must classify as
    //    repo-newer and sync — not stop. (Bug fixed in capability-sync/skill-resync:
    //    this false xdg-newer silently refused ~half of all skill edits at connect.)
    //    Genuine leaf hand-edits are still caught above as xdg-drift (projectionHash).
    if (repo.ssotOrigin !== "external-mcp-repo" && compareVersions(installed.version, repo.version) > 0) {
      return {
        ...base,
        state: "xdg-newer",
        action: "stop",
        diagnostic: {
          reason: "installed XDG version is newer than repo SSOT version",
          repoVersion: repo.version,
          xdgVersion: installed.version,
          repoHash: repo.hash,
          xdgHash: installed.sourceHash,
          remediation: "repo is the single source of truth; reconcile the XDG-newer claim",
        },
      }
    }

    // 4. current: version AND hash both match (DD-4).
    if (installed.version === repo.version && installed.sourceHash === repo.hash) {
      return { ...base, state: "current", action: "load" }
    }

    // 5. repo-newer: anything else means the repo differs and is authoritative.
    return {
      ...base,
      state: "repo-newer",
      action: "sync-then-reload",
      diagnostic: {
        reason: "repo version/hash differs from installed; repo is authoritative",
        repoVersion: repo.version,
        xdgVersion: installed.version,
        repoHash: repo.hash,
        xdgHash: installed.sourceHash,
      },
    }
  }

  /**
   * invalidVerdict
   * - what: build a stop verdict for a manifest that failed schema validation.
   * - input: id, kind, reason string.
   * - output: Verdict with state="invalid", action="stop".
   * - NOT: does not itself validate — caller catches InvalidError and calls this.
   * - done when: a stop verdict is returned.
   */
  export function invalidVerdict(id: string, kind: CapabilityManifest.Kind, reason: string): Verdict {
    return {
      id,
      kind,
      state: "invalid",
      action: "stop",
      diagnostic: { reason, remediation: "fix the capability manifest schema/fields" },
    }
  }

  /**
   * syncFailedVerdict
   * - what: build a stop verdict when projection write or reload failed.
   * - input: id, kind, reason string.
   * - output: Verdict with state="sync-failed", action="stop".
   * - NOT: must NOT fall back to a previously loaded registry entry (no silent fallback).
   * - done when: a stop verdict is returned.
   */
  export function syncFailedVerdict(id: string, kind: CapabilityManifest.Kind, reason: string): Verdict {
    return {
      id,
      kind,
      state: "sync-failed",
      action: "stop",
      diagnostic: { reason, remediation: "do not use stale XDG; resolve the sync failure first" },
    }
  }
}