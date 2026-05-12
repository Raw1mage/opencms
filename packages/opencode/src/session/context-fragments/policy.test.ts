import { describe, expect, it } from "bun:test"
import {
  FRAGMENT_POLICY_CANONICAL,
  FragmentPolicySchema,
  LEGACY_SESSION_STABLE_LABEL,
  type FragmentPolicy,
} from "./policy"

describe("FragmentPolicy taxonomy", () => {
  it("accepts the four canonical values", () => {
    expect(FragmentPolicySchema.safeParse("always_on").success).toBe(true)
    expect(FragmentPolicySchema.safeParse("conversation_stable").success).toBe(true)
    expect(FragmentPolicySchema.safeParse("chain_stable").success).toBe(true)
    expect(FragmentPolicySchema.safeParse("once_after_chain_break").success).toBe(true)
  })

  it("accepts the two retained legacy labels (decay, dynamic)", () => {
    expect(FragmentPolicySchema.safeParse("decay").success).toBe(true)
    expect(FragmentPolicySchema.safeParse("dynamic").success).toBe(true)
  })

  it("rejects the deprecated 'session_stable' label", () => {
    expect(FragmentPolicySchema.safeParse(LEGACY_SESSION_STABLE_LABEL).success).toBe(false)
  })

  it("rejects arbitrary unknown values", () => {
    expect(FragmentPolicySchema.safeParse("made_up_policy").success).toBe(false)
    expect(FragmentPolicySchema.safeParse("").success).toBe(false)
  })

  it("FRAGMENT_POLICY_CANONICAL exposes the four canonical labels", () => {
    const canonical = Object.values(FRAGMENT_POLICY_CANONICAL) as FragmentPolicy[]
    expect(canonical).toContain("always_on")
    expect(canonical).toContain("conversation_stable")
    expect(canonical).toContain("chain_stable")
    expect(canonical).toContain("once_after_chain_break")
    expect(canonical).toHaveLength(4)
  })

  it("LEGACY_SESSION_STABLE_LABEL is documented as the migration source", () => {
    expect(LEGACY_SESSION_STABLE_LABEL).toBe("session_stable")
  })
})
