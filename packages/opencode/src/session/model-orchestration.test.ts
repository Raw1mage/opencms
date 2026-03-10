import { describe, expect, it } from "bun:test"
import {
  domainForAgent,
  orchestrateModelSelection,
  selectOrchestratedModel,
  shouldAutoSwitchMainModel,
} from "./model-orchestration"

describe("session model orchestration", () => {
  it("maps agent names to orchestration domains", () => {
    expect(domainForAgent("review")).toBe("review")
    expect(domainForAgent("testing")).toBe("testing")
    expect(domainForAgent("docs")).toBe("docs")
    expect(domainForAgent("explore")).toBe("explore")
    expect(domainForAgent("build")).toBe("coding")
  })

  it("only auto-switches main model for autonomous synthetic turns", () => {
    expect(
      shouldAutoSwitchMainModel({
        session: {
          workflow: {
            autonomous: {
              enabled: true,
              stopOnTestsFail: true,
              requireApprovalFor: ["push", "destructive", "architecture_change"],
            },
            state: "waiting_user",
            updatedAt: 1,
          },
        },
        lastUserParts: [
          {
            id: "part_1",
            messageID: "message_1",
            sessionID: "session_1",
            type: "text",
            text: "continue",
            synthetic: true,
          },
        ],
      }),
    ).toBe(true)

    expect(
      shouldAutoSwitchMainModel({
        session: {
          workflow: {
            autonomous: {
              enabled: true,
              stopOnTestsFail: true,
              requireApprovalFor: ["push", "destructive", "architecture_change"],
            },
            state: "waiting_user",
            updatedAt: 1,
          },
        },
        lastUserParts: [
          {
            id: "part_2",
            messageID: "message_2",
            sessionID: "session_1",
            type: "text",
            text: "continue",
          },
        ],
      }),
    ).toBe(false)
  })

  it("preserves explicit and agent model precedence before scored fallback", async () => {
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        explicitModel: { providerId: "openai", modelID: "gpt-5" },
        agentModel: { providerId: "google", modelID: "gemini-2.5-pro" },
        fallbackModel: { providerId: "anthropic", modelID: "claude-sonnet-4-5" },
        selectModel: async () => ({
          providerId: "google",
          modelID: "gemini-2.5-pro",
          accountId: "public",
        }),
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5" })

    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        agentModel: { providerId: "google", modelID: "gemini-2.5-pro" },
        fallbackModel: { providerId: "anthropic", modelID: "claude-sonnet-4-5" },
        selectModel: async () => ({
          providerId: "openai",
          modelID: "gpt-5",
          accountId: "public",
        }),
      }),
    ).resolves.toEqual({ providerId: "google", modelID: "gemini-2.5-pro" })
  })

  it("uses scored fallback when no explicit or agent model is pinned", async () => {
    await expect(
      selectOrchestratedModel({
        agentName: "docs",
        fallbackModel: { providerId: "openai", modelID: "gpt-5" },
        selectModel: async () => ({
          providerId: "anthropic",
          modelID: "claude-opus-4-5",
          accountId: "team-a",
        }),
      }),
    ).resolves.toEqual({
      providerId: "anthropic",
      modelID: "claude-opus-4-5",
      accountId: "team-a",
    })
  })

  it("falls back to the caller model when the scored candidate is not operational", async () => {
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        fallbackModel: { providerId: "openai", modelID: "gpt-5" },
        selectModel: async () => ({
          providerId: "anthropic",
          modelID: "claude-opus-4-5",
          accountId: "team-a",
        }),
        isOperationalModel: async (model) => model.providerId === "openai",
        findOperationalFallback: async () => null,
      }),
    ).resolves.toEqual({
      providerId: "openai",
      modelID: "gpt-5",
    })
  })

  it("uses rotation fallback rescue when both scored and current models are unhealthy", async () => {
    await expect(
      selectOrchestratedModel({
        agentName: "review",
        fallbackModel: { providerId: "openai", modelID: "gpt-5" },
        selectModel: async () => ({
          providerId: "anthropic",
          modelID: "claude-opus-4-5",
          accountId: "team-a",
        }),
        isOperationalModel: async () => false,
        findOperationalFallback: async () => ({
          providerId: "google",
          modelID: "gemini-2.5-pro",
          accountId: "team-b",
        }),
      }),
    ).resolves.toEqual({
      providerId: "google",
      modelID: "gemini-2.5-pro",
      accountId: "team-b",
    })
  })

  it("preserves accountId in explicit and fallback arbitration traces", async () => {
    await expect(
      orchestrateModelSelection({
        agentName: "coding",
        explicitModel: { providerId: "openai", modelID: "gpt-5", accountId: "acct-explicit" },
        fallbackModel: { providerId: "anthropic", modelID: "claude-sonnet-4-5", accountId: "acct-fallback" },
      }),
    ).resolves.toEqual({
      model: { providerId: "openai", modelID: "gpt-5", accountId: "acct-explicit" },
      trace: {
        agentName: "coding",
        domain: "coding",
        selected: { providerId: "openai", modelID: "gpt-5", accountId: "acct-explicit", source: "explicit" },
        candidates: [{ providerId: "openai", modelID: "gpt-5", accountId: "acct-explicit", source: "explicit" }],
      },
    })
  })

  it("produces a readable arbitration trace for downstream UI", async () => {
    await expect(
      orchestrateModelSelection({
        agentName: "docs",
        fallbackModel: { providerId: "openai", modelID: "gpt-5" },
        selectModel: async () => ({
          providerId: "anthropic",
          modelID: "claude-opus-4-5",
          accountId: "team-a",
        }),
        isOperationalModel: async (model) => model.providerId === "openai",
        findOperationalFallback: async () => ({ providerId: "google", modelID: "gemini-2.5-pro", accountId: "team-b" }),
      }),
    ).resolves.toEqual({
      model: { providerId: "openai", modelID: "gpt-5" },
      trace: {
        agentName: "docs",
        domain: "docs",
        selected: { providerId: "openai", modelID: "gpt-5", source: "fallback" },
        candidates: [
          {
            providerId: "anthropic",
            modelID: "claude-opus-4-5",
            accountId: "team-a",
            source: "scored",
            operational: false,
          },
          { providerId: "openai", modelID: "gpt-5", source: "fallback", operational: true },
        ],
      },
    })
  })
})
