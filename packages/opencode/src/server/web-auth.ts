import { createHmac, randomBytes, timingSafeEqual } from "crypto"
import type { Context } from "hono"
import { Flag } from "@/flag/flag"
import { WebAuthCredentials } from "./web-auth-credentials"

const SESSION_COOKIE = "opencode_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOCK_THRESHOLD = 5
const LOCK_WINDOW_MS = 5 * 60 * 1000

type SessionPayload = {
  username: string
  csrf: string
  sid: string
  iat: number
  exp: number
}

type LockState = {
  count: number
  lockedUntil?: number
}

const revoked = new Map<string, number>()
const lockout = new Map<string, LockState>()

const API_PREFIXES = [
  "/api/v2",
  "/global",
  "/auth",
  "/project",
  "/pty",
  "/config",
  "/experimental",
  "/session",
  "/permission",
  "/question",
  "/provider",
  "/mcp",
  "/tui",
  "/account",
  "/accounts",
  "/rotation",
  "/path",
  "/vcs",
  "/command",
  "/log",
  "/agent",
  "/skill",
  "/lsp",
  "/formatter",
  "/event",
  "/instance",
  "/doc",
]

function now() {
  return Date.now()
}

function enabled() {
  return WebAuthCredentials.enabled()
}

function username() {
  return WebAuthCredentials.usernameHint()
}

function cleanup() {
  const t = now()
  for (const [sid, exp] of revoked) {
    if (exp <= t) revoked.delete(sid)
  }
  for (const [key, state] of lockout) {
    if (state.lockedUntil && state.lockedUntil <= t) {
      lockout.delete(key)
      continue
    }
    if (!state.lockedUntil && state.count <= 0) lockout.delete(key)
  }
}

function secret() {
  const user = username()
  const password = Flag.OPENCODE_SERVER_PASSWORD ?? ""
  const file = WebAuthCredentials.filePath() ?? ""
  return process.env.OPENCODE_SERVER_AUTH_SECRET ?? `${user}:${password}:${file}:opencode:web-auth:v1`
}

function sign(raw: string) {
  return createHmac("sha256", secret()).update(raw).digest("base64url")
}

function encode(payload: SessionPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${sign(body)}`
}

function decode(token: string | undefined): SessionPayload | undefined {
  if (!token) return
  const [body, sig] = token.split(".")
  if (!body || !sig) return

  const expected = sign(body)
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return
  if (!timingSafeEqual(left, right)) return

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload
    if (!payload?.sid || !payload?.csrf || !payload?.exp || !payload?.username) return
    if (payload.exp <= now()) return
    if (revoked.has(payload.sid)) return
    return payload
  } catch {
    return
  }
}

function parseCookies(cookieHeader: string | undefined) {
  if (!cookieHeader) return {}
  const result: Record<string, string> = {}
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=")
    if (!rawName) continue
    result[rawName] = decodeURIComponent(rawValue.join("="))
  }
  return result
}

function isSecureRequest(c: Context) {
  // Check X-Forwarded-Proto first (reverse proxy with SSL termination)
  const proto = c.req.header("x-forwarded-proto")
  if (proto) return proto.split(",")[0].trim() === "https"
  try {
    return new URL(c.req.url).protocol === "https:"
  } catch {
    return false
  }
}

function cookieHeader(c: Context, token: string, maxAgeSeconds: number) {
  const secure = isSecureRequest(c)
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${
    secure ? "; Secure" : ""
  }`
}

function clearCookieHeader(c: Context) {
  const secure = isSecureRequest(c)
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
}

function isApiPath(pathname: string) {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"))
}

function routePublic(c: Context) {
  const pathname = c.req.path
  const method = c.req.method
  if (method === "OPTIONS") return true
  if (pathname === "/global/health") return true
  if (pathname === "/global/auth/login") return true
  if (pathname === "/global/auth/session") return true
  if (pathname === "/global/auth/logout") return true
  if ((method === "GET" || method === "HEAD") && !isApiPath(pathname)) return true
  return false
}

function isTrustedLoopbackRequest(c: Context) {
  // Reject if any proxy headers are present — request came through a
  // reverse proxy and is NOT a direct loopback connection.
  const forwardedFor = c.req.header("x-forwarded-for")
  const forwardedProto = c.req.header("x-forwarded-proto")
  const realIp = c.req.header("x-real-ip")
  const cfConnectingIp = c.req.header("cf-connecting-ip")
  if (forwardedFor || forwardedProto || realIp || cfConnectingIp) return false

  try {
    const hostname = new URL(c.req.url).hostname.toLowerCase()
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]") {
      return false
    }
  } catch {
    return false
  }

  return true
}

function lockKey(c: Context, user: string) {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  return `${ip}:${user}`
}

function lockStatus(c: Context, user: string) {
  cleanup()
  const state = lockout.get(lockKey(c, user))
  if (!state?.lockedUntil) return
  const ms = state.lockedUntil - now()
  if (ms <= 0) return
  return {
    lockedUntil: state.lockedUntil,
    retryAfterSeconds: Math.ceil(ms / 1000),
  }
}

function markFailure(c: Context, user: string) {
  cleanup()
  const key = lockKey(c, user)
  const prev = lockout.get(key) ?? { count: 0 }
  const nextCount = prev.count + 1
  if (nextCount >= LOCK_THRESHOLD) {
    lockout.set(key, {
      count: nextCount,
      lockedUntil: now() + LOCK_WINDOW_MS,
    })
    return
  }
  lockout.set(key, { count: nextCount })
}

function markSuccess(c: Context, user: string) {
  lockout.delete(lockKey(c, user))
}

function issue(user: string): { payload: SessionPayload; token: string } {
  const iat = now()
  const exp = iat + SESSION_TTL_MS
  const payload: SessionPayload = {
    username: user,
    csrf: randomBytes(24).toString("base64url"),
    sid: randomBytes(16).toString("base64url"),
    iat,
    exp,
  }
  return { payload, token: encode(payload) }
}

function readSession(c: Context) {
  cleanup()
  const token = parseCookies(c.req.header("cookie"))[SESSION_COOKIE]
  return decode(token)
}

function invalidate(session: SessionPayload | undefined) {
  if (!session) return
  revoked.set(session.sid, session.exp)
}

function verifyCredentials(user: string, pass: string) {
  return WebAuthCredentials.verify(user, pass)
}

function parseBasicAuthorization(value: string | undefined) {
  if (!value || !value.startsWith("Basic ")) return
  const encoded = value.slice("Basic ".length).trim()
  if (!encoded) return
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const index = decoded.indexOf(":")
    if (index <= 0) return
    const user = decoded.slice(0, index)
    const pass = decoded.slice(index + 1)
    if (!user || !pass) return
    return { user, pass }
  } catch {
    return
  }
}

async function verifyBasicAuth(c: Context) {
  const user = await verifyBasicAuthUser(c)
  return !!user
}

async function verifyBasicAuthUser(c: Context) {
  const parsed = parseBasicAuthorization(c.req.header("authorization"))
  if (!parsed) return
  const ok = await WebAuthCredentials.verify(parsed.user, parsed.pass)
  if (!ok) return
  return parsed.user
}

function shouldProtectMutation(method: string, pathname: string) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  if (pathname === "/global/auth/login") return false
  return true
}

export const WebAuth = {
  enabled,
  routePublic,
  isTrustedLoopbackRequest,
  readSession,
  shouldProtectMutation,
  isApiPath,
  cookieHeader,
  clearCookieHeader,
  verifyCredentials,
  verifyBasicAuth,
  verifyBasicAuthUser,
  issue,
  invalidate,
  lockStatus,
  markFailure,
  markSuccess,
  username,
}

export type WebAuthSession = SessionPayload
