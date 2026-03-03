import { existsSync, readFileSync, statSync } from "fs"
import { Flag } from "@/flag/flag"

type Cache = {
  path: string
  mtimeMs: number
  entries: Map<string, string>
}

let cache: Cache | undefined

function htpasswdPath() {
  return Flag.OPENCODE_SERVER_HTPASSWD ?? Flag.OPENCODE_SERVER_PASSWORD_FILE
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
  if (process.platform === "linux") return true
  return plainEnabled() || fileEnabled()
}

async function verifyPam(username: string, password: string): Promise<boolean> {
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
  const path = htpasswdPath()
  if (path && existsSync(path)) {
    const hash = readHtpasswd(path).get(username)
    if (hash) {
      if (await Bun.password.verify(password, hash)) return true
    }
  }

  const expectedUser = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  const expectedPass = Flag.OPENCODE_SERVER_PASSWORD ?? ""
  if (expectedPass && username === expectedUser && password === expectedPass) {
    return true
  }

  if (process.platform === "linux") {
    return verifyPam(username, password)
  }

  return false
}

function usernameHint() {
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
  filePath: htpasswdPath,
}
