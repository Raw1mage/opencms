import { Flag } from "@/flag/flag"

function enabled() {
  // Internal per-user daemon is bound to loopback and fronted by gateway.
  // Skip web-auth challenge in this mode to allow gateway-to-daemon RPC.
  if (process.env.OPENCODE_USER_DAEMON_MODE === "1") return false
  return process.platform === "linux"
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
  if (process.platform !== "linux") return false
  return verifyPam(username, password)
}

function usernameHint() {
  return (
    process.env.SUDO_USER ?? process.env.LOGNAME ?? process.env.USER ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  )
}

export const WebAuthCredentials = {
  enabled,
  verify,
  usernameHint,
}
