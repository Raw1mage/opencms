/**
 * harness/freerun-mode — DD-19 dynamic tool catalog filtering.
 *
 * At planning time the LLM may declare `relevant_tools: ["bash","read",…]`
 * on a child node. When that node is later picked for execution, the engine
 * filters the available tool catalog down to that subset. This narrows
 * attention and matches the senior-engineer intuition: «I've decided this
 * step only needs grep+read».
 *
 * Rules:
 *   - `relevant_tools` absent (undefined)  → full catalog passes through
 *   - `relevant_tools` present but empty   → engine sends NO tools (model
 *                                            is being asked to think, not act)
 *   - `relevant_tools` present + non-empty → catalog ∩ relevant_tools
 *   - Unknown names in `relevant_tools`    → logged via `unknown` callback,
 *                                            silently dropped from the
 *                                            filtered catalog (the model
 *                                            doesn't see ghosts)
 *
 * The engine layer (not this module) is responsible for separately
 * informing the model in the prompt when relevant_tools is empty so the
 * model doesn't waste tokens proposing tool calls.
 */

export namespace ToolFilter {
  /** Shape of a tool record we filter on. Only `name` is consumed; other fields pass through opaquely. */
  export interface ToolRecord {
    name: string
    [k: string]: unknown
  }

  export interface FilterOptions {
    /** From `node.relevant_tools`. */
    relevantTools: readonly string[] | undefined
    /** Optional sink for unknown tool names (telemetry / warnings). */
    onUnknown?: (name: string) => void
  }

  export interface FilterResult<T extends ToolRecord> {
    /** Filtered catalog in the order it should be exposed to the model. */
    tools: T[]
    /** True when the empty-array (think-only) policy is in effect. */
    suppressAll: boolean
    /** Names found in `relevant_tools` that did not match any catalog entry. */
    unknown: string[]
  }

  export function filter<T extends ToolRecord>(catalog: readonly T[], opts: FilterOptions): FilterResult<T> {
    const { relevantTools, onUnknown } = opts

    // Case 1: undefined → pass through.
    if (relevantTools === undefined) {
      return { tools: [...catalog], suppressAll: false, unknown: [] }
    }

    // Case 2: empty → suppress everything (think-only).
    if (relevantTools.length === 0) {
      return { tools: [], suppressAll: true, unknown: [] }
    }

    // Case 3: filter catalog ∩ relevantTools, preserving relevantTools order.
    const catalogByName = new Map<string, T>()
    for (const t of catalog) catalogByName.set(t.name, t)
    const out: T[] = []
    const unknown: string[] = []
    for (const name of relevantTools) {
      const hit = catalogByName.get(name)
      if (hit !== undefined) {
        out.push(hit)
      } else {
        unknown.push(name)
        onUnknown?.(name)
      }
    }
    return { tools: out, suppressAll: false, unknown }
  }
}
