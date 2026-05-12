import { describe, expect, it } from "bun:test"
import {
  buildChainInitNoticeFragment,
  CHAIN_INIT_NOTICE_CLOSE_TAG,
  CHAIN_INIT_NOTICE_OPEN_TAG,
  decideChainInitInjection,
} from "./chain-init-notice"
import { renderFragment } from "./fragment"
import type { CommitmentDigest } from "../continuation/commitment-digest"
import type { PendingContinuationInjection } from "../continuation/pending-injection"

const sampleDigest: CommitmentDigest = {
  entries: [
    {
      call_id: "call_p1",
      tool: "apply_patch",
      args_brief: "foo/bar.md",
      status: "completed",
      output_summary: "✓ Success",
      completed_at: 1000,
    },
    {
      call_id: "call_p2",
      tool: "apply_patch",
      args_brief: "baz/qux.ts",
      status: "completed",
      output_summary: "✓ Success",
      completed_at: 1001,
    },
  ],
  bodyCharCount: 200,
  capturedAt: 1002,
  sourceMessageCount: 50,
}

describe("chain-init-notice / decideChainInitInjection", () => {
  it("null pending → null decision", () => {
    expect(decideChainInitInjection(null)).toBeNull()
  })

  it("amnesia-only pending → null decision (chain-init not requested)", () => {
    const pending: PendingContinuationInjection = {
      chainInit: false,
      amnesia: true,
      digest: null,
      reason: "compaction_narrative",
      ts: 1,
    }
    expect(decideChainInitInjection(pending)).toBeNull()
  })

  it("chainInit-true pending → returns the marker", () => {
    const pending: PendingContinuationInjection = {
      chainInit: true,
      amnesia: false,
      digest: sampleDigest,
      reason: "account_switch",
      ts: 1,
    }
    expect(decideChainInitInjection(pending)).toBe(pending)
  })

  it("both chainInit + amnesia → returns the marker (chain-init wins)", () => {
    const pending: PendingContinuationInjection = {
      chainInit: true,
      amnesia: true,
      digest: sampleDigest,
      reason: "account_switch",
      ts: 1,
    }
    expect(decideChainInitInjection(pending)).toBe(pending)
  })
})

describe("chain-init-notice / buildChainInitNoticeFragment", () => {
  it("renders markers", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.startMarker).toBe(CHAIN_INIT_NOTICE_OPEN_TAG)
    expect(f.endMarker).toBe(CHAIN_INIT_NOTICE_CLOSE_TAG)
  })

  it("emits the CHAIN-RESET NOTICE body header", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.body).toContain("CHAIN-RESET NOTICE")
  })

  it("names the reason humanely", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.body).toContain("account switched")
  })

  it("for empty-response recovery, reason text is descriptive", () => {
    const f = buildChainInitNoticeFragment({ reason: "empty_response_recovery", digest: sampleDigest })
    expect(f.body).toContain("empty-response recovery")
  })

  it("with digest → body contains the digest entries", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.body).toContain("call_p1")
    expect(f.body).toContain("call_p2")
    expect(f.body).toContain("foo/bar.md")
    expect(f.body).toContain("Recent committed actions")
  })

  it("without digest (null) → body contains the sentinel marker", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: null })
    expect(f.body).toContain("commitment_digest_unavailable")
  })

  it("with anchorId → body contains the anchor tag", () => {
    const f = buildChainInitNoticeFragment({
      reason: "compaction_narrative",
      digest: sampleDigest,
      anchorId: "anchor_xyz",
    })
    expect(f.body).toContain("<anchor_id>anchor_xyz</anchor_id>")
  })

  it("without anchorId → body has no anchor tag", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.body).not.toContain("<anchor_id>")
  })

  it("body mentions recall(tool_call_id) affordance", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.body).toContain("recall(tool_call_id)")
  })

  it("body warns against silent re-do (the post-rebind read-loop class)", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: null })
    expect(f.body).toContain("Do NOT silently re-do")
  })

  it("role is user", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.role).toBe("user")
  })

  it("source is opencode-only", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    expect(f.source).toBe("opencode-only")
  })

  it("renderFragment wraps the body in markers", () => {
    const f = buildChainInitNoticeFragment({ reason: "account_switch", digest: sampleDigest })
    const rendered = renderFragment(f)
    expect(rendered.startsWith(CHAIN_INIT_NOTICE_OPEN_TAG)).toBe(true)
    expect(rendered.endsWith(CHAIN_INIT_NOTICE_CLOSE_TAG)).toBe(true)
  })
})
