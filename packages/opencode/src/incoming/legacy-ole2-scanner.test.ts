import { describe, expect, it } from "bun:test"
import { applyDensityFilter, renderBody } from "./legacy-ole2-scanner"

describe("renderBody (two-pass scanner)", () => {
  it("preserves CR/LF/tab as structural newlines, not run terminators", () => {
    const bytes = Buffer.from("Hello\nWorld\tTabbed\r\nCRLF")
    const out = renderBody(bytes, 0)
    expect(out).toContain("Hello")
    expect(out).toContain("World")
    expect(out).toContain("Tabbed")
    expect(out).toContain("CRLF")
    // newlines preserved
    expect(out.split("\n").length).toBeGreaterThan(2)
    // tab preserved as tab character
    expect(out).toContain("World\tTabbed")
  })

  it("preserves leading whitespace within a line", () => {
    const bytes = Buffer.from("Title\n    Indented body\n        deeper\n")
    const out = renderBody(bytes, 0)
    const lines = out.split("\n")
    expect(lines.some((l) => l.startsWith("    Indented"))).toBe(true)
    expect(lines.some((l) => l.startsWith("        deeper"))).toBe(true)
  })

  it("collapses runs of binary noise to at most one newline", () => {
    // ASCII text + binary garbage between → soft separator, not 100 newlines
    const noise = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
    const bytes = Buffer.concat([Buffer.from("First"), noise, noise, noise, Buffer.from("Second")])
    const out = renderBody(bytes, 0)
    expect(out).toContain("First")
    expect(out).toContain("Second")
    // Should not have a flood of empty lines from binary noise
    expect(out.match(/\n{3,}/g)).toBeNull()
  })

  it("prefers UTF-16LE pass when its output is significantly larger (CJK case)", () => {
    // Encode CJK as UTF-16LE — ASCII pass produces nothing useful.
    const cjk = "繁體中文段落內容"
    const cjkUtf16 = Buffer.alloc(cjk.length * 2)
    for (let i = 0; i < cjk.length; i++) {
      const cp = cjk.charCodeAt(i)
      cjkUtf16[i * 2] = cp & 0xff
      cjkUtf16[i * 2 + 1] = (cp >> 8) & 0xff
    }
    const out = renderBody(cjkUtf16, 0)
    expect(out).toContain("繁體中文段落內容")
  })

  it("returns empty when both passes produce nothing useful", () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x00])
    const out = renderBody(bytes, 0)
    expect(out.trim()).toBe("")
  })
})

describe("applyDensityFilter", () => {
  it("keeps lines whose printable ratio meets the threshold", () => {
    const text = ["High density text line", "    ", "another full line"].join("\n")
    const out = applyDensityFilter(text, 0.4)
    expect(out).toContain("High density text line")
    expect(out).toContain("another full line")
  })

  it("preserves empty lines (paragraph structure)", () => {
    const text = ["line1", "", "line2"].join("\n")
    const out = applyDensityFilter(text, 0.4)
    expect(out).toBe(text)
  })

  it("drops sparse / whitespace-heavy noise lines", () => {
    const sparse = "          x          " // mostly whitespace, density well below 0.4
    const text = ["solid content here", sparse, "more solid content"].join("\n")
    const out = applyDensityFilter(text, 0.4)
    expect(out).toContain("solid content here")
    expect(out).toContain("more solid content")
    expect(out).not.toContain(sparse)
  })

  it("returns input unchanged when threshold <= 0", () => {
    const text = "anything\n   sparse\nx"
    expect(applyDensityFilter(text, 0)).toBe(text)
    expect(applyDensityFilter(text, -1)).toBe(text)
  })
})

describe("layout preservation acceptance (AC-10 sanity)", () => {
  it("preserves at least 90% of newlines + 80% of leading-whitespace lines from a synthetic fixture", () => {
    const fixtureLines = [
      "Chapter 1",
      "  Introduction paragraph one.",
      "  Continued paragraph one with more text.",
      "",
      "  1.1 Section heading",
      "    Detail line A.",
      "    Detail line B.",
      "",
      "Chapter 2",
      "  Different content here.",
    ]
    const expectedNewlines = fixtureLines.length - 1
    const expectedLeadingWs = fixtureLines.filter((l) => /^\s+\S/.test(l)).length
    const fixture = Buffer.from(fixtureLines.join("\n"))

    const out = renderBody(fixture, 0)
    const outLines = out.split("\n")
    const outNewlines = outLines.length - 1
    const outLeadingWs = outLines.filter((l) => /^\s+\S/.test(l)).length

    expect(outNewlines / expectedNewlines).toBeGreaterThanOrEqual(0.9)
    expect(outLeadingWs / expectedLeadingWs).toBeGreaterThanOrEqual(0.8)
  })
})
