import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import {
  buildGDriveAuthUrl,
  decodeSetupState,
  encodeSetupState,
  exchangeGDriveAuthCode,
  gdriveOAuthClientFromEnv,
  getSetupStatus,
  normalizeRemote,
  writeRcloneDriveRemote,
} from "../../gdrive/setup-cli"
import { errors } from "../error"
import { RequestUser } from "@/runtime/request-user"

const SetupStatusSchema = z.object({
  home: z.string(),
  configPath: z.string(),
  remote: z.string(),
  rcloneAvailable: z.boolean(),
  remoteConfigured: z.boolean(),
  fuseAvailable: z.boolean(),
  mounted: z.boolean().optional(),
  mountPoint: z.string().optional(),
  remediation: z.string().optional(),
})

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export const GDriveRoutes = lazy(() =>
  new Hono()
    .get(
      "/setup/connect",
      describeRoute({
        summary: "Start Google Drive OAuth setup",
        description:
          "Redirects to Google OAuth for Drive access and binds the resulting token to the current user's rclone config.",
        operationId: "gdrive.setup.connect",
        responses: {
          302: { description: "Redirect to Google OAuth" },
          ...errors(400, 403),
        },
      }),
      async (c) => {
        const client = gdriveOAuthClientFromEnv()
        if (!client) return c.json({ error: "Google Drive OAuth client is not configured" }, 400)
        const remote = normalizeRemote(c.req.query("remote") ?? undefined)
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const redirectUri = `${proto}://${host}/api/v2/gdrive/setup/callback`
        const state = encodeSetupState({ remote, username: RequestUser.username() ?? undefined })
        return c.redirect(
          buildGDriveAuthUrl({
            clientId: client.clientId,
            authUri: client.authUri,
            redirectUri,
            state,
          }),
        )
      },
    )
    .get(
      "/setup/status",
      describeRoute({
        summary: "Get Google Drive setup status",
        description: "Returns bounded rclone/FUSE readiness for the current Linux user without exposing tokens.",
        operationId: "gdrive.setup.status",
        responses: {
          200: {
            description: "Google Drive setup status",
            content: {
              "application/json": {
                schema: resolver(SetupStatusSchema),
              },
            },
          },
          ...errors(400, 500),
        },
      }),
      async (c) => {
        try {
          const remote = normalizeRemote(c.req.query("remote") ?? undefined)
          const mountPoint = c.req.query("mountPoint") ?? undefined
          return c.json(await getSetupStatus({ remote, mountPoint }), 200)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
      },
    )
    .get(
      "/setup/callback",
      describeRoute({
        summary: "Receive Google Drive OAuth callback",
        description:
          "Receives browser OAuth callback, exchanges the authorization code, and writes the current user's rclone Drive remote.",
        operationId: "gdrive.setup.callback",
        responses: {
          200: { description: "Callback received" },
          ...errors(400),
        },
      }),
      async (c) => {
        const error = c.req.query("error")
        if (error) {
          return c.html(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google Drive authorization denied</h2><p>${escapeHtml(error)}</p></body></html>`,
          )
        }
        const code = c.req.query("code")
        if (!code) return c.json({ error: "Missing authorization code" }, 400)
        const stateRaw = c.req.query("state")
        if (!stateRaw) return c.json({ error: "Missing setup state" }, 400)
        const client = gdriveOAuthClientFromEnv()
        if (!client) return c.json({ error: "Google Drive OAuth client is not configured" }, 400)
        let setupState: ReturnType<typeof decodeSetupState>
        try {
          setupState = decodeSetupState(stateRaw)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
        const username = RequestUser.username() ?? undefined
        if (setupState.username && username && setupState.username !== username) {
          return c.json({ error: "Google Drive setup state user mismatch" }, 403)
        }
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const redirectUri = `${proto}://${host}/api/v2/gdrive/setup/callback`
        try {
          const token = await exchangeGDriveAuthCode({ client, code, redirectUri })
          await writeRcloneDriveRemote({ remote: setupState.remote, token, client })
        } catch (error) {
          return c.html(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google Drive setup failed</h2><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></body></html>`,
          )
        }
        return c.html(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google Drive setup complete</h2><p>The rclone remote is configured. Return to the agent and ask it to mount Google Drive.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`,
        )
      },
    ),
)
