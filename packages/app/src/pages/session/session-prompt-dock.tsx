import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { Icon } from "@opencode-ai/ui/icon"
import { PromptInput } from "@/components/prompt-input"
import { QuestionDock } from "@/components/question-dock"
import { formatElapsedSeconds, questionSubtitle } from "@/pages/session/session-prompt-helpers"

export function SessionPromptDock(props: {
  centered: boolean
  isChildSession: boolean
  parentSessionHref?: string
  questionRequest: () => QuestionRequest | undefined
  permissionRequest: () => { patterns: string[]; permission: string } | undefined
  blocked: boolean
  promptReady: boolean
  handoffPrompt?: string
  t: (key: string, vars?: Record<string, string | number | boolean>) => string
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  setPromptDockRef: (el: HTMLDivElement) => void
  activeChild?: {
    sessionID: string
    agent: string
    title: string
    step: string
    href: string
    startedAt?: number
    // session-ui-freshness: dock memo passes fidelity + receivedAt so the
    // dock card can mirror the degradation applied in side-panel / tool-page.
    fidelity?: import("@/utils/freshness").Fidelity
    receivedAt?: number
  }
  onOpenChildSession: (href: string) => void
  onAbortActiveChild: () => Promise<void>
}) {
  const [tick, setTick] = createSignal(0)
  const [aborting, setAborting] = createSignal(false)

  createEffect(() => {
    if (!props.activeChild?.startedAt) return
    setTick(0)
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  const activeChildElapsed = createMemo(() => {
    tick()
    const startedAt = props.activeChild?.startedAt
    if (!startedAt) return undefined
    return formatElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
  })

  return (
    <div
      ref={props.setPromptDockRef}
      class="absolute inset-x-0 bottom-0 pt-12 pb-4 flex flex-col justify-center items-center z-50 bg-gradient-to-t from-background-stronger via-background-stronger to-transparent pointer-events-none"
    >
      <div
        classList={{
          "w-full px-4 pointer-events-auto": true,
          "max-w-[1000px] mx-auto": props.centered,
        }}
      >
        <Show when={props.activeChild}>
          {(child) => {
            // session-ui-freshness: opacity + hint mirror side-panel / tool-page
            // process-card pattern. fidelity=undefined means feature flag is OFF
            // or memo hasn't classified yet — treat as fresh (no visual change).
            const dockOpacity = () => {
              const f = child().fidelity
              return f === "hard-stale" ? 0.4 : f === "stale" ? 0.75 : 1
            }
            const targetHref = () =>
              props.isChildSession ? (props.parentSessionHref ?? child().href) : child().href
            const navLabel = props.isChildSession ? "Return to parent session" : "Open session"
            return (
            <div
              class="mb-3 pointer-events-auto rounded-md border border-border-base/60 bg-background-base/90 px-3 py-2"
              style={{ opacity: dockOpacity() }}
            >
              <div class="flex items-center gap-2 min-w-0">
                <a
                  href={targetHref()}
                  class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden cursor-pointer rounded-sm hover:bg-background-stronger/40 focus-visible:bg-background-stronger/40 focus-visible:outline-none -mx-1 px-1 py-0.5"
                  aria-label={navLabel}
                  title={navLabel}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                      return
                    }
                    event.preventDefault()
                    event.stopPropagation()
                    props.onOpenChildSession(targetHref())
                  }}
                >
                  <Icon name="task" size="small" class="shrink-0 text-text-weak" />
                  <div class="min-w-0 flex-1 overflow-hidden">
                    <div class="flex items-center gap-2 min-w-0 overflow-hidden text-12-regular text-text-strong whitespace-nowrap">
                      <span class="shrink-0">{child().agent}</span>
                      <span class="truncate min-w-0">{child().title}</span>
                      <span class="truncate min-w-0 text-text-weak">{child().step}</span>
                      <Show when={activeChildElapsed() && child().fidelity !== "hard-stale"}>
                        {(elapsed) => <span class="shrink-0 text-text-weak tabular-nums">{elapsed()}</span>}
                      </Show>
                      <Show when={child().fidelity === "stale" || child().fidelity === "hard-stale"}>
                        <span class="shrink-0 text-text-weak italic">stale</span>
                      </Show>
                    </div>
                  </div>
                  <Icon
                    name="square-arrow-top-right"
                    size="small"
                    class="shrink-0 text-text-weak"
                  />
                </a>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={aborting()}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    if (aborting()) return
                    setAborting(true)
                    void props.onAbortActiveChild().finally(() => setAborting(false))
                  }}
                >
                  {aborting() ? "Stopping…" : "Stop"}
                </Button>
              </div>
            </div>
            )
          }}
        </Show>

        <Show when={props.questionRequest()} keyed>
          {(req) => {
            const subtitle = questionSubtitle(req.questions.length, (key) => props.t(key))
            return (
              <div data-component="tool-part-wrapper" data-question="true" class="mb-3">
                <BasicTool
                  icon="bubble-5"
                  locked
                  defaultOpen
                  trigger={{
                    title: props.t("ui.tool.questions"),
                    subtitle,
                  }}
                />
                <QuestionDock request={req} />
              </div>
            )
          }}
        </Show>

        <Show when={props.permissionRequest()} keyed>
          {(perm) => (
            <div data-component="tool-part-wrapper" data-permission="true" class="mb-3">
              <BasicTool
                icon="checklist"
                locked
                defaultOpen
                trigger={{
                  title: props.t("notification.permission.title"),
                  subtitle:
                    perm.permission === "doom_loop"
                      ? props.t("settings.permissions.tool.doom_loop.title")
                      : perm.permission,
                }}
              >
                <Show when={perm.patterns.length > 0}>
                  <div class="flex flex-col gap-1 py-2 px-3 max-h-40 overflow-y-auto no-scrollbar">
                    <For each={perm.patterns}>
                      {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                    </For>
                  </div>
                </Show>
                <Show when={perm.permission === "doom_loop"}>
                  <div class="text-12-regular text-text-weak pb-2 px-3">
                    {props.t("settings.permissions.tool.doom_loop.description")}
                  </div>
                </Show>
              </BasicTool>
              <div data-component="permission-prompt">
                <div data-slot="permission-actions">
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => props.onDecide("reject")}
                    disabled={props.responding}
                  >
                    {props.t("ui.permission.deny")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => props.onDecide("always")}
                    disabled={props.responding}
                  >
                    {props.t("ui.permission.allowAlways")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={() => props.onDecide("once")}
                    disabled={props.responding}
                  >
                    {props.t("ui.permission.allowOnce")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <Show when={!props.blocked}>
          <Show
            when={props.promptReady}
            fallback={
              <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                {props.handoffPrompt || props.t("prompt.loading")}
              </div>
            }
          >
            <Show when={!props.isChildSession}>
              <PromptInput
                ref={props.inputRef}
                newSessionWorktree={props.newSessionWorktree}
                onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                onSubmit={props.onSubmit}
                forceWorking={!!props.activeChild}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
