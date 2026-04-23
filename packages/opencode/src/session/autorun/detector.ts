import { Tweaks } from "@/config/tweaks"

/**
 * specs/autonomous-opt-in/ — verbal arm/disarm intent detector.
 *
 * Pure-logic: given user message text and a phrase config, return the arm
 * or disarm intent if any configured phrase is present (case-insensitive,
 * anywhere in the text). Trigger phrases win over disarm phrases when both
 * match the same message (rare — matches user intent: "stop the current
 * thing and start a new autorun" would be two separate messages).
 *
 * The caller wires the intent to Session.updateAutonomous + runloop enqueue.
 * See `prompt.ts` ingest path and `specs/autonomous-opt-in/design.md` DD-11.
 */
export type AutorunIntent =
  | { kind: "arm"; phrase: string }
  | { kind: "disarm"; phrase: string }
  | null

export function detectAutorunIntent(text: string, cfg: Tweaks.AutorunConfig): AutorunIntent {
  if (!text) return null
  const haystack = text.toLowerCase()
  for (const phrase of cfg.triggerPhrases) {
    if (phrase.length === 0) continue
    if (haystack.includes(phrase.toLowerCase())) return { kind: "arm", phrase }
  }
  for (const phrase of cfg.disarmPhrases) {
    if (phrase.length === 0) continue
    if (haystack.includes(phrase.toLowerCase())) return { kind: "disarm", phrase }
  }
  return null
}

/**
 * Collapse a PromptInput parts array's user text down to a single string.
 * Only text parts contribute; synthetic / file / agent / tool parts are
 * ignored (the detector is intent-on-user-typed-text).
 */
export function extractUserText(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>): string {
  const buf: string[] = []
  for (const p of parts) {
    if (p.type !== "text") continue
    if (p.synthetic) continue
    if (typeof p.text === "string" && p.text.length > 0) buf.push(p.text)
  }
  return buf.join("\n").trim()
}
