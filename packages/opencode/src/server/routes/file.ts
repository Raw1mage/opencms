import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { Log } from "@/util/log"
import { RequestUser } from "@/runtime/request-user"

const log = Log.create({ service: "server.routes.file" })

function fileOperationResponse(c: { json: (body: unknown, status?: number) => Response }, fn: () => Promise<unknown>) {
  return fn()
    .then((result) => c.json(result))
    .catch((err) => {
      if (err instanceof File.OperationError) return c.json(err.toObject(), err.status)
      throw err
    })
}

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
    )
    .post(
      "/file/directory",
      describeRoute({
        summary: "Create directory",
        description: "Create a directory at the specified path.",
        operationId: "file.createDirectory",
        responses: {
          200: {
            description: "Created directory",
            content: {
              "application/json": {
                schema: resolver(File.DirectoryCreateResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().min(1),
        }),
      ),
      async (c) => {
        const path = c.req.valid("json").path
        const content = await File.createDirectory({ path })
        return c.json(content)
      },
    )
    .post(
      "/file/create",
      describeRoute({
        summary: "Create file or directory",
        description: "Create a file or directory under an active-project parent. Basename conflicts are rejected.",
        operationId: "file.create",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          parent: z.string(),
          name: z.string().min(1),
          type: z.enum(["file", "directory"]),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.create(body))
      },
    )
    .post(
      "/file/rename",
      describeRoute({
        summary: "Rename file or directory",
        description:
          "Rename an active-project item. The new name must be a basename and destination conflicts are rejected.",
        operationId: "file.rename",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().min(1),
          name: z.string().min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.rename(body))
      },
    )
    .post(
      "/file/move",
      describeRoute({
        summary: "Move file or directory",
        description:
          "Move an active-project item into an active-project directory. Destination conflicts are rejected.",
        operationId: "file.move",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          destinationParent: z.string(),
          scope: z.enum(["active-project", "external"]).optional(),
          overwrite: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.move(body))
      },
    )
    .post(
      "/file/copy",
      describeRoute({
        summary: "Copy file or directory",
        description:
          "Copy an active-project item into an active-project directory. Destination conflicts are rejected.",
        operationId: "file.copy",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          destinationParent: z.string(),
          scope: z.enum(["active-project", "external"]).optional(),
          overwrite: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.copy(body))
      },
    )
    .post(
      "/file/delete",
      describeRoute({
        summary: "Delete file or directory to recyclebin",
        description: "Move an active-project item into repo-local recyclebin. Requires explicit confirmation.",
        operationId: "file.deleteToRecyclebin",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().min(1),
          confirmed: z.boolean(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.deleteToRecyclebin(body))
      },
    )
    .post(
      "/file/restore",
      describeRoute({
        summary: "Restore file or directory from recyclebin",
        description: "Restore a repo-local recyclebin tombstone using its metadata. Restore conflicts are rejected.",
        operationId: "file.restoreFromRecyclebin",
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          tombstonePath: z.string().min(1),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.restoreFromRecyclebin(body))
      },
    )
    .post(
      "/file/destination/preflight",
      describeRoute({
        summary: "Preflight file-operation destination",
        description:
          "Resolve and probe a destination directory. External destinations are preflight-only in this slice.",
        operationId: "file.destinationPreflight",
        responses: {
          200: {
            description: "Destination preflight result",
            content: {
              "application/json": {
                schema: resolver(File.DestinationPreflightResult),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          destinationParent: z.string().min(1),
          scope: z.enum(["active-project", "external"]),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        return fileOperationResponse(c, () => File.destinationPreflight(body))
      },
    )
    .post(
      "/file/upload",
      describeRoute({
        summary: "Upload file into active-project directory",
        description:
          "Upload a single file via multipart/form-data into the given active-project parent directory. Browser-supplied filename basename is used; embedded path separators are rejected. Duplicate destinations and oversize payloads are rejected.",
        operationId: "file.upload",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["parent", "file"],
                properties: {
                  parent: { type: "string" },
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "File operation result",
            content: {
              "application/json": {
                schema: resolver(File.OperationResult),
              },
            },
          },
        },
      }),
      async (c) => {
        return fileOperationResponse(c, async () => {
          const form = await c.req.formData().catch(() => null)
          if (!form) {
            throw new File.OperationError(
              "FILE_OP_INVALID_NAME",
              "Expected multipart form data with parent and file fields.",
              400,
            )
          }
          const parent = form.get("parent")
          const file = form.get("file")
          if (typeof parent !== "string") {
            throw new File.OperationError(
              "FILE_OP_INVALID_NAME",
              "Missing 'parent' field.",
              400,
            )
          }
          if (!(file instanceof Blob)) {
            throw new File.OperationError(
              "FILE_OP_INVALID_NAME",
              "Missing 'file' part.",
              400,
            )
          }
          const maybeNamed = file as Blob & { name?: unknown }
          const filename = typeof maybeNamed.name === "string" ? maybeNamed.name : ""
          return File.upload({ parent, filename, source: file })
        })
      },
    )
    .get(
      "/file/download",
      describeRoute({
        summary: "Download file from active project",
        description:
          "Stream the bytes of an active-project file. Directory targets are rejected with FILE_DOWNLOAD_DIRECTORY_UNSUPPORTED. Symlinks whose realpath leaves the project are rejected with FILE_OP_PATH_ESCAPE.",
        operationId: "file.download",
        responses: {
          200: {
            description: "File bytes",
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().min(1),
        }),
      ),
      async (c) => {
        const errorShim = c as unknown as { json: (body: unknown, status?: number) => Response }
        try {
          const result = await File.download({ path: c.req.valid("query").path })
          const bunFile = Bun.file(result.absolutePath)
          return new Response(bunFile.stream(), {
            headers: {
              "Content-Type": result.mimeType,
              "Content-Length": String(result.size),
              "Content-Disposition": `attachment; filename="${result.filename.replaceAll('"', "")}"`,
              "Cache-Control": "no-store",
            },
          })
        } catch (err) {
          if (err instanceof File.OperationError) return errorShim.json(err.toObject(), err.status)
          throw err
        }
      },
    )
    .get(
      "/file/stat",
      describeRoute({
        summary: "Stat file",
        description:
          "Lightweight mtime/size probe for an open file viewer to detect on-disk changes without re-reading content. Used by the SPA to poll the active file tab.",
        operationId: "file.stat",
        responses: {
          200: {
            description: "File stat",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    mtime: z.number(),
                    size: z.number(),
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
          path: z.string(),
        }),
      ),
      async (c) => {
        const reqPath = c.req.valid("query").path
        const fs = await import("fs/promises")
        const path = await import("path")
        const resolved = path.isAbsolute(reqPath) ? reqPath : path.resolve(Instance.directory, reqPath)
        const stat = await fs.stat(resolved)
        return c.json({ mtime: stat.mtimeMs, size: stat.size })
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        c.header("X-Opencode-Review-Directory", Instance.directory)
        c.header("X-Opencode-Review-Count", String(content.length))
        if (process.env.OPENCODE_DEBUG_REVIEW_CHECKPOINT === "1") {
          log.info("checkpoint:file.status.route", {
            requestUser: RequestUser.username() ?? null,
            directory: Instance.directory,
            statusCount: content.length,
          })
        }
        return c.json(content)
      },
    ),
)
