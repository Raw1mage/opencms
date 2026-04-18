import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import { Instance } from "../project/instance"
import { tmpdir } from "../../test/fixture/fixture"

describe("session execution identity", () => {
  it("increments revision only when execution identity actually changes", () => {
    const first = Session.nextExecutionIdentity({
      model: {
        providerId: "openai",
        modelID: "gpt-5.4",
        accountId: "acct-a",
      },
      now: 100,
    })

    expect(first).toEqual({
      providerId: "openai",
      modelID: "gpt-5.4",
      accountId: "acct-a",
      revision: 1,
      updatedAt: 100,
    })

    const unchanged = Session.nextExecutionIdentity({
      current: first,
      model: {
        providerId: "openai",
        modelID: "gpt-5.4",
        accountId: "acct-a",
      },
      now: 200,
    })

    expect(unchanged).toEqual({
      providerId: "openai",
      modelID: "gpt-5.4",
      accountId: "acct-a",
      revision: 1,
      updatedAt: 200,
    })

    const changed = Session.nextExecutionIdentity({
      current: unchanged,
      model: {
        providerId: "github-copilot",
        modelID: "gpt-5.4",
        accountId: "acct-b",
      },
      now: 300,
    })

    expect(changed).toEqual({
      providerId: "github-copilot",
      modelID: "gpt-5.4",
      accountId: "acct-b",
      revision: 2,
      updatedAt: 300,
    })
  })

  // Mission contract + Session.setMission/clearMission removed 2026-04-18.
  // Autonomous runner is todolist-driven; mission binding was dead code.
})
