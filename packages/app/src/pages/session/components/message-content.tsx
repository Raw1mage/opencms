import { Component, createMemo, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { TextPart } from "@opencode-ai/sdk/v2"
import { Markdown } from "@opencode-ai/ui/markdown"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"

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
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  
  const displayText = createMemo(() => (props.part.text ?? "").trim())
  const throttledText = createThrottledValue(displayText)

  const handleCopy = async () => {
    const content = displayText()
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Show when={throttledText()}>
      <div data-component="text-part" class="group relative">
        <div data-slot="text-part-body" class="prose prose-sm max-w-none">
          <Markdown text={throttledText()} cacheKey={props.part.id} />
          <div class="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip
              value={copied() ? language.t("ui.message.copied") : language.t("ui.message.copy")}
              placement="top"
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                variant="ghost"
                size="normal"
                onClick={handleCopy}
              />
            </Tooltip>
          </div>
        </div>
      </div>
    </Show>
  )
}
