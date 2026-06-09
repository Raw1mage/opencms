/**
 * Matrix tests for assembleBetas() — claude-provider-beta-fingerprint-realign.
 *
 * Reads test-vectors.json from the spec package and asserts byte-equivalent
 * output for each (model × auth × provider × env × interactive) scenario.
 *
 * Source-of-truth: specs/claude-provider-beta-fingerprint-realign/test-vectors.json
 * Spec: specs/claude-provider-beta-fingerprint-realign/spec.md
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  assembleBetas,
  buildBillingHeader,
  isFirstPartyish,
  isHaikuModel,
  modelIsOpus48,
  modelSupportsContextManagement,
  supports1MContext,
  type AssembleBetasOptions,
  type ProviderRoute,
} from "../src/protocol.js"

interface MatrixCase {
  name: string
  input: AssembleBetasOptions | { _assertion: string; _runtime: string }
  expected: string[] | string
  _note?: string
  _comment?: string
}

// The spec package was archived to specs/_archive/ but assembleBetas() is still
// live code, so this matrix test stays valid — only the fixture path moved.
const SPEC_VECTORS_PATH = resolve(
  __dirname,
  "../../../specs/_archive/claude-provider-beta-fingerprint-realign/test-vectors.json",
)

const raw = readFileSync(SPEC_VECTORS_PATH, "utf-8")
const allCases: MatrixCase[] = JSON.parse(raw)

// Filter out leading metadata comment + non-runnable guardrail entries
const matrixCases = allCases.filter(
  (c): c is MatrixCase & { input: AssembleBetasOptions; expected: string[] } =>
    c.input !== undefined &&
    typeof c.expected !== "string" &&
    typeof c.input === "object" &&
    "isOAuth" in c.input &&
    typeof (c.input as { isOAuth: unknown }).isOAuth === "boolean",
)

describe("assembleBetas matrix (vs upstream claude-code 2.1.112 ZR1)", () => {
  for (const c of matrixCases) {
    test(c.name, () => {
      const actual = assembleBetas(c.input)
      expect(actual).toEqual(c.expected)
    })
  }
})

describe("predicate helpers", () => {
  test("isHaikuModel: claude-haiku-* matches", () => {
    expect(isHaikuModel("claude-haiku-4-5-20251001")).toBe(true)
    expect(isHaikuModel("claude-3-haiku-20240307")).toBe(true)
    expect(isHaikuModel("CLAUDE-HAIKU-4")).toBe(true)
  })
  test("isHaikuModel: opus/sonnet do not match", () => {
    expect(isHaikuModel("claude-opus-4-7")).toBe(false)
    expect(isHaikuModel("claude-sonnet-4-6")).toBe(false)
  })

  test("isFirstPartyish: includes mantle (per upstream $Q)", () => {
    expect(isFirstPartyish("firstParty")).toBe(true)
    expect(isFirstPartyish("anthropicAws")).toBe(true)
    expect(isFirstPartyish("foundry")).toBe(true)
    expect(isFirstPartyish("mantle")).toBe(true)
  })
  test("isFirstPartyish: bedrock and vertex are NOT firstPartyish", () => {
    expect(isFirstPartyish("bedrock")).toBe(false)
    expect(isFirstPartyish("vertex")).toBe(false)
  })

  test("supports1MContext: opus-4-7 matches (added in 4f6039bf1)", () => {
    expect(supports1MContext("claude-opus-4-7")).toBe(true)
    expect(supports1MContext("claude-opus-4-20250514")).toBe(true)
    expect(supports1MContext("claude-sonnet-4-6-20250627")).toBe(true)
    expect(supports1MContext("claude-haiku-4-5-20251001")).toBe(false)
    expect(supports1MContext("claude-3-opus-20240229")).toBe(false)
  })

  test("modelSupportsContextManagement: foundry always true", () => {
    expect(
      modelSupportsContextManagement("claude-3-opus-20240229", "foundry"),
    ).toBe(true)
  })
  test("modelSupportsContextManagement: firstPartyish excludes claude-3-", () => {
    expect(
      modelSupportsContextManagement("claude-3-opus-20240229", "firstParty"),
    ).toBe(false)
    expect(
      modelSupportsContextManagement("claude-opus-4-7", "firstParty"),
    ).toBe(true)
  })
  test("modelSupportsContextManagement: non-firstPartyish requires opus-4/sonnet-4/haiku-4", () => {
    expect(
      modelSupportsContextManagement("claude-opus-4-7", "bedrock"),
    ).toBe(true)
    expect(
      modelSupportsContextManagement("claude-3-opus-20240229", "bedrock"),
    ).toBe(false)
  })
})

describe("guardrail (DD-16) — provider.ts call site is OAuth-only", () => {
  test("provider.ts source contains the OAuth-only throw guard", () => {
    const providerSource = readFileSync(
      resolve(__dirname, "../src/provider.ts"),
      "utf-8",
    )
    // Two invariants of DD-16's enforcement:
    //   1. There is a throw that mentions DD-16
    //   2. The buildHeaders call hardcodes isOAuth: true (string literal)
    expect(providerSource).toMatch(/DD-16/)
    expect(providerSource).toMatch(/throw new Error/)
    expect(providerSource).toMatch(/isOAuth:\s*true/)
  })

  test("provider.ts does NOT compute isOAuth from a boolean expression", () => {
    const providerSource = readFileSync(
      resolve(__dirname, "../src/provider.ts"),
      "utf-8",
    )
    // No `isOAuth = ... ||` or `isOAuth: ...||...` or `isOAuth: !...`
    expect(providerSource).not.toMatch(/isOAuth\s*=\s*[^t]/)
    expect(providerSource).not.toMatch(/isOAuth:\s*\(/)
  })
})

describe("structural guardrails", () => {
  test("MINIMUM_BETAS export is gone", () => {
    const protocolSource = readFileSync(
      resolve(__dirname, "../src/protocol.ts"),
      "utf-8",
    )
    // Must not be exported, must not appear at all (we deleted the constant)
    expect(protocolSource).not.toMatch(/export\s+const\s+MINIMUM_BETAS/)
    expect(protocolSource).not.toMatch(/\bMINIMUM_BETAS\b/)
  })
})

// align-2.1.169 DD-1: mid-conversation-system gate (upstream O98)
describe("mid-conversation-system (opus-4-8 gate, align-2.1.169)", () => {
  const MCS = "mid-conversation-system-2026-04-07"
  const base = { isOAuth: true, provider: "firstParty" as ProviderRoute }

  test("opus-4-8 first-party OAuth includes it (TV-01)", () => {
    expect(assembleBetas({ ...base, modelId: "claude-opus-4-8" })).toContain(MCS)
  })
  test("opus-4-8[1m] alias still gated true (TV-02)", () => {
    expect(assembleBetas({ ...base, modelId: "claude-opus-4-8[1m]" })).toContain(MCS)
  })
  test("opus-4-8 date alias gated true", () => {
    expect(assembleBetas({ ...base, modelId: "claude-opus-4-8-20251101" })).toContain(MCS)
  })
  test("opus-4-7 / sonnet-4-6 / haiku-4-5 exclude it (TV-03/04)", () => {
    for (const modelId of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(assembleBetas({ ...base, modelId })).not.toContain(MCS)
    }
  })
  test("explicit midConversationSystem:false disables on opus-4-8 (TV-05)", () => {
    expect(
      assembleBetas({ ...base, modelId: "claude-opus-4-8", midConversationSystem: false }),
    ).not.toContain(MCS)
  })
  test("hipaa disables on opus-4-8 (TV-06)", () => {
    expect(
      assembleBetas({ ...base, modelId: "claude-opus-4-8", hipaa: true }),
    ).not.toContain(MCS)
  })
  test("non-first-party (bedrock) excludes it even on opus-4-8 (TV-07)", () => {
    expect(
      assembleBetas({ isOAuth: true, provider: "bedrock", modelId: "claude-opus-4-8" }),
    ).not.toContain(MCS)
  })
  test("modelIsOpus48 normalizes aliases", () => {
    expect(modelIsOpus48("claude-opus-4-8")).toBe(true)
    expect(modelIsOpus48("CLAUDE-OPUS-4-8[1m]")).toBe(true)
    expect(modelIsOpus48("us-claude-opus-4-8-20251101")).toBe(true)
    expect(modelIsOpus48("claude-opus-4-7")).toBe(false)
  })
})

// align-2.1.169 DD-2: billing-header conditional segments
describe("buildBillingHeader (cc_workload / cc_is_subagent, align-2.1.169)", () => {
  const C = "the quick brown fox jumps"

  test("no options → byte-identical, no new segments (TV-08, AC5)", () => {
    const h = buildBillingHeader(C, "cli")
    expect(h).toMatch(/^cc_version=[^;]+; cc_entrypoint=cli; cch=00000;$/)
    expect(h).not.toContain("cc_workload")
    expect(h).not.toContain("cc_is_subagent")
  })

  test("empty options object is also byte-identical to no-options", () => {
    expect(buildBillingHeader(C, "cli", {})).toBe(buildBillingHeader(C, "cli"))
  })

  test("workload appends cc_workload (TV-09, AC6)", () => {
    expect(buildBillingHeader(C, "cli", { workload: "cron" })).toEndWith(
      " cc_workload=cron;",
    )
  })

  test("subagent non-main appends cc_is_subagent (TV-10, AC7)", () => {
    expect(
      buildBillingHeader(C, "cli", { isSubagent: true, isMainSession: false }),
    ).toEndWith(" cc_is_subagent=true;")
  })

  test("main-session subagent flag → no cc_is_subagent (TV-11)", () => {
    expect(
      buildBillingHeader(C, "cli", { isSubagent: true, isMainSession: true }),
    ).not.toContain("cc_is_subagent")
  })

  test("both segments, order: cc_workload before cc_is_subagent", () => {
    const h = buildBillingHeader(C, "cli", {
      workload: "cron",
      isSubagent: true,
      isMainSession: false,
    })
    expect(h).toBe(
      `${buildBillingHeader(C, "cli")} cc_workload=cron; cc_is_subagent=true;`,
    )
  })
})

void join // satisfy unused-import in some bun versions
