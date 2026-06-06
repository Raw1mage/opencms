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
import {
  buildCanonicalProviderRows,
  normalizeCanonicalProviderKey,
  resolveCanonicalRuntimeProvider,
} from "../../provider/canonical-family-source"
import { resolveProviderBillingMode } from "../../provider/billing-mode"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
const log = Log.create({ service: "provider.routes" })
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
                    all: Provider.Info.array(),
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
        log.info("GET /provider")
        c.header("Cache-Control", "no-store, no-transform")
        c.header("Pragma", "no-cache")
        const config = await Config.get()
        const allProviders = await ModelsDev.get()
        log.info("ModelsDev.get done")

        // Wait for discovery to be sure we have the latest account-specific models
        const connected = await Provider.list()
        log.info("Provider.list done")

        // Get all families with accounts to determine multi-account status dynamically
        const familiesWithAccounts = await Account.listAll()

        const disabledProviderIds = Array.isArray(config.disabled_providers)
          ? config.disabled_providers.filter((item): item is string => typeof item === "string")
          : []
        const canonicalProviders = buildCanonicalProviderRows({
          accountFamilies: familiesWithAccounts,
          connectedProviderIds: Object.keys(connected),
          modelsDevProviderIds: Object.keys(allProviders),
          disabledProviderIds,
          excludedFamilies: ["google"],
        })

        const providers: Record<string, Provider.Info> = {}

        for (const row of canonicalProviders) {
          const family = row.family
          const familyData = familiesWithAccounts[family]
          const activeAccountId = familyData?.activeAccount
          const connectedProviders = Object.values(connected).filter(
            (provider) => normalizeCanonicalProviderKey(provider.id) === family,
          )
          const resolvedConnected = resolveCanonicalRuntimeProvider({
            family,
            activeAccountId,
            providers: connectedProviders,
          })
          if (resolvedConnected) {
            providers[family] = {
              ...resolvedConnected.provider,
              id: family,
              name: Account.getProviderLabel(family),
              billingMode: resolveProviderBillingMode(config, family),
            }
            continue
          }

          const devEntry = Object.entries(allProviders).find(
            ([id]) => normalizeCanonicalProviderKey(id) === family,
          )?.[1]
          if (!devEntry) continue

          const info = Provider.fromModelsDevProvider({
            ...devEntry,
            id: family,
            name: Account.getProviderLabel(family),
          })

          const hasAccountsConfigured = !!(familyData?.accounts && Object.keys(familyData.accounts).length > 0)
          if (hasAccountsConfigured) {
            const publicModels: Record<string, Provider.Model> = {}
            for (const [modelId, modelInfo] of Object.entries(info.models as Record<string, Provider.Model>)) {
              if (modelInfo.cost.input === 0) {
                publicModels[modelId] = modelInfo
              }
            }
            if (Object.keys(publicModels).length === 0) continue
            info.models = publicModels
          }

          providers[family] = {
            ...info,
            billingMode: resolveProviderBillingMode(config, family),
          }
        }

        const connectedCanonical = canonicalProviders
          .filter((row) => row.inConnectedProviders)
          .map((row) => row.providerKey)

        // Expose non-canonical (custom) providers loaded from opencode.json
        // so the frontend can read model.limit.context / billingMode for them.
        // canonicalProviders only covers SUPPORTED_PROVIDER_KEYS; user-defined
        // providers (e.g. @ai-sdk/openai-compatible against a local llama.cpp)
        // would otherwise vanish from /provider/all and the UI sidebar shows
        // "—" for context limit / usage.
        const customConnected: string[] = []
        for (const [id, info] of Object.entries(connected)) {
          if (providers[id]) continue
          if (disabledProviderIds.includes(id)) continue
          providers[id] = {
            ...info,
            billingMode: resolveProviderBillingMode(config, id),
          }
          customConnected.push(id)
        }

        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: [...connectedCanonical, ...customConnected],
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
          accountName: z
            .string()
            .optional()
            .meta({ description: "Optional user-chosen account label (overrides email-derived identity)" }),
        }),
      ),
      async (c) => {
        const providerId = c.req.valid("param").providerId
        const { method, code, accountName } = c.req.valid("json")
        await ProviderAuth.callback({
          providerId,
          method,
          code,
          accountName,
        })
        return c.json(true)
      },
    ),
)
