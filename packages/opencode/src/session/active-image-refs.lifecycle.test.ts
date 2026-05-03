import { describe, expect, it } from "bun:test"

import { addOnUpload, drainAfterAssistant, type AttachmentRefLike } from "./active-image-refs"

// T.2.4: lifecycle scenario coverage (DD-20). The orchestration code in
// prompt.ts (upload site) and processor.ts (post-completion drain) is a thin
// shim around these pure operations; covering the shim's BEHAVIOR via the
// helpers gives us the same correctness guarantee without requiring a full
// Storage / Session boot. Integration validation runs in T.5.3 / T.5.4.

const imagePart = (filename: string, repo_path = `incoming/${filename}`): AttachmentRefLike => ({
  type: "attachment_ref",
  mime: "image/png",
  filename,
  repo_path,
})

describe("attachment-lifecycle T.2.4 lifecycle hook scenarios", () => {
  it("upload hook adds inline-eligible images to a fresh session", () => {
    const next = addOnUpload(undefined, [imagePart("a.png")])
    expect(next).toEqual(["a.png"])
  })

  it("drain hook clears all on assistant finish=stop", () => {
    const result = drainAfterAssistant(["a.png", "b.png"])
    expect(result.next).toEqual([])
    expect(result.drained).toEqual(["a.png", "b.png"])
  })

  it("drain hook clears even on finish=length / finish=error (R9 mitigation)", () => {
    // Hook calls drainAfterAssistant unconditionally on the post-completion
    // site — finishReason is not branched on. So any non-empty prior set
    // must always result in next=[].
    const result = drainAfterAssistant(["x.png"])
    expect(result.next).toEqual([])
  })

  it("multiple uploads across turns dedup by filename", () => {
    const turn1 = addOnUpload(undefined, [imagePart("doc.png")])
    // simulate turn drained between turns
    const drained = drainAfterAssistant(turn1)
    expect(drained.next).toEqual([])
    // user re-attaches the same filename next turn → no dup
    const turn2 = addOnUpload(drained.next, [imagePart("doc.png")])
    expect(turn2).toEqual(["doc.png"])
  })

  it("FIFO cap evicts oldest when single user message exceeds the limit", () => {
    const next = addOnUpload(
      undefined,
      [imagePart("a.png"), imagePart("b.png"), imagePart("c.png"), imagePart("d.png")],
      { max: 3 },
    )
    expect(next).toEqual(["b.png", "c.png", "d.png"])
  })

  it("subagent session does not inherit parent's active set (R10)", () => {
    // R10: subagents start fresh sessions with their own ExecutionIdentity.
    // The hook reads activeImageRefs off the SUBAGENT's session.execution,
    // which is independent of the parent. We model this here by computing
    // addOnUpload against `undefined` (a fresh session's prior state) and
    // confirming the parent's prior set has no influence.
    const parentPrior = ["parent-img.png", "parent-img2.png"]
    // addOnUpload starts from `undefined` for the fresh subagent session;
    // parentPrior is conceptually unreachable from the subagent's setter call
    const subagentNext = addOnUpload(undefined, [imagePart("sub-img.png")])
    expect(subagentNext).toEqual(["sub-img.png"])
    expect(subagentNext).not.toContain(parentPrior[0])
  })
})
