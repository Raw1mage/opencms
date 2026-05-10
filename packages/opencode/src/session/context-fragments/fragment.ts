/**
 * Context fragment system — pure shape definition.
 *
 * Mirrors upstream codex-cli's `ContextualUserFragment` trait
 * (refs/codex/codex-rs/core/src/context/fragment.rs). Each producer
 * emits `ContextFragment` with explicit ROLE + START/END marker + body;
 * the bundle assembler groups them by ROLE and joins into one
 * `BundledMessage` per ROLE for the codex provider's `input[]` prefix.
 *
 * Design contract (DD-1 of plans/provider_codex-prompt-realign):
 *   - Fragments either copy an upstream codex-cli shape exactly
 *     (`source: "upstream"`) or are OpenCode-only additions
 *     (`source: "opencode-only"`) justified in design.md.
 *   - `id` MUST be stable across turns for the same logical content;
 *     the assembler dedupes by id.
 *   - `body()` MUST be byte-stable across turns whenever the producer's
 *     inputs are byte-stable. Per-turn-changing content (timestamps,
 *     counters, dynamic skill toggles) is the responsibility of the
 *     producer to either commit to or factor out.
 *   - Empty body skips marker wrapping AND is dropped from the bundle.
 */

export type FragmentRole = "user" | "developer"

export type FragmentSource = "upstream" | "opencode-only"

export interface ContextFragment {
  /**
   * Stable identifier. Convention: `<category>:<name>` for OpenCode-side
   * dedup (e.g. `agents_md:global`, `agents_md:project`, `skill:plan-builder`,
   * `environment_context`, `opencode_protocol`, `role_identity`).
   *
   * Two fragments with the same id collide; the FragmentRegistry MUST
   * throw rather than silently overwrite (errors.md E3 contract).
   */
  id: string

  /** Wire role in input[] item. Mirrors upstream ROLE constant. */
  role: FragmentRole

  /**
   * Opening marker tag (e.g. `<environment_context>`, `<opencode_protocol>`).
   * Empty string means body is rendered without wrapping (matches upstream
   * fragments where START_MARKER is "").
   */
  startMarker: string

  /**
   * Closing marker. Empty string when startMarker is empty (validation
   * mirror of upstream `fragment.rs` startMarker.is_empty() && endMarker.is_empty()).
   */
  endMarker: string

  /** Already-serialized body. Producer is responsible for byte-stability. */
  body: string

  /**
   * Whether this fragment shape is copied verbatim from upstream codex-cli
   * or is an OpenCode-only addition (must have a design.md justification).
   */
  source: FragmentSource
}

/**
 * Render a fragment to its wire string. Matches upstream
 * `fragment.rs::render`:
 *
 *   format!("{}{}{}", START_MARKER, body(), END_MARKER)
 *
 * Empty markers + empty body → empty string (caller drops the entry).
 */
export function renderFragment(f: ContextFragment): string {
  if (f.body.length === 0) return ""
  if (f.startMarker.length === 0 && f.endMarker.length === 0) {
    return f.body
  }
  return `${f.startMarker}${f.body}${f.endMarker}`
}
