# Direct Hoja tools

## Ownership and activation

`extensions/hoja-mode` registers eleven native tools: the compatible `hoja_list`
and `hoja_get`, plus `hoja_projects`, `hoja_teams`, `hoja_issues`, `hoja_issue`,
`hoja_search_issues`, `hoja_issue_create`, `hoja_issue_update`,
`hoja_issue_delete`, and `hoja_comment_create`.

The new operations live in `.pi/lib/tools/hoja-operations.ts`. Their contracts
join `swarm-hoja.contract.ts` and the canonical tool surface, so the normal
Swarm filter retains selected tools. Explicit user exclusions remain respected.
Repeated registration on the same extension API object is idempotent.

Load this checkout's package and reload/start a new Pi session to activate the
change. Do not load both the main checkout and this linked worktree: use one
package source. This change does not automatically install itself into a running
session, change global config, merge branches, or alter credentials. The existing
native `HojaClient` uses `LINEAR_TOKEN` (or an explicitly injected token); this
patch does not add a new credential resolver. Its endpoint defaults to Hoja and
can be configured with `LINEAR_API_URL`.

The inspected host is Pi 1.3.0, with built-in MCP support. Its
`dist/core/mcp-servers.js` defines `codemode` as the default exposure and `direct`
as declarations in the model payload. This is not proof of a separately installed
`pi-mcp-adapter`. Live discovery in the worker found the nine
`mcp__hoja__hoja_*` names. They remain independently owned by Pi's MCP runtime;
the native names cannot collide with these names. We register no MCP server,
open no duplicate MCP connection, and do not change server exposure/selection.
Both paths may coexist and offer similar operations; they are not aliases or
exactly-once failover paths. Do not retry a failed write through the other path.

## Consent and safety

- An explicit user request to create/update/comment authorizes exactly that
  change. Do not ask again by routine. Resolve ambiguous targets/fields first.
- The rule and tool descriptions communicate this requirement; they do **not**
  cryptographically establish user intent. There is no model-controlled
  `confirmed` flag pretending to be an approval capability. Existing tool-call
  hooks, account permissions and runtime policy still apply.
- Native deletion additionally requires `ctx.hasUI` and a `ctx.ui.confirm`
  result of exactly `true`, tied to a snapshotted ID. Unavailable UI, cancellation
  or abort before dispatch sends no mutation. Tern contexts reporting `hasUI=false`
  cannot delete through this native tool yet. No silent fallback is attempted.
- `/hoja off` disables only proactive Hoja-first guidance. Consent instructions
  remain active, and the tool set is unchanged.
- All documents are constants and inputs are variables. Unknown fields, malformed
  arguments and unbounded page sizes are rejected before network dispatch.
- Client errors redact remote bodies and credentials. Ambiguous writes are never
  retried automatically. A successful payload still requires read-back by the
  caller; deletion is verified with lists/search because it can be logical.
- The external MCP server's deletion handler is unchanged; native UI confirmation
  does not retroactively become a technical gate on that external implementation.
  Consent guidance applies to both paths, but do not claim equivalent enforcement.

## Operation contracts

| Name | Inputs / output |
| --- | --- |
| `hoja_projects` | Bounded projects page (200 + sentinel), IDs/names |
| `hoja_teams` | Bounded visible teams page (200 + sentinel), IDs/names/keys |
| `hoja_issues` | `teamId` or `projectId` required; optional `assigneeId`, `excludeStateTypes`, `first` 1–200; page with `truncated` |
| `hoja_issue` | Full `id`, description, relationship IDs, up to 50 comments; not an unlimited history |
| `hoja_search_issues` | Text `query`, optional `first` 1–200; page with `truncated` |
| `hoja_issue_create` | `title`, `teamId`; optional description/project/priority/assignee/dueDate |
| `hoja_issue_update` | `id` and at least one of title/description/priority/stateId/assigneeId/dueDate |
| `hoja_issue_delete` | `id`, runtime human confirmation |
| `hoja_comment_create` | `issueId`, `body` |

`labelIds` is intentionally not advertised or silently discarded: it is outside
this request and rejected as an unknown field. IDs are resolved through reads,
not inferred from names. List/get retain their older contracts.

## Verification

### TREBOL-365 corrections — independent round 2 reviewed

The independent report `artifacts/trebol-363-independent-review.md` remains
unchanged (SHA-256 `fb8cf482655fa2c18944ddf37c7084743fc5e9feb3d407f3918eb1f8adf1217c`).
Round 2 independently returned LISTO within the corrected code-review scope.
The reviewer re-fetched the schema (same data hash), validated nine actual
mocked handler dispatches, ran 44 additional calendar probes, the 170-test
suite and provider payload E2E. This does not establish real write permissions
or approve deployment. Review reports and raw evidence remain local/ignored.

**Calendar validation:** reproduced before correction with the new regression
suite: 22 failing cases / 91 passing, recorded in
`artifacts/trebol-365-dates-before.log`. `2026-02-31` reached the mock client.
`validDueDate` now checks Gregorian day/month/leap-year bounds before dispatch,
including century rules (1900/2100 invalid leap days; 2000 valid). It also
rejects normalized `24:00`, invalid minutes/seconds and offsets. Date-only and
DateTime inputs remain supported: `YYYY-MM-DD`, `T HH:mm` (without the space),
optional seconds/fraction (1–9 digits), optional `Z` or signed HH:mm/HHmm offset.
Valid strings are passed unchanged; local timestamps retain local semantics,
not silently converted to UTC. Eighty create/update cases cover valid and
invalid boundaries across all months, leap years, timestamps and offsets.
This local policy does not prove server acceptance of every custom DateTime
format; introspection cannot describe a scalar's implementation.

**Independent GraphQL source:** captured via one read-only introspection query
from `https://hoja.clover4.app/graphql` at `2026-10-27T02:53:25.567Z`.
Snapshot: `artifacts/hoja-schema-introspection.json`, containing provenance and
data SHA-256 `67b3c6d8fe03b68390e22d0e82f403168629cc1a4dfbe7d5130152a99dfa8b31`.
The snapshot is schema metadata only, not a mock constructed from our handlers.
The initial validation found a real error: `commentCreate` requires
`input: CommentCreateInput!`; separate `issueId`/`body` arguments are invalid.
The document and variable envelope are now corrected. Public tool arguments
remain `issueId` and `body` for compatibility.

Reproduce capture and offline validation (no mutation is executed):

```sh
npm install --prefix artifacts/hoja-schema-validator --no-save --package-lock=false --ignore-scripts graphql@16.11.0
npx vite-node tools/e2e/hoja-schema.ts --capture  # optional refresh: read-only
npx vite-node tools/e2e/hoja-schema.ts            # saved snapshot, offline
```

GraphQL 16.11.0 validates all nine documents (field/argument names, variable and
input types, nullability and selected response fields). Seven negative document
controls include the old comment signature, and variable coercion tests check
filter operators and mutation input fields plus three invalid input controls.
Custom scalar coercion in a client schema is not remote runtime validation.
Result log: `artifacts/trebol-365-schema-validation.log`.

After correction: **170 tests in six files passed** (same expanded suite below),
recorded in `artifacts/trebol-365-regressions.log`; actual Pi payload E2E passed
again for eleven direct tools and preserved denylist. `git diff --check` passed.
No real write was executed, no write permission established, no global
activation performed. Publication was subsequently authorized separately; merge
and global activation remain out of scope. Raw artifacts are local/ignored and
not shipped; the scripts let a reviewer recapture the primary source independently.
The payload E2E uses `--no-mcp`: it proves native visibility, not live MCP
coexistence or the external server's confirmation behavior. The delete modal is
mock-tested, not end-to-end UI-tested. Remote DateTime scalar coercion and
server filter/pagination semantics are not established by schema validation.

Commands run in the isolated `feat/363-hoja-direct` worktree:

```sh
npx vitest run .pi/test/tools/hoja-operations.test.ts .pi/test/tools/hoja-mode.test.ts .pi/test/tools/hoja-mode-restore.test.ts
node tools/e2e/hoja-direct.mjs
npx vite-node tools/e2e/hoja-read-live.ts
git diff --check
node tools/repo/check-tracked-symlinks.mjs
```

The first run passed 63 tests. The actual installed Pi/local-provider capture
declared all eleven native names once, with strict schemas and consent text;
an explicit deletion denylist was preserved. Mock tests cover all four writes,
unavailable/cancelled deletion, ID snapshot, abort, HTTP 401/403/500 sanitization,
malformed arguments, and no retries. Live reads returned 13 projects, one visible
team, one bounded issue (`truncated=true`), its detail and one search hit.
No real mutations were invoked, so real write permissions/results are unverified.

Before calendar corrections, expanded verification passed **90 tests in six files**: the three Hoja
files above plus `session-mode-restore`, `swarm-extra-tool-gating`, and
`readonly-domain-tools`. Additional mock cases cover GraphQL rejection,
partial-data ambiguity, network failure and timeout, each without retries.
`npm run check:install -- --extension extensions/hoja-mode/index.ts` loaded the
extension with zero errors using the npm-local Pi 1.0.4 SDK; the separate payload
test used global Pi 1.3.0. No full repository test/build is claimed.

