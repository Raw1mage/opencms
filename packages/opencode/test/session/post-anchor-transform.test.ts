/**
 * compaction-fix Phase 1 v5 — post-anchor transformer unit tests.
 *
 * v5 unconditionally drops every completed assistant turn that is not
 * in-flight and not carrying a `compaction` part. No `recentRawRounds`
 * preservation. Aligns with upstream codex-rs `build_compacted_history`.
 * Recall is via system-manager `recall_toolcall_*` MCP tools advertised
 * in the post-compaction provider manifest.
 *
 * Coverage:
 *   - drops all completed assistant turns
 *   - preserves anchor + all user messages + in-flight + compaction-bearing
 *   - itemCount reduction on long tails
 *   - layer-purity exports retained for back-compat
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
// transformPostAnchorTail — v5 unconditional drop
// ─────────────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail v5 (drop all completed assistants)", () => {
  test("noop on empty input", () => {
    const result = transformPostAnchorTail([])
    expect(result.messages).toEqual([])
    expect(result.transformedTurnCount).toBe(0)
    expect(result.exemptTurnCount).toBe(0)
  })

  test("drops every completed assistant turn unconditionally", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("[summary]"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 3 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages)
    expect(result.transformedTurnCount).toBe(3)
    // Anchor + 3 user messages survive; 3 completed assistants dropped
    expect(result.messages.length).toBe(4)
    expect(result.messages[0]).toBe(messages[0])
    const surviving = result.messages.filter((m) => m.info.role === "user")
    expect(surviving.length).toBe(3)
  })

  test("preserves in-flight assistant intact", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 3 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1, inFlight: true }), // pending tool
    ]
    const result = transformPostAnchorTail(messages)
    // 2 completed assistants dropped, in-flight kept
    expect(result.transformedTurnCount).toBe(2)
    expect(result.exemptTurnCount).toBe(1)
    const inFlight = result.messages[result.messages.length - 1]
    expect(inFlight.info.role).toBe("assistant")
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
    const result = transformPostAnchorTail(messages)
    // 2 completed assistants dropped, 1 compaction-bearing kept
    expect(result.transformedTurnCount).toBe(2)
    expect(result.exemptTurnCount).toBe(1)
    const compactionBearing = result.messages.find(
      (m) => m.parts.some((p) => p.type === "compaction") && !(m.info as MessageV2.Assistant).summary,
    )
    expect(compactionBearing).toBeDefined()
  })

  test("treats no-text completed assistant identically to text-bearing (drops both)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }), // text + tools
      userMessage("u2"),
      assistantTurn({ toolCount: 3, noText: true }), // tools only
      userMessage("u3"),
      assistantTurn({ toolCount: 1, hasReasoning: true, noText: true }), // reasoning only
    ]
    const result = transformPostAnchorTail(messages)
    expect(result.transformedTurnCount).toBe(3) // all three dropped
    expect(result.messages.length).toBe(4) // anchor + 3 user
  })

  test("ignores deprecated recentRawRounds option (back-compat call site)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }),
    ]
    // Even with recentRawRounds=10, v5 still drops all
    const result = transformPostAnchorTail(messages, { recentRawRounds: 10 })
    expect(result.transformedTurnCount).toBe(3)
  })

  test("noop when no completed assistants exist (only in-flight)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1, inFlight: true }),
    ]
    const result = transformPostAnchorTail(messages)
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages) // referential equality on noop
  })

  test("itemCount reduction on long tail — 50 turns drop to anchor + user msgs only", () => {
    const messages: MessageV2.WithParts[] = [anchorMessage("[summary]")]
    for (let i = 0; i < 50; i++) {
      messages.push(userMessage(`u${i}`))
      messages.push(assistantTurn({ toolCount: 4, hasReasoning: true }))
    }
    const result = transformPostAnchorTail(messages)
    // All 50 completed assistants dropped
    expect(result.transformedTurnCount).toBe(50)
    // 1 anchor + 50 user = 51 messages remain
    expect(result.messages.length).toBe(51)
  })

  test("does not mutate the input array", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
    ]
    const originalLength = messages.length
    const originalRefs = [...messages]
    transformPostAnchorTail(messages)
    expect(messages.length).toBe(originalLength)
    for (let i = 0; i < messages.length; i++) {
      expect(messages[i]).toBe(originalRefs[i])
    }
  })
})
