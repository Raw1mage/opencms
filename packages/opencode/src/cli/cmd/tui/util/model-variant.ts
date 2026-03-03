export type VariantOption = {
  value: string
  title: string
  description: string
}

const OPENAI_PREFERRED_ORDER = ["low", "medium", "high", "extra", "xhigh"]

function formatVariantLabel(value: string, family?: string) {
  const normalized = value.toLowerCase()
  if (family === "openai" && (normalized === "xhigh" || normalized === "extra")) return "Extra"
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token[0]?.toUpperCase() + token.slice(1))
    .join(" ")
}

export function buildVariantOptions(values: string[], family?: string): VariantOption[] {
  let normalized = [...values]

  if (family === "openai") {
    const set = new Set(normalized)
    const narrowed = OPENAI_PREFERRED_ORDER.filter((value) => set.has(value))
    if (narrowed.length > 0) normalized = narrowed
    normalized = normalized.filter((value) => value !== "none" && value !== "minimal")
  }

  const usedTitles = new Set<string>()
  const result: VariantOption[] = []
  for (const value of normalized) {
    const title = formatVariantLabel(value, family)
    if (usedTitles.has(title)) continue
    usedTitles.add(title)
    result.push({ value, title, description: `Raw: ${value}` })
  }
  return result
}

export function getEffectiveVariantValue(input: {
  family?: string
  current?: string
  options: VariantOption[]
}): string | undefined {
  if (input.current) return input.current
  if (input.family === "openai") {
    return input.options.find((item) => item.value === "medium")?.value ?? input.options[0]?.value
  }
  return undefined
}

export function shouldShowVariantControl(input: {
  family?: string
  current?: string
  options: VariantOption[]
}): boolean {
  if (input.options.length === 0) return false
  if (input.family === "openai") return true
  return !!input.current
}
