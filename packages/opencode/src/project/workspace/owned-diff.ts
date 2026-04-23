import { File } from "@/file"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Snapshot } from "@/snapshot"
import path from "path"
import { WorkspaceService } from "./service"

const normalizePath = (input: string) => input.replaceAll("\\", "/").replace(/\/+$/, "")
const normalizeBody = (input: string) => input.replaceAll("\r\n", "\n")

const normalizeSessionPath = (directory: string, input: string) => {
  const normalized = normalizePath(input)
  if (path.isAbsolute(normalized)) return normalizePath(path.relative(directory, normalized))
  return normalized.replace(/^\.\//, "")
}

function collectExplicitTouchedFiles(messages: MessageV2.WithParts[], directory: string) {
  const explicitTouched = new Set<string>()

  const parseApplyPatchFiles = (patchText: string) => {
    const matches = patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)
    for (const match of matches) {
      const file = match[1]?.trim()
      if (file) explicitTouched.add(normalizeSessionPath(directory, file))
    }
  }

  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      const input = part.state.input as Record<string, unknown>
      if (part.tool === "edit" || part.tool === "write") {
        const filePath = typeof input.filePath === "string" ? input.filePath : undefined
        if (filePath) explicitTouched.add(normalizeSessionPath(directory, filePath))
      }
      if (part.tool === "apply_patch") {
        // Support both codex-rs canonical ("input") and legacy opencode ("patchText")
        const patchText = typeof input.input === "string" ? input.input
          : typeof input.patchText === "string" ? input.patchText
          : undefined
        if (patchText) parseApplyPatchFiles(patchText)
      }
      if (part.tool === "filesystem_write_file" || part.tool === "filesystem_edit_file") {
        const filePath = typeof input.path === "string" ? input.path : undefined
        if (filePath) explicitTouched.add(normalizeSessionPath(directory, filePath))
      }
      if (part.tool === "filesystem_move_file") {
        const source = typeof input.source === "string" ? input.source : undefined
        const destination = typeof input.destination === "string" ? input.destination : undefined
        if (source) explicitTouched.add(normalizeSessionPath(directory, source))
        if (destination) explicitTouched.add(normalizeSessionPath(directory, destination))
      }
    }
  }

  return explicitTouched
}

// mobile-session-restructure (2026-04-23): the previous schema stored
// full before/after file bodies on every diff entry; this let
// computeOwnedSessionDirtyDiff do a content-equality check
// `latest.after === current.after` to filter out files the user had
// stomped beyond the AI's intent.
//
// Per the spec we drop those bodies entirely. The remaining filter
// uses status alone (added/deleted/modified match). False-positives
// from user override are accepted as a minor behavioural drift; the
// owned-diff surface still answers "what files did the AI touch that
// are still dirty". If precise override detection is later needed, a
// follow-up spec can add a targeted git-show comparison against the
// per-turn snapshot commit; we are deliberately not preserving the
// mistake to simulate that here.

function latestSummaryDiffByFile(messages: MessageV2.WithParts[]) {
  const latestByFile = new Map<string, Snapshot.FileDiff>()
  for (const message of messages) {
    if (message.info.role !== "user") continue
    for (const diff of message.info.summary?.diffs ?? []) {
      latestByFile.set(normalizePath(diff.file), {
        ...diff,
        file: normalizePath(diff.file),
      })
    }
  }
  return latestByFile
}

export function collectOwnedSessionCandidateFiles(messages: MessageV2.WithParts[], directory: string) {
  const explicitTouched = collectExplicitTouchedFiles(messages, directory)
  const latestByFile = latestSummaryDiffByFile(messages)
  if (explicitTouched.size === 0 || latestByFile.size === 0) return []
  return [...explicitTouched].filter((file) => latestByFile.has(file)).sort((a, b) => a.localeCompare(b))
}

export function computeOwnedSessionDirtyDiff(currentDiffs: Snapshot.FileDiff[], messages: MessageV2.WithParts[]) {
  const explicitTouched = collectExplicitTouchedFiles(messages, Instance.directory)
  const latestByFile = latestSummaryDiffByFile(messages)
  if (explicitTouched.size === 0 || latestByFile.size === 0) return []

  return currentDiffs.filter((diff) => {
    const file = normalizePath(diff.file)
    if (!explicitTouched.has(file)) return false
    const latest = latestByFile.get(file)
    if (!latest) return false
    return (latest.status ?? "modified") === (diff.status ?? "modified")
  })
}

function normalizeSnapshotDiffs(diffs: Snapshot.FileDiff[]) {
  return diffs.map((diff) => ({
    ...diff,
    file: normalizePath(diff.file),
  }))
}

export async function getSessionMessageDiff(input: { sessionID: string; messageID: string }) {
  const messages = await Session.messages({ sessionID: input.sessionID })
  const user = messages.find((message) => message.info.id === input.messageID && message.info.role === "user")
  if (!user || user.info.role !== "user") return []
  return normalizeSnapshotDiffs(user.info.summary?.diffs ?? [])
}

export async function getSessionOwnedDirtyDiff(input: { sessionID: string }) {
  const session = await Session.get(input.sessionID)
  const workspace = await WorkspaceService.resolve({ directory: session.directory })
  if (workspace.attachments.sessionIds.length > 0 && !workspace.attachments.sessionIds.includes(input.sessionID))
    return []

  const messages = await Session.messages({ sessionID: input.sessionID })
  const candidates = collectOwnedSessionCandidateFiles(messages, session.directory)
  if (candidates.length === 0) return []

  const currentDiffs = await Instance.provide({
    directory: session.directory,
    fn: () => File.status({ paths: candidates }),
  })

  return computeOwnedSessionDirtyDiff(
    currentDiffs.map((diff) => ({
      file: normalizePath(diff.path),
      additions: diff.added,
      deletions: diff.removed,
      status: diff.status,
    })),
    messages,
  )
}
