import { describe, expect, test } from "bun:test"
import {
  assembleBundles,
  buildEnvironmentContextFragment,
  buildOpencodeProtocolFragment,
  buildRoleIdentityFragment,
  buildUserInstructionsFragment,
  ENVIRONMENT_CONTEXT_CLOSE_TAG,
  ENVIRONMENT_CONTEXT_OPEN_TAG,
  OPENCODE_PROTOCOL_OPEN_TAG,
  renderFragment,
  ROLE_IDENTITY_OPEN_TAG,
  USER_INSTRUCTIONS_END_MARKER,
  USER_INSTRUCTIONS_START_MARKER,
  type ContextFragment,
} from "../../src/session/context-fragments"

describe("context-fragments — fragment rendering", () => {
  test("renderFragment wraps body with markers", () => {
    const f = buildEnvironmentContextFragment({
      cwd: "/home/pkcs12/projects/opencode",
      shell: "bash",
      currentDate: "Mon May 11 2026",
      timezone: "Asia/Taipei",
    })
    const out = renderFragment(f)
    expect(out.startsWith(ENVIRONMENT_CONTEXT_OPEN_TAG)).toBe(true)
    expect(out.endsWith(ENVIRONMENT_CONTEXT_CLOSE_TAG)).toBe(true)
    expect(out).toContain("<cwd>/home/pkcs12/projects/opencode</cwd>")
    expect(out).toContain("<shell>bash</shell>")
    expect(out).toContain("<current_date>Mon May 11 2026</current_date>")
    expect(out).toContain("<timezone>Asia/Taipei</timezone>")
  })

  test("renderFragment skips wrapping when both markers empty", () => {
    const f: ContextFragment = {
      id: "test:plain",
      role: "developer",
      startMarker: "",
      endMarker: "",
      body: "plain content",
      source: "opencode-only",
    }
    expect(renderFragment(f)).toBe("plain content")
  })

  test("renderFragment returns empty string for empty body", () => {
    const f: ContextFragment = {
      id: "test:empty",
      role: "user",
      startMarker: "<x>",
      endMarker: "</x>",
      body: "",
      source: "upstream",
    }
    expect(renderFragment(f)).toBe("")
  })
})

describe("context-fragments — UserInstructions matches upstream wire shape", () => {
  test("body composition mirrors upstream user_instructions.rs", () => {
    const f = buildUserInstructionsFragment({
      scope: "project",
      directory: "/home/pkcs12/projects/foo",
      text: "Be terse.",
    })
    expect(f.role).toBe("user")
    expect(f.startMarker).toBe(USER_INSTRUCTIONS_START_MARKER)
    expect(f.endMarker).toBe(USER_INSTRUCTIONS_END_MARKER)
    // Upstream body() = format!("{}\n\n<INSTRUCTIONS>\n{}\n", directory, text)
    expect(f.body).toBe("/home/pkcs12/projects/foo\n\n<INSTRUCTIONS>\nBe terse.\n")
    const rendered = renderFragment(f)
    expect(rendered).toBe(
      "# AGENTS.md instructions for /home/pkcs12/projects/foo\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>",
    )
  })

  test("global vs project scope produce distinct ids", () => {
    const g = buildUserInstructionsFragment({ scope: "global", directory: "~/.config/opencode", text: "G" })
    const p = buildUserInstructionsFragment({ scope: "project", directory: "/repo", text: "P" })
    expect(g.id).toBe("agents_md:global")
    expect(p.id).toBe("agents_md:project")
  })
})

describe("context-fragments — assembleBundles", () => {
  test("groups fragments by role and preserves insertion order", () => {
    const result = assembleBundles([
      buildRoleIdentityFragment({ isSubagent: false }),
      buildOpencodeProtocolFragment({ text: "OpenCode protocol body." }),
      buildUserInstructionsFragment({ scope: "global", directory: "~/.config/opencode", text: "global rules" }),
      buildUserInstructionsFragment({ scope: "project", directory: "/repo", text: "project rules" }),
      buildEnvironmentContextFragment({
        cwd: "/repo",
        shell: "bash",
        currentDate: "Mon May 11 2026",
      }),
    ])
    expect(result.developerBundle).not.toBeNull()
    expect(result.userBundle).not.toBeNull()
    expect(result.developerBundle!.role).toBe("developer")
    expect(result.userBundle!.role).toBe("user")
    expect(result.developerBundle!.fragmentIds).toEqual(["role_identity", "opencode_protocol"])
    expect(result.userBundle!.fragmentIds).toEqual(["agents_md:global", "agents_md:project", "environment_context"])
  })

  test("returns null bundle for an empty role list", () => {
    const result = assembleBundles([buildRoleIdentityFragment({ isSubagent: true })])
    expect(result.developerBundle).not.toBeNull()
    expect(result.userBundle).toBeNull()
  })

  test("drops fragments with empty body", () => {
    const result = assembleBundles([
      buildRoleIdentityFragment({ isSubagent: false }),
      buildOpencodeProtocolFragment({ text: "" }),
    ])
    expect(result.developerBundle!.fragmentIds).toEqual(["role_identity"])
  })

  test("throws on fragment id collision (E3 contract)", () => {
    expect(() =>
      assembleBundles([
        buildUserInstructionsFragment({ scope: "global", directory: "/a", text: "x" }),
        buildUserInstructionsFragment({ scope: "global", directory: "/a", text: "y" }),
      ]),
    ).toThrow(/duplicate fragment id/)
  })

  test("returns identical bundle text for identical inputs (byte-stability)", () => {
    const make = () =>
      assembleBundles([
        buildRoleIdentityFragment({ isSubagent: false }),
        buildOpencodeProtocolFragment({ text: "OpenCode protocol body." }),
        buildEnvironmentContextFragment({
          cwd: "/repo",
          shell: "bash",
          currentDate: "Mon May 11 2026",
          timezone: "Asia/Taipei",
        }),
      ])
    const a = make()
    const b = make()
    expect(a.developerBundle!.parts).toEqual(b.developerBundle!.parts)
    expect(a.userBundle!.parts).toEqual(b.userBundle!.parts)
  })
})

describe("context-fragments — RoleIdentity reflects subagent vs main", () => {
  test("subagent body contains 'Current Role: Subagent'", () => {
    const f = buildRoleIdentityFragment({ isSubagent: true })
    expect(f.role).toBe("developer")
    expect(f.startMarker).toBe(ROLE_IDENTITY_OPEN_TAG)
    expect(f.body).toContain("Current Role: Subagent")
    expect(f.body).toContain("Session Context: Sub-task")
  })

  test("main body contains 'Current Role: Main Agent'", () => {
    const f = buildRoleIdentityFragment({ isSubagent: false })
    expect(f.body).toContain("Current Role: Main Agent")
    expect(f.body).toContain("Session Context: Main-task Orchestration")
  })
})

describe("context-fragments — OpencodeProtocolInstructions", () => {
  test("renders SYSTEM.md text inside <opencode_protocol> wrapper", () => {
    const f = buildOpencodeProtocolFragment({ text: "Read before write.\nAbsolute paths only." })
    expect(f.role).toBe("developer")
    expect(f.startMarker).toBe(OPENCODE_PROTOCOL_OPEN_TAG)
    expect(f.source).toBe("opencode-only")
    const rendered = renderFragment(f)
    expect(rendered).toBe("<opencode_protocol>Read before write.\nAbsolute paths only.</opencode_protocol>")
  })
})
