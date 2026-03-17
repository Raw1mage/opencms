import { describe, expect, it, beforeEach } from "bun:test"
import { Lanes } from "./lanes"
import { Drain } from "./drain"

describe("Lanes", () => {
  beforeEach(() => {
    Drain.reset()
    Lanes.register()
  })

  it("registers lanes with default concurrency", () => {
    const info = Lanes.info()
    expect(info["default:main"].maxConcurrent).toBe(1)
    expect(info["default:cron"].maxConcurrent).toBe(1)
    expect(info["default:subagent"].maxConcurrent).toBe(2)
    expect(info["default:nested"].maxConcurrent).toBe(1)
  })

  it("registers with custom concurrency", () => {
    Lanes.register({ [Lanes.CommandLane.Cron]: 3 })
    const info = Lanes.info()
    expect(info["default:cron"].maxConcurrent).toBe(3)
    expect(info["default:main"].maxConcurrent).toBe(1) // unchanged
  })

  it("enqueues and executes a task", async () => {
    const result = await Lanes.enqueue(Lanes.CommandLane.Main, async () => 42)
    expect(result).toBe(42)
  })

  it("executes tasks sequentially in single-concurrency lane", async () => {
    const order: number[] = []

    const p1 = Lanes.enqueue(Lanes.CommandLane.Main, async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push(1)
      return 1
    })
    const p2 = Lanes.enqueue(Lanes.CommandLane.Main, async () => {
      order.push(2)
      return 2
    })

    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it("executes tasks concurrently in multi-concurrency lane", async () => {
    const started: number[] = []

    const p1 = Lanes.enqueue(Lanes.CommandLane.Subagent, async () => {
      started.push(1)
      await new Promise((r) => setTimeout(r, 50))
      return 1
    })
    const p2 = Lanes.enqueue(Lanes.CommandLane.Subagent, async () => {
      started.push(2)
      await new Promise((r) => setTimeout(r, 50))
      return 2
    })

    // Both should start before either completes (maxConcurrent=2)
    await new Promise((r) => setTimeout(r, 20))
    expect(started.length).toBe(2)

    await Promise.all([p1, p2])
  })

  it("rejects enqueue when draining", async () => {
    Drain.enter("shutdown")

    try {
      await Lanes.enqueue(Lanes.CommandLane.Main, async () => 1)
      expect(true).toBe(false) // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(Lanes.GatewayDrainingError)
    }
  })

  it("reports queue size", async () => {
    expect(Lanes.queueSize(Lanes.CommandLane.Main)).toBe(0)

    // Enqueue a slow task to occupy the lane
    const p = Lanes.enqueue(Lanes.CommandLane.Main, () => new Promise((r) => setTimeout(r, 100)))
    // Queue another — it should be queued (not active)
    const p2 = Lanes.enqueue(Lanes.CommandLane.Main, async () => 2)

    expect(Lanes.queueSize(Lanes.CommandLane.Main)).toBe(2) // 1 active + 1 queued

    await Promise.all([p, p2])
    expect(Lanes.queueSize(Lanes.CommandLane.Main)).toBe(0)
  })

  it("reports total active tasks", async () => {
    expect(Lanes.totalActiveTasks()).toBe(0)

    const p = Lanes.enqueue(Lanes.CommandLane.Main, () => new Promise((r) => setTimeout(r, 100)))
    await new Promise((r) => setTimeout(r, 10))
    expect(Lanes.totalActiveTasks()).toBe(1)

    await p
    expect(Lanes.totalActiveTasks()).toBe(0)
  })

  it("reports idle when no tasks", () => {
    expect(Lanes.isIdle()).toBe(true)
  })

  describe("resetAll", () => {
    it("bumps generation numbers", () => {
      const before = Lanes.info()
      expect(before["default:main"].generation).toBe(0)

      Lanes.resetAll()
      const after = Lanes.info()
      expect(after["default:main"].generation).toBe(1)
    })

    it("rejects queued tasks with CommandLaneClearedError", async () => {
      // Occupy the lane
      const slowTask = Lanes.enqueue(Lanes.CommandLane.Main, () => new Promise((r) => setTimeout(r, 500)))

      // Queue another task
      const queuedTask = Lanes.enqueue(Lanes.CommandLane.Main, async () => "should not run")

      // Reset lanes
      Lanes.resetAll()

      try {
        await queuedTask
        expect(true).toBe(false) // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(Lanes.CommandLaneClearedError)
      }

      // The slow task may or may not complete — it's already running
      await slowTask.catch(() => {})
    })
  })
})

// --- Per-workspace lane isolation tests (Stage 4) ---

describe("Per-workspace lane isolation", () => {
  beforeEach(() => {
    Drain.reset()
    Lanes.register()
  })

  it("buildLaneKey creates composite key", () => {
    expect(Lanes.buildLaneKey("ws-a", Lanes.CommandLane.Main)).toBe("ws-a:main")
    expect(Lanes.buildLaneKey("default", Lanes.CommandLane.Cron)).toBe("default:cron")
  })

  it("parseLaneKey extracts workspaceId and lane", () => {
    const parsed = Lanes.parseLaneKey("ws-a:main")
    expect(parsed).toEqual({ workspaceId: "ws-a", lane: Lanes.CommandLane.Main })
  })

  it("cross-workspace isolation: workspace A full does not block workspace B", async () => {
    Lanes.registerWorkspace({ workspaceId: "ws-a", concurrency: { main: 1 } })
    Lanes.registerWorkspace({ workspaceId: "ws-b", concurrency: { main: 1 } })

    const order: string[] = []

    // Occupy workspace A's main lane
    const pA = Lanes.enqueue(
      Lanes.CommandLane.Main,
      async () => {
        await new Promise((r) => setTimeout(r, 100))
        order.push("a-done")
        return "a"
      },
      "ws-a",
    )

    // Workspace B should execute immediately despite workspace A being full
    const pB = Lanes.enqueue(
      Lanes.CommandLane.Main,
      async () => {
        order.push("b-done")
        return "b"
      },
      "ws-b",
    )

    await pB
    expect(order).toContain("b-done")
    // Workspace A should still be running
    expect(Lanes.workspaceActiveTasks("ws-a")).toBe(1)

    await pA
    expect(order).toEqual(["b-done", "a-done"])
  })

  it("workspace-scoped active task count", async () => {
    Lanes.registerWorkspace({ workspaceId: "ws-x" })

    const p = Lanes.enqueue(
      Lanes.CommandLane.Main,
      () => new Promise((r) => setTimeout(r, 100)),
      "ws-x",
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(Lanes.workspaceActiveTasks("ws-x")).toBe(1)
    expect(Lanes.workspaceActiveTasks("default")).toBe(0) // default unaffected

    await p
    expect(Lanes.workspaceActiveTasks("ws-x")).toBe(0)
  })

  it("unregisterWorkspace clears workspace lanes", () => {
    Lanes.registerWorkspace({ workspaceId: "ephemeral" })
    const info = Lanes.info()
    expect(info["ephemeral:main"]).toBeDefined()

    Lanes.unregisterWorkspace("ephemeral")
    const infoAfter = Lanes.info()
    expect(infoAfter["ephemeral:main"]).toBeUndefined()
  })

  it("default workspace backward compatibility", async () => {
    // enqueue without workspaceId should use default workspace
    const result = await Lanes.enqueue(Lanes.CommandLane.Main, async () => "default-works")
    expect(result).toBe("default-works")
  })
})
