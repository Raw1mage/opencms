/**
 * /specs/docxmcp-http-transport DD-13: bind-mount lint at McpAppStore.addApp.
 * Resource-level test of the predicate (no integration with file IO).
 */
import { describe, expect, test } from "bun:test"
import { McpAppStore } from "../../src/mcp/app-store"

const findViolations = McpAppStore.findBindMountViolations

describe("McpAppStore.findBindMountViolations", () => {
  test("non-docker command returns no violations", () => {
    expect(findViolations(["python", "/app/main.py"])).toEqual([])
    expect(findViolations(["/usr/local/bin/some-binary"])).toEqual([])
  })

  test("docker run with no -v flags returns no violations", () => {
    expect(
      findViolations(["docker", "run", "-i", "--rm", "alpine"]),
    ).toEqual([])
  })

  test("docker -v with arbitrary host data dir is rejected", () => {
    const v = findViolations([
      "docker", "run", "-v", "/home/x/data:/container",
      "-v", "/tmp/things:/extra:ro",
      "image",
    ])
    expect(v.length).toBe(2)
    expect(v[0]).toContain("/home/x/data:/container")
    expect(v[1]).toContain("/tmp/things:/extra")
  })

  test("--mount type=bind with arbitrary host path is rejected", () => {
    const v = findViolations([
      "docker", "run",
      "--mount", "type=bind,src=/home/x/data,dst=/container",
      "image",
    ])
    expect(v.length).toBe(1)
    expect(v[0]).toContain("type=bind")
  })

  test("IPC bind mount under /run/user/<uid>/opencode/sockets/<app>/ is allowed", () => {
    const v = findViolations([
      "docker", "run",
      "-v", "/run/user/1000/opencode/sockets/docxmcp:/run/docxmcp",
      "image",
    ])
    expect(v).toEqual([])
  })

  test("IPC --mount type=bind under the IPC dir convention is allowed", () => {
    const v = findViolations([
      "docker", "run",
      "--mount", "type=bind,src=/run/user/1000/opencode/sockets/myapp,dst=/run/myapp",
      "image",
    ])
    expect(v).toEqual([])
  })

  test("named volume (-v vol:/dst) is not a bind mount and passes through", () => {
    const v = findViolations([
      "docker", "run",
      "-v", "docxmcp-cache:/var/cache/docxmcp",
      "image",
    ])
    expect(v).toEqual([])
  })

  test("mixed: IPC ok + arbitrary data bad → only the data one in violations", () => {
    const v = findViolations([
      "docker", "run",
      "-v", "/run/user/1000/opencode/sockets/docxmcp:/run/docxmcp",
      "-v", "/home/data:/x",
      "image",
    ])
    expect(v.length).toBe(1)
    expect(v[0]).toContain("/home/data:/x")
  })

  test("=form --mount=type=bind also detected", () => {
    const v = findViolations([
      "docker", "run",
      "--mount=type=bind,src=/etc/secret,dst=/secret",
      "image",
    ])
    expect(v.length).toBe(1)
    expect(v[0]).toContain("type=bind")
  })

  test("container path outside /run/<app> is rejected even if host is IPC dir", () => {
    const v = findViolations([
      "docker", "run",
      "-v", "/run/user/1000/opencode/sockets/docxmcp:/etc/socket",
      "image",
    ])
    expect(v.length).toBe(1)
  })

  test("host path outside /run/user/<uid>/opencode/sockets is rejected", () => {
    const v = findViolations([
      "docker", "run",
      "-v", "/run/user/1000/something-else:/run/docxmcp",
      "image",
    ])
    expect(v.length).toBe(1)
  })
})
