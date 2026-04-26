# Web Panel Channel

A lightweight, browser-based interface for Mercury. No frameworks, no database — just Node.js built-in HTTP and a clean HTML interface.

## Features

- **Status dashboard** — see provider, budget, channels at a glance
- **Chat interface** — send prompts and receive responses
- **Command access** — use `/help`, `/status`, `/budget` from the browser
- **Auth support** — optional token-based authentication for remote access
- **Zero dependencies** — built on Node.js `node:http`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PANEL_ENABLED` | `false` | Enable the web panel |
| `WEB_PANEL_HOST` | `127.0.0.1` | Bind host (localhost by default) |
| `WEB_PANEL_PORT` | `3977` | Port number |
| `WEB_PANEL_AUTH_TOKEN` | — | Bearer token for API authentication |
| `WEB_PANEL_ALLOW_REMOTE` | `false` | Allow remote access without auth |

## Quick Start

```
WEB_PANEL_ENABLED=true
```

Then start Mercury:
```
mercury start
```

Open http://127.0.0.1:3977 in your browser.

## Security Model

### Localhost (default)
By default, the panel binds to `127.0.0.1` — only accessible from the same machine. No auth required for local access.

### LAN/WAN Access
To make the panel accessible from other devices:

```
WEB_PANEL_HOST=0.0.0.0
WEB_PANEL_AUTH_TOKEN=your-secret-token-here
```

**Important safety rules:**
- If `WEB_PANEL_HOST=0.0.0.0` and no `WEB_PANEL_AUTH_TOKEN` is set, the panel **will not start** unless `WEB_PANEL_ALLOW_REMOTE=true`
- Setting `WEB_PANEL_ALLOW_REMOTE=true` without a token logs a strong warning
- Always use HTTPS in production (use a reverse proxy like nginx/Caddy)

### Auth Token
When `WEB_PANEL_AUTH_TOKEN` is set, all API requests must include:
```
Authorization: Bearer your-secret-token-here
```

The browser panel will prompt for the token on first load.

### What's Protected
- All tool execution goes through Mercury's existing permission system
- No direct shell, file read/write, or admin operations from the panel
- Rate limited to 60 requests/minute per IP
- Request body limited to 1MB

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web panel HTML |
| `GET` | `/api/status` | Safe status info |
| `POST` | `/api/chat` | Send a message |
| `GET` | `/api/help` | Help text |
| `POST` | `/api/command` | Execute slash command |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Panel doesn't start | Check `WEB_PANEL_ENABLED=true` and logs |
| Can't access remotely | Set `WEB_PANEL_HOST=0.0.0.0` and configure auth |
| Auth fails | Verify `WEB_PANEL_AUTH_TOKEN` matches in request header |
| Port in use | Change `WEB_PANEL_PORT` to a different value |
