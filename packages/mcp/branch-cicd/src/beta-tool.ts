import path from "node:path"
import type { ResolvedContext, Resolution } from "./context.js"
import { ensurePathUsable, resolveProjectContext } from "./context.js"
import {
  branchExists,
  ensureCleanWorktree,
  executeRuntimePolicy,
  getWorktreeList,
  git,
  gitStdout,
  listLoops,
  loadLoop,
  removeLoop,
  saveLoop,
  sameGitCommonDir,
} from "./project-policy.js"

export type ToolEnvelope = {
  tool: "newbeta" | "syncback" | "merge"
  status: "ok" | "blocked" | "needs_question" | "needs_confirmation"
  message: string
  data?: Record<string, unknown>
  question?: Record<string, unknown>
}

export type NewBetaInput = {
  repoRoot?: string
  mainWorktreePath?: string
  baseBranch?: string
  betaRoot?: string
  branchName?: string
  taskHint?: string
  runtimePolicy?: {
    kind: "custom" | "manual"
    startCommand?: string[]
    refreshCommand?: string[]
    label?: string
  }
}

export type SyncBackInput = {
  repoRoot?: string
  mainWorktreePath?: string
  branchName?: string
  runtimeMode?: "start" | "refresh"
  executeRuntime?: boolean
  baseBranch?: string
  betaRoot?: string
  runtimePolicy?: NewBetaInput["runtimePolicy"]
}

export type MergeInput = {
  repoRoot?: string
  mainWorktreePath?: string
  branchName?: string
  mergeTarget?: string
  confirm?: boolean
  cleanup?: {
    removeWorktree?: boolean
    deleteBranch?: boolean
  }
  baseBranch?: string
  betaRoot?: string
  runtimePolicy?: NewBetaInput["runtimePolicy"]
}

function toEnvelope(tool: ToolEnvelope["tool"], result: Resolution<ResolvedContext>): ToolEnvelope | null {
  if (result.status === "ok") return null
  if (result.status === "blocked") {
    return { tool, status: "blocked", message: result.message, data: result.details }
  }
  return {
    tool,
    status: "needs_question",
    message: result.message,
    data: result.details,
    question: result.question,
  }
}

function slugifyBranchHint(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function branchQuestion(taskHint?: string): ToolEnvelope {
  const slug = slugifyBranchHint(taskHint ?? "change") || "change"
  return {
    tool: "newbeta",
    status: "needs_question",
    message: "Branch name is required or must be selected explicitly.",
    question: {
      requiresOrchestratorQuestion: true,
      kind: "select",
      questionKey: "beta-tool.branch-name",
      prompt: "Select the feature branch name for the beta loop.",
      detail: "beta-tool refuses to create a branch when more than one naming style is plausible.",
      options: [
        { id: "feature", label: `feature/${slug}`, description: "Feature branch", value: `feature/${slug}` },
        { id: "fix", label: `fix/${slug}`, description: "Bugfix branch", value: `fix/${slug}` },
        { id: "chore", label: `chore/${slug}`, description: "Chore branch", value: `chore/${slug}` },
      ],
    },
    data: { taskHint },
  }
}

async function resolveLoopContext(
  tool: ToolEnvelope["tool"],
  input: {
    repoRoot?: string
    mainWorktreePath?: string
    baseBranch?: string
    betaRoot?: string
    runtimePolicy?: NewBetaInput["runtimePolicy"]
  },
) {
  const context = await resolveProjectContext(input)
  return { context, envelope: toEnvelope(tool, context) }
}

async function resolveStoredLoop(tool: ToolEnvelope["tool"], repoRoot: string, branchName?: string) {
  if (branchName) {
    const loop = await loadLoop(repoRoot, branchName)
    return { loop, envelope: null as ToolEnvelope | null }
  }

  const loops = await listLoops(repoRoot)
  if (loops.length === 0) {
    return { loop: undefined, envelope: null as ToolEnvelope | null }
  }
  if (loops.length === 1) {
    return { loop: loops[0], envelope: null as ToolEnvelope | null }
  }

  return {
    loop: undefined,
    envelope: {
      tool,
      status: "needs_question",
      message: "Multiple stored beta loops exist; branch selection is required.",
      question: {
        requiresOrchestratorQuestion: true,
        kind: "select",
        questionKey: `beta-tool.${tool}.branch`,
        prompt: "Select the feature branch to continue.",
        detail: "beta-tool refuses to guess among multiple stored loops for the same repo.",
        options: loops.map((loop) => ({
          id: loop.branchName,
          label: loop.branchName,
          description: `beta: ${loop.betaPath}`,
          value: loop.branchName,
        })),
      },
      data: { repoRoot, branches: loops.map((loop) => loop.branchName) },
    } satisfies ToolEnvelope,
  }
}

export async function runNewBeta(input: NewBetaInput): Promise<ToolEnvelope> {
  const { context, envelope } = await resolveLoopContext("newbeta", input)
  if (envelope || context.status !== "ok") return envelope!

  if (!input.branchName) return branchQuestion(input.taskHint)

  const clean = await ensureCleanWorktree(context.value.repoRoot)
  if (clean.status !== "ok") {
    return { tool: "newbeta", status: "blocked", message: clean.message, data: clean.details }
  }

  const betaPath = path.join(context.value.betaRoot, input.branchName)
  const pathCheck = await ensurePathUsable(betaPath)
  if (pathCheck.status !== "ok") {
    return { tool: "newbeta", status: "blocked", message: pathCheck.message, data: pathCheck.details }
  }
  if (pathCheck.value.exists) {
    const sameRepo = await sameGitCommonDir(context.value.repoRoot, betaPath).catch(() => false)
    if (!sameRepo) {
      return {
        tool: "newbeta",
        status: "blocked",
        message: "Beta path exists but belongs to a different git repository/worktree set.",
        data: { repoRoot: context.value.repoRoot, betaPath },
      }
    }
  }

  const worktrees = await getWorktreeList(context.value.repoRoot)
  const existingWorktree = worktrees.find(
    (entry) => path.resolve(entry.path) === betaPath || entry.branch === input.branchName,
  )

  if (!(await branchExists(context.value.repoRoot, input.branchName))) {
    await git(["-C", context.value.repoRoot, "branch", input.branchName, context.value.baseBranch])
  }

  if (!existingWorktree) {
    await git(["-C", context.value.repoRoot, "worktree", "add", betaPath, input.branchName])
  } else if (path.resolve(existingWorktree.path) !== betaPath) {
    return {
      tool: "newbeta",
      status: "blocked",
      message: "Feature branch already has a different worktree path; refusing implicit remap.",
      data: { branchName: input.branchName, existingPath: existingWorktree.path, requestedBetaPath: betaPath },
    }
  }

  await saveLoop({
    repoRoot: context.value.repoRoot,
    mainWorktreePath: context.value.mainWorktreePath,
    betaPath,
    branchName: input.branchName,
    baseBranch: context.value.baseBranch,
    runtimePolicy: context.value.runtimePolicy,
    updatedAt: new Date().toISOString(),
  })

  return {
    tool: "newbeta",
    status: "ok",
    message: existingWorktree ? "Reused existing beta loop." : "Created beta loop.",
    data: {
      repoRoot: context.value.repoRoot,
      mainWorktreePath: context.value.mainWorktreePath,
      betaPath,
      branchName: input.branchName,
      baseBranch: context.value.baseBranch,
      runtimePolicy: context.value.runtimePolicy,
    },
  }
}

export async function runSyncBack(input: SyncBackInput): Promise<ToolEnvelope> {
  const { context, envelope } = await resolveLoopContext("syncback", input)
  if (envelope || context.status !== "ok") return envelope!

  const stored = await resolveStoredLoop("syncback", context.value.repoRoot, input.branchName)
  if (stored.envelope) return stored.envelope
  const loop = stored.loop
  const branchName = input.branchName ?? loop?.branchName
  if (!branchName) {
    return {
      tool: "syncback",
      status: "blocked",
      message: "Branch name is required for syncback when no stored loop exists.",
      data: { repoRoot: context.value.repoRoot },
    }
  }

  const clean = await ensureCleanWorktree(context.value.repoRoot)
  if (clean.status !== "ok") {
    return { tool: "syncback", status: "blocked", message: clean.message, data: clean.details }
  }

  if (!(await branchExists(context.value.repoRoot, branchName))) {
    return {
      tool: "syncback",
      status: "blocked",
      message: "Feature branch does not exist locally.",
      data: { repoRoot: context.value.repoRoot, branchName },
    }
  }

  await git(["-C", context.value.repoRoot, "checkout", "--ignore-other-worktrees", branchName])
  const runtimePolicy = loop?.runtimePolicy ?? context.value.runtimePolicy
  const runtimeMode = input.runtimeMode ?? "refresh"
  const runtimeCommand =
    runtimePolicy.kind === "manual"
      ? []
      : runtimeMode === "refresh"
        ? (runtimePolicy.refreshCommand ?? runtimePolicy.startCommand)
        : runtimePolicy.startCommand

  let runtimeResult: Record<string, unknown> | undefined
  if (input.executeRuntime) {
    const executed = await executeRuntimePolicy(runtimePolicy, context.value.repoRoot, runtimeMode)
    runtimeResult = executed
  }

  return {
    tool: "syncback",
    status: "ok",
    message: input.executeRuntime ? "Main worktree synced and runtime executed." : "Main worktree synced.",
    data: {
      repoRoot: context.value.repoRoot,
      mainWorktreePath: context.value.mainWorktreePath,
      betaPath: loop?.betaPath,
      branchName,
      checkedOutBranch: (await gitStdout(["-C", context.value.repoRoot, "branch", "--show-current"])).trim(),
      runtimePolicy,
      runtimeCommand,
      runtimeResult,
    },
  }
}

export async function runMerge(input: MergeInput): Promise<ToolEnvelope> {
  const { context, envelope } = await resolveLoopContext("merge", input)
  if (envelope || context.status !== "ok") return envelope!

  const stored = await resolveStoredLoop("merge", context.value.repoRoot, input.branchName)
  if (stored.envelope) return stored.envelope
  const loop = stored.loop
  const branchName = input.branchName ?? loop?.branchName
  if (!branchName) {
    return {
      tool: "merge",
      status: "blocked",
      message: "Branch name is required for merge when no stored loop exists.",
      data: { repoRoot: context.value.repoRoot },
    }
  }

  const mergeTarget = input.mergeTarget ?? loop?.baseBranch ?? input.baseBranch
  if (!mergeTarget) {
    return {
      tool: "merge",
      status: "needs_question",
      message: "Merge target is ambiguous.",
      question: {
        requiresOrchestratorQuestion: true,
        kind: "select",
        questionKey: "beta-tool.merge-target",
        prompt: "Select the authoritative merge target branch.",
        detail: "beta-tool refuses to merge without an explicit target branch.",
        options: [
          {
            id: "current",
            label: context.value.currentBranch,
            description: "Current branch",
            value: context.value.currentBranch,
          },
          {
            id: "base",
            label: context.value.baseBranch,
            description: "Resolved base branch",
            value: context.value.baseBranch,
          },
        ],
      },
      data: { branchName, repoRoot: context.value.repoRoot },
    }
  }

  const cleanup = {
    removeWorktree: input.cleanup?.removeWorktree ?? false,
    deleteBranch: input.cleanup?.deleteBranch ?? false,
  }

  if (!input.confirm) {
    return {
      tool: "merge",
      status: "needs_confirmation",
      message: "Merge is destructive and requires explicit confirmation.",
      question: {
        requiresOrchestratorQuestion: true,
        kind: "confirm",
        questionKey: "beta-tool.merge-confirm",
        prompt: `Confirm merge of ${branchName} into ${mergeTarget}.`,
        detail: "If confirmed, beta-tool will re-check dirty state before merging and optional cleanup.",
        options: [
          { id: "confirm", label: "confirm", description: "Proceed with merge and requested cleanup.", value: "true" },
          { id: "cancel", label: "cancel", description: "Abort; make no changes.", value: "false" },
        ],
      },
      data: { repoRoot: context.value.repoRoot, branchName, mergeTarget, cleanup },
    }
  }

  const cleanMain = await ensureCleanWorktree(context.value.repoRoot)
  if (cleanMain.status !== "ok") {
    return { tool: "merge", status: "blocked", message: cleanMain.message, data: cleanMain.details }
  }

  if (!(await branchExists(context.value.repoRoot, branchName))) {
    return {
      tool: "merge",
      status: "blocked",
      message: "Feature branch does not exist locally.",
      data: { repoRoot: context.value.repoRoot, branchName },
    }
  }

  await git(["-C", context.value.repoRoot, "checkout", mergeTarget])
  await git(["-C", context.value.repoRoot, "merge", "--no-ff", branchName])

  const steps: string[] = [`merged ${branchName} into ${mergeTarget}`]

  if (cleanup.removeWorktree && loop?.betaPath) {
    try {
      const betaStatus = (await gitStdout(["-C", loop.betaPath, "status", "--porcelain"])).trim()
      if (betaStatus) {
        return {
          tool: "merge",
          status: "blocked",
          message: "Beta worktree is dirty; refusing cleanup after merge.",
          data: { betaPath: loop.betaPath, status: betaStatus, mergeTarget, branchName },
        }
      }
    } catch (error) {
      return {
        tool: "merge",
        status: "blocked",
        message: "Failed to inspect beta worktree before cleanup.",
        data: { betaPath: loop.betaPath, error: error instanceof Error ? error.message : String(error) },
      }
    }
    await git(["-C", context.value.repoRoot, "worktree", "remove", loop.betaPath])
    steps.push(`removed worktree ${loop.betaPath}`)
  }

  if (cleanup.deleteBranch) {
    await git(["-C", context.value.repoRoot, "branch", "-d", branchName])
    steps.push(`deleted branch ${branchName}`)
  }

  if (cleanup.removeWorktree || cleanup.deleteBranch) {
    await removeLoop(context.value.repoRoot, branchName)
  }

  return {
    tool: "merge",
    status: "ok",
    message: "Merge completed.",
    data: {
      repoRoot: context.value.repoRoot,
      branchName,
      mergeTarget,
      cleanup,
      steps,
    },
  }
}
