/**
 * Pure selection-model helpers for the desktop File Explorer.
 *
 * These helpers translate user input (single click, Shift-click, Ctrl-click,
 * checkbox toggle, header select-all, escape-to-clear) into a new selection
 * set + a new anchor path. They never touch the DOM and never mutate inputs;
 * the FileTree component owns the actual signals and applies the returned
 * shape via setStore / setSignal.
 *
 * Anchor model
 * ------------
 * Shift-click extends a contiguous range FROM the anchor TO the clicked row,
 * within the same flat list (typically the siblings of a single folder). The
 * caller passes the relevant flat list as `siblings`; helpers preserve any
 * paths in the existing selection that are NOT in `siblings`. A click that
 * lands outside `siblings` (e.g. cross-folder Shift-click in a recursive
 * tree) is treated as a plain select-only fallback — V1 does not support
 * cross-folder Shift ranges.
 *
 * Returned shape
 * --------------
 *   { selected: ReadonlySet<string>; anchor: string | undefined }
 *
 * Callers should use Object.is on `selected` to short-circuit setStore when
 * nothing changed.
 */

export interface SelectionState {
  selected: ReadonlySet<string>
  anchor: string | undefined
}

export type ClickModifiers = {
  shift?: boolean
  ctrlOrMeta?: boolean
}

const FROZEN_EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>())

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function withSelected(state: SelectionState, next: ReadonlySet<string>, anchor: string | undefined): SelectionState {
  if (setEquals(state.selected, next) && state.anchor === anchor) return state
  return { selected: next, anchor }
}

function rangeBetween(siblings: readonly string[], from: string, to: string): string[] {
  const a = siblings.indexOf(from)
  const b = siblings.indexOf(to)
  if (a === -1 || b === -1) return [to]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return siblings.slice(lo, hi + 1)
}

/**
 * Apply a click on the row body.
 *
 * - plain click: replace the selection with this single path; anchor = path
 * - Shift+click: extend a contiguous range from `anchor` to this path,
 *   within `siblings`. Paths in the existing selection that are NOT in
 *   `siblings` are preserved (so multi-folder accumulated selections survive
 *   a Shift-click within one folder). Falls back to plain click when
 *   `anchor` is missing or not in `siblings`.
 * - Ctrl/Cmd+click: toggle this single path in/out of the selection;
 *   anchor moves to this path on add, stays on remove (matches Finder /
 *   Explorer behaviour).
 */
export function applyRowClick(
  state: SelectionState,
  path: string,
  siblings: readonly string[],
  modifiers: ClickModifiers,
): SelectionState {
  if (modifiers.ctrlOrMeta) {
    const next = new Set(state.selected)
    if (next.has(path)) {
      next.delete(path)
      return withSelected(state, next, state.anchor)
    }
    next.add(path)
    return withSelected(state, next, path)
  }

  if (modifiers.shift && state.anchor !== undefined && siblings.includes(state.anchor) && siblings.includes(path)) {
    const range = rangeBetween(siblings, state.anchor, path)
    const next = new Set<string>()
    // Preserve selections from outside this folder.
    for (const existing of state.selected) {
      if (!siblings.includes(existing)) next.add(existing)
    }
    for (const item of range) next.add(item)
    return withSelected(state, next, state.anchor)
  }

  // Plain click: select-only.
  const next = new Set<string>([path])
  return withSelected(state, next, path)
}

/**
 * Apply a checkbox toggle on a single row.
 *
 * Independent of the row-body click model: a checkbox click never replaces
 * the selection wholesale; it only adds or removes the one row. Anchor is
 * unchanged on remove and moves to the toggled-on path on add (so a
 * subsequent Shift-click extends from a sensible anchor).
 */
export function applyCheckboxToggle(state: SelectionState, path: string): SelectionState {
  const next = new Set(state.selected)
  if (next.has(path)) {
    next.delete(path)
    return withSelected(state, next, state.anchor)
  }
  next.add(path)
  return withSelected(state, next, path)
}

/**
 * Apply a header "select all visible" toggle.
 *
 * - if every entry in `siblings` is already selected, the toggle clears
 *   exactly those entries (preserves cross-folder selections)
 * - otherwise, every entry in `siblings` is added; cross-folder selections
 *   are preserved
 */
export function applySelectAllToggle(state: SelectionState, siblings: readonly string[]): SelectionState {
  if (siblings.length === 0) return state
  const allSelected = siblings.every((p) => state.selected.has(p))
  const next = new Set(state.selected)
  if (allSelected) {
    for (const p of siblings) next.delete(p)
  } else {
    for (const p of siblings) next.add(p)
  }
  return withSelected(state, next, allSelected ? state.anchor : siblings[siblings.length - 1])
}

/** Clear all selections — Esc handler, etc. */
export function clearSelection(state: SelectionState): SelectionState {
  if (state.selected.size === 0 && state.anchor === undefined) return state
  return { selected: FROZEN_EMPTY, anchor: undefined }
}

/** Initial empty state suitable for createSignal seeding. */
export function emptySelection(): SelectionState {
  return { selected: FROZEN_EMPTY, anchor: undefined }
}

/**
 * Drop selection entries that no longer exist in the visible tree.
 * Called after a tree-shape change (refresh, mutation) so stale paths
 * don't survive forever.
 */
export function pruneSelection(state: SelectionState, knownPaths: ReadonlySet<string>): SelectionState {
  const filtered = new Set<string>()
  let changed = false
  for (const item of state.selected) {
    if (knownPaths.has(item)) filtered.add(item)
    else changed = true
  }
  const anchor = state.anchor && knownPaths.has(state.anchor) ? state.anchor : undefined
  if (!changed && anchor === state.anchor) return state
  return withSelected(state, filtered, anchor)
}
