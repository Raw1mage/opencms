import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Account } from "../../account"
import { lazy } from "../../util/lazy"

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        // Wait for discovery to be sure we have the latest account-specific models
        const connected = await Provider.list()

        const providers: Record<string, Provider.Info> = {}

        // Get all families with accounts to determine multi-account status dynamically
        const familiesWithAccounts = await Account.listAll()

        // Merge ModelsDev providers
        for (const [id, devProvider] of Object.entries(filteredProviders)) {
          const family = Account.parseFamily(id) || id
          // A provider has multi-account if it has accounts in storage (not a whitelist)
          const hasAccountsConfigured = !!(
            familiesWithAccounts[family]?.accounts && Object.keys(familiesWithAccounts[family].accounts).length > 0
          )

          if (hasAccountsConfigured) {
            // For multi-account families, we should only show models if they are either:
            // 1. In the 'connected' list (meaning they were discovered specifically for the active account)
            // 2. Public models (cost.input === 0)

            const connectedProvider = connected[id]
            if (connectedProvider) {
              providers[id] = connectedProvider
              continue
            }

            // If not connected, we show the ModelsDev version but filter for public models only
            const info = Provider.fromModelsDevProvider(devProvider)
            const publicModels: Record<string, Provider.Model> = {}
            for (const [mId, mInfo] of Object.entries(info.models)) {
              if (mInfo.cost.input === 0) {
                publicModels[mId] = mInfo
              }
            }

            if (Object.keys(publicModels).length > 0) {
              info.models = publicModels
              providers[id] = info
            }
          } else {
            // For other providers, show as is or if they are in connected
            providers[id] = connected[id] || Provider.fromModelsDevProvider(devProvider)
          }
        }

        // Add any connected providers that were not in filteredProviders
        for (const [id, info] of Object.entries(connected)) {
          if (!providers[id]) {
            providers[id] = info
          }
        }

        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: Object.keys(connected),
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerId/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
        }),
      ),
      async (c) => {
        const providerId = c.req.valid("param").providerId
        const { method } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerId,
          method,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerId/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerId = c.req.valid("param").providerId
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerId,
          method,
          code,
        })
        return c.json(true)
      },
    ),
)
