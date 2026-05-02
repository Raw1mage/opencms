import { onCleanup, onMount } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { usePrompt, type ContentPart, type ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
// /specs/repo-incoming-attachments — drag-drop accepts the file types the
// backend (routeOversizedAttachment → tryLandInIncoming → mcp dispatcher)
// can route. Office formats land in <repo>/incoming/ and are picked up by
// docxmcp / future xlsx-mcp / pptx-mcp via the dispatcher.
export const ACCEPTED_OFFICE_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/msword", // legacy .doc
  "application/vnd.ms-excel", // legacy .xls
  "application/vnd.ms-powerpoint", // legacy .ppt
]
export const ACCEPTED_TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]
export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  "application/pdf",
  ...ACCEPTED_OFFICE_TYPES,
  ...ACCEPTED_TEXT_TYPES,
]

// Extension-based MIME inference for OS / DE that don't fill in
// dataTransfer.file.type for Office documents.
const EXTENSION_TO_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
}

function inferMimeFromFile(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_TO_MIME[ext] ?? ""
}
const LARGE_PASTE_CHARS = 8000
const LARGE_PASTE_BREAKS = 120

function largePaste(text: string) {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement | undefined
  isFocused: () => boolean
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const language = useLanguage()
  const pendingImageKeys = new Set<string>()
  const recentImageKeys = new Map<string, number>()
  let lastPasteSignature = ""
  let lastPasteAt = 0

  const imageKey = (file: File) => `${file.name}:${file.type}:${file.size}:${file.lastModified}`
  const RECENT_TTL = 5000

  const markRecent = (key: string) => {
    const now = Date.now()
    recentImageKeys.set(key, now)
    for (const [k, at] of recentImageKeys) {
      if (now - at > RECENT_TTL) recentImageKeys.delete(k)
    }
  }

  const seenRecently = (key: string) => {
    const at = recentImageKeys.get(key)
    return typeof at === "number" && Date.now() - at < RECENT_TTL
  }

  const addImageAttachment = async (file: File) => {
    const inferredMime = inferMimeFromFile(file)
    if (!ACCEPTED_FILE_TYPES.includes(inferredMime)) return
    const key = imageKey(file)
    if (pendingImageKeys.has(key) || seenRecently(key)) return
    pendingImageKeys.add(key)

    const reader = new FileReader()
    reader.onerror = () => {
      pendingImageKeys.delete(key)
    }
    reader.onabort = () => {
      pendingImageKeys.delete(key)
    }
    reader.onload = () => {
      const editor = input.editor()
      if (!editor) {
        pendingImageKeys.delete(key)
        return
      }
      const dataUrl = reader.result as string
      const attachment: ImageAttachmentPart = {
        type: "image",
        id: uuid(),
        filename: file.name,
        mime: inferredMime,
        dataUrl,
      }
      const cursorPosition = prompt.cursor() ?? getCursorPosition(editor)
      const current = prompt.current()
      const duplicated = current.some((part) => part.type === "image" && part.dataUrl === dataUrl)
      if (duplicated) {
        markRecent(key)
        pendingImageKeys.delete(key)
        return
      }
      prompt.set([...current, attachment], cursorPosition)
      markRecent(key)
      pendingImageKeys.delete(key)
    }
    reader.readAsDataURL(file)
  }

  const removeImageAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    if (!input.isFocused()) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const items = Array.from(clipboardData.items)
    const signature = items
      .map((item) => {
        if (item.kind !== "file") return `${item.kind}:${item.type}`
        const file = item.getAsFile()
        if (!file) return `${item.kind}:${item.type}`
        return `${item.kind}:${item.type}:${file.name}:${file.size}:${file.lastModified}`
      })
      .sort()
      .join("|")
    const now = Date.now()
    if (signature && signature === lastPasteSignature && now - lastPasteAt < 1200) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    lastPasteSignature = signature
    lastPasteAt = now
    const fileItems = items.filter((item) => item.kind === "file")
    const imageItems = fileItems.filter((item) => ACCEPTED_FILE_TYPES.includes(item.type))

    if (imageItems.length > 0) {
      // Some clipboard sources expose the same image in multiple mime variants
      // (eg. image/png + image/jpeg). We only keep a single best candidate
      // to avoid duplicated thumbnails and duplicated token usage.
      const preferred = ["image/png", "image/webp", "image/jpeg", "image/gif", "application/pdf"]
      const selectedItem =
        preferred
          .map((mime) => imageItems.find((item) => item.type === mime))
          .find((item): item is DataTransferItem => !!item) ?? imageItems[0]
      const file = selectedItem?.getAsFile()
      if (file) await addImageAttachment(file)
      return
    }

    if (fileItems.length > 0) {
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addImageAttachment(file)
        return
      }
    }

    if (!plainText) return
    if (largePaste(plainText)) {
      if (input.addPart({ type: "text", content: plainText, start: 0, end: 0 })) return
      input.focusEditor()
      if (input.addPart({ type: "text", content: plainText, start: 0, end: 0 })) return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, plainText)
    if (inserted) return

    input.addPart({ type: "text", content: plainText, start: 0, end: 0 })
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    for (const file of Array.from(dropped)) {
      if (ACCEPTED_FILE_TYPES.includes(inferMimeFromFile(file))) {
        await addImageAttachment(file)
      }
    }
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop)
  })

  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop)
  })

  return {
    addImageAttachment,
    removeImageAttachment,
    handlePaste,
  }
}
