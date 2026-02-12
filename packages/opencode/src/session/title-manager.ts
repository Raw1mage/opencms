import { MessageV2 } from "./message-v2"
import { Session } from "."

export async function ensureTitle(input: {
  session: Session.Info
  history: MessageV2.WithParts[]
  providerId: string
  modelID: string
}) {
  if (input.session.parentID) return
  if (!Session.isDefaultTitle(input.session.title)) return

  const firstRealUserIdx = input.history.findIndex(
    (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
  )
  if (firstRealUserIdx === -1) return

  const isFirst =
    input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)).length === 1
  if (!isFirst) return

  const firstRealUser = input.history[firstRealUserIdx]
  const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
  const text = firstRealUser.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => (p as MessageV2.TextPart).text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

  const source =
    text.length > 0
      ? text
      : subtaskParts
        .map((p) => p.prompt)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

  if (source.length === 0) return

  const sentence =
    source.match(/^[^。！？.!?]+[。！？.!?]/)?.[0] ??
    source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ??
    source

  const cleaned = sentence.trim()
  if (cleaned.length === 0) return

  return Session.update(
    input.session.id,
    (draft) => {
      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      draft.title = title
    },
    { touch: false },
  )
}
