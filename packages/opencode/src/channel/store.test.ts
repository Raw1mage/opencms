import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { ChannelStore } from "./store"
import { ChannelInfoSchema, DEFAULT_CHANNEL_ID, DEFAULT_LANE_POLICY } from "./types"
import { Global } from "../global"

// Use a temp dir to avoid polluting real config
let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-test-"))
  // Override Global.Path.config to use temp dir
  ;(Global.Path as any).config = tempDir
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("ChannelStore CRUD", () => {
  it("creates and retrieves a channel", async () => {
    const channel = await ChannelStore.create({
      name: "test-channel",
      description: "A test channel",
      lanePolicy: { main: 2, cron: 1, subagent: 3, nested: 1 },
    })

    expect(channel.id).toBeDefined()
    expect(channel.name).toBe("test-channel")
    expect(channel.enabled).toBe(true)
    expect(channel.lanePolicy.main).toBe(2)
    expect(channel.lanePolicy.subagent).toBe(3)
    expect(channel.killSwitchScope).toBe("channel")

    // Retrieve
    const fetched = await ChannelStore.get(channel.id)
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe("test-channel")
    expect(fetched!.lanePolicy.main).toBe(2)
  })

  it("updates a channel", async () => {
    const channel = await ChannelStore.create({ name: "updatable" })
    const updated = await ChannelStore.update(channel.id, {
      name: "renamed",
      enabled: false,
    })

    expect(updated).toBeDefined()
    expect(updated!.name).toBe("renamed")
    expect(updated!.enabled).toBe(false)
    expect(updated!.id).toBe(channel.id)
    expect(updated!.createdAtMs).toBe(channel.createdAtMs)
  })

  it("removes a channel", async () => {
    const channel = await ChannelStore.create({ name: "removable" })
    const removed = await ChannelStore.remove(channel.id)
    expect(removed).toBe(true)

    const fetched = await ChannelStore.get(channel.id)
    expect(fetched).toBeUndefined()
  })

  it("lists all channels", async () => {
    await ChannelStore.create({ name: "ch-a" })
    await ChannelStore.create({ name: "ch-b" })

    const channels = await ChannelStore.list()
    expect(channels.length).toBe(2)
    const names = channels.map((c) => c.name).sort()
    expect(names).toEqual(["ch-a", "ch-b"])
  })

  it("returns undefined for non-existent channel", async () => {
    const fetched = await ChannelStore.get("nonexistent")
    expect(fetched).toBeUndefined()
  })
})

describe("ChannelStore default channel bootstrap", () => {
  it("bootstraps default channel on empty dir", async () => {
    const channels = await ChannelStore.restoreOrBootstrap()

    expect(channels.length).toBe(1)
    expect(channels[0].id).toBe(DEFAULT_CHANNEL_ID)
    expect(channels[0].name).toBe("Default")
    expect(channels[0].lanePolicy).toEqual(DEFAULT_LANE_POLICY)
    expect(channels[0].enabled).toBe(true)

    // Verify it was persisted
    const fetched = await ChannelStore.get(DEFAULT_CHANNEL_ID)
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(DEFAULT_CHANNEL_ID)
  })

  it("restores existing channels without creating default", async () => {
    await ChannelStore.create({ name: "existing-channel" })

    const channels = await ChannelStore.restoreOrBootstrap()
    expect(channels.length).toBe(1)
    expect(channels[0].name).toBe("existing-channel")
    // Should NOT have created a default channel
    const defaultCh = await ChannelStore.get(DEFAULT_CHANNEL_ID)
    expect(defaultCh).toBeUndefined()
  })
})

describe("Channel schema validation", () => {
  it("rejects invalid lanePolicy (zero concurrency)", () => {
    const invalid = {
      id: "bad",
      name: "bad",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      lanePolicy: { main: 0, cron: 1, subagent: 1, nested: 1 },
      killSwitchScope: "channel",
      state: { activeSessionCount: 0 },
    }
    expect(() => ChannelInfoSchema.parse(invalid)).toThrow()
  })

  it("rejects invalid lanePolicy (negative concurrency)", () => {
    const invalid = {
      id: "bad",
      name: "bad",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      lanePolicy: { main: 1, cron: -1, subagent: 1, nested: 1 },
      killSwitchScope: "channel",
      state: { activeSessionCount: 0 },
    }
    expect(() => ChannelInfoSchema.parse(invalid)).toThrow()
  })

  it("rejects empty channel name", () => {
    const invalid = {
      id: "bad",
      name: "",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      lanePolicy: { main: 1, cron: 1, subagent: 1, nested: 1 },
      killSwitchScope: "channel",
      state: { activeSessionCount: 0 },
    }
    expect(() => ChannelInfoSchema.parse(invalid)).toThrow()
  })
})
