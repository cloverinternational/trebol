# Hoja mode baseline (Pi session trajectories)

Source: `~/.pi/agent/sessions/--Users-swarm-Work-Clover-trebol--/` (local, not committed; aggregate counts only).

| Measure | Value |
| --- | --- |
| Session files | 104 |
| Sessions with tool calls | 90 (6262 calls) |
| Sessions with edit tools (`apply_patch`, `Edit`, `Write`, `Undo`) | 46 |
| Sessions with Hoja API calls (`LINEAR_API_URL` or `hoja.clover4.app` in Bash input) | 1 (2 calls) |
| Sessions where Hoja was queried before the first edit | 0 |

Reading: Hoja was almost never consulted before acting. This supports a proactive startup digest or prompt-level rule over relying on the user to ask.

Method limit: counts assume the transcript `toolCall` block shape observed in these files; Hoja detection matches only the environment variable name or host in Bash input.
