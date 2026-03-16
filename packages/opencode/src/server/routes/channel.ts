import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { ChannelStore, ChannelInfoSchema, LanePolicySchema } from "@/channel"

/**
 * Channel CRUD API routes — /api/v2/channel/
 *
 * IDEF0 reference: A51 (Handle Channel CRUD Requests)
 */

const ChannelCreateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  lanePolicy: LanePolicySchema.partial().optional(),
  killSwitchScope: z.enum(["channel", "global"]).optional(),
})

const ChannelPatchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  lanePolicy: LanePolicySchema.partial().optional(),
  killSwitchScope: z.enum(["channel", "global"]).optional(),
})

export const ChannelRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List channels",
        description: "List all channels.",
        operationId: "channel.list",
        responses: {
          200: {
            description: "Channel list",
            content: {
              "application/json": {
                schema: resolver(z.array(ChannelInfoSchema)),
              },
            },
          },
        },
      }),
      async (c) => {
        const channels = await ChannelStore.list()
        return c.json(channels)
      },
    )
    .get(
      "/:channelId",
      describeRoute({
        summary: "Get channel",
        description: "Get a specific channel by ID.",
        operationId: "channel.get",
        responses: {
          200: {
            description: "Channel info",
            content: {
              "application/json": {
                schema: resolver(ChannelInfoSchema),
              },
            },
          },
          404: { description: "Channel not found" },
        },
      }),
      async (c) => {
        const channelId = c.req.param("channelId")
        const channel = await ChannelStore.get(channelId)
        if (!channel) return c.json({ error: "not_found" }, 404)
        return c.json(channel)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create channel",
        description: "Create a new channel with optional lane policy.",
        operationId: "channel.create",
        responses: {
          201: {
            description: "Channel created",
            content: {
              "application/json": {
                schema: resolver(ChannelInfoSchema),
              },
            },
          },
          400: { description: "Validation error" },
        },
      }),
      async (c) => {
        const body = ChannelCreateBody.safeParse(await c.req.json())
        if (!body.success) return c.json({ error: "validation", details: body.error.flatten() }, 400)
        const channel = await ChannelStore.create(body.data)
        return c.json(channel, 201)
      },
    )
    .patch(
      "/:channelId",
      describeRoute({
        summary: "Update channel",
        description: "Update an existing channel.",
        operationId: "channel.update",
        responses: {
          200: {
            description: "Channel updated",
            content: {
              "application/json": {
                schema: resolver(ChannelInfoSchema),
              },
            },
          },
          404: { description: "Channel not found" },
          400: { description: "Validation error" },
        },
      }),
      async (c) => {
        const channelId = c.req.param("channelId")
        const body = ChannelPatchBody.safeParse(await c.req.json())
        if (!body.success) return c.json({ error: "validation", details: body.error.flatten() }, 400)
        const channel = await ChannelStore.update(channelId, body.data)
        if (!channel) return c.json({ error: "not_found" }, 404)
        return c.json(channel)
      },
    )
    .delete(
      "/:channelId",
      describeRoute({
        summary: "Delete channel",
        description: "Delete a channel. Cannot delete the default channel.",
        operationId: "channel.delete",
        responses: {
          200: { description: "Channel deleted" },
          404: { description: "Channel not found" },
          409: { description: "Cannot delete default channel" },
        },
      }),
      async (c) => {
        const channelId = c.req.param("channelId")
        if (channelId === "default") {
          return c.json({ error: "cannot_delete_default" }, 409)
        }
        const removed = await ChannelStore.remove(channelId)
        if (!removed) return c.json({ error: "not_found" }, 404)
        return c.json({ ok: true })
      },
    ),
)
