import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { RuntimeEventService } from "../../src/system/runtime-event-service"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"
import { Identifier } from "../../src/id/id"
import { Todo } from "../../src/session/todo"
import { decideAutonomousContinuation, enqueuePendingContinuation } from "../../src/session/workflow-runner"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.autonomous", () => {
  // harness/autonomous-gate-enforcement task 2.7 — integration: the async
  // decision path actually suspends an armed session into waiting_user with the
  // non-resumable approval_needed stopReason, and keeps autonomous armed.
  test("approval gate suspends an armed session into waiting_user:approval_needed (DD-1)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        await Session.updateAutonomous({ sessionID: session.id, policy: { enabled: true } })
        // "delete old data" → inferActionFromContent ⇒ destructive/needsApproval,
        // which is in the default requireApprovalFor (['push','destructive']).
        await Todo.update({
          sessionID: session.id,
          todos: [{ id: "g", content: "delete old data", status: "pending", priority: "high" }],
        })

        const decision = await decideAutonomousContinuation({ sessionID: session.id })
        expect(decision.continue).toBe(false)
        expect(decision.reason).toBe("approval_required")

        const after = await Session.get(session.id)
        expect(after.workflow?.state).toBe("waiting_user")
        expect(after.workflow?.stopReason).toBe("approval_needed")
        // gate hands back to the user but stays armed (unlike todo_complete)
        expect(after.workflow?.autonomous.enabled).toBe(true)
      },
    })
  })

  test("enables autonomous workflow policy for a session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.2" },
          path: { cwd: projectRoot, root: projectRoot },
          variant: "high",
        })

        const response = await app.request(`/session/${session.id}/autonomous`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, enqueue: false }),
        })

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)
        const body = (await response.json()) as { workflow?: { autonomous?: { enabled?: boolean } } }
        expect(body.workflow?.autonomous?.enabled).toBe(true)
      },
    })
  })

  test("enqueue synthetic continue when enabling autonomous on idle session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerId: "openai", modelID: "gpt-5.2" },
          path: { cwd: projectRoot, root: projectRoot },
          variant: "high",
        })

        const response = await app.request(`/session/${session.id}/autonomous`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, enqueue: true }),
        })

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)

        const messages = await Session.messages({ sessionID: session.id })

        const syntheticUser = [...messages]
          .reverse()
          .find(
            (message) =>
              message.info.role === "user" &&
              message.parts.some(
                (part) =>
                  part.type === "text" &&
                  part.synthetic === true &&
                  part.text.includes("Continue with the current work"),
              ),
          )

        expect(syntheticUser).toBeDefined()
      },
    })
  })

  test("returns autonomous workflow health snapshot from session route", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Session.setWorkflowState({
          sessionID: session.id,
          state: "waiting_user",
          stopReason: "wait_subagent",
        })
        await Session.updateWorkflowSupervisor({
          sessionID: session.id,
          patch: {
            consecutiveResumeFailures: 2,
            retryAt: 12_345,
            lastResumeCategory: "provider_rate_limit",
            lastResumeError: "429 Too Many Requests",
          },
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_health",
          createdAt: 111,
          roundCount: 2,
          reason: "todo_pending",
          text: "Continue with the next planned step.",
        })
        await RuntimeEventService.append({
          sessionID: session.id,
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.unreconciled_wait_subagent",
          anomalyFlags: ["unreconciled_wait_subagent"],
          payload: { activeSubtasks: 0 },
        })

        const response = await app.request(`/session/${session.id}/autonomous/health`)

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          state: string
          stopReason?: string
          queue: { hasPendingContinuation: boolean; roundCount?: number; reason?: string }
          supervisor: { consecutiveResumeFailures: number; lastResumeCategory?: string; retryAt?: number }
          anomalies: { recentCount: number; latestEventType?: string; flags: string[] }
          summary: { health: string; label: string }
        }
        expect(body).toMatchObject({
          state: "waiting_user",
          stopReason: "wait_subagent",
          queue: {
            hasPendingContinuation: true,
            roundCount: 2,
            reason: "todo_pending",
          },
          supervisor: {
            consecutiveResumeFailures: 2,
            lastResumeCategory: "provider_rate_limit",
            retryAt: 12_345,
          },
          anomalies: {
            recentCount: 1,
            latestEventType: "workflow.unreconciled_wait_subagent",
            flags: ["unreconciled_wait_subagent"],
          },
          summary: {
            health: "degraded",
            label: "Degraded: workflow.unreconciled_wait_subagent",
          },
        })
      },
    })
  })

  test("returns autonomous queue inspection with resumable vs blocked classification", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Session.setWorkflowState({
          sessionID: session.id,
          state: "waiting_user",
          stopReason: "approval_needed",
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_queue",
          createdAt: 222,
          roundCount: 3,
          reason: "todo_pending",
          text: "Continue with next step",
        })

        const response = await app.request(`/session/${session.id}/autonomous/queue`)

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          hasPendingContinuation: boolean
          status: string
          resumable: boolean
          blockedReasons: string[]
          pending?: { sessionID: string; roundCount: number; reason: string }
          health: { stopReason?: string; queue: { hasPendingContinuation: boolean } }
        }
        expect(body).toMatchObject({
          hasPendingContinuation: true,
          status: "idle",
          resumable: false,
          blockedReasons: ["waiting_user_non_resumable:approval_needed"],
          pending: {
            sessionID: session.id,
            roundCount: 3,
            reason: "todo_pending",
          },
          health: {
            stopReason: "approval_needed",
            queue: { hasPendingContinuation: true },
          },
        })
      },
    })
  })

  test("applies queue control mutation to drop pending continuation", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_queue_drop",
          createdAt: 333,
          roundCount: 1,
          reason: "todo_pending",
          text: "Continue",
        })

        const response = await app.request(`/session/${session.id}/autonomous/queue`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "drop_pending" }),
        })

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          action: string
          applied: boolean
          reason: string
          inspection: { hasPendingContinuation: boolean; blockedReasons: string[] }
        }
        expect(body).toMatchObject({
          action: "drop_pending",
          applied: true,
          reason: "dropped",
          inspection: {
            hasPendingContinuation: false,
            blockedReasons: ["no_pending_continuation"],
          },
        })
      },
    })
  })

  test("returns not_resumable when queue control resume_once is blocked", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Session.setWorkflowState({
          sessionID: session.id,
          state: "waiting_user",
          stopReason: "approval_needed",
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_queue_resume_blocked",
          createdAt: 334,
          roundCount: 1,
          reason: "todo_pending",
          text: "Continue",
        })

        const response = await app.request(`/session/${session.id}/autonomous/queue`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "resume_once" }),
        })

        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          action: string
          applied: boolean
          reason: string
          blockedReasons?: string[]
          inspection: { hasPendingContinuation: boolean; resumable: boolean; blockedReasons: string[] }
        }
        expect(body).toMatchObject({
          action: "resume_once",
          applied: false,
          reason: "not_resumable",
          blockedReasons: ["waiting_user_non_resumable:approval_needed"],
          inspection: {
            hasPendingContinuation: true,
            resumable: false,
            blockedReasons: ["waiting_user_non_resumable:approval_needed"],
          },
        })
      },
    })
  })
})
