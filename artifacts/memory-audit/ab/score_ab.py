# Score downstream A/B (see PREREG-ab.md). Run: python3 artifacts/memory-audit/ab/score_ab.py
import json, os, re, glob, random
H = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(H, "../../.."))
E = os.path.join(H, "..", "eval")
P = {}
for l in open(os.path.join(E, "passages.jsonl")):
    x = json.loads(l)
    if x.get("lines") and not x.get("summary"): P[x["doc"]] = x
G = {}
for l in open(os.path.join(E, "qrels.jsonl")):
    x = json.loads(l)
    if x["doc"] in P: p = P[x["doc"]]; G.setdefault(x["qid"], []).append((p["ref"], p["lines"][0], p["lines"][1], x["grade"]))
Qs = [json.loads(l)["qid"] for l in open(os.path.join(H, "ab-questions.jsonl"))]
CITE = re.compile(r"([\w./@-]+\.\w+)#L(\d+)(?:-L?(\d+))?")
def load(q, arm):
    fs = sorted(glob.glob(os.path.join(H, "runs", f"{q}-{arm}-*.jsonl")))
    if not fs: return None
    f = fs[-1]; ev = []
    for l in open(f):
        try: ev.append(json.loads(l))
        except Exception: pass
    if not any(e.get("type") == "agent_end" for e in ev): return {"invalid": True, "file": os.path.relpath(f, REPO)}
    msgs = [e["message"] for e in ev if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"]
    text = "".join(c.get("text", "") for c in (msgs[-1]["content"] if msgs else []) if c.get("type") == "text")
    tools = [e.get("toolName") for e in ev if e.get("type") == "tool_execution_end"]
    tok = sum((m.get("usage") or {}).get("totalTokens", 0) for m in msgs)
    cites = [(m[1].lstrip("./"), int(m[2]), int(m[3] or m[2])) for m in CITE.finditer(text)][:3]
    return {"invalid": False, "file": os.path.relpath(f, REPO), "attempts": len(fs), "text": text, "tools": tools, "tokens": tok, "cites": cites}
def judge(q, c):
    path, a, b = c; fp = os.path.join(REPO, path)
    exists = os.path.isfile(fp) and a >= 1 and b >= a and b <= sum(1 for _ in open(fp, errors="ignore"))
    best = -1
    for ref, x, y, g in G.get(q, []):
        if ref == path and a <= y and b >= x: best = max(best, g)
    return exists, best
R = {}
for q in Qs:
    for arm in "AB":
        r = load(q, arm)
        if r and not r["invalid"]:
            r["judged"] = [judge(q, c) for c in r["cites"]]
            r["pass"] = int(any(g == 2 for _, g in r["judged"])); r["pass1"] = int(any(g >= 1 for _, g in r["judged"]))
            r["pc_calls"] = r["tools"].count("project_context")
        R[(q, arm)] = r
valid = [q for q in Qs if all(R.get((q, a)) and not R[(q, a)]["invalid"] for a in "AB")]
inv = [q for q in Qs if q not in valid]
def m(arm, k): return [R[(q, arm)][k] for q in valid]
print(f"questions {len(Qs)}  valid pairs {len(valid)}  invalid {inv}")
for arm in "AB":
    cs = [j for q in valid for j in R[(q, arm)]["judged"]]
    print(f"arm {arm}: pass {sum(m(arm,'pass'))}/{len(valid)}  pass1 {sum(m(arm,'pass1'))}/{len(valid)}  citations {len(cs)}  "
          f"resolve {sum(e for e,_ in cs)}  precision(rel>=1) {sum(e and g>=1 for e,g in cs)}/{len(cs)}  unjudged {sum(g<0 for _,g in cs)}/{len(cs)}  "
          f"tool calls {sum(len(t) for t in m(arm,'tools'))} (mean {sum(len(t) for t in m(arm,'tools'))/len(valid):.1f})  tokens mean {sum(m(arm,'tokens'))/len(valid):.0f}  median {sorted(m(arm,'tokens'))[len(valid)//2]}")
print("arm A project_context calls per question:", m("A", "pc_calls"))
d = [a - b for a, b in zip(m("A", "pass"), m("B", "pass"))]
rng = random.Random(20261018); n = len(d); bs = sorted(sum(d[rng.randrange(n)] for _ in range(n)) / n for _ in range(10000))
lo, hi = bs[249], bs[9749]; delta = sum(d) / n
wins, losses = d.count(1), d.count(-1); k = min(wins, losses); N = wins + losses
from math import comb
p = min(1.0, 2 * sum(comb(N, i) for i in range(k + 1)) / 2 ** N) if N else 1.0
verdict = "project_context helps" if lo > 0 else ("project_context hurts" if hi < 0 else "not established")
print(f"pass A-B: delta {delta:+.3f}  95% CI [{lo:+.3f}, {hi:+.3f}]  discordant A-only {wins} B-only {losses}  sign test p={p:.3f}  -> {verdict}")
td = [a - b for a, b in zip(m("A", "tokens"), m("B", "tokens"))]; cd = [len(a) - len(b) for a, b in zip(m("A", "tools"), m("B", "tools"))]
print(f"tokens A-B mean {sum(td)/n:+.0f}; tool calls A-B mean {sum(cd)/n:+.2f}")
for q in Qs:
    print(q, *[(a, None if R.get((q,a)) is None or R[(q,a)]["invalid"] else (R[(q,a)]["pass"], R[(q,a)]["pass1"], len(R[(q,a)]["tools"]), R[(q,a)]["tokens"], R[(q,a)]["attempts"])) for a in "AB"])
json.dump({f"{q}|{a}": v for (q, a), v in R.items()}, open(os.path.join(H, "ab-per-run.json"), "w"), indent=1, default=str)
