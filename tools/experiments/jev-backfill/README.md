# Staged Pi backfill (experimental)

Offline scan:
```
python tools/experiments/jev-backfill/scan.py --output artifacts/jev-backfill/NEW-RUN
python tools/experiments/jev-backfill/test_scan.py
```
Explicit roots: ~/.pi/agent/sessions plus .pi/agent-sessions beneath observed
session-header workspaces. No entire-home/workspace recursive scan. Frozen inventory,
per-file event/metadata outputs, atomic completion; resume skips completed files.

Scan-v2 outcome:627 inventoried sources /17,042,863,889 bytes;618 clean,5 malformed
exceptions,4 changed before scan.30,995 retained events /94,994 chunks;685,306 excluded
runtime/nonvisible records;5 malformed lines;0 oversized lines. These are scan
outcomes, NOT a completed model backfill. Cross-file fork dedup is NOT implemented;
source events are preserved and require lineage reconciliation before full spend.

Pilot:
```
# API key in environment; reserves each call before network, counts failures.
python tools/experiments/jev-backfill/pilot.py artifacts/jev-backfill/staged-scan-v2 --cap 20
```
20 actual calls /32,258 input tokens;47 classified human excerpts:3 memory,1
procedure,25 temporary,9 unresolved,9 noise. Workspace-spread selection is NOT
representative random sampling and only samples human evidence. All3 memory
candidates remain candidates after one independent review job;none verified.
No live memory writes or promotion. Reviewer job ran106seconds/11 tool turns,
exceeding its requested prose budget: not the hard-capped production worker.
Do not report that judge as proof of6turn/90s enforcement.

Nominal Jev input charge at documented$0.042/M: ~$0.00135 for pilot, not a bill.
Very rough full upper work estimate before cross-file dedup:31,665 three-chunk
calls and ~$2.15 at pilot mean tokens/call. This is NOT a reviewer cost estimate:
review quality/rate, contextual batching and longer tool excerpts can dominate.
Do not extrapolate3/47 into verified-memory yield. No useful verified recall
improvement was demonstrated yet.

Remaining gates: reconcile4 changed sources and5 malformed records; prove lineage
dedup; repository/worktree mapping (currently source cwd, not canonical identity);
stronger redaction review; hard-capped staging reviewer integration; independent
source-supported labels and before/after bootstrap recall. Outputs are private
ignored artifacts. No complete-backfill or memory-quality success claim is warranted.
