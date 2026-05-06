/**
 * empty-turn-classifier.test.ts — Verify Phase 1 stub coverage.
 *
 * Spec: codex-empty-turn-recovery
 * Phase 1 contract (DD-12): every input MUST return
 *   {causeFamily: "unclassified", recoveryAction: "pass-through-to-runloop-nudge", suspectParams: []}
 * Phase 2 will replace the stub with predicates per DD-9.
 *
 * Covers:
 * - Stub returns unclassified for every snapshot variation
 * - INV-12: pure function (deterministic, no side effects)
 * - INV-13: causeFamily enum values match data-schema.json
 * - INV-14: recoveryAction enum closed; hard-error not present
 * - buildClassificationPayload assembles all data-schema.json fields correctly
 */
import { describe, test, expect } from "bun:test"
import {
  classifyEmptyTurn,
  buildClassificationPayload,
  CAUSE_FAMILY,
  RECOVERY_ACTION,
  type EmptyTurnSnapshot,
} from "./empty-turn-classifier"

function baseSnapshot(overrides: Partial<EmptyTurnSnapshot> = {}): EmptyTurnSnapshot {
  return {
    wsFrameCount: 0,
    terminalEventReceived: false,
    terminalEventType: null,
    wsCloseCode: null,
    wsCloseReason: null,
    serverErrorMessage: null,
    deltasObserved: { text: 0, toolCallArguments: 0, reasoning: 0 },
    requestOptionsShape: {
      store: false,
      hasReasoningEffort: false,
      reasoningEffortValue: null,
      includeFields: [],
      hasTools: false,
      toolCount: 0,
      promptCacheKeyHash: "0000000000000000",
      inputItemCount: 0,
      instructionsByteSize: 0,
    },
    retryAttempted: false,
    ...overrides,
  }
}

describe("Phase 1 stub: every input → unclassified + pass-through", () => {
  const variations: { name: string; snap: EmptyTurnSnapshot }[] = [
    { name: "fully empty (default)", snap: baseSnapshot() },
    {
      name: "ws_truncation pattern",
      snap: baseSnapshot({ wsFrameCount: 5, terminalEventReceived: false, wsCloseCode: 1006 }),
    },
    {
      name: "ws_no_frames pattern",
      snap: baseSnapshot({ wsFrameCount: 0, terminalEventReceived: false, wsCloseCode: 1006 }),
    },
    {
      name: "server_empty_output_with_reasoning pattern",
      snap: baseSnapshot({
        wsFrameCount: 4,
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          hasReasoningEffort: true,
          reasoningEffortValue: "high",
          includeFields: ["reasoning.encrypted_content"],
        },
      }),
    },
    {
      name: "server_incomplete pattern",
      snap: baseSnapshot({
        wsFrameCount: 3,
        terminalEventReceived: true,
        terminalEventType: "response.incomplete",
        serverErrorMessage: "max_output_tokens",
      }),
    },
    {
      name: "server_failed pattern",
      snap: baseSnapshot({
        wsFrameCount: 2,
        terminalEventReceived: true,
        terminalEventType: "response.failed",
        serverErrorMessage: "Model overloaded",
      }),
    },
    {
      name: "retry attempt",
      snap: baseSnapshot({ wsFrameCount: 5, retryAttempted: true }),
    },
  ]

  for (const v of variations) {
    test(v.name, () => {
      const result = classifyEmptyTurn(v.snap)
      expect(result.causeFamily).toBe(CAUSE_FAMILY.UNCLASSIFIED)
      expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
      expect(result.suspectParams).toEqual([])
    })
  }
})

describe("INV-12 pure function (deterministic)", () => {
  test("same input → identical output across 100 calls", () => {
    const snap = baseSnapshot({ wsFrameCount: 3, terminalEventReceived: true })
    const ref = classifyEmptyTurn(snap)
    for (let i = 0; i < 100; i++) {
      const r = classifyEmptyTurn(snap)
      expect(r).toEqual(ref)
    }
  })

  test("no mutation of input snapshot", () => {
    const snap = baseSnapshot({ wsFrameCount: 5 })
    const before = JSON.parse(JSON.stringify(snap))
    classifyEmptyTurn(snap)
    expect(snap).toEqual(before)
  })
})

describe("INV-13 / INV-14 enum stability", () => {
  test("CAUSE_FAMILY contains exactly the 6 documented values", () => {
    expect(Object.values(CAUSE_FAMILY).sort()).toEqual(
      [
        "server_empty_output_with_reasoning",
        "server_failed",
        "server_incomplete",
        "unclassified",
        "ws_no_frames",
        "ws_truncation",
      ].sort(),
    )
  })

  test("RECOVERY_ACTION contains exactly the 4 documented values; hard-error excluded", () => {
    const values = Object.values(RECOVERY_ACTION)
    expect(values.sort()).toEqual(
      [
        "log-and-continue",
        "pass-through-to-runloop-nudge",
        "retry-once-then-soft-fail",
        "synthesize-from-deltas",
      ].sort(),
    )
    // INV-01 / INV-14: hard-error MUST NEVER appear
    expect(values).not.toContain("hard-error")
    expect(values).not.toContain("error")
    expect(values).not.toContain("throw")
  })
})

describe("buildClassificationPayload assembly", () => {
  test("payload includes all snapshot fields + classification + retry context", () => {
    const snap = baseSnapshot({
      wsFrameCount: 7,
      terminalEventReceived: true,
      terminalEventType: "response.completed",
      wsCloseCode: 1000,
      wsCloseReason: "normal closure",
      serverErrorMessage: null,
      deltasObserved: { text: 0, toolCallArguments: 0, reasoning: 2 },
    })
    const result = classifyEmptyTurn(snap)
    const payload = buildClassificationPayload(snap, result, {
      retryAlsoEmpty: true,
      previousLogSequence: 42,
    })
    expect(payload.schemaVersion).toBe(1)
    expect(payload.causeFamily).toBe(CAUSE_FAMILY.UNCLASSIFIED)
    expect(payload.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
    expect(payload.suspectParams).toEqual([])
    expect(payload.wsFrameCount).toBe(7)
    expect(payload.terminalEventReceived).toBe(true)
    expect(payload.terminalEventType).toBe("response.completed")
    expect(payload.wsCloseCode).toBe(1000)
    expect(payload.wsCloseReason).toBe("normal closure")
    expect(payload.deltasObserved).toEqual({ text: 0, toolCallArguments: 0, reasoning: 2 })
    expect(payload.requestOptionsShape).toEqual(snap.requestOptionsShape)
    expect(payload.retryAttempted).toBe(false)
    expect(payload.retryAlsoEmpty).toBe(true)
    expect(payload.previousLogSequence).toBe(42)
  })

  test("default retry context: retryAlsoEmpty and previousLogSequence are null", () => {
    const snap = baseSnapshot()
    const payload = buildClassificationPayload(snap, classifyEmptyTurn(snap))
    expect(payload.retryAlsoEmpty).toBe(null)
    expect(payload.previousLogSequence).toBe(null)
  })
})
