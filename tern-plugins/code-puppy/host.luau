--!strict
-- Host half: a status block. Runs `which code-puppy` on the pane's machine
-- and shows the result. Handles no agent I/O (cx.agents is window-only).

local ui = tern.ui

type S = { found: string?, checked: boolean }

local function check(state: S, cx: BlockCx)
	tern.process.run({ "sh", "-c", "command -v code-puppy" }, { cwd = cx.cwd, timeout_ms = 5000 }, function(r)
		state.found = if r.status == 0 then (string.gsub(r.stdout, "%s+$", "")) else nil
		state.checked = true
		cx:render()
	end)
end

local def: BlockDef<S> = {
	init = function(cx, _args, _saved)
		local state: S = { found = nil, checked = false }
		check(state, cx)
		return state
	end,
	view = function(state, _cx)
		local line
		if not state.checked then
			line = "Checking for code-puppy..."
		elseif state.found then
			line = "code-puppy: " .. state.found
		else
			line = "code-puppy not found on PATH. Install it, then press r."
		end
		return {
			main = ui.col({
				ui.text({ ui.span(line) }),
				ui.text({ ui.span("Use the Code Puppy commands in the palette to start a pane.", "muted") }),
			}),
		}
	end,
	key = function(state, key, cx)
		if key.name == "r" then
			state.checked = false
			check(state, cx)
			return true
		end
		return false
	end,
}

tern.block.define("status", def)
