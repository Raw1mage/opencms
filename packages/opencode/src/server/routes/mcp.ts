import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { MCP, McpAppStore, McpAppManifest } from "../../mcp"
import { ManagedAppRegistry } from "../../mcp"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Log } from "../../util/log"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { GoogleBinding } from "../../google-binding"
import { RequestUser } from "@/runtime/request-user"

const oauthLog = Log.create({ service: "managed-app-oauth" })
const RETIRED_MARKET_APP_IDS = new Set(["beta-tool", "fake-good"])

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
      "/market",
      describeRoute({
        summary: "Unified MCP app market",
        description:
          "Returns all MCP components (standard servers + managed apps) in a unified card format for the app market UI.",
        operationId: "mcp.market",
        responses: {
          200: { description: "Unified app market entries" },
        },
      }),
      async (c) => {
        const [serverApps, managedApps, storeApps] = await Promise.all([
          MCP.serverApps(),
          ManagedAppRegistry.list(),
          McpAppStore.listApps().catch(() => []),
        ])

        // Convert managed apps to unified format
        const managedCards: MCP.ServerApp[] = managedApps.map((app) => ({
          id: app.id,
          name: app.name,
          description: app.description,
          icon: app.id === "google-calendar" ? "📅" : "📦",
          kind: "managed-app" as const,
          status: app.runtimeStatus,
          tools: app.toolContract.tools.map((t) => ({ id: t.id, name: t.label, description: "" })),
          enabled: app.operator.install === "installed" && app.runtimeStatus === "ready",
        }))

        // Check Google OAuth token availability for auth status
        let hasGoogleToken = false
        let googleTokenExpired = false
        try {
          const gauthPath = path.join(Global.Path.config, "gauth.json")
          const content = await fs.readFile(gauthPath, "utf-8")
          const tokens = JSON.parse(content) as { access_token?: string; expires_at?: number }
          hasGoogleToken = !!tokens.access_token
          if (tokens.expires_at && Date.now() > tokens.expires_at) {
            googleTokenExpired = true
          }
        } catch {
          // No gauth.json
        }

        // Convert store apps to unified format
        const storeCards = storeApps
          .filter((app) => !RETIRED_MARKET_APP_IDS.has(app.id))
          .map((app) => {
            const auth = app.manifest?.auth
            let status = app.entry.enabled ? "connected" : "disabled"
            let error: string | undefined

            // Derive auth status for enabled apps
            if (app.entry.enabled && auth && auth.type !== "none") {
              if (auth.type === "oauth") {
                const provider = (auth as any).provider
                if (provider === "google" && (!hasGoogleToken || googleTokenExpired)) {
                  status = "needs_auth"
                  if (googleTokenExpired) error = "OAuth token expired"
                }
              } else if (auth.type === "api-key") {
                const tokenEnv = (auth as any).tokenEnv
                if (tokenEnv && !app.entry.config?.[tokenEnv]) status = "needs_auth"
              }
            }

            return {
              id: `store-${app.id}`,
              name: app.manifest?.name ?? app.id,
              description: app.manifest?.description ?? "",
              icon: app.manifest?.icon ?? "📦",
              kind: "mcp-app" as const,
              status,
              error,
              tools: (app.entry.tools ?? []).map((t) => ({
                id: t.name,
                name: t.name,
                description: t.description ?? "",
              })),
              enabled: app.entry.enabled,
              auth: app.manifest?.auth,
              toolCount: app.entry.tools?.length ?? 0,
              settingsSchema: app.entry.settingsSchema ?? app.manifest?.settings,
              config: app.entry.config,
            }
          })

        return c.json([...serverApps, ...managedCards, ...storeCards])
      },
    )
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
            return c.json(error.toObject().data, managedAppUsageHttpStatus(error.data.reason))
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
          "Redirect user to the Google OAuth consent screen for a managed app. Supports google-calendar and gmail with shared token and merged scopes.",
        operationId: "mcp.apps.oauth.connect",
        responses: {
          302: { description: "Redirect to OAuth provider" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")

        // Resolve OAuth config: check store apps first, then legacy managed apps
        const storeApps = await McpAppStore.listApps().catch(() => [])
        const storeApp = storeApps.find((a) => a.id === appId)

        // Legacy hardcoded Google OAuth apps (fallback for managed apps still in registry)
        const LEGACY_GOOGLE_OAUTH_APPS: Record<string, { scopeEnv: string; scopeDefault: string }> = {
          "google-calendar": {
            scopeEnv: "GOOGLE_CALENDAR_SCOPE",
            scopeDefault: "https://www.googleapis.com/auth/calendar",
          },
          gmail: { scopeEnv: "GOOGLE_GMAIL_SCOPE", scopeDefault: "https://mail.google.com/" },
        }

        // Determine if this app supports OAuth
        const storeAuth = storeApp?.manifest?.auth
        const isStoreOAuth = storeAuth && storeAuth.type === "oauth"
        const isLegacyOAuth = LEGACY_GOOGLE_OAUTH_APPS[appId]

        if (!isStoreOAuth && !isLegacyOAuth) {
          return c.json({ error: `OAuth connect not supported for app: ${appId}` }, 400)
        }

        const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
        if (!clientId) {
          return c.json({ error: "GOOGLE_CALENDAR_CLIENT_ID not configured" }, 400)
        }
        const authUri = process.env.GOOGLE_CALENDAR_AUTH_URI || "https://accounts.google.com/o/oauth2/auth"

        // Merge scopes from all Google OAuth apps (store + legacy)
        const scopeSet = new Set<string>(["openid", "email", "profile"])

        // Add scopes from the connecting app
        if (isStoreOAuth && "scopes" in storeAuth) {
          for (const s of (storeAuth as any).scopes ?? []) scopeSet.add(s)
        } else if (isLegacyOAuth) {
          const envScope = process.env[isLegacyOAuth.scopeEnv]
          for (const s of (envScope || isLegacyOAuth.scopeDefault).split(/\s+/)) {
            if (s) scopeSet.add(s)
          }
        }

        // Also merge scopes from other installed Google OAuth store apps
        for (const app of storeApps) {
          if (app.id === appId) continue
          const auth = app.manifest?.auth
          if (auth?.type === "oauth" && (auth as any).provider === "google") {
            for (const s of (auth as any).scopes ?? []) scopeSet.add(s)
          }
        }

        const mergedScope = Array.from(scopeSet).join(" ")

        // Determine redirect URI from forwarded headers (proxy-safe)
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const origin = `${proto}://${host}`
        const redirectUri = `${origin}/api/v2/mcp/apps/${appId}/oauth/callback`

        const state = crypto.randomUUID()
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: mergedScope,
          access_type: "offline",
          prompt: "consent",
          state,
        })

        oauthLog.info("starting OAuth connect", { appId, redirectUri, scope: mergedScope })
        return c.redirect(`${authUri}?${params.toString()}`)
      },
    )
    .get(
      "/apps/:appId/oauth/callback",
      describeRoute({
        summary: "Handle managed app OAuth callback",
        description:
          "Exchange authorization code for tokens and enable all installed Google OAuth apps sharing gauth.json.",
        operationId: "mcp.apps.oauth.callback",
        responses: {
          200: { description: "OAuth completed, shows success page" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ appId: z.string() })),
      async (c) => {
        const { appId } = c.req.valid("param")

        // Validate: this appId must be a store app with OAuth or a legacy Google app
        const storeAppsForCallback = await McpAppStore.listApps().catch(() => [])
        const callbackStoreApp = storeAppsForCallback.find((a) => a.id === appId)
        const isStoreOAuthCallback = callbackStoreApp?.manifest?.auth?.type === "oauth"
        const LEGACY_GOOGLE_OAUTH_APP_IDS = ["google-calendar", "gmail"]
        if (!isStoreOAuthCallback && !LEGACY_GOOGLE_OAUTH_APP_IDS.includes(appId)) {
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
        const redirectUri = `${origin}/api/v2/mcp/apps/${appId}/oauth/callback`

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

        // Store tokens directly to gauth.json — shared across all Google OAuth apps
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

        // Piggyback: auto-bind Google identity for gateway login (best-effort, non-blocking)
        const username = RequestUser.username()
        if (username && tokens.access_token) {
          try {
            const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
              headers: { Authorization: `${tokens.token_type} ${tokens.access_token}` },
            })
            if (userinfoRes.ok) {
              const userinfo = (await userinfoRes.json()) as { email: string; verified_email: boolean }
              if (userinfo.email && userinfo.verified_email) {
                await GoogleBinding.bind(userinfo.email, username)
                oauthLog.info("Google identity auto-bound via MCP OAuth", {
                  email: userinfo.email,
                  username,
                })
              }
            }
          } catch (e) {
            // Best-effort — binding may already exist or userinfo may fail; don't block MCP flow
            oauthLog.info("Google binding piggyback skipped", {
              username,
              reason: e instanceof Error ? e.message : String(e),
            })
          }
        }

        // Enable all Google OAuth apps that share this token (store apps + legacy)
        const appNames: string[] = []

        // Store apps: any app with auth.provider === "google"
        for (const app of storeAppsForCallback) {
          const auth = app.manifest?.auth
          if (auth?.type === "oauth" && (auth as any).provider === "google") {
            appNames.push(app.manifest?.name ?? app.id)
            oauthLog.info("store app authenticated after shared OAuth", { appId: app.id })
          }
        }

        // Legacy managed apps (if any still registered)
        for (const id of LEGACY_GOOGLE_OAUTH_APP_IDS) {
          const snap = await ManagedAppRegistry.get(id).catch(() => null)
          if (snap && snap.operator.install === "installed") {
            try {
              await ManagedAppRegistry.setConfigKeys(id, ["googleOAuth"])
              await ManagedAppRegistry.enable(id)
              if (!appNames.includes(snap.name)) appNames.push(snap.name)
              oauthLog.info("legacy app enabled after shared OAuth", { appId: id })
            } catch {
              oauthLog.info("legacy app enable skipped", { appId: id })
            }
          }
        }

        const connectedLabel = appNames.length > 0 ? appNames.join(" & ") : "Google"
        oauthLog.info("OAuth connect complete", { appId, enabledApps: appNames })

        return c.html(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>${connectedLabel} connected</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`,
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
    )

    // ── MCP App Store CRUD (Layer 2) ─────────────────────────────────

    .get(
      "/store/apps",
      describeRoute({
        summary: "List installed MCP Apps from mcp-apps.json",
        operationId: "mcp.store.list",
        responses: { 200: { description: "App list with manifest metadata and tier" } },
      }),
      async (c) => {
        const apps = await McpAppStore.listApps()
        return c.json(apps)
      },
    )
    .post(
      "/store/apps",
      describeRoute({
        summary: "Register a new MCP App",
        operationId: "mcp.store.add",
        responses: {
          200: { description: "Registered app manifest" },
          400: { description: "Validation error" },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().optional(),
          githubUrl: z.string().optional(),
          id: z.string().optional(),
          target: z.enum(["system", "user"]).optional().default("system"),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")

        if (body.githubUrl) {
          const id =
            body.id ??
            body.githubUrl
              .split("/")
              .pop()
              ?.replace(/\.git$/, "") ??
            "unknown"
          try {
            const manifest = await McpAppStore.cloneAndRegister(body.githubUrl, id)
            return c.json({ id, manifest, status: "installed" })
          } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }

        if (body.path) {
          const id = body.id ?? body.path.split("/").pop() ?? "unknown"
          try {
            const manifest = await McpAppStore.addApp(id, body.path, body.target)
            return c.json({ id, manifest, status: "registered" })
          } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
          }
        }

        return c.json({ error: "Either 'path' or 'githubUrl' is required" }, 400)
      },
    )
    .post(
      "/store/apps/preview",
      describeRoute({
        summary: "Preview an MCP App manifest without registering",
        operationId: "mcp.store.preview",
        responses: {
          200: { description: "Manifest preview" },
          400: { description: "Manifest not found or invalid" },
        },
      }),
      validator("json", z.object({ path: z.string() })),
      async (c) => {
        const { path: appPath } = c.req.valid("json")
        try {
          const manifest = await McpAppManifest.load(appPath)
          return c.json({ manifest })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .patch(
      "/store/apps/:id",
      describeRoute({
        summary: "Update MCP App state (enable/disable)",
        operationId: "mcp.store.update",
        responses: { 200: { description: "Updated" } },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", z.object({ enabled: z.boolean() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const { enabled } = c.req.valid("json")
        try {
          await McpAppStore.setEnabled(id, enabled)
          return c.json({ id, enabled })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .put(
      "/store/apps/:id/config",
      describeRoute({
        summary: "Update MCP App config values",
        operationId: "mcp.store.setConfig",
        responses: { 200: { description: "Config updated" } },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", z.object({ config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })),
      async (c) => {
        const { id } = c.req.valid("param")
        const { config } = c.req.valid("json")
        try {
          await McpAppStore.setConfig(id, config)
          return c.json({ id, status: "configured" })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .delete(
      "/store/apps/:id",
      describeRoute({
        summary: "Remove an MCP App",
        operationId: "mcp.store.remove",
        responses: { 200: { description: "Removed" } },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const { id } = c.req.valid("param")
        try {
          await McpAppStore.removeApp(id)
          return c.json({ id, status: "removed" })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    ),
)
