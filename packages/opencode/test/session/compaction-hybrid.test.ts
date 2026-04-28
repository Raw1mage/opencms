import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Log } from "../../src/util/log"
import type { MessageV2 } from "../../src/session/message-v2"

Log.init({ print: false })

const Hybrid = SessionCompaction.Hybrid

// ─── Test fixtures ────────────────────────────────────────────────────

function validHeader(opts?: { rounds?: [number, number]; provider?: string; model?: string }): string {
  const [a, b] = opts?.rounds ?? [0, 5]
  const provider = opts?.provider ?? "anthropic"
  const model = opts?.model ?? "claude-4-7"
  return `[Context Anchor v1] generated at 2026-04-29T00:00:00.000Z by ${provider}:${model} covering rounds [${a}..${b}]`
}

function makeRequest(overrides?: Partial<typeof Hybrid extends never ? never : SessionCompaction.Hybrid.LLMCompactRequest>): SessionCompaction.Hybrid.LLMCompactRequest {
  return {
    priorAnchor: null,
    journalUnpinned: [
      {
        roundIndex: 0,
        messages: [
          { role: "user", content: "first user message with reasonable length to make input larger than output" },
          { role: "assistant", content: "first assistant reply with a good amount of body text to ensure sanity-smaller passes" },
        ],
      },
      {
        roundIndex: 1,
        messages: [
          { role: "user", content: "another user message to add more journal content" },
          { role: "assistant", content: "another assistant reply with substantial text content to make sure the input estimate is large enough" },
        ],
      },
    ],
    framing: { mode: "phase1", strict: false },
    targetTokens: 5000,
    ...overrides,
  }
}

// ─── validateAnchorBody ───────────────────────────────────────────────

describe("Hybrid.validateAnchorBody", () => {
  test("accepts a valid header + small body", () => {
    const body = validHeader() + "\n\n## Goal\n- write tests"
    const r = Hybrid.validateAnchorBody(body, makeRequest())
    expect(r.ok).toBe(true)
  })

  test("rejects body with missing header", () => {
    const body = "## Goal\n- write tests\nNo header line"
    const r = Hybrid.validateAnchorBody(body, makeRequest())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("header_missing")
  })

  test("rejects body where size > targetTokens * 1.10", () => {
    const big = "x".repeat(5000 * 4 * 1.2) // ~6000 tokens, target 5000, ceiling 5500
    const body = validHeader() + "\n" + big
    const r = Hybrid.validateAnchorBody(body, makeRequest())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("size_overflow")
  })

  test("rejects body that is not strictly smaller than input", () => {
    // Tiny request input + huge body
    const tinyReq = makeRequest({
      journalUnpinned: [{ roundIndex: 0, messages: [{ role: "user", content: "x" }] }],
      targetTokens: 100_000,
    })
    const body = validHeader() + "\n" + "y".repeat(4000) // ~1000 tokens, much bigger than tiny input
    const r = Hybrid.validateAnchorBody(body, tinyReq)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("sanity_smaller")
  })

  test("rejects body containing forbidden token", () => {
    const body = validHeader() + "\n## Goal\n<thinking>oops</thinking>\nbody"
    const r = Hybrid.validateAnchorBody(body, makeRequest())
    expect(r.ok).toBe(false)
    expect(typeof r.reason === "object" && r.reason && r.reason.kind).toBe("forbidden_token")
  })

  test("rejects body with dropped tool_call_id mentioned verbatim", () => {
    const req = makeRequest({ dropMarkers: ["toolu_xyz123"] })
    const body = validHeader() + "\n## Goal\nThe drop_marker toolu_xyz123 still appears here"
    const r = Hybrid.validateAnchorBody(body, req)
    expect(r.ok).toBe(false)
    expect(typeof r.reason === "object" && r.reason && r.reason.kind).toBe("drop_violated")
  })

  test("accepts body that respects all rules", () => {
    const body =
      validHeader() +
      "\n\n## Goal\n- ship hybrid-llm\n\n## Discoveries\n- validators are testable in isolation\n"
    const r = Hybrid.validateAnchorBody(body, makeRequest())
    expect(r.ok).toBe(true)
  })
})

// ─── inputTokenEstimate ───────────────────────────────────────────────

describe("Hybrid.inputTokenEstimate", () => {
  test("zero on empty request", () => {
    const tokens = Hybrid.inputTokenEstimate({
      priorAnchor: null,
      journalUnpinned: [],
      framing: { mode: "phase1", strict: false },
      targetTokens: 5000,
    })
    expect(tokens).toBe(0)
  })

  test("non-zero on populated request", () => {
    const tokens = Hybrid.inputTokenEstimate(makeRequest())
    expect(tokens).toBeGreaterThan(0)
  })

  test("scales with priorAnchor content size", () => {
    const small = Hybrid.inputTokenEstimate(
      makeRequest({
        priorAnchor: {
          role: "assistant",
          summary: true,
          content: "small",
          metadata: {
            anchorVersion: 1,
            generatedAt: "2026-04-29T00:00:00Z",
            generatedBy: { provider: "test", model: "test", accountId: "" },
            coversRounds: { earliest: 0, latest: 0 },
            inputTokens: 0,
            outputTokens: 0,
            phase: 1,
          },
        },
      }),
    )
    const big = Hybrid.inputTokenEstimate(
      makeRequest({
        priorAnchor: {
          role: "assistant",
          summary: true,
          content: "x".repeat(10_000),
          metadata: {
            anchorVersion: 1,
            generatedAt: "2026-04-29T00:00:00Z",
            generatedBy: { provider: "test", model: "test", accountId: "" },
            coversRounds: { earliest: 0, latest: 0 },
            inputTokens: 0,
            outputTokens: 0,
            phase: 1,
          },
        },
      }),
    )
    expect(big).toBeGreaterThan(small)
  })
})

// ─── wrapPinnedToolMessage / materialisePinnedZone (DD-4 closes G-1) ──

describe("Hybrid.wrapPinnedToolMessage", () => {
  test("produces user-role envelope with [Pinned earlier output] header", () => {
    const sourceMsg = {
      info: { id: "msg_a", role: "assistant", time: { created: 1714329600000 } } as any,
      parts: [],
    } as MessageV2.WithParts
    const toolPart = {
      type: "tool",
      callID: "toolu_abc123",
      tool: "read",
      state: { input: { path: "/etc/hosts" }, output: "127.0.0.1 localhost\n" },
    } as any as MessageV2.ToolPart

    const entry = Hybrid.wrapPinnedToolMessage(toolPart, sourceMsg)

    expect(entry.role).toBe("user")
    expect(entry.content.startsWith("[Pinned earlier output] tool 'read' (round")).toBe(true)
    expect(entry.content.includes("toolu_abc123")).toBe(true)
    expect(entry.content.includes("127.0.0.1 localhost")).toBe(true)
    expect(entry.metadata.pinSource.toolCallId).toBe("toolu_abc123")
    expect(entry.metadata.pinSource.toolName).toBe("read")
    expect(entry.metadata.pinnedBy).toBe("ai") // default
  })

  test("falls back to JSON of input when output absent", () => {
    const sourceMsg = {
      info: { id: "msg_b", role: "assistant", time: { created: 1714329600000 } } as any,
      parts: [],
    } as MessageV2.WithParts
    const toolPart = {
      type: "tool",
      callID: "toolu_def456",
      tool: "glob",
      state: { input: { pattern: "**/*.ts" } }, // no output
    } as any as MessageV2.ToolPart

    const entry = Hybrid.wrapPinnedToolMessage(toolPart, sourceMsg)
    expect(entry.content.includes("**/*.ts")).toBe(true)
  })

  test("respects pinnedBy override (human pin from admin UI)", () => {
    const sourceMsg = {
      info: { id: "msg_c", role: "assistant", time: { created: 1 } } as any,
      parts: [],
    } as MessageV2.WithParts
    const toolPart = {
      type: "tool",
      callID: "toolu_human",
      tool: "bash",
      state: { input: { command: "ls" }, output: "file.txt\n" },
    } as any as MessageV2.ToolPart
    const entry = Hybrid.wrapPinnedToolMessage(toolPart, sourceMsg, { pinnedBy: "human" })
    expect(entry.metadata.pinnedBy).toBe("human")
  })
})

describe("Hybrid.materialisePinnedZone", () => {
  test("empty input → empty output", () => {
    const out = Hybrid.materialisePinnedZone([])
    expect(out).toEqual([])
  })

  test("preserves order of inputs", () => {
    const sources = [1, 2, 3].map((n) => ({
      message: { info: { id: `msg_${n}`, time: { created: n } } as any, parts: [] } as MessageV2.WithParts,
      toolPart: {
        type: "tool",
        callID: `toolu_${n}`,
        tool: "test",
        state: { input: {}, output: `out_${n}` },
      } as any as MessageV2.ToolPart,
    }))
    const entries = Hybrid.materialisePinnedZone(sources)
    expect(entries).toHaveLength(3)
    expect(entries[0].metadata.pinSource.toolCallId).toBe("toolu_1")
    expect(entries[1].metadata.pinSource.toolCallId).toBe("toolu_2")
    expect(entries[2].metadata.pinSource.toolCallId).toBe("toolu_3")
  })
})

// ─── buildUserPayload structural shape ────────────────────────────────

describe("Hybrid.buildUserPayload", () => {
  test("includes META block with provider + model + target_tokens", () => {
    const text = Hybrid.buildUserPayload(makeRequest(), {
      generatedAt: "2026-04-29T01:23:45.000Z",
      provider: "anthropic",
      model: "claude-4-7",
    })
    expect(text.includes("META:")).toBe(true)
    expect(text.includes("provider: anthropic")).toBe(true)
    expect(text.includes("model: claude-4-7")).toBe(true)
    expect(text.includes("target_tokens: 5000")).toBe(true)
    expect(text.includes("phase: 1")).toBe(true)
  })

  test("includes (none — cold start) when priorAnchor is null", () => {
    const text = Hybrid.buildUserPayload(makeRequest(), {
      generatedAt: "x",
      provider: "p",
      model: "m",
    })
    expect(text.includes("(none — cold start)")).toBe(true)
  })

  test("phase 2 includes PINNED_ZONE block when pinnedZone non-empty", () => {
    const pinSource = {
      message: { info: { id: "x", time: { created: 1 } } as any, parts: [] } as MessageV2.WithParts,
      toolPart: {
        type: "tool",
        callID: "toolu_p1",
        tool: "read",
        state: { input: {}, output: "pinned content here" },
      } as any as MessageV2.ToolPart,
    }
    const pinned = Hybrid.materialisePinnedZone([pinSource])
    const text = Hybrid.buildUserPayload(
      makeRequest({
        framing: { mode: "phase2", strict: true },
        pinnedZone: pinned,
      }),
      { generatedAt: "x", provider: "p", model: "m" },
    )
    expect(text.includes("PINNED_ZONE:")).toBe(true)
    expect(text.includes("pinned content here")).toBe(true)
    expect(text.includes("phase: 2")).toBe(true)
  })

  test("includes DROP_MARKERS line when dropMarkers non-empty", () => {
    const text = Hybrid.buildUserPayload(
      makeRequest({ dropMarkers: ["toolu_aaa", "toolu_bbb"] }),
      { generatedAt: "x", provider: "p", model: "m" },
    )
    expect(text.includes("DROP_MARKERS: toolu_aaa, toolu_bbb")).toBe(true)
  })

  test("ends with the produce-now imperative", () => {
    const text = Hybrid.buildUserPayload(makeRequest(), {
      generatedAt: "x",
      provider: "p",
      model: "m",
    })
    expect(text.trimEnd().endsWith("Produce the new anchor body now.")).toBe(true)
  })
})

// ─── loadFramingTemplate (lazy + cached + fallback) ───────────────────

describe("Hybrid.loadFramingTemplate", () => {
  test("returns a non-empty string on first load", async () => {
    const tpl = await Hybrid.loadFramingTemplate()
    expect(typeof tpl).toBe("string")
    expect(tpl.length).toBeGreaterThan(0)
  })

  test("subsequent calls return identical content (cached)", async () => {
    const a = await Hybrid.loadFramingTemplate()
    const b = await Hybrid.loadFramingTemplate()
    expect(a).toBe(b)
  })
})
