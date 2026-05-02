/**
 * tool-hook.test.ts — Phase 4 of /specs/repo-incoming-attachments/.
 *
 * Verifies the maybeBreakIncomingHardLink + maybeAppendToolWriteHistory
 * helpers wired into Edit / Write tools:
 *   - Outside incoming/** : both helpers no-op (no history file created).
 *   - Inside incoming/** at slot root: history journal under the slot's
 *     filename gets a `tool:<name>` entry; hard-linked file detaches.
 *   - Inside incoming/<stem>/ subfolder: history journal under
 *     `<stem>.bundle.jsonl`.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import fsAsync from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { maybeBreakIncomingHardLink, maybeAppendToolWriteHistory } from "../../src/incoming"
import { Instance } from "../../src/project/instance"

let tmpdir: string

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "incoming-hook-test-"))
  fs.mkdirSync(path.join(tmpdir, ".git"), { recursive: true })
  fs.writeFileSync(path.join(tmpdir, ".git", "opencode"), "tool-hook-test-id")
  fs.mkdirSync(path.join(tmpdir, "incoming"), { recursive: true })
})
afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }))

async function inProject<R>(fn: () => Promise<R>): Promise<R> {
  return Instance.provide({ directory: tmpdir, fn })
}

describe("maybeBreakIncomingHardLink", () => {
  test("no-ops outside incoming/", async () => {
    const f = path.join(tmpdir, "elsewhere.txt")
    fs.writeFileSync(f, "x")
    fs.linkSync(f, path.join(tmpdir, "elsewhere2.txt"))
    expect(fs.statSync(f).nlink).toBe(2)
    await inProject(() => maybeBreakIncomingHardLink(f))
    // Still nlink=2 because outside incoming/, not our concern.
    expect(fs.statSync(f).nlink).toBe(2)
  })

  test("detaches hard-link under incoming/<stem>/", async () => {
    const cache = path.join(tmpdir, "cache.txt")
    fs.writeFileSync(cache, "shared")
    fs.mkdirSync(path.join(tmpdir, "incoming", "stemX"), { recursive: true })
    const repo = path.join(tmpdir, "incoming", "stemX", "description.md")
    fs.linkSync(cache, repo)
    expect(fs.statSync(repo).nlink).toBe(2)

    await inProject(() => maybeBreakIncomingHardLink(repo))

    expect(fs.statSync(repo).nlink).toBe(1)
    expect(fs.statSync(cache).nlink).toBe(1)
    expect(fs.statSync(repo).ino).not.toBe(fs.statSync(cache).ino)
  })

  test("no project context → silent no-op", async () => {
    const cache = path.join(tmpdir, "x.txt")
    fs.writeFileSync(cache, "x")
    fs.linkSync(cache, path.join(tmpdir, "y.txt"))
    expect(fs.statSync(cache).nlink).toBe(2)
    // no inProject — Instance.provide not called. project.id === "global".
    await maybeBreakIncomingHardLink(cache)
    expect(fs.statSync(cache).nlink).toBe(2)
  })
})

describe("maybeAppendToolWriteHistory", () => {
  test("no-ops outside incoming/", async () => {
    const f = path.join(tmpdir, "elsewhere.txt")
    fs.writeFileSync(f, "x")
    await inProject(() => maybeAppendToolWriteHistory(f, "Write", "s-1"))
    expect(fs.existsSync(path.join(tmpdir, "incoming", ".history"))).toBe(false)
  })

  test("appends tool:<name> entry for slot-root file", async () => {
    const f = path.join(tmpdir, "incoming", "notes.md")
    fs.writeFileSync(f, "v1")
    await inProject(() => maybeAppendToolWriteHistory(f, "Write", "s-1"))
    const journal = path.join(tmpdir, "incoming", ".history", "notes.md.jsonl")
    expect(fs.existsSync(journal)).toBe(true)
    const lines = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.length).toBe(1)
    expect(lines[0].source).toBe("tool:Write")
    expect(lines[0].sessionId).toBe("s-1")
  })

  test("appends tool:<name> entry for bundle-internal file under <stem>.bundle.jsonl", async () => {
    fs.mkdirSync(path.join(tmpdir, "incoming", "合約"), { recursive: true })
    const f = path.join(tmpdir, "incoming", "合約", "description.md")
    fs.writeFileSync(f, "edited")
    await inProject(() => maybeAppendToolWriteHistory(f, "Edit", "s-2"))
    const journal = path.join(tmpdir, "incoming", ".history", "合約.bundle.jsonl")
    expect(fs.existsSync(journal)).toBe(true)
    const lines = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.length).toBe(1)
    expect(lines[0].source).toBe("tool:Edit")
  })
})
