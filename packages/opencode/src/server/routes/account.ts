import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Account } from "../../account"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { Config } from "../../config/config"
import { Plugin } from "../../plugin"
import { getQuotaHint } from "../../account/quota"
import { RequestUser } from "@/runtime/request-user"
import { UserDaemonManager } from "../user-daemon"

export const AccountRoutes = lazy(() =>
  new Hono()
    .get(
      "/quota",
      describeRoute({
        summary: "Get quota hint for current model",
        description: "Returns provider-specific quota hint text for prompt footer metadata.",
        operationId: "account.quotaHint",
        responses: {
          200: {
            description: "Quota hint",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providerId: z.string().meta({ description: "Resolved runtime provider ID" }),
                    providerKey: z.string().meta({ description: "Canonical provider identity key" }),
                    // legacy compatibility field; operationally this is the canonical provider key
                    family: z.string().meta({
                      description: "Deprecated alias of providerKey kept for compatibility",
                      deprecated: true,
                    }),
                    accountId: z.string().optional(),
                    hint: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          providerId: z.string(),
          modelID: z.string().optional(),
          accountId: z.string().optional(),
          format: z.enum(["footer", "admin"]).optional(),
          fresh: z.string().optional(),
        }),
      ),
      async (c) => {
        const { providerId, modelID, accountId: requestedAccountId, format = "footer", fresh } = c.req.valid("query")
        const providerKey = Account.parseProvider(providerId) ?? Account.parseFamily(providerId) ?? providerId
        const family = providerKey
        const families = await Account.listAll()
        const familyAccounts = families[family]?.accounts ?? {}
        const accountId = requestedAccountId && familyAccounts[requestedAccountId] ? requestedAccountId : undefined

        if (!accountId) {
          return c.json({
            providerId,
            providerKey,
            family,
          })
        }

        const quota = await getQuotaHint({ providerId, accountId, modelID, format, fresh: fresh === "1" })

        return c.json({
          providerId,
          providerKey,
          family: quota.family,
          accountId: quota.accountId,
          hint: quota.hint,
        })
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List all accounts",
        description:
          "Get a list of all configured accounts grouped by provider key. Response keeps legacy 'families' for compatibility and also returns 'providers'.",
        operationId: "account.listAll",
        responses: {
          200: {
            description: "List of accounts by provider key (with legacy families alias)",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: z.record(z.string(), Account.ProviderData).meta({
                      description: "Canonical provider-keyed account map",
                    }),
                    // legacy compatibility field; mirrors providers
                    families: z.record(z.string(), Account.FamilyData).meta({
                      description: "Deprecated alias of providers kept for compatibility",
                      deprecated: true,
                    }),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (username && UserDaemonManager.routeAccountListEnabled()) {
          const response = await UserDaemonManager.callAccountList<{
            families?: unknown
          }>(username)
          if (!response.ok) {
            return c.json(
              {
                code: response.error.code,
                message: response.error.message,
              },
              503,
            )
          }
          if (response.data && typeof response.data === "object") {
            const parsed = response.data as { families?: unknown }
            if (parsed.families && typeof parsed.families === "object") {
              return c.json({
                providers: parsed.families as Record<string, unknown>,
                families: parsed.families,
              })
            }
            return c.json(
              {
                code: "DAEMON_INVALID_PAYLOAD",
                message: "daemon account.list payload missing families",
              },
              503,
            )
          }
          return c.json(
            {
              code: "DAEMON_INVALID_PAYLOAD",
              message: "daemon account.list payload is not an object",
            },
            503,
          )
        }
        const families = await Account.listAll()

        return c.json({
          providers: families,
          families,
        })
      },
    )
    .post(
      "/:family/active",
      describeRoute({
        summary: "Set active account",
        description:
          "Set the active account for a specific provider key. Canonical request semantics are provider-key based. Legacy route param name remains 'family' for compatibility, and request bodies may also include matching 'providerKey' as a deprecated compatibility alias.",
        operationId: "account.setActive",
        responses: {
          200: {
            description: "Active account set successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          family: z.string().meta({ description: "Deprecated path param alias of providerKey" }),
        }),
      ),
      validator(
        "json",
        z.object({
          accountId: z.string().meta({ description: "Target account ID under the selected provider key" }),
          providerKey: z.string().optional().meta({
            description: "Canonical provider key alias; must match legacy :family route param when provided",
          }),
        }),
      ),
      async (c) => {
        const providerKey = c.req.valid("param").family
        const { accountId, providerKey: requestedProviderKey } = c.req.valid("json")

        if (requestedProviderKey && requestedProviderKey !== providerKey) {
          return c.json(
            {
              code: "ACCOUNT_PROVIDER_MISMATCH",
              message: `providerKey body does not match route provider: ${requestedProviderKey} !== ${providerKey}`,
            },
            400,
          )
        }

        const username = RequestUser.username()
        if (username && UserDaemonManager.routeAccountMutationEnabled()) {
          const response = await UserDaemonManager.callAccountSetActive<boolean>(username, providerKey, accountId)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Account.setActive(providerKey, accountId)
        return c.json(true)
      },
    )
    .get(
      "/auth/:family/login",
      describeRoute({
        summary: "Trigger login",
        description:
          "Get the login URL for a provider key. Canonical request semantics are provider-key based. Legacy route param name remains 'family' for compatibility, and query may also include matching 'providerKey' as a deprecated compatibility alias.",
        operationId: "account.login",
        responses: {
          200: { description: "Login URL info" },
        },
      }),
      validator(
        "param",
        z.object({
          family: z.string().meta({ description: "Deprecated path param alias of providerKey" }),
        }),
      ),
      validator(
        "query",
        z.object({
          providerKey: z.string().optional().meta({
            description: "Canonical provider key alias; must match legacy :family route param when provided",
          }),
        }),
      ),
      async (c) => {
        const providerKey = c.req.valid("param").family
        const { providerKey: requestedProviderKey } = c.req.valid("query")

        if (requestedProviderKey && requestedProviderKey !== providerKey) {
          return c.json(
            {
              code: "ACCOUNT_PROVIDER_MISMATCH",
              message: `providerKey query does not match route provider: ${requestedProviderKey} !== ${providerKey}`,
            },
            400,
          )
        }

        const authMethod = await Plugin.getAuth(providerKey)
        if (!authMethod || !authMethod.methods[0]?.authorize) {
          return c.json({ error: "No auth method for provider key" }, 400)
        }

        const result = await authMethod.methods[0].authorize({ noBrowser: "true" })
        return c.json(result)
      },
    )
    .post(
      "/:family/:accountId/reset-cooldown",
      describeRoute({
        summary: "Reset account cooldown",
        description: "Clear all rate limit cooldowns, daily failure counters, and health score for a specific account.",
        operationId: "account.resetCooldown",
        responses: {
          200: {
            description: "Cooldown reset successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator(
        "param",
        z.object({
          family: z.string(),
          accountId: z.string(),
        }),
      ),
      async (c) => {
        const { family: providerKey, accountId } = c.req.valid("param")

        const account = await Account.get(providerKey, accountId)
        if (!account) {
          return c.json(
            {
              code: "ACCOUNT_NOT_FOUND",
              message: `Account not found: ${providerKey}/${accountId}`,
            },
            404,
          )
        }

        await Account.clearAccountCooldown(providerKey, accountId)
        return c.json(true)
      },
    )
    .delete(
      "/:family/:accountId",
      describeRoute({
        summary: "Remove account",
        description:
          "Remove a specific account under a provider key. Canonical request semantics are provider-key based. Legacy route param name remains 'family' for compatibility, and query may also include matching 'providerKey' as a deprecated compatibility alias.",
        operationId: "account.remove",
        responses: {
          200: {
            description: "Account removed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          family: z.string().meta({ description: "Deprecated path param alias of providerKey" }),
          accountId: z.string(),
        }),
      ),
      validator(
        "query",
        z.object({
          providerKey: z.string().optional().meta({
            description: "Canonical provider key alias; must match legacy :family route param when provided",
          }),
        }),
      ),
      async (c) => {
        const { family: providerKey, accountId } = c.req.valid("param")
        const { providerKey: requestedProviderKey } = c.req.valid("query")

        if (requestedProviderKey && requestedProviderKey !== providerKey) {
          return c.json(
            {
              code: "ACCOUNT_PROVIDER_MISMATCH",
              message: `providerKey query does not match route provider: ${requestedProviderKey} !== ${providerKey}`,
            },
            400,
          )
        }

        const username = RequestUser.username()
        if (username && UserDaemonManager.routeAccountMutationEnabled()) {
          const response = await UserDaemonManager.callAccountRemove<boolean>(username, providerKey, accountId)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        const { Auth } = await import("../../auth")
        await Auth.remove(accountId)
        return c.json(true)
      },
    )
    .patch(
      "/:family/:accountId",
      describeRoute({
        summary: "Update account metadata",
        description:
          "Update editable account metadata under a provider key. Canonical request semantics are provider-key based. Legacy route param name remains 'family' for compatibility, and request bodies may also include matching 'providerKey' as a deprecated compatibility alias.",
        operationId: "account.update",
        responses: {
          200: {
            description: "Account updated successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          family: z.string().meta({ description: "Deprecated path param alias of providerKey" }),
          accountId: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          name: z.string().min(1),
          providerKey: z.string().optional().meta({
            description: "Canonical provider key alias; must match legacy :family route param when provided",
          }),
        }),
      ),
      async (c) => {
        const { family: providerKey, accountId } = c.req.valid("param")
        const { name, providerKey: requestedProviderKey } = c.req.valid("json")

        if (requestedProviderKey && requestedProviderKey !== providerKey) {
          return c.json(
            {
              code: "ACCOUNT_PROVIDER_MISMATCH",
              message: `providerKey body does not match route provider: ${requestedProviderKey} !== ${providerKey}`,
            },
            400,
          )
        }

        const trimmedName = name.trim()
        if (!trimmedName) {
          return c.json(
            {
              code: "ACCOUNT_NAME_REQUIRED",
              message: "account name is required",
            },
            400,
          )
        }

        const username = RequestUser.username()
        if (username && UserDaemonManager.routeAccountMutationEnabled()) {
          const response = await UserDaemonManager.callAccountUpdate<boolean>(username, providerKey, accountId, {
            name: trimmedName,
          })
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }

        const account = await Account.get(providerKey, accountId)
        if (!account) {
          return c.json(
            {
              code: "ACCOUNT_NOT_FOUND",
              message: `Account not found: ${providerKey}/${accountId}`,
            },
            404,
          )
        }

        await Account.update(providerKey, accountId, { ...account, name: trimmedName })
        return c.json(true)
      },
    ),
)
