import { Component, createMemo, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { TextPart } from "@opencode-ai/sdk/v2"
import { Markdown } from "@opencode-ai/ui/markdown"

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

export interface MessageContentProps {
  part: TextPart
}

export const MessageContent: Component<MessageContentProps> = (props) => {
  const displayText = createMemo(() => (props.part.text ?? "").trim())
  const throttledText = createThrottledValue(displayText)

  return (
    <Show when={throttledText()}>
      <div data-component="text-part">
        <div data-slot="text-part-body" class="prose prose-sm max-w-none">
          <Markdown text={throttledText()} cacheKey={props.part.id} />
        </div>
      </div>
    </Show>
  )
}
