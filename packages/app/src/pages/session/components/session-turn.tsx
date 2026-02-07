import { Component, createMemo, For, Show, Switch, Match } from "solid-js"
import { AssistantMessage, UserMessage, Part as PartType } from "@opencode-ai/sdk/v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Button } from "@opencode-ai/ui/button"
import { MessageContent } from "./message-content"
import { MessageReasoning } from "./message-reasoning"
import { MessageToolInvocation } from "./message-tool-invocation"

interface SessionTurnProps {
  sessionID: string
  messageID: string
  lastUserMessageID?: string
  stepsExpanded: boolean
  onStepsExpandedToggle: () => void
  classes?: {
    root?: string
    content?: string
    container?: string
  }
}

export const SessionTurn: Component<SessionTurnProps> = (props) => {
  const sync = useSync()
  const language = useLanguage()

  const allMessages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  
  const userMessage = createMemo(() => 
    allMessages().find(m => m.id === props.messageID && m.role === "user") as UserMessage | undefined
  )

  const assistantMessages = createMemo(() => {
    const userMsg = userMessage()
    if (!userMsg) return []
    
    const messages = allMessages()
    const index = messages.findIndex(m => m.id === userMsg.id)
    if (index < 0) return []

    const result: AssistantMessage[] = []
    for (let i = index + 1; i < messages.length; i++) {
      const item = messages[i]
      if (item.role === "user") break
      if (item.role === "assistant" && item.parentID === userMsg.id) {
        result.push(item as AssistantMessage)
      }
    }
    return result
  })

  const assistantParts = (msgId: string) => sync.data.part[msgId] ?? []
  
  const hasSteps = createMemo(() => {
    return assistantMessages().some(msg => 
      assistantParts(msg.id).some(part => part.type === "tool" || part.type === "reasoning")
    )
  })

  const status = createMemo(() => sync.data.session_status[props.sessionID] ?? { type: "idle" })
  const working = createMemo(() => status().type !== "idle" && props.messageID === props.lastUserMessageID)

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div class={props.classes?.content}>
        <div class={props.classes?.container}>
          <div class="group/turn flex flex-col gap-4 py-4 first:pt-0">
            {/* User Message */}
            <Show when={userMessage()}>
              {(msg) => (
                <div class="flex flex-col gap-2">
                  <div class="flex items-center gap-2">
                    <div class="size-6 rounded-full bg-surface-base flex items-center justify-center border border-border-base">
                      <span class="text-10-medium text-text-weak uppercase">U</span>
                    </div>
                    <span class="text-12-medium text-text-strong">{language.t("context.breakdown.user")}</span>
                  </div>
                  <div class="pl-8 text-14-regular text-text-strong whitespace-pre-wrap">
                    {assistantParts(msg().id).map(p => p.type === "text" ? p.text : "").join("")}
                  </div>
                </div>
              )}
            </Show>

            {/* Assistant Messages / Steps */}
            <Show when={assistantMessages().length > 0 || working()}>
              <div class="flex flex-col gap-4">
                <div class="flex items-center gap-2">
                  <div class="size-6 rounded-full bg-accent-primary/10 flex items-center justify-center border border-accent-primary/20">
                    <span class="text-10-medium text-accent-primary uppercase">A</span>
                  </div>
                  <span class="text-12-medium text-text-strong">{language.t("context.breakdown.assistant")}</span>
                  
                  <Show when={hasSteps()}>
                    <Button
                      variant="ghost"
                      size="small"
                      class="ml-auto h-6 text-11-medium gap-1"
                      onClick={props.onStepsExpandedToggle}
                    >
                      <Show when={working()} fallback={<div class="size-1.5 rounded-full bg-text-weak" />}>
                        <Spinner class="size-3" />
                      </Show>
                      <span>
                        {props.stepsExpanded ? language.t("command.steps.toggle") : language.t("command.steps.toggle")}
                      </span>
                    </Button>
                  </Show>
                </div>

                <div class="pl-8 flex flex-col gap-2">
                  <Show when={props.stepsExpanded}>
                    <For each={assistantMessages()}>
                      {(msg) => (
                        <For each={assistantParts(msg.id)}>
                          {(part) => (
                            <Switch>
                              <Match when={part.type === "reasoning"}>
                                <MessageReasoning part={part as any} />
                              </Match>
                              <Match when={part.type === "tool"}>
                                <MessageToolInvocation part={part as any} message={msg} />
                              </Match>
                              <Match when={part.type === "text"}>
                                <MessageContent part={part as any} />
                              </Match>
                            </Switch>
                          )}
                        </For>
                      )}
                    </For>
                  </Show>

                  {/* Final Response (always visible if not expanded, or if steps are hidden) */}
                  <Show when={!props.stepsExpanded}>
                    <For each={assistantMessages()}>
                      {(msg) => (
                        <For each={assistantParts(msg.id)}>
                          {(part) => (
                            <Show when={part.type === "text"}>
                              <MessageContent part={part as any} />
                            </Show>
                          )}
                        </For>
                      )}
                    </For>
                  </Show>
                  
                  <Show when={working() && !props.stepsExpanded}>
                    <div class="flex items-center gap-2 text-12-regular text-text-weak italic">
                      <Spinner class="size-3" />
                      <span>{language.t("session.messages.loading")}</span>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
