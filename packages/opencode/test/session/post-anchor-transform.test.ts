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

  parts.push({
    id: id("prt"),
    sessionID,
    messageID,
    type: "text",
    text: "I'll do the next step",
  } as MessageV2.TextPart)

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
