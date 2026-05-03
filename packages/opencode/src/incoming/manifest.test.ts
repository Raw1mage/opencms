import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupCache, validateManifest, writeManifest, readManifest, type Manifest } from "./manifest"

let dir: string
let stemDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manifest-test-"))
  stemDir = join(dir, "foo")
  mkdirSync(stemDir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sample = (overrides: Partial<Manifest> = {}): Manifest => ({
  schema_version: 1,
  stem: "foo",
  source: {
    filename: "foo.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byte_size: 1234,
    sha256: "a".repeat(64),
    uploaded_at: "2026-05-03T08:14:22Z",
  },
  decompose: {
    status: "ok",
    duration_ms: 42,
    decomposer: "docxmcp.extract_all",
    background_status: "done",
  },
  files: [{ path: "body.md", kind: "body", summary: "1 line" }],
  ...overrides,
})

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(sample())).toEqual([])
  })

  it("rejects bad schema_version", () => {
    const issues = validateManifest({ ...sample(), schema_version: 99 } as unknown)
    expect(issues).toContain("schema_version must be 1")
  })

  it("requires reason when status is failed or unsupported", () => {
    const issues = validateManifest(
      sample({
        decompose: {
          status: "failed",
          duration_ms: 30000,
          decomposer: "opencode.failure_recorder",
          background_status: "n/a",
        },
      }),
    )
    expect(issues).toContain("decompose.reason required when status != ok")
  })

  it("requires pending_kinds when background_status is running", () => {
    const issues = validateManifest(
      sample({
        decompose: {
          status: "ok",
          duration_ms: 10000,
          decomposer: "docxmcp.extract_all",
          background_status: "running",
        },
      }),
    )
    expect(issues).toContain("decompose.pending_kinds required when background_status == running")
  })

  it("requires background_error when background_status is failed", () => {
    const issues = validateManifest(
      sample({
        decompose: {
          status: "ok",
          duration_ms: 1000,
          decomposer: "docxmcp.extract_all",
          background_status: "failed",
        },
      }),
    )
    expect(issues).toContain("decompose.background_error required when background_status == failed")
  })

  it("rejects bad sha256 format", () => {
    const issues = validateManifest(sample({ source: { ...sample().source, sha256: "short" } }))
    expect(issues).toContain("source.sha256 must be 64-hex")
  })

  it("rejects non-objects", () => {
    expect(validateManifest(null)).toContain("not an object")
    expect(validateManifest(42)).toContain("not an object")
  })
})

describe("writeManifest + readManifest round-trip", () => {
  it("writes atomically and reads back identical content", async () => {
    const m = sample()
    await writeManifest(stemDir, m)
    const back = await readManifest(stemDir)
    expect(back).toEqual(m)
  })

  it("returns null when manifest is missing", async () => {
    expect(await readManifest(stemDir)).toBeNull()
  })

  it("returns null when manifest is unparseable JSON", async () => {
    writeFileSync(join(stemDir, "manifest.json"), "{not json")
    expect(await readManifest(stemDir)).toBeNull()
  })

  it("returns null when manifest fails schema validation", async () => {
    writeFileSync(
      join(stemDir, "manifest.json"),
      JSON.stringify({ schema_version: 99 }),
    )
    expect(await readManifest(stemDir)).toBeNull()
  })
})

describe("lookupCache", () => {
  it("returns 'fresh' when no prior manifest exists", async () => {
    rmSync(stemDir, { recursive: true })
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "b".repeat(64),
      newFilename: "foo.docx",
    })
    expect(r.verdict).toBe("fresh")
  })

  it("returns 'hit' when sha + filename both match", async () => {
    await writeManifest(stemDir, sample())
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "a".repeat(64),
      newFilename: "foo.docx",
    })
    expect(r.verdict).toBe("hit")
    expect(r.cached?.stem).toBe("foo")
  })

  it("returns 'hit' even when prior decompose.status is failed (DD-12)", async () => {
    await writeManifest(
      stemDir,
      sample({
        decompose: {
          status: "failed",
          duration_ms: 30000,
          reason: "docxmcp 服務暫時無回應 (timeout 30s)",
          decomposer: "opencode.failure_recorder",
          background_status: "n/a",
        },
      }),
    )
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "a".repeat(64),
      newFilename: "foo.docx",
    })
    expect(r.verdict).toBe("hit")
    expect(r.cached?.decompose.status).toBe("failed")
  })

  it("returns 'regen' with priorUploadedAt when sha mismatches", async () => {
    await writeManifest(stemDir, sample())
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "b".repeat(64),
      newFilename: "foo.docx",
    })
    expect(r.verdict).toBe("regen")
    expect(r.priorUploadedAt).toBe("2026-05-03T08:14:22Z")
    expect(r.staleRunning).toBeFalsy()
  })

  it("returns 'regen' with staleRunning=true when prior is running and older than max age (DD-14)", async () => {
    const oldUploadedAt = "2026-05-03T08:14:22Z"
    await writeManifest(
      stemDir,
      sample({
        source: { ...sample().source, uploaded_at: oldUploadedAt },
        decompose: {
          status: "ok",
          duration_ms: 5000,
          decomposer: "docxmcp.extract_all",
          background_status: "running",
          pending_kinds: ["body", "chapter", "table", "media"],
        },
      }),
    )
    const farFuture = Date.parse(oldUploadedAt) + 700_000 // > 600 s default
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "a".repeat(64),
      newFilename: "foo.docx",
      now: farFuture,
    })
    expect(r.verdict).toBe("regen")
    expect(r.staleRunning).toBe(true)
    expect(r.priorUploadedAt).toBe(oldUploadedAt)
  })

  it("still returns 'hit' when prior is running but within max age window", async () => {
    const oldUploadedAt = "2026-05-03T08:14:22Z"
    await writeManifest(
      stemDir,
      sample({
        source: { ...sample().source, uploaded_at: oldUploadedAt },
        decompose: {
          status: "ok",
          duration_ms: 5000,
          decomposer: "docxmcp.extract_all",
          background_status: "running",
          pending_kinds: ["body", "chapter"],
        },
      }),
    )
    const nearFuture = Date.parse(oldUploadedAt) + 60_000 // within 600 s
    const r = await lookupCache({
      stemDirAbs: stemDir,
      newSha256: "a".repeat(64),
      newFilename: "foo.docx",
      now: nearFuture,
    })
    expect(r.verdict).toBe("hit")
  })
})
