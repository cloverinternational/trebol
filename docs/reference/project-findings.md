# Project findings

Reviewed project facts promoted from `memory_history` candidates. Each section
heading is a stable ID (`F-NNNN`) and never changes, so TaskManage evidence such
as `docs/reference/project-findings.md#F-0001` keeps resolving when the text is
revised. A section is admitted only after every claim is re-checked against
current repository code. A memory record's own session-file evidence is not
enough, because TaskManage cannot resolve it. Claims that could not be checked
are left out, not softened.

Each section lists: the claim, repository evidence, review date, source
records (`id@revision`), and the code anchor whose change makes it stale.
Retire a finding by marking it superseded. Do not delete its heading.

## F-0001

**Task-enforcement gate: what it blocks and what it exempts.**

With no TaskManage task `in_progress` and active, `TaskEnforcementHook`
blocks non-exempt tool calls with `[TASK ENFORCEMENT - BLOCKED]`. Exempt calls
are TaskManage, plan-mode, skill, user-interaction and CodeMode tools,
read-only exploration tools, read-only Bash commands, and `memory_history`
with `operation` `search` or `get`. Other `memory_history` operations stay
blocked. All hooks are dormant for the first 5 turns of a session
(`HOOK_WARMUP_TURNS`), so the gate cannot be observed before turn 6.

- Evidence: `.pi/lib/runtime/swarm-builtin-hooks.ts#L136-L155`,
  `.pi/lib/runtime/swarm-toolclass.ts#L33-L35`,
  `.pi/lib/runtime/hook-state.ts#L110-L126`; end-to-end:
  `node tools/e2e/memory-gate.mjs`.
- Reviewed: 2026-10-18, from code and the end-to-end run.
- Source records: `96f8cbf4-6ea5-4087-8eb4-70dad14815e7@e4c3cd5d`,
  `21555c16-e79d-4984-bdfe-1602ef50d4a0@27f50af0`,
  `26a6d888-3d86-4182-a29c-460d55a39de6@1a6f7aa5` (three near-copies merged).
  Their shared claim that every tool is blocked is outdated. The onboarding
  skill-budget gate in `96f8cbf4` is a separate mechanism and was not reviewed.
- Stale when: `onToolBefore` exemptions or `HOOK_WARMUP_TURNS` change.

## F-0002

**TaskManage file evidence must live inside allowed roots.**

File evidence resolves only inside the workspace root, its linked worktrees,
or host-configured `evidenceRoots`. Task input cannot add roots. Anything else
fails with `outside_allowed_roots`, and the message does not name the root that
was tried. This includes `~/.swarm/memory` store files, Pi session files, and
the installed Pi package. To cite outside material, quote it into a repository
document and cite that document.

- Evidence: `packages/tools/taskmanage/src/task-manage.ts#L96-L97`,
  `packages/tools/taskmanage/src/task-manage.ts#L706-L707`.
- Reviewed: 2026-10-18, including a live completion that cited a
  `~/.swarm/memory` event file and was rejected.
- Source record: `3ae605cd-ac99-4450-8055-92fdf9f68fb3@6e95df3f`.
- Stale when: `resolveEvidence` root list changes.

## F-0003

**mcp-fallback manifest discovery.**

`mcp-fallback` reads `.pi/mcp.json`, then `.mcp.json`, both resolved from the
working directory. It drops servers whose `enabled` is `false` and starts
`MCPManager` in closed mode unless `closed: false` is passed. The record also
claimed that non-lazy manifests are discovered at startup. That was not
re-checked and is omitted.

- Evidence: `extensions/mcp-fallback/extension.ts#L15-L36`.
- Reviewed: 2026-10-18, from source only. Runtime behaviour was not exercised.
- Source record: `72a66a8d-3330-4239-9ba1-e4b35ee0892f@792a84ae`.
- Stale when: `loadMcpManifests` or `registerMcpFallback` change.

## F-0004

**Pi session replacement invalidates the extension context.**

After a session replacement or reload, the old extension `ctx` must not be
used. Session-bound work belongs in the `withSession` callback, using the
fresh context it receives. The installed Pi docs (Pi 1.1.0, checked
2026-10-18) state, verbatim:

> Session replacement invalidates the old context. Capture only plain data
> before switching, then use the fresh context supplied to `withSession` for
> session-bound work.

The quote is copied here because the installed package is outside TaskManage's
evidence roots (F-0002).

- Evidence: this section (the quote is from
  `@earendil-works/pi-coding-agent/docs/extensions.md`, line 217, version 1.1.0).
- Reviewed: 2026-10-18. The source record says "Pi 1.0.4". The claim still
  holds in 1.1.0. Its list of operations (newSession, fork, switchSession,
  reload) was not re-checked line by line.
- Source record: `1ae1d7a6-2a7c-4f8f-9e11-145cb91e3538@df166525`.
- Stale when: Pi is upgraded. Re-check the quoted line.
