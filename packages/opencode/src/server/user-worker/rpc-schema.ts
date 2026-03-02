import z from "zod"

export namespace UserWorkerRPC {
  export const SessionScope = z.enum(["all", "roots", "active"])

  export const Request = z.discriminatedUnion("method", [
    z.object({
      method: z.literal("health"),
      payload: z.object({}).optional(),
    }),
    z.object({
      method: z.literal("session.list"),
      payload: z.object({
        directory: z.string().optional(),
        search: z.string().optional(),
        start: z.number().optional(),
        limit: z.number().int().positive().max(200).optional(),
        scope: SessionScope.optional(),
      }),
    }),
    z.object({
      method: z.literal("session.status"),
      payload: z.object({}).optional(),
    }),
    z.object({
      method: z.literal("session.top"),
      payload: z
        .object({
          sessionID: z.string().optional(),
          includeDescendants: z.boolean().optional(),
          maxMessages: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      method: z.literal("session.get"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.children"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.todo"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.messages"),
      payload: z.object({ sessionID: z.string(), limit: z.number().optional() }),
    }),
    z.object({
      method: z.literal("session.message.get"),
      payload: z.object({ sessionID: z.string(), messageID: z.string() }),
    }),
    z.object({
      method: z.literal("session.diff"),
      payload: z.object({ sessionID: z.string(), messageID: z.string() }),
    }),
    z.object({
      method: z.literal("session.create"),
      payload: z.object({ body: z.unknown().optional() }).optional(),
    }),
    z.object({
      method: z.literal("session.delete"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.update"),
      payload: z.object({ sessionID: z.string(), updates: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.abort"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.prompt_async"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.prompt"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.command"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.shell"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.revert"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.unrevert"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.message.delete"),
      payload: z.object({ sessionID: z.string(), messageID: z.string() }),
    }),
    z.object({
      method: z.literal("session.part.delete"),
      payload: z.object({ sessionID: z.string(), messageID: z.string(), partID: z.string() }),
    }),
    z.object({
      method: z.literal("session.part.update"),
      payload: z.object({ part: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.init"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.fork"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("session.share"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.unshare"),
      payload: z.object({ sessionID: z.string() }),
    }),
    z.object({
      method: z.literal("session.summarize"),
      payload: z.object({ sessionID: z.string(), body: z.unknown() }),
    }),
    z.object({
      method: z.literal("config.get"),
      payload: z.object({ key: z.string().optional() }).optional(),
    }),
    z.object({
      method: z.literal("config.update"),
      payload: z.object({ config: z.unknown() }),
    }),
    z.object({
      method: z.literal("account.list"),
      payload: z.object({ includeAntigravity: z.boolean().optional() }).optional(),
    }),
    z.object({
      method: z.literal("account.setActive"),
      payload: z.object({ family: z.string(), accountId: z.string() }),
    }),
    z.object({
      method: z.literal("account.remove"),
      payload: z.object({ family: z.string(), accountId: z.string() }),
    }),
    z.object({
      method: z.literal("account.antigravityToggle"),
      payload: z.object({ index: z.number(), enabled: z.boolean() }),
    }),
    z.object({
      method: z.literal("model.preferences.get"),
      payload: z.object({}).optional(),
    }),
    z.object({
      method: z.literal("model.preferences.update"),
      payload: z.object({ preferences: z.unknown() }),
    }),
  ])

  export type Request = z.infer<typeof Request>

  export const Response = z.object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
  })

  export type Response = z.infer<typeof Response>
}
