import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Show, createMemo, createSignal, onMount, type ParentComponent } from "solid-js"
import { useServer } from "@/context/server"
import { useWebAuth } from "@/context/web-auth"

export const AuthGate: ParentComponent = (props) => {
  const auth = useWebAuth()
  const server = useServer()
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const canRenderApp = createMemo(() => {
    if (auth.loading()) return false
    return !auth.enabled() || auth.authenticated()
  })

  // Auto-login support for desktop: Tauri injects credentials via initialization script
  onMount(() => {
    const creds = (window as any).__OPENCODE__?.autoLoginCredentials
    if (!creds) return
    delete (window as any).__OPENCODE__.autoLoginCredentials
    auth.login(creds.username, creds.password)
  })



  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    setError("")
    setBusy(true)
    const result = await auth.login(username().trim(), password())
    if (!result.ok) {
      setError(result.message)
      setBusy(false)
      return
    }
    setPassword("")
    setBusy(false)
  }

  return (
    <Show
      when={canRenderApp()}
      fallback={
        <div class="size-full min-h-screen bg-bg-default flex items-center justify-center p-6">
          <form
            class="w-full max-w-[380px] bg-surface-raised-base border border-border-weak-base rounded-xl p-6"
            onSubmit={submit}
          >
            <div class="flex flex-col gap-1 mb-5">
              <h1 class="text-18-medium text-text-strong">OpenCode Login</h1>
              <p class="text-13-regular text-text-weak">{server.name || server.url}</p>
            </div>

            <div class="flex flex-col gap-3">
              <TextField
                type="text"
                hideLabel
                value={username()}
                onChange={setUsername}
                placeholder="Username"
                autoComplete="username"
              />
              <TextField
                type="password"
                hideLabel
                value={password()}
                onChange={setPassword}
                placeholder="Password"
                autoComplete="current-password"
              />
            </div>

            <Show when={error()}>
              <div class="mt-3 text-12-regular text-text-danger-base">{error()}</div>
            </Show>

            <Show when={auth.session()?.lockout}>
              <div class="mt-3 text-12-regular text-icon-warning-base">
                Too many attempts. Retry in {auth.session()!.lockout!.retryAfterSeconds}s.
              </div>
            </Show>

            <div class="mt-5">
              <Button type="submit" class="w-full" disabled={busy() || !username().trim() || !password()}>
                {busy() ? "Signing in..." : "Sign in"}
              </Button>
            </div>
          </form>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

// this is just to trigger a change
