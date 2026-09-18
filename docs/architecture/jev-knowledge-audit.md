# Current control surface

Use `/supervisor`; the earlier individual commands described below are historical and removed. See AGENTS.md Unified Supervisor surface and docs/architecture/supervisor-panel.md.

# Jev first-finder audit

Opt-in state-layer adapter: `/jev-audit on|off|status|now` or initial
`PI_SWARM_JEV_AUDIT=on`. Resolves `TYPESAFE_API_KEY` from environment first, then the vault entry
`typesafe-api-key`. Status reports source/presence only, not connectivity.
`PI_SWARM_JEV_CREDENTIAL_ID` overrides the exact ID and `PI_SWARM_JEV_VAULT=off`
disables fallback. Secret stays internal to the HTTP Authorization header.
Normal package extension discovery loads it; reload/new session required after install.

Data flow: turn_end cumulative count → next turn_start after five turns → bounded
new visible evidence → Jev typed classifications → persisted redacted pending
review → context event → working agent reviews and uses existing memory/skill tools.
No wakeup, automatic promotion, global write, skill rewrite, or context deletion.

At most three excerpts (1800 chars each) per batch prevents discarded findings
from exceeding the 6000-char review limit. Cursor stops before batch overflow;
backlog drains on later five-turn audits. Questions identify array indices, not
semantic keys. Fixed model jev-1.13.0 and HTTPS endpoint; response bounded64KiB,
timeout3s, status/schema validation, errors sanitized. Cache is session-process-local,
32 entries keyed by model/rubric/evidence hash; persisted cursor handles restart.

Assistant prose is labeled assertion. Interaction-tool human answers carry linked
question context. Visible Skill/SkillManage view outputs are flagged skill evidence;
only available revision metadata is retained. Truncated skill output does not prove
whole-library health. No unsupported inference that a section is superseded.

Jev-enabled mode supersedes the old generative lifecycle extractor for this session.
Disabling restores old behavior; it may rescan since its own last capture cursor.
Existing candidate/verified memory semantics are unchanged. Agent review must inspect
sources and later corrections before any verification. Jev probability is not proof.

Fail-open for work, fail-closed for findings: missing key/error aborts the audit,
keeps evidence retryable, and does not prevent tools. Session replacement cancels
stale work. Missing compacted cursor pauses; automatic compaction recovery is not
implemented. Review delivery is marked before context return; a failed provider
request may consume that delivery, so manual review via status/source is needed.

Verification: focused context/state tests and live installed-Pi smoke documented in
`tools/experiments/jev-audit/README.md`. Actual review→memory save→recall by a real
working agent remains the next dogfood step, not claimed by scripted smoke.

## Optional memory worker

`/memory-worker on` delegates nonempty Jev findings to a single background child.
The parent queues at most four deduplicated packets; overflow remains main-agent
review. Child inherits a redacted active-branch snapshot through real `--fork`,
not the original conversation's authority. Parent model/provider is preserved.
The snapshot is limited to2MB; oversized branches fail with review pending.

Restricted worker loads no other extensions and exposes only snapshot evidence
reads and scoped memory operations. Search-before-write and read-before-verified
are enforced, CAS remains store-owned. Six new turns/90seconds bound maintenance.
Parent never waits for the worker inside a tool turn. A cancellation lease guards
subsequent writes; completed writes may survive cancellation and are reported.
No arbitrary project-file reads are exposed in v1: code/deployment assertions
without sufficient snapshot evidence must remain candidates.

Main query reminders use the durable memory_history tool rather than the separate
session-only context index. State persists without query text. No-op/error and
non-project scopes cannot masquerade as recall. One reminder per unmet interval;
rearm requires successful project lookup or new interactive/RPC input.

Known v1 limitations: default limits are fixed at6/90s in the parent command; no
live budget editor yet. Failed dispatch is reported for manual retry rather than
an autonomous restart loop. Stored record evidence refers to retained snapshot
files; deleting them loses replay provenance. Human/agent fact-checking quality is
not guaranteed by the tool evidence-read check. No production accuracy claim.

## Stop capture and recall scale

agent_end now audits one bounded remaining batch even before five turns. A
completed-turn/latest-message fingerprint prevents repeated stop hooks from
retrying the same request indefinitely. It shares cursor, pending review and
inflight state with preturn capture. A pending main-agent packet can defer more
evidence; stop audit is not an unlimited backlog drain.

Durable verified recall now scans the complete current record projection before
ranking, rather than the first100. Output still caps8 memories; candidate and
tombstoned records are excluded. The event-log projection is in memory and grows
with the store; this is correctness beyond100, not a scalable search-index claim.
Bootstrap also retains an explicitly labeled legacy-unverified path.
