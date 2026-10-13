# Git Blocks

`git` commands drive a repository's graph, changes, diff surface and Git
forms. Use them to stage Git UI screenshots or inspect a repository from a
control endpoint. They run on desktop builds only, including desktop
headless runs; unsupported platforms skip them with a warning.

## Opening and waiting

| Command | Does |
| --- | --- |
| `git open [fixture\|media\|"<dir>"]` | Opens the repository containing a directory, or a generated fixture repository. An existing block for that repository in the current tab takes focus. |
| `git wait` | Waits for the repository, selection detail and open file to finish loading. |
| `git loading` | Empties the repository snapshot, clears its selection and marks it unread, for a loading-state screenshot. |

The default for `git open` is `fixture`. Relative directories use the same
path resolution as other fixture paths; a directory must belong to a Git
repository. Opening can fail if the repository cannot be found or a fixture
cannot be built.

The generated repositories need Git and a writable temporary directory, not
files from `crates/tern/goldens/fixtures`. They have pinned identities and
dates and ignore the user's Git configuration:

- `fixture` builds **orbit**, a small Rust library with merged
  `feature/lanes`, unmerged `fix/long-subjects`, tags `v0.1.0` and `v0.2.0`,
  an `origin` remote, `main` two commits ahead of `origin/main` and one stash.
  `src/lib.rs` is staged, `src/graph.rs` has unstaged changes including a
  formatting-only hunk, and `src/palette.rs` is untracked.
- `media` builds **brand-kit**, with changed `assets/badge.png` and
  `icons/mark.svg` for image comparison.

Each fixture is built once per process in temporary storage. Scripts in the
same process share it; another process gets its own copy.

Every command except `open` acts on the focused Git block, or the newest
visible Git block in the current tab. Without one it fails with
`no git block (git open first)`.

`open`, `wait`, selection, search, diff, context, preferences and the commit
AI panels wait for real repository work, then settle for 450 ms. They time
out after 20 seconds. Loading includes selection details, syntax
highlighting and image display. A repository-open or file-load failure also
ends the wait: completion alone does not prove a successful load. Other
commands settle for 450 ms without waiting for repository work.

`tern ctl state` exposes this family as the `git_blocks` object, not an
array: `git_blocks.blocks[]` contains each block's `id`, `focused`, `repo`,
`editor` and `media`. Check `repo.path`, `repo.name`, `repo.ready`,
`repo.head` and repository counts for opening/loading; `repo.open.error`
reports open-file errors. `repo` can be null before the repository opens.

## Graph and selection

| Command | Does |
| --- | --- |
| `git select wip` | Selects the working tree and shows the Files pane's Changes tab. |
| `git select none` | Clears the selection. |
| `git select <n>` | Selects and scrolls to graph row `n`, starting at zero. |
| `git select <a>..<b>` | Selects the range between two graph rows. |
| `git select "<rev>"` | Selects `HEAD`, a branch, a tag, `stash@{n}` or a hexadecimal commit ID/prefix. |
| `git search ["<query>"]` | Closes the open file, opens and focuses graph search, and sets its query. Omit the query to open empty search. |

Rows must exist in the loaded graph. Revisions use the loaded repository's
branches, tags and stashes, not arbitrary Git revision expressions. Numeric
words are row numbers even when quoted; a hexadecimal ID/prefix must contain
at least one letter to be treated as a revision. Missing rows or unresolved
revisions fail. A stash is inspected rather than located in the graph.

State reflects these commands in `git_blocks.blocks[].repo.selection`
(`kind`: `none`, `wip` or `commits`, with commit `ids`) and `repo.search`.
The selected working tree also changes `git_blocks.files_tab` to `changes`.

## Diffs and files

| Command | Does |
| --- | --- |
| `git diff ["<path>"] [file\|history]` | Opens a changed file as a diff (default), its whole file (`file`) or its history (`history`). |
| `git find ["<query>"]` | Opens find in the current diff or whole-file editor and sets its query; omission uses an empty query. |
| `git pick <n>` | Picks the first `n` changed diff rows. |
| `git context more` | Reveals unchanged lines around the current hunk. |
| `git context all` | Reveals all unchanged lines, or folds them again. |

Without a path, `diff` chooses the first changed working-tree file, then the
first file in the selected commit or range. With a path, it uses the same
priority for that exact repository-relative path. Working-tree files select
the working tree; an unstaged change takes priority over a staged one.
`file` and `history` are trailing mode words, not a separate command.

`diff` fails if there is no matching change or selected-commit file. `find`
requires an open file; `pick` requires a loaded diff; `context` requires an
open diff surface. `n` is a nonnegative integer: zero picks nothing, and a
number larger than the changed-row count picks all available changed rows.

Check `git_blocks.blocks[].repo.open`: `path`, `scope` (`staged`,
`unstaged`, `commit:<id>` or `range`), `mode`, `loaded`, `error` and `picked`.
Whole-file editor and image-comparison state are in the block's `editor`
and `media`. Diff find and expanded context have no dedicated state fields.

```text
ready
git open fixture
zoom
git diff "src/graph.rs"
git context more
shot git-context
```

## Diff preferences

| Command | Does |
| --- | --- |
| `git set split on\|off` | Switches side-by-side diffs. |
| `git set hunk on\|off` | Switches hunk view. |
| `git set wrap on\|off` | Switches line wrapping. |
| `git set tree on\|off` | Switches file lists between a tree and a list. |
| `git whitespace exact\|ignore-space\|ignore-formatting` | Sets whitespace comparison. |

These change window Git preferences, not just the selected file, and save
settings in ordinary windows. Headless settings are not saved. They still
require a Git block. `git_blocks` has no dedicated preference fields; inspect
the resulting surface with `tree` or a screenshot.

## Files and refs

| Command | Does |
| --- | --- |
| `git tab files\|changes\|refs` | Shows that Files pane tab. |
| `git refs fold branches\|remotes\|tags\|stashes\|worktrees\|submodules` | Folds a Refs section. |
| `git refs unfold branches\|remotes\|tags\|stashes\|worktrees\|submodules` | Unfolds a Refs section. |
| `git refs filter ["<text>"]` | Sets the Refs filter; omission clears it. |

An unknown tab or section is an error. State exposes the current tab as
`git_blocks.files_tab` and the Refs view as `git_blocks.refs`.

## Sample AI panels

| Command | Does |
| --- | --- |
| `git ai explain` | Selects `HEAD` and shows a canned commit explanation. |
| `git ai message` | Selects `HEAD` and shows a canned proposed commit message. |
| `git ai staging` | Selects the working tree and shows a running AI staging banner. |
| `git ai staged` | Selects the working tree and shows a completed AI staging banner. |

These stage sample UI, not a real AI request or staging operation.
`explain` and `message` fail if `HEAD` has no commit. `staging` and `staged`
also show the Changes tab. State reflects the selection and
`git_blocks.files_tab`, but does not expose the sample AI answer or banner.

## Dialogs, menus and peek

| Command | Does |
| --- | --- |
| `git dialog branch\|rename\|tag\|message\|remote\|remote-url\|init\|clone\|patch\|stash\|confirm\|discard\|ai-stage` | Opens a partly filled sample Git form. |
| `git menu commit\|branch\|tag\|stash\|file\|rows` | Opens a context menu for the selected commit (else `HEAD`), current branch, first tag, newest stash, first changed file or picked diff rows. |
| `git peek` | Opens the selected commit's peek, falling back to `HEAD`. |

Dialog forms do not submit an operation. `branch` deliberately contains an
invalid name to show validation; `remote` selects GitHub while `remote-url`
uses a URL. Unknown forms fail, including `git dialog open`.

Menus fail when their target is absent: no commits, detached `HEAD`, no
tags, no stashes, no changed files or no picked rows. Use `git pick` before
`git menu rows`. Peek requires a commit whose graph row is drawn and whose
content is loaded; otherwise it fails.

State reports `git_blocks.dialog` and `git_blocks.peek` as booleans. Menus
are available through `tern ctl menus`, not a dedicated `git_blocks` field.

```text
ready
git open media
zoom
git diff "assets/badge.png"
shot git-image
```

## See also

- [Scripts](index.md): syntax, running scripts and timing.
- [Files Pane](files.md): Files pane controls.
- [Preferences](prefs.md): window settings.
- [Control Commands](control.md): state, menus and inspection.
- [Debugging](../guides/debugging.md): driving a window from a script.
