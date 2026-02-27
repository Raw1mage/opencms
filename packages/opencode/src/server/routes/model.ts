import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import path from "path"
import { lazy } from "../../util/lazy"
import { Global } from "../../global"

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
