# `swarm-websearch`

This is a provider-neutral MCP adapter. It does not contain an Exa URL, a
Plexus URL, a provider name, or an API key. **Set it up yourself** for the MCP
server you want to use.

Create `.pi/config/swarm-websearch.json`:

```json
{
  "enabled": true,
  "server": {
    "id": "your-search-server",
    "type": "http",
    "url": "https://your-mcp-server.example/mcp",
    "environment": ["YOUR_MCP_AUTH_TOKEN"],
    "headers": { "authorization": "YOUR_MCP_AUTH_TOKEN" },
    "tools": [],
    "timeoutMs": 30000
  }
}
```

Header values are environment-variable **names**, not secrets. Set the
referenced variable before starting Pi, or set `PI_SWARM_WEBSEARCH_CONFIG` to
an alternate config path. Never commit populated credentials.

For Plexus, configure its MCP gateway URL and a dedicated Plexus client
credential here. Configure the Exa credential on Plexus itself; it remains
server-side and is never sent to Pi.

The extension discovers tools at session start and exposes them as
`mcp__<server-id>__<tool-name>`. Use `tools` or `excludeTools` for an explicit
allowlist. Missing or disabled configuration makes no network request. Use
`/swarm-websearch discover` after changing configuration.
