import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  buildActiveImageContentBlocks,
  buildPreface,
  type InlineImageContentBlock,
  type InlineImageRefInput,
} from "./context-preface"

const baseInput = {
  preload: { readmeSummary: "README", cwdListing: "fileA" },
  skills: { pinned: [], active: [], summarized: [] },
  todaysDate: "Sun May 04 2026",
}

let projectRoot: string

beforeAll(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), "preface-image-test-"))
})

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function writeImage(repoPath: string, payload: string): void {
  const abs = path.join(projectRoot, repoPath)
  const dir = path.dirname(abs)
  // mkdtemp + recursive write
  const fs = require("node:fs") as typeof import("node:fs")
  fs.mkdirSync(dir, { recursive: true })
  writeFileSync(abs, payload)
}

function ref(filename: string, repoRel: string, mime = "image/png"): [string, InlineImageRefInput] {
  return [filename, { filename, mime, absPath: path.join(projectRoot, repoRel) }]
}

describe("buildActiveImageContentBlocks (v4 DD-19/DD-20)", () => {
  it("returns empty array when activeImageRefs empty", async () => {
    const out = await buildActiveImageContentBlocks([], new Map())
    expect(out).toEqual([])
  })

  it("emits one block per active filename with data URI", async () => {
    writeImage("incoming/a.png", "AAA")
    const refs = new Map<string, InlineImageRefInput>([ref("a.png", "incoming/a.png")])
    const out = await buildActiveImageContentBlocks(["a.png"], refs)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("file")
    expect(out[0].tier).toBe("trailing")
    expect(out[0].mediaType).toBe("image/png")
    expect(out[0].filename).toBe("a.png")
    expect(out[0].url.startsWith("data:image/png;base64,")).toBe(true)
    expect(out[0].url).toContain(Buffer.from("AAA").toString("base64"))
  })

  it("preserves activeImageRefs order", async () => {
    writeImage("incoming/a.png", "A")
    writeImage("incoming/b.jpg", "B")
    const refs = new Map<string, InlineImageRefInput>([
      ref("a.png", "incoming/a.png"),
      ref("b.jpg", "incoming/b.jpg", "image/jpeg"),
    ])
    const out = await buildActiveImageContentBlocks(["b.jpg", "a.png"], refs)
    expect(out.map((b) => b.filename)).toEqual(["b.jpg", "a.png"])
  })

  it("skips filenames missing from refsByFilename", async () => {
    const out = await buildActiveImageContentBlocks(["ghost.png"], new Map())
    expect(out).toEqual([])
  })

  it("skips files missing from disk without throwing", async () => {
    const refs = new Map<string, InlineImageRefInput>([ref("vanished.png", "incoming/vanished.png")])
    const out = await buildActiveImageContentBlocks(["vanished.png"], refs)
    expect(out).toEqual([])
  })

  it("skips refs with non-image mime", async () => {
    const refs = new Map<string, InlineImageRefInput>([ref("doc.pdf", "incoming/doc.pdf", "application/pdf")])
    const out = await buildActiveImageContentBlocks(["doc.pdf"], refs)
    expect(out).toEqual([])
  })

  it("works with session-scoped absPath (storage-agnostic)", async () => {
    // Helper accepts any pre-resolved absPath — repo or session-scoped.
    writeImage("session-scoped/img.png", "SESS")
    const refs = new Map<string, InlineImageRefInput>([
      ["img.png", { filename: "img.png", mime: "image/png", absPath: path.join(projectRoot, "session-scoped/img.png") }],
    ])
    const out = await buildActiveImageContentBlocks(["img.png"], refs)
    expect(out).toHaveLength(1)
    expect(out[0].url).toContain(Buffer.from("SESS").toString("base64"))
  })

  it("is byte-deterministic for the same filesystem state", async () => {
    writeImage("incoming/det.png", "DET")
    const refs = new Map<string, InlineImageRefInput>([ref("det.png", "incoming/det.png")])
    const a = await buildActiveImageContentBlocks(["det.png"], refs)
    const b = await buildActiveImageContentBlocks(["det.png"], refs)
    expect(a).toEqual(b)
  })
})

describe("buildPreface — activeImageBlocks placement (v4 DD-19)", () => {
  it("emits image blocks as the LAST entries after trailing text", () => {
    const imageBlock: InlineImageContentBlock = {
      type: "file",
      tier: "trailing",
      url: "data:image/png;base64,XYZ",
      mediaType: "image/png",
      filename: "x.png",
    }
    const out = buildPreface({
      ...baseInput,
      trailingExtras: ["lazy catalog hint"],
      activeImageBlocks: [imageBlock],
    })
    const lastBlock = out.contentBlocks[out.contentBlocks.length - 1]
    expect(lastBlock).toEqual(imageBlock)
    // trailing text block should still come BEFORE the image
    const trailingTextIdx = out.contentBlocks.findIndex((b) => b.type === "text" && b.tier === "trailing")
    const fileIdx = out.contentBlocks.findIndex((b) => b.type === "file")
    expect(trailingTextIdx).toBeGreaterThan(-1)
    expect(fileIdx).toBeGreaterThan(trailingTextIdx)
  })

  it("skips image blocks when activeImageBlocks is empty/undefined", () => {
    const out = buildPreface(baseInput)
    expect(out.contentBlocks.some((b) => b.type === "file")).toBe(false)
  })
})
