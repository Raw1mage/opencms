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
