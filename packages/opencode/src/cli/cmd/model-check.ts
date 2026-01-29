import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { ProviderHealth } from "../../provider/health"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { renderModelCheckReport } from "./model-check-report"

export const ModelCheckCommand = cmd({
    command: "model-check [provider]",
    describe: "perceive availability and account status of configured models",
    builder: (yargs: Argv) => {
        return yargs
            .positional("provider", {
                describe: "provider ID to filter models by",
                type: "string",
                array: false,
            })
            .option("timeout", {
                describe: "timeout for each model check in milliseconds",
                type: "number",
                default: 10000,
            })
            .option("parallel", {
                describe: "check models in parallel (faster but may trigger rate limits)",
                type: "boolean",
                default: false,
            })
            .option("json", {
                describe: "output results in JSON format",
                type: "boolean",
                default: false,
            })
            .option("full", {
                describe: "run full health check with test requests (slower)",
                type: "boolean",
            })
    },
    handler: async (args) => {
        await Instance.provide({
            directory: process.cwd(),
            async fn() {
                // Default to 'perception' for model-check
                const mode = args.full ? "full" : "perception"

                // Build options
                const options: ProviderHealth.CheckAllOptions = {
                    timeout: args.timeout,
                    parallel: args.parallel,
                    mode: mode as any,
                }

                // Add provider filter if specified
                if (args.provider) {
                    options.providers = [args.provider]
                }

                // Show progress message
                if (!args.json) {
                    UI.println(
                        UI.Style.TEXT_INFO +
                        "🔍 Checking model availability" +
                        (args.parallel ? " (parallel mode)" : " (sequential mode)") +
                        "..." +
                        UI.Style.TEXT_NORMAL,
                    )
                    UI.empty()
                }

                // Suppress console errors during health check to avoid noise
                const originalConsoleError = console.error
                let report: ProviderHealth.HealthReport
                try {
                    console.error = () => { } // Silence errors during health check
                    report = await ProviderHealth.checkAll(options)
                } finally {
                    console.error = originalConsoleError
                }

                // Output results
                if (args.json) {
                    // JSON output
                    console.log(JSON.stringify(report, null, 2))
                } else {
                    // Text output
                    UI.println(renderModelCheckReport(report))
                }
            },
        })
    },
})
