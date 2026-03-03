import type { ParentProps } from "solid-js"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DiffComponentProvider } from "@opencode-ai/ui/context/diff"
import { CodeComponentProvider } from "@opencode-ai/ui/context/code"
import { Diff } from "@opencode-ai/ui/diff"
import { Code } from "@opencode-ai/ui/code"
import { usePlatform } from "@/context/platform"

export default function SessionRichContentProvider(props: ParentProps) {
  const platform = usePlatform()
  return (
    <MarkedProvider nativeParser={platform.parseMarkdown}>
      <DiffComponentProvider component={Diff}>
        <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
      </DiffComponentProvider>
    </MarkedProvider>
  )
}
