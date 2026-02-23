import { existsSync, readFileSync, statSync } from "fs"
import { Flag } from "@/flag/flag"

type Cache = {
  path: string
  mtimeMs: number
  entries: Map<string, string>
}

let cache: Cache | undefined

function htpasswdPath() {
  return Flag.OPENCODE_SERVER_HTPASSWD ?? Flag.OPENCODE_SERVER_PASSWORD_FILE
}

function parseHtpasswd(content: string) {
  const entries = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf(":")
    if (index <= 0) continue
    const user = trimmed.slice(0, index).trim()
    const hash = trimmed.slice(index + 1).trim()
    if (!user || !hash) continue
    entries.set(user, hash)
  }
  return entries
}

function readHtpasswd(path: string) {
  const stat = statSync(path)
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs) return cache.entries
  const content = readFileSync(path, "utf8")
  const entries = parseHtpasswd(content)
  cache = {
    path,
    mtimeMs: stat.mtimeMs,
    entries,
  }
  return entries
}

function plainEnabled() {
  return !!Flag.OPENCODE_SERVER_PASSWORD
}

function fileEnabled() {
  const path = htpasswdPath()
  if (!path) return false
  return existsSync(path)
}

function enabled() {
  return plainEnabled() || fileEnabled()
}

async function verify(username: string, password: string) {
  const path = htpasswdPath()
  if (path && existsSync(path)) {
    const hash = readHtpasswd(path).get(username)
    if (!hash) return false
    return Bun.password.verify(password, hash)
  }
  const expectedUser = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  const expectedPass = Flag.OPENCODE_SERVER_PASSWORD ?? ""
  if (!expectedPass) return false
  return username === expectedUser && password === expectedPass
}

function usernameHint() {
  const path = htpasswdPath()
  if (path && existsSync(path)) {
    const first = readHtpasswd(path).keys().next()
    if (!first.done) return first.value
  }
  return Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
}

export const WebAuthCredentials = {
  enabled,
  verify,
  usernameHint,
  filePath: htpasswdPath,
}
