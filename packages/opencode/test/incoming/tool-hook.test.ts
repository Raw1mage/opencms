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

describe("maybeBreakIncomingHardLink — no-op after http-transport cutover", () => {
  // /specs/docxmcp-http-transport phase 6 retired the bind-mount cache;
  // hard-link detection isn't applicable any more. Helper kept as a
  // no-op so call sites compile. These tests verify the helper does
  // not throw and does not modify the filesystem.
  test("no-op when called with any path", async () => {
    const f = path.join(tmpdir, "anything.txt")
    fs.writeFileSync(f, "x")
    fs.linkSync(f, path.join(tmpdir, "buddy.txt"))
    const inoBefore = fs.statSync(f).ino
    const nlinkBefore = fs.statSync(f).nlink
    await inProject(() => maybeBreakIncomingHardLink(f))
    expect(fs.statSync(f).ino).toBe(inoBefore)
    expect(fs.statSync(f).nlink).toBe(nlinkBefore)
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
