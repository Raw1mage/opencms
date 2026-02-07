import { Component, createMemo, Show, Switch, Match, createSignal, createEffect, onCleanup } from "solid-js"
import { ToolPart, AssistantMessage } from "@opencode-ai/sdk/v2"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { Icon } from "@opencode-ai/ui/icon"
import { Card } from "@opencode-ai/ui/card"
import { Button } from "@opencode-ai/ui/button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { getFilename, getDirectory } from "@opencode-ai/util/path"
import stripAnsi from "strip-ansi"

export interface MessageToolInvocationProps {
  part: ToolPart
  message: AssistantMessage
}

export const MessageToolInvocation: Component<MessageToolInvocationProps> = (props) => {
  const language = useLanguage()
  const sync = useSync()
  const sdk = useSDK()

  const permission = createMemo(() => {
    const next = sync.data.permission[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== props.part.callID) return undefined
    return next
  })

  const [showPermission, setShowPermission] = createSignal(false)

  createEffect(() => {
    if (permission()) {
      const timeout = setTimeout(() => setShowPermission(true), 50)
      onCleanup(() => clearTimeout(timeout))
    } else {
      setShowPermission(false)
    }
  })

  const respond = (response: "once" | "always" | "reject") => {
    const perm = permission()
    if (!perm) return
    sdk.client.permission.respond({
      sessionID: perm.sessionID,
      permissionID: perm.id,
      response,
    })
  }

  const input = () => props.part.state?.input ?? {}
  const output = () => (props.part.state as any)?.output ?? ""
  const status = () => props.part.state?.status

  return (
    <div data-component="tool-part-wrapper" class="my-2" classList={{ "border-l-2 border-accent-primary pl-4": showPermission() }}>
      <Switch>
        <Match when={status() === "error" && (props.part.state as any).error}>
          {(error) => (
            <Card variant="error" class="p-3 flex items-start gap-2">
              <Icon name="circle-ban-sign" class="size-4 shrink-0 mt-0.5" />
              <div class="text-12-regular text-text-strong break-words">
                {String(error()).replace("Error: ", "")}
              </div>
            </Card>
          )}
        </Match>
        <Match when={props.part.tool === "bash"}>
          <BasicTool
            icon="console"
            trigger={{
              title: language.t("settings.permissions.tool.bash.title"),
              subtitle: String(input().description || ""),
            }}
          >
            <div class="mt-2 rounded bg-background-strong p-2 overflow-x-auto overflow-y-auto max-h-60" data-scrollable>
              <Markdown
                text={`\`\`\`command\n$ ${input().command ?? ""}${output() ? "\n\n" + stripAnsi(output()) : ""}\n\`\`\``}
              />
            </div>
          </BasicTool>
        </Match>
        <Match when={props.part.tool === "edit" || props.part.tool === "write"}>
           <BasicTool
            icon="code-lines"
            trigger={{
              title: language.t(props.part.tool === "edit" ? "settings.permissions.tool.edit.title" : "settings.permissions.tool.edit.title"),
              subtitle: getFilename(String(input().filePath || "")),
            }}
          >
            <div class="mt-1 text-11-regular text-text-weak px-2">
              {getDirectory(String(input().filePath || ""))}
            </div>
          </BasicTool>
        </Match>
        <Match when={true}>
          <BasicTool
            icon="mcp"
            trigger={{
              title: props.part.tool,
              subtitle: JSON.stringify(input()),
            }}
          />
        </Match>
      </Switch>

      <Show when={showPermission() && permission()}>
        <div class="mt-3 flex items-center justify-end gap-2 p-2 bg-surface-base rounded-md border border-border-base">
          <Button variant="ghost" size="small" onClick={() => respond("reject")}>
            {language.t("common.dismiss")}
          </Button>
          <Button variant="secondary" size="small" onClick={() => respond("always")}>
            {language.t("common.save")}
          </Button>
          <Button variant="primary" size="small" onClick={() => respond("once")}>
            {language.t("common.submit")}
          </Button>
        </div>
      </Show>
    </div>
  )
}
