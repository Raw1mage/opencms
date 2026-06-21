import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { GoogleBinding } from "../../google-binding"
import { RequestUser } from "@/runtime/request-user"
import { Global } from "../../global"
import { Log } from "../../util/log"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "google-binding-route" })

/**
 * Google Binding Routes — self-service binding management for PAM-authenticated users.
 *
 * These routes run inside the per-user daemon (user is already PAM-authenticated).
 * They let users bind/unbind their Google identity to/from the global binding registry,
 * which the C gateway reads for Google login routing.
 */
export const GoogleBindingRoutes = lazy(() =>
  new Hono()
    // --- GET /status ---
    .get(
      "/status",
      describeRoute({
        summary: "Get Google binding status for current user",
        description:
          "Returns whether the current PAM-authenticated user has a Google identity bound.",
        operationId: "googleBinding.status",
        responses: {
          200: {
            description: "Binding status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    bound: z.boolean(),
                    email: z.string().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(403),
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (!username) {
          return c.json({ error: "Not authenticated" }, 403)
        }

        const email = await GoogleBinding.getByUsername(username)
        return c.json({ bound: !!email, email: email ?? undefined })
      },
    )

    // --- GET /connect ---
    .get(
      "/connect",
      describeRoute({
        summary: "Start Google OAuth flow for binding",
        description:
          "Redirects the user to Google OAuth consent screen to verify Google identity for binding. Requires openid and email scopes only.",
        operationId: "googleBinding.connect",
        responses: {
          302: { description: "Redirect to Google OAuth" },
          ...errors(400, 403),
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (!username) {
          return c.json({ error: "Not authenticated" }, 403)
        }

        const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
        if (!clientId) {
          return c.json({ error: "GOOGLE_CALENDAR_CLIENT_ID not configured" }, 400)
        }

        const authUri =
          process.env.GOOGLE_CALENDAR_AUTH_URI || "https://accounts.google.com/o/oauth2/auth"

        // Build redirect URI from forwarded headers (proxy-safe)
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host =
          c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const origin = `${proto}://${host}`
        const redirectUri = `${origin}/api/v2/google-binding/callback`

        // State: encode username for CSRF and identity verification
        const statePayload = JSON.stringify({
          username,
          nonce: crypto.randomUUID(),
          ts: Date.now(),
        })
        const state = Buffer.from(statePayload).toString("base64url")

        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          access_type: "online",
          prompt: "select_account",
          state,
        })

        log.info("Starting Google binding OAuth", { username, redirectUri })
        return c.redirect(`${authUri}?${params.toString()}`)
      },
    )

    // --- GET /callback ---
    .get(
      "/callback",
      describeRoute({
        summary: "Handle Google OAuth callback for binding",
        description:
          "Exchanges authorization code for tokens, extracts verified email from Google userinfo, and creates the binding.",
        operationId: "googleBinding.callback",
        responses: {
          200: { description: "Binding created, shows success page" },
          ...errors(400, 403),
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (!username) {
          return c.json({ error: "Not authenticated" }, 403)
        }

        const error = c.req.query("error")
        if (error) {
          log.warn("Google binding OAuth denied", { error })
          return c.html(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Authorization denied</h2><p>${escapeHtml(error)}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`,
          )
        }

        const code = c.req.query("code")
        if (!code) {
          return c.json({ error: "Missing authorization code" }, 400)
        }

        // Validate state — username must match current session
        const stateRaw = c.req.query("state")
        if (stateRaw) {
          try {
            const statePayload = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf8"))
            if (statePayload.username !== username) {
              log.warn("Google binding state mismatch", {
                expected: username,
                got: statePayload.username,
              })
              return c.json({ error: "State mismatch — session user changed" }, 403)
            }
            // Check TTL (5 minutes)
            if (Date.now() - statePayload.ts > 5 * 60 * 1000) {
              return c.json({ error: "OAuth state expired" }, 400)
            }
          } catch {
            return c.json({ error: "Invalid state parameter" }, 400)
          }
        }

        const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID
        const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET
        const tokenUri = process.env.GOOGLE_CALENDAR_TOKEN_URI || "https://oauth2.googleapis.com/token"
        if (!clientId || !clientSecret) {
          return c.json({ error: "Google OAuth credentials not configured" }, 400)
        }

        // Build redirect URI (must match the one used in /connect)
        const proto = c.req.header("x-forwarded-proto") || "https"
        const host =
          c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host
        const origin = `${proto}://${host}`
        const redirectUri = `${origin}/api/v2/google-binding/callback`

        // Exchange authorization code for tokens
        const tokenResponse = await fetch(tokenUri, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        })

        if (!tokenResponse.ok) {
          const body = await tokenResponse.text()
          log.error("Google binding token exchange failed", {
            status: tokenResponse.status,
            body,
          })
          return c.json({ error: "Token exchange failed" }, 400)
        }

        const tokens = (await tokenResponse.json()) as {
          access_token: string
          token_type: string
        }

        // Get verified email from Google userinfo
        const userinfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `${tokens.token_type} ${tokens.access_token}` },
        })

        if (!userinfoResponse.ok) {
          log.error("Google userinfo fetch failed", { status: userinfoResponse.status })
          return c.json({ error: "Failed to verify Google identity" }, 400)
        }

        const userinfo = (await userinfoResponse.json()) as {
          email: string
          verified_email: boolean
        }

        if (!userinfo.email || !userinfo.verified_email) {
          log.warn("Google email not verified", { email: userinfo.email })
          return c.json({ error: "Google email is not verified" }, 400)
        }

        // Create the binding
        try {
          await GoogleBinding.bind(userinfo.email, username)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          log.warn("Google binding failed", { email: userinfo.email, username, error: msg })
          return c.html(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Binding failed</h2><p>${escapeHtml(msg)}</p><script>setTimeout(()=>window.close(),5000)</script></body></html>`,
          )
        }

        log.info("Google binding created via OAuth", { email: userinfo.email, username })
        return c.html(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Google account bound</h2><p>${escapeHtml(userinfo.email)} → ${escapeHtml(username)}</p><p>You can now use Google login on the gateway.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`,
        )
      },
    )

    // --- DELETE / ---
    .delete(
      "/",
      describeRoute({
        summary: "Remove Google binding for current user",
        description: "Removes the Google identity binding for the current PAM-authenticated user.",
        operationId: "googleBinding.unbind",
        responses: {
          200: {
            description: "Binding removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(403),
        },
      }),
      async (c) => {
        const username = RequestUser.username()
        if (!username) {
          return c.json({ error: "Not authenticated" }, 403)
        }

        await GoogleBinding.unbind(username)
        log.info("Google binding removed via API", { username })
        return c.json({ ok: true })
      },
    ),
)

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
