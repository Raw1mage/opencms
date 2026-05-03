/**
 * Routing hint generator for Office attachments.
 *
 * Reads incoming/<stem>/manifest.json (synchronously — the call site
 * is in toModelMessages which is synchronous and on a hot path) and
 * renders a plain-language map of what's in the bundle dir for the
 * AI to consume. Implements DD-7 (map-not-content + fold rules),
 * DD-12 (cached-failure prefix), and DD-13 (pull-refresh contract
 * closing line).
 *
 * For non-Office attachment_refs (image / pdf / text-like), this
 * module returns null — the existing per-mime hint blocks in
 * message-v2.ts handle those.
 */

import path from "node:path"
import fs from "node:fs"
import { classifyOffice, type OfficeKind } from "./office-mime"
import {
  validateManifest,
  MANIFEST_FILENAME,
  type Manifest,
  type ManifestFile,
  type FileKind,
} from "./manifest"

export interface RenderRoutingHintInput {
  /** repo-relative path to the source file (e.g. "incoming/foo.docx"). */
  repoPath: string
  mime: string
  filename: string | undefined
  /** Absolute path to the project root. */
  projectRoot: string
}

/**
 * Returns a routing-hint string (without leading newline) when the
 * attachment is an Office mime AND a manifest exists for it. Returns
 * null otherwise — the caller's existing per-mime fallback then runs.
 */
export function renderOfficeRoutingHint(input: RenderRoutingHintInput): string | null {
  const kind = classifyOffice(input.mime, input.filename)
  if (kind === "non-office") return null

  const stem = path.basename(input.repoPath, path.extname(input.repoPath))
  const stemDir = path.join(input.projectRoot, "incoming", stem)
  const manifestPath = path.join(stemDir, MANIFEST_FILENAME)
  if (!fs.existsSync(manifestPath)) return null

  let manifest: Manifest | null = null
  try {
    const raw = fs.readFileSync(manifestPath, "utf8")
    const parsed = JSON.parse(raw)
    const issues = validateManifest(parsed)
    if (issues.length === 0) manifest = parsed as Manifest
  } catch {
    // fall through; manifest read failed
  }
  if (!manifest) return null

  return renderFromManifest({
    repoPath: input.repoPath,
    bundleRepoPath: path.join("incoming", stem),
    manifest,
    kind,
  })
}

interface RenderFromManifestInput {
  repoPath: string
  bundleRepoPath: string
  manifest: Manifest
  kind: OfficeKind
}

const ACTION_CONTRACT = [
  "**動 incoming/<stem>/ 任何檔案前，先 read manifest.json 確認當前狀態。**",
  "讀內容直接用一般檔案讀寫工具（read / grep / glob）。",
  "要改寫 docx 才呼叫 docxmcp 工具。",
].join("\n")

function renderFromManifest(input: RenderFromManifestInput): string {
  const { manifest, repoPath, bundleRepoPath } = input
  const status = manifest.decompose.status
  const bgStatus = manifest.decompose.background_status

  // Failed (cached or fresh) — DD-6 + DD-12 wording
  if (status === "failed") {
    const reason = manifest.decompose.reason ?? "(no reason recorded)"
    return [
      `附檔 \`${repoPath}\`。**過去拆解曾失敗**：「${reason}」`,
      `此失敗結果已快取。如要重試，請使用者修改檔案內容，或先執行 \`rm -rf ${bundleRepoPath}\` 清除舊紀錄後重傳。`,
    ].join("\n")
  }

  // Unsupported — DD-7 wording
  if (status === "unsupported") {
    const reason = manifest.decompose.reason ?? "(no reason recorded)"
    return [
      `附檔 \`${repoPath}\`。**此格式目前不支援自動拆解**：「${reason}」`,
      `請告知使用者轉成 .docx 後再上傳。`,
    ].join("\n")
  }

  // Success — render the file map (DD-7 fold rules)
  const groups = groupByKind(manifest.files)
  const lines: string[] = []
  lines.push(`附檔 \`${repoPath}\`（${formatBytes(manifest.source.byte_size)}）。已自動拆解到 \`${bundleRepoPath}/\`：`)

  pushKindLine(lines, groups, "body", (files) => {
    const f = files[0]!
    return `- 全文：\`${f.path}\`（${f.summary}）`
  })

  pushKindLine(lines, groups, "outline", (files) => {
    const f = files[0]!
    return `- 大綱：\`${f.path}\`（${f.summary}）`
  })

  pushKindLine(lines, groups, "chapter", (files) => {
    return `- 章節：${formatList("chapters/", files, "份")}`
  })

  pushKindLine(lines, groups, "table", (files) => {
    return `- 表格：${formatList("tables/", files, "份")}`
  })

  pushKindLine(lines, groups, "media", (files) => {
    return `- 圖片：${formatList("media/", files, "張")}`
  })

  pushKindLine(lines, groups, "template", (files) => {
    const dotx = files.find((f) => f.path.endsWith(".dotx"))
    if (dotx) return `- 範本：\`${dotx.path}\`（${files.length} 個檔）`
    return `- 範本：${files.length} 個檔（styles / theme / numbering / settings）`
  })

  // Background status banner
  if (bgStatus === "running") {
    const pending = manifest.decompose.pending_kinds ?? []
    const pendingLabel = pending.join("、") || "尚有"
    lines.push("")
    lines.push(
      `⏳ **背景拆解中**：${pendingLabel}。host 端每 5 秒同步增量；要立刻等完成可呼叫 \`mcpapp-docxmcp_extract_all_collect\`。`,
    )
  } else if (bgStatus === "failed") {
    const err = manifest.decompose.background_error ?? "(unknown)"
    lines.push("")
    lines.push(`⚠️ **背景拆解失敗**：${err}。已就緒檔案仍可使用。`)
  }

  lines.push("")
  lines.push(ACTION_CONTRACT)
  return lines.join("\n")
}

function groupByKind(files: ManifestFile[]): Map<FileKind, ManifestFile[]> {
  const m = new Map<FileKind, ManifestFile[]>()
  for (const f of files) {
    if (f.kind === "pending_marker") continue // never advertise marker files
    const arr = m.get(f.kind) ?? []
    arr.push(f)
    m.set(f.kind, arr)
  }
  // sort each group by path so the rendered order is deterministic
  for (const arr of m.values()) arr.sort((a, b) => a.path.localeCompare(b.path))
  return m
}

function pushKindLine(
  out: string[],
  groups: Map<FileKind, ManifestFile[]>,
  kind: FileKind,
  render: (files: ManifestFile[]) => string,
): void {
  const files = groups.get(kind)
  if (!files || files.length === 0) return
  out.push(render(files))
}

/**
 * DD-7 fold rule: ≤ 4 items show every filename; > 4 show the first
 * + a count. Display path is the leaf name relative to the bundle dir.
 */
function formatList(_prefix: string, files: ManifestFile[], counter: string): string {
  if (files.length <= 4) {
    const rendered = files.map((f) => `\`${f.path}\``).join(" / ")
    return `${rendered}（共 ${files.length} ${counter}）`
  }
  const first = files[0]!.path
  const remain = files.length - 1
  return `\`${first}\` 起（還有 ${remain} ${counter}，共 ${files.length} ${counter}）`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
