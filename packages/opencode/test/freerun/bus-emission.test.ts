import { describe, expect, test } from "bun:test"
import * as path from "path"

describe("freerun state mutation Bus coverage", () => {
  test("runtime files that mutate ContextNode/session state emit freerun Bus events", async () => {
    const root = path.join(import.meta.dir, "..", "..", "src", "freerun", "runtime")
    const files = ["engine.ts", "iterate.ts", "consolidate.ts"]
    const mutationMarkers = ["NodeFS.write(", "MetaFS.write(", "MetaFS.patch(", "Tree.archiveSubtree("]

    const uncovered: string[] = []
    for (const file of files) {
      const filePath = path.join(root, file)
      const text = await Bun.file(filePath).text()
      if (!mutationMarkers.some((marker) => text.includes(marker))) continue
      if (!text.includes("FreerunBus.emit.")) uncovered.push(file)
    }

    expect(uncovered).toEqual([])
  })
})
