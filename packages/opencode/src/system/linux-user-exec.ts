/**
 * Linux user utilities — read-only helpers for resolving user identities.
 *
 * @event_20260319_daemonization Phase δ — sudo invocation functions removed.
 * buildSudoInvocation / enabled / resolveExecutionUser are gone because the
 * per-user daemon already runs as the correct UID.  Retained: sanitizeUsername,
 * resolveLinuxUserHome, resolveLinuxUserUID (used by manager.ts / app.ts).
 */
import fs from "fs"

export namespace LinuxUserExec {
  const USER_RE = /^[a-z_][a-z0-9_-]*[$]?$/i

  export function sanitizeUsername(username: string | undefined) {
    if (!username) return
    if (!USER_RE.test(username)) return
    if (username === "root") return
    return username
  }

  export function resolveLinuxUserHome(username: string | undefined) {
    const safe = sanitizeUsername(username)
    if (!safe) return
    if (process.platform !== "linux") return
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf8")
      for (const line of passwd.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue
        const parts = line.split(":")
        if (parts.length < 7) continue
        if (parts[0] !== safe) continue
        const home = parts[5]
        if (!home || !home.startsWith("/")) return
        return home
      }
    } catch {
      return
    }
  }

  export function resolveLinuxUserUID(username: string | undefined) {
    const safe = sanitizeUsername(username)
    if (!safe) return
    if (process.platform !== "linux") return
    try {
      const passwd = fs.readFileSync("/etc/passwd", "utf8")
      for (const line of passwd.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue
        const parts = line.split(":")
        if (parts.length < 7) continue
        if (parts[0] !== safe) continue
        const uid = Number(parts[2])
        if (!Number.isFinite(uid) || uid < 0) return
        return uid
      }
    } catch {
      return
    }
  }

  export function isSudoer(username: string | undefined) {
    const safe = sanitizeUsername(username)
    if (!safe) return false
    if (process.platform !== "linux") return false
    try {
      const group = fs.readFileSync("/etc/group", "utf8")
      for (const line of group.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue
        const parts = line.split(":")
        if (parts.length < 4) continue
        const name = parts[0]
        if (name !== "sudo" && name !== "wheel" && name !== "admin") continue
        const members = parts[3]
          .split(",")
          .map((member) => member.trim())
          .filter(Boolean)
        if (members.includes(safe)) return true
      }
    } catch {
      return false
    }
    return false
  }
}
