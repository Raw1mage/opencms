import z from "zod"
import path from "path"
import os from "os"
import { promises as fs } from "fs"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Bus } from "@/bus"
import { Session } from "@/session"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const SKILL_GLOB = new Bun.Glob("**/SKILL.md")

  async function createState() {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      dirs.add(path.dirname(match))

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    // Single authoritative skill source: <data>/skills only (~/.local/share/opencode/skills).
    // Deliberately NOT scanning ~/.claude, ~/.agents, ~/.config/opencode/skills,
    // project .opencode/skills, config.skills.paths, or config.skills.urls — those
    // pulled in same-name copies from other agents and produced shadowing ambiguity.
    // MCP-server-carried skills (e.g. docxmcp/skills) are installed INTO this central
    // directory, not read from their repos.
    const skillRoot = path.join(Global.Path.data, "skills")
    if (await Filesystem.isDir(skillRoot)) {
      for await (const match of SKILL_GLOB.scan({
        cwd: skillRoot,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        await addSkill(match)
      }
    } else {
      log.warn("skill root not found", { path: skillRoot })
    }

    return {
      skills,
      dirs: Array.from(dirs),
    }
  }

  type StateGetter = (() => Promise<Awaited<ReturnType<typeof createState>>>) & { reset?: () => void }
  let stateGetter: StateGetter | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  export function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState) as unknown as StateGetter
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  /** Drop the cached skill index so the next state() call rescans every source. */
  export function reset() {
    stateGetter?.reset?.()
    fallbackState = undefined
    log.info("skill state reset")
  }

  /**
   * Resolve `~/...` and relative paths to an absolute path. Returns the
   * canonical form used for de-duplication in skills.paths.
   */
  export function expandPath(input: string): string {
    const trimmed = input.trim()
    if (!trimmed) throw new Error("path is required")
    let expanded = trimmed
    if (expanded === "~" || expanded.startsWith("~/")) {
      expanded = path.join(os.homedir(), expanded === "~" ? "" : expanded.slice(2))
    }
    return path.resolve(expanded)
  }

  /**
   * Pick the user-level config file to mutate. Prefer an existing
   * opencode.jsonc (so comments survive); fall back to opencode.json
   * (creating it if neither exists).
   */
  async function chooseUserConfigFile(): Promise<string> {
    const dir = Global.Path.config
    const jsonc = path.join(dir, "opencode.jsonc")
    const json = path.join(dir, "opencode.json")
    try {
      await fs.access(jsonc)
      return jsonc
    } catch {}
    try {
      await fs.access(json)
      return json
    } catch {}
    return json
  }

  async function readUserConfigText(file: string): Promise<string> {
    try {
      return await fs.readFile(file, "utf-8")
    } catch (err: any) {
      if (err?.code === "ENOENT") return "{}\n"
      throw err
    }
  }

  function parseSkillPaths(text: string): string[] {
    const parsed = (parseJsonc(text) as { skills?: { paths?: unknown } } | undefined) ?? {}
    const raw = parsed.skills?.paths
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === "string")
  }

  type MutationResult = {
    file: string
    before: string[]
    after: string[]
    changed: boolean
  }

  async function mutateSkillPaths(transform: (current: string[]) => string[]): Promise<MutationResult> {
    const file = await chooseUserConfigFile()
    const original = await readUserConfigText(file)
    const before = parseSkillPaths(original)
    const after = transform(before.slice())
    const changed = before.length !== after.length || before.some((p, i) => p !== after[i])
    if (!changed) return { file, before, after, changed: false }

    const formatting = { tabSize: 2, insertSpaces: true, eol: "\n" as const }
    const edits = modify(original, ["skills", "paths"], after, { formattingOptions: formatting })
    const next = applyEdits(original, edits)
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    await fs.writeFile(file, next, "utf-8")
    return { file, before, after, changed: true }
  }

  /**
   * Add a folder to the user-level `skills.paths` array (idempotent) and
   * invalidate the cache so the next list() rescans. The path is normalised
   * (`~/` expansion + `path.resolve`) before comparison.
   */
  export async function addUserPath(input: string) {
    const target = expandPath(input)
    const result = await mutateSkillPaths((paths) => {
      const expanded = paths.map((p) => {
        try {
          return expandPath(p)
        } catch {
          return p
        }
      })
      const idx = expanded.findIndex((p) => p === target)
      if (idx >= 0) return paths
      return [...paths, target]
    })
    if (result.changed) {
      reset()
      log.info("user skill path added", { path: target, file: result.file })
    } else {
      log.info("user skill path already present", { path: target, file: result.file })
    }
    return { ...result, target }
  }

  /**
   * Remove a folder from the user-level `skills.paths`. Matches by
   * normalised absolute path so the user can pass `~/foo` even if the
   * stored entry is the resolved form (or vice versa).
   */
  export async function removeUserPath(input: string) {
    const target = expandPath(input)
    const result = await mutateSkillPaths((paths) =>
      paths.filter((p) => {
        try {
          return expandPath(p) !== target
        } catch {
          return true
        }
      }),
    )
    if (result.changed) {
      reset()
      log.info("user skill path removed", { path: target, file: result.file })
    } else {
      log.info("user skill path was not present", { path: target, file: result.file })
    }
    return { ...result, target }
  }

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }
}
