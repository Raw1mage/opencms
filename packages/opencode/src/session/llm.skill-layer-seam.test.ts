import { expect, it, describe } from "bun:test"
import { buildSkillLayerRegistrySystemPart } from "./skill-layer-seam"
import { SkillLayerRegistry } from "./skill-layer-registry"

describe("LLM skill layer registry seam", () => {
  it("renders full and summary entries for managed injection", () => {
    expect(buildSkillLayerRegistrySystemPart([])).toEqual({
      key: "skill_layer_registry",
      name: "Skill 層",
      policy: "registry_seam_empty",
      text: "",
    })

    const result = buildSkillLayerRegistrySystemPart([
      {
        name: "planner",
        content: "planner content",
        purpose: "planning",
        keepRules: ["retain:planner"],
        loadedAt: 1,
        lastUsedAt: 2,
        runtimeState: "active",
        desiredState: "full",
        pinned: false,
        lastReason: "relevance_keep_full",
      },
      {
        name: "example-summarized-skill",
        content: "ignored when summary",
        purpose: "workflow",
        keepRules: ["retain:workflow"],
        loadedAt: 3,
        lastUsedAt: 4,
        runtimeState: "summarized",
        desiredState: "summary",
        pinned: false,
        lastReason: "idle_summarize",
        residue: {
          skillName: "example-summarized-skill",
          purpose: "workflow",
          keepRules: ["retain:workflow"],
          lastReason: "idle_summarize",
          loadedAt: 3,
          lastUsedAt: 4,
        },
      },
    ])

    expect(result.policy).toBe("registry_seam_loaded:2:full=1:summary=1")
    expect(result.text).toContain('<skill_layer name="planner" state="full"')
    expect(result.text).toContain('<skill_layer_summary name="example-summarized-skill" state="summary"')
  })

  it("keeps absent entries out of prompt text", () => {
    const result = buildSkillLayerRegistrySystemPart([
      {
        name: "planner",
        content: "planner content",
        purpose: "planning",
        keepRules: [],
        loadedAt: 1,
        lastUsedAt: 2,
        runtimeState: "unloaded",
        desiredState: "absent",
        pinned: false,
        lastReason: "idle_unload",
        residue: {
          skillName: "planner",
          purpose: "planning",
          keepRules: [],
          lastReason: "idle_unload",
          loadedAt: 1,
          lastUsedAt: 2,
        },
      },
    ])

    expect(result).toEqual({
      key: "skill_layer_registry",
      name: "Skill 層",
      policy: "registry_seam_loaded:1:full=0:summary=0",
      text: "",
    })
  })

  it("fades a loaded skill purely on idle, with no billing input", () => {
    // The seam carries whatever listForInjection decides. Decay is billing-
    // independent now: a loaded skill is kept full while recent, then fades
    // (summary→unload) on idle alone — no billing mode is consulted.
    const sessionID = "seam-test-idle-fade"
    const now = Date.now()
    SkillLayerRegistry.recordLoaded(sessionID, "test-skill", { content: "content", now })

    const freshEntry = SkillLayerRegistry.listForInjection(sessionID, { now }).find((e) => e.name === "test-skill")
    expect(freshEntry?.runtimeState).toBe("active")
    expect(freshEntry?.lastReason).toBe("recently_used")

    const later = now + 1000 * 60 * 60 * 2 // 2 hours idle
    const agedEntry = SkillLayerRegistry.listForInjection(sessionID, { now: later }).find((e) => e.name === "test-skill")
    expect(agedEntry?.desiredState).toBe("absent")
    expect(agedEntry?.runtimeState).toBe("unloaded")
    expect(agedEntry?.lastReason).toBe("idle_unload")

    SkillLayerRegistry.clear(sessionID)
  })
})
