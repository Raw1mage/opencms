import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"

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

function titleSegment(input: PlannerInput) {
  const fromTitle = input.title ? slugify(input.title) : ""
  if (fromTitle && !fromTitle.startsWith("new-session")) return fromTitle.slice(0, 80)
  return input.slug
}

export function plannerRootName(input: PlannerInput) {
  return `${datePrefix(input.time.created)}_${titleSegment(input)}`
}

export function plannerRoot(input: PlannerInput) {
  const rootName = plannerRootName(input)
  return Instance.project.vcs
    ? path.join(Instance.worktree, "specs", rootName)
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
