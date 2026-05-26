/**
 * harness/freerun-mode — cron trigger.
 *
 * Invoked by an OS cron entry (or any other periodic scheduler). Reads a
 * small JSON task definition file describing what to run and delegates
 * to the goal trigger. The task file is the SSOT for what this cron
 * tick does — keeping it on disk lets operators edit cadence + content
 * independently of opencode.
 *
 * Task file shape (TaskDef below):
 *   {
 *     "sessionId": "daily-sweep",
 *     "providerId": "custom-provider-work",
 *     "modelId":    "qwen3.6-35b-a3b-q4_k_m",
 *     "title":      "Daily inbox sweep",
 *     "body":       "Read latest emails and summarize unread to ~/Inbox.md",
 *     "rootMode":   "pending-plan",
 *     "iterationCap": 20
 *   }
 *
 * Recommended cron invocation:
 *   0 8 * * *  /usr/local/bin/opencode freerun-cron /home/pkcs12/.config/opencode/cron/daily-sweep.json
 */

import { GoalTrigger } from "./goal"
import { Config } from "@/config/config"
import { Global } from "@/global"
import z from "zod"

export namespace CronTrigger {
  export const TaskDef = z.object({
    sessionId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    providerId: z.string(),
    modelId: z.string(),
    title: z.string().min(1),
    body: z.string().min(1),
    rootMode: z.enum(["pending-plan", "pending-exec"]).default("pending-plan"),
    iterationCap: z.number().int().min(1).default(20),
    userId: z.string().optional(),
  })
  export type TaskDef = z.infer<typeof TaskDef>

  /** Read a task definition file and drive one freerun session. */
  export async function runFromTaskFile(taskFilePath: string): Promise<GoalTrigger.StartResult> {
    const text = await Bun.file(taskFilePath).text()
    const parsed = TaskDef.parse(JSON.parse(text))

    const cfg = await Config.get()
    const providerCfg = (cfg.provider as Record<
      string,
      { mode?: "full" | "lite" | "freerun"; options?: { baseURL?: string; apiKey?: string } }
    > | undefined)?.[parsed.providerId]
    if (!providerCfg) {
      throw new Error(`cron task ${taskFilePath}: provider '${parsed.providerId}' not in opencode.json`)
    }
    if (providerCfg.mode !== "freerun") {
      throw new Error(`cron task ${taskFilePath}: provider '${parsed.providerId}' is not freerun-mode`)
    }
    if (!providerCfg.options?.baseURL) {
      throw new Error(`cron task ${taskFilePath}: provider '${parsed.providerId}' has no options.baseURL`)
    }

    return GoalTrigger.start({
      sessionId: parsed.sessionId,
      dataHome: Global.Path.data,
      goal: parsed.body,
      title: parsed.title,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      baseUrl: providerCfg.options.baseURL,
      apiKey: providerCfg.options.apiKey,
      userId: parsed.userId ?? process.env.USER ?? "cron",
      iterationCapOverride: parsed.iterationCap,
    })
  }
}
