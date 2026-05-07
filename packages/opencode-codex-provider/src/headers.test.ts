/**
 * headers.test.ts — context-window lineage headers (Phase 2 of provider-hotfix)
 *
 * Mirrors upstream codex-rs 9e19004bc2: /responses requests MUST carry
 * x-codex-window-id, x-codex-parent-thread-id (when subagent), and
 * x-openai-subagent (when subagent) alongside the existing identity headers.
 */
import { describe, expect, test } from "bun:test"
import { buildHeaders } from "./headers"

describe("buildHeaders context-window lineage", () => {
  const baseOptions = {
    accessToken: "access-abc",
    accountId: "codex-subscription-test",
    sessionId: "ses_test",
  }

  test("top-level session emits window-id; no parent-thread-id / subagent label", () => {
    const headers = buildHeaders({
      ...baseOptions,
      window: { conversationId: "conv-1", generation: 0 },
    })
    expect(headers["x-codex-window-id"]).toBe("conv-1:0")
    expect(headers["x-codex-parent-thread-id"]).toBeUndefined()
    expect(headers["x-openai-subagent"]).toBeUndefined()
  })

  test("subagent session emits all three context-window headers", () => {
    const headers = buildHeaders({
      ...baseOptions,
      window: { conversationId: "ses_child", generation: 2 },
      parentThreadId: "ses_parent",
      subagentLabel: "coding",
    })
    expect(headers["x-codex-window-id"]).toBe("ses_child:2")
    expect(headers["x-codex-parent-thread-id"]).toBe("ses_parent")
    expect(headers["x-openai-subagent"]).toBe("coding")
  })

  test("empty subagent label is skipped (does not emit an empty-string header)", () => {
    const headers = buildHeaders({
      ...baseOptions,
      window: { conversationId: "conv", generation: 0 },
      parentThreadId: "",
      subagentLabel: "",
    })
    expect(headers["x-codex-parent-thread-id"]).toBeUndefined()
    expect(headers["x-openai-subagent"]).toBeUndefined()
  })

  test("identity headers (authorization / ChatGPT-Account-Id / session_id) unchanged", () => {
    const headers = buildHeaders({
      ...baseOptions,
      window: { conversationId: "conv", generation: 0 },
      parentThreadId: "ses_p",
      subagentLabel: "coding",
    })
    expect(headers["authorization"]).toBe("Bearer access-abc")
    expect(headers["ChatGPT-Account-Id"]).toBe("codex-subscription-test")
    expect(headers["session_id"]).toBe("ses_test")
    expect(headers["content-type"]).toBe("application/json")
  })
})

// codex-update plan §1: session_id / thread_id / x-client-request-id semantics
// (upstream codex commit a98623511b — feat: add session_id #20437)
describe("buildHeaders session_id / thread_id pairing (codex-update DD-1, DD-2, INV-1, INV-2)", () => {
  test("TV-1: only sessionId provided → both session_id and thread_id emitted with equal values", () => {
    const headers = buildHeaders({
      accessToken: "tok",
      sessionId: "S-uuid-aaaa",
    })
    expect(headers["session_id"]).toBe("S-uuid-aaaa")
    expect(headers["thread_id"]).toBe("S-uuid-aaaa")
    expect(headers["x-client-request-id"]).toBe("S-uuid-aaaa")
  })

  test("TV-2: both sessionId and threadId provided → headers carry distinct values", () => {
    const headers = buildHeaders({
      accessToken: "tok",
      sessionId: "S-uuid-aaaa",
      threadId: "T-uuid-bbbb",
    })
    expect(headers["session_id"]).toBe("S-uuid-aaaa")
    expect(headers["thread_id"]).toBe("T-uuid-bbbb")
    expect(headers["x-client-request-id"]).toBe("T-uuid-bbbb") // INV-2: x-client-request-id == thread_id
  })

  test("TV-3: neither sessionId nor threadId provided → both headers absent", () => {
    const headers = buildHeaders({
      accessToken: "tok",
    })
    expect(headers["session_id"]).toBeUndefined()
    expect(headers["thread_id"]).toBeUndefined()
    expect(headers["x-client-request-id"]).toBeUndefined()
  })

  test("TV-4: x-client-request-id sources from threadId, not sessionId, when both differ", () => {
    const headers = buildHeaders({
      accessToken: "tok",
      sessionId: "S-uuid-aaaa",
      threadId: "T-uuid-bbbb",
    })
    expect(headers["x-client-request-id"]).toBe("T-uuid-bbbb")
    expect(headers["x-client-request-id"]).not.toBe("S-uuid-aaaa")
  })

  test("TV-5: x-client-request-id falls back to sessionId when threadId omitted", () => {
    const headers = buildHeaders({
      accessToken: "tok",
      sessionId: "S-uuid-aaaa",
    })
    expect(headers["x-client-request-id"]).toBe("S-uuid-aaaa")
  })

  test("back-compat: legacy `conversationId` only supplies x-client-request-id when threadId/sessionId are absent", () => {
    // Strict spec wording: x-client-request-id source is `threadId ?? sessionId`.
    // Legacy callers passing `conversationId` only (no thread/session) keep working
    // via a tail-of-chain fallback; threadId or sessionId always wins if either is set.
    const legacyOnly = buildHeaders({
      accessToken: "tok",
      conversationId: "C-legacy",
    })
    expect(legacyOnly["x-client-request-id"]).toBe("C-legacy")
    expect(legacyOnly["session_id"]).toBeUndefined()
    expect(legacyOnly["thread_id"]).toBeUndefined()

    const withSession = buildHeaders({
      accessToken: "tok",
      sessionId: "S-wins",
      conversationId: "C-loses",
    })
    expect(withSession["x-client-request-id"]).toBe("S-wins")
  })
})
