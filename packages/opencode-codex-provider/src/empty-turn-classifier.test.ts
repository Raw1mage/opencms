/**
 * empty-turn-classifier.test.ts — Verify Phase 2 predicate ladder.
 *
 * Spec: codex-empty-turn-recovery
 * Phase 2 contract (DD-9 mapping table): inputs match one of 6 cause families;
 * the unclassified residue is the explicit fallback when no predicate matches.
 *
 * Covers:
 * - DD-9: each cause-family predicate selects the right family + action
 * - INV-11: suspectParams truthfully reflects request body (B/C signal)
 * - INV-12: pure function (deterministic, no side effects)
 * - INV-13: causeFamily enum values match data-schema.json
 * - INV-14: recoveryAction enum closed; hard-error not present
 * - Predicate ordering: server_* takes precedence over ws_* when terminal arrived
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

describe("DD-9 predicate ladder per cause family", () => {
  test("ws_truncation: frames received but no terminal event", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({ wsFrameCount: 5, terminalEventReceived: false, wsCloseCode: 1006 }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.WS_TRUNCATION)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.RETRY_ONCE_THEN_SOFT_FAIL)
    expect(result.suspectParams).toEqual([])
  })

  test("ws_no_frames: connection lost before any frame", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({ wsFrameCount: 0, terminalEventReceived: false, wsCloseCode: 1006 }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.WS_NO_FRAMES)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.RETRY_ONCE_THEN_SOFT_FAIL)
  })

  test("server_empty_output_with_reasoning: completed + reasoning.effort", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        wsFrameCount: 4,
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          hasReasoningEffort: true,
          reasoningEffortValue: "high",
        },
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_EMPTY_OUTPUT_WITH_REASONING)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
    expect(result.suspectParams).toEqual(["reasoning.effort"])
  })

  test("server_empty_output_with_reasoning: completed + include encrypted_content", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          includeFields: ["reasoning.encrypted_content"],
        },
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_EMPTY_OUTPUT_WITH_REASONING)
    expect(result.suspectParams).toEqual(["include.reasoning.encrypted_content"])
  })

  test("server_empty_output_with_reasoning: BOTH suspect params present (INV-11)", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          hasReasoningEffort: true,
          reasoningEffortValue: "medium",
          includeFields: ["reasoning.encrypted_content"],
        },
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_EMPTY_OUTPUT_WITH_REASONING)
    expect(result.suspectParams).toEqual([
      "reasoning.effort",
      "include.reasoning.encrypted_content",
    ])
  })

  test("server_incomplete: response.incomplete arrived", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.incomplete",
        serverErrorMessage: "max_output_tokens",
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_INCOMPLETE)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
  })

  test("server_failed: response.failed arrived", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.failed",
        serverErrorMessage: "Model overloaded",
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_FAILED)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
  })

  test("server_failed: top-level error event arrived", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "error",
        serverErrorMessage: "Internal server error",
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_FAILED)
  })

  test("unclassified: empty turn matching none of the documented patterns (response.completed without suspect params)", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        wsFrameCount: 3,
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        // No reasoning.effort, no include — just clean empty
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.UNCLASSIFIED)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
    expect(result.suspectParams).toEqual([])
  })
})

describe("Predicate ordering and precedence", () => {
  test("server_failed wins over potential ws_truncation when terminal arrives", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        wsFrameCount: 5,
        terminalEventReceived: true,
        terminalEventType: "response.failed",
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_FAILED)
  })

  test("server_incomplete wins over ws_no_frames when terminal arrives early", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        wsFrameCount: 1,
        terminalEventReceived: true,
        terminalEventType: "response.incomplete",
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_INCOMPLETE)
  })

  test("server_empty_output_with_reasoning wins over unclassified when suspect params present", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          hasReasoningEffort: true,
          reasoningEffortValue: "low",
        },
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_EMPTY_OUTPUT_WITH_REASONING)
  })

  test("INV-11: suspectParams empty when no suspect params present (no false positive)", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.completed",
      }),
    )
    expect(result.suspectParams).toEqual([])
  })
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

describe("INV-13 schema-drift guard (task 2.9)", () => {
  test("CAUSE_FAMILY values match data-schema.json causeFamily enum exactly", () => {
    // Read schema from spec dir (relative to package root)
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    // Walk up from src/ to repo root, then into specs/
    const here = path.dirname(__filename ?? "")
    const repoRoot = path.resolve(here, "..", "..", "..")
    const schemaPath = path.join(
      repoRoot,
      "specs",
      "codex-empty-turn-recovery",
      "data-schema.json",
    )
    expect(fs.existsSync(schemaPath)).toBe(true)
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
    const schemaCauseEnum = (schema.properties.causeFamily.enum as string[]).slice().sort()
    const codeCauseEnum = Object.values(CAUSE_FAMILY).slice().sort()
    expect(codeCauseEnum).toEqual(schemaCauseEnum)
  })

  test("RECOVERY_ACTION values match data-schema.json recoveryAction enum exactly", () => {
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const here = path.dirname(__filename ?? "")
    const repoRoot = path.resolve(here, "..", "..", "..")
    const schemaPath = path.join(
      repoRoot,
      "specs",
      "codex-empty-turn-recovery",
      "data-schema.json",
    )
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
    const schemaActionEnum = (schema.properties.recoveryAction.enum as string[]).slice().sort()
    const codeActionEnum = Object.values(RECOVERY_ACTION).slice().sort()
    expect(codeActionEnum).toEqual(schemaActionEnum)
    // Bonus: explicitly assert hard-error not in schema either
    expect(schemaActionEnum).not.toContain("hard-error")
  })
})

describe("INV-08 retry cap (DD-7)", () => {
  test("retry attempt with ws_truncation pattern → recoveryAction demoted to pass-through", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        wsFrameCount: 3,
        terminalEventReceived: false,
        retryAttempted: true,
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.WS_TRUNCATION) // family unchanged
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE) // demoted
  })

  test("retry attempt with ws_no_frames pattern → demoted likewise", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({ wsFrameCount: 0, retryAttempted: true }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.WS_NO_FRAMES)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
  })

  test("retry attempt with non-retry cause is unaffected (server_failed stays pass-through)", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.failed",
        retryAttempted: true,
      }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.SERVER_FAILED)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE)
  })

  test("first attempt (retryAttempted=false) still gets retry action for ws_truncation", () => {
    const result = classifyEmptyTurn(
      baseSnapshot({ wsFrameCount: 3, retryAttempted: false }),
    )
    expect(result.causeFamily).toBe(CAUSE_FAMILY.WS_TRUNCATION)
    expect(result.recoveryAction).toBe(RECOVERY_ACTION.RETRY_ONCE_THEN_SOFT_FAIL)
  })
})

describe("DD-8 dormant synthesize-from-deltas action", () => {
  test("synthesizeTextFromDeltas returns empty array for empty input", () => {
    const { synthesizeTextFromDeltas } = require("./empty-turn-classifier")
    expect(synthesizeTextFromDeltas([])).toEqual([])
  })

  test("synthesizeTextFromDeltas combines deltas into text-start + text-delta + text-end", () => {
    const { synthesizeTextFromDeltas } = require("./empty-turn-classifier")
    const parts = synthesizeTextFromDeltas(["Hello", " ", "world"])
    expect(parts).toHaveLength(3)
    expect(parts[0].type).toBe("text-start")
    expect(parts[1].type).toBe("text-delta")
    expect(parts[1].delta).toBe("Hello world")
    expect(parts[2].type).toBe("text-end")
    // text-start id matches text-delta id matches text-end id
    expect(parts[0].id).toBe(parts[1].id)
    expect(parts[1].id).toBe(parts[2].id)
  })

  test("classifier never selects synthesize-from-deltas for any current scenario (DD-8 dormant)", () => {
    // Walk every documented scenario; none should pick synthesize-from-deltas
    const scenarios: EmptyTurnSnapshot[] = [
      baseSnapshot(),
      baseSnapshot({ wsFrameCount: 3 }),
      baseSnapshot({ wsFrameCount: 0 }),
      baseSnapshot({ terminalEventReceived: true, terminalEventType: "response.completed" }),
      baseSnapshot({
        terminalEventReceived: true,
        terminalEventType: "response.completed",
        requestOptionsShape: {
          ...baseSnapshot().requestOptionsShape,
          hasReasoningEffort: true,
        },
      }),
      baseSnapshot({ terminalEventReceived: true, terminalEventType: "response.incomplete" }),
      baseSnapshot({ terminalEventReceived: true, terminalEventType: "response.failed" }),
      baseSnapshot({ retryAttempted: true, wsFrameCount: 5 }),
    ]
    for (const s of scenarios) {
      const r = classifyEmptyTurn(s)
      expect(r.recoveryAction).not.toBe(RECOVERY_ACTION.SYNTHESIZE_FROM_DELTAS)
    }
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
