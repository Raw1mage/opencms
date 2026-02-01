import { Buffer } from "node:buffer"

export namespace JWT {
    /**
     * Extract email from a JWT token
     * Supports multiple claim locations used by different OAuth providers
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

            // Try various common JWT claim locations for email
            return payload.email ||
                   payload["https://api.openai.com/profile"]?.email ||
                   payload["https://api.openai.com/auth"]?.user_email ||
                   payload.preferred_username ||  // Some OAuth providers use this
                   payload.unique_name ||         // Azure AD
                   payload.upn ||                 // Azure AD UPN
                   payload.sub_email ||           // Some providers
                   (payload.sub && payload.sub.includes("@") ? payload.sub : undefined)
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
