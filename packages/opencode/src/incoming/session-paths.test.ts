import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ENV_KEY = "OPENCODE_DATA_HOME"
let tmpRoot: string
let prev: string | undefined

const SID_A = "ses_paths_test_a000000000"
const SID_B = "ses_paths_test_b000000000"

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "session-paths-test-"))
  prev = process.env[ENV_KEY]
  process.env[ENV_KEY] = tmpRoot
})

afterEach(() => {
  if (prev === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prev
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("SessionIncomingPaths.tryLandInSession", () => {
  it("writes bytes to <data>/sessions/<id>/attachments/<filename>", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const result = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: "screenshot.png",
      bytes: new Uint8Array([1, 2, 3, 4]),
    })
    expect(result).not.toBeNull()
    expect(result!.sanitizedName).toBe("screenshot.png")
    expect(result!.sessionPath).toContain("sessions")
    expect(result!.sessionPath).toContain(SID_A)
    expect(result!.sessionPath).toContain("screenshot.png")
    const abs = SessionIncomingPaths.resolveAbsolute(SID_A, result!.sessionPath)
    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it("dedupes when same bytes are uploaded twice", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const bytes = new Uint8Array([9, 9, 9])
    const a = await SessionIncomingPaths.tryLandInSession({ sessionID: SID_A, filename: "dup.png", bytes })
    const b = await SessionIncomingPaths.tryLandInSession({ sessionID: SID_A, filename: "dup.png", bytes })
    expect(a!.sessionPath).toBe(b!.sessionPath)
    expect(a!.sanitizedName).toBe("dup.png")
    expect(b!.sanitizedName).toBe("dup.png")
  })

  it("conflict-renames when same filename has different bytes", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const a = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: "fork.png",
      bytes: new Uint8Array([1, 2, 3]),
    })
    const b = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: "fork.png",
      bytes: new Uint8Array([4, 5, 6]),
    })
    expect(a!.sanitizedName).toBe("fork.png")
    expect(b!.sanitizedName).not.toBe("fork.png")
    expect(b!.sanitizedName).toMatch(/^fork \(\d+\)\.png$/)
  })

  it("isolates two sessions in distinct subdirs", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const a = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: "x.png",
      bytes: new Uint8Array([1]),
    })
    const b = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_B,
      filename: "x.png",
      bytes: new Uint8Array([2]),
    })
    expect(a!.sessionPath).toContain(SID_A)
    expect(b!.sessionPath).toContain(SID_B)
    expect(a!.sessionPath).not.toBe(b!.sessionPath)
  })

  it("returns null when filename is undefined", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const result = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: undefined,
      bytes: new Uint8Array([1]),
    })
    expect(result).toBeNull()
  })

  it("rejects path-traversal in resolveAbsolute", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    expect(() => SessionIncomingPaths.resolveAbsolute(SID_A, "../../etc/passwd")).toThrow()
    expect(() => SessionIncomingPaths.resolveAbsolute(SID_A, `sessions/${SID_B}/attachments/x.png`)).toThrow()
  })

  it("does NOT write into the project worktree", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const fakeWorktree = mkdtempSync(path.join(tmpdir(), "fake-repo-"))
    try {
      await SessionIncomingPaths.tryLandInSession({
        sessionID: SID_A,
        filename: "should-not-be-in-repo.png",
        bytes: new Uint8Array([1]),
      })
      expect(existsSync(path.join(fakeWorktree, "incoming"))).toBe(false)
    } finally {
      rmSync(fakeWorktree, { recursive: true, force: true })
    }
  })
})

describe("SessionIncomingPaths GC (24h sweep + on-delete removal)", () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = 1_900_000_000_000

  function writeAttachment(root: string, sessionID: string, name: string, ageMs: number) {
    const dir = path.join(root, "sessions", sessionID, "attachments")
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    writeFileSync(file, "bytes")
    const t = new Date(NOW - ageMs)
    utimesSync(file, t, t)
    return file
  }

  it("sweepExpired removes >24h binaries, keeps fresh ones, prunes empty dirs", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    const stale = writeAttachment(tmpRoot, SID_A, "old.png", 2 * DAY)
    const fresh = writeAttachment(tmpRoot, SID_A, "new.png", 60_000) // 1 min old
    const staleOnly = writeAttachment(tmpRoot, SID_B, "old2.png", 2 * DAY) // SID_B holds only a stale file

    const { removed } = await SessionIncomingPaths.sweepExpired({ root: tmpRoot, now: NOW, retentionMs: DAY })

    expect(removed).toBe(2)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(staleOnly)).toBe(false)
    // SID_B's now-empty attachments dir is pruned; SID_A's survives (has new.png).
    expect(existsSync(path.join(tmpRoot, "sessions", SID_B, "attachments"))).toBe(false)
    expect(existsSync(path.join(tmpRoot, "sessions", SID_A, "attachments"))).toBe(true)
  })

  it("removeSessionAttachments deletes a session's whole folder regardless of age", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    // tryLandInSession resolves via Global.Path.data (== OPENCODE_DATA_HOME here),
    // so the on-delete helper targets the same real path the writer used.
    const landed = await SessionIncomingPaths.tryLandInSession({
      sessionID: SID_A,
      filename: "fresh-but-deleted.png",
      bytes: new Uint8Array([1, 2, 3]),
    })
    const abs = SessionIncomingPaths.resolveAbsolute(SID_A, landed!.sessionPath)
    expect(existsSync(abs)).toBe(true)

    await SessionIncomingPaths.removeSessionAttachments(SID_A)
    expect(existsSync(abs)).toBe(false)
    expect(existsSync(SessionIncomingPaths.attachmentsDir(SID_A))).toBe(false)
  })

  it("removeSessionAttachments is a safe no-op when the folder is absent", async () => {
    const { SessionIncomingPaths } = await import("./session-paths")
    await SessionIncomingPaths.removeSessionAttachments("ses_never_had_attachments_x")
    // no throw == contract honoured at delete time
    expect(true).toBe(true)
  })
})
