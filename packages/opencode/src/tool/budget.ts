import { Tweaks } from "../config/tweaks"
import type { Tool } from "./tool"

/**
 * Layer 2 of the context-management subsystem (specs/tool-output-chunking/).
 *
 * Variable-size tools call ToolBudget.resolve(ctx) to get a guaranteed
 * per-invocation token budget. The tool MUST cap its natural output to
 * that many tokens before returning, appending a trailing
 * natural-language hint with the next-slice args (e.g. offset=N).
 *
 * Decision DD-2: outputBudget = min(round(model.contextWindow * ratio),
 * absoluteCap), floored at minimumFloor. `task` and `bash` substitute
 * their per-tool override for absoluteCap.
 *
 * Until the runtime plumbs ctx.outputBudget at every invocation site
 * (later phase), the helper falls back to the static absoluteCap from
 * tweaks.cfg. Tools written today against this helper are forward-
 * compatible with the eventual model-aware plumbing — no rewrite needed.
 */
export namespace ToolBudget {
  export interface Resolved {
    /** Final token budget the tool must respect. */
    tokens: number
    /** Where the value came from — useful for telemetry / debugging. */
    source: "ctx" | "tweaks-default" | "tweaks-task-override" | "tweaks-bash-override"
  }

  /**
   * Resolve a guaranteed budget for a tool's output.
   *
   * @param ctx tool context (Tool.Context). ctx.outputBudget wins if set.
   * @param toolId tool identifier ("read", "bash", "task", ...). Affects
   *               which per-tool override applies.
   */
  export function resolve(ctx: Pick<Tool.Context, "outputBudget">, toolId?: string): Resolved {
    if (typeof ctx.outputBudget === "number" && ctx.outputBudget > 0) {
      return { tokens: ctx.outputBudget, source: "ctx" }
    }
    const cfg = Tweaks.toolOutputBudgetSync()
    const cap =
      toolId === "task"
        ? cfg.taskOverride
        : toolId === "bash"
          ? cfg.bashOverride
          : cfg.absoluteCap
    const floored = Math.max(cap, cfg.minimumFloor)
    const source: Resolved["source"] =
      toolId === "task" ? "tweaks-task-override" : toolId === "bash" ? "tweaks-bash-override" : "tweaks-default"
    return { tokens: floored, source }
  }

  /**
   * Compute outputBudget for a model with a known context window. Used by
   * the runtime when constructing Tool.Context (later phase). Tools
   * themselves should call resolve() instead.
   */
  export function computeForModel(modelContextWindowTokens: number, toolId?: string): number {
    const cfg = Tweaks.toolOutputBudgetSync()
    const cap =
      toolId === "task"
        ? cfg.taskOverride
        : toolId === "bash"
          ? cfg.bashOverride
          : cfg.absoluteCap
    const fromRatio = Math.round(modelContextWindowTokens * cfg.contextRatio)
    return Math.max(cfg.minimumFloor, Math.min(fromRatio, cap))
  }

  /**
   * Approximate token count for a string — the codebase's single shared
   * estimator. Tools use it for token-boundary slicing; compaction uses it for
   * anchor-size gating. Keeping ONE estimator avoids the unpredictable divergence
   * of mixing methods (a separate gate that counted differently was the root of
   * plan compaction_anchor-unbounded-growth).
   *
   * CJK-aware: a CJK / Japanese / Korean / fullwidth codepoint is ~1 token (not
   * ~0.25 as plain chars/4 assumed); everything else stays chars/4. Pure
   * ASCII/Latin text returns EXACTLY Math.ceil(length/4) — byte-identical to the
   * old formula — so only CJK-bearing text changes (it gets counted closer to
   * its real token cost, which is also what the model's reported usage shows).
   * Fast: a single charCodeAt pass, no allocation, deterministic.
   */
  export function estimateTokens(text: string): number {
    let cjk = 0
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (
        (c >= 0x3000 && c <= 0x303f) || // CJK symbols & punctuation
        (c >= 0x3040 && c <= 0x30ff) || // Hiragana + Katakana
        (c >= 0x3400 && c <= 0x4dbf) || // CJK Ext A
        (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
        (c >= 0xac00 && c <= 0xd7af) || // Hangul syllables
        (c >= 0xf900 && c <= 0xfaff) || // CJK compat ideographs
        (c >= 0xff00 && c <= 0xffef) || // Fullwidth / halfwidth forms
        (c >= 0xd800 && c <= 0xdbff) // high surrogate (astral CJK ext-B etc.) ~1 token
      ) {
        cjk++
      }
    }
    const other = text.length - cjk
    return cjk + Math.ceil(other / 4)
  }
}
