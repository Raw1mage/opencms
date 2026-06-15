import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

/**
 * Capability-sync data contracts.
 *
 * Faithful zod mirror of plans/capability_repo-ssot-sync/data-schema.json.
 * Reflects DD-1 (repo manifest + normalized hash is authority), DD-4 (version
 * AND hash both required), DD-5 (rsync projection), DD-6 (per-kind SSOT origin).
 */
export namespace CapabilityManifest {
  /** skill+template SSOT = opencode repo; mcp-app SSOT = the MCP's own external repo (DD-6). */
  export const Kind = z.enum(["skill", "template", "mcp-app"])
  export type Kind = z.infer<typeof Kind>

  /** Which repo is authoritative (DD-6). */
  export const SsotOrigin = z.enum(["opencode-repo", "external-mcp-repo"])
  export type SsotOrigin = z.infer<typeof SsotOrigin>

  export const HashAlgorithm = z.enum(["sha256"])
  export type HashAlgorithm = z.infer<typeof HashAlgorithm>

  export const HashNormalize = z.object({
    lineEndings: z.literal("lf").default("lf"),
    sortEntries: z.boolean().default(true),
  })
  export type HashNormalize = z.infer<typeof HashNormalize>

  export const HashPolicy = z.object({
    algorithm: HashAlgorithm.default("sha256"),
    /** Globs never hashed/projected: logs, cache, runtime state, node_modules, lockfiles, *.bak, .run/, snapshot/. */
    excludes: z.array(z.string()).default([]),
    normalize: HashNormalize.default({ lineEndings: "lf", sortEntries: true }),
  })
  export type HashPolicy = z.infer<typeof HashPolicy>

  /** T8: which existing reload hook fires after sync. */
  export const ReloadTarget = z.enum([
    "skill-index-rebuild",
    "mcp-app-reload",
    "template-noop",
    "enablement-reload",
  ])
  export type ReloadTarget = z.infer<typeof ReloadTarget>

  /** T6/DD-5: rsync projection policy from SSOT to XDG. */
  export const Projection = z.object({
    targetPath: z.string(),
    /** DD-5: rsync only. */
    method: z.literal("rsync").default("rsync"),
    rsyncIncludes: z.array(z.string()).optional(),
    /** Aligns with hashPolicy.excludes. */
    rsyncExcludes: z.array(z.string()).optional(),
    /** rsync --delete against include/exclude set for deterministic projection. */
    delete: z.boolean().default(true),
    reloadTarget: ReloadTarget.optional(),
  })
  export type Projection = z.infer<typeof Projection>

  export const Compatibility = z.object({
    minOpencodeVersion: z.string().optional(),
  })
  export type Compatibility = z.infer<typeof Compatibility>

  /**
   * Authoritative capability descriptor sourced from the SSOT repo (DD-1).
   * For skill/template derived from opencode repo files; for mcp-app derived
   * from the MCP source repo's bundled descriptor.
   */
  export const Repo = z.object({
    id: z.string(),
    kind: Kind,
    ssotOrigin: SsotOrigin,
    /**
     * Absolute path of the authoritative repo. For mcp-app this is
     * mcp-apps.json apps.<id>.path (external). For skill/template this is the
     * opencode repo root. Required when ssotOrigin=external-mcp-repo.
     */
    sourceRepoPath: z.string().optional(),
    version: z.string(),
    schemaVersion: z.number().int(),
    sourcePaths: z.array(z.string()).min(1),
    /** Normalized content hash over sourcePaths (DD-1). sha256 hex. */
    hash: z.string(),
    hashPolicy: HashPolicy.optional(),
    projection: Projection,
    compatibility: Compatibility.optional(),
  })
  export type Repo = z.infer<typeof Repo>

  /**
   * Non-authoritative evidence of what was projected into XDG and when.
   * For mcp-app this EXTENDS the existing mcp-apps.json apps.<id> entry (T4).
   */
  export const Installed = z.object({
    id: z.string(),
    kind: Kind,
    /** Version copied from Repo manifest at projection time. */
    version: z.string(),
    schemaVersion: z.number().int(),
    /** Repo.hash captured at projection time. */
    sourceHash: z.string(),
    /** Hash recomputed over the materialised XDG tree after rsync. */
    projectionHash: z.string(),
    sourceRepoPath: z.string().optional(),
    projectionPath: z.string(),
    installedAt: z.string(),
    installedBy: z.string().optional(),
    syncToolVersion: z.string().optional(),
    /**
     * DD-6 TTL: for mcp-app, the probe verdict is cached until this time;
     * calls within the window skip re-probing the external source repo.
     */
    probeCachedUntil: z.string().optional(),
  })
  export type Installed = z.infer<typeof Installed>

  /** Thrown when a manifest fails schema validation (resolver maps this to state=invalid). */
  export const InvalidError = NamedError.create(
    "CapabilityManifestInvalidError",
    z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      message: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  /**
   * Parse + validate a repo manifest. Throws InvalidError on failure so the
   * resolver can classify state=invalid (no silent fallback).
   */
  export function parseRepo(input: unknown): Repo {
    const parsed = Repo.safeParse(input)
    if (!parsed.success) {
      const obj = (input ?? {}) as Record<string, unknown>
      throw new InvalidError({
        id: typeof obj.id === "string" ? obj.id : undefined,
        kind: typeof obj.kind === "string" ? obj.kind : undefined,
        message: "repo manifest failed schema validation",
        issues: parsed.error.issues,
      })
    }
    // DD-6 invariant: external-mcp-repo manifests must carry their source repo path.
    if (parsed.data.ssotOrigin === "external-mcp-repo" && !parsed.data.sourceRepoPath) {
      throw new InvalidError({
        id: parsed.data.id,
        kind: parsed.data.kind,
        message: "external-mcp-repo manifest requires sourceRepoPath (DD-6)",
      })
    }
    return parsed.data
  }

  /**
   * Parse + validate an installed manifest. Returns undefined when the input
   * is structurally absent (caller maps that to state=missing); throws
   * InvalidError when present-but-malformed.
   */
  export function parseInstalled(input: unknown): Installed | undefined {
    if (input === undefined || input === null) return undefined
    const parsed = Installed.safeParse(input)
    if (!parsed.success) {
      const obj = (input ?? {}) as Record<string, unknown>
      throw new InvalidError({
        id: typeof obj.id === "string" ? obj.id : undefined,
        kind: typeof obj.kind === "string" ? obj.kind : undefined,
        message: "installed manifest failed schema validation",
        issues: parsed.error.issues,
      })
    }
    return parsed.data
  }
}
