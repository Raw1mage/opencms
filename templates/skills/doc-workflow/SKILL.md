---
name: doc-workflow
description: Universal methodology for turning one structured source file into one directly editable decomposition package: markdown-first materials, logical blocks, assets, render outputs, and Git-friendly version history in the surrounding documents repository. Format-agnostic at the methodology layer; the docxmcp MCP server provides file ingestion, decomposition, mutation, and rendering primitives. Use when the user wants to edit, rewrite, restructure, AI-modify, regenerate, or refresh a structured document (proposal, report, RFP response, ISMS / 服務建議書 / 企劃書 / 標書 / 政府採購文件) — particularly when the document is large enough that a one-shot LLM rewrite is impractical.
---

# doc-workflow

## 0. Iron rules (read first — these override convenience)

1. **Decompose first; never hand-touch OOXML.** Every document goes through docxmcp
   decompose → src (`body.md` / `outline.md` / canvas) before you read or edit it. If
   you find yourself running `unzip` / `zipfile` / a python recolor, or parsing
   `document.xml` / `slideN.xml` by hand — **you are off the sanctioned path; stop.**
   There is a tool for it (or report the gap). This is the MCP-first red line.
2. **Failure protocol.** If any docxmcp tool errors or its output fails validation:
   **stop, report to the user, and do NOT fall back to bash/python OOXML editing.** A
   tool gap is a tool gap — surface it, don't route around it.
3. **Lossy vs lossless — pick by intent.** Canvas `extract → render` is **lossy** (for
   authoring new content; it does NOT faithfully preserve background / theme colours /
   embedded fonts). To **reuse an existing deck and keep its look**, use **surgery**
   (`docxmcp_pptx_revise`), which is lossless (edits the original in place). Don't
   discover loss at pixel-check time — choose the lossless path up front.
   Surgery now also covers **speaker notes** (`set_notes`) and **whole-design
   edits** (`apply_view`: submit an edited anchored view; the tool diffs vs the
   original and applies only the minimal delta) inside one `batch` — so you never
   re-render an existing deck just to attach notes. Authoring a new deck
   (`render`) now routes through the **same** surgery substrate internally
   (bootstrap-blank + splice per page): there is **one** byte-faithful write path,
   not two. "Produce content → surgery the slide" is the single model.
4. **Recon budget.** Read `body.md` / `outline.md` / `scout` **once** each; don't
   re-derive the same structure across turns, and don't pixel-verify before you have
   produced an artifact.
5. **src is the single source of truth.** Persist the decomposed src as `<stem>.src/`
   (see Part A) and work from it; don't re-read the binary.

### pptx: intent → the one sanctioned sequence

| Intent | Sequence (only this) |
|---|---|
| Reuse a deck, keep its look (swap text / images / trim / notes / redesign) | upload → `docxmcp_pptx_revise` `scout` → `batch` (set_text / set_shape / add_picture / delete / set_notes / apply_view — all edits in one call) → download |
| Author a brand-new deck | `docxmcp_pptx_bootstrap` / `docxmcp_pptx_template` → edit canvas → `docxmcp_pptx_render` (internally splices each page into the surgery substrate — same write path as reuse) |
| Extract a deck's content (for reuse elsewhere) | `docxmcp_document` `decompose` (format=pptx) → read `body.md` / canvas |

`docxmcp_pptx_revise` is the **single** pptx surgery entry (token/in-place). Do not
reach for decompose-package slide tools for in-place edits.

### docx: template/report recipe uses primitive handoffs

For `.docx` reports with a `.dotx` / `.docx` template, do not invent a one-off
tool and do not use generic Python libraries. Use the primitive sequence:

1. Upload the source `.docx` and template `.dotx` / `.docx` to get tokens.
2. Call `docxmcp_document action=decompose` on the source token.
3. Edit package markdown/materials as needed.
4. Call `docxmcp_document action=assemble` with returned
   `data.next_args.assemble`, plus `template_token`, `template_mode`, and generic
   `template_contract` when the user asked for template preservation.
5. If the deliverable needs cover/TOC, call `docxmcp_document action=add_front_matter`
   with the assemble result's `next_args.add_front_matter` and the user-approved
   cover/TOC spec.
6. Preview/status/retrieve through returned handoff fields; never infer container
   token workspace paths by hand.

This is a recipe over reusable primitives, not a macro tool. If any step returns a
structured diagnostic, stop and report the contract/tool gap instead of falling back.

**Heading hierarchy is YOUR judgment, not the tool's and not the source file's.**
A document's own Heading styles / outline levels are often unreliable — government
and official templates fake structure with `Normal` paragraphs plus literal numbering
(壹、/ 一、/（一）/ 1.), `.doc`→LibreOffice conversion drops outline levels entirely,
and authors misapply styles. So never trust the native outline as authority. decompose
emits `signals.json`: one evidence record per paragraph (text, char length, font size,
bold, alignment, indentation, leading numbering token, plus the native style name and
outline level explicitly flagged as untrustworthy hints). Read `body.md` alongside
`signals.json`, **judge** the logical hierarchy from this combined visual evidence, and
annotate the markdown with heading levels (`#`, `##`, `###`) before assemble / surgery.
The tool supplies evidence; it never decides headings. A flat, heading-less dump is a
decomposition DEFECT — both round-trip paths depend on the outline (Mode B
`apply_chapter_md` anchors on it; Mode A `assemble` maps template styles + auto-numbering
off it). Domain-specific section rosters (e.g. an ISMS four-tier skeleton) are a *second*
correction layer that belongs to the caller, not docxmcp.

**Two halves**:

1. **Universal methodology** (Part A) — format-agnostic. The same SOP applies regardless of source format: docx, pdf, xlsx, future pptx / odt / rtf / etc.
2. **MCP implementation** (Part B) — how to apply that methodology using the `docxmcp` MCP server.

Other format families (when added) get their own Part B sections in this same skill, OR a sibling skill that re-uses Part A's vocabulary.

## Capability contract

Do **not** try to fuse everything into one giant prompt. The reliable composition is layered:

1. **Repo entry / red-line layer** — the repo's `AGENTS.md` tells the agent where to start and what is forbidden.
2. **Workflow layer** — this skill defines the document methodology, package model, paradigm selection, and verification discipline.
3. **Live MCP layer** — the `docxmcp` server's `InitializeResult.instructions` plus `tools/list` expose the current tool surface and JSON-Schema contracts.

In short: **this skill decides how to work; docxmcp decides what mechanical operations are available right now.**

## Canonical source and sync rule

- Canonical source: `/home/pkcs12/projects/docxmcp/skills/doc-workflow/SKILL.md`
- Deployment copy: `/home/pkcs12/projects/skills/doc-workflow/SKILL.md`
- Any content change to one copy must be mirrored to the other in the same task.
- Tool schemas must stay out of this skill; `tools/list` remains the single source of truth for wire contracts.

## When to invoke

- User has a large structured document and wants to: edit, rewrite, restructure, refresh, or AI-modify it.
- User has a regulatory / proposal / RFP document and a separate spec/requirements file, and wants the proposal aligned with the spec.
- User wants to round-trip a document: pull content out, edit elsewhere, reassemble.
- Mentions: 服務建議書, 企劃書, 標書, ISMS, RFP, 政府採購, 衛福部, 投標, "extract chapters", "extract outline", "rebuild docx".

Do **not** invoke this skill for trivial single-paragraph edits or plain-text dumps — direct python-docx / pandoc / similar one-shot calls are simpler.

---

# Part A — Universal methodology

## A.1 The cardinal rule: one source file, one editable decomposition package

The single most important habit:

> **Phase 1 — Decompose each source file into its own package before writing anything.**
>
> **Phase 2 — Edit the package directly as the document workspace.**
>
> **Phase 3 — Render physical outputs from that package.**
>
> **Phase 4 — Let the surrounding documents repo carry Git versioning.**

Why this order matters: trying to compose while decomposing means you read source documents repeatedly through the wrong lens (per-chapter rather than holistic), miss reusable paragraphs that span chapters, and end up with a thin output that needs heavy human patching. Decomposing first creates a complete **material inventory** — markdown / csv / image / formula / object artefacts — that humans and AI can edit directly as the working document.

The decomposition package is not a frozen source archive. It is the document's editable workspace. Preserve original evidence under `source/` and provenance metadata, but let `body.md`, `blocks/`, `materials.md`, `blueprint.md`, `notes.md`, and `assets/` evolve as the work evolves. Git versioning for the parent documents repo records the before/after states.

## A.2 Single-file package anatomy

One source file collapses to one directly editable package:

```
<document-package>/
├── manifest.json                        # source hash, extractor version, artefact inventory
├── source/                              # original input (docx, pdf, xlsx, ...)
├── blueprint.md                         # audience, purpose, outline, constraints, render targets
├── body.md                              # main human-editable working draft
├── outline.md                           # extracted structural snapshot
├── materials.md                         # material index, provenance, selected/rejected notes
├── blocks/<block-id>.md                 # reusable logical blocks
├── media/<material-id>.<ext>            # extracted images / drawings / screenshots
├── tables/<material-id>.csv             # extracted tables; small tables may also appear in md
├── formulae/<material-id>.<ext>         # formula images / MathML / LaTeX when available
├── objects/<material-id>.json           # charts, embedded objects, sheet metadata, layout spans
├── assets/                              # newly authored or overridden figures / tables / formulae
└── notes.md                             # decisions, TODOs, unresolved questions
```

Recommended placement in document repositories: keep the package as a sibling of the physical source or deliverable, named `<stem>.src/`. This makes extraction and recomposition use one visible convention:

```
Proposal.docx
Proposal.src/
```

Use `<stem>.src/` for both directions: decomposing an existing `.docx` / `.pdf` / `.odt` into editable materials, and rebuilding a deliverable from `body.md`, `blocks/`, `assets/`, and related package files. If the workflow needs a flat text dump or quick provenance metadata, keep them inside the same package as `extracted.txt` and `metadata.txt` rather than creating a separate `<stem>.meta/` folder.

Formal deliverables live at the package root, not in a mandatory `renders/` directory. Use versioned filenames such as `<stem>_v01.docx`, `<stem>_v02.docx`, or `<stem>_v03.pdf`. Preview images may live under `preview/` when needed, and temporary render artefacts should stay in the token workspace or another disposable cache location.

This is the universal material workspace: same intent whether source was docx, pdf, xlsx, pptx, odt, etc. Markdown is the default because text logic is the dominant editing surface and keeps AI token cost low. Use CSV / images / SVG / HTML / JSON only for material that markdown cannot represent cheaply or faithfully.

In `docxmcp`'s legacy vocabulary, a **"doc-dir"** is an implementation-specific package directory. Prefer the single `document-package` vocabulary above when reasoning about workflows.

## A.2.1 Git-backed versioning, document-native UX

Borrow Git's model, not Git's interface:

- **Working tree** → the package files humans edit directly: `body.md`, `blueprint.md`, `materials.md`, `blocks/`, and `assets/`.
- **Index / provenance** → `manifest.json` plus material references in `materials.md` / `blocks/*.md`.
- **Commit** → the surrounding documents repo commit, with a human-readable message describing the document change.
- **Branch** → a repo-level branch or copied package only when the user explicitly wants divergent variants.
- **Release artifact** → versioned deliverables at the package root, such as `<stem>_v01.docx`, `<stem>_v02.pdf`, `<stem>_v03.html`.

Do not expose `.diff` or conflict markers as the normal editing surface. Humans should experience the package as a normal editable document folder; Git records history at the repository level.

## A.2.2 Greenfield documents use the same package structure

New documents created from zero still use the same `document-package` anatomy. The only difference is how `blueprint.md` is produced:

- **No source extraction step**: create the package folder directly, with `manifest.json`, `blueprint.md`, `body.md`, `materials.md`, `blocks/`, `assets/`, and `notes.md`.
- **Interactive blueprint building**: the agent asks the user for purpose, audience, target format, constraints, style, source references, and approval gates, then writes those decisions into `blueprint.md`.
- **Dynamic content framework**: outline and section logic are negotiated between user and agent; do not invent a full structure silently when user intent is underspecified.
- **Material inventory still exists**: `materials.md` records user-provided references, copied snippets, generated tables, figures, assumptions, and missing inputs even when there is no original source file.
- **Same editing surface**: write the working document in `body.md`, split reusable logic into `blocks/`, place rich assets in `assets/` / `tables/` / `media/`, and render from the same package.
- **Same Git story**: repo-level Git records each meaningful evolution of the package; do not create an internal `outputs/` branch folder just because the package began from zero.

## A.2.3 Requirement elicitation is a writing gate

Before drafting a greenfield document, the agent must help the user make the document's logic and requirements explicit. Do not jump from a vague request to `body.md`. First build enough `blueprint.md` to answer:

- **Purpose**: what outcome should this article/document cause — inform, persuade, compare, request approval, sell, teach, record, or decide?
- **Audience**: who will read it, what they already know, what they care about, and what objections or risks they may raise.
- **Core thesis / conclusion**: what the document must make the reader believe, understand, approve, or do by the end.
- **Scope and boundaries**: what is in/out, required length, language, tone, format, deadline, compliance rules, and forbidden claims.
- **Logical route**: preferred argument flow, section order, decision tree, evidence chain, or narrative arc.
- **Required materials**: source files, notes, facts, numbers, examples, charts, images, tables, citations, templates, branding rules, and prior versions.
- **Unknowns and assumptions**: what is missing, which assumptions are safe, which require user confirmation, and which gaps block drafting.

Use structured questions for bounded choices and short open-ended prompts for context. After each answer, update `blueprint.md` and `materials.md` rather than keeping decisions only in chat. If a missing input materially changes the document's purpose, claims, compliance posture, or audience fit, stop and ask; otherwise record the assumption in `notes.md` and continue.

### Brainstorm / curation loop (salvaged from doc-coauthoring)

When a section's content is underspecified — the user knows the topic but not what to include — run a per-section convergence loop instead of silently inventing structure:

1. **Clarify** — ask 5-10 targeted questions about what the section must cover.
2. **Brainstorm** — propose 5-20 numbered candidate points (more for complex sections), surfacing angles the user may have forgotten.
3. **Curate** — user replies in shorthand ("keep 1,4,7; remove 3 dup; combine 11+12"); parse freeform feedback too.
4. **Gap check** — ask what important point is still missing before drafting.
5. **Draft into `body.md` / `blocks/`**, then refine via surgical edits — never reprint the whole document.

Preference learning: when the user corrects a draft, ask them to describe the change ("make paragraph 3 more concise") rather than silently hand-editing, so later sections inherit their style. Skip this loop when the blueprint already pins the section content; reserve it for genuinely open sections.

## A.2.4 Two source families: text-document vs 2D-design

The package shape in A.2 was tacitly designed around docx-class sources, where the renderer (Word) derives layout from text flow. That assumption holds for `.docx`, plain markdown, and long-form PDF. It **breaks for 2D-design formats** — PPT, poster PDF, infographic, Figma export — because in those formats layout *is* content, not derived from it. A package with only `body.md` + `blocks/*.md` cannot describe a slide; the 2D composition is unrecoverable.

Two families result, distinguished by **how layout relates to content**:

| Family | Layout source | Examples | Canvas layer |
| --- | --- | --- | --- |
| Text-document | Renderer derives layout from text flow | docx, plain markdown, long-form PDF | absent / empty |
| 2D-design | Layout is content (absolute composition) | pptx, poster PDF, infographic | **required** |

For 2D-design sources, the package gains a **canvas layer** under `pages/<NN>/`:

```
<document-package>/
├── (all the A.2 fields)
└── pages/<NN-title>/
    ├── canvas.html          # 2D composition: HTML in absolute-positioning + inline SVG + <img>
    ├── meta.yaml            # per-page metadata: role, optional template_layout, x_* extensions
    ├── notes.md             # speaker notes / annotations
    └── assets/              # page-local images, fonts, sub-SVGs referenced by canvas.html
```

**Why HTML + inline SVG + `<img>` and not a bespoke schema?** Because the web stack is the universal markup for 2D composition — every LLM is fluent, every browser previews it, every designer tool emits it. docxmcp invents nothing at the content layer; only the toolcalls (`docxmcp_pptx_render`, `docxmcp_pptx_extract`) are docxmcp-specific.

**Canvas authoring discipline** (full contract: [`plans/pptx_render_from_doc_package/spec.md`](../../plans/pptx_render_from_doc_package/spec.md)):

- A single `.slide` container is `position: relative` with explicit `width` and `height` (inches recommended to match PPT's coordinate system).
- Every direct child (`.slide > *`) is `position: absolute` with explicit `left/top/width/height`. Each direct child maps to one PPT shape candidate.
- Inside each child, normal HTML flow is fine — `<p>` reflows, `<ul>` bullets, `<table>` cells work natively.
- Vector geometry uses inline `<svg>`. Raster uses `<img>` — point its `src` at a package-local path, or a base64 `data:image/*` URI. To use a host/uploaded image without base64, upload it (`POST /files`), then `docxmcp_stage` the package with a `{from_token, from_rel?}` entry that copies the blob in, and reference it locally. `box-shadow`/`border-radius`/`clip-path`/`filter`/`transform` have no DrawingML mapping and render a warning (to reproduce a branded master, use master-surgery, not canvas).
- **No JavaScript inside canvas** — `<script>`, `on*` attributes, and `javascript:` URLs are rejected at parse time. Canvas is declarative content, not a program.

`pptx` is the first 2D-design format docxmcp supports via this layer. The same canvas contract will extend to other 2D-design formats (poster PDF, infographic) when their adapters land.

## A.3 Hierarchical filename convention

Media and tables embed their source location in the filename:

```
img_<chapter>[.<sec>[.<sub>[.<sub2>...]]]_<serial>.<ext>
table_<chapter>[.<sec>[.<sub>[.<sub2>...]]]_<serial>.csv
```

Examples:
- `img_3_01.png` — first image directly under chapter 3 (before any sub-section)
- `img_2.4_01.png` — first image inside chapter 2's 4th sub-section
- `table_5.1.3_02.csv` — second table inside chapter 5 / section 1 / subsection 3

Serial restarts at 01 within each unique section path. Filenames are opaque to the markdown — chapter md just references whatever filename was emitted. When recycling artefacts across components folders, the hierarchical name signals where in the source document that artefact came from, useful when auditing for cross-pollution.

## A.4 blueprint.md is the composition contract

`blueprint.md` in the document package is the single source of truth for "what this composition must achieve". It contains:

- **Purpose / audience / thesis**: the desired reader action or belief change, target reader profile, and central conclusion.
- **Spec key conditions** verbatim (case name, case number, authorising body, budget cap, deliverables schedule, team minimums, mandatory certifications, acceptance criteria, penalty terms — whatever the binding spec demands).
- **Required outline** if the spec mandates one (often appendix-listed as 「服務建議書大綱」 or similar).
- **Per-section content map**: what to keep / rewrite / delete / add; which package materials each section uses; mandatory tables and figures; tone and length rules.
- **Material request list**: what the user still needs to provide, what the agent may infer, and what cannot be drafted safely yet.
- **Cross-source policy**: which materials are structural references vs which provide reusable content vs the binding spec, and what must NOT leak across (e.g., a sister project's case-specific scope must not pollute this one).

**Every later edit traces back to a blueprint item; no free-form rewrites.** If you find yourself editing without a blueprint line to point to, stop and update `blueprint.md` first. Legacy docx-only flows may still call this `plan.md`; treat it as the same contract but prefer `blueprint.md` for new packages.

## A.5 Cross-pollution alarm

When recycling content from sister proposals or other document packages, check every factual claim against the binding spec:

- If a chapter ends up describing the source project (client name, case number, technical scope) — **delete and rewrite**.
- If a passage carries B-specific technical detail that the new spec doesn't ask for — **delete**.
- Pull factual claims (case name, case no., budget cap, deliverables schedule) from the spec, never from recycled sources.

The hierarchical filename convention and provenance notes help audit this: an image named `img_3_01.png` originating from project A's chapter 3 stays traceable even after copying into another package.

## A.6 Visual loop

Markdown alone hides layout problems (deep hanging indents, table cell widths, image overflow, page-break drift). Always close the loop by rendering the rebuilt document to images and comparing visually:

```
{format}-render-pages → preview/page_NN.jpg
```

For docx: see Part B.

## A.6b Reader verification (optional, salvaged from doc-coauthoring)

The visual loop catches layout defects; it does **not** catch comprehension defects — places where the prose makes sense to the author but confuses a fresh reader. For high-stakes deliverables (proposals, specs, decision docs, RFP responses), close a second loop by testing the rendered content against a context-free reader:

1. **Predict reader questions** — list 5-10 questions a real reader would ask of this document.
2. **Test with a fresh subagent** — dispatch each question to a `task()` subagent given ONLY the document content (no conversation context). Summarise what it got right/wrong.
3. **Run blind-spot checks** — ask the subagent: what is ambiguous, what prior knowledge does this assume, are there internal contradictions?
4. **Loop back** — feed gaps back into `body.md` / `blocks/` and re-render.

Exit when the reader subagent answers consistently and surfaces no new ambiguity. Skip this loop for routine handouts and internal notes; reserve it for documents whose misreading carries real cost.

## A.7 Anti-patterns

- ❌ Editing `source.<ext>` directly. Keep original files as evidence; edit `body.md`, `blocks/`, `blueprint.md`, `materials.md`, and `assets/`.
- ❌ Skipping `blueprint.md` and rewriting from spec on the fly — leads to drift across chapters and missed requirements.
- ❌ Hand-editing `outline.md` (it's a read-only artifact for review; recompute by re-running the outline extractor).
- ❌ Hardcoding chapter-specific text inside any tool/script — that belongs in the markdown.
- ❌ Treating the MCP server's repo as a workspace — code-only repo; packages belong in the caller's project or token workspace.
- ❌ Asking humans to edit raw diff patches. Package folders must feel like normal documents; Git history stays outside the writing surface.

## A.8 Composition pattern: "A's structure carries content for new spec"

Common request: "use the layout of project A but author content for a new spec." Clean execution order:

1. Decompose A: create a document package with structure + materials.
2. Decompose any reference proposals (B/C/...) the same way.
3. Pick the binding template — typically a generic house template rather than A's own (A's may carry A-specific style names that leak the source project's identity).
4. Choose the outline source: the spec's own mandated outline takes precedence over A's structure if the spec mandates one. Otherwise A's structure is the format frame.
5. Create or edit the target document package using A's shape as the initial `blueprint.md`; write `body.md` from the binding spec and selected package materials — A and B are *only* references, never the source of truth.
6. Rebuild with the chosen house template.

---

# Part B — MCP implementation (via docxmcp MCP server)

## B.1 Tooling discovery

The `docxmcp` MCP server exposes tools across the document lifecycle. **Do not memorise their schemas in this skill** — call `tools/list` at session start to receive each tool's description + JSON-Schema input contract. The skill points at tools by name and purpose; the wire-level details come from MCP itself.

Use MCP for mechanical file work: ingest source files, decompose document packages, inspect structures, mutate docx when preserving Word edits, rebuild, render, and retrieve produced artefacts. Use agent + this skill for semantic work: deciding the blueprint, selecting materials, writing `body.md` / `blocks/*.md`, and maintaining human-readable notes.

## B.2 Tool families (1-line role each)

> **2026-05-23 update — tool surface consolidated**. The default
> `DOCXMCP_TOOL_PROFILE=unified` now lists exactly 2 facade tools:
> `docxmcp_document` (workflow facade with 13 Mode-tagged actions)
> and `docxmcp_stage` (constructor primitive). 29 legacy tools have
> been DELETED outright; 15 are RETIRED to legacy-only visibility.
> The Mode A / Mode B dichotomy below is the new contract surface.
> Legacy tool names listed in this section remain reachable via
> `DOCXMCP_TOOL_PROFILE=legacy|full` for pinned third-party callers.
> Full migration trail: `docs/events/event_20260523_tool-group-consolidation.md`.

**Mode A — build from markdown** (full content rewrites):
- `docxmcp_document action=decompose` — source → doc_dir (autoroutes docx / pdf / xlsx / odt / pptx; PDF accepts `strategy=auto|object-aware|text-only|render-ocr`)
- `docxmcp_document action=extract_template` — source.docx → reusable .dotx
- `docxmcp_document action=extract_chapter` — selective chapter re-extract with `chapters`, `chapter_style`, `inline_tables`, `no_media`
- `docxmcp_document action=assemble` — doc_dir + template.dotx → rebuilt.docx (accepts `template`, `clean_headings`, `preview`, `preview_pages`)
- `docxmcp_document action=add_front_matter` — inject cover + Word TOC field
- `docxmcp_document action=status` — generic completion / wait for in-flight jobs (returns clean `{state, jobs, error}`; manifest internals are NOT contract)
- `docxmcp_document action=preview` — render docx pages → JPEG/PNG
- `docxmcp_stage` — stage inline files-map into a fresh token doc_dir (synthesise content without a source file)

**Mode B — surgery on docx** (byte-preserving micro-edits):
- `docxmcp_document action=open_for_revise` — inject stable paragraph bookmarks
- `docxmcp_document action=scout` — one-shot reconnaissance returning `{paragraphs, outline, styles, counts}` (replaces the entire pre-consolidation inspect surface)
- `docxmcp_document action=apply_chapter_md` — diff edited chapter md against docx and apply delete/modify/insert ops; bytes outside the edit stay identical
- `docxmcp_document action=unpack` / `pack` — raw OOXML escape hatch when markdown can't express the change (e.g. OOXML-specific run formatting)

**Mode-both**:
- `docxmcp_document action=probe` — classify a file before workflow routing

**PPTX build paths (four tracks)** — `pptx` is the 2D-design format. Pick the
track by *where the visual design comes from*. All four end in an editable
.pptx and must NOT use caller-side `python-pptx` / `pptxgenjs` / Office
automation / case-specific layout scripts. (The old `visual_spec.json` /
`docxmcp_pptx_visual_build` path is **retired** — superseded by these tracks; see
`plans/pptx_render_from_doc_package/` DD-6.)

- **Unified visual loop (mandatory for all PPTX work)** — every canvas,
  template-bank, master-surgery, existing-PPTX revise, and native recomposition
  task follows **Perceive → Plan → Edit → Render → Verify → Iterate**. First
  obtain a perception packet with visual evidence plus shape/placeholder/layout
  evidence; then write an evidence-linked edit plan; then route explicit ops to
  the existing backend. If the target was not perceived, do not mutate it. If no
  evidence-linked target exists, mark it unresolved or ask the user; never pick
  the first shape/layout/placeholder as fallback.
- **Track 1 — canvas** (from scratch / arbitrary 2D). Author
  `pages/<NN>/canvas.html` (HTML absolute-positioning + inline SVG + `<img>`,
  no JS) → `docxmcp_pptx_render` → .pptx. Browse with `docxmcp_pptx_index`
  (emits an `index.html`: left nav + live thumbnails, right full page). Use for
  bespoke layouts (diagrams, flows, infographics) or when there is no master.
  `docxmcp_pptx_extract` turns any existing deck into this package — each
  extracted `canvas.html` is itself a reusable by-example template (copy a page,
  edit its content).
- **Track 2 — template-bank** (parameterised house styles).
  `docxmcp_pptx_template(action=list)` → see templates + archetypes + typed
  slots; build a payload `{template_id, pages:[{archetype, slots}]}` →
  `docxmcp_pptx_template(action=apply)` → a canvas src package →
  `docxmcp_pptx_render`. Use when content is structured and you want one vetted,
  consistent look without hand-placing each page. The skill carries the taste
  (which template / archetype, content → payload); the tool only binds,
  deterministically.
- **Track 3 — master-surgery** (a designer's blank master — the best visual
  start). `docxmcp_pptx_extract` the master deck → read with
  `docxmcp_pptx_read(action=layouts)` (layouts / placeholders / theme) and
  `docxmcp_pptx_read(action=shapes)` (per-slide inventory) → mutate with
  `docxmcp_pptx_edit(action=add_slide_from_layout)` →
  `docxmcp_pptx_edit(action=set_placeholder)` →
  `docxmcp_pptx_edit(action=add_shape)` (textbox / picture, inline fill/line/font) /
  `action=set_shape_text` / `action=delete_shape` (or `action=batch` with an
  `ops[]` array to apply many edits in one atomic package mutation) →
  materialise with `docxmcp_document(action=pack, force=true)` → .pptx. A
  surgery package is **raw-zipped, not re-rendered** (its chrome is the master's
  own vector art); `docxmcp_pptx_render` is for canvas/template-bank packages
  only. Geometry is in inches; the new slide inherits the master's theme /
  layout / placeholder geometry. Every mutation is atomic + XSD-valid (fail-fast
  `PPTX_SURGERY_*`, no partial output). **Pack once**: get all structure into the
  package, pack a single time, then do fill/line/font styling in
  `docxmcp_pptx_revise` — re-packing after revise styling discards those edits.
- **Track 4 — native-layout recomposition** (DOCX/content package + selected
  PPTX/POTX design system). Decompose the source DOCX to `slide_molecules.json`
  → resolve the template through Template Vault/Gallery (`template_id`, stable
  selection handle, selector query, or explicit opt-in source import) → produce
  `recompose_presentation_plan` → `recompose_design_selection_plan` →
  `recompose_slot_application_plan` → agent-authored apply request → native
  apply bridge → `recompose_apply_validation_report`. Use this for the common
  request 「根據 docx 內容，及某某 pptx 為 template，重組新的 pptx」. The agent
  decides slide narrative, wording, layouts, placeholders, image boxes, and any
  split/omit choices; the tools only validate explicit evidence, create requested
  slides, fill placeholder text, insert explicitly boxed images, assemble the
  `.pptx`, and report traceability. Unsupported table/macro/overflow choices stay
  explicit unresolved items; never fake completion through rasterisation, first
  layout/placeholder fallback, or tool-side aesthetic decisions.

**Choosing the track**:
- DOCX/report content + selected PPTX/POTX style, want a new deck plan →
  **native-layout recomposition**.
- Designed master available, want native PowerPoint look → **master-surgery**.
- Consistent house style from structured content → **template-bank**.
- Bespoke 2D / diagrams / no master → **canvas**.
- **Output tool differs**: canvas & template-bank finish with
  `docxmcp_pptx_render` (canvas → .pptx); master-surgery finishes with
  `docxmcp_document(action=pack, force=true)` (edited OOXML package → .pptx);
  native-layout recomposition finishes with an agent-controlled apply assembly
  plus validation report.
- Judgement (which track, which layout/archetype, content → payload/edits) is
  the skill's job; the MCP tools perceive, execute, and validate explicit plans,
  but never decide aesthetics or fallback targets.

**Reuse a user-supplied PPTX as a template** (the most common PPTX request) —
route by whether the existing deck is the **artifact to edit** or the **design
system to reuse**. If the user wants to edit that exact PPTX, default to **Mode B
in-place surgery** (`docxmcp_pptx_revise`: scout → batch), preserving
theme/master/layout/background byte-for-byte. If the user wants a new deck from
DOCX/report content using that PPTX/POTX as template evidence, use
**native-layout recomposition** and keep all template selection/layout/slot
decisions inspectable before mutation, then execute only the agent-authored apply
request. Canvas extract-then-copy is the lossy authoring path only for fresh
by-example HTML slides. There is never a reason to fall back to caller-side
`python-pptx` / unpack-edit-pack — the whole flow exists in the MCP surface. The full recipe, track choice, and reuse hazards live in
[`pptx_template_reuse.md`](pptx_template_reuse.md); **load that file when the task
is template-based deck generation** (keep it out of context otherwise).

A specialised sub-case: a **blank brand master** whose master carries only
header/footer/logo chrome and whose content area is empty (no usable pre-designed
body layouts). To build a new deck that keeps the brand frame *and* looks
designed, you author bespoke absolute-positioned content into the empty content
area (master-surgery track) while the chrome inherits for free — this gets
"template + 設計感" without the canvas lossiness. The full workflow, the
registered TheSmart Vault masters (`thesmart_16to9` / `thesmart_4to3`), the
verified reference deck, density targets, and content-area hazards live in
[`branded_master_authoring.md`](branded_master_authoring.md); **load that file
when the task is "build a new deck on our blank brand master"** (keep it out of
context otherwise).

**PPTX aesthetic rubric + revise loop** — making "looks good" checkable. The
*eye* is the multimodal model reading a rendered raster; the rubric is the
checklist it scores against. Render → read each slide image → score → fix the
top 1–2 issues → re-render. Stop when the gate passes or after 2–3 rounds (log
what remains; never silently ship a Tier-1 fail).

Loop (authoritative view = the .pptx a client actually gets):
0. **Objective gate**: run `docxmcp_pptx_canvas_lint` (canvas / template-bank:
   on the src package or a canvas.html). It measures the Tier-1 rules
   deterministically (off-canvas, overlap, contrast, min-font, + Tier-2
   alignment/density) and returns `summary.ready`. Fix any Tier-1 before
   rendering. (Native-OOXML/surgery/recomposition output isn't canvas-lint-covered
   yet — use the structured recomposition validator, then eyeball Tier-1 from the
   raster.)
1. Render to PNG: master-surgery → `docxmcp_document(action=pack, force=true)` then
   `docxmcp_pptx_thumbnail`; canvas / template-bank → `docxmcp_pptx_render` then
   `docxmcp_pptx_thumbnail` (or open `docxmcp_pptx_index` for the live HTML view).
2. Read each slide PNG; score the (subjective Tier-2) dimensions below.
3. Triage remaining Tier-1 first, then Tier-2; apply fixes with the active
   track's tools; re-lint + re-render.

Tier 1 — must pass (this is 80% of why AI slides look broken):
- **Containment**: nothing clipped or spilling past the 13.33×7.5in canvas;
  keep a ~0.4–0.5in safe margin. FAIL if any element is cut off or bleeds off-edge.
- **No collision**: no two elements overlap illegibly. FAIL on overlapping text.
- **Legibility / contrast**: body vs background ≈ WCAG AA (≥4.5:1 body, ≥3:1 for
  ≥24pt); body size ≥ ~18pt. FAIL on low-contrast or sub-14pt body text.

Tier 2 — quality (≤2 WARNs tolerated):
- **Hierarchy / focal point**: exactly one title; clear size/weight steps
  (title > subhead > body); one obvious focal point per slide.
- **Alignment**: elements share a grid / common left edges; geometry is not
  visually random (snap x/y to a small set).
- **Whitespace / density**: ≤ ~6 bullets or one idea-cluster per slide; generous
  gutters; not crammed.
- **Colour discipline**: ≤ ~3 main colours + neutrals; accent purposeful and
  consistent with the theme tokens.
- **Type consistency**: ≤2 font families; same-role elements share size; respect
  a type scale.
- **Cross-slide consistency**: title position, margins, accent placement
  consistent deck-wide.

Gate: PASS when there is no Tier-1 FAIL and ≤2 Tier-2 WARNs; else pick the 1–2
highest-impact fixes and loop.

Fix → tool mapping:
- too much text / too many bullets → fewer, shorter (template-bank: edit
  payload; canvas: edit `canvas.html`; surgery: `set_shape_text` /
  `set_placeholder`).
- off-canvas / overlap / misaligned → correct geometry (canvas: edit inline
  `left/top/width/height`; template-bank: choose a better archetype; surgery:
  re-place via `delete_shape` + `add_shape` — move/resize is v1.x).
- low contrast / off-palette → align to the theme (template-bank theme overlay;
  canvas `shared.css`; surgery: the master theme already governs placeholders).

Honest limits: the objective Tier-1 checks (containment / overlap / contrast /
min-font / alignment / density) are measured deterministically by
`docxmcp_pptx_canvas_lint` over canvas.html — run it as the gate; the model's eye
then scores the subjective Tier-2 from the raster. The linter covers the canvas /
template-bank tracks; native-OOXML (master-surgery) output is not lint-covered
yet, so eyeball its Tier-1. LibreOffice raster ≠ PowerPoint pixel-exact — treat
it as the authoritative *deliverable* view, not a fidelity guarantee.

**Picking a mode**:
- If the goal is "rewrite content" / "produce a new docx from authored markdown" → Mode A.
- If the goal is "fix typo / case-number / one paragraph and preserve everything else byte-for-byte" → Mode B.
- If the content is rich markdown but the target docx is finished and you want byte-preserve elsewhere → Mode B `apply_chapter_md` with `md_content`.

**Where project conventions live now** (D7 of the consolidation):
project-specific rules (image width, table column weighting, page break
policy, image inline policy, ...) live in `AGENTS.md` (repo-wide) or
`<doc_dir>/doc_rules.md` (per document) — NOT in dedicated tools. AI
reads the rule document at task start and applies via the mechanism
tools (`unpack` → edit XML → `pack`).

When you don't know which action fits a step, call `tools/list` and
read each action enum's description — every action carries a
`Mode: A | B | both` prefix.

### PDF source adapter

Decompose a PDF through the unified facade: `docxmcp_document action=decompose
format=pdf` (the old `docxmcp_pdf_extract_all` is retired into legacy-only
visibility). Upload the PDF first (B.8) and pass the **`token`** — the server
resolves single-file *and* staged/tarball tokens to the lone PDF, so the token
workflow works the same as docx.

**Strategy selection** (`strategy=auto|object-aware|text-only|render-ocr`):
- `auto` → `object-aware`: text pass + an embedded-object pass (images / tables /
  formulae crops). Best for electronic PDFs that carry figures.
- `text-only`: text layer only — the right choice for **pure-text layouts**
  (government notices, contracts, long-form reports). Cheaper and avoids the
  object pass entirely.
- `render-ocr`: for scanned / image-only PDFs with no text layer.

On failure the result carries a structured `error` with `code` + `alternatives`
(e.g. `PDF_TEXT_TOO_SPARSE` → try `render-ocr`; `PDF_OBJECT_EXTRACTION_FAILED` →
try `text-only`). If a default `object-aware` run comes back empty for a
text-only document, re-run with `strategy=text-only` rather than concluding the
PDF is unsupported.

Adapter boundaries:
- It reads the PDF text layer (pypdf); it does not OCR or AI-vision unless you
  pick `render-ocr`.
- It writes `manifest.json`, `body.md`, `outline.md`, `blocks/*.md`,
  `figures_manifest.json`, and `tables_manifest.json` into the token workspace.
- It preserves page provenance with `<!-- page: N -->` markers and block page spans.
- Figure/table manifests are semantic indexes from captions only:
  `image_extracted=false` and `body_reconstructed=false` mean no crop or table
  body has been produced.

## B.3 Standard 7-step workflow (the spec → docx flow)

1. **Elicit intent and inputs** — identify whether this is greenfield or source-based; guide the user to clarify purpose, audience, thesis, target formats, constraints, source/reference materials, and missing facts (A.2.3).
2. **Create or decompose the package** — for source-based work, upload each source file (B.8) and call `docxmcp_document action=decompose` with the `token` (it autoroutes docx / pdf / xlsx / odt / pptx); for greenfield work, create the package folder directly. Treat each result as one document package.
3. **Prepare the package workspace** — ensure `manifest.json`, `blueprint.md`, `body.md`, `materials.md`, `notes.md`, `blocks/`, `assets/`, and `renders/` exist in the same package folder.
4. **Author blueprint.md** (Part A.4 / A.2.2 / A.2.3). Read every binding spec and package; for greenfield documents, build the content framework through user-agent interaction before drafting, and record unanswered material requests.
5. **Edit body.md / blocks/** — write the complete human-editable document from selected materials. Reference tables/media/assets by relative path; keep provenance in `materials.md` and inline notes.
6. **Assemble / render** — `docxmcp_document action=assemble` (doc_dir=token) rebuilds the deliverable from the edited package; use the `next_args.assemble` the decompose result handed back. (pptx uses its own render/pack tracks in B.2.)
7. **Verify** — run visual/text checks for each target format; record result in `notes.md`. Let repo-level Git record the version history.

## B.4 Choosing paradigm: rebuild vs revise

| Scenario | Paradigm |
|---|---|
| New docx from scratch (no source) | Elicit purpose / audience / thesis / materials; create package; write `blueprint.md` + `body.md`; render |
| Existing docx, large structural rewrite | Decompose to package; edit `blueprint.md` + `body.md`; render |
| Existing docx, targeted edits, **preserve user's Word revisions** | Revise (B.6 below) |
| User edited docx in Word and wants AI to continue without losing those edits | Revise |

## B.5 Markdown contract for chapters/*.md (rebuild paradigm)

| markdown | Word output |
| --- | --- |
| `## …` | chapter (frontmatter `chapter_style`, default `List Bullet 3`) |
| `### …` | Heading 2 |
| `#### …` | Heading 3 |
| `##### …` | Heading 4 |
| plain line | `標N內` (depth-aware) — falls back to Normal |
| `- foo` | `標N點` (depth-aware) — falls back to List Paragraph |
| `1. foo` / `(一) foo` | `標N號` (depth-aware) — falls back to Normal |
| `<!-- table: tables/table_2.3_01.csv -->` | Word table from external CSV (UTF-8 BOM) |
| `<!-- table: tables/foo.csv; caption: 表 1 ... -->` | …with bold caption above |
| `\| a \| b \|` | inline Word table (`<br/>` for soft break in a cell) — small hand-written tables only |
| `![](media/x.png){width=6in}` | inline picture (default 6 in) |
| `<!-- pagebreak -->` | page break before next paragraph |
| `<!-- style: X -->` | next paragraph uses style `X` |

Inline `**bold**`, `*italic*`, `***bold italic***` map to run properties.

### Hierarchical paragraph styles (`標N{內,點,號}`)

Corporate templates (e.g. `ISMS_Template.dotx`) define a style set keyed by heading depth:

| Depth | Heading | 內文 (inner) | 點條列 (bullet) | 號條列 (numbered) |
|---|---|---|---|---|
| 1 (under H2) | Heading 2 | 標1內 | 標1點 | 標1號 |
| 2 (under H3) | Heading 3 | 標2內 | 標2點 | 標2號 |
| 3 (under H4) | Heading 4 | 標3內 | 標3點 | 標3號 |

`docxmcp_rebuild_docx` walks each chapter md, tracks current depth, and uses `resolve_hierarchy_style(doc, depth, kind)` to pick the right `標N{內/點/號}` style. Missing styles fall through to shallower / deeper / `Normal` / `List Paragraph`.

Numbered list patterns recognised by the parser: `1. text`, `(1) text`, `（1）text`, `(一) text`, `（一）text`, `一、text`.

Plain paragraphs that end up styled `Normal` after rebuild are **orphans** — fix by adding `<!-- style: X -->` or by rewriting the markdown to use a recognised form.

### Template / Word deliverable rules

When the target is a polished `.docx`, treat the `.dotx` template as a full document contract, not merely a style bag. A normal Word deliverable must include front matter and updateable navigation unless the user explicitly says otherwise.

**Assemble defaults (no template specified)**:

- The built-in default template is **`cht_template.dotx`** (CHT house style; `heading 1`–`5` carry auto-numbering `numPr`). Override per call with `template=`, or per environment with `$DOCXMCP_DEFAULT_TEMPLATE`; `base.docx` is the fallback when cht is absent.
- **Do not hand-number headings in markdown.** The assemble step strips manual heading prefixes (`第一章` / `1.1` / `一、` / `壹、` / `(1)` / `1.` …) so the template's auto-numbering is the single source of truth — hand-typed numbers would otherwise show twice. Non-number leading tokens (`第三方`, `5G`, `1.5cm`) are left intact. Disable with `--no-strip-heading-prefix` only if the template has no heading numbering.
- **CJK↔ASCII boundary spaces are removed** on assemble (`使用 Python 套件` → `使用Python套件`). ASCII-internal (`Table 1`) and full-width (U+3000) spaces are kept. Disable with `--no-strip-cjk-space`.
- **Minimal markdown→docx path**: assemble needs only `manifest.json` + content markdown. If the package has no `chapters/*.md` (e.g. a PDF-decomposed package, or a hand-staged one), assemble falls back to the root `body.md` — so "stage `manifest.json` + `body.md` → assemble" works without splitting chapters. `source.format` (e.g. `markdown`) is provenance only and never conflicts with the docx target format.
- **Assemble errors are concrete**: a failed assemble reports the real reason (missing markdown / missing template) on the error message, not the rebuild usage text.

**Front matter is mandatory**:

- Add a title page before the first chapter. Use the template's cover/title styles (for the current CHT template: `置中大大`, `置中大`, `靠左大`) instead of ad-hoc large text.
- Add a table-of-contents page after the title page and before chapter 1. Use the template's TOC heading style (`toc 1` in the current template) and insert a real Word TOC field such as `TOC \\o "1-3" \\h \\z \\u`.
- The required order is: **title page → TOC page → body**. Verify this order in the generated `.docx`; do not rely on the renderer's default behavior.
- Word/LibreOffice may require the user to update fields to populate page numbers. That is acceptable only if the TOC field exists; a plain placeholder is not enough.

**Template numbering must be preserved**:

- Do not use `--clean-headings` for formal outputs that rely on template numbering. It removes Heading 1–9 `numPr` and will make chapter/section numbers disappear.
- Validate that `Heading 1`, `Heading 2`, `Heading 3` and template list styles such as `標1點`, `標2點`, `標1號`, `標2號` still have `numPr` after rebuild.
- Use template styles for lists. Never fake bullets with Unicode bullet characters; use Markdown bullets/numbered lists so `docxmcp_rebuild_docx` maps them to `標N點` / `標N號`.

**Table and figure rules**:

- Prefer Markdown tables for comparisons, classifications, roles, risks, and mitigation summaries; they should become real Word tables, not screenshots.
- Keep tables Word-friendly: concise cells, explicit headers, no overly wide prose columns, and captions when needed.
- Images/diagrams must be inserted as images with captions or figure notes; do not leave only JSON/SVG source paths in the final narrative.

**Output placement**:

- The formal `.docx` should live at the package root (`<stem>/<title>.docx`) unless the user asks otherwise.
- `renders/` is for intermediate docxmcp work dirs, previews, backups, and validation artifacts; do not hide the formal deliverable there.

**Verification gate**:

- Open the produced file with `python-docx` or equivalent to verify front matter order, heading/list `numPr`, paragraph/table counts, and TOC field presence.
- Convert with LibreOffice or render preview pages when available; record the result in `notes.md`.

## B.6 Revise paradigm (in-place mutation)

When the user has revised the docx in Word and wants AI to continue editing without losing those revisions, **don't go through rebuild**. Use the mutation primitives:

1. **Bootstrap**: call `docxmcp_open_docx_for_revise` once. This injects stable paragraph bookmarks (idempotent — existing bookmarks preserved) and returns the ID map.
2. **(Optional) Re-extract** with `docxmcp_extract_chapter --with-bookmark-ids` to get chapter md with `<!-- p:p_<chap>_<sec>_<seq> -->` markers — AI sees the same IDs in md as in docx.
3. **Locate** target paragraphs/sections by ID or text (locate primitives in B.2).
4. **Mutate** via the mutate primitives. Each call is atomic: the docx is re-parsed, op applied, atomically saved. No session state to manage.
5. **Strict-error discipline** (DD-4 in `plans/mcp_revise-paradigm/`): if any ID-target is missing, the call refuses to apply and reports `ID_NOT_FOUND`. Re-extract to re-align with the current docx state, then retry. **Never let the AI fall back to fuzzy text matching** — silent miscorrections in research / legal docs are worse than the round-trip cost of re-extracting.

The revise paradigm preserves Word-level user revisions byte-for-byte in regions AI didn't touch (round-trip 100% on L1+L2+L3 tiers; track changes / embedded OLE etc. require pre-flight Accept All by the user — see `plans/mcp_revise-paradigm/spec.md`).

## B.7 docx-specific recovery

| Symptom | Action |
|---|---|
| Source docx has no styles | `docxmcp_apply_styles --rules style_rules.json` first, then resume at step 4 |
| Need a manual TOC inserted | `docxmcp_build_toc` after rebuild |
| Template missing in `templates/` | run `docxmcp_extract_styles` (step 3) |
| Need extra images from a prior version | `docxmcp_merge_media` |
| Chapter heading text empty in body | `docxmcp_extract_outline` falls back to TOC `toc 1` entries; no action needed |
| User in Word added bookmarks / format painter / large copy | revise paradigm only — rebuild would lose them |

## B.8 File transfer & session workspace (the one model, all formats)

The MCP server is a docker container with HTTP-over-UDS transport (DD-12); the
client (this agent, via opencode) and the server do **not** share a filesystem —
a host absolute path like `/home/you/doc.pdf` is invisible inside the container.
There is **no WebDAV mount**. Instead the boundary is a *session-handle facade*
(commit `session-handle facade`): one **token = one session workspace** (a
directory in the server's session cache). Everything — docx, pdf, pptx, xlsx,
odt — rides this same upload → decompose(src) → edit → assemble → download spine.

**Populate a workspace (write into the server)** — three entry points, all mint a token:
- **Single file** → `POST /files` (multipart). The token carries that one file.
  In practice opencode does this for you: pass a project-relative or absolute
  *client* path as the facade's `path` arg and the dispatcher uploads it and
  swaps in the token. (Do not hand the server a raw container path.)
- **Multiple files / a whole package** → `POST /files` with a tarball
  (`Content-Type: application/x-tar`), or `docxmcp_stage` with an inline
  files-map. This is a **staged** token: its directory holds the files plus a
  `.docxmcp-meta.json`.
- **Tool output** → decompose / assemble / render write their artefacts *into
  the same token directory*, so the workspace accretes the src package and
  deliverables under one handle.

**Operate on a workspace** — two arg shapes, same token:
- Source-taking actions (`decompose`, `probe`) take **`token`**. The server
  resolves the token to its lone source FILE: a single-file upload → that file;
  a staged token → the one non-meta file in the directory. A staged token with
  several files raises `token_ambiguous_source` — pass **`token` + `path=<rel>`**
  (a relative path inside the workspace) to name the one you mean. You never need
  an internal container path; a host absolute path that the container can't see
  returns `path_not_visible` (upload it instead).
- doc_dir-taking actions (`assemble`, `add_front_matter`, `scout`,
  `apply_chapter_md`, `unpack`/`pack`, `status`, `preview`) take **`doc_dir`**,
  which accepts the **bare token** as a directory handle. Single-file CRUD
  (`write_file` / `delete_file` / `list_files`) lets you edit one file inside the
  workspace without re-staging the whole package.

**Read back (download from the server)** — `GET /files/{token}/blob/<rel>` for any
artefact; `body.md` is `/files/{token}/blob/body.md`, a rebuilt docx is its
`out_path` rel. Tool results carry these for you: `structuredContent.produced[]`
lists the rel paths, `next_args` pre-fills the follow-up call, and ResourceLinks
expose the blobs — prefer those over guessing paths.

So the unified workflow is format-agnostic: **upload → `docxmcp_document
action=decompose` (token) → edit the src package in place → `action=assemble`
(doc_dir=token) → download the blob**. docx/pdf/pptx differ only in adapter
internals, not in how files cross the boundary.

Other facts so AI doesn't reinvent:
- `_token_store.py` (file tokens) ≠ `_docx_session.py` (in-memory Document holders, in-process only — not exposed through MCP per DD-8).
- The slim Dockerfile variant (default) doesn't include LibreOffice. `docxmcp_docx_to_images` and `docxmcp_pack_docx` (corruption check) require the `full` variant. `soffice` is **not** a runtime dependency of the rebuild or revise paradigms — DD-6.

## B.9 docxmcp repo is code-only

`docxmcp` itself never hosts the long-lived package workspace. Document packages live in the **caller's project** or in the MCP token workspace until fetched. Resolution order (recognised by all CLI / MCP tools):

1. Absolute path
2. Path relative to the caller's `cwd`
3. If `$DOCXMCP_WORK` is set: name relative to that env path

Templates (`.dotx`) ship inside docxmcp at `<repo>/templates/`. Override per project with `$DOCXMCP_TEMPLATES`.

---

## Direct-edit package cheat sheet

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ Decompose            │     │ Edit / render         │     │ Revise via mutation   │
│ (MCP primitives)     │     │ (agent + skill)      │     │ (MCP primitives)      │
│                      │     │                      │     │                      │
│ source file →        │     │ document package →   │     │ Word-revised docx →   │
│ document package     │     │ blueprint/body/      │     │ stable IDs → locate → │
│ body/blocks/tables/  │     │ blocks/assets →      │     │ mutate same docx      │
│ media/objects        │     │ renders/*            │     │                      │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
          ↓                            ↓                              ↓
  source evidence preserved    human edits are direct         user's Word edits SAFE
                               Git tracks history             (faithful at L1+L2+L3)
```

Pick by intent — direct package editing for large structural rewrites / new outputs, revise for targeted edits over a Word-revised source.
