import { Instance } from "@/project/instance"
import { Plugin } from "../plugin"
import { map, filter, pipe, fromEntries, mapValues } from "remeda"
import z from "zod"
import { fn } from "@/util/fn"
import type { AuthOuathResult, Hooks } from "@opencode-ai/plugin"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "@/auth"

export namespace ProviderAuth {
  async function createState() {
    const methods = pipe(
      await Plugin.list(),
      filter((x) => x.auth?.provider !== undefined),
      map((x) => [x.auth!.provider, x.auth!] as const),
      fromEntries(),
    )
    return { methods, pending: {} as Record<string, AuthOuathResult> }
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods() {
    const s = await state().then((x) => x.methods)
    return mapValues(s, (x) =>
      x.methods.map(
        (y): Method => ({
          type: y.type,
          label: y.label,
        }),
      ),
    )
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
      /**
       * When method is "auto", indicates the plugin also accepts a manual
       * paste-callback-URL fallback. UI should render a paste field alongside
       * the auto-callback waiting state.
       */
      hasCodeFallback: z.boolean().optional(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  export const authorize = fn(
    z.object({
      providerId: z.string(),
      method: z.number(),
    }),
    async (input): Promise<Authorization | undefined> => {
      const auth = await state().then((s) => s.methods[input.providerId])
      const method = auth.methods[input.method]
      if (method.type === "oauth") {
        const result = await method.authorize()
        await state().then((s) => (s.pending[input.providerId] = result))
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
          hasCodeFallback: result.method === "auto" && typeof (result as { code?: unknown }).code === "function",
        }
      }
    },
  )

  export const callback = fn(
    z.object({
      providerId: z.string(),
      method: z.number(),
      code: z.string().optional(),
    }),
    async (input) => {
      const match = await state().then((s) => s.pending[input.providerId])
      if (!match) throw new OauthMissing({ providerId: input.providerId })
      let result

      if (match.method === "code") {
        if (!input.code) throw new OauthCodeMissing({ providerId: input.providerId })
        result = await match.callback(input.code)
      }

      if (match.method === "auto") {
        // Hybrid: if caller provided a code AND the auto match exposes a paste
        // fallback, route to the manual exchange instead of long-polling for
        // the local OAuth server callback.
        if (input.code && typeof match.code === "function") {
          result = await match.code(input.code)
        } else {
          result = await match.callback()
        }
      }

      if (result?.type === "success") {
        if ("key" in result) {
          await Auth.set(input.providerId, {
            type: "api",
            key: result.key,
          })
        }
        if ("refresh" in result) {
          const info: Auth.Info = {
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          }
          if (result.accountId) {
            info.accountId = result.accountId
          }
          // Standardized identity fields from AuthIdentity contract
          if ("email" in result && typeof result.email === "string") {
            info.email = result.email
          }
          if ("username" in result && typeof result.username === "string") {
            info.username = result.username
          }
          await Auth.set(input.providerId, info)
        }
        return
      }

      throw new OauthCallbackFailed({})
    },
  )

  export const api = fn(
    z.object({
      providerId: z.string(),
      key: z.string(),
    }),
    async (input) => {
      await Auth.set(input.providerId, {
        type: "api",
        key: input.key,
      })
    },
  )

  export const OauthMissing = NamedError.create(
    "ProviderAuthOauthMissing",
    z.object({
      providerId: z.string(),
    }),
  )
  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({
      providerId: z.string(),
    }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))
}
