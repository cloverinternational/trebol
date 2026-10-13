# OSC 7501 Program Status support

Trebol emits [OSC 7501](https://mitchellh.com/writing/program-status-osc7501)
program-status reports — Mitchell Hashimoto's terminal-native protocol that
lets any program tell the terminal what it is doing: `idle`, `working`,
`blocked`, `done`, or `error`, and why. Terminals, multiplexers, and
"agentic inboxes" (Ghostty, Rex, Herdr, conch, …) consume these reports to
show Trebol's state without screen-scraping heuristics.

## Wire format

```
ESC ] 7501 ; state=working:app=trebol:msg=<base64> ESC \
```

- One report per sequence; `key=value` pairs joined by `:`; `state` required.
- Optional keys: `id` (hierarchical record id, `/`-separated names like
  `deploy/us-east`), `app` (stable machine name, always `trebol` here),
  `kind` (`permission`|`question`|`auth`, only with `blocked`), `progress`
  (`0`–`100`, only with `working`|`blocked`), `title` and `msg`
  (base64, single-line UTF-8 for people).
- Each report replaces its record completely. `state=clear` removes the
  record (and children); without an id it removes every record.
- Whole sequence ≤ 4096 bytes; the emitter truncates `msg`/`title` and drops
  invalid values instead of emitting a malformed sequence.

## Trebol lifecycle mapping

| Pi event | Report |
| --- | --- |
| `session_start`, `session_switch` | `idle` — at rest, awaiting input |
| `before_agent_start`, `turn_start` | `working` — running, msg = first line of the user prompt |
| `tool_call` → `ask_user_question` | `blocked`, `kind=question` — msg = first question text |
| `tool_result` → `ask_user_question` | `working` — answer received, resuming |
| `agent_before_settle` (completed) | `done` — piece of work finished |
| `agent_before_settle` (other outcome, or `continue`) | `error` (`Stopped: <outcome>`) / stays `working` |
| `session_shutdown` | `clear` — drop our record |

## Enablement

Emission is optimistic per the spec (programs may report without asking, and
terminals that do not implement OSC 7501 ignore it). Trebol additionally
gates on a TTY check: stderr must be a terminal and `TERM` must not be
`dumb`. Override with `TREBOL_PROGRAM_STATUS=1` (force on) or
`TREBOL_PROGRAM_STATUS=0` (force off).

The interactive support query (`OSC 7501 ; ?`) is intentionally not used:
reading the terminal's reply would require racing the TUI for stdin.

## Code

- Emitter: `.pi/lib/runtime/program-status.ts` (`ProgramStatusReporter`,
  `buildProgramStatusSequence`)
- Extension: `extensions/swarm-program-status/extension.ts` (registered in
  the root `package.json` `pi.extensions` list)
- Tests: `.pi/test/runtime/program-status.test.ts`,
  `.pi/test/ui/swarm-program-status.test.ts`

## Known limitations

- Single root record per process: concurrent sessions in one Pi process share
  the record and the last reporter wins. The emitter supports hierarchical
  `id`s; per-session child records are future work once a clean child-session
  lifecycle signal exists.
- `blocked` currently covers `ask_user_question` (`kind=question`). Native
  tool approval prompts have no Pi extension event to observe; if one is
  added, map it to `kind=permission`.
