export type FreerunCommand =
  | { verb: "on" | "off" | "clear" }
  | { verb: "arm"; goal?: string }
  | { verb: "disarm" }

export function parseFreerunCommand(text: string): FreerunCommand | undefined {
  const match = /^\/freerun\s+(on|off|clear|arm|disarm)(?:\s+([\s\S]+))?\s*$/i.exec(text.trim())
  if (!match) return undefined
  const verb = match[1].toLowerCase() as FreerunCommand["verb"]
  if (verb === "arm") {
    const goal = match[2]?.trim()
    return goal ? { verb, goal } : { verb }
  }
  return { verb }
}
