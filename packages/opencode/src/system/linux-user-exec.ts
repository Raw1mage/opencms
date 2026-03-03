import fs from "fs"

export namespace LinuxUserExec {
  const USER_RE = /^[a-z_][a-z0-9_-]*[$]?$/i
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

  function truthy(value: string | undefined) {
    if (!value) return false
    const v = value.toLowerCase()
    return v === "1" || v === "true"
  }

  function disabled(value: string | undefined) {
    if (!value) return false
    const v = value.toLowerCase()
    return v === "0" || v === "false"
  }

  export function enabled() {
    if (process.platform !== "linux") return false
    if (disabled(process.env.OPENCODE_RUN_AS_USER_ENABLED)) return false
    if (!truthy(process.env.OPENCODE_RUN_AS_USER_ENABLED)) return false

    const wrapper = process.env.OPENCODE_RUN_AS_USER_WRAPPER || "/usr/local/libexec/opencode-run-as-user"
    if (!fs.existsSync(wrapper)) return false
    return true
  }

  export function sanitizeUsername(username: string | undefined) {
    if (!username) return
    if (!USER_RE.test(username)) return
    if (username === "root") return
    return username
  }

  export function resolveExecutionUser(username: string | undefined) {
    if (!enabled()) return
    return sanitizeUsername(username)
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

  function sanitizeEnv(env: Record<string, string | undefined>) {
    const out: Array<[string, string]> = []
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue
      if (!ENV_KEY_RE.test(key)) continue
      if (key.includes("\n") || value.includes("\n")) continue
      out.push([key, value])
    }
    return out
  }

  export function buildSudoInvocation(input: {
    user: string
    cwd: string
    executable: string
    args?: string[]
    env?: Record<string, string | undefined>
  }) {
    const wrapper = process.env.OPENCODE_RUN_AS_USER_WRAPPER || "/usr/local/libexec/opencode-run-as-user"
    const sudoBin = process.env.OPENCODE_RUN_AS_USER_SUDO_BIN || "sudo"
    const args = ["-n", wrapper, "--user", input.user, "--cwd", input.cwd]
    for (const [key, value] of sanitizeEnv(input.env ?? {})) {
      args.push("--env", `${key}=${value}`)
    }
    args.push("--", input.executable, ...(input.args ?? []))
    return {
      command: sudoBin,
      args,
    }
  }
}
