# refs/claude-code-npm — implementation reference template

This directory mirrors the **npm tarball** of `@anthropic-ai/claude-code` and
exists purely as a **reference template** for the `@opencode-ai/claude-provider`
plugin. We never run anything from here — the JS bundle is read-only source-of-truth
for protocol constants (VERSION strings, beta flags, attribution salt, identity
strings, header layout, billing-hash routine, etc.).

## Pinned version: **2.1.112** (last JS bundle)

`@anthropic-ai/claude-code` switched its distribution model at **2.1.113**:

| Version range | Distribution | Inspectable? |
|---|---|---|
| ≤ 2.1.112 | Single Node.js bundle (`cli.js`, ~18 MB tarball) | ✅ Yes — minified JS, but strings + structure recoverable |
| ≥ 2.1.113 | Native binary via platform-specific optional deps (`@anthropic-ai/claude-code-linux-x64`, etc., ~237 MB Bun-compiled ELF) | ⚠️ Only via `strings` / disassembler |

So **2.1.112 is the last upstream version where the implementation can be read
as source**. Anything newer (2.1.113 → 2.1.126 at time of writing) is a stripped
wrapper around a native executable; the wrapper itself contains nothing
protocol-relevant.

## Companion: `refs/claude-code/` submodule

The sibling submodule `refs/claude-code/` tracks the **public GitHub repo**
(`anthropics/claude-code`), which only ships scripts, plugins, and CHANGELOG —
no bundled source. Its only role is to track tags / CHANGELOG entries for
release-note diffing. Pair it with this directory: GitHub for "what changed",
this directory for "how it was implemented".

## When to bump

- **DO bump** if Anthropic publishes a new ≤2.1.112-style JS-source release
  (unlikely, but watch for it).
- **DO NOT bump** to 2.1.113+ as a JS-source reference — those tarballs have no
  source. If we need to verify post-2.1.112 protocol constants, the path is:
  1. Pull `@anthropic-ai/claude-code-linux-x64@<version>`
  2. Run `strings package/claude | grep -E 'cc_version|claude-code-2025|...'`
  3. Cross-reference disassembly if needed.

## Companion datasheet

The extracted protocol constants are summarized in
`plans/claude-provider/protocol-datasheet.md`. Update both together when
bumping. Provider source-of-truth lives at
`packages/opencode-claude-provider/src/protocol.ts`.
