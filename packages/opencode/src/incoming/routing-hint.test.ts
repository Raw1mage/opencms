import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeManifest, type Manifest } from "./manifest"
import { renderOfficeRoutingHint } from "./routing-hint"

let projectRoot: string
let stemDir: string

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rh-test-"))
  mkdirSync(join(projectRoot, "incoming"), { recursive: true })
  stemDir = join(projectRoot, "incoming", "foo")
  mkdirSync(stemDir, { recursive: true })
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

const manifestOk = (overrides: Partial<Manifest> = {}): Manifest => ({
  schema_version: 1,
  stem: "foo",
  source: {
    filename: "foo.docx",
    mime: DOCX_MIME,
    byte_size: 130_000,
    sha256: "a".repeat(64),
    uploaded_at: "2026-05-03T08:14:22Z",
  },
  decompose: {
    status: "ok",
    duration_ms: 312,
    decomposer: "docxmcp.extract_all",
    background_status: "done",
  },
  files: [
    { path: "body.md", kind: "body", summary: "3,214 paragraphs" },
    { path: "outline.md", kind: "outline", summary: "14 headings, 3 chapters" },
    { path: "chapters/01-introduction.md", kind: "chapter", summary: "chapter 1" },
    { path: "chapters/02-method.md", kind: "chapter", summary: "chapter 2" },
    { path: "chapters/03-results.md", kind: "chapter", summary: "chapter 3" },
    { path: "tables/01.csv", kind: "table", summary: "5 rows × 4 cols" },
    { path: "tables/02.csv", kind: "table", summary: "10 rows" },
    { path: "media/01-figure-a.png", kind: "media", summary: "image/png" },
    { path: "template/template.dotx", kind: "template", summary: "reusable .dotx" },
    { path: "template/styles.xml", kind: "template", summary: "raw style defs" },
  ],
  ...overrides,
})

describe("renderOfficeRoutingHint", () => {
  it("returns null when manifest does not exist", () => {
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })
    expect(hint).toBeNull()
  })

  it("returns null for non-Office mimes", async () => {
    await writeManifest(stemDir, manifestOk())
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: "application/pdf",
      filename: "foo.pdf",
      projectRoot,
    })
    expect(hint).toBeNull()
  })

  it("renders a successful docx hint with all kinds present", async () => {
    await writeManifest(stemDir, manifestOk())
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })
    expect(hint).not.toBeNull()
    expect(hint!).toContain("incoming/foo.docx")
    expect(hint!).toContain("incoming/foo/")
    expect(hint!).toContain("body.md")
    expect(hint!).toContain("outline.md")
    expect(hint!).toContain("chapters/")
    expect(hint!).toContain("tables/")
    expect(hint!).toContain("media/")
    expect(hint!).toContain("template.dotx")
  })

  it("includes the DD-13 pull-refresh contract closing line", async () => {
    await writeManifest(stemDir, manifestOk())
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("動 incoming/<stem>/ 任何檔案前，先 read manifest.json")
    expect(hint).toContain("讀內容直接用一般檔案讀寫工具")
    expect(hint).toContain("要改寫 docx 才呼叫 docxmcp 工具")
  })

  it("folds chapter list when > 4 items per DD-7", async () => {
    const many: Manifest = manifestOk({
      files: [
        { path: "outline.md", kind: "outline", summary: "512 headings, 44 chapters" },
        ...Array.from({ length: 44 }, (_, i) => ({
          path: `chapters/${String(i + 1).padStart(2, "0")}-x.md`,
          kind: "chapter" as const,
          summary: `chapter ${i + 1}`,
        })),
      ],
    })
    await writeManifest(stemDir, many)
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("還有 43") // first + 43 more = 44 total
    expect(hint).toContain("共 44")
    // Should NOT inline all 44 paths
    expect(hint).not.toContain("chapters/44-x.md")
  })

  it("does NOT fold list of 4 or fewer items", async () => {
    const few = manifestOk({
      files: [
        { path: "outline.md", kind: "outline", summary: "..." },
        { path: "chapters/01-a.md", kind: "chapter", summary: "1" },
        { path: "chapters/02-b.md", kind: "chapter", summary: "2" },
        { path: "chapters/03-c.md", kind: "chapter", summary: "3" },
      ],
    })
    await writeManifest(stemDir, few)
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("chapters/01-a.md")
    expect(hint).toContain("chapters/02-b.md")
    expect(hint).toContain("chapters/03-c.md")
    expect(hint).not.toContain("還有")
  })

  it("renders cached-failure with DD-12 prefix and retry instructions", async () => {
    await writeManifest(
      stemDir,
      manifestOk({
        decompose: {
          status: "failed",
          duration_ms: 30000,
          reason: "docxmcp 服務暫時無回應 (timeout 30s)",
          decomposer: "opencode.failure_recorder",
          background_status: "n/a",
        },
        files: [{ path: "failure.md", kind: "failure", summary: "timeout" }],
      }),
    )
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("過去拆解曾失敗")
    expect(hint).toContain("docxmcp 服務暫時無回應")
    expect(hint).toContain("rm -rf incoming/foo")
  })

  it("renders unsupported with convert-to-docx advice", async () => {
    await writeManifest(
      stemDir,
      manifestOk({
        source: {
          ...manifestOk().source,
          filename: "foo.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        decompose: {
          status: "unsupported",
          duration_ms: 0,
          reason: "此格式（xlsx）目前不支援自動拆解；請使用者轉成 .docx 後再上傳",
          decomposer: "opencode.unsupported_writer",
          background_status: "n/a",
        },
        files: [{ path: "unsupported.md", kind: "unsupported", summary: "convert advice" }],
      }),
    )
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "foo.xlsx",
      projectRoot,
    })!
    expect(hint).toContain("此格式目前不支援自動拆解")
    expect(hint).toContain("轉成 .docx")
  })

  it("shows ⏳ background-running banner with pending kinds", async () => {
    await writeManifest(
      stemDir,
      manifestOk({
        decompose: {
          status: "ok",
          duration_ms: 312,
          decomposer: "docxmcp.extract_all",
          background_status: "running",
          pending_kinds: ["body", "chapter", "table", "media"],
        },
      }),
    )
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("⏳")
    expect(hint).toContain("背景拆解中")
    expect(hint).toContain("body")
    expect(hint).toContain("chapter")
    expect(hint).toContain("extract_all_collect")
  })

  it("shows ⚠️ banner when background failed", async () => {
    await writeManifest(
      stemDir,
      manifestOk({
        decompose: {
          status: "ok",
          duration_ms: 312,
          decomposer: "docxmcp.extract_all",
          background_status: "failed",
          background_error: "container restart killed background phase",
          background_duration_ms: 8000,
        },
      }),
    )
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).toContain("⚠️")
    expect(hint).toContain("背景拆解失敗")
    expect(hint).toContain("container restart killed background phase")
  })

  it("never inlines body content (DD-7 map-not-content)", async () => {
    const sneaky = manifestOk({
      files: [
        {
          path: "body.md",
          kind: "body",
          // summary that contains content-like text — should NOT appear verbatim
          summary: "3,214 paragraphs",
        },
      ],
    })
    await writeManifest(stemDir, sneaky)
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    // The hint mentions the body.md filename + summary string but
    // does not embed actual body text.
    expect(hint).toContain("body.md")
    expect(hint).not.toMatch(/\n.{200,}/) // no long content blocks
  })

  it("excludes _PENDING.md marker files from rendered hint", async () => {
    const withMarkers = manifestOk({
      files: [
        ...manifestOk().files,
        { path: "chapters/_PENDING.md", kind: "pending_marker", summary: "extraction in progress" },
        { path: "tables/_PENDING.md", kind: "pending_marker", summary: "extraction in progress" },
      ],
    })
    await writeManifest(stemDir, withMarkers)
    const hint = renderOfficeRoutingHint({
      repoPath: "incoming/foo.docx",
      mime: DOCX_MIME,
      filename: "foo.docx",
      projectRoot,
    })!
    expect(hint).not.toContain("_PENDING.md")
  })
})
