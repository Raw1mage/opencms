# PPTX template reuse — a user's deck becomes the template

> Loaded on demand from `SKILL.md` Part B.2. Read this only when the task is
> "take this finished `.pptx` and generate a new deck that keeps its look."

## The request, stated plainly

The user hands you a finished `.pptx` and says 「用這個當範本」 / "make a deck
like this for chapter 7" / "swap in my content but keep the design". They mean
one intuitive thing:

> **Keep the background, colours, fonts, and per-slide layout. Replace only the
> content.**

Template reuse is a **surgery task**: the new deck *is* the original file with
unwanted content removed and text swapped — nothing about its format is rebuilt.
Because the flow is fully covered by the MCP tools, **never** drop to caller-side
`python-pptx`, `pptxgenjs`, or host-side unpack-edit-pack — that is the failure
mode this recipe exists to prevent.

## The default: Mode B in-place surgery (`docxmcp_pptx_revise`)

When the intent is "keep the look, swap content", edit the **original `.pptx` in
place** and let every built-in format ride along untouched. This is the pptx
parity of docx Mode B; it preserves theme / master / layout / background / fonts /
media **byte-for-byte** because they never leave the file.

    upload (POST /files → tok_*)
    docxmcp_pptx_revise action=scout            → slide indices + stable slide_id + shape ids
    docxmcp_pptx_revise action=batch            → apply ALL edits in ONE call (see below) — the default
    # the file at tok_* IS the finished deck — retrieve its blob; no render/assemble step

**Use `action=batch` for the build — not dozens of single calls.** A full reuse
(swap text on N shapes, add the images, drop/reorder slides) is one `batch` call whose
`ops` is a JSON array, applied in one open→mutate→save cycle. Doing it as separate
`set_shape_text` / `add_picture` / `delete_slides` calls is one LLM round each and does
not scale — a 24-slide build that way runs hundreds of rounds and stalls. Author the
ops against the scouted indices, put structural ops (`delete_slides` / `rearrange` /
`duplicate`) last:

    docxmcp_pptx_revise action=batch ops=[
      {"op":"set_shape_text","index":1,"shape_id":84,"text":"…","min_font_pt":16},
      {"op":"add_picture","index":5,"image_token":"tok_…","fit":"contain"},
      {"op":"duplicate","index":9,"insert_after":9},
      {"op":"delete_slides","indices":[20,21,22,23,24]}
    ]

Single-op actions (`scout`, `set_shape_text`, `add_picture`, `delete_slides`,
`rearrange_slides`, `duplicate_slide`) still exist for one-off tweaks, but the build
itself is one `batch`.

Hazard: `delete_slides` takes a comma list and deletes descending in one call, so a
single call is index-shift safe; if you target indices across *separate* calls,
re-`scout` between them because indices renumber after each deletion.

## When to use canvas extract-then-copy instead (by-example HTML retemplate)

The canvas track (`docxmcp_pptx_extract` → copy `pages/<NN>/canvas.html` → refill →
`docxmcp_pptx_render`) is **not** the default for reuse: it re-synthesises each
slide from HTML, so it is lossy by construction (per-slide backgrounds, gradients,
effects, native placeholder inheritance can degrade — see
`issues/issue_20260603_pptx_extract_drops_slide_background.md`). Reach for it only
when you genuinely want a slide as a **by-example HTML template** to author fresh
content against (DD-6, `event_20260529_pptx-canvas-template-collapse.md`), not when
the goal is to preserve the original deck's exact look. For "keep the look", prefer
Mode B above.

## The canvas-track recipe (A.1 phases — for authoring fresh content by example)

> Use this section only on the **canvas / by-example** track (above): when you are
> building a *new* deck's content against the template's slides as HTML examples.
> For pure "keep the look, swap content" reuse, use **Mode B in-place surgery**
> and skip this section.

**Phase 1 — Decompose the template.** Upload the deck (`POST /files` → `tok_*`),
then `docxmcp_pptx_extract` → a document package with `pages/<NN>/canvas.html`.
Survey the available layouts visually with `docxmcp_pptx_index` (live thumbnails +
left nav) or `docxmcp_pptx_thumbnail`. You now hold the template's full slide
vocabulary. Extract also distils the deck's brand tokens into **`theme.css`** —
the colour scheme (`--color-accent1`, `--color-bg1`, …) and major/minor Latin +
East-Asian fonts (`--font-major-latin`, `--font-major-ea`, …). Because the canvas
track is lossy (it does not carry the theme), reference these variables when
hand-writing canvas HTML so new slides stay on-brand instead of guessing hexes.

**Phase 2 — Blueprint the slide map.** For the 2D-design family, `blueprint.md`
(A.4) records, per content section, **which template slide carries it**.
Deliberately spread the work across the deck's *different* layouts — title,
multi-column, image+text, quote/callout, section divider, stat/number callout.
The dominant failure is monotony: every section forced onto the same
title+bullets slide. Match content shape to layout shape (key points → bullets;
roles/teams → multi-column; testimonial → quote; metric → stat callout).

**Phase 3 — Build structure first, then fill.** Assemble the new deck's page
list *before* authoring any content:

- **Canvas track.** Copy the chosen `pages/<NN>/canvas.html` into the
  new package's page list; reorder by page number.
- **Master-surgery track (Track 3).** `docxmcp_pptx_duplicate_slide` /
  `docxmcp_pptx_delete_slide` / `docxmcp_pptx_rearrange_slides`.

Finish every add / remove / reorder before editing text — content you are about
to delete is wasted work. Then **swap content while preserving style**: edit the
text inside each page and leave its CSS / structure / geometry untouched (canvas:
edit the copied `canvas.html`; surgery: `docxmcp_pptx_edit action=set_placeholder`
/ `set_shape_text`). This is the literal 「只置換文字，延用背景／顏色／字型」.

**Phase 4 — Render and verify.** Canvas → `docxmcp_pptx_render`; surgery →
`docxmcp_document(action=pack, force=true)` (raw-zips the edited OOXML package;
surgery output is not re-rendered). Then run the **aesthetic rubric loop** in
`SKILL.md` B.2 (lint → render → score → fix top 1–2 → re-render) and the A.6
visual loop.

## Choosing the track

- **Mode B in-place surgery (`docxmcp_pptx_revise`) — default.** Keep the original
  deck's exact look; delete unwanted slides/shapes and swap text on the file
  itself. Lossless by construction (theme/master/layout/background/media never
  leave the file). Use for every "用這個當範本 / keep the look" request.
- **Master-surgery (decomposed, Track 3) — when you must *add* native content.**
  A designer's blank master or corporate template where you need to instantiate
  fresh layout placeholders: `docxmcp_pptx_read(action=layouts)` (each layout
  reports its parent `master_id` — verify you build on the brand master, not a
  stray `blank` one) → `docxmcp_pptx_edit action=add_slide_from_layout` → fill
  placeholders (delete or populate inherited ones so the master's sample/prompt
  text can't leak) → `docxmcp_document(action=pack, force=true)`. The new slide
  inherits the master's theme/layout/placeholder geometry directly.
- **Canvas (extract-then-copy) — only for by-example HTML retemplate.** Lossy
  (see above); use when you want a slide as an HTML template to author against,
  not to preserve the original look.

## Template-reuse hazards

- **Template slots ≠ source items.** If a template slide holds 4 team cards and
  you have 3 people, delete the 4th card's *whole group* (image + text boxes),
  not just its text. After clearing any text, hunt for orphaned visuals (a
  picture or shape whose label is now empty).
- **Replacement text length.** Shorter content is usually safe; longer content
  overflows or rewraps and breaks the layout. Split or trim to the slide's
  design, then visual-QA that page specifically.
- **Leftover template copy.** After the swap, scan every slide for un-replaced
  wording from the original deck — sample names, the source author's phrasing,
  placeholder strings. These are the most common "looks broken" defect.
- **Multi-item content.** One paragraph / block per item; never concatenate a
  numbered or bulleted list into a single run.

## Identity: keep the look, scrub the content (vs A.8)

A.8 (the docx composition pattern) deliberately swaps project A's house template
for a *generic* one so A's identity does not leak. **PPTX-as-template is the
opposite intent**: the user *wants* the source deck's visual identity preserved.
So keep theme / colours / fonts / layout — and scrub only the source-specific
*content* (client names, case numbers, A-specific facts) under the A.5
cross-pollution alarm. Visual identity stays; factual identity goes.
