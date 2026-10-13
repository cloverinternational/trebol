# Extending Carly

Desktop window plugins extend Carly's stateful Lua tool with functions, not
JSON-schema tools. Every loaded local window plugin's registered exports and
request context are available to Carly by default. Host-only and remote plugins
cannot supply these integrations.

## Built-in window tools

Carly can inspect and operate on the active Tern window without a plugin:

- `inspect` lists sessions, hosts, tabs, panes, agents and processes; `object="block"`
  returns typed state for screen, board, Markdown, browser and other blocks.
  `read_block` returns their contents.
- `inspect object="settings"` lists every persisted setting as a dotted key with
  its value, type, choices, range and description. `configure` applies a patch of
  those keys; nested objects and dotted paths are accepted.
- `session` switches, creates, renames and closes sessions. `arrange` regroups,
  renames and recolors tabs. `actions` discovers and runs built-in, plugin and
  keymap actions. `processes` lists or signals local process IDs.
- `run_command`, `send_input` and `lua` open or operate blocks; the Lua
  context also exposes the full window-plugin API, including files, documents,
  boards, agents, screens, browsers, databases, hosts and processes.

## Synchronous and asynchronous results

`await(value)` returns a synchronous value unchanged, or waits for an awaitable.
For example, `cx.agents:start(...)` returns the new pane immediately and
`cx.agents:list()` returns rows; `await(cx.agents:wait(pane))` waits for a reply.
Only awaitables suspend the Lua call. `await_all` takes a list of awaitables.

## Export a function

Put registrations in your plugin's `window.luau`:

```lua
local tern = require("tern")

tern.carly.export("current", {
	sig = "() -> {pane: number?}",
	doc = "The pane currently focused in this window.",
}, function(cx, call)
	return { pane = cx.session:focused() }
end)

tern.carly.export("pwd", {
	sig = "() -> string",
	doc = "Run pwd and return its output.",
}, function(cx, call)
	tern.process.run({ "pwd" }, { timeout_ms = 5000 }, function(result, fresh_cx)
		if result.status ~= 0 then
			call:fail(result.stderr)
		else
			call:reply(result.stdout)
		end
	end)
	return call:wait(6000)
end)
```

Carly discovers functions with `help()` or `help("plugins.my-plugin")` and calls:

```lua
local focused = await(plugins["my-plugin"].current())
local directory = await(plugins["my-plugin"].pwd())
return { focused = focused, directory = directory }
```

The arguments before `cx, call` are positional. Declare both trailing parameters
even when unused: omitted fixed arguments are padded with nil so optional values
do not shift the context and call handle. Too many arguments to that fixed
signature fail; variadic exports may unpack their arguments and trailing handles.
All results are awaitables,
including immediate returns. Multiple return values become an array. Values cross
VMs through JSON: tables, strings, booleans, finite numbers and null are supported;
functions, userdata, threads and cycles fail with the offending path. Encoded
values are capped at 16 KiB. A missing return and missing answer is an error;
return `nil` explicitly for a null result.

Export names match `[a-z][a-z0-9_]{0,23}`, at most 16 per plugin. Both `sig` and `doc`
are required, nonempty, and at most 1024 bytes. Registration with the same name
replaces it. Reload replaces implementations without resetting Carly's globals;
any call still waiting on the old plugin fails before that VM is dropped.

## Answer later

Functions run on the UI thread, under the plugin's 50 ms budget. Start slow work
through process, fetch or timer APIs. Return `call:wait(ms)` and answer once from a
callback with `call:reply(value)` or `call:fail(message)`. The default wait is 30000
ms, capped at 120000. Reply/fail return false after an answer, cancellation,
timeout or reload; `call.cancelled` then reads true.

The call handle survives the function. Its `cx` does not: callbacks must use the
fresh context they receive. Do not save a scoped context in a closure.

## Add request data

```lua
tern.carly.context(function(cx)
	local pane = cx.session:focused()
	return pane and ("Focused pane " .. tostring(pane)) or nil
end)
```

One provider per plugin, replaced on re-registration. `fn(cx)` returns a string
or nil. The plugin VM enforces its 4 ms budget; errors and interrupted overruns
are omitted without blocking the question. Successful results are not discarded
by a second wall-clock check. Registered providers and export names appear under a labelled **Plugins**
heading. Each plugin contributes at most 400 characters, with 1600 total.

## Ask from a plugin

```lua
tern.command({
	id = "explain",
	title = "Ask Carly about this pane",
	run = function(cx)
		cx:ask_carly("Explain the failure in this pane.")
	end,
})
```

`cx:ask_carly(text)` opens Carly and submits a shown, nonempty question from any
window-plugin context, including callbacks, exports and Carly's own context.

`cx:action(name)` lets a plugin or Carly run any action name, including another
loaded plugin's `plugin.<id>.<command>`, built-in commands, keymap actions and
focused-view actions.

## Schedule reminders and watches

Every loaded desktop window plugin can call `tern.carly.schedule(spec)` from a
scoped window callback. Plugin-created tasks record `by = "plugin:<id>"`.
Carly's Lua tool has the same API. Tasks persist across reloads and launches and
run only in their creating window. Use `tern.carly.tasks()` to list all windows'
tasks and
`tern.carly.cancel(id)` to delete one; a missing id returns false. The heartbeat is
built-in task 0, managed by its interval setting rather than replaced or deleted.

```lua
-- A reminder: no check, so the due time starts a Carly turn.
local reminder = tern.carly.schedule({
	title = "Stand-up",
	when = "in 20m",
	prompt = "Remind the user that stand-up starts now.",
})

-- A cheap watch: no model call until a matching command finishes.
tern.carly.schedule({
	title = "Build finished",
	on = "command_finished",
	pane = 14,
	check = [[return function(ev, cx, state)
		if ev.ev == "command_finished" and ev.pane == 14 then
			return {line = ev.line, status = ev.status}
		end
	end]],
	prompt = "The build in pane 14 finished. Read it and summarize the result.",
})
```

A `TaskSpec` has `title`, exactly one of `when`/`on`, optional `check` source,
`prompt`, anchor `pane`, `once`, event-watch `expires`, and replacement `id`.
Time forms are `in 20m`, `at 15:00`, `at 2026-10-04 09:00`, `every 30m`,
`daily 09:00`, `weekdays 09:00`, and `mon,thu 18:30`. Recurring intervals must be at
least five minutes when they can start model turns, or one minute for promptless
checks. Event tasks require a check or pane and expire after 12 hours
by default (at most seven days). One-shot times and event watches default to
`once = true`. At most 50 tasks can be scheduled.

Checks are source strings returning `function(ev, cx, state)`, not closures.
Each runs synchronously in its own VM under the 50 ms budget; do not await.
`state` persists as JSON. `nil` is quiet, `false` ends the task, and a string or
table with `prompt` starts a turn. A string without a prompt becomes an alert
without a model call. Without a check, every fire starts a turn. A check also
receives `dry_run` on creation and `resume` after a window reopens; compare current
pane state with a saved baseline when watching work across restarts. The example
above reacts only to live command-finished events, not resume.
Invalid specs, compilation and dry-run failures raise an error naming the field.

**Settings › Carly › Scheduled**, or the `carly_tasks` action, manages tasks and
shows the last ten runs. `TaskInfo` includes the spec, id, creating `window`, `by`
(`carly`, `user`, `plugin:<id>` or `heartbeat`), `paused`, next RFC 3339 time and
`runs` with `at`, `outcome` (`quiet`, `said`, `failed`, `missed`, `skipped`) and
optional `text`.

## API capabilities

Installing a plugin means trusting its local code. An export receives a fresh
ordinary window-plugin `cx`; its shared APIs and later callbacks have the normal
plugin capabilities and budgets. Carly's own Lua tool can also read environment
variables, read and write files, run programs, fetch URLs, type into any specified
pane and manipulate the window through these APIs. There is no separate Carly
approval or per-turn access tier.

Normal argument validation, lookup errors, operation failures, timeouts and
resource limits still apply. Reloading does not reset Carly's conversation-local VM.

See the [Window API](../reference/api-window.md#carly-exports-and-request-context)
and [action names](../reference/actions.md).
