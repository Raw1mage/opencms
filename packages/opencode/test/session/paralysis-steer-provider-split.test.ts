import { describe, expect, it, spyOn } from "bun:test"
import { buildParalysisSteerSL, emitParalysisSteer, type ParalysisState } from "../../src/session/prompt"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"

// harness/paralysis-steer-provider-split — provider-class carrier split.
// RCA: issues/issue_20260622_paralysis_nudge_persisted_user_poisons_claude.md

const fakeLastUser = {
  agent: "main",
  variant: undefined,
} as unknown as MessageV2.User
const fakeModel = { providerId: "anthropic", modelID: "claude-x" } as unknown as MessageV2.User["model"]

function freshState(): ParalysisState {
  return { recoveryCount: 0, cleanStreak: 0 }
}

describe("buildParalysisSteerSL (DD-4 — claude steer text contract)", () => {
  const detectors = ["signature", "narrative", "preface", "no-progress", "phrase"] as const

  it("TV-5: every detector variant is wrapped, self-labelled not-user-feedback, and free of 2nd-person scolding", () => {
    for (const detector of detectors) {
      const text = buildParalysisSteerSL({ detector })
      expect(text.startsWith("<system-reminder>")).toBe(true)
      expect(text.trimEnd().endsWith("</system-reminder>")).toBe(true)
      // The marker that breaks claude's apology reflex.
      expect(text).toContain("NOT user feedback")
      expect(text.toLowerCase()).toContain("do not")
      // Must NOT carry the second-person Chinese scolding that triggers "你說得對".
      expect(text).not.toContain("你連續")
      expect(text).not.toContain("停下來")
    }
  })

  it("invalid-sink and no-op shim variants give a directional escape", () => {
    const invalid = buildParalysisSteerSL({ detector: "signature", repeatedToolName: "invalid" })
    expect(invalid).toContain("invalid")
    expect(invalid).toContain("NOT user feedback")
    const loader = buildParalysisSteerSL({ detector: "signature", repeatedToolName: "tool_loader" })
    expect(loader).toContain("tool_loader")
    expect(loader).toContain("no-op")
  })
})

describe("emitParalysisSteer (DD-1/DD-2 — carrier split)", () => {
  it("TV-1: SL records an ephemeral pendingSteer and performs ZERO store writes", async () => {
    const updateMessage = spyOn(Session, "updateMessage").mockImplementation(async () => {})
    const updatePart = spyOn(Session, "updatePart").mockImplementation(async () => ({}) as any)
    try {
      const state = freshState()
      await emitParalysisSteer({
        providerClass: "SL",
        sessionID: "ses_test_sl",
        paralysisState: state,
        detector: "signature",
        ssText: "你連續 3 輪…停下來…換一個動作。",
        lastUser: fakeLastUser,
        model: fakeModel,
      })
      expect(state.pendingSteer).toBeDefined()
      expect(state.pendingSteer!).toContain("<system-reminder>")
      expect(state.pendingSteer!).toContain("NOT user feedback")
      // The ssText (codex scolding) MUST NOT leak into the claude carrier.
      expect(state.pendingSteer!).not.toContain("你連續")
      // storeWrites == 0
      expect(updateMessage).toHaveBeenCalledTimes(0)
      expect(updatePart).toHaveBeenCalledTimes(0)
    } finally {
      updateMessage.mockRestore()
      updatePart.mockRestore()
    }
  })

  it("TV-2: SS persists the ssText byte-identically (INV-0) and sets no pendingSteer", async () => {
    let persistedText: string | undefined
    const updateMessage = spyOn(Session, "updateMessage").mockImplementation(async () => {})
    const updatePart = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
      persistedText = part.text
      return {} as any
    })
    try {
      const state = freshState()
      const ssText =
        "你連續 3 輪呼叫了同一個 tool 加同樣參數。停下來想想：是不是該檢查當前實際狀態，而不是重複 plan？換一個動作。"
      await emitParalysisSteer({
        providerClass: "SS",
        sessionID: "ses_test_ss",
        paralysisState: state,
        detector: "signature",
        ssText,
        lastUser: fakeLastUser,
        model: fakeModel,
      })
      expect(state.pendingSteer).toBeUndefined()
      expect(updateMessage).toHaveBeenCalledTimes(1)
      expect(updatePart).toHaveBeenCalledTimes(1)
      expect(persistedText).toBe(ssText)
    } finally {
      updateMessage.mockRestore()
      updatePart.mockRestore()
    }
  })

  it("TV-6: SL carrier holds regardless of detector (invalid-sink case still ephemeral)", async () => {
    const updateMessage = spyOn(Session, "updateMessage").mockImplementation(async () => {})
    const updatePart = spyOn(Session, "updatePart").mockImplementation(async () => ({}) as any)
    try {
      const state = freshState()
      await emitParalysisSteer({
        providerClass: "SL",
        sessionID: "ses_test_sl2",
        paralysisState: state,
        detector: "signature",
        repeatedToolName: "invalid",
        ssText: "你連續打到 invalid …",
        lastUser: fakeLastUser,
        model: fakeModel,
      })
      expect(state.pendingSteer).toContain("invalid")
      expect(updateMessage).toHaveBeenCalledTimes(0)
      expect(updatePart).toHaveBeenCalledTimes(0)
    } finally {
      updateMessage.mockRestore()
      updatePart.mockRestore()
    }
  })
})
