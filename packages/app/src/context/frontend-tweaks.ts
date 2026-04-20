import { createSignal } from "solid-js"

/**
 * Frontend-session-lazyload runtime knobs served by the daemon at
 * GET /config/tweaks/frontend. Populated once at app bootstrap via
 * ensureFrontendTweaksLoaded(); consumers read the current values via
 * frontendTweaks() accessor.
 *
 * Contract (AGENTS.md §1, errors.md LAZYLOAD_FLAG_UNAVAILABLE):
 *   - Fetch failure => keep defaults with flag=0 (safe mode) + warn once.
 *   - Values-out-of-range => daemon-side already clamps/falls back; we trust
 *     what the endpoint returns.
 *
 * See specs/frontend-session-lazyload/data-schema.json#TweaksConfigKeys,
 * design.md DD-3 / DD-7 / DD-8, invariants.md INV-2 / INV-7.
 */
export interface FrontendTweaks {
  frontend_session_lazyload: 0 | 1
  part_inline_cap_kb: number
  tail_window_kb: number
  fold_preview_lines: number
  initial_page_size_small: "all" | number
  initial_page_size_medium: number
  initial_page_size_large: number
  session_size_threshold_kb: number
  session_size_threshold_parts: number
}

export const FRONTEND_TWEAKS_DEFAULTS: FrontendTweaks = {
  frontend_session_lazyload: 0,
  part_inline_cap_kb: 64,
  tail_window_kb: 64,
  fold_preview_lines: 20,
  initial_page_size_small: "all",
  initial_page_size_medium: 100,
  initial_page_size_large: 50,
  session_size_threshold_kb: 512,
  session_size_threshold_parts: 80,
}

const [tweaks, setTweaks] = createSignal<FrontendTweaks>(FRONTEND_TWEAKS_DEFAULTS)
const [loaded, setLoaded] = createSignal(false)
let _loading: Promise<void> | undefined
let _warnedUnavailable = false

export function frontendTweaks(): FrontendTweaks {
  return tweaks()
}

export function frontendTweaksLoaded(): boolean {
  return loaded()
}

export function resetFrontendTweaksForTesting(): void {
  setTweaks(FRONTEND_TWEAKS_DEFAULTS)
  setLoaded(false)
  _loading = undefined
  _warnedUnavailable = false
}

/**
 * Set specific tweak values for unit tests. Merges with current tweaks so
 * callers can override one field without restating all nine.
 */
export function setFrontendTweaksForTesting(overrides: Partial<FrontendTweaks>): void {
  setTweaks({ ...tweaks(), ...overrides })
  setLoaded(true)
}

export async function ensureFrontendTweaksLoaded(baseUrl: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (loaded()) return
  if (_loading) return _loading
  _loading = (async () => {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/config/tweaks/frontend`)
      if (!response.ok) {
        if (!_warnedUnavailable) {
          // eslint-disable-next-line no-console
          console.warn("[lazyload] /config/tweaks/frontend returned non-OK, using safe defaults", {
            status: response.status,
          })
          _warnedUnavailable = true
        }
        setTweaks(FRONTEND_TWEAKS_DEFAULTS)
        setLoaded(true)
        return
      }
      const body = (await response.json()) as Partial<FrontendTweaks>
      // Trust daemon-side validation; merge shallowly with defaults so missing
      // keys fall back loud at the type layer (not silently wrong).
      const merged: FrontendTweaks = { ...FRONTEND_TWEAKS_DEFAULTS, ...body } as FrontendTweaks
      setTweaks(merged)
      setLoaded(true)
    } catch (error) {
      if (!_warnedUnavailable) {
        // eslint-disable-next-line no-console
        console.warn("[lazyload] failed to fetch /config/tweaks/frontend, using safe defaults", {
          error: error instanceof Error ? error.message : String(error),
        })
        _warnedUnavailable = true
      }
      setTweaks(FRONTEND_TWEAKS_DEFAULTS)
      setLoaded(true)
    }
  })()
  return _loading
}
