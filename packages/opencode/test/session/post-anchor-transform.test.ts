/**
 * compaction-fix Phase 1 — post-anchor transformer unit tests.
 *
 * 2026-05-08 revision: transformer now DROPS completed assistant turns
 * (instead of replacing parts with trace markers). Tests verify the
 * drop behavior, recentRawRounds preservation, and carve-outs.
 *
 * Coverage:
 *   - DD-1 / drop completed assistant turns       → "drops older completed turns"
 *   - DD-2 / recentRawRounds preserved            → "preserves last N raw"
 *   - DD-7 / Mode 1 compaction exempt             → "exempts compaction part type"
 *   - In-flight assistant preserved               → "preserves in-flight"
 *   - Empty / undersized inputs                   → "noop on empty / under threshold"
 *   - Layer-purity exports still present (back-compat)
 */

import { describe, expect, test } from "bun:test"
import {
  transformPostAnchorTail,
  LayerPurityViolation,
  LAYER_PURITY_FORBIDDEN_KEYS,
} from "../../src/session/post-anchor-transform"
import type { MessageV2 } from "../../src/session/message-v2"

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

let nextId = 0
function id(prefix: string): string {
  return `${prefix}_${(++nextId).toString(36).padStart(8, "0")}`
}

function userMessage(text: string): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
    } as MessageV2.User,
    parts: [
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "text",
        text,
      } as MessageV2.TextPart,
    ],
  }
}

function anchorMessage(summary: string): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: id("msg"),
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "build",
      agent: "default",
      path: { cwd: "/", root: "/" },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts: [
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "text",
        text: summary,
      } as MessageV2.TextPart,
      {
        id: id("prt"),
        sessionID,
        messageID,
        type: "compaction",
        auto: false,
      } as unknown as MessageV2.Part,
    ],
  }
}

interface TurnSpec {
  toolCount: number
  hasReasoning?: boolean
  inFlight?: boolean
  hasCompactionPart?: boolean
  toolName?: string
  toolInput?: unknown
  /** v3: when true, emit no text part (tool-call-only turn). */
  noText?: boolean
}

function assistantTurn(spec: TurnSpec): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  const parts: MessageV2.Part[] = [
    { id: id("prt"), sessionID, messageID, type: "step-start" } as unknown as MessageV2.Part,
  ]

  if (spec.hasReasoning) {
    parts.push({
      id: id("prt"),
      sessionID,
      messageID,
      type: "reasoning",
      text: "thinking through the problem",
    } as unknown as MessageV2.Part)
  }

  if (!spec.noText) {
    parts.push({
      id: id("prt"),
      sessionID,
      messageID,
      type: "text",
      text: "I'll do the next step",
    } as MessageV2.TextPart)
  }

  for (let i = 0; i < spec.toolCount; i++) {
    parts.push({
      id: id("prt"),
      sessionID,
      messageID,
      type: "tool",
      callID: id("call"),
      tool: spec.toolName ?? "read",
      state:
        spec.inFlight && i === spec.toolCount - 1
          ? { status: "pending", input: spec.toolInput ?? { file: "x.ts" } }
          : { status: "completed", input: spec.toolInput ?? { file: "x.ts" }, output: "..." },
    } as unknown as MessageV2.Part)
  }

  if (spec.hasCompactionPart) {
    parts.push({
      id: id("prt"),
      sessionID,
      messageID,
      type: "compaction",
      auto: true,
    } as unknown as MessageV2.Part)
  }

  parts.push({ id: id("prt"), sessionID, messageID, type: "step-finish" } as unknown as MessageV2.Part)

  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now(), completed: spec.inFlight ? undefined : Date.now() },
      parentID: id("msg"),
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "build",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer-purity exports (back-compat)
// ─────────────────────────────────────────────────────────────────────────────

describe("Layer purity exports (back-compat)", () => {
  test("LAYER_PURITY_FORBIDDEN_KEYS still contains expected tokens", () => {
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("accountId")
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("previous_response_id")
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("wsSessionId")
  })

  test("LayerPurityViolation class is constructable", () => {
    const err = new LayerPurityViolation("accountId", "test")
    expect(err).toBeInstanceOf(Error)
    expect(err.forbiddenKey).toBe("accountId")
    expect(err.context).toBe("test")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// transformPostAnchorTail — drop semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail (drop semantics)", () => {
  test("noop on empty input", () => {
    const result = transformPostAnchorTail([], { recentRawRounds: 2 })
    expect(result.messages).toEqual([])
    expect(result.transformedTurnCount).toBe(0)
    expect(result.exemptTurnCount).toBe(0)
  })

  test("drops older completed turns, keeps last N=2 raw (DD-1 + DD-2)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("[summary so far]"),
      userMessage("turn 1 question"),
      assistantTurn({ toolCount: 2 }),
      userMessage("turn 2 question"),
      assistantTurn({ toolCount: 3 }),
      userMessage("turn 3 question"),
      assistantTurn({ toolCount: 1 }),
      userMessage("turn 4 question"),
      assistantTurn({ toolCount: 2 }),
      userMessage("turn 5 question"),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })

    // 5 completed assistant turns; recentRawRounds=2 keeps last 2 → 3 dropped
    expect(result.transformedTurnCount).toBe(3)

    // Anchor at index 0 unchanged
    expect(result.messages[0]).toBe(messages[0])

    // All 5 user messages preserved
    const userMsgs = result.messages.filter((m) => m.info.role === "user")
    expect(userMsgs.length).toBe(5)

    // Only 2 assistant messages (the kept-raw last 2)
    const assistantMsgs = result.messages.filter((m) => m.info.role === "assistant")
    // Anchor counts as assistant role too — anchor + 2 raw = 3
    expect(assistantMsgs.length).toBe(3)

    // The kept assistant turns retain their full part structure (not collapsed)
    const nonAnchorAssistants = assistantMsgs.filter((m) => !(m.info as MessageV2.Assistant).summary)
    for (const a of nonAnchorAssistants) {
      expect(a.parts.length).toBeGreaterThan(2)
    }
  })

  test("preserves in-flight assistant intact", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 3 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1, inFlight: true }), // last one has pending tool
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 0 })
    // In-flight assistant is preserved even with recentRawRounds=0
    const inFlight = result.messages[result.messages.length - 1]
    expect(inFlight.info.role).toBe("assistant")
    expect(inFlight.parts.length).toBeGreaterThan(2)
    expect(inFlight.parts.some((p) => p.type === "tool")).toBe(true)
  })

  test("exempts assistant message with compaction part (DD-7 carve-out)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1, hasCompactionPart: true }), // exempt
      userMessage("u3"),
      assistantTurn({ toolCount: 2 }),
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 0 })
    // Compaction-bearing assistant is preserved fully (full part count)
    const compactionBearing = result.messages.find((m) => m.parts.some((p) => p.type === "compaction") && !(m.info as MessageV2.Assistant).summary)
    expect(compactionBearing).toBeDefined()
    expect(compactionBearing!.parts.some((p) => p.type === "compaction")).toBe(true)
  })

  test("noop when recent N >= candidate count", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 5 })
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages) // returns same reference when no-op
  })

  test("itemCount-equivalent reduction is significant on long tail", () => {
    // Synthesize 30 completed turns each with 4 tool calls — without drop,
    // each turn contributes ~7 parts. With drop (recentRawRounds=2), 28 of
    // 30 are removed entirely.
    const messages: MessageV2.WithParts[] = [anchorMessage("[summary]")]
    for (let i = 0; i < 30; i++) {
      messages.push(userMessage(`u${i}`))
      messages.push(assistantTurn({ toolCount: 4, hasReasoning: true }))
    }
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    expect(result.transformedTurnCount).toBe(28)
    // Original: 1 anchor + 30 user + 30 assistant = 61 messages
    // After:    1 anchor + 30 user + 2 assistant = 33 messages
    expect(result.messages.length).toBe(33)
  })

  test("does not mutate the input array", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }),
    ]
    const originalLength = messages.length
    const originalRefs = [...messages]
    transformPostAnchorTail(messages, { recentRawRounds: 1 })
    expect(messages.length).toBe(originalLength)
    for (let i = 0; i < messages.length; i++) {
      expect(messages[i]).toBe(originalRefs[i])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v3 — text-bearing-aware preservation (mixed text / no-text turns)
// ─────────────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail v3 — text-bearing preservation", () => {
  test("keeps Nth-most-recent text turn + everything after (interleaved no-text)", () => {
    // Pattern: text / no-text / text / no-text / text / no-text  (6 turns)
    // recentRawRounds=2 → cutoff = 2nd-most-recent text-bearing turn
    // = the text turn at index ... let's count positions:
    //   idx 0: anchor
    //   idx 1: user u1
    //   idx 2: assistant text-bearing #1 (oldest)
    //   idx 3: user u2
    //   idx 4: assistant no-text #1
    //   idx 5: user u3
    //   idx 6: assistant text-bearing #2
    //   idx 7: user u4
    //   idx 8: assistant no-text #2
    //   idx 9: user u5
    //   idx 10: assistant text-bearing #3 (newest)
    //   idx 11: user u6
    //   idx 12: assistant no-text #3 (newest)
    // text-bearing indices: [2, 6, 10]
    // recentRawRounds=2 → cutoff = textBearing[3-2] = textBearing[1] = idx 6
    // drop indices: candidates < 6 = [2, 4]
    // kept: [0(anchor), 1, 3, 5, 6(text#2), 7, 8(no-text#2), 9, 10(text#3), 11, 12(no-text#3)]
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),                  // idx 2 — text #1
      userMessage("u2"),
      assistantTurn({ toolCount: 2, noText: true }),    // idx 4 — no-text #1
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }),                  // idx 6 — text #2
      userMessage("u4"),
      assistantTurn({ toolCount: 2, noText: true }),    // idx 8 — no-text #2
      userMessage("u5"),
      assistantTurn({ toolCount: 1 }),                  // idx 10 — text #3
      userMessage("u6"),
      assistantTurn({ toolCount: 2, noText: true }),    // idx 12 — no-text #3
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    expect(result.transformedTurnCount).toBe(2) // idx 2 and 4 dropped
    expect(result.messages.length).toBe(messages.length - 2) // 13 - 2 = 11

    // Verify text #2 and after survived
    expect(result.messages).toContain(messages[6])  // text #2
    expect(result.messages).toContain(messages[8])  // no-text #2 (interleaved, kept)
    expect(result.messages).toContain(messages[10]) // text #3
    expect(result.messages).toContain(messages[12]) // no-text #3

    // Verify text #1 + adjacent no-text #1 dropped
    expect(result.messages).not.toContain(messages[2])
    expect(result.messages).not.toContain(messages[4])
  })

  test("drops nothing when last 2 turns are both no-text but only 2 text-bearing total", () => {
    // 2 text + 2 no-text, recentRawRounds=2 → text count (2) ≤ N (2) → noop
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),                  // text
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),                  // text
      userMessage("u3"),
      assistantTurn({ toolCount: 1, noText: true }),    // no-text
      userMessage("u4"),
      assistantTurn({ toolCount: 1, noText: true }),    // no-text
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages) // referential equality on noop
  })

  test("v2-amnesia regression: with last 2 raw being no-text, model still sees text history", () => {
    // The exact failure mode v3 fixes: 5 text + 2 trailing no-text,
    // recentRawRounds=2. v2 would keep only the 2 trailing no-text.
    // v3 keeps text-bearing #4 (cutoff) + no-text and text after.
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u0"),
      assistantTurn({ toolCount: 1 }),                  // idx 2 — text #1
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),                  // idx 4 — text #2
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),                  // idx 6 — text #3
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }),                  // idx 8 — text #4 (cutoff for N=2)
      userMessage("u4"),
      assistantTurn({ toolCount: 1 }),                  // idx 10 — text #5
      userMessage("u5"),
      assistantTurn({ toolCount: 1, noText: true }),    // idx 12 — no-text #1
      userMessage("u6"),
      assistantTurn({ toolCount: 1, noText: true }),    // idx 14 — no-text #2
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    // textBearing indices [2, 4, 6, 8, 10]; cutoff = [5-2] = [3] = idx 8
    // candidates < 8 = [2, 4, 6] dropped (3 turns)
    expect(result.transformedTurnCount).toBe(3)

    // Verify model retains text-bearing #4 (the cutoff) — its self-narrative
    // is still in the prompt despite the trailing no-text turns
    expect(result.messages).toContain(messages[8]) // text #4
    expect(result.messages).toContain(messages[10]) // text #5
    expect(result.messages).toContain(messages[12]) // no-text #1
    expect(result.messages).toContain(messages[14]) // no-text #2
    expect(result.messages).not.toContain(messages[2])
    expect(result.messages).not.toContain(messages[4])
    expect(result.messages).not.toContain(messages[6])
  })

  test("treats reasoning-only turns as text-bearing", () => {
    // Turn with reasoning but no main-channel text → still counts as
    // text-bearing (codex emits narrative on reasoning channel).
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1, hasReasoning: true, noText: true }), // reasoning only
      userMessage("u2"),
      assistantTurn({ toolCount: 1, hasReasoning: true, noText: true }), // reasoning only
      userMessage("u3"),
      assistantTurn({ toolCount: 1, hasReasoning: true, noText: true }), // reasoning only
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    // textBearing count = 3 (all reasoning turns count) > N=2
    // cutoff = textBearing[1] = the 2nd reasoning turn
    expect(result.transformedTurnCount).toBe(1)
  })

  test("when no text-bearing turns exist, drops nothing", () => {
    // All-no-text edge case (rare in practice). Conservative behavior:
    // don't drop, model already has nothing useful.
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2, noText: true }),
      userMessage("u2"),
      assistantTurn({ toolCount: 2, noText: true }),
      userMessage("u3"),
      assistantTurn({ toolCount: 2, noText: true }),
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages)
  })
})
