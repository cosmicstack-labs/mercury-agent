# Discord Channel

Use Mercury from Discord via slash commands. Secure, allowlisted, and minimal-intent.

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "Mercury Agent")
3. Go to **Bot** tab → click **Add Bot**
4. Copy the **Bot Token** (this is `DISCORD_BOT_TOKEN`)
5. Go to **OAuth2** tab → copy **Client ID** (this is `DISCORD_CLIENT_ID`)

### 2. Invite the Bot to Your Server

Use this URL (replace `CLIENT_ID`):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=2147483648&scope=bot%20applications.commands
```

This grants minimal permissions: only slash command access.

### 3. Configure Mercury

Add to your `.env` or `~/.mercury/.env`:

```
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
DISCORD_GUILD_ID=your-server-id
DISCORD_ALLOWED_USER_IDS=user-id-1,user-id-2
DISCORD_ADMIN_USER_IDS=admin-user-id
```

### 4. Start Mercury

```
mercury start
```

The bot will register slash commands and come online.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_ENABLED` | `false` | Enable Discord integration |
| `DISCORD_BOT_TOKEN` | — | Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | — | Application Client ID |
| `DISCORD_GUILD_ID` | — | Server (guild) ID for command registration |
| `DISCORD_ALLOWED_USER_IDS` | — | Comma-separated user IDs allowed to use bot |
| `DISCORD_ALLOWED_CHANNEL_IDS` | — | Comma-separated channel IDs |
| `DISCORD_ADMIN_USER_IDS` | — | Comma-separated admin user IDs |
| `DISCORD_USE_GLOBAL_COMMANDS` | `false` | Register commands globally (slower propagation) |
| `DISCORD_ALLOW_DMS` | `false` | Allow DM interactions |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/mercury ask <prompt>` | Send a prompt to Mercury |
| `/mercury status` | Show agent status (safe info only) |
| `/mercury help` | Show available commands |
| `/mercury budget` | Show token budget status |
| `/mercury memory` | Show memory overview |
| `/mercury permissions` | Show permission mode |

## Access Control

### User Allowlist
- If `DISCORD_ALLOWED_USER_IDS` is set, only listed users can interact with the bot
- If empty, only `DISCORD_ADMIN_USER_IDS` can use it
- Admins always have access

### Channel Restrictions
- If `DISCORD_ALLOWED_CHANNEL_IDS` is set, bot only responds in those channels
- If empty, bot responds in all channels it can see

### DMs
- Disabled by default for security
- Enable with `DISCORD_ALLOW_DMS=true`

## Security
- **No privileged intents** — doesn't require Message Content intent
- **Slash commands only** — no raw message parsing
- **Allowlist enforced** — unauthorized users are silently ignored
- **No secrets exposed** — status/info commands only show safe data
- **Permission system** — all tool execution goes through Mercury's permission flow

## Finding Your Discord IDs

Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then:
- **User ID**: Right-click a user → Copy ID
- **Channel ID**: Right-click a channel → Copy ID
- **Guild ID**: Right-click server name → Copy ID

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot doesn't come online | Check `DISCORD_BOT_TOKEN` is correct |
| Commands not appearing | Check `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID`; global commands take up to 1 hour |
| "Interaction failed" | Check Mercury logs for errors |
| Bot ignores messages | Verify user ID is in `DISCORD_ALLOWED_USER_IDS` or is an admin |
| Can't use in DMs | Set `DISCORD_ALLOW_DMS=true` |
