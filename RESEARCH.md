# Mercury — Research

> Experiments, findings, and notes.

## Token Optimization

### 2026-04-19: Baseline Token Costs

| Component | Est. Tokens |
|---|---|
| soul.md | ~200 |
| persona.md | ~150 |
| taste.md | ~100 |
| heartbeat.md | ~100 |
| Short-term (10 msgs) | ~500 |
| Long-term facts (3) | ~100 |
| User message | ~100 |
| Agent response | ~500 |
| **Total per request** | **~1,200-1,500** |

### Strategies
1. Only inject soul+persona by default (~350 tokens)
2. Taste and heartbeat loaded selectively
3. Compress old conversation into 50-token summaries
4. Keyword matching for long-term retrieval (not full scan)
5. Daily token budget with hard cap

## Telegram Streaming

- Telegram supports streaming via `sendMessageDraft` API (Bot API 9.5+)
- grammY's `@grammyjs/stream` plugin handles this natively
- Streaming only works in private chats
- Must use `@grammyjs/auto-retry` alongside stream plugin (flood limits)
- Markdown partial chunks break Telegram's parser — stream plain text, edit with formatting after

## LLM Provider Notes

- DeepSeek uses OpenAI-compatible API — same adapter works
- Vercel AI SDK `createOpenAI` accepts custom `baseURL` — works for any OpenAI-compatible endpoint
- Token counting: `js-tiktoken` for OpenAI tokenization. Anthropic uses different tokenizer — approximate.

## Mercury Network Bot — Auto-Detection & P2P Communication

> Research date: 2026-04-25

### Problem Statement

Mercury instances (Node.js/TypeScript processes running on individual users' machines) need to discover and connect to a **Mercury Network Bot** — a shared Telegram bot that acts as a coordination/introduction service. The Network Bot facilitates introductions between Mercury instances so they can communicate. The key constraint: **zero manual configuration** for the Network Bot connection.

### Approach 1: Hardcoded Bot Token (Embedded in Source)

**How it works:** The Network Bot token is embedded directly in the Mercury source code. Every `npm install @cosmicstack/mercury-agent` ships with the same token.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ✅ Zero | Works out of the box, no setup |
| Security | ❌ Catastrophic | Token is in public npm package → anyone can impersonate/flood/control the bot, read all messages, extract chat IDs |
| Maintainability | ❌ Terrible | Token rotation requires npm publish + every user must upgrade |
| Feasibility | ✅ Trivial | Just a string constant in config.ts |

**Verdict: REJECTED.** A bot token gives full control (sendMessage, getUpdates, etc.). Exposing it in open source code is a credentials leak. This is the same as publishing an admin password.

### Approach 2: Environment Variable

**How it works:** `MERCURY_NETWORK_BOT_TOKEN` env var set at install time.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ❌ High | Requires manual config — defeats the zero-setup goal |
| Security | ⚠️ Moderate | Token stays on user's machine, but if everyone has the same token, it's effectively public |
| Maintainability | ⚠️ Moderate | Token change requires all users to update env var |
| Feasibility | ✅ Trivial | Already supported pattern in Mercury |

**Verdict: REJECTED.** This approach requires manual user configuration, violating the zero-setup constraint. If the same token is shared, it's equivalent to Approach 1 but worse (harder to rotate).

### Approach 3: Auto-Discovery via Telegram Username

**How it works:** Mercury knows the Network Bot's @username (e.g., `@MercuryNetworkBot`). At startup, it calls `getChat("@MercuryNetworkBot")` to get bot info, then... what?

**Critical Telegram limitation:** Bots **cannot** initiate conversations with other bots in private chats. The Bot API has no `sendMessage` to another bot by username. Bots can only send messages to:
- Users who have previously started a conversation with them (`/start`)
- Groups where the bot is a member

Even with Bot API 9.6's new **Bot-to-Bot Communication** feature, bot-to-bot messaging is only enabled in:
1. **Group chats** — both bots must be in the same group, at least one must have Bot-to-Bot Communication Mode enabled
2. **Business accounts** — if connected to the same business account

There is **no mechanism** for one bot to discover and message another bot in a private chat by username alone.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ✅ Low | Just need the username baked in |
| Security | ✅ Good | No token exposed |
| Maintainability | ✅ Good | Username rarely changes |
| Feasibility | ❌ Impossible | Bots cannot message each other privately by username |

**Verdict: INSUFFICIENT ALONE.** The username approach cannot bootstrap a connection because Telegram doesn't allow bots to message each other privately without a prior relationship (user mediation).

### Approach 4: Shared Config File

**How it works:** Default `mercury.yaml` shipped as part of the npm package contains the Network Bot token, similar to hardcoded but in a config file.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ✅ Zero | Works out of the box |
| Security | ❌ Same as hardcoded | Token in a file distributed via npm is public |
| Maintainability | ⚠️ Slightly better | User could edit it, but default is still public |
| Feasibility | ✅ Trivial | Extends current config system |

**Verdict: REJECTED.** Same security problem as Approach 1. The config file is readable by anyone who installs the package.

### Approach 5: How Other Tools Handle "Connect to Mothership"

#### ngrok
- **Approach:** Hardcoded coordination server URL + client authentication
- The ngrok client has a hardcoded `https://tunnel.ngrok.com` endpoint baked in
- Authentication is via an **authtoken** the user gets from ngrok's website after signing up
- The authtoken is specific to the user, not shared across all ngrok installations
- ngrok's coordination server handles tunnel allocation, but requires user signup
- **Lesson for Mercury:** ngrok accepts that user auth is required for the coordination layer. Free tier auth is per-user, not shared.

#### Tailscale
- **Approach:** Central coordination server (login.tailscale.com) + decentralized data plane
- Each node generates its own public/private keypair. Private key NEVER leaves the node.
- Nodes register their public keys + current endpoints (IP:port) with the coordination server
- OAuth2/OIDC (Google, Microsoft, etc.) handles authentication
- Data flows peer-to-peer via WireGuard; coordination server only exchanges keys and ACL policies
- For NAT traversal: STUN/ICE for hole-punching; DERP relay servers as fallback (encrypted, can't decrypt traffic)
- **Lesson for Mercury:** Tailscale's model is the gold standard for this problem. Central coordination for discovery, P2P for data. Authentication is per-user via existing identity providers. The coordination server holds only public keys.

#### localtunnel
- **Approach:** Hardcoded server URL + random subdomain assignment
- Client connects to `localtunnel.me` (hardcoded)
- Server assigns a random subdomain for the tunnel
- No authentication — anyone can create a tunnel
- **Lesson:** Simplicity at the cost of security. Works for dev/testing but not production.

### Approach 6: Telegram Bot API — Bot Discovery Capabilities

Researched the Bot API thoroughly (as of API 9.6, April 2026):

| API Method | Capability | Can it help? |
|---|---|---|
| `getMe` | Returns info about the calling bot itself | Only for self-identification |
| `getChat` | Gets info about a chat by ID or @username | ✅ Can look up a bot by @username, but returns a Chat object. **However**, you still can't SEND to it |
| `sendMessage` | Send message to a chat_id | ❌ Cannot send to another bot's private chat |
| Bot-to-Bot Communication (API 9.6) | Bots can communicate in groups | ✅ If both bots are in the same group, they can message each other |
| `getManagedBotToken` (API 9.6) | A manager bot can get tokens of bots it manages | ✅ Interesting — see Approach 9 below |

**Key finding:** `getChat("@SomeBot")` works — it returns bot info including its `chat.id`. But you **cannot** then `sendMessage` to that bot because Telegram prohibits bots from initiating private conversations with other bots. The only way two bots can communicate is through a **shared group** or via the new **Bot-to-Bot Communication** feature in group contexts.

**New Bot API 9.6 Feature: Managed Bots**

This is the most relevant new capability. A "manager bot" can have bots created for it that it then controls. The flow:
1. User visits `https://t.me/newbot/{manager_bot_username}/{suggested_bot_username}?name={suggested_name}`
2. User confirms bot creation
3. Manager bot receives a `managed_bot` update with `ManagedBotCreated` info
4. Manager bot can call `getManagedBotToken` to get the new bot's token
5. Manager bot now controls the new bot entirely

This is essentially how Mercury could work: the Network Bot is a **manager bot** that creates individual Mercury bot instances for each user.

### Approach 7: Key-Based Approach (Cryptographic Proof)

**How it works:** Mercury ships with a **public key** belonging to the Network Bot. When a Mercury instance connects, it proves its identity using cryptographic signatures. The Network Bot verifies using the corresponding private key.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ✅ Low | Public key is safe to embed — no secret material exposed |
| Security | ✅ Good | Public keys are safe to distribute; signing prevents spoofing |
| Maintainability | ⚠️ Moderate | Key rotation requires npm update, but Ed25519 keys don't need frequent rotation |
| Feasibility | ⚠️ Partial | Proves identity but doesn't solve the *transport* problem — how do two instances actually find and communicate with each other? |

**Verdict: USEFUL COMPLEMENT, but not sufficient alone.** A public key can verify that a message truly comes from the Network Bot, but it doesn't solve how Mercury instances discover each other or exchange messages.

### Approach 8: Package-Level Configuration (NPM Package Defaults)

**How it works:** The `@cosmicstack/mercury-agent` npm package includes a default config file with Network Bot connection details (username, maybe a public key). User's local `~/.mercury/mercury.yaml` overrides the defaults.

| Dimension | Rating | Notes |
|---|---|---|
| User friction | ✅ Zero | Package ships with working defaults |
| Security | ✅ Good for username/pubkey | Only non-secret data is in the package |
| Maintainability | ✅ Good | `npm update` pulls latest defaults; user overrides persist |
| Feasibility | ✅ Easy | Already fits Mercury's config merge pattern (`deepMerge(defaults, userConfig)`) |

**Verdict: VIABLE for non-secret data (username, public key, coordination server URL). Not viable for bot tokens.**

### Recommended Approach: Hybrid — Managed Bot + Group-Based Coordination

After analyzing all approaches, the recommended architecture combines several patterns:

#### Phase 1: Network Bot as Manager (Bot API 9.6 Managed Bots)

**This is the breakthrough.** The new Bot API 9.6 (April 2026) introduces Managed Bots. This changes everything:

1. **Mercury Network Bot** is set up as a "manager bot" via @BotFather
2. Each Mercury user visits: `https://t.me/newbot/MercuryNetworkBot/{suggested_username}?name={name}`
3. User confirms, and the Network Bot receives a `managed_bot` update containing `ManagedBotCreated`
4. Network Bot calls `getManagedBotToken(managed_bot_id)` to get the new bot's token
5. Network Bot delivers this token **back to the Mercury instance** via a secure channel

**The problem:** How does the Network Bot deliver the token back to the Mercury instance? The Mercury instance doesn't have a Telegram identity yet — it needs the token to become a bot.

**Solution:** A lightweight HTTPS coordination endpoint (the "signaling server"):
- Mercury instance generates a one-time pairing code and displays it to the user
- User enters the pairing code in the Managed Bot creation flow
- Network Bot associates the managed bot token with the pairing code
- Mercury instance polls `https://network.mercury.cosmicstack.org/pair/{code}` until it gets its bot token
- From this point, Mercury uses its own dedicated bot token

This mirrors the existing pairing flow in Mercury's Telegram channel (which already has `pairingCode` support).

#### Phase 2: Bot-to-Bot Communication in Groups

Once Mercury instances have their own bot tokens, they need to communicate. With Bot API 9.6's **Bot-to-Bot Communication** feature:

1. The Network Bot creates a **private group** (supergroup) for each pair of Mercury instances that want to connect
2. Both Mercury bots are added to this group
3. Both bots enable Bot-to-Bot Communication Mode (via @BotFather)
4. They can now exchange messages in the group context

**Advantages:**
- No hardcoded shared token — each user has their own bot
- Network Bot only acts as coordinator, not as message relay
- Telegram handles the transport layer
- End-to-end within Telegram's infrastructure

#### Phase 3: Direct P2P (Post-Introduction)

After the Network Bot introduces two Mercury instances via a Telegram group, they can negotiate **direct P2P connections**:

1. Inside the group, Mercury A sends its endpoint info (public IP, port, WireGuard pubkey) to Mercury B
2. Both instances attempt direct P2P connectivity (STUN/ICE hole-punching)
3. If direct P2P fails (both behind symmetric NAT), fall back to a DERP-like relay

**P2P feasibility analysis:**

| Scenario | P2P Possible? | Approach |
|---|---|---|
| Both have public IPs | ✅ Yes | Direct connection after exchanging endpoints |
| One public, one NAT | ✅ Yes | NAT-traversal via STUN — hole-punching from behind NAT |
| Both behind cone NAT | ✅ Yes | Simultaneous open via STUN — both send to each other at the same time |
| Both behind symmetric NAT | ❌ Relayed | Need TURN/DERP-style relay server |

**Lightweight P2P libraries for Node.js:**

| Library | Protocol | Notes |
|---|---|---|
| `@libp2p/webrtc` | WebRTC | Good for browser; complex in Node.js |
| `simple-peer` | WebRTC | Wraps `wrtc`; mature, well-tested |
| `node-datachannel` | WebRTC/libdatachannel | C++ binding, fast, supports SCTP |
| `werift-webrtc` | WebRTC | Pure TypeScript implementation |
| `airtyper/parsec` (custom) | QUIC | Modern, good for NAT traversal |
| `hyperswarm` | DHT + UDP | Part of the Hyper stack; DHT discovery |
| `ws` over SSH tunnel | WebSocket | Simplest; user already has SSH |
| `y-webrtc` | WebRTC | CRDT-oriented; built for Yjs |

**Best options for Mercury:**

1. **WebRTC via `simple-peer` or `node-datachannel`**: Full NAT traversal with ICE/STUN/TURN. Most battle-tested approach. `simple-peer` is pure JS (via `wrtc` native binding), `node-datachannel` is C++ but very fast.

2. **Hyperstack (`hyperswarm` + `hypercore`)**: DHT-based discovery + replicated logs. No central server needed. But adds significant dependency weight and a different programming paradigm.

3. **Custom QUIC/WebSocket with relay fallback**: Build on Node.js `net` module or `ws`. Use STUN for discovery, relay server for fallback. Lightest weight but most custom code.

**Recommendation:** Start with Telegram groups as the transport (Phase 2), then add WebRTC (`simple-peer` + public STUN servers) for direct P2P (Phase 3). Use the Network Bot's coordination endpoint as a TURN relay fallback for symmetric NAT cases.

### Comprehensive Comparison

| Approach | User Friction | Security | Maintainability | Feasibility | Verdict |
|---|---|---|---|---|---|
| 1. Hardcoded token | ✅ Zero | ❌ Catastrophic | ❌ Terrible | ✅ Trivial | REJECTED |
| 2. Environment variable | ❌ High | ⚠️ Moderate | ⚠️ Moderate | ✅ Trivial | REJECTED |
| 3. Username discovery | ✅ Low | ✅ Good | ✅ Good | ❌ Impossible | INSUFFICIENT |
| 4. Shared config file | ✅ Zero | ❌ Catastrophic | ⚠️ Better | ✅ Trivial | REJECTED |
| 5. Other tools pattern | Varies | Varies | Varies | Varies | INFORMATIVE |
| 6. Bot API capabilities | Varies | Varies | Varies | ✅ Feasible | KEY ENABLER |
| 7. Key-based approach | ✅ Low | ✅ Good | ⚠️ Moderate | ⚠️ Partial | COMPLEMENT |
| 8. Package-level config | ✅ Zero | ✅ Good (for non-secrets) | ✅ Good | ✅ Easy | ACCEPTED |
| **Managed Bot + Group** | ✅ Low (one-time pairing) | ✅ Excellent (per-user tokens) | ✅ Good | ✅ Now feasible | **RECOMMENDED** |

### Final Recommendation

**Architecture: Managed Bot + Group Coordination + Optional P2P**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Mercury Network Architecture                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Mercury Instance A                Mercury Instance B              │
│  (User's machine)                 (User's machine)                │
│       │                                 │                          │
│  1. Generate                         1. Generate                   │
│     pairing code                       pairing code                │
│       │                                 │                          │
│  2. Visit t.me/newbot/              2. Visit t.me/newbot/           │
│     MercuryNetworkBot/                MercuryNetworkBot/           │
│     MyMercuryBot                     YourMercuryBot               │
│       │                                 │                          │
│       └─────────┐     ┌─────────────────┘                          │
│                   ▼     ▼                                            │
│           Network Bot (Manager)                                     │
│           - Receives ManagedBotCreated updates                     │
│           - Gets managed bot tokens via getManagedBotToken         │
│           - Creates private group for A↔B communication            │
│           - Adds both managed bots to the group                    │
│                   │                                                  │
│                   │  Coordination Server (HTTPS)                    │
│           network.mercury.cosmicstack.org                          │
│           - Pairing code → bot token mapping                       │
│           - Instance registry (who's online, endpoint info)       │
│           - TURN relay for symmetric NAT fallback                  │
│                   │                                                  │
│       ┌───────────┴──────────────┐                                │
│       ▼                            ▼                                │
│  Mercury Bot A ◄──► Group ◄──► Mercury Bot B                     │
│  (owns its bot      Chat        (owns its bot                     │
│   token)                         token)                            │
│       │                            │                                │
│       └──── Optional Direct P2P ───┘                               │
│            (WebRTC/ICE/STUN)                                       │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Connection flow:**

1. **Package-level config** (Approach 8): Mercury npm package ships with `networkBotUsername: "MercuryNetworkBot"` and `coordinationServer: "https://network.mercury.cosmicstack.org"`. No secrets.

2. **Managed Bot creation** (Bot API 9.6): User visits the deep link to create their personal Mercury bot. Network Bot receives the `ManagedBotCreated` event and `getManagedBotToken` to get the new bot's token.

3. **Token delivery**: Mercury instance polls the coordination server with its pairing code, receives its dedicated bot token. Each user gets their OWN bot token — no shared credentials.

4. **Bot-to-Bot Communication** (Bot API 9.6): Network Bot creates a private group, adds both managed bots. With Bot-to-Bot Communication Mode enabled, they can exchange messages directly in the group.

5. **Optional P2P upgrade**: Inside the group, bots negotiate direct WebRTC connections (`simple-peer` + public STUN + coordination server as TURN fallback). Once P2P is established, Telegram group is only used as a signaling fallback.

6. **Key-based verification** (Approach 7): The package includes the Network Bot's Ed25519 public key. Mercury instances sign their registration messages. The coordination server verifies authenticity.

**Why this works:**

- **Zero shared secrets** in the npm package — only public key and username
- **Per-user bot tokens** via Managed Bot API — no single token to compromise
- **Telegram handles transport** for initial communication (no need to expose ports)
- **P2P upgrade path** for low-latency, high-bandwidth communication
- **Graceful degradation** — falls back to relay for symmetric NAT
- **Aligns with Tailscale's model**: coordination server for discovery, P2P mesh for data, relay for fallback