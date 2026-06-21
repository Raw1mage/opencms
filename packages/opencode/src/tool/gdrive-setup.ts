import z from "zod"
import { Tool } from "./tool"
import {
  getSetupStatus,
  materializeRcloneDriveRemoteFromGoogleAuth,
  normalizeRemote,
  planRcloneConfigDelete,
  runFixedArgv,
} from "../gdrive/setup-cli"

type GDriveSetupMetadata = {
  action: string
  remote: string
  status?: unknown
  requiresBrowserApproval?: boolean
  code?: string
}

const Params = z.object({
  action: z.enum(["status", "start", "complete", "remove"]),
  remote: z.string().optional().describe("Optional rclone remote name. Defaults to gdrive."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing rclone remote when explicitly requested."),
})

function formatStatus(status: Awaited<ReturnType<typeof getSetupStatus>>): string {
  return [
    `Google Drive setup status for ${status.remote}`,
    `- rclone available: ${status.rcloneAvailable ? "yes" : "no"}`,
    `- remote configured: ${status.remoteConfigured ? "yes" : "no"}`,
    `- FUSE available: ${status.fuseAvailable ? "yes" : "no"}`,
    status.remediation ? `- remediation: ${status.remediation}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export const GDriveSetupTool = Tool.define<typeof Params, GDriveSetupMetadata>("gdrive_setup", {
  description: `Set up the current Linux user's Google Drive rclone remote through an agent-executable, CLI-first flow.

Use this before gdrive_mount when the Google Drive remote is missing or unhealthy. The tool reuses the current OpenCMS Google login token from gauth.json and materializes it into rclone config. It never asks the user to open a terminal and never prints OAuth tokens.`,
  parameters: Params,
  async execute(params) {
    const remote = normalizeRemote(params.remote)
    if (params.action === "status") {
      const status = await getSetupStatus({ remote })
      return {
        title: "Google Drive setup status",
        output: formatStatus(status),
        metadata: { action: params.action, remote, status },
      }
    }

    if (params.action === "start") {
      const status = await getSetupStatus({ remote })
      if (status.remoteConfigured && !params.overwrite) {
        return {
          title: "Google Drive remote already configured",
          output: `${remote} is already configured. If you need to replace it, call gdrive_setup with overwrite:true after explicit user approval.`,
          metadata: { action: params.action, remote, status, code: "REMOTE_ALREADY_CONFIGURED" },
        }
      }
      if (!status.rcloneAvailable) {
        return {
          title: "rclone is required",
          output: formatStatus(status),
          metadata: { action: params.action, remote, status, code: "RCLONE_MISSING" },
        }
      }
      try {
        await materializeRcloneDriveRemoteFromGoogleAuth({ remote, overwrite: params.overwrite })
      } catch (error) {
        return {
          title: "Google Drive login token is required",
          output: error instanceof Error ? error.message : String(error),
          metadata: { action: params.action, remote, status, code: "GOOGLE_LOGIN_TOKEN_REQUIRED" },
        }
      }
      const nextStatus = await getSetupStatus({ remote })
      return {
        title: "Google Drive remote configured",
        output: [
          `${remote} was configured from the current OpenCMS Google login token.`,
          `No additional Google OAuth approval was requested.`,
          formatStatus(nextStatus),
        ].join("\n"),
        metadata: {
          action: params.action,
          remote,
          status: nextStatus,
          requiresBrowserApproval: false,
          code: "REMOTE_MATERIALIZED_FROM_LOGIN",
        },
      }
    }

    if (params.action === "complete") {
      return {
        title: "Google Drive setup uses OpenCMS login",
        output:
          "No separate Google Drive OAuth completion step is required. Run gdrive_setup start to materialize the current OpenCMS Google login token into rclone config, then run gdrive_mount mount.",
        metadata: {
          action: params.action,
          remote,
          requiresBrowserApproval: false,
          code: "NO_SEPARATE_COMPLETION_REQUIRED",
        },
      }
    }

    const status = await getSetupStatus({ remote })
    if (!status.remoteConfigured) {
      return {
        title: "Google Drive remote not configured",
        output: `${remote} is not configured. Nothing was removed.`,
        metadata: { action: params.action, remote, status, code: "REMOTE_NOT_CONFIGURED" },
      }
    }
    if (!params.overwrite) {
      return {
        title: "Explicit approval required",
        output: `Removing ${remote} may delete local rclone credentials. Call gdrive_setup remove with overwrite:true only after explicit user approval.`,
        metadata: { action: params.action, remote, status, code: "EXPLICIT_APPROVAL_REQUIRED" },
      }
    }
    const result = await runFixedArgv(planRcloneConfigDelete(remote))
    return {
      title: result.ok ? "Google Drive remote removed" : "Google Drive remote removal failed",
      output: result.ok ? `${remote} removed.` : `Failed to remove ${remote}: ${result.stderr || result.stdout}`,
      metadata: { action: params.action, remote, status, code: result.ok ? "REMOTE_REMOVED" : "REMOVE_FAILED" },
    }
  },
})
