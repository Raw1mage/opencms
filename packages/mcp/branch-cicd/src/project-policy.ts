import { spawn } from "node:child_process"
import type { Buffer } from "node:buffer"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RuntimePolicy } from "./context.js"

export type CommandResult = {
  command: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
}

export async function pathExists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

export async function execCommand(command: string[], cwd: string): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode: number | null) => {
      resolve({ command, cwd, exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

export async function git(args: string[], cwd?: string) {
  const result = await execCommand(["git", ...args], cwd ?? process.cwd())
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`)
  }
  return result
}

export async function gitStdout(args: string[], cwd?: string) {
  const result = await git(args, cwd)
  return result.stdout
}

export async function ensureDir(targetPath: string) {
  await mkdir(targetPath, { recursive: true })
}

const HOME = process.env.HOME ?? os.homedir()
const XDG_STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(HOME, ".local", "state")
const STORE_DIR = path.join(XDG_STATE_HOME, "opencode", "beta-tool")
const STORE_PATH = path.join(STORE_DIR, "loops.json")

export type LoopRecord = {
  repoRoot: string
  mainWorktreePath: string
  betaPath: string
  branchName: string
  baseBranch: string
  runtimePolicy: RuntimePolicy
  updatedAt: string
}

type LoopStore = { loops: LoopRecord[] }

async function readStore(): Promise<LoopStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    return JSON.parse(raw) as LoopStore
  } catch {
    return { loops: [] }
  }
}

async function writeStore(data: LoopStore) {
  await ensureDir(STORE_DIR)
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2), "utf8")
}

export async function loadLoop(repoRoot: string, branchName?: string) {
  const data = await readStore()
  return data.loops.find((loop) => loop.repoRoot === repoRoot && (!branchName || loop.branchName === branchName))
}

export async function listLoops(repoRoot: string) {
  const data = await readStore()
  return data.loops.filter((loop) => loop.repoRoot === repoRoot)
}

export async function saveLoop(loop: LoopRecord) {
  const data = await readStore()
  const next = data.loops.filter((item) => !(item.repoRoot === loop.repoRoot && item.branchName === loop.branchName))
  next.push(loop)
  await writeStore({ loops: next })
}

export async function removeLoop(repoRoot: string, branchName: string) {
  const data = await readStore()
  await writeStore({
    loops: data.loops.filter((item) => !(item.repoRoot === repoRoot && item.branchName === branchName)),
  })
}

export async function gitStatusPorcelain(repoRoot: string) {
  return (await gitStdout(["-C", repoRoot, "status", "--porcelain"])).trim()
}

export async function ensureCleanWorktree(repoRoot: string) {
  const status = await gitStatusPorcelain(repoRoot)
  if (status) {
    return {
      status: "blocked" as const,
      reason: "dirty_worktree" as const,
      message: "Git worktree is dirty; refusing unsafe branch/worktree transition.",
      details: { repoRoot, status },
    }
  }
  return { status: "ok" as const }
}

export async function branchExists(repoRoot: string, branchName: string) {
  const result = await execCommand(
    ["git", "-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    repoRoot,
  )
  return result.exitCode === 0
}

export async function getWorktreeList(repoRoot: string) {
  const stdout = await gitStdout(["-C", repoRoot, "worktree", "list", "--porcelain"])
  const entries: Array<{ path: string; branch?: string; bare?: boolean }> = []
  let current: { path: string; branch?: string; bare?: boolean } | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current)
      current = null
      continue
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = { path: line.slice("worktree ".length) }
      continue
    }
    if (!current) continue
    if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    if (line === "bare") current.bare = true
  }
  if (current) entries.push(current)
  return entries
}

export async function sameGitCommonDir(repoRoot: string, worktreePath: string) {
  const [repoCommonDir, worktreeCommonDir] = await Promise.all([
    gitStdout(["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    gitStdout(["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ])
  return repoCommonDir.trim() === worktreeCommonDir.trim()
}

export async function executeRuntimePolicy(runtimePolicy: RuntimePolicy, cwd: string, mode: "start" | "refresh") {
  if (runtimePolicy.kind === "manual") {
    return {
      command: [] as string[],
      cwd,
      exitCode: 0,
      stdout: "manual runtime policy selected",
      stderr: "",
    }
  }
  const command =
    mode === "refresh" ? (runtimePolicy.refreshCommand ?? runtimePolicy.startCommand) : runtimePolicy.startCommand
  return await execCommand(command, cwd)
}

export async function removePath(targetPath: string) {
  if (await pathExists(targetPath)) {
    await rm(targetPath, { recursive: true, force: true })
  }
}
