# MCP servers (Tern plugin)

Manage Pi's MCP servers from Tern, outside Pi's TUI. Pi stays the only owner of MCP: this plugin runs
`pi mcp list --json`, `pi mcp add`, `pi mcp login` and `pi mcp remove` (directly, no shell) in the pane's
directory and never edits `mcp.json` itself.

```sh
tern plugin link tern-plugins/mcp     # undo: tern plugin unlink mcp
```

Palette: **Add MCP server** (opens the block with the field focused) and **MCP servers**.

In the block:

- Paste a server's JSON from its README (`{"mcpServers": {…}}`, `{"servers": {…}}`, `"name": {…}`), a URL
  (`https://mcp.sentry.dev/mcp` becomes `sentry`), `name https://url`, or `name -- command args`
  (any `pi mcp add` arguments). Pick **Global** or **This project**, press Enter.
- Literal secrets in headers or env need a second Enter; prefer `${ENV_VAR}` or `!command`, which Pi
  resolves when it connects.
- `↑/↓` select, `a` add, `l` sign in (OAuth, opens the browser), `del`/`d` twice to remove, `r` refresh.

Pi sessions read `mcp.json` when they start: a running session connects a new server after `/reload`.
Inside Pi, `/mcp-add` does the same and reloads for you.
