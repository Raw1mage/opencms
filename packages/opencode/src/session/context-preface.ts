// Phase B B.2.3 (DD-1, DD-2, DD-4, DD-5 of specs/prompt-cache-and-compaction-hardening).
//
// Builder for the user-role context preface message. Accepts already-resolved
// dynamic content (preload parts, skill registry snapshot, today's date) and
// emits a deterministic ContextPrefaceParts structure plus a wire
// representation suitable for inserting into messages[] before the user's
// first text turn.
//
// Tier order is slow-first (DD-1):
//   T1: README → cwd → pinned skills → today's date  (session-stable)
//   T2: active skills → summarized skills            (decay-tier)
//
// Phase B v2 recalibration 2026-05-04 (R1 mitigation baked in): the preface
// always opens with PREFACE_DIRECTIVE_HEADER so the LLM treats the user-role
// message as instruction-bearing context rather than chitchat. No A/B test
// dependency.

import path from "node:path"
import { promises as fsp } from "node:fs"

import { Log } from "../util/log"

import type { ContextPrefaceParts, PreloadParts, PrefaceContentBlock, SkillContextEntry } from "./context-preface-types"
import { CONTEXT_PREFACE_KIND, PREFACE_DIRECTIVE_HEADER } from "./context-preface-types"

const log = Log.create({ service: "context-preface" })

export interface BuildPrefaceInput {
  preload: PreloadParts
  skills: {
    pinned: SkillContextEntry[]
    active: SkillContextEntry[]
    summarized: SkillContextEntry[]
  }
  todaysDate: string
  /**
   * Per-turn dynamic content that doesn't belong to T1 or T2 — e.g. lazy
   * tool catalog hints, structured-output directives, subagent return
   * notices, processor.ts quota-low wrap-up addenda. Emitted as a third
   * content block with tier="trailing" if non-empty (data-schema.json
   * PrefaceContentBlock). Per-turn cache invalidation is fine here.
   */
  trailingExtras?: string[]
  /**
   * attachment-lifecycle v4 (DD-19/DD-20): pre-resolved inline image content
   * blocks emitted as the LAST entries in the trailing tier (BP4 zone).
   * Caller (llm.ts) is responsible for reading bytes off disk via
   * `buildActiveImageContentBlocks`. Empty / undefined = no images inlined.
   */
  activeImageBlocks?: InlineImageContentBlock[]
}

export type InlineImageContentBlock = Extract<PrefaceContentBlock, { type: "file" }>

export interface ContextPrefaceMessageOutput {
  parts: ContextPrefaceParts
  /** Multi-block content payload for insertion into messages[]. */
  contentBlocks: PrefaceContentBlock[]
  /** Marker matching MessageV2.User.kind (DD-5). */
  kind: typeof CONTEXT_PREFACE_KIND
  /**
   * True when T2 is empty (no active/summary skills). The cache breakpoint
   * allocator (B.5) reads this to know it should omit BP3 rather than
   * relocating it.
   */
  t2Empty: boolean
}

/**
 * Build a context preface from already-resolved dynamic content. Pure
 * function — same input bytes → same output bytes (DD-3 prerequisite for
 * cache hits).
 *
 * Caller is responsible for upstream resolution (calling getPreloadParts,
 * SkillLayerRegistry.listForInjection, environmentParts) and for inserting
 * the resulting message into the outbound `messages[]` array immediately
 * before the user's first text turn (DD-1).
 */
export function buildPreface(input: BuildPrefaceInput): ContextPrefaceMessageOutput {
  const parts: ContextPrefaceParts = {
    t1: {
      readmeSummary: input.preload.readmeSummary,
      cwdListing: input.preload.cwdListing,
      pinnedSkills: input.skills.pinned,
      todaysDate: input.todaysDate,
    },
    t2: {
      activeSkills: input.skills.active,
      summarizedSkills: input.skills.summarized,
    },
  }

  const t1Body = renderT1(parts.t1)
  const t2Body = renderT2(parts.t2)
  const t2Empty = t2Body.length === 0

  const contentBlocks: PrefaceContentBlock[] = [{ type: "text", tier: "t1", text: t1Body }]
  if (!t2Empty) {
    contentBlocks.push({ type: "text", tier: "t2", text: t2Body })
  }
  const trailing = (input.trailingExtras ?? []).filter((s) => s && s.length > 0)
  if (trailing.length > 0) {
    contentBlocks.push({ type: "text", tier: "trailing", text: trailing.join("\n\n") })
  }

  // v4 DD-19: image binary blocks ride at the very end of trailing tier so
  // per-turn churn lands in BP4 zone and never invalidates T1/T2 prefix.
  for (const block of input.activeImageBlocks ?? []) {
    contentBlocks.push(block)
  }

  return { parts, contentBlocks, kind: CONTEXT_PREFACE_KIND, t2Empty }
}

/**
 * attachment-lifecycle v4 (DD-19/DD-20): read inline image bytes off disk
 * for filenames listed in `activeImageRefs`. Returns content blocks ready
 * to pass into `buildPreface(..., {activeImageBlocks})`.
 *
 * Skips silently (with telemetry) when:
 *   - filename has no entry in `refsByFilename`
 *   - referenced file is missing on disk
 *   - referenced file fails to read for any reason
 *
 * Skipping is preferred over throwing because the preface assembly path is
 * latency-critical and a missing image file should not break a turn.
 */
export interface InlineImageRefInput {
  filename: string
  mime: string
  repo_path: string
}

export async function buildActiveImageContentBlocks(
  activeImageRefs: string[],
  refsByFilename: Map<string, InlineImageRefInput>,
  projectRoot: string,
): Promise<InlineImageContentBlock[]> {
  const out: InlineImageContentBlock[] = []
  for (const filename of activeImageRefs) {
    const ref = refsByFilename.get(filename)
    if (!ref) {
      log.warn("inline image ref not found in session parts; skipping", { filename })
      continue
    }
    if (!ref.mime.startsWith("image/")) {
      log.warn("inline image ref has non-image mime; skipping", { filename, mime: ref.mime })
      continue
    }
    if (!ref.repo_path) {
      log.warn("inline image ref missing repo_path; skipping", { filename })
      continue
    }
    const absPath = path.join(projectRoot, ref.repo_path)
    try {
      const bytes = await fsp.readFile(absPath)
      const url = `data:${ref.mime};base64,${bytes.toString("base64")}`
      out.push({ type: "file", tier: "trailing", url, mediaType: ref.mime, filename })
    } catch (err) {
      log.warn("inline image read failed; skipping", {
        filename,
        absPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

/** Render T1 with the directive header always present and date last (DD-2). */
function renderT1(t1: ContextPrefaceParts["t1"]): string {
  const sections: string[] = [PREFACE_DIRECTIVE_HEADER, ""]

  if (t1.readmeSummary) {
    sections.push("<readme_summary>")
    sections.push(t1.readmeSummary)
    sections.push("</readme_summary>")
    sections.push("")
  }

  if (t1.cwdListing) {
    sections.push("<cwd_listing>")
    sections.push(t1.cwdListing)
    sections.push("</cwd_listing>")
    sections.push("")
  }

  if (t1.pinnedSkills.length > 0) {
    sections.push("<pinned_skills>")
    for (const skill of t1.pinnedSkills) {
      sections.push(renderSkill(skill))
    }
    sections.push("</pinned_skills>")
    sections.push("")
  }

  // DD-2: date is always last in T1 so cross-day invalidation only
  // affects what comes after it (T2 segment).
  sections.push(`Today's date: ${t1.todaysDate}`)

  return sections.join("\n")
}

/** Render T2 (active + summarized skills). Returns empty string when both lists are empty. */
function renderT2(t2: ContextPrefaceParts["t2"]): string {
  if (t2.activeSkills.length === 0 && t2.summarizedSkills.length === 0) {
    return ""
  }
  const sections: string[] = []

  if (t2.activeSkills.length > 0) {
    sections.push("<active_skills>")
    for (const skill of t2.activeSkills) {
      sections.push(renderSkill(skill))
    }
    sections.push("</active_skills>")
    sections.push("")
  }

  if (t2.summarizedSkills.length > 0) {
    sections.push("<summarized_skills>")
    for (const skill of t2.summarizedSkills) {
      sections.push(renderSkill(skill))
    }
    sections.push("</summarized_skills>")
  }

  return sections.join("\n").trimEnd()
}

function renderSkill(skill: SkillContextEntry): string {
  return `<skill name="${skill.name}" state="${skill.state}">\n${skill.content}\n</skill>`
}
