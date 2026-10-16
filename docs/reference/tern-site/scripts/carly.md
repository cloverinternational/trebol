# Carly

Carly commands put the assistant into conversation, tool, voice and scheduled
 task states for scripts and screenshots, or run her real Tern tools. Use
 simulated turns to exercise her UI without omp, and tool calls to inspect or
 change the window without an agent. This family is desktop-only; headless
 windows never start omp.

## Opening and attachments

| Command | Does |
| --- | --- |
| `carly open` | Opens Carly through her normal opening behavior. |
| `carly close` | Closes Carly. |
| `carly new` | Starts a new conversation, resetting its Lua environment and canvas handlers. |
| `carly paste text "<text>"` | Pastes clipboard text into her input. |
| `carly paste image <width> <height>` | Pastes a solid gray bitmap of the given pixel dimensions. |
| `carly paste file "<path>"` | Pastes a file attachment from the given clipboard path. |

Paste opens Carly first if her input is not already accepting paste. Image
 dimensions are unsigned 32-bit integers; text and file paths must be nonempty.
 The file form supplies a clipboard path rather than opening a file block.
 Conversation reset does not remove durable canvases.

Inspect `state.carly.open`, `peek`, `target`, `field` and `attachments` for the
 resulting presentation and input.

## Conversation and steps

| Command | Does |
| --- | --- |
| `carly ask "<text>"` | Submits a question and marks its turn started. |
| `carly queue "<text>"` | Submits a question without simulating its start. |
| `carly stream "<markdown>"` | Supplies the answer so far for the turn underway. |
| `carly reply "<markdown>"` | Starts and finishes a user turn with the final answer. |
| `carly fail "<message>"` | Finishes the user turn with an error, including a waiting question. |
| `carly step run\|ok\|bad ["<label>"]` | Records a running, completed or failed tool step. |
| `carly command run\|ok\|bad ["<command line>"]` | Records the same step states, displayed as a shell command. |

These commands supply conversation events; `command` does not execute its
 command line. Repeating a step label updates that step. Text for `ask`,
 `queue`, `stream`, `reply` and `fail` must contain non-whitespace characters;
 step labels may be empty. In a real window, submitting a question can also
 reach the running agent; the simulation does not wait for an agent answer.

`state.carly.phase` describes the current activity. `turns` holds each turn's
 `kind`, `started`, `task`, `asked`, `steps`, `unfolded`, `answer`, `error` and
 `done`. Step state values are `running`, `done` and `failed`.

```text
ready
carly open
carly ask "what sessions did I close today?"
carly step ok "Find session actions"
carly command run "ls -la ~/Library/Application Support/Tern"
shot carly-working
carly command ok "ls -la ~/Library/Application Support/Tern"
carly reply "You closed **3 sessions** today."
shot carly-answer
```

This follows the conversation and step progression in the `carly-steps`
 golden.

## Real tools and assertions

| Command | Does |
| --- | --- |
| `carly tool <name> [<json>]` | Runs a real Tern tool and stores its answer. |
| `carly lua "<code>"` | Runs the `lua` tool and displays its literal output in a conversation turn. |
| `carly context` | Stores the context a question asked now would carry. |
| `carly last ["<contains>"]` | Displays the last tool answer or queued canvas request, optionally asserting a substring. |
| `carly ok` | Asserts that the last tool answer exists and is not an error. |

Tool arguments default to `{}`. Invalid JSON fails the command. Unknown tool
 names and tool execution errors produce error answers rather than failing
 the script: use `carly ok` to make them assertions. Lua code must be nonempty;
 its environment persists until `carly new`.

The available tool names are:

| Tool | Does |
| --- | --- |
| `inspect` | Reads structured window, sessions, hosts, tabs, panes, agents, settings, processes or block data without moving focus. |
| `configure` | Applies a validated settings patch through the normal save path. |
| `actions` | Discovers built-in and plugin actions, or runs an action by id or exact label. |
| `processes` | Lists this machine's sampled processes or signals a positive PID. |
| `session` | Lists, switches, creates, renames or closes sessions. |
| `arrange` | Renames, recolors, reorders and regroups tabs and blocks. |
| `read_block` | Reads a block's visible contents, including unsaved file text and native block data. |
| `send_input` | Sends keys, text and optionally Enter to a terminal, optionally waiting for output. |
| `run_command` | Runs a Tern command by id through its normal handler. |
| `lua` | Runs Lua against Carly's Tern APIs and registered plugin exports. |

These are real operations, not simulated tool steps. Closing sessions ends
 their programs; settings may persist in an ordinary window. Process tools
 target the local machine, not remote hosts; Windows supports only terminate
 and kill signals.

Pending tools settle before the script advances, using real elapsed time.
 Process inspection waits up to 10 seconds for its first sample. `send_input`
 defaults `wait_ms` to zero and caps it at 120000; a submitted command may
 finish early once shell completion arrives, after at least 250 ms. Its
 deadline returns the terminal's last lines, possibly reporting that the
 command is still running, rather than treating the deadline as an error.
 A closed target returns an error answer. The script harness's general
 20-second settling timeout still applies to pending commands.

`state.carly.last_tool` holds `{ "text": …, "error": … }`. `context` uses
 Carly's target block, falling back to the focused block. `last` fails if
 no answer exists or its text does not contain the requested substring; it
 can display an error answer. `ok` fails on a missing or error answer.

```text
ready
carly open
carly lua "scratch = 41; print('hello', 'Lua'); return {answer = scratch + 1, ok = true}"
carly ok
carly lua "scratch += 1; return scratch"
carly last "42"
shot carly-lua-persistence
carly new
carly lua "return scratch == nil"
carly ok
```

This uses the persistent Lua state and reset exercised by `carly-lua`.
 See [Extending Carly](../guides/carly.md) for her Lua APIs.

## Voice

| Command | Does |
| --- | --- |
| `carly voice connecting\|listening\|speaking\|working\|muted\|error\|off [<level>]` | Sets the voice presentation and meter level; `off` clears the voice state. |
| `carly heard "<text>"` | Supplies a final recognized voice transcript. |
| `carly said "<text>"` | Supplies final spoken answer text. |

These simulate voice events without connecting a microphone or voice service.
 The level defaults to `0.0`, including when its argument is not a number.
 The visual meter caps it at `1.0`; `state.carly.voice.level` retains the
 supplied value. `state.carly.voice` is null when off, otherwise contains
 `phase` and `level`; voice conversation events also affect `turns`.
 `heard` and `said` require non-whitespace text.

## Scheduled tasks

| Command | Does |
| --- | --- |
| `carly task add <json>` | Validates and adds a task from the scheduling API's JSON specification, attributed to the user. |
| `carly task fire <id>` | Fires a task's check or model turn immediately. |
| `carly task run <id> ["<text>"]` | Simulates successful completion of that task's turn, starting it first if needed. |
| `carly task fail <id> ["<message>"]` | Simulates a failed task turn, starting it first if needed. |
| `carly task event command_finished <pane> <status> ["<line>"]` | Delivers a simulated shell completion to scheduled task checks. |

Task ids are unsigned 32-bit integers; `0` is the built-in heartbeat. Pane
 ids are unsigned 64-bit integers, and exit statuses are signed 32-bit
 integers. Completion text, error messages and command lines may be empty.
 The simulated completion event has a fixed duration of 1200 ms; it does
 not run a shell command.

An `add` specification requires a string `title` and either `when` or `on`,
 not both. It accepts `id`, `check`, `prompt`, `pane`, `once`, `paused` and
 event `expires`. `once` defaults to true for one-shot and event triggers,
 otherwise false; `paused` defaults to false. Event expiry defaults to `12h`
 and must fall within the next seven days. Task id `0` cannot be added or
 replaced this way. Invalid specifications and checks fail the command;
 checks are compiled and dry-run before the task is stored. The new id is
 returned in `state.carly.last_tool.text`.

`fire` preserves retry behavior when Carly is occupied; it does not wait for
 a model answer. `run` and `fail` route their completion to the named task,
 not a queued user question. `HEARTBEAT_OK` is a quiet completion. Successful
 one-shot tasks complete their schedule; failures record a failed outcome.
 Ordinary windows persist schedules; ephemeral headless sessions do not.
 See `state.carly.tasks`, `peek` and task-tagged `turns` for the results, and
 [Extending Carly](../guides/carly.md) for scheduling specifications.

## See also

- [Scripts](index.md): running, syntax and settling rules.
- [Extending Carly](../guides/carly.md): tools, Lua and scheduled checks.
- [Sessions and Blocks](sessions.md): the blocks Carly works with.
- [Harness Commands](harness.md): input and screenshots.
