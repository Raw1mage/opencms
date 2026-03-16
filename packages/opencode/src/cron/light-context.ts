import { Global } from "../global"

/**
 * Light context bootstrap for cron sessions (D.1.3).
 *
 * Produces a minimal system context that skips workspace file injection
 * (no README, no directory listing, no skill preloading) to keep token
 * footprint low for scheduled/isolated job sessions.
 *
 * IDEF0 reference: A12 (Bootstrap Lightweight Context)
 * GRAFCET reference: opencode_a1_grafcet.json step S2
 * Design decision: DD-8
 */
export function getCronPreloadedContext(input: {
  jobName: string
  jobId: string
  runId: string
}): string {
  return `
<preloaded_context mode="cron-light">
<cron_context>
<job_name>${input.jobName}</job_name>
<job_id>${input.jobId}</job_id>
<run_id>${input.runId}</run_id>
<config_dir>${Global.Path.config}</config_dir>
</cron_context>
</preloaded_context>

This is a cron-triggered session running in lightweight mode. Workspace files are NOT preloaded. Use tools to read files only when necessary. Focus on executing the job payload efficiently.
`
}

/**
 * Get preloaded context based on whether this is a cron light-context session.
 * Falls back to the standard getPreloadedContext for non-cron sessions.
 */
export async function getPreloadedContextForCron(input: {
  lightContext: boolean
  jobName: string
  jobId: string
  runId: string
  fallback: () => Promise<string>
}): Promise<string> {
  if (input.lightContext) {
    return getCronPreloadedContext({
      jobName: input.jobName,
      jobId: input.jobId,
      runId: input.runId,
    })
  }
  return input.fallback()
}
