import * as fs from "fs/promises"
import * as path from "path"

export interface FreerunMetricsSummary {
  planningValidationFailures: number
  noMetaIcomRejects: number
  pickNextDecisions: number
  nodeTransitions: number
  consolidationEvents: number
  recentValidationErrors: string[]
}

export interface FreerunEventRecord {
  type?: string
  properties?: Record<string, unknown>
}

export async function readFreerunEventRecords(sessionID: string, dataHome: string): Promise<FreerunEventRecord[]> {
  const filePath = path.join(dataHome, "storage", "freerun", sessionID, "events.jsonl")
  let text: string
  try {
    text = await fs.readFile(filePath, "utf-8")
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }

  const records: FreerunEventRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      records.push(JSON.parse(line) as FreerunEventRecord)
    } catch {
      records.push({
        type: "freerun.metrics.invalidEventRecord",
        properties: { errors: ["invalid events.jsonl line"] },
      })
    }
  }
  return records
}

export function summarizeFreerunEvents(records: FreerunEventRecord[]): FreerunMetricsSummary {
  const summary: FreerunMetricsSummary = {
    planningValidationFailures: 0,
    noMetaIcomRejects: 0,
    pickNextDecisions: 0,
    nodeTransitions: 0,
    consolidationEvents: 0,
    recentValidationErrors: [],
  }

  for (const record of records) {
    const properties = record.properties ?? {}
    if (record.type === "freerun.llm.validationRetry" || record.type === "freerun.iteration.halted") {
      summary.planningValidationFailures++
      for (const error of readErrors(properties)) {
        if (/meta-icom|no meta/i.test(error)) summary.noMetaIcomRejects++
        summary.recentValidationErrors.push(error)
      }
    }
    if (record.type === "freerun.iteration.start") summary.pickNextDecisions++
    if (record.type === "freerun.node.stateTransition") summary.nodeTransitions++
    if (record.type === "freerun.consolidation.performed") summary.consolidationEvents++
  }

  summary.recentValidationErrors = summary.recentValidationErrors.slice(-5)
  return summary
}

function readErrors(properties: Record<string, unknown>) {
  const raw = properties.validationErrors ?? properties.errors ?? []
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}
