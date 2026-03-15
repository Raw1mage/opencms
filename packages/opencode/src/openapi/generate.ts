import { Server } from "../server/server"

const specs = await Server.openapi()
const json = JSON.stringify(specs, null, 2)
const outputPath = process.argv[2]

if (outputPath) {
  await Bun.write(outputPath, json)
  process.exit(0)
} else {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(json, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
