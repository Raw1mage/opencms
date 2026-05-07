/**
 * processor-empty-turn-rotation-guard.test.ts — DD-3 verification.
 *
 * Spec: fix-empty-response-rca / Decision DD-3
 *
 * Verifies that SessionProcessor.readEmptyTurnClassification correctly
 * extracts the codex-empty-turn-recovery classifier metadata from a
 * provider finish part's providerMetadata, as opaque structural data
 * (no codex-provider type import per INV-16).
 *
 * The actual rotation guard inside isModelTemporaryError uses
 * readEmptyTurnClassification — when it returns non-null, isModelTemporaryError
 * returns false, suppressing handleRateLimitFallback. Testing the helper
 * in isolation lets us verify the guard contract without spinning up the
 * full processor stream loop.
 */
import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

const { readEmptyTurnClassification } = SessionProcessor

describe("readEmptyTurnClassification (DD-3 rotation guard helper)", () => {
  test("returns null for null / undefined / non-object input", () => {
    expect(readEmptyTurnClassification(null)).toBe(null)
    expect(readEmptyTurnClassification(undefined)).toBe(null)
    expect(readEmptyTurnClassification("string")).toBe(null)
    expect(readEmptyTurnClassification(42)).toBe(null)
    expect(readEmptyTurnClassification([])).toBe(null) // arrays are objects but no .openai
  })

  test("returns null when providerMetadata has no openai key", () => {
    expect(readEmptyTurnClassification({ anthropic: { foo: "bar" } })).toBe(null)
    expect(readEmptyTurnClassification({})).toBe(null)
  })

  test("returns null when openai has no emptyTurnClassification", () => {
    expect(readEmptyTurnClassification({ openai: { responseId: "resp_normal" } })).toBe(null)
    expect(readEmptyTurnClassification({ openai: {} })).toBe(null)
  })

  test("returns null when emptyTurnClassification missing causeFamily", () => {
    expect(
      readEmptyTurnClassification({
        openai: { emptyTurnClassification: { recoveryAction: "pass-through-to-runloop-nudge" } },
      }),
    ).toBe(null)
  })

  test("returns null when causeFamily is empty string", () => {
    expect(
      readEmptyTurnClassification({
        openai: { emptyTurnClassification: { causeFamily: "" } },
      }),
    ).toBe(null)
  })

  test("returns extracted fields when ws_truncation classification present", () => {
    const result = readEmptyTurnClassification({
      openai: {
        responseId: "resp_x",
        emptyTurnClassification: {
          causeFamily: "ws_truncation",
          recoveryAction: "retry-once-then-soft-fail",
          logSequence: 17,
        },
      },
    })
    expect(result).not.toBe(null)
    expect(result!.causeFamily).toBe("ws_truncation")
    expect(result!.recoveryAction).toBe("retry-once-then-soft-fail")
    expect(result!.logSequence).toBe(17)
  })

  test("returns extracted fields when ws_no_frames classification present", () => {
    const result = readEmptyTurnClassification({
      openai: {
        emptyTurnClassification: {
          causeFamily: "ws_no_frames",
          recoveryAction: "retry-once-then-soft-fail",
          logSequence: 42,
        },
      },
    })
    expect(result!.causeFamily).toBe("ws_no_frames")
  })

  test("returns extracted fields when server_failed classification present", () => {
    const result = readEmptyTurnClassification({
      openai: {
        emptyTurnClassification: {
          causeFamily: "server_failed",
          recoveryAction: "pass-through-to-runloop-nudge",
          logSequence: 99,
        },
      },
    })
    expect(result!.causeFamily).toBe("server_failed")
    expect(result!.recoveryAction).toBe("pass-through-to-runloop-nudge")
  })

  test("returns null recoveryAction / logSequence fields when not strings/numbers", () => {
    const result = readEmptyTurnClassification({
      openai: {
        emptyTurnClassification: {
          causeFamily: "ws_truncation",
          // recoveryAction missing entirely
          logSequence: "not-a-number", // wrong type
        },
      },
    })
    expect(result!.causeFamily).toBe("ws_truncation")
    expect(result!.recoveryAction).toBe(null)
    expect(result!.logSequence).toBe(null)
  })

  test("INV-16 boundary discipline: helper accepts opaque metadata, no codex-provider type knowledge", () => {
    // The helper's signature takes `unknown`; it works on plain objects
    // with no codex-provider import. Caller (isModelTemporaryError in
    // processor.ts) needs only this helper's output, not the codex
    // provider's classifier types.
    const opaqueMetadata = JSON.parse(
      JSON.stringify({
        openai: {
          emptyTurnClassification: {
            causeFamily: "unclassified",
            recoveryAction: "pass-through-to-runloop-nudge",
            logSequence: 0,
          },
        },
      }),
    )
    const result = readEmptyTurnClassification(opaqueMetadata)
    expect(result).not.toBe(null)
    expect(result!.causeFamily).toBe("unclassified")
  })
})
