--!nonstrict
-- Window half: palette commands that open the host block. All MCP work happens in the block, through `pi mcp`.

tern.command({
	id = "add",
	title = "Add MCP server",
	icon = "extension",
	group = "MCP",
	run = function(cx)
		if cx:new_block("mcp.servers", { "add" }, "beside") == nil then
			cx:toast("error", "MCP", "the mcp plugin's block is not available on this host")
		end
	end,
})

tern.command({
	id = "servers",
	title = "MCP servers",
	icon = "extension",
	group = "MCP",
	run = function(cx)
		if cx:new_block("mcp.servers", {}, "beside") == nil then
			cx:toast("error", "MCP", "the mcp plugin's block is not available on this host")
		end
	end,
})
