import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Provider } from "../provider/provider"
import { buildFallbackCandidates } from "../account/rotation3d"
import { debugCheckpoint } from "@/util/debug"
import { NamedError } from "@opencode-ai/util/error"
import { Bus } from "../bus"
import { Session } from "."

function hasImageParts(message?: MessageV2.WithParts): boolean {
  if (!message) return false
  return message.parts.some((part) => part.type === "file" && part.mime?.startsWith("image/"))
}

export function stripImageParts(messages: MessageV2.WithParts[]) {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue
    const parts: MessageV2.Part[] = []
    for (const part of msg.parts) {
      if (part.type !== "file" || !part.mime?.startsWith("image/")) {
        parts.push(part)
        continue
      }
      const name = part.filename || part.mime || "image"
      parts.push({
        id: Identifier.ascending("part"),
        messageID: msg.info.id,
        sessionID: msg.info.sessionID,
        type: "text",
        text: `[Image omitted: ${name}]`,
        synthetic: true,
      })
    }
    msg.parts = parts
  }
}

async function selectImageModel(current: Provider.Model): Promise<Provider.Model | undefined> {
  const { Account } = await import("../account/index")
  const family = Account.parseFamily(current.providerId)
  const accountId = family ? ((await Account.getActive(family)) ?? current.providerId) : current.providerId

  const candidates = await buildFallbackCandidates({
    providerId: current.providerId,
    accountId,
    modelID: current.id,
  })

  const providers = await Provider.list()
  for (const c of candidates) {
    const provider = providers[c.accountId] ?? providers[c.providerId]
    if (!provider) continue

    const model = provider.models[c.modelID]
    if (!model) continue

    if (model.capabilities.input.image && !c.isRateLimited) {
      debugCheckpoint("rotation3d", "Image capability rotation", {
        from: `${accountId}(${current.id})`,
        to: `${c.accountId}(${c.modelID})`,
        reason: "capability",
      })
      return model
    }
  }
}

export async function resolveImageRequest(input: {
  model: Provider.Model
  message?: MessageV2.WithParts
  sessionID: string
}): Promise<{ model: Provider.Model; dropImages: boolean; rotated: boolean }> {
  if (!hasImageParts(input.message)) {
    return { model: input.model, dropImages: false, rotated: false }
  }

  if (input.model.capabilities.input.image) {
    return { model: input.model, dropImages: false, rotated: false }
  }

  const fallback = await selectImageModel(input.model)
  if (fallback) {
    return { model: fallback, dropImages: false, rotated: true }
  }

  const error = new NamedError.Unknown({
    message: "No available image-capable model from Rotation3D. Image input blocked.",
  })
  Bus.publish(Session.Event.Error, {
    sessionID: input.sessionID,
    error: error.toObject(),
  })
  throw error
}
