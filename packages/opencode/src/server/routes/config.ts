import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { RequestUser } from "@/runtime/request-user"
import { UserDaemonManager } from "../user-daemon"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeConfigEnabled()) {
          const response = await UserDaemonManager.callConfigGet<z.infer<typeof Config.Info>>(username)
          if (response.ok) {
            return c.json(response.data)
          }
          log.warn("per-user daemon config.get failed", {
            username,
            code: response.error.code,
            message: response.error.message,
          })
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeConfigEnabled()) {
          const response = await UserDaemonManager.callConfigUpdate<z.infer<typeof Config.Info>>(username, config)
          if (response.ok) {
            return c.json(config)
          }
          log.warn("per-user daemon config.update failed", {
            username,
            code: response.error.code,
            message: response.error.message,
          })
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    ),
)
