import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import {
  WorkspaceDeleteOperationResultSchema,
  WorkspaceOperation,
  WorkspaceResetOperationResultSchema,
  WorkspaceService,
} from "../../project/workspace"
import { WorkspaceAggregateSchema } from "../../project/workspace/types"
import { Storage } from "../../storage/storage"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const WorkspaceStatus = z.object({
  projectId: z.string(),
  total: z.number(),
  kinds: z.object({
    root: z.number(),
    sandbox: z.number(),
    derived: z.number(),
  }),
  attachments: z.object({
    sessions: z.number(),
    ptys: z.number(),
    previews: z.number(),
    workers: z.number(),
  }),
})

export const WorkspaceRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List project workspaces",
        description: "Resolve and return known workspaces for the current project, including root and sandboxes.",
        operationId: "workspace.list",
        responses: {
          200: {
            description: "List of workspaces",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const workspaces = await WorkspaceService.listProjectWorkspaces(Instance.project)
        return c.json(workspaces)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current workspace",
        description: "Resolve the workspace corresponding to the current instance directory.",
        operationId: "workspace.current",
        responses: {
          200: {
            description: "Current workspace",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
        },
      }),
      async (c) => {
        const workspace = await WorkspaceService.resolve({ directory: Instance.directory })
        return c.json(workspace)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get workspace project status",
        description:
          "Return a lightweight workspace summary for the current project including counts and attachment totals.",
        operationId: "workspace.status",
        responses: {
          200: {
            description: "Workspace status summary",
            content: {
              "application/json": {
                schema: resolver(WorkspaceStatus),
              },
            },
          },
        },
      }),
      async (c) => {
        const status = await WorkspaceService.getProjectStatus(Instance.project)
        return c.json(status)
      },
    )
    .get(
      "/:workspaceID",
      describeRoute({
        summary: "Get workspace by id",
        description: "Return a previously resolved workspace from the registry by workspace id.",
        operationId: "workspace.get",
        responses: {
          200: {
            description: "Workspace info",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const workspace = await WorkspaceService.getById(c.req.param("workspaceID"))
        if (!workspace) throw new Storage.NotFoundError({ message: "Workspace not found" })
        return c.json(workspace)
      },
    )
    .post(
      "/:workspaceID/reset-run",
      describeRoute({
        summary: "Run workspace reset operation",
        description:
          "Archive active sessions, dispose runtime instance state, reset the sandbox worktree, and return the updated workspace aggregate.",
        operationId: "workspace.resetRun",
        responses: {
          200: {
            description: "Workspace reset operation result",
            content: {
              "application/json": {
                schema: resolver(WorkspaceResetOperationResultSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceOperation.reset({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/delete-run",
      describeRoute({
        summary: "Run workspace delete operation",
        description:
          "Archive active sessions, dispose runtime instance state, remove the sandbox worktree, remove project sandbox metadata, and return the archived workspace aggregate.",
        operationId: "workspace.deleteRun",
        responses: {
          200: {
            description: "Workspace delete operation result",
            content: {
              "application/json": {
                schema: resolver(WorkspaceDeleteOperationResultSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceOperation.delete({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/reset",
      describeRoute({
        summary: "Mark workspace resetting",
        description: "Transition a workspace into resetting lifecycle state.",
        operationId: "workspace.reset",
        responses: {
          200: {
            description: "Workspace updated",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceService.markResetting({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/delete",
      describeRoute({
        summary: "Mark workspace deleting",
        description: "Transition a workspace into deleting lifecycle state.",
        operationId: "workspace.delete",
        responses: {
          200: {
            description: "Workspace updated",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceService.markDeleting({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/archive",
      describeRoute({
        summary: "Mark workspace archived",
        description: "Transition a workspace into archived lifecycle state.",
        operationId: "workspace.archive",
        responses: {
          200: {
            description: "Workspace updated",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceService.markArchived({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/active",
      describeRoute({
        summary: "Mark workspace active",
        description: "Transition a workspace into active lifecycle state.",
        operationId: "workspace.active",
        responses: {
          200: {
            description: "Workspace updated",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceService.markActive({ workspaceID: c.req.valid("param").workspaceID })),
    )
    .post(
      "/:workspaceID/failed",
      describeRoute({
        summary: "Mark workspace failed",
        description: "Transition a workspace into failed lifecycle state.",
        operationId: "workspace.failed",
        responses: {
          200: {
            description: "Workspace updated",
            content: {
              "application/json": {
                schema: resolver(WorkspaceAggregateSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ workspaceID: z.string() })),
      async (c) => c.json(await WorkspaceService.markFailed({ workspaceID: c.req.valid("param").workspaceID })),
    ),
)
