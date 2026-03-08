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
      validator(
        "query",
        z.object({
          providerId: z.string(),
          modelID: z.string().optional(),
          accountId: z.string().optional(),
          format: z.enum(["footer", "admin"]).optional(),
        }),
      ),
      async (c) => {
        const { providerId, modelID, accountId: requestedAccountId, format = "footer" } = c.req.valid("query")
        const family = Account.parseFamily(providerId) ?? providerId
        const families = await Account.listAll()
        const familyAccounts = families[family]?.accounts ?? {}
        const accountId =
          requestedAccountId && familyAccounts[requestedAccountId]
            ? requestedAccountId
            : families[family]?.activeAccount

        if (!accountId) {
          return c.json({
            providerId,
            family,
          })
        }

        const quota = await getQuotaHint({ providerId, accountId, modelID, format })

        return c.json({
          providerId,
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
        description: "Get a list of all configured accounts grouped by provider family.",
        operationId: "account.listAll",
        responses: {
          200: {
            description: "List of accounts by family",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    families: z.record(z.string(), Account.FamilyData),
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
          families,
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
        if (username && UserDaemonManager.routeAccountMutationEnabled()) {
          const response = await UserDaemonManager.callAccountSetActive<boolean>(username, family, accountId)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Account.setActive(family, accountId)
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
        if (username && UserDaemonManager.routeAccountMutationEnabled()) {
          const response = await UserDaemonManager.callAccountRemove<boolean>(username, family, accountId)
          if (response.ok) return c.json(true)
          return c.json(
            {
              code: response.error.code,
              message: response.error.message,
            },
            503,
          )
        }
        await Account.remove(family, accountId)
        return c.json(true)
      },
    )
    .patch(
      "/:family/:accountId",
      describeRoute({
        summary: "Update account metadata",
        description: "Update editable account metadata such as display name.",
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
      validator("param", z.object({ family: z.string(), accountId: z.string() })),
      validator(
        "json",
        z.object({
          name: z.string().min(1),
        }),
      ),
      async (c) => {
        const { family, accountId } = c.req.valid("param")
        const { name } = c.req.valid("json")
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
          const response = await UserDaemonManager.callAccountUpdate<boolean>(username, family, accountId, {
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

        const account = await Account.get(family, accountId)
        if (!account) {
          return c.json(
            {
              code: "ACCOUNT_NOT_FOUND",
              message: `Account not found: ${family}/${accountId}`,
            },
            404,
          )
        }

        await Account.update(family, accountId, { ...account, name: trimmedName })
        return c.json(true)
      },
    ),
)
