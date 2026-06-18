import path from "path"
import { promises as fs } from "fs"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { Skill } from "../skill"
import { McpAppStore } from "./app-store"
import { McpSkillConvention } from "./skill-convention"
import { CapabilitySyncExec } from "../capability-sync/sync"
import { CapabilityResolver } from "../capability-sync/resolver"

/**
 * SkillResync (capability-sync/skill-resync M2)
 *
 * Operator-driven orchestration over capability-sync's existing primitives: make a
 * bundled skill's repo edits go live on demand (force preflight + rsync + reload)
 * and report projection freshness — WITHOUT a new sync engine (DD-1). Target
 * resolution reuses the exact same path as connect-time syncMcpBundledSkills (DD-3),
 * so the CLI and connect-time never disagree.
 */
export namespace SkillResync {
  const log = Log.create({ service: "skill-resync" })

  /** `all` = every enabled app's bundled skills; `name` matches an app id OR a skill name. */
  export type Target = { kind: "all" } | { kind: "name"; value: string }

  export interface Located {
    app: string
    skillName: string
    sourceDir: string
    mcpAppPath: string
    projectionPath: string
  }

  /**
   * locate — resolve a target to concrete bundled-skill sources across enabled MCP
   * apps, using the SAME resolver connect-time uses (McpAppStore.loadConfig enabled
   * filter → McpSkillConvention.resolve), so resync targets exactly what connect
   * would (DD-3). projectionPath mirrors syncMcpBundledSkills (Global.Path.data/skills/<name>).
   */
  export async function locate(target: Target): Promise<Located[]> {
    const config = await McpAppStore.loadConfig()
    const enabled = Object.entries(config.apps).filter(([, e]) => e.enabled)
    const out: Located[] = []
    for (const [id, entry] of enabled) {
      const sources = await McpSkillConvention.resolve({ id, entry })
      for (const { skillName, sourceDir } of sources) {
        if (target.kind === "name" && id !== target.value && skillName !== target.value) continue
        out.push({
          app: id,
          skillName,
          sourceDir,
          mcpAppPath: entry.path,
          projectionPath: path.join(Global.Path.data, "skills", skillName),
        })
      }
    }
    return out
  }

  export interface StatusRow {
    app: string
    skill: string
    /** "no-skill" only when a located dir vanished between locate and status. */
    state: CapabilityResolver.State | "no-skill"
    repoHash?: string
    leafHash?: string
    installedAt?: string
    reason?: string
  }

  /** Read-only freshness across the target (no projection, no reload). */
  export async function status(target: Target): Promise<StatusRow[]> {
    const located = await locate(target)
    const rows: StatusRow[] = []
    for (const l of located) {
      const s = await CapabilitySyncExec.statusMcpSkill({
        skillName: l.skillName,
        mcpAppPath: l.mcpAppPath,
        sourceDir: l.sourceDir,
        projectionPath: l.projectionPath,
      })
      if (!s.managed) {
        rows.push({ app: l.app, skill: l.skillName, state: "no-skill" })
        continue
      }
      rows.push({
        app: l.app,
        skill: l.skillName,
        state: s.state,
        repoHash: s.repoHash,
        leafHash: s.leafHash,
        installedAt: s.installedAt,
        reason: s.reason,
      })
    }
    return rows
  }

  export type Outcome = "synced" | "current" | "reconciled" | "stopped" | "no-skill"

  export interface ResyncRow {
    app: string
    skill: string
    outcome: Outcome
    fromState?: CapabilityResolver.State
    toHash?: string
    reason?: string
  }

  /**
   * run — force re-projection of the targeted bundled skills from their repo SSOT.
   * Computes the pre-state (statusMcpSkill) for reporting, then forces the existing
   * preflight (forceRefresh bypasses the TTL; acceptSource reconciles a hand-edited
   * leaf, DD-5) and fires Skill.reset on success. A stop verdict is surfaced, never
   * silently loaded (no-silent-fallback).
   */
  /** Force-resync a single located skill (pre-state for reporting → forced preflight → reload). */
  export async function resyncOne(l: Located, opts?: { acceptSource?: boolean }): Promise<ResyncRow> {
    const pre = await CapabilitySyncExec.statusMcpSkill({
      skillName: l.skillName,
      mcpAppPath: l.mcpAppPath,
      sourceDir: l.sourceDir,
      projectionPath: l.projectionPath,
    })
    if (!pre.managed) return { app: l.app, skill: l.skillName, outcome: "no-skill" }
    const outcome = await CapabilitySyncExec.preflightMcpSkill({
      skillName: l.skillName,
      mcpAppPath: l.mcpAppPath,
      sourceDir: l.sourceDir,
      projectionPath: l.projectionPath,
      forceRefresh: true,
      acceptSource: opts?.acceptSource,
      reload: Skill.reset,
    })
    if (!outcome.proceed) {
      const reason = outcome.verdict.diagnostic?.reason ?? outcome.verdict.state
      log.warn("skill resync stopped", {
        app: l.app,
        skill: l.skillName,
        state: outcome.verdict.state,
        reason,
        remediation: outcome.verdict.diagnostic?.remediation,
      })
      return { app: l.app, skill: l.skillName, outcome: "stopped", fromState: pre.state, reason }
    }
    const reconciled = pre.state === "xdg-drift" || pre.state === "xdg-newer"
    const out: Outcome = pre.state === "current" ? "current" : reconciled ? "reconciled" : "synced"
    return { app: l.app, skill: l.skillName, outcome: out, fromState: pre.state, toHash: pre.repoHash }
  }

  export async function run(target: Target, opts?: { acceptSource?: boolean }): Promise<ResyncRow[]> {
    const located = await locate(target)
    const rows: ResyncRow[] = []
    for (const l of located) rows.push(await resyncOne(l, opts))
    return rows
  }

  // ── opt-in watch (DD-11) ───────────────────────────────────────────────────
  // We do NOT use fs.watch on a dir: Bun opens an FD per entry and exhausts them
  // (RCA 2026-06-01, server/session-storage-watch.ts). Instead, mirror the
  // existing MCP.resolveLocalSourceWatch philosophy — cheap mtime-baseline change
  // detection, polled by the foreground `skill watch` loop (and reusable by a
  // future connect-time auto-resync). Coalescing of rapid saves is the poll
  // interval itself: many saves within one tick → one resync.
  const watchBaseline = new Map<string, number>()

  /** newest mtime (ms) anywhere under dir, skipping vcs/dep noise; 0 if unreadable. */
  async function newestMtimeMs(dir: string): Promise<number> {
    let newest = 0
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()!
      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === ".venv") continue
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
          stack.push(p)
          continue
        }
        try {
          const st = await fs.stat(p)
          if (st.mtimeMs > newest) newest = st.mtimeMs
        } catch {
          /* file vanished mid-walk; ignore */
        }
      }
    }
    return newest
  }

  /**
   * sourceChanged — true when sourceDir's newest mtime advanced since the last
   * call (and updates the baseline). The FIRST call for a dir seeds the baseline
   * and returns false, so seeding never triggers a spurious resync. Idempotent
   * between edits: a second call with no new write returns false.
   */
  export async function sourceChanged(sourceDir: string): Promise<boolean> {
    const now = await newestMtimeMs(sourceDir)
    const prev = watchBaseline.get(sourceDir)
    watchBaseline.set(sourceDir, now)
    if (prev === undefined) return false
    return now > prev
  }

  /** Reset the watch baselines (test hook). */
  export function _resetWatchBaseline(): void {
    watchBaseline.clear()
  }
}
