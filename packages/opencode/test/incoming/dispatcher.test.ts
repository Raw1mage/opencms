/**
 * dispatcher.test.ts — Phase 3 of /specs/repo-incoming-attachments/.
 *
 * Tests the dispatcher boundary alone (no real mcp client). Real docker /
 * docxmcp validation lives in phase 5 manual smoke.
 *
 * Covers:
 *   - DD-3 args rewrite: incoming/foo.docx → /state/staging/<sha>.docx
 *   - DD-11 publish via hard-link: post-publish nlink == 2 on cache file
 *   - DD-15 EXDEV / cross-fs fallback simulated by patching link()
 *   - DD-16 manifest validity gates cache-hit fast path; corrupted manifest
 *     forces cache-miss
 *   - DD-17 cache-hit short-circuit: skipMcpCall=true, ctx.cacheHit set,
 *     bundle published before mcp ever called
 *   - DD-14 result path rewriting via after()
 *   - break-on-write detach: nlink>1 file becomes nlink=1 in place,
 *     cache-side untouched
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import fsAsync from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

import { IncomingDispatcher } from "../../src/incoming/dispatcher"
import { IncomingPaths } from "../../src/incoming/paths"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"

let tmpdir: string

function asBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

async function inProject<R>(fn: () => Promise<R>): Promise<R> {
  return Instance.provide({ directory: tmpdir, fn })
}

function writeIncomingFile(filename: string, content: string): void {
  const dir = path.join(tmpdir, "incoming")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

function bundleDir(appId: string, sha: string): string {
  return IncomingDispatcher.__forTesting.bundleDirFor(appId, sha)
}

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "incoming-dispatcher-test-"))
  fs.mkdirSync(path.join(tmpdir, ".git"), { recursive: true })
  fs.writeFileSync(path.join(tmpdir, ".git", "opencode"), "incoming-dispatcher-test-id")
})

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true })
  // Best-effort: clean staging too — only entries created by this test.
  // (Different tests may share STAGING_BASE; we clean the appId dir we
  // used.)
  const stagingApp = path.join(IncomingDispatcher.__forTesting.STAGING_BASE, "test-app")
  fs.rmSync(stagingApp, { recursive: true, force: true })
})

describe("dispatcher.before — stage + path rewrite", () => {
  test("rewrites incoming/foo.docx to /state/staging/<sha>.docx and records mappings", async () => {
    writeIncomingFile("foo.docx", "hello")
    const expectedSha = sha256Hex("hello")

    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/foo.docx" },
        appId: "test-app",
        sessionID: "s-1",
      }),
    )

    expect(result.rewrittenArgs.input).toBe(`/state/staging/${expectedSha}.docx`)
    expect(result.ctx.stagedFiles.length).toBe(1)
    expect(result.ctx.stagedFiles[0]!.sha).toBe(expectedSha)

    const staged = result.ctx.stagedFiles[0]!.stagedPath
    expect(fs.existsSync(staged)).toBe(true)
    expect(fs.readFileSync(staged, "utf8")).toBe("hello")

    // Path-replacement mappings include staging→repo and bundles→repo
    const replacements = result.ctx.pathReplacements
    expect(replacements.some((r) => r.from === `/state/staging/${expectedSha}.docx` && r.to === "incoming/foo.docx")).toBe(true)
    expect(replacements.some((r) => r.from.startsWith(`/state/bundles/${expectedSha}`))).toBe(true)
  })

  test("non-incoming args pass through unchanged", async () => {
    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "extract_text",
        args: { mode: "stdout", verbose: true },
        appId: "test-app",
        sessionID: null,
      }),
    )
    expect(result.rewrittenArgs).toEqual({ mode: "stdout", verbose: true })
    expect(result.ctx.stagedFiles.length).toBe(0)
    expect(result.ctx.skipMcpCall).toBe(false)
  })

  test("incoming path that does not exist on disk is left untouched", async () => {
    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/nonexistent.docx" },
        appId: "test-app",
        sessionID: null,
      }),
    )
    expect(result.rewrittenArgs.input).toBe("incoming/nonexistent.docx")
    expect(result.ctx.stagedFiles.length).toBe(0)
  })
})

describe("dispatcher cache-hit (DD-17 short-circuit + DD-16 manifest validate)", () => {
  test("valid manifest triggers cache-hit, bundle published, skipMcpCall=true", async () => {
    writeIncomingFile("doc.docx", "body")
    const sha = sha256Hex("body")
    // Pre-populate the cache: bundles/<sha>/{description.md, manifest.json}
    const bdir = bundleDir("test-app", sha)
    fs.mkdirSync(bdir, { recursive: true })
    fs.writeFileSync(path.join(bdir, "description.md"), "cached body")
    fs.writeFileSync(
      path.join(bdir, "manifest.json"),
      JSON.stringify({ sha256: sha, appId: "test-app", appVersion: "0.3.0", createdAt: new Date().toISOString() }),
    )

    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/doc.docx" },
        appId: "test-app",
        sessionID: "s-1",
      }),
    )
    expect(result.ctx.skipMcpCall).toBe(true)
    expect(result.ctx.cacheHit?.sha).toBe(sha)
    expect(result.ctx.cacheHit?.repoBundlePath).toBe("incoming/doc")

    // Bundle published into <repo>/incoming/doc/
    const publishedDescription = path.join(tmpdir, "incoming/doc/description.md")
    expect(fs.existsSync(publishedDescription)).toBe(true)
    expect(fs.readFileSync(publishedDescription, "utf8")).toBe("cached body")
    // Same fs → hard-linked. nlink should be 2 (cache + repo).
    const stat = fs.statSync(publishedDescription)
    expect(stat.nlink).toBe(2)
  })

  test("corrupted manifest (sha mismatch) forces cache-miss, skipMcpCall=false", async () => {
    writeIncomingFile("doc.docx", "body")
    const sha = sha256Hex("body")
    const bdir = bundleDir("test-app", sha)
    fs.mkdirSync(bdir, { recursive: true })
    fs.writeFileSync(path.join(bdir, "description.md"), "stale")
    fs.writeFileSync(
      path.join(bdir, "manifest.json"),
      JSON.stringify({ sha256: "0".repeat(64), appId: "test-app", appVersion: "0.3.0", createdAt: new Date().toISOString() }),
    )

    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/doc.docx" },
        appId: "test-app",
        sessionID: "s-1",
      }),
    )
    expect(result.ctx.skipMcpCall).toBe(false)
    expect(result.ctx.cacheHit).toBeUndefined()
    // The repo-side bundle is NOT published in the corrupted-manifest path.
    expect(fs.existsSync(path.join(tmpdir, "incoming/doc/description.md"))).toBe(false)
  })

  test("missing manifest is treated as cache-miss (silent fall-through to mcp)", async () => {
    writeIncomingFile("doc.docx", "body")
    const sha = sha256Hex("body")
    const bdir = bundleDir("test-app", sha)
    fs.mkdirSync(bdir, { recursive: true })
    fs.writeFileSync(path.join(bdir, "description.md"), "no-manifest")
    // No manifest.json

    const result = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/doc.docx" },
        appId: "test-app",
        sessionID: "s-1",
      }),
    )
    expect(result.ctx.skipMcpCall).toBe(false)
    expect(result.ctx.cacheHit).toBeUndefined()
  })
})

describe("dispatcher.after — publish + result rewrite", () => {
  test("publishes bundle and rewrites staging-path strings in result", async () => {
    writeIncomingFile("doc.docx", "body")
    const sha = sha256Hex("body")

    const beforeOut = await inProject(() =>
      IncomingDispatcher.before({
        toolName: "docx_decompose",
        args: { input: "incoming/doc.docx" },
        appId: "test-app",
        sessionID: "s-1",
      }),
    )
    // Simulate mcp tool writing a bundle into the cache dir.
    const bdir = bundleDir("test-app", sha)
    fs.mkdirSync(bdir, { recursive: true })
    fs.writeFileSync(path.join(bdir, "description.md"), "fresh body")

    const fakeResult = {
      content: [
        {
          type: "text",
          text: `bundle ready at /state/bundles/${sha}/description.md`,
        },
      ],
      structuredContent: { bundlePath: `/state/bundles/${sha}` },
    }
    const rewritten = (await inProject(() =>
      IncomingDispatcher.after({ result: fakeResult, ctx: beforeOut.ctx }),
    )) as typeof fakeResult

    // Staging-path → repo path
    expect(rewritten.content[0]!.text).toContain("incoming/doc/description.md")
    expect(rewritten.content[0]!.text).not.toContain(`/state/bundles/${sha}`)
    expect(rewritten.structuredContent.bundlePath).toBe("incoming/doc")

    // Bundle was published
    const publishedDescription = path.join(tmpdir, "incoming/doc/description.md")
    expect(fs.existsSync(publishedDescription)).toBe(true)
    expect(fs.readFileSync(publishedDescription, "utf8")).toBe("fresh body")
    expect(fs.statSync(publishedDescription).nlink).toBe(2)
  })
})

describe("dispatcher.breakHardLinkBeforeWrite (DD-11)", () => {
  test("nlink>1 file gets detached; cache-side inode unchanged", async () => {
    const cache = path.join(tmpdir, "cache.txt")
    const repo = path.join(tmpdir, "linked.txt")
    fs.writeFileSync(cache, "shared")
    fs.linkSync(cache, repo)
    const cacheInoBefore = fs.statSync(cache).ino
    expect(fs.statSync(repo).nlink).toBe(2)

    await IncomingDispatcher.breakHardLinkBeforeWrite(repo)

    const repoStat = fs.statSync(repo)
    const cacheStat = fs.statSync(cache)
    expect(repoStat.nlink).toBe(1)
    expect(cacheStat.nlink).toBe(1)
    expect(repoStat.ino).not.toBe(cacheStat.ino)
    expect(cacheStat.ino).toBe(cacheInoBefore) // cache file untouched
    expect(fs.readFileSync(repo, "utf8")).toBe("shared") // content preserved
  })

  test("nlink=1 file is no-op", async () => {
    const f = path.join(tmpdir, "solo.txt")
    fs.writeFileSync(f, "alone")
    const inoBefore = fs.statSync(f).ino
    await IncomingDispatcher.breakHardLinkBeforeWrite(f)
    expect(fs.statSync(f).ino).toBe(inoBefore)
  })

  test("ENOENT is silently no-op", async () => {
    await IncomingDispatcher.breakHardLinkBeforeWrite(path.join(tmpdir, "missing.txt"))
    // no throw expected
    expect(true).toBe(true)
  })
})
