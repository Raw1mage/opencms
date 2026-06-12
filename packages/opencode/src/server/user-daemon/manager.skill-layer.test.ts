import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"

const requests: Array<{ method?: string; path?: string; body?: string }> = []
const queuedResponses: Array<{ status: number; body: unknown }> = []

mock.module("node:http", () => ({
  request: (options: any, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void
      end: () => void
      destroy: (error?: Error) => void
      setTimeout?: (ms: number, cb?: () => void) => void
    }
    let body = ""
    req.write = (chunk: string) => {
      body += chunk
    }
    req.end = () => {
      requests.push({ method: options.method, path: options.path, body })
      const next = queuedResponses.shift() ?? {
        status: 500,
        body: { code: "NO_RESPONSE", message: "missing test response" },
      }
      const res = new EventEmitter() as EventEmitter & { statusCode?: number }
      res.statusCode = next.status
      callback(res)
      queueMicrotask(() => {
        res.emit("data", JSON.stringify(next.body))
        res.emit("end")
      })
    }
    req.destroy = (error?: Error) => {
      req.emit("error", error ?? new Error("destroyed"))
    }
    return req
  },
}))

mock.module("@/system/linux-user-exec", () => ({
  LinuxUserExec: {
    sanitizeUsername: (value?: string) => value,
    resolveLinuxUserUID: () => 1000,
    isSudoer: () => false,
  },
}))

mock.module("@/util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    }),
  },
}))

describe("UserDaemonManager skill-layer routing", () => {
  const previousExperimental = process.env.OPENCODE_PER_USER_DAEMON_EXPERIMENTAL
  const previousLazyStart = process.env.OPENCODE_PER_USER_DAEMON_LAZY_START

  beforeEach(() => {
    process.env.OPENCODE_PER_USER_DAEMON_EXPERIMENTAL = "1"
    process.env.OPENCODE_PER_USER_DAEMON_LAZY_START = "0"
    requests.length = 0
    queuedResponses.length = 0
  })

  afterEach(() => {
    if (previousExperimental === undefined) delete process.env.OPENCODE_PER_USER_DAEMON_EXPERIMENTAL
    else process.env.OPENCODE_PER_USER_DAEMON_EXPERIMENTAL = previousExperimental
    if (previousLazyStart === undefined) delete process.env.OPENCODE_PER_USER_DAEMON_LAZY_START
    else process.env.OPENCODE_PER_USER_DAEMON_LAZY_START = previousLazyStart
  })

  it("routes skill-layer list through the per-user daemon", async () => {
    const { UserDaemonManager } = await import("./manager")
    queuedResponses.push({
      status: 200,
      body: [
        {
          name: "planner",
          loadedAt: 1,
          lastUsedAt: 2,
          runtimeState: "active",
          desiredState: "full",
          pinned: false,
          lastReason: "relevance_keep_full",
        },
      ],
    })

    const result = await UserDaemonManager.callSessionSkillLayerList<any[]>("alice", "ses_test")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0].name).toBe("planner")
    }
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/session/ses_test/skill-layer",
        body: "",
      },
    ])
  })

  it("routes skill-layer actions through the per-user daemon", async () => {
    const { UserDaemonManager } = await import("./manager")
    queuedResponses.push({
      status: 200,
      body: {
        ok: true,
        entries: [
          {
            name: "planner",
            loadedAt: 1,
            lastUsedAt: 3,
            runtimeState: "sticky",
            desiredState: "full",
            pinned: true,
            lastReason: "operator_promote_full",
          },
        ],
      },
    })

    const result = await UserDaemonManager.callSessionSkillLayerAction<{ ok: boolean; entries: any[] }>(
      "alice",
      "ses_test",
      "planner",
      { action: "promote" },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].lastReason).toBe("operator_promote_full")
    }
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/session/ses_test/skill-layer/planner/action",
        body: JSON.stringify({ action: "promote" }),
      },
    ])
  })
})
