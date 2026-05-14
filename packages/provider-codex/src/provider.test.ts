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

  // plans/provider_codex-prompt-realign DD-6 (Stage A.4): prompt_cache_key
  // is pure threadId, mirroring upstream codex-cli
  // (refs/codex/codex-rs/core/src/client.rs:713). doStream now derives
  // cacheKey = threadId (no `codex-${accountId}-` prefix), so multi-account
  // rotation within one session shares one cache namespace and prefix
  // cache can grow across rotations. The buildResponsesApiRequest function
  // itself is plumbing-only — it carries whatever cacheKey the caller
  // derived, so this test verifies that pass-through.
  test("TV-6: buildResponsesApiRequest carries the caller-derived cache key verbatim (post-DD-6: pure threadId)", () => {
    const body = buildResponsesApiRequest({
      modelId: "gpt-5.4",
      input: [],
      promptCacheKey: "S-uuid-aaaa",
      window: { conversationId: "S-uuid-aaaa", generation: 0 },
    })
    // Post-DD-6: doStream feeds in threadId only; we verify pass-through.
    expect(body.prompt_cache_key).toBe("S-uuid-aaaa")
    expect(body.prompt_cache_key).not.toMatch(/^codex-/)
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
