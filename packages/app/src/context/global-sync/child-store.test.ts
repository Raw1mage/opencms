import { describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { createChildStoreManager } from "./child-store"

mock.module("@/utils/persist", () => ({
  Persist: {
    workspace: (directory: string, key: string) => ({ key: `${directory}:${key}` }),
  },
  persisted: (_target: unknown, store: ReturnType<typeof createStore>) => [...store, () => {}, () => true] as const,
}))

const child = () => createStore({} as State)
const owner = createRoot(() => getOwner())

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      markStats() {},
      incrementEvictions() {},
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })
})
