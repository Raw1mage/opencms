import { BusEvent } from "@/bus/bus-event"
import { Bus } from "../index"
import { RuntimeEventService, TelemetryProjector } from "@/system/runtime-event-service"
import z from "zod"

const SUPPORTED_TYPES = new Set([
  "llm.prompt.telemetry",
  "session.round.telemetry",
  "session.compaction.telemetry",
  "rotation.executed",
  "continuation.dispatched",
])

export const SessionTelemetryUpdatedEvent = BusEvent.define(
  "session.telemetry.updated",
  z.object({
    sessionID: z.string(),
    telemetry: z.record(z.string(), z.any()),
  }),
)

function getSessionID(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined
  const sessionID = (properties as Record<string, unknown>).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

async function handleEvent(event: { type: string; properties?: unknown }) {
  if (!SUPPORTED_TYPES.has(event.type)) return
  const sessionID = getSessionID(event.properties)
  if (!sessionID) return
  await RuntimeEventService.append({
    sessionID,
    level: "info",
    domain: "telemetry",
    eventType: event.type,
    anomalyFlags: [],
    payload:
      event.properties && typeof event.properties === "object" ? (event.properties as Record<string, unknown>) : {},
  }).catch(() => undefined)
  const telemetry = await TelemetryProjector.project(sessionID).catch(() => undefined)
  if (!telemetry) return
  await Bus.publish(SessionTelemetryUpdatedEvent, {
    sessionID,
    telemetry: telemetry as Record<string, unknown>,
  }).catch(() => undefined)
}

let registered = false

export function registerTelemetryRuntimePersistence() {
  if (registered) return
  registered = true
  Bus.subscribeGlobal("*", 0, handleEvent)
}
