/**
 * harness/freerun-mode — render the current node's full detail block.
 *
 * The detail block follows the nav band in the prompt. It carries everything
 * the model needs to act on THIS node: free-form description, prior
 * observations, decisions with rationale, blockers, results so far, and the
 * intent declared at the end of the previous iteration on this node.
 *
 * No token budgeting here — the working set assembler upstream decides what
 * fits; this module just renders. If detail must be capped, the engine
 * trims observations[] or decisions[] at the storage layer before calling
 * render() (preserving the most recent entries).
 */

import type { ContextNode } from "../types"

export namespace NodeDetail {
  export interface RenderResult {
    text: string
  }

  export function render(node: ContextNode): RenderResult {
    const lines: string[] = []

    lines.push("# Current node")
    lines.push(`**id**: \`${node.id}\``)
    lines.push(`**title**: ${node.title}`)
    lines.push(`**mode**: \`${node.mode}\``)
    lines.push(`**iteration_count**: ${node.iteration_count}`)
    if (node.goal_binding !== undefined) {
      lines.push(`**goal_source**: ${node.goal_binding.source}`)
      if (node.goal_binding.source === "plan-task") {
        lines.push(`**plan_task**: ${node.goal_binding.plan_slug}#${node.goal_binding.task_id}`)
      }
    }
    if (node.relevant_tools !== undefined && node.relevant_tools.length > 0) {
      lines.push(`**relevant_tools**: ${node.relevant_tools.join(", ")}`)
    }
    if (node.relevant_skills !== undefined && node.relevant_skills.length > 0) {
      lines.push(`**relevant_skills**: ${node.relevant_skills.join(", ")}`)
    }
    lines.push("")

    if (node.body.length > 0) {
      lines.push("## Description")
      lines.push(node.body)
      lines.push("")
    }

    if (node.observations.length > 0) {
      lines.push("## Observations")
      for (const obs of node.observations) lines.push(`- ${obs}`)
      lines.push("")
    }

    if (node.decisions.length > 0) {
      lines.push("## Decisions")
      for (const d of node.decisions) {
        lines.push(`- **${d.decision}**`)
        lines.push(`  - rationale: ${d.rationale}`)
      }
      lines.push("")
    }

    if (node.blockers.length > 0) {
      lines.push("## Blockers")
      for (const b of node.blockers) lines.push(`- ${b}`)
      lines.push("")
    }

    if (node.results !== null && node.results !== undefined) {
      lines.push("## Results")
      lines.push("```json")
      lines.push(JSON.stringify(node.results, null, 2))
      lines.push("```")
      lines.push("")
    }

    if (node.next_intent.length > 0) {
      lines.push("## Last iteration's next_intent")
      lines.push(node.next_intent)
      lines.push("")
    }

    if (node.consolidated_summary !== null && node.consolidated_summary !== undefined && node.consolidated_summary.length > 0) {
      lines.push("## Consolidated summary (post-consolidation)")
      lines.push(node.consolidated_summary)
      lines.push("")
    }

    return { text: lines.join("\n").trimEnd() + "\n" }
  }
}
