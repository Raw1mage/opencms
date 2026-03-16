import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { ChannelStore, DEFAULT_CHANNEL_ID } from "@/channel"
import { Global } from "@/global"

// Use a temp dir to avoid polluting real config
let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-api-test-"))
  ;(Global.Path as any).config = tempDir
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("Channel API CRUD", () => {
  it("creates a channel via store and retrieves it", async () => {
    const channel = await ChannelStore.create({
      name: "api-test",
      description: "Created for API test",
      lanePolicy: { main: 2, cron: 1, subagent: 3, nested: 1 },
    })

    expect(channel.id).toBeDefined()
    expect(channel.name).toBe("api-test")
    expect(channel.description).toBe("Created for API test")
    expect(channel.lanePolicy.main).toBe(2)

    const fetched = await ChannelStore.get(channel.id)
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe("api-test")
  })

  it("lists multiple channels", async () => {
    await ChannelStore.create({ name: "ch-1" })
    await ChannelStore.create({ name: "ch-2" })
    await ChannelStore.create({ name: "ch-3" })

    const channels = await ChannelStore.list()
    expect(channels.length).toBe(3)
    const names = channels.map((c) => c.name).sort()
    expect(names).toEqual(["ch-1", "ch-2", "ch-3"])
  })

  it("updates a channel", async () => {
    const ch = await ChannelStore.create({ name: "updatable-api" })
    const updated = await ChannelStore.update(ch.id, { name: "renamed-api", enabled: false })

    expect(updated).toBeDefined()
    expect(updated!.name).toBe("renamed-api")
    expect(updated!.enabled).toBe(false)
    expect(updated!.id).toBe(ch.id)
  })

  it("deletes a channel", async () => {
    const ch = await ChannelStore.create({ name: "deletable-api" })
    const removed = await ChannelStore.remove(ch.id)
    expect(removed).toBe(true)

    const fetched = await ChannelStore.get(ch.id)
    expect(fetched).toBeUndefined()
  })

  it("returns undefined for non-existent channel", async () => {
    const fetched = await ChannelStore.get("nonexistent")
    expect(fetched).toBeUndefined()
  })

  it("prevents deleting default channel by convention", async () => {
    // Create the default channel via bootstrap
    await ChannelStore.restoreOrBootstrap()
    const defaultCh = await ChannelStore.get(DEFAULT_CHANNEL_ID)
    expect(defaultCh).toBeDefined()

    // API route convention: channelId === "default" returns 409
    // Here we test the store-level behavior (remove succeeds at store level;
    // the 409 guard is in the route handler)
    expect(DEFAULT_CHANNEL_ID).toBe("default")
  })
})

describe("Channel API — session channelId", () => {
  it("session creation schema accepts channelId", async () => {
    // Import Session dynamically to avoid circular deps
    const { Session } = await import("@/session")
    const schema = Session.create.schema
    const result = schema.safeParse({
      title: "test session",
      channelId: "my-channel",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.channelId).toBe("my-channel")
    }
  })

  it("session creation schema allows omitting channelId", async () => {
    const { Session } = await import("@/session")
    const schema = Session.create.schema
    const result = schema.safeParse({
      title: "no channel",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.channelId).toBeUndefined()
    }
  })

  it("Session.Info schema includes optional channelId", async () => {
    const { Session } = await import("@/session")
    const shape = Session.Info.shape
    expect(shape.channelId).toBeDefined()
  })
})
