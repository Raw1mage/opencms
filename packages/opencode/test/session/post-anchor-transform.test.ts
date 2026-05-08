/**
 * compaction-fix Phase 1 — post-anchor transformer unit tests.
 *
 * Coverage map vs spec.md:
 *   - DD-1 / TraceMarker shape           → "TV1 / format / args truncation / reasoning truncation"
 *   - DD-2 / recentRawRounds preserved   → "preserves last N raw"
 *   - DD-7 / Mode 1 compaction exempt    → "exempts compaction part type"
 *   - In-flight assistant preserved      → "preserves in-flight"
 *   - DD-7 / layer purity guard          → "throws on forbidden key"
 *   - Empty input                        → "noop on empty"
 */

import { describe, expect, test } from "bun:test"
import {
  formatTraceMarker,
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
  /** Optional override for tool name to test custom names */
  toolName?: string
  /** Optional override for tool input to test args formatting */
  toolInput?: unknown
}

function assistantTurn(spec: TurnSpec): MessageV2.WithParts {
  const messageID = id("msg")
  const sessionID = "ses_test"
  const parts: MessageV2.Part[] = [
    {
      id: id("prt"),
      sessionID,
      messageID,
      type: "step-start",
    } as unknown as MessageV2.Part,
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
      state: spec.inFlight && i === spec.toolCount - 1
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

  parts.push({
    id: id("prt"),
    sessionID,
    messageID,
    type: "step-finish",
  } as unknown as MessageV2.Part)

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
// formatTraceMarker
// ─────────────────────────────────────────────────────────────────────────────

describe("formatTraceMarker — DD-1 shape", () => {
  test("multi-tool turn folds into one line with refs", () => {
    const text = formatTraceMarker({
      turnIndex: 5,
      toolFragments: [
        { toolName: "read", argsBrief: '{"file":"x.ts"}', callID: "call_abc123def456ghi", hasResult: true },
        { toolName: "grep", argsBrief: '{"pattern":"foo"}', callID: "call_xyz999", hasResult: true },
      ],
      reasoningSummary: null,
    })
    expect(text).toMatch(/^\[turn 5\] /)
    expect(text).toContain("read(")
    expect(text).toContain("grep(")
    expect(text).toContain("→ ref:call_abc123d")
    expect(text).toContain(";")
  })

  test("no result on tool → omits ref", () => {
    const text = formatTraceMarker({
      turnIndex: 1,
      toolFragments: [{ toolName: "bash", argsBrief: "ls", callID: "call_x", hasResult: false }],
      reasoningSummary: null,
    })
    expect(text).toContain("bash(ls)")
    expect(text).not.toContain("→ ref:")
  })

  test("args truncated to 80 chars", () => {
    const longArgs = "a".repeat(200)
    const text = formatTraceMarker({
      turnIndex: 0,
      toolFragments: [{ toolName: "read", argsBrief: longArgs.slice(0, 80) + "…", callID: "call_x", hasResult: true }],
      reasoningSummary: null,
    })
    // Trace marker preserves the briefArgs the caller passed; we only verify
    // formatTraceMarker doesn't ADD beyond what was passed.
    expect(text.length).toBeLessThan(300)
  })

  test("reasoning summary truncated and appended", () => {
    const long = "thinking ".repeat(20)
    const text = formatTraceMarker({
      turnIndex: 2,
      toolFragments: [],
      reasoningSummary: long,
    })
    // "thinking " * 20 = 180 chars; truncated to ~50.
    const segments = text.split("] ")[1] // strip "[turn 2] "
    expect(segments.length).toBeLessThanOrEqual(60)
  })

  test("empty turn yields placeholder", () => {
    const text = formatTraceMarker({ turnIndex: 9, toolFragments: [], reasoningSummary: null })
    expect(text).toContain("(no traced parts)")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Layer purity (DD-7)
// ─────────────────────────────────────────────────────────────────────────────

describe("Layer purity (DD-7)", () => {
  test("LAYER_PURITY_FORBIDDEN_KEYS contains expected tokens", () => {
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("accountId")
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("previous_response_id")
    expect(LAYER_PURITY_FORBIDDEN_KEYS).toContain("wsSessionId")
  })

  test("formatTraceMarker throws on forbidden key in args", () => {
    expect(() =>
      formatTraceMarker({
        turnIndex: 0,
        toolFragments: [
          { toolName: "secret", argsBrief: '{"previous_response_id":"resp_abc"}', callID: "call_x", hasResult: true },
        ],
        reasoningSummary: null,
      }),
    ).toThrow(LayerPurityViolation)
  })

  test("formatTraceMarker throws on forbidden key in reasoning", () => {
    expect(() =>
      formatTraceMarker({
        turnIndex: 0,
        toolFragments: [],
        reasoningSummary: "leaking accountId into trace",
      }),
    ).toThrow(LayerPurityViolation)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// transformPostAnchorTail
// ─────────────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail", () => {
  test("noop on empty input", () => {
    const result = transformPostAnchorTail([], { recentRawRounds: 2 })
    expect(result.messages).toEqual([])
    expect(result.transformedTurnCount).toBe(0)
  })

  test("preserves last N=2 raw turns (DD-2)", () => {
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

    // 5 completed assistant turns; recentRawRounds=2 keeps last 2 raw → 3 transformed
    expect(result.transformedTurnCount).toBe(3)
    // Anchor at index 0 unchanged
    expect(result.messages[0]).toBe(messages[0])
    // Last 2 assistant turns at indices 8, 10 — should still have many parts (raw)
    expect(result.messages[8].parts.length).toBeGreaterThan(2)
    expect(result.messages[10].parts.length).toBeGreaterThan(2)
    // First 3 assistant turns (indices 2, 4, 6) — transformed to step-start + trace + step-finish
    const transformedIndices = [2, 4, 6]
    for (const idx of transformedIndices) {
      const parts = result.messages[idx].parts
      const traceParts = parts.filter((p) => p.type === "text")
      expect(traceParts.length).toBe(1)
      expect((traceParts[0] as MessageV2.TextPart).text).toMatch(/^\[turn \d+\]/)
      expect((traceParts[0] as MessageV2.TextPart).synthetic).toBe(true)
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
    // In-flight (index 6) should NOT be transformed even with recentRawRounds=0
    const inFlight = result.messages[6]
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
    // Index 4 holds compaction part — must be preserved fully
    expect(result.messages[4].parts.some((p) => p.type === "compaction")).toBe(true)
    expect(result.messages[4].parts.length).toBe(messages[4].parts.length)
  })

  test("does not transform when recent N >= candidate count", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 1 }),
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }),
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 5 })
    expect(result.transformedTurnCount).toBe(0)
  })

  test("transforms multi-tool turn into trace markers with refs", () => {
    const messages: MessageV2.WithParts[] = [
      anchorMessage("summary"),
      userMessage("u1"),
      assistantTurn({ toolCount: 4, hasReasoning: true }), // candidate to transform
      userMessage("u2"),
      assistantTurn({ toolCount: 1 }), // recent, raw
      userMessage("u3"),
      assistantTurn({ toolCount: 1 }), // recent, raw
    ]
    const result = transformPostAnchorTail(messages, { recentRawRounds: 2 })
    expect(result.transformedTurnCount).toBe(1)
    const tracedTurn = result.messages[2]
    const traceText = (tracedTurn.parts.find((p) => p.type === "text") as MessageV2.TextPart).text
    expect(traceText).toMatch(/^\[turn 2\]/)
    expect(traceText).toContain("read(")
    expect(traceText.match(/→ ref:/g)?.length).toBe(4) // 4 tool calls all have refs
  })
})
