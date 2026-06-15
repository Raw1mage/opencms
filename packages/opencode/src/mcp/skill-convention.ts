import fs from "fs/promises"
import path from "path"
import { Log } from "@/util/log"
import { McpAppStore } from "./app-store"

/**
 * McpSkillConvention (mcp_connect-adaptation MVP-2, DD-3)
 *
 * Locate the bundled-skill source dirs an MCP app ships, by each MCP's own
 * convention rather than a frozen path. Resolution order (DD-3):
 *   1. mcp.json `skillPaths` declaration (relative to app.path) — docxmcp
 *      already declares ["skills"].
 *   2. else default scan <app.path>/skills/*\/ — bodesign has skills/bodesign
 *      with no declaration.
 *   3. else [] (none) — scope boundary, not a fallback.
 * A candidate dir qualifies only if it contains SKILL.md (same enrollability
 * rule as T14 / capability-sync).
 *
 * Boundary: this module only LOCATES skill sources. It does NOT compute hashes,
 * sync, project, or reload — that remains capability-sync's responsibility.
 */
export namespace McpSkillConvention {
  const log = Log.create({ service: "mcp-skill-convention" })

  /**
   * SkillSource — one bundled skill source dir to feed capability-sync.
   * - skillName: the skill id (the leaf dir name, == capability-sync's <name>).
   * - sourceDir: the absolute repo source dir that contains SKILL.md.
   * Not to be interpreted as: an XDG projection path — this is the SSOT source
   * inside the MCP's own repo.
   */
  export interface SkillSource {
    skillName: string
    sourceDir: string
  }

  /**
   * resolve — produce the bundled-skill sources for one MCP app.
   * - input:
   *   - id: the mcp-apps.json app id (for diagnostics).
   *   - entry: the mcp-apps.json AppEntry (entry.path = the MCP repo root).
   * - output: SkillSource[] — each entry is an enrollable skill dir (has
   *   SKILL.md). Empty array means the MCP bundles no skills (scope boundary).
   * - NOT: it does not hash/sync/reload; it does not read external repos beyond
   *   the declared/scanned skill dirs.
   * - done when: the resolution order has been applied and a (possibly empty)
   *   array of enrollable sources is returned.
   */
  export async function resolve(args: { id: string; entry: McpAppStore.AppEntry }): Promise<SkillSource[]> {
    const { id, entry } = args
    const appRoot = entry.path

    // Read mcp.json RAW for skillPaths — McpAppManifest.Schema does NOT carry
    // skillPaths, and McpAppManifest.load() has a write side effect on absence.
    const declaredPaths = await readSkillPaths(appRoot)

    const candidateDirs: string[] = []
    if (declaredPaths && declaredPaths.length > 0) {
      // (1) Declared skillPaths: each is a dir (relative to app root) that may
      // itself be a skill dir OR a parent containing skill subdirs. Expand both.
      for (const rel of declaredPaths) {
        const abs = path.resolve(appRoot, rel)
        await collectSkillDirs(abs, candidateDirs)
      }
    } else {
      // (2) Default convention: scan <app.path>/skills/*\/.
      const defaultRoot = path.join(appRoot, "skills")
      await collectSkillDirs(defaultRoot, candidateDirs)
    }

    // (3) Filter to enrollable dirs (must contain SKILL.md) and de-dupe.
    const seen = new Set<string>()
    const sources: SkillSource[] = []
    for (const dir of candidateDirs) {
      if (seen.has(dir)) continue
      seen.add(dir)
      if (await hasSkillMd(dir)) {
        sources.push({ skillName: path.basename(dir), sourceDir: dir })
      }
    }

    if (sources.length === 0) {
      log.info("mcp app bundles no enrollable skills", { id, appRoot })
    } else {
      log.info("mcp app bundled skills resolved", {
        id,
        skills: sources.map((s) => s.skillName),
        declared: declaredPaths ?? null,
      })
    }
    return sources
  }

  /**
   * readSkillPaths — extract mcp.json `skillPaths: string[]` if declared.
   * - output: the declared relative paths, or undefined if absent/unparseable.
   *   undefined (not []) signals "no declaration → use default scan".
   * - NOT: it does not throw on a missing/invalid mcp.json — a missing skillPaths
   *   declaration is a legitimate convention (default scan), not an error here.
   *   (Prerequisite probe owns mcp.json fail-fast; convention resolution is
   *   downstream of a satisfied probe.)
   */
  async function readSkillPaths(appRoot: string): Promise<string[] | undefined> {
    const manifestPath = path.join(appRoot, "mcp.json")
    let raw: string
    try {
      raw = await fs.readFile(manifestPath, "utf-8")
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed !== "object" || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>)["skillPaths"]
    if (!Array.isArray(value)) return undefined
    const paths = value.filter((v): v is string => typeof v === "string")
    return paths.length > 0 ? paths : undefined
  }

  /**
   * collectSkillDirs — add `dir` itself (if it is a skill dir) and its immediate
   * subdirectories as skill-dir candidates. Enrollability (SKILL.md) is filtered
   * later by the caller; here we only enumerate plausible dirs.
   */
  async function collectSkillDirs(dir: string, out: string[]): Promise<void> {
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // The dir may itself be a single skill dir (contains SKILL.md directly).
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(dir)
    }
    // Or a parent holding multiple skill subdirs.
    for (const e of entries) {
      if (e.isDirectory()) out.push(path.join(dir, e.name))
    }
  }

  async function hasSkillMd(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, "SKILL.md"))
      return true
    } catch {
      return false
    }
  }
}
