import { Component, createMemo, Show } from "solid-js"
import { ReasoningPart } from "@opencode-ai/sdk/v2"
import { Markdown } from "@opencode-ai/ui/markdown"
import { createSimpleContext } from "@opencode-ai/ui/context"

// We'll use a throttled value for smoother text rendering during streaming
function createThrottledValue(getValue: () => string) {
  const [value, setValue] = createSignal(getValue())
  let last = 0
  const throttle = 100

  createEffect(() => {
    const next = getValue()
    const now = Date.now()
    if (now - last >= throttle) {
      last = now
      setValue(next)
    } else {
      const timer = setTimeout(() => {
        last = Date.now()
        setValue(getValue())
      }, throttle - (now - last))
      onCleanup(() => clearTimeout(timer))
    }
  })

  return value
}

import { createSignal, createEffect, onCleanup } from "solid-js"

export interface MessageReasoningProps {
  part: ReasoningPart
}

export const MessageReasoning: Component<MessageReasoningProps> = (props) => {
  const text = createMemo(() => props.part.text.trim())
  const throttledText = createThrottledValue(text)

  return (
    <Show when={throttledText()}>
      <div data-component="reasoning-part" class="text-text-weak italic border-l-2 border-border-base pl-4 py-1 my-2">
        <Markdown text={throttledText()} cacheKey={props.part.id} />
      </div>
    </Show>
  )
}
