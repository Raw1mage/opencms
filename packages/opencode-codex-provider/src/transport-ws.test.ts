/**
 * transport-ws.test.ts — WS upgrade header fingerprint.
 *
 * Covers the fixes that the WS transport needed to match upstream codex-rs
 * first-party classification, now expressed via the unified buildHeaders()
 * entry point with isWebSocket: true (Phase 2 of
 * codex-fingerprint-alignment):
 *   - User-Agent must be present on WS upgrade (was missing; HTTP already had it)
 *   - ChatGPT-Account-Id must be TitleCase (was lowercase chatgpt-account-id)
 *   - OpenAI-Beta must carry the responses_websockets date
 *   - x-client-request-id = conversationId (Phase 4)
 *   - No Content-Type / no Accept on WS upgrade (those are HTTP-only)
 */
import { describe, expect, test } from "bun:test"
import { buildHeaders } from "./headers"

describe("buildHeaders({ isWebSocket: true }) fingerprint", () => {
  const base = {
    accessToken: "access-abc",
    accountId: "codex-subscription-test",
    isWebSocket: true as const,
  }

  test("includes TitleCase ChatGPT-Account-Id (not lowercase)", () => {
    const h = buildHeaders(base)
    expect(h["ChatGPT-Account-Id"]).toBe("codex-subscription-test")
    expect(h["chatgpt-account-id"]).toBeUndefined()
  })

  test("includes User-Agent when provided", () => {
    const ua = "codex_cli_rs/0.125.0-alpha.1 (Linux 5.15.0; x86_64) terminal"
    const h = buildHeaders({ ...base, userAgent: ua })
    expect(h["User-Agent"]).toBe(ua)
  })

  test("UA prefix matches originator (first-party classifier contract)", () => {
    const ua = "codex_cli_rs/0.125.0-alpha.1 (Linux 5.15.0; x86_64) terminal"
    const h = buildHeaders({ ...base, userAgent: ua })
    expect(h["originator"]).toBe("codex_cli_rs")
    expect(h["User-Agent"]?.startsWith(h["originator"] + "/")).toBe(true)
  })

  test("omits User-Agent when not provided (caller responsibility)", () => {
    const h = buildHeaders(base)
    expect(h["User-Agent"]).toBeUndefined()
  })

  test("always emits authorization + originator + OpenAI-Beta", () => {
    const h = buildHeaders(base)
    expect(h["authorization"]).toBe("Bearer access-abc")
    expect(h["originator"]).toBe("codex_cli_rs")
    expect(h["OpenAI-Beta"]).toMatch(/^responses_websockets=\d{4}-\d{2}-\d{2}$/)
  })

  test("x-codex-turn-state flows through when provided", () => {
    const h = buildHeaders({ ...base, turnState: "turn-xyz" })
    expect(h["x-codex-turn-state"]).toBe("turn-xyz")
  })

  test("no accountId → no ChatGPT-Account-Id header at all", () => {
    const h = buildHeaders({ accessToken: "t", isWebSocket: true })
    expect(h["ChatGPT-Account-Id"]).toBeUndefined()
    expect(h["chatgpt-account-id"]).toBeUndefined()
  })

  test("WS path omits Content-Type and Accept (HTTP-only)", () => {
    const h = buildHeaders(base)
    expect(h["content-type"]).toBeUndefined()
    expect(h["Accept"]).toBeUndefined()
  })

  test("x-client-request-id = conversationId when provided (Phase 4)", () => {
    const h = buildHeaders({ ...base, conversationId: "conv-xyz" })
    expect(h["x-client-request-id"]).toBe("conv-xyz")
  })
})

describe("buildHeaders() HTTP path (Phase 4 additions)", () => {
  const base = {
    accessToken: "access-abc",
    accountId: "codex-subscription-test",
  }

  test("emits Content-Type application/json", () => {
    const h = buildHeaders(base)
    expect(h["content-type"]).toBe("application/json")
  })

  test("emits Accept text/event-stream (Phase 4)", () => {
    const h = buildHeaders(base)
    expect(h["Accept"]).toBe("text/event-stream")
  })

  test("x-client-request-id = conversationId when provided (Phase 4)", () => {
    const h = buildHeaders({ ...base, conversationId: "conv-xyz" })
    expect(h["x-client-request-id"]).toBe("conv-xyz")
  })

  test("no conversationId → no x-client-request-id header", () => {
    const h = buildHeaders(base)
    expect(h["x-client-request-id"]).toBeUndefined()
  })

  test("HTTP path does NOT emit OpenAI-Beta", () => {
    const h = buildHeaders(base)
    expect(h["OpenAI-Beta"]).toBeUndefined()
  })
})
