# Tern turn work: states, frames, and indicator ownership

While a user turn runs tools, Tern shows one live line for it. When the turn ends, that line becomes
one collapsed summary. By default no step rows, commands, or raw output are visible. The code is in
`.pi/lib/tern/bridge.ts` (`TranscriptProjector`, `toolGroupNode`) and the pure rules in
`.pi/lib/tern/turn-groups.ts`.

## States

"Goal" is the first non-empty line of the turn's user message with whitespace collapsed (`goalLine`).
"N" is the number of the turn's tool calls still running.

| State | Visible frame (TSP node in the main region) | Produced by |
| --- | --- | --- |
| idle | nothing for the turn | no `agent_start` yet, or the turn ran no tools |
| running, one tool | `text` `role:"tern.work-live"`, `wrap:"none"`, `truncate:"end"`: `1 running · goal` | `agent_start`, `tool_execution_start` |
| running, parallel | the same single line: `N running · goal` | several `tool_execution_start` before their ends |
| running, between tools | `working · goal` (the line stays; no card flashes) | `tool_execution_end` for every call while the turn is still open (`agent_start` seen, `agent_end` not) |
| settled, done | `card` `role:"tern.work"`, `collapsible`, `collapsed`, title `Done`, target goal, meta `N steps` | `agent_end`; every step ok |
| settled, failed | the same card, title `Failed` | `agent_end`; any step's result `isError` that was not caused by an abort |
| interrupted | the same card, title `Interrupted` | the final assistant `message_end` has `stopReason` `aborted`, or `error` with `errorMessage` "…aborted". Steps that were still running, or that failed with "context canceled", become cancelled; finished or genuinely failed steps keep their result |
| reloaded | the same settled card, with the same text as when the turn was live | `replaceFromSessionBranch` on `session_tree` and on `rebind` (`/resume` → `/tern-resume`); built from the session JSONL's `message` entries |

The step count is the number of tool calls, and the summary has no timing, so the live text and the
restored text are equal. Pi's JSONL does not carry reliable timing. The count leads the live line, so
end truncation never cuts it at narrow widths. The live line has no children. The settled card's
children (one per step) are present on the wire, but stay collapsed until ctrl+o (`outputExpanded`)
expands every card. Clicking a card's head folds that one card locally in Tern.

## Which indicator owns which work

| Work | Turn live line / summary | Running-work bar |
| --- | --- | --- |
| foreground tool call (Bash, Read, …) | yes | no (`foreground: true` is filtered out of `#backgroundWork`) |
| foreground subagent (`Subagent` without `run_in_background`) | yes | no |
| bash `background: true`, Ctrl+B, auto-background | the call's step only (it returns at once) | yes (`foreground: false` from launch, or `markBackgrounded`) |
| background subagent / subagent backgrounded later | the launching step only | yes (`patchRunningWork(id, { foreground: false })`) |

Each piece of work is announced by exactly one indicator while it runs.

## Verification

- `.pi/test/tern/turn-work.test.ts` replays real recorded sessions (`.pi/test/tern/fixtures/turn-work/`,
  extracted by `.pi/test/tern/live/extract-corpus.py` from runs with `PI_TERN_EVENT_LOG` set). It
  snapshots the visible work rows the bridge's TSP frames produce after every event. It also checks
  four properties over the corpus and 300 seeded generated sessions (every intermediate state):
  - each tool call is in exactly one group;
  - a running turn renders one line and no tool rows;
  - a settled turn renders exactly one collapsed summary;
  - restoring from the JSONL gives the same text as the live run.
- `.pi/test/tern/live/turn-work-live.py SOCK OUTDIR` drives a real Tern window over its control socket.
  It checks widths 40, 65, 100 (resized to 65 mid-run) and 140 (Escape mid-run), with a wide-Unicode
  goal, and asserts that every turn-work and user row fits the main region.
