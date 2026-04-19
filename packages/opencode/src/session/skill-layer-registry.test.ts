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

  it("applies billing-gated idle transitions and keeps pin session-scoped", () => {
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

    const tokenResult = SkillLayerRegistry.listForInjection(sessionID, { billingMode: "token", now })
    const planner = tokenResult.find((x) => x.name === "planner")
    const doc = tokenResult.find((x) => x.name === "doc-coauthoring")

    expect(planner?.desiredState).toBe("absent")
    expect(planner?.runtimeState).toBe("unloaded")
    expect(planner?.residue?.skillName).toBe("planner")
    expect(doc?.desiredState).toBe("full")
    expect(doc?.runtimeState).toBe("sticky")

    SkillLayerRegistry.unpin(sessionID, "doc-coauthoring")
    const requestResult = SkillLayerRegistry.listForInjection(sessionID, { billingMode: "request", now })
    const docAfterUnpin = requestResult.find((x) => x.name === "doc-coauthoring")
    expect(docAfterUnpin?.desiredState).toBe("full")
    expect(docAfterUnpin?.runtimeState).toBe("active")
    expect(docAfterUnpin?.lastReason).toBe("request_billed_keep_full")
  })

  it("fails fast when mutating non-existent entries", () => {
    const sessionID = `ses_registry_missing_${Date.now().toString(36)}`
    expect(() => SkillLayerRegistry.pin(sessionID, "planner")).toThrow("skill layer session registry missing")
  })

  it("TV12: pinned entry survives 35min idle under token billing (no decay)", () => {
    const sessionID = `ses_registry_pinned_aged_${Date.now().toString(36)}`
    const now = Date.now()
    const thirtyFiveMinutesAgo = now - 35 * 60 * 1000

    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", {
      content: "plan-builder-content",
      now: thirtyFiveMinutesAgo,
    })
    SkillLayerRegistry.pin(sessionID, "plan-builder", thirtyFiveMinutesAgo)

    const result = SkillLayerRegistry.listForInjection(sessionID, { billingMode: "token", now })
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
