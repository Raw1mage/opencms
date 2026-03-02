import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Account } from "../../account"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { Config } from "../../config/config"
import { Plugin } from "../../plugin"
import { getOpenAIQuotas } from "../../account/quota"
import { RequestUser } from "@/runtime/request-user"
import { UserWorkerManager } from "../user-worker"

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
                    providerId: z.string(),
                    family: z.string(),
                    accountId: z.string().optional(),
                    hint: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("query", z.object({ providerId: z.string(), modelID: z.string().optional() })),
      async (c) => {
        const { providerId } = c.req.valid("query")
        const family = Account.parseFamily(providerId) ?? providerId
        const families = await Account.listAll()
        const accountId = families[family]?.activeAccount

        if (!accountId) {
          return c.json({
            providerId,
            family,
          })
        }

        if (family === "openai") {
          const quotas = await getOpenAIQuotas()
          const quota = quotas[accountId]
          const fiveHour = quota ? (quota.hasHourlyWindow ? `${quota.hourlyRemaining}%` : "--") : "--"
          const week = quota ? `${quota.weeklyRemaining}%` : "--"
          return c.json({
            providerId,
            family,
            accountId,
            hint: `(5hrs:${fiveHour} | week:${week})`,
          })
        }

        return c.json({
          providerId,
          family,
          accountId,
        })
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List all accounts",
        description:
          "Get a list of all configured accounts grouped by provider family, with detailed status for Antigravity pool.",
        operationId: "account.listAll",
        responses: {
          200: {
            description: "List of accounts by family",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    families: z.record(z.string(), Account.FamilyData),
                    antigravity: z.any().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (username && UserWorkerManager.routeAccountListEnabled()) {
          const response = await UserWorkerManager.call(username, {
            method: "account.list",
            payload: { includeAntigravity: true },
          })
          if (response.ok && response.data && typeof response.data === "object") {
            const parsed = response.data as { families?: unknown; antigravity?: unknown }
            if (parsed.families && typeof parsed.families === "object") {
              return c.json({
                families: parsed.families,
                antigravity: parsed.antigravity,
              })
            }
          }
        }

        const families = await Account.listAll()

        // Fetch rich Antigravity status if plugin is available
        let antigravityStatus = undefined
        try {
          const { AccountManager } = await import("../../plugin/antigravity/plugin/accounts")
          const { Auth } = await import("../../auth")
          const auth = await Auth.get("antigravity")
          if (auth && auth.type === "oauth") {
            const manager = await AccountManager.loadFromDisk(auth)
            antigravityStatus = {
              accounts: manager.getAccountsSnapshot(),
              activeIndex: manager.getActiveIndex(),
              activeIndexByFamily: manager.getActiveIndexByFamily(),
            }
          }
        } catch (e) {
          // Plugin might not be loaded
        }

        return c.json({
          families,
          antigravity: antigravityStatus,
        })
      },
    )
    .post(
      "/:family/active",
      describeRoute({
        summary: "Set active account",
        description: "Set the active account for a specific provider family.",
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
      validator("param", z.object({ family: z.string() })),
      validator("json", z.object({ accountId: z.string() })),
      async (c) => {
        const family = c.req.valid("param").family
        const { accountId } = c.req.valid("json")

        const username = RequestUser.username()
        if (username && UserWorkerManager.routeAccountMutationEnabled()) {
          const response = await UserWorkerManager.call(username, {
            method: "account.setActive",
            payload: { family, accountId },
          })
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error?.code ?? "WORKER_ERROR",
              message: response.error?.message ?? "User worker failed to set active account",
            },
            503,
          )
        }

        if (family === "antigravity") {
          const { AccountManager } = await import("../../plugin/antigravity/plugin/accounts")
          const { clearAccountCache } = await import("../../plugin/antigravity/plugin/storage")
          const { Auth } = await import("../../auth")
          const auth = await Auth.get("antigravity")
          if (auth && auth.type === "oauth") {
            const manager = await AccountManager.loadFromDisk(auth)
            const index = parseInt(accountId, 10)
            if (!isNaN(index)) {
              manager.setActiveIndex(index)
              await manager.saveToDisk()
              clearAccountCache()
            }
          }
        } else {
          await Account.setActive(family, accountId)
        }
        return c.json(true)
      },
    )
    .post(
      "/antigravity/toggle",
      describeRoute({
        summary: "Toggle Antigravity account",
        description: "Enable or disable a specific account in the Antigravity pool.",
        operationId: "account.antigravityToggle",
        responses: {
          200: { description: "Success" },
        },
      }),
      validator("json", z.object({ index: z.number(), enabled: z.boolean() })),
      async (c) => {
        const { index, enabled } = c.req.valid("json")

        const username = RequestUser.username()
        if (username && UserWorkerManager.routeAccountMutationEnabled()) {
          const response = await UserWorkerManager.call(username, {
            method: "account.antigravityToggle",
            payload: { index, enabled },
          })
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error?.code ?? "WORKER_ERROR",
              message: response.error?.message ?? "User worker failed to toggle antigravity account",
            },
            503,
          )
        }

        const { AccountManager } = await import("../../plugin/antigravity/plugin/accounts")
        const { Auth } = await import("../../auth")
        const auth = await Auth.get("antigravity")
        if (auth && auth.type === "oauth") {
          const manager = await AccountManager.loadFromDisk(auth)
          const { clearAccountCache } = await import("../../plugin/antigravity/plugin/storage")
          const account = manager.getAccount(index)
          if (account) {
            account.enabled = enabled
            await manager.saveToDisk()
            clearAccountCache()
          }
        }
        return c.json(true)
      },
    )
    .get(
      "/auth/:family/login",
      describeRoute({
        summary: "Trigger login",
        description: "Get the login URL for a provider family.",
        operationId: "account.login",
        responses: {
          200: { description: "Login URL info" },
        },
      }),
      validator("param", z.object({ family: z.string() })),
      async (c) => {
        const family = c.req.valid("param").family
        const authMethod = await Plugin.getAuth(family)
        if (!authMethod || !authMethod.methods[0]?.authorize) {
          return c.json({ error: "No auth method for family" }, 400)
        }

        const result = await authMethod.methods[0].authorize({ noBrowser: "true" })
        return c.json(result)
      },
    )
    .delete(
      "/:family/:accountId",
      describeRoute({
        summary: "Remove account",
        description: "Remove a specific account.",
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
      validator("param", z.object({ family: z.string(), accountId: z.string() })),
      async (c) => {
        const { family, accountId } = c.req.valid("param")

        const username = RequestUser.username()
        if (username && UserWorkerManager.routeAccountMutationEnabled()) {
          const response = await UserWorkerManager.call(username, {
            method: "account.remove",
            payload: { family, accountId },
          })
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error?.code ?? "WORKER_ERROR",
              message: response.error?.message ?? "User worker failed to remove account",
            },
            503,
          )
        }

        if (family === "antigravity") {
          const { AccountManager } = await import("../../plugin/antigravity/plugin/accounts")
          const { clearAccountCache } = await import("../../plugin/antigravity/plugin/storage")
          const { Auth } = await import("../../auth")
          const auth = await Auth.get("antigravity")
          if (auth && auth.type === "oauth") {
            const manager = await AccountManager.loadFromDisk(auth)
            const index = parseInt(accountId, 10)
            if (!isNaN(index)) {
              manager.removeAccountByIndex(index)
              await manager.saveToDisk()
              clearAccountCache()
            }
          }
        } else {
          await Account.remove(family, accountId)
        }
        return c.json(true)
      },
    ),
)
