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

  it("always inherits parent model (no scoring, no downgrade)", async () => {
    const result = await selectOrchestratedModel({
      agentName: "coding",
      fallbackModel: { providerId: "anthropic", modelID: "claude-opus-4-5", accountId: "acct-1" },
      selectModel: async () => ({
        providerId: "anthropic",
        modelID: "claude-sonnet-4-5",
        accountId: "acct-1",
      }),
    })
    expect(result).toEqual({
      providerId: "anthropic",
      modelID: "claude-opus-4-5",
      accountId: "acct-1",
    })
  })

  it("allows explicit model override only if same provider+account", async () => {
    // Same provider — allowed
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        explicitModel: { providerId: "openai", modelID: "gpt-5" },
        fallbackModel: { providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" },
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5", accountId: "acct-session" })

    // Different provider — rejected, falls back to parent
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        explicitModel: { providerId: "github-copilot", modelID: "gpt-5" },
        fallbackModel: { providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" },
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" })
  })

  it("allows agent pinned model only if same provider+account", async () => {
    // Same provider — allowed
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        agentModel: { providerId: "openai", modelID: "gpt-5" },
        fallbackModel: { providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" },
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5", accountId: "acct-session" })

    // Different provider — rejected
    await expect(
      selectOrchestratedModel({
        agentName: "docs",
        agentModel: { providerId: "anthropic", modelID: "claude-opus-4-5" },
        fallbackModel: { providerId: "openai", modelID: "gpt-5", accountId: "acct-session" },
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5", accountId: "acct-session" })
  })

  it("rejects cross-account explicit model", async () => {
    await expect(
      selectOrchestratedModel({
        agentName: "coding",
        explicitModel: { providerId: "openai", modelID: "gpt-5", accountId: "acct-other" },
        fallbackModel: { providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" },
      }),
    ).resolves.toEqual({ providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" })
  })

  it("forces parent accountId on same-provider explicit models", async () => {
    const result = await orchestrateModelSelection({
      agentName: "coding",
      explicitModel: { providerId: "openai", modelID: "gpt-5" },
      fallbackModel: { providerId: "openai", modelID: "gpt-5.4", accountId: "acct-session" },
    })
    expect(result.model.accountId).toBe("acct-session")
    expect(result.trace.selected.source).toBe("explicit")
  })

  it("produces parent_inherit trace when no overrides", async () => {
    const result = await orchestrateModelSelection({
      agentName: "docs",
      fallbackModel: { providerId: "openai", modelID: "gpt-5", accountId: "acct-1" },
    })
    expect(result).toEqual({
      model: { providerId: "openai", modelID: "gpt-5", accountId: "acct-1" },
      trace: {
        agentName: "docs",
        domain: "docs",
        selected: { providerId: "openai", modelID: "gpt-5", accountId: "acct-1", source: "parent_inherit" },
        candidates: [
          { providerId: "openai", modelID: "gpt-5", accountId: "acct-1", source: "parent_inherit", operational: true },
        ],
      },
    })
  })

  it("ignores scoring and rotation entirely", async () => {
    // Even with a scoring function that returns a different model, parent wins
    const result = await selectOrchestratedModel({
      agentName: "review",
      fallbackModel: { providerId: "openai", modelID: "gpt-5", accountId: "acct-1" },
      selectModel: async () => ({
        providerId: "openai",
        modelID: "gpt-3.5-turbo",
        accountId: "acct-1",
      }),
      isOperationalModel: async () => true,
      findOperationalFallback: async () => ({
        providerId: "google",
        modelID: "gemini-2.5-pro",
        accountId: "team-b",
      }),
    })
    expect(result).toEqual({
      providerId: "openai",
      modelID: "gpt-5",
      accountId: "acct-1",
    })
  })
})
