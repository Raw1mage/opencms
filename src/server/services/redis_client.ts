import Redis from "ioredis"

const url = process.env.OPENCODE_REDIS_URL || "redis://127.0.0.1:6379"
const client = new Redis(url)

client.on("error", (e) => {
  console.error("[redis] error", e)
})

export default client

export function redisPublish(channel: string, message: string) {
  return client.publish(channel, message)
}

export function redisSubscribe(channel: string, handler: (msg: string) => void) {
  const sub = new Redis(url)
  sub.subscribe(channel, (err) => {
    if (err) console.error("[redis] subscribe error", err)
  })
  sub.on("message", (_ch, message) => handler(message))
  return sub
}
