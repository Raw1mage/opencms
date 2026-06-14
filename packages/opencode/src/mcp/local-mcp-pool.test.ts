import { describe, expect, it } from "bun:test"
import { createLocalMcpPool, localShareKey, type PoolResource } from "./local-mcp-pool"

// Fake client: records close() calls and how many times the underlying
// transport was really torn down (realClose).
function fakeResource() {
  const state = { closedForReal: 0 }
  const resource: PoolResource & { state: typeof state } = {
    state,
    mcpClient: {
      close: async () => {
        state.closedForReal++
      },
    },
  }
  return resource
}

describe("createLocalMcpPool ref-counting", () => {
  it("single acquire/release closes the child immediately (refs 1 == pre-pool behavior)", async () => {
    const pool = createLocalMcpPool()
    const r = fakeResource()
    const got = await pool.acquire("k", async () => r)
    expect(got).toBe(r)
    expect(pool.refs("k")).toBe(1)
    expect(pool.size()).toBe(1)

    await got!.mcpClient!.close()
    expect((r as any).state.closedForReal).toBe(1)
    expect(pool.size()).toBe(0)
  })

  it("two sequential acquires for the same key share ONE spawn and close only at the last release", async () => {
    const pool = createLocalMcpPool()
    let spawns = 0
    const r = fakeResource()
    const spawn = async () => {
      spawns++
      return r
    }

    const a = await pool.acquire("k", spawn)
    const b = await pool.acquire("k", spawn)
    expect(spawns).toBe(1) // shared — only one child spawned
    expect(a).toBe(b)
    expect(pool.refs("k")).toBe(2)

    await a!.mcpClient!.close() // first Instance releases
    expect((r as any).state.closedForReal).toBe(0) // still alive for B
    expect(pool.refs("k")).toBe(1)

    await b!.mcpClient!.close() // last Instance releases
    expect((r as any).state.closedForReal).toBe(1) // now really closed
    expect(pool.size()).toBe(0)
  })

  it("concurrent acquires for the same key spawn only once", async () => {
    const pool = createLocalMcpPool()
    let spawns = 0
    const spawn = async () => {
      spawns++
      await Promise.resolve()
      return fakeResource()
    }
    const [a, b, c] = await Promise.all([pool.acquire("k", spawn), pool.acquire("k", spawn), pool.acquire("k", spawn)])
    expect(spawns).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(pool.refs("k")).toBe(3)
  })

  it("re-acquires (respawns) after the key was fully released", async () => {
    const pool = createLocalMcpPool()
    let spawns = 0
    const spawn = async () => {
      spawns++
      return fakeResource()
    }
    const a = await pool.acquire("k", spawn)
    await a!.mcpClient!.close()
    expect(pool.size()).toBe(0)

    await pool.acquire("k", spawn)
    expect(spawns).toBe(2) // fresh child after full release
    expect(pool.refs("k")).toBe(1)
  })

  it("spawn returning undefined leaves no entry and lets the next acquire retry", async () => {
    const pool = createLocalMcpPool()
    let calls = 0
    const got = await pool.acquire("k", async () => {
      calls++
      return undefined // spawn failed entirely
    })
    expect(got).toBeUndefined()
    expect(pool.size()).toBe(0)

    const r = fakeResource()
    const retry = await pool.acquire("k", async () => {
      calls++
      return r
    })
    expect(retry).toBe(r)
    expect(calls).toBe(2)
  })

  it("returns a client-less failure resource without pooling it (status still propagates)", async () => {
    const pool = createLocalMcpPool<PoolResource & { status: string }>()
    const failure = { status: "failed" } // no mcpClient
    const got = await pool.acquire("k", async () => failure)
    expect(got).toBe(failure) // caller still sees the failure result + its status
    expect(pool.size()).toBe(0) // not pooled
    expect(pool.refs("k")).toBe(0)
  })

  it("fires onRealClose exactly once, only at the final release", async () => {
    const closed: string[] = []
    const pool = createLocalMcpPool({ onRealClose: (k) => closed.push(k) })
    const r = fakeResource()
    await pool.acquire("k", async () => r)
    await pool.acquire("k", async () => r)
    await r.mcpClient!.close()
    expect(closed).toEqual([])
    await r.mcpClient!.close()
    expect(closed).toEqual(["k"])
  })

  it("different keys keep independent children", async () => {
    const pool = createLocalMcpPool()
    let spawns = 0
    const spawn = async () => {
      spawns++
      return fakeResource()
    }
    await pool.acquire("a", spawn)
    await pool.acquire("b", spawn)
    expect(spawns).toBe(2)
    expect(pool.size()).toBe(2)
  })
})

describe("localShareKey", () => {
  const base = { command: ["/usr/local/lib/opencode/mcp/docxmcp"], cwd: "/tmp", env: { A: "1" }, sourceMtimeMs: 100 }

  it("is identical for identical spawn specs (→ shared child)", () => {
    expect(localShareKey(base)).toBe(localShareKey({ ...base, env: { A: "1" } }))
  })

  it("is order-insensitive for env entries", () => {
    expect(localShareKey({ ...base, env: { A: "1", B: "2" } })).toBe(localShareKey({ ...base, env: { B: "2", A: "1" } }))
  })

  it("differs when cwd differs (per-project local MCP stays separate)", () => {
    expect(localShareKey({ ...base, cwd: "/proj/a" })).not.toBe(localShareKey({ ...base, cwd: "/proj/b" }))
  })

  it("differs when the source mtime changes (stale-refresh spawns a fresh child)", () => {
    expect(localShareKey(base)).not.toBe(localShareKey({ ...base, sourceMtimeMs: 200 }))
  })

  it("differs when env values differ", () => {
    expect(localShareKey(base)).not.toBe(localShareKey({ ...base, env: { A: "2" } }))
  })
})
