---
name: specbase-kb
description: Build two-layer knowledge bases with a web/wiki presentation layer and a media-backed asset repository. Use when users need a specwiki-style KB, source/reference ingestion, legal/regulatory evidence tracking, multi-format document/media storage, or traceable knowledge distillation from PDFs, DOC/DOCX, HTML, images, OCR, tables, screenshots, or web pages. Pairs with specbase as the registry/index layer and document/web MCPs as extraction tools.
---

# Skill: specbase-kb

中文：**Specbase 知識庫建置**；口語：**建 KB / specwiki KB / asset KB**。

Use this skill when the user wants to create a KB from heterogeneous sources and expose it as a human-readable wiki while preserving raw evidence.

## 1. Architecture

The KB has two durable layers plus one registry layer:

```text
KB
├─ frontend: specwiki
│  ├─ human-readable wiki pages
│  ├─ generated indexes and backlinks
│  ├─ search-friendly markdown/html views
│  └─ role/process/legal/control/data-field pages
├─ backend: assets
│  ├─ raw files: PDF/DOC/DOCX/XLSX/PPTX/HTML/images/audio/video
│  ├─ extracted text/OCR/tables/thumbnails
│  ├─ metadata manifests
│  └─ immutable source snapshots
└─ registry: specbase-compatible records
   ├─ source, asset, extract, concept, relation, view
   ├─ lineage: source → asset → extract → concept/control/workflow → view
   └─ reverse impact queries
```

Do not collapse these layers:

- Raw files stay byte-preserving in the asset layer.
- Structured metadata and relations live in specbase-compatible records or JSON manifests.
- Wiki pages are generated/curated views, not the only source of truth.

## 2. Trigger Conditions

Load this skill when the task includes any of these:

- Build a knowledge base, wiki, specwiki, research corpus, legal KB, evidence library, or reference library.
- Ingest many files from `refs/`, websites, PDFs, DOC/DOCX, images, scanned pages, or Office documents.
- Need source traceability, legal/regulatory lineage, citations, versioning, or impact analysis.
- Need a frontend wiki backed by backend media assets.
- Need to map source documents to workflows, controls, roles, forms, data fields, or AI-assist candidates.

## 3. Default Folder Contract

Prefer this layout unless the repo already has a stronger convention:

```text
kb-assets/
  raw/
  extracts/
  thumbnails/
  manifests/

knowledge-base/
  README.md
  roles/
  workflows/
  transfer-points/
  forms-records/
  data-dictionary/
  compliance/
    legal-sources/
    controls/
    accreditation/
    reimbursement/
    privacy-security/
    internal-policies/
  evidence/
  ai-assist-candidates/

specwiki/
  pages/
  indexes/
  assets -> ../kb-assets
```

If the repo already uses `refs/`, keep raw externally sourced material there and treat it as the backend asset store. Do not duplicate large files unless the user asks.

## 4. Object Types

Use stable IDs. Prefer lowercase dotted slugs.

| Type | ID Example | Purpose |
|---|---|---|
| `kb.source` | `source.1966.related-regulations` | Origin: website, agency, book, interview, dataset |
| `kb.asset` | `asset.1966.ltc-services-act.pdf` | Raw file or web snapshot |
| `kb.extract` | `extract.1966.ltc-services-act.articles` | OCR/text/table/page extract derived from an asset |
| `kb.concept` | `concept.home-care-supervisor` | Domain concept, role, service, policy, term |
| `kb.legal-source` | `legal-source.ltc.services-act` | Law, regulation, announcement, interpretation, standard |
| `kb.control` | `control.personnel.certification` | Rule that constrains workflow IDEF0 Control |
| `kb.workflow` | `workflow.caregiver.submit-service-record` | Work node / IDEF0 function |
| `kb.form` | `form.service-record` | Form or record artifact |
| `kb.data-field` | `data-field.service-record.signature` | Field-level data dictionary item |
| `kb.relation` | `relation.control-to-workflow.*` | Typed edge between objects |
| `kb.view` | `view.specwiki.role.home-care-supervisor` | Generated or curated wiki page |

## 5. Minimum Metadata Schema

Every asset and knowledge object needs enough metadata for traceability:

```yaml
id: kb.asset.<slug>
type: kb.asset
title: Human readable title
mediaType: application/pdf | text/html | image/png | ...
path: kb-assets/raw/... or refs/...
sourceUrl: https://...
capturedAt: YYYY-MM-DDTHH:mm:ss+08:00
hash: sha256:<hex>
version: source date / announcement date / local revision
license: unknown | public-sector-open-data | user-provided | ...
confidence: verified | partial | inferred | todo
extractionStatus: raw-only | extracted | reviewed | normalized
sourceRefs:
  - path: ...
    page: ...
    line: ...
relatedObjects:
  - legal-source.ltc.services-act
  - control.personnel.certification
```

For `kb.control`, add `appliesTo`, `controlCategory`, `sourceEvidence`, and `impact`.

## 6. Ingestion Workflow

1. Declare source batch.
2. Preserve raw assets; never overwrite originals.
3. Register assets with path, source URL, hash, media type, date.
4. Extract content using docxmcp for Office/PDF, web tools for web snapshots, OCR for scans, table extraction for structured pages.
5. Normalize source, legal-source, control, concept, form, field, workflow objects.
6. Connect lineage from source to specwiki view.
7. Generate human-readable pages and indexes.
8. Validate raw paths, manifests, and evidence-backed controls.

## 7. Legal / Compliance KB Rules

- Legal sources become first-class `kb.legal-source` objects.
- Workflow constraints become `kb.control` objects, not prose-only notes.
- Controls must cite article/page/section/attachment locator when available.
- Controls must be mappable to IDEF0 `Control` in workflow nodes.
- Changes to legal sources must support reverse impact queries: `legal-source → control → workflow → role → AI candidate`.
- Unknown or inferred compliance claims must be marked `confidence: todo` or `inferred`.

## 8. Specwiki Page Contract

Each generated/curated wiki page should include title, stable object ID, summary, source evidence, related objects, version/confidence, and backlinks.

## 9. Tool Routing

- Use `docxmcp` for Office/PDF document extraction and decomposition when available.
- Use web/fetch tools for web source capture, but save raw snapshots when the source is authoritative.
- Use file tools for manifests and wiki pages; read before updating existing files.
- Use specbase MCP/event tools when available for durable decisions, events, wiki queries, or structured record hooks.
- Do not invent legal facts from memory. If not in evidence, mark `todo`.

## 10. Completion Checklist

- Raw assets are saved and indexed.
- Extracts are linked to raw assets.
- Knowledge objects have stable IDs.
- Legal/compliance claims have evidence locators or are marked `todo`.
- Specwiki pages or indexes exist for human navigation.
- Plan files are synchronized if the repo uses plan-builder.
- Remaining gaps are explicit.
