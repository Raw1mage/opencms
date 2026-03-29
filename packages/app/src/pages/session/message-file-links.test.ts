import { describe, expect, test } from "bun:test"
import {
  decodeFileLink,
  detectFileReference,
  encodeFileLink,
  linkifyFileReferences,
  resolveFileReferencePath,
} from "./message-file-links"

describe("message-file-links", () => {
  const workspace = "/home/pkcs12/projects/opencode"

  test("detects workspace absolute paths", () => {
    expect(detectFileReference("/home/pkcs12/projects/opencode/packages/app/src/app.tsx:42", workspace)).toEqual({
      original: "/home/pkcs12/projects/opencode/packages/app/src/app.tsx:42",
      path: "/home/pkcs12/projects/opencode/packages/app/src/app.tsx",
      line: 42,
      column: undefined,
    })
    expect(detectFileReference("/etc/passwd", workspace)).toBeUndefined()
  })

  test("detects repo-relative paths conservatively", () => {
    expect(detectFileReference("packages/app/src/app.tsx:7", workspace)).toEqual({
      original: "packages/app/src/app.tsx:7",
      path: "packages/app/src/app.tsx",
      line: 7,
      column: undefined,
    })
    expect(detectFileReference("README.md", workspace)?.path).toBe("README.md")
    expect(detectFileReference("foo:bar", workspace)).toBeUndefined()
  })

  test("detects colon-based line and column suffixes", () => {
    expect(detectFileReference("packages/app/src/app.tsx:7:3", workspace)).toEqual({
      original: "packages/app/src/app.tsx:7:3",
      path: "packages/app/src/app.tsx",
      line: 7,
      column: 3,
    })
  })

  test("encodes and decodes file links", () => {
    const href = encodeFileLink("packages/app/src/app.tsx", 9)
    expect(decodeFileLink(href)).toEqual({ path: "packages/app/src/app.tsx", line: 9, column: undefined })
  })

  test("encodes and decodes file links with columns", () => {
    const href = encodeFileLink("packages/app/src/app.tsx", 9, 4)
    expect(decodeFileLink(href)).toEqual({ path: "packages/app/src/app.tsx", line: 9, column: 4 })
  })

  test("linkifies file references outside code spans", () => {
    const text = "See packages/app/src/app.tsx:7:3 and `/tmp/nope.ts`."
    const result = linkifyFileReferences(text, workspace)
    expect(result).toContain("[packages/app/src/app.tsx:7:3](opencode-file://")
    expect(result).toContain("`/tmp/nope.ts`")
  })

  test("skips fenced code blocks", () => {
    const text = ["```ts", "packages/app/src/app.tsx:7", "```", "docs/readme.md"].join("\n")
    const result = linkifyFileReferences(text, workspace)
    expect(result).toContain("packages/app/src/app.tsx:7")
    expect(result).toContain("[docs/readme.md](opencode-file://")
  })

  test("resolves normalized relative paths", () => {
    expect(resolveFileReferencePath("/home/pkcs12/projects/opencode/packages/app/src/app.tsx", workspace)).toBe(
      "packages/app/src/app.tsx",
    )
    expect(resolveFileReferencePath("packages/app/src/app.tsx", workspace)).toBe("packages/app/src/app.tsx")
  })
})
