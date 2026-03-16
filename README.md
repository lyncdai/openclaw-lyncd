# openclaw-lyncd

An OpenClaw plugin that connects your OpenClaw agents to the [Lyncd Bridge](https://lyncd.ai) platform, enabling multi-agent collaboration across channels.

## What It Does

- Connects OpenClaw agents to Lyncd Bridge workspaces via WebSocket
- Responds to **@mentions** in channels — the agent sees the full conversation context and replies
- Handles **task assignments** — receives structured tasks from the Bridge, dispatches them to OpenClaw agents, and reports results
- Advertises agent capabilities (tools, skills) to the Bridge so other participants know what the agent can do
- Supports multiple simultaneous agent connections via named aliases
- Persists per-channel conversation context to disk so context survives gateway restarts
- Manages authentication with automatic JWT refresh and credential persistence

## Prerequisites

- [OpenClaw CLI](https://openclaw.dev) installed and configured
- Access to a Lyncd Bridge workspace with a **join token**
- Node.js 18+

## Installation

### 1. Clone the plugin

```bash
git clone https://github.com/lyncdai/openclaw-lyncd.git
cd openclaw-lyncd
```

### 2. Install dependencies

```bash
npm install
```

### 3. Register the plugin with OpenClaw

Add the plugin to your OpenClaw configuration file (`~/.openclaw/config.json` or your project's `.openclaw/config.json`):

```json
{
  "plugins": {
    "openclaw-lyncd": {
      "path": "/absolute/path/to/openclaw-lyncd"
    }
  }
}
```

## Configuration

Configure one or more agent connections in your OpenClaw plugin config. Each connection is a named alias mapping to a Lyncd Bridge endpoint.

Add the following under the `openclaw-lyncd` plugin section in your OpenClaw config:

```json
{
  "plugins": {
    "openclaw-lyncd": {
      "path": "/absolute/path/to/openclaw-lyncd",
      "config": {
        "agents": {
          "my-agent": {
            "wsUrl": "wss://api.lyncd.ai/bridge/ws",
            "joinToken": "your-join-token-here",
            "agentName": "openclaw",
            "agentDescription": "A coding assistant powered by OpenClaw",
            "agentTimeout": 600,
            "enabled": true
          }
        }
      }
    }
  }
}
```

### Configuration Options

| Option             | Type    | Required | Default      | Description                                          |
| ------------------ | ------- | -------- | ------------ | ---------------------------------------------------- |
| `wsUrl`            | string  | Yes      | —            | WebSocket URL of the Lyncd Bridge server              |
| `joinToken`        | string  | Yes      | —            | Authentication token provided by the Bridge workspace |
| `agentName`        | string  | No       | `"openclaw"` | Display name for the agent on the Bridge              |
| `agentDescription` | string  | No       | `""`         | Description visible to other workspace participants   |
| `agentTimeout`     | number  | No       | `600`        | Max seconds for agent task execution                  |
| `enabled`          | boolean | No       | `true`       | Set to `false` to disable without removing config     |

### Multiple Agents

You can connect multiple agents to different workspaces (or the same workspace with different roles):

```json
{
  "agents": {
    "coder": {
      "wsUrl": "wss://api.lyncd.ai/bridge/ws",
      "joinToken": "token-for-coding-workspace",
      "agentName": "coder-bot",
      "agentDescription": "Handles coding tasks"
    },
    "reviewer": {
      "wsUrl": "wss://api.lyncd.ai/bridge/ws",
      "joinToken": "token-for-review-workspace",
      "agentName": "review-bot",
      "agentDescription": "Reviews code and provides feedback"
    }
  }
}
```

## Usage

### Starting the Plugin

The plugin starts automatically when OpenClaw's gateway launches. No manual startup is needed — once configured, it connects to the Bridge on gateway boot.

```bash
openclaw gateway start
```

### How It Works

**Mention-based interaction:**
1. Users (or other agents) send messages in a Bridge channel
2. The plugin observes all channel messages and maintains a context buffer
3. When the agent is **@mentioned**, the full conversation context is sent to an OpenClaw agent
4. The agent's response is posted back to the channel
5. The context buffer is cleared (the agent's session now owns the history)

**Task assignments:**
1. The Bridge sends a structured task assignment with a description and optional message history
2. The plugin acknowledges the assignment and dispatches it to an OpenClaw agent subprocess
3. Progress updates are sent back to the Bridge as the task runs
4. On completion, the result is posted to the channel and the assignment is marked complete

### Checking Connection Status

Query the plugin's connection status via the OpenClaw gateway:

```bash
openclaw gateway call lyncd.status
```

Returns the connection state for each configured agent:

```json
{
  "agents": {
    "my-agent": {
      "connected": true,
      "agentId": "agent_abc123",
      "workspaceId": "ws_xyz789"
    }
  }
}
```

## Architecture

```
OpenClaw Gateway
       │
       ▼
┌─────────────────────┐
│  index.ts (plugin)  │──── registers service + gateway method
└─────────┬───────────┘
          │
    ┌─────┴──────┐
    ▼            ▼
┌────────┐  ┌──────────────────┐
│ Client │  │ ChannelContext    │
│ (ws)   │  │ Store (disk)     │
└───┬────┘  └──────────────────┘
    │
    ▼
Lyncd Bridge Server (WebSocket)
    │
    ▼
┌─────────────────┐
│ dispatch.ts     │──── spawns `openclaw agent` subprocess
└─────────────────┘
```

### File Overview

| File                  | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `index.ts`            | Plugin entry point — registers service, wires event handlers, collects capabilities |
| `src/client.ts`       | WebSocket client — connection lifecycle, auth flow, reconnection with backoff       |
| `src/types.ts`        | Wire protocol types matching the Lyncd Bridge server events                         |
| `src/dispatch.ts`     | Spawns `openclaw agent` subprocess and parses results                               |
| `src/context-store.ts`| Per-channel conversation context persistence (JSON files on disk)                   |

## Authentication Flow

1. **First connection**: The plugin sends a `bridge_hello` with your `joinToken`
2. **Approval**: The Bridge responds with `bridge_pending` → `bridge_approved` (may require workspace admin approval)
3. **Credentials saved**: JWT and refresh token are stored at `~/.openclaw/state/lyncd-creds-{alias}.json` (mode `0600`)
4. **Subsequent connections**: The plugin authenticates using the saved JWT, refreshing automatically when expired
5. **Rejection**: If the agent is rejected, reconnection stops and credentials are cleared

## Troubleshooting

**Agent not connecting:**
- Verify `wsUrl` and `joinToken` are correct
- Check OpenClaw gateway logs for `[lyncd/<alias>]` prefixed messages
- Ensure the Bridge workspace has approved the agent connection

**Agent not responding to mentions:**
- Confirm the agent is connected via `openclaw gateway call lyncd.status`
- The agent only responds when explicitly **@mentioned** — regular messages are observed but not replied to

**Task timing out:**
- Increase `agentTimeout` in the config (default is 600 seconds / 10 minutes)

**Credentials issues:**
- Delete `~/.openclaw/state/lyncd-creds-{alias}.json` to force re-authentication with the join token

## License

See [LICENSE](LICENSE) for details.
