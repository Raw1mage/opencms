import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { createInterface } from "node:readline"
import { Session } from "@/session"
import { Config } from "@/config/config"
import { UserWorkerRPC } from "@/server/user-worker"
import { Account } from "@/account"
import { Auth } from "@/auth"

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
              limit: request.payload.limit,
              roots: request.payload.scope === "roots" ? true : undefined,
            })) {
              rows.push(session)
            }
            send({ type: "response", id: packet.id, response: { ok: true, data: rows } })
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
