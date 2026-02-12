import path from "path"
import { spawn } from "child_process"
import { Shell } from "@/shell/shell"
import { Env } from "@/env"

const MAX_LIVE_OUTPUT_METADATA = 50_000

export interface ShellExecutionInput {
  command: string
  abort: AbortSignal
  cwd: string
  onLiveOutput?: (output: string) => void
}

export interface ShellExecutionResult {
  output: string
  aborted: boolean
}

function buildInvocationArgs(shellPath: string, command: string): string[] {
  const shellName = (
    process.platform === "win32" ? path.win32.basename(shellPath, ".exe") : path.basename(shellPath)
  ).toLowerCase()

  const invocations: Record<string, { args: string[] }> = {
    nu: { args: ["-c", command] },
    fish: { args: ["-c", command] },
    zsh: {
      args: [
        "-l",
        "-c",
        `
          [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
          [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
          eval ${JSON.stringify(command)}
        `,
      ],
    },
    bash: {
      args: [
        "-l",
        "-c",
        `
          shopt -s expand_aliases
          [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
          eval ${JSON.stringify(command)}
        `,
      ],
    },
    cmd: { args: ["/c", command] },
    powershell: { args: ["-NoProfile", "-Command", command] },
    pwsh: { args: ["-NoProfile", "-Command", command] },
    "": { args: ["-c", `${command}`] },
  }

  return (invocations[shellName] ?? invocations[""]).args
}

export function formatLiveOutput(output: string) {
  return output.length > MAX_LIVE_OUTPUT_METADATA ? output.slice(0, MAX_LIVE_OUTPUT_METADATA) + "\n\n..." : output
}

export async function executeShellCommand(input: ShellExecutionInput): Promise<ShellExecutionResult> {
  const shellPath = Shell.preferred()
  const args = buildInvocationArgs(shellPath, input.command)

  const proc = spawn(shellPath, args, {
    cwd: input.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...Env.all(),
      TERM: "dumb",
    },
  })

  let output = ""
  let aborted = false
  let exited = false

  const publish = () => {
    input.onLiveOutput?.(formatLiveOutput(output))
  }

  proc.stdout?.on("data", (chunk) => {
    output += chunk.toString()
    publish()
  })

  proc.stderr?.on("data", (chunk) => {
    output += chunk.toString()
    publish()
  })

  const kill = () => Shell.killTree(proc, { exited: () => exited })

  if (input.abort.aborted) {
    aborted = true
    await kill()
  }

  const abortHandler = () => {
    aborted = true
    void kill()
  }

  input.abort.addEventListener("abort", abortHandler, { once: true })

  await new Promise<void>((resolve) => {
    proc.once("close", () => {
      exited = true
      input.abort.removeEventListener("abort", abortHandler)
      resolve()
    })
    proc.once("error", (error) => {
      exited = true
      output += `\n\n<metadata>Failed to execute shell command: ${error instanceof Error ? error.message : String(error)}</metadata>`
      input.abort.removeEventListener("abort", abortHandler)
      resolve()
    })
  })

  if (aborted) {
    output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
  }

  return {
    output,
    aborted,
  }
}
