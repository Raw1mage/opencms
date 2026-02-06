import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { PromptInput } from "@/components/prompt-input"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"

export function SessionPromptDock(props: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  centered: boolean
  permissionRequest: () => { patterns: string[]; permission: string } | undefined
  promptReady: boolean
  handoffPrompt?: string
  language: ReturnType<typeof useLanguage>
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
  setInputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  return (
    <div
      ref={props.setPromptDockRef}
      class="absolute inset-x-0 bottom-0 pt-12 pb-4 flex flex-col justify-center items-center z-50 bg-gradient-to-t from-background-stronger via-background-stronger to-transparent pointer-events-none"
    >
      <div
        classList={{
          "w-full px-4 pointer-events-auto": true,
          "md:max-w-200 3xl:max-w-[1200px] 4xl:max-w-[1600px] 5xl:max-w-[1900px]": props.centered,
        }}
      >
        <Show when={props.permissionRequest()} keyed>
          {(perm) => (
            <div data-component="tool-part-wrapper" data-permission="true" class="mb-3">
              <BasicTool
                icon="checklist"
                locked
                defaultOpen
                trigger={{
                  title: props.language.t("notification.permission.title"),
                  subtitle:
                    perm.permission === "doom_loop"
                      ? props.language.t("settings.permissions.tool.doom_loop.title")
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
                    {props.language.t("settings.permissions.tool.doom_loop.description")}
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
                    {props.language.t("ui.permission.deny")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => props.onDecide("always")}
                    disabled={props.responding}
                  >
                    {props.language.t("ui.permission.allowAlways")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={() => props.onDecide("once")}
                    disabled={props.responding}
                  >
                    {props.language.t("ui.permission.allowOnce")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <Show
          when={props.promptReady}
          fallback={
            <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
              {props.handoffPrompt || props.language.t("prompt.loading")}
            </div>
          }
        >
          <PromptInput
            ref={props.setInputRef}
            newSessionWorktree={props.newSessionWorktree}
            onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
            onSubmit={props.onSubmit}
          />
        </Show>
      </div>
    </div>
  )
}
