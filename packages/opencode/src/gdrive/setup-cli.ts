import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export const DEFAULT_GDRIVE_REMOTE = "gdrive:"
export const DEFAULT_GDRIVE_MOUNT_DIR = "GoogleDrive"

export type FixedArgv = {
  command: string
  args: string[]
}

export type FixedCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  code?: string | number
}

export type GDriveSetupStatus = {
  home: string
  configPath: string
  remote: string
  rcloneAvailable: boolean
  remoteConfigured: boolean
  fuseAvailable: boolean
  mounted?: boolean
  mountPoint?: string
  remediation?: string
}

export function normalizeRemote(remote?: string): string {
  const raw = (remote ?? DEFAULT_GDRIVE_REMOTE).trim()
  const name = raw.endsWith(":") ? raw : `${raw}:`
  if (!/^[A-Za-z0-9_.-]+:$/.test(name)) {
    throw new Error(`Invalid Google Drive remote name "${raw}". Use a simple rclone remote name such as "gdrive".`)
  }
  return name
}

export function defaultMountPoint(home = os.homedir()): string {
  if (!home) throw new Error("Cannot resolve current user home directory for Google Drive mount.")
  return path.join(home, DEFAULT_GDRIVE_MOUNT_DIR)
}

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function realpathIfExists(candidate: string): Promise<string | undefined> {
  try {
    return await fs.realpath(candidate)
  } catch {
    return undefined
  }
}

export async function resolveHomeBoundMountPoint(input?: string, home = os.homedir()): Promise<string> {
  if (!home) throw new Error("Cannot resolve current user home directory for Google Drive mount.")
  const resolvedHome = path.resolve(home)
  let candidate: string
  const requested = input?.trim()
  if (!requested) candidate = defaultMountPoint(resolvedHome)
  else if (requested === "~") candidate = resolvedHome
  else if (requested.startsWith("~/")) candidate = path.join(resolvedHome, requested.slice(2))
  else if (requested.startsWith("~")) throw new Error("Mount point must stay inside the current user's home directory.")
  else if (path.isAbsolute(requested)) candidate = path.resolve(requested)
  else candidate = path.resolve(resolvedHome, requested)

  if (!isPathInside(candidate, resolvedHome)) {
    throw new Error(
      "Mount point rejected: Google Drive mounts are only allowed inside the current user's home directory.",
    )
  }

  const realCandidate = await realpathIfExists(candidate)
  if (realCandidate && !isPathInside(realCandidate, resolvedHome)) {
    throw new Error("Mount point rejected: existing path resolves outside the current user's home directory.")
  }

  const parentReal = await realpathIfExists(path.dirname(candidate))
  if (parentReal && !isPathInside(parentReal, resolvedHome)) {
    throw new Error("Mount point rejected: parent directory resolves outside the current user's home directory.")
  }

  return candidate
}

export function rcloneConfigPath(home = os.homedir()): string {
  if (!home) throw new Error("Cannot resolve current user home directory for rclone config.")
  return path.join(home, ".config", "rclone", "rclone.conf")
}

export function planRcloneVersion(): FixedArgv {
  return { command: "rclone", args: ["version"] }
}

export function planRcloneListRemotes(): FixedArgv {
  return { command: "rclone", args: ["listremotes"] }
}

export function planRcloneConfigCreate(remote: string): FixedArgv {
  const name = normalizeRemote(remote).slice(0, -1)
  return { command: "rclone", args: ["config", "create", name, "drive", "config_is_local", "false"] }
}

export function planRcloneConfigDelete(remote: string): FixedArgv {
  return { command: "rclone", args: ["config", "delete", normalizeRemote(remote).slice(0, -1)] }
}

export async function runFixedArgv(plan: FixedArgv, timeoutMs = 10_000): Promise<FixedCommandResult> {
  try {
    const result = await execFileAsync(plan.command, plan.args, { timeout: timeoutMs, windowsHide: true })
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number }
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, code: err.code }
  }
}

export async function listRemotes(run = runFixedArgv): Promise<{ ok: boolean; remotes: string[]; error?: string }> {
  const result = await run(planRcloneListRemotes())
  if (!result.ok)
    return { ok: false, remotes: [], error: result.stderr || result.stdout || "rclone listremotes failed" }
  return {
    ok: true,
    remotes: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

export async function checkFuseAvailable(run = runFixedArgv): Promise<boolean> {
  const fusermount3 = await run({ command: "fusermount3", args: ["--version"] }, 5_000)
  if (fusermount3.ok) return true
  const fusermount = await run({ command: "fusermount", args: ["--version"] }, 5_000)
  if (fusermount.ok) return true
  try {
    await fs.access("/dev/fuse")
    return true
  } catch {
    return false
  }
}

export function decodeMountInfoPath(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\")
}

export async function isMounted(mountPoint: string): Promise<boolean> {
  const resolved = path.resolve(mountPoint)
  try {
    const raw = await fs.readFile("/proc/self/mountinfo", "utf8")
    return raw.split("\n").some((line) => decodeMountInfoPath(line.split(" ")[4] ?? "") === resolved)
  } catch {
    return false
  }
}

export async function getSetupStatus(input: { remote?: string; mountPoint?: string } = {}): Promise<GDriveSetupStatus> {
  const home = os.homedir()
  const remote = normalizeRemote(input.remote)
  const mountPoint = input.mountPoint ? await resolveHomeBoundMountPoint(input.mountPoint, home) : undefined
  const version = await runFixedArgv(planRcloneVersion(), 5_000)
  if (!version.ok) {
    return {
      home,
      configPath: rcloneConfigPath(home),
      remote,
      rcloneAvailable: false,
      remoteConfigured: false,
      fuseAvailable: false,
      mountPoint,
      mounted: mountPoint ? await isMounted(mountPoint) : undefined,
      remediation:
        "Install rclone through the managed environment, then ask the agent to run gdrive_setup start again.",
    }
  }
  const remotes = await listRemotes()
  const fuseAvailable = await checkFuseAvailable()
  return {
    home,
    configPath: rcloneConfigPath(home),
    remote,
    rcloneAvailable: true,
    remoteConfigured: remotes.ok && remotes.remotes.includes(remote),
    fuseAvailable,
    mountPoint,
    mounted: mountPoint ? await isMounted(mountPoint) : undefined,
    remediation:
      remotes.ok && remotes.remotes.includes(remote)
        ? undefined
        : "Ask the agent to run gdrive_setup start to create the Google Drive remote; browser approval may be required.",
  }
}
