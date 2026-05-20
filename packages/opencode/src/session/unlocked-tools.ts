const unlockedBySession = new Map<string, Set<string>>()
const availableBySession = new Map<string, Set<string>>()

export namespace UnlockedTools {
  export function unlock(sessionID: string, toolIDs: string[]): void {
    let set = unlockedBySession.get(sessionID)
    if (!set) {
      set = new Set()
      unlockedBySession.set(sessionID, set)
    }
    for (const id of toolIDs) set.add(id)
  }

  export function get(sessionID: string): Set<string> {
    return unlockedBySession.get(sessionID) ?? new Set()
  }

  /** Called by resolveTools after collecting all tools (active + lazy). */
  export function setAvailable(sessionID: string, toolIDs: Iterable<string>): void {
    availableBySession.set(sessionID, new Set(toolIDs))
  }

  /** Returns the set of all tool IDs that resolveTools found in the last resolution pass. */
  export function getAvailable(sessionID: string): Set<string> {
    return availableBySession.get(sessionID) ?? new Set()
  }

  export function clear(sessionID: string): void {
    unlockedBySession.delete(sessionID)
    availableBySession.delete(sessionID)
  }
}
