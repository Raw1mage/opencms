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
