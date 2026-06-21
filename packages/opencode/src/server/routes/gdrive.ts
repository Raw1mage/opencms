import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { getSetupStatus, normalizeRemote } from "../../gdrive/setup-cli"
import { errors } from "../error"

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
          "Receives browser OAuth callback for Google Drive setup. Token exchange is intentionally not completed in this first slice.",
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
        return c.html(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google Drive authorization received</h2><p>Return to the agent to continue setup. Token exchange is not implemented in this slice.</p></body></html>`,
        )
      },
    ),
)
