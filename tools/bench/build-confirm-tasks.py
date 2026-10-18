"""Fresh confirmatory task set (tasks not in artifacts/prompt-bench/tasks.json).
fix: commits validated by validate-fix.sh (shipped tests fail at parent, pass at fix) and
     check-api.py (fix-version tests import nothing the parent lacks); bug text paraphrases
     the failing assertions at the parent (failnames), not the fix. Excluded: ddd5857
     (assertion is a description wording only), 63b1757/1372f45/d7e0827/e65b5ac (fail at fix),
     b7f001a/825f4b5/569d418 (pass at parent), adab0a7 (test deleted), fc690fc/d75cd6c/235c9b7
     (tests import symbols the parent lacks), 5427563/d08f054/f59eb6b/46828a8/5036f7c (7+ or
     multi-file failures, too broad for a single bug report).
q: next 14 eligible qids in the same seeded order as ab/select_ab.py (hash '20261018'+qid),
   skipping the 15 used; same grading (qrels span overlap) and workspace 5ad9194."""
import json,hashlib,os
R=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..')
END="\n\nFind the cause and fix it in the source. Do not commit. When done, reply with one line naming the file(s) you changed."
B="Bug report for this repository (current directory):\n\n"
FIX={
'ebd3f0f':(['.pi/test/runtime/program-status.test.ts'],"Program status (OSC 7501): buildProgramStatusSequence silently drops a `kind` given with a state other than blocked, and a `progress` given with a state other than working or blocked, and still emits a sequence. Such incompatible combinations must be rejected (return null). Separately, ProgramStatusReporter crashes the host when its write function throws (for example EPIPE on a closed stderr); reporting must never throw."),
'7345849':(['packages/tools/taskmanage/test/evidence-lifecycle.test.ts'],"TaskManage: in an atomic batch, if the abort signal fires after the first operation succeeded but before the next one runs, the batch fails but the first operation's task is left in the store. A cancelled atomic batch must leave the task store exactly as it was before the batch."),
'032871f':(['packages/tools/taskmanage/test/evidence-lifecycle.test.ts','packages/tools/taskmanage/test/review-regressions.test.ts'],"TaskManage (two problems):\n1. Completing a task whose answers cite file evidence runs git worktree discovery (execFileSync) once per evidence reference instead of once per batch; it must run once per execute() batch and again on the next batch.\n2. new TaskManager(...) accepts the legacy `resolveEvidence` option together with `canReadEvidence` or `evidenceRoots`. That combination must throw an error whose message says the options are mutually exclusive."),
'0f76e1b':(['.pi/test/ui/green-chat-input.test.ts','.pi/test/ui/running-work-view.test.ts'],"UI (two problems):\n1. The green-chat-input extension replaces whatever editor component is already installed, losing its input handler (for example the work browser's), and it installs an editor even when no editor factory was present. It must keep the existing editor's input handler and only restyle its border green, and do nothing when there is no editor factory.\n2. RunningWorkView renders more rows than fit on a short terminal (terminal rows 12 -> 12 rendered rows). The list must be bounded to the terminal height (at most 8 rows for a 12-row terminal) while still showing the selected row marker."),
'03359d7':(['packages/tools/taskmanage/test/pi-extension.test.ts'],"Bash tool result rendering: tab characters in output are left as raw tabs, so wrapping by terminal width is wrong (a tab occupies several cells but counts as one). Rendered result lines must expand tabs to spaces and every rendered line must fit the requested width."),
'9ddef13':(['.pi/test/tools/swarm-history-vault-tools.test.ts'],"HistorySearch: passing `fields` with non-normalized names such as [\" BODY \"] crashes (TypeError reading 'includes'), and segment searches (segment_kind set) ignore case_sensitive, exclude_runtime, sort and order. Field names must be normalized (trim, lower-case), and segment searches must honor case_sensitive, exclude_runtime, sort and order like conversation searches."),
'd2f2acb':(['.pi/test/runtime/swarm-transport-parity.test.ts'],"Tool surface gating: the memory_history tool is registered by the state layer but is missing from the gated model tool surface (for example the headless surface), so the model never sees it. memory_history must be part of the surface."),
'2577572':(['packages/tools/agents/test/agents.test.ts'],"Subagents (createPiRunner): the child Pi session file is named only after the deterministic session id (<id>.jsonl), so two parents or concurrent runs of the same task share and clobber one transcript. Each child run must get its own session file named <id>-<pid>-<uuid>.jsonl in the same directory."),
'ad38501':(['packages/tools/taskmanage/test/evidence-lifecycle.test.ts'],"TaskManage: registerTaskManage(pi, ..., options) writes session callbacks onto the caller's options object. Frozen options make it throw (TypeError: cannot add property), and two registrations that reuse one options object share session callbacks, so one session's tool results satisfy the other's evidence. Registration must not mutate the caller's options and each registration must keep its own session binding."),
'dcadf80':(['packages/tools/taskmanage/test/review-regressions.test.ts'],"TaskManage: if a host callback (for example canonicalizeToolEvidence) throws while an atomic batch is running, the exception escapes execute() with its message. It must be contained: the batch fails with a validation_failed result for that operation, earlier operations in the atomic batch are rolled back, and the host's error message must not appear in the result."),
'a2b2f3a':(['.pi/test/tools/paseo-startup-lifecycle.test.ts'],"Paseo extension: startup is asynchronous, and if the session shuts down before startup resolves, the late result still touches ctx.ui of the expired session (there is no session_shutdown handling). After session_shutdown, a delayed startup result must not access the UI; while the session is active, startup failures must still be reported via notify."),
}
fix=[{"id":f"fix-{c}","kind":"fix","commit":f"{c}^","check":{"fixCommit":c,"tests":t},"task":B+txt+END} for c,(t,txt) in FIX.items()]
E=os.path.join(R,'artifacts/memory-audit/eval')
P={x['doc'] for x in map(json.loads,open(os.path.join(E,'passages.jsonl'))) if x.get('lines') and not x.get('summary')}
ok={x['qid'] for x in map(json.loads,open(os.path.join(E,'qrels.jsonl'))) if x['grade']==2 and x['doc'] in P}
used={t['check']['qid'] for t in json.load(open(os.path.join(R,'artifacts/prompt-bench/tasks.json')))['tasks'] if t['kind']=='q'}
Q={x['qid']:x for x in map(json.loads,open(os.path.join(E,'test-queries.jsonl')))}
qs=[q for q in sorted(ok,key=lambda q:hashlib.sha256(('20261018'+q).encode()).hexdigest()) if q not in used]
old=json.load(open(os.path.join(R,'artifacts/prompt-bench/tasks.json')))['tasks']
tmpl=next(t for t in old if t['kind']=='q')['task']
def qtask(q):
  x=Q[q];return tmpl.split('A developer searched for')[0]+f"A developer searched for `{x['text']}` while working on this request:\n\n\"\"\"{x['need'][:600]}\"\"\"\n\n"+tmpl.split('"""\n\n',2)[-1]
qt=[{"id":f"q-{q}","kind":"q","commit":"5ad9194","check":{"qid":q},"task":qtask(q)} for q in qs]
assert qtask('T02')==next(t for t in old if t['id']=='q-T02')['task'],'q template mismatch'
assert not ({t['id'] for t in fix+qt}&{t['id'] for t in old})
json.dump({"provenance":{"fix":__doc__.split('q:')[0].strip(),"q":"q:"+__doc__.split('q:')[1].strip()},"tasks":fix+qt},open(os.path.join(R,'artifacts/prompt-bench/confirm/tasks.json'),'w'),indent=1)
print(len(fix),'fix',len(qt),'q',[t['id'] for t in qt])
