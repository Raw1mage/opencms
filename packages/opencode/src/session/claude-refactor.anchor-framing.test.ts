import { describe, expect, it } from "bun:test"
import { sanitizeAnchorToString, unwrapPriorContext } from "./anchor-sanitizer"

const BODY = "## Round 1\n\n**User**\n\ndo the thing\n\n**Assistant**\n\nworking on it"

describe("anchor supersede framing (DD-9/DD-16, claude-gated)", () => {
  it("INV-0: no opts => byte-identical to the legacy <prior_context source> wrapper", () => {
    const { body } = sanitizeAnchorToString(BODY, "narrative")
    expect(body).toBe(`<prior_context source="narrative">\n${BODY}\n</prior_context>`)
  })

  it("claudeSupersede => frames as EARLIER + recent supersedes", () => {
    const { body } = sanitizeAnchorToString(BODY, "narrative", { claudeSupersede: true })
    expect(body).toContain("EARLIER portion")
    expect(body).toContain("more recent and authoritative")
    expect(body).toContain('superseded_by_recent="true"')
    // content preserved
    expect(body).toContain("do the thing")
  })

  it("claudeSupersede with coversUpTo => emits the cutoff marker", () => {
    const { body } = sanitizeAnchorToString(BODY, "narrative", {
      claudeSupersede: true,
      coversUpTo: "msg_e75e83843",
    })
    expect(body).toContain('covers_up_to="msg_e75e83843"')
    expect(body).toContain("up to msg_e75e83843")
  })

  it("framed body still round-trips through unwrapPriorContext (content recoverable)", () => {
    const { body } = sanitizeAnchorToString(BODY, "narrative", {
      claudeSupersede: true,
      coversUpTo: "msg_x",
    })
    const inner = unwrapPriorContext(body)
    expect(inner).toContain("do the thing")
    expect(inner).not.toContain("<prior_context")
  })
})
