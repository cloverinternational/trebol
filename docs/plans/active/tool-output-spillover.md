# Recoverable tool-output spillover

## Scope and decision

Implement recoverable token-threshold spillover for Bash and other tool text
outputs, not a new artifact browser or a streaming-execution redesign. The user
selected estimated tokens rather than model-specific tokenizers. Define the
estimate as ceil(UTF-8 bytes / 4); it is not an actual provider token count.
Preserve unrelated working-tree changes, including existing AGENTS.md edits.

## Evidence

- `.pi/lib/runtime/swarm-toolout.ts` already bounds output at 100,000 bytes /
  1,000 lines but irreversibly elides it.
- `.pi/lib/runtime/swarm-builtin-hooks-runtime.ts` applies that guard only to
  the first text block, skips images, and couples it to task-enforcement hooks.
- `.pi/lib/tools/swarm-bash.ts` has a separate 12,500-estimated-token /
  2,000-line spill path; failed writes can yield an empty saved-output path.
- Pi's installed extension runner applies tool_result content patches while
  preserving isError unless explicitly changed. Content replacement clears
  stale structuredContent unless replaced explicitly.
- Original OMP reference: https://github.com/can1357/oh-my-pi/blob/e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e/packages/coding-agent/src/tools/output-meta.ts
  centralizes text spilling with head/tail previews and does not invent links
  on write failure. Its threshold is bytes, not tokens.
- Code Puppy reference: https://github.com/mpfaffenberger/code_puppy/blob/b679f6039cf01fcd06c832bbda31a34c329a551f/code_puppy/tools/file_operations.py
  spills list_files locally; it is not evidence of a general shell spill layer.
  The intended DeepSeek harness is unidentified; do not guess.

## Implementation

1. Extend the shared output helper with a configurable estimated-token budget
   (environment configuration, validated positive integer with documented
   minimum and default). Retain existing general and Bash defaults unless
   overridden. Keep existing line guards. Budget the preview and recovery
   notice together, use UTF-8-safe head/tail clipping, and state the scope of
   the bound: tool text, not images or provider protocol overhead.
2. Persist full available text before clipping in private, uniquely allocated
   temporary files. Publish a path only after a successful complete write;
   remove partial files on failure. Reuse the existing temp-output convention
   and ordinary Bash sed/rg retrieval rather than adding a tool. State that
   files survive session exit but depend on OS temporary-file retention.
3. Apply general spillover at the existing tool_result integration boundary,
   independently of task-hook enablement/warmup. Aggregate all text blocks for
   budgeting, preserve non-text blocks and failure status, and retain original
   text in the artifact. Remove the old destructive first-block elision.
   Verify middleware ordering and structured-content handling against the
   installed runner; do not promise recovery of data already discarded by an
   upstream tool or clipping done before this boundary.
4. Share persistence/bounding behavior with Bash's earlier spill path so
   execution output is recoverable before its formatter discards it. Preserve
   exit/signal/timeout semantics and report write failure honestly with a
   bounded preview, never an empty or nonexistent recovery link. Keep
   background logging and execution architecture unchanged.
5. Document configuration, counting, retrieval, disk failure, and retention in
   a focused reference and minimally update affected contract descriptions.

## Verification

- Unit tests: just below/at/above budget; multiline and huge single-line text;
  Unicode; multiple text blocks; mixed images/text; unchanged small results;
  marker/path overhead; invalid configuration; collision-free concurrent
  spills; restrictive permissions; exact UTF-8 recovery; injected write failure.
- Integration tests: register real middleware, pass successful and failed
  results through the installed Pi result path, and verify model-facing text
  plus unchanged error semantics, including disabled task enforcement.
- Bash end-to-end tests: real shell output over threshold, success and failure,
  recoverable full output, then bounded sed/rg retrieval through the same path.
- Run focused tests first, relevant runtime/Bash regressions next, and build
  checks as appropriate. Record failures without attributing them prematurely.
- Request a separate read-only code review, resolve findings, and rerun tests.
  Report actual commands/results and remaining limitations, not just success.

## Non-goals

No new provider tokenizer, artifact URI protocol, UI, background-process
redesign, automatic summarization, or broad external harness survey. No claim
of byte-perfect raw stream recovery where existing tools already normalize
ANSI or decode stdout/stderr before returning text.
