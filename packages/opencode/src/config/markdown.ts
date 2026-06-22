import { NamedError } from "@opencode-ai/util/error"
import matter from "gray-matter"
import { z } from "zod"

export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  // other coding agents like claude code allow invalid yaml in their
  // frontmatter, we need to fallback to a more permissive parser for those cases
  export function fallbackSanitization(content: string): string {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return content

    const frontmatter = match[1]
    const lines = frontmatter.split(/\r?\n/)
    const result: string[] = []

    for (const line of lines) {
      // skip comments and empty lines
      if (line.trim().startsWith("#") || line.trim() === "") {
        result.push(line)
        continue
      }

      // skip lines that are continuations (indented)
      if (line.match(/^\s+/)) {
        result.push(line)
        continue
      }

      // match key: value pattern
      const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!kvMatch) {
        result.push(line)
        continue
      }

      const key = kvMatch[1]
      const value = kvMatch[2].trim()

      // skip if value is empty, already quoted, or uses block scalar
      if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
        result.push(line)
        continue
      }

      // if value contains a colon, convert to block scalar
      if (value.includes(":")) {
        result.push(`${key}: |-`)
        result.push(`  ${value}`)
        continue
      }

      result.push(line)
    }

    const processed = result.join("\n")
    return content.replace(frontmatter, () => processed)
  }

  // gray-matter keeps a PROCESS-GLOBAL cache keyed by raw content
  // (matter.cache[file.content]) that it only consults when no options object is
  // passed (index.js: `if (!options) { if (cached) … ; cache[content] = file }`).
  // Crucially it writes the cache entry BEFORE the YAML body is parsed, so a
  // frontmatter that makes strict js-yaml THROW (e.g. a description scalar with a
  // mid-value colon) poisons the cache with an empty-data entry: the first call
  // throws and our fallback path recovers it, but every SUBSEQUENT call on the
  // same content hits the poisoned cache, returns `{ data: {} }` WITHOUT
  // throwing, so the fallback never runs and the skill silently loses its
  // name/description. In a long-lived daemon that re-scans skills repeatedly this
  // makes such a skill (doc-workflow) intermittently invisible while a fresh
  // process — whose cache is empty — always sees it. Passing an options object on
  // every call takes gray-matter's no-cache branch, so each parse is independent
  // and deterministic. We sacrifice a micro-cache we never relied on.
  const MATTER_OPTS: matter.GrayMatterOption<string, any> = {}

  export async function parse(filePath: string) {
    const template = await Bun.file(filePath).text()

    try {
      const md = matter(template, MATTER_OPTS)
      return md
    } catch {
      try {
        return matter(fallbackSanitization(template), MATTER_OPTS)
      } catch (err) {
        throw new FrontmatterError(
          {
            path: filePath,
            message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
          },
          { cause: err },
        )
      }
    }
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
