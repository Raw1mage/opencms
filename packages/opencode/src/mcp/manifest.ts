import fs from "fs/promises"
import path from "path"
import z from "zod/v4"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "@/util/log"

/**
 * MCP App Package Convention (Layer 1)
 *
 * A valid MCP App is a directory containing mcp.json + an executable MCP server.
 * The manifest declares identity and launch command; tool discovery happens at
 * runtime via the MCP protocol's tools/list.
 */
export namespace McpAppManifest {
  const log = Log.create({ service: "mcp-manifest" })

  // ── Auth contract ────────────────────────────────────────────────────

  export const AuthNone = z.object({ type: z.literal("none") })

  export const AuthOAuth = z.object({
    type: z.literal("oauth"),
    provider: z.string(),
    tokenEnv: z.string(),
    refreshTokenEnv: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })

  export const AuthApiKey = z.object({
    type: z.literal("api-key"),
    provider: z.string(),
    tokenEnv: z.string(),
  })

  export const Auth = z.discriminatedUnion("type", [AuthNone, AuthOAuth, AuthApiKey])
  export type Auth = z.infer<typeof Auth>

  // ── Settings schema ──────────────────────────────────────────────────

  export const SettingsFieldType = z.enum(["string", "number", "boolean", "select"])
  export type SettingsFieldType = z.infer<typeof SettingsFieldType>

  export const SettingsField = z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: SettingsFieldType,
    description: z.string().optional(),
    required: z.boolean().optional().default(false),
    secret: z.boolean().optional().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  })
  export type SettingsField = z.infer<typeof SettingsField>

  export const Settings = z.object({
    fields: z.array(SettingsField).min(1),
  })
  export type Settings = z.infer<typeof Settings>

  // ── Source provenance ────────────────────────────────────────────────

  export const Source = z.discriminatedUnion("type", [
    z.object({ type: z.literal("github"), repo: z.string(), ref: z.string().optional() }),
    z.object({ type: z.literal("local") }),
  ])
  export type Source = z.infer<typeof Source>

  // ── Manifest schema ──────────────────────────────────────────────────

  // /specs/docxmcp-http-transport DD-8 / DD-12: mcp app manifests can
  // declare an HTTP transport (Streamable HTTP) including unix:// URLs
  // for Unix domain socket binding. When `transport` is "streamable-http"
  // the `command` array is optional (the docker container is brought up
  // out-of-band by docker compose); the connection is keyed off `url`.
  export const Schema = z
    .object({
      id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "id must be alphanumeric with hyphens/underscores"),
      name: z.string().min(1),
      command: z.array(z.string()).min(1).optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      version: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      settings: Settings.optional(),
      modelProcess: z.array(z.string()).optional(),
      auth: Auth.optional().default({ type: "none" }),
      source: Source.optional(),
      transport: z.enum(["stdio", "streamable-http", "sse"]).optional().default("stdio"),
      url: z.string().optional(),
    })
    .refine(
      (m) => m.transport === "stdio" ? !!m.command : !!m.url,
      "transport=streamable-http|sse requires url; transport=stdio requires command",
    )
    .meta({ ref: "McpAppManifest" })

  export type Manifest = z.infer<typeof Schema>

  // ── Errors ───────────────────────────────────────────────────────────

  export const NotFoundError = NamedError.create(
    "McpManifestNotFoundError",
    z.object({ dir: z.string(), reason: z.string() }),
  )

  export const InvalidError = NamedError.create(
    "McpManifestInvalidError",
    z.object({ dir: z.string(), errors: z.string() }),
  )

  // ── Path safety ──────────────────────────────────────────────────────

  function assertSafePath(dirPath: string): string {
    const resolved = path.resolve(dirPath)
    // Block obvious traversal — the resolved path must not contain ".."
    // after resolution (which would indicate symlink tricks on some systems)
    if (resolved.includes("..")) {
      throw new NotFoundError({ dir: dirPath, reason: "Path traversal rejected" })
    }
    return resolved
  }

  // ── Load manifest ────────────────────────────────────────────────────

  /**
   * Load and validate mcp.json from an App directory.
   *
   * - If mcp.json exists: parse + validate via Zod schema.
   * - If mcp.json is missing: attempt inference from project files.
   * - All failure paths log.warn and throw — NO silent fallback.
   */
  export async function load(dirPath: string): Promise<Manifest> {
    const dir = assertSafePath(dirPath)
    const manifestPath = path.join(dir, "mcp.json")

    let raw: unknown
    try {
      const content = await fs.readFile(manifestPath, "utf-8")
      raw = JSON.parse(content)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // mcp.json not found — try inference
        log.info("mcp.json not found, attempting inference", { dir })
        const inferred = await infer(dir)
        if (inferred) return inferred
        log.warn("manifest inference failed — no mcp.json and unable to infer command", { dir })
        throw new NotFoundError({
          dir,
          reason: "mcp.json not found and command could not be inferred from project files",
        })
      }
      log.warn("failed to read mcp.json", { dir, error: String(err) })
      throw new NotFoundError({ dir, reason: `Failed to read mcp.json: ${err}` })
    }

    const result = Schema.safeParse(raw)
    if (!result.success) {
      const errorMsg = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      log.warn("mcp.json schema validation failed", { dir, errors: errorMsg })
      throw new InvalidError({ dir, errors: errorMsg })
    }

    return result.data
  }

  // ── Inference engine ─────────────────────────────────────────────────

  /**
   * Attempt to infer a manifest from project files when mcp.json is absent.
   *
   * Returns the inferred manifest (also writes mcp.json to disk), or null
   * if inference fails. Caller is responsible for throwing on null.
   */
  export async function infer(dirPath: string): Promise<Manifest | null> {
    const dir = assertSafePath(dirPath)
    const dirName = path.basename(dir)

    // Try package.json (Node.js / Bun)
    try {
      const pkgContent = await fs.readFile(path.join(dir, "package.json"), "utf-8")
      const pkg = JSON.parse(pkgContent)
      const name = pkg.name ?? dirName

      // Check for bin entry
      if (pkg.bin) {
        const binCmd = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0]
        if (binCmd) {
          return await writeInferred(dir, {
            id: sanitizeId(name),
            name,
            command: ["node", binCmd as string],
          })
        }
      }
      // Check for start script
      if (pkg.scripts?.start) {
        return await writeInferred(dir, {
          id: sanitizeId(name),
          name,
          command: ["npm", "start"],
        })
      }
      // Check for main field
      if (pkg.main) {
        return await writeInferred(dir, {
          id: sanitizeId(name),
          name,
          command: ["node", pkg.main],
        })
      }
    } catch {
      // No package.json or invalid — continue
    }

    // Try pyproject.toml
    try {
      await fs.access(path.join(dir, "pyproject.toml"))
      return await writeInferred(dir, {
        id: sanitizeId(dirName),
        name: dirName,
        command: ["uvx", "."],
      })
    } catch {
      // No pyproject.toml — continue
    }

    // Try requirements.txt + server.py
    try {
      await fs.access(path.join(dir, "requirements.txt"))
      await fs.access(path.join(dir, "server.py"))
      return await writeInferred(dir, {
        id: sanitizeId(dirName),
        name: dirName,
        command: ["python", "-u", "server.py"],
      })
    } catch {
      // Not a Python project — continue
    }

    return null
  }

  function sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
  }

  async function writeInferred(
    dir: string,
    partial: { id: string; name: string; command: string[] },
  ): Promise<Manifest> {
    const manifest: Manifest = {
      ...partial,
      auth: { type: "none" },
      transport: "stdio",
    }
    const manifestPath = path.join(dir, "mcp.json")
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    log.info("auto-generated mcp.json from project files", { dir, id: manifest.id, command: manifest.command })
    return manifest
  }
}
