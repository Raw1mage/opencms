import { describe, it, expect } from "bun:test"
import { afterEach } from "bun:test"
import {
  parseMandatorySkills,
  parseMandatorySkillsBlocks,
  resolveMandatoryList,
  mergeMandatorySources,
  reconcileMandatoryList,
  KEEP_RULES,
} from "./mandatory-skills"
import { SkillLayerRegistry } from "./skill-layer-registry"

describe("parseMandatorySkills", () => {
  it("TV1: extracts single block with two skills", () => {
    const text = [
      "# Project",
      "",
      "<!-- opencode:mandatory-skills -->",
      "- plan-builder",
      "- code-thinker",
      "<!-- /opencode:mandatory-skills -->",
      "",
      "rest of file",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["plan-builder", "code-thinker"])
  })

  it("TV2: returns empty list when no sentinel, does not throw", () => {
    const text = "# AGENTS.md\n\nNo mandatory-skills block here."
    expect(parseMandatorySkills(text)).toEqual([])
  })

  it("TV3: normalizes bullets — trim whitespace, strip inline # comment, skip empty", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "- plan-builder    # 必要",
      "-  code-thinker ",
      "- ",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["plan-builder", "code-thinker"])
  })

  it("TV4: merges multiple blocks, dedups preserving first occurrence", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "- plan-builder",
      "<!-- /opencode:mandatory-skills -->",
      "",
      "prose...",
      "",
      "<!-- opencode:mandatory-skills -->",
      "- code-thinker",
      "- plan-builder",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["plan-builder", "code-thinker"])
  })

  it("unclosed block — treats body as single block, returns skills parsed so far", () => {
    const text = ["<!-- opencode:mandatory-skills -->", "- plan-builder", "- code-thinker"].join("\n")
    const blocks = parseMandatorySkillsBlocks(text, "<test>")
    expect(blocks).toHaveLength(1)
    expect(blocks[0].endLine).toBeNull()
    expect(blocks[0].skills).toEqual(["plan-builder", "code-thinker"])
    expect(parseMandatorySkills(text)).toEqual(["plan-builder", "code-thinker"])
  })

  it("nested opener closes previous block + starts new one (warn only)", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "- alpha",
      "<!-- opencode:mandatory-skills -->",
      "- beta",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["alpha", "beta"])
  })

  it("ignores non-bullet lines within block", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "some prose line",
      "- plan-builder",
      "* not-a-skill-wrong-bullet",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["plan-builder"])
  })

  it("parseMandatorySkillsBlocks emits source + line numbers", () => {
    const text = [
      "header",
      "<!-- opencode:mandatory-skills -->",
      "- plan-builder",
      "<!-- /opencode:mandatory-skills -->",
      "footer",
    ].join("\n")
    const blocks = parseMandatorySkillsBlocks(text, "/tmp/AGENTS.md")
    expect(blocks).toEqual([
      {
        skills: ["plan-builder"],
        sourceFile: "/tmp/AGENTS.md",
        startLine: 2,
        endLine: 4,
      },
    ])
  })

  it("handles CRLF line endings", () => {
    const text = "<!-- opencode:mandatory-skills -->\r\n- plan-builder\r\n<!-- /opencode:mandatory-skills -->"
    // Our parser splits on \n; \r stays attached. The bullet regex + normalize should still extract.
    // Body after \r: "- plan-builder\r" → BULLET_RE captures "plan-builder\r" → trim → "plan-builder"
    expect(parseMandatorySkills(text)).toEqual(["plan-builder"])
  })

  it("whitespace tolerant on sentinel markers", () => {
    const text = ["<!--opencode:mandatory-skills-->", "- one", "<!-- /opencode:mandatory-skills   -->"].join(
      "\n",
    )
    expect(parseMandatorySkills(text)).toEqual(["one"])
  })
})

describe("resolveMandatoryList — non-coding subagent short-circuit (TV8)", () => {
  it("returns empty list without FS access when subagent.name !== coding", async () => {
    const result = await resolveMandatoryList({
      sessionID: "ses_test_tv8",
      agent: { name: "plan-builder" },
      isSubagent: true,
    })
    expect(result).toEqual({ list: [], bySkill: {} })
  })

  it("returns empty list for subagent with non-matching name even 'code-thinker'", async () => {
    const result = await resolveMandatoryList({
      sessionID: "ses_test_other_sub",
      agent: { name: "code-thinker" },
      isSubagent: true,
    })
    expect(result).toEqual({ list: [], bySkill: {} })
  })
})

describe("mergeMandatorySources — Global + Project dedup", () => {
  const projectSrc = {
    source: "agents_md_project" as const,
    path: "/proj/AGENTS.md",
    text: "<!-- opencode:mandatory-skills -->\n- B\n- C\n<!-- /opencode:mandatory-skills -->",
  }
  const globalSrc = {
    source: "agents_md_global" as const,
    path: "~/.config/opencode/AGENTS.md",
    text: "<!-- opencode:mandatory-skills -->\n- A\n- B\n<!-- /opencode:mandatory-skills -->",
  }

  it("TV5: project priority, global appends tail, deduped", () => {
    // Order: project first → global second (project-priority feeds earlier)
    const result = mergeMandatorySources([projectSrc, globalSrc])
    expect(result.list).toEqual(["B", "C", "A"])
    expect(result.bySkill).toEqual({
      B: ["agents_md_project", "agents_md_global"],
      C: ["agents_md_project"],
      A: ["agents_md_global"],
    })
  })

  it("TV6: global missing (only project present) returns project list", () => {
    const result = mergeMandatorySources([projectSrc])
    expect(result.list).toEqual(["B", "C"])
    expect(result.bySkill).toEqual({
      B: ["agents_md_project"],
      C: ["agents_md_project"],
    })
  })

  it("no sources returns empty result without throwing", () => {
    expect(mergeMandatorySources([])).toEqual({ list: [], bySkill: {} })
  })

  it("coding.txt source path — mirrors TV7 subagent input", () => {
    const codingSrc = {
      source: "coding_txt" as const,
      path: "/proj/packages/opencode/src/agent/prompt/coding.txt",
      text: "Role: subagent\n\n<!-- opencode:mandatory-skills -->\n- code-thinker\n<!-- /opencode:mandatory-skills -->\n...",
    }
    expect(mergeMandatorySources([codingSrc])).toEqual({
      list: ["code-thinker"],
      bySkill: { "code-thinker": ["coding_txt"] },
    })
  })
})

describe("reconcileMandatoryList — TV13 unpin on removal", () => {
  afterEach(() => {
    SkillLayerRegistry.reset()
  })

  it("unpins mandatory entries that are no longer in desired list", async () => {
    const sessionID = `ses_reconcile_${Date.now().toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", {
      content: "pb-content",
      keepRules: [KEEP_RULES.AGENTS_MD],
    })
    SkillLayerRegistry.pin(sessionID, "plan-builder")
    SkillLayerRegistry.recordLoaded(sessionID, "obsolete-skill", {
      content: "obs-content",
      keepRules: [KEEP_RULES.AGENTS_MD],
    })
    SkillLayerRegistry.pin(sessionID, "obsolete-skill")

    const result = await reconcileMandatoryList({
      sessionID,
      desired: ["plan-builder"],
    })

    expect(result.unpinned).toEqual(["obsolete-skill"])
    expect(SkillLayerRegistry.peek(sessionID, "plan-builder")?.pinned).toBe(true)
    expect(SkillLayerRegistry.peek(sessionID, "obsolete-skill")?.pinned).toBe(false)
  })

  it("does not unpin non-mandatory pinned entries (those without mandatory:* keepRule)", async () => {
    const sessionID = `ses_reconcile_nonmand_${Date.now().toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "user-pinned-skill", {
      content: "upc",
      keepRules: ["user:manual-pin"],
    })
    SkillLayerRegistry.pin(sessionID, "user-pinned-skill")

    const result = await reconcileMandatoryList({
      sessionID,
      desired: [],
    })

    expect(result.unpinned).toEqual([])
    expect(SkillLayerRegistry.peek(sessionID, "user-pinned-skill")?.pinned).toBe(true)
  })

  it("no-op when desired list matches current mandatory pinned set", async () => {
    const sessionID = `ses_reconcile_match_${Date.now().toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "plan-builder", {
      content: "pb",
      keepRules: [KEEP_RULES.AGENTS_MD],
    })
    SkillLayerRegistry.pin(sessionID, "plan-builder")

    const result = await reconcileMandatoryList({
      sessionID,
      desired: ["plan-builder"],
    })

    expect(result.unpinned).toEqual([])
    expect(SkillLayerRegistry.peek(sessionID, "plan-builder")?.pinned).toBe(true)
  })

  it("handles empty registry gracefully", async () => {
    const result = await reconcileMandatoryList({
      sessionID: "ses_empty_registry",
      desired: ["plan-builder"],
    })
    expect(result.unpinned).toEqual([])
  })

  it("distinguishes agents_md vs coding_txt keepRules (both treated as mandatory)", async () => {
    const sessionID = `ses_reconcile_both_${Date.now().toString(36)}`
    SkillLayerRegistry.recordLoaded(sessionID, "from-agents", {
      content: "a",
      keepRules: [KEEP_RULES.AGENTS_MD],
    })
    SkillLayerRegistry.pin(sessionID, "from-agents")
    SkillLayerRegistry.recordLoaded(sessionID, "from-coding", {
      content: "c",
      keepRules: [KEEP_RULES.CODING_TXT],
    })
    SkillLayerRegistry.pin(sessionID, "from-coding")

    const result = await reconcileMandatoryList({
      sessionID,
      desired: [],
    })

    expect(result.unpinned.sort()).toEqual(["from-agents", "from-coding"])
  })
})

describe("KEEP_RULES constants", () => {
  it("exports stable keepRule tags for registry integration", () => {
    expect(KEEP_RULES.AGENTS_MD).toBe("mandatory:agents_md")
    expect(KEEP_RULES.CODING_TXT).toBe("mandatory:coding_txt")
  })
})

describe("parseMandatorySkills — dedup semantics", () => {
  it("duplicate skill name within single block — deduped", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "- plan-builder",
      "- plan-builder",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["plan-builder"])
  })

  it("skill order reflects first occurrence across merged blocks", () => {
    const text = [
      "<!-- opencode:mandatory-skills -->",
      "- B",
      "- A",
      "<!-- /opencode:mandatory-skills -->",
      "<!-- opencode:mandatory-skills -->",
      "- C",
      "- A",
      "<!-- /opencode:mandatory-skills -->",
    ].join("\n")
    expect(parseMandatorySkills(text)).toEqual(["B", "A", "C"])
  })
})
