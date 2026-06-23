import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { SkillLayerRegistry } from "./skill-layer-registry"

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    info: z.object({
      id: Identifier.schema("session"),
    }),
  }),
)

describe("skill layer registry", () => {
  afterEach(() => {
    SkillLayerRegistry.reset()
  })

  it("cleans up session entries when the session is deleted", async () => {
    const sessionID = `ses_registry_cleanup_${Date.now().toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "planner", {
      content: "planner-content",
    })
    expect(SkillLayerRegistry.list(sessionID)).toHaveLength(1)

    await Bus.publish(SessionDeletedEvent, {
      info: {
        id: sessionID,
      },
    })

    expect(SkillLayerRegistry.list(sessionID)).toEqual([])
  })

  it("applies idle decay (summary→unload) and keeps pin session-scoped", () => {
    const sessionID = `ses_registry_policy_${Date.now().toString(36)}`
    const now = Date.now()

    SkillLayerRegistry.recordLoaded(sessionID, "planner", {
      content: "planner-content",
      keepRules: ["preserve safety style"],
      now: now - 35 * 60 * 1000,
    })

    SkillLayerRegistry.recordLoaded(sessionID, "doc-coauthoring", {
      content: "doc-content",
      now,
    })
    SkillLayerRegistry.pin(sessionID, "doc-coauthoring", now)

    const result = SkillLayerRegistry.listForInjection(sessionID, { now })
    const planner = result.find((x) => x.name === "planner")
    const doc = result.find((x) => x.name === "doc-coauthoring")

    expect(planner?.desiredState).toBe("absent")
    expect(planner?.runtimeState).toBe("unloaded")
    expect(planner?.residue?.skillName).toBe("planner")
    expect(doc?.desiredState).toBe("full")
    expect(doc?.runtimeState).toBe("sticky")

    // After unpin, a freshly-loaded (idle 0) skill is recently-used → active.
    SkillLayerRegistry.unpin(sessionID, "doc-coauthoring")
    const afterUnpin = SkillLayerRegistry.listForInjection(sessionID, { now })
    const docAfterUnpin = afterUnpin.find((x) => x.name === "doc-coauthoring")
    expect(docAfterUnpin?.desiredState).toBe("full")
    expect(docAfterUnpin?.runtimeState).toBe("active")
    expect(docAfterUnpin?.lastReason).toBe("recently_used")
  })

  it("idle decay is billing-independent: summarize then unload purely on idle", () => {
    // Root cause: decay used to sit behind a `billingMode === "token"` gate, so
    // request/unknown providers (the OAuth Claude path resolves to "unknown")
    // never decayed and held loaded skills full forever. The fade is now purely
    // idle-based, with no billing input at all.
    const now = Date.now()

    const fresh = `ses_decay_fresh_${now.toString(36)}`
    SkillLayerRegistry.recordLoaded(fresh, "doc-workflow", { content: "dw", now })
    expect(SkillLayerRegistry.listForInjection(fresh, { now })[0]?.lastReason).toBe("recently_used")

    const mid = `ses_decay_mid_${now.toString(36)}`
    SkillLayerRegistry.recordLoaded(mid, "doc-workflow", { content: "dw", now: now - 15 * 60 * 1000 })
    const midEntry = SkillLayerRegistry.listForInjection(mid, { now })[0]
    expect(midEntry?.runtimeState).toBe("summarized")
    expect(midEntry?.lastReason).toBe("idle_summarize")

    const aged = `ses_decay_aged_${now.toString(36)}`
    SkillLayerRegistry.recordLoaded(aged, "doc-workflow", { content: "dw", now: now - 35 * 60 * 1000 })
    const agedEntry = SkillLayerRegistry.listForInjection(aged, { now })[0]
    expect(agedEntry?.runtimeState).toBe("unloaded")
    expect(agedEntry?.lastReason).toBe("idle_unload")
    expect(agedEntry?.residue?.skillName).toBe("doc-workflow")
  })

  it("presentSkillNames reflects only skills currently in context (gate #1 signal)", () => {
    const now = Date.now()
    const sessionID = `ses_registry_present_${now.toString(36)}`

    // pinned → sticky → present
    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", { content: "pb", now })
    SkillLayerRegistry.pin(sessionID, "plan-builder", now)
    // freshly loaded → active → present
    SkillLayerRegistry.recordLoaded(sessionID, "doc-workflow", { content: "dw", now })
    // 15min idle → summarized → NOT present
    SkillLayerRegistry.recordLoaded(sessionID, "code-thinker", { content: "ct", now: now - 15 * 60 * 1000 })
    // 35min idle → unloaded → NOT present
    SkillLayerRegistry.recordLoaded(sessionID, "miatdiagram", { content: "md", now: now - 35 * 60 * 1000 })

    SkillLayerRegistry.listForInjection(sessionID, { now })

    const present = SkillLayerRegistry.presentSkillNames(sessionID)
    expect(present.has("plan-builder")).toBe(true)
    expect(present.has("doc-workflow")).toBe(true)
    expect(present.has("code-thinker")).toBe(false)
    expect(present.has("miatdiagram")).toBe(false)
  })

  it("touch keep-alive prevents idle-unload of an actively-used skill (no sawtooth)", () => {
    const now = Date.now()
    const sessionID = `ses_registry_touch_${now.toString(36)}`

    // Loaded 29min ago; the model has kept calling its toolchain, which the
    // llm.ts keep-alive translates into touch() — refreshing the idle clock.
    SkillLayerRegistry.recordLoaded(sessionID, "doc-workflow", {
      content: "dw",
      now: now - 29 * 60 * 1000,
    })
    expect(SkillLayerRegistry.touch(sessionID, "doc-workflow", now)).toBe(true)

    // 6min later (35min since load, but only 6min since touch) → still active.
    const later = now + 6 * 60 * 1000
    SkillLayerRegistry.listForInjection(sessionID, { now: later })
    const entry = SkillLayerRegistry.list(sessionID).find((e) => e.name === "doc-workflow")
    expect(entry?.runtimeState).toBe("active")
    expect(SkillLayerRegistry.presentSkillNames(sessionID).has("doc-workflow")).toBe(true)
  })

  it("touch stops → skill decays normally once it falls out of use", () => {
    const now = Date.now()
    const sessionID = `ses_registry_touch_stop_${now.toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "doc-workflow", { content: "dw", now })

    // No further touches; 31min later the idle clock crosses the unload line.
    const later = now + 31 * 60 * 1000
    SkillLayerRegistry.listForInjection(sessionID, { now: later })
    const entry = SkillLayerRegistry.list(sessionID).find((e) => e.name === "doc-workflow")
    expect(entry?.runtimeState).toBe("unloaded")
    expect(SkillLayerRegistry.presentSkillNames(sessionID).has("doc-workflow")).toBe(false)
  })

  it("touch is a no-op on a missing entry", () => {
    const sessionID = `ses_registry_touch_missing_${Date.now().toString(36)}`
    expect(SkillLayerRegistry.touch(sessionID, "ghost")).toBe(false)
  })

  it("fails fast when mutating non-existent entries", () => {
    const sessionID = `ses_registry_missing_${Date.now().toString(36)}`
    expect(() => SkillLayerRegistry.pin(sessionID, "planner")).toThrow("skill layer session registry missing")
  })

  it("TV12: pinned entry survives 35min idle (no decay)", () => {
    const sessionID = `ses_registry_pinned_aged_${Date.now().toString(36)}`
    const now = Date.now()
    const thirtyFiveMinutesAgo = now - 35 * 60 * 1000

    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", {
      content: "plan-builder-content",
      now: thirtyFiveMinutesAgo,
    })
    SkillLayerRegistry.pin(sessionID, "plan-builder", thirtyFiveMinutesAgo)

    const result = SkillLayerRegistry.listForInjection(sessionID, { now })
    const entry = result.find((x) => x.name === "plan-builder")

    expect(entry?.pinned).toBe(true)
    expect(entry?.runtimeState).toBe("sticky")
    expect(entry?.desiredState).toBe("full")
    expect(entry?.lastReason).toBe("session_pinned_keep_full")
  })

  it("peek returns undefined for missing entry, entry for existing", () => {
    const sessionID = `ses_registry_peek_${Date.now().toString(36)}`
    expect(SkillLayerRegistry.peek(sessionID, "ghost")).toBeUndefined()
    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", { content: "x" })
    const entry = SkillLayerRegistry.peek(sessionID, "plan-builder")
    expect(entry?.name).toBe("plan-builder")
    expect(entry?.content).toBe("x")
  })
})
