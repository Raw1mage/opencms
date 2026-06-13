import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { CronTrigger } from "../../src/freerun/trigger/cron"
import { WatchdogTrigger } from "../../src/freerun/trigger/watchdog"

describe("freerun CronTrigger schema", () => {
  test("TaskDef validates a complete task file", () => {
    const parsed = CronTrigger.TaskDef.parse({
      sessionId: "daily-sweep",
      providerId: "custom-provider-work",
      modelId: "qwen3.6-35b-a3b-q4_k_m",
      title: "Daily sweep",
      body: "Summarise overnight emails.",
      rootMode: "pending-plan",
      iterationCap: 20,
      userId: "pkcs12",
    })
    expect(parsed.sessionId).toBe("daily-sweep")
    expect(parsed.iterationCap).toBe(20)
    expect(parsed.rootMode).toBe("pending-plan")
  })

  test("TaskDef supplies sensible defaults", () => {
    const parsed = CronTrigger.TaskDef.parse({
      sessionId: "min",
      providerId: "p",
      modelId: "m",
      title: "t",
      body: "b",
    })
    expect(parsed.rootMode).toBe("pending-plan")
    expect(parsed.iterationCap).toBe(20)
  })

  test("TaskDef rejects invalid session id regex", () => {
    expect(() =>
      CronTrigger.TaskDef.parse({
        sessionId: "Daily Sweep With Spaces",
        providerId: "p",
        modelId: "m",
        title: "t",
        body: "b",
      }),
    ).toThrow()
  })
})

describe("freerun WatchdogTrigger", () => {
  test("interpolate substitutes {{vars}}", () => {
    const out = WatchdogTrigger.interpolate("File at {{path}} on {{timestamp}}", {
      path: "/tmp/x.png",
      timestamp: "2026-05-27T10:00Z",
    })
    expect(out).toBe("File at /tmp/x.png on 2026-05-27T10:00Z")
  })

  test("interpolate leaves unknown placeholders intact", () => {
    const out = WatchdogTrigger.interpolate("Hello {{name}}, you have {{unread}} messages", {
      name: "world",
    })
    expect(out).toBe("Hello world, you have {{unread}} messages")
  })

  test("WatchdogRule schema accepts fs-watch trigger", () => {
    const parsed = WatchdogTrigger.WatchdogRule.parse({
      id: "screenshot-watcher",
      trigger: { kind: "fs-watch", path: "/home/x/Pictures/Screenshots" },
      rootNodeSeed: {
        providerId: "p",
        modelId: "m",
        title: "Analyse screenshot",
        body: "New screenshot at {{path}}",
        iterationCap: 5,
      },
    })
    expect(parsed.trigger.kind).toBe("fs-watch")
    expect(parsed.rootNodeSeed.iterationCap).toBe(5)
  })

  test("WatchdogRule accepts the declared (but unimplemented) source kinds", () => {
    const okHttp = WatchdogTrigger.WatchdogRule.parse({
      id: "webhook",
      trigger: { kind: "http-webhook", pathPrefix: "/freerun/notify" },
      rootNodeSeed: { providerId: "p", modelId: "m", title: "t", body: "b" },
    })
    expect(okHttp.trigger.kind).toBe("http-webhook")

    const okDbus = WatchdogTrigger.WatchdogRule.parse({
      id: "dbus-rule",
      trigger: { kind: "dbus", interface: "org.freedesktop.NetworkManager", member: "StateChanged" },
      rootNodeSeed: { providerId: "p", modelId: "m", title: "t", body: "b" },
    })
    expect(okDbus.trigger.kind).toBe("dbus")
  })

  test("attach rejects unsupported source kind early", async () => {
    await expect(
      WatchdogTrigger.attach({
        rule: WatchdogTrigger.WatchdogRule.parse({
          id: "x",
          trigger: { kind: "http-webhook", pathPrefix: "/x" },
          rootNodeSeed: { providerId: "p", modelId: "m", title: "t", body: "b" },
        }),
      }),
    ).rejects.toThrow(/only supports/)
  })

  test("attach fails fast when fs-watch path missing", async () => {
    await expect(
      WatchdogTrigger.attach({
        rule: WatchdogTrigger.WatchdogRule.parse({
          id: "missing-dir",
          trigger: { kind: "fs-watch", path: "/definitely/does/not/exist/here" },
          rootNodeSeed: { providerId: "p", modelId: "m", title: "t", body: "b" },
        }),
      }),
    ).rejects.toThrow(/cannot stat target/)
  })
})

describe("freerun goal trigger — seedRoot-only path (no live LLM)", () => {
  test("seeds root when not present (idempotent on re-seed)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "goal-seed-test"
    // First write the root file directly to assert presence;
    // GoalTrigger.start would do this but also calls LLM (we don't here).
    expect(await NodeFS.list(sessionId, tmp.path)).toEqual([])
    await NodeFS.write(
      sessionId,
      {
        id: "root",
        parent_id: null,
        children_ids: [],
        title: "test",
        body: "the goal body",
        mode: "pending-plan",
        created_at: new Date().toISOString(),
        iteration_count: 0,
        observations: [],
        decisions: [],
        blockers: [],
        results: null,
        next_intent: "",
        consolidated_summary: null,
        goal_binding: { source: "conversation-goal", goal_text: "the goal body" },
      },
      tmp.path,
    )
    const snap = await Tree.load(sessionId, tmp.path)
    expect(snap.rootId).toBe("root")
    expect(Tree.get(snap, "root").body).toBe("the goal body")
    expect(Tree.get(snap, "root").goal_binding?.source).toBe("conversation-goal")
  })
})
