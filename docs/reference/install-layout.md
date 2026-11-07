# Installation layout and validation

## One code owner, separate configuration

| Location | Owner | Purpose |
| --- | --- | --- |
| The package containing the `pi` executable on PATH | Pi / your package manager | Host CLI, SDK, built-in extensions. Do not patch or copy into it. |
| A development checkout **or** Pi's managed Git clone | Trebol | Entire package: `extensions`, `.pi/lib`, `packages`, installed dependencies and generated runtime outputs. Enable only one copy. |
| `~/.pi/agent/settings.json` (or the configured agent directory) | User | Personal package registrations and resource selections, not extension source code. |
| `<project>/.pi/settings.json` | Project | Project package declarations/overrides, subject to Pi project trust. Relative package paths resolve from this file. |
| `~/.pi/agent/git/<host>/<repository>` | Pi package manager | Managed Git package checkout. A historical clone can remain on disk without being active. |
| Trebol `.swarm/`, `.pi/agent-sessions/`, `~/.local/state/pi-swarm/` | Runtime | Ignored runtime state; not installation sources. Harness diagnostics are opt-in (`PI_SWARM_DIAGNOSTICS=1`) and live under the state directory, never in a project checkout. |

Never copy the extensions directory on its own. Its relative imports require the
rest of the package. Do not relocate memory, credentials or sessions as part of
an installation cleanup.

## Development checkout

```sh
npm ci                       # includes prepare: build runtime dependencies
npm run check:install        # actual Pi loader, isolated temporary settings
pi install /absolute/path/to/trebol
npm run doctor              # static checks of current personal configuration
```

Pi does not install dependencies for local-path packages. Re-run installation
after dependency changes and rebuild after changing dist-consumed package sources.
The repository's `.pi/settings.json` already declares `..` for project use;
global registration is for making the checkout available in other projects.
Project declarations may override personal resource filters, so inspect both
scopes with `pi config` rather than assuming a personal exclusion always wins.

## Managed installation

```sh
pi install git:github.com/cloverinternational/trebol@<tag-or-commit>
```

Use an actual release ref. Do not simultaneously enable a local checkout and a
managed Git copy. Use `pi list` to identify registrations, and `pi remove <source>`
to remove the unwanted registration through Pi. Review configuration before
removal; an old directory alone is not evidence that its extensions are loaded.

## What validation proves

`npm run doctor` is a static diagnostic, not proof of successful loading.
`npm run check:install` resolves the Pi executable on PATH, follows its symlink,
and locates that installation's SDK. It loads the Trebol package from fresh
personal settings in a temporary directory outside the repository. It does not
read your personal model configuration, start a session, or call a model.
It executes trusted extension factories: it is **not a security sandbox**.
It checks package loading, not every tool's execution, lifecycle cleanup, themes,
skills, live provider connectivity, or the resource selections in your real settings.

Set `PI_EXECUTABLE=/absolute/path/to/pi` to select an explicit npm-installed host.
Shell wrappers and standalone binaries without the SDK fail with an actionable
error; no guessed `/usr/lib` or Homebrew prefix is used.

`node tools/e2e/trebol-toggle-session.mjs` uses the same host resolver to exercise
an actual session reload with a narrow extension set. It is not a whole-package
lifecycle certification.
