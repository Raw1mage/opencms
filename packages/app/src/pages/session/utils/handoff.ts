import type { SelectedLineRange } from "@/context/file"

export const handoff = {
  prompt: "",
  terminals: [] as string[],
  files: {} as Record<string, SelectedLineRange | null>,
}
