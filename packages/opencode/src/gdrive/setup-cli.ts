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

export type GDriveOAuthClient = {
  clientId: string
  clientSecret: string
  authUri?: string
  tokenUri?: string
}

export type GDriveOAuthToken = {
  access_token: string
  token_type?: string
  refresh_token?: string
  expiry?: string
  expires_in?: number
  scope?: string
}

export type GDriveSetupState = {
  remote: string
  username?: string
  nonce: string
  ts: number
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

export function gdriveOAuthClientFromEnv(env: NodeJS.ProcessEnv = process.env): GDriveOAuthClient | undefined {
  const clientId = env.OPENCODE_GDRIVE_CLIENT_ID ?? env.GOOGLE_DRIVE_CLIENT_ID ?? env.GOOGLE_CALENDAR_CLIENT_ID
  const clientSecret =
    env.OPENCODE_GDRIVE_CLIENT_SECRET ?? env.GOOGLE_DRIVE_CLIENT_SECRET ?? env.GOOGLE_CALENDAR_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  return {
    clientId,
    clientSecret,
    authUri: env.OPENCODE_GDRIVE_AUTH_URI ?? env.GOOGLE_DRIVE_AUTH_URI ?? "https://accounts.google.com/o/oauth2/auth",
    tokenUri: env.OPENCODE_GDRIVE_TOKEN_URI ?? env.GOOGLE_DRIVE_TOKEN_URI ?? "https://oauth2.googleapis.com/token",
  }
}

export function encodeSetupState(input: { remote: string; username?: string; now?: number; nonce?: string }): string {
  const payload: GDriveSetupState = {
    remote: normalizeRemote(input.remote),
    username: input.username,
    nonce: input.nonce ?? crypto.randomUUID(),
    ts: input.now ?? Date.now(),
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

export function decodeSetupState(state: string, now = Date.now()): GDriveSetupState {
  const payload = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as Partial<GDriveSetupState>
  if (!payload.remote || !payload.nonce || typeof payload.ts !== "number")
    throw new Error("Invalid Google Drive setup state.")
  if (now - payload.ts > 10 * 60 * 1000) throw new Error("Google Drive setup state expired.")
  return {
    remote: normalizeRemote(payload.remote),
    username: payload.username,
    nonce: payload.nonce,
    ts: payload.ts,
  }
}

export function buildGDriveAuthUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  authUri?: string
  scope?: string
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scope ?? "https://www.googleapis.com/auth/drive",
    access_type: "offline",
    prompt: "consent select_account",
    state: input.state,
  })
  return `${input.authUri ?? "https://accounts.google.com/o/oauth2/auth"}?${params.toString()}`
}

export async function exchangeGDriveAuthCode(input: {
  client: GDriveOAuthClient
  code: string
  redirectUri: string
  fetcher?: typeof fetch
}): Promise<GDriveOAuthToken> {
  const fetcher = input.fetcher ?? fetch
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  })
  const response = await fetcher(input.client.tokenUri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    const message =
      typeof data.error_description === "string" ? data.error_description : (data.error ?? response.statusText)
    throw new Error(`Google Drive token exchange failed: ${String(message)}`)
  }
  if (typeof data.access_token !== "string")
    throw new Error("Google Drive token exchange did not return an access token.")
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined
  return {
    access_token: data.access_token,
    token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiry: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    expires_in: expiresIn,
    scope: typeof data.scope === "string" ? data.scope : undefined,
  }
}

function sectionHeader(remote: string): string {
  return `[${normalizeRemote(remote).slice(0, -1)}]`
}

function upsertIniSection(input: { content: string; remote: string; lines: string[]; overwrite: boolean }): string {
  const header = sectionHeader(input.remote)
  const lines = input.content.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === header)
  if (start >= 0 && !input.overwrite)
    throw new Error(`${normalizeRemote(input.remote)} already exists; explicit overwrite is required.`)
  if (start < 0) {
    const prefix = input.content.trimEnd()
    return `${prefix ? `${prefix}\n\n` : ""}${[header, ...input.lines].join("\n")}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] ?? "")) {
      end = index
      break
    }
  }
  lines.splice(start, end - start, header, ...input.lines)
  return `${lines.join("\n").replace(/\n*$/, "")}\n`
}

export async function writeRcloneDriveRemote(input: {
  remote: string
  token: GDriveOAuthToken
  client: GDriveOAuthClient
  overwrite?: boolean
  home?: string
}) {
  const configPath = rcloneConfigPath(input.home)
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  const existing = await fs.readFile(configPath, "utf8").catch((error) => {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") return ""
    throw error
  })
  const token = {
    access_token: input.token.access_token,
    token_type: input.token.token_type ?? "Bearer",
    refresh_token: input.token.refresh_token,
    expiry: input.token.expiry,
  }
  const next = upsertIniSection({
    content: existing,
    remote: input.remote,
    overwrite: input.overwrite === true,
    lines: [
      "type = drive",
      `client_id = ${input.client.clientId}`,
      `client_secret = ${input.client.clientSecret}`,
      `token = ${JSON.stringify(token)}`,
    ],
  })
  await fs.writeFile(configPath, next, { mode: 0o600 })
  await fs.chmod(configPath, 0o600).catch(() => {})
  return { configPath, remote: normalizeRemote(input.remote) }
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
