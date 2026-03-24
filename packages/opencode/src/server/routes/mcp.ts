import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { MCP } from "../../mcp"
import { ManagedAppRegistry } from "../../mcp"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Log } from "../../util/log"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

const oauthLog = Log.create({ service: "managed-app-oauth" })

function managedAppUsageHttpStatus(reason: ManagedAppRegistry.UsageErrorReason): 401 | 409 | 503 {
  switch (reason) {
    case "unauthenticated":
      return 401
    case "misconfigured":
      return 409
    case "runtime_error":
      return 503
  }
}

export const McpRoutes = lazy(() =>
  new Hono()
    .get(
      "/apps",
      describeRoute({
        summary: "List managed MCP apps",
        description:
          "Get built-in managed app catalog entries with persisted and runtime state for Web/TUI management.",
        operationId: "mcp.apps.list",
        responses: {
          200: {
            description: "Managed app snapshots",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ManagedAppRegistry.list())
      },
    )
    .get(
      "/apps/:appId",
      describeRoute({
        summary: "Get managed MCP app",
        description:
          "Get a managed app snapshot including operator-visible install, config, runtime, and error states.",
        operationId: "mcp.apps.get",
        responses: {
          200: {
            description: "Managed app snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        return c.json(await ManagedAppRegistry.get(appId))
      },
    )
    .post(
      "/apps/:appId/install",
      describeRoute({
        summary: "Install managed MCP app",
        description: "Mark a built-in managed app as installed and available for later configuration and enablement.",
        operationId: "mcp.apps.install",
        responses: {
          200: {
            description: "Managed app snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        return c.json(await ManagedAppRegistry.install(appId))
      },
    )
    .post(
      "/apps/:appId/uninstall",
      describeRoute({
        summary: "Uninstall managed MCP app",
        description: "Reset a managed app to available state and detach any runtime attachment.",
        operationId: "mcp.apps.uninstall",
        responses: {
          200: {
            description: "Managed app snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        return c.json(await ManagedAppRegistry.uninstall(appId))
      },
    )
    .post(
      "/apps/:appId/config",
      describeRoute({
        summary: "Update managed MCP app config keys",
        description: "Persist operator-visible configuration completion keys for a managed app.",
        operationId: "mcp.apps.config",
        responses: {
          200: {
            description: "Managed app snapshot with runtime attachment state",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.ManagedAppSnapshot),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      validator(
        "json",
        z.object({
          keys: z.array(z.string()),
        }),
      ),
      async (c) => {
        const { appId } = c.req.valid("param")
        const { keys } = c.req.valid("json")
        return c.json(await ManagedAppRegistry.setConfigKeys(appId, keys))
      },
    )
    .post(
      "/apps/:appId/enable",
      describeRoute({
        summary: "Enable managed MCP app",
        description: "Enable a managed app after install and configuration complete.",
        operationId: "mcp.apps.enable",
        responses: {
          200: {
            description: "Managed app snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        try {
          return c.json(await ManagedAppRegistry.enable(appId))
        } catch (error) {
          if (error instanceof ManagedAppRegistry.UsageStateError) {
            return c.json(error.toObject().data, managedAppUsageHttpStatus(error.reason))
          }
          throw error
        }
      },
    )
    .post(
      "/apps/:appId/disable",
      describeRoute({
        summary: "Disable managed MCP app",
        description: "Disable a managed app and detach any active runtime attachment.",
        operationId: "mcp.apps.disable",
        responses: {
          200: {
            description: "Managed app snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.AppSnapshot),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        return c.json(await ManagedAppRegistry.disable(appId))
      },
    )
    .get(
      "/apps/:appId/runtime",
      describeRoute({
        summary: "Get managed MCP app runtime state",
        description: "Get runtime attachment and status for a managed app without exposing full MCP tool flows.",
        operationId: "mcp.apps.runtime",
        responses: {
          200: {
            description: "Managed app runtime snapshot",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.RuntimeSnapshot),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        return c.json(await ManagedAppRegistry.runtime(appId))
      },
    )
    .get(
      "/apps/:appId/usage",
      describeRoute({
        summary: "Get managed MCP app usage state",
        description:
          "Expose fail-fast unauthenticated, misconfigured, and runtime-error states for managed app usage without implicit fallback.",
        operationId: "mcp.apps.usage",
        responses: {
          200: {
            description: "Managed app usage is ready",
            content: {
              "application/json": {
                schema: resolver(z.null()),
              },
            },
          },
          401: {
            description: "Managed app requires explicit authentication binding",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.UsageError),
              },
            },
          },
          409: {
            description: "Managed app is misconfigured",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.UsageError),
              },
            },
          },
          503: {
            description: "Managed app hit a runtime error",
            content: {
              "application/json": {
                schema: resolver(ManagedAppRegistry.UsageError),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        const usage = await ManagedAppRegistry.usage(appId)
        if (!usage) return c.json(null)
        return c.json(usage, managedAppUsageHttpStatus(usage.reason))
      },
    )
    .get(
      "/apps/:appId/oauth/connect",
      describeRoute({
        summary: "Start managed app OAuth connect flow",
        description:
          "Redirect user to the OAuth provider consent screen for a managed app. Currently supports google-calendar.",
        operationId: "mcp.apps.oauth.connect",
        responses: {
          302: { description: "Redirect to OAuth provider" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        if (appId !== "google-calendar") {
          return c.json({ error: `OAuth connect not supported for app: ${appId}` }, 400)
        }
        const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
        if (!clientId) {
          return c.json({ error: "GOOGLE_CALENDAR_CLIENT_ID not configured" }, 400)
        }
        const scope = process.env.GOOGLE_CALENDAR_SCOPE || "https://www.googleapis.com/auth/calendar"
        const authUri = process.env.GOOGLE_CALENDAR_AUTH_URI || "https://accounts.google.com/o/oauth2/auth"

        // Determine redirect URI from forwarded headers (proxy-safe)
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const origin = `${proto}://${host}`
        const redirectUri = `${origin}/api/v2/mcp/apps/google-calendar/oauth/callback`

        const state = crypto.randomUUID()
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope,
          access_type: "offline",
          prompt: "consent",
          state,
        })

        oauthLog.info("starting OAuth connect", { appId, redirectUri })
        return c.redirect(`${authUri}?${params.toString()}`)
      },
    )
    .get(
      "/apps/:appId/oauth/callback",
      describeRoute({
        summary: "Handle managed app OAuth callback",
        description:
          "Exchange authorization code for tokens and create canonical account binding for the managed app.",
        operationId: "mcp.apps.oauth.callback",
        responses: {
          200: { description: "OAuth completed, shows success page" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")
        if (appId !== "google-calendar") {
          return c.json({ error: `OAuth callback not supported for app: ${appId}` }, 400)
        }

        const code = c.req.query("code")
        const error = c.req.query("error")
        if (error) {
          oauthLog.error("OAuth denied by user", { error })
          return c.html(
            `<html><body><h2>Authorization denied</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`,
          )
        }
        if (!code) {
          return c.json({ error: "Missing authorization code" }, 400)
        }

        const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
        const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET
        const tokenUri = process.env.GOOGLE_CALENDAR_TOKEN_URI || "https://oauth2.googleapis.com/token"
        if (!clientId || !clientSecret) {
          return c.json({ error: "GOOGLE_CALENDAR_CLIENT_ID or CLIENT_SECRET not configured" }, 400)
        }

        const proto = c.req.header("x-forwarded-proto") || "https"
        const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const origin = `${proto}://${host}`
        const redirectUri = `${origin}/api/v2/mcp/apps/google-calendar/oauth/callback`

        // Exchange authorization code for tokens
        const tokenResponse = await fetch(tokenUri, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        })

        if (!tokenResponse.ok) {
          const body = await tokenResponse.text()
          oauthLog.error("token exchange failed", { status: tokenResponse.status, body })
          return c.json({ error: "Token exchange failed", detail: body }, 400)
        }

        const tokens = (await tokenResponse.json()) as {
          access_token: string
          refresh_token?: string
          expires_in: number
          token_type: string
        }

        oauthLog.info("token exchange succeeded", { hasRefresh: !!tokens.refresh_token })

        // Store tokens directly to gauth.json — no Account system involvement
        const gauthPath = path.join(Global.Path.config, "gauth.json")
        const gauthData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || "",
          expires_at: Date.now() + tokens.expires_in * 1000,
          token_type: tokens.token_type,
          updated_at: Date.now(),
        }
        await Bun.write(gauthPath, JSON.stringify(gauthData, null, 2))
        await fs.chmod(gauthPath, 0o600)
        oauthLog.info("tokens written to gauth.json", { path: gauthPath })

        // Mark config as complete — OAuth IS the config for this app
        await ManagedAppRegistry.setConfigKeys(appId, ["googleOAuth"])
        oauthLog.info("config marked complete after OAuth")

        // Try to enable the app automatically if it was just waiting on config
        try {
          await ManagedAppRegistry.enable(appId)
          oauthLog.info("app auto-enabled after OAuth")
        } catch {
          // If enable fails (e.g. already enabled), that's fine
        }

        const snap = await ManagedAppRegistry.get(appId)
        oauthLog.info("OAuth connect complete", { appId, runtimeStatus: snap.runtimeStatus })

        return c.html(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google Calendar connected</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`,
        )
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "Get MCP status",
        description: "Get the status of all Model Context Protocol (MCP) servers.",
        operationId: "mcp.status",
        responses: {
          200: {
            description: "MCP server status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.status())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add MCP server",
        description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
        operationId: "mcp.add",
        responses: {
          200: {
            description: "MCP server added successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          config: Config.Mcp,
        }),
      ),
      async (c) => {
        const { name, config } = c.req.valid("json")
        const result = await MCP.add(name, config)
        return c.json(result.status)
      },
    )
    .post(
      "/:name/auth",
      describeRoute({
        summary: "Start MCP OAuth",
        description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
        operationId: "mcp.auth.start",
        responses: {
          200: {
            description: "OAuth flow started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    authorizationUrl: z.string().describe("URL to open in browser for authorization"),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const result = await MCP.startAuth(name)
        return c.json(result)
      },
    )
    .post(
      "/:name/auth/callback",
      describeRoute({
        summary: "Complete MCP OAuth",
        description:
          "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
        operationId: "mcp.auth.callback",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          code: z.string().describe("Authorization code from OAuth callback"),
        }),
      ),
      async (c) => {
        const name = c.req.param("name")
        const { code } = c.req.valid("json")
        const status = await MCP.finishAuth(name, code)
        return c.json(status)
      },
    )
    .post(
      "/:name/auth/authenticate",
      describeRoute({
        summary: "Authenticate MCP OAuth",
        description: "Start OAuth flow and wait for callback (opens browser)",
        operationId: "mcp.auth.authenticate",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const status = await MCP.authenticate(name)
        return c.json(status)
      },
    )
    .delete(
      "/:name/auth",
      describeRoute({
        summary: "Remove MCP OAuth",
        description: "Remove OAuth credentials for an MCP server",
        operationId: "mcp.auth.remove",
        responses: {
          200: {
            description: "OAuth credentials removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        await MCP.removeAuth(name)
        return c.json({ success: true as const })
      },
    )
    .post(
      "/:name/connect",
      describeRoute({
        description: "Connect an MCP server",
        operationId: "mcp.connect",
        responses: {
          200: {
            description: "MCP server connected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.connect(name)
        return c.json(true)
      },
    )
    .post(
      "/:name/disconnect",
      describeRoute({
        description: "Disconnect an MCP server",
        operationId: "mcp.disconnect",
        responses: {
          200: {
            description: "MCP server disconnected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.disconnect(name)
        return c.json(true)
      },
    ),
)
