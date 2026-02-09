import { Env } from "@/env"

export function proxied() {
  return !!(Env.get("HTTP_PROXY") || Env.get("HTTPS_PROXY") || Env.get("http_proxy") || Env.get("https_proxy"))
}
