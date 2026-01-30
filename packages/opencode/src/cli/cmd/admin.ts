
import { cmd } from "./cmd"
import { tui } from "./tui/app"

export const AdminCommand = cmd({
    command: "admin",
    aliases: ["adm"],
    describe: "Launch the Admin Control Panel",
    builder: (yargs) => {
        return yargs
            .option("url", {
                describe: "LLM API connection URL",
                type: "string",
                default: "http://127.0.0.1:11434",
            })
    },
    async handler(args) {
        await tui({
            url: args.url,
            args: {
                admin: true,
            }
        })
    },
})
