const unlockedBySession = new Map<string, Set<string>>()

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

  export function clear(sessionID: string): void {
    unlockedBySession.delete(sessionID)
  }
}
