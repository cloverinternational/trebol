--!nonstrict
-- Host half: the `mcp.servers` block.
--
-- Pi owns MCP. This block never edits mcp.json itself: it lists with `pi mcp list --json`, adds with
-- `pi mcp add`, signs in with `pi mcp login` and removes with `pi mcp remove`, run directly (no shell) in the
-- pane's directory. What it adds is a way in that fits a terminal: paste a server's JSON from its README, a URL,
-- or `name -- command args`, pick global or this project, press Enter. Literal secrets need a second Enter.
-- Running Pi sessions read mcp.json at start, so they see a new server after /reload (Pi's /mcp-add reloads).

local ui = tern.ui
local M = {}

-- Converter (mirrors .pi/lib/tools/mcp-add.ts; Pi validates the result) -------------------------------------

local KNOWN = { type = true, command = true, args = true, url = true, env = true, headers = true, cwd = true, exposure = true, description = true }
local SECRETISH = { "token", "secret", "password", "passwd", "api_key", "api-key", "apikey", "auth", "bearer", "credential" }

function M.tokenize(text: string): { string }
	local out, cur, started, quote = {}, {}, false, nil
	local i, n = 1, #text
	while i <= n do
		local c = text:sub(i, i)
		if quote then
			if c == quote then
				quote = nil
			elseif c == "\\" and quote == '"' and i < n then
				i += 1
				table.insert(cur, text:sub(i, i))
			else
				table.insert(cur, c)
			end
		elseif c == "'" or c == '"' then
			quote, started = c, true
		elseif c == "\\" and i < n then
			i += 1
			table.insert(cur, text:sub(i, i))
			started = true
		elseif c:match("%s") then
			if started then
				table.insert(out, table.concat(cur))
			end
			cur, started = {}, false
		else
			table.insert(cur, c)
			started = true
		end
		i += 1
	end
	if started then
		table.insert(out, table.concat(cur))
	end
	return out
end

function M.literal_secret(key: string, value: string): boolean
	if value:sub(1, 1) == "!" or value:find("%$%{?[%a_]") then
		return false
	end
	local lower = key:lower()
	for _, word in SECRETISH do
		if lower:find(word, 1, true) then
			return true
		end
	end
	if value:match("^[Bb]earer%s+%S%S%S%S%S%S%S%S") or value:match("^[Tt]oken%s+%S%S%S%S%S%S%S%S") then
		return true
	end
	return #value >= 24 and value:match("^[%w_%-%.]+$") ~= nil
end

function M.name_from_url(url: string): string?
	local host = url:match("^https?://([^/:?#]+)")
	if not host then
		return nil
	end
	local labels = {}
	for label in host:gmatch("[^%.]+") do
		if label ~= "www" and label ~= "mcp" and label ~= "api" and label ~= "app" and label ~= "server" then
			table.insert(labels, label)
		end
	end
	local name = if #labels > 1 then labels[#labels - 1] else labels[1]
	return if name then (name:gsub("[^%w_%-]", "-")) else nil
end

local function from_config(name: string, config: any, warnings: { string }, secrets: { string })
	if type(config) ~= "table" then
		return nil, `server "{name}" must be an object`
	end
	local args = { name }
	local keys = {}
	for key in config do
		table.insert(keys, key)
	end
	table.sort(keys)
	for _, key in keys do
		if not KNOWN[key] then
			table.insert(warnings, `{name}: ignored "{key}" (Pi's mcp.json has no such field)`)
		end
	end
	local function pairs_of(flag: string, map: any): string?
		if map == nil then
			return nil
		end
		if type(map) ~= "table" then
			return `server "{name}": {flag:sub(3)} must be an object`
		end
		local names = {}
		for k in map do
			table.insert(names, k)
		end
		table.sort(names)
		for _, k in names do
			local value = tostring(map[k])
			if M.literal_secret(k, value) then
				table.insert(secrets, `{name}: {if flag == "--env" then "env" else "header"} {k}`)
			end
			table.insert(args, flag)
			table.insert(args, `{k}={value}`)
		end
		return nil
	end
	if type(config.exposure) == "string" then
		table.insert(args, "--exposure")
		table.insert(args, config.exposure)
	end
	if type(config.description) == "string" then
		table.insert(args, "--description")
		table.insert(args, config.description)
	end
	if type(config.url) == "string" then
		table.insert(args, "--url")
		table.insert(args, config.url)
		local err = pairs_of("--header", config.headers)
		if err then
			return nil, err
		end
	elseif type(config.command) == "string" then
		local err = pairs_of("--env", config.env)
		if err then
			return nil, err
		end
		if type(config.cwd) == "string" then
			table.insert(args, "--cwd")
			table.insert(args, config.cwd)
		end
		table.insert(args, "--")
		table.insert(args, config.command)
		if type(config.args) == "table" then
			for _, a in config.args do
				table.insert(args, tostring(a))
			end
		end
	else
		return nil, `server "{name}" needs "url" or "command"`
	end
	return { name = name, args = args }, nil
end

-- Returns { requests = {{name, args}}, warnings, secrets } or nil, error.
function M.parse(input: string)
	local text = input:match("^%s*(.-)%s*$")
	if text == "" then
		return nil, "Paste a server's JSON, a URL, or `name -- command args`."
	end
	local warnings, secrets = {}, {}
	local first = text:sub(1, 1)
	if first == "{" or first == '"' then
		local ok, root = pcall(tern.json.decode, text)
		if not ok then
			ok, root = pcall(tern.json.decode, "{" .. text:gsub(",%s*$", "") .. "}")
		end
		if not ok or type(root) ~= "table" then
			return nil, "Not valid JSON."
		end
		local servers = root.mcpServers or root.servers or root
		if type(servers) ~= "table" then
			return nil, "Expected an object of servers."
		end
		if servers.command ~= nil or servers.url ~= nil then
			return nil, 'This is one server without a name; wrap it as {"name": {...}}.'
		end
		local names = {}
		for name in servers do
			table.insert(names, name)
		end
		table.sort(names)
		local requests = {}
		for _, name in names do
			local request, err = from_config(name, servers[name], warnings, secrets)
			if not request then
				return nil, err
			end
			table.insert(requests, request)
		end
		if #requests == 0 then
			return nil, "The JSON lists no servers."
		end
		return { requests = requests, warnings = warnings, secrets = secrets }, nil
	end
	local tokens = M.tokenize(text)
	if tokens[1] == "pi" and tokens[2] == "mcp" then
		tokens = { table.unpack(tokens, 3) }
	end
	if tokens[1] == "add" then
		tokens = { table.unpack(tokens, 2) }
	end
	if #tokens == 1 and tokens[1]:match("^https?://") then
		local name = M.name_from_url(tokens[1])
		if not name then
			return nil, `Cannot name a server from {tokens[1]}; write "name {tokens[1]}".`
		end
		return { requests = { { name = name, args = { name, "--url", tokens[1] } } }, warnings = warnings, secrets = secrets }, nil
	end
	if #tokens == 2 and tokens[1]:sub(1, 1) ~= "-" and tokens[2]:match("^https?://") then
		return { requests = { { name = tokens[1], args = { tokens[1], "--url", tokens[2] } } }, warnings = warnings, secrets = secrets }, nil
	end
	local name = tokens[1]
	if not name or name:sub(1, 1) == "-" then
		return nil, "Start with the server name, e.g. `docs https://example.com/mcp`."
	end
	for i, t in tokens do
		if t == "--" then
			break
		end
		if (t == "--env" or t == "--header") and tokens[i + 1] then
			local k, v = tokens[i + 1]:match("^([^=]*)=(.*)$")
			if k and M.literal_secret(k, v) then
				table.insert(secrets, `{name}: {if t == "--env" then "env" else "header"} {k}`)
			end
		end
	end
	return { requests = { { name = name, args = tokens } }, warnings = warnings, secrets = secrets }, nil
end

-- Block --------------------------------------------------------------------------------------------------

local DRAFT_ID = "main.add.draft"
local TONES = { connected = "success", failed = "error", ["needs-auth"] = "warning", disabled = "muted", disconnected = "warning" }

local function strip(s: string): string
	return (s:gsub("\27%[[%d;]*m", ""):gsub("%s+$", ""))
end

local function lines_of(s: string): { string }
	local out = {}
	for line in strip(s):gmatch("[^\n]+") do
		table.insert(out, line)
	end
	return out
end

-- `quiet` skips the immediate render (init has no view yet).
local function refresh(state, cx, quiet: boolean?)
	state.loading = true
	if not quiet then
		cx:render()
	end
	-- `list` connects to each server, and exits 1 when one fails; its JSON is on stdout either way.
	tern.process.run({ "pi", "mcp", "list", "--json" }, { cwd = state.cwd, timeout_ms = 90000 }, function(r)
		state.loading = false
		local ok, data = pcall(tern.json.decode, r.stdout)
		if ok and type(data) == "table" and type(data.servers) == "table" then
			state.servers = data.servers
			state.list_error = if type(data.errors) == "table" and #data.errors > 0 then table.concat(data.errors, "\n") else nil
		else
			state.list_error = if r.timed_out then "pi mcp list timed out" else (strip(r.stderr) ~= "" and strip(r.stderr) or "pi mcp list failed")
		end
		if state.selected == nil and state.servers[1] then
			state.selected = state.servers[1].name
		end
		cx:render()
	end)
end

local function report(state, tone: string, lines: { string })
	state.message = { tone = tone, lines = lines }
end

local function run_pi(state, cx, argv: { string }, timeout_ms: number, done: (ok: boolean, lines: { string }) -> ())
	state.busy = true
	cx:render()
	local ok, err = pcall(tern.process.run, argv, { cwd = state.cwd, timeout_ms = timeout_ms }, function(r)
		state.busy = false
		local out = lines_of(r.stdout)
		for _, line in lines_of(r.stderr) do
			table.insert(out, line)
		end
		done(r.status == 0, out)
		cx:render()
	end)
	if not ok then
		state.busy = false
		report(state, "error", { `Could not run pi: {err}`, "Install Pi (npm i -g @earendil-works/pi-coding-agent) or put it on PATH." })
		cx:render()
	end
end

local function add(state, cx)
	local parsed, err = M.parse(state.draft)
	if not parsed then
		report(state, "error", { err })
		return
	end
	if #parsed.secrets > 0 and state.confirm_secret ~= state.draft then
		state.confirm_secret = state.draft
		local lines = { "These values would be written to mcp.json in plain text:" }
		for _, s in parsed.secrets do
			table.insert(lines, "  " .. s)
		end
		table.insert(lines, "Prefer ${ENV_VAR} or !command (Pi resolves them when it connects). Press Enter again to store them anyway.")
		report(state, "warning", lines)
		return
	end
	state.confirm_secret = nil
	local results, added = {}, 0
	for _, w in parsed.warnings do
		table.insert(results, w)
	end
	local remaining = #parsed.requests
	for _, request in parsed.requests do
		local argv = { "pi", "mcp", "add", request.args[1] }
		if state.scope == "project" then
			table.insert(argv, "--local")
		end
		for i = 2, #request.args do
			table.insert(argv, request.args[i])
		end
		run_pi(state, cx, argv, 30000, function(ok, out)
			if ok then
				added += 1
			end
			for _, line in out do
				table.insert(results, line)
			end
			remaining -= 1
			if remaining == 0 then
				if added > 0 then
					table.insert(results, "Running Pi sessions connect it after /reload.")
					state.draft, state.cursor = "", 0
					state.selected = parsed.requests[1].name
					refresh(state, cx)
				end
				report(state, if added == #parsed.requests then "success" else "error", results)
			end
		end)
	end
end

local function selected_server(state)
	for _, s in state.servers do
		if s.name == state.selected then
			return s
		end
	end
	return nil
end

local function remove(state, cx)
	local s = selected_server(state)
	if not s then
		return
	end
	if state.confirm_remove ~= s.name then
		state.confirm_remove = s.name
		report(state, "warning", { `Press Delete again to remove "{s.name}" from {s.source}.` })
		return
	end
	state.confirm_remove = nil
	local argv = { "pi", "mcp", "remove", s.name }
	if s.scope == "project" then
		table.insert(argv, "--local")
	end
	run_pi(state, cx, argv, 30000, function(ok, out)
		report(state, if ok then "success" else "error", out)
		if ok then
			state.selected = nil
			refresh(state, cx)
		end
	end)
end

local function login(state, cx)
	local s = selected_server(state)
	if not s then
		return
	end
	report(state, "info", { `Signing in to "{s.name}": finish in the browser that opens.` })
	run_pi(state, cx, { "pi", "mcp", "login", s.name }, 310000, function(ok, out)
		report(state, if ok then "success" else "error", out)
		refresh(state, cx)
	end)
end

local function focus(state, cx, on: boolean)
	state.editing = on
	cx:frame({ { "focus", if on then DRAFT_ID else tern.json.null } })
end

local function server_item(s)
	local tools = if type(s.tools) == "table" then #s.tools else 0
	local detail = { ui.span(s.state or "unknown", if TONES[s.state] then TONES[s.state] else "muted"), ui.span(`  {s.exposure or ""} · {s.scope or ""}`, "dim") }
	if s.error and s.state ~= "connected" then
		table.insert(detail, ui.span("  " .. tostring(s.error):match("^[^\n]*"), "dim"))
	end
	return ui.node("item", {
		key = s.name,
		label = { ui.span(s.name, "bold") },
		detail = detail,
		value = if s.state == "connected" then `{tools} tools` else nil,
		icon = "extension",
		tone = TONES[s.state],
	})
end

local function view(state, cx)
	local servers = {}
	for _, s in state.servers do
		table.insert(servers, server_item(s))
	end
	local head = { ui.span("MCP servers", "bold") }
	if state.loading then
		table.insert(head, ui.span("  checking…", "dim"))
	else
		table.insert(head, ui.span(`  {#state.servers} configured`, "dim"))
	end
	local main = {
		ui.node("text", { key = "head", spans = head }),
		ui.node("list", {
			key = "servers",
			selected = if state.selected then "main.servers." .. state.selected else nil,
			max = { lines = 10 },
			empty = { ui.span(if state.loading then "Asking Pi…" else "No MCP servers yet. Add one below.", "dim") },
		}, servers),
	}
	if state.list_error then
		table.insert(main, ui.node("text", { key = "list-error", tone = "error", spans = { ui.span(state.list_error) } }))
	end
	local s = selected_server(state)
	if s then
		table.insert(main, ui.node("text", { key = "transport", spans = { ui.span(s.transport or "", "dim") }, wrap = "soft" }))
	end
	local function scope(value: string, label: string)
		return ui.el("label", { class = "opt" }, {
			ui.el("input", { type = "radio", name = "scope", value = value, checked = state.scope == value }),
			ui.el("span", { text = label }),
		})
	end
	local add_children = {
		ui.node("input", {
			key = "draft",
			text = state.draft,
			cursor = utf8.len(state.draft:sub(1, state.cursor)) or state.cursor,
			placeholder = 'Paste {"mcpServers": …}, a URL, or: name -- command args',
			nowrap = false,
		}),
		ui.el("form", { key = "scope", class = "scope" }, {
			scope("global", "Global  ~/.pi/agent/mcp.json"),
			scope("project", "This project  .pi/mcp.json"),
			ui.el("button", { text = if state.busy then "Adding…" else "Add", actions = { click = "add" } }),
		}),
	}
	if state.message then
		local spans = {}
		for i, line in state.message.lines do
			table.insert(spans, ui.span((if i > 1 then "\n" else "") .. line))
		end
		table.insert(add_children, ui.node("text", { key = "message", tone = state.message.tone, spans = spans, wrap = "soft" }))
	end
	local section = ui.section({ ui.span("Add a server") }, add_children)
	section.p = section.p or {}
	section.p.key = "add"
	table.insert(main, section)
	local hints = if state.editing
		then "enter add · esc leave the field · paste anywhere"
		else "↑/↓ select · a add · l sign in · del remove · r refresh"
	return {
		main = ui.node("col", { key = "main" }, main),
		dock = ui.col({ ui.text({ ui.span(hints, "dim") }) }),
	}
end

local def = {
	init = function(cx, args, saved)
		local state = {
			cwd = cx.cwd,
			servers = {},
			selected = nil,
			draft = "",
			cursor = 0,
			scope = if type(saved) == "table" and saved.scope == "project" then "project" else "global",
			editing = args[1] == "add",
			loading = false,
			busy = false,
		}
		refresh(state, cx, true)
		if state.editing then
			tern.timer(0, function()
				cx:frame({ { "focus", DRAFT_ID } })
			end)
		end
		return state
	end,
	view = view,
	title = function(state)
		return "MCP servers"
	end,
	save = function(state)
		return { scope = state.scope }
	end,
	key = function(state, key, cx)
		if key.name == "paste" and key.text then
			state.draft = state.draft:sub(1, state.cursor) .. key.text .. state.draft:sub(state.cursor + 1)
			state.cursor += #key.text
			if not state.editing then
				focus(state, cx, true)
			end
			return true
		end
		if state.editing then
			if key.name == "escape" then
				focus(state, cx, false)
			elseif key.name == "enter" and not key.shift then
				add(state, cx)
			elseif key.name == "enter" then
				state.draft = state.draft:sub(1, state.cursor) .. "\n" .. state.draft:sub(state.cursor + 1)
				state.cursor += 1
			elseif key.name == "backspace" then
				if state.cursor > 0 then
					local before = state.draft:sub(1, state.cursor)
					local last = utf8.offset(before, -1) or state.cursor
					state.draft = before:sub(1, last - 1) .. state.draft:sub(state.cursor + 1)
					state.cursor = last - 1
				end
			elseif key.name == "left" then
				state.cursor = math.max(0, (utf8.offset(state.draft:sub(1, state.cursor), -1) or 1) - 1)
			elseif key.name == "right" then
				local nxt = utf8.offset(state.draft, 2, state.cursor + 1)
				state.cursor = if nxt then nxt - 1 else #state.draft
			elseif key.name == "home" then
				state.cursor = 0
			elseif key.name == "end" then
				state.cursor = #state.draft
			elseif key.ctrl and key.name == "u" then
				state.draft, state.cursor = "", 0
			elseif key.text and key.text ~= "" and not key.ctrl and not key.meta then
				state.draft = state.draft:sub(1, state.cursor) .. key.text .. state.draft:sub(state.cursor + 1)
				state.cursor += #key.text
			else
				return false
			end
			state.confirm_secret = if state.confirm_secret == state.draft then state.confirm_secret else nil
			return true
		end
		if key.name == "up" or key.name == "down" then
			local index = 0
			for i, s in state.servers do
				if s.name == state.selected then
					index = i
				end
			end
			local n = #state.servers
			if n == 0 then
				return false
			end
			index = ((index - 1 + (if key.name == "up" then -1 else 1)) % n) + 1
			state.selected = state.servers[index].name
			state.confirm_remove = nil
		elseif key.name == "a" or key.name == "i" or key.name == "enter" then
			focus(state, cx, true)
		elseif key.name == "r" then
			refresh(state, cx)
		elseif key.name == "l" then
			login(state, cx)
		elseif key.name == "delete" or key.name == "d" then
			remove(state, cx)
		else
			return false
		end
		return true
	end,
	event = function(state, ev, cx)
		if ev.ev == "focus" and ev.id == DRAFT_ID then
			focus(state, cx, true)
		elseif (ev.ev == "select" or ev.ev == "activate") and ev.id == "main.servers" and type(ev.item) == "string" then
			state.selected = ev.item:match("^main%.servers%.(.+)$")
			state.confirm_remove = nil
		elseif ev.ev == "change" and ev.name == "scope" and type(ev.value) == "string" then
			state.scope = ev.value
		elseif ev.ev == "action" and ev.act == "add" then
			if ev.values and type(ev.values.scope) == "string" then
				state.scope = ev.values.scope
			end
			add(state, cx)
		end
	end,
}

tern.block.define("servers", def)

