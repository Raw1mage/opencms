import Minio from "minio"

export async function createSnapshot(payload: any) {
  // If MinIO env configured, attempt upload. Otherwise fallback to local file
  const endpoint = process.env.OPENCODE_MINIO_ENDPOINT
  if (endpoint) {
    const client = new Minio.Client({
      endPoint: endpoint,
      accessKey: process.env.OPENCODE_MINIO_ACCESS_KEY || "",
      secretKey: process.env.OPENCODE_MINIO_SECRET_KEY || "",
      port: Number(process.env.OPENCODE_MINIO_PORT || 9000),
      useSSL: process.env.OPENCODE_MINIO_SSL === "true",
    })
    const bucket = process.env.OPENCODE_MINIO_BUCKET || "opencode-snapshots"
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const body = Buffer.from(JSON.stringify(payload, null, 2))
    try {
      // ensure bucket exists (best-effort)
      const exists = await client.bucketExists(bucket).catch(() => false)
      if (!exists) await client.makeBucket(bucket)
      await client.putObject(bucket, name, body)
      // construct object URL (assume standard MinIO + proxy)
      return `s3://${bucket}/${name}`
    } catch (e) {
      console.error("[snapshot] minio upload failed", e)
      // fallback to local file
    }
  }
  const dir = "/tmp/opencode-snapshots"
  const fs = require("fs")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const path = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  fs.writeFileSync(path, JSON.stringify(payload, null, 2))
  return `file://${path}`
}
