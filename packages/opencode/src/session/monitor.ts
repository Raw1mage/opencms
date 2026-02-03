import z from "zod"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"

export namespace SessionMonitor {
  export const Status = z
    .union([
      SessionStatus.Info,
      z.object({
        type: z.literal("working"),
      }),
      z.object({
        type: z.literal("compacting"),
      }),
      z.object({
        type: z.literal("pending"),
      }),
      z.object({
        type: z.literal("error"),
        message: z.string().optional(),
      }),
    ])
    .meta({
      ref: "SessionMonitorStatus",
    })
  export type Status = z.infer<typeof Status>

  export const Info = z
    .object({
      sessionID: z.string(),
      title: z.string(),
      parentID: z.string().optional(),
      agent: z.string().optional(),
      status: Status,
      model: z
        .object({
          providerID: z.string(),
          modelID: z.string(),
        })
        .optional(),
      requests: z.number(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      }),
      totalTokens: z.number(),
      activeTool: z.string().optional(),
      activeToolStatus: z.string().optional(),
      updated: z.number(),
    })
    .meta({
      ref: "SessionMonitorInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function snapshot() {
    const result: Info[] = []
    for await (const session of Session.list()) {
      const sums = {
        requests: 0,
        total: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      }
      const model = {
        value: undefined as { providerID: string; modelID: string } | undefined,
      }
      const agent = {
        value: undefined as string | undefined,
      }
      const tool = {
        name: undefined as string | undefined,
        status: undefined as string | undefined,
      }
      const latest = {
        value: undefined as MessageV2.Info | undefined,
      }

      for await (const message of MessageV2.stream(session.id)) {
        if (!latest.value) latest.value = message.info
        if (message.info.role === "assistant") {
          const info = message.info
          const total =
            info.tokens.input +
            info.tokens.output +
            info.tokens.reasoning +
            info.tokens.cache.read +
            info.tokens.cache.write
          if (!model.value && total > 0) {
            model.value = {
              providerID: info.providerID,
              modelID: info.modelID,
            }
          }
          if (!agent.value) agent.value = info.agent
          if (total > 0) sums.requests += 1
          sums.tokens.input += info.tokens.input
          sums.tokens.output += info.tokens.output
          sums.tokens.reasoning += info.tokens.reasoning
          sums.tokens.cache.read += info.tokens.cache.read
          sums.tokens.cache.write += info.tokens.cache.write
          sums.total += total
        }

        if (!tool.name) {
          const part = message.parts.find(
            (item) => item.type === "tool" && (item.state.status === "pending" || item.state.status === "running"),
          )
          if (part && part.type === "tool") {
            tool.name = part.tool
            tool.status = part.state.status
          }
        }
      }

      const status = (() => {
        if (session.time.compacting) return { type: "compacting" } as Status
        const current = SessionStatus.get(session.id)
        if (current.type !== "idle") return current
        const last = latest.value
        if (!last) return { type: "pending" } as Status
        if (last.role === "assistant" && last.error) {
          const err = last.error as any
          return { type: "error", message: err.message || err.data?.message || "Unknown error" } as Status
        }
        if (last.role === "assistant" && !last.time.completed) return { type: "working" } as Status
        if (last.role === "user") return { type: "working" } as Status
        return current
      })()

      result.push({
        sessionID: session.id,
        title: session.title,
        parentID: session.parentID,
        agent: agent.value,
        status,
        model: model.value,
        requests: sums.requests,
        tokens: sums.tokens,
        totalTokens: sums.total,
        activeTool: tool.name,
        activeToolStatus: tool.status,
        updated: session.time.updated,
      })
    }
    result.sort((a, b) => b.updated - a.updated)
    return result
  }
}
