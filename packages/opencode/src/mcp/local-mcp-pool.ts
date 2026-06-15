/**
 * Process-global ref-counted pool for local stdio MCP children.
 *
 * BR 20260612 (direction 1): a daemon serving N project directories used to
 * spawn one local stdio MCP child PER Instance (Instance.state is keyed by
 * Instance.directory), because the old `createInFlight` map only deduped
 * truly-concurrent create() calls and deleted its entry on settle — sequential
 * project-opens each spawned their own child. This pool instead shares ONE
 * child across every Instance whose resolved spawn spec is identical, closing
 * the child only when the LAST Instance releases it.
 *
 * Mechanism: acquire() wraps the spawned client's close() so that every
 * existing close site (cleanupState / disconnect / reconnect / stale-refresh)
 * is automatically ref-counted — calling close() decrements; the real
 * transport close fires only at refs 0. A single Instance (refs 1) therefore
 * behaves byte-identically to the pre-pool path: close() closes immediately.
 *
 * Pure & generic over the resource type — no MCP imports — so the ref-count and
 * concurrency logic is unit-tested in isolation (local-mcp-pool.test.ts).
 */

export interface PoolResource {
  /** The long-lived client whose close() the pool ref-counts. */
  mcpClient?: { close(): Promise<void> }
}

interface Entry<R extends PoolResource> {
  refs: number
  resource?: R
  inflight?: Promise<R | undefined>
}

export interface LocalMcpPool<R extends PoolResource> {
  /**
   * Acquire a shared resource for `shareKey`. If a live (or in-flight) resource
   * already exists for the key, its ref-count is incremented and the SAME
   * resource is returned; otherwise `spawn` is called once to create it.
   * Returns undefined if spawn fails or produces no client.
   */
  acquire(shareKey: string, spawn: () => Promise<R | undefined>): Promise<R | undefined>
  /** Number of live shared entries (test/diagnostic). */
  size(): number
  /** Current ref-count for a key, 0 if absent (test/diagnostic). */
  refs(shareKey: string): number
}

export interface CreatePoolOptions {
  /** Invoked when a key's last ref is released and the child is really closed. */
  onRealClose?: (shareKey: string) => void
}

export function createLocalMcpPool<R extends PoolResource>(opts: CreatePoolOptions = {}): LocalMcpPool<R> {
  const entries = new Map<string, Entry<R>>()

  async function acquire(shareKey: string, spawn: () => Promise<R | undefined>): Promise<R | undefined> {
    let entry = entries.get(shareKey)
    if (entry) {
      // Join an in-flight spawn (concurrent acquire for the same key).
      if (entry.inflight) await entry.inflight
      entry = entries.get(shareKey)
      if (entry?.resource?.mcpClient) {
        entry.refs++
        return entry.resource
      }
      // entry resolved without a client (spawn had failed and was deleted) —
      // fall through and respawn.
    }

    const fresh: Entry<R> = { refs: 0, resource: undefined }
    entries.set(shareKey, fresh)
    fresh.inflight = (async () => {
      const resource = await spawn().catch(() => undefined)
      if (!resource) {
        entries.delete(shareKey)
        return undefined
      }
      if (!resource.mcpClient) {
        // Spawn produced a failure result (status carries the error) — return
        // it to the caller so status propagates, but do NOT pool a clientless
        // resource.
        entries.delete(shareKey)
        return resource
      }
      // Ref-count the client's close(): every existing close site decrements;
      // the real transport close fires only when the last Instance releases.
      const realClose = resource.mcpClient.close.bind(resource.mcpClient)
      resource.mcpClient.close = async () => {
        const cur = entries.get(shareKey)
        if (!cur || cur.resource !== resource) {
          // Entry already detached (replaced/cleared) — close for real.
          return realClose()
        }
        cur.refs--
        if (cur.refs <= 0) {
          entries.delete(shareKey)
          opts.onRealClose?.(shareKey)
          await realClose()
        }
      }
      fresh.resource = resource
      fresh.refs = 1
      return resource
    })()

    try {
      return await fresh.inflight
    } finally {
      fresh.inflight = undefined
    }
  }

  return {
    acquire,
    size: () => entries.size,
    refs: (shareKey: string) => entries.get(shareKey)?.refs ?? 0,
  }
}

/**
 * Stable share key for a local stdio spawn. Two Instances share a child iff
 * their resolved command (incl. args), environment, AND on-disk source mtime
 * are all identical.
 *
 * `cwd` is included ONLY when it is significant — i.e. the user explicitly set
 * `mcp.cwd`. The default cwd (Instance.directory) is incidental for the common
 * case (a global tool launched per project), so folding it into the key would
 * needlessly spawn one child per project — exactly the duplication this pool
 * exists to remove. The one cwd-sensitive built-in, the filesystem MCP, injects
 * its working directory into the ARGS, so it stays correctly separated via the
 * resolved command regardless of whether cwd is in the key.
 *
 * Including the source mtime means a stale-refresh (the source file was edited
 * after spawn) yields a NEW key → a fresh child, so pooling never hands back a
 * stale client after a content change.
 */
export function localShareKey(input: {
  command: ReadonlyArray<string>
  /** Only pass when explicitly configured (mcp.cwd); omit for the default. */
  cwd?: string
  env: Record<string, string | undefined>
  sourceMtimeMs?: number
}): string {
  const env = Object.keys(input.env)
    .sort()
    .map((k) => [k, input.env[k]] as const)
  return JSON.stringify({
    command: input.command,
    cwd: input.cwd ?? null,
    env,
    sourceMtimeMs: input.sourceMtimeMs ?? null,
  })
}
