import { describe, expect, test } from "bun:test"
import { matchDaemonSpawnDenylist } from "./bash"

/* Tests for safe-daemon-restart RESTART-002 daemon-spawn denylist.
 * See specs/safe-daemon-restart/test-vectors.json TV-3, TV-4. */

describe("daemon-spawn denylist", () => {
  test("blocks webctl.sh dev-start (TV-3)", () => {
    const m = matchDaemonSpawnDenylist("webctl.sh dev-start")
    expect(m).not.toBeNull()
    expect(m?.rule).toBe("webctl-restart-family")
  })

  test("blocks webctl.sh restart with flags", () => {
    const m = matchDaemonSpawnDenylist("./webctl.sh restart --force-gateway")
    expect(m?.rule).toBe("webctl-restart-family")
  })

  test("blocks webctl.sh web-refresh", () => {
    const m = matchDaemonSpawnDenylist("/etc/opencode/webctl.sh web-refresh")
    expect(m?.rule).toBe("webctl-restart-family")
  })

  test("blocks bun serve --unix-socket (TV-4)", () => {
    const m = matchDaemonSpawnDenylist(
      "bun run index.ts serve --unix-socket /run/user/1000/opencode/daemon.sock",
    )
    expect(m?.rule).toBe("bun-serve-unix-socket")
  })

  test("blocks opencode serve", () => {
    const m = matchDaemonSpawnDenylist("opencode serve --port 1080")
    expect(m?.rule).toBe("opencode-serve-or-web")
  })

  test("blocks systemctl restart opencode-gateway", () => {
    const m = matchDaemonSpawnDenylist("sudo systemctl restart opencode-gateway")
    expect(m?.rule).toBe("systemctl-gateway")
  })

  test("blocks indirect kill via pgrep opencode", () => {
    const m = matchDaemonSpawnDenylist("kill -TERM $(pgrep -f opencode-daemon)")
    expect(m?.rule).toBe("direct-daemon-signal")
  })

  test("allows legitimate git command", () => {
    expect(matchDaemonSpawnDenylist("git status")).toBeNull()
  })

  test("allows legitimate ls command", () => {
    expect(matchDaemonSpawnDenylist("ls -la /home/pkcs12")).toBeNull()
  })

  test("allows unrelated bun build", () => {
    expect(matchDaemonSpawnDenylist("bun build packages/opencode/src/index.ts")).toBeNull()
  })

  test("allows unrelated kill (not daemon-targeted)", () => {
    expect(matchDaemonSpawnDenylist("kill 12345")).toBeNull()
  })

  test("allows word webctl.sh in path context (not with restart verb)", () => {
    expect(matchDaemonSpawnDenylist("cat webctl.sh | head -20")).toBeNull()
  })

  test("argvHash is stable across calls", () => {
    const a = matchDaemonSpawnDenylist("webctl.sh dev-start")
    const b = matchDaemonSpawnDenylist("webctl.sh dev-start")
    expect(a?.argvHash).toBe(b?.argvHash)
    expect(a?.argvHash).toMatch(/^[0-9a-f]{8}$/)
  })

  test("argvHash differs for different commands", () => {
    const a = matchDaemonSpawnDenylist("webctl.sh dev-start")
    const b = matchDaemonSpawnDenylist("webctl.sh restart")
    expect(a?.argvHash).not.toBe(b?.argvHash)
  })
})
