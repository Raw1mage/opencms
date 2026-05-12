import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export type State =
  | "proposed"
  | "designed"
  | "planned"
  | "implementing"
  | "verified"
  | "living"
  | "archived"

export const STATES: readonly State[] = [
  "proposed",
  "designed",
  "planned",
  "implementing",
  "verified",
  "living",
  "archived",
] as const

export type Mode =
  | "new"
  | "promote"
  | "amend"
  | "revise"
  | "extend"
  | "refactor"
  | "sync"
  | "archive"
  | "migration"
  | "refactor-rollback"

export const USER_MODES: readonly Mode[] = [
  "new",
  "promote",
  "amend",
  "revise",
  "extend",
  "refactor",
  "sync",
  "archive",
] as const

export type SyncResult = "warned" | "clean"

export interface HistoryEntry {
  from?: State | null
  to?: State
  at: string
  by: string
  mode: Mode
  reason: string
  result?: SyncResult
  drift?: string[]
  snapshot?: string
  "restored-from"?: string
}

export interface StateFile {
  schema_version: 1
  state: State
  profile: string[]
  history: HistoryEntry[]
}

export const STATE_FILE_NAME = ".state.json"

export function stateFilePath(specRoot: string): string {
  return path.join(specRoot, STATE_FILE_NAME)
}

export function hasStateFile(specRoot: string): boolean {
  return existsSync(stateFilePath(specRoot))
}

export function readState(specRoot: string): StateFile {
  const p = stateFilePath(specRoot)
  if (!existsSync(p)) {
    throw new Error(`No .state.json at ${p}`)
  }
  const raw = readFileSync(p, "utf8")
  const parsed = JSON.parse(raw) as StateFile
  if (!STATES.includes(parsed.state)) {
    throw new Error(`Invalid state value "${parsed.state}" in ${p}`)
  }
  return parsed
}

export function writeState(specRoot: string, data: StateFile): void {
  const p = stateFilePath(specRoot)
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8")
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function currentUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? "system"
}

export function appendHistory(data: StateFile, entry: HistoryEntry): StateFile {
  return { ...data, history: [...data.history, entry] }
}

/** Natural forward transitions for `promote` mode. */
export const FORWARD: Readonly<Record<State, State | null>> = {
  proposed: "designed",
  designed: "planned",
  planned: "implementing",
  implementing: "verified",
  verified: "living",
  living: null, // living is terminal for forward; leave via amend/revise/extend/refactor/archive
  archived: null,
}

export function isForward(from: State, to: State): boolean {
  return FORWARD[from] === to
}

/**
 * Allowed transitions by mode. Returns null if the transition is invalid.
 * Non-transition modes (amend, sync) return the same state.
 */
export function transitionFor(mode: Mode, from: State, requestedTo?: State): State | null {
  switch (mode) {
    case "new":
      return from === "proposed" ? "proposed" : null // mode=new only allowed when spec just got created
    case "promote":
      return FORWARD[from]
    case "amend":
      return from === "living" ? "living" : null
    case "revise":
    case "extend":
      return from === "living" ? "designed" : null
    case "refactor":
      return from === "living" ? "proposed" : null
    case "archive":
      return from === "living" ? "archived" : null
    case "sync":
      return from // no change
    case "migration":
      return requestedTo ?? null
    case "refactor-rollback":
      return requestedTo ?? null
  }
}
