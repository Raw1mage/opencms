/**
 * harness/freerun-mode — watchdog trigger.
 *
 * Long-lived process that listens for events (file changes, webhook
 * deliveries, D-Bus signals, …) and spawns a freerun session per
 * matching rule. V1 ships with the rule schema + a simple inotify-style
 * file-change source; richer event sources can plug into the same
 * dispatch surface later.
 *
 * Rule shape (WatchdogRule below):
 *   {
 *     "id":          "screenshot-watcher",
 *     "trigger": { "kind": "fs-watch", "path": "/home/pkcs12/Pictures/Screenshots" },
 *     "rootNodeSeed": {
 *       "providerId": "custom-provider-work",
 *       "modelId":    "qwen3.6-35b-a3b-q4_k_m",
 *       "title":      "Analyse new screenshot",
 *       "body":       "A new screenshot landed at {{path}}. Summarise + categorise.",
 *       "iterationCap": 10
 *     }
 *   }
 *
 * V1 scope: schema + rule loader + a minimal `fs-watch` source. Other
 * source kinds (`http-webhook`, `dbus`, `bus-event`) declared but not
 * yet implemented — they'll throw a clear error at attach time.
 */

import z from "zod"
import * as fsAsync from "fs/promises"
import * as fsCore from "fs"
import { GoalTrigger } from "./goal"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Log } from "../../util/log"

const log = Log.create({ service: "freerun.trigger.watchdog" })

export namespace WatchdogTrigger {
  // ============================================================================
  // Rule schema
  // ============================================================================

  export const TriggerSource = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fs-watch"), path: z.string().min(1) }),
    z.object({ kind: z.literal("http-webhook"), pathPrefix: z.string().min(1) }),
    z.object({ kind: z.literal("dbus"), interface: z.string().min(1), member: z.string().min(1) }),
    z.object({ kind: z.literal("bus-event"), eventType: z.string().min(1) }),
  ])
  export type TriggerSource = z.infer<typeof TriggerSource>

  export const WatchdogRule = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    trigger: TriggerSource,
    rootNodeSeed: z.object({
      providerId: z.string(),
      modelId: z.string(),
      title: z.string().min(1),
      body: z.string().min(1), // may contain {{var}} placeholders interpolated from event context
      iterationCap: z.number().int().min(1).default(20),
      userId: z.string().optional(),
    }),
  })
  export type WatchdogRule = z.infer<typeof WatchdogRule>

  // ============================================================================
  // Event interpolation
  // ============================================================================

  /** Substitute `{{key}}` placeholders in `template` from `context`. */
  export function interpolate(template: string, context: Record<string, string>): string {
    return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => context[key] ?? `{{${key}}}`)
  }

  // ============================================================================
  // Attach (v1: fs-watch source only)
  // ============================================================================

  export interface AttachOptions {
    rule: WatchdogRule
    /** Optional onSpawn callback (for tests / monitoring). */
    onSpawn?: (sessionId: string, eventContext: Record<string, string>) => void
  }

  export interface AttachHandle {
    /** Stop watching + release resources. */
    detach(): Promise<void>
  }

  export async function attach(opts: AttachOptions): Promise<AttachHandle> {
    const { trigger, rootNodeSeed } = opts.rule

    if (trigger.kind !== "fs-watch") {
      throw new Error(`watchdog v1 only supports trigger.kind="fs-watch"; got "${trigger.kind}"`)
    }

    const targetPath = trigger.path
    try {
      const st = await fsAsync.stat(targetPath)
      if (!st.isDirectory()) {
        throw new Error(`watchdog target must be a directory: ${targetPath}`)
      }
    } catch (err) {
      throw new Error(`watchdog cannot stat target '${targetPath}': ${err instanceof Error ? err.message : err}`)
    }

    const seen = new Set<string>()
    // Prime with current directory contents — only NEW files trigger.
    for (const e of await fsAsync.readdir(targetPath)) seen.add(e)

    const watcher = fsCore.watch(targetPath, async (_event, filename) => {
      if (!filename || seen.has(filename)) return
      seen.add(filename)

      const eventContext: Record<string, string> = {
        path: `${targetPath}/${filename}`,
        filename,
        directory: targetPath,
        timestamp: new Date().toISOString(),
      }
      const sessionId = `${opts.rule.id}-${Date.now()}`

      try {
        await spawn(sessionId, rootNodeSeed, eventContext)
        opts.onSpawn?.(sessionId, eventContext)
      } catch (err) {
        log.warn("watchdog spawn failed", {
          ruleId: opts.rule.id,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return {
      async detach() {
        watcher.close()
      },
    }
  }

  async function spawn(
    sessionId: string,
    seed: WatchdogRule["rootNodeSeed"],
    eventContext: Record<string, string>,
  ): Promise<GoalTrigger.StartResult> {
    const cfg = await Config.get()
    const providerCfg = (cfg.provider as Record<
      string,
      { mode?: "full" | "lite" | "freerun"; options?: { baseURL?: string; apiKey?: string } }
    > | undefined)?.[seed.providerId]
    if (!providerCfg) {
      throw new Error(`watchdog: provider '${seed.providerId}' not in opencode.json`)
    }
    if (providerCfg.mode !== "freerun") {
      throw new Error(`watchdog: provider '${seed.providerId}' is not freerun-mode`)
    }
    if (!providerCfg.options?.baseURL) {
      throw new Error(`watchdog: provider '${seed.providerId}' has no options.baseURL`)
    }

    return GoalTrigger.start({
      sessionId,
      dataHome: Global.Path.data,
      goal: interpolate(seed.body, eventContext),
      title: interpolate(seed.title, eventContext),
      providerId: seed.providerId,
      modelId: seed.modelId,
      baseUrl: providerCfg.options.baseURL,
      apiKey: providerCfg.options.apiKey,
      userId: seed.userId ?? process.env.USER ?? "watchdog",
      iterationCapOverride: seed.iterationCap,
    })
  }
}
