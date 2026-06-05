# AI Agent Slack Integration: Industry Research & Best Practices

## Table of Contents
1. [Connection Architecture Comparison](#1-connection-architecture-comparison)
2. [Platform-by-Platform Analysis](#2-platform-by-platform-analysis)
3. [Conversation Threading & Context](#3-conversation-threading--context)
4. [Tool Execution from Slack Messages](#4-tool-execution-from-slack-messages)
5. [Multi-Workspace / Token Management](#5-multi-workspace--token-management)
6. [Error Handling Patterns](#6-error-handling-patterns)
7. [Security Considerations](#7-security-considerations)
8. [Architecture Recommendations](#8-architecture-recommendations)

---

## 1. Connection Architecture Comparison

### Socket Mode vs Event API (HTTP) vs RTM

| Feature | Socket Mode | Event API (HTTP) | RTM (Legacy) |
|---|---|---|---|
| **Protocol** | WebSocket (bidirectional) | HTTP POST to public URL | WebSocket (legacy) |
| **Public endpoint required** | No | Yes | No |
| **Behind firewall** | Works | Requires tunnel/proxy | Works |
| **Auth model** | App-level token (`xapp-`) + Bot token (`xoxb-`) | Bot token + Signing Secret | Bot token (`xoxb-`) |
| **Event verification** | Pre-authenticated WebSocket (no signing needed) | Must verify signing secret on every request | Pre-authenticated |
| **Max connections** | Up to 10 concurrent WebSocket connections | N/A (stateless HTTP) | 1 |
| **Connection refresh** | Every ~few hours; must handle reconnects | N/A | Similar refresh pattern |
| **Marketplace eligible** | No (Socket Mode apps cannot be listed) | Yes | No (deprecated) |
| **Granular permissions** | Required | Required | Classic permissions only |
| **Latency** | Low (persistent WebSocket) | HTTP round-trip | Low |
| **Load balancing** | Up to 10 connections for horizontal scaling | Standard HTTP scaling | Single connection |
| **Interactive features** | Full support (buttons, modals, slash commands) | Full support | Limited |

**Industry consensus**: Socket Mode is the standard for internal/dev tools and agents. Event API (HTTP) is required for Slack Marketplace distribution. RTM is deprecated and should not be used.

### Slack's Official Recommendation
> "We recommend using our Bolt framework or SDKs for Java, JavaScript, or Python to handle the details of Socket Mode."

---

## 2. Platform-by-Platform Analysis

### Slack's Official Bolt Framework (Python & JS)

**Architecture**: The gold standard. Bolt is Slack's official framework.

**Key patterns from Bolt for agents**:
- `SocketModeHandler` for Python, `{ socketMode: true }` for JS
- Built-in `Assistant` class for the AI assistant side panel
- `sayStream()` utility for streaming LLM responses token-by-token
- `setStatus()` for showing "thinking..." indicators
- `setSuggestedPrompts()` for onboarding UX
- `FeedbackButtonsElement` for thumbs up/down feedback
- `chat.startStream` / `chat.appendStream` / `chat.stopStream` for streaming
- `task_display_mode: 'plan'` or `'timeline'` for task card visualization

**Sample "Casey" support agent** (official Slack sample):
- Supports Claude Agent SDK, OpenAI Agents SDK, and Pydantic AI
- Three entry points: @mention in channels, DM messages, Assistant side panel
- Adds `:eyes` reacji when processing, `:white_check_mark:` when resolved
- Thread-scoped session store for conversation context
- MCP Server integration for workspace search

```python
# Bolt Python - Socket Mode setup
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

app = App(token=os.environ["SLACK_BOT_TOKEN"])
handler = SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"])
handler.start()
```

```javascript
// Bolt JS - Socket Mode setup
const { App } = require('@slack/bolt');
const app = new App({
  token: process.env.BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});
await app.start();
```

### LangChain/LangGraph

**Architecture**: LangChain treats Slack as a **tool** (not a runtime). Slack integration is a `Toolkit` that provides actions (send message, read channel, etc.) and document loaders.

**Key patterns**:
- `SlackToolkit` / `SlackTool` provides Web API actions as LangChain tools
- `SlackChatLoader` loads channel history as documents for RAG
- LangGraph agents invoke Slack tools as part of their ReAct loop
- The agent framework (LangGraph) is separate from the Slack connection layer
- You still need Bolt or a custom Socket Mode handler to receive events
- Slack becomes one of many tools the agent can call, not the orchestrator

**Pattern**: External event listener (Bolt/custom) -> LangGraph agent runner -> Slack tool calls

### CrewAI

**Architecture**: CrewAI has no native Slack integration. Slack access is via custom tools or Composio integration.

**Key patterns**:
- Custom `BaseTool` subclass wrapping Slack Web API
- Tools registered with agents via `tools=[...]` parameter
- No built-in event listener — you must host your own Bolt/custom listener
- `crewai_tools` package doesn't include Slack tools
- ComposioTool provide pre-built Slack connectors

**Pattern**: Custom Bolt listener -> CrewAI `Crew.kickoff()` -> Custom Slack tool responses

### OpenAI's Official Slack Integration

**Architecture**: The ChatGPT Slack app is a closed-source Marketplace app using Event API (HTTP).

**Key patterns**:
- HTTP-based (required for Marketplace distribution)
- OAuth 2.0 installation flow for multi-workspace
- `chat:write`, `app_mentions:read` scopes
- Responds to @mentions and DMs
- Uses `assistant.threads.setStatus` for thinking indicators
- Streaming responses via `chat.startStream/appendStream/stopStream`
- No tool execution — pure conversational Q&A
- Enterprise features: data stays within Slack's trust boundary

**Important**: The official OpenAI Slack app is NOT an agent. It's an assistant — it responds to queries but cannot take autonomous actions or call tools.

### Anthropic's Claude Slack Integration

**Architecture**: Available via two paths:
1. **Claude.ai / Claude Code** — connects via Slack's **MCP Server** (remote MCP)
2. **Custom Claude Agent SDK app** — uses Bolt + Socket Mode + Claude Agent SDK

**MCP Server path**:
- Slack hosts the MCP server at `https://mcp.slack.com/mcp`
- JSON-RPC 2.0 over Streamable HTTP
- Claude.ai acts as the host/client, Slack is the server
- OAuth 2.0 with PKCE for user-level authentication
- Granular scopes per tool (e.g., `search:read.public`, `chat:write`)
- Available in: Claude.ai, Claude Code, Perplexity, Cursor

**Custom Bolt app path** (Slack's "Casey" sample):
- Bolt for Python/JS + Socket Mode
- Claude Agent SDK with `createSdkMcpServer` for tool definition
- `@tool` decorator for custom tools
- `Runner.run_sync()` for agent execution
- Conversation history stored per `(channel_id, thread_ts)` key

### AutoGPT / AgentGPT

**Architecture**: No native Slack integration. These are autonomous agent frameworks that would need a custom Slack connector.

**Pattern**: Would require a custom Socket Mode handler that feeds events into the AutoGPT loop, with Slack APIs exposed as callable tools. No standard implementation exists.

---

## 3. Conversation Threading & Context

### Industry Standard Threading Model

All major platforms converge on the same pattern:

```
Thread Identity: (channel_id, thread_ts) -> unique conversation session
```

**How it works**:
1. First mention/message creates a thread: `thread_ts = event.ts`
2. All subsequent replies in that thread inherit the same `thread_ts`
3. The `(channel_id, thread_ts)` pair becomes the session key
4. Agent stores conversation state keyed by this pair
5. On follow-up messages, agent retrieves existing session/state

### Context Management Patterns

**Slack's official "structured state" pattern** (from their agent docs):

```typescript
const state = {
  goal: '',          // user's current objective
  constraints: '',   // date range, channel scope, filters
  decisions: [],    // key decisions identified this session
  artifacts: [],    // outputs created (summaries, canvases, links)
  sources: []       // [{ text, link }] — attribution for cited messages
};
```

**Key best practices from Slack's docs**:
- **Don't refetch entire threads**: Use structured state between turns
- **Progressive summarization**: Summarize older material into reusable state
- **Token budgets per request**: Enforce limits, prefer small context slices
- **Use `assistant.search.context`** for workspace-wide semantic search (not legacy `search.messages`)
- **Use `conversations.replies`** only when you need full thread history
- **Drift detection**: Detect when conversation has diverged from original goal

### Context Gathering APIs

| API Method | Use Case | Rate Limit |
|---|---|---|
| `assistant.search.context` | Workspace-wide semantic search | Special |
| `conversations.replies` | Full thread history | Tier 3: 50+/min |
| `conversations.history` | Channel message history | Tier 3: 50+/min |
| `conversations.info` | Channel metadata | Tier 3: 50+/min |
| `users.info` | User profile data | Tier 4: 100+/min |

### Assistant Thread Context

When using the **Agents & AI Apps** feature (assistant side panel):
- `assistant_thread_started` event includes `context.channel_id` and `context.team_id`
- `assistant_thread_context_changed` fires when user navigates channels while panel is open
- This lets the agent know which channel the user is currently looking at

---

## 4. Tool Execution from Slack Messages

### Pattern 1: Bolt + Agent SDK (Recommended)

The industry standard pattern for AI agents that need to execute tools:

```
Slack Event (Socket Mode)
  -> Bolt event handler
    -> Add reaction (eyes) to show processing
    -> Set thread status ("Thinking...")
    -> Retrieve conversation state from session store
    -> Run agent with tools (Claude/OpenAI/Pydantic Agent SDK)
    -> Agent decides which tools to call
    -> Tools execute (Slack API calls, external APIs, etc.)
    -> Stream response with sayStream()
    -> Add feedback buttons
    -> Update session store
    -> Add reaction (white_check_mark) when resolved
```

### Pattern 2: MCP Server (New Emerging Standard)

Slack's MCP Server provides a standard tool interface:

**Transport**: JSON-RPC 2.0 over Streamable HTTP at `https://mcp.slack.com/mcp`

**Available MCP tools**:
- Search messages/files/channels/users/emoji
- Send messages, read channels/threads
- Create conversations, add reactions
- Create/update/read canvases
- Read user profiles, list channel members

**Authentication**: OAuth 2.0 with granular scopes per tool

### Pattern 3: Direct Tool Definition (Claude Agent SDK)

```python
from claude_agent_sdk import tool, createSdkMcpServer

@tool(name="check_github_status", description="Check GitHub's current status", input_schema={})
async def check_github_status_tool(args):
    async with httpx.AsyncClient() as client:
        response = await client.get("https://www.githubstatus.com/api/v2/status.json")
        data = response.json()
        return {"content": [{"type": "text", "text": f"**GitHub Status** — {data['status']['indicator']}"}]}

casey_tools_server = createSdkMcp_server(
    name="casey-tools", version="1.0.0",
    tools=[check_github_status_tool],
)
```

### Pattern 4: CrewAI Custom Tools

```python
from crewai.tools import BaseTool
from pydantic import BaseModel

class SlackMessageTool(BaseTool):
    name: str = "send_slack_message"
    description: str = "Send a message to a Slack channel or thread"

    def _run(self, channel: str, text: str, thread_ts: str = None) -> str:
        client.chat_postMessage(channel=channel, text=text, thread_ts=thread_ts)
        return "Message sent"
```

### Human-in-the-Loop for Tool Execution

Slack's official guidance: **Any action with real-world output should require explicit human confirmation.**

```python
# Show approval gate before executing
streamer.append(markdown_text="I can create a Jira ticket for this. Should I proceed?")
streamer.stop(blocks=[{
    "type": "actions",
    "elements": [
        {"type": "button", "text": {"type": "plain_text", "text": "Create Ticket"}, "action_id": "approve_ticket", "style": "primary"},
        {"type": "button", "text": {"type": "plain_text", "text": "Cancel"}, "action_id": "cancel_ticket", "style": "danger"},
    ]
}])
```

---

## 5. Multi-Workspace / Token Management

### Single Workspace (Socket Mode)
- Simplest: one `SLACK_BOT_TOKEN` (`xoxb-`) + one `SLACK_APP_TOKEN` (`xapp-`)
- Store in environment variables
- Single connection, single bot user

### Multi-Workspace (OAuth)
Required for Slack Marketplace and MCP Server. Uses Bolt's OAuth support:

```python
# Bolt Python - Multi-workspace OAuth
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

app = App(
    signing_secret=os.environ["SLACK_SIGNING_SECRET"],
    oauth_settings=OAuthSettings(
        client_id=os.environ["SLACK_CLIENT_ID"],
        client_secret=os.environ["SLACK_CLIENT_SECRET"],
        installation_store=FileInstallationStore(),
    ),
)
handler = SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"])
handler.start()
```

**Token types and their management**:

| Token | Prefix | Purpose | Storage |
|---|---|---|---|
| App-level token | `xapp-` | Socket Mode WebSocket connection | Env var (single value) |
| Bot token | `xoxb-` | Web API calls as bot user | Installation store (per workspace) |
| User token | `xoxp-` | Web API calls as user | Installation store (per user/workspace) |
| Signing secret | N/A | HTTP request verification | Env var (single value) |
| Client ID/Secret | N/A | OAuth flow | Env var (single value) |

**Installation store patterns**:
- `FileInstallationStore` — dev/local, JSON files
- `AmazonS3InstallationStore` — production AWS
- `SQLInstallationStore` — production relational DB
- Custom store — implement `InstallationStore` interface

**Token rotation**: Enable `token_rotation_enabled: true` in manifest. Slack automatically rotates bot/user tokens. App must handle refresh via `auth.v2.access` endpoint.

### MCP Server Token Management
- OAuth 2.0 with PKCE support for desktop clients
- OAuth discovery at `https://mcp.slack.com/.well-known/oauth-authorization-server`
- User-level tokens with granular scopes
- Separate scopes per MCP tool (e.g., `search:read.public`, `chat:write`, `channels:history`)

---

## 6. Error Handling Patterns

### Slack's Official Error Handling Guidance

> "Graceful failure means the agent treats its own partial progress as something worth preserving."

**When an agent errors, it should**:
1. Save what it has accomplished
2. Explain where it got stuck and why
3. Give the user clear options: provide info, skip step, take over manually
4. As last resort, clear `setStatus('')` so app isn't stuck "thinking"

### Connection-Level Error Handling (Socket Mode)

```python
# Expected disconnect scenarios:
# - Connection refresh every few hours
# - Warning 10 seconds before disconnect (reason: "warning")
# - Refresh requested (reason: "refresh_requested")
# - Socket Mode toggled off (reason: "link_disabled")

# Bolt handles reconnection automatically, but for custom implementations:
async def handle_disconnect(reason):
    if reason in ("refresh_requested", "warning"):
        new_url = await apps_connections_open(app_token)
        await connect_websocket(new_url)
    elif reason == "link_disabled":
        logger.error("Socket Mode disabled in app settings")
```

### Agent-Level Error Handling

```python
# From Slack's Casey sample - comprehensive error handling
def handle_app_mentioned(client, context, event, logger, say, say_stream, set_status):
    try:
        set_status(status="Thinking...")
        # ... agent logic ...
        streamer = say_stream()
        streamer.append(markdown_text=result.output)
        streamer.stop(blocks=feedback_blocks)
    except Exception as e:
        logger.exception(f"Failed to handle app mention: {e}")
        say(
            text=f":warning: Something went wrong! ({e})",
            thread_ts=event.get("thread_ts") or event["ts"],
        )
```

### Common Error Scenarios

| Scenario | Handling |
|---|---|---|
| LLM timeout | Set status to error, offer retry button |
| Tool call failure | Report which tool failed, suggest alternatives |
| Rate limit hit | Exponential backoff, queue for retry |
| Invalid user input | Ephemeral message with guidance |
| WebSocket disconnect | Auto-reconnect (Bolt handles this) |
| Token expired | Re-auth via installation store |
| Channel access denied | Graceful message explaining limitation |
| Prompt injection suspected | Sanitize input, flag to admin |

### Metrics to Track (from Slack's governance docs)

```typescript
{
  total_latency_ms: number,     // End-to-end clock time
  outcome: "success" | "partial" | "failure",
  user_id: string,
  agent_id: string,             // Which agent handler
  tools_called: string[],      // Tool names invoked
  model: string,               // Model name/version
  retry_attempts: number,
  total_tokens: number,
  token_efficiency: number,    // Output/input ratio
  error_type?: "llm_error" | "tool_error" | "validation_error" | "timeout"
}
```

---

## 7. Security Considerations

### Token Storage

**Never commit tokens to source code.** Use:
- Environment variables for single-workspace deployments
- Encrypted installation store (DB/S3) for multi-workspace
- Secret managers (AWS Secrets Manager, HashiCorp Vault) for production
- Token rotation enabled (`token_rotation_enabled: true`)

### Permissions Scoping (Least Privilege)

**Start narrow, expand with explicit approval:**

```yaml
# Minimal scopes for a basic agent
oauth_config:
  scopes:
    bot:
      - app_mentions:read    # Receive @mentions
      - chat:write            # Send messages
      - reactions:write       # Add emoji reactions
      - assistant:write      # Assistant side panel features

# Expand only when needed
      - channels:history      # Read channel messages
      - channels:read         # List channels
      - search:read.public    # Search public channels
      - files:read            # Read shared files
```

**Slack MCP Server granular scopes**:

| Tool | Required Scopes |
|---|---|
| Search messages | `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im` |
| Search files | `search:read.files` |
| Send message | `chat:write` |
| Read channel/thread | `channels:history`, `groups:history`, `mpim:history`, `im:history` |
| Create channel | `channels:write` / `groups:write` / `im:write` / `mpim:write` |
| Reactions | `reactions:write` |
| Canvas | `canvases:read`, `canvases:write` |
| User info | `users:read`, `users:read.email` |

### Prompt Injection Defense

From Slack's security docs:
> "Integrating with AI carries an inherent risk of prompt injection."

**Mitigations**:
- Sanitize all user input before passing to LLM
- Never include raw Slack message text directly in system prompts
- Use structured data extraction, not raw text passthrough
- Mark data boundaries: `<user_input>...</user_input>` vs `<system_context>`
- Validate LLM output before executing tool calls
- Audit log all agent actions

### Data Privacy

**Slack's official stance**:
- Customer data never leaves Slack for Slack's own AI features
- LLMs for Slack AI are hosted in Slack's AWS VPC
- Customer data is NOT used to train LLMs
- For custom agents: your app controls where data goes

**Best practices for custom agents**:
- Don't store Slack data; store metadata and pull in real time
- Mark search scopes as optional to reduce installation abandonment
- For FedRAMP workspaces: restrict apps with `search:read.*` scopes
- Use ephemeral messages for sensitive information
- Implement data retention policies

### Admin Controls

**Required for enterprise deployment**:
- Audit trails via [Audit Logs API](/reference/audit-logs-api)
- "AI Excluded" indicator for channels that opt out
- Admin approval for MCP client integrations
- Dashboard for agent incidents, performance, reliability
- Only marketplace-published or internal apps can use MCP

---

## 8. Architecture Recommendations

### Recommended Architecture for Mercury Agent

Based on all research, here is the recommended architecture:

```
┌──────────────────────────────────────────────────────┐
│                    Slack Workspace                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │ @mention │  │ DM message│  │ Assistant Side Panel│ │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘ │
│       │              │                   │             │
└───────┼──────────────┼───────────────────┼─────────────┘
        │   Socket Mode (WebSocket)       │
        ▼                                 ▼
┌──────────────────────────────────────────────────────┐
│                  Bolt Framework Layer                  │
│  ┌─────────────────────────────────────────────────┐ │
│  │  SocketModeHandler ←── SLACK_APP_TOKEN (xapp-)  │ │
│  │  App            ←── SLACK_BOT_TOKEN (xoxb-)     │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │ Event    │  │ Message  │  │ Assistant Thread     │ │
│  │ Handlers │  │ Handlers │  │ Handlers             │ │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘ │
└───────┼──────────────┼───────────────────┼─────────────┘
        │              │                   │
        ▼              ▼                   ▼
┌──────────────────────────────────────────────────────┐
│                    Agent Runtime                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Session Store: (channel_id, thread_ts) → state │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────┐ │
│  │ Set Status   │  │ Stream Reply  │  │ Add Reacji │ │
│  │ "Thinking.." │  │ sayStream()   │  │ 👀 ✅      │ │
│  └──────────────┘  └───────────────┘  └────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │              Agent Framework (LangGraph/etc)      │ │
│  │  ┌───────────────────────────────────────────┐  │ │
│  │  │  LLM → Reason → Tool Call → Observe → Loop │  │ │
│  │  └───────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │                   Tool Layer                      │ │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐  │ │
│  │  │Slack   │ │Jira    │ │GitHub  │ │Custom    │  │ │
│  │  │Tools   │ │Tools   │ │Tools   │ │API Tools │  │ │
│  │  └────────┘ └────────┘ └────────┘ └──────────┘  │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Key Trade-offs

| Decision | Option A | Option B | Recommendation |
|---|---|---|---|
| **Connection** | Socket Mode | Event API (HTTP) | Socket Mode for internal; HTTP only if Marketplace needed |
| **Framework** | Bolt (official) | Custom WebSocket | Bolt — handles reconnection, auth, event routing |
| **Agent SDK** | Claude Agent SDK | OpenAI Agents SDK | Either — both supported by Slack's samples |
| **Context** | Full thread history | Structured state | Structured state for ongoing; `conversations.replies` for initial load |
| **Streaming** | `sayStream()` | `chat.postMessage` | `sayStream()` — matches user expectations from ChatGPT/Claude |
| **Feedback** | FeedbackButtonsElement | Reacji tracking | FeedbackButtons for UX; reacji for lightweight |
| **Tool approval** | Human-in-loop for writes | Auto-execute all | Human-in-loop for any write/delete/high-impact action |
| **MCP** | Slack MCP Server | Custom tools | Custom tools for agent-specific; MCP for workspace-wide search |
| **Tokens** | Env vars (single workspace) | OAuth installation store | Env vars for dev; installation store for production |

### Minimal Viable Agent Stack

1. **Bolt for Python/JS** — Socket Mode, event routing, response utilities
2. **Agent SDK** (Claude/OpenAI/LangGraph) — reasoning & tool execution
3. **Session store** — `(channel_id, thread_ts)` keyed dict/DB
4. **Custom tools** — Slack API wrappers + external service integrations
5. **Error handling** — try/catch with graceful degradation + status clearing
6. **Token security** — Env vars + `.gitignore`, never commit

### Production-Ready Agent Stack (add)

7. **OAuth + InstallationStore** — Multi-workspace support
8. **Token rotation** — Enabled in manifest
9. **Structured state** — `{ goal, constraints, decisions, artifacts, sources }`
10. **Streaming** — `sayStream()` with `task_display_mode: 'plan'`
11. **Feedback** — `FeedbackButtonsElement` + analytics logging
12. **MCP Server** — Workspace-wide search via `assistant.search.context`
13. **Audit logging** — Per-response metrics (`outcome`, `tools_called`, `latency`)
14. **Human-in-the-loop** — Approval gates for write actions
15. **Rate limit handling** — Exponential backoff + retry queues