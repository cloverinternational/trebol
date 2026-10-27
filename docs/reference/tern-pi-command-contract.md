# Command contract for Pi's dogfood Tern UI

Inspected against local `@earendil-works/pi-coding-agent` 1.0.4; installed
`pi` on PATH is 1.1.0, so the opt-in TSP runner and this contract use the
local SDK version. Existing shell dispatch routes only bare interactive `pi`.

## Sources

- **Built-in TUI commands:** `node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js` exports `BUILTIN_SLASH_COMMANDS`, but the package only exports its root, rpc-entry and client/experimental entries (`package.json`); no supported built-in command executor is exposed on `AgentSession`. Built-ins such as `/settings`, `/tree`, `/model`, `/resume` require Pi's InteractiveMode. They must be listed as unavailable rather than passed to an LLM.
- **Extension commands:** `session.extensionRunner.getRegisteredCommands()` resolves invocation names, suffixing duplicates (`:1`, `:2`), in `dist/core/extensions/runner.js:556-596`. `AgentSession.prompt()` handles extension commands immediately, including while streaming, before model submission (`dist/core/agent-session.js:1506-1530`); `_tryExecuteExtensionCommand` calls `getCommand` and its handler with the command context (`:1630-1652`). Exact catalog identity must be checked before calling prompt, because unknown names fall through to model input.
- **Prompt templates:** `session.promptTemplates` returns `resourceLoader.getPrompts().prompts` (`dist/core/agent-session.js:1238-1240`). `prompt()` expands templates (`:1540-1543`); `expandPromptTemplate()` matches `/name args` by exact name and substitutes parsed arguments (`dist/core/prompt-templates.js:247-260`). The expansion is intentionally sent to Pi's model, unlike a rejected slash command.
- **Skills:** `session.resourceLoader.getSkills().skills` returns discovered skills (`dist/core/resource-loader.js:295-299`). `prompt()` expands `/skill:name args` through `_expandSkillCommand` before templates (`dist/core/agent-session.js:1540-1543`). Only exact discovered skill names may be accepted.

## Safety policy

`/commands` is UI-local and never reaches `session.prompt`. Validate every
slash command's first token against a fresh catalogue just before dispatch.
Offer built-ins as unavailable, including collision names; explicit
extension/template/skill identities must be unambiguous. Unknown slash input,
stale picker selections, busy unsupported prompt/template/skill commands,
and dispatch errors must become local feedback, never a raw model prompt.
Extension commands are the only category Pi guarantees can run during
streaming; prompt templates and skills create model input and should run only
when idle. No renderer action may grant permissions or bypass Pi's no-op
extension UI context.

Ordinary non-slash text is different from a busy template or skill command:
when Enter submits it during an active agent turn, `bridge.ts` queues it with
`session.prompt(text, { streamingBehavior: "followUp" })`, matching Pi's
follow-up queue. Alt+Enter uses the same path while busy and behaves like an
ordinary submission while idle. Alt+Up calls `clearQueue()` and restores the
queued steering/follow-up text to the composer; cancellation aborts the active
turn but does not implicitly clear Pi's queue. Queue API errors are shown in
the local transcript and remove the corresponding optimistic queued entry.
Queued messages render in the dock above the composer as OMP's
`QueuedMessagesBand` (`queue-view.ts`): col `omp.queue` with one
`omp.queue.item` pill per message (steering first, then "After yield"),
the typed text on one truncated line, a total `omp.queue.count` badge on the
first pill when more than one waits, and an `omp.queue.edit` control (⌥↑)
that acts like Alt+Up. Tern's built-in stylesheet draws these roles. The band
follows Pi's `queue_update` and disappears when the queue empties; queueing no
longer adds a transcript line. Verified by `tools/e2e/tern-queue-band.mjs`.

## Implemented dogfood behavior

`.pi/lib/tern/commands.ts` builds a fresh catalogue on submission and a
keyboard-operable TSP `list` (up/down, Enter inserts, Escape closes). Because
the native list in the dock was not represented by `tern capture --surfaces`
in the live pane check, `.pi/lib/tern/bridge.ts` also prints the catalogue
as a local transcript message when `/commands [query]` opens. This is UI
output, not a model prompt. Picker draft and composer draft are distinct;
closing the picker clears the composer, avoiding accidental concatenation
with the next slash input. Selecting an unavailable builtin does not insert
it. Unknown and ambiguous commands, discovery failures and dispatch errors
produce local system feedback. The list is rebuilt on each submit, so a
stale selected command is revalidated before Pi is called.

Focused test suite: `.pi/test/tern/commands.test.ts` (21 tests), with the
whole Tern+wizard suite passing. In a live Tern pane bare `pi` then
`/commands` displayed an extension command `/tern-setup`, skills and
`/model [builtin, unavailable]` in `tern capture --surfaces`. The native
picker itself and a successful extension/template/skill command invocation
were not verified live. Pi's local SDK is 1.0.4 while global `pi` is 1.1.0;
the copied builtin list can drift until a public catalogue is exposed.
