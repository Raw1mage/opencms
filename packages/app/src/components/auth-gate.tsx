import { Show, createEffect, createMemo, onMount, type ParentComponent } from "solid-js"
import { useWebAuth } from "@/context/web-auth"

export const AuthGate: ParentComponent = (props) => {
  const auth = useWebAuth()
  const canRenderApp = createMemo(() => {
    if (auth.loading()) return false
    return !auth.enabled() || auth.authenticated()
  })

  let redirectedToGateway = false
  createEffect(() => {
    if (auth.loading()) return
    if (!auth.enabled()) return
    if (auth.authenticated()) return
    if (redirectedToGateway) return
    redirectedToGateway = true
    window.location.replace("/global/auth/logout")
  })

  // Auto-login support for desktop: Tauri injects credentials via initialization script
  onMount(() => {
    const creds = (window as any).__OPENCODE__?.autoLoginCredentials
    if (!creds) return
    delete (window as any).__OPENCODE__.autoLoginCredentials
    auth.login(creds.username, creds.password)
  })
  return (
    <Show
      when={canRenderApp()}
      fallback={
        <div class="size-full min-h-screen bg-bg-default flex items-center justify-center p-6 text-13-regular text-text-weak">
          Returning to gateway...
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

// this is just to trigger a change
