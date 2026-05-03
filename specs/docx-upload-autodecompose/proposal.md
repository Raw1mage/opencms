# Proposal: docx-upload-autodecompose

## Why

When a user attaches a Word document (.docx) to a chat message, the AI today
must call a docx-handling tool to even see the body text — every read, every
summary, every search costs a tool round-trip and AI tokens. Worse, the
referral chain from the upload-time tool to the docx-handling tool was
documented in prose and required the AI to parse a long redirect note,
optionally lazy-load tools, and pick the right one by intent. A real session
on 2026-05-03 (`ses_21399718cffeTk8Um1AfPKx9sc`) hit this end-to-end: the
codex-backed agent looped on the upload-time tool's digest call until the
runtime runaway-stop fired, never reaching the docx tooling at all.

Two related issues compound the pain:
- The same upload-time tool is also the place where image / PDF / legacy
  Office handling lives, so its responsibilities are tangled. Users
  reasonably (but wrongly) think "anything to do with attached files is
  this tool's job".
- The docx-handling tool already auto-decomposes a docx into a
  human-readable tree of paragraphs / outline / chapters / tables / images
  on every call. That decomposition is great — but it only happens when the
  AI calls a tool. If we run it at upload time instead, the AI sees a
  ready-to-read directory before it even starts thinking, and most docx
  questions become "read this file" rather than "call a tool".

The pressure: docx is by far the most common attached format in this
deployment (legal / proposal / contract documents). Saving the AI a tool
round-trip for every docx question saves real tokens, eliminates the loop
class of bugs, and makes the user's mental model match the code.

## Original Requirement Wording (Baseline)

Captured verbatim from the user across the design conversation on
2026-05-03:

- "其實attachment可以當成all in one的toolcall proxy，它懂得所有的mcp操作，
  也能轉達AI request去調用mcp。你覺得如何？" — initial (rejected) framing
  that the upload-time tool should proxy all MCP work.
- "我也覺得不好。問題多。那就回到原本的問題．attachment存在的目的，和
  docxmcp存在的目的，是不是有重疊？我一直覺得attachment只是對話中有附檔
  時的一個runtime處理機制，不應該帶什麼AI token需求。當它判斷出檔案是
  docx的時候，就該回報AI去lazy load docxmcp來接後續的工作了" — the core
  principle: upload-time machinery handles routing and decomposition
  without spending AI tokens.
- "合理是由attachment去調用docxmcp" — direction confirmed: the docx tool
  is invoked from the runtime side, not from the AI side, when possible.
- "我設下的新規定是，只要一觸發mcp處理 docx，先拆檔到<stem>後再回應使用
  者的任何問題。" — decompose-first SOP locked.
- "關於舊doc。之前問過了。不靠第三方的話只能硬解純文字。那就做一個硬解
  純文字的fallback path來處理，免得AI撞壁了又花token去處理。" — old
  Office (.doc / .xls / .ppt) gets an in-process plain-text fallback,
  no third-party dependency.
- "xls ppt允許擴大處理。原則一樣，在incoming/<stem>拆解檔案內容。整個
  incoming不列入gittrack" — same SOP applies to .xls and .ppt; the
  incoming directory is gitignored.
- "我認為即使是十萬字等級的稿件也都是秒級處理，不用擔心。" — synchronous
  decompose at upload is acceptable; no background or progress UI needed.
- "我想像中的情況是，runtime已經把該拆的東西都拆好了，AI只要知道檔案在
  哪並開reader tool去讀就好了。" — final mental model: runtime delivers a
  ready-to-read tree; AI uses standard read tools.

## Requirement Revision History

- 2026-05-03: initial draft created via plan-init.ts; captures the
  conversation that started from a runaway-loop incident in
  `ses_21399718cffeTk8Um1AfPKx9sc` and converged on the synchronous
  upload-time decompose model.

## Effective Requirement Description

When a user uploads a Word document (.docx), the upload-time machinery
synchronously decomposes it via the docx-handling tool into a fixed,
human-readable directory tree under `incoming/<stem>/`. The tree
contains: full body text, outline, per-chapter markdown, tables as CSV,
extracted images, AND the document's template assets (styles, theme,
numbering, plus a repackaged reusable .dotx) so the document can be
rebuilt or another doc can inherit its look. A manifest lists everything
in the tree; the user's message is decorated with a plain-language
summary of the manifest. The AI then reads from the tree using its
standard read / grep / glob tools. Editing the docx is the only path
that still requires the AI to invoke docx-handling tools.

Legacy Office formats (.doc, .xls, .ppt) follow the same SOP using an
in-process printable-runs fallback. The fallback preserves line
breaks, blank lines, and leading whitespace from the source bytes and
writes the output as `body.md` (not `.txt`) so the AI can use layout
cues to guess heading hierarchy and restore some structure. The
manifest marks the extraction as "noisy, structure-guessable".

New-format spreadsheets and presentations (.xlsx, .pptx) cannot be
decomposed without a third-party zip parser. The upload-time machinery
creates `incoming/<stem>/unsupported.md` (so the AI's read path is
identical regardless of format) explaining the constraint and asking
the AI to advise the user to convert to .docx; a future xlsx-mcp /
pptx-mcp can fill in the gap without changing the AI-facing contract.

Failures during decomposition are soft: the upload still succeeds, and
the message carries a one-line plain-language reason that the AI can
quote back to the user or use to decide its own next step. The
content-hash cache key is `sha256(file_bytes) + original_filename`,
so two uploads of the same content under different names produce
distinct stems (visual alignment with the user's message wins over
de-duplication).

After this work lands, the upload-time tool has no docx / Office logic
left in it; its remaining role is image / PDF reading via reader
subagents and small text / JSON preview.

## Scope

### IN
- New synchronous decompose hook in the upload dispatcher for .docx,
  .doc, .xls, .ppt, .xlsx, .pptx.
- New all-in-one decompose entry on the docx-handling tool (one call
  produces full text + outline + chapters + tables + images + manifest).
- Manifest format: a single `manifest.json` per `<stem>` directory,
  documenting every file, its purpose, and a small summary number
  (line count, heading count, etc.).
- Content-hash cache so identical re-uploads skip work.
- Soft-fail on decompose error: upload succeeds, message carries the
  failure reason for the AI.
- Refactor of the user-message routing hint to render the manifest in
  plain language; remove the long "use these tool names" prose.
- Removal of all docx / Office branches from the upload-time tool
  (`attachment` tool); image / PDF / text / JSON paths stay.
- Add `/incoming/` to `.gitignore`.
- Update tests to match the new flow.

### OUT
- A real Excel / PowerPoint extractor (would need a zip parser; out of
  scope for this round).
- An OLE2 structural parser for cleaner legacy Office output (the
  printable-runs fallback stays).
- Background / async decompose; progress UI; cancellation.
- Auto-conversion of .doc / .xls / .ppt to .docx.
- Changes to image / PDF reader-subagent paths.
- Changes to non-Office binary attachment handling.

## Non-Goals

- We do not promise byte-perfect text extraction for legacy Office —
  the fallback stays explicitly noisy.
- We do not introduce any third-party dependency (no pandoc, no zip
  library beyond what is already shipped, no OLE parser).
- We do not change the docx tool's existing per-call auto-decompose
  behaviour; the new entry is additive (the runtime calls the new
  entry, but per-tool calls remain unchanged for editing flows).

## Constraints

- No third-party runtime dependency may be introduced. The decomposer
  must work with what is already shipped in opencode and the
  docx-handling tool.
- Decompose must be synchronous and complete before the user message
  reaches the AI. User-stated tolerance: 100k-word manuscripts process
  in seconds; this is an acceptable upper bound.
- `incoming/<stem>/` directory layout becomes a contract — once shipped,
  the AI is trained (via routing hints) to expect specific filenames.
  Layout changes need a coordinated update to the routing hint generator.
- `incoming/` is never tracked by git.
- Content-hash cache lives on the host filesystem; cache invalidation
  is purely on hash mismatch (no time-based eviction in this round).
- All silent fallback is forbidden (per AGENTS.md rule 1). Decompose
  failures must surface concretely in the AI's view of the message.
- Plain-language discipline: the routing hint text the AI sees uses
  human language with file paths as anchors, not function / tool
  identifiers as primary content.

## What Changes

- The user-facing experience: AI replies to "summarise this docx"
  questions immediately, with no visible "calling tool…" round-trip.
- AI prompt context for upload turns: routing hint is shorter and
  describes the tree, not the tool catalog.
- Disk layout: every uploaded Office file produces a sibling
  `incoming/<stem>/` tree alongside `incoming/<stem>.<ext>`.
- The upload-time tool (`attachment`): docx / Office branches removed;
  contract narrows to "AI-callable query tool for image / PDF / text /
  JSON refs only".
- The docx-handling tool: one new entry (the all-in-one decompose);
  existing entries unchanged.
- Telemetry: a new event records decompose latency, file size, hit /
  miss on the hash cache, and soft-fail reasons.

## Capabilities

### New Capabilities
- **Upload-time auto-decompose for Office files**: any .docx / .doc /
  .xls / .ppt / .xlsx / .pptx upload triggers a synchronous decompose
  step before the AI sees the message.
- **All-in-one decompose entry on the docx tool**: a single call
  produces the complete tree + manifest, replacing the current pattern
  of three separate calls (full text / outline / chapters).
- **Template / dotx extraction as part of decompose**: the tree
  includes a `template/` subfolder containing styles.xml,
  theme*.xml, numbering.xml, settings.xml, fontTable.xml — and a
  ready-to-reuse `template.dotx` repackaged from the source. This
  is the foundation for "rebuild this docx" or "reuse this look in a
  new doc" workflows, both of which were previously possible only
  by hand-running unpack_docx.
- **Manifest as the AI's primary docx interface**: the AI reads
  `manifest.json` (or its rendered summary in the routing hint) to know
  what is in the tree, then reads the actual files with standard
  read / grep tools.
- **Content-hash cache for identical re-uploads**: skip work entirely
  when the cache key (sha256 of bytes + original filename) matches.
- **Layout-preserving fallback for legacy Office (.doc / .xls /
  .ppt)**: the printable-runs scanner is rewritten to emit `body.md`
  instead of a deduped `body.txt`, preserving newlines, blank lines,
  and leading whitespace so the AI can guess heading hierarchy from
  layout cues.

### Modified Capabilities
- **Upload-time tool (`attachment`) responsibilities**: shrinks to
  image / PDF / text / JSON only; all Office handling lifted out.
- **Routing hint text in user messages**: changes from "call tool X
  with arguments Y" prose to "tree at incoming/<stem>/, here is what is
  in it" plain-language summary.
- **docx-handling tool's per-call auto-decompose**: still runs (it is
  idempotent and harmless), but its output is no longer the primary
  source for the AI on first read; the upload-time decompose has
  already populated the tree.

## Impact

- **opencode upload dispatcher** (`packages/opencode/src/incoming/`):
  new sync hook for Office mimes; calls the docx tool entry or the
  in-process printable-runs scanner depending on format.
- **opencode message composer** (`packages/opencode/src/session/
  message-v2.ts`): routing hint generator rewrites for Office mimes.
- **opencode upload-time tool** (`packages/opencode/src/tool/
  attachment.ts`): docx / Office branches removed; tests updated.
- **docx-handling tool** (separate repo at `~/projects/docxmcp/`):
  one new entry that orchestrates the existing extract-text /
  extract-outline / extract-chapter scripts and emits a manifest.
- **`.gitignore`**: add `/incoming/`.
- **Telemetry consumers**: new event type to handle.
- **Documentation**: `specs/architecture.md` upload section reflects
  the new SOP.
- **Cross-repo coordination**: the docx tool entry must ship before
  the opencode dispatcher hook is enabled; otherwise opencode would
  call a non-existent entry. Phase ordering matters.
