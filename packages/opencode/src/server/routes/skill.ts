import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import fs from "fs/promises"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { Skill } from "../../skill/skill"

const log = Log.create({ service: "skill-route" })

/**
 * Skill loader endpoint.
 *
 * Exposes the in-process skill index over HTTP so external tools (the
 * system-manager MCP, ops scripts, the admin panel) can list what is
 * loaded and trigger a rescan after the user adds a new skill folder
 * or edits config.skills.paths — without bouncing the daemon.
 */

const SkillEntry = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
})

const SkillIndexResponse = z.object({
  skills: z.array(SkillEntry),
  dirs: z.array(z.string()),
  count: z.number().int().min(0),
})

const SkillLoadRequest = z.object({
  path: z
    .string()
    .min(1)
    .describe("Folder containing one or more SKILL.md files. Supports ~ expansion and relative paths."),
})

const SkillMutationResponse = z.object({
  action: z.enum(["load", "unload"]),
  target: z.string(),
  configFile: z.string(),
  pathsBefore: z.array(z.string()),
  pathsAfter: z.array(z.string()),
  configChanged: z.boolean(),
  index: SkillIndexResponse,
  warnings: z.array(z.string()).optional(),
})

async function buildIndex(): Promise<z.infer<typeof SkillIndexResponse>> {
  const [all, dirs] = await Promise.all([Skill.all(), Skill.dirs()])
  return {
    skills: all
      .map((s) => ({ name: s.name, description: s.description, location: s.location }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dirs: [...dirs].sort(),
    count: all.length,
  }
}

export const SkillRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List loaded skills",
        description:
          "Returns the current in-process skill index: every skill the daemon has loaded with its name, " +
          "description, SKILL.md path, and the de-duplicated set of source directories. Reflects the " +
          "cached state — call POST /skill/reload to force a rescan first.",
        operationId: "skill.list",
        responses: {
          200: {
            description: "Skill index snapshot",
            content: { "application/json": { schema: resolver(SkillIndexResponse) } },
          },
        },
      }),
      async (c) => {
        try {
          return c.json(await buildIndex())
        } catch (err) {
          log.error("list failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ code: "SKILL_LIST_FAILED", message: "skill list unavailable" }, 503)
        }
      },
    )
    .post(
      "/reload",
      describeRoute({
        summary: "Reload skills from disk",
        description:
          "Drops the cached skill index and rescans every source: " +
          "~/.claude/skills, ~/.agents/skills, project .claude/skills walked up from cwd, " +
          "Config.directories() (so ~/.config/opencode/skills and ~/.local/share/opencode/skills), " +
          "config.skills.paths, and config.skills.urls. Use after adding a SKILL.md or editing " +
          "opencode.json's skills.paths so the change goes live without restarting the daemon.",
        operationId: "skill.reload",
        responses: {
          200: {
            description: "Rescan completed; returns the fresh index",
            content: { "application/json": { schema: resolver(SkillIndexResponse) } },
          },
        },
      }),
      async (c) => {
        try {
          Skill.reset()
          const index = await buildIndex()
          log.info("reload complete", { count: index.count, dirs: index.dirs.length })
          return c.json(index)
        } catch (err) {
          log.error("reload failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json({ code: "SKILL_RELOAD_FAILED", message: "skill reload failed" }, 503)
        }
      },
    )
    .post(
      "/load",
      describeRoute({
        summary: "Add a folder to skills.paths and reload",
        description:
          "Persistently adds the given folder to ~/.config/opencode/opencode.json's skills.paths " +
          "(idempotent — duplicates are skipped) and triggers a rescan so any SKILL.md files " +
          "directly inside or nested below it become available. Survives daemon restart. The " +
          "JSONC editor preserves comments and formatting in the existing config file.",
        operationId: "skill.load",
        responses: {
          200: {
            description: "Path registered (or already present) and index rebuilt",
            content: { "application/json": { schema: resolver(SkillMutationResponse) } },
          },
          400: { description: "Invalid path argument" },
          404: { description: "Folder does not exist" },
        },
      }),
      validator("json", SkillLoadRequest),
      async (c) => {
        const { path: input } = c.req.valid("json")
        let target: string
        try {
          target = Skill.expandPath(input)
        } catch (err) {
          return c.json(
            { code: "SKILL_LOAD_BAD_PATH", message: err instanceof Error ? err.message : String(err) },
            400,
          )
        }
        const warnings: string[] = []
        try {
          const stat = await fs.stat(target)
          if (!stat.isDirectory()) warnings.push("path is not a directory; the rescan will likely find nothing")
        } catch {
          warnings.push("path does not exist yet; entry is registered and will be picked up if/when created")
        }
        try {
          const mutation = await Skill.addUserPath(target)
          const index = await buildIndex()
          log.info("load complete", {
            target,
            file: mutation.file,
            changed: mutation.changed,
            count: index.count,
          })
          return c.json({
            action: "load" as const,
            target: mutation.target,
            configFile: mutation.file,
            pathsBefore: mutation.before,
            pathsAfter: mutation.after,
            configChanged: mutation.changed,
            index,
            warnings: warnings.length ? warnings : undefined,
          })
        } catch (err) {
          log.error("load failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json(
            { code: "SKILL_LOAD_FAILED", message: err instanceof Error ? err.message : String(err) },
            503,
          )
        }
      },
    )
    .post(
      "/unload",
      describeRoute({
        summary: "Remove a folder from skills.paths and reload",
        description:
          "Inverse of /load: removes the path entry from ~/.config/opencode/opencode.json's " +
          "skills.paths and rescans. Skills bundled with opencode (under Global.Path.config / " +
          "Global.Path.data) and the hard-wired ~/.claude/skills, ~/.agents/skills, and " +
          "project .claude/skills paths are not affected — only the user-added paths array.",
        operationId: "skill.unload",
        responses: {
          200: {
            description: "Path removed (or already absent) and index rebuilt",
            content: { "application/json": { schema: resolver(SkillMutationResponse) } },
          },
          400: { description: "Invalid path argument" },
        },
      }),
      validator("json", SkillLoadRequest),
      async (c) => {
        const { path: input } = c.req.valid("json")
        let target: string
        try {
          target = Skill.expandPath(input)
        } catch (err) {
          return c.json(
            { code: "SKILL_UNLOAD_BAD_PATH", message: err instanceof Error ? err.message : String(err) },
            400,
          )
        }
        try {
          const mutation = await Skill.removeUserPath(target)
          const index = await buildIndex()
          log.info("unload complete", {
            target,
            file: mutation.file,
            changed: mutation.changed,
            count: index.count,
          })
          return c.json({
            action: "unload" as const,
            target: mutation.target,
            configFile: mutation.file,
            pathsBefore: mutation.before,
            pathsAfter: mutation.after,
            configChanged: mutation.changed,
            index,
          })
        } catch (err) {
          log.error("unload failed", { error: err instanceof Error ? err.message : String(err) })
          return c.json(
            { code: "SKILL_UNLOAD_FAILED", message: err instanceof Error ? err.message : String(err) },
            503,
          )
        }
      },
    ),
)
