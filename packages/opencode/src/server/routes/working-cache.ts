import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Session } from "@/session"
import { WorkingCache } from "@/session/working-cache"
import { errors } from "../error"

/**
 * HTTP surface for the Working Cache `system-manager:recall_toolcall_*` MCP
 * tool family. Endpoints are read-only and per-session.
 *
 * Plan reference: plans/20260507_working-cache-local-cache/ DD-10, DD-21, DD-22.
 *
 * - `GET /working-cache/index/:sessionID` → manifest counts + topic labels.
 * - `GET /working-cache/raw/:sessionID`   → L2 ledger pointers; with
 *   `include_body=1` the response inlines `ToolPart.output` from
 *   Session.messages without duplicating into L2.
 * - `GET /working-cache/digest/:sessionID` → L1 valid entries plus omitted
 *   reasons.
 */
const ManifestResponse = z.object({
  l2: z.object({
    total: z.number().int().min(0),
    byKind: z.record(z.string(), z.number().int().min(0)),
    byFileCount: z.number().int().min(0),
  }),
  l1: z.object({
    total: z.number().int().min(0),
    topics: z.array(z.string()),
  }),
  retrieval: z.object({
    raw: z.string(),
    digest: z.string(),
    index: z.string(),
  }),
})

const RawEntryResponse = z.object({
  found: z.boolean(),
  toolCallID: z.string().optional(),
  toolName: z.string().optional(),
  kind: z.enum(["exploration", "modify", "other"]).optional(),
  argsSummary: z.string().optional(),
  filePath: z.string().optional(),
  outputHash: z.string().optional(),
  mtimeMs: z.number().optional(),
  turn: z.number().int().min(0).optional(),
  messageRef: z.string().optional(),
  ageTurns: z.number().int().min(0).optional(),
  capturedAt: z.string().optional(),
  body: z.string().optional(),
})

const DigestResponse = z.object({
  entries: z.array(z.any()),
  omitted: z.array(
    z.object({
      entryID: z.string(),
      reason: z.string(),
    }),
  ),
})

export function WorkingCacheRoutes() {
  const app = new Hono()
    .get(
      "/index/:sessionID",
      describeRoute({
        summary: "Working Cache awareness manifest",
        description:
          "Counts + topic labels + retrieval tool names for the requested session. Same content shape as the post-compaction manifest, on demand. No fact bodies, no hashes, no path enumeration.",
        operationId: "workingCache.index",
        responses: {
          200: {
            description: "Manifest",
            content: { "application/json": { schema: resolver(ManifestResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: z.string().min(1) })),
      validator(
        "query",
        z.object({
          since_turn: z.coerce.number().int().min(0).optional(),
          kind: z.enum(["exploration", "modify", "other"]).optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const query = c.req.valid("query")
        const messages = await Session.messages({ sessionID }).catch(() => [])
        let ledger = WorkingCache.deriveLedger(messages)
        if (typeof query.since_turn === "number") {
          ledger = ledger.filter((entry) => entry.turn >= query.since_turn!)
        }
        if (query.kind) {
          ledger = ledger.filter((entry) => entry.kind === query.kind)
        }
        const valid = await WorkingCache.selectValid({ kind: "session", sessionID }, 32).catch(() => ({
          entries: [] as WorkingCache.Entry[],
          omitted: [] as { entryID: string; reason: WorkingCache.ErrorCode | "WORKING_CACHE_SCOPE_UNRESOLVED" }[],
        }))
        const manifest = WorkingCache.buildManifest(ledger, valid.entries)
        return c.json(manifest)
      },
    )
    .get(
      "/raw/:sessionID",
      describeRoute({
        summary: "Working Cache raw ledger query",
        description:
          "Returns the most recent L2 ledger entry matching the query, or { found: false } on miss. Optional include_body=1 inlines the original ToolPart.output from message storage; no payload duplication into L2.",
        operationId: "workingCache.raw",
        responses: {
          200: {
            description: "Ledger pointer (with optional body)",
            content: { "application/json": { schema: resolver(RawEntryResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: z.string().min(1) })),
      validator(
        "query",
        z.object({
          kind: z.enum(["exploration", "modify", "other"]).optional(),
          path: z.string().optional(),
          hash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          turn_range_start: z.coerce.number().int().min(0).optional(),
          turn_range_end: z.coerce.number().int().min(0).optional(),
          include_body: z.coerce.boolean().optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const query = c.req.valid("query")
        const messages = await Session.messages({ sessionID }).catch(() => [])
        const ledger = WorkingCache.deriveLedger(messages)
        const matches = WorkingCache.selectLedger(ledger, {
          kind: query.kind,
          path: query.path,
          hash: query.hash,
          turnRangeStart: query.turn_range_start,
          turnRangeEnd: query.turn_range_end,
        })
        if (matches.length === 0) {
          return c.json({ found: false })
        }
        const entry = matches[0]
        let body: string | undefined
        if (query.include_body) {
          for (const message of messages) {
            if (message.info?.id !== entry.messageRef) continue
            for (const part of message.parts ?? []) {
              if (part.type !== "tool") continue
              if (part.callID !== entry.toolCallID) continue
              if (part.state?.status === "completed" && typeof part.state.output === "string") {
                body = part.state.output
              }
              break
            }
            break
          }
        }
        return c.json({ found: true, ...entry, body })
      },
    )
    .get(
      "/digest/:sessionID",
      describeRoute({
        summary: "Working Cache digest query",
        description:
          "Returns matching L1 digest entries; stale entries are omitted from `entries` and reported in `omitted` with their omission reason.",
        operationId: "workingCache.digest",
        responses: {
          200: {
            description: "Digest entries",
            content: { "application/json": { schema: resolver(DigestResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: z.string().min(1) })),
      validator(
        "query",
        z.object({
          topic: z.string().optional(),
          entry_id: z.string().optional(),
          evidence_path: z.string().optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const query = c.req.valid("query")
        const result = await WorkingCache.selectDigest(
          { kind: "session", sessionID },
          { topic: query.topic, entryID: query.entry_id, evidencePath: query.evidence_path },
        )
        return c.json({
          entries: result.entries,
          omitted: result.omitted.map((item) => ({ entryID: item.entryID, reason: String(item.reason) })),
        })
      },
    )

  return app
}
