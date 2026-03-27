import { afterEach, describe, expect, it, mock } from "bun:test"
import { Server } from "./server"
import { Daemon as RuntimeDaemon } from "../daemon"
import { Daemon as DiscoveryDaemon } from "./daemon"

describe("Server.listenUnix", () => {
  const originalCheckSingleInstance = DiscoveryDaemon.checkSingleInstance
  const originalWriteDiscovery = DiscoveryDaemon.writeDiscovery
  const originalRemoveDiscovery = DiscoveryDaemon.removeDiscovery
  const originalRuntimeStart = RuntimeDaemon.start
  const originalRuntimeShutdown = RuntimeDaemon.shutdown
  const originalBunServe = Bun.serve

  afterEach(() => {
    ;(DiscoveryDaemon as any).checkSingleInstance = originalCheckSingleInstance
    ;(DiscoveryDaemon as any).writeDiscovery = originalWriteDiscovery
    ;(DiscoveryDaemon as any).removeDiscovery = originalRemoveDiscovery
    ;(RuntimeDaemon as any).start = originalRuntimeStart
    ;(RuntimeDaemon as any).shutdown = originalRuntimeShutdown
    ;(Bun as any).serve = originalBunServe
  })

  it("fails fast when daemon lifecycle does not start", async () => {
    ;(DiscoveryDaemon as any).checkSingleInstance = mock(() => Promise.resolve(null))
    ;(RuntimeDaemon as any).start = mock(() => Promise.resolve(false))

    await expect(Server.listenUnix("/tmp/opencode-test.sock")).rejects.toThrow("failed to start daemon lifecycle")
    expect((RuntimeDaemon.start as any).mock.calls.length).toBe(1)
  })

  it("starts lifecycle before serving and cleans up on stop", async () => {
    const callOrder: string[] = []
    const originalStop = mock(() => Promise.resolve())
    ;(DiscoveryDaemon as any).checkSingleInstance = mock(() => Promise.resolve(null))
    ;(RuntimeDaemon as any).start = mock(() => {
      callOrder.push("runtime-start")
      return Promise.resolve(true)
    })
    ;(DiscoveryDaemon as any).writeDiscovery = mock(() => {
      callOrder.push("write-discovery")
      return Promise.resolve()
    })
    ;(RuntimeDaemon as any).shutdown = mock(() => {
      callOrder.push("runtime-shutdown")
      return Promise.resolve()
    })
    ;(DiscoveryDaemon as any).removeDiscovery = mock(() => {
      callOrder.push("remove-discovery")
      return Promise.resolve()
    })
    ;(Bun as any).serve = mock(() => {
      callOrder.push("bun-serve")
      return {
        stop: originalStop,
        url: new URL("http://localhost"),
      }
    })

    const server = await Server.listenUnix("/tmp/opencode-test.sock")

    expect(callOrder.slice(0, 3)).toEqual(["runtime-start", "bun-serve", "write-discovery"])

    await server.stop()

    expect(callOrder).toContain("runtime-shutdown")
    expect(callOrder).toContain("remove-discovery")
    expect(originalStop.mock.calls.length).toBe(1)
  })
})
