import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import { lazy } from "../../util/lazy"
import { Global } from "../../global"
import { RequestUser } from "@/runtime/request-user"
import { UserDaemonManager } from "../user-daemon"

const ModelPreferenceEntry = z.object({
  providerId: z.string(),
  modelID: z.string(),
})

const ModelPreferences = z.object({
  favorite: z.array(ModelPreferenceEntry),
  hidden: z.array(ModelPreferenceEntry),
  hiddenProviders: z.array(z.string()),
})

type ModelPreferences = z.infer<typeof ModelPreferences>

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

function normalizePreferences(value: Record<string, unknown>): ModelPreferences {
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

export const ModelRoutes = lazy(() =>
  new Hono()
    .get(
      "/preferences",
      describeRoute({
        summary: "Get model preferences",
        description: "Get persisted model favorites/hidden metadata used by TUI and Web selectors.",
        operationId: "model.preferences.get",
        responses: {
          200: {
            description: "Model preferences",
            content: {
              "application/json": {
                schema: resolver(ModelPreferences),
              },
            },
          },
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeModelPreferencesEnabled()) {
          const response = await UserDaemonManager.callModelPreferencesGet<ModelPreferences>(username)
          if (response.ok && response.data && typeof response.data === "object") {
            return c.json(response.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok ? "daemon model.preferences.get payload is not an object" : response.error.message,
            },
            503,
          )
        }
        const state = await readModelState()
        return c.json(normalizePreferences(state))
      },
    )
    .patch(
      "/preferences",
      describeRoute({
        summary: "Update model preferences",
        description: "Update persisted model favorites/hidden metadata while preserving unrelated model state fields.",
        operationId: "model.preferences.update",
        responses: {
          200: {
            description: "Updated model preferences",
            content: {
              "application/json": {
                schema: resolver(ModelPreferences),
              },
            },
          },
        },
      }),
      validator("json", ModelPreferences),
      async (c) => {
        const payload = c.req.valid("json")
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeModelPreferencesEnabled()) {
          const response = await UserDaemonManager.callModelPreferencesUpdate<ModelPreferences>(username, payload)
          if (response.ok && response.data && typeof response.data === "object") {
            return c.json(response.data)
          }
          return c.json(
            {
              code: response.ok ? "DAEMON_INVALID_PAYLOAD" : response.error.code,
              message: response.ok
                ? "daemon model.preferences.update payload is not an object"
                : response.error.message,
            },
            503,
          )
        }
        const current = await readModelState()
        const next = {
          ...current,
          favorite: payload.favorite,
          hidden: payload.hidden,
          hiddenProviders: payload.hiddenProviders,
        }
        await Bun.write(Bun.file(MODEL_STATE_FILE), JSON.stringify(next))
        return c.json(payload)
      },
    ),
)
