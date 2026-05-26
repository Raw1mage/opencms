/**
 * harness/freerun-mode — per-session meta.json persistence.
 *
 * Shape defined in types.ts FreerunSessionMeta. Stored at
 * `<dataHome>/storage/freerun/<sessionId>/meta.json`. Engine writes it
 * at session start (init) and at session terminate (final_status,
 * total_iterations, ended_at). The freerun-pause / freerun-resume CLIs
 * patch only final_status.
 *
 * Atomic write via temp-file-then-rename, same pattern as node-fs.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { FreerunSessionMeta, sessionStorageDir, type FreerunSessionMeta as FreerunSessionMetaT } from "../types"

export namespace MetaFS {
  function metaPath(sessionId: string, dataHome: string): string {
    return path.join(sessionStorageDir(sessionId, dataHome), "meta.json")
  }

  /** Atomically write a complete meta object. */
  export async function write(sessionId: string, meta: FreerunSessionMetaT, dataHome: string): Promise<void> {
    const target = metaPath(sessionId, dataHome)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const parsed = FreerunSessionMeta.parse(meta) // validation belt-and-suspenders
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await Bun.write(tmp, JSON.stringify(parsed, null, 2))
      await fs.rename(tmp, target)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Read meta.json; returns null on missing file. */
  export async function read(sessionId: string, dataHome: string): Promise<FreerunSessionMetaT | null> {
    try {
      const text = await fs.readFile(metaPath(sessionId, dataHome), "utf-8")
      const parsed = JSON.parse(text)
      return FreerunSessionMeta.parse(parsed)
    } catch (err: any) {
      if (err?.code === "ENOENT") return null
      throw err
    }
  }

  /** Patch a few fields; returns the updated meta. Returns null if no meta on disk. */
  export async function patch(
    sessionId: string,
    dataHome: string,
    patch: Partial<FreerunSessionMetaT>,
  ): Promise<FreerunSessionMetaT | null> {
    const current = await read(sessionId, dataHome)
    if (current === null) return null
    const merged = { ...current, ...patch }
    await write(sessionId, merged, dataHome)
    return merged
  }

  /** Check final_status — useful for engine + bridge gating. */
  export async function statusOf(
    sessionId: string,
    dataHome: string,
  ): Promise<FreerunSessionMetaT["final_status"] | null> {
    const m = await read(sessionId, dataHome)
    return m?.final_status ?? null
  }
}
