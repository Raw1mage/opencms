import { promises as fs } from "fs"
import path from "path"

type ValidationResult = {
  fatal: string[]
  warnings: string[]
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function readRolesFromNestedMessages(messagesDir: string) {
  const ids = await fs.readdir(messagesDir)
  const roles: string[] = []

  for (const id of ids) {
    const infoPath = path.join(messagesDir, id, "info.json")
    const exists = await pathExists(infoPath)
    if (!exists) continue
    const info = JSON.parse(await fs.readFile(infoPath, "utf-8")) as { role?: string }
    if (info.role) roles.push(info.role)
  }

  return roles
}

async function validateNestedMessageStructure(messagesDir: string) {
  const fatal: string[] = []
  const ids = await fs.readdir(messagesDir)

  if (ids.length === 0) {
    fatal.push("No messages found in nested session storage")
    return { fatal }
  }

  for (const id of ids) {
    const infoPath = path.join(messagesDir, id, "info.json")
    if (!(await pathExists(infoPath))) {
      fatal.push(`Message ${id} is missing info.json`)
      continue
    }
    const partsDir = path.join(messagesDir, id, "parts")
    if (!(await pathExists(partsDir))) {
      fatal.push(`Message ${id} is missing parts directory`)
    }
  }

  return { fatal }
}

async function readRolesFromLegacyMessages(messageDir: string) {
  const files = await fs.readdir(messageDir)
  const roles: string[] = []
  for (const file of files) {
    const info = JSON.parse(await fs.readFile(path.join(messageDir, file), "utf-8")) as { role?: string }
    if (info.role) roles.push(info.role)
  }
  return roles
}

export async function validateForkSource(storageBase: string, sessionID: string): Promise<ValidationResult> {
  const fatal: string[] = []
  const warnings: string[] = []

  const sourceMessagesDir = path.join(storageBase, "session", sessionID, "messages")
  const legacyMessagesDir = path.join(storageBase, "message", sessionID)

  const hasSourceMessages = await pathExists(sourceMessagesDir)
  const hasLegacyMessages = await pathExists(legacyMessagesDir)

  if (!hasSourceMessages && !hasLegacyMessages) {
    fatal.push(`Cannot fork session ${sessionID}: no persisted message history found`)
    return { fatal, warnings }
  }

  let roles: string[] = []

  if (hasSourceMessages) {
    const result = await validateNestedMessageStructure(sourceMessagesDir)
    fatal.push(...result.fatal)
    if (result.fatal.length === 0) {
      roles = await readRolesFromNestedMessages(sourceMessagesDir)
    }
  }

  if (hasLegacyMessages && roles.length === 0) {
    roles = await readRolesFromLegacyMessages(legacyMessagesDir)
    if (roles.length === 0) {
      fatal.push("Legacy message storage exists but contains no message entries")
    }
  }

  if (roles.length > 0 && !roles.includes("assistant")) {
    warnings.push(
      "Source session has no assistant messages. This often indicates an incomplete/manual seed session and may cause unstable UI behavior.",
    )
  }

  return { fatal, warnings }
}

export async function validateForkResult(storageBase: string, newSessionID: string): Promise<ValidationResult> {
  const fatal: string[] = []
  const warnings: string[] = []

  const sessionIndexPath = path.join(storageBase, "index", "session", `${newSessionID}.json`)
  if (!(await pathExists(sessionIndexPath))) {
    fatal.push(`Forked session index missing: ${sessionIndexPath}`)
  }

  const nestedMessagesDir = path.join(storageBase, "session", newSessionID, "messages")
  const legacyMessagesDir = path.join(storageBase, "message", newSessionID)

  const hasNested = await pathExists(nestedMessagesDir)
  const hasLegacy = await pathExists(legacyMessagesDir)

  if (!hasNested && !hasLegacy) {
    fatal.push(`Forked session ${newSessionID} has no message history`)
    return { fatal, warnings }
  }

  let roles: string[] = []

  if (hasNested) {
    const result = await validateNestedMessageStructure(nestedMessagesDir)
    fatal.push(...result.fatal)
    if (result.fatal.length === 0) {
      roles = await readRolesFromNestedMessages(nestedMessagesDir)
    }
  }

  if (hasLegacy && roles.length === 0) {
    roles = await readRolesFromLegacyMessages(legacyMessagesDir)
  }

  if (roles.length === 0) {
    fatal.push(`Forked session ${newSessionID} has empty message role data`)
  } else if (!roles.includes("assistant")) {
    warnings.push("Forked session contains no assistant messages; conversation may appear as queued/pending in UI.")
  }

  return { fatal, warnings }
}
