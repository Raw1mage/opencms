import { cmd } from "./cmd"
import { UI } from "../ui"
import { Account } from "../../account"
import { JWT } from "../../util/jwt"
import * as p from "@clack/prompts"
import readline from "readline"

export const AccountsCommand = cmd({
  command: "accounts [id]",
  aliases: ["account"],
  describe: "manage accounts",
  builder: (yargs) => {
    return yargs
      .positional("id", {
        describe: "account ID to switch to",
        type: "string",
      })
      .option("remove", {
        describe: "remove an account",
        type: "string",
      })
  },
  async handler(args) {
    // --- Smart Menu Core ---
    async function runInteractiveManager() {
      let cursorIndex = 0
      let exit = false
      let isPrompting = false
      let accountsList: any[] = []

      const isUUID = JWT.isUUID

      const getDisplayName = (info: any, family: string) => {
        return Account.getDisplayName(info.id || "", info, family)
      }

      const refreshData = async () => {
        const families = await Account.listAll()
        const order = ["opencode", "anthropic", "openai", "gemini-cli", "google API-KEY", "copilot", "others"]
        const sortedFamilies = Object.keys(families).sort((a, b) => {
          const idxA = order.indexOf(a)
          const idxB = order.indexOf(b)
          if (idxA === -1 && idxB === -1) return a.localeCompare(b)
          if (idxA === -1) return 1
          if (idxB === -1) return -1
          return idxA - idxB
        })

        const newList: any[] = []
        for (const familyName of sortedFamilies) {
          const familyData = families[familyName]
          const accountsArr = Object.entries(familyData.accounts)
          if (accountsArr.length === 0) continue

          newList.push({ isHeader: true, label: familyName.toUpperCase() })
          for (const [id, info] of accountsArr) {
            newList.push({
              provider: familyName,
              id,
              info: { ...info, id },
              isActive: familyData.activeAccount === id,
            })
          }
        }
        accountsList = newList

        if (accountsList.length > 0) {
          if (cursorIndex >= accountsList.length) cursorIndex = accountsList.length - 1
          while (cursorIndex < accountsList.length && accountsList[cursorIndex]?.isHeader) cursorIndex++
          if (cursorIndex >= accountsList.length) {
            cursorIndex = accountsList.length - 1
            while (cursorIndex >= 0 && accountsList[cursorIndex]?.isHeader) cursorIndex--
          }
        }
      }

      const draw = async () => {
        if (isPrompting || exit) return
        process.stdout.write("\x1Bc")
        process.stdout.write(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Account Manager${UI.Style.TEXT_NORMAL}\n`)
        process.stdout.write(
          `${UI.Style.TEXT_DIM}Move: ↑/↓ | Switch: Enter | Add: (a) | Delete: (x/del) | Exit: (q)${UI.Style.TEXT_NORMAL}\n`,
        )

        if (accountsList.length === 0) {
          process.stdout.write(`\n  ${UI.Style.TEXT_DIM}No accounts found.${UI.Style.TEXT_NORMAL}\n`)
        } else {
          accountsList.forEach((item, i) => {
            if (item.isHeader) {
              process.stdout.write(`\n${UI.Style.TEXT_INFO_BOLD}${item.label}${UI.Style.TEXT_NORMAL}\n`)
            } else {
              const isSelected = cursorIndex === i
              const prefix = isSelected ? `${UI.Style.TEXT_HIGHLIGHT}▶${UI.Style.TEXT_NORMAL} ` : "  "
              const status = item.isActive ? `${UI.Style.TEXT_SUCCESS} ● active${UI.Style.TEXT_NORMAL}` : ""
              const check = item.isActive ? "[x]" : "[ ]"
              const displayName = getDisplayName(item.info, item.provider)
              process.stdout.write(
                `${prefix}${check} ${displayName}${status} ${UI.Style.TEXT_DIM}(${item.id})${UI.Style.TEXT_NORMAL}\n`,
              )
            }
          })
        }
      }

      const handleKey = async (str: string, key: any) => {
        if (isPrompting) return

        if (key.name === "up") {
          let next = cursorIndex
          do {
            next = (next - 1 + accountsList.length) % accountsList.length
          } while (accountsList[next]?.isHeader && accountsList.length > 0)
          cursorIndex = next
        } else if (key.name === "down") {
          let next = cursorIndex
          do {
            next = (next + 1) % accountsList.length
          } while (accountsList[next]?.isHeader && accountsList.length > 0)
          cursorIndex = next
        } else if (key.name === "return" || key.name === "space") {
          const item = accountsList[cursorIndex]
          if (item && !item.isHeader) {
            await Account.setActive(item.provider, item.id)
            await refreshData()
          }
        } else if (key.name === "a") {
          isPrompting = true
          process.stdin.setRawMode(false)
          await handleAdd()
          process.stdin.setRawMode(true)
          process.stdin.resume()
          isPrompting = false
          await refreshData()
        } else if (key.name === "delete" || key.name === "x") {
          const item = accountsList[cursorIndex]
          if (item && !item.isHeader) {
            isPrompting = true
            process.stdin.setRawMode(false)
            try {
              const confirmed = await p.confirm({
                message: `Are you sure you want to remove account ${item.id}?`,
                initialValue: false,
              })
              if (confirmed === true && !p.isCancel(confirmed)) {
                await Account.remove(item.provider, item.id)
                await refreshData()
              }
            } catch (e) {}
            process.stdin.setRawMode(true)
            process.stdin.resume()
            isPrompting = false
          }
        } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
          exit = true
        }

        if (!exit) await draw()
      }

      const handleAdd = async () => {
        console.log("\x1Bc")
        p.intro(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Add New Account${UI.Style.TEXT_NORMAL}`)
        // Get all existing families + known families
        const allFamilies = await Account.listAll()
        const existingFamilies = Object.keys(allFamilies)
        const knownFamilies = [...Account.FAMILIES] as string[]
        const combinedFamilies = Array.from(new Set([...existingFamilies, ...knownFamilies])).sort()
        const family = await p.select({
          message: "Select Provider (or choose 'Other' for custom):",
          options: [
            ...combinedFamilies.map((f) => ({ value: f, label: f })),
            { value: "__other__", label: "Other (custom provider)" },
          ],
        })
        if (p.isCancel(family)) return
        let finalFamily = family as string
        if (family === "__other__") {
          const customFamily = await p.text({ message: "Enter provider ID (e.g., github-copilot, deepseek):" })
          if (p.isCancel(customFamily)) return
          finalFamily = customFamily as string
        }
        const nameIn = await p.text({ message: "Account Name (leave for auto):" })
        if (p.isCancel(nameIn)) return

        const keyVal = await p.password({
          message: "Enter Token/Key:",
          validate: (v) => (v && v.length > 0 ? undefined : "Required"),
        })
        if (p.isCancel(keyVal)) return

        const { Auth } = await import("../../auth")
        const extractedEmail = JWT.getEmail(keyVal as string)
        const finalName = nameIn && (nameIn as string).length > 0 ? (nameIn as string) : extractedEmail || "Default"

        await Auth.set(finalFamily, {
          type: "api",
          name: finalName,
          key: keyVal as string,
        })
        p.log.success(`Added.`)
        await new Promise((r) => setTimeout(r, 600))
      }

      await refreshData()
      readline.emitKeypressEvents(process.stdin)
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      await draw()

      return new Promise<void>((resolve) => {
        const listener = async (str: string, key: any) => {
          await handleKey(str, key)
          if (exit) {
            process.stdin.removeListener("keypress", listener)
            if (process.stdin.isTTY) process.stdin.setRawMode(false)
            resolve()
          }
        }
        process.stdin.on("keypress", listener)
      })
    }

    if (args.id) {
      const found = await Account.getById(args.id as string)
      if (found) await Account.setActive(found.provider, args.id as string)
      return
    }

    await runInteractiveManager()
    p.outro("Account Manager Closed.")
  },
})
