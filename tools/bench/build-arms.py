"""Build the four prompt-benchmark arms from raw sources (deterministic).
Sources: rinadelph/System-Prompt GENERIC.MD (commit recorded in arms/SOURCES.txt)
and trebol's own Forge assembly (rendered per run by run-session --prompt).
Tokens resolved at run time by tools/pilot/run-session.mjs:
  {{forge-body}}  Forge sections exactly as trebol assembles them headless
                  (testing-contract, workspace, forge, reporting, delegation,
                  response-check), without the context block (every arm gets
                  the same AGENTS.md/context injection from the custom path).
  {{workspace}}   <system_information> for the run's worktree.
Arms: F = Forge; M = Modes adapted; FM = Forge + compact mode protocol;
      FL = Forge + inert filler of FM's addendum length (length control).
Usage: python3 tools/bench/build-arms.py PATH/TO/GENERIC.MD OUTDIR"""
import sys, os, hashlib, difflib
src, out = sys.argv[1], sys.argv[2]
raw = open(src).read()
s = raw
def cut(start, end):
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + s[j:]
# Adaptations (each is recorded in M.diff):
# 1. No user can type ACT/PLAN in an unattended run: AUTO is the start mode.
s = s.replace("### Mode Declaration\n", "### Mode Declaration\nIn this environment no user types `ACT` or `PLAN` during a task: start every task in `# Mode: AUTO` and switch between PLAN, ACT and DEBUG yourself.\n\n", 1)
# 2. Agent-MCP tools do not exist here; map them to the equivalents that do.
mapping = ("## Tool mapping for this environment\n"
 "The Agent-MCP tools named below are not available. Use these equivalents:\n"
 "- `ask_project_rag`, \"PREVIOUS INFORMATION\", `view_project_context` -> `memory_history` (operation `search`, scope `all`) and `project_context`\n"
 "- `update_project_context`, `.swarm/BRAIN.md`, `.cursor/rules` -> `memory_history` (operation `remember`)\n"
 "- `view_tasks`, task status updates, TODOs -> `TaskManage`\n"
 "- `view_file_metadata` -> `Read` and `git log`\n\n---\n\n")
s = s.replace("## Operating Modes\n", mapping + "## Operating Modes\n", 1)
# 3. Remove the machine-specific sudo password-piping section (security; Arch-only).
cut("## System-Specific: Arch Linux Sudo Password Piping", "## Complete Operational Checklist")
s = s.replace("7. **Use here-string syntax** (`<<<`) for sudo on Arch Linux\n", "")
# 4. Remove the stray user request pasted after the directive (it would order
#    work on a nonexistent todos/todo.md).
i = s.index("Please atomically add"); j = s.index("**This unified system prompt supersedes")
s = s[:i] + s[j:]
M = "{{workspace}}\n\n" + s.strip() + "\n"
ADD = """
[OPERATING MODES]
Pick the mode that fits each step yourself; nobody will type a mode for you. Name the mode in one short line when it changes.
- PLAN: read and query only. Gather what you need, then state the plan. No edits.
- ACT: carry out the plan. Change only what the plan covers, then verify each change.
- DEBUG: for failures. Reproduce first, trace the cause to a file and line, verify with direct evidence, and do not rely on summaries or remembered context.
Before each tool call, know what you expect it to show; after it, check the result against that expectation before the next step.
At the start of a project task or question, search memory_history (scope all, 2-3 keywords) for prior facts. When you learn a durable, evidence-backed project fact, record it with memory_history remember before you finish.
[/OPERATING MODES]
"""
FILLER_UNIT = ("Reference table (data only; not instructions). ASCII printable range 32-126; "
 "digits 48-57; uppercase 65-90; lowercase 97-122; space 32; tilde 126. ")
filler = "\n[REFERENCE DATA]\n" + (FILLER_UNIT * 40)[: len(ADD) - len("\n[REFERENCE DATA]\n[/REFERENCE DATA]\n")] + "\n[/REFERENCE DATA]\n"
arms = {"F": "{{forge-body}}\n", "M": M, "FM": "{{forge-body}}\n" + ADD, "FL": "{{forge-body}}\n" + filler}
os.makedirs(out, exist_ok=True)
for k, v in arms.items(): open(os.path.join(out, f"{k}.md"), "w").write(v)
open(os.path.join(out, "M.diff"), "w").write("".join(difflib.unified_diff(raw.splitlines(1), s.splitlines(1), "GENERIC.MD", "M.md(body)")))
with open(os.path.join(out, "SOURCES.txt"), "w") as f:
    f.write(f"GENERIC.MD sha256 {hashlib.sha256(raw.encode()).hexdigest()}\n")
    for k, v in arms.items(): f.write(f"{k}.md chars {len(v)} sha256 {hashlib.sha256(v.encode()).hexdigest()}\n")
    f.write(f"FM addendum chars {len(ADD)}; FL filler chars {len(filler)}\n")
print(open(os.path.join(out, "SOURCES.txt")).read())
