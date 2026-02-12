#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import path from "path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"

const SERVER_NAME = "refacting-merger"
const SERVER_VERSION = "0.1.0"
const CHARACTER_LIMIT = 120_000
const ROOT = process.env["REFACTING_MERGER_ROOT"] || process.cwd()
const PROTECTED_PATHS = [
  "packages/opencode/src/provider/",
  "packages/opencode/src/account/",
  "packages/opencode/src/session/llm.ts",
  "packages/opencode/src/cli/cmd/admin.ts",
  "packages/opencode/src/cli/cmd/tui/",
]

type CommitAnalysis = {
  hash: string
  subject: string
  files: string[]
  risk: "high" | "medium" | "low"
  logicalType: "behavioral-fix" | "feature" | "ux" | "protocol" | "infra" | "docs"
  valueScore: {
    fit: -1 | 0 | 1
    user: -1 | 0 | 1
    ops: -1 | 0 | 1
    risk: -1 | 0 | 1
    total: number
  }
  defaultDecision: "ported" | "integrated" | "skipped"
  reasons: string[]
}

type ProcessedEntry = {
  upstream: string
  status: "ported" | "integrated" | "skipped"
  localCommit?: string
  note: string
}

function truncate(text: string) {
  if (text.length <= CHARACTER_LIMIT) return text
  return `${text.slice(0, CHARACTER_LIMIT)}\n...<truncated ${text.length - CHARACTER_LIMIT} chars>`
}

function normalizePath(input: string) {
  return path.isAbsolute(input) ? input : path.resolve(ROOT, input)
}

async function runGit(args: string[], cwd = ROOT) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

async function git(args: string[], cwd = ROOT) {
  const result = await runGit(args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function parseBacktickHashes(text: string) {
  const regex = /`([0-9a-f]{7,40})`/gi
  const result = new Set<string>()
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text))) {
    const hash = match[1]
    if (hash) result.add(hash)
  }
  return result
}

function isProcessedHash(hash: string, processed: Set<string>) {
  for (const p of processed) {
    if (hash.startsWith(p) || p.startsWith(hash)) return true
  }
  return false
}

function classifyLogicalType(subject: string, files: string[]): CommitAnalysis["logicalType"] {
  const lowerSubject = subject.toLowerCase()
  const filesLower = files.map((x) => x.toLowerCase())
  const allDocs =
    filesLower.length > 0 &&
    filesLower.every((x) => x.includes("/docs/") || x.endsWith(".md") || x.includes("/content/"))
  const allInfra =
    filesLower.length > 0 &&
    filesLower.every(
      (x) =>
        x.startsWith(".github/") || x.startsWith("script/") || x.startsWith("scripts/") || x.includes("/workflows/"),
    )

  if (allDocs || lowerSubject.includes("docs")) return "docs"
  if (allInfra || lowerSubject.includes("ci:") || lowerSubject.includes("workflow") || lowerSubject.includes("chore:"))
    return "infra"
  if (
    lowerSubject.includes("ux") ||
    lowerSubject.includes("dialog") ||
    lowerSubject.includes("hover") ||
    filesLower.some((x) => x.includes("/tui/"))
  ) {
    return "ux"
  }
  if (
    lowerSubject.includes("protocol") ||
    lowerSubject.includes("header") ||
    lowerSubject.includes("oauth") ||
    lowerSubject.includes("auth") ||
    lowerSubject.includes("session.error")
  ) {
    return "protocol"
  }
  if (
    lowerSubject.startsWith("fix") ||
    lowerSubject.includes("defensive") ||
    lowerSubject.includes("regression") ||
    lowerSubject.includes("crash")
  ) {
    return "behavioral-fix"
  }
  return "feature"
}

function hasProtectedPath(files: string[]) {
  return files.some((file) => PROTECTED_PATHS.some((prefix) => file.startsWith(prefix)))
}

function computeRisk(files: string[]): CommitAnalysis["risk"] {
  if (hasProtectedPath(files)) return "high"
  if (files.some((x) => x.startsWith("packages/opencode/src/"))) return "medium"
  return "low"
}

function scoreCommit(
  subject: string,
  files: string[],
  logicalType: CommitAnalysis["logicalType"],
  risk: CommitAnalysis["risk"],
) {
  const lowerSubject = subject.toLowerCase()
  const isRevert = lowerSubject.startsWith("revert")
  const docsOnly =
    files.length > 0 &&
    files.every((x) => x.includes("/docs/") || x.endsWith(".md") || x.startsWith("packages/web/src/content/"))

  let fit: -1 | 0 | 1 = 0
  let user: -1 | 0 | 1 = 0
  let ops: -1 | 0 | 1 = 0

  if (docsOnly) fit = -1
  else if (hasProtectedPath(files)) fit = 0
  else fit = 1

  if (logicalType === "behavioral-fix") user = 1
  else if (logicalType === "feature" || logicalType === "ux" || logicalType === "protocol") user = 0
  else if (logicalType === "docs") user = -1

  if (files.some((x) => x.startsWith("scripts/") || x.startsWith("script/"))) ops = 1
  else if (logicalType === "docs") ops = -1
  else ops = 0

  if (isRevert && hasProtectedPath(files)) {
    fit = -1
    user = 0
    ops = 0
  }

  const riskScore: -1 | 0 | 1 = risk === "high" ? -1 : risk === "medium" ? 0 : 1
  const total = fit + user + ops + riskScore
  return {
    fit,
    user,
    ops,
    risk: riskScore,
    total,
  }
}

function recommendDecision(
  subject: string,
  analysis: Omit<CommitAnalysis, "defaultDecision">,
): CommitAnalysis["defaultDecision"] {
  const lowerSubject = subject.toLowerCase()
  const isRevert = lowerSubject.startsWith("revert")
  const fixesRegression = /fix|security|crash|regression/.test(lowerSubject)

  if (isRevert && !fixesRegression) return "skipped"
  if (analysis.valueScore.total >= 2) return analysis.risk === "high" ? "ported" : "integrated"
  if (analysis.valueScore.total < 0) return "skipped"
  return analysis.risk === "high" ? "ported" : "skipped"
}

async function getChangedFiles(hash: string) {
  const output = await git(["show", "--name-only", "--pretty=format:", hash])
  return output
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
}

async function collectCommitAnalyses(params: {
  sourceRemote: string
  sourceBranch: string
  targetRef: string
  ledgerPath?: string
  includeProcessed?: boolean
}) {
  await git(["fetch", params.sourceRemote, params.sourceBranch])
  const sourceRef = `${params.sourceRemote}/${params.sourceBranch}`
  const raw = await git(["log", "--reverse", "--pretty=format:%H%x1f%s", `${params.targetRef}..${sourceRef}`])

  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const processed = new Set<string>()
  if (params.ledgerPath) {
    try {
      const ledgerText = await readFile(normalizePath(params.ledgerPath), "utf8")
      for (const item of parseBacktickHashes(ledgerText)) processed.add(item)
    } catch {}
  }

  const analyses: CommitAnalysis[] = []
  for (const row of rows) {
    const [hash = "", subject = ""] = row.split("\u001f")
    if (!hash) continue
    if (!params.includeProcessed && isProcessedHash(hash, processed)) continue

    const files = await getChangedFiles(hash)
    const logicalType = classifyLogicalType(subject, files)
    const risk = computeRisk(files)
    const valueScore = scoreCommit(subject, files, logicalType, risk)
    const reasons = [
      `logicalType=${logicalType}`,
      `score=${valueScore.fit}/${valueScore.user}/${valueScore.ops}/${valueScore.risk} => ${valueScore.total}`,
      `risk=${risk}`,
    ]

    const partial: Omit<CommitAnalysis, "defaultDecision"> = {
      hash,
      subject,
      files,
      logicalType,
      risk,
      valueScore,
      reasons,
    }
    analyses.push({
      ...partial,
      defaultDecision: recommendDecision(subject, partial),
    })
  }

  return {
    sourceRef,
    targetRef: params.targetRef,
    totalFromSource: rows.length,
    processedCount: rows.length - analyses.length,
    analyses,
  }
}

function renderPlanMarkdown(input: {
  topic: string
  sourceRef: string
  targetRef: string
  totalFromSource: number
  processedCount: number
  analyses: CommitAnalysis[]
}) {
  const date = new Date().toISOString().slice(0, 10)
  const summaryLines = [
    `# Refactor Plan: ${date} (${input.sourceRef} → ${input.targetRef}, ${input.topic})`,
    "",
    `Date: ${date}`,
    "Status: WAITING_APPROVAL",
    "",
    "## Summary",
    "",
    `- Upstream pending (raw): ${input.totalFromSource} commits`,
    `- Excluded by processed ledger: ${input.processedCount} commits`,
    `- Commits for this round: ${input.analyses.length} commits`,
    "",
    "## Actions",
    "",
    "| Commit | Logical Type | Value Score | Risk | Decision | Notes |",
    "| :----- | :----------- | :---------- | :--- | :------- | :---- |",
  ]

  for (const item of input.analyses) {
    const score = `${item.valueScore.fit}/${item.valueScore.user}/${item.valueScore.ops}/${item.valueScore.risk}=${item.valueScore.total}`
    const notes = item.subject.replace(/\|/g, "\\|")
    summaryLines.push(
      `| \`${item.hash.slice(0, 9)}\` | ${item.logicalType} | ${score} | ${item.risk} | ${item.defaultDecision} | ${notes} |`,
    )
  }

  summaryLines.push(
    "",
    "## Execution Queue",
    "",
    "1. [ ] Confirm high-risk items (ported vs skipped).",
    "2. [ ] Integrate low/medium-risk high-value items.",
    "3. [ ] Update ledger with final status mapping.",
    "",
    "## Mapping to Ledger",
    "",
    "| Upstream Commit | Status | Local Commit | Note |",
    "| :-------------- | :----- | :----------- | :--- |",
  )

  for (const item of input.analyses) {
    summaryLines.push(
      `| \`${item.hash.slice(0, 9)}\` | ${item.defaultDecision} | - | ${item.subject.replace(/\|/g, "\\|")} |`,
    )
  }

  summaryLines.push("")
  return summaryLines.join("\n")
}

async function readSkillFrontmatter(skillDir: string) {
  const skillFile = path.join(skillDir, "SKILL.md")
  try {
    const text = await readFile(skillFile, "utf8")
    const m = text.match(/^---\n([\s\S]*?)\n---/)
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "")
    if (!m) return { name: path.basename(skillDir), description: "", body }
    const fm = m[1]
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? path.basename(skillDir)
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
    return { name, description, body }
  } catch {
    return null
  }
}

async function listSkills() {
  const skillsRoot = path.join(ROOT, ".opencode/skills")
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const result: Array<{ name: string; description: string; path: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(skillsRoot, entry.name)
    const meta = await readSkillFrontmatter(skillDir)
    if (!meta) continue
    result.push({
      name: meta.name,
      description: meta.description,
      path: skillDir,
    })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
})

server.registerTool(
  "refacting_merger_daily_delta",
  {
    title: "Refacting Merger Daily Delta",
    description:
      "Analyze target ref vs source ref delta, apply refactor-from-src methodology, and return commit-level logical type/value score/recommended decision. Source and target must be explicitly specified by the user — do NOT assume defaults; ask the user if not provided.",
    inputSchema: z
      .object({
        sourceRemote: z.string().describe("Source remote (e.g. origin, upstream). Must be explicitly specified."),
        sourceBranch: z.string().describe("Source branch (e.g. dev, main). Must be explicitly specified."),
        targetRef: z
          .string()
          .describe("Target ref to compare from (e.g. HEAD, cms, main). Must be explicitly specified."),
        ledgerPath: z
          .string()
          .optional()
          .describe("Optional processed ledger markdown path, e.g. docs/events/refactor_processed_commits_20260210.md"),
        includeProcessed: z.boolean().default(false).describe("Include commits already in ledger"),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => {
    const data = await collectCommitAnalyses(input)
    return {
      content: [
        {
          type: "text",
          text: truncate(JSON.stringify(data, null, 2)),
        },
      ],
      structuredContent: data,
    }
  },
)

server.registerTool(
  "refacting_merger_generate_plan",
  {
    title: "Refacting Merger Generate Plan",
    description:
      "Generate a refactor plan markdown skeleton under docs/events with commit table (logical type, value score, risk, decision) for guided merge workflow.",
    inputSchema: z
      .object({
        topic: z.string().min(1).describe("Plan topic suffix, e.g. origin_dev_delta_round3"),
        outputPath: z.string().min(1).describe("Output markdown path (absolute or repo-relative)"),
        sourceRemote: z.string().describe("Source remote (e.g. origin, upstream). Must be explicitly specified."),
        sourceBranch: z.string().describe("Source branch (e.g. dev, main). Must be explicitly specified."),
        targetRef: z.string().describe("Target ref to compare from (e.g. HEAD, cms). Must be explicitly specified."),
        ledgerPath: z.string().optional(),
        includeProcessed: z.boolean().default(false),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => {
    const data = await collectCommitAnalyses(input)
    const markdown = renderPlanMarkdown({
      ...data,
      topic: input.topic,
    })
    const absOut = normalizePath(input.outputPath)
    await mkdir(path.dirname(absOut), { recursive: true })
    await writeFile(absOut, markdown, "utf8")

    const result = {
      outputPath: absOut,
      commits: data.analyses.length,
      sourceRef: data.sourceRef,
      targetRef: data.targetRef,
    }
    return {
      content: [
        {
          type: "text",
          text: `Plan generated: ${absOut}\nCommits in round: ${data.analyses.length}`,
        },
      ],
      structuredContent: result,
    }
  },
)

server.registerTool(
  "refacting_merger_update_ledger",
  {
    title: "Refacting Merger Update Ledger",
    description:
      "Append processed commit mapping to refactor processed ledger markdown with status ported/integrated/skipped.",
    inputSchema: z
      .object({
        ledgerPath: z.string().min(1).describe("Ledger markdown path"),
        roundTitle: z.string().default("origin/dev delta"),
        entries: z
          .array(
            z
              .object({
                upstream: z.string().min(7),
                status: z.enum(["ported", "integrated", "skipped"]),
                localCommit: z.string().optional(),
                note: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ ledgerPath, roundTitle, entries }) => {
    const abs = normalizePath(ledgerPath)
    let existing = ""
    try {
      existing = await readFile(abs, "utf8")
    } catch {
      existing = `# Refactor Processed Commit Ledger (${new Date().toISOString().slice(0, 10)})\n\n`
    }

    const section = [
      `\n## 已處理（${roundTitle} @ ${new Date().toISOString()}）\n`,
      "| Upstream Commit | Status | Local Commit | Note |",
      "| --------------- | ------ | ------------ | ---- |",
      ...entries.map(
        (x: ProcessedEntry) =>
          `| \`${x.upstream}\` | ${x.status} | ${x.localCommit ? `\`${x.localCommit}\`` : "-"} | ${x.note.replace(/\|/g, "\\|")} |`,
      ),
      "",
    ].join("\n")

    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, `${existing.trimEnd()}\n${section}`, "utf8")

    const result = {
      ledgerPath: abs,
      appended: entries.length,
    }
    return {
      content: [{ type: "text", text: `Ledger updated: ${abs}\nAppended rows: ${entries.length}` }],
      structuredContent: result,
    }
  },
)

server.registerTool(
  "refacting_merger_skill_index",
  {
    title: "Refacting Merger Skill Index",
    description:
      "List installed local skills from .opencode/skills with name/description/path so wizard can choose proper methodology (e.g., refactor-from-src).",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const skills = await listSkills()
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(skills, null, 2)) }],
      structuredContent: { skills },
    }
  },
)

server.registerTool(
  "refacting_merger_skill_read",
  {
    title: "Refacting Merger Skill Read",
    description:
      "Read one local skill bundle content (SKILL.md body and optional references) so the merger wizard can follow exact project methodology.",
    inputSchema: z
      .object({
        skillName: z.string().min(1).describe("Skill directory name under .opencode/skills"),
        includeReferences: z.boolean().default(true),
        maxReferenceFiles: z.number().int().min(1).max(30).default(8),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ skillName, includeReferences, maxReferenceFiles }) => {
    const skillDir = path.join(ROOT, ".opencode/skills", skillName)
    const meta = await readSkillFrontmatter(skillDir)
    if (!meta) {
      throw new Error(`Skill not found: ${skillName}`)
    }

    const references: Array<{ path: string; content: string }> = []
    if (includeReferences) {
      const refDir = path.join(skillDir, "references")
      try {
        const entries = await readdir(refDir, { withFileTypes: true })
        for (const entry of entries.filter((x) => x.isFile()).slice(0, maxReferenceFiles)) {
          const filePath = path.join(refDir, entry.name)
          const content = await readFile(filePath, "utf8")
          references.push({
            path: filePath,
            content: truncate(content),
          })
        }
      } catch {}
    }

    const payload = {
      name: meta.name,
      description: meta.description,
      skillPath: skillDir,
      body: truncate(meta.body),
      references,
    }
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(payload, null, 2)) }],
      structuredContent: payload,
    }
  },
)

server.registerTool(
  "refacting_merger_wizard_hint",
  {
    title: "Refacting Merger Wizard Hint",
    description:
      "Return guided next-step hints for wizard phases (analysis/planning/approval/execution/ledger) following refactor-from-src workflow. Source and target must be explicitly specified.",
    inputSchema: z
      .object({
        phase: z.enum(["analysis", "planning", "approval", "execution", "ledger"]),
        sourceRef: z.string().describe("Source ref (e.g. origin/dev, upstream/main). Must be explicitly specified."),
        targetRef: z.string().describe("Target ref (e.g. HEAD, cms). Must be explicitly specified."),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ phase, sourceRef, targetRef }) => {
    const steps: Record<string, string[]> = {
      analysis: [
        `1) Run refacting_merger_daily_delta on ${targetRef}..${sourceRef}`,
        "2) Load refactor-from-src skill via refacting_merger_skill_read",
        "3) Review high-risk commits in protected paths first",
      ],
      planning: [
        "1) Run refacting_merger_generate_plan",
        "2) Fill decisions per commit: ported/integrated/skipped",
        "3) Confirm test matrix by touched area",
      ],
      approval: ["1) Present plan table", "2) Get explicit Go", "3) Keep no code changes before approval"],
      execution: [
        "1) Integrate low-risk commits first",
        "2) Manual port protected-path commits",
        "3) Validate lint + typecheck + focused tests",
      ],
      ledger: [
        "1) Collect final statuses",
        "2) Run refacting_merger_update_ledger",
        "3) Commit plan + ledger for auditability",
      ],
    }

    const result = {
      phase,
      sourceRef,
      targetRef,
      steps: steps[phase],
    }
    return {
      content: [{ type: "text", text: result.steps.join("\n") }],
      structuredContent: result,
    }
  },
)

async function main() {
  if (Bun.argv.includes("--help")) {
    console.log(`${SERVER_NAME} MCP server`)
    console.log("Usage:")
    console.log(`  bun scripts/refacting-merger-mcp.ts`)
    console.log("Environment:")
    console.log("  REFACTING_MERGER_ROOT=/absolute/repo/path (optional)")
    return
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`${SERVER_NAME} running on stdio (root=${ROOT})`)
}

main().catch((err) => {
  console.error(`${SERVER_NAME} failed:`, err)
  process.exit(1)
})
