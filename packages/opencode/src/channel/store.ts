import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import {
  ChannelInfoSchema,
  type ChannelInfo,
  type ChannelCreate,
  type ChannelPatch,
  DEFAULT_CHANNEL_ID,
  DEFAULT_LANE_POLICY,
  createDefaultChannel,
} from "./types"

/**
 * Channel store — per-file JSON persistence at ~/.config/opencode/channels/<channelId>.json
 *
 * IDEF0 reference: A22 (Persist Channel Configuration)
 * Design decision: DD-14 (per-file JSON), DD-17 (auto-bootstrap default)
 */
export namespace ChannelStore {
  const log = Log.create({ service: "channel.store" })
  const LOCK_KEY = "channel:store"

  function channelDir(): string {
    return path.join(Global.Path.config, "channels")
  }

  function channelPath(channelId: string): string {
    return path.join(channelDir(), `${channelId}.json`)
  }

  async function readChannel(channelId: string): Promise<ChannelInfo | undefined> {
    try {
      const raw = await Bun.file(channelPath(channelId)).text()
      const parsed = JSON.parse(raw)
      return ChannelInfoSchema.parse(parsed)
    } catch {
      return undefined
    }
  }

  async function writeChannel(channel: ChannelInfo): Promise<void> {
    await fs.mkdir(channelDir(), { recursive: true })
    await Bun.write(channelPath(channel.id), JSON.stringify(channel, null, 2))
  }

  // --- CRUD ---

  export async function get(channelId: string): Promise<ChannelInfo | undefined> {
    using _lock = await Lock.read(LOCK_KEY)
    return readChannel(channelId)
  }

  export async function list(): Promise<ChannelInfo[]> {
    using _lock = await Lock.read(LOCK_KEY)
    const dir = channelDir()
    try {
      const files = await fs.readdir(dir)
      const channels: ChannelInfo[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const id = file.replace(/\.json$/, "")
        const ch = await readChannel(id)
        if (ch) channels.push(ch)
      }
      return channels
    } catch {
      return []
    }
  }

  export async function create(input: ChannelCreate): Promise<ChannelInfo> {
    using _lock = await Lock.write(LOCK_KEY)
    const now = Date.now()
    const channel: ChannelInfo = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      lanePolicy: {
        ...DEFAULT_LANE_POLICY,
        ...input.lanePolicy,
      },
      killSwitchScope: input.killSwitchScope ?? "channel",
      sessionFilter: input.sessionFilter,
      state: {
        activeSessionCount: 0,
      },
    }
    // Validate before writing
    ChannelInfoSchema.parse(channel)
    await writeChannel(channel)
    log.info("created", { id: channel.id, name: channel.name })
    return channel
  }

  export async function update(
    channelId: string,
    patch: ChannelPatch,
  ): Promise<ChannelInfo | undefined> {
    using _lock = await Lock.write(LOCK_KEY)
    const existing = await readChannel(channelId)
    if (!existing) return undefined

    const updated: ChannelInfo = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: Date.now(),
      lanePolicy: patch.lanePolicy
        ? { ...existing.lanePolicy, ...patch.lanePolicy }
        : existing.lanePolicy,
      state: existing.state,
    }
    ChannelInfoSchema.parse(updated)
    await writeChannel(updated)
    log.info("updated", { id: channelId })
    return updated
  }

  export async function remove(channelId: string): Promise<boolean> {
    using _lock = await Lock.write(LOCK_KEY)
    const filePath = channelPath(channelId)
    try {
      await fs.unlink(filePath)
      log.info("removed", { id: channelId })
      return true
    } catch {
      return false
    }
  }

  // --- Bootstrap ---

  /**
   * Restore existing channels or bootstrap default channel if store is empty.
   * Called on daemon boot after scheduler recovery.
   *
   * IDEF0 reference: A21 (Bootstrap Default Channel)
   * Design decision: DD-17 (auto-bootstrap on empty)
   */
  export async function restoreOrBootstrap(): Promise<ChannelInfo[]> {
    const channels = await list()
    if (channels.length > 0) {
      log.info("restored channels", { count: channels.length })
      return channels
    }

    // Empty store — bootstrap default channel
    const defaultChannel = createDefaultChannel()
    using _lock = await Lock.write(LOCK_KEY)
    await writeChannel(defaultChannel)
    log.info("bootstrapped default channel")
    return [defaultChannel]
  }
}
