import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { KillSwitchService } from "./service"

describe("KillSwitchService", () => {
  // Pre-warm lazy imports so dynamic import("aws4fetch") doesn't race with mocked fetch
  beforeAll(async () => {
    await import("aws4fetch").catch(() => {})
    await import("ioredis").catch(() => {})
  })

  afterAll(() => {
    // restore env for other test suites
    delete process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
    delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
  })

  it("generates and verifies MFA", async () => {
    const requestID = await KillSwitchService.idempotentRequestID("tester", "reason", 1000)
    const code = await KillSwitchService.generateMfa(requestID, "tester")
    expect(code.length).toBe(6)
    const ok = await KillSwitchService.verifyMfa(requestID, "tester", code)
    expect(ok).toBe(true)
  })

  it("rejects stale seq", async () => {
    const requestID = await KillSwitchService.idempotentRequestID("tester", "seq-case", 1000)
    const sessionID = "ses_test_seq"
    const first = await KillSwitchService.publishControl({
      requestID,
      sessionID,
      seq: 100,
      action: "snapshot",
      initiator: "tester",
      timeoutMs: 2000,
    })
    expect(first.status).toBe("accepted")
    const second = await KillSwitchService.publishControl({
      requestID,
      sessionID,
      seq: 99,
      action: "snapshot",
      initiator: "tester",
      timeoutMs: 2000,
    })
    expect(second.status).toBe("rejected")
  })

  it("defaults control transport mode to local", () => {
    const prev = process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
    delete process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
    try {
      expect(KillSwitchService.resolveControlTransportMode()).toBe("local")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
      else process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT = prev
    }
  })

  it("fails fast when redis control transport is selected without redis url", async () => {
    const prevMode = process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
    const prevRedis = process.env.OPENCODE_REDIS_URL
    process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT = "redis"
    delete process.env.OPENCODE_REDIS_URL
    try {
      const requestID = await KillSwitchService.idempotentRequestID("tester", "redis-missing", 1000)
      await expect(
        KillSwitchService.publishControl({
          requestID,
          sessionID: "ses_test_redis",
          seq: 1,
          action: "snapshot",
          initiator: "tester",
          timeoutMs: 100,
        }),
      ).rejects.toThrow("OPENCODE_REDIS_URL")
    } finally {
      if (prevMode === undefined) delete process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
      else process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT = prevMode
      if (prevRedis === undefined) delete process.env.OPENCODE_REDIS_URL
      else process.env.OPENCODE_REDIS_URL = prevRedis
    }
  })

  it("resolves control transport mode to redis when env is set", () => {
    const prev = process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
    process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT = "redis"
    try {
      expect(KillSwitchService.resolveControlTransportMode()).toBe("redis")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT
      else process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT = prev
    }
  })

  it("resolves snapshot backend mode to minio when env is set", () => {
    const prev = process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
    process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = "minio"
    try {
      expect(KillSwitchService.resolveSnapshotBackendMode()).toBe("minio")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
      else process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = prev
    }
  })

  it("resolves snapshot backend mode to s3 alias", () => {
    const prev = process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
    process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = "s3"
    try {
      expect(KillSwitchService.resolveSnapshotBackendMode()).toBe("s3")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
      else process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = prev
    }
  })

  it("minio snapshot backend uploads via aws4fetch PUT", async () => {
    const prevBackend = process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
    const prevEndpoint = process.env.OPENCODE_MINIO_ENDPOINT
    const prevAK = process.env.OPENCODE_MINIO_ACCESS_KEY
    const prevSK = process.env.OPENCODE_MINIO_SECRET_KEY
    const prevBucket = process.env.OPENCODE_MINIO_BUCKET
    const prevRegion = process.env.OPENCODE_MINIO_REGION

    process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = "minio"
    process.env.OPENCODE_MINIO_ENDPOINT = "http://localhost:9000"
    process.env.OPENCODE_MINIO_ACCESS_KEY = "testkey"
    process.env.OPENCODE_MINIO_SECRET_KEY = "testsecret"
    process.env.OPENCODE_MINIO_BUCKET = "test-bucket"
    process.env.OPENCODE_MINIO_REGION = "us-east-1"

    const originalFetch = globalThis.fetch
    let capturedUrl = ""
    let capturedMethod = ""
    let capturedContentType = ""
    let capturedBody = ""
    globalThis.fetch = mock(async (input: any, init?: any) => {
      // aws4fetch passes a Request object (not separate url+init)
      if (input instanceof Request) {
        capturedUrl = input.url
        capturedMethod = input.method
        capturedContentType = input.headers.get("Content-Type") ?? ""
        capturedBody = await input.text()
      } else {
        capturedUrl = typeof input === "string" ? input : input.toString()
        capturedMethod = init?.method ?? "GET"
        capturedContentType = init?.headers?.["Content-Type"] ?? ""
        capturedBody = init?.body ?? ""
      }
      return new Response("OK", { status: 200 })
    }) as any

    try {
      const result = await KillSwitchService.createSnapshotPlaceholder({
        requestID: "ks_test_minio_upload",
        initiator: "tester",
        mode: "global",
        scope: "global",
        reason: "test upload",
      })
      expect(result).toContain("killswitch/snapshots/ks_test_minio_upload.json")
      expect(capturedMethod).toBe("PUT")
      expect(capturedContentType).toBe("application/json")
      const body = JSON.parse(capturedBody)
      expect(body.requestID).toBe("ks_test_minio_upload")
      expect(body.source).toBe("minio")
    } finally {
      globalThis.fetch = originalFetch
      if (prevBackend === undefined) delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
      else process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = prevBackend
      if (prevEndpoint === undefined) delete process.env.OPENCODE_MINIO_ENDPOINT
      else process.env.OPENCODE_MINIO_ENDPOINT = prevEndpoint
      if (prevAK === undefined) delete process.env.OPENCODE_MINIO_ACCESS_KEY
      else process.env.OPENCODE_MINIO_ACCESS_KEY = prevAK
      if (prevSK === undefined) delete process.env.OPENCODE_MINIO_SECRET_KEY
      else process.env.OPENCODE_MINIO_SECRET_KEY = prevSK
      if (prevBucket === undefined) delete process.env.OPENCODE_MINIO_BUCKET
      else process.env.OPENCODE_MINIO_BUCKET = prevBucket
      if (prevRegion === undefined) delete process.env.OPENCODE_MINIO_REGION
      else process.env.OPENCODE_MINIO_REGION = prevRegion
    }
  })

  it("minio snapshot backend returns null on PUT failure without blocking kill path", async () => {
    const prevBackend = process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
    const prevEndpoint = process.env.OPENCODE_MINIO_ENDPOINT
    const prevAK = process.env.OPENCODE_MINIO_ACCESS_KEY
    const prevSK = process.env.OPENCODE_MINIO_SECRET_KEY
    const prevBucket = process.env.OPENCODE_MINIO_BUCKET

    process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = "minio"
    process.env.OPENCODE_MINIO_ENDPOINT = "http://localhost:9000"
    process.env.OPENCODE_MINIO_ACCESS_KEY = "testkey"
    process.env.OPENCODE_MINIO_SECRET_KEY = "testsecret"
    process.env.OPENCODE_MINIO_BUCKET = "test-bucket"

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: any) => {
      // consume body if Request to avoid hanging
      if (input instanceof Request) await input.text().catch(() => {})
      return new Response("Service Unavailable", { status: 503 })
    }) as any

    try {
      const result = await KillSwitchService.createSnapshotPlaceholder({
        requestID: "ks_test_minio_fail",
        initiator: "tester",
        mode: "global",
        scope: "global",
        reason: "test failure resilience",
      })
      // Should return null (not throw) — kill path must not be blocked by snapshot failure
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      if (prevBackend === undefined) delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
      else process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = prevBackend
      if (prevEndpoint === undefined) delete process.env.OPENCODE_MINIO_ENDPOINT
      else process.env.OPENCODE_MINIO_ENDPOINT = prevEndpoint
      if (prevAK === undefined) delete process.env.OPENCODE_MINIO_ACCESS_KEY
      else process.env.OPENCODE_MINIO_ACCESS_KEY = prevAK
      if (prevSK === undefined) delete process.env.OPENCODE_MINIO_SECRET_KEY
      else process.env.OPENCODE_MINIO_SECRET_KEY = prevSK
      if (prevBucket === undefined) delete process.env.OPENCODE_MINIO_BUCKET
      else process.env.OPENCODE_MINIO_BUCKET = prevBucket
    }
  })

  it("fails fast when minio snapshot backend is selected without required env", async () => {
    const prevBackend = process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
    const prevEndpoint = process.env.OPENCODE_MINIO_ENDPOINT
    const prevAK = process.env.OPENCODE_MINIO_ACCESS_KEY
    const prevSK = process.env.OPENCODE_MINIO_SECRET_KEY
    const prevBucket = process.env.OPENCODE_MINIO_BUCKET
    process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = "minio"
    delete process.env.OPENCODE_MINIO_ENDPOINT
    delete process.env.OPENCODE_MINIO_ACCESS_KEY
    delete process.env.OPENCODE_MINIO_SECRET_KEY
    delete process.env.OPENCODE_MINIO_BUCKET
    try {
      await expect(
        KillSwitchService.createSnapshotPlaceholder({
          requestID: "ks_req_minio_missing",
          initiator: "tester",
          mode: "global",
          scope: "global",
          reason: "test",
        }),
      ).rejects.toThrow("snapshot backend 'minio' selected")
    } finally {
      if (prevBackend === undefined) delete process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND
      else process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND = prevBackend
      if (prevEndpoint === undefined) delete process.env.OPENCODE_MINIO_ENDPOINT
      else process.env.OPENCODE_MINIO_ENDPOINT = prevEndpoint
      if (prevAK === undefined) delete process.env.OPENCODE_MINIO_ACCESS_KEY
      else process.env.OPENCODE_MINIO_ACCESS_KEY = prevAK
      if (prevSK === undefined) delete process.env.OPENCODE_MINIO_SECRET_KEY
      else process.env.OPENCODE_MINIO_SECRET_KEY = prevSK
      if (prevBucket === undefined) delete process.env.OPENCODE_MINIO_BUCKET
      else process.env.OPENCODE_MINIO_BUCKET = prevBucket
    }
  })
})
