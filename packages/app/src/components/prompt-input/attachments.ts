import { createSignal, createMemo, onCleanup } from "solid-js"
import { usePrompt, type ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { Identifier } from "@/utils/id"

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
export const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"]

export function createPromptAttachments() {
  const prompt = usePrompt()
  const language = useLanguage()
  const [dragging, setDragging] = createSignal(false)

  const imageAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "image") as ImageAttachmentPart[],
  )

  const addImageAttachment = async (file: File) => {
    if (!ACCEPTED_FILE_TYPES.includes(file.type)) {
      showToast({
        title: language.t("prompt.toast.invalidFileType.title"),
        description: language.t("prompt.toast.invalidFileType.description", {
          types: ACCEPTED_FILE_TYPES.join(", "),
        }),
      })
      return
    }

    if (file.size > 10 * 1024 * 1024) {
      showToast({
        title: language.t("prompt.toast.fileTooLarge.title"),
        description: language.t("prompt.toast.fileTooLarge.description", { size: "10MB" }),
      })
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      if (!dataUrl) return

      const next = [...prompt.current()]
      next.push({
        type: "image",
        id: Identifier.ascending("part"),
        dataUrl,
        mime: file.type,
        filename: file.name,
      })
      prompt.set(next)
    }
    reader.readAsDataURL(file)
  }

  const removeImageAttachment = (id: string) => {
    const next = prompt.current().filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (ACCEPTED_FILE_TYPES.includes(item.type)) {
        const file = item.getAsFile()
        if (file) {
          addImageAttachment(file)
          event.preventDefault()
        }
      }
    }
  }

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
  }

  const handleDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)

    const files = event.dataTransfer?.files
    if (!files) return

    for (const file of Array.from(files)) {
      if (ACCEPTED_FILE_TYPES.includes(file.type)) {
        addImageAttachment(file)
      }
    }
  }

  return {
    dragging,
    imageAttachments,
    addImageAttachment,
    removeImageAttachment,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
