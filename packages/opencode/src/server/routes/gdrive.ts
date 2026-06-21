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

export const GDriveRoutes = lazy(() =>
  new Hono().get(
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
  ),
)
