--!strict
-- Window half: launches Code Puppy as an ordinary terminal pane. Code Puppy
-- is not an omp TSP agent, so cx.agents:start/ask/wait would promise unsupported
-- prompt delivery and transcript semantics. No prompts are injected here.

local COMMAND = "code-puppy"
local KV_PANE = "last_pane"

local function last_pane(): number?
	local v = tern.kv.get(KV_PANE)
	if type(v) == "number" then
		return v
	end
	return nil
end

tern.command({
	id = "start",
	title = "Start Code Puppy",
	icon = "sparkle",
	group = "Code Puppy",
	run = function(cx)
		local pane = cx.layout:new_tab({ command = COMMAND })
		if pane == nil then
			cx:toast("error", "Code Puppy", "could not open a new pane")
			return
		end
		tern.kv.set(KV_PANE, pane)
		cx:toast("info", "Code Puppy started", "pane " .. tostring(pane))
	end,
})

tern.command({
	id = "status",
	title = "Code Puppy status",
	icon = "sparkle",
	group = "Code Puppy",
	run = function(cx)
		local pane = last_pane()
		if pane == nil then
			cx:toast("info", "Code Puppy", "no pane started yet")
			return
		end
		for _, p in cx.session:panes() do
			if p.id == pane then
				cx:toast("info", "Code Puppy", p.title or "pane is open")
				return
			end
		end
		cx:toast("info", "Code Puppy", "pane " .. tostring(pane) .. " is gone")
	end,
})

tern.command({
	id = "interrupt",
	title = "Interrupt Code Puppy turn",
	icon = "sparkle",
	group = "Code Puppy",
	run = function(cx)
		local pane = last_pane()
		if pane ~= nil then
			cx:run(pane, "\003")
		end
	end,
})

tern.command({
	id = "stop",
	title = "Stop Code Puppy pane",
	icon = "sparkle",
	group = "Code Puppy",
	run = function(cx)
		local pane = last_pane()
		if pane ~= nil then
			cx.layout:close(pane)
			tern.kv.set(KV_PANE, nil)
		end
	end,
})
