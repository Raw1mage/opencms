import { describe, expect, it, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { GatewayLock } from "./gateway-lock"

const lockPath = path.join(Global.Path.config, "daemon.lock")

describe("GatewayLock", () => {
  afterEach(async () => {
    await fs.unlink(lockPath).catch(() => {})
  })

  it("acquires lock when no lock exists", async () => {
    const acquired = await GatewayLock.acquire()
    expect(acquired).toBe(true)
  })

  it("writes lock file with current PID", async () => {
    await GatewayLock.acquire()
    const raw = await fs.readFile(lockPath, "utf-8")
    const info = JSON.parse(raw)
    expect(info.pid).toBe(process.pid)
    expect(info.acquiredAtMs).toBeGreaterThan(0)
  })

  it("releases lock when held by current process", async () => {
    await GatewayLock.acquire()
    await GatewayLock.release()
    const exists = await fs.stat(lockPath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it("reports lock held after acquire", async () => {
    await GatewayLock.acquire()
    const held = await GatewayLock.isHeld()
    expect(held).toBe(true)
  })

  it("reports lock not held when no file", async () => {
    const held = await GatewayLock.isHeld()
    expect(held).toBe(false)
  })

  it("returns holder info", async () => {
    await GatewayLock.acquire()
    const holder = await GatewayLock.holder()
    expect(holder).toBeDefined()
    expect(holder!.pid).toBe(process.pid)
  })

  it("breaks stale lock from non-running PID", async () => {
    // Write a fake lock with a PID that doesn't exist
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999999, acquiredAtMs: Date.now() }))

    const acquired = await GatewayLock.acquire()
    expect(acquired).toBe(true)
  })
})
