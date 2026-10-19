#!/usr/bin/env python3
"""Live Tern check for the turn-work UI. Drives a real Tern window over its control socket.

Usage: turn-work-live.py SOCK OUTDIR   (the window must already run .pi/lib/tern/run.ts)
Per width it sends one prompt whose goal holds wide Unicode, samples the transcript DOM while the turn
runs, and asserts: every transcript row fits inside the main region; the live line is one line and has
no children; a settled turn is exactly one collapsed head with no step rows. Width 100 resizes mid-run;
width 140 aborts mid-run with Escape. Every sample is written to OUTDIR as JSON plus a screenshot.
"""
import json, os, subprocess, sys, threading, time

SOCK, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
GOAL = "修復ログイン 🚀 テスト確認 ✅ 文字幅"
results = []

def ctl(*a):
    r = subprocess.run(["tern", "ctl", "--control", SOCK, *a], capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": r.stdout, "err": r.stderr}

def cols():
    return ctl("state")["panes"][0]["cols"]

def set_cols(target):
    px = 6 * target + 182
    for _ in range(16):
        ctl("resize", str(px), "700")
        c = cols()
        if c == target:
            return True
        px += (target - c) * 6 if abs(target - c) > 1 else (target - c) * 2 or 1
    return cols() == target

def region():
    n = ctl("tree", ".sf-region.sf-main")["nodes"][0]["rect"]
    return n

def rows():
    # Transcript rows are direct children of the main region or of its column wrapper.
    return ctl("tree", ".sf-region.sf-main > *, .sf-region.sf-main > div > *").get("nodes", [])

def visible_text_boxes(selector=".sf-region.sf-main *"):
    # Rendered text-bearing elements under the selector, for the width check. Tern's hidden table-width
    # probe (.sf-tbl-probe) is a measuring element, not a drawn line.
    return [n for n in ctl("tree", selector).get("nodes", []) if n["rect"][2] > 0 and n["rect"][3] > 0 and n.get("text", "").strip()
            and "sf-tbl-probe" not in n.get("class", "")]

WORK_SELECTOR = ", ".join(f".sf-region.sf-main {r}" for r in (
    "[data-role='tern.work-live']", "[data-role='tern.work']", "[data-role='tern.work'] *", "[data-role='pi.user']", "[data-role='pi.user'] *"))

def snapshot(tag):
    reg = region()
    rs = rows()
    right = reg[0] + reg[2]
    def out_of(boxes):
        return [(n.get("class", n.get("tag", ""))[:30], round(n["rect"][0] + n["rect"][2] - right, 1), n.get("text", "")[:50]) for n in boxes
                if n["rect"][0] < reg[0] - 0.5 or n["rect"][0] + n["rect"][2] > right + 0.5]
    overflow = out_of(visible_text_boxes())
    work_overflow = out_of(visible_text_boxes(WORK_SELECTOR))
    running = [n for n in ctl("tree", ".sf-region.sf-main [data-role='tern.work-live']").get("nodes", []) if n["rect"][2] > 0]
    heads = [n for n in ctl("tree", ".sf-region.sf-main [data-role='tern.work'] > .sf-tool-head, .sf-region.sf-main [data-role='tern.work'] .sf-tool-head").get("nodes", []) if n["rect"][2] > 0]
    work = ctl("tree", ".sf-region.sf-main [data-role='tern.work']").get("nodes", [])
    steps = [n for n in ctl("tree", ".sf-region.sf-main [data-role='tern.work'] .sf-tool .sf-tool-head").get("nodes", []) if n["rect"][2] > 0]
    snap = {"tag": tag, "cols": cols(), "region": reg, "rows": [(r.get("class", r.get("tag", ""))[:40], [round(x, 1) for x in r["rect"]], r.get("text", "")[:160]) for r in rs],
            "overflow": work_overflow, "startupOverflow": [o for o in overflow if o not in work_overflow], "workCards": len(work), "liveRows": [(r["text"][:160], r["rect"]) for r in running], "heads": [h["text"][:160] for h in heads], "headHeights": [round(h["rect"][3], 1) for h in heads],
            "visibleStepHeads": len([s for s in steps if s["rect"][2] > 0])}
    return snap

def send(prompt):
    # The draft is empty after each submit; ctrl+a/ctrl+k before typing was seen to drop the first character.
    ctl("type", '"' + prompt + '"')
    ctl("key", "Return")

def idle():
    # Idle once no live work line has shown for three consecutive seconds.
    for _ in range(3):
        if ctl("tree", ".sf-region.sf-main [data-role='tern.work-live']").get("count"):
            return False
        time.sleep(1)
    return True

def check(name, ok, detail=""):
    results.append({"check": name, "status": "passed" if ok else "failed", "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (" — " + detail if detail else ""), flush=True)

def run_width(w, mode):
    if not set_cols(w):
        check(f"w{w} resize to {w} cols", False, f"got {cols()}"); return
    heads_before = snapshot("before")["workCards"]
    # Each tool call blocks reading a FIFO this harness controls: `cat` is read-only (no task gate) and the
    # call ends exactly when the harness writes. In abort mode nothing is written; Escape cancels the turn.
    fifos = [f"/tmp/tw/fifo-{x}{w}" for x in "ab"]
    for f in fifos:
        if os.path.exists(f): os.remove(f)
        os.mkfifo(f)
    def feed(path, delay):
        time.sleep(delay)
        with open(path, "w") as fh: fh.write(path[-4:] + "\n")
    if mode != "abort":
        for f, d in zip(fifos, (8, 11)):
            threading.Thread(target=feed, args=(f, d), daemon=True).start()
    prompt = f"{GOAL} w{w}: run these two bash commands in parallel as two separate tool calls in one message, with no other tools: `cat {fifos[0]}` and `cat {fifos[1]}`. Then reply with the single word ok."
    send(prompt)
    samples, t0, resized, aborted = [], time.time(), False, False
    while time.time() - t0 < 90:
        s = snapshot(f"w{w}-t{round(time.time()-t0,1)}")
        samples.append(s)
        if s["liveRows"] and mode == "resize" and not resized:
            ctl("shot", f"w{w}-live-before-resize"); set_cols(65); time.sleep(0.6)
            s2 = snapshot(f"w{w}-resized-to-65"); samples.append(s2); ctl("shot", f"w{w}-live-at-65")
            set_cols(w); resized = True
        if s["liveRows"] and mode == "abort" and not aborted and s["liveRows"][0][0].startswith("2 running"):
            ctl("shot", f"w{w}-live-before-abort"); ctl("key", "Escape"); aborted = True
        if s["workCards"] > heads_before and not s["liveRows"] and (time.time() - t0) > 2:
            time.sleep(2.5)
            if not snapshot("x")["liveRows"]:
                break
        time.sleep(0.4)
    final = snapshot(f"w{w}-settled"); samples.append(final)
    shot = ctl("shot", f"w{w}-settled")
    json.dump(samples, open(f"{OUT}/w{w}-{mode}.json", "w"), ensure_ascii=False, indent=1)
    live = [s for s in samples if s["liveRows"]]
    check(f"w{w} live line observed", bool(live), f"{len(live)} samples")
    check(f"w{w} live line is one line, one row", all(len(s["liveRows"]) == 1 and s["liveRows"][0][1][3] <= 20 for s in live),
          "; ".join(sorted({s['liveRows'][0][0] for s in live}))[:200] if live else "")
    check(f"w{w} running turn shows no step rows", all(s["visibleStepHeads"] == 0 for s in live))
    check(f"w{w} every turn-work and user row fits the main region (all samples)", all(not s["overflow"] for s in samples),
          json.dumps([s["overflow"] for s in samples if s["overflow"]][:2], ensure_ascii=False))
    new_heads = final["heads"][heads_before:]
    check(f"w{w} settled turn is exactly one summary", final["workCards"] == heads_before + 1 and len(new_heads) == 1 and not final["liveRows"], json.dumps(new_heads, ensure_ascii=False))
    check(f"w{w} summary head is one line", bool(final["headHeights"]) and final["headHeights"][-1] <= 20, str(final["headHeights"][-1:]))
    check(f"w{w} every transcript line fits, incl. the startup card (outside turn-work)", all(not s["startupOverflow"] for s in samples),
          json.dumps(final["startupOverflow"][:3], ensure_ascii=False))
    check(f"w{w} settled shows no step rows", final["visibleStepHeads"] == 0)
    expect = "Interrupted" if mode == "abort" else "Done"
    check(f"w{w} summary status {expect}", bool(new_heads) and new_heads[0].startswith(expect), new_heads[0][:80] if new_heads else "")
    if mode == "resize":
        check(f"w{w} resize mid-run happened while live", resized)
    if mode == "abort":
        check(f"w{w} abort mid-run happened while live", aborted)

for w, mode in [(40, "plain"), (65, "plain"), (100, "resize"), (140, "abort")]:
    run_width(w, mode)
    for _ in range(60):
        if idle(): break
        time.sleep(1)
json.dump(results, open(f"{OUT}/results.json", "w"), indent=1, ensure_ascii=False)
print(json.dumps({"passed": sum(r["status"] == "passed" for r in results), "failed": sum(r["status"] == "failed" for r in results)}))
