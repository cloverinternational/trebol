# Jev operational supervisor

This module is the first, pure operational-supervisor slice. It collects a bounded
sanitized goal/task/budget/waiting snapshot, builds one typed Jev call with evidence
questions, and parses a finding into enum-constrained probability distributions.
Findings are proposals, never actions. Task proposals are checked against hashes of
the individual task snapshots (not a global-list hash), including stale targets,
ownership, dependencies, terminal states, and a five-operation limit.

`vaultCredentialMetadata` accepts only `id`, `purpose`, and `scope`; it does not
inspect a vault file and emits no secret. Review results require evidence IDs that
were actually supplied, and a confirm/reject without evidence is refused.

## Integration seam

The eventual parent dispatcher should call collection beside the existing audit
record, send the single Jev request, and route the returned finding/proposal through
the parent task dispatcher. This commit is **module-ready, not live-wired**: it does
not alter audit persistence, dispatch, skills, memory, or execution. Wiring and skill
ownership remain with the parent.

## Implemented integration and remaining work

`/jev-supervisor on|off|status` adds work_state/review_need questions to the same
Jev audit request. Requires Jev audit enabled. Memory worker processes resulting
requests with evidence-bound supervisor_review and supervisor_task_proposal tools.
Parent application is separately gated by PI_SWARM_SUPERVISOR_TASK_APPLY=on, checks
current task snapshots, rejects completion/deletion/owned-task updates, then invokes
registered TaskManage through existing hooks. A proposal is not a completed task.

Cross-adapter handoff now keys by exact session identity, since Pi supplies distinct
extension API objects. This fixes a real integration gap previously hidden by
same-object mocks. Mode state is shared per session; no global authorization state.

Current limitations: budget input is not yet connected to live autogen metrics;
waiting input currently reflects pending messages, not all outstanding workers.
No automatic reviewer-triggered wake has been added; existing guarded reconciliation
owns continuation. Explicit supervisor/task-apply flags avoid silently replacing it.
Vault metadata filtering is implemented as a pure allowlist, but no live vault
metadata ingestion or memory-reference reconciliation is wired yet.

Compaction change re-appends autogen state after session_compact; tests preserve
counts and dedup during that event. The supplied test does NOT reproduce deletion
of Pi's real active-branch history, so do not claim a demonstrated host compaction
reset was fixed. A real compact/reload smoke remains required.

Skill cleanup exists only as an isolated byte-preserving preview with three tests:
171,177-byte source ->166,428-byte body plus5,493-byte reference. No global patch,
memory fact migration, or autonomous skill mutation was applied. Reviewed cleanup
and end-to-end reviewer task reconciliation require further dogfood before rollout.

## Live inputs and integration follow-up

Autogen adapter now publishes a session-keyed read-only budget callback; Jev reads
actual counters, not an empty object. Tool-result observations track known running
background IDs and completion notices; session input resets transient failure flags.
Unknown or non-JSON tool outputs are not authoritative worker state. This is partial
wait coverage, not a complete control-plane worker registry. Mandatory permissions
and budget counters remain code-owned.

Task proposals now additionally require independent supervisor_review confirmation
covering every proposed evidence ID; missing or later-rejected verdicts cannot
mutate tasks. Separate test exercises absent confirmation. Actual installed-Pi
integration smoke proves fixture finding -> real fork -> confirm/proposal -> parent
pending task; local scripted provider, not arbitrary real-world accuracy.

## Credential-reference evidence boundary

`vault-memory-evidence.ts` admits only explicit vault list metadata and projects
id/name-as-purpose/scope/kind. Value-bearing get/add/exec operations are omitted,
not merely regex-redacted. Unknown fields, permission lists, targets and secret
fields are discarded. Human-provided project usage context remains separate:
a global credential listing alone does not establish a project relationship.
No vault store is read by the classifier or restricted worker. Existing visible
list evidence is used; no automatic global credential inventory enumeration.

Fork snapshots now drop opaque message details/provider fields and value-bearing
vault calls/results. Sentinel tests cover tool arguments, results and details.
This does not guarantee arbitrary secrets embedded in all prose are detectable;
existing general redaction remains defense in depth, not confidentiality proof.

## Reviewed skill preview

Independent reviewer required preserving unique invocation/UI edge cases in a
reference and an explicit canonical load pointer. Updated preview now does both;
four preservation tests reject changed source, body or reference. Global skill
has not yet been patched. The reconstruction routine validates the exact allowed
body transformation and restores from original retained spans plus reference;
this is integrity validation, not a general lossless document codec.

## Dream-RSI-inspired review protocol

The worker now loads `.pi/lib/context/prompts/memory-review-policy.md`, adapted
from arXiv2609.14858v1 AppendixB.2, before its finding packet. It requires ordered
prefix evidence, recoverable-failure distinction, history preservation, explicit
confirm/reject/insufficient and no-write when no useful supported action remains.
The returned runner receipt includes the policy hash. This is review discipline,
not an implementation of the paper's replay simulator or self-improving policy.

Complete source B.2 and an explicitly offline-only adaptation are retained in
`tools/experiments/jev-audit/prompts/`. That development prompt may not run until
prefix-only replay APIs and known-outcome support checks exist. Unexecuted actions
have unknown outcomes; changing skill text requires fresh task execution.

Real-provider dogfood initially failed because isolated HOME removed provider
configuration. The integrated runner instead uses configured provider auth while
isolating workspace/memory/autogen data. It exposed a second issue: forked assistant
messages require usage.totalTokens. Snapshot now preserves bounded non-secret
usage metadata, not arbitrary provider payloads. No secret file was copied.
