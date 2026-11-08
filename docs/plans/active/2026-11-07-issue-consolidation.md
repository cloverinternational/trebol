# Issue consolidation: close exact duplicates, keep every real report

Status: proposed · Owner: agent · Scope: `cloverinternational/trebol` open issues only

## Problem

104 open issues, 0 labels, 0 comments. Roughly a third are the same defect reported repeatedly by
different agent sessions, and the tracker has become an inbox that nobody can triage: the
TaskManage evidence family alone was closed a dozen times (#118, #121, #134, #189, #194, #216, #224,
#240, #241, #245, #247, #276) while the defect kept recurring.

## Decisions (resolved with the owner)

| # | Decision | Resolution |
|---|---|---|
| D1 | How aggressive | **Conservative.** Close only issues whose titles state the *identical* failure. Reports that merely share a surface stay open. |
| D2 | What to do with #412/#413/#417 (addressed by today's unmerged change) | **Comment now, close at release.** #412 and #413 are duplicates of #417; #417 carries the triage comment and closes when the release ships. Nothing claims an unmerged fix is shipped. |
| D3 | New umbrella issues? | **No.** With conservative scope the oldest, most complete report in each group *is* the umbrella. Creating fresh umbrellas would add issues to a tracker whose problem is too many issues. |

## Closure map (9 closures)

| Duplicate | Anchor | Why it is the same defect |
|---|---|---|
| #366 | #364 | "`open` reports success but creates no browser block" |
| #373 | #364 | same, re-reported from another session |
| #374 | #364 | same, terminal-only pane wording |
| #385 | #364 | `open` returns a block id that later calls reject — same unusable-id outcome |
| #391 | #364 | `open` returns an unaddressable block id — same outcome |
| #376 | #351 | `act click` dispatches at coordinates that miss the target |
| #370 | #310 | `act fill`/`check` write into the focused element, not the referenced one |
| #412 | #417 | tern executable not resolvable |
| #413 | #417 | tern executable not resolvable |

Deliberately **not** closed, though adjacent: #309, #312, #317, #323, #324, #325 (block-id and
new_tab provenance, plausibly different root causes), #313, #314, #315, #318, #375, #378, #380
(each a distinct interaction defect), and everything outside the tern cluster.

## Wording

Every closure carries a comment naming the anchor and inviting further evidence there, so nobody's
report vanishes silently:

> Duplicate of #364 — same failure (`open` answers success while no addressable block exists).
> Consolidated on 2026-11-07; please add any new evidence to #364.

#417 gets a triage comment instead: the root cause (the tool's `execFile("tern", …)` inherits the
pane's `PATH`, so an installed binary can be invisible), the fix in this working tree
(`.pi/lib/panes/install-probe.ts`, `.pi/lib/panes/dispatch.ts`, `extensions/tern-browser/extension.ts`),
the plan (`docs/plans/active/2026-11-07-pane-runtime-detection-and-herdr-fallback.md`), and the
release gate.

## Steps

1. Comment on #417 with the triage above (`gh issue comment`). Do this first so the duplicate
   closures point at a comment that already exists.
2. Close the 9 duplicates with `gh issue close <n> --reason "not planned" -c "<comment>"`, one
   command each, so a failure is attributable to exactly one issue.
3. Label the four anchors `bug` so the clusters are queryable: #364, #351, #310, #417.
4. Verify: re-list open issues and assert 95 open, and re-read each anchor to confirm it is open.

## Failure modes

- **Partial run.** Each closure is one command; re-running the plan skips anything already closed
  (`gh issue close` on a closed issue is a no-op error, so state is checked first).
- **Wrong merge.** Reversible with `gh issue reopen <n>`. This is why the conservative set was
  chosen and why each closure names its anchor.
- **Rate limiting.** Nine closures plus one comment is far below any limit; no batching needed.

## Verification

```sh
gh issue list -R cloverinternational/trebol --state open --limit 200 --json number | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'   # expect 95
gh issue view 364 -R cloverinternational/trebol --json state                        # expect OPEN
gh issue view 417 -R cloverinternational/trebol --json comments --jq '.comments|length'  # expect >= 1
```

## Non-goals

- No mass-closing, no relabelling of the other 95 issues, no bot automation.
- No claim that #417 is fixed: it closes when the release ships, not before.
- Nothing outside `cloverinternational/trebol` is touched.
