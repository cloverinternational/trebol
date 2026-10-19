#!/usr/bin/env python3
"""Builds the turn-work replay corpus from real recordings (no hand-written events).

Usage: extract-corpus.py EVENT_LOG OUT_DIR
EVENT_LOG is the file run.ts writes with PI_TERN_EVENT_LOG set: one {at, sessionFile, event} line per Pi event.
For each session file seen in it, writes OUT_DIR/<name>.events.jsonl (the events the projector consumes) and
OUT_DIR/<name>.session.jsonl (Pi's persisted branch for the same session). Streaming deltas and bookkeeping
entries are dropped, except text and tool-call-start deltas, which are kept as {type, delta} only (narration
streams before its tool call, so the corpus must stream too); every other event is kept in order. Long strings are cut to 300 characters so the
fixtures stay small; the projector's behaviour under test does not depend on long payloads.
"""
import json, os, sys

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
KEEP = {"agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_end"}

def cut(v):
    if isinstance(v, str):
        return v if len(v) <= 300 else v[:300] + "…"
    if isinstance(v, list):
        return [cut(x) for x in v]
    if isinstance(v, dict):
        return {k: cut(x) for k, x in v.items() if k not in ("thinkingSignature", "signature", "usage", "tools", "toolsAdded", "sections", "systemPrompt")}
    return v

streams = {}
last_update = {}
for line in open(SRC, encoding="utf-8"):
    rec = json.loads(line)
    ev = rec["event"]
    if ev.get("type") == "message_update":
        d = ev.get("assistantMessageEvent") or {}
        if d.get("type") not in ("text_delta", "toolcall_start"):
            continue
        ev = {"type": "message_update", "assistantMessageEvent": {"type": d["type"], **({"delta": d["delta"]} if d["type"] == "text_delta" else {})}}
    elif ev.get("type") not in KEEP:
        continue
    if ev["type"] == "tool_execution_update":
        # Keep only the first and the latest update per call; intermediate snapshots repeat the same prefix.
        key = ev.get("toolCallId")
        if key in last_update:
            streams[rec["sessionFile"]][last_update[key]] = None
        last_update[key] = len(streams.setdefault(rec["sessionFile"], []))
    streams.setdefault(rec["sessionFile"], []).append(cut(ev))

for session_file, events in streams.items():
    name = os.path.basename(session_file).split("_")[0]
    with open(f"{OUT}/{name}.events.jsonl", "w", encoding="utf-8") as fh:
        for ev in events:
            if ev is not None:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
    with open(f"{OUT}/{name}.session.jsonl", "w", encoding="utf-8") as fh:
        for line in open(session_file, encoding="utf-8"):
            entry = json.loads(line)
            if entry.get("type") in ("message", "custom_message"):
                fh.write(json.dumps(cut(entry), ensure_ascii=False) + "\n")
    print(name, len([e for e in events if e is not None]), "events")
