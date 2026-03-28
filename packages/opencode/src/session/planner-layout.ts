import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"

const DEFAULT_PARENT_TITLE_PREFIX = "new-session-"
const DEFAULT_CHILD_TITLE_PREFIX = "child-session-"

type PlannerInput = {
  slug: string
  title?: string
  time: { created: number }
}

function datePrefix(timestamp: number) {
  const date = new Date(timestamp)
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0")
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0")
  const dd = date.getUTCDate().toString().padStart(2, "0")
  return `${yyyy}${mm}${dd}`
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function isGenericSessionTitle(input: string) {
  const normalized = slugify(input)
  return normalized.startsWith(DEFAULT_PARENT_TITLE_PREFIX) || normalized.startsWith(DEFAULT_CHILD_TITLE_PREFIX)
}

function titleSegment(input: PlannerInput) {
  const fromTitle = input.title ? slugify(input.title) : ""
  if (fromTitle && !isGenericSessionTitle(fromTitle)) return fromTitle.slice(0, 80)

  const fromSlug = slugify(input.slug)
  if (!fromSlug) {
    throw new Error("planner root slug derivation requires a non-empty session slug")
  }

  const sessionSlugPattern = /^ses-[a-z0-9]+$/
  if (sessionSlugPattern.test(fromSlug)) {
    throw new Error("planner root slug derivation requires a topic-aligned title before plan_enter")
  }

  return fromSlug.slice(0, 80)
}

export function plannerRootName(input: PlannerInput) {
  return `${datePrefix(input.time.created)}_${titleSegment(input)}`
}

export function plannerRoot(input: PlannerInput) {
  const rootName = plannerRootName(input)
  return Instance.project.vcs
    ? path.join(Instance.worktree, "plans", rootName)
    : path.join(Global.Path.data, "plans", rootName)
}

export function plannerArtifacts(input: PlannerInput) {
  const root = plannerRoot(input)
  return {
    root,
    implementationSpec: path.join(root, "implementation-spec.md"),
    proposal: path.join(root, "proposal.md"),
    spec: path.join(root, "spec.md"),
    design: path.join(root, "design.md"),
    tasks: path.join(root, "tasks.md"),
    handoff: path.join(root, "handoff.md"),
    idef0: path.join(root, "idef0.json"),
    grafcet: path.join(root, "grafcet.json"),
    c4: path.join(root, "c4.json"),
    sequence: path.join(root, "sequence.json"),
  }
}
