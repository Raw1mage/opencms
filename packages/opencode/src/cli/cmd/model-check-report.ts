import { EOL } from "os"
import { ProviderHealth } from "../../provider/health"
import { JWT } from "@/util/jwt"

export function renderModelCheckReport(report: ProviderHealth.HealthReport): string {
    const lines: string[] = []

    lines.push("# OpenCode Model Health Report")
    lines.push(`**Date:** ${new Date(report.timestamp).toLocaleString()}`)
    lines.push(`**Total Models Configured:** ${report.totalModels}`)
    lines.push(`**Accounts Authenticated:** ${report.summary.accountsAuthenticated}/${report.summary.accountsTotal}`)
    lines.push("")

    if (report.accounts.length > 0) {
        lines.push("### 🔐 Account Authentication Status")
        lines.push("")

        for (const account of report.accounts) {
            const statusText = account.authenticated ? "✅ Active" : "❌ No Working Models"
            const modelsText = `${account.modelsWorking}/${account.modelsTotal}`

            const typeDisplay = formatAuthType(account.authType)
            let displayName = account.accountName || account.accountEmail
            if (!displayName || JWT.isUUID(displayName)) {
                displayName = `${account.providerFamily.charAt(0).toUpperCase() + account.providerFamily.slice(1)} ${typeDisplay}`
            }

            lines.push(`#### Account: \`${displayName}\``)
            lines.push(`- **Provider**: ${account.providerFamily}`)
            lines.push(`- **Type**: ${typeDisplay}`)

            if (account.authType !== "api") {
                const identifier = account.accountEmail || account.accountName || "-"
                if (identifier !== "-" && !JWT.isUUID(identifier) && identifier !== displayName) {
                    lines.push(`- **Email/Project**: ${identifier}`)
                }
            }

            lines.push(`- **Status**: ${statusText}`)
            lines.push(`- **Models**: ${modelsText}`)
            lines.push("")

            if (account.models && account.models.length > 0 && account.modelsWorking > 0) {
                lines.push("**Models for this account:**")
                const colModel = "Model".padEnd(45)
                const colStatus = "Status".padEnd(20)
                const colResp = "Ping"
                lines.push(`| ${colModel} | ${colStatus} | ${colResp} |`)

                for (const model of account.models) {
                    if (model.error?.toLowerCase().includes("not supported")) continue

                    const statusIcon = getStatusIcon(model.status)
                    const responseTime = model.responseTime !== undefined && model.responseTime !== null
                        ? `${model.responseTime}ms`
                        : "-"

                    let statusTextModel = model.status
                    if (model.error && model.status !== "RATE_LIMITED") {
                        statusTextModel = `${model.status}: ${model.error.substring(0, 40)}`
                    }

                    const statusDisplay = `${statusIcon} ${statusTextModel}`
                    const statusPadding = 20 - (statusIcon.length > 0 ? 1 : 0)
                    lines.push(`| ${model.name.padEnd(45)} | ${statusDisplay.padEnd(statusPadding)} | ${responseTime.padEnd(4)} |`)
                }
                lines.push("")
            }
        }
    }

    lines.push("### 📊 Model Status Summary")
    lines.push("| Status | Count |")
    lines.push("| :--- | :--- |")
    lines.push(`| ✅ Available | ${report.summary.available} |`)
    lines.push(`| ⏳ Rate Limited | ${report.summary.rateLimited} |`)
    lines.push(`| 💰 Quota Exceeded | ${report.summary.quotaExceeded} |`)
    lines.push(`| 🔑 Auth Error | ${report.summary.authError} |`)
    lines.push(`| 🔐 No Auth Configured | ${report.summary.noAuth} |`)
    lines.push(`| ❌ Other/Error | ${report.summary.other} |`)
    lines.push("")
    lines.push("---")
    lines.push("💡 *Tip: Models showing green status are ready for use. Use `opencode allocate-models` to update your routing based on this report.*")

    return lines.join(EOL)
}

function getStatusIcon(status: ProviderHealth.ModelStatus): string {
    switch (status) {
        case "AVAILABLE":
            return "✅"
        case "RATE_LIMITED":
            return "⏳"
        case "QUOTA_EXCEEDED":
            return "💰"
        case "AUTH_ERROR":
            return "🔑"
        case "NO_AUTH":
            return "🔐"
        case "TIMEOUT":
            return "⏱️"
        case "NETWORK_ERROR":
            return "🌐"
        case "MODEL_NOT_FOUND":
            return "❓"
        case "UNKNOWN_ERROR":
            return "❌"
        default:
            return ""
    }
}

function formatAuthType(authType: string): string {
    switch (authType) {
        case "api":
            return "API Key"
        case "oauth":
        case "antigravity":
            return "Subscription"
        case "wellknown":
            return "Well-Known"
        case "none":
            return "Not Configured"
        default:
            return authType
    }
}
