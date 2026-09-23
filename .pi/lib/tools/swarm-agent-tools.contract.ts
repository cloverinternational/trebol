/** Model-facing contracts for the tools registered by this module. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const BACKGROUNDTASK_CONTRACT: ToolContract = {
  description: "Launch a background agent for long-running work that shouldn't block the conversation. Use for large-scale analysis, multi-file refactoring, or operations that may take minutes. Returns immediately with an agent_id and output_file path. Use TaskOutput(agent_id, action='result') to retrieve output, or Read the output_file directly for a live view while running. Do not duplicate the agent's work on the same files while it is running.",
  parameters: {"properties":{"agent_id":{"description":"Optional custom ID for tracking this background agent. If omitted, an ID will be auto-generated.","type":"string"},"model":{"description":"Optional model to use for the background agent.","type":"string"},"resume":{"description":"Optional agent_id of a prior BackgroundTask run to resume.","type":"string"},"system_prompt":{"description":"Optional custom system prompt for the background agent.","type":"string"},"task":{"description":"The long-running task for the background agent to perform.","type":"string"},"tools":{"description":"Optional list of tool names the background agent can use. If omitted, the agent has access to all available tools.","items":{"type":"string"},"type":"array"}},"required":["task"],"type":"object"},
};

export const SUBAGENT_CONTRACT: ToolContract = {
  description: "Run a specialized subagent for autonomous, multi-step work. It has separate context, so provide a self-contained task and request a concise final report.\n\nUse direct tools for small lookups. Launch independent subagents together, without duplicating their work. Use run_in_background for long work; completion is reported automatically, and SubagentOutput retrieves the result. Synchronous output is capped at 8 MB.",
  parameters: {"properties":{"agent_id":{"description":"Agent to invoke; cannot be used with preset.","enum":["agent_constructor","background-worker","code-reviewer","code_formatter","data_validator","error_analyzer","explore","general-assistant","question_answerer","research-agent","text_summarizer"],"type":"string"},"auto_background_seconds":{"description":"Move an unfinished task to the background after this many seconds; incompatible with run_in_background.","type":"integer"},"model":{"description":"Optional fuzzy-matched model override; use only when explicitly requested.","type":"string"},"preset":{"description":"DEPRECATED: Use 'agent_id' instead. Legacy preset sub-agent types.","enum":["code_formatter","text_summarizer","data_validator","error_analyzer","question_answerer"],"type":"string"},"resume":{"description":"Agent ID of a prior Subagent run to resume.","type":"string"},"run_in_background":{"description":"Launch in the background; cannot be used with auto_background_seconds.","type":"boolean"},"system_prompt":{"description":"Custom system prompt that overrides agent_id configuration.","type":"string"},"task":{"description":"A clear, self-contained task for the sub-agent.","type":"string"}},"required":["task"],"type":"object"},
};

export const SUBAGENTOUTPUT_CONTRACT: ToolContract = {
  description: "Check the status or retrieve output of background agents. Actions: 'status' (default) — current status; 'result' — full output with optional byte offset for incremental reads (output_file is read directly when available); 'cancel' — stop a running agent. Pass offset from a previous result call to read only new content. Do NOT poll in a loop to watch progress — you are notified automatically when a background agent completes. Collect the result after notification; check progress when needed to diagnose a blocker, coordinate work, or answer the user.",
  parameters: {"properties":{"action":{"description":"Action to perform: status (default), result, cancel","enum":["status","result","cancel"],"type":"string"},"agent_id":{"description":"Agent ID to check. Omit with action='status' to list all agents.","type":"string"},"offset":{"description":"Byte offset for incremental reads with action='result'. Use new_offset from a prior call.","type":"integer"}},"type":"object"},
};

export const TASKOUTPUT_CONTRACT: ToolContract = {
  description: "Check the status or retrieve output of background agents. Actions: 'status' (default) — current status; 'result' — full output with optional byte offset for incremental reads (output_file is read directly when available); 'cancel' — stop a running agent. Pass offset from a previous result call to read only new content.",
  parameters: {"properties":{"action":{"description":"Action to perform: status (default), result, cancel","enum":["status","result","cancel"],"type":"string"},"agent_id":{"description":"Agent ID to check. Omit with action='status' to list all agents.","type":"string"},"offset":{"description":"Byte offset for incremental reads with action='result'. Use new_offset from a prior call.","type":"integer"}},"type":"object"},
};

export const DELEGATE_CONTRACT: ToolContract = {
  description: "Spawn a focused agent that can ask the parent clarifying questions. Use DelegateOutput to poll, answer questions, check status, and retrieve the result; use Subagent instead for fully autonomous work.",
  parameters: {"properties":{"agent_id":{"description":"Agent type to invoke (e.g. 'general-assistant', 'research-agent'). Defaults to general-assistant.","type":"string"},"inherit_context":{"description":"If true, the delegate receives your conversation summary and tool set as additional context.","type":"boolean"},"model":{"description":"Optional model override for the delegate (e.g. 'sonnet', 'haiku').","type":"string"},"system_prompt":{"description":"Custom system prompt for the delegate. Overrides agent_id configuration.","type":"string"},"task":{"description":"The specific task to delegate. Be clear and self-contained — the delegate agent will work autonomously but can ask you questions.","type":"string"}},"required":["task"],"type":"object"},
};

export const DELEGATEOUTPUT_CONTRACT: ToolContract = {
  description: "Interact with an active delegate agent spawned by Delegate().\n\nActions:\n  \"status\"  — Check current state, pending questions, and task progress.\n  \"poll\"    — Wait up to 10s for a question from the delegate or completion.\n              Use this to efficiently wait for questions without busy-looping.\n  \"answer\"  — Send your answer to a pending question. The delegate resumes immediately.\n  \"result\"  — Read the delegate's final output. Use offset for incremental reads.\n  \"cancel\"  — Cancel a running delegate.\n\nTypical polling loop:\n  while true:\n    out = DelegateOutput(agent_id, \"poll\")\n    if out has question → DelegateOutput(agent_id, \"answer\", \"your answer\")\n    if out.status == \"done\" → DelegateOutput(agent_id, \"result\") and break\n\nPass offset from a previous 'result' call to read only new content.",
  parameters: {"properties":{"action":{"description":"Action: 'status' (current state + pending questions), 'poll' (wait briefly for a question or completion), 'answer' (send answer to delegate), 'result' (get final output), 'cancel' (stop the delegate)","type":"string"},"agent_id":{"description":"The delegate agent_id returned by Delegate()","type":"string"},"answer":{"description":"Your answer to the delegate's question. Used with action='answer'.","type":"string"},"offset":{"description":"Byte offset for incremental result reads. Use new_offset from a previous result call.","type":"integer"},"question_id":{"description":"The question_id from the pending question. Used with action='answer' for precision (optional — omit to answer the current pending question).","type":"string"}},"required":["agent_id","action"],"type":"object"},
};

export const MULTI_AGENT_WAIT_CONTRACT: ToolContract = {
  description: "Wait for multiple background or task agents to complete before continuing. Blocks execution until all specified agents finish (completed, failed, or cancelled). \n\nThis tool is designed for coordinating parallel agent workflows where the orchestrator needs to:\n- Spawn multiple background agents for independent tasks\n- Wait for all agents to complete before proceeding\n- Collect results from all agents in one operation\n\nUse this when you need to parallelize work across multiple agents and synchronize on their completion.",
  parameters: {"properties":{"agent_ids":{"description":"Array of agent IDs to wait for. All agents must complete before this tool returns.","items":{"type":"string"},"type":"array"},"poll_interval_ms":{"default":"1000","description":"Deprecated and ignored: waiting is now event-driven via each agent's completion signal, not polling.","type":"integer"},"timeout_seconds":{"default":"600","description":"Maximum time to wait in seconds (default: 600, 0 for no timeout)","type":"integer"}},"required":["agent_ids"],"type":"object"},
};

export const WAIT_FOR_AGENT_CONTRACT: ToolContract = {
  description: "Wait for a background agent to complete using event-driven notifications. Blocks execution until the agent finishes (completed, failed, or cancelled) or timeout occurs. More efficient than polling - uses internal event channels for immediate completion detection.",
  parameters: {"properties":{"agent_id":{"description":"Agent ID to wait for completion.","type":"string"},"timeout_seconds":{"default":"600","description":"Maximum time to wait in seconds (default: 600, 0 for no timeout).","type":"integer"}},"required":["agent_id"],"type":"object"},
};

export const CONTRACTS: Record<string, ToolContract> = {
  BackgroundTask: BACKGROUNDTASK_CONTRACT,
  Subagent: SUBAGENT_CONTRACT,
  SubagentOutput: SUBAGENTOUTPUT_CONTRACT,
  TaskOutput: TASKOUTPUT_CONTRACT,
  Delegate: DELEGATE_CONTRACT,
  DelegateOutput: DELEGATEOUTPUT_CONTRACT,
  multi_agent_wait: MULTI_AGENT_WAIT_CONTRACT,
  wait_for_agent: WAIT_FOR_AGENT_CONTRACT,
};
