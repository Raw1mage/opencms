import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Account } from "../../account"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { Config } from "../../config/config"
import { Plugin } from "../../plugin"

export const AccountRoutes = lazy(() =>
  new Hono()
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
