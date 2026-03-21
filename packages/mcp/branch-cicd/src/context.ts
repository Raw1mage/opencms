import path from "node:path"
import { access } from "node:fs/promises"
import { git, gitStdout, pathExists } from "./project-policy.js"

export type QuestionOption = {
  id: string
  label: string
  description: string
  value?: string
}

export type QuestionContract = {
  requiresOrchestratorQuestion: true
  kind: "select" | "confirm"
  questionKey: string
  prompt: string
  detail: string
  options: QuestionOption[]
}

export type Blocker = {
  status: "blocked"
  reason:
    | "ambiguous_repo_root"
    | "ambiguous_base_branch"
    | "ambiguous_beta_path"
    | "ambiguous_runtime_policy"
    | "ambiguous_merge_target"
    | "dirty_worktree"
    | "path_conflict"
    | "missing_context"
    | "git_error"
  message: string
  details?: Record<string, unknown>
}

export type QuestionResult = {
  status: "needs_question"
  reason: Blocker["reason"]
  message: string
  question: QuestionContract
  details?: Record<string, unknown>
}

export type Resolution<T> = { status: "ok"; value: T } | Blocker | QuestionResult

export type RuntimePolicy =
  | {
      kind: "webctl"
      label: string
      startCommand: string[]
      refreshCommand: string[]
    }
  | {
      kind: "custom"
      label: string
      startCommand: string[]
      refreshCommand?: string[]
    }
  | {
      kind: "manual"
      label: string
    }

export type ResolvedContext = {
  repoRoot: string
  repoName: string
  mainWorktreePath: string
  currentBranch: string
  baseBranch: string
  betaRoot: string
  runtimePolicy: RuntimePolicy
}

export type ResolveContextInput = {
  repoRoot?: string
  mainWorktreePath?: string
  baseBranch?: string
  betaRoot?: string
  runtimePolicy?: {
    kind: "custom" | "manual"
    startCommand?: string[]
    refreshCommand?: string[]
    label?: string
  }
}

function normalizeAbsolute(input: string) {
  return path.resolve(input)
}

function question(
  reason: Blocker["reason"],
  message: string,
  questionData: QuestionContract,
  details?: Record<string, unknown>,
): QuestionResult {
  return {
    status: "needs_question",
    reason,
    message,
    question: questionData,
    details,
  }
}

function blocker(reason: Blocker["reason"], message: string, details?: Record<string, unknown>): Blocker {
  return { status: "blocked", reason, message, details }
}

async function resolveRepoRoot(
  input: ResolveContextInput,
): Promise<Resolution<{ repoRoot: string; mainWorktreePath: string }>> {
  const mainWorktreePath = normalizeAbsolute(input.mainWorktreePath ?? input.repoRoot ?? process.cwd())
  const repoCandidates = new Set<string>()

  if (input.repoRoot) repoCandidates.add(normalizeAbsolute(input.repoRoot))

  try {
    repoCandidates.add((await gitStdout(["-C", mainWorktreePath, "rev-parse", "--show-toplevel"])).trim())
  } catch (error) {
    return blocker("ambiguous_repo_root", "Unable to resolve git repo root from main worktree path.", {
      mainWorktreePath,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (repoCandidates.size !== 1) {
    return question(
      "ambiguous_repo_root",
      "Repo root is ambiguous.",
      {
        requiresOrchestratorQuestion: true,
        kind: "select",
        questionKey: "beta-tool.repo-root",
        prompt: "Select the canonical repo root before beta-tool mutates git state.",
        detail: "beta-tool refuses to guess between conflicting repo roots.",
        options: [...repoCandidates].map((candidate, index) => ({
          id: `repo-${index + 1}`,
          label: candidate,
          description: "Use this path as the canonical repository root.",
          value: candidate,
        })),
      },
      { candidates: [...repoCandidates], mainWorktreePath },
    )
  }

  const repoRoot = [...repoCandidates][0]
  return { status: "ok", value: { repoRoot, mainWorktreePath } }
}

async function resolveCurrentBranch(repoRoot: string) {
  const branch = (await gitStdout(["-C", repoRoot, "branch", "--show-current"])).trim()
  if (!branch) {
    return blocker(
      "ambiguous_base_branch",
      "Current repo branch is detached or empty; explicit base branch is required.",
      {
        repoRoot,
      },
    )
  }
  return { status: "ok", value: branch } as const
}

async function resolveBaseBranch(repoRoot: string, explicitBaseBranch?: string): Promise<Resolution<string>> {
  if (explicitBaseBranch) return { status: "ok", value: explicitBaseBranch }

  const current = await resolveCurrentBranch(repoRoot)
  if (current.status !== "ok") return current
  return { status: "ok", value: current.value }
}

async function resolveBetaRoot(repoRoot: string, explicitBetaRoot?: string): Promise<Resolution<string>> {
  if (explicitBetaRoot) return { status: "ok", value: normalizeAbsolute(explicitBetaRoot) }
  const repoName = path.basename(repoRoot)
  const candidate = path.join(path.dirname(repoRoot), ".beta-worktrees", repoName)
  return { status: "ok", value: candidate }
}

async function hasWebctl(repoRoot: string) {
  try {
    await access(path.join(repoRoot, "webctl.sh"))
    return true
  } catch {
    return false
  }
}

async function resolveRuntimePolicy(
  repoRoot: string,
  explicit?: ResolveContextInput["runtimePolicy"],
): Promise<Resolution<RuntimePolicy>> {
  if (explicit?.kind === "manual") {
    return { status: "ok", value: { kind: "manual", label: explicit.label ?? "manual" } }
  }
  if (explicit?.kind === "custom") {
    if (!explicit.startCommand?.length) {
      return blocker("ambiguous_runtime_policy", "Custom runtime policy requires startCommand.")
    }
    return {
      status: "ok",
      value: {
        kind: "custom",
        label: explicit.label ?? "custom",
        startCommand: explicit.startCommand,
        refreshCommand: explicit.refreshCommand,
      },
    }
  }

  if (await hasWebctl(repoRoot)) {
    return {
      status: "ok",
      value: {
        kind: "webctl",
        label: "webctl.sh",
        startCommand: ["./webctl.sh", "dev-start"],
        refreshCommand: ["./webctl.sh", "dev-refresh"],
      },
    }
  }

  return question(
    "ambiguous_runtime_policy",
    "Runtime policy cannot be inferred safely for this project.",
    {
      requiresOrchestratorQuestion: true,
      kind: "select",
      questionKey: "beta-tool.runtime-policy",
      prompt: "Select the runtime policy beta-tool should use.",
      detail:
        "Direct MCP question invocation is not available here, so the orchestrator must ask and re-call the tool with the selected policy.",
      options: [
        {
          id: "manual",
          label: "manual",
          description: "Do not execute runtime commands; only return git/worktree state.",
          value: "manual",
        },
        {
          id: "custom",
          label: "custom",
          description: "Provide explicit startCommand/refreshCommand on the next call.",
          value: "custom",
        },
      ],
    },
    { repoRoot },
  )
}

export async function ensurePathUsable(targetPath: string): Promise<Resolution<{ path: string; exists: boolean }>> {
  const exists = await pathExists(targetPath)
  if (!exists) return { status: "ok", value: { path: targetPath, exists: false } }

  try {
    const gitDir = (await gitStdout(["-C", targetPath, "rev-parse", "--git-dir"])).trim()
    return { status: "ok", value: { path: targetPath, exists: Boolean(gitDir) } }
  } catch {
    return blocker("path_conflict", "Beta path already exists and is not a git worktree.", { path: targetPath })
  }
}

export async function resolveProjectContext(input: ResolveContextInput): Promise<Resolution<ResolvedContext>> {
  const repo = await resolveRepoRoot(input)
  if (repo.status !== "ok") return repo

  const repoName = path.basename(repo.value.repoRoot)
  const branch = await resolveCurrentBranch(repo.value.repoRoot)
  if (branch.status !== "ok") return branch

  const baseBranch = await resolveBaseBranch(repo.value.repoRoot, input.baseBranch)
  if (baseBranch.status !== "ok") return baseBranch

  const betaRoot = await resolveBetaRoot(repo.value.repoRoot, input.betaRoot)
  if (betaRoot.status !== "ok") return betaRoot

  const runtimePolicy = await resolveRuntimePolicy(repo.value.repoRoot, input.runtimePolicy)
  if (runtimePolicy.status !== "ok") return runtimePolicy

  return {
    status: "ok",
    value: {
      repoRoot: repo.value.repoRoot,
      repoName,
      mainWorktreePath: repo.value.mainWorktreePath,
      currentBranch: branch.value,
      baseBranch: baseBranch.value,
      betaRoot: betaRoot.value,
      runtimePolicy: runtimePolicy.value,
    },
  }
}
