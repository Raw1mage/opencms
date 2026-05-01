import { Match, Show, Switch } from "solid-js"
import { Spinner } from "./spinner"

export type StatusLineSnapshot = {
  kind: "working" | "retry" | "override"
  label: string
  duration: string
  retry?: { messageShort: string; attempt: number; retrySeconds: number; retryingLabel: string; retryInLabel?: string }
}

/**
 * Standalone status line — renders a single row of spinner + label + · + duration.
 * Self-contained styling (no [data-component=session-turn] ancestor required).
 *
 * Used in two places:
 * - inline at the end of a turn (SessionTurn renders it directly)
 * - anchored inside the prompt dock (when SessionPromptDock receives statusLine prop)
 */
export function StatusLine(props: { snapshot: StatusLineSnapshot; visible?: boolean }) {
  return (
    <div
      data-slot="status-line"
      data-visible={props.visible === false ? "false" : "true"}
      style={{
        display: "flex",
        "flex-direction": "row",
        "flex-wrap": "nowrap",
        "align-items": "center",
        gap: "8px",
        "min-width": "0",
        width: "100%",
        color: "var(--text-weak)",
        "font-size": "13px",
        "font-weight": "500",
        padding: "4px 0",
      }}
    >
      <Switch>
        <Match when={props.snapshot.kind === "retry" && props.snapshot.retry}>
          <Show when={props.snapshot.retry}>
            {(retry) => (
              <>
                <span
                  data-slot="status-line-retry-message"
                  style={{
                    "font-weight": "500",
                    color: "var(--syntax-critical)",
                    "min-width": "0",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {retry().messageShort}
                </span>
                <span data-slot="status-line-retry-seconds" style={{ color: "var(--text-weak)" }}>
                  · {retry().retryingLabel}
                  {retry().retryInLabel ? " " + retry().retryInLabel : ""}
                </span>
                <span data-slot="status-line-retry-attempt" style={{ color: "var(--text-weak)" }}>
                  (#{retry().attempt})
                </span>
              </>
            )}
          </Show>
        </Match>
        <Match when={true}>
          <Spinner style={{ "flex-shrink": "0", width: "18px", height: "18px" }} />
          <span
            data-slot="status-line-text"
            style={{
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "min-width": "0",
            }}
          >
            {props.snapshot.label}
          </span>
        </Match>
      </Switch>
      <span aria-hidden="true" style={{ "flex-shrink": "0" }}>
        ·
      </span>
      <span aria-live="off" style={{ "flex-shrink": "0" }}>
        {props.snapshot.duration}
      </span>
    </div>
  )
}
