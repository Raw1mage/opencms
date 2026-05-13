import { sanitizeAnchor, sanitizeAnchorToString, unwrapPriorContext, type AnchorKind } from "./anchor-sanitizer"

describe("anchor sanitizer (DD-6)", () => {
  describe("wrapping", () => {
    it.each<AnchorKind>(["narrative", "replay-tail", "ai_free", "ai_paid"])(
      'wraps body in <prior_context source="%s">',
      (kind) => {
        const out = sanitizeAnchor("hello world", kind)
        expect(out.wrapperOpen).toBe(`<prior_context source="${kind}">`)
        expect(out.wrapperClose).toBe("</prior_context>")
      },
    )

    it("toString helper produces a single body string", () => {
      const out = sanitizeAnchorToString("hello world", "narrative")
      expect(out.body).toBe('<prior_context source="narrative">\nhello world\n</prior_context>')
      expect(out.imperativePrefixApplied).toBe(false)
    })

    it("flattens an existing prior_context wrapper before writing the next anchor", () => {
      const previous = '<prior_context source="narrative">\nold summary\n</prior_context>'
      const out = sanitizeAnchorToString(`${previous}\n\nnew tail`, "narrative")
      expect(out.body.match(/<prior_context\b/g)).toHaveLength(1)
      expect(out.body.match(/<\/prior_context>/g)).toHaveLength(1)
      expect(out.body).toContain("old summary")
      expect(out.body).toContain("new tail")
    })

    it("unwraps nested whole-body prior_context wrappers", () => {
      const nested =
        '<prior_context source="narrative">\n<prior_context source="ai_paid">\ninner\n</prior_context>\n</prior_context>'
      expect(unwrapPriorContext(nested)).toBe("inner")
    })
  })

  describe("imperative softening", () => {
    const cases: Array<[label: string, input: string]> = [
      ["You must", "You must always validate input."],
      ["You should", "You should consider edge case Y."],
      ["Always", "Always sanitize before insert."],
      ["Never", "Never trust user input."],
      ["Do not", "Do not skip the lock check."],
      ["Don't", "Don't bypass the gate."],
      ["Rules:", "Rules: no shadowing of L7."],
      ["Rule:", "Rule: keep cache stable."],
      ["Important:", "Important: this is a hard rule."],
      ["System:", "System: emergency stop required."],
    ]

    it.each(cases)("rewrites '%s' leading line", (_label, input) => {
      const out = sanitizeAnchor(input, "narrative")
      expect(out.imperativePrefixApplied).toBe(true)
      expect(out.softenedBody.startsWith("Note from prior context: ")).toBe(true)
    })

    it("does not rewrite non-imperative lines", () => {
      const out = sanitizeAnchor("The agent inspected the logs.", "narrative")
      expect(out.imperativePrefixApplied).toBe(false)
      expect(out.softenedBody).toBe("The agent inspected the logs.")
    })

    it("only rewrites lines whose leading token matches", () => {
      const text = "Background: agent did X.\nYou must keep state.\nResult: ok."
      const out = sanitizeAnchor(text, "narrative")
      expect(out.imperativePrefixApplied).toBe(true)
      const lines = out.softenedBody.split("\n")
      expect(lines[0]).toBe("Background: agent did X.")
      expect(lines[1]).toBe("Note from prior context: You must keep state.")
      expect(lines[2]).toBe("Result: ok.")
    })

    it("preserves leading whitespace before applying prefix", () => {
      const text = "  You must keep indentation."
      const out = sanitizeAnchor(text, "narrative")
      expect(out.softenedBody).toBe("  Note from prior context: You must keep indentation.")
    })
  })

  describe("byte determinism", () => {
    it("same input produces byte-equal output across two calls", () => {
      const input = "You must keep state.\nThe agent inspected the logs."
      const a = sanitizeAnchor(input, "narrative")
      const b = sanitizeAnchor(input, "narrative")
      expect(a).toEqual(b)

      const sa = sanitizeAnchorToString(input, "narrative")
      const sb = sanitizeAnchorToString(input, "narrative")
      expect(sa.body).toBe(sb.body)
    })

    it("kind change alters wrapperOpen but keeps softenedBody stable", () => {
      const input = "Always validate."
      const a = sanitizeAnchor(input, "narrative")
      const b = sanitizeAnchor(input, "ai_paid")
      expect(a.softenedBody).toBe(b.softenedBody)
      expect(a.wrapperOpen).not.toBe(b.wrapperOpen)
    })
  })

  describe("edge cases", () => {
    it("empty string", () => {
      const out = sanitizeAnchor("", "narrative")
      expect(out.softenedBody).toBe("")
      expect(out.imperativePrefixApplied).toBe(false)
    })

    it("multi-line all imperative", () => {
      const input = "You must X.\nAlways Y.\nNever Z."
      const out = sanitizeAnchor(input, "narrative")
      expect(out.imperativePrefixApplied).toBe(true)
      const lines = out.softenedBody.split("\n")
      expect(lines.every((l) => l.startsWith("Note from prior context:"))).toBe(true)
    })

    it("case-insensitive matching", () => {
      const out1 = sanitizeAnchor("YOU MUST X", "narrative")
      const out2 = sanitizeAnchor("you must x", "narrative")
      expect(out1.imperativePrefixApplied).toBe(true)
      expect(out2.imperativePrefixApplied).toBe(true)
    })
  })
})
