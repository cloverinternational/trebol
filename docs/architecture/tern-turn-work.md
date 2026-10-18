# Tern turn work: states, frames, and indicator ownership

While a user turn runs tools, Tern shows one live line for it. When the turn ends, that line becomes
one collapsed summary. By default no step rows, commands, or raw output are visible. The code is in
`.pi/lib/tern/bridge.ts` (`TranscriptProjector`, `toolGroupNode`) and the pure rules in
`.pi/lib/tern/turn-groups.ts`.

## States

A turn starts at a user message or at a visible custom message (`display: true`, e.g. `swarm-agent-complete`,
`swarm-goal`, `swarm-monitor`), which Pi delivers with `triggerTurn` and may steer into the same agent run.
"Goal" is the first non-empty line of the turn's starting message with whitespace collapsed (`goalLine`).
"N" is the number of the turn's tool calls still running.

| State | Visible frame (TSP node in the main region) | Produced by |
| --- | --- | --- |
| idle | nothing for the turn | no `agent_start` yet, or the turn ran no tools |
| running, one tool | `text` `role:"tern.work-live"`, `wrap:"none"`, `truncate:"end"`: `1 running · goal` | `agent_start`, `tool_execution_start` |
| running, parallel | the same single line: `N running · goal` | several `tool_execution_start` before their ends |
| running, between tools | `working · goal` (the line stays; no card flashes) | `tool_execution_end` for every call while the turn is still open (`agent_start` seen, `agent_end` not) |
| settled, done | `card` `role:"tern.work"`, `collapsible`, `collapsed`, title `Done`, target goal, meta `N steps`, plus `K failed` when K steps errored | the turn ended normally. A step error the agent went on from (hook block, failed Subagent) is counted in `K failed`, not used as the turn's outcome |
| settled, failed | the same card, title `Failed` | the turn's final assistant message has `stopReason: "error"` that is not an abort (provider failure) |
| interrupted | the same card, title `Interrupted` | the final assistant `message_end` has `stopReason` `aborted`, or `error` with `errorMessage` "…aborted". Steps that were still running, or that failed with "context canceled", become cancelled; finished or genuinely failed steps keep their result |
| reloaded | the same settled card, with the same text as when the turn was live | `replaceFromSessionBranch` on `session_tree` and on `rebind` (`/resume` → `/tern-resume`); built from the session JSONL's `message` and `custom_message` entries |
| notice | `text` `role:"tern.notice"`, `tone:"muted"`, `wrap:"none"`, `truncate:"end"`: the notice's first line | a visible custom message; it starts a turn whose work gets its own card |

Only the turn's starting message, notices, and the assistant's answer after its last tool call are top-level
rows. Assistant text in a message that calls tools, or written before the turn's last tool call, is narration:
it sits in the card as a `md` `role:"tern.work-note"` child between the steps, behind the fold. Hidden custom
messages (`display: false`: hook context, nudges) and Pi `system` messages never render. Assistant messages
with no text (thinking or tool calls only) render nothing.

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
  - restoring from the JSONL gives the same text as the live run;
  - nothing written mid-turn (narration, hidden hook context) is a top-level row, live or restored, and a
    card reads `Failed` only when the turn's final message failed.
  A recorded background-agent run checks the notice line and the wakeup turn's own card.
- `.pi/test/tern/live/turn-work-live.py SOCK OUTDIR` drives a real Tern window over its control socket.
  It checks widths 40, 65, 100 (resized to 65 mid-run) and 140 (Escape mid-run), with a wide-Unicode
  goal, and asserts that every turn-work and user row fits the main region.

## Streaming and flicker

While a run is busy, an assistant message that is still streaming stays with the turn's work (under the live
line) until `message_end`, because it may yet call a tool. On `message_end` it becomes narration inside the card
if it called tools, otherwise the turn's top-level reply. Showing it as a reply first and folding it into the
card at `toolcall_start` made each narration sentence appear and vanish. A plain reply therefore appears whole
when its message ends; the live line covers it while it streams. A turn's work node is keyed by its first member,
so its id does not change when the first tool starts.

## UI trace (dogfooding)

`run.ts` writes `~/.pi/agent/tern-trace/<time>-<pid>.ui.jsonl` (newest 20 kept; off with `PI_TERN_UI_TRACE=0`):
`{k:"ev"}` lines with each Pi event's type and ids (no payload text, no text deltas), and `{k:"frame"}` lines
with the top-level transcript rows `[id, role, state, text≤80]`, the render trigger, and `busy`, written only when
they change. `node --experimental-strip-types .pi/lib/tern/ui-trace-report.ts [file]` lists flicker in the newest
trace: a row that vanishes or comes back while busy, a row whose state returns to an earlier one, a live line
replaced by work with a new id, and a settled card in a still-running turn. The replay corpus keeps text and
tool-call-start deltas so these streams are replayed too, and `ui-trace.test.ts` asserts the corpus has none.
