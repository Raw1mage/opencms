import { describe, expect, it } from "bun:test"
import {
  classifyOffice,
  decomposerForKind,
  isAnyOffice,
  isLegacyOle2,
  isModernOffice,
} from "./office-mime"

describe("classifyOffice", () => {
  it("classifies modern Office mimes", () => {
    expect(
      classifyOffice("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx"),
    ).toBe("docx")
    expect(
      classifyOffice("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x.xlsx"),
    ).toBe("xlsx")
    expect(
      classifyOffice("application/vnd.openxmlformats-officedocument.presentationml.presentation", "x.pptx"),
    ).toBe("pptx")
  })

  it("classifies legacy OLE2 Office mimes", () => {
    expect(classifyOffice("application/msword", "x.doc")).toBe("doc")
    expect(classifyOffice("application/vnd.ms-excel", "x.xls")).toBe("xls")
    expect(classifyOffice("application/vnd.ms-powerpoint", "x.ppt")).toBe("ppt")
  })

  it("falls back to filename extension when mime is generic", () => {
    expect(classifyOffice("application/octet-stream", "report.docx")).toBe("docx")
    expect(classifyOffice(undefined, "old.doc")).toBe("doc")
    expect(classifyOffice("", "sheet.XLSX")).toBe("xlsx") // case-insensitive ext
  })

  it("returns non-office for unknown mime + unknown extension", () => {
    expect(classifyOffice("text/plain", "notes.txt")).toBe("non-office")
    expect(classifyOffice("image/png", "shot.png")).toBe("non-office")
    expect(classifyOffice(undefined, undefined)).toBe("non-office")
    expect(classifyOffice("application/octet-stream", undefined)).toBe("non-office")
  })

  it("handles filenames without extension", () => {
    expect(classifyOffice("application/octet-stream", "noext")).toBe("non-office")
    expect(classifyOffice("application/octet-stream", ".hidden")).toBe("non-office")
  })
})

describe("isModernOffice / isLegacyOle2 / isAnyOffice", () => {
  it("partitions kinds correctly", () => {
    expect(isModernOffice("docx")).toBe(true)
    expect(isModernOffice("xlsx")).toBe(true)
    expect(isModernOffice("pptx")).toBe(true)
    expect(isModernOffice("doc")).toBe(false)
    expect(isModernOffice("non-office")).toBe(false)

    expect(isLegacyOle2("doc")).toBe(true)
    expect(isLegacyOle2("xls")).toBe(true)
    expect(isLegacyOle2("ppt")).toBe(true)
    expect(isLegacyOle2("docx")).toBe(false)

    expect(isAnyOffice("docx")).toBe(true)
    expect(isAnyOffice("doc")).toBe(true)
    expect(isAnyOffice("non-office")).toBe(false)
  })
})

describe("decomposerForKind", () => {
  it("routes each kind to the right decomposer", () => {
    expect(decomposerForKind("docx")).toBe("docxmcp.extract_all")
    expect(decomposerForKind("doc")).toBe("opencode.legacy_ole2_scanner")
    expect(decomposerForKind("xls")).toBe("opencode.legacy_ole2_scanner")
    expect(decomposerForKind("ppt")).toBe("opencode.legacy_ole2_scanner")
    expect(decomposerForKind("xlsx")).toBe("opencode.unsupported_writer")
    expect(decomposerForKind("pptx")).toBe("opencode.unsupported_writer")
    expect(decomposerForKind("non-office")).toBeNull()
  })
})
