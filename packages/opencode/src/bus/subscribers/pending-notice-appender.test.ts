import { beforeAll, describe, expect, it } from "bun:test"
import { Instance } from "@/project/instance"
import { tmpdir } from "../../../test/fixture/fixture"
import { registerPendingNoticeAppenderSubscriber } from "./pending-notice-appender"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { TaskCompletedEvent } from "@/tool/task"

beforeAll(() => {
  registerPendingNoticeAppenderSubscriber()
})

// bugfix/subagent-double-turn: the pending-notice-appender previously had NO
// per-jobId idempotency on the auto-resume side (only the notice APPEND was
// idempotent). That let a re-fired or duplicate TaskCompletedEvent mint a second
// synthetic continuation message and start a second parent turn — the user-facing
// "two souls" double-turn. These tests pin the three-pronged guard.

async function seedParentWithUser(tmpPath: string) {
  const parent = await Session.create({})
  const userMessageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userMessageID,
    role: "user",
    sessionID: parent.id,
    time: { created: Date.now() },
    agent: "orchestrator",
  } as MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userMessageID,
    sessionID: parent.id,
    type: "text",
    text: "do the work",
    time: { start: Date.now(), end: Date.now() },
  })
  return parent
}

async function countSyntheticContinuations(sessionID: string): Promise<number> {
  let count = 0
  for await (const m of MessageV2.stream(sessionID)) {
    if (m.info.role !== "user") continue
    for (const p of m.parts) {
      if (p.type === "text" && typeof p.text === "string" && p.text.startsWith("Subagent ")) {
        count++
      }
    }
  }
  return count
}

function completedEvent(parentID: string, childID: string, jobId: string) {
  return {
    jobId,
    parentSessionID: parentID,
    childSessionID: childID,
    status: "success" as const,
    finish: "stop",
    elapsedMs: 100,
  }
}

describe("pending-notice-appender auto-resume idempotency (bugfix/subagent-double-turn)", () => {
  it("same jobId fired twice → appends each time but auto-resumes ONCE", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await seedParentWithUser(tmp.path)
        const child = await Session.create({ parentID: parent.id })
        const jobId = "call_dup_job"

        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, child.id, jobId))
        await Bun.sleep(40)
        // Re-fire (orphan-reconcile style) the SAME jobId.
        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, child.id, jobId))
        await Bun.sleep(40)

        const after = await Session.get(parent.id)
        // jobId recorded exactly once in the resume ledger.
        expect((after.resumedSubagentJobIds ?? []).filter((j) => j === jobId)).toEqual([jobId])
        // Only ONE synthetic continuation message was minted.
        expect(await countSyntheticContinuations(parent.id)).toBe(1)
      },
    })
  })

  it("two distinct jobIds near-simultaneously → second coalesces, no duplicate synthetic msg", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await seedParentWithUser(tmp.path)
        const childA = await Session.create({ parentID: parent.id })
        const childB = await Session.create({ parentID: parent.id })

        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, childA.id, "job_A"))
        await Bun.sleep(40)
        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, childB.id, "job_B"))
        await Bun.sleep(40)

        const after = await Session.get(parent.id)
        // Both jobIds claimed in the ledger…
        expect(after.resumedSubagentJobIds).toContain("job_A")
        expect(after.resumedSubagentJobIds).toContain("job_B")
        // …but only the FIRST minted a synthetic continuation; the second
        // coalesced into the still-pending continuation (RunQueue per-session).
        expect(await countSyntheticContinuations(parent.id)).toBe(1)
      },
    })
  })

  it("already-resumed jobId (pre-seeded ledger) → skips auto-resume entirely", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await seedParentWithUser(tmp.path)
        const child = await Session.create({ parentID: parent.id })
        const jobId = "job_preseeded"
        await Session.update(parent.id, (draft) => {
          draft.resumedSubagentJobIds = [jobId]
        })

        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, child.id, jobId))
        await Bun.sleep(40)

        const after = await Session.get(parent.id)
        // Notice still appended (so the UI/next turn can see it)…
        expect((after.pendingSubagentNotices ?? []).some((n) => n.jobId === jobId)).toBe(true)
        // …but NO synthetic continuation minted.
        expect(await countSyntheticContinuations(parent.id)).toBe(0)
      },
    })
  })

  it("resumedSubagentJobIds is bounded (FIFO, never grows unbounded)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await seedParentWithUser(tmp.path)
        // Pre-seed 64 (the cap) so the next distinct jobId must evict the oldest.
        const seeded = Array.from({ length: 64 }, (_, i) => `seed_${i}`)
        await Session.update(parent.id, (draft) => {
          draft.resumedSubagentJobIds = [...seeded]
        })
        const child = await Session.create({ parentID: parent.id })

        await Bus.publish(TaskCompletedEvent, completedEvent(parent.id, child.id, "job_new"))
        await Bun.sleep(40)

        const after = await Session.get(parent.id)
        const ledger = after.resumedSubagentJobIds ?? []
        expect(ledger.length).toBe(64)
        expect(ledger).toContain("job_new")
        // Oldest seed evicted.
        expect(ledger).not.toContain("seed_0")
      },
    })
  })
})
