/**
 * compaction-fix Phase 1 v6 — post-anchor transformer unit tests.
 *
 * v6 drops completed assistant turns whose position is BEFORE the most
 * recent user message in the post-anchor stream. Within the current
 * task (turns since the last user message) every assistant message
 * stays intact, giving the model full self-continuity for the live
 * question while still bounding itemCount across long sessions of
 * many separate user tasks.
 *
 * Coverage:
 *   - drops completed assistants before last user message
 *   - keeps everything from last user message onward
 *   - in-flight assistant always preserved
 *   - compaction-bearing assistant always preserved
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
// transformPostAnchorTail v6 — current-task scope
// ─────────────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail v6 (drop before last user message)", () => {
  test("noop on empty input", () => {
    const result = transformPostAnchorTail([])
    expect(result.messages).toEqual([])
    expect(result.transformedTurnCount).toBe(0)
    expect(result.exemptTurnCount).toBe(0)
  })

  test("drops completed assistants from prior tasks; keeps current task intact", () => {
    // 3 user tasks. Most recent task is the last user message.
    const messages: MessageV2.WithParts[] = [
      anchorMessage("[summary]"),
      userMessage("u1"),                     // task 1
      assistantTurn({ toolCount: 2 }),
      assistantTurn({ toolCount: 1 }),
      userMessage("u2"),                     // task 2
      assistantTurn({ toolCount: 3 }),
      assistantTurn({ toolCount: 1 }),
      userMessage("u3"),                     // task 3 (current)
      assistantTurn({ toolCount: 2 }),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages)

    // 4 assistants from prior tasks dropped (indices 2, 3, 5, 6)
    expect(result.transformedTurnCount).toBe(4)
    // Anchor + 3 user + 2 current-task assistants = 6 messages
    expect(result.messages.length).toBe(6)
    expect(result.messages[0]).toBe(messages[0])   // anchor
    expect(result.messages).toContain(messages[1]) // u1
    expect(result.messages).toContain(messages[4]) // u2
    expect(result.messages).toContain(messages[7]) // u3 (last user)
    expect(result.messages).toContain(messages[8]) // current task assistant 1
    expect(result.messages).toContain(messages[9]) // current task assistant 2
    // Prior-task assistants dropped
    expect(result.messages).not.toContain(messages[2])
    expect(result.messages).not.toContain(messages[3])
    expect(result.messages).not.toContain(messages[5])
    expect(result.messages).not.toContain(messages[6])
  })

  test("preserves in-flight assistant (always after last user)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 3 }),
      userMessage("u3"),
      assistantTurn({ toolCount: 1, inFlight: true }),
    ]
    const result = transformPostAnchorTail(messages)
    // 2 prior-task assistants (indices 2, 4) dropped
    expect(result.transformedTurnCount).toBe(2)
    // In-flight survives (it's after u3, current task)
    const inFlight = result.messages[result.messages.length - 1]
    expect(inFlight.info.role).toBe("assistant")
    expect(inFlight.parts.some((p) => p.type === "tool")).toBe(true)
  })

  test("keeps all assistants when only one user message exists (single-task session)", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 2 }),
      assistantTurn({ toolCount: 3 }),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages)
    // All 3 assistants are after u1 (the only user) → drop nothing
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  test("noop when no user message exists in post-anchor slice", () => {
    // Synthetic post-compaction state: anchor + assistant continue messages
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      assistantTurn({ toolCount: 1 }),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages)
    // No user msg → drop nothing
    expect(result.transformedTurnCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  test("exempts assistant message with compaction part regardless of position", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1, hasCompactionPart: true }), // exempt
      userMessage("u2"),
      assistantTurn({ toolCount: 2 }),
    ]
    const result = transformPostAnchorTail(messages)
    // Compaction-bearing assistant is exempt; in this case it's BEFORE last user
    // but the carve-out keeps it
    expect(result.transformedTurnCount).toBe(0) // exempt + current task
    expect(result.exemptTurnCount).toBe(1)
  })

  test("ignores deprecated recentRawRounds option", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
    ]
    // recentRawRounds=10 used to mean "keep 10 raw" — v6 ignores it
    const result = transformPostAnchorTail(messages, { recentRawRounds: 10 })
    // 1 assistant (idx 2, before u2) dropped
    expect(result.transformedTurnCount).toBe(1)
  })

  test("typical long session — many prior tasks + active current task", () => {
    // 20 prior user-task cycles, each with 4 assistant turns
    const messages: MessageV2.WithParts[] = [anchorMessage("[summary]")]
    for (let task = 0; task < 20; task++) {
      messages.push(userMessage(`task-${task}`))
      for (let t = 0; t < 4; t++) {
        messages.push(assistantTurn({ toolCount: 2, hasReasoning: true }))
      }
    }
    // Current task: user + 5 in-progress turns
    messages.push(userMessage("current-task"))
    for (let t = 0; t < 5; t++) {
      messages.push(assistantTurn({ toolCount: 2, hasReasoning: true }))
    }
    const result = transformPostAnchorTail(messages)
    // 20 tasks × 4 assistants = 80 prior assistants dropped
    expect(result.transformedTurnCount).toBe(80)
    // Kept: 1 anchor + 21 user + 5 current = 27 messages
    expect(result.messages.length).toBe(27)
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
