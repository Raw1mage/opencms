import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { SkillResync } from "../../mcp/skill-resync"

function targetFrom(args: { target?: unknown; all?: unknown }): SkillResync.Target {
  if (args.all || args.target === undefined || args.target === null || args.target === "") return { kind: "all" }
  return { kind: "name", value: String(args.target) }
}

function shortHash(h?: string): string {
  return h ? h.slice(0, 12) : "-"
}

const ResyncSub = cmd({
  command: "resync [target]",
  describe: "force re-sync of MCP-bundled skill projections from their repo SSOT (bypasses the TTL/reconnect wait)",
  builder: (yargs: Argv) =>
    yargs
      .positional("target", {
        describe: "MCP app id or skill name; omit (or --all) for every bundled skill",
        type: "string",
      })
      .option("all", { describe: "resync every enabled app's bundled skills", type: "boolean" })
      .option("accept-source", {
        describe: "reconcile a hand-edited projection (drift) to the repo SSOT — repo wins",
        type: "boolean",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const rows = await SkillResync.run(targetFrom(args), { acceptSource: Boolean(args["accept-source"]) })
      if (rows.length === 0) {
        console.log("no enabled MCP app bundles a matching skill")
        return
      }
      let anyStopped = false
      for (const r of rows) {
        if (r.outcome === "stopped") {
          anyStopped = true
          console.log(`✗ ${r.app}/${r.skill}: stopped (${r.fromState}) — ${r.reason}`)
          console.log(`    re-run with --accept-source to reconcile the projection to the repo SSOT`)
        } else if (r.outcome === "current") {
          console.log(`= ${r.app}/${r.skill}: already current`)
        } else if (r.outcome === "no-skill") {
          console.log(`- ${r.app}/${r.skill}: not capability-sync-managed`)
        } else {
          const verb = r.outcome === "reconciled" ? "reconciled" : "synced"
          console.log(`✓ ${r.app}/${r.skill}: ${verb} (${r.fromState} → ${shortHash(r.toHash)})`)
        }
      }
      if (anyStopped) process.exitCode = 1
    })
  },
})

const StatusSub = cmd({
  command: "status [target]",
  describe: "report MCP-bundled skill projection freshness (read-only): current | stale | drifted | missing",
  builder: (yargs: Argv) =>
    yargs.positional("target", {
      describe: "MCP app id or skill name; omit for all bundled skills",
      type: "string",
    }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const rows = await SkillResync.status(targetFrom(args))
      if (rows.length === 0) {
        console.log("no enabled MCP app bundles a matching skill")
        return
      }
      // Friendly verdict mapping over the resolver's 7-state classification.
      const friendly: Record<string, string> = {
        current: "current",
        "repo-newer": "stale (repo ahead — run `skill resync`)",
        missing: "missing (never projected — run `skill resync`)",
        "xdg-drift": "drifted (projection hand-edited — `skill resync --accept-source`)",
        "xdg-newer": "drifted (xdg-newer — `skill resync --accept-source`)",
        invalid: "invalid sidecar",
        "sync-failed": "sync-failed",
        "no-skill": "no skill dir",
      }
      for (const r of rows) {
        const label = friendly[r.state] ?? r.state
        const extra = r.installedAt ? `  (synced ${r.installedAt})` : ""
        console.log(`${r.app}/${r.skill}: ${label}${extra}`)
      }
    })
  },
})

const ListSub = cmd({
  command: "list",
  describe: "list MCP-bundled skills discovered across enabled apps",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    await bootstrap(process.cwd(), async () => {
      const located = await SkillResync.locate({ kind: "all" })
      if (located.length === 0) {
        console.log("no enabled MCP app bundles any skills")
        return
      }
      for (const l of located) {
        console.log(`${l.app}/${l.skillName}\n    source: ${l.sourceDir}\n    leaf:   ${l.projectionPath}`)
      }
    })
  },
})

const WatchSub = cmd({
  command: "watch [target]",
  describe: "watch bundled-skill sources and auto-resync on every edit (Ctrl-C to stop)",
  builder: (yargs: Argv) =>
    yargs
      .positional("target", { describe: "MCP app id or skill name; omit for all", type: "string" })
      .option("interval", { describe: "poll interval in ms (coalesces rapid saves)", type: "number", default: 800 })
      .option("accept-source", {
        describe: "auto-reconcile a hand-edited projection to the repo SSOT on change",
        type: "boolean",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const located = await SkillResync.locate(targetFrom(args))
      if (located.length === 0) {
        console.log("no enabled MCP app bundles a matching skill")
        return
      }
      const intervalMs = Math.max(150, Number(args.interval) || 800)
      const acceptSource = Boolean(args["accept-source"])
      // Seed baselines so we only fire on edits AFTER watch starts.
      for (const l of located) await SkillResync.sourceChanged(l.sourceDir)
      console.log(`watching ${located.length} skill(s) every ${intervalMs}ms — edit, save, it goes live. Ctrl-C to stop:`)
      for (const l of located) console.log(`  ${l.app}/${l.skillName}  ←  ${l.sourceDir}`)

      let stop = false
      const onSig = () => {
        stop = true
      }
      process.on("SIGINT", onSig)
      process.on("SIGTERM", onSig)
      try {
        while (!stop) {
          await new Promise((r) => setTimeout(r, intervalMs))
          if (stop) break
          for (const l of located) {
            if (!(await SkillResync.sourceChanged(l.sourceDir))) continue
            const row = await SkillResync.resyncOne(l, { acceptSource })
            const t = new Date().toTimeString().slice(0, 8)
            if (row.outcome === "stopped") {
              console.log(`[${t}] ✗ ${l.app}/${l.skillName}: ${row.reason}`)
              console.log(`        (projection was hand-edited — restart watch with --accept-source to discard it)`)
            } else if (row.outcome === "current" || row.outcome === "no-skill") {
              // nothing meaningful changed in the projection; stay quiet
            } else {
              console.log(`[${t}] ✓ ${l.app}/${l.skillName}: ${row.outcome} → live`)
            }
          }
        }
      } finally {
        process.off("SIGINT", onSig)
        process.off("SIGTERM", onSig)
      }
      console.log("\nstopped watching")
    })
  },
})

export const SkillCommand = cmd({
  command: "skill",
  describe: "inspect and re-sync MCP-bundled skill projections (SSOT → XDG)",
  builder: (yargs: Argv) =>
    yargs.command(ResyncSub).command(StatusSub).command(WatchSub).command(ListSub).demandCommand(1),
  handler: () => {},
})
