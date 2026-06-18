import { describe, test, expect } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { CapabilitySyncExec } from "./sync"
import { SkillResync } from "../mcp/skill-resync"

async function mktmp(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}
async function statusState(args: { skillName: string; mcpAppPath: string; projectionPath: string }) {
  const s = await CapabilitySyncExec.statusMcpSkill(args)
  return s.managed ? s.state : "no-skill"
}
async function leaf(p: string) {
  return await fs.readFile(path.join(p, "SKILL.md"), "utf8")
}

describe("capability-sync/skill-resync: statusMcpSkill + acceptSource", () => {
  test("missing → sync → current → repo-edit stale → resync(no flag) → leaf-drift stop → accept-source", async () => {
    const root = await mktmp("skill-resync-")
    const mcpAppPath = path.join(root, "repo")
    const skillName = "demo"
    const skillDir = path.join(mcpAppPath, "skills", skillName)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\nv1 content\n")
    const projectionPath = path.join(root, "proj", skillName)
    const addr = { skillName, mcpAppPath, projectionPath }

    // 1. before any projection: missing
    expect(await statusState(addr)).toBe("missing")

    // 2. force sync (missing → sync-then-reload)
    expect((await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true })).proceed).toBe(true)
    expect(await leaf(projectionPath)).toContain("v1 content")

    // 3. now current
    expect(await statusState(addr)).toBe("current")

    // 4. edit the repo SSOT → repo-newer (NOT xdg-newer), reported even within the TTL.
    //    Regression guard for the hash-version false-xdg-newer bug: a lower-sorting new
    //    hash must still be repo-newer, never xdg-newer.
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\nv2 content\n")
    expect(await statusState(addr)).toBe("repo-newer")

    // 5. a plain repo edit resyncs WITHOUT --accept-source (the common case "just works")
    expect((await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true })).proceed).toBe(true)
    expect(await leaf(projectionPath)).toContain("v2 content")
    expect(await statusState(addr)).toBe("current")

    // 6. hand-edit the projection leaf → xdg-drift (the only real "needs a flag" case)
    await fs.writeFile(path.join(projectionPath, "SKILL.md"), "# Demo\nHAND EDITED\n")
    expect(await statusState(addr)).toBe("xdg-drift")

    // 7. resync WITHOUT acceptSource → stop, leaf left untouched (no-silent-fallback)
    const stop = await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true })
    expect(stop.proceed).toBe(false)
    if (!stop.proceed) expect(stop.verdict.state).toBe("xdg-drift")
    expect(await leaf(projectionPath)).toContain("HAND EDITED")

    // 8. resync WITH acceptSource → reconcile to SSOT (v2), current again
    expect((await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true, acceptSource: true })).proceed).toBe(
      true,
    )
    expect(await leaf(projectionPath)).toContain("v2 content")
    expect(await statusState(addr)).toBe("current")

    // 9. managed:false for a non-existent skill dir (scope boundary)
    const s = await CapabilitySyncExec.statusMcpSkill({
      skillName: "nope",
      mcpAppPath,
      projectionPath: path.join(root, "proj", "nope"),
    })
    expect(s.managed).toBe(false)

    await fs.rm(root, { recursive: true, force: true })
  })

  test("regression: hash-version repo edits never false-classify as xdg-newer (probe many contents)", async () => {
    const root = await mktmp("skill-resync-reg-")
    const mcpAppPath = path.join(root, "repo")
    const skillName = "demo"
    const skillDir = path.join(mcpAppPath, "skills", skillName)
    await fs.mkdir(skillDir, { recursive: true })
    const projectionPath = path.join(root, "proj", skillName)
    const addr = { skillName, mcpAppPath, projectionPath }
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "seed\n")
    await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true })
    // Walk several contents; each edit (leaf untouched) must be repo-newer, never xdg-newer.
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(skillDir, "SKILL.md"), `content revision ${i} ${"x".repeat(i)}\n`)
      expect(await statusState(addr)).toBe("repo-newer")
      expect((await CapabilitySyncExec.preflightMcpSkill({ ...addr, forceRefresh: true })).proceed).toBe(true)
      expect(await statusState(addr)).toBe("current")
    }
    await fs.rm(root, { recursive: true, force: true })
  })
})

describe("SkillResync.sourceChanged (watch change-detection, M3)", () => {
  test("seeds false, fires once per edit, coalesces, detects nested-file edits", async () => {
    SkillResync._resetWatchBaseline()
    const dir = await mktmp("skill-watch-")
    const f = path.join(dir, "SKILL.md")
    await fs.writeFile(f, "v1\n")
    // Drive mtime explicitly so the test is independent of fs mtime granularity.
    await fs.utimes(f, new Date(1000), new Date(1000))

    expect(await SkillResync.sourceChanged(dir)).toBe(false) // first call = seed baseline
    expect(await SkillResync.sourceChanged(dir)).toBe(false) // no change

    await fs.writeFile(f, "v2 changed (same dir)\n")
    await fs.utimes(f, new Date(2000), new Date(2000)) // newer
    expect(await SkillResync.sourceChanged(dir)).toBe(true) // edit detected
    expect(await SkillResync.sourceChanged(dir)).toBe(false) // coalesced: no new write since

    // a nested file edit must also be detected (skills carry scripts/, references/)
    const nested = path.join(dir, "scripts", "x.ts")
    await fs.mkdir(path.dirname(nested), { recursive: true })
    await fs.writeFile(nested, "x\n")
    await fs.utimes(nested, new Date(3000), new Date(3000))
    expect(await SkillResync.sourceChanged(dir)).toBe(true)
    expect(await SkillResync.sourceChanged(dir)).toBe(false)

    await fs.rm(dir, { recursive: true, force: true })
  })
})
