import { describe, expect, test } from "bun:test"
import { linkifyFileReferences } from "./file-path-link"

describe("ui file-path-link", () => {
  const workspace = "/home/pkcs12/projects/opencode"

  test("does not linkify inline shell commands ending in file paths", () => {
    const text = "- `bun --check packages/mcp/system-manager/src/index.ts` passed"
    const result = linkifyFileReferences(text, workspace)

    expect(result).toBe(text)
  })

  test("still linkifies standalone inline file references", () => {
    const text = "See `packages/mcp/system-manager/src/index.ts`."
    const result = linkifyFileReferences(text, workspace)

    expect(result).toContain("[`packages/mcp/system-manager/src/index.ts`](opencode-file://")
  })
})
