import { base64Encode } from "@opencode-ai/util/encode"

export function buildCanonicalDirectoryHref(input: {
  pathname: string
  dirParam: string
  resolvedDirectory: string
  search?: string
  hash?: string
}) {
  const currentPrefix = `/${input.dirParam}`
  const hasExactMatch = input.pathname === currentPrefix
  const hasNestedMatch = input.pathname.startsWith(currentPrefix + "/")
  if (!hasExactMatch && !hasNestedMatch) return
  const nextPrefix = `/${base64Encode(input.resolvedDirectory)}`
  return `${nextPrefix}${input.pathname.slice(currentPrefix.length)}${input.search ?? ""}${input.hash ?? ""}`
}
