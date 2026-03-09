import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { buildCanonicalDirectoryHref } from "./directory-layout-path"

describe("directory layout canonical href", () => {
  test("rewrites nested directory route to resolved canonical path", () => {
    const next = buildCanonicalDirectoryHref({
      pathname: `/${base64Encode("/alias")}/session/abc`,
      dirParam: base64Encode("/alias"),
      resolvedDirectory: "/real/path",
      search: "?tab=files",
      hash: "#pane",
    })

    expect(next).toBe(`/${base64Encode("/real/path")}/session/abc?tab=files#pane`)
  })

  test("rewrites top-level directory route", () => {
    const next = buildCanonicalDirectoryHref({
      pathname: `/${base64Encode("/alias")}`,
      dirParam: base64Encode("/alias"),
      resolvedDirectory: "/real/path",
    })

    expect(next).toBe(`/${base64Encode("/real/path")}`)
  })

  test("ignores unrelated path prefixes", () => {
    const next = buildCanonicalDirectoryHref({
      pathname: "/settings",
      dirParam: base64Encode("/alias"),
      resolvedDirectory: "/real/path",
    })

    expect(next).toBeUndefined()
  })
})
