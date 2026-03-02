import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { createInterface } from "node:readline"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionMonitor } from "@/session/monitor"
import { Todo } from "@/session/todo"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Config } from "@/config/config"
import { UserWorkerRPC } from "@/server/user-worker"
import { Account } from "@/account"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { Global } from "@/global"
import path from "path"
import z from "zod"

const ModelPreferenceEntry = z.object({
  providerId: z.string(),
  modelID: z.string(),
})
const ModelPreferences = z.object({
  favorite: z.array(ModelPreferenceEntry),
  hidden: z.array(ModelPreferenceEntry),
  hiddenProviders: z.array(z.string()),
})
const MODEL_STATE_FILE = path.join(Global.Path.state, "model.json")

async function readModelState(): Promise<Record<string, unknown>> {
  const file = Bun.file(MODEL_STATE_FILE)
  if (!(await file.exists())) return {}
  try {
    const parsed = await file.json()
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

function normalizePreferences(value: Record<string, unknown>) {
  const parsed = ModelPreferences.safeParse({
    favorite: value.favorite,
    hidden: value.hidden,
    hiddenProviders: value.hiddenProviders,
  })
  if (parsed.success) return parsed.data
  return {
    favorite: [],
    hidden: [],
    hiddenProviders: [],
  }
}

const WORKER_PREFIX = "__OPENCODE_USER_WORKER__ "

function send(payload: Record<string, unknown>) {
  process.stdout.write(WORKER_PREFIX + JSON.stringify(payload) + "\n")
}

export const UserWorkerCommand = cmd({
  command: "user-worker",
  describe: "run per-user runtime worker",
  builder: (yargs) =>
    yargs.option("stdio", {
      type: "boolean",
      default: true,
      describe: "Use stdio JSON-line transport",
    }),
  handler: async () => {
    process.env.OPENCODE_NON_INTERACTIVE = "1"

    await bootstrap(process.cwd(), async () => {
      const rl = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      })

      send({ type: "ready", pid: process.pid })

      const heartbeat = setInterval(() => {
        send({ type: "heartbeat", pid: process.pid, ts: Date.now() })
      }, 5000)
      if (typeof heartbeat.unref === "function") heartbeat.unref()

      for await (const raw of rl) {
        const line = raw.trim()
        if (!line) continue

        let input: unknown
        try {
          input = JSON.parse(line)
        } catch {
          send({ type: "response", ok: false, error: { code: "INVALID_JSON", message: "Invalid JSON line" } })
          continue
        }

        const packet =
          typeof input === "object" && input !== null && "id" in input && "request" in input
            ? (input as { id: string; request: unknown })
            : undefined

        if (!packet || typeof packet.id !== "string") {
          send({ type: "response", ok: false, error: { code: "BAD_PACKET", message: "Missing packet id/request" } })
          continue
        }

        const parsed = UserWorkerRPC.Request.safeParse(packet.request)
        if (!parsed.success) {
          send({
            type: "response",
            id: packet.id,
            response: {
              ok: false,
              error: { code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid request" },
            },
          })
          continue
        }

        try {
          const request = parsed.data
          if (request.method === "health") {
            send({
              type: "response",
              id: packet.id,
              response: { ok: true, data: { pid: process.pid, ts: Date.now() } },
            })
            continue
          }

          if (request.method === "session.list") {
            const rows: Session.GlobalInfo[] = []
            for await (const session of Session.listGlobal({
              directory: request.payload.directory,
              search: request.payload.search,
              start: request.payload.start,
              limit: request.payload.limit,
              roots: request.payload.scope === "roots" ? true : undefined,
            })) {
              rows.push(session)
            }
            send({ type: "response", id: packet.id, response: { ok: true, data: rows } })
            continue
          }

          if (request.method === "session.status") {
            send({ type: "response", id: packet.id, response: { ok: true, data: SessionStatus.list() } })
            continue
          }

          if (request.method === "session.top") {
            const result = await SessionMonitor.snapshot({
              sessionID: request.payload?.sessionID,
              includeDescendants: request.payload?.includeDescendants,
              maxMessages: request.payload?.maxMessages,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data: result } })
            continue
          }

          if (request.method === "session.get") {
            const data = await Session.get(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.children") {
            const data = await Session.children(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.todo") {
            const data = await Todo.get(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.messages") {
            const data = await Session.messages({
              sessionID: request.payload.sessionID,
              limit: request.payload.limit,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.message.get") {
            const data = await MessageV2.get({
              sessionID: request.payload.sessionID,
              messageID: request.payload.messageID,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.diff") {
            const data = await SessionSummary.diff({
              sessionID: request.payload.sessionID,
              messageID: request.payload.messageID,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.create") {
            const body = (request.payload?.body ?? {}) as Parameters<typeof Session.create>[0]
            const data = await Session.create(body)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.delete") {
            void Session.remove(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "session.update") {
            const updates = request.payload.updates as { title?: string; time?: { archived?: number } }
            const data = await Session.update(
              request.payload.sessionID,
              (session) => {
                if (updates.title !== undefined) session.title = updates.title
                if (updates.time?.archived !== undefined) session.time.archived = updates.time.archived
              },
              { touch: false },
            )
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.abort") {
            SessionPrompt.cancel(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "session.prompt_async") {
            const data = await SessionPrompt.prompt({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.prompt") {
            const data = await SessionPrompt.prompt({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.command") {
            const data = await SessionPrompt.command({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.shell") {
            const data = await SessionPrompt.shell({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.revert") {
            const data = await SessionRevert.revert({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.unrevert") {
            const data = await SessionRevert.unrevert({ sessionID: request.payload.sessionID })
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.message.delete") {
            SessionPrompt.assertNotBusy(request.payload.sessionID)
            await Session.removeMessage({
              sessionID: request.payload.sessionID,
              messageID: request.payload.messageID,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "session.part.delete") {
            await Session.removePart({
              sessionID: request.payload.sessionID,
              messageID: request.payload.messageID,
              partID: request.payload.partID,
            })
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "session.part.update") {
            const data = await Session.updatePart(request.payload.part as MessageV2.Part)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.init") {
            await Session.initialize({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "session.fork") {
            const data = await Session.fork({
              ...(request.payload.body as Record<string, unknown>),
              sessionID: request.payload.sessionID,
            } as any)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.share") {
            await Session.share(request.payload.sessionID)
            const data = await Session.get(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.unshare") {
            await Session.unshare(request.payload.sessionID)
            const data = await Session.get(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data } })
            continue
          }

          if (request.method === "session.summarize") {
            const body = request.payload.body as { providerId: string; modelID: string; auto?: boolean }
            const session = await Session.get(request.payload.sessionID)
            await SessionRevert.cleanup(session)
            const msgs = await Session.messages({ sessionID: request.payload.sessionID })
            let currentAgent = await Agent.defaultAgent()
            for (let i = msgs.length - 1; i >= 0; i--) {
              const info = msgs[i].info
              if (info.role === "user") {
                currentAgent = info.agent || (await Agent.defaultAgent())
                break
              }
            }
            await SessionCompaction.create({
              sessionID: request.payload.sessionID,
              agent: currentAgent,
              model: {
                providerId: body.providerId,
                modelID: body.modelID,
              },
              auto: body.auto ?? false,
            })
            await SessionPrompt.loop(request.payload.sessionID)
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "config.get") {
            const cfg = await Config.getGlobal()
            if (request.payload?.key) {
              const key = request.payload.key
              const data = (cfg as Record<string, unknown>)[key]
              send({ type: "response", id: packet.id, response: { ok: true, data } })
            } else {
              send({ type: "response", id: packet.id, response: { ok: true, data: cfg } })
            }
            continue
          }

          if (request.method === "account.list") {
            const families = await Account.listAll()
            send({
              type: "response",
              id: packet.id,
              response: {
                ok: true,
                data: {
                  families,
                },
              },
            })
            continue
          }

          if (request.method === "config.update") {
            const parsedConfig = Config.Info.safeParse(request.payload.config)
            if (!parsedConfig.success) {
              send({
                type: "response",
                id: packet.id,
                response: {
                  ok: false,
                  error: {
                    code: "BAD_CONFIG",
                    message: parsedConfig.error.issues[0]?.message ?? "Invalid config payload",
                  },
                },
              })
              continue
            }
            await Config.update(parsedConfig.data)
            send({
              type: "response",
              id: packet.id,
              response: {
                ok: true,
                data: parsedConfig.data,
              },
            })
            continue
          }

          if (request.method === "account.setActive") {
            const { family, accountId } = request.payload
            if (family === "antigravity") {
              const { AccountManager } = await import("@/plugin/antigravity/plugin/accounts")
              const { clearAccountCache } = await import("@/plugin/antigravity/plugin/storage")
              const auth = await Auth.get("antigravity")
              if (auth && auth.type === "oauth") {
                const manager = await AccountManager.loadFromDisk(auth)
                const index = parseInt(accountId, 10)
                if (!isNaN(index)) {
                  manager.setActiveIndex(index)
                  await manager.saveToDisk()
                  clearAccountCache()
                }
              }
            } else {
              await Account.setActive(family, accountId)
            }
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "account.remove") {
            const { family, accountId } = request.payload
            if (family === "antigravity") {
              const { AccountManager } = await import("@/plugin/antigravity/plugin/accounts")
              const { clearAccountCache } = await import("@/plugin/antigravity/plugin/storage")
              const auth = await Auth.get("antigravity")
              if (auth && auth.type === "oauth") {
                const manager = await AccountManager.loadFromDisk(auth)
                const index = parseInt(accountId, 10)
                if (!isNaN(index)) {
                  manager.removeAccountByIndex(index)
                  await manager.saveToDisk()
                  clearAccountCache()
                }
              }
            } else {
              await Account.remove(family, accountId)
            }
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "account.antigravityToggle") {
            const { index, enabled } = request.payload
            const { AccountManager } = await import("@/plugin/antigravity/plugin/accounts")
            const { clearAccountCache } = await import("@/plugin/antigravity/plugin/storage")
            const auth = await Auth.get("antigravity")
            if (auth && auth.type === "oauth") {
              const manager = await AccountManager.loadFromDisk(auth)
              const account = manager.getAccount(index)
              if (account) {
                account.enabled = enabled
                await manager.saveToDisk()
                clearAccountCache()
              }
            }
            send({ type: "response", id: packet.id, response: { ok: true, data: true } })
            continue
          }

          if (request.method === "model.preferences.get") {
            const state = await readModelState()
            send({ type: "response", id: packet.id, response: { ok: true, data: normalizePreferences(state) } })
            continue
          }

          if (request.method === "model.preferences.update") {
            const parsed = ModelPreferences.safeParse(request.payload.preferences)
            if (!parsed.success) {
              send({
                type: "response",
                id: packet.id,
                response: {
                  ok: false,
                  error: { code: "BAD_MODEL_PREFS", message: parsed.error.issues[0]?.message ?? "Invalid preferences" },
                },
              })
              continue
            }
            const current = await readModelState()
            const next = {
              ...current,
              favorite: parsed.data.favorite,
              hidden: parsed.data.hidden,
              hiddenProviders: parsed.data.hiddenProviders,
            }
            await Bun.write(Bun.file(MODEL_STATE_FILE), JSON.stringify(next))
            send({ type: "response", id: packet.id, response: { ok: true, data: parsed.data } })
            continue
          }

          send({
            type: "response",
            id: packet.id,
            response: { ok: false, error: { code: "NOT_IMPLEMENTED", message: "Method not implemented" } },
          })
        } catch (error) {
          send({
            type: "response",
            id: packet.id,
            response: {
              ok: false,
              error: {
                code: "INTERNAL",
                message: error instanceof Error ? error.message : String(error),
              },
            },
          })
        }
      }

      clearInterval(heartbeat)
    })
  },
})
