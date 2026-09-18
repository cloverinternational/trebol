# Backfill accounting and quality review

## Accounting
Primary ledgers in artifacts/jev-backfill/staged-scan-v2 establish32 reserved Jev
calls with32 completed result files;6 reserved reviewer jobs with completed result
files, plus the1 exploratory allowance charged by review_staged.py. Thus7 reviewer
jobs used; ceiling remaining68 Jev calls/3 reviewers for this authorized pilot.
Older pilot summary20calls and documentation4reviews are stale, not authoritative.
No new paid calls or live promotion were performed during this review.

94,994 manifest chunks =90,273 clean-file chunks +4,721 chunks from5 files scanned
with exceptions. lineage.py deliberately processes status=scanned only. No chunk
loss/dedup is established by the differing totals. Four changed-before-scan files
contribute0 chunks and remain excluded. Full classification remains incomplete.
Read-only audit_accounting.py derives the accounting;13 Python tests passed.

## Quality
Reviewed14 current staging record variants (including3 namespace-copy pairs).
Do not count the namespace copies as independent findings.
- Trefoil historical Rust/frontend intent: directly supported by cited snapshot
 866a7861-0, belongs to Trefoil, not Pi-Swarm. Preserve date and intent limitation.
- Firefox two-command adapter approval: supported by linked question and answer
 9d9ebeaf-0; keep narrow approval, do not convert recommended details into consent.
- Google Workspace requirement: snapshot dc05f28c-0 has a blank Question field.
 Answer wording is present; surrounding source must repair attribution before
 treating the full integration requirement as independently established.
- Three code-owner/contract facts (task answers, MCP owner, /btw prompt array) are
 useful. Current target source supports the core claims, but task-answer quote
 'missing answer for question id' is outdated and unmerged facts need scope review.
 Update exact evidence/revision before any live promotion.
- Old test counts, ahead/behind branches, merge attempts and attributed assistant
 outcome reports are execution history. Candidate caveats do not make them useful
 durable memory. Recommend exclusion from promotion, retaining original audit.
- Bare snapshot IDs on some candidates lack a standalone source locator; repair
 via job/evidence-links before independent review or promotion.
All prepared job snapshot/link-file hashes inspected matched their job manifests;
this establishes artifact consistency, not truth or freshness of original sources.

## Next batch
Spend no further Jev calls merely to rediscover known findings. First make a
read-only disposition manifest for all staged records, repair ambiguous/bare
citations and check current-source hashes/project scope. Then use at most one of
the3 remaining reviewer slots on a newly supported bounded batch, after checking
reservation freshness. Keep staging-only; live promotion is a separate decision.
This review does not complete full corpus backfill or certify all records.

## Per-record disposition and citation repair proposals
Generated staging disposition-review.json:14 records,2 keep,5 revise,7 exclude
from promotion (not deletion). Each entry pins the reviewed record revision.
15 evidence references resolve uniquely to snapshot and original-event locators;
3 are code references requiring refreshed line/hash citations. Resolution alone
is not source truth verification. Unknown future records remain unreviewed.
The exporter validates snapshot/link hashes, writes no memory, and retains originals.

Recovered missing Google Workspace questionnaire from original transcript by
matching answer dc05f28c's toolCallId to ask_user_question in event39a99e17.
It asked3 questions: OAuth-client choice, installation location, accounts to add.
The freeform answer establishes global installation/multiple-account/UI preference,
not a selection of OAuth client or successful implementation. Recommendation:
attach both original event references and keep a narrowly attributed requirement.
No record correction or live promotion applied.14 Python tests pass; diff clean.

## Applied staging citation repairs
Ran repair_staged.ts through canonical KnowledgeStore:7 revision-checked corrections,
0 live writes,0 deletions. Preflight checked all reviewed revisions/owner identities;
individual writes are CAS guarded, not an atomic multi-record transaction. Receipt
citation-repair-receipt.json records old/new revisions and current-code hashes.
Readback verified all7 resulting revisions and no bare refs in these corrected records.
Original events remain in append-only history.7 excluded records were untouched.

Two direct historical decisions retain verified status. Google Workspace attribution
was narrowed and downgraded to candidate pending independent review. Three current
local-code records got exact line citations/hash receipts and were downgraded to
candidate because repository/merged scope was not established. The uncertain MCP
assessment remains candidate with resolved original-event citations; semantic
consolidation is still pending. No promotion from staging is implied.

14 existing Python tests passed after repairs; these cover accounting/export/scan
utilities, not a dedicated mutation-runner test. Actual7-record CAS outcomes were
separately read back. Broader backfill and independent semantic review remain open.
