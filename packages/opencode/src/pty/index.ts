import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { Plugin } from "@/plugin"
import { debugCheckpoint } from "@/util/debug"
import * as fs from "fs"
import { RequestUser } from "@/runtime/request-user"

const debugLog = (...args: any[]) => {
  try {
    fs.appendFileSync(
      "/tmp/pty-debug.log",
      args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n",
    )
  } catch (e) {}
}

export namespace Pty {
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  const encoder = new TextEncoder()

  type Socket = {
    readyState: number
    data?: unknown
    send: (data: string | Uint8Array<ArrayBuffer> | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  type Subscriber = {
    id: number
    token?: unknown
  }

  const sockets = new WeakMap<object, number>()
  const owners = new WeakMap<object, string>()
  let socketCounter = 0

  const tagSocket = (ws: Socket) => {
    if (!ws || typeof ws !== "object") return
    const next = (socketCounter = (socketCounter + 1) % Number.MAX_SAFE_INTEGER)
    sockets.set(ws, next)
    return next
  }

  const token = (ws: unknown): string | number | undefined | unknown => {
    if (!ws || typeof ws !== "object") return ws
    const raw = (ws as { raw?: unknown }).raw
    const data = (ws as { data?: unknown }).data
    if (data === undefined || data === null) {
      if (raw) return token(raw)
      return undefined
    }
    if (typeof data !== "object") return data

    const id = (data as { connId?: unknown }).connId
    if (typeof id === "number" || typeof id === "string") return id

    const href = (data as { href?: unknown }).href
    if (typeof href === "string") return href

    const url = (data as { url?: unknown }).url
    if (typeof url === "string") return url
    if (url && typeof url === "object") {
      const urlHref = (url as { href?: unknown }).href
      if (typeof urlHref === "string") return urlHref
      return url
    }

    const events = (data as { events?: unknown }).events
    if (typeof events === "number" || typeof events === "string") return events
    if (events && typeof events === "object") {
      const eventsConnID = (events as { connId?: unknown }).connId
      if (typeof eventsConnID === "number" || typeof eventsConnID === "string") return eventsConnID

      const eventsConnection = (events as { connection?: unknown }).connection
      if (typeof eventsConnection === "number" || typeof eventsConnection === "string") return eventsConnection

      const eventsID = (events as { id?: unknown }).id
      if (typeof eventsID === "number" || typeof eventsID === "string") return eventsID

      return events
    }

    return data
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON (currently { cursor }).
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out.buffer
  }

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    owner?: string
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<Socket, Subscriber>
  }

  function canAccess(session: ActiveSession, owner?: string) {
    if (!session.owner) return true
    if (!owner) return false
    return session.owner === owner
  }

  function createState() {
    return new Map<string, ActiveSession>()
  }

  async function cleanupState(sessions: ReturnType<typeof createState>) {
    for (const session of sessions.values()) {
      try {
        session.process.kill()
      } catch (error) {
        debugCheckpoint("pty", "failed to kill session process during cleanup", {
          sessionID: session.info.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      for (const ws of session.subscribers.keys()) {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    }
    sessions.clear()
  }

  let stateGetter: (() => ReturnType<typeof createState>) | undefined
  let fallbackState: ReturnType<typeof createState> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState, cleanupState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export function list(owner?: string) {
    return Array.from(state().values())
      .filter((s) => canAccess(s, owner))
      .map((s) => s.info)
  }

  export function get(id: string, owner?: string) {
    const session = state().get(id)
    if (!session) return
    if (!canAccess(session, owner)) return
    return session.info
  }

  export async function create(input: CreateInput, owner = RequestUser.username()) {
    const id = Identifier.create("pty", false)
    const command = input.command || Shell.preferred()
    const args = input.args || []
    if (command.endsWith("sh")) {
      args.push("-l")
    }

    const cwd = input.cwd || Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const baseEnv = {
      ...input.env,
      ...shellEnv.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    } as Record<string, string>

    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...baseEnv,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ) as Record<string, string>

    if (process.platform === "win32") {
      env.LC_ALL = "C.UTF-8"
      env.LC_CTYPE = "C.UTF-8"
      env.LANG = "C.UTF-8"
    }
    // @event_20260319_daemonization Phase δ.3b — per-user daemon runs as correct UID;
    // sudo invocation removed.
    log.info("creating session", { id, cmd: command, args, cwd, owner })

    const spawn = await pty()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
    })

    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
    } as const
    const session: ActiveSession = {
      info,
      process: ptyProcess,
      owner,
      buffer: "",
      bufferCursor: 0,
      cursor: 0,
      subscribers: new Map(),
    }
    state().set(id, session)
    ptyProcess.onData((data) => {
      debugLog("[PTY SERVER] Process outputted length:", data.length)
      session.cursor += data.length

      for (const [ws, sub] of session.subscribers) {
        if (ws.readyState !== 1) {
          session.subscribers.delete(ws)
          continue
        }
        if (typeof ws === "object" && sockets.get(ws) !== sub.id) {
          console.log(
            "[PTY SERVER] Deleting subscriber due to socket.id mismatch! current:",
            sockets.get(ws),
            "saved:",
            sub.id,
          )
          session.subscribers.delete(ws)
          continue
        }
        // Identity guard (restored): the connection token is captured at connect()
        // from the wrapper socket (token(identity ?? ws)). If the raw socket object
        // is reused by Bun for a different connection before its onOpen runs, the
        // socket.id check above can still pass (same WeakMap-tagged object) while the
        // live identity no longer matches — output would leak to the new owner. Re-
        // derive the token from the loop's socket and drop the subscriber on mismatch.
        // Real usage is unaffected: token() delegates a data-less wrapper to its .raw,
        // so wrapper-derived sub.token === raw-derived token(ws) for genuine clients.
        if (token(ws) !== sub.token) {
          session.subscribers.delete(ws)
          continue
        }
        try {
          ws.send(data)
        } catch {
          session.subscribers.delete(ws)
        }
      }

      session.buffer += data
      if (session.buffer.length <= BUFFER_LIMIT) return
      const excess = session.buffer.length - BUFFER_LIMIT
      session.buffer = session.buffer.slice(excess)
      session.bufferCursor += excess
    })
    ptyProcess.onExit(({ exitCode }) => {
      log.info("session exited", { id, exitCode })
      session.info.status = "exited"
      for (const ws of session.subscribers.keys()) {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
      session.subscribers.clear()
      Bus.publish(Event.Exited, { id, exitCode })
      state().delete(id)
    })
    Bus.publish(Event.Created, { info })
    return info
  }

  export async function update(id: string, input: UpdateInput, owner?: string) {
    const session = state().get(id)
    if (!session) return
    if (!canAccess(session, owner)) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      session.process.resize(input.size.cols, input.size.rows)
    }
    Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function remove(id: string, owner?: string) {
    const session = state().get(id)
    if (!session) return
    if (!canAccess(session, owner)) return
    log.info("removing session", { id })
    try {
      session.process.kill()
    } catch (error) {
      debugCheckpoint("pty", "failed to kill session process during remove", {
        sessionID: id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    for (const ws of session.subscribers.keys()) {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
    session.subscribers.clear()
    state().delete(id)
    Bus.publish(Event.Deleted, { id })
  }

  export function resize(id: string, cols: number, rows: number, owner?: string) {
    const session = state().get(id)
    if (session && canAccess(session, owner) && session.info.status === "running") {
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string, owner?: string) {
    const session = state().get(id)
    if (session && canAccess(session, owner) && session.info.status === "running") {
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: Socket, cursor?: number, identity?: unknown, owner?: string) {
    debugLog("[PTY SERVER] connect called for id:", id)
    const session = state().get(id)
    if (!session) {
      ws.close()
      return
    }
    if (!canAccess(session, owner)) {
      ws.close(1008, "Forbidden")
      return
    }
    log.info("client connected to session", { id })

    const socketId = tagSocket(ws)
    if (socketId === undefined) {
      ws.close()
      return
    }

    const previous = owners.get(ws)
    if (previous && previous !== id) {
      state().get(previous)?.subscribers.delete(ws)
    }

    owners.set(ws, id)
    session.subscribers.set(ws, { id: socketId, token: token(identity ?? ws) })

    const cleanup = () => {
      session.subscribers.delete(ws)
      if (owners.get(ws) === id) owners.delete(ws)
    }

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      return session.buffer.slice(offset)
    })()

    if (data) {
      try {
        for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
          ws.send(data.slice(i, i + BUFFER_CHUNK))
        }
      } catch {
        cleanup()
        ws.close()
        return
      }
    }

    try {
      ws.send(meta(end))
    } catch {
      cleanup()
      ws.close()
      return
    }

    return {
      onMessage: async (message: any) => {
        const payload = message instanceof Blob ? await message.arrayBuffer() : message
        const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload)
        debugLog("[PTY SERVER] Received input from client length:", text.length, "content:", text)
        session.process.write(text)
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        cleanup()
      },
    }
  }
}
