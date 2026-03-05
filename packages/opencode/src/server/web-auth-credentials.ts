import { existsSync, readFileSync, statSync } from "fs"
import { Flag } from "@/flag/flag"

type AuthMode = "auto" | "pam" | "htpasswd" | "legacy"

type Cache = {
  path: string
  mtimeMs: number
  entries: Map<string, string>
}

let cache: Cache | undefined

function htpasswdPath() {
  return Flag.OPENCODE_SERVER_HTPASSWD ?? Flag.OPENCODE_SERVER_PASSWORD_FILE
}

function authMode(): AuthMode {
  const raw = Flag.OPENCODE_AUTH_MODE?.trim().toLowerCase()
  if (raw === "pam" || raw === "htpasswd" || raw === "legacy" || raw === "auto") return raw
  return "auto"
}

function parseHtpasswd(content: string) {
  const entries = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf(":")
    if (index <= 0) continue
    const user = trimmed.slice(0, index).trim()
    const hash = trimmed.slice(index + 1).trim()
    if (!user || !hash) continue
    entries.set(user, hash)
  }
  return entries
}

function readHtpasswd(path: string) {
  const stat = statSync(path)
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs) return cache.entries
  const content = readFileSync(path, "utf8")
  const entries = parseHtpasswd(content)
  cache = {
    path,
    mtimeMs: stat.mtimeMs,
    entries,
  }
  return entries
}

function plainEnabled() {
  return !!Flag.OPENCODE_SERVER_PASSWORD
}

function fileEnabled() {
  const path = htpasswdPath()
  if (!path) return false
  return existsSync(path)
}

function enabled() {
  // Internal per-user daemon is bound to loopback and fronted by gateway.
  // Skip web-auth challenge in this mode to allow gateway-to-daemon RPC.
  if (process.env.OPENCODE_USER_DAEMON_MODE === "1") return false
  const mode = authMode()

  if (mode === "pam") return process.platform === "linux"
  if (mode === "htpasswd") return fileEnabled()
  if (mode === "legacy") return plainEnabled()

  if (process.platform === "linux") return true
  return plainEnabled() || fileEnabled()
}

async function verifyPam(username: string, password: string): Promise<boolean> {
  try {
    const pam = await import("authenticate-pam")
    const ok = await new Promise<boolean>((resolve) => {
      pam.authenticate(username, password, (err: Error | null) => {
        resolve(!err)
      })
    })
    if (ok) return true
  } catch {
    // Fallback to interactive su probe for environments without authenticate-pam runtime support.
  }

  const { spawn } = await import("bun-pty")
  return new Promise((resolve) => {
    let done = false
    const finish = (result: boolean) => {
      if (done) return
      done = true
      try {
        term.kill()
      } catch {}
      resolve(result)
    }

    const term = spawn("su", ["-", username, "-c", "exit 0"], {
      name: "xterm-color",
      cols: 80,
      rows: 30,
    })

    const timer = setTimeout(() => {
      finish(false)
    }, 5000)

    let out = ""
    let submitted = false
    term.onData((data: string) => {
      out += data.toLowerCase()
      if (!submitted && out.includes("password")) {
        submitted = true
        term.write(password + "\n")
      }
    })

    term.onExit((code: { exitCode: number }) => {
      clearTimeout(timer)
      finish(code.exitCode === 0)
    })
  })
}

async function verify(username: string, password: string): Promise<boolean> {
  const mode = authMode()

  if (mode === "pam") {
    if (process.platform !== "linux") return false
    return verifyPam(username, password)
  }

  const path = htpasswdPath()
  if (mode !== "legacy" && path && existsSync(path)) {
    const hash = readHtpasswd(path).get(username)
    if (hash) {
      if (await Bun.password.verify(password, hash)) return true
    }
    if (mode === "htpasswd") return false
  }

  const expectedUser = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  const expectedPass = Flag.OPENCODE_SERVER_PASSWORD ?? ""
  if (mode !== "htpasswd" && expectedPass && username === expectedUser && password === expectedPass) {
    return true
  }

  if (mode === "legacy") return false

  if (process.platform === "linux") {
    return verifyPam(username, password)
  }

  return false
}

function usernameHint() {
  if (authMode() === "pam") {
    return (
      process.env.SUDO_USER ?? process.env.LOGNAME ?? process.env.USER ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
    )
  }

  const path = htpasswdPath()
  if (path && existsSync(path)) {
    const first = readHtpasswd(path).keys().next()
    if (!first.done) return first.value
  }
  return Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
}

export const WebAuthCredentials = {
  enabled,
  verify,
  usernameHint,
  mode: authMode,
  filePath: htpasswdPath,
}
