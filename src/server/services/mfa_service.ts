import redisClient from "./redis_client"

const MFA_PREFIX = "mfa:"

// Generate an MFA code for a given user (initiator). Returns the code (in real prod send out-of-band).
export async function generateMfaCode(initiator: string, ttlSeconds = 300) {
  const code = Math.floor(100000 + Math.random() * 900000).toString()
  const key = `${MFA_PREFIX}${initiator}`
  await redisClient.set(key, code)
  await redisClient.expire(key, ttlSeconds)
  return code
}

export async function verifyMfaCode(initiator: string, code: string) {
  const key = `${MFA_PREFIX}${initiator}`
  const v = await redisClient.get(key)
  if (!v) return false
  if (v !== code) return false
  // consume the code
  await redisClient.del(key)
  return true
}
