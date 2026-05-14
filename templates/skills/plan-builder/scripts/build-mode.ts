#!/usr/bin/env bun
/**
 * build-mode.ts — helper for plan-builder §16.5b `build_mode()` ceremony.
 *
 * See SKILL.md §16.5b for the full protocol. In short:
 * - AI calls `build-mode.ts <sessionID> check` when about to do real work
 *   on an implementing-state spec. If the session is already armed OR has
 *   already been asked (marker present), the script reports that so AI
 *   skips the ceremony. Otherwise AI shows an AskUserQuestion using the
 *   returned promptText.
 * - AI calls `build-mode.ts <sessionID> answer <yes|no>` with the user's
 *   response. Script writes the marker (so next check is a no-op) and,
 *   on `yes`, arms the session via the per-user opencode daemon socket.
 *
 * Marker location: `~/.local/state/opencode/build-mode-asked/<sessionID>.json`
 * The marker is scoped to (session, asked-at-time); it is NOT tied to a
 * specific spec slug because a session is usually bound to one active spec.
 * If the user opens a different spec in the same session later, delete the
 * marker file manually to re-trigger the ceremony.
 *
 * Daemon socket: ${XDG_RUNTIME_DIR:-/run/user/$UID}/opencode/daemon.sock
 *
 * Usage:
 *   bun run scripts/build-mode.ts <sessionID> check
 *   bun run scripts/build-mode.ts <sessionID> answer yes
 *   bun run scripts/build-mode.ts <sessionID> answer no
 *   bun run scripts/build-mode.ts <sessionID> reset    (clears the marker)
 *
 * Exit codes:
 *   0 — ok; JSON printed to stdout
 *   1 — runtime error (daemon unreachable, marker write failed)
 *   2 — usage error
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

function usage(exitCode = 2): never {
  const msg = [
    "Usage:",
    "  build-mode.ts <sessionID> check",
    "  build-mode.ts <sessionID> answer <yes|no>",
    "  build-mode.ts <sessionID> reset",
  ].join("\n")
  console.error(msg)
  process.exit(exitCode)
}

const [, , sessionID, cmd, arg] = process.argv
if (!sessionID || !cmd) usage()

const STATE_DIR = path.join(homedir(), ".local/state/opencode/build-mode-asked")
const MARKER_PATH = path.join(STATE_DIR, `${sessionID}.json`)

const PROMPT_TEXT =
  "This plan has pending work in tasks.md. Enter build_mode for this session? " +
  "(arms autonomous continuation so phase rollovers happen without pausing. " +
  "You can still stop any time by saying 停 / stop.)"

interface Marker {
  sessionID: string
  askedAt: string
  answer: "yes" | "no"
  armed: boolean
}

function readMarker(): Marker | null {
  if (!existsSync(MARKER_PATH)) return null
  try {
    return JSON.parse(readFileSync(MARKER_PATH, "utf8")) as Marker
  } catch {
    return null
  }
}

function writeMarker(m: Marker) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(MARKER_PATH, JSON.stringify(m, null, 2), "utf8")
}

function socketPath(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ""}`
  return path.join(base, "opencode/daemon.sock")
}

async function fetchDaemon(methodPath: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const url = `http://daemon${methodPath}`
  const body = init?.body ? JSON.stringify(init.body) : undefined
  return fetch(url, {
    unix: socketPath(),
    method: init?.method ?? "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body,
  } as any)
}

async function getSession(): Promise<{ enabled: boolean } | { error: string }> {
  try {
    const res = await fetchDaemon(`/session/${encodeURIComponent(sessionID)}`)
    if (!res.ok) return { error: `daemon HTTP ${res.status}` }
    const body = (await res.json()) as { workflow?: { autonomous?: { enabled?: boolean } } }
    return { enabled: body.workflow?.autonomous?.enabled === true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function armSession(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchDaemon(`/session/${encodeURIComponent(sessionID)}/autonomous`, {
      method: "POST",
      body: { enabled: true, enqueue: true },
    })
    if (!res.ok) return { ok: false, error: `daemon HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function main() {
  if (cmd === "check") {
    const marker = readMarker()
    const sess = await getSession()
    if ("error" in sess) {
      console.log(
        JSON.stringify(
          {
            asked: marker !== null,
            answer: marker?.answer ?? null,
            currentlyArmed: null,
            daemonError: sess.error,
            skipCeremony: marker !== null,
            promptText: PROMPT_TEXT,
          },
          null,
          2,
        ),
      )
      return
    }
    console.log(
      JSON.stringify(
        {
          asked: marker !== null,
          answer: marker?.answer ?? null,
          currentlyArmed: sess.enabled,
          skipCeremony: marker !== null || sess.enabled,
          promptText: PROMPT_TEXT,
        },
        null,
        2,
      ),
    )
    return
  }

  if (cmd === "answer") {
    if (arg !== "yes" && arg !== "no") usage()
    const existing = readMarker()
    if (existing) {
      console.log(
        JSON.stringify(
          {
            already: true,
            previousAnswer: existing.answer,
            previousAskedAt: existing.askedAt,
            note: "build_mode ceremony already recorded for this session; no-op.",
          },
          null,
          2,
        ),
      )
      return
    }
    let armed = false
    let armError: string | undefined
    if (arg === "yes") {
      const result = await armSession()
      armed = result.ok
      armError = result.error
    }
    const marker: Marker = {
      sessionID,
      askedAt: new Date().toISOString(),
      answer: arg,
      armed,
    }
    writeMarker(marker)
    console.log(JSON.stringify({ written: marker, armError: armError ?? null }, null, 2))
    return
  }

  if (cmd === "reset") {
    if (existsSync(MARKER_PATH)) {
      rmSync(MARKER_PATH)
      console.log(JSON.stringify({ reset: true, path: MARKER_PATH }, null, 2))
    } else {
      console.log(JSON.stringify({ reset: false, reason: "marker did not exist", path: MARKER_PATH }, null, 2))
    }
    return
  }

  usage()
}

main().catch((err) => {
  console.error("build-mode error:", err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
