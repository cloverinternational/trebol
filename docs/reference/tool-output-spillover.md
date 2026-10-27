# Tool-output spillover

Two places can shorten what the model reads from a tool. Both now write the
complete text to a private temporary file first, and name that file in the text
the model sees, so a bound never silently destroys output.

| Boundary | Applies to | Code |
| --- | --- | --- |
| General `tool_result` | every tool result, any provider, headless or TUI | `.pi/lib/runtime/swarm-toolout-boundary.ts` |
| Bash formatter | the Swarm `bash` tool, before it builds its XML envelope | `bashTruncateOutput` in `.pi/lib/tools/swarm-bash.ts` |

The shared persistence, counting, and clipping live in
`.pi/lib/runtime/swarm-toolout.ts`.

## Counting rule

```
estimated tokens = ceil(UTF-8 bytes / 4)
```

This is an estimate, not a provider tokenizer count. A CJK or emoji-heavy result
costs more provider tokens than this number says; an ASCII result usually costs
about the same. The bound is about preventing one tool result from occupying a
quarter of the context window, not about exact accounting.

The budget covers **tool text only**. Images, other non-text content blocks,
`structuredContent`, and provider protocol overhead are outside it.
Later middleware can append context beyond this boundary's budget.

## Configuration

| Variable | Default | Minimum | Applies to |
| --- | --- | --- | --- |
| `PI_SWARM_TOOL_OUTPUT_TOKENS` | `25000` (100,000 bytes) | `500` | general `tool_result` boundary |
| `PI_SWARM_BASH_OUTPUT_TOKENS` | `12500` (50,000 bytes) | `500` | Swarm `bash` tool spill |

Values must be plain positive integers. An empty, non-numeric, zero, negative,
non-integer, or below-minimum value is **ignored** and the default applies — a
mis-set variable cannot silently shrink the preview to nothing. The line guards
are not configurable: 1,000 lines for the general boundary and 2,000 lines for
the Bash formatter (Swarm parity).

These limits are layered: a Bash result below its own 2,000-line guard can
still trigger the general 1,000-line guard, producing a second recovery file.

```sh
PI_SWARM_TOOL_OUTPUT_TOKENS=8000 pi        # general boundary at 8k estimated tokens
PI_SWARM_BASH_OUTPUT_TOKENS=4000 pi        # Bash spill at 4k estimated tokens
```

## What happens to an oversized result

1. Every text block of the result is budgeted together. Non-text blocks are
   counted as zero and never clipped.
2. The complete text is written to the spill file. A path is published only
   after every byte landed; a partial file is removed.
3. Text blocks are clipped head-and-tail (Bash keeps the head only, matching
   Swarm), and one notice in the model-facing text names the spill file.
4. The preview plus the notice fit inside the same budget, so the final text
   does not creep past the limit.

The general boundary preserves the result's error status, `details`, block
order, and non-text blocks. It returns `structuredContent` unchanged when the
tool produced any, because Pi drops it whenever `content` is replaced without
it. It runs on Pi's `tool_result` event directly, not through a Swarm hook
group, so `/hooks taskmanage off`, `PI_SWARM_NO_HOOKS=1`, and the first turns of
a session do not disable it.

Installation currently belongs to the taskmanage extension: disabling that
extension removes the general guard. The legacy `dispatchRegisteredHook`
compatibility path does not dispatch this plain Pi event handler.

## Getting the full text back

Files live in `$TMPDIR/swarm-tool-output/` (on macOS that is per-user under
`/var/folders/...`):

| Prefix | Written by |
| --- | --- |
| `tool-full-<uint32>.txt` | general `tool_result` boundary |
| `bash-full-<uint32>.txt` | Swarm `bash` tool |

The owned directory is created or tightened to mode `0700`; symlink or
foreign-owned directories are rejected. Every file is mode `0600`. Names are
allocated with exclusive create, so concurrent spills in one and the same
millisecond never collide.

The notice tells the model, in the same words the tool contract uses:

```sh
sed -n '1,200p'  /tmp/swarm-tool-output/tool-full-123456.txt
rg -n 'FAIL|error TS' /tmp/swarm-tool-output/tool-full-123456.txt
```

No new tool is needed for retrieval; ordinary Bash or Read reaches the file.

## When the write fails

If the directory cannot be created, the file cannot be created, or the write is
short, no path is published and no partial file is left behind. The text then
says `Full output could not be saved (<reason>); re-run a narrower command or
query to see more.` and the preview stays bounded. The Swarm `bash` XML envelope
omits `<output_file path="..."/>` in that case instead of emitting an empty
`path=""`.

## Retention

Spill files survive session exit, reload, and process exit, but they are
ordinary OS temporary files: tmp cleaners, reboots, and OS policies can delete
them. This repository does not prune `swarm-tool-output/`; delete files you no
longer need if the directory grows. Never treat a spill path as durable
evidence — copy what matters somewhere persistent.

## Limits

- Data a tool already discarded cannot be recovered here: its own truncation,
  ANSI stripping, or decoded-stream merging. For the Swarm `bash` tool the spill
  happens **before** the formatter discards its copy, so the artifact is the
  complete merged stdout/stderr as the tool captured it.
- Pi's own native `bash` tool (used when the Swarm `bash` extension is not
  registered) truncates at its own 50 KB / 2,000-line limits and writes its own
  full-output file; that path is unchanged.
- A result with several text blocks has them joined with a blank line in the
  artifact, so per-block boundaries are not preserved in the file.
- The estimate is not a tokenizer count; see above.
- Background commands (`ReadBackgroundCommand`) keep their own compaction and
  their own `bgprocess-output-*.txt` spill; this reference does not change them.

## Verification

```sh
npx vitest run .pi/test/runtime/swarm-toolout.test.ts \
               .pi/test/runtime/tool-output-boundary.test.ts \
               .pi/test/tools/swarm-bash-spill.test.ts
node tools/e2e/tool-output-spillover.mjs    # real installed Pi session + real shell
```

The boundary suite imports the **installed** Pi runner
(`~/.pi/agent/install/current-version` → `pi-coding-agent/dist/index.js`) and
passes results through `emitToolResult`, so patch merging, `isError`, and
`structuredContent` behavior are checked against the real release rather than a
stand-in. The end-to-end script drives a real `seq 1 20000` shell command
through the registered Swarm `bash` tool and the real agent result hook.
