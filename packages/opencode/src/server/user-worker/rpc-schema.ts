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
        limit: z.number().int().positive().max(200).optional(),
        scope: SessionScope.optional(),
      }),
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
