/**
 * compaction-fix Phase 1 — emission filter unit tests.
 *
 * Three regurgitation classes the filter must catch:
 *   - trace_marker:        `[turn N] tool(args) → ref:call_xyz; ...`
 *   - line_numbered_dump:  3+ consecutive `<digits>| <content>` lines
 *   - cache_digest_fence:  ` ```cache-digest ... ``` ` in main text channel
 *
 * Plus negative cases — legitimate prose must NOT match.
 */

import { describe, expect, test } from "bun:test"
import { detectEmissionGarbage } from "../../src/session/emission-filter"

describe("detectEmissionGarbage", () => {
  describe("trace_marker", () => {
    test("matches Phase 1 v1 trace marker with ref payload", () => {
      const text = "[turn 133] read({\"filePath\":\"/x.py\",\"offset\":0}) → ref:call_58KS9ID; grep({\"pattern\":\"foo\"}) → ref:call_5gObfo5"
      expect(detectEmissionGarbage(text)).toEqual({ hidden: true, reason: "trace_marker" })
    })

    test("matches multi-line trace marker", () => {
      const text =
        "[turn 1] read({\"file\":\"a.ts\"}) → ref:call_aaaaaa\n" +
        "[turn 2] grep({\"pattern\":\"x\"}) → ref:call_bbbbbb\n" +
        "Continuing the work."
      const result = detectEmissionGarbage(text)
      expect(result.hidden).toBe(true)
      expect(result.reason).toBe("trace_marker")
    })

    test("does NOT match prose mentioning [turn N] without ref", () => {
      const text = "[turn 5] is the round we left off in. Let me continue from there."
      expect(detectEmissionGarbage(text)).toEqual({ hidden: false, reason: null })
    })

    test("does NOT match legitimate ref token in unrelated prose", () => {
      const text = "I see ref:call_abcdef in the logs but no turn marker structure."
      expect(detectEmissionGarbage(text)).toEqual({ hidden: false, reason: null })
    })
  })

  describe("line_numbered_dump", () => {
    test("matches 3+ consecutive line-numbered rows (read-style)", () => {
      const text = `Here is the code:
08571| def foo():
08572|     return 42
08573| def bar():
08574|     pass`
      expect(detectEmissionGarbage(text).hidden).toBe(true)
      expect(detectEmissionGarbage(text).reason).toBe("line_numbered_dump")
    })

    test("matches inline-flow line dump (no prefix newline)", () => {
      const text =
        "08571| safe = safe_range_for_edge(edge) 08572| if safe is None: 08573| return edge 08574| min_y, max_y = safe 08575| new_points = tuple("
      // Single-line concatenated style — but our pattern requires line break
      // between entries. This particular shape is more of a mixed flow that
      // should still be caught if it has multiple entries.
      // Behavior: we deliberately require newlines between line markers (more
      // conservative — avoids false positives on prose mentioning code).
      const result = detectEmissionGarbage(text)
      // This shape is technically caught only if the pattern allows linear
      // (one-line) concatenation. We chose the stricter line-break form;
      // assert the current behavior so future regressions are visible.
      expect(result.hidden).toBe(false)
    })

    test("does NOT match 2 lines (under threshold)", () => {
      const text = "Two lines:\n08571| code\n08572| more"
      expect(detectEmissionGarbage(text).hidden).toBe(false)
    })

    test("does NOT match prose without line markers", () => {
      const text = "Lines 8571-8573 contain the function body."
      expect(detectEmissionGarbage(text).hidden).toBe(false)
    })
  })

  describe("cache_digest_fence", () => {
    test("matches misrouted cache-digest fenced block", () => {
      const text =
        "Some prose first.\n```cache-digest\n{\"purpose\":\"test\"}\n```\nMore prose."
      expect(detectEmissionGarbage(text)).toEqual({ hidden: true, reason: "cache_digest_fence" })
    })

    test("does NOT match other fenced languages", () => {
      const text = "```javascript\nconst x = 1;\n```"
      expect(detectEmissionGarbage(text).hidden).toBe(false)
    })
  })

  describe("clean cases", () => {
    test("empty string is clean", () => {
      expect(detectEmissionGarbage("")).toEqual({ hidden: false, reason: null })
    })

    test("non-string input is clean (defensive)", () => {
      expect(detectEmissionGarbage(undefined as unknown as string)).toEqual({ hidden: false, reason: null })
      expect(detectEmissionGarbage(null as unknown as string)).toEqual({ hidden: false, reason: null })
    })

    test("normal assistant prose is clean", () => {
      const text = "I checked the file and the function calculates the safe range. Let me run the tests now."
      expect(detectEmissionGarbage(text).hidden).toBe(false)
    })

    test("code block with normal language tag is clean", () => {
      const text =
        "Here's the diff:\n```diff\n- old line\n+ new line\n```"
      expect(detectEmissionGarbage(text).hidden).toBe(false)
    })
  })

  describe("first-match wins (deterministic reason)", () => {
    test("trace marker wins over line dump when both present", () => {
      const text =
        "[turn 9] read({}) → ref:call_aaaaaa\n08571| code\n08572| more\n08573| stuff"
      // Trace marker matches first in the function order.
      expect(detectEmissionGarbage(text).reason).toBe("trace_marker")
    })
  })
})
