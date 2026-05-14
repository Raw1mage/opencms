import { createHash } from "node:crypto"
import { appendFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Log } from "@/util/log"

const log = Log.create({ service: "self-update" })

export namespace SelfUpdate {
  export type Action =
    | {
        type: "install-file"
        source: string
        target:
          | "/usr/local/bin/opencode-gateway"
          | "/etc/opencode/webctl.sh"
          | "/usr/local/libexec/opencms-daemon-launch"
          | "/etc/systemd/system/opencode-gateway.service"
          | "/etc/systemd/system/opencms-daemon-user@.service"
          | "/etc/systemd/system/opencms-daemon-wheel@.service"
        mode?: "0644" | "0755"
      }
    | {
        type: "sync-directory"
        source: string
        target: "/usr/local/share/opencode/frontend"
      }
    | {
        type: "restart-service"
        service: "opencode-gateway.service"
      }
    | {
        type: "daemon-reload"
      }

  export type ActionResult = {
    action: string
    argv: string[]
    exitCode: number
    stdout: string
    stderr: string
    sourceSha256?: string
  }

  export type Result = {
    ok: true
    sudoer: true
    uid: number
    user: string
    results: ActionResult[]
  }

  export type Failure = {
    ok: false
    code: "SELF_UPDATE_REQUIRES_SUDOER" | "SELF_UPDATE_ACTION_FAILED" | "SELF_UPDATE_INVALID_ACTION"
    message: string
    uid: number
    user: string
    results?: ActionResult[]
  }

  const auditPath = () =>
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
      "opencode",
      "self-update-audit.jsonl",
    )

  async function run(argv: string[]) {
    const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  async function sha256(file: string) {
    const data = await Bun.file(file).arrayBuffer()
    return createHash("sha256").update(Buffer.from(data)).digest("hex")
  }

  async function audit(entry: Record<string, unknown>) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"
    await appendFile(auditPath(), line).catch((error) =>
      log.warn("failed to write self-update audit", { error: String(error) }),
    )
  }

  export async function canSudo() {
    const uid = process.getuid?.() ?? -1
    const user = os.userInfo().username
    const probe = await run(["sudo", "-n", "-v"])
    const sudoer = probe.exitCode === 0
    await audit({
      event: "sudo-probe",
      uid,
      user,
      sudoer,
      exitCode: probe.exitCode,
      stderr: probe.stderr.slice(0, 500),
    })
    return { sudoer, uid, user, stderr: probe.stderr }
  }

  async function actionToArgv(action: Action): Promise<{ argv: string[]; sourceSha256?: string }> {
    if (action.type === "install-file") {
      if (
        action.target !== "/usr/local/bin/opencode-gateway" &&
        action.target !== "/etc/opencode/webctl.sh" &&
        action.target !== "/usr/local/libexec/opencms-daemon-launch" &&
        action.target !== "/etc/systemd/system/opencode-gateway.service" &&
        action.target !== "/etc/systemd/system/opencms-daemon-user@.service" &&
        action.target !== "/etc/systemd/system/opencms-daemon-wheel@.service"
      ) {
        throw new Error(`invalid install target: ${action.target}`)
      }
      await stat(action.source)
      const sourceSha256 = await sha256(action.source)
      const mode = action.mode ?? "0755"
      return { argv: ["sudo", "-n", "install", "-m", mode, action.source, action.target], sourceSha256 }
    }

    if (action.type === "sync-directory") {
      await stat(action.source)
      return {
        argv: ["sudo", "-n", "rsync", "-a", "--delete", `${action.source.replace(/\/+$/, "")}/`, `${action.target}/`],
      }
    }

    if (action.type === "restart-service") {
      if (action.service !== "opencode-gateway.service") throw new Error(`invalid service: ${action.service}`)
      return { argv: ["sudo", "-n", "systemctl", "restart", action.service] }
    }

    if (action.type === "daemon-reload") {
      return { argv: ["sudo", "-n", "systemctl", "daemon-reload"] }
    }

    throw new Error("unknown self-update action")
  }

  export async function runActions(actions: Action[]): Promise<Result | Failure> {
    const capability = await canSudo()
    const results: ActionResult[] = []
    if (!capability.sudoer) {
      return {
        ok: false,
        code: "SELF_UPDATE_REQUIRES_SUDOER",
        message: "Current daemon user cannot run non-interactive sudo.",
        uid: capability.uid,
        user: capability.user,
      }
    }

    for (const action of actions) {
      let argv: string[]
      let sourceSha256: string | undefined
      try {
        const prepared = await actionToArgv(action)
        argv = prepared.argv
        sourceSha256 = prepared.sourceSha256
      } catch (error) {
        await audit({
          event: "action-invalid",
          uid: capability.uid,
          user: capability.user,
          action,
          error: String(error),
        })
        return {
          ok: false,
          code: "SELF_UPDATE_INVALID_ACTION",
          message: String(error),
          uid: capability.uid,
          user: capability.user,
          results,
        }
      }

      const proc = await run(argv)
      const result: ActionResult = {
        action: action.type,
        argv,
        exitCode: proc.exitCode,
        stdout: proc.stdout.slice(0, 2000),
        stderr: proc.stderr.slice(0, 2000),
        sourceSha256,
      }
      results.push(result)
      await audit({ event: "action-result", uid: capability.uid, user: capability.user, result })
      if (proc.exitCode !== 0) {
        return {
          ok: false,
          code: "SELF_UPDATE_ACTION_FAILED",
          message: `${action.type} failed with exit ${proc.exitCode}`,
          uid: capability.uid,
          user: capability.user,
          results,
        }
      }
    }

    return { ok: true, sudoer: true, uid: capability.uid, user: capability.user, results }
  }
}
