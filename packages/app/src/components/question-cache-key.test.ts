import { describe, expect, test } from "bun:test"
import { canonicalJson, fnv1a32, questionCacheKey } from "./question-cache-key"

const baseQuestion = {
  question: "Pick one?",
  header: "Pick",
  options: [
    { label: "A", description: "first" },
    { label: "B", description: "second" },
  ],
  multiple: false,
  custom: true,
}

describe("canonicalJson", () => {
  test("emits keys in sorted order regardless of input order", () => {
    const a = canonicalJson({ b: 1, a: 2 })
    const b = canonicalJson({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  test("recurses into nested objects and arrays", () => {
    const x = canonicalJson({ outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] })
    expect(x).toBe('{"list":[{"x":2,"y":1}],"outer":{"a":2,"z":1}}')
  })

  test("omits undefined fields so optional absent keys don't change the hash", () => {
    const a = canonicalJson({ x: 1, y: undefined })
    const b = canonicalJson({ x: 1 })
    expect(a).toBe(b)
  })

  test("primitives, null, boolean, number serialize normally", () => {
    expect(canonicalJson(null)).toBe("null")
    expect(canonicalJson(true)).toBe("true")
    expect(canonicalJson(42)).toBe("42")
    expect(canonicalJson("hi")).toBe('"hi"')
  })
})

describe("fnv1a32", () => {
  test("produces stable 8-char hex output", () => {
    const h = fnv1a32("hello world")
    expect(h).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1a32("hello world")).toBe(h)
  })

  test("differs for different inputs", () => {
    expect(fnv1a32("alpha")).not.toBe(fnv1a32("beta"))
  })

  test("handles empty string", () => {
    expect(fnv1a32("")).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("questionCacheKey (Requirement B)", () => {
  test("TV4: identical questions on same session produce same key (AI re-ask restores cache)", () => {
    const a = questionCacheKey({ sessionID: "ses_A", questions: [baseQuestion] })
    const b = questionCacheKey({ sessionID: "ses_A", questions: [baseQuestion] })
    expect(a).toBe(b)
    expect(a).toMatch(/^ses_A:[0-9a-f]{8}$/)
  })

  test("TV5: different question content produces different key", () => {
    const q1 = { ...baseQuestion, question: "A?" }
    const q2 = { ...baseQuestion, question: "B?" }
    const k1 = questionCacheKey({ sessionID: "ses_A", questions: [q1] })
    const k2 = questionCacheKey({ sessionID: "ses_A", questions: [q2] })
    expect(k1).not.toBe(k2)
  })

  test("TV6: same questions on different sessions produce different keys", () => {
    const k1 = questionCacheKey({ sessionID: "ses_A", questions: [baseQuestion] })
    const k2 = questionCacheKey({ sessionID: "ses_B", questions: [baseQuestion] })
    expect(k1).not.toBe(k2)
    // same hash portion, different sessionID prefix
    expect(k1.split(":")[1]).toBe(k2.split(":")[1])
  })

  test("option order matters (options are positional)", () => {
    const q1 = {
      ...baseQuestion,
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
    }
    const q2 = {
      ...baseQuestion,
      options: [
        { label: "B", description: "second" },
        { label: "A", description: "first" },
      ],
    }
    const k1 = questionCacheKey({ sessionID: "ses_A", questions: [q1] })
    const k2 = questionCacheKey({ sessionID: "ses_A", questions: [q2] })
    expect(k1).not.toBe(k2)
  })

  test("key order within option object does not matter (canonical JSON)", () => {
    const q1 = {
      ...baseQuestion,
      options: [{ label: "A", description: "first" }],
    }
    const q2 = {
      ...baseQuestion,
      // Force a different in-memory key order by reconstructing; JS engines
      // preserve insertion order, so canonicalJson must sort them.
      options: [{ description: "first", label: "A" }],
    }
    const k1 = questionCacheKey({ sessionID: "ses_A", questions: [q1] })
    const k2 = questionCacheKey({ sessionID: "ses_A", questions: [q2] })
    expect(k1).toBe(k2)
  })

  test("multiple/custom flags participate in the hash", () => {
    const q1 = { ...baseQuestion, multiple: false }
    const q2 = { ...baseQuestion, multiple: true }
    const k1 = questionCacheKey({ sessionID: "ses_A", questions: [q1] })
    const k2 = questionCacheKey({ sessionID: "ses_A", questions: [q2] })
    expect(k1).not.toBe(k2)
  })
})
