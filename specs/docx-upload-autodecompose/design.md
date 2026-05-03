# Design: docx-upload-autodecompose

## Context

This design follows the proposal in `proposal.md`. The starting state:
- Office attachments arrive at the upload dispatcher as raw bytes; the
  dispatcher writes them to `incoming/<original-filename>` and tags the
  user message with metadata (filename, mime, byte size, ref id, repo
  path). The AI sees the tagged message; if it wants to read the file
  it must call a tool.
- The docx-handling service (a separate MCP server living in
  `~/projects/docxmcp/`) has three relevant scripts: full-text
  extractor, outline extractor, and chapter extractor; it auto-runs an
  unzip-and-pretty-print step on every tool call and ships the
  resulting tree back to the host as a tar bundle, which the
  dispatcher then unpacks under the source file's stem.
- Legacy Office (.doc / .xls / .ppt) is handled by an in-process
  printable-runs scanner inside the AI-callable upload-time tool
  (`attachment`). New-format Excel / PowerPoint (.xlsx / .pptx) has
  no handler; the upload-time tool returns a "convert to docx" note.

## Goals / Non-Goals

- **Zero AI tokens for the decompose step.** Decomposition runs in the
  upload pipeline before the AI is consulted.
- **One read-shaped contract for every Office format.** Whether the
  file is .docx, .doc, .xls, .ppt, .xlsx, or .pptx, the AI looks in
  `incoming/<stem>/` and reads files. The set of files present
  varies; the read mechanic is identical.
- **Template extraction is first-class**, not an afterthought, so
  rebuilding a docx or reusing its look becomes a normal capability.
- **Plain-language manifest**: the AI gets a readable summary, not a
  list of tool names to choose from.
- **Soft-fail with concrete reasons**: upload never fails because of
  decompose; the AI is told what went wrong in one line of plain
  language and decides what to do.

## Non-Goals

- Building xlsx-mcp or pptx-mcp in this round (placeholder
  `unsupported.md` is what they get).
- Cleaning up the printable-runs noise on legacy Office (an OLE2
  parser would help; out of scope).
- Changing the docx-handling tool's per-call auto-decompose
  behaviour (it stays; it is harmless and useful for the editing
  flow).

## Decisions

### DD-1 Two-phase decompose at upload time (fast sync + detached background)

> **Amended 2026-05-03 (during phase 1 implementation, in-place):**
> The original "fully synchronous" framing was wrong for very large
> docx (50+ MB), where iterating `doc.paragraphs` to produce
> `body.md` alone takes 8+ seconds. After running real fixtures, the
> 56 MB welfare proposal took 72 s end-to-end — past the 30 s
> soft-fail timeout. User direction:
> "docxmcp 請採取非同步執行緒。快速回報架構資訊，並在背景持續寫回大型內容拆解。"
> See DD-11 below for the new async delivery contract.

Decomposition runs in two phases:

1. **Fast synchronous phase** (target p95 < 5 s). Produces the
   "architecture map": `outline.md`, `template/*` (styles + theme +
   numbering + settings + fontTable + reusable `template.dotx`),
   plus a `manifest.json` skeleton with
   `decompose.background_status: "running"` and
   `decompose.pending_kinds` listing what is still being written.
   Each pending subdirectory (`chapters/`, `tables/`, `media/`)
   gets a `_PENDING.md` marker file so an AI doing `ls` sees an
   explanation. The dispatcher unblocks the user message turn here.

2. **Detached background phase**. Produces the heavy content:
   `body.md`, `chapters/*.md`, `tables/*.csv`, `media/*`. Rewrites
   `manifest.json` with the full file list and flips
   `background_status` to `done` (or `failed`). Removes the
   `_PENDING.md` markers.

Reasoning for the split:

- User-stated tolerance: 100k-word manuscripts in seconds. Real
  measurement on the 56 MB welfare proposal: full path = 72 s,
  fast path alone = 10 s. Two-phase keeps the user's mental model
  for typical docx (sub-second total) and makes huge docx usable
  too, without ever blocking the user message turn for >> seconds.
- "Synchronous matches the user's mental model" still holds for
  *the architecture map*. The user does not need full body text
  before the AI starts thinking — outline + template are enough
  for the AI to plan its read pattern.
- The background phase IS exposed to the AI (via manifest's
  `background_status`, `_PENDING.md` markers, and the routing
  hint), so it is never silent.

### DD-2 Directory layout under `incoming/<stem>/`

For a successful .docx decompose, the tree is:

```
incoming/foo.docx                        ← original upload
incoming/foo/
├── manifest.json                        ← index of everything below
├── body.md                              ← full text, every paragraph
│                                          one block, tables flattened
├── outline.md                           ← heading tree, indented
├── chapters/
│   ├── 01-<slug>.md                     ← per-chapter markdown
│   ├── 02-<slug>.md
│   └── …
├── tables/
│   ├── 01.csv
│   ├── 02.csv
│   └── …
├── media/
│   ├── 01-<original-name>.png
│   ├── 02-<original-name>.jpg
│   └── …
└── template/
    ├── styles.xml                       ← raw OOXML style defs
    ├── theme1.xml
    ├── numbering.xml
    ├── settings.xml
    ├── fontTable.xml
    └── template.dotx                    ← repackaged reusable .dotx
```

For a legacy .doc / .xls / .ppt decompose:

```
incoming/foo.doc                          ← original upload
incoming/foo/
├── manifest.json
└── body.md                               ← printable-runs scan output;
                                            preserves newlines, blank
                                            lines, leading whitespace
```

For an unsupported .xlsx / .pptx upload:

```
incoming/foo.xlsx                         ← original upload
incoming/foo/
├── manifest.json
└── unsupported.md                        ← plain-language explanation
                                            of why no decompose; advice
                                            to convert to .docx
```

For a soft-failed .docx decompose:

```
incoming/foo.docx                         ← original upload
incoming/foo/
├── manifest.json                         ← marks failure + reason
└── failure.md                            ← one-line plain-language
                                            reason + raw error if any
```

**Filename rules:**
- All extensions are lowercase.
- Body and outline use `.md` (markdown is more useful than plain text
  for AI; legacy fallback can also use markdown's leading-whitespace
  preservation).
- Chapter filenames carry a 2-digit zero-padded ordinal + a slugified
  title fragment (e.g. `02-introduction.md`).
- Tables and media use 2-digit zero-padded ordinals; media keeps the
  original asset filename for traceability.
- All produced files are UTF-8; CSV is UTF-8 with BOM for Excel
  friendliness (matches existing chapter extractor behaviour).

### DD-3 Manifest format

`manifest.json` is the single machine-readable contract for what is in
the stem directory. Schema (formalized in `data-schema.json`):

```json
{
  "schema_version": 1,
  "stem": "foo",
  "source": {
    "filename": "foo.docx",
    "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "byte_size": 134912,
    "sha256": "…64 hex…",
    "uploaded_at": "2026-05-03T08:14:22Z"
  },
  "decompose": {
    "status": "ok" | "failed" | "unsupported",
    "duration_ms": 312,
    "reason": "<string, only present when status != ok>"
  },
  "files": [
    { "path": "body.md",        "kind": "body",     "summary": "3,214 lines" },
    { "path": "outline.md",     "kind": "outline",  "summary": "14 headings, 3 chapters" },
    { "path": "chapters/01-introduction.md",       "kind": "chapter", "summary": "chapter 1" },
    { "path": "tables/01.csv",  "kind": "table",    "summary": "5 rows × 4 cols" },
    { "path": "media/01-figure-a.png", "kind": "media", "summary": "image/png" },
    { "path": "template/template.dotx", "kind": "template", "summary": "reusable .dotx" }
  ]
}
```

Fields:
- `kind` is one of `body | outline | chapter | table | media |
  template | unsupported | failure`. AI uses kind to pick what to read
  for a given user intent.
- `summary` is a short human-readable string. AI may render it
  verbatim into responses to the user.
- `decompose.status = "failed"` always carries a `reason`. No silent
  failures (matches AGENTS.md rule 1).

### DD-4 All-in-one decompose entry on the docx-handling tool

A new MCP tool entry, `extract_all`, on the docx-handling service.
Behaviour: takes a token (file ref) and an output directory, runs the
existing extract-text, extract-outline, extract-chapter steps, plus
two new sub-steps for template extraction (raw style XML files copied
out of the unpack tree; `template.dotx` repackaged from the source by
copying the docx and renaming), and writes `manifest.json` reflecting
everything produced.

Implementation: a thin orchestrator script in
`~/projects/docxmcp/bin/extract_all.py` that calls the existing
extractors as Python functions (not subprocesses) and emits the
manifest. The existing per-tool scripts stay so they can be called
independently for editing flows.

### DD-5 Same-name-different-content: paired version-rename of the OLD pair, new pair occupies canonical position

Cache key = `sha256(file_bytes) + ":" + original_filename`.

Replaces the existing `nextConflictName`-based behaviour in
`user-message-parts.ts` (which suffixed the *new* upload with `(2)`).
The new rule, decided 2026-05-03 in this spec's planning conversation,
suffixes the **OLD** pair instead so the canonical position
`incoming/<stem>.<ext>` + `incoming/<stem>/` always holds the latest
version. Multi-version history accumulates as siblings that sort
chronologically by suffix.

Cache verdicts:

- **Cache hit** — `incoming/<stem>/manifest.json` exists AND its
  `source.sha256` + `source.filename` match the new upload. Skip
  decompose, reuse tree. (See DD-12 for the failed-manifest case;
  failed manifests count as cache hits too.)
- **Cache miss, no prior pair** — write file to `incoming/<stem>.<ext>`
  and create a fresh `incoming/<stem>/`.
- **Cache miss, prior pair exists with sha drift** — read the prior
  manifest's `source.uploaded_at`, format as `YYYYMMDD-HHMMSS` UTC,
  then **atomically rename BOTH the source file and the bundle dir**:
  - `incoming/<stem>.<ext>` → `incoming/<stem>-<old-ts>.<ext>`
  - `incoming/<stem>/` → `incoming/<stem>-<old-ts>/`
  Then write the new file to `incoming/<stem>.<ext>` and decompose
  into a fresh `incoming/<stem>/`.

Pairing is critical. Renaming only one of the two leaves an
inconsistent tree where the manifest's `source.filename` no longer
matches its on-disk sibling. The rename helper takes both paths and
either succeeds on both or rolls back both.

Example trace for two uploads of `foo.docx` with different content:

```
# After first upload at 2026-05-03 08:14:22 UTC:
incoming/foo.docx                              ← v1 bytes
incoming/foo/
└── manifest.json (source.uploaded_at = "2026-05-03T08:14:22Z")

# After second upload at 2026-05-03 09:30:00 UTC (different content):
incoming/foo.docx                              ← v2 bytes (canonical)
incoming/foo/
└── manifest.json (source.uploaded_at = "2026-05-03T09:30:00Z")
incoming/foo-20260503-081422.docx              ← v1 bytes preserved
incoming/foo-20260503-081422/                  ← v1 tree preserved
└── manifest.json (source.uploaded_at = "2026-05-03T08:14:22Z")
```

`ls incoming/foo*` then shows the version timeline at a glance:
canonical = latest, suffixed = older versions in chronological order.

The AI's routing hint always points at the canonical
`incoming/<stem>/`; historical siblings are not advertised but
remain on disk for the user / debugging / audit. Eviction of
historical siblings is out of scope for this round.

**Migration of the existing DD-8 (`nextConflictName`) behaviour:** the
old function added a `(N)` suffix to the *new* file. We are replacing
that with the paired version-rename above. Other call sites of
`nextConflictName` (if any) outside the Office-upload path keep the
old behaviour; only the Office-upload path under `tryLandInIncoming`
opts into the new helper.

### DD-6 Soft-fail message style

When decompose fails, the routing hint shown to the AI says:

> 附檔 `foo.docx`（130 KB）。自動拆解失敗：「<plain reason>」。
> 請按使用者本來的問題回答；若無法在沒有拆解內容的情況下回答，
> 請告知使用者可重新上傳，或請使用者手動轉成純文字後再貼進來。

`<plain reason>` is the manifest's `decompose.reason` — one sentence,
no stack trace, no file paths to internal state. Examples:
- `docx 內部結構不完整，缺少 word/document.xml`
- `檔案不是有效的 zip 結構，可能在傳輸途中損壞`
- `docxmcp 服務暫時無回應 (timeout 30s)`
- `OLE2 解析失敗：找不到主要文字流`

### DD-7 Routing hint is a MAP, not CONTENT

**Principle:** the routing hint shown to the AI is a **map** of what is
in `incoming/<stem>/`. It tells the AI where to look. The AI then
opens its read tools to fetch actual content. The hint never tries to
preview body text, outline contents, table cells, or anything readable
— that would defeat the zero-token decompose principle by stuffing
content into the prompt where the read tool would have fetched only
what the AI actually needed.

Concrete rendering rules:

- Each kind of artifact gets **one line** with: kind, file count or
  range, one-number summary (line count, heading count, etc.), and
  the canonical filename pattern.
- Lists with ≤ 4 items show every filename. Lists with > 4 items show
  only the first item + a count: `chapters/01-introduction.md 起 3 份`
  for 3 items; `chapters/01-…05-… (還有 40 份)` for many.
- Never inline body content, even short. The AI can `grep` it.
- Always close the hint with the same three-line action contract:
  "**動 `incoming/<stem>/` 任何檔案前，先 read manifest.json 確認當前狀態。** 讀內容直接用一般檔案讀寫工具（read / grep / glob）。要改寫 docx 才呼叫 docxmcp 工具。"
  (The first line implements DD-13's pull-refresh rule.)

Example for a successful docx upload (small):

> 附檔 `foo.docx`（130 KB）。已自動拆解到 `incoming/foo/`：
> - 全文：`body.md`（3,214 段）
> - 大綱：`outline.md`（14 個標題、3 章）
> - 章節：`chapters/01-introduction.md` 起 3 份
> - 表格：`tables/01.csv` 起 5 份
> - 圖片：`media/01-figure-a.png` 起 8 張
> - 範本：`template/template.dotx`（連同 styles.xml / theme1.xml）
>
> **動 `incoming/foo/` 任何檔案前，先 read manifest.json 確認當前狀態。**
> 讀內容直接用一般檔案讀寫工具（read / grep / glob）。
> 要改寫 docx 才呼叫 docxmcp 工具。

Example for a successful docx upload (large book, > 4 chapters):

> 附檔 `book.docx`（4.2 MB）。已自動拆解到 `incoming/book/`：
> - 全文：`body.md`（38,210 段）
> - 大綱：`outline.md`（512 個標題、44 章）
> - 章節：`chapters/01-…04-…`（還有 40 份，共 44 份）
> - 表格：`tables/01.csv` 起 187 份
> - 圖片：`media/01-…`（共 612 張）
> - 範本：`template/template.dotx`
>
> **動 `incoming/book/` 任何檔案前，先 read manifest.json 確認當前狀態。**
> 讀內容直接用一般檔案讀寫工具（read / grep / glob）。
> 要改寫 docx 才呼叫 docxmcp 工具。

For unsupported / failure cases, the corresponding shorter form is
shown (see DD-6). The hint generator lives in the message composer
and reads the manifest to render the summary; it never renders tool
identifiers as primary content, and never renders body content.

Implementation note: the manifest itself stays full (no folding) — it
is the canonical record. Folding is purely a render-time decision in
the routing-hint generator.

### DD-8 Legacy Office printable-runs scanner: layout-preserving rewrite

The current scanner (introduced earlier the same day) drops short
runs and dedups duplicates. Both destroy layout. Rewrite:

- Scan in two passes (ASCII / UTF-8 single-byte; UTF-16LE for CJK).
- Treat CR / LF / tab as **structural** characters, not run
  terminators: preserve them in the output.
- Preserve runs of leading spaces (they often indicate indentation
  or table column alignment in legacy Word).
- Drop runs of pure binary noise (length < 4 with no surrounding
  text-like context).
- Do not dedup across the two passes; instead, prefer the UTF-16LE
  pass when its output covers the same byte range as the ASCII pass
  (UTF-16LE is more likely to hold body text in modern legacy .doc).
- Output to `body.md`. AI is then free to read leading-whitespace
  patterns as heading-level cues.

The scanner stays in opencode (no new dependency on docxmcp for
legacy formats; docxmcp is .docx-only).

### DD-9 Architecture: where decompose runs and who writes what

Five surfaces participate. Cleanly separated by data ownership:

| Component | Owns | Calls |
|---|---|---|
| **User-message upload hook** (`packages/opencode/src/session/user-message-parts.ts` → `tryLandInIncoming`) | Receives uploaded bytes from the chat UI; lands them on disk; **for Office mimes, also: detects mime, computes cache key, runs the cache lookup, invokes the version-rename helper on sha drift, and synchronously calls the chosen decomposer; blocks until the fast phase returns; then schedules the polling loop** | Office mime detector (helper); version-rename helper (DD-5); `extract_all` MCP call (for .docx); in-process legacy OLE2 scanner (for .doc / .xls / .ppt); unsupported-note writer (for .xlsx / .pptx); failure recorder (any path on error) |
| **Polling loop** (`packages/opencode/src/incoming/poll-loop.ts`, new) | Per-stem `extract_all_collect(wait=0)` every 5 s during background; stops on `background_status != "running"` or 180 s safety cap | `extract_all_collect` MCP call (via dispatcher's existing token-rewriting infrastructure) |
| **Message composer / routing hint generator** (`packages/opencode/src/session/message-v2.ts`) | Reading the manifest, rendering the routing hint in plain language; per DD-13, the hint is RE-RENDERED on every AI turn from the current manifest, not embedded once | manifest reader (file system) |
| **MCP tool dispatcher** (`packages/opencode/src/incoming/dispatcher.ts`) | Existing role unchanged: intercepts AI tool calls that pass paths under `incoming/`; rewrites paths → tokens; uploads to the MCP server's `/files`; on tool return, decodes the tar bundle and extracts to the bundle dir. **Used by the polling loop to deliver `extract_all_collect` calls.** | MCP HTTP transport |
| **AI-callable upload-time tool** (`packages/opencode/src/tool/attachment.ts`) | Image / PDF / text / JSON ref queries only (Office logic is being lifted out per phase 8) | reader subagents (image / PDF) |
| **docx-handling service** (`~/projects/docxmcp/`) | The `extract_all` orchestrator (fast phase + detached background); `extract_all_collect`; per-token `_last_bundled_state`; existing per-tool extractors | nothing new outside its repo |

Earlier drafts of this design put the upload-time work in
`incoming/dispatcher.ts`. That was wrong: that file is the
*MCP-tool* dispatcher (it intercepts AI tool calls), not the
*user-upload* dispatcher (the chat-UI bytes pipeline). The actual
Office upload entry point is `tryLandInIncoming`.

Telemetry: a new event `incoming.decompose` records `{mime, bytes,
duration_ms, cache: hit | miss, status: ok | failed | unsupported,
reason}`. Consumed by the existing telemetry pipeline.

### DD-14 Stale-running recovery, configurability, schema clarifications (P1 batch)

This DD batches several smaller decisions surfaced in the 2026-05-03
audit (G6, G7, G8, G9, G11, G13, G14) that don't individually warrant
a full DD but do need to be on record before phase 3 implementation.

**(G6/G8) Stale `background_status: "running"` across sessions.** A
manifest may be left in `running` if (a) the user closed the chat
session before background completed, or (b) the docxmcp container
was restarted mid-flight. On the next upload of the same file
(cache key matches), the upload hook MUST detect stale running:

- If `manifest.decompose.background_status == "running"` AND
  `now - manifest.source.uploaded_at > MAX_BACKGROUND_AGE` (default
  600 s, configurable via `tweaks.cfg`), treat as cache miss and
  re-decompose. Rename the stale dir + source aside per DD-5
  (paired version-rename) so the prior partial state is preserved
  for debugging.
- If still within `MAX_BACKGROUND_AGE`, treat as cache hit and let
  the new session's polling loop (re-)attach via `extract_all_collect`
  to pick up the in-flight work.

**(G7) docxmcp container restart mid-poll.** Detected by
`extract_all_collect` returning `token_not_found` (the docxmcp
in-process token store is wiped on restart). The polling loop
catches this, treats it as a fatal background failure, writes
`background_status: "failed"` + `background_error: "docxmcp
container restarted; partial extras lost"` into the manifest, and
stops polling. Recovery is the same as G6 path 1 above (re-upload
with stale recovery rule).

**(G9) Timeout numbers consolidated:**

| Knob | Value | Where |
|---|---|---|
| Fast-phase target latency p95 | < 5 s typical, < 15 s for ≤ 60 MB | AC-1, AC-2 |
| Fast-phase hard timeout | 30 s | dispatcher's AbortController; surfaces as `DECOMPOSE_TIMEOUT` |
| Background phase target latency p95 | < 90 s for ≤ 60 MB | AC-2b |
| Polling interval | 5 s | tweaks.cfg `incomingDecomposePollIntervalMs` (default 5000) |
| Polling safety cap | 180 s | tweaks.cfg `incomingDecomposePollCapMs` (default 180000) |
| MAX_BACKGROUND_AGE for stale running detection | 600 s | tweaks.cfg `incomingDecomposeStaleRunningAgeMs` (default 600000) |
| docxmcp token TTL | TBD-VERIFY | docxmcp's `_token_store`; must be ≥ MAX_BACKGROUND_AGE + cap headroom (so collect calls stay valid through the safety cap window) |

**(G11) Manifest schema clarification for unsupported/failure cases:**

For an `unsupported` upload (xlsx / pptx today):
- `decompose.status = "unsupported"`
- `decompose.background_status = "n/a"`
- `decompose.reason = "<plain reason>"`
- `files = [{path: "unsupported.md", kind: "unsupported", summary: "..."}]`

For a `failed` upload:
- `decompose.status = "failed"`
- `decompose.background_status = "n/a"` (failure is at fast-phase
  level; no background was started)
- `decompose.reason = "<plain reason>"`
- `files = [{path: "failure.md", kind: "failure", summary: "..."}]`

For a successful fast phase whose background later fails:
- `decompose.status = "ok"` (fast phase succeeded — outline and
  template are real on-disk)
- `decompose.background_status = "failed"`
- `decompose.background_error = "<plain reason>"`
- `files` includes whatever the fast phase + any partial background
  writes produced

**(G13) docxmcp token TTL.** The opencode-side dispatcher MUST
verify (in phase 9.2 of tasks.md, added) that docxmcp's
`_token_store` TTL is ≥ MAX_BACKGROUND_AGE. If shorter, either
extend the TTL on the docxmcp side or clamp MAX_BACKGROUND_AGE on
the opencode side. Default plan: extend docxmcp TTL to 1800 s.

**(G14) Configurability.** Every magic number in this spec is
configurable via `tweaks.cfg` per the project convention
(memory: `feedback_tweaks_cfg.md`). Names listed in the timeout
table above. Defaults stay sensible without any config file.

### DD-13 Pull-only manifest refresh; AI must re-read on every action against `incoming/<stem>/`

The routing hint attached to a user message is **immutable** once
the message lands in conversation history. Polling continues to
update `incoming/<stem>/manifest.json` on disk, but the message-level
hint AI saw at turn N captures only the state at time N.

There is no push channel that re-injects an updated hint into AI
context (we considered: re-render-per-turn, synthetic
"manifest updated" message, change-watch tool — all add complexity
without clearly beating the pull model).

The contract instead is **pull**: every routing hint and every
`_PENDING.md` marker tells the AI the same rule:

> **動 `incoming/<stem>/` 的任何檔案前，先 `read incoming/<stem>/manifest.json`
> 確認當前狀態。** manifest 隨背景進度持續更新；只有它是即時真相。

Mechanics:

- The AI's `read` tool always reads the current bytes on disk. There
  is no caching at the tool level. So `read incoming/foo/manifest.json`
  always returns whatever the file is RIGHT NOW.
- The polling loop in opencode keeps `incoming/<stem>/manifest.json`
  in lockstep with the docxmcp-side state (within ~5 s lag).
- AI behavioural contract: before any operation on
  `incoming/<stem>/`, re-read manifest. If `background_status` is
  still `running` and the AI needs a file that isn't there yet, it
  may either (a) call `mcpapp-docxmcp_extract_all_collect` to
  block-wait, or (b) inform the user that the answer it can give
  right now is partial.

Why pull beats push:

- No new injection path / no risk of stale system-message accumulation
- Standard `read` semantics — no special tool, no opencode wiring
- Routing hint stays a one-shot contract (matches the rest of
  opencode's message model)
- Future-proof: even if polling cadence changes or polling is
  disabled, the AI's contract is identical

The cost: AI must remember the contract. We bake it into:
1. Every routing hint variant (DD-7)
2. Every `_PENDING.md` marker text (already done in
   `bin/extract_all.py` PENDING_MARKER_TEXT)
3. The action-contract closing line of every routing hint
4. (Optional) An entry in CLAUDE.md / AGENTS.md that explicitly
   names the rule

### DD-12 Failed manifests are cached; manual cleanup required to retry

A `manifest.json` with `decompose.status = "failed"` is treated as a
real cache entry: re-uploading the same file (same sha + same name)
returns the cached failure manifest, no re-attempt is made. This
matches the user direction 2026-05-03:
"我改變想法了。失敗要入Cache".

Rationale: most failures are deterministic with respect to file
content (corrupt zip, missing required parts, OLE2 stream
extraction failure). Re-attempting on every re-upload would burn
the timeout window each time without changing the outcome.

Recovery paths the user has:

1. **Modify the file** (re-export from Word, fix the zip, etc.) so
   the sha changes — that's a cache miss, fresh attempt.
2. **Manually clear the cached failure**: `rm -rf incoming/<stem>/`
   (and optionally `rm incoming/<stem>.<ext>` if the source is
   also bad). Next upload of the same name + content is treated as
   no-prior-pair → fresh attempt.
3. **Wait for the underlying issue to be fixed** (e.g. docxmcp
   container brought back up after crash) and then path 2.

The routing hint must surface the cached-failure state explicitly
so the AI can advise the user about path 1 or 2:

> 附檔 `foo.docx`（130 KB）。**過去拆解曾失敗**：「<reason>」。
> 此失敗結果已快取。如要重試，請使用者修改檔案內容或先執行
> `rm -rf incoming/foo/` 清除舊紀錄。

Failed manifests do NOT participate in the "background_status:
running" path either — they are terminal states for that token.
A separate DD (DD-14, in P1 batch) covers stale running states.

### DD-11 Async delivery contract for the background phase

Three orthogonal mechanisms expose the background phase's state to
the AI. Each is independent so failure of one does not blind the AI:

**(1) `manifest.json` is the canonical state.** Fields:

- `decompose.background_status`: `running | done | failed`
- `decompose.pending_kinds`: array of kinds still being written
  (only present while `running`)
- `decompose.background_duration_ms`: present when `done` or `failed`
- `decompose.background_error`: one-line plain reason; present only
  when `failed`

The routing hint instructs the AI: *"any time you are about to
operate on `incoming/<stem>/`, read `manifest.json` first to know
what is ready and what is still being produced"*.

**(2) `_PENDING.md` markers in pending subdirectories.** When the
fast phase returns, `chapters/_PENDING.md`, `tables/_PENDING.md`,
`media/_PENDING.md` exist as plain-text markers explaining the
state and pointing at `manifest.json`. The background phase removes
them when done. AI doing `ls chapters/` sees the marker even if it
forgot the routing-hint contract.

**(3) Routing hint banner.** Initial hint includes a `⏳ 背景拆解中`
line listing pending kinds and stating two recovery options:
"call `mcpapp-docxmcp_extract_all_collect` to wait", OR "use the
already-ready outline + template now".

**Process model.** docxmcp runs as a long-lived MCP server, but
each tool call is a fresh `subprocess.run`. A daemon thread cannot
survive the subprocess exit, so the background phase is run in a
**double-forked detached child** (parent → intermediate → grandchild;
intermediate exits to reparent grandchild to PID 1). The grandchild
inherits the working directory and writes to the same on-disk
`<doc-dir>/` the parent populated. Stdio is redirected to /dev/null
so it does not pollute MCP responses. Container restart while a
grandchild is mid-flight is the only loss case (acceptable: the
manifest stays at `running`, `extract_all_collect` will re-run the
extraction since chapters/ remains empty).

**Fetch-back contract for extras.** A new MCP tool
`extract_all_collect` reads the manifest, optionally blocks waiting
for `background_status` to flip from `running` (default 60 s; pass
`wait=0` for non-blocking), then returns the manifest. The bundle
producer ships any files that have changed since this token's last
bundle (see incremental polling below).

The AI may call `extract_all_collect` directly when it needs to wait
synchronously for a particular extra (e.g. "give me chapter 3"
requires `chapters/03-*.md` to be on disk).

**Incremental polling for near-real-time host mirror.** The
naive snapshot-diff bundle producer (per-call `pre_snapshot` →
`post_snapshot` → diff) loses any file written by the background
process between two MCP calls. To make `incoming/<stem>/` on the
host mirror the container in near-real-time, the bundle producer
maintains a per-token `_last_bundled_state` dict. Each MCP call's
bundle is computed as `_snapshot_files(root)` ∖ `_last_bundled_state[token]`,
and `_last_bundled_state[token]` is updated to the post-call snapshot.
Effect: every file written between any two consecutive calls for the
same token is shipped exactly once — no gaps, no duplicates.

The opencode dispatcher exploits this by polling
`extract_all_collect` with `wait=0` every 5 seconds during the
background phase, until the manifest reports
`background_status != "running"` (or a 180 s safety cap). Each poll
ships only the new bytes; the host's `incoming/<stem>/` tree fills
up incrementally as the container produces files.

Wastage analysis: each empty poll round-trips a few hundred bytes
of MCP framing + an empty manifest read; full polls ship only the
incremental files. For a typical 60 MB docx, 6–12 polls × small
incremental bundles ≈ the same bytes as a single full bundle, with
the bonus of progressive UI on the host side.

### DD-10 Cross-repo coordination — docxmcp is a separate Docker service, NOT a submodule

Both repos are in-house and on the same authority. docxmcp lives at
`~/projects/docxmcp/` and is **deployed as a Docker container**
(`docker compose -p docxmcp-<user>`) talking to opencode over an HTTP-
over-Unix-socket MCP transport. It is NOT registered as a git
submodule of opencode — earlier drafts of this design said "bump the
docxmcp submodule pointer", which was wrong. The actual delivery
mechanism is `docker compose build && up -d`.

Concretely:

- The docxmcp `extract_all` + `extract_all_collect` entries ship
  first as a non-blocking precondition — opencode's upload hook
  calls them through the regular MCP transport, so they must be
  registered on the running container or the call fails.
- After committing to docxmcp's `main`, the operator must
  **rebuild and restart** the container. Because container restart
  is shared infrastructure (briefly interrupts any in-flight docx
  work for any user on the same host), it requires explicit user
  consent before being run (per the project's daemon-restart rule
  in memory `feedback_restart_daemon_consent.md`).
- Tasks split: docxmcp-side tasks (Phase 1 / 1b / 1c) ship first,
  container rebuild + restart is Phase 2, opencode-side tasks
  (Phase 3 onwards) ship after that.
- The opencode upload hook is built defensively: if `extract_all`
  is missing on the running container (e.g. operator forgot to
  rebuild), the hook surfaces this as a soft-fail "docx tooling
  unavailable" via the failure-recorder — does not silently fall
  back to the old "AI calls docxmcp on demand" path (no silent
  fallback, AGENTS.md rule 1).

## Risks / Trade-offs

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Synchronous decompose blocks the user-message turn | Soft-fail with timeout (default 30 s); keep upload, surface failure in routing hint; revisit if real-world p95 exceeds 5 s |
| R-2 | Same-name different-content uploads back-to-back | DD-5: paired version-rename of the OLD pair (file + dir together) to `incoming/<stem>-<old-ts>.<ext>` + `incoming/<stem>-<old-ts>/`; new pair occupies canonical position; same-sha + same-name = real cache hit; chronological suffix sorts naturally with `ls` |
| R-3 | docxmcp `extract_all` missing or down | DD-10 soft-fail surface; never silently degrade to per-tool calls |
| R-4 | Template `template.dotx` repackaging produces an invalid file | Add a docxmcp-side validator step (LibreOffice headless or python-docx round-trip) and degrade `template/` to raw XML only if invalid |
| R-5 | Routing hint's manifest summary grows too long for very large docs (e.g. 50-chapter book) | DD-7 fold rules: lists > 4 items collapse to first + count (`chapters/01-…04-…（還有 40 份，共 44 份）`); manifest itself stays full; routing hint never inlines body content |
| R-6 | Layout-preserving legacy scanner produces too much noise (leading spaces from binary garbage) | Add a heuristic: discard any line whose printable density is below a threshold; tunable in tweaks.cfg |
| R-7 | The new `extract_all` doubles work when AI then also calls per-tool extractors (which still auto-decompose) | docxmcp's per-tool decompose is idempotent (skip if `unpacked/` exists); confirm no double work in tests |
| R-8 | `incoming/` accumulates without bound | Out of scope for this round; user can `rm -rf incoming/` ad hoc; consider eviction policy in a follow-up |

## Critical Files

- `packages/opencode/src/session/user-message-parts.ts` — **primary integration point**: wraps `tryLandInIncoming` with Office detection + cache lookup + version-rename + decomposer dispatch
- `packages/opencode/src/incoming/manifest.ts` — new manifest reader / writer (shared between upload hook, polling loop, and composer)
- `packages/opencode/src/incoming/version-rename.ts` — new paired-rename helper (DD-5)
- `packages/opencode/src/incoming/poll-loop.ts` — new per-stem polling loop for `extract_all_collect`
- `packages/opencode/src/incoming/legacy-ole2-scanner.ts` — moved out of `tool/attachment.ts`
- `packages/opencode/src/incoming/unsupported-writer.ts` — new (xlsx / pptx note + manifest)
- `packages/opencode/src/incoming/failure-recorder.ts` — new (failure manifest + failure.md)
- `packages/opencode/src/session/message-v2.ts` — routing hint generator rewrite (re-renders per turn from current manifest, per DD-13)
- `packages/opencode/src/incoming/dispatcher.ts` — unchanged role (MCP-tool dispatcher); used by poll-loop for `extract_all_collect` calls
- `packages/opencode/src/tool/attachment.ts` — strip docx / Office branches (phase 8)
- `packages/opencode/src/tool/attachment.test.ts` — update tests (phase 8)
- `~/projects/docxmcp/bin/extract_all.py` — new orchestrator (already shipped)
- `~/projects/docxmcp/bin/_mcp_registry.py` — register `extract_all` + `extract_all_collect` (already shipped)
- `~/projects/docxmcp/bin/mcp_server.py` — per-token `_last_bundled_state` (already shipped)
- `.gitignore` — add `/incoming/`
- `specs/architecture.md` — sync upload section
