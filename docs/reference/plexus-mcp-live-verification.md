# Plexus MCP live verification

Verified 2026-09-22 from /home/swarm/clover; no management tools invoked.

## Transport
Authenticated initialize returned HTTP 200 and negotiated 2025-11-25 even when
2026-07-28 was offered. tools/list returned 12, resources/list 1, prompts/list 1.
The installed @modelcontextprotocol/client SDK connected using the literal
headers in the private project config and returned the same counts.

## Interactive
Launched the real `pi --no-session` in an isolated tmux session rooted at
/home/swarm/clover using existing installed packages. /mcp opened the adapter's
MCP Servers overlay showing plexus-management connected, 13/13 direct tools
(12 server tools plus resource wrapper). /reload completed without a stale-context
or uncaught exception. /mcp reopened with the same connected 13/13 state.
No model request or management mutation was made. Provider-wire tool exposure
and tool execution remain untested; menu registration is not proof of invocation.

## Fixes
Pi-Swarm no longer claims /mcp; fallback diagnostics use /swarm-mcp. Startup
skips fallback discovery when /pi-mcp identifies the installed adapter. Removed
vendor-example config fallback. Tool gating retains selected MCP definitions
without reactivating excluded tools. Private project configuration migrated
from custom apiKey fields to adapter-supported literal headers, with a private
backup; no secret values recorded here.

## Tests
Five tests passed in swarm-runtime-mcp.test.ts and swarm-extra-tool-gating.test.ts.
The broad Pi 0.87 audit and full MCP 2026-07-28 conformance are not complete.
