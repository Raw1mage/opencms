import { createMemo, createSignal, Show, onCleanup, createEffect } from "solid-js"
import { Portal } from "solid-js/web"
import { createSimpleContext } from "@opencode-ai/ui/context"

/**
 * Anchored in-app prompt + confirm primitives.
 *
 * Replaces window.prompt / window.confirm across the app. A single Portal
 * layer + dismissal contract is owned by this provider so every surface
 * (file-tree, terminal pane, session sidebar, popout windows, future
 * features) gets the same look + UX without duplicating modal scaffolds.
 *
 * Caller responsibility: pass anchor coords (typically captured from a
 * contextmenu / pointerdown event). When anchor is omitted the modal
 * centers in the viewport.
 *
 * Provider responsibility: Solid signal state, Portal mount, position
 * clamping, focus management on input prompts, Escape / Enter / outside-
 * click dismissal, z-index governance.
 */

export type ConfirmResolution = "confirm" | "cancel" | "apply-all"

export interface ConfirmOpts {
  title: string
  description?: string
  destructive?: boolean
  confirmLabel?: string
  cancelLabel?: string
  applyAllLabel?: string
  anchor?: { x: number; y: number }
}

export interface InputOpts {
  title: string
  description?: string
  initial?: string
  placeholder?: string
  submitLabel?: string
  cancelLabel?: string
  validate?: (value: string) => string | undefined
  anchor?: { x: number; y: number }
}

type ConfirmRequest = ConfirmOpts & {
  anchor: { x: number; y: number }
  resolve: (result: ConfirmResolution) => void
}
type InputRequest = InputOpts & {
  anchor: { x: number; y: number }
  resolve: (value: string | undefined) => void
}

const POPUP_MAX_W = 380
const POPUP_MAX_H = 220

const centerAnchor = (): { x: number; y: number } => ({
  x: typeof window === "undefined" ? 0 : window.innerWidth / 2,
  y: typeof window === "undefined" ? 0 : window.innerHeight / 2,
})

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

export const { use: usePrompts, provider: PromptsProvider } = createSimpleContext({
  name: "Prompts",
  init: () => {
    const [pendingConfirm, setPendingConfirm] = createSignal<ConfirmRequest | undefined>()
    const [pendingInput, setPendingInput] = createSignal<InputRequest | undefined>()

    const promptConfirm = (opts: ConfirmOpts): Promise<ConfirmResolution> =>
      new Promise<ConfirmResolution>((resolve) => {
        setPendingConfirm({ ...opts, anchor: opts.anchor ?? centerAnchor(), resolve })
      })

    const promptInput = (opts: InputOpts): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        setPendingInput({ ...opts, anchor: opts.anchor ?? centerAnchor(), resolve })
      })

    return {
      promptConfirm,
      promptInput,
      // Internal — used by the matching <PromptsLayer> renderer.
      _pendingConfirm: pendingConfirm,
      _setPendingConfirm: setPendingConfirm,
      _pendingInput: pendingInput,
      _setPendingInput: setPendingInput,
    }
  },
})

/**
 * Render layer for the active confirm / input modal. Mount once near the
 * top of the app shell (alongside Toast.Region). Multiple mounts will
 * each render the same modal, so keep it to one.
 */
export function PromptsLayer() {
  const prompts = usePrompts()
  return (
    <>
      <Show when={prompts._pendingConfirm()}>
        {(req) => {
          const left = () => clamp(req().anchor.x, 8, window.innerWidth - POPUP_MAX_W - 8)
          const top = () => clamp(req().anchor.y, 8, window.innerHeight - POPUP_MAX_H - 8)
          let overlayRef: HTMLDivElement | undefined
          const settle = (result: ConfirmResolution) => {
            const r = req()
            prompts._setPendingConfirm(undefined)
            r.resolve(result)
          }
          const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault()
              settle("cancel")
            } else if (e.key === "Enter") {
              e.preventDefault()
              settle("confirm")
            }
          }
          createEffect(() => {
            if (!prompts._pendingConfirm()) return
            window.addEventListener("keydown", onKey, true)
            onCleanup(() => window.removeEventListener("keydown", onKey, true))
          })
          return (
            <Portal>
              <div
                ref={(el) => {
                  overlayRef = el
                }}
                class="fixed inset-0 z-[200]"
                onClick={(e) => {
                  if (e.target === overlayRef) settle("cancel")
                }}
              >
                <div
                  class="fixed bg-slate-900 border-2 border-slate-600 rounded-md shadow-xl text-slate-100 p-3 text-12-regular"
                  style={{
                    "max-width": `${POPUP_MAX_W}px`,
                    "max-height": `${POPUP_MAX_H}px`,
                    left: `${left()}px`,
                    top: `${top()}px`,
                  }}
                  data-slot="prompts-confirm"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div class="text-14-medium mb-1">{req().title}</div>
                  <Show when={req().description}>
                    <div class="text-text-weak break-words whitespace-pre-line mb-3 max-h-32 overflow-auto">
                      {req().description}
                    </div>
                  </Show>
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                      onClick={() => settle("cancel")}
                    >
                      {req().cancelLabel ?? "取消"}
                    </button>
                    <Show when={req().applyAllLabel}>
                      <button
                        type="button"
                        class="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white"
                        onClick={() => settle("apply-all")}
                      >
                        {req().applyAllLabel}
                      </button>
                    </Show>
                    <button
                      type="button"
                      classList={{
                        "px-2 py-1 rounded text-white": true,
                        "bg-red-600 hover:bg-red-500": !!req().destructive,
                        "bg-blue-600 hover:bg-blue-500": !req().destructive,
                      }}
                      onClick={() => settle("confirm")}
                    >
                      {req().confirmLabel ?? "確定"}
                    </button>
                  </div>
                </div>
              </div>
            </Portal>
          )
        }}
      </Show>
      <Show when={prompts._pendingInput()}>
        {(req) => {
          const left = () => clamp(req().anchor.x, 8, window.innerWidth - POPUP_MAX_W - 8)
          const top = () => clamp(req().anchor.y, 8, window.innerHeight - POPUP_MAX_H - 8)
          const [value, setValue] = createSignal(req().initial ?? "")
          const validation = createMemo(() => req().validate?.(value()))
          let overlayRef: HTMLDivElement | undefined
          let inputRef: HTMLInputElement | undefined
          const settle = (next: string | undefined) => {
            const r = req()
            prompts._setPendingInput(undefined)
            r.resolve(next)
          }
          const submit = () => {
            if (validation()) return
            settle(value())
          }
          const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault()
              settle(undefined)
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }
          createEffect(() => {
            if (!prompts._pendingInput()) return
            window.addEventListener("keydown", onKey, true)
            queueMicrotask(() => {
              inputRef?.focus()
              inputRef?.select()
            })
            onCleanup(() => window.removeEventListener("keydown", onKey, true))
          })
          return (
            <Portal>
              <div
                ref={(el) => {
                  overlayRef = el
                }}
                class="fixed inset-0 z-[200]"
                onClick={(e) => {
                  if (e.target === overlayRef) settle(undefined)
                }}
              >
                <div
                  class="fixed bg-slate-900 border-2 border-slate-600 rounded-md shadow-xl text-slate-100 p-3 text-12-regular flex flex-col gap-2"
                  style={{
                    "max-width": `${POPUP_MAX_W}px`,
                    "max-height": `${POPUP_MAX_H}px`,
                    width: "min(380px, calc(100vw - 16px))",
                    left: `${left()}px`,
                    top: `${top()}px`,
                  }}
                  data-slot="prompts-input"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div class="text-14-medium">{req().title}</div>
                  <Show when={req().description}>
                    <div class="text-text-weak break-words whitespace-pre-line">{req().description}</div>
                  </Show>
                  <input
                    ref={(el) => {
                      inputRef = el
                    }}
                    type="text"
                    class="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 outline-none focus:border-blue-500"
                    value={value()}
                    placeholder={req().placeholder}
                    onInput={(e) => setValue(e.currentTarget.value)}
                  />
                  <Show when={validation()}>
                    <div class="text-red-400">{validation()}</div>
                  </Show>
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                      onClick={() => settle(undefined)}
                    >
                      {req().cancelLabel ?? "取消"}
                    </button>
                    <button
                      type="button"
                      class="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
                      disabled={!!validation() || value().length === 0}
                      onClick={submit}
                    >
                      {req().submitLabel ?? "確定"}
                    </button>
                  </div>
                </div>
              </div>
            </Portal>
          )
        }}
      </Show>
    </>
  )
}
