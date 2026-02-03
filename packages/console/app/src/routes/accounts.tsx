import { createResource, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"

// We use the same API provided by the hono server
const fetchAccounts = async () => {
  const res = await fetch("/api/account/")
  if (!res.ok) throw new Error("Failed to fetch accounts")
  return res.json()
}

const switchAccount = async (family: string, accountId: string) => {
  const res = await fetch(`/api/account/${family}/active`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  })
  if (res.ok) {
    window.location.reload()
  } else {
    alert("Failed to switch account")
  }
}

export default function AccountsPage() {
  const [data, { mutate, refetch }] = createResource(fetchAccounts)

  return (
    <main class="min-h-screen bg-gray-50/50 p-8">
      <Title>Accounts - opencode</Title>

      <div class="max-w-3xl mx-auto">
        <div class="flex items-center justify-between mb-8">
          <div>
            <h1 class="text-3xl font-bold tracking-tight text-gray-900">Accounts</h1>
            <p class="mt-2 text-sm text-gray-600">Manage your connected provider accounts and switch active state.</p>
          </div>
          <button onClick={() => refetch()} class="text-sm text-blue-600 hover:text-blue-500 font-medium">
            Refresh List
          </button>
        </div>

        <Show
          when={data()}
          fallback={
            <div class="flex items-center justify-center p-12">
              <div class="animate-pulse text-gray-400">Loading accounts...</div>
            </div>
          }
        >
          <div class="space-y-10">
            <For each={Object.entries(data().families)}>
              {([family, familyData]: [string, any]) => (
                <section>
                  <div class="flex items-center gap-2 mb-4">
                    <h2 class="text-lg font-semibold capitalize text-gray-800">{family}</h2>
                    <span class="h-px flex-1 bg-gray-200"></span>
                  </div>

                  <div class="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                    <div class="divide-y divide-gray-100">
                      <For each={Object.entries(familyData.accounts)}>
                        {([id, info]: [string, any]) => {
                          const isActive = familyData.activeAccount === id
                          return (
                            <div class="p-5 flex items-center justify-between hover:bg-gray-50/50 transition-colors">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-3">
                                  <p class="text-sm font-semibold text-gray-900 truncate">{info.name}</p>
                                  <Show when={isActive}>
                                    <span class="inline-flex items-center rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
                                      Active
                                    </span>
                                  </Show>
                                </div>
                                <p class="mt-1 text-xs text-gray-500 font-mono truncate">{id}</p>
                              </div>

                              <div class="ml-4 flex-shrink-0">
                                <button
                                  onClick={() => switchAccount(family, id)}
                                  disabled={isActive}
                                  class={`inline-flex items-center rounded-md px-3 py-2 text-sm font-semibold shadow-sm ring-1 ring-inset transition-all ${
                                    isActive
                                      ? "bg-gray-50 text-gray-400 ring-gray-200 cursor-not-allowed"
                                      : "bg-white text-gray-900 ring-gray-300 hover:bg-gray-50 active:scale-95"
                                  }`}
                                >
                                  {isActive ? "Connected" : "Switch To"}
                                </button>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>

        <Show when={data() && Object.keys(data().families).length === 0}>
          <div class="text-center py-20 bg-white border-2 border-dashed border-gray-200 rounded-2xl">
            <p class="text-gray-500">No accounts configured yet.</p>
          </div>
        </Show>
      </div>
    </main>
  )
}
