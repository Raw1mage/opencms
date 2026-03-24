/**
 * Per-user daemon discovery and lifecycle management.
 *
 * Discovery file: $XDG_RUNTIME_DIR/opencode/daemon.json
 * PID file:       $XDG_RUNTIME_DIR/opencode/daemon.pid
 * Unix socket:    $XDG_RUNTIME_DIR/opencode/daemon.sock
 *
 * @event_20260319_daemonization Phase β
 */
import fs from "fs/promises"
import path from "path"
import os from "os"

export namespace Daemon {
  export type Info = {
    socketPath: string
    pid: number
    startedAt: number
    version: string
  }

  function runtimeDir(): string {
    // XDG_RUNTIME_DIR is typically /run/user/<uid> on systemd systems
    const xdg = process.env.XDG_RUNTIME_DIR
    if (xdg) return path.join(xdg, "opencode")
    // Fallback: /tmp/opencode-<uid>
    const uid = process.getuid?.() ?? "user"
    return path.join(os.tmpdir(), `opencode-${uid}`)
  }

  export function daemonDir(): string {
    return runtimeDir()
  }

  export function discoveryPath(): string {
    return path.join(runtimeDir(), "daemon.json")
  }

  export function pidPath(): string {
    return path.join(runtimeDir(), "daemon.pid")
  }

  export function socketPath(): string {
    return path.join(runtimeDir(), "daemon.sock")
  }

  export async function ensureDir(): Promise<void> {
    await fs.mkdir(runtimeDir(), { recursive: true })
  }

  /** Write discovery file and PID file atomically after daemon is ready. */
  export async function writeDiscovery(info: Info): Promise<void> {
    await ensureDir()
    await Bun.write(discoveryPath(), JSON.stringify(info, null, 2))
    await Bun.write(pidPath(), String(info.pid))
  }

  /** Remove discovery and PID files on clean shutdown. */
  export async function removeDiscovery(): Promise<void> {
    await fs.rm(discoveryPath(), { force: true })
    await fs.rm(pidPath(), { force: true })
    await fs.rm(socketPath(), { force: true })
  }

  /** Read and validate discovery file. Returns null if missing or stale. */
  export async function readDiscovery(): Promise<Info | null> {
    const file = Bun.file(discoveryPath())
    if (!(await file.exists())) return null
    let info: Info
    try {
      info = JSON.parse(await file.text())
    } catch {
      return null
    }
    // Validate PID is still alive
    if (!isPidAlive(info.pid)) {
      // Stale file — clean up so next invocation starts fresh
      await removeDiscovery().catch(() => {})
      return null
    }
    return info
  }

  /** Check if a PID is still alive using kill -0 semantics. */
  export function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Prevent duplicate daemon for the same user.
   * Returns existing PID if already running, null otherwise.
   */
  export async function checkSingleInstance(): Promise<number | null> {
    const file = Bun.file(pidPath())
    if (!(await file.exists())) return null
    let pid: number
    try {
      pid = parseInt(await file.text(), 10)
    } catch {
      return null
    }
    if (isNaN(pid)) return null
    if (isPidAlive(pid)) return pid
    // Stale PID file
    await fs.rm(pidPath(), { force: true })
    return null
  }

  /**
   * Spawn a detached per-user daemon process and wait until its discovery
   * file appears with a live PID.
   *
   * Resolution order for the opencode executable:
   *   1. OPENCODE_BIN env (set by webctl.sh / gateway)
   *   2. Bun.argv[0] — the same binary/script that the current process uses
   *
   * Returns the daemon Info on success, throws on timeout.
   */
  export async function spawn(opts?: { timeoutMs?: number }): Promise<Info> {
    const timeout = opts?.timeoutMs ?? 10_000
    const sock = socketPath()

    // Determine the executable: honour OPENCODE_BIN, else re-use ourselves
    const bin = process.env.OPENCODE_BIN ?? Bun.argv[0]
    const args = ["serve", "--unix-socket", sock]

    // If running via bun (argv[0] is bun), the real entry is argv[1]
    const spawnArgs = Bun.argv[0].endsWith("bun") || Bun.argv[0].endsWith("bun.exe")
      ? [Bun.argv[0], ...Bun.argv.slice(1, 2), ...args]  // bun <entry> serve --unix-socket ...
      : [bin, ...args]

    await ensureDir()

    const child = Bun.spawn(spawnArgs, {
      stdio: ["ignore", "ignore", "ignore"],
      // OPENCODE_SKIP_TUI=1: prevent daemon from loading TUI modules (app.tsx imports react)
      // which would cause "Cannot find module 'react/jsx-dev-runtime'" crash
      env: { ...process.env, OPENCODE_SKIP_TUI: "1" },
    })
    // Detach: unref so the TUI process can exit without waiting for daemon
    child.unref()

    // Poll for discovery file readiness
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const info = await readDiscovery()
      if (info) return info
      await Bun.sleep(150)
    }

    throw new Error(
      `Timed out waiting for daemon to become ready (${timeout}ms). Socket: ${sock}`,
    )
  }
}
