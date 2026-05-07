/**
 * provider.test.ts — Verify request body assembly matches golden format.
 *
 * Tests the CodexLanguageModel request body construction against
 * golden-request.json top-level fields.
 */
import { describe, test, expect } from "bun:test"
import { buildResponsesApiRequest, createCodex } from "./provider"

// Mock credentials that skip token refresh
const mockCredentials = {
  access: "mock-access-token",
  refresh: "mock-refresh-token",
  expires: Date.now() + 3600000, // 1 hour from now
  accountId: "acct_test123",
}

describe("CodexLanguageModel request body", () => {
  test("top-level fields match golden structure", async () => {
    const provider = createCodex({
      credentials: mockCredentials,
      sessionId: "ses_test",
      installationId: "inst_test",
    })

    const model = provider.languageModel("gpt-5.4")

    // We can't call doStream without a real server, but we can verify
    // the model instance was created correctly
    expect(model.modelId).toBe("gpt-5.4")
    expect(model.provider).toBe("codex")
    expect(model.specificationVersion).toBe("v2")
  })

  test("buildResponsesApiRequest pins Mode 1 context_management shape", () => {
    const body = buildResponsesApiRequest({
      modelId: "gpt-5.4",
      instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      promptCacheKey: "codex-acct-ses",
      installationId: "inst_test",
      window: { conversationId: "ses_test", generation: 0 },
    })

    expect(body.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: expect.any(Number),
      },
    ])
    expect(body.context_management?.[0]?.compact_threshold).toBeGreaterThan(0)
    expect(body.stream).toBeUndefined()
    expect(body.prompt_cache_key).toBe("codex-acct-ses")
    expect(body.store).toBe(false)
  })

  // codex-update plan §2: prompt_cache_key sources from thread_id (upstream
  // a98623511b: prompt_cache_key = self.state.thread_id.to_string()).
  // For single-thread callers (default) threadId == sessionId, so the existing
  // composite cache key ("codex-{accountId}-{sessionId}") is preserved bit-for-bit;
  // when an explicit threadId is supplied (multi-thread future use), the composite
  // tracks threadId instead. INV-3.
  test("TV-6: default cache key follows threadId (== sessionId by DD-1) — buildResponsesApiRequest plumbing", () => {
    // doStream constructs `codex-{accountId}-{threadId}` where threadId defaults to
    // sessionId. We verify the body field carries whatever the caller derived.
    const body = buildResponsesApiRequest({
      modelId: "gpt-5.4",
      input: [],
      promptCacheKey: "codex-acct_test123-S-uuid-aaaa",
      window: { conversationId: "S-uuid-aaaa", generation: 0 },
    })
    expect(body.prompt_cache_key).toBe("codex-acct_test123-S-uuid-aaaa")
  })

  test("TV-7: explicit promptCacheKey override wins over threadId default", () => {
    const body = buildResponsesApiRequest({
      modelId: "gpt-5.4",
      input: [],
      promptCacheKey: "codex-acct_test123-S-uuid-aaaa",
      window: { conversationId: "T-uuid-bbbb", generation: 0 },
      providerOptions: {
        promptCacheKey: "custom-key",
      },
    })
    expect(body.prompt_cache_key).toBe("custom-key")
  })

  test("buildResponsesApiRequest preserves provider options around Mode 1 shape", () => {
    const body = buildResponsesApiRequest({
      modelId: "gpt-5.4",
      input: [],
      promptCacheKey: "default-key",
      window: { conversationId: "ses_test", generation: 2 },
      providerOptions: {
        promptCacheKey: "custom-key",
        store: true,
        serviceTier: "flex",
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        textVerbosity: "low",
      },
    })

    expect(body.prompt_cache_key).toBe("custom-key")
    expect(body.store).toBe(true)
    expect(body.service_tier).toBe("flex")
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" })
    expect(body.text).toEqual({ verbosity: "low" })
    expect(body.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: expect.any(Number),
      },
    ])
  })
})
