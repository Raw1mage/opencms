# Skill: Webapp Registry

## Context
When a developer builds a web application within Opencode, they may want to expose a specific URL path (e.g., `/cecelearn`) to the public or bind it to a local service (like a Docker container running on port 5173 or a UDS HTTP service like docxmcp).
Opencode handles this through a C Gateway that routes incoming HTTP requests transparently based on a global configuration file located at `/etc/opencode/web_routes.conf`.

## Usage
If a user requests you to "publish my project to /example" or "expose the webapp", follow this 3-step workflow:

### Step 1: User Developer Setup
The developer prepares their project, which must ultimately listen on a specific TCP port (e.g., frontend on 5173, backend API on 3014) or expose an HTTP service over a Unix domain socket.
They decide the public URL path (`/example`).

### Step 2: Global Registry Registration
Use the `webctl.sh` tool to publish the route. The tool checks for conflicts and writes the configuration into the authoritative gateway routing file (`/etc/opencode/web_routes.conf`).
TCP route example:

```bash
curl -X POST /api/v2/web-route/publish \
  -d '{"prefix":"/example","upstreamType":"tcp","host":"127.0.0.1","port":5173,"auth":0}'
```

UDS route example:

```bash
curl -X POST /api/v2/web-route/publish \
  -d '{"prefix":"/docxmcp","upstreamType":"uds","socketPath":"/run/user/1000/opencode/sockets/docxmcp/docxmcp.sock","auth":1}'
```

Routes may be public (`auth:0`) or protected by Opencode PAM/JWT (`auth:1`).

### Step 3: Gateway Restart / Reload
Once the routes are published to `/etc/opencode/web_routes.conf`, the Gateway must reload this configuration to make the entry active.
```bash
./webctl.sh reload-routes
```
*(This sends a SIGHUP to the `opencode-gateway` process, clearing its memory and parsing the updated `web_routes.conf`.)*

## Constraints
- **Order matters**: Always publish the longer, more specific paths first if testing manually, though the Gateway should handle longest-prefix matching.
- **Conflict Handling**: `publish-route` will fail fast if a different target is already registered for that path.
- **Access**: Public routes are anonymously accessible from the internet. Use protected routes (`auth:1`) for private services and MCP/file APIs.
- **UDS Upstreams**: Do not add a TCP bridge for UDS services. Publish them as `upstreamType: "uds"` so the gateway preserves the internal socket boundary.
