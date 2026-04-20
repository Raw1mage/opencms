import { Accessor } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { createOpencodeClient, type Message } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLocal } from "@/context/local"
import { usePrompt, type ImageAttachmentPart, type Prompt } from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useCommand } from "@/context/command"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import type { FileSelection } from "@/context/file"
import { setCursorPosition } from "./editor-dom"
import { buildRequestParts } from "./build-request-parts"
import { formatApiErrorMessage } from "@/utils/api-error"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
  autonomous?: Accessor<boolean>
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const local = useLocal()
  const permission = usePermission()
  const command = useCommand()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()

  const debugAttachments = (...args: unknown[]) => {
    if (typeof localStorage === "undefined") return
    if (localStorage.getItem("opencode.debug.attachments") !== "1") return
    console.info("[attachments-debug]", ...args)
  }

  const errorMessage = (err: unknown) => {
    return formatApiErrorMessage({
      error: err,
      fallback: language.t("common.requestFailed"),
      projectBoundaryMessage:
        "This operation is restricted to the active workspace directory. Choose or create a workspace that contains your target path.",
    })
  }

  let lastAbortMs = 0
  const DOUBLE_CLICK_WINDOW_MS = 500

  const abortAll = async () => {
    try {
      const res = await sdk.fetch(`${sdk.url}/api/v2/session/abort-all`, { method: "POST" })
      if (res.ok) {
        const body = (await res.json()) as { aborted: number }
        showToast({
          title: language.t("prompt.action.stop"),
          description: `Emergency stop: ${body.aborted} session(s) aborted`,
        })
      }
    } catch {}
  }

  const abort = async () => {
    const now = Date.now()
    if (now - lastAbortMs < DOUBLE_CLICK_WINDOW_MS) {
      lastAbortMs = 0
      return abortAll()
    }
    lastAbortMs = now

    const sessionID = params.id
    if (!sessionID) return Promise.resolve()
    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) abort()
      return
    }

    if (mode === "normal" && images.length === 0 && input.commentCount() === 0 && text.startsWith("/")) {
      const [cmdName] = text.trim().split(/\s+/)
      const commandName = cmdName.slice(1)
      const builtin = command.options.find((opt) => !opt.disabled && opt.slash === commandName)
      if (builtin) {
        prompt.reset()
        input.setMode("normal")
        input.setPopover(null)
        command.trigger(builtin.id, "slash")
        return
      }
    }

    const currentModel = local.model.current(params.id)
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory, worktreeCreateInput: {} })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = createOpencodeClient({
          baseUrl: sdk.url,
          fetch: sdk.fetch,
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      session = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (session) {
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    input.onSubmit?.()

    // SSOT: when the session already has a pinned execution identity, ALL three
    // fields (providerId / modelID / accountId) must come from it together.
    // Mixing server-side SSOT for accountId with client-local for providerId/modelID
    // produces invalid combinations the server can't resolve — the session then
    // enters a "message sent but no reply" death loop because each client is
    // submitting a different triple against the same session.
    // Only new sessions (no params.id) fall back to local selection.
    const sessionExec = params.id ? sync.session.get(params.id)?.execution : undefined
    const model = sessionExec
      ? {
          modelID: sessionExec.modelID,
          providerId: sessionExec.providerId,
          accountId: sessionExec.accountId,
        }
      : {
          modelID: currentModel.id,
          providerId: currentModel.provider.id,
          accountId: local.model.selection?.(params.id)?.accountID,
        }
    const agent = currentAgent.name
    const variant = local.model.variant.current(params.id)

    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)

      // Mobile UX: collapse soft keyboard right after successful submit.
      if (
        platform.platform === "web" &&
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 767px)").matches
      ) {
        input.editor()?.blur()
      }
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerId}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: errorMessage(err),
            })
            restoreInput()
          })
        return
      }
    }

    const context = prompt.context.items().slice()
    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

    const messageID = Identifier.ascending("message")
    const { requestParts, optimisticParts } = buildRequestParts({
      prompt: currentPrompt,
      context,
      images,
      text,
      sessionID: session.id,
      messageID,
      sessionDirectory,
    })

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const addOptimisticMessage = () =>
      sync.session.optimistic.add({
        directory: sessionDirectory,
        sessionID: session.id,
        message: optimisticMessage,
        parts: optimisticParts,
      })

    debugAttachments("submit", {
      sessionID: session.id,
      messageID,
      composerImages: images.map((image) => ({
        filename: image.filename,
        mime: image.mime,
        bytes: image.dataUrl.length,
      })),
      optimisticFileParts: optimisticParts
        .filter((part) => part.type === "file")
        .map((part) => ({ id: part.id, filename: part.filename, mime: part.mime, urlHead: part.url.slice(0, 48) })),
    })

    const removeOptimisticMessage = () =>
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })

    removeCommentItems(commentItems)
    clearInput()
    addOptimisticMessage()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({ status: "failed", message: language.t("workspace.error.stillPreparing") })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    // Telemetry context — logged on send start, success, and failure so a
    // "sent but no reply" incident can be classified as:
    //   (a) fetch never fired       → no `[submit] send start` log
    //   (b) fetch threw/timed out   → `[submit] send failed` in catch
    //   (c) server accepted but no reply → start + ok but no assistant msg
    // Correlates with the daemon-side `prompt_async inbound` log by sessionID.
    const telemetryCtx = {
      sessionID: session.id,
      messageID,
      agent,
      providerId: model.providerId,
      modelID: model.modelID,
      accountId: model.accountId,
      variant,
      partCount: requestParts.length,
      sameDirectory: sessionDirectory === projectDirectory,
    }
    const sendStartedAt = Date.now()

    const send = async () => {
      const ok = await waitForWorktree()
      if (!ok) return
      console.info("[submit] send start", telemetryCtx)
      await client.session.promptAsync({
        sessionID: session.id,
        agent,
        model,
        messageID,
        parts: requestParts,
        variant,
        autonomous: true, // always-on
      })
      console.info("[submit] send ok", { ...telemetryCtx, elapsedMs: Date.now() - sendStartedAt })
    }

    void send().catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      console.warn("[submit] send failed", {
        ...telemetryCtx,
        elapsedMs: Date.now() - sendStartedAt,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      })
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      restoreCommentItems(commentItems)
      restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
