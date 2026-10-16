# Terraform Plans

`terraform` turns the human-readable output of `terraform plan` and
`tofu plan` into a native view: summary badges, diagnostics with their
source excerpt, and the planned resources grouped by action, the
destructive groups first. Clicking a resource copies its address. It is the
example for a command lens with its own stylesheet.

## What it demonstrates

| Surface | Half | Used for |
| --- | --- | --- |
| `[[lenses]]` `match` globs | Manifest | Claiming `terraform plan`, `tofu plan` and their `-chdir=` forms |
| `tern.lens.define` with `open`, `line`, `finish`, `view` | Host | Parsing the plan line by line and drawing it |
| `ui.badge`, `ui.section`, `ui.diagnostic`, `ui.overflow` | Host | Summary, groups, errors and warnings, long groups |
| `actions = { click = … }` on a node, lens `event` | Host | Copying a resource address on click |
| `EffectCx:copy`, `EffectCx:toast` | Host | The clipboard and the confirmation |
| `role` props and `styles` in the manifest | Both | Coloring rows by action, marking destructive plans |

The plugin has no window half: lens views and their CSS are all it needs.
The stylesheet is still loaded by each window, because CSS is a window
concern.

## Install

```sh
tern plugin install github.com/stencil-hq/tern-sdk/plugins/examples/terraform
```

While you change it, clone the SDK and link the folder instead, so Tern
reloads it on every save:

```sh
git clone https://github.com/stencil-hq/tern-sdk
tern plugin link tern-sdk/plugins/examples/terraform
```

Lenses need shell integration (it reports each command line) and the
`command_lenses` setting, both on by default. Run `terraform plan` in a
project; the block's **Raw** toggle still shows the original output.

## Design

### What it claims, and what it leaves alone

A lens claim is declarative. Every replica of a pane (the daemon, each
window, iOS, the web client) has to agree on which commands become lens
blocks, but only the host runs Lua, so the decision is made from the
manifest's `match` globs against the program and its arguments joined by
single spaces. `open` cannot decline a command the globs matched; narrowing
the globs is the only way to say no (see [Command Lenses](../guides/lenses.md)).

| Pattern | Matches |
| --- | --- |
| `terraform plan`, `terraform plan *` | A plain plan, with or without options |
| `terraform -chdir=* plan`, `terraform -chdir=* plan *` | A plan of another directory |
| `tofu …` | The same four for OpenTofu |

`terraform apply` is deliberately not claimed. Without `-auto-approve` it
prints the plan and then waits at `Enter a value:` for you to type `yes`.
Reading a line switches on none of the terminal modes that make Tern abort a
lens and replay the raw output (an alternate screen, mouse or keyboard
modes), so the native view would keep covering the question it is asking.
A plan asks only for a required variable that has no value; `-input=false`
makes it fail instead, which the lens shows as a diagnostic.

Some plans are not meant for people: `terraform plan -json` streams JSON
and `terraform plan -help` prints usage. Neither contains anything the
parser recognizes, so `view` returns `nil`, and a `nil` view leaves the
block showing the raw output.

### Reading the plan line by line

`line` is called once per output line while the command runs, and the
view is redrawn at most every 250 ms, so the parser is a small state
machine that never looks back more than one line:

| Output | What the lens records |
| --- | --- |
| `<addr>: Refreshing state...` | A count shown as "N refreshed" |
| `Note: Objects have changed outside of Terraform` | Enters the drift section |
| `Terraform will perform the following actions:` | Enters the actions section |
| `  # <addr> will be created` (and the other suffixes) | A resource with its action |
| `  # (because …)`, `  # (moved from …)` | A note on the resource above |
| `Changes to Outputs:` and `  + name` rows | Output changes |
| `Plan: N to add, M to change, K to destroy.` | The summary |
| `No changes.` | The no-changes state |
| `╷`, `│ Error: …`, `│ …`, `╵` | A diagnostic and its body |

Resource headers are matched against a table of suffixes ("will be
created", "will be updated in-place", "must be replaced", "is tainted, so
must be replaced", "will be read during apply", …). The table is ordered so
that a longer suffix is tried before a shorter one it ends with, and a
`(deposed object …)` qualifier is split off into the row's note. Headers in
the drift section use a separate table ("has changed", "has been deleted"),
because those resources are not part of what the plan will do.

Diagnostics are the boxes Terraform draws with `╷`, `│` and `╵`. The first
`│ Error: title` or `│ Warning: title` line opens one; `on main.tf line 12`
gives its location, the numbered lines under it become the snippet, and the
paragraphs after that become notes. Terraform prints the paths relative to
the directory it ran in, so `open` keeps the shell's `cwd` (or the
`-chdir=` directory) and `ui.diagnostic` resolves the path against it,
which makes the location a link to the file.

`finish` records the exit status. With `-detailed-exitcode` a plan exits 2
when it has changes, so only statuses other than 0 and 2 count as a failed
plan.

### The view

The top row is the summary as badges, each with the tone of what it means:

| Badge | Tone |
| --- | --- |
| "N to import" | `info` |
| "N to add" | `success` |
| "N to change" | `warning` |
| "N to destroy" | `error` |
| "No changes" | `success` |
| "Planning" plus running counts per action, while the command runs | `pending`, `muted` |
| "Plan failed", "N errors" | `error` |
| "N warnings" | `warning` |

Below it come the diagnostics, then one collapsible `ui.section` per
action. The order is the order a reviewer reads in: Destroy, Replace,
Update in place, Create, then the quieter Import, Move, Forget and Read.
Each section has a `key` naming its action, so its identity does not shift
when another group appears above it while the plan streams in.
Read-during-apply data sources and the drift section ("Changed outside
Terraform") start collapsed: they explain the plan but are not changes it
makes. A group longer than 200 rows ends with `ui.overflow`, the "… N more"
line that points at Raw.

### Copying an address

Each resource row is a text node whose props carry a click action:

```lua
local p: { [string]: any } = node.p or {}
p.actions = { click = "copy-address=" .. r.addr }
node.p = p
```

A click arrives in the lens's `event` handler as
`{ev = "action", act = "copy-address", value = "<addr>"}`. Only the first
`=` separates the action name from its value, so addresses such as
`terraform_data.item["a=b"]` arrive intact in `ev.value`. The handler uses
that value without splitting or decoding it:

```lua
if ev.ev == "action" and ev.act == "copy-address" and type(ev.value) == "string" then
	cx:copy(ev.value)
	cx:toast("success", "Copied resource address", ev.value)
end
```

The event's `EffectCx` delivers the copy and toast to the
windows showing the pane. Lens state lives on the host worker for the last
256 captures per plugin; clicking an older block replays `open`, `line` and
`finish` over its saved output first, so the click works after a daemon
restart too.

### Styling through roles

The plugin never styles by position or by Tern's internal class names
alone. Every rule is scoped to the lens block's role,
`.sf-block[data-role='lens.plugin.terraform.plan']`, and the plugin sets
its own roles on the nodes it wants to target:

| Role | Node | Style |
| --- | --- | --- |
| `terraform.plan` | The view's root | None |
| `terraform.plan.danger` | The root, when anything is destroyed or replaced | A red rule down the left edge |
| `terraform.<action>` | Each resource row | `--tc` set to the action's tone, used by the hover highlight |

Colors come from Tern's tone variables (`--sf-ok`, `--sf-warn`, `--sf-bad`,
`--sf-info`, `--sf-muted`), so light and dark themes both follow. The file
is listed under `styles` in the manifest and installed as the global sheet
`plugin:local:terraform:styles`; see [Chrome and Styling](../guides/chrome.md).

## Limits

- The parser reads Terraform's human output, which is not a stable
  interface; a future release that rewords a header leaves that resource
  out (the summary line still counts it).
- Resources are grouped by action only, not by module.
- A plan that stops at a `var.name Enter a value:` prompt hides the prompt
  until you switch to Raw; run plans with `-input=false` or a `.tfvars` file.
- Plans of more than 200 resources in one action show the first 200 and a
  pointer to Raw.

## Code

`plugin.toml`:

```toml
schema = 1
id = "terraform"
name = "Terraform"
version = "1.0.0"
description = "Reads terraform and tofu plans as summary badges and resources grouped by action."
icon = "stack"
host = "host.luau"
styles = ["terraform.css"]

[[lenses]]
id = "plan"
match = [
	"terraform plan",
	"terraform plan *",
	"terraform -chdir=* plan",
	"terraform -chdir=* plan *",
	"tofu plan",
	"tofu plan *",
	"tofu -chdir=* plan",
	"tofu -chdir=* plan *",
]
```

`host.luau`:

```lua
--!strict
-- The `plan` lens: Terraform's (and OpenTofu's) human-readable plan output
-- as summary badges, diagnostics and resources grouped by action. Clicking a
-- resource copies its address.

local ui = tern.ui

-- Rows shown per group before the rest fold into "… N more".
local GROUP_ROWS = 200

-- The diagnostic box Terraform draws around errors and warnings.
local BOX_SIDE = "│"
local BOX_END = "╵"

type Resource = { addr: string, action: string, note: string? }
type Output = { sym: string, name: string }
type Diagnostic = {
	severity: string,
	title: string,
	path: string?,
	line: number?,
	snippet: { any }?,
	notes: { string },
	para: string?,
}
type State = {
	base: string?,
	tool: string,
	section: string,
	resources: { Resource },
	drift: { Resource },
	outputs: { Output },
	summary: { [string]: number }?,
	nochanges: boolean,
	refreshed: number,
	diags: { Diagnostic },
	open: Diagnostic?,
	header: boolean,
	status: number?,
}

-- Resource headers (`# <addr> <suffix>`), longest suffix first where one
-- ends another.
local ACTIONS = {
	{ " is tainted, so must be replaced", "replace" },
	{ " will be replaced, as requested", "replace" },
	{ " must be replaced", "replace" },
	{ " will be created", "create" },
	{ " will be updated in-place", "update" },
	{ " will be destroyed", "destroy" },
	{ " will be read during apply", "read" },
	{ " will be imported", "import" },
	{ " will no longer be managed by Terraform", "forget" },
	{ " will no longer be managed by OpenTofu", "forget" },
}

-- Headers of the "Objects have changed outside of Terraform" section.
local DRIFT = {
	{ " has been deleted", "deleted" },
	{ " has changed", "changed" },
}

-- Groups in the order a reviewer reads them: what is lost first.
local GROUPS = {
	{ action = "destroy", title = "Destroy", sym = "-", style = "error" },
	{ action = "replace", title = "Replace", sym = "-/+", style = "warning" },
	{ action = "update", title = "Update in place", sym = "~", style = "warning" },
	{ action = "create", title = "Create", sym = "+", style = "success" },
	{ action = "import", title = "Import", sym = "<-", style = "info" },
	{ action = "move", title = "Move", sym = "->", style = "muted" },
	{ action = "forget", title = "Forget", sym = "/", style = "muted" },
	{ action = "read", title = "Read during apply", sym = "<=", style = "info" },
}

local function starts(s: string, prefix: string): boolean
	return string.sub(s, 1, #prefix) == prefix
end

local function ends(s: string, suffix: string): boolean
	return #s >= #suffix and string.sub(s, -#suffix) == suffix
end

-- The directory relative paths in diagnostics resolve against: the shell's
-- working directory, or the `-chdir=` one.
local function base_dir(run: LensRun): string?
	for _, arg in run.args do
		local dir = string.match(arg, "^%-chdir=(.+)$")
		if dir then
			if starts(dir, "/") or run.cwd == nil then
				return dir
			end
			return run.cwd .. "/" .. dir
		end
	end
	return run.cwd
end

-- The resource a `# …` header line announces, if it is one.
local function header(body: string, section: string): Resource?
	if section == "drift" then
		for _, pair in DRIFT do
			if ends(body, pair[1]) then
				return { addr = string.sub(body, 1, #body - #pair[1]), action = pair[2] }
			end
		end
		return nil
	end
	local from, to = string.match(body, "^(.-) has moved to (.+)$")
	if from and to then
		return { addr = to, action = "move", note = "moved from " .. from }
	end
	for _, pair in ACTIONS do
		if ends(body, pair[1]) then
			local addr = string.sub(body, 1, #body - #pair[1])
			local base, deposed = string.match(addr, "^(.-) %((deposed object %w+)%)$")
			if base and deposed then
				return { addr = base, action = pair[2], note = deposed }
			end
			return { addr = addr, action = pair[2] }
		end
	end
	return nil
end

-- Ends the paragraph a diagnostic is collecting.
local function flush(d: Diagnostic)
	if d.para then
		table.insert(d.notes, d.para)
		d.para = nil
	end
end

-- One line from inside a diagnostic box.
local function absorb(d: Diagnostic, body: string)
	local path, line = string.match(body, "^%s*on (.-) line (%d+)")
	if path and line and d.path == nil then
		d.path = path
		d.line = tonumber(line)
		return
	end
	local num, src = string.match(body, "^%s*(%d+): ?(.*)$")
	if num and src and d.path and #d.notes == 0 and d.para == nil then
		local snippet = d.snippet
		if snippet then
			snippet[2] ..= "\n" .. src
		else
			d.snippet = { tonumber(num) :: any, src }
		end
		return
	end
	local text = string.match(body, "^%s*(.-)%s*$") or ""
	if text == "" then
		flush(d)
	elseif starts(text, "├") then
		return -- the rule above value annotations
	elseif starts(text, BOX_SIDE) then
		flush(d)
		table.insert(d.notes, (string.gsub(string.sub(text, #BOX_SIDE + 1), "^%s+", "")))
	else
		d.para = if d.para then d.para .. " " .. text else text
	end
end

local function close(state: State)
	local open = state.open
	if open then
		flush(open)
		state.open = nil
	end
end

-- A clickable resource row: its symbol, address and note.
local function resource_row(r: Resource, sym: string, style: string): Node
	local spans: { Span | string } = { ui.span(sym, style .. " strong"), " ", ui.span(r.addr, "mono") }
	if r.note then
		table.insert(spans, ui.span("  " .. r.note, "muted"))
	end
	local node = ui.text(spans)
	local p: { [string]: any } = node.p or {}
	p.role = "terraform." .. r.action
	p.title = "Copy address"
	p.actions = { click = "copy-address=" .. r.addr }
	node.p = p
	return node
end

-- A collapsible group of rows, keyed so its collapsed state survives updates.
local function group(key: string, head: Spans, rows: { Node }, total: number, collapsed: boolean): Node
	if total > #rows then
		table.insert(rows, ui.overflow(total - #rows))
	end
	local node = ui.section(head, rows)
	local p: { [string]: any } = node.p or {}
	p.key = key
	p.collapsible = true
	p.collapsed = collapsed
	node.p = p
	return node
end

local function counts(state: State): { [string]: number }
	local n: { [string]: number } = {}
	for _, r in state.resources do
		n[r.action] = (n[r.action] or 0) + 1
	end
	return n
end

local function badges(state: State): { Node }
	local out: { Node } = {}
	local errors, warnings = 0, 0
	for _, d in state.diags do
		if d.severity == "error" then
			errors += 1
		else
			warnings += 1
		end
	end
	local summary = state.summary
	if summary then
		local any = false
		for _, b in
			{
				{ "import", "to import", "info" },
				{ "add", "to add", "success" },
				{ "change", "to change", "warning" },
				{ "destroy", "to destroy", "error" },
				{ "forget", "to forget", "muted" },
			}
		do
			local n = summary[b[1]] or 0
			if n > 0 then
				any = true
				table.insert(out, ui.badge(n .. " " .. b[2], b[3]))
			end
		end
		if not any then
			table.insert(out, ui.badge("No resource changes", "muted"))
		end
	elseif state.nochanges then
		table.insert(out, ui.badge("No changes", "success"))
	elseif state.status == nil then
		table.insert(out, ui.badge("Planning", "pending"))
		local n = counts(state)
		for _, g in GROUPS do
			if n[g.action] then
				table.insert(out, ui.badge(n[g.action] .. " " .. string.lower(g.title), "muted"))
			end
		end
	elseif state.status ~= 0 and state.status ~= 2 then
		-- `-detailed-exitcode` exits 2 for a plan with changes, 1 for an error.
		table.insert(out, ui.badge("Plan failed", "error"))
	end
	if #state.outputs > 0 then
		local label = if #state.outputs == 1 then " output change" else " output changes"
		table.insert(out, ui.badge(#state.outputs .. label, "info"))
	end
	if errors > 0 then
		table.insert(out, ui.badge(errors .. (if errors == 1 then " error" else " errors"), "error"))
	end
	if warnings > 0 then
		table.insert(out, ui.badge(warnings .. (if warnings == 1 then " warning" else " warnings"), "warning"))
	end
	if state.refreshed > 0 then
		table.insert(out, ui.text({ ui.span(state.refreshed .. " refreshed", "muted") }))
	end
	return out
end

local function view(state: State): Node?
	local empty = #state.resources == 0
		and #state.drift == 0
		and #state.outputs == 0
		and #state.diags == 0
		and state.summary == nil
		and not state.nochanges
	if empty then
		return nil -- not a plan we can read (`-json`, `-help`): raw output
	end

	local children: { Node } = { ui.row(badges(state)) }
	for _, d in state.diags do
		table.insert(
			children,
			ui.diagnostic({
				severity = d.severity :: any,
				message = d.title,
				path = d.path,
				line = d.line,
				snippet = d.snippet,
				notes = d.notes,
			}, state.base)
		)
	end

	local danger = false
	for _, g in GROUPS do
		local rows: { Node } = {}
		local total = 0
		for _, r in state.resources do
			if r.action == g.action then
				total += 1
				if total <= GROUP_ROWS then
					table.insert(rows, resource_row(r, g.sym, g.style))
				end
			end
		end
		if total > 0 then
			danger = danger or g.action == "destroy" or g.action == "replace"
			local head = { ui.span(g.title, "strong " .. g.style), ui.span("  " .. total, "muted num") }
			table.insert(children, group(g.action, head, rows, total, g.action == "read"))
		end
	end

	if #state.drift > 0 then
		local rows: { Node } = {}
		for i, r in state.drift do
			if i > GROUP_ROWS then
				break
			end
			table.insert(rows, resource_row(r, "!", "muted"))
		end
		local head = {
			ui.span("Changed outside " .. state.tool, "strong muted"),
			ui.span("  " .. #state.drift, "muted num"),
		}
		table.insert(children, group("drift", head, rows, #state.drift, true))
	end

	if #state.outputs > 0 then
		local rows: { Node } = {}
		for _, o in state.outputs do
			local style = if o.sym == "+" then "success" elseif o.sym == "-" then "error" else "warning"
			local spans: { Span | string } = { ui.span(o.sym, style .. " strong"), " ", ui.span(o.name, "mono") }
			table.insert(rows, ui.text(spans))
		end
		local head = { ui.span("Outputs", "strong"), ui.span("  " .. #state.outputs, "muted num") }
		table.insert(children, group("outputs", head, rows, #state.outputs, false))
	end

	local root = ui.col(children)
	local p: { [string]: any } = root.p or {}
	p.role = if danger then "terraform.plan.danger" else "terraform.plan"
	root.p = p
	return root
end

tern.lens.define("plan", {
	open = function(run: LensRun, _cx: EffectCx): State
		return {
			base = base_dir(run),
			tool = if run.program == "tofu" then "OpenTofu" else "Terraform",
			section = "",
			resources = {},
			drift = {},
			outputs = {},
			summary = nil,
			nochanges = false,
			refreshed = 0,
			diags = {},
			open = nil,
			header = false,
			status = nil,
		}
	end,

	line = function(state: State, l: LensLine)
		local text = l.text

		-- Diagnostics: `╷`, then `│ Error: title` and its body, then `╵`.
		if starts(text, BOX_SIDE) then
			local body = string.gsub(string.sub(text, #BOX_SIDE + 1), "^ ", "")
			local severity, title = string.match(body, "^(%a+): (.+)$")
			if (severity == "Error" or severity == "Warning") and title then
				close(state)
				local d: Diagnostic = { severity = string.lower(severity), title = title, notes = {} }
				table.insert(state.diags, d)
				state.open = d
			elseif state.open then
				absorb(state.open, body)
			end
			return
		end
		if starts(text, BOX_END) then
			close(state)
			return
		end
		local bare_sev, bare_title = string.match(text, "^(%a+): (.+)$")
		if (bare_sev == "Error" or bare_sev == "Warning") and bare_title then
			-- Without the box (older releases): the title alone.
			table.insert(state.diags, { severity = string.lower(bare_sev), title = bare_title, notes = {} })
			return
		end

		-- Section markers.
		if starts(text, "Note: Objects have changed outside of ") then
			state.section = "drift"
		elseif string.find(text, "^%a+ will perform the following actions:") then
			state.section = "actions"
		elseif text == "Changes to Outputs:" then
			state.section = "outputs"
			return
		end

		-- Resource headers and the `# (because …)` notes right under them.
		local body = string.match(text, "^%s*# (.+)$")
		if body then
			local note = string.match(body, "^%((.*)%)$")
			local last = state.resources[#state.resources]
			if note then
				if state.header and last and last.note == nil then
					last.note = note
				end
				return
			end
			local r = header(body, state.section)
			if r then
				table.insert(if state.section == "drift" then state.drift else state.resources, r)
				state.header = state.section ~= "drift"
				return
			end
		end
		state.header = false

		if state.section == "outputs" then
			local sym, name = string.match(text, "^  ([%+~%-]) ([%w_%-]+)")
			if sym and name then
				table.insert(state.outputs, { sym = sym, name = name })
			elseif text ~= "" and not starts(text, " ") then
				state.section = ""
			end
		end

		local plan = string.match(text, "^Plan: (.+)$")
		if plan then
			local summary: { [string]: number } = {}
			for n, what in string.gmatch(plan, "(%d+) to (%a+)") do
				if n and what then
					summary[what] = tonumber(n) or 0
				end
			end
			state.summary = summary
		elseif starts(text, "No changes.") then
			state.nochanges = true
		elseif string.find(text, ": Refreshing state...", 1, true) then
			state.refreshed += 1
		end
	end,

	finish = function(state: State, status: number?)
		close(state)
		state.status = status
	end,

	view = view,

	event = function(_state: State, ev: UiEvent, cx: EffectCx)
		if ev.ev ~= "action" or ev.act ~= "copy-address" or type(ev.value) ~= "string" then
			return
		end
		cx:copy(ev.value)
		cx:toast("success", "Copied resource address", ev.value)
	end,
})
```

`terraform.css`:

```css
/* The terraform plan lens. Every rule is scoped by the lens block's role, so
   the sheet touches nothing else; colors come from Tern's tone variables, so
   light and dark themes both follow. */

/* A plan that destroys or replaces something: a red rule down its view. */
.sf-block[data-role='lens.plugin.terraform.plan'] [data-role='terraform.plan.danger'] {
	box-shadow: inset 2px 0 0 rgb(from var(--sf-bad) r g b/70%);
	padding-left: 10px;
}

/* Resource rows take their action's color as --tc. */
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role^='terraform.'] {
	--tc: var(--sf-muted);
	border-radius: 4px;
	padding: 0 4px;
}
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.create'] {
	--tc: var(--sf-ok);
}
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.update'],
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.replace'] {
	--tc: var(--sf-warn);
}
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.destroy'] {
	--tc: var(--sf-bad);
}
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.read'],
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role='terraform.import'] {
	--tc: var(--sf-info);
}

/* A click copies the address: say so on hover. */
.sf-block[data-role='lens.plugin.terraform.plan'] .sf-text[data-role^='terraform.']:hover {
	background: rgb(from var(--tc) r g b/12%);
	box-shadow: inset 2px 0 0 var(--tc);
}
```
