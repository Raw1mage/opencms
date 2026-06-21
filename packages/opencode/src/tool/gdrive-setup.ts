import z from "zod"
import { Tool } from "./tool"
import {
  getSetupStatus,
  normalizeRemote,
  planRcloneConfigCreate,
  planRcloneConfigDelete,
  runFixedArgv,
} from "../gdrive/setup-cli"

type GDriveSetupMetadata = {
  action: string
  remote: string
  status?: unknown
  commandPlan?: { command: string; args: string[] }
  requiresBrowserApproval?: boolean
  code?: string
}

const Params = z.object({
  action: z.enum(["status", "start", "complete", "remove"]),
  remote: z.string().optional().describe("Optional rclone remote name. Defaults to gdrive."),
  authCode: z.string().optional().describe("Authorization code captured by the Web callback fallback."),
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

Use this before gdrive_mount when the Google Drive remote is missing or unhealthy. The tool performs bounded non-interactive setup checks and fixed-argv rclone operations. It never asks the user to open a terminal. If Google approval is required, return a browser/Web approval handoff instead. Never print OAuth tokens.`,
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
      const commandPlan = planRcloneConfigCreate(remote)
      return {
        title: "Google Drive setup requires browser approval",
        output: [
          `Prepared a bounded setup transaction for ${remote}.`,
          `The daemon will run a fixed rclone setup operation and hand Google OAuth approval to the Web/browser flow when available.`,
          `No terminal action is required from the user.`,
        ].join("\n"),
        metadata: {
          action: params.action,
          remote,
          status,
          commandPlan,
          requiresBrowserApproval: true,
          code: "WEB_APPROVAL_REQUIRED",
        },
      }
    }

    if (params.action === "complete") {
      return {
        title: "Google Drive setup completion pending Web callback",
        output:
          "OAuth completion must arrive through the Web callback or authCode handoff. This slice exposes the bounded tool surface but does not claim a completed token exchange.",
        metadata: {
          action: params.action,
          remote,
          requiresBrowserApproval: true,
          code: params.authCode ? "TOKEN_EXCHANGE_NOT_IMPLEMENTED" : "AUTH_CODE_REQUIRED",
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
