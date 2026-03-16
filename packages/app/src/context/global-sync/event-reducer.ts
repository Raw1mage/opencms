import { Binary } from "@opencode-ai/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { LlmErrorEntry, State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => void)) => void
  refresh: () => void
  onDisposed?: () => boolean
}) {
  if (input.event.type === "global.disposed") {
    if (input.onDisposed?.()) return
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject((draft) => {
      draft[result.index] = { ...draft[result.index], ...properties }
    })
    return
  }
  input.setGlobalProject((draft) => {
    draft.splice(result.index, 0, properties)
  })
}

function cleanupSessionCaches(store: Store<State>, setStore: SetStoreFunction<State>, sessionID: string) {
  if (!sessionID) return
  const hasAny =
    store.message[sessionID] !== undefined ||
    store.session_diff[sessionID] !== undefined ||
    store.todo[sessionID] !== undefined ||
    store.permission[sessionID] !== undefined ||
    store.question[sessionID] !== undefined ||
    store.session_status[sessionID] !== undefined
  if (!hasAny) return
  setStore(
    produce((draft) => {
      const messages = draft.message[sessionID]
      if (messages) {
        for (const message of messages) {
          const id = message?.id
          if (!id) continue
          delete draft.part[id]
        }
      }
      delete draft.message[sessionID]
      delete draft.session_diff[sessionID]
      delete draft.todo[sessionID]
      delete draft.permission[sessionID]
      delete draft.question[sessionID]
      delete draft.session_status[sessionID]
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  vcsCache?: VcsCache
}) {
  const event = input.event
  const debugAttachments = (...args: unknown[]) => {
    if (typeof localStorage === "undefined") return
    if (localStorage.getItem("opencode.debug.attachments") !== "1") return
    console.info("[attachments-debug]", ...args)
  }
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    case "workspace.created":
    case "workspace.updated":
    case "workspace.lifecycle.changed":
    case "workspace.attachment.added":
    case "workspace.attachment.removed": {
      const props = event.properties as { workspace?: State["workspace"] }
      if (!props.workspace) break
      input.setStore("workspace", reconcile(props.workspace))
      break
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(input.store, input.setStore, info.id)
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(input.store, input.setStore, info.id)
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.diff": {
      // Ignore backend session.diff bus events.
      // They reflect historical session summary snapshots, while web now fetches
      // authoritative session-owned dirty diffs on demand through the session.diff API.
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        if (part.type === "file") {
          debugAttachments("part.updated:new", {
            messageID: part.messageID,
            partID: part.id,
            mime: part.mime,
            filename: part.filename,
            urlHead: part.url.slice(0, 64),
          })
        }
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        if (part.type === "file") {
          debugAttachments("part.updated:replace-id", {
            messageID: part.messageID,
            partID: part.id,
          })
        }
        break
      }

      // De-duplicate optimistic vs server-confirmed image/file parts.
      // Some providers may emit fresh part IDs for already-optimistic attachments.
      if (part.type === "file") {
        const isInlineImage = part.url.startsWith("data:image/")
        const semanticIndex = parts.findIndex(
          (existing) =>
            existing.type === "file" && existing.url === part.url && (isInlineImage || existing.mime === part.mime),
        )
        if (semanticIndex !== -1) {
          input.setStore("part", part.messageID, semanticIndex, reconcile(part))
          debugAttachments("part.updated:dedup-semantic", {
            messageID: part.messageID,
            partID: part.id,
            replacedIndex: semanticIndex,
          })
          break
        }
      }

      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
    case "llm.error": {
      const props = event.properties as {
        providerId: string
        modelId: string
        accountId: string
        sessionID: string
        status?: number
        message: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        sessionID: props.sessionID,
        status: props.status,
        message: props.message,
        timestamp: props.timestamp,
        type: "error",
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          // Replace existing entry for same provider+account+model vector
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
          // Cap at 30 entries
          if (draft.llm_errors.length > 30) {
            draft.llm_errors = draft.llm_errors.slice(-30)
          }
        }),
      )
      break
    }
    case "ratelimit.detected": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
        reason: string
        backoffMs: number
        source: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        message: props.reason,
        timestamp: props.timestamp,
        type: "ratelimit",
        reason: props.reason,
        backoffMs: props.backoffMs,
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
          if (draft.llm_errors.length > 30) {
            draft.llm_errors = draft.llm_errors.slice(-30)
          }
        }),
      )
      break
    }
    case "ratelimit.cleared": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) return
          draft.llm_errors = draft.llm_errors.filter(
            (e) =>
              !(e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId),
          )
        }),
      )
      break
    }
    case "ratelimit.auth_failed": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
        message: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        message: props.message,
        timestamp: props.timestamp,
        type: "auth_failed",
        reason: "AUTH_FAILED",
        backoffMs: 3_600_000,
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
        }),
      )
      break
    }
  }
}
