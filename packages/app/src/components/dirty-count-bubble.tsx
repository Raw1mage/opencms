import { splitProps, type JSX } from "solid-js"

export function DirtyCountBubble(
  props: {
    count: number
    active?: boolean
    rounded?: "full" | "md"
    interactiveGroup?: string
    class?: string
  } & JSX.HTMLAttributes<HTMLSpanElement>,
) {
  const [local, rest] = splitProps(props, ["count", "active", "rounded", "interactiveGroup", "class"])
  const group = local.interactiveGroup
  const normalInteractive = group
    ? `group-hover/${group}:bg-warning/18 group-hover/${group}:border-warning/30 group-focus-within/${group}:bg-warning/18 group-focus-within/${group}:border-warning/30`
    : ""
  const activeInteractive = group
    ? `group-hover/${group}:bg-[#f2f2f2] group-hover/${group}:border-[#f2f2f2] group-focus-within/${group}:bg-[#f2f2f2] group-focus-within/${group}:border-[#f2f2f2]`
    : ""

  return (
    <span
      {...rest}
      class={[
        "shrink-0 inline-flex min-w-5 h-5 px-1.5 items-center justify-center text-11-medium tabular-nums border transition-colors",
        local.rounded === "md" ? "rounded-md" : "rounded-full",
        local.active
          ? `bg-[#ffffff] text-[#000000] border-[#ffffff] shadow-sm ${activeInteractive}`
          : `bg-warning/12 text-warning border-warning/20 ${normalInteractive}`,
        local.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {local.count}
    </span>
  )
}
