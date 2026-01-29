import { Buffer } from "node:buffer"

export namespace JWT {
    /**
     * Extract email from a JWT token
     */
    export function getEmail(token: string): string | undefined {
        try {
            const parts = token.split(".")
            if (parts.length !== 3) return undefined
            let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
            const pad = base64.length % 4
            if (pad) {
                base64 += "=".repeat(4 - pad)
            }
            const payload = JSON.parse(Buffer.from(base64, "base64").toString())
            return payload.email || payload["https://api.openai.com/profile"]?.email
        } catch {
            return undefined
        }
    }

    /**
     * Check if a string is a UUID
     */
    export function isUUID(str: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
    }
}
