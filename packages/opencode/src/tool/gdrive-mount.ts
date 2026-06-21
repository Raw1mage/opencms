import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import {
  checkFuseAvailable,
  getSetupStatus,
  isMounted,
  normalizeRemote,
  resolveHomeBoundMountPoint,
  runFixedArgv,
} from "../gdrive/setup-cli"

type GDriveMountMetadata = {
  action: string
  remote: string
  mountPoint: string
  mounted: boolean
  code?: string
  status?: unknown
}

const Params = z.object({
  action: z.enum(["status", "mount", "unmount", "remount"]),
  mountPoint: z.string().optional().describe("Mount point inside the current user's home. Defaults to ~/GoogleDrive."),
  remote: z.string().optional().describe("Optional rclone remote name. Defaults to gdrive."),
})

async function ensureEmptyOrMount(mountPoint: string): Promise<void> {
  await fs.mkdir(mountPoint, { recursive: true, mode: 0o700 })
  const entries = await fs.readdir(mountPoint)
  if (entries.length > 0 && !(await isMounted(mountPoint))) {
    throw new Error(
      "Mount point exists and is not empty. Choose an empty directory inside your home or unmount the existing mount first.",
    )
  }
}

async function unmountFixed(mountPoint: string): Promise<{ ok: boolean; error?: string }> {
  const candidates = [
    { command: "fusermount3", args: ["-u", mountPoint] },
    { command: "fusermount", args: ["-u", mountPoint] },
    { command: "umount", args: [mountPoint] },
  ]
  const errors: string[] = []
  for (const candidate of candidates) {
    const result = await runFixedArgv(candidate, 10_000)
    if (result.ok) return { ok: true }
    errors.push(`${candidate.command}: ${result.stderr || result.stdout || result.code || "failed"}`)
  }
  return { ok: false, error: errors.join("; ") }
}

async function startMount(remote: string, mountPoint: string): Promise<void> {
  const child = spawn("rclone", ["mount", remote, mountPoint, "--vfs-cache-mode", "writes"], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

function formatStatus(
  action: string,
  mountPoint: string,
  mounted: boolean,
  status: Awaited<ReturnType<typeof getSetupStatus>>,
): string {
  return [
    `Google Drive mount ${action} for ${status.remote}`,
    `- mount point: ${mountPoint}`,
    `- mounted: ${mounted ? "yes" : "no"}`,
    `- rclone available: ${status.rcloneAvailable ? "yes" : "no"}`,
    `- remote configured: ${status.remoteConfigured ? "yes" : "no"}`,
    `- FUSE available: ${status.fuseAvailable ? "yes" : "no"}`,
    status.remediation ? `- remediation: ${status.remediation}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export const GDriveMountTool = Tool.define<typeof Params, GDriveMountMetadata>("gdrive_mount", {
  description: `Mount, unmount, remount, or inspect Google Drive for the current Linux user using rclone FUSE.

Use this after gdrive_setup has configured the remote. Mount points must stay inside the current user's home directory and default to ~/GoogleDrive. The tool uses fixed argv operations only; it never asks the user to open a terminal and never accepts arbitrary rclone flags.`,
  parameters: Params,
  async execute(params) {
    const remote = normalizeRemote(params.remote)
    const mountPoint = await resolveHomeBoundMountPoint(params.mountPoint)
    const status = await getSetupStatus({ remote, mountPoint })
    let mounted = await isMounted(mountPoint)

    if (params.action === "status") {
      return {
        title: "Google Drive mount status",
        output: formatStatus(params.action, mountPoint, mounted, status),
        metadata: { action: params.action, remote, mountPoint, mounted, status },
      }
    }

    if (!status.rcloneAvailable) {
      return {
        title: "rclone is required",
        output: formatStatus(params.action, mountPoint, mounted, status),
        metadata: { action: params.action, remote, mountPoint, mounted, status, code: "RCLONE_MISSING" },
      }
    }
    if (!status.remoteConfigured) {
      return {
        title: "Google Drive remote missing",
        output: formatStatus(params.action, mountPoint, mounted, status),
        metadata: { action: params.action, remote, mountPoint, mounted, status, code: "REMOTE_MISSING" },
      }
    }
    if (!(await checkFuseAvailable())) {
      return {
        title: "FUSE is required",
        output: formatStatus(params.action, mountPoint, mounted, status),
        metadata: { action: params.action, remote, mountPoint, mounted, status, code: "FUSE_MISSING" },
      }
    }

    if (params.action === "unmount" || params.action === "remount") {
      if (mounted) {
        const result = await unmountFixed(mountPoint)
        if (!result.ok) {
          return {
            title: "Google Drive unmount failed",
            output: result.error ?? "Unmount failed.",
            metadata: { action: params.action, remote, mountPoint, mounted, status, code: "UNMOUNT_FAILED" },
          }
        }
      }
      mounted = await isMounted(mountPoint)
      if (params.action === "unmount") {
        return {
          title: "Google Drive unmounted",
          output: formatStatus(params.action, mountPoint, mounted, status),
          metadata: { action: params.action, remote, mountPoint, mounted, status },
        }
      }
    }

    if (mounted) {
      return {
        title: "Google Drive already mounted",
        output: formatStatus(params.action, mountPoint, mounted, status),
        metadata: { action: params.action, remote, mountPoint, mounted, status, code: "ALREADY_MOUNTED" },
      }
    }

    await ensureEmptyOrMount(mountPoint)
    await startMount(remote, mountPoint)
    mounted = await isMounted(mountPoint)
    return {
      title: mounted ? "Google Drive mounted" : "Google Drive mount started",
      output: formatStatus(params.action, mountPoint, mounted, status),
      metadata: { action: params.action, remote, mountPoint, mounted, status },
    }
  },
})
