# Web Registry

Publish, remove, or list public web routes on the OpenCode gateway.

## Use when

- User wants to make a webapp accessible to anonymous users (e.g., "publish cecelearn to /cecelearn")
- User wants to check which routes are currently registered
- User wants to remove a published route

## How it works

The C Gateway listens on a control socket at `/run/opencode-gateway/ctl.sock`.
Routes registered here bypass JWT/PAM authentication — they are publicly accessible.

## Commands

### Publish a route

```bash
./webctl.sh publish-route <prefix> <host> <port>
```

Example:
```bash
./webctl.sh publish-route /cecelearn 127.0.0.1 5173
```

- `prefix`: URL path prefix (e.g., `/cecelearn`). Must start with `/`.
- `host`: Backend IP address. Usually `127.0.0.1` for local webapps.
- `port`: Backend port number.

The route takes effect immediately. If the prefix is already taken, the command fails.

### List routes

```bash
./webctl.sh list-routes
```

Shows all currently registered public routes with their prefix, target, and owner UID.

### Remove a route

```bash
./webctl.sh remove-route <prefix>
```

Example:
```bash
./webctl.sh remove-route /cecelearn
```

## Important notes

- All routes in the registry are **public** (no authentication required).
- The webapp receives the full request path including the prefix (e.g., `/cecelearn/index.html`). Configure your webapp's base path accordingly.
- If the backend is down, the gateway silently redirects users to the homepage.
- Routes persist across gateway restarts via `/etc/opencode/web_routes.conf`.
- First-come-first-served: duplicate prefixes are rejected.
