import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Skill } from "@/skill"
import { SkillLayerRegistry } from "./skill-layer-registry"
import { RuntimeEventService } from "@/system/runtime-event-service"

const log = Log.create({ service: "mandatory-skills" })

export type MandatorySource = "agents_md_global" | "agents_md_project" | "coding_txt"

export type MandatorySentinelBlock = {
  skills: string[]
  sourceFile: string
  startLine: number
  endLine: number | null
}

export type ResolveInput = {
  sessionID: string
  agent: { name: string }
  isSubagent: boolean
}

export type ResolveResult = {
  list: string[]
  bySkill: Record<string, MandatorySource[]>
}

export type PreloadOutcome = {
  skill: string
  source: MandatorySource
  status: "preloaded" | "already_pinned" | "missing" | "error"
  skillMdPath?: string | null
  error?: string | null
}

const OPENER_RE = /<!--\s*opencode:mandatory-skills\s*-->/
const CLOSER_RE = /<!--\s*\/opencode:mandatory-skills\s*-->/
const BULLET_RE = /^\s*-\s+(.*)$/
const KEEP_RULE_AGENTS = "mandatory:agents_md"
const KEEP_RULE_CODING = "mandatory:coding_txt"

function normalizeBullet(raw: string): string {
  const hashIdx = raw.indexOf("#")
  const body = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim()
  return body
}

export function parseMandatorySkillsBlocks(text: string, sourceFile: string): MandatorySentinelBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MandatorySentinelBlock[] = []
  let current: { startLine: number; skills: string[] } | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!current) {
      if (OPENER_RE.test(line)) {
        current = { startLine: i + 1, skills: [] }
      }
      continue
    }
    if (CLOSER_RE.test(line)) {
      blocks.push({
        skills: current.skills,
        sourceFile,
        startLine: current.startLine,
        endLine: i + 1,
      })
      current = undefined
      continue
    }
    if (OPENER_RE.test(line)) {
      log.warn("[mandatory-skills] nested sentinel opener", {
        path: sourceFile,
        openerLine: current.startLine,
        nestedAt: i + 1,
      })
      blocks.push({
        skills: current.skills,
        sourceFile,
        startLine: current.startLine,
        endLine: null,
      })
      current = { startLine: i + 1, skills: [] }
      continue
    }
    const match = BULLET_RE.exec(line)
    if (!match) continue
    const name = normalizeBullet(match[1])
    if (!name) continue
    current.skills.push(name)
  }
  if (current) {
    log.warn("[mandatory-skills] unclosed sentinel block", {
      path: sourceFile,
      openerLine: current.startLine,
    })
    blocks.push({
      skills: current.skills,
      sourceFile,
      startLine: current.startLine,
      endLine: null,
    })
  }
  return blocks
}

export function parseMandatorySkills(text: string, sourceFile = "<inline>"): string[] {
  const blocks = parseMandatorySkillsBlocks(text, sourceFile)
  const seen = new Set<string>()
  const out: string[] = []
  for (const block of blocks) {
    for (const skill of block.skills) {
      if (seen.has(skill)) continue
      seen.add(skill)
      out.push(skill)
    }
  }
  return out
}

async function readFileSafe(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  return file.text()
}

async function resolveAgentsMdSources(): Promise<
  Array<{ source: MandatorySource; path: string; text: string }>
> {
  const results: Array<{ source: MandatorySource; path: string; text: string }> = []
  const projectPath = path.join(Instance.directory, "AGENTS.md")
  const projectText = await readFileSafe(projectPath)
  if (projectText !== null) {
    results.push({ source: "agents_md_project", path: projectPath, text: projectText })
  }
  const globalPath = path.join(Global.Path.config, "AGENTS.md")
  const globalText = await readFileSafe(globalPath)
  if (globalText !== null) {
    results.push({ source: "agents_md_global", path: globalPath, text: globalText })
  }
  return results
}

async function resolveCodingTxtSource(): Promise<
  { source: MandatorySource; path: string; text: string } | undefined
> {
  const codingTxtPath = path.join(Instance.directory, "packages/opencode/src/agent/prompt/coding.txt")
  const text = await readFileSafe(codingTxtPath)
  if (text === null) return undefined
  return { source: "coding_txt", path: codingTxtPath, text }
}

export type MandatorySourceText = {
  source: MandatorySource
  path: string
  text: string
}

/**
 * Pure-function core of resolveMandatoryList. Given source texts in priority
 * order (first wins on dedup ordering), produce the merged skill list.
 * Exported for unit testing without touching the filesystem.
 */
export function mergeMandatorySources(sources: MandatorySourceText[]): ResolveResult {
  const bySkill: Record<string, MandatorySource[]> = {}
  const order: string[] = []
  for (const src of sources) {
    const names = parseMandatorySkills(src.text, src.path)
    for (const name of names) {
      if (!bySkill[name]) {
        bySkill[name] = []
        order.push(name)
      }
      if (!bySkill[name].includes(src.source)) {
        bySkill[name].push(src.source)
      }
    }
  }
  return { list: order, bySkill }
}

export async function resolveMandatoryList(input: ResolveInput): Promise<ResolveResult> {
  if (input.isSubagent) {
    if (input.agent.name !== "coding") {
      return { list: [], bySkill: {} }
    }
    const coding = await resolveCodingTxtSource()
    if (!coding) {
      log.warn("[mandatory-skills] coding.txt not found for coding subagent", {
        sessionID: input.sessionID,
      })
      return { list: [], bySkill: {} }
    }
    return mergeMandatorySources([coding])
  }

  const sources = await resolveAgentsMdSources()
  return mergeMandatorySources(sources)
}

function keepRuleFor(source: MandatorySource): string {
  return source === "coding_txt" ? KEEP_RULE_CODING : KEEP_RULE_AGENTS
}

async function appendEventSafe(input: {
  sessionID: string
  level: "info" | "warn"
  domain: "workflow" | "anomaly"
  eventType: string
  anomalyFlags?: string[]
  payload: Record<string, unknown>
}) {
  try {
    await RuntimeEventService.append({
      sessionID: input.sessionID,
      level: input.level,
      domain: input.domain,
      eventType: input.eventType,
      anomalyFlags: input.anomalyFlags ?? [],
      payload: input.payload as any,
    })
  } catch (err) {
    log.warn("[mandatory-skills] failed to append event", {
      sessionID: input.sessionID,
      eventType: input.eventType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function preloadMandatorySkills(input: {
  sessionID: string
  list: string[]
  bySkill: Record<string, MandatorySource[]>
}): Promise<PreloadOutcome[]> {
  const outcomes: PreloadOutcome[] = []
  for (const name of input.list) {
    const sources = input.bySkill[name] ?? []
    const primarySource: MandatorySource = sources[0] ?? "agents_md_project"
    try {
      const skill = await Skill.get(name)
      if (!skill) {
        const searchedPaths = await Skill.dirs().catch(() => [] as string[])
        log.warn("[mandatory-skills] skill file missing", {
          sessionID: input.sessionID,
          skill: name,
          source: primarySource,
          searchedPaths,
        })
        await appendEventSafe({
          sessionID: input.sessionID,
          level: "warn",
          domain: "anomaly",
          eventType: "skill.mandatory_missing",
          anomalyFlags: ["mandatory_skill_missing"],
          payload: { skill: name, source: primarySource, searchedPaths },
        })
        outcomes.push({ skill: name, source: primarySource, status: "missing" })
        continue
      }

      const existing = SkillLayerRegistry.peek(input.sessionID, name)
      if (existing?.pinned && existing.content === skill.content.trim()) {
        outcomes.push({
          skill: name,
          source: primarySource,
          status: "already_pinned",
          skillMdPath: skill.location,
        })
        continue
      }

      SkillLayerRegistry.recordLoaded(input.sessionID, name, {
        content: skill.content.trim(),
        purpose: `mandatory:${primarySource}`,
        keepRules: [keepRuleFor(primarySource)],
      })
      SkillLayerRegistry.pin(input.sessionID, name)

      log.info("[mandatory-skills] preloaded skill", {
        sessionID: input.sessionID,
        skill: name,
        source: primarySource,
        skillMdPath: skill.location,
        bytes: skill.content.length,
      })
      await appendEventSafe({
        sessionID: input.sessionID,
        level: "info",
        domain: "workflow",
        eventType: "skill.mandatory_preloaded",
        payload: { skill: name, source: primarySource, skillMdPath: skill.location },
      })
      outcomes.push({
        skill: name,
        source: primarySource,
        status: "preloaded",
        skillMdPath: skill.location,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error("[mandatory-skills] preload threw", {
        sessionID: input.sessionID,
        skill: name,
        error: message,
      })
      await appendEventSafe({
        sessionID: input.sessionID,
        level: "warn",
        domain: "anomaly",
        eventType: "skill.mandatory_read_error",
        anomalyFlags: ["mandatory_skill_read_error"],
        payload: { skill: name, source: primarySource, error: message },
      })
      outcomes.push({
        skill: name,
        source: primarySource,
        status: "error",
        error: message,
      })
    }
  }
  return outcomes
}

export async function reconcileMandatoryList(input: {
  sessionID: string
  desired: string[]
}): Promise<{ unpinned: string[] }> {
  const desiredSet = new Set(input.desired)
  const entries = SkillLayerRegistry.list(input.sessionID)
  const unpinned: string[] = []
  for (const entry of entries) {
    if (!entry.pinned) continue
    const isMandatory = entry.keepRules.some(
      (rule) => rule === KEEP_RULE_AGENTS || rule === KEEP_RULE_CODING,
    )
    if (!isMandatory) continue
    if (desiredSet.has(entry.name)) continue
    SkillLayerRegistry.unpin(input.sessionID, entry.name)
    unpinned.push(entry.name)
    log.info("[mandatory-skills] unpinned on removal", {
      sessionID: input.sessionID,
      skill: entry.name,
      reason: "removed_from_list",
    })
    await appendEventSafe({
      sessionID: input.sessionID,
      level: "info",
      domain: "workflow",
      eventType: "skill.mandatory_unpinned",
      payload: { skill: entry.name, reason: "removed_from_list" },
    })
  }
  return { unpinned }
}

export const KEEP_RULES = {
  AGENTS_MD: KEEP_RULE_AGENTS,
  CODING_TXT: KEEP_RULE_CODING,
} as const
