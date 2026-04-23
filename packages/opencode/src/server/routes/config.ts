import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Tweaks } from "../../config/tweaks"
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
    )
    .get(
      "/tweaks/frontend",
      describeRoute({
        summary: "Get frontend tweaks",
        description:
          "Return the frontend-facing subset of /etc/opencode/tweaks.cfg so the webapp does not have to read the file itself. See specs/frontend-session-lazyload/ DD-3, DD-7, DD-8.",
        operationId: "config.tweaks.frontend",
        responses: {
          200: {
            description: "Frontend tweaks",
            content: {
              "application/json": {
                schema: resolver(FrontendTweaksResponse),
              },
            },
          },
        },
      }),
      async (c) => {
        const cfg = await Tweaks.frontendLazyload()
        const uiCfg = await Tweaks.sessionUiFreshness()
        return c.json({
          frontend_session_lazyload: cfg.flag,
          part_inline_cap_kb: cfg.partInlineCapKb,
          tail_window_kb: cfg.tailWindowKb,
          fold_preview_lines: cfg.foldPreviewLines,
          initial_page_size_small: cfg.initialPageSizeSmall,
          initial_page_size_medium: cfg.initialPageSizeMedium,
          initial_page_size_large: cfg.initialPageSizeLarge,
          session_size_threshold_kb: cfg.sessionSizeThresholdKb,
          session_size_threshold_parts: cfg.sessionSizeThresholdParts,
          // session-ui-freshness DD-3 / DD-5
          ui_session_freshness_enabled: uiCfg.flag,
          ui_freshness_threshold_sec: uiCfg.softThresholdSec,
          ui_freshness_hard_timeout_sec: uiCfg.hardTimeoutSec,
          // mobile-tail-first-simplification DD-1 / DD-4
          session_tail_mobile: cfg.sessionTailMobile,
          session_tail_desktop: cfg.sessionTailDesktop,
          session_store_cap_mobile: cfg.sessionStoreCapMobile,
          session_store_cap_desktop: cfg.sessionStoreCapDesktop,
          session_part_cap_bytes: cfg.sessionPartCapBytes,
        } satisfies z.infer<typeof FrontendTweaksResponse>)
      },
    ),
)

const FrontendTweaksResponse = z.object({
  frontend_session_lazyload: z.union([z.literal(0), z.literal(1)]),
  part_inline_cap_kb: z.number().int().min(4).max(4096),
  tail_window_kb: z.number().int().min(4).max(4096),
  fold_preview_lines: z.number().int().min(1).max(200),
  initial_page_size_small: z.union([z.literal("all"), z.number().int().min(10).max(1000)]),
  initial_page_size_medium: z.number().int().min(10).max(1000),
  initial_page_size_large: z.number().int().min(10).max(1000),
  session_size_threshold_kb: z.number().int().min(64),
  session_size_threshold_parts: z.number().int().min(10),
  // session-ui-freshness DD-3 / DD-5
  ui_session_freshness_enabled: z.union([z.literal(0), z.literal(1)]),
  ui_freshness_threshold_sec: z.number().int().min(1).max(3600),
  ui_freshness_hard_timeout_sec: z.number().int().min(1).max(86400),
  // mobile-tail-first-simplification DD-1 / DD-4
  session_tail_mobile: z.number().int().min(5).max(500),
  session_tail_desktop: z.number().int().min(5).max(2000),
  session_store_cap_mobile: z.number().int().min(30).max(2000),
  session_store_cap_desktop: z.number().int().min(50).max(5000),
  session_part_cap_bytes: z.number().int().min(16_000).max(16_000_000),
})
