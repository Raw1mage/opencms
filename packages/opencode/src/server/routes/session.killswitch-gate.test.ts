import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import z from "zod"

const assertSchedulingAllowed = mock(async () => ({
  ok: false as const,
  state: {
    active: true,
    state: "soft_paused",
    requestID: "ks_req_gate",
  },
}))

mock.module("../killswitch/service", () => ({
  KillSwitchService: {
    assertSchedulingAllowed,
  },
}))

mock.module("../../session", () => ({
  Session: {
    Info: z.object({}).passthrough(),
    create: {
      schema: z.object({}).passthrough(),
    },
    remove: {
      schema: z.string(),
    },
    get: Object.assign(
      mock(async () => ({
        id: "ses_test",
        time: { updated: Date.now() },
        directory: "/tmp",
      })),
      { schema: z.string().startsWith("ses") },
    ),
    children: Object.assign(
      mock(async () => []),
      { schema: z.string().startsWith("ses") },
    ),
    fork: Object.assign(
      mock(async () => ({ id: "ses_fork" })),
      {
        schema: z.object({
          sessionID: z.string().startsWith("ses"),
          messageID: z.string().startsWith("msg").optional(),
        }),
      },
    ),
    unshare: Object.assign(
      mock(async () => undefined),
      { schema: z.string().startsWith("ses") },
    ),
    initialize: Object.assign(
      mock(async () => undefined),
      {
        schema: z.object({ sessionID: z.string().startsWith("ses") }),
      },
    ),
    listGlobal: async function* () {},
    update: mock(async () => ({ id: "ses_test" })),
    updateMessage: mock(async () => undefined),
    updatePart: mock(async () => undefined),
    removeMessage: mock(async () => undefined),
    removePart: mock(async () => undefined),
    messages: mock(async () => []),
    share: mock(async () => undefined),
    defaultWorkflow: () => ({
      state: "idle",
      autonomous: { enabled: true },
      updatedAt: Date.now(),
      lastRunAt: Date.now(),
    }),
    mergeAutonomousPolicy: (_current: any, next: any) => ({ enabled: !!next?.enabled }),
    nextExecutionIdentity: (_input: any) => ({ providerId: "openai", modelID: "gpt-test" }),
    setWorkflowState: mock(async () => undefined),
    AutonomousPolicy: z
      .object({
        enabled: z.boolean().optional(),
      })
      .passthrough(),
    WorkflowState: z.enum(["idle", "running", "waiting_user", "blocked", "completed"]),
  },
}))

const actualMessageV2 = await import("../../session/message-v2")
mock.module("../../session/message-v2", () => ({
  MessageV2: {
    // Spread the REAL MessageV2 namespace so consumers in the import chain
    // (task.ts reads MessageV2.PendingSubagentNotice.shape.result.optional,
    // etc.) see the genuine zod schemas; only the two heavy IO helpers below
    // are stubbed. A hand-rolled partial namespace silently drops members and
    // surfaces as `undefined is not an object` deep in the import graph.
    ...actualMessageV2.MessageV2,
    stream: async function* () {},
    get: mock(async () => ({ info: {}, parts: [] })),
  },
}))

mock.module("../../session/prompt", () => ({
  SessionPrompt: {
    PromptInput: z.object({
      sessionID: z.string().startsWith("ses"),
      parts: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
    prompt: mock(async () => ({ info: {}, parts: [] })),
    CommandInput: z.object({
      sessionID: z.string().startsWith("ses"),
      command: z.string().optional(),
    }),
    command: mock(async () => ({ info: {}, parts: [] })),
    ShellInput: z.object({
      sessionID: z.string().startsWith("ses"),
      command: z.string().optional(),
    }),
    shell: mock(async () => ({ info: {}, parts: [] })),
    cancel: mock(() => undefined),
    loop: mock(async () => undefined),
    assertNotBusy: mock(() => undefined),
  },
}))

mock.module("../../session/compaction", () => ({
  SessionCompaction: {
    create: mock(async () => undefined),
  },
}))

mock.module("../../session/revert", () => ({
  SessionRevert: {
    RevertInput: z.object({
      sessionID: z.string().startsWith("ses"),
      messageID: z.string().startsWith("msg").optional(),
    }),
    cleanup: mock(async () => undefined),
    revert: mock(async () => true),
  },
}))

mock.module("@/session/status", () => ({
  SessionStatus: {
    Info: z.object({ type: z.string() }),
    list: () => ({}),
    get: () => ({ type: "idle" }),
  },
}))

mock.module("@/session/summary", () => ({
  SessionSummary: {
    diff: {
      schema: z.object({ sessionID: z.string(), messageID: z.string().optional() }),
    },
  },
}))

mock.module("@/session/monitor", () => ({
  SessionMonitor: {
    Info: z.object({}).passthrough(),
    snapshot: mock(async () => []),
  },
}))

// Spread the REAL barrel and override only the two diff helpers this test needs
// to stub. A partial mock (listing only those two) truncates the namespace, so
// the static ESM linker then fails any other `import { … }` from this barrel
// (e.g. WorkspaceOperation, WorkspaceDeleteOperationResultSchema) with
// "Export named '…' not found".
const actualWorkspace = await import("@/project/workspace")
mock.module("@/project/workspace", () => ({
  ...actualWorkspace,
  getSessionMessageDiff: mock(async () => []),
  getSessionOwnedDirtyDiff: mock(async () => []),
}))

mock.module("../../session/todo", () => ({
  Todo: {
    Info: z.object({}).passthrough(),
    get: mock(async () => []),
    projectSeedWithProgress: (_current: any, seed: any) => seed,
    sameStructure: () => true,
    setDerived: mock(async ({ todos }: any) => todos),
  },
}))

mock.module("@/session/tasks-checklist", () => ({
  extractChecklistItems: () => [],
}))

mock.module("../../agent/agent", () => ({
  Agent: {
    defaultAgent: mock(async () => "build"),
  },
}))

mock.module("@/snapshot", () => ({
  Snapshot: {
    FileDiff: z.object({}).passthrough(),
  },
}))

mock.module("../../util/log", () => ({
  Log: {
    create: () => ({
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: () => {},
      time: () => ({ stop: () => {} }),
    }),
  },
}))

mock.module("@/permission/next", () => ({
  PermissionNext: {
    Ruleset: z.array(z.any()),
  },
}))

mock.module("../error", () => ({
  errors: () => ({}),
}))

mock.module("../../util/lazy", () => ({
  lazy: (fn: any) => {
    let value: any
    let loaded = false
    const result = () => {
      if (loaded) return value
      loaded = true
      value = fn()
      return value
    }
    result.reset = () => {
      loaded = false
      value = undefined
    }
    return result
  },
}))

mock.module("@/runtime/request-user", () => ({
  RequestUser: {
    username: () => undefined,
  },
}))

mock.module("../user-daemon", () => ({
  UserDaemonManager: {
    routeSessionMutationEnabled: () => false,
    routeSessionListEnabled: () => false,
    routeSessionStatusEnabled: () => false,
    routeSessionTopEnabled: () => false,
    routeSessionReadEnabled: () => false,
  },
}))

mock.module("@/util/debug", () => ({
  debugCheckpoint: () => {},
}))

mock.module("@/session/workflow-runner", () => ({
  enqueueAutonomousContinue: mock(async () => undefined),
  getAutonomousWorkflowHealth: mock(async () => ({
    state: "idle",
    queue: { hasPendingContinuation: false },
    supervisor: { consecutiveResumeFailures: 0 },
    anomalies: { recentCount: 0, flags: [], countsByType: {} },
    summary: { health: "healthy", label: "ok" },
  })),
  getPendingContinuationQueueInspection: mock(async () => ({
    hasPendingContinuation: false,
    status: "idle",
    inFlight: false,
    resumable: false,
    blockedReasons: [],
    health: {
      state: "idle",
      queue: { hasPendingContinuation: false },
      supervisor: { consecutiveResumeFailures: 0 },
      anomalies: { recentCount: 0, flags: [], countsByType: {} },
      summary: { health: "healthy", label: "ok" },
    },
  })),
  mutatePendingContinuationQueue: mock(async () => ({
    action: "drop_pending",
    applied: true,
    reason: "dropped",
    inspection: {
      hasPendingContinuation: false,
      status: "idle",
      inFlight: false,
      resumable: false,
      blockedReasons: [],
      health: {
        state: "idle",
        queue: { hasPendingContinuation: false },
        supervisor: { consecutiveResumeFailures: 0 },
        anomalies: { recentCount: 0, flags: [], countsByType: {} },
        summary: { health: "healthy", label: "ok" },
      },
    },
  })),
}))

let SessionRoutes: typeof import("./session").SessionRoutes

describe("SessionRoutes kill-switch scheduling gate", () => {
  beforeAll(async () => {
    ;({ SessionRoutes } = await import("./session"))
  })

  beforeEach(() => {
    assertSchedulingAllowed.mockReset()
    assertSchedulingAllowed.mockImplementation(async () => ({
      ok: false as const,
      state: {
        active: true,
        state: "soft_paused",
        requestID: "ks_req_gate",
      },
    }))
  })

  it("blocks POST /:sessionID/message with 409 when kill-switch active", async () => {
    const app = SessionRoutes()
    const res = await app.request("http://localhost/ses_test/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello" }],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("KILL_SWITCH_ACTIVE")
  })

  it("blocks POST /:sessionID/prompt_async with 409 when kill-switch active", async () => {
    const app = SessionRoutes()
    const res = await app.request("http://localhost/ses_test/prompt_async", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello" }],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("KILL_SWITCH_ACTIVE")
  })
})
