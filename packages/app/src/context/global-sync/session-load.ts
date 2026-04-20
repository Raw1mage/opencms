import type { RootLoadArgs } from "./types"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  // Root-only load: only top-level sessions come from the server here.
  // Subsessions (children) are lazy-loaded on demand when the user expands
  // a tree, NOT fetched up front — otherwise 20 projects × hundreds of
  // subsessions each reliably OOMs the tab at bootstrap. See regression
  // introduced in c32b9612b which removed `roots: true`; restored here.
  // Fallback path also keeps `roots: true` AND `limit` so we never
  // accidentally load the entire 2000+ session corpus.
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch {
    input.onFallback()
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
