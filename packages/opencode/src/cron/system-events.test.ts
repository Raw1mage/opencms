import { describe, expect, it, beforeEach } from "bun:test"
import { SystemEvents } from "./system-events"

describe("SystemEvents", () => {
  beforeEach(() => {
    SystemEvents.clearAll()
  })

  it("starts with empty queue", () => {
    expect(SystemEvents.size("ses-1")).toBe(0)
    expect(SystemEvents.hasPending("ses-1")).toBe(false)
  })

  it("enqueues and drains events", () => {
    SystemEvents.enqueue("event-1", { sessionKey: "ses-1" })
    SystemEvents.enqueue("event-2", { sessionKey: "ses-1" })

    expect(SystemEvents.size("ses-1")).toBe(2)
    expect(SystemEvents.hasPending("ses-1")).toBe(true)

    const events = SystemEvents.drain("ses-1")
    expect(events.length).toBe(2)
    expect(events[0].text).toBe("event-1")
    expect(events[1].text).toBe("event-2")

    // Queue should be empty after drain
    expect(SystemEvents.size("ses-1")).toBe(0)
    expect(SystemEvents.hasPending("ses-1")).toBe(false)
  })

  it("peek does not remove events", () => {
    SystemEvents.enqueue("hello", { sessionKey: "ses-1" })

    const peeked = SystemEvents.peek("ses-1")
    expect(peeked.length).toBe(1)
    expect(SystemEvents.size("ses-1")).toBe(1)
  })

  it("deduplicates consecutive identical texts", () => {
    SystemEvents.enqueue("same text", { sessionKey: "ses-1" })
    SystemEvents.enqueue("same text", { sessionKey: "ses-1" })
    SystemEvents.enqueue("same text", { sessionKey: "ses-1" })

    expect(SystemEvents.size("ses-1")).toBe(1)
  })

  it("does not deduplicate non-consecutive identical texts", () => {
    SystemEvents.enqueue("A", { sessionKey: "ses-1" })
    SystemEvents.enqueue("B", { sessionKey: "ses-1" })
    SystemEvents.enqueue("A", { sessionKey: "ses-1" })

    expect(SystemEvents.size("ses-1")).toBe(3)
  })

  it("enforces max 20 events per session", () => {
    for (let i = 0; i < 25; i++) {
      SystemEvents.enqueue(`event-${i}`, { sessionKey: "ses-1" })
    }

    expect(SystemEvents.size("ses-1")).toBe(20)
    // Oldest events should be dropped
    const events = SystemEvents.drain("ses-1")
    expect(events[0].text).toBe("event-5")
    expect(events[19].text).toBe("event-24")
  })

  it("isolates events by session key", () => {
    SystemEvents.enqueue("a", { sessionKey: "ses-1" })
    SystemEvents.enqueue("b", { sessionKey: "ses-2" })

    expect(SystemEvents.size("ses-1")).toBe(1)
    expect(SystemEvents.size("ses-2")).toBe(1)

    const e1 = SystemEvents.drain("ses-1")
    expect(e1[0].text).toBe("a")
    expect(SystemEvents.size("ses-2")).toBe(1) // unaffected
  })

  it("detects context change", () => {
    SystemEvents.enqueue("ev", { sessionKey: "ses-1", contextKey: "ctx-A" })

    expect(SystemEvents.isContextChanged("ses-1", "ctx-A")).toBe(false)
    expect(SystemEvents.isContextChanged("ses-1", "ctx-B")).toBe(true)
  })

  it("returns false for context change when no events", () => {
    expect(SystemEvents.isContextChanged("ses-1", "ctx-A")).toBe(false)
  })

  it("clear removes all events for a session", () => {
    SystemEvents.enqueue("x", { sessionKey: "ses-1" })
    SystemEvents.clear("ses-1")
    expect(SystemEvents.size("ses-1")).toBe(0)
  })

  it("clearAll removes all queues", () => {
    SystemEvents.enqueue("a", { sessionKey: "ses-1" })
    SystemEvents.enqueue("b", { sessionKey: "ses-2" })
    SystemEvents.clearAll()
    expect(SystemEvents.size("ses-1")).toBe(0)
    expect(SystemEvents.size("ses-2")).toBe(0)
  })

  it("drain returns empty array for non-existent session", () => {
    expect(SystemEvents.drain("non-existent")).toEqual([])
  })
})
