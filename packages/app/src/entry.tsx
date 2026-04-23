// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"
const DYNAMIC_IMPORT_RETRY_KEY = "opencode.web.dynamicImportRetry"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const installDynamicImportRecovery = () => {
  const shouldRecover = (reason: unknown) => {
    const message =
      typeof reason === "string"
        ? reason
        : reason instanceof Error
          ? reason.message
          : reason && typeof reason === "object" && "message" in reason
            ? String((reason as { message?: unknown }).message)
            : ""
    return /Failed to fetch dynamically imported module/i.test(message)
  }

  // mobile reload diagnostic (2026-04-24): beacon the trigger path so we
  // can see in daemon log what causes the client-side reload loop. Fires
  // BEFORE the reload so the server captures the event even if the page
  // unmount kills subsequent sends.
  const beaconReloadCause = (cause: string, detail: unknown) => {
    try {
      const payload = {
        cause,
        detail: typeof detail === "string" ? detail.slice(0, 400) : (() => {
          try { return JSON.stringify(detail).slice(0, 400) } catch { return String(detail).slice(0, 400) }
        })(),
        href: window.location.href.slice(0, 200),
        ua: navigator.userAgent.slice(0, 200),
        at: new Date().toISOString(),
      }
      // sendBeacon survives page unload
      const body = JSON.stringify(payload)
      const blob = new Blob([body], { type: "application/json" })
      navigator.sendBeacon?.("/api/v2/global/debug/reload-beacon", blob)
    } catch {
      // diagnostic best-effort; never block reload
    }
  }

  const recover = (cause: string, detail: unknown) => {
    beaconReloadCause(cause, detail)
    const now = Date.now()
    const last = Number(localStorage.getItem(DYNAMIC_IMPORT_RETRY_KEY) ?? "0")
    // Prevent infinite hard-reload loop on persistent outage
    if (Number.isFinite(last) && now - last < 15_000) return
    localStorage.setItem(DYNAMIC_IMPORT_RETRY_KEY, String(now))
    window.location.reload()
  }

  window.addEventListener("vite:preloadError", (event) => {
    recover("vite:preloadError", (event as any)?.payload ?? (event as any)?.target?.src ?? "unknown")
  })

  window.addEventListener("unhandledrejection", (event) => {
    if (!shouldRecover(event.reason)) return
    event.preventDefault()
    recover("unhandledrejection", event.reason)
  })
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServerUrl: readDefaultServerUrl,
  setDefaultServerUrl: writeDefaultServerUrl,
}

installDynamicImportRecovery()

if (root instanceof HTMLElement) {
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
